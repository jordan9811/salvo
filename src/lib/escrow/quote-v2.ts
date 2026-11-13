/**
 * A dollars-rail quote on SalvoEscrowV2, as our server writes it and as the
 * shopper's phone checks it (unified spec sections 5.3, 6 and 8.3).
 *
 * ONE SHAPE, TWO SIDES. The till's planner (planTill, which lands with the
 * till's merge) picks the cards; quoteV2Of writes what it picked in the shape
 * the phone reads (client/api-v2.ts parseQuoteV2), and quoteProblemsV2 is the
 * rule both sides hold it to: our server before it answers, and the phone
 * before it asks Lit for a ticket. The phone runs its own copy of this file,
 * so a server that changed only its answers is still refused.
 *
 * WHAT A V2 LEG SAYS. Each card names the listing state the plan read (the
 * value left on it, its sales count, the deposit covering what is left), the
 * cents this purchase uses, and what the contract will charge for them: the
 * seller's share of the price for the cents used, and the cents left at face
 * as the deposit. The contract alone decides (SalvoEscrowV2._priceUse); these
 * are its rules in TypeScript (terms-v2.ts), so the phone can refuse a quote
 * the contract would price differently before it pays.
 *
 * THE RULES (spec sections 6.2 and 8.5):
 *   - every card but the last is used up; only the last may keep a leftover,
 *     and at most its listing's cap (never above $5 blind, $10 readable);
 *   - a quote that cannot cover the total leaves no leftover at all: every
 *     card is used up and the rest is "then $X your usual way";
 *   - the cents used on the last card are the total less the cards before it,
 *     never a number the shopper is asked for;
 *   - no card the total does not need;
 *   - a remainder (a card already partly used) is priced at the seller's own
 *     discount, with the remainder haircut off the price only when no deposit
 *     covers it (decision 3); whether it must be used whole is the chain's to
 *     say (load-v2.ts), since only the chain knows whose deposit covers it.
 *
 * Isomorphic: no Node imports. The browser loads this.
 */

import type { Hex } from 'viem'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { listingIdOfSealV2 } from './hashes-v2'
import { PATH_USD, UNITS_PER_CENT } from './manifest'
import { parseEscrowManifestV2, residualCapLimitV2, type EscrowManifestV2 } from './manifest-v2'
import { escrowMerchantById, type EscrowMerchantName, type EscrowMode } from './merchants'
import { escrowIntentIdFor } from './refs'
import { priceForV2 } from './terms-v2'

/** The most cards one V2 quote may name: the till's max-cards setting tops out at 5 (spec section 3.3). */
export const MAX_QUOTE_LEGS_V2 = 5

/**
 * How long another shopper's leftover rests after the sale that left it,
 * before the till offers it to anyone else (till-quote-v2.ts).
 *
 * ITS FIRST SHOPPER MAY STILL HAVE THAT CARD ON SCREEN, UNSCANNED. Every card
 * of a purchase is paid at the tap and scanned after, and a register takes a
 * gift card's balance up to what is due. Offered at once, the next shopper's
 * register took what the first shopper had paid for and not scanned yet, and
 * the first shopper's own scan was then declined. Nothing on the chain says
 * the first scan happened, so the leftover waits two hours, far past any
 * register. Meanwhile the first shopper's phone shows that card again after
 * a reload, and makes every card it never showed their store credit
 * (dollars-backend.ts), which takes those leftovers off sale at once.
 *
 * THE REST ENDS EARLY ONCE THAT SHOPPER IS DONE WITH THE CARD. Their phone
 * says so, proved with the card's own reply key, when the till moves past it
 * (Next, Done, "Register says paid"), and the leftover is offered at once
 * (leftover-done.ts, POST /api/escrow/done). A shopper who never says so
 * keeps the whole two hours.
 */
export const LEFTOVER_REST_MS = 2 * 3_600_000

/** One card of a V2 quote. */
export interface QuoteLegV2 {
  intentId: string
  listingId: Hex
  /** The 14-key V2 manifest, exactly as sealed. */
  manifest: string
  envelope: LitEnvelope
  seller: Hex
  mode: EscrowMode
  /** `remainder`: the card was partly used before (sales > 0). `fresh`: its first sale. */
  source: 'remainder' | 'fresh'
  /** The value left on the card the plan read: the card's value before its first sale. */
  remainingCents: number
  /** The listing's sales the plan read. */
  sales: number
  /** The deposit covering what is left, as the plan read it: 0 if none. */
  bondDeposit: number
  /** The cents this purchase uses on the card. */
  usedCents: number
  /** The cents it leaves on the card: the remaining value less the cents used. */
  leftCents: number
  /** What the seller is paid for the cents used, in token units. */
  amountUnits: number
  /** The deposit at face on the cents left, in token units. */
  bondUnits: number
  scanOrder: number
}

export interface QuoteV2 {
  version: 2
  quoteId: string
  merchant: EscrowMerchantName
  /** What the shopper typed. */
  totalCents: number
  /** What the cards cover: the sum of the cents used. */
  coveredCents: number
  /** What is left to pay the usual way: the total less what the cards cover. */
  uncoveredCents: number
  amountUnits: number
  bondUnits: number
  /** The amount in dollars, rounded up. */
  priceCents: number
  /** The deposit in dollars: the cents left on the last card, at face. */
  depositCents: number
  /** The cents covered less the price. */
  savingCents: number
  legs: QuoteLegV2[]
  expiresAt: string
}

/** One card the planner picked, with the listing state it read and the cents it uses. */
export interface PlannedLegV2 {
  intentId: string
  manifestText: string
  envelope: LitEnvelope
  /** gate().remainingCents (0 before the first sale), sales and bondDeposit, as read. */
  remainingCents: number
  sales: number
  bondDeposit: bigint
  usedCents: number
}

const ceilDiv = (n: number, d: number): number => Math.ceil(n / d)

/** The value left a listing state means: the card's value before the first sale. */
export function valueLeftV2(m: EscrowManifestV2, sales: number, remainingCents: number): number {
  return sales === 0 ? m.valueCents : remainingCents
}

/**
 * What the contract charges for `usedCents` of a card in this state, as the
 * quote states it: the seller's share for the cents used and the cents left
 * at face. The haircut comes off only a remainder no deposit covers.
 */
export function legChargeV2(m: EscrowManifestV2, sales: number, bondDeposit: bigint | number, valueLeft: number, usedCents: number): { amountUnits: number; bondUnits: number; leftCents: number } {
  const haircut = sales > 0 && BigInt(bondDeposit) === 0n
  const amount = priceForV2(BigInt(m.price), m.valueCents, usedCents, haircut ? m.remainderHaircutBps : 0)
  const leftCents = valueLeft - usedCents
  return { amountUnits: Number(amount), bondUnits: leftCents * UNITS_PER_CENT, leftCents }
}

/**
 * Write the planner's cards as a V2 quote. Throws RangeError for a plan the
 * phone would refuse (quoteProblemsV2), so our server never sends one.
 */
export function quoteV2Of(input: {
  quoteId: string
  merchant: EscrowMerchantName
  totalCents: number
  escrow: Hex
  depositor: Hex
  legs: readonly PlannedLegV2[]
  expiresAt: string
}): QuoteV2 {
  const legs: QuoteLegV2[] = input.legs.map((l, i) => {
    const m = parseEscrowManifestV2(l.manifestText, input.escrow)
    if (m === null) throw new RangeError('a planned card is not a V2 listing on this escrow')
    const valueLeft = valueLeftV2(m, l.sales, l.remainingCents)
    const charge = legChargeV2(m, l.sales, l.bondDeposit, valueLeft, l.usedCents)
    return {
      intentId: l.intentId,
      listingId: listingIdOfSealV2(m, l.envelope),
      manifest: l.manifestText,
      envelope: l.envelope,
      seller: m.seller,
      mode: m.mode,
      source: l.sales > 0 ? 'remainder' : 'fresh',
      remainingCents: valueLeft,
      sales: l.sales,
      bondDeposit: Number(l.bondDeposit),
      usedCents: l.usedCents,
      leftCents: charge.leftCents,
      amountUnits: charge.amountUnits,
      bondUnits: charge.bondUnits,
      scanOrder: i + 1,
    }
  })
  const coveredCents = legs.reduce((n, l) => n + l.usedCents, 0)
  const amountUnits = legs.reduce((n, l) => n + l.amountUnits, 0)
  const bondUnits = legs.reduce((n, l) => n + l.bondUnits, 0)
  const priceCents = ceilDiv(amountUnits, UNITS_PER_CENT)
  const q: QuoteV2 = {
    version: 2,
    quoteId: input.quoteId,
    merchant: input.merchant,
    totalCents: input.totalCents,
    coveredCents,
    uncoveredCents: input.totalCents - coveredCents,
    amountUnits,
    bondUnits,
    priceCents,
    depositCents: legs.reduce((n, l) => n + l.leftCents, 0),
    savingCents: coveredCents - priceCents,
    legs,
    expiresAt: input.expiresAt,
  }
  const problems = quoteProblemsV2(q, { merchant: input.merchant, totalCents: input.totalCents, depositor: input.depositor }, input.escrow)
  if (problems.length > 0) throw new RangeError(`the plan is not one a phone would pay: ${problems.join('; ')}`)
  return q
}

/** What the shopper asked for. */
export interface QuoteAskV2 {
  merchant: EscrowMerchantName
  totalCents: number
  depositor: Hex
  /** Cards the plan must leave out: one the shopper just reported, so its leftover is not sold back to them. */
  exclude?: readonly string[]
}

/**
 * Every reason this quote is not the one asked for, or not what its own
 * manifests say, or not priced the way the contract prices it. Pure; empty
 * means consistent. The chain's half (each listing's state now, and whose
 * deposit covers a remainder) is load-v2.ts's.
 */
export function quoteProblemsV2(q: QuoteV2, ask: QuoteAskV2, escrow: Hex): string[] {
  const out: string[] = []
  if (q.version !== 2) out.push('the quote is not for the new escrow')
  if (q.merchant !== ask.merchant) out.push('the quote is for another store')
  if (q.totalCents !== ask.totalCents) out.push('the quote is for another amount')
  if (q.legs.length < 1 || q.legs.length > MAX_QUOTE_LEGS_V2) out.push('the quote names too many cards')
  if (q.legs.some((l, i) => l.scanOrder !== i + 1)) out.push('the cards are not in scan order')
  if (new Set(q.legs.map((l) => l.listingId)).size !== q.legs.length) out.push('the quote names one card twice')
  if (q.legs.some((l) => ask.exclude?.includes(l.intentId) === true)) out.push('the quote names a card you just reported')
  const depositor = ask.depositor.toLowerCase()
  let covered = 0
  let amount = 0
  let bond = 0
  let left = 0
  for (const [i, leg] of q.legs.entries()) {
    const m = parseEscrowManifestV2(leg.manifest, escrow)
    if (m === null) {
      out.push('a card is not listed on the escrow this page trusts')
      continue
    }
    const mc = escrowMerchantById(m.merchant)
    if (mc?.name !== ask.merchant) out.push('a card is for another store')
    if (m.seller !== leg.seller) out.push("a card's seller is not its listing's")
    if (m.mode !== leg.mode) out.push("a card's check is not its listing's")
    if (m.seller === depositor) out.push('a card is your own listing')
    if (m.token !== PATH_USD) out.push('a card is priced in another token')
    if (listingIdOfSealV2(m, leg.envelope) !== leg.listingId) out.push("a card's terms do not hash to its listing")
    if (escrowIntentIdFor(leg.listingId) !== leg.intentId) out.push("a card's id is not its listing's")
    if (!Number.isSafeInteger(leg.sales) || leg.sales < 0) out.push("a card's sales count is not a count")
    if (leg.source !== (leg.sales > 0 ? 'remainder' : 'fresh')) out.push('a card is called fresh or partly used wrongly')
    if (leg.sales === 0 && leg.remainingCents !== m.valueCents) out.push("a new card's value is not its listing's")
    if (leg.remainingCents < 1 || leg.remainingCents > m.valueCents) out.push("a card's value left is not one its listing can have")
    if (leg.sales === 0 && leg.bondDeposit !== 0) out.push('a new card names a deposit')
    if (!Number.isSafeInteger(leg.usedCents) || leg.usedCents < 1 || leg.usedCents > leg.remainingCents) out.push('a card is used for more than is on it')
    const charge = legChargeV2(m, leg.sales, leg.bondDeposit, leg.remainingCents, leg.usedCents)
    if (leg.leftCents !== charge.leftCents) out.push('the cents left on a card are not what using it leaves')
    if (charge.leftCents > m.residualCapCents || (mc !== null && charge.leftCents > residualCapLimitV2(mc, m.mode))) {
      out.push('a card leaves more over than the store allows')
    }
    if (leg.amountUnits !== charge.amountUnits) out.push("a card's price is not what the escrow charges for the cents used")
    if (leg.bondUnits !== charge.bondUnits) out.push("a card's deposit is not the cents left at face")
    if (i < q.legs.length - 1 && charge.leftCents !== 0) out.push('a card before the last is not used up')
    covered += leg.usedCents
    amount += leg.amountUnits
    bond += leg.bondUnits
    left += leg.leftCents
  }
  if (covered !== q.coveredCents) out.push('the cents used do not add up to what the cards cover')
  if (q.coveredCents + q.uncoveredCents !== q.totalCents || q.uncoveredCents < 0) out.push('what the cards cover and the rest do not add up to the total')
  if (q.uncoveredCents > 0 && left > 0) out.push('a quote that does not cover the total leaves a card partly used')
  if (amount !== q.amountUnits) out.push('the prices do not add up to the total')
  if (bond !== q.bondUnits) out.push('the deposits do not add up')
  if (q.priceCents !== ceilDiv(q.amountUnits, UNITS_PER_CENT)) out.push('the price in dollars is not the price')
  if (q.depositCents !== left) out.push('the deposit in dollars is not the cents left')
  if (q.savingCents !== q.coveredCents - q.priceCents) out.push('the saving is not what the cards save')
  // Every card but the last is used up. If they already cover the total, the last is one the shopper does not need.
  const beforeLast = q.legs.slice(0, -1).reduce((n, l) => n + l.remainingCents, 0)
  if (q.legs.length > 1 && beforeLast >= q.totalCents) out.push('the quote adds a card you do not need')
  return out
}
