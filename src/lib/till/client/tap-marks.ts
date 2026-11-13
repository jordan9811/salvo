/**
 * A dollars tap, step by step, in this browser's console, when this browser
 * asks for it: localStorage "salvo:till-timing" set to "1". Off otherwise.
 *
 * The same steps scripts/till-timing.ts prints offline (src/lib/till/timing.ts
 * TapStep): ticket wait, reads, sign, send, included, second host, release,
 * and render, the first barcode on screen. So a run on a phone or in a test
 * browser reads where the tap went without a request log. Each line is a
 * step's name and its milliseconds, nothing else: never a card, a key, an
 * address or an amount.
 *
 * Browser only by use. A setting that cannot be read (a private window, a
 * thumbnail render) means off.
 */

import { TAP_STEP_NAMES, type TapStep } from '../timing'

const SETTING = 'salvo:till-timing'

function timingOn(): boolean {
  try {
    return globalThis.localStorage?.getItem(SETTING) === '1'
  } catch {
    return false
  }
}

/** The dollars backend's onMark hook: prints each step as it ends, or undefined while timing is off. */
export function tapMarks(): ((step: TapStep, ms: number) => void) | undefined {
  if (!timingOn()) return undefined
  return (step, ms) => {
    console.info(`[till timing] ${TAP_STEP_NAMES[step]} ${Math.round(ms)} ms`)
  }
}

/**
 * The till's own step: from the first code in hand (`since`, performance.now)
 * to the frame after the scan screen is painted with it. Nothing while timing
 * is off.
 */
export function markRender(since: number): void {
  const mark = tapMarks()
  if (mark === undefined || typeof globalThis.requestAnimationFrame !== 'function') return
  globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => mark('render', performance.now() - since)))
}
