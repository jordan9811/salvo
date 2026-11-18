/**
 * The card till's deposit: what decides it, with no money and no database
 * (unified-account spec 7.1 and 9.3). The money moves in deposit.ts, through
 * the deposit calls in stripe-hold.ts, which is the only module that reaches
 * the card processor.
 *
 * ===========================================================================
 * WHAT A DEPOSIT IS FOR. A shopper whose purchase leaves part of a card has
 * seen that card's barcode, and could spend the rest themselves. So the till
 * holds a deposit on their card for what is left, AT FACE, not at its price:
 * spending the rest yourself then nets nothing. The rest of the card goes
 * back on sale, first in line, and the next shopper's use of it decides the
 * deposit:
 *
 *   the rest was there      the deposit is released
 *   the rest was not        the deposit pays the seller, up to what was missing
 *
 * "There" is proved by the next shopper's balance read where a store lets us
 * read (Best Buy, Nike), and by the next shopper's code going through, with
 * no report inside two hours, where it does not (Target, Walmart).
 * ===========================================================================
 *
 * A DEPOSIT LASTS A WEEK AT MOST. Card holds lapse (a Visa one placed off
 * session in under 5 days), and the deposit is released a day before. The
 * rest of the card stays first in line with no deposit; the router then takes
 * the haircut off its price (route/plan.ts, open decision 3).
 *
 * NEVER CAPTURED AND REFUNDED. A captured deposit would be money we hold for
 * a shopper, and the processor keeps its fee on a refund. A cancelled hold
 * costs nothing. So every path below either cancels it or takes part of it,
 * for the seller, once.
 */

import { decodeUnscanned } from '../barcode/unscanned'
import { legCostCents } from '../route/plan'

/** A deposit this close to lapsing is released, and the rest stays first in line. The hold sweep's own rule. */
export const BOND_NEAR_LAPSE_MS = 24 * 3600_000

/** The deposit as the processor reports it now. */
interface BondReading {
  status: string
  captureBefore: Date
}

/** The card the deposit stands behind, as it is now. */
interface CardNow {
  state: string
  failureReason: string | null
  matchedOrderId: string | null
  expiresAt: Date
}

/** The next shopper's order for the rest of the card, as it is now. */
interface NextNow {
  id: string
  state: string
  /** They, or their balance read, found it short, and by how much at face. */
  shortCents: number | null
}

export type BondVerdict =
  | { act: 'wait'; why: string }
  /** `clearMarker`: the card still names this deposit; list it with none. */
  | { act: 'release'; why: string; clearMarker: boolean }
  /** `strike`: whether it counts against the first shopper (supply/remainder.ts remainderStrikes). */
  | { act: 'capture'; cents: number; why: string; strike: boolean }
  /** Already decided at the processor: only the card's marker may need clearing. */
  | { act: 'done'; clearMarker: boolean }

/**
 * What the hold sweep does with one deposit, from everything as it is now.
 * Inline paths decide most deposits the moment their evidence arrives; this
 * is the backstop for every one they did not, and it never captures without
 * a recorded report.
 *
 *   aOrder     the first shopper's order, whose part-used card it stands behind
 *   remainder  the card's remainder marker names this deposit right now
 *   readable   the store lets us read the card's balance
 */
export function decideBond(input: {
  aOrder: { id: string; state: string }
  depositCents: number
  bond: BondReading | null
  card: CardNow | null
  remainderNamesThis: boolean
  next: NextNow | null
  readable: boolean
  /** The smallest capture the card rail can make. Less than this is written off, never rounded up. */
  minTakeCents: number
  /** Balance-watch found the rest of the card lower while it was on sale, by this much at face, or null. */
  shortOnSaleCents: number | null
  now: Date
}): BondVerdict {
  const { aOrder, bond, card, next, now } = input

  if (bond === null) return { act: 'done', clearMarker: input.remainderNamesThis }
  if (bond.status === 'canceled' || bond.status === 'succeeded') {
    return { act: 'done', clearMarker: input.remainderNamesThis }
  }

  // THE EVIDENCE FIRST. A recorded report is a decision a request made and may
  // not have finished; the bank's clock cannot overrule it while there is time.
  // A shortfall under the smallest charge cannot be taken at all: it is
  // written off and the deposit goes back, rather than waiting on a capture
  // that can never be made until the bank drops the hold.
  if (next !== null && next.shortCents !== null) {
    const cents = Math.min(input.depositCents, next.shortCents)
    if (cents < input.minTakeCents) {
      return {
        act: 'release',
        why: 'what was missing is under the smallest card charge, so it is written off',
        clearMarker: input.remainderNamesThis,
      }
    }
    return { act: 'capture', cents, why: 'the next shopper found the rest of the card short', strike: true }
  }
  // Found lower on sale, after the first shopper's own window closed clean:
  // the deposit pays the seller by rule, and it is not their strike. Under the
  // smallest charge it is written off and the deposit stays behind the rest.
  if (input.shortOnSaleCents !== null && input.shortOnSaleCents >= input.minTakeCents) {
    return {
      act: 'capture',
      cents: Math.min(input.depositCents, input.shortOnSaleCents),
      why: 'the rest of the card was found lower while it was on sale',
      strike: false,
    }
  }

  if (bond.status === 'requires_capture' && bond.captureBefore.getTime() - now.getTime() < BOND_NEAR_LAPSE_MS) {
    return {
      act: 'release',
      why: 'the deposit would lapse before anyone used the rest of the card',
      clearMarker: true,
    }
  }

  // The first shopper's own window: their code is not settled yet.
  if (card !== null && card.matchedOrderId === aOrder.id && (card.state === 'matched' || card.state === 'executing')) {
    return { act: 'wait', why: 'the first shopper\'s own code is still being settled' }
  }

  // Their code never went through, so nothing was left on the card by them.
  if (aOrder.state !== 'fulfilling' && aOrder.state !== 'fulfilled') {
    return { act: 'release', why: `the first shopper's code ended ${aOrder.state}`, clearMarker: input.remainderNamesThis }
  }

  if (card === null) return { act: 'release', why: 'the card is gone', clearMarker: false }

  if (card.state === 'offered') {
    // "It didn't scan" on the part-used card: listed whole, first in line,
    // with their kept hold behind it. The kept hold covers only what the card
    // was to apply, and this deposit the rest at face, so the two wait
    // together: taken with the kept hold if the card proves spent, released
    // with it if it proves whole (reveal-service.ts finishKeptHold).
    if (decodeUnscanned(card.failureReason)?.keptOrderId === aOrder.id) {
      return { act: 'wait', why: 'a kept hold stands behind the card, and this deposit with it' }
    }
    if (!input.remainderNamesThis) {
      // Listed with no deposit: nothing of theirs stands behind it now.
      return { act: 'release', why: 'the card is not listed as a remainder behind this deposit', clearMarker: false }
    }
    if (card.expiresAt.getTime() <= now.getTime()) {
      return { act: 'release', why: 'the listing expired before anyone used the rest', clearMarker: true }
    }
    return { act: 'wait', why: 'first in line, waiting for the next shopper' }
  }

  if (next === null || card.matchedOrderId === next.id) {
    if (card.state === 'matched' || card.state === 'executing') {
      return { act: 'wait', why: 'the next shopper has the card' }
    }
  }

  if (next !== null) {
    if (next.state === 'fulfilled') {
      return { act: 'release', why: 'the next shopper\'s code went through', clearMarker: false }
    }
    if (next.state === 'fulfilling') {
      // Where the store lets us read, their open read proved the rest was there.
      if (input.readable) return { act: 'release', why: 'the next shopper\'s balance read proved the rest', clearMarker: false }
      return { act: 'wait', why: 'the next shopper\'s report window is still open' }
    }
    if (next.state === 'refunded' || next.state === 'failed') {
      // Refunded with no report: their own purchase ended for another reason
      // (a code never shown, a balance read that found it whole and unused).
      return { act: 'release', why: `the next shopper's order ended ${next.state} with no report`, clearMarker: false }
    }
    return { act: 'wait', why: `the next shopper's order is ${next.state}` }
  }

  // Ended with nobody using the rest: the seller marked it used, or it was
  // retired. Nothing proves it was spent, so the deposit goes back.
  return { act: 'release', why: `the card ended ${card.state} with nobody using the rest`, clearMarker: false }
}

/**
 * The price of value on one card of a till purchase, against the hold its
 * code was bought with.
 *
 * THE HOLD IS THE PRICE AT BUY, of what the plan then applied (`bought`).
 * Value up to that is priced as the hold priced it, so a remainder sold with
 * the haircut off its price is never charged the haircut back. Value past it,
 * when the total went up and the card covered more, is the card's own price
 * for the extra, at the seller's discount (route/plan.ts legCostCents), so
 * the whole card costs what it would have cost bought whole.
 */
export function legPriceOf(leg: {
  holdCents: number
  boughtCents: number
  priceCents: number
  faceValueCents: number
}): (valueCents: number) => number {
  const full = (v: number): number => legCostCents(v, leg.priceCents, leg.faceValueCents)
  return (v) => {
    if (v <= 0) return 0
    if (leg.boughtCents <= 0) return full(v)
    if (v <= leg.boughtCents) return Math.min(full(v), Math.ceil((v * leg.holdCents) / leg.boughtCents))
    return leg.holdCents + full(v) - full(leg.boughtCents)
  }
}

/** What one till card comes to, once its code is settled as worked. */
export interface LegSettlement {
  /** What the code's own hold takes, when less than all of it; null for all of it. */
  billCents: number | null
  /** Taken from the shopper's own deposit for what the code's hold does not cover. */
  fromDepositCents: number
  /** Whether that counts against them (spec 7.5): only a read showing they used more than the plan. */
  strike: boolean
  /** Left on the card for the seller and listed again, behind a deposit of at least this at face. 0 lists nothing. */
  listCents: number
  /** A deposit for `listCents` must be held before the one recorded is taken from or released. */
  newDeposit: boolean
  /** The value the shopper pays for: what their receipt says the card covered. */
  paidForCents: number
  /** Value left on the card that nobody pays for: retired with it, and booked as the loss it is. */
  lossCents: number
  /** Past the cap: the rest is billed at its price, and the card is the shopper's (spec 5.4). */
  theirs: boolean
}

/**
 * What one till card is charged once its window is settled as worked, and
 * what becomes of the rest of it (spec 5.2 step 6, 5.4, 5.5, 7.1 and 9.2).
 *
 *   used    what the card paid at the register: the read's figure where a
 *           store lets us read, else what the plan applies now
 *   left    what stays on it: the read after the window, or what the plan
 *           leaves
 *
 * The answer is the ways to settle it, best first. The caller takes the
 * first whose rest can be listed and whose new deposit, if it needs one, is
 * held. The last always can be taken: it lists nothing and needs no deposit.
 *
 * ===========================================================================
 * THE SHOPPER PAYS FOR WHAT THEY USED, AND THE REST IS THE SELLER'S, while a
 * deposit at face stands behind the rest:
 *
 *   used more                        the excess price from their deposit, a
 *                                    new one for what is left held first:
 *                                    one capture releases the rest of a hold
 *   the total went up on screen      the same: the extra price at release,
 *                                    from the deposit, never before the
 *                                    register has taken anything
 *   used less, within the cap        bill the real amount, and list the rest
 *                                    behind a deposit for all of it at face,
 *                                    held FIRST (a typo costs nothing, 5.5)
 *
 * A READ MAY CREDIT ONLY WHAT A HELD DEPOSIT COVERS, AND ONLY WITHIN THE CAP.
 * The shopper has seen the number, so whatever is left on the card and not
 * billed must have a deposit at face behind it. When the larger deposit
 * cannot be held, or the rest cannot be listed, the card is settled as
 * planned: the bill the plan made, and the old deposit behind what the plan
 * left. What the register did not take was paid for at Pay, and stays on the
 * card with the shopper. Billing the read and retiring the rest used to let a
 * $150 card used for $1 cost 90 cents, its $149 still spendable on a number
 * the shopper had seen.
 *
 * PAST THE CAP THE READ CREDITS NOTHING. A deposit is released a day before
 * it lapses, and the rest then waits on sale with nothing behind it, so a
 * rest larger than the cap is never listed (spec 5.4 and 5.5: beyond the cap
 * the shopper pays the price, keeps the card, or reports it). The card is
 * settled as planned, the old deposit behind what the plan left, which is
 * within the cap. When what the shopper left on it is past the cap too, the
 * next shopper's open would refuse the card, so nothing can be listed on it:
 * it is billed whole, the plan's bill and the price of what the plan left,
 * taken from the deposit that stood behind it, and the card is the shopper's.
 * ===========================================================================
 *
 * A rest too small to list again (under REMAINDER_RELIST_MIN_CENTS) is
 * retired as a booked loss, as the planner's own small leftovers are. One the
 * deposit does not fully cover, only because the card held more than its
 * plan knew, is listed behind what there is: that exposure was the open's to
 * accept (reveal.ts decideReveal), not this shopper's doing. When nothing can
 * be listed, the plan's own leftover is retired as a booked loss, as before:
 * never more than the plan left, which is within the cap.
 */
export function settleTillLeg(input: {
  usedCents: number
  leftCents: number
  /** What the plan applies now: the latest spend leg. */
  appliedCents: number
  /** What the code's own hold can take: its price at buy. */
  holdCents: number
  /** The shopper's deposit still held, at face, or 0. */
  depositCents: number
  /** The most that may stay on a card a shopper has seen with no bill behind it (till-quote.ts capForMerchant). */
  capCents: number
  relistMinCents: number
  minChargeCents: number
  priceOf: (valueCents: number) => number
}): LegSettlement[] {
  const used = Math.max(0, input.usedCents)
  const left = Math.max(0, input.leftCents)
  const applied = Math.max(0, input.appliedCents)
  const deposit = Math.max(0, input.depositCents)

  /** The card settled on `paid` of value paid for and `rest` left: listed when it can be, and retired when not. */
  const at = (paid: number, rest: number, strike: boolean): { settle: LegSettlement; retire: LegSettlement } => {
    const price = input.priceOf(paid)
    const billCents = price < input.holdCents ? price : null
    const fromDepositCents = Math.min(deposit, Math.max(0, price - input.holdCents))
    const retire: LegSettlement = {
      billCents,
      fromDepositCents,
      strike,
      listCents: 0,
      newDeposit: false,
      paidForCents: paid,
      lossCents: rest,
      theirs: false,
    }
    const taking = fromDepositCents >= input.minChargeCents
    const credit = billCents !== null
    const listable = rest >= input.relistMinCents
    const newDeposit = listable && (taking || (credit && deposit < rest))
    const list = listable && (newDeposit || deposit > 0) ? rest : 0
    return { settle: { ...retire, listCents: list, newDeposit, lossCents: list > 0 ? 0 : rest }, retire }
  }

  if (used >= applied) {
    const s = at(used, left, used > applied)
    return [s.settle, s.retire]
  }

  // The register took less than the plan applied. The difference was paid
  // for at Pay and is the shopper's; only the rest past it is the seller's.
  const extra = applied - used
  const sellers = Math.max(0, left - extra)
  if (extra > input.capCents) {
    // Billed whole, as far as the deposit at face can pay for the seller's part.
    const covered = Math.min(sellers, deposit)
    const whole = at(applied + covered, 0, false).retire
    return [{ ...whole, lossCents: sellers - covered, theirs: true }]
  }
  const planned = at(applied, sellers, false)
  if (left > input.capCents) return [planned.settle, planned.retire]
  return [at(used, left, false).settle, planned.settle, planned.retire]
}
