/**
 * The V2 keeper's decisions, as pure functions of what the chain says (unified
 * spec sections 7.1, 8.2, 8.3 and 17). keeper-v2.ts reads the chain, asks
 * these, and writes or sends what they say. No database, no network, no key.
 *
 * Each rule is the contract's own, read off chain so the keeper never sends a
 * call that would revert, and never waits on one that is already due:
 *   - a sale is paid out at releaseAt, and not before its contest window ends;
 *   - a leftover's deposit comes back once the next shopper's use of it has
 *     gone two hours with no "it was empty" (decision 1), at once when the
 *     listing was cancelled, and by rule at seven days when no sale is
 *     resolving it. From five days the seller may say what became of it;
 *   - a readable store's leftover is read once, at least fifteen minutes after
 *     the sale that left it, so the buyer's window closes on a real read; and
 *     at once when a ticket found it short, so the shortfall posts before
 *     anyone else pays for it;
 *   - our listing row follows the listing: offered while it sells, with what
 *     is left; executing once drained, until the sale that drained it is paid
 *     out (completed) or refunded.
 *
 * Isomorphic: no Node imports.
 */

import { LEGAL_INTENT_TRANSITIONS } from '@/lib/intent/state'
import type { IntentState } from '@/lib/intent/types'
import { MODE_READABLE } from './merchants'
import { V2_STATE, type DepositViewV2, type ListingViewV2 } from './runbook/reads-v2'

/** SalvoEscrowV2's clocks, in seconds (spec section 8.2). config-v2.ts serves the same numbers. */
export const V2_SECONDS = Object.freeze({
  contestWindow: 7_200,
  bondReviewAfter: 432_000,
  bondMaxAge: 604_800,
  confirmDelay: 900,
})

/** Where our listing row should be, given the listing on chain. */
export interface IntentTargetV2 {
  state: IntentState
  /** What is left on the card, for an offered row after its first sale; null before it (the face value stands). */
  balanceCents: number | null
  cancellation: 'seller_reclaimed' | 'balance_dropped' | 'expired' | null
}

const TERMINAL: ReadonlySet<IntentState> = new Set(['completed', 'cancelled', 'refunded'])

/**
 * The row's target for this listing, or null when the row is terminal (it
 * never moves again) or the chain shows no listing. `latest` is the listing's
 * last sale (getListing().lastDeposit), null before the first. `chainTime` is
 * the agreed block's time; the contract refuses a purchase at or after the
 * listing's expiry.
 */
export function intentTargetV2(
  l: ListingViewV2,
  latest: DepositViewV2 | null,
  chainTime: number,
  listingExpiry: number,
  current: IntentState,
): IntentTargetV2 | null {
  if (TERMINAL.has(current)) return null
  const sold = current !== 'offered'
  switch (l.state) {
    case V2_STATE.listing.ACTIVE:
      if (chainTime >= listingExpiry) return { state: 'cancelled', balanceCents: null, cancellation: 'expired' }
      return { state: 'offered', balanceCents: l.sales === 0 ? null : l.remainingCents, cancellation: null }
    case V2_STATE.listing.DRAINED: {
      const s = latest?.state
      if (s === V2_STATE.deposit.OPENED) return { state: 'executing', balanceCents: 0, cancellation: null }
      if (s === V2_STATE.deposit.RELEASED) return { state: 'completed', balanceCents: 0, cancellation: null }
      // The sale that drained it refunded in full: the card is its seller's again.
      return { state: 'refunded', balanceCents: 0, cancellation: null }
    }
    case V2_STATE.listing.CANCELLED:
      // Unsold, or the seller's "I used it myself", or a first sale refunded in full.
      return sold ? { state: 'refunded', balanceCents: 0, cancellation: null } : { state: 'cancelled', balanceCents: 0, cancellation: 'seller_reclaimed' }
    case V2_STATE.listing.SPENT:
      // The leftover was found spent: contested by the next shopper, read at 0, or the seller's word.
      return sold ? { state: 'refunded', balanceCents: 0, cancellation: null } : { state: 'cancelled', balanceCents: 0, cancellation: 'balance_dropped' }
    default:
      return null
  }
}

/**
 * The moves from `from` to `to` through the intent table, shortest first,
 * excluding `from`; [] when they are equal; null when the table has no way.
 * The keeper makes each move in turn, so every edge is one the table allows.
 * A drained listing that reopens (reduceUse) needs executing -> offered,
 * which the table gains with the till's merge; until then this says null and
 * the row waits, reported, rather than taking a move the table refuses.
 */
export function intentPath(from: IntentState, to: IntentState): IntentState[] | null {
  if (from === to) return []
  const prev = new Map<IntentState, IntentState>()
  const queue: IntentState[] = [from]
  while (queue.length > 0) {
    const at = queue.shift() as IntentState
    for (const next of LEGAL_INTENT_TRANSITIONS[at]) {
      if (next === from || prev.has(next)) continue
      prev.set(next, at)
      if (next === to) {
        const path: IntentState[] = [to]
        let step = at
        while (step !== from) {
          path.unshift(step)
          step = prev.get(step) as IntentState
        }
        return path
      }
      queue.push(next)
    }
  }
  return null
}

export type SaleOutcomeV2 = 'open' | 'released' | 'refunded' | 'contested' | 'missing'

/** What became of one sale, from getDeposit(id).state, never from an event's name. */
export function saleOutcomeV2(d: Pick<DepositViewV2, 'state'>): SaleOutcomeV2 {
  if (d.state === V2_STATE.deposit.OPENED) return 'open'
  if (d.state === V2_STATE.deposit.RELEASED) return 'released'
  if (d.state === V2_STATE.deposit.REFUNDED) return 'refunded'
  if (d.state === V2_STATE.deposit.CONTESTED) return 'contested'
  return 'missing'
}

/** May `release(id)` be sent now: Opened, past releaseAt, and past its contest window if it has one. */
export function payoutDueV2(d: Pick<DepositViewV2, 'state' | 'releaseAt' | 'contestUntil'>, chainTime: number): boolean {
  return d.state === V2_STATE.deposit.OPENED && chainTime >= d.releaseAt && chainTime >= d.contestUntil
}

export type BondActionV2 =
  | { kind: 'none' }
  /** releaseBond(id) is due now, and why. */
  | { kind: 'return'; why: 'next_use_held' | 'listing_cancelled' | 'max_age' }
  /** Held, and nothing is due before `until` (chain seconds). `review` once the seller may decide. */
  | { kind: 'wait'; until: number; review: boolean }

/**
 * What to do about the deposit `bond` (id `bondId`) that covers the leftover
 * of listing `l`, whose last sale is `latest` (id `latestId`). The contract's
 * releaseBond rule, read off chain:
 *   (a) the next shopper's sale used this leftover and its contest window has
 *       ended: the deposit goes back (decision 1's two hours);
 *   (b) the listing was cancelled: back at once (cancelListing already does it);
 *   (c) seven days since it was put down, with no sale resolving it.
 * A deposit already returned or forfeited is `none`.
 */
export function bondActionV2(
  bond: Pick<DepositViewV2, 'bondState'>,
  bondId: bigint,
  l: Pick<ListingViewV2, 'state' | 'bondSince' | 'lastDeposit'>,
  latest: Pick<DepositViewV2, 'covers' | 'contestUntil'> | null,
  chainTime: number,
): BondActionV2 {
  if (bond.bondState !== V2_STATE.bond.HELD) return { kind: 'none' }
  const covering = latest !== null && l.lastDeposit !== bondId && latest.covers === bondId && latest.contestUntil !== 0
  if (covering) {
    return chainTime >= latest.contestUntil ? { kind: 'return', why: 'next_use_held' } : { kind: 'wait', until: latest.contestUntil, review: false }
  }
  if (l.state === V2_STATE.listing.CANCELLED) return { kind: 'return', why: 'listing_cancelled' }
  const maxAge = l.bondSince + V2_SECONDS.bondMaxAge
  if (chainTime >= maxAge) return { kind: 'return', why: 'max_age' }
  const review = l.state === V2_STATE.listing.ACTIVE && chainTime >= l.bondSince + V2_SECONDS.bondReviewAfter
  return { kind: 'wait', until: maxAge, review }
}

/**
 * Should the keeper ask Lit to read this readable leftover now and post it
 * (confirmRemainder)? Only an Active readable listing after a sale, with a
 * deposit on its leftover or a ticket that found it short. The read must
 * come after the sale it is about (`basis`: the deposit covering the leftover,
 * else the last sale) and after the last read, as the contract requires.
 *   - Due once at least CONFIRM_DELAY after that sale, if no read that late
 *     was posted yet: that read closes the buyer's window.
 *   - Due at once when a ticket found it short (`shortReported`): the
 *     shortfall posts before anyone else pays for the leftover.
 */
export function confirmDueV2(
  l: Pick<ListingViewV2, 'state' | 'sales' | 'mode' | 'bondDeposit' | 'confirmedAt'>,
  basis: Pick<DepositViewV2, 'openedAt'> | null,
  chainTime: number,
  shortReported: boolean,
): boolean {
  if (l.state !== V2_STATE.listing.ACTIVE || l.sales < 1 || l.mode !== MODE_READABLE || basis === null) return false
  if (chainTime <= basis.openedAt || chainTime <= l.confirmedAt) return false
  if (shortReported) return true
  if (l.bondDeposit === 0n) return false
  const windowEnd = basis.openedAt + V2_SECONDS.confirmDelay
  return chainTime >= windowEnd && l.confirmedAt < windowEnd
}

/**
 * Does a posted read of `balance` count against the deposit's buyer? The
 * contract's rule in confirmRemainder: a shortfall counts against the buyer
 * whose deposit covers the leftover while their window is open (no earlier
 * read at least CONFIRM_DELAY after their sale), else against the seller.
 */
export function shortfallIsBuyersV2(
  l: Pick<ListingViewV2, 'bondDeposit' | 'confirmedAt' | 'remainingCents'>,
  bond: Pick<DepositViewV2, 'openedAt'> | null,
  balance: number,
): boolean {
  return balance < l.remainingCents && l.bondDeposit !== 0n && bond !== null && l.confirmedAt < bond.openedAt + V2_SECONDS.confirmDelay
}
