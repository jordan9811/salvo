/**
 * Intent state machine (PHASE2_BRIEF §5, criterion 8).
 *
 * Deliberately the same shape as the order state machine in src/lib/state.ts —
 * a typed transition table, a throwing assert, and self-transitions illegal by
 * construction. Two state machines that behave differently would be a trap for
 * whoever maintains them.
 *
 * Legal moves, per the brief:
 *   offered          -> matched | cancelled
 *   matched          -> executing | cancelled
 *   executing        -> completed | execution_failed | matched | offered
 *   execution_failed -> refunded
 *   completed | cancelled | refunded -> (terminal)
 *
 * Note what is NOT legal: executing -> cancelled. Once the adapter is mid-
 * redemption the seller can no longer pull the card out from under the buyer;
 * that window closes deliberately, and it is why balance-watch auto-cancels
 * BEFORE a match rather than during execution.
 */

import { EscrowRailRefusedError, isEscrowIntentId } from '../escrow/refs'
import type { IntentState } from './types'

export const LEGAL_INTENT_TRANSITIONS: Readonly<Record<IntentState, readonly IntentState[]>> = {
  offered: ['matched', 'cancelled'],
  matched: ['executing', 'cancelled'],
  // `executing -> matched` is the BOUNDED RE-OPEN, and it is the one edge here
  // that gives a claim back. It exists because one reveal per order was
  // absolute, so a register malfunction became a dispute instead of a retry.
  //
  // It does NOT weaken the claim that stops two devices racing one card: that
  // claim is the `matched -> executing` compare-and-swap, which still admits
  // exactly one winner. Releasing back to `matched` is a deliberate, counted,
  // window-must-be-closed transition — a sequential retry, not a concurrent one.
  // The cap lives in reveal-marker.ts and the window check in `canReopen`.
  //
  // `executing -> offered` LISTS THE SAME CARD AGAIN, on the same row and the
  // same seal (a listing seal pins only the intent id, envelope.ts). Only the
  // reveal path takes it, and only once the window is closed and the order's
  // money is decided or deliberately kept: today, a "didn't scan" at a store
  // nobody can check, whose hold is kept while the card goes to the next
  // shopper first (src/lib/barcode/unscanned.ts). The relist of a used card's
  // remainder takes the same edge as its release, in place of `-> completed`:
  // the window is decided, and the capture follows it as it follows every
  // release (src/lib/supply/remainder.ts). And a card till code held at Pay
  // and never shown, once its hold is released: nothing about the card
  // changed (reveal-service.ts closeUnshownCode). The row cannot check any of
  // these conditions, so the caller does, in the same swap.
  //
  // Still absent, deliberately: `executing -> cancelled`. A seller may not pull
  // a card out from under a buyer who is holding a live code.
  executing: ['completed', 'execution_failed', 'matched', 'offered'],
  execution_failed: ['refunded'],
  completed: [],
  cancelled: [],
  refunded: [],
} as const

export const ALL_INTENT_STATES: readonly IntentState[] = Object.freeze(
  Object.keys(LEGAL_INTENT_TRANSITIONS) as IntentState[],
)

export const TERMINAL_INTENT_STATES: readonly IntentState[] = Object.freeze(
  ALL_INTENT_STATES.filter((s) => LEGAL_INTENT_TRANSITIONS[s].length === 0),
)

/** States where the seller can still withdraw the offer costlessly. */
export const CANCELLABLE_INTENT_STATES: readonly IntentState[] = Object.freeze(
  ALL_INTENT_STATES.filter((s) => LEGAL_INTENT_TRANSITIONS[s].includes('cancelled')),
)

/** States where a buyer's funds are committed and must be protected. */
export const BUYER_EXPOSED_INTENT_STATES: readonly IntentState[] = Object.freeze([
  'matched',
  'executing',
  'execution_failed',
])

export class IllegalIntentTransitionError extends Error {
  readonly from: IntentState
  readonly to: IntentState
  readonly intentId: string | undefined

  constructor(from: IntentState, to: IntentState, intentId?: string) {
    const allowed = LEGAL_INTENT_TRANSITIONS[from]
    const tail =
      allowed.length === 0
        ? `${from} is terminal — no transitions out of it are legal`
        : `legal moves from ${from} are: ${allowed.join(', ')}`
    super(
      `Illegal intent state transition ${from} -> ${to}` +
        (intentId ? ` for intent ${intentId}` : '') +
        `. ${tail}.`,
    )
    this.name = 'IllegalIntentTransitionError'
    this.from = from
    this.to = to
    this.intentId = intentId
  }
}

export function isTerminalIntent(state: IntentState): boolean {
  return LEGAL_INTENT_TRANSITIONS[state].length === 0
}

export function canTransitionIntent(from: IntentState, to: IntentState): boolean {
  // Self-transitions are never legal: an intent moving matched -> matched is a
  // double-processed match, which must be loud rather than idempotent.
  if (from === to) return false
  return LEGAL_INTENT_TRANSITIONS[from].includes(to)
}

/**
 * The shared rule every path that moves a listing goes through.
 *
 * AN ESCROW LISTING NEVER MOVES THROUGH HERE. Its state follows the chain,
 * and only the escrow keeper writes it (src/lib/escrow/keeper.ts, which checks
 * the same table through `canTransitionIntent`). Some paths reach this with
 * only an id, and then write the row directly (the reveal settle's release),
 * so the id alone is enough to refuse: escrow listing ids are `esc_` and 64
 * hex digits, which no cuid is (src/lib/escrow/refs.ts).
 */
export function assertIntentTransition(
  from: IntentState,
  to: IntentState,
  intentId?: string,
): void {
  if (isEscrowIntentId(intentId)) throw new EscrowRailRefusedError(`move intent ${intentId} to ${to}`)
  if (!canTransitionIntent(from, to)) {
    throw new IllegalIntentTransitionError(from, to, intentId)
  }
}

/** Can the seller still pull this offer at no cost? */
export function isCancellable(state: IntentState): boolean {
  return CANCELLABLE_INTENT_STATES.includes(state)
}

/** Are a buyer's funds committed against this intent right now? */
export function buyerIsExposed(state: IntentState): boolean {
  return BUYER_EXPOSED_INTENT_STATES.includes(state)
}
