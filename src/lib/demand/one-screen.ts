/**
 * The one-screen buy.
 *
 * ===========================================================================
 * WHAT THIS REPLACES, AND WHY IT IS NOT A NEW ENGINE.
 *
 * The shipped flow is a harness, not a product: browse a list of gift cards,
 * pick one, pay, open an order page, tap reveal, show a barcode. Six steps, and
 * every one of them makes the buyer think about gift cards — a thing they never
 * wanted and would not have gone looking for. What they actually want is to pay
 * less for the purchase they were already making.
 *
 * So the surface collapses to: which shop, how much, one tap.
 *
 * Nothing here decides anything. `quoteTill` turns "spend $80 at Best Buy"
 * into a priced plan over live supply: the till's planner (route/plan.ts)
 * with per-seller pro-rata pricing, remainders first in line, and the
 * shopper's own setting. Buying reuses `createPaidOrder` and `matchIntent`
 * exactly as `buyOffer` does, including the orphaned-order refund. This
 * module is the adapter between those two, and it is deliberately thin.
 * ===========================================================================
 *
 * SEVERAL CARDS, AS ONE ORDER EACH. A shopper's total rarely equals one card,
 * and covering it with one whole card leaves them paying the rest at the
 * register themselves, which is a poor trip for a small discount. So a spend is
 * covered by several cards: all of each but the last and, where needed, part
 * of the last, scanned one after the other at the till. How many is the
 * shopper's setting: two by default ("In and out"), up to five.
 *
 * Every part of the reveal path (the claim, the window marker, the settle
 * credential, the balance delta, the refund) is written around ONE intent per
 * order, and that is the atomic settlement path. So rather than teach it about
 * two cards, each card becomes its own order with its own price, and the pair
 * is matched in one transaction (`matchIntentsTogether`) so a purchase never
 * holds half its cards. The settlement path is untouched: each card settles,
 * releases or refunds exactly as a single-card order always has.
 *
 * The leftover rule still applies to every card: a card may only be revealed
 * if what is left on it beyond what this purchase applies at the register is
 * within the merchant's cap, because the shopper sees its barcode. A card used
 * up leaves nothing, whatever its discount. A part-used second card is
 * therefore one whose remainder is small; raising the cap is what lets bigger
 * remainders leapfrog to the next shopper, and it is a risk decision.
 *
 * PAY ON SCAN: NOTHING IS CHARGED HERE. With a payer, a buy only RESERVES each
 * card against the shopper's saved card (`hold:<cus>:none`). Each card's price
 * is held at its own Show my code, and taken only if that code works, so a
 * two-card purchase is two separate holds placed at two separate taps. That is
 * also why every card must be at least Stripe's 50c minimum: a card priced
 * under it would reserve here and then fail at the till.
 */

import { randomUUID } from 'node:crypto'
import type { Intent, Order } from '@prisma/client'
import { prisma } from '../db'
import { env } from '../env'
import { createPaidOrders, type CreatePaidOrderInput } from '../orders'
import { CapacityError } from '../inventory'
import { matchIntentsTogether } from '../intent/service'
import { carriesRealMoney } from '../fake-fulfilment-guard'
import { hasBarcodeProfile } from '../barcode/merchants'
import { hasPublicBalanceLookup } from '../barcode/balance-readers'
import { HoldUnavailableError, STRIPE_MIN_CHARGE_CENTS, reservedRef } from '../hold/ref'
import { AllowanceExceededError, assertBuyFits, savedCard, type SharedHoldReads } from '../hold/stripe-hold'
import { isNoQuote, type DemandQuote } from './quote'
import { quoteTill, type TillQuote, type TillQuoteLeg, type TillQuoteRequest } from './till-quote'
import { recordSpendLeg, recordTillLeg } from './spend-leg'
import { decodeRemainder, recordRemainderOf } from '../supply/remainder'
import { decideReveal, type RevealDecision } from '../barcode/reveal'
import { BALANCE_BLIND, BALANCE_READABLE } from '../barcode/evidence'

/**
 * The cards in the order they are scanned: used-up cards first, the part-used
 * one last (route/scan-order.ts says why). The till's plan is already in this
 * order; kept here under its old name for callers of the old rule.
 */
export { tillScanOrder as scanOrder } from '../route/scan-order'

/** The residual cap the reveal enforces, by merchant. Lives with the till's quote now. */
export { capForMerchant } from './till-quote'

/**
 * Would the reveal refuse this card for this much of the bill?
 *
 * ===========================================================================
 * TWO CAPS THAT LOOKED LIKE ONE, AND THE GAP BETWEEN THEM WAS SELLABLE.
 *
 * `planCardMatch` already bounds a residual, so this looked covered. It was
 * not, because the two bounded DIFFERENT QUANTITIES:
 *
 *   matcher:  balance - APPLIED   (what is left once the register takes its part)
 *   reveal:   face - PRICE        (what the buyer paid us, pro-rated below that)
 *
 * Price is always below the applied value (that is the discount, the entire
 * product), so the reveal's figure was always the larger one, and a plan could
 * satisfy the matcher and still be refused at the register. The first fix was
 * a ceiling on the listable discount, which closed the gap by refusing cards:
 * a $60 Target card at 10% off could not be listed at all, though using all of
 * it leaves $0.
 *
 * NOW BOTH MEASURE THE SAME THING. Exposure is what is left on the card beyond
 * what this purchase applies (docs/mechanism/settlement.md), so the reveal is
 * passed the applied value, recorded on the order at buy (spend-leg.ts), and
 * this precheck passes the same figure. A full drain exposes nothing at any
 * discount, and the discount ceiling is gone.
 *
 * This calls `decideReveal` rather than restating its arithmetic. Two
 * implementations of one cap drift, and the old gap is what that drift looks
 * like.
 *
 * THE ONE DIFFERENCE, STATED: the reveal probes the balance and we cannot, so a
 * readable merchant is checked against its last swept balance falling back to
 * the declared face — the same fallback `quoteDemand` uses to build candidates.
 * A blind merchant passes null, exactly as the reveal will.
 *
 * A BLIND MERCHANT'S DECLARED VALUE IS THE CARD'S VALUE NOW, by the same
 * fallback: the face until something lower is known. A remainder listed again
 * holds only what the last purchase left (supply/remainder.ts), and measured
 * against its face it read as the whole spent part "exposed", so every
 * remainder at Target was refused. The reveal uses the same figure, from the
 * order's spend leg (spend-leg.ts `cardValueCents`).
 * ===========================================================================
 */
export function revealPrecheck(
  intent: { merchantId: string; faceValueCents: number; lastKnownBalanceCents: number | null },
  appliedCents: number,
): RevealDecision {
  const readable = hasPublicBalanceLookup(intent.merchantId)
  const value = intent.lastKnownBalanceCents ?? intent.faceValueCents
  return decideReveal({
    balanceCents: readable ? value : null,
    purchasedValueCents: appliedCents,
    capabilities: readable ? BALANCE_READABLE : BALANCE_BLIND,
    declaredValueCents: value,
  })
}

/** The buyer-facing shape. Carries no intent ids and no card material. */
export interface SpendOffer {
  merchantId: string
  /** What they asked to spend at the shop. */
  spendCents: number
  /** What we charge them. Always less. */
  priceCents: number
  savingCents: number
  discountBps: number
  expiresAt: string
  /** How many codes they will scan at the till: up to the shopper's card limit, two by default. */
  cards: number
}

/**
 * Why a pay-on-scan buy was refused, for a caller that answers each one
 * differently. Absent on every other refusal.
 */
export type SpendUnavailableCode = 'card_required' | 'over_allowance' | 'hold_closed' | 'price_changed'

/**
 * The numbers behind over_allowance. `heldCents` is live holds only, and
 * `reservedCents` the reservations that hold nothing yet.
 */
interface AllowanceDetail {
  heldCents: number
  reservedCents: number
  allowanceCents: number
}

export class SpendUnavailableError extends Error {
  readonly code: SpendUnavailableCode | undefined
  /** The numbers behind over_allowance, so the shopper can be told them. */
  readonly detail: AllowanceDetail | undefined
  /**
   * No plan covers this total from what is on sale: short of supply, no
   * plan inside the cap, or a card too small to charge. The shop's sentence
   * asks for another amount; the till says it in its own words.
   */
  readonly cannotCover: boolean
  /** Nothing is listed at this store at all. */
  readonly noSupply: boolean
  /** price_changed: the plan as it stands now, which is past the ceiling the caller set. */
  readonly quote: TillQuote | undefined

  constructor(
    message: string,
    opts: {
      code?: SpendUnavailableCode
      detail?: AllowanceDetail
      cannotCover?: boolean
      noSupply?: boolean
      quote?: TillQuote
    } = {},
  ) {
    super(message)
    this.name = 'SpendUnavailableError'
    this.code = opts.code
    this.detail = opts.detail
    this.cannotCover = opts.cannotCover === true
    this.noSupply = opts.noSupply === true
    this.quote = opts.quote
  }
}

/** The sentence for a card too small to charge, or a remainder too large to show. */
function roundAmountRefusal(orderTotalCents: number): string {
  return (
    `We cannot sell exactly $${(orderTotalCents / 100).toFixed(2)} against what is ` +
    `available. Try a little more, or a round amount.`
  )
}

/** Refusals a buyer can act on, all of them at once. */
export function spendRefusals(input: { merchantId: string; spendCents: number }): string[] {
  const reasons: string[] = []
  const merchant = input.merchantId.toLowerCase().trim()

  // The balance-lookup half of this condition is GONE, and it was the same
  // closure Phase 15 removed from listing: a merchant we cannot read is
  // BALANCE_BLIND, which is a settlement route rather than an unsupported
  // state. A barcode profile is still required, because without one we would be
  // guessing a symbology and a wrong guess simply does not beep at the till.
  if (!hasBarcodeProfile(merchant)) {
    reasons.push(`We are not in ${input.merchantId} yet.`)
  }
  if (!Number.isFinite(input.spendCents) || input.spendCents <= 0) {
    reasons.push('Enter how much you are spending.')
  }
  return reasons
}

/**
 * Price a spend against live supply.
 *
 * A quote is not a reservation — it says so and stamps a short expiry — so
 * the buy path below re-quotes rather than trusting this one.
 *
 * THE SAME CAP THE REVEAL WILL APPLY, inside `quoteTill` (capForMerchant).
 * Quoting every merchant at the readable cap would offer a blind card leaving
 * more residual than its reveal permits — the buyer pays, the reveal refuses,
 * and they are refunded for something this quote could have declined to offer.
 */
export async function quoteSpend(input: {
  merchantId: string
  spendCents: number
  /** The shopper's setting. Absent, in and out with two cards, as before it existed. */
  preference?: TillQuoteRequest['preference']
  now?: Date
}): Promise<SpendOffer | SpendUnavailable> {
  const quote = await quoteTillSpend(input)
  return 'unavailable' in quote ? quote : publicOffer(quote)
}

/**
 * The same quote as quoteSpend, with every card of the plan: what the card
 * till's keypad shows (src/lib/till/card-till.ts), and what its Pay buys.
 * Every refusal is quoteSpend's, word for word, so the two tills cannot
 * disagree about what can be sold.
 */
export async function quoteTillSpend(input: {
  merchantId: string
  spendCents: number
  preference?: TillQuoteRequest['preference']
  buyer?: TillQuoteRequest['buyer']
  excludeIntentIds?: readonly string[]
  now?: Date
}): Promise<TillQuote | SpendUnavailable> {
  const refusals = spendRefusals(input)
  if (refusals.length > 0) return { unavailable: refusals.join(' ') }

  const quotedMerchant = input.merchantId.toLowerCase().trim()
  const quote = await quoteTill('card', {
    merchantId: quotedMerchant,
    totalCents: input.spendCents,
    preference: input.preference ?? null,
    ...(input.buyer ? { buyer: input.buyer } : {}),
    ...(input.excludeIntentIds ? { excludeIntentIds: input.excludeIntentIds } : {}),
    ...(input.now ? { now: input.now } : {}),
  })

  if (isNoQuote(quote)) {
    /*
      A FLAG, NOT A STRING TO MATCH. The shop offers a walk-through of the flow
      when there is simply nothing listed — and only then, because for "short
      of" or a residual-cap refusal the useful next step is changing the amount,
      not watching a demo. Keying that on the wording of a sentence would break
      the first time the sentence was edited.
    */
    const noSupply = quote.reason.includes('no live supply')
    /*
      AND WHETHER IT IS TRUE AT EVERY STORE. The shop's sentence names the store
      the shopper picked, so they tried all four; when nothing is listed
      anywhere it can say so once. Counted with the matcher's own definition of
      live supply (quote.ts), minus the merchant — read-only, one count.
    */
    const noSupplyAnywhere =
      noSupply &&
      (await prisma.intent.count({
        where: {
          state: 'offered',
          formFactor: 'in_store_barcode',
          expiresAt: { gt: input.now ?? new Date() },
        },
      })) === 0
    return {
      unavailable: humanise(quote.reason, input.spendCents),
      ...(noSupply ? { noSupply: true as const } : { cannotCover: true as const }),
      ...(noSupplyAnywhere ? { noSupplyAnywhere: true as const } : {}),
    }
  }

  // The reveal's own test, on the value each card applies, exactly as the
  // reveal will measure it. Without it this returns a price the register then
  // refuses.
  const blocked = await revealWouldRefuse(quote)
  if (blocked) return { unavailable: blocked, cannotCover: true }

  return quote
}

/**
 * Run the reveal's decision over a priced quote's single leg.
 *
 * Returns a buyer-facing sentence when the reveal would refuse, or null when it
 * would proceed. Shared by quoting and buying so the two cannot disagree about
 * what is sellable.
 */
async function revealWouldRefuse(quote: DemandQuote): Promise<string | null> {
  if (quote.legs.length === 0) return 'That amount could not be filled right now.'

  // EVERY CARD, ON ITS OWN SHARE. Each card is its own order, so each reveal
  // tests what that card applies, not the purchase total.
  for (const leg of quote.legs) {
    // Each card is its own charge, and Stripe refuses one under 50c. A small
    // second card would quote, reserve, and then fail at the till. Same
    // sentence as the cap below, because the fix for the shopper is the same.
    if (leg.costCents < STRIPE_MIN_CHARGE_CENTS) return roundAmountRefusal(quote.orderTotalCents)

    const intent = await prisma.intent.findUnique({ where: { id: leg.intentId } })
    if (!intent) return 'That one just went. Try again.'

    const decision = revealPrecheck(intent, leg.appliedCents)
    if (decision.ok) continue

    // Never leak "residual cap" at a buyer. What they can act on is the amount.
    return decision.refusal === 'residual_cap_exceeded'
      ? roundAmountRefusal(quote.orderTotalCents)
      : `We could not cover $${(quote.orderTotalCents / 100).toFixed(2)} with what is available. ` +
          `Try a different amount.`
  }
  return null
}

function publicOffer(q: DemandQuote): SpendOffer {
  return {
    merchantId: q.merchantId,
    spendCents: q.orderTotalCents,
    priceCents: q.priceCents,
    savingCents: q.savingCents,
    discountBps: q.discountBps,
    expiresAt: q.expiresAt.toISOString(),
    cards: q.legs.length,
  }
}

/** A quote that could not be made, and whether that is because nothing is listed. */
export interface SpendUnavailable {
  unavailable: string
  /** Nothing at all is listed for this merchant, independent of the amount. */
  noSupply?: true
  /** Nothing is listed for ANY merchant, so a store-named sentence would mislead. */
  noSupplyAnywhere?: true
  /**
   * Things are listed, but no plan covers this total: the sentence asks for
   * another amount, which is what the shop's buyer can do. The till cannot:
   * its total is the register's (src/lib/till/card-till.ts says it its way).
   */
  cannotCover?: true
}

/**
 * Turn a matcher refusal into something a person can act on.
 *
 * The matcher's reasons are written for an operator reading logs. A buyer at a
 * till needs to know whether to wait, change the amount, or give up.
 */
function humanise(reason: string, spendCents: number): string {
  if (reason.includes('no live supply')) {
    /*
      It said "Check back in a bit", which promises supply will return. On a
      deployment with none listed at all, that is false for every visitor, and
      it sends them away to wait for something that is not coming. This is true
      in both cases.
    */
    return 'Nothing is listed for this store right now.'
  }
  if (reason.includes('short of')) {
    return `We do not have enough to cover $${(spendCents / 100).toFixed(2)} right now. Try a smaller amount.`
  }
  // The card-count limit surfaces as a plan refusal; say so plainly rather
  // than leaking "residual cap" or "max cards" at a buyer.
  return `We could not cover $${(spendCents / 100).toFixed(2)} with what is available. Try a different amount.`
}

/** One card of a purchase: its order, what it covers at the till, what it cost. */
export interface SpendLeg {
  orderId: string
  appliedCents: number
  priceCents: number
  /** The card, for the till that holds and opens it. */
  intentId: string
  /** What the plan leaves on this card: non-zero on the part-used one only. */
  leftoverCents: number
  /** The deposit that leftover needs, at face: what the card till holds for it. */
  depositCents: number
  source: TillQuoteLeg['source']
  firstInLine: boolean
}

/**
 * Buy a spend: charge the discounted price, claim the cards, hand back orders.
 *
 * Re-quotes against live supply rather than trusting a quote from the client —
 * a quote is public pricing, not an entitlement, and the intent it named may
 * have been bought in the meantime.
 *
 * `orderId` is the first card's order, so a one-card caller is unchanged;
 * `legs` lists every card in scan order.
 *
 * WITH A PAYER (pay on scan), nothing is charged: each order is reserved
 * against the payer's saved card and held only at its own Show my code. A buy
 * is refused before any order exists when there is no saved card, or when
 * this purchase would put the payer over the hold allowance. Without a payer
 * the made-up ref path is exactly as it was.
 */
export async function buySpend(input: {
  merchantId: string
  spendCents: number
  buyerEmail: string
  /**
   * The Stripe customer named by the shopper's verified card cookie. `read`:
   * the card till's one read of that customer's card and holds this tap
   * (stripe-hold.ts readTap), so neither is read again here.
   */
  payer?: { customerId: string; read?: SharedHoldReads | null }
  /** The shopper's setting, as for the quote. */
  preference?: TillQuoteRequest['preference']
  /** The card till only: who is buying, so a barred shopper gets no remainders (spec 7.5). */
  buyer?: TillQuoteRequest['buyer']
  /** The card till only: cards a report or a change left out of the plan. */
  excludeIntentIds?: readonly string[]
  /** The card till only: full drains when the shopper's card would not hold a deposit. */
  maxLeftoverCents?: number
  /**
   * The card till only: what the shopper agreed to on the button. A plan
   * that now costs more, scans more cards or holds a bigger deposit is
   * refused before any order exists (`price_changed`, with the new plan), so
   * nothing is held at a price nobody tapped.
   */
  ceiling?: { costCents: number; cards: number; depositCents: number }
  /**
   * The card till is buying (src/lib/till/card-till.ts). Two things follow.
   * The deposit the plan needs counts toward the hold allowance with the
   * purchase, because the till holds it at Pay; the shop places no deposit,
   * so its check is the price alone, as before. And each order is marked a
   * till leg (spend-leg.ts TILL_LEG), so a store's balance read bills it for
   * what the card actually paid; the shop's orders are charged their price.
   */
  till?: boolean
  now?: Date
}): Promise<{ orderId: string; priceCents: number; spendCents: number; depositCents: number; legs: SpendLeg[] }> {
  const refusals = spendRefusals(input)
  if (refusals.length > 0) throw new SpendUnavailableError(refusals.join(' '))

  const rail = 'stripe' as const
  if (carriesRealMoney(rail)) {
    throw new SpendUnavailableError(
      /*
        THIS STRING IS RENDERED VERBATIM TO A SHOPPER. It read "Checkout is not
        enabled on this deployment: it would mark an order paid without taking
        money, which is only acceptable on a test rail" — our deployment
        vocabulary, our internal reasoning, on the screen of someone who just
        tried to buy something. The guard is unchanged and the reason still
        reaches the logs through the throw site; only the sentence a person
        reads is different, and it answers the question they actually have.
      */
      'We cannot take payments right now, so nothing was charged. Please try again later.',
    )
  }

  const payer = input.payer
  if (payer) {
    // Zero is the off switch, the house convention for a cap (env.ts).
    if (env().HOLD_ALLOWANCE_CENTS === 0) {
      throw new SpendUnavailableError('We cannot hold payments right now. Nothing was charged.', {
        code: 'hold_closed',
      })
    }
    // Before the quote, so a shopper with no card is sent to save one rather
    // than shown a price they cannot pay.
    if ((payer.read ?? null) === null && (await savedCard(payer.customerId)) === null) {
      throw new SpendUnavailableError('Save a card first. Nothing is charged until you show your code.', {
        code: 'card_required',
      })
    }
  }

  const merchantId = input.merchantId.toLowerCase().trim()
  // WHO IS BUYING, WHEREVER THEY BUY. The till passes the shopper's card
  // customer and fingerprint; any other pay-on-scan buy is still this payer,
  // so a card whose kept hold is theirs is never routed back to them, and a
  // barred shopper gets no remainder, from either page (till-quote.ts).
  const buyer = input.buyer ?? (payer ? { customerId: payer.customerId, fingerprint: null } : undefined)
  // The same planner, cap and setting as the quote above, and the same cap
  // the reveal below applies (capForMerchant, in till-quote.ts).
  const quote = await quoteTill('card', {
    merchantId,
    totalCents: input.spendCents,
    preference: input.preference ?? null,
    ...(buyer ? { buyer } : {}),
    ...(input.excludeIntentIds ? { excludeIntentIds: input.excludeIntentIds } : {}),
    ...(input.maxLeftoverCents !== undefined ? { maxLeftoverCents: input.maxLeftoverCents } : {}),
    ...(input.now ? { now: input.now } : {}),
  })
  if (isNoQuote(quote)) {
    const noSupply = quote.reason.includes('no live supply')
    throw new SpendUnavailableError(humanise(quote.reason, input.spendCents), { noSupply, cannotCover: !noSupply })
  }
  if (quote.legs.length === 0) {
    throw new SpendUnavailableError('That amount could not be filled right now.', { cannotCover: true })
  }
  const c = input.ceiling
  if (c && (quote.priceCents > c.costCents || quote.legs.length > c.cards || quote.depositCents > c.depositCents)) {
    throw new SpendUnavailableError('The price changed. Nothing was charged.', { code: 'price_changed', quote })
  }

  // Re-checked here rather than trusted from the quote: this is the last point
  // before money moves, and the quote may have priced different cards. The
  // plan is already in scan order: used-up cards first, the part-used one last.
  const legs = quote.legs
  const intents: Intent[] = []
  for (const leg of legs) {
    const intent = await prisma.intent.findUnique({ where: { id: leg.intentId } })
    if (!intent || intent.state !== 'offered') {
      throw new SpendUnavailableError('That one just went. Try again.')
    }
    // The same floor the quote applies, so quote and buy cannot disagree.
    if (leg.costCents < STRIPE_MIN_CHARGE_CENTS) {
      throw new SpendUnavailableError(roundAmountRefusal(quote.orderTotalCents), { cannotCover: true })
    }
    const decision = revealPrecheck(intent, leg.appliedCents)
    if (!decision.ok) {
      throw new SpendUnavailableError(
        decision.refusal === 'residual_cap_exceeded'
          ? roundAmountRefusal(quote.orderTotalCents)
          : `We could not cover $${(quote.orderTotalCents / 100).toFixed(2)} with what is available.`,
        { cannotCover: true },
      )
    }
    intents.push(intent)
  }

  // THE WHOLE PURCHASE, not one card: the second card of a pair either fits
  // now or the purchase is refused before either order exists.
  if (payer) {
    const held = quote.priceCents + (input.till ? quote.depositCents : 0)
    await assertPayerFits(payer.customerId, held, input.now ?? new Date(), payer.read?.listed ?? null)
  }

  // One order per card, each priced at that card's own cost.
  //
  // ONE TRANSACTION FOR ALL OF THEM, with every card's markers. A refusal on
  // card 2 (the day's gift-card cap, say) once stranded card 1: paid, matched
  // to nothing, until its supply expiry. It was then closed after the fact;
  // now a refusal on any card leaves no order at all, and no order is ever
  // there without what it covers.
  const orders: Order[] = []
  try {
    const drafts = legs.map((leg, i): CreatePaidOrderInput => {
      const intent = intents[i]
      if (!intent) throw new SpendUnavailableError('That amount could not be filled right now.')
      return {
        intake: {
          buyerEmail: input.buyerEmail,
          theaterName: null,
          theaterZip: null,
          theaterSlug: null,
          film: null,
          showtimeUtc: null,
          showtimeUrl: null,
          qty: 1,
          priceCents: leg.costCents,
        },
        rail,
        ...(payer
          ? {
              paymentRef: reservedRef(payer.customerId),
              // ONE KEY PER CALL, NOT PER CARD. Keyed on the intent, a card a
              // lost two-card match left offered handed the NEXT shopper the
              // previous shopper's order, and a racing loser's refund could
              // close the winner's. A fresh key per call makes a new order.
              idempotencyKey: `spend_${payer.customerId}_${randomUUID()}_${i}`,
              eventReason: 'reserved for pay on scan, nothing charged',
            }
          : {
              paymentRef: `cs_spend_${quote.expiresAt.getTime()}_${leg.intentId}`,
              idempotencyKey: `spend_${leg.intentId}`,
            }),
        kind: 'gift_card',
        merchantId,
        deadlineAt: intent.expiresAt,
      }
    })
    const made = await createPaidOrders(drafts, async (tx, order, i) => {
      const leg = legs[i]
      const intent = intents[i]
      if (!leg || !intent) throw new SpendUnavailableError('That amount could not be filled right now.')
      // WHAT THIS CARD COVERS, ON ITS ORDER, before any code can open. The
      // reveal measures exposure against it rather than against the price, so
      // a card used up exposes nothing. In the same transaction as the order.
      const balance = intent.lastKnownBalanceCents ?? intent.faceValueCents
      await recordSpendLeg(
        order,
        {
          appliedCents: leg.appliedCents,
          index: i + 1,
          of: legs.length,
          leftoverCents: Math.max(0, balance - leg.appliedCents),
        },
        tx,
      )
      if (input.till) await recordTillLeg(order, tx)
      // A REMAINDER NAMES WHOSE PURCHASE LEFT IT, on this order, now: the
      // card's own marker is replaced by this shopper's window once they open
      // it, and the first shopper's deposit is decided by how this one goes.
      // From the row as re-read above, not the quote.
      const remainder = decodeRemainder(intent.failureReason)
      if (remainder) await recordRemainderOf(order, remainder.orderId, tx)
    })
    orders.push(...made.map((m) => m.order))
  } catch (err) {
    // Nothing was made: the transaction that would have made it rolled back.
    if (err instanceof CapacityError) {
      throw new SpendUnavailableError('We are not taking more orders today. Nothing was charged.')
    }
    throw err
  }

  // The orphaned-order window, handled as `buyOffer` handles it: the orders
  // exist before the match, so a lost compare-and-swap leaves PAID orders with
  // no supply. The cards match together or not at all, so on a loss every order
  // refunds through the one verified refund path, and no card is left held.
  // A reserved order holds nothing, so closing it makes no Stripe call at all.
  try {
    await matchIntentsTogether(orders.map((o, i) => ({ intentId: legs[i]?.intentId ?? '', orderId: o.id })))
  } catch {
    const allRefunded = await closeOrders(
      orders,
      'a card was taken by someone else before this purchase could be matched',
      input.now,
    )
    throw new SpendUnavailableError(
      payer
        ? 'Someone just took one of those cards. Nothing was charged. Try again.'
        : allRefunded
          ? 'Someone just took one of those cards, so we have refunded you. Try again.'
          : 'Someone just took one of those cards. Your refund is being handled by hand, and you ' +
            'will not be left out of pocket.',
    )
  }

  const first = orders[0]
  if (!first) throw new SpendUnavailableError('That amount could not be filled right now.')
  return {
    orderId: first.id,
    priceCents: quote.priceCents,
    spendCents: quote.orderTotalCents,
    depositCents: quote.depositCents,
    legs: orders.map((o, i) => ({
      orderId: o.id,
      appliedCents: legs[i]?.appliedCents ?? 0,
      priceCents: legs[i]?.costCents ?? o.priceCents,
      intentId: legs[i]?.intentId ?? '',
      leftoverCents: legs[i]?.leftoverCents ?? 0,
      depositCents: legs[i]?.depositCents ?? 0,
      source: legs[i]?.source ?? 'fresh',
      firstInLine: legs[i]?.firstInLine ?? false,
    })),
  }
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * The allowance check, as a refusal the shopper can act on.
 *
 * TWO NUMBERS, BECAUSE THEY ARE TWO THINGS. Reservations and live holds both
 * count against the allowance, so the refusal states their sum, as the
 * shopper's open codes. But a reservation holds nothing on the card, and
 * calling the sum "on hold" told a shopper with nothing authorized that their
 * bank was holding it. Only live holds are called on hold, and `heldCents` is
 * those alone, as GET /api/card reports it.
 *
 * A PURCHASE OVER THE ALLOWANCE ON ITS OWN IS SAID AS THAT. The open codes
 * sentence told a first-time shopper their open codes came to $0.00 and to
 * finish one first, when there was none, and finishing any would not have
 * made this purchase fit. Only a smaller amount does.
 */
async function assertPayerFits(customerId: string, totalCents: number, now: Date, listed: Parameters<typeof assertBuyFits>[3] = null): Promise<void> {
  try {
    await assertBuyFits(customerId, totalCents, now, listed)
  } catch (err) {
    if (err instanceof AllowanceExceededError) {
      const open = err.heldCents + err.reservedCents
      throw new SpendUnavailableError(
        totalCents > err.allowanceCents
          ? `We hold up to ${dollars(err.allowanceCents)} for you at once, and this purchase is ` +
              `${dollars(totalCents)}. Try a smaller amount.`
          : `We hold up to ${dollars(err.allowanceCents)} for you at once. Your open codes come to ` +
              `${dollars(open)}, and ` +
              (err.heldCents > 0 ? `${dollars(err.heldCents)} of that is on hold now.` : 'nothing is on hold yet.') +
              ' Try a smaller amount, or finish your open code first.',
        {
          code: 'over_allowance',
          detail: { heldCents: err.heldCents, reservedCents: err.reservedCents, allowanceCents: err.allowanceCents },
        },
      )
    }
    // Too many PaymentIntents to count safely: refuse, with nothing created.
    if (err instanceof HoldUnavailableError) {
      throw new SpendUnavailableError('We cannot hold payments right now. Nothing was charged.', {
        code: 'hold_closed',
      })
    }
    throw err
  }
}

/**
 * Refund every order a failed buy already made, through the one verified
 * refund path. True when all of them closed.
 */
async function closeOrders(orders: readonly Order[], reason: string, now: Date | undefined): Promise<boolean> {
  const { refundOrder } = await import('../reconcile')
  let allRefunded = true
  for (const order of orders) {
    const outcome = await refundOrder(order, reason, now ?? new Date())
    if (!outcome.refunded) allRefunded = false
  }
  return allRefunded
}
