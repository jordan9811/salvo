/**
 * The leftovers whose buyer said they are done with the card (POST
 * /api/escrow/done), so the till offers the leftover to the next shopper at
 * once instead of after its two-hour rest (till-quote-v2.ts restingV2,
 * quote-v2.ts LEFTOVER_REST_MS).
 *
 * WHY THE REST CAN END EARLY. It is there for one person: the buyer who may
 * still have the card on screen, unscanned, whose paid-for value the next
 * register would take. Once that buyer's phone says the till is done with the
 * card (Next past it, Done, or "Register says paid"), nobody is left to
 * protect. A buyer who never says so keeps the whole two hours.
 *
 * ONLY A MARK THE CHAIN BACKS. The route keeps a mark only after the card's
 * reply key signed for that deposit and the deposit, read at the block both
 * hosts agree on, names that key's keccak256 as its replyKeyHash. Each mark
 * names that key, and the quote honours it only while the deposit covering
 * the leftover still names the same key. So there is at most one mark per real
 * deposit, and a mark nobody's key backs is never made.
 *
 * IN THIS PROCESS'S MEMORY, AND THAT IS ENOUGH. One server answers the phone's
 * done and the next shopper's quote. A restart forgets every mark, and each
 * leftover then simply rests its two hours, as before marks existed: the rest
 * is the safe default, and a mark only ever shortens it. A mark is kept at
 * most LEFTOVER_REST_MS, after which the rest is over anyway.
 *
 * Server-only by use.
 */

import type { Hex } from 'viem'
import { LEFTOVER_REST_MS } from './quote-v2'

/** Far more deposits than two hours of sales open: past it, the oldest mark goes first. */
const MAX_MARKS = 20_000

class LeftoverDone {
  readonly #marks = new Map<string, { keyHash: Hex; at: number }>()

  /** Keep that the buyer holding the key `keyHash` is done with deposit `depositId`'s card. The route checks both first. */
  mark(escrow: Hex, depositId: string, keyHash: Hex, now: number): void {
    const k = `${escrow.toLowerCase()}|${depositId}`
    // Newest last, so the oldest is the first to go.
    this.#marks.delete(k)
    if (this.#marks.size >= MAX_MARKS) {
      for (const [x, m] of this.#marks) if (now - m.at >= LEFTOVER_REST_MS) this.#marks.delete(x)
      const oldest = this.#marks.keys().next()
      if (this.#marks.size >= MAX_MARKS && !oldest.done) this.#marks.delete(oldest.value)
    }
    this.#marks.set(k, { keyHash: keyHash.toLowerCase() as Hex, at: now })
  }

  /** Did the buyer holding `keyHash`, the key the chain names for this deposit now, say they are done with its card? */
  done(escrow: Hex, depositId: bigint | string, keyHash: Hex, now: number): boolean {
    const m = this.#marks.get(`${escrow.toLowerCase()}|${depositId.toString()}`)
    return m !== undefined && m.keyHash === keyHash.toLowerCase() && now - m.at < LEFTOVER_REST_MS
  }

  clear(): void {
    this.#marks.clear()
  }
}

export const leftoverDone = new LeftoverDone()

/** Tests only: forget every mark, as a restart does. */
export function __clearLeftoverDoneForTests(): void {
  leftoverDone.clear()
}
