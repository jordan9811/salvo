/**
 * "It didn't scan" at a store whose balance nobody can read: the hold is kept,
 * and the card goes to the next shopper first. Open decision 2 of the unified
 * account spec (section 17), on its default.
 *
 * ===========================================================================
 * THE HOLE THIS CLOSES. At Target or Walmart nobody can read a card's balance,
 * so the shopper's word is the only evidence. A No used to cancel the hold and
 * retire the card (evidence.ts, the tier-3 "did not work" branch). The number
 * had already been on their screen. So "it didn't scan" was a free card: say
 * it, keep the number, spend it later.
 *
 * THE DEFAULT, AS APPROVED. Keep that shopper's hold, uncaptured, and list
 * the same card again, first in line, never to that same shopper
 * (demand/till-quote.ts). The next shopper's scan is the test nobody else can
 * run:
 *
 *   their scan works        the first shopper told the truth: release the hold
 *   they say No too         the card was empty: the kept hold is taken at its
 *                           price (and a deposit behind it at face), the next
 *                           shopper is refunded from their own hold, and a
 *                           person is told, who can undo it
 *
 * So a false "didn't scan" gains nothing: the card is paid for either way.
 * The cost falls on an honest shopper: their hold can last until the next
 * shopper comes, and at most until just before the bank would drop it (the
 * hold sweep releases it a day before; under 5 days on a Visa). A next
 * shopper who lies costs them the price, as a lying next shopper costs a
 * deposit under open decision 1, and their reports count: two in 30 days and
 * they get nothing waiting first in line. A hold released that way leaves the
 * card first in line with its marker, and the next shopper's No on it refunds
 * them: nothing stands behind it, and it is no one else's to pay for.
 *
 * NOT USED IS NOT A NO ABOUT THE CARD. The till tells a shopper not to scan a
 * card when the total comes down past what can stay on it. That tests
 * nothing, so on a card someone else stands behind it decides only that
 * shopper's own hold (decideBlindNo `set_aside`).
 * ===========================================================================
 *
 * WHAT IS KEPT WHERE, WITH NO MIGRATION:
 *
 *   the card (Intent)    offered again, `failureReason = UNSCANNED|<orderId>`,
 *                        naming the order whose hold stands behind it. The
 *                        router reads it to put the card first in line.
 *   that order           stays `fulfilling` with its hold, and carries an
 *                        OrderEvent `KEPT_HOLD|<intentId>`, so the hold sweep
 *                        can find it once the card has moved on.
 *   the next shopper     nothing new. Their order is the card's matched order,
 *                        and the kept hold is found from the card.
 *
 * Only one card can wait behind a kept hold at a time: a second No while one
 * is kept decides it, and the card is retired with the next shopper's refund.
 *
 * WHICH NO IS WHICH. The register answer can say why: `didnt_scan` or
 * `declined` (buyer-evidence.ts). For the FIRST shopper every No keeps the
 * hold, whatever it says: refunding "declined" would hand the same free card
 * to anyone who picks that word instead. For the NEXT shopper every No takes
 * the kept hold, for the same reason. The why goes to the person told. A card
 * that was empty when it was listed reads exactly like a spent one, and only
 * the seller can tell them apart.
 *
 * Pure: no database, no Stripe. The money moves in reveal-service.ts and the
 * hold sweep, through the paths every other release and capture use.
 */

/** On the card, while it waits for the next shopper. */
const UNSCANNED_MARKER = 'UNSCANNED'

/** On the first shopper's order, so the hold sweep can find its hold. */
const KEPT_HOLD_MARKER = 'KEPT_HOLD'

/**
 * Written on the kept order's `failureReason` as the claim on deciding it, in
 * one compare-and-swap, so a release and a capture can never both happen. The
 * sweep finishes a claim a request left half done.
 */
export const KEPT_HOLD_CAPTURING = 'kept_hold:capturing'
export const KEPT_HOLD_RELEASING = 'kept_hold:releasing'

/** Why the register did not take the card, when the shopper said. */
export type RegisterFailure = 'didnt_scan' | 'declined'

/**
 * Why a No, as it is recorded: a failure at the register, or `not_used`, a
 * card the till told its shopper not to scan (the total came down past what
 * can stay on it, or the cards before it covered the total). Not used says
 * nothing about the card, so it never decides anyone else's money: see
 * decideBlindNo. Only the till sends it; the reveal page's settle takes the
 * two failures only (isRegisterFailure).
 */
export type RegisterNo = RegisterFailure | 'not_used'

export function isRegisterFailure(v: unknown): v is RegisterFailure {
  return v === 'didnt_scan' || v === 'declined'
}

export function unscannedMarker(keptOrderId: string): string {
  return `${UNSCANNED_MARKER}|${keptOrderId}`
}

/** The order whose hold stands behind this card, or null. */
export function decodeUnscanned(reason: string | null | undefined): { keptOrderId: string } | null {
  if (!reason || !reason.startsWith(`${UNSCANNED_MARKER}|`)) return null
  const [, keptOrderId, ...rest] = reason.split('|')
  if (!keptOrderId || rest.length > 0) return null
  return { keptOrderId }
}

/**
 * Is this listing waiting for its next shopper, first in line? An offered card
 * with the marker. The router uses it whole, before any other card.
 */
export function isFirstInLine(intent: { state: string; failureReason: string | null }): boolean {
  return intent.state === 'offered' && decodeUnscanned(intent.failureReason) !== null
}

export function keptHoldEventReason(intentId: string): string {
  return `${KEPT_HOLD_MARKER}|${intentId}`
}

/** The card a kept-hold event names, or null. */
export function decodeKeptHoldEvent(reason: string | null | undefined): { intentId: string } | null {
  if (!reason || !reason.startsWith(`${KEPT_HOLD_MARKER}|`)) return null
  const [, intentId, ...rest] = reason.split('|')
  if (!intentId || rest.length > 0) return null
  return { intentId }
}

/** The prefix the sweep queries kept-hold events by. */
export const KEPT_HOLD_EVENT_PREFIX = `${KEPT_HOLD_MARKER}|`

// ===========================================================================
// A No at the register, at a store nobody can check
// ===========================================================================

export type NoDecision =
  /** Keep this shopper's hold; list the card again, first in line. */
  | { kind: 'keep_for_next_shopper' }
  /** Refund this shopper and retire the card, as before. */
  | { kind: 'refund' }
  /**
   * The rest of a part-used card did not work for the next shopper (open
   * decision 1): they are refunded, and the first shopper's deposit pays the
   * seller (reveal-service.ts remainderFoundEmpty).
   */
  | { kind: 'remainder_empty' }
  /**
   * NOT USED, ON A CARD SOMEONE ELSE STANDS BEHIND. The till told this shopper
   * not to scan it, so nobody's scan has tested it: it is no evidence that the
   * card was spent. Only this shopper's own hold is decided, and it goes back,
   * nothing charged; the card goes back on sale with the marker it had, so the
   * deposit or kept hold behind it keeps waiting for a real scan. Taking that
   * deposit or kept hold here charged someone who did nothing, and retired a
   * card nobody had tried.
   */
  | { kind: 'set_aside' }
  /**
   * A No on a card someone said did not scan, whose hold was released before
   * anyone's scan decided it (the hold sweep's backstop, a day before the hold
   * would lapse). Nothing stands behind the card, and keeping this shopper's
   * hold for the next one would make them pay for a card that may have been
   * spent before they came. Refunded, as a No on a remainder with no deposit
   * left is, the card retired, and a person told.
   */
  | { kind: 'refund_after_release'; page: true; why: string }
  /**
   * A No behind a kept hold: the card was empty for the next shopper, so the
   * first shopper's "didn't scan" was not true, or the card was spent before
   * either came. The kept hold is taken at its price, this purchase is
   * refunded, and a person is told, with what to do if the card truly does
   * not scan. `sameShopper`: the one whose hold was kept came back to it.
   */
  | { kind: 'settle_kept_then_refund'; kept: 'capture'; page: true; sameShopper: boolean; why: string }

/**
 * What a No does, at a store whose balance nobody can read.
 *
 * `held` is whether this order has a hold to keep: pay on scan, with a hold
 * recorded. An order paid at buy has none, and its No refunds as it always
 * did. `behindKeptHold` is whether a kept hold already stands behind this
 * card, and `sameShopper` whether it is this shopper's own.
 * `behindRemainder` is whether the card is the rest of a part-used card, with
 * the first shopper's deposit behind it. `afterReleasedHold` is whether
 * someone said this card did not scan and their hold was released before any
 * scan decided it.
 *
 * ===========================================================================
 * THE NEXT SHOPPER'S NO TAKES THE KEPT HOLD (open decision 2, as approved:
 * "if it's empty, the hold is taken at the normal price, so a false didn't
 * scan gains nothing"). It used to keep both holds for a person, and with
 * nobody acting the hold sweep released both a day before they lapsed: the
 * false "didn't scan" was a free card again, a few days later.
 *
 * Every No still counts against the shopper who gave it (supply/remainder.ts
 * KEPT_NO), and the till never routes a card to the shopper whose hold
 * stands behind it (demand/till-quote.ts).
 * ===========================================================================
 */
export function decideBlindNo(input: {
  held: boolean
  behindKeptHold: boolean
  behindRemainder: boolean
  afterReleasedHold: boolean
  sameShopper: boolean
  failure: RegisterNo | null
}): NoDecision {
  if (input.failure === 'not_used' && (input.behindKeptHold || input.behindRemainder || input.afterReleasedHold)) {
    return { kind: 'set_aside' }
  }
  if (input.behindRemainder) return { kind: 'remainder_empty' }
  if (input.behindKeptHold && input.sameShopper) {
    return {
      kind: 'settle_kept_then_refund',
      kept: 'capture',
      page: true,
      sameShopper: true,
      why:
        'the shopper whose hold was kept behind this card bought it again and said it did not work again, ' +
        'so their kept hold is taken and the new purchase refunded. Refund the kept order by hand if the card ' +
        'truly does not scan',
    }
  }
  if (input.behindKeptHold) {
    const said =
      input.failure === 'declined'
        ? 'the next shopper says the register declined the card'
        : input.failure === 'didnt_scan'
          ? 'the next shopper could not scan it either'
          : 'the next shopper says the card did not work, and not why'
    return {
      kind: 'settle_kept_then_refund',
      kept: 'capture',
      page: true,
      sameShopper: false,
      why:
        `${said}, so the kept hold is taken at its price and the next shopper is refunded. If the barcode ` +
        'itself is bad, refund the kept order by hand',
    }
  }
  if (input.afterReleasedHold) {
    return {
      kind: 'refund_after_release',
      page: true,
      why:
        'the shopper before said it did not scan, and their hold was released before anyone used the card, so ' +
        'nothing stands behind it: this shopper is refunded and the card retired. Check the card before listing it again',
    }
  }
  if (!input.held) return { kind: 'refund' }
  // "Declined" is kept too. Refunding it would hand back the free card this
  // closes, to anyone who picks that word instead of "didn't scan".
  return { kind: 'keep_for_next_shopper' }
}

// ===========================================================================
// The hold sweep's view of a kept hold
// ===========================================================================

/** A card hold as the sweep reads it from Stripe. */
interface HoldReading {
  status: string
  captureBefore: Date
}

/**
 * A release never lists the card plain. A card still waiting first in line
 * keeps its marker once the hold behind it is released, so the next
 * shopper's No on it refunds them (decideBlindNo `refund_after_release`).
 * Listed plain, it sold as fresh stock at full value: a No there kept the
 * next shopper's hold, the one after took it, and an innocent shopper paid
 * for a card the first one may have spent.
 */
export type KeptHoldVerdict = { act: 'wait'; why: string } | { act: 'release'; why: string } | { act: 'page'; why: string }

/** An unsettled hold this close to lapsing is released. The hold sweep's own rule. */
export const KEPT_HOLD_NEAR_LAPSE_MS = 24 * 3600_000

/**
 * What the hold sweep does with one kept hold, from the card as it is now.
 *
 * Inline, the next shopper's settle decides the kept hold the moment their
 * own code is decided, and a No decides it BEFORE their own refund. So once
 * the card has ended, a kept hold still open was never decided by a next
 * shopper's answer: none came before the hold would lapse, their open was
 * refused, the deadline net closed their order, or the seller took the card
 * down. None of those proves the card was spent, so every one releases. This
 * is the backstop for them, and it never captures.
 *
 *   card   the listing the hold stands behind, as it is now
 *   hold   the kept hold, read from Stripe just now; null when unread
 */
export function decideKeptHold(input: {
  keptOrderId: string
  card: { state: string; failureReason: string | null; matchedOrderId: string | null; expiresAt: Date } | null
  hold: HoldReading | null
  now: Date
}): KeptHoldVerdict {
  const { card, hold, now } = input

  // The bank's clock comes first: past it there is nothing left to take.
  if (hold) {
    if (hold.status === 'canceled') {
      return { act: 'release', why: 'the bank dropped the kept hold' }
    }
    if (hold.status === 'succeeded') {
      return { act: 'page', why: 'the kept hold was captured outside the settle that decides it' }
    }
    if (hold.status === 'requires_capture' && hold.captureBefore.getTime() - now.getTime() < KEPT_HOLD_NEAR_LAPSE_MS) {
      return {
        act: 'release',
        why: 'no next shopper settled the card before the kept hold would lapse',
      }
    }
  }

  if (card === null) return { act: 'release', why: 'the card behind the kept hold is gone' }

  const stillWaiting = decodeUnscanned(card.failureReason)?.keptOrderId === input.keptOrderId
  if (card.state === 'offered') {
    if (!stillWaiting) {
      // Listed with nothing naming this hold: someone cleared it.
      return { act: 'release', why: 'the card no longer waits on the kept hold' }
    }
    if (card.expiresAt.getTime() <= now.getTime()) {
      return { act: 'release', why: 'the listing expired before a next shopper came' }
    }
    return { act: 'wait', why: 'first in line, waiting for the next shopper' }
  }

  // The card is still on the kept shopper's own window. The relist has not
  // landed yet, or a request died before it: the stale sweep owns that window.
  if (card.matchedOrderId === input.keptOrderId) {
    return { act: 'wait', why: 'the kept shopper\'s own window is still being settled' }
  }

  // A next shopper has it.
  if (card.state === 'matched' || card.state === 'executing') {
    return { act: 'wait', why: 'the next shopper has the card' }
  }
  if (card.state === 'completed') {
    return { act: 'release', why: 'the next shopper\'s code went through' }
  }
  // Refunded, failed or cancelled with the hold still open: see above.
  return { act: 'release', why: `the card ended ${card.state} without proof it was spent` }
}
