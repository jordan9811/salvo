/**
 * The till's dollars quote on SalvoEscrowV2 (unified spec sections 5.3, 6
 * and 6.3): live V2 supply at one store, read on the chain, handed to the
 * till's own planner, and written as the V2 quote the phone checks.
 *
 * ===========================================================================
 * ONE PLANNER, BOTH TILLS. planTill (route/plan.ts) picks the cards on the
 * dollars rail exactly as it does on the card rail: the leftovers waiting
 * first in line, oldest first and used whole; then fresh cards, at most one
 * left part used and within the store's cap; scored by the shopper's own
 * setting. The plan is written out by quote-v2.ts quoteV2Of, which refuses
 * any plan a phone would refuse, so our server never sends one.
 *
 * THE CHAIN, NOT THE ROW. Only the keeper moves a V2 listing's row, so the
 * value left on a card, its sales count and the deposit covering its
 * leftover are read live from SalvoEscrowV2's gate() on both hosts (kept five
 * seconds: a shopper typing quotes several times a second). A row the keeper
 * has not caught up with is never trusted, and the phone reads the chain
 * again itself before it pays (load-v2.ts).
 *
 * WHAT A LEFTOVER IS TO THE PLANNER.
 *   - Another shopper's, with their deposit behind it: first in line, used
 *     whole, at no haircut (the deposit stands behind it), once it has rested
 *     two hours after the sale that left it (quote-v2.ts LEFTOVER_REST_MS),
 *     or at once when that shopper's phone has said the till is done with
 *     the card (leftover-done.ts: Next past it, Done, or "Register says
 *     paid", proved with the card's own reply key). Before either, its first
 *     shopper may still have the card on screen, unscanned, and the next
 *     register would take what they paid for. The quote's two-minute hold is
 *     no guard: it ends while a cashier is slow, and the same shopper's next
 *     quote drops it.
 *   - One whose deposit came back by rule: first in line, used whole, the
 *     haircut off its price (decision 3).
 *   - The shopper's own, behind their own deposit: like a fresh card, so it
 *     may be used in part, and their deposit comes back in the same batch,
 *     netted (SalvoEscrowV2 reduceUse's rule, spec section 5.4).
 *
 * WHO GETS WHAT (spec 7.5, standing.ts). A buyer with two reports or
 * shortfalls in 30 days gets no leftovers and no part-used last card; a
 * seller whose leftovers two buyers found short is used whole only; a seller
 * with a sale under dispute is left out; the shopper's own listings are left
 * out, since the contract refuses a seller buying their own card.
 *
 * A QUOTE HOLDS ITS CARDS for the shopper for two minutes, and is the only
 * way to their tickets (quote.ts holdQuotedCards, takeQuotedTicket): the
 * same holds and limits as the first escrow's quote.
 * ===========================================================================
 *
 * Server-only: planTillQuoteV2 is pure; quoteTillV2Server reads the database
 * and both chain hosts.
 */

import type { Hex } from 'viem'
import { MERCHANT_BARCODE_PROFILES } from '@/lib/barcode/merchants'
import { prisma } from '@/lib/db'
import { QUOTE_TTL_MS } from '@/lib/demand/quote'
import { isNoTillPlan, planTill, type FirstInLineCandidate, type RoutePreference, type TillCandidate } from '@/lib/route/plan'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { escrowReaderV2 } from './chain-v2'
import { leftoverDone } from './leftover-done'
import { isSuspect } from './listing'
import { escrowVersionOfRef, readEscrowSealedRefV2 } from './listing-v2'
import { MAX_VALUE_CENTS, UNITS_PER_CENT } from './manifest'
import { residualCapLimitV2, type EscrowManifestV2 } from './manifest-v2'
import { ESCROW_MERCHANTS, escrowMerchantById, type EscrowMerchantName } from './merchants'
import { cardsNotQuotable, holdQuotedCards } from './quote'
import { LEFTOVER_REST_MS, MAX_QUOTE_LEGS_V2, quoteV2Of, type PlannedLegV2, type QuoteV2 } from './quote-v2'
import { ESCROW_INTENT_FORM_FACTOR } from './refs'
import { V2_STATE, type GateViewV2 } from './runbook/reads-v2'
import { escrowRuntime, templateV2Of, type EscrowRuntime } from './runtime'
import { escrowBuyerStanding, escrowDisputedSellersV2, escrowWholeCardSellers } from './standing'

/** Off the price of a leftover nothing covers: the haircut every V2 listing from our pages carries (sell-v2.ts). */
const UNCOVERED_HAIRCUT_BPS = 2_500
/** A listing's live state is read again after this: a shopper typing quotes several times a second. */
const GATE_SEEN_MS = 5_000
/** Listings read per quote at one store, oldest expiry first. */
const MAX_ROWS = 60
/**
 * A listing this close to its expiry is not quoted: the template refuses a
 * ticket within a minute of it, and the shopper may take the quote's whole
 * two minutes before the tap.
 */
const EXPIRY_MARGIN_MS = QUOTE_TTL_MS + 60_000
const ADDRESS_RE = /^0x[0-9a-f]{40}$/

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/** One V2 listing at the store, as the planner takes it: its terms and its state on chain now. */
export interface CandidateV2 {
  intentId: string
  /** `seller:<address>`, as the listing route records it. */
  accountId: string
  manifestText: string
  manifest: EscrowManifestV2
  envelope: LitEnvelope
  /** gate() now: the value left (0 before the first sale), the sales count, and the deposit covering the leftover. */
  remainingCents: number
  sales: number
  bondDeposit: bigint
  /** When the sale whose deposit covers the leftover opened, chain seconds; 0 when no deposit covers it. */
  bondOpenedAt: number
  /** The deposit covering the leftover is the shopper's own, still held. */
  ownBond: boolean
  /**
   * The shopper whose deposit covers the leftover said the till is done with
   * the card, with the key the chain names for that deposit (leftover-done.ts).
   */
  bondDone: boolean
}

/**
 * Another shopper's leftover whose sale is too recent to offer
 * (LEFTOVER_REST_MS): its first shopper may still have the card on screen,
 * unscanned. Not once that shopper said the till is done with it: nobody is
 * left to protect. The shopper's own leftover never rests: it is theirs.
 */
function restingV2(c: Pick<CandidateV2, 'sales' | 'ownBond' | 'bondDeposit' | 'bondOpenedAt' | 'bondDone'>, nowSeconds: number): boolean {
  return c.sales > 0 && !c.ownBond && c.bondDeposit !== 0n && !c.bondDone && (nowSeconds - c.bondOpenedAt) * 1000 < LEFTOVER_REST_MS
}

export interface QuoteUnavailableV2 {
  unavailable: string
  /** Nothing is listed at this store at all, whatever the total. */
  nothingListed?: boolean
}

/** A V2 card as the planner sees it: what is on it now, at its listing's discount. */
function candidateOf(c: CandidateV2): TillCandidate {
  const m = c.manifest
  return {
    ref: c.intentId,
    accountId: c.accountId,
    balanceCents: c.sales === 0 ? m.valueCents : c.remainingCents,
    priceCents: Math.ceil(m.price / UNITS_PER_CENT),
    faceValueCents: m.valueCents,
  }
}

/**
 * Plan a total over V2 supply that has already been read, and write it as a
 * V2 quote. Pure. `candidates`: every listing at the store the shopper may
 * buy, live, oldest leftover first.
 */
export function planTillQuoteV2(input: {
  quoteId: string
  merchant: EscrowMerchantName
  totalCents: number
  depositor: Hex
  escrow: Hex
  preference: RoutePreference
  candidates: readonly CandidateV2[]
  buyerBarred: boolean
  demotedAccountIds: readonly string[]
  expiresAt: string
  /** Chain time of the block the candidates were read at, seconds: how long each leftover has rested. */
  nowSeconds: number
}): QuoteV2 | QuoteUnavailableV2 {
  const store = input.merchant === 'salvotest' ? 'Salvo test' : (MERCHANT_BARCODE_PROFILES[input.merchant]?.displayName ?? input.merchant)
  if (input.candidates.length === 0) return { unavailable: `Nothing at ${store} right now. Pay your usual way.`, nothingListed: true }
  const notEnough: QuoteUnavailableV2 = { unavailable: `There is not enough at ${store} right now to cover ${dollars(input.totalCents)}.` }
  // Another shopper's leftover is not offered until it has rested, or they are done with it: until then they may still have it on screen.
  const usable = input.candidates.filter((c) => !restingV2(c, input.nowSeconds))
  if (usable.length === 0) return notEnough
  const firstInLine: FirstInLineCandidate[] = []
  const fresh: TillCandidate[] = []
  for (const c of usable) {
    if (c.sales === 0 || c.ownBond) fresh.push(candidateOf(c))
    else firstInLine.push({ ...candidateOf(c), kind: 'remainder', covered: c.bondDeposit !== 0n })
  }
  // The store's cap, never above any listing's own: the one card left part used must fit its listing.
  const mc = ESCROW_MERCHANTS[input.merchant]
  const cap = Math.min(...usable.map((c) => Math.min(c.manifest.residualCapCents, residualCapLimitV2(mc, c.manifest.mode))))
  const plan = planTill({
    totalCents: input.totalCents,
    firstInLine,
    fresh,
    capCents: cap,
    preference: { ...input.preference, maxCards: Math.min(input.preference.maxCards, MAX_QUOTE_LEGS_V2) as RoutePreference['maxCards'] },
    minLegCostCents: 1,
    minDepositCents: 1,
    haircutBps: UNCOVERED_HAIRCUT_BPS,
    buyerBarred: input.buyerBarred,
    demotedAccountIds: input.demotedAccountIds,
  })
  if (isNoTillPlan(plan)) return notEnough
  const byId = new Map(usable.map((c) => [c.intentId, c]))
  const legs: PlannedLegV2[] = plan.legs.map((l) => {
    const c = byId.get(l.ref) as CandidateV2
    return { intentId: c.intentId, manifestText: c.manifestText, envelope: c.envelope, remainingCents: c.remainingCents, sales: c.sales, bondDeposit: c.bondDeposit, usedCents: l.appliedCents }
  })
  try {
    return quoteV2Of({ quoteId: input.quoteId, merchant: input.merchant, totalCents: input.totalCents, escrow: input.escrow, depositor: input.depositor, legs, expiresAt: input.expiresAt })
  } catch (err) {
    if (!(err instanceof RangeError)) throw err
    return { unavailable: `We cannot cover exactly ${dollars(input.totalCents)} at ${store} right now. Try again in a moment.` }
  }
}

/**
 * listingId -> its gate, whose deposit covers its leftover, since when (chain
 * seconds) and under which reply key, until when (ms). Whether that shopper
 * is done with the card is asked at every quote, never kept here: a done
 * mark counts the moment it lands.
 */
const gateSeen = new Map<string, { until: number; gate: GateViewV2; ownBondOf: Hex | null; bondOpenedAt: number; bondKeyHash: Hex | null }>()

function randomQuoteId(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(12))
  return `t2_${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`
}

/** Tests only: forget every chain read kept. */
export function __clearTillQuoteV2ForTests(): void {
  gateSeen.clear()
}

/**
 * Price a total at the till on SalvoEscrowV2 for `depositor`, the shopper's
 * own address, and hold the cards quoted for them. `address`: where the
 * request came from (http.ts clientAddress), only to cap how many cards one
 * place can hold.
 */
export async function quoteTillV2Server(
  input: { merchant: string; totalCents: number; depositor: Hex; preference: RoutePreference; exclude: readonly string[]; address: string; preview?: boolean },
  rt: EscrowRuntime = escrowRuntime(),
): Promise<QuoteV2 | QuoteUnavailableV2 | { limited: string }> {
  const name = input.merchant.toLowerCase().trim()
  if (!Object.prototype.hasOwnProperty.call(ESCROW_MERCHANTS, name)) return { unavailable: `Salvo Pay is not at ${input.merchant.slice(0, 40)} yet.` }
  const merchant = name as EscrowMerchantName
  const most = MAX_QUOTE_LEGS_V2 * MAX_VALUE_CENTS
  if (!Number.isSafeInteger(input.totalCents) || input.totalCents < 1 || input.totalCents > most) return { unavailable: `Type a total between $0.01 and ${dollars(most)}.` }
  const holder = input.depositor.toLowerCase() as Hex
  if (!ADDRESS_RE.test(holder)) return { unavailable: 'That is not a wallet address.' }
  const reader = escrowReaderV2(rt)
  // The route answers not_ready before this whenever V2 is not configured.
  if (reader === null) throw new Error('there is no pinned V2 escrow to read')
  const template = templateV2Of(rt)
  const nowMs = rt.now()
  const now = new Date(nowMs)

  const [disputed, wholeOnly, standing] = await Promise.all([escrowDisputedSellersV2(), escrowWholeCardSellers(), escrowBuyerStanding(holder, now)])
  const notQuotable = cardsNotQuotable(holder, nowMs)
  const rows = await prisma.intent.findMany({
    where: {
      state: 'offered',
      merchantId: merchant,
      formFactor: ESCROW_INTENT_FORM_FACTOR,
      expiresAt: { gt: new Date(nowMs + EXPIRY_MARGIN_MS) },
      id: { notIn: [...notQuotable, ...input.exclude] },
      accountId: { notIn: [...disputed.map((s) => `seller:${s}`), `seller:${holder}`] },
    },
    orderBy: [{ expiresAt: 'asc' }],
    take: MAX_ROWS,
  })
  const listed = rows.flatMap((r) => {
    if (escrowVersionOfRef(r.sealedRef) !== 2 || isSuspect(r.failureReason, now)) return []
    const sealed = readEscrowSealedRefV2(r.sealedRef, template)
    if (sealed === null || escrowMerchantById(sealed.manifest.merchant)?.name !== merchant) return []
    return [{ row: r, sealed }]
  })

  // Each card's state on chain now: at one finalized block on both hosts, kept a few seconds.
  const block = await reader.block()
  const candidates: CandidateV2[] = []
  await Promise.all(
    listed.map(async ({ row, sealed }) => {
      let seen = gateSeen.get(sealed.listingId)
      if (seen === undefined || seen.until <= nowMs) {
        const gate = await reader.gate(block, sealed.listingId, 0n)
        let ownBondOf: Hex | null = null
        let bondOpenedAt = 0
        let bondKeyHash: Hex | null = null
        if (gate.bondDeposit !== 0n) {
          const bond = await reader.deposit(block, gate.bondDeposit)
          if (bond.bondState === V2_STATE.bond.HELD) ownBondOf = bond.depositor
          // The sale that left the leftover: it rests from here (restingV2), until the key it names says done.
          bondOpenedAt = bond.openedAt
          bondKeyHash = bond.replyKeyHash
        }
        seen = { until: nowMs + GATE_SEEN_MS, gate, ownBondOf, bondOpenedAt, bondKeyHash }
        gateSeen.set(sealed.listingId, seen)
      }
      const g = seen.gate
      const left = g.sales === 0 ? sealed.manifest.valueCents : g.remainingCents
      if (g.listingState !== V2_STATE.listing.ACTIVE || g.listingSeller !== sealed.manifest.seller || left < 1) return
      if (Number(block.timestamp) * 1000 + EXPIRY_MARGIN_MS >= sealed.manifest.listingExpiry * 1000) return
      candidates.push({
        intentId: row.id,
        accountId: row.accountId,
        manifestText: sealed.manifestText,
        manifest: sealed.manifest,
        envelope: sealed.envelope,
        remainingCents: g.remainingCents,
        sales: g.sales,
        bondDeposit: g.bondDeposit,
        bondOpenedAt: seen.bondOpenedAt,
        ownBond: seen.ownBondOf === holder,
        bondDone: seen.bondKeyHash !== null && leftoverDone.done(reader.escrow, g.bondDeposit, seen.bondKeyHash, nowMs),
      })
    }),
  )
  // Oldest leftover first: deposit ids run in time order, so the deposit covering it says when it was left.
  candidates.sort((a, b) => (a.bondDeposit === b.bondDeposit ? a.intentId.localeCompare(b.intentId) : a.bondDeposit < b.bondDeposit ? -1 : 1))

  const quote = planTillQuoteV2({
    quoteId: randomQuoteId(),
    merchant,
    totalCents: input.totalCents,
    depositor: holder,
    escrow: reader.escrow,
    preference: input.preference,
    candidates,
    buyerBarred: !standing.remaindersAllowed,
    demotedAccountIds: wholeOnly.map((s) => `seller:${s}`),
    expiresAt: new Date(nowMs + QUOTE_TTL_MS).toISOString(),
    nowSeconds: Number(block.timestamp),
  })
  if ('unavailable' in quote) return quote
  // A PREVIEW HOLDS NOTHING. A phone that cannot pay with dollars yet still
  // asks the price, under the zero address: a look at the till must never
  // hold a card from the shopper behind them. Its tickets are never asked for.
  if (input.preview === true) return quote
  if (!holdQuotedCards(holder, input.address, quote.legs.map((l) => l.intentId), nowMs)) {
    return { limited: 'Too many cards are held from here right now. Wait two minutes and try again.' }
  }
  return quote
}
