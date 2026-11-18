/**
 * Gate 4 — the buyer side.
 *
 * Everything built so far is supply and settlement. A seller can offer a card,
 * escrow can hold money, an adapter can redeem — but **a buyer cannot initiate
 * anything.** This is the missing half: given a merchant and an order total,
 * find matching supply, price it, and show the discount.
 *
 * It reuses the Gate 4 matcher from the previous phase (`planCardMatch`) rather
 * than inventing a second one, so the buyer is quoted against the same rules the
 * router will actually execute: full drains preferred, capped partials only when
 * nothing better exists. A quote produced by different logic from the execution
 * would be a quote that sometimes cannot be filled.
 *
 * Nothing here writes. Quoting is a read, and a quote is not a claim on supply —
 * two buyers can hold the same quote, and the first to fund escrow wins. The
 * alternative (reserving supply at quote time) invites griefing: free options on
 * every live card for the price of an HTTP request.
 */

import { prisma } from '../db'
import {
  DEFAULT_MAX_CARDS,
  DEFAULT_RESIDUAL_CAP_CENTS,
  isNoMatch,
  planWithFirstInLine,
  type CardCandidate,
  type MatchPlan,
} from '../supply/matching'
import { discountBps } from '../intent/types'
import { ESCROW_INTENT_FORM_FACTOR } from '../escrow/refs'
import { isFirstInLine } from '../barcode/unscanned'
import { legCostCents } from '../route/plan'

/** One card's contribution, as the buyer sees it. Never identifies the seller. */
export interface QuoteLeg {
  intentId: string
  /** Last four, for display. Never the full number. */
  last4: string
  /** How much of the order this card covers. */
  appliedCents: number
  /** What the buyer pays for that coverage. */
  costCents: number
  /** True when the card is left at zero — the security property behind all this. */
  fullyDrained: boolean
}

export interface DemandQuote {
  kind: 'quote'
  merchantId: string
  /** What the buyer wants to spend at the merchant. */
  orderTotalCents: number
  /** What the buyer pays us. Always less than orderTotalCents. */
  priceCents: number
  /** The saving, in cents and in basis points. */
  savingCents: number
  discountBps: number
  legs: QuoteLeg[]
  /** True when every card in the plan is drained to zero. */
  fullDrain: boolean
  /** Value left across all cards afterwards. 0 on a full drain. */
  residualCents: number
  /** How long this pricing is good for. Quotes are not reservations. */
  expiresAt: Date
}

export interface NoQuote {
  kind: 'no_quote'
  reason: string
}

export function isNoQuote(v: DemandQuote | NoQuote): v is NoQuote {
  return v.kind === 'no_quote'
}

/**
 * How long a quote is honoured.
 *
 * Short on purpose. Supply is live — a seller can reclaim their own card at any
 * time, and balance-watch can cancel an intent between quote and payment. A long
 * quote is a promise about someone else's card that we are not in a position to
 * make.
 */
export const QUOTE_TTL_MS = 2 * 60_000

export interface QuoteRequest {
  merchantId: string
  /** What the buyer wants to spend at the merchant, in cents. */
  orderTotalCents: number
  residualCapCents?: number
  /**
   * Restrict supply to one form factor. Omit to quote across all of them
   * except escrow listings, which only the escrow quote may name: their money
   * moves on chain, and no other buy path can sell one.
   */
  formFactor?: string
  maxCards?: number
  now?: Date
  /** Listings to leave out: another shopper's soft reservation, or one Lit refused a ticket for. */
  excludeIntentIds?: readonly string[]
  /** Sellers to leave out, such as one with an open dispute. */
  excludeAccountIds?: readonly string[]
}

/**
 * The price of one card leg lives with the till's planner now (route/plan.ts),
 * which must stay pure: this module reads the database. Re-exported so every
 * caller keeps one import site, and so both quotes price a leg identically.
 */
export { legCostCents }

/**
 * Find supply for an order total and price it.
 *
 * Reads only `offered` intents that have not expired. A `matched` intent is
 * already spoken for, and an expired one cannot be unsealed even if matched —
 * quoting either would be quoting something that cannot be delivered.
 */
export async function quoteDemand(req: QuoteRequest): Promise<DemandQuote | NoQuote> {
  const now = req.now ?? new Date()

  if (!Number.isInteger(req.orderTotalCents) || req.orderTotalCents <= 0) {
    return { kind: 'no_quote', reason: `order total ${req.orderTotalCents} is not a positive amount` }
  }

  const live = await prisma.intent.findMany({
    where: {
      state: 'offered',
      merchantId: req.merchantId,
      // Optional rather than hardcoded: this matcher is shared, and the
      // ecommerce channel would legitimately quote bearer supply. The in-store
      // caller passes its form factor so it cannot be sold a card its reveal
      // could not render. See one-screen.ts.
      //
      // "All of them" never includes an escrow listing. Its card opens only
      // through the escrow on chain, so a quote here would sell something the
      // buy path cannot deliver, and match it in our books out from under the
      // chain (src/lib/escrow/refs.ts).
      formFactor: req.formFactor ? req.formFactor : { not: ESCROW_INTENT_FORM_FACTOR },
      ...(req.excludeIntentIds && req.excludeIntentIds.length > 0 ? { id: { notIn: [...req.excludeIntentIds] } } : {}),
      ...(req.excludeAccountIds && req.excludeAccountIds.length > 0
        ? { accountId: { notIn: [...req.excludeAccountIds] } }
        : {}),
      expiresAt: { gt: now },
      // An agent's relisted leftover has a deposit behind it that only the
      // agent endpoint settles (src/lib/agent/markers.ts). Null-safe: a plain
      // NOT on a nullable column would drop every card with no marker.
      OR: [{ failureReason: null }, { NOT: { failureReason: { startsWith: 'AGENT_' } } }],
    },
    orderBy: [{ expiresAt: 'asc' }],
    take: 200,
  })

  if (live.length === 0) {
    return { kind: 'no_quote', reason: `no live supply for merchant ${req.merchantId}` }
  }

  // `lastKnownBalanceCents` is what balance-watch last observed; face value is
  // the fallback before the first sweep. Using face value when a lower balance
  // is known would quote value that is not there.
  const byIntent = new Map(live.map((i) => [i.id, i]))
  const candidate = (i: (typeof live)[number]): CardCandidate => ({
    intentId: i.id,
    accountId: i.accountId,
    merchantId: i.merchantId,
    balanceCents: i.lastKnownBalanceCents ?? i.faceValueCents,
  })

  // FIRST IN LINE: a card whose last shopper said it did not scan, with their
  // hold kept until the next shopper's scan shows the truth (unscanned.ts).
  // Oldest first, used whole where it fits; with none listed this is exactly
  // `planCardMatch` over every card, as before.
  const firstInLine = live
    .filter(isFirstInLine)
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
  const plan = planWithFirstInLine(
    req.orderTotalCents,
    firstInLine.map(candidate),
    live.filter((i) => !isFirstInLine(i)).map(candidate),
    {
      residualCapCents: req.residualCapCents ?? DEFAULT_RESIDUAL_CAP_CENTS,
      maxCards: req.maxCards ?? DEFAULT_MAX_CARDS,
    },
  )

  if (isNoMatch(plan)) return { kind: 'no_quote', reason: plan.reason }

  return priceMatchPlan(plan, req.merchantId, byIntent, now)
}

type IntentRow = {
  id: string
  last4: string
  priceCents: number
  faceValueCents: number
}

/** Turn an execution plan into buyer-facing pricing. Split out so it is testable. */
export function priceMatchPlan(
  plan: MatchPlan,
  merchantId: string,
  byIntent: ReadonlyMap<string, IntentRow>,
  now: Date,
): DemandQuote | NoQuote {
  const legs: QuoteLeg[] = []
  let priceCents = 0

  for (const leg of plan.legs) {
    const intent = byIntent.get(leg.card.intentId)
    if (!intent) {
      // The intent vanished between the read and here. Refuse the whole quote:
      // a partially-priced plan is one that cannot be executed as quoted.
      return { kind: 'no_quote', reason: `supply ${leg.card.intentId} is no longer available` }
    }

    const costCents = legCostCents(leg.appliedCents, intent.priceCents, intent.faceValueCents)
    priceCents += costCents
    legs.push({
      intentId: intent.id,
      last4: intent.last4,
      appliedCents: leg.appliedCents,
      costCents,
      fullyDrained: leg.fullyDrained,
    })
  }

  const orderTotalCents = plan.totalAppliedCents
  if (priceCents >= orderTotalCents) {
    // No saving means no product. Better to say so than to quote a zero or
    // negative discount and let a buyer work it out themselves.
    return {
      kind: 'no_quote',
      reason: `available supply prices at ${priceCents}c for a ${orderTotalCents}c order — no saving`,
    }
  }

  return {
    kind: 'quote',
    merchantId,
    orderTotalCents,
    priceCents,
    savingCents: orderTotalCents - priceCents,
    discountBps: discountBps(orderTotalCents, priceCents),
    legs,
    fullDrain: plan.fullDrain,
    residualCents: plan.residualCents,
    expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
  }
}

/** Safe to serialise to a buyer. Dates become ISO strings; no seller identity. */
export function publicQuote(quote: DemandQuote): Record<string, unknown> {
  return {
    merchantId: quote.merchantId,
    orderTotalCents: quote.orderTotalCents,
    priceCents: quote.priceCents,
    savingCents: quote.savingCents,
    discountBps: quote.discountBps,
    fullDrain: quote.fullDrain,
    expiresAt: quote.expiresAt.toISOString(),
    // accountId is deliberately absent: which seller supplied a card is not the
    // buyer's business, and publishing it would let a buyer profile sellers.
    legs: quote.legs.map((l) => ({
      intentId: l.intentId,
      last4: l.last4,
      appliedCents: l.appliedCents,
      costCents: l.costCents,
      fullyDrained: l.fullyDrained,
    })),
  }
}
