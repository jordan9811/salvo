/**
 * The till's quote: live supply at one store, read and handed to the planner
 * (unified-account spec 6.3).
 *
 * ===========================================================================
 * ONE READ, ONE PLANNER, BOTH TILLS. The card rail's quote and buy both come
 * through here (one-screen.ts quoteSpend and buySpend), so a purchase is
 * bought on exactly the rules it was quoted on, re-read rather than trusted.
 * The planner itself is pure (route/plan.ts); this is the part that knows the
 * database: which rows are on sale, which wait first in line and in what
 * order, what each holds, and the store's cap.
 *
 * EACH RAIL ROUTES OVER ITS OWN SUPPLY ONLY, so no rail fronts the other's
 * money. The card rail reads `in_store_barcode` listings, never an escrow one.
 * The dollars rail keeps its own quote (src/lib/escrow/quote.ts) until the
 * second escrow contract can sell part of a card; until then a request for it
 * here is refused, plainly, rather than half wired.
 * ===========================================================================
 *
 * Stripe-free, like everything the till imports: the floor on a card charge
 * is restated below rather than read from the hold code.
 */

import { prisma } from '../db'
import { discountBps } from '../intent/types'
import { hasPublicBalanceLookup } from '../barcode/balance-readers'
import { blindResidualCapCents, residualCapCents } from '../barcode/reveal'
import { REMAINDER_RELIST_MIN_CENTS, inferenceHaircutBps } from '../barcode/relist'
import { decodeUnscanned, isFirstInLine } from '../barcode/unscanned'
import { decodeRemainder, keptHoldOwners, remainderStrikes, STRIKES_TO_BAR, waitingOldestFirst } from '../supply/remainder'
import {
  isNoTillPlan,
  planTill,
  routePreference,
  type FirstInLineCandidate,
  type LegSource,
  type RoutePreference,
  type TillCandidate,
  type TillPlan,
} from '../route/plan'
import { QUOTE_TTL_MS, type DemandQuote, type NoQuote, type QuoteLeg } from './quote'

/**
 * The smallest card charge, and the smallest deposit hold, on the card rail.
 * STRIPE_MIN_CHARGE_CENTS (src/lib/hold/ref.ts), restated because the till
 * must not import the hold code. tests/till-quote.test.ts holds them equal.
 */
export const CARD_MIN_CHARGE_CENTS = 50

/**
 * The residual cap this merchant's reveal will actually enforce.
 *
 * One helper rather than the expression twice, because quote, buy and reveal
 * must agree: quoting at one cap and buying at another would show a price the
 * purchase then refuses.
 */
export function capForMerchant(merchantId: string): number {
  return hasPublicBalanceLookup(merchantId) ? residualCapCents() : blindResidualCapCents()
}

export type TillRail = 'card' | 'stablecoin'

export interface TillQuoteRequest {
  merchantId: string
  totalCents: number
  /** The shopper's setting. Absent or malformed, the default: in and out, two cards. */
  preference?: { mode?: unknown; maxCards?: unknown } | null
  now?: Date
  /** Listings to leave out. */
  excludeIntentIds?: readonly string[]
  /** Sellers to leave out, such as one with an open dispute. */
  excludeAccountIds?: readonly string[]
  /**
   * The most the part-used card may be left with, below the store's own cap.
   * 0 plans full drains only: the till's second try when the shopper's card
   * would not hold the deposit a leftover needs (spec 5.2 step 2).
   */
  maxLeftoverCents?: number
  /**
   * Who is buying, when we know: their card customer and card fingerprint.
   * A shopper with two remainder reports or shortfalls in 30 days gets no
   * remainders and no part-used last card (spec 7.5). Absent, nobody is barred.
   */
  buyer?: { customerId: string; fingerprint: string | null } | null
}

/** One card of a till quote: the buyer-facing leg, plus what the buy records. */
export interface TillQuoteLeg extends QuoteLeg {
  source: LegSource
  firstInLine: boolean
  leftoverCents: number
  depositCents: number
  /** A remainder: the order whose purchase left it, for the next order's REMAINDER_OF. */
  remainderOf: string | null
}

/** A DemandQuote, so the shop's checks read it unchanged, plus the plan's deposit. */
export interface TillQuote extends Omit<DemandQuote, 'legs'> {
  legs: TillQuoteLeg[]
  depositCents: number
  preference: RoutePreference
  plan: TillPlan
}

/**
 * Quote a total at one store on one rail.
 *
 * Reads `offered` listings that have not expired, exactly the set the shared
 * matcher reads (quote.ts quoteDemand), split three ways: remainders and
 * cards behind a kept hold wait first in line, oldest first; everything else
 * is fresh. A remainder is planned at its own value and priced at its
 * listing's own discount; with no deposit behind it, the haircut comes off
 * its price (open decision 3).
 *
 * The no-quote reasons keep the matcher's phrases ("no live supply", "short
 * of"), because the shop turns those into sentences a shopper can act on.
 */
export async function quoteTill(rail: TillRail, req: TillQuoteRequest): Promise<TillQuote | NoQuote> {
  const now = req.now ?? new Date()
  if (!Number.isInteger(req.totalCents) || req.totalCents <= 0) {
    return { kind: 'no_quote', reason: `order total ${req.totalCents} is not a positive amount` }
  }
  if (rail !== 'card') {
    // THE SEAM, NOT A STUB. The dollars till joins this one with the second
    // escrow contract, which can sell part of a card. Until then the first
    // contract sells whole cards only, through its own quote.
    return { kind: 'no_quote', reason: 'the dollars rail quotes through the escrow until it can sell part of a card' }
  }

  const merchantId = req.merchantId.toLowerCase().trim()
  const live = await prisma.intent.findMany({
    where: {
      state: 'offered',
      merchantId,
      formFactor: 'in_store_barcode',
      expiresAt: { gt: now },
      ...(req.excludeIntentIds && req.excludeIntentIds.length > 0 ? { id: { notIn: [...req.excludeIntentIds] } } : {}),
      ...(req.excludeAccountIds && req.excludeAccountIds.length > 0
        ? { accountId: { notIn: [...req.excludeAccountIds] } }
        : {}),
    },
    orderBy: [{ expiresAt: 'asc' }],
    take: 200,
  })
  if (live.length === 0) return { kind: 'no_quote', reason: `no live supply for merchant ${merchantId}` }

  const candidate = (i: (typeof live)[number], balanceCents: number): TillCandidate => ({
    ref: i.id,
    accountId: i.accountId,
    balanceCents,
    priceCents: i.priceCents,
    faceValueCents: i.faceValueCents,
  })

  const isWaiting = (i: (typeof live)[number]) => decodeRemainder(i.failureReason) !== null || isFirstInLine(i)
  const waitingRows = live.filter(isWaiting)
  const line = await lineFacts(waitingRows)
  const waiting: FirstInLineCandidate[] = []
  for (const i of waitingOldestFirst(waitingRows, line.joinedAt)) {
    // NEVER THE SHOPPER WHOSE HOLD STANDS BEHIND IT. Routed back to them, a
    // second "didn't scan" read as two shoppers who could not scan the card,
    // and released both holds: a whole card for nothing. Matched by card
    // customer, and by the card itself under a new customer. Left out
    // entirely, not just from the front of the line: the next scan of it has
    // to be someone else's.
    const keptBy = line.keptBy.get(i.id)
    if (keptBy && req.buyer && ownsKeptHold(keptBy, req.buyer)) continue
    const remainder = decodeRemainder(i.failureReason)
    if (remainder) {
      // A remainder is its own value or nothing: face would quote value
      // that is not on the card. Relisting always writes it.
      if (i.lastKnownBalanceCents === null) continue
      waiting.push({
        ...candidate(i, i.lastKnownBalanceCents),
        kind: 'remainder',
        covered: remainder.depositPaymentIntentId !== null,
      })
    } else {
      // The kept hold behind it is what a deposit is for a remainder.
      waiting.push({ ...candidate(i, i.lastKnownBalanceCents ?? i.faceValueCents), kind: 'unscanned', covered: true })
    }
  }
  // `lastKnownBalanceCents` is what balance-watch last observed; face value is
  // the fallback before the first sweep, as for every quote. A card left out
  // above is left out here too: it is never fresh supply for its own shopper.
  const fresh = live.filter((i) => !isWaiting(i)).map((i) => candidate(i, i.lastKnownBalanceCents ?? i.faceValueCents))

  const preference = routePreference(req.preference)
  const storeCap = capForMerchant(merchantId)
  const cap =
    req.maxLeftoverCents !== undefined && Number.isSafeInteger(req.maxLeftoverCents)
      ? Math.max(0, Math.min(storeCap, req.maxLeftoverCents))
      : storeCap
  const buyerBarred = req.buyer ? (await remainderStrikes(req.buyer, now)) >= STRIKES_TO_BAR : false
  const plan = planTill({
    totalCents: req.totalCents,
    firstInLine: waiting,
    fresh,
    capCents: cap,
    buyerBarred,
    preference,
    minLegCostCents: CARD_MIN_CHARGE_CENTS,
    // A deposit only for a leftover that can be listed again: one under $1 is
    // retired (relist.ts), so a deposit on it would stand behind nothing.
    minDepositCents: Math.max(CARD_MIN_CHARGE_CENTS, REMAINDER_RELIST_MIN_CENTS),
    haircutBps: inferenceHaircutBps(),
  })
  if (isNoTillPlan(plan)) return { kind: 'no_quote', reason: plan.reason }

  const byId = new Map(live.map((i) => [i.id, i]))
  const legs: TillQuoteLeg[] = []
  for (const leg of plan.legs) {
    const intent = byId.get(leg.ref)
    if (!intent) return { kind: 'no_quote', reason: `supply ${leg.ref} is no longer available` }
    legs.push({
      intentId: intent.id,
      last4: intent.last4,
      appliedCents: leg.appliedCents,
      costCents: leg.costCents,
      fullyDrained: leg.fullyDrained,
      source: leg.source,
      firstInLine: leg.firstInLine,
      leftoverCents: leg.leftoverCents,
      depositCents: leg.depositCents,
      remainderOf: leg.source === 'remainder' ? (decodeRemainder(intent.failureReason)?.orderId ?? null) : null,
    })
  }

  return {
    kind: 'quote',
    merchantId,
    orderTotalCents: plan.totalCents,
    priceCents: plan.costCents,
    savingCents: plan.savingCents,
    discountBps: discountBps(plan.totalCents, plan.costCents),
    legs,
    fullDrain: plan.leftoverCents === 0,
    residualCents: plan.leftoverCents,
    expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
    depositCents: plan.depositCents,
    preference,
    plan,
  }
}

interface KeptBy {
  customerId: string | null
  fingerprint: string | null
}

/** Is this buyer the shopper whose kept hold stands behind the card? */
function ownsKeptHold(kept: KeptBy, buyer: { customerId: string; fingerprint: string | null }): boolean {
  if (kept.customerId !== null && kept.customerId === buyer.customerId) return true
  return kept.fingerprint !== null && kept.fingerprint === buyer.fingerprint
}

/**
 * What the line needs to know about each waiting card: when it joined (the
 * creation of the order its marker names, which is the purchase that put it
 * there) and, for a card behind a kept hold, whose hold that is. Two queries,
 * and none when nothing waits. An order that cannot be found leaves no
 * entry, and the row's own times stand in (supply/remainder.ts
 * waitingOldestFirst).
 */
async function lineFacts(
  rows: ReadonlyArray<{ id: string; failureReason: string | null }>,
): Promise<{ joinedAt: Map<string, Date>; keptBy: Map<string, KeptBy> }> {
  const orderOf = new Map<string, string>()
  const keptOrderOf = new Map<string, string>()
  for (const r of rows) {
    const kept = decodeUnscanned(r.failureReason)?.keptOrderId
    const orderId = decodeRemainder(r.failureReason)?.orderId ?? kept
    if (orderId) orderOf.set(r.id, orderId)
    if (kept) keptOrderOf.set(r.id, kept)
  }
  const joinedAt = new Map<string, Date>()
  const keptBy = new Map<string, KeptBy>()
  if (orderOf.size === 0) return { joinedAt, keptBy }
  const [orders, owners] = await Promise.all([
    prisma.order.findMany({
      where: { id: { in: [...new Set(orderOf.values())] } },
      select: { id: true, createdAt: true },
    }),
    keptHoldOwners([...new Set(keptOrderOf.values())]),
  ])
  const created = new Map(orders.map((o) => [o.id, o.createdAt]))
  for (const [intentId, orderId] of orderOf) {
    const at = created.get(orderId)
    if (at) joinedAt.set(intentId, at)
  }
  for (const [intentId, orderId] of keptOrderOf) {
    const owner = owners.get(orderId)
    if (owner) keptBy.set(intentId, owner)
  }
  return { joinedAt, keptBy }
}
