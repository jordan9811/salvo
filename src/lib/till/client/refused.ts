/**
 * How a till backend says no, the same on both rails (unified-account spec
 * 5.1): a code the screen keys on, and the sentence it shows.
 *
 * TWO CODES KEEP THE TAP'S KEY. No answer at all (NO_ANSWER), and a tap still
 * going through (STILL_GOING): neither says what the tap did, so the screen
 * asks again with the same key, which finds what the first one did rather
 * than paying twice. On the card rail that is our server; on the dollars
 * rail, a payment this phone signed and sent that the chain has not settled
 * yet. Every other code ends the key.
 *
 * Pure: no imports. Both backends and the till's screens use it.
 */

/** A refusal from the till, with the code the screen keys on and the sentence it shows. */
export class TillRefused extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'TillRefused'
    this.code = code
    this.status = status
  }
}

/** No answer came back. The request may have acted; asking again the same way is safe. */
export const NO_ANSWER = 'network'
/**
 * The tap with this key is still going through. Not an answer about the tap:
 * it is asked again with the same key, never a new one.
 */
export const STILL_GOING = 'still_going'
