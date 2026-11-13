/**
 * How long the till takes, step by step (unified-account spec 0, "How
 * fast", and scripts/till-timing.ts).
 *
 * ===========================================================================
 * MEASURED THROUGH THE TILL'S OWN INTERFACE. The timer drives a TillBackend,
 * the same one the keypad drives, so a number here is the time the screen
 * waits: the price after typing stops, what the tap needs fetched while the
 * shopper still types (prepare: on the dollars rail the tickets, the chain
 * read and the batch's nonce, fees and gas; on the card rail nothing), the
 * tap to the first code in hand, drawing it, each Next to the next barcode,
 * and Done. The targets: about 2 s from the tap to the first barcode in
 * dollars, about 1.5 s by card.
 *
 * A DESKTOP NUMBER IS NOT A PHONE NUMBER. Run from a laptop it leaves out
 * the phone's radio and Safari. It says what our server and the card
 * processor add, which is the part we can change; the phone check in the
 * spec's phase 0 says the rest.
 * ===========================================================================
 *
 * Pure apart from the backend it is given: the clock is passed in.
 */

import type { LegCode, RoutePreference, TillBackend } from './types'

/**
 * The steps of one tap, as the dollars rail marks them (dollars-backend.ts,
 * load-v2.ts) and the till marks the last:
 *   - prepare: while typing, not in the tap: the tickets, the card checks
 *     and the batch filled;
 *   - ticket wait: the tap waiting for a prepare still going (0 when it was
 *     done before the tap);
 *   - reads: what had aged since the prepare, read again in one round (0
 *     when nothing had);
 *   - sign, send, included (the first host's receipt), second host (its
 *     agreement), release (Lit opening every card), render (the first
 *     barcode drawn).
 * The tap to the first barcode is ticket wait, reads, sign, send, included,
 * the slower of second host and release, and render.
 */
export type TapStep = 'prepare' | 'ticket_wait' | 'reads' | 'sign' | 'send' | 'included' | 'second_host' | 'release' | 'render'

/** The steps in the order a tap goes through them, as scripts/till-timing.ts and the till print them. */
export const TAP_STEPS: readonly TapStep[] = ['prepare', 'ticket_wait', 'reads', 'sign', 'send', 'included', 'second_host', 'release', 'render']

/** Each step's name as printed. */
export const TAP_STEP_NAMES: Readonly<Record<TapStep, string>> = {
  prepare: 'prepare',
  ticket_wait: 'ticket wait',
  reads: 'reads',
  sign: 'sign',
  send: 'send',
  included: 'included',
  second_host: 'second host',
  release: 'release',
  render: 'render',
}

/** One purchase, timed. Milliseconds. */
export interface TillTiming {
  quoteMs: number
  /** While the shopper types, before the tap: what the tap needs, fetched. */
  prepareMs: number
  /** The tap to the first card's code in hand. */
  payMs: number
  /** Drawing that code as the barcode on screen. */
  renderMs: number
  /** Each Next to the next barcode, in scan order. Empty for one card. */
  nextMs: number[]
  doneMs: number
  cards: number
  costCents: number
  depositCents: number
}

/**
 * Quote, prepare (as the till does while the total stays as typed), pay,
 * draw the first code, Next through every card, then Done on the last: what
 * a shopper does when every code scans. Done settles the purchase, so a live
 * run is a real purchase on whatever card the backend pays with. `render`
 * draws a code as the screen would; without it nothing is drawn.
 *
 * `tap`: the tap comes `afterMs` after the prepare starts, through `pause`,
 * finished or not, as the till's does (measured 2026-10-14: 1.47 s after the
 * tickets were asked for, with the tickets taking 2.4 s), so the tap's wait
 * for them shows. Without it the tap comes once the prepare is done.
 */
export async function timeTillPurchase(
  backend: TillBackend,
  a: { merchant: string; totalCents: number; preference: RoutePreference },
  clock: () => number,
  render: (code: LegCode) => unknown = () => undefined,
  tap: { afterMs: number; pause: (ms: number) => Promise<void> } | null = null,
): Promise<TillTiming | { unavailable: string }> {
  const q0 = clock()
  const plan = await backend.quote(a)
  const quoteMs = clock() - q0
  if ('unavailable' in plan) return { unavailable: plan.unavailable }

  const r0 = clock()
  let prepareMs = 0
  const preparing = backend.prepare(plan).then(() => {
    prepareMs = clock() - r0
  })
  if (tap === null) await preparing
  else {
    // The tap's own prepare waits for this one; a failure is the tap's to say.
    preparing.catch(() => undefined)
    await Promise.race([preparing, tap.pause(tap.afterMs)])
  }

  const p0 = clock()
  if (tap !== null) await backend.prepare(plan, { tap: true })
  const paid = await backend.pay(plan)
  const payMs = clock() - p0
  // Supply moved between the quote and the tap: nothing was held, so there is nothing to time.
  if ('requote' in paid || 'ended' in paid) return { unavailable: paid.message }
  const purchase = paid
  const w0 = clock()
  await render(purchase.code)
  const renderMs = clock() - w0

  const nextMs: number[] = []
  let code = purchase.code
  while (code.scanIndex < code.scanOf) {
    const n0 = clock()
    code = await backend.next(purchase, code.scanIndex)
    nextMs.push(clock() - n0)
  }

  const d0 = clock()
  await backend.done(purchase, code.scanIndex)
  const doneMs = clock() - d0

  return {
    quoteMs,
    prepareMs,
    payMs,
    renderMs,
    nextMs,
    doneMs,
    cards: purchase.plan.legs.length,
    costCents: purchase.plan.costCents,
    depositCents: purchase.plan.depositCents,
  }
}

/** The middle of some samples, and their spread. Null for none. */
export function summarize(samples: readonly number[]): { median: number; min: number; max: number; n: number } | null {
  if (samples.length === 0) return null
  const s = [...samples].sort((x, y) => x - y)
  const mid = Math.floor(s.length / 2)
  const median = s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
  return { median, min: s[0] ?? 0, max: s[s.length - 1] ?? 0, n: s.length }
}
