/**
 * The card till's answers, made up once: what /api/card/till/* and GET
 * /api/account say for one plausible purchase at Target.
 *
 * Two readers. scripts/ui-states.ts answers the till page's fetches with
 * them, so the real screens render against a real-shaped reply and nothing
 * is written anywhere. scripts/till-timing.ts drives the real card backend
 * against them offline, so the timer's own path runs with no network.
 * tests/till-fixtures.test.ts proves the real card backend accepts every
 * answer here, so a change to the routes' shapes fails a test before it
 * quietly breaks a screenshot.
 *
 * The purchase: $52.13 at Target, two cards. Card 1 is the rest of another
 * shopper's card, waiting first in line, used whole. Card 2 is fresh and
 * part used: $3.87 stays on it, with a $3.87 deposit behind it. No number
 * here is a real card.
 */

import type { LegCode, RoutePlan, TillReceipt } from '../src/lib/till/types'

export const TILL_FIXTURE_STORE = 'target'

/** What the keypad types: "5", "2", "1", "3". */
export const TILL_FIXTURE_TOTAL_CENTS = 5213

/** Target-eGift-shaped payloads: 26 digits. Not cards. */
export const TILL_FIXTURE_BARCODES = ['98765432109876543210123456', '98765432109876543210654321'] as const

/** The handle the fixture's Pay hands back, and every later step presents. */
export const TILL_FIXTURE_PURCHASE = 'fixture-purchase'

/** A signed-in browser with a saved card: what GET /api/account answers. */
export function tillAccountView(o: { address?: string | null; card?: boolean } = {}): Record<string, unknown> {
  const card = o.card ?? true
  return {
    signedIn: o.address !== null,
    address: o.address === undefined ? '0x5a1f000000000000000000000000000000000042' : o.address,
    cardRail: true,
    card: card ? { brand: 'visa', last4: '4242' } : null,
    cardLinked: card && o.address !== null,
    cardKnown: true,
    heldCents: 0,
    allowanceCents: 20_000,
    prefs: null,
  }
}

const PREFERENCE = { mode: 'in_and_out', maxCards: 2 } as const

/** The plan for the fixture's total. Leg 1 the remainder, leg 2 the part-used fresh card. */
export function tillPlan(now: Date = new Date()): RoutePlan {
  return {
    rail: 'card',
    merchant: TILL_FIXTURE_STORE,
    totalCents: TILL_FIXTURE_TOTAL_CENTS,
    legs: [
      {
        ref: 'leg-1',
        source: 'remainder',
        firstInLine: true,
        faceCents: 2_100,
        appliedCents: 2_100,
        costCents: 1_890,
        leftoverCents: 0,
        depositCents: 0,
        scanIndex: 1,
        scanOf: 2,
      },
      {
        ref: 'leg-2',
        source: 'fresh',
        firstInLine: false,
        faceCents: 3_500,
        appliedCents: 3_113,
        costCents: 2_802,
        leftoverCents: 387,
        depositCents: 387,
        scanIndex: 2,
        scanOf: 2,
      },
    ],
    costCents: 4_692,
    savingCents: 521,
    depositCents: 387,
    uncoveredCents: 0,
    preference: { ...PREFERENCE },
    quoteRef: 'fixture-quote',
    expiresAt: new Date(now.getTime() + 600_000).toISOString(),
  }
}

/** What is still owed when card 1 did not work: one more card, for all of it. */
export function tillOwedPlan(now: Date = new Date()): RoutePlan {
  return {
    ...tillPlan(now),
    legs: [
      {
        ref: 'leg-1',
        source: 'fresh',
        firstInLine: false,
        faceCents: 5_500,
        appliedCents: 5_213,
        costCents: 4_692,
        leftoverCents: 287,
        depositCents: 287,
        scanIndex: 1,
        scanOf: 1,
      },
    ],
    costCents: 4_692,
    savingCents: 521,
    depositCents: 287,
    quoteRef: 'fixture-owed',
  }
}

/** Card `scanIndex`'s code. `pdf417` is the store's own 2D code, drawn by whoever calls. */
export function tillCode(scanIndex: 1 | 2, pdf417: string | null, now: Date = new Date()): LegCode {
  const leg = tillPlan(now).legs[scanIndex - 1]
  return {
    scanIndex,
    scanOf: 2,
    coversCents: leg?.appliedCents ?? 0,
    leftoverCents: leg?.leftoverCents ?? 0,
    depositCents: leg?.depositCents ?? 0,
    barcode: TILL_FIXTURE_BARCODES[scanIndex - 1] ?? TILL_FIXTURE_BARCODES[0],
    pdf417,
    expiresAt: new Date(now.getTime() + 90_000).toISOString(),
    // Target: nobody can check, so no answer counts as used.
    silenceIsSale: true,
  }
}

/** The receipt once both cards scanned. */
export function tillReceipt(): TillReceipt {
  const p = tillPlan()
  return { paidCents: p.costCents, savedCents: p.savingCents, depositCents: p.depositCents, keptCents: 0 }
}

/**
 * What is still owed when the total went up by $3.00 with card 1 on screen:
 * card 2 was closed unshown, so the rest after card 1 is $34.13, one card.
 * Its button sits under card 1's code until card 1 has scanned.
 */
export function tillAddPlan(now: Date = new Date()): RoutePlan {
  return {
    ...tillPlan(now),
    totalCents: 3_413,
    legs: [
      {
        ref: 'leg-1',
        source: 'fresh',
        firstInLine: false,
        faceCents: 3_500,
        appliedCents: 3_413,
        costCents: 3_072,
        leftoverCents: 87,
        depositCents: 0,
        scanIndex: 1,
        scanOf: 1,
      },
    ],
    costCents: 3_072,
    savingCents: 341,
    depositCents: 0,
    quoteRef: 'fixture-add',
  }
}

/** The new totals the fixture's "The total changed" answers, by what the shopper types. */
export const TILL_FIXTURE_TOTAL_UP_CENTS = 5_513
export const TILL_FIXTURE_TOTAL_DOWN_CENTS = 1_400

/**
 * The answer to one till POST, by the route's last path segment, or null
 * for a path that is not the till's. `pdf417` draws a payload's 2D code, or
 * gives null for none.
 */
export function tillRouteAnswer(
  step: string,
  body: Record<string, unknown>,
  pdf417: (payload: string) => string | null,
): { status: number; body: Record<string, unknown> } | null {
  const now = new Date()
  const code = (i: 1 | 2) => tillCode(i, pdf417(TILL_FIXTURE_BARCODES[i - 1] ?? ''), now)
  switch (step) {
    case 'quote':
      return { status: 200, body: { plan: tillPlan(now) } }
    case 'pay':
      // "Pay $X more" pays the owed plan: its one card, in place of the two.
      if (typeof body.after === 'string') {
        const owed = tillOwedPlan(now)
        return { status: 200, body: { purchase: `${TILL_FIXTURE_PURCHASE}-2`, plan: owed, code: { ...code(1), scanOf: 1, coversCents: 5_213, leftoverCents: 287 } } }
      }
      return { status: 200, body: { purchase: TILL_FIXTURE_PURCHASE, plan: tillPlan(now), code: code(1) } }
    case 'next':
      return { status: 200, body: { code: code(2) } }
    case 'done':
    case 'receipt':
      return { status: 200, body: { receipt: tillReceipt() } }
    case 'report': {
      // An empty remainder after Done, or any other problem, is answered with
      // the receipt and a note; a card that did not work, with what is owed,
      // and its hold kept, as Target keeps it for the next shopper.
      if (body.outcome === 'empty' || body.outcome === 'problem') {
        return {
          status: 200,
          body: {
            plan: null,
            owedCents: 0,
            receipt: tillReceipt(),
            kept: null,
            note: body.outcome === 'empty' ? 'Got it. Your hold for card 1 is released, and nothing is charged for it.' : 'Got it. A person will look at this card within a day.',
          },
        }
      }
      const kept = { cents: 1_890, until: 'next_shopper' }
      const none = { paidCents: 0, savedCents: 0, depositCents: 0, keptCents: 1_890 }
      return { status: 200, body: { plan: tillOwedPlan(now), owedCents: TILL_FIXTURE_TOTAL_CENTS, receipt: none, kept, note: null } }
    }
    case 'change': {
      // Up: card 2 is closed and the rest is one more card, after card 1.
      // Down past what can stay on card 1: it must not be scanned.
      const cover = { scanIndex: 1, coversCents: 2_100, leftoverCents: 0, depositCents: 0 }
      const purchasePlan = { ...tillPlan(now), legs: tillPlan(now).legs.slice(0, 1) }
      if (body.totalCents === TILL_FIXTURE_TOTAL_DOWN_CENTS) {
        return {
          status: 200,
          body: {
            purchase: TILL_FIXTURE_PURCHASE,
            unavailable: 'The total came down by more than we can leave on this card. Do not scan it. Tap Use other cards.',
            purchasePlan,
            cover,
            tooLow: true,
          },
        }
      }
      if (body.totalCents === TILL_FIXTURE_TOTAL_UP_CENTS) {
        return { status: 200, body: { purchase: TILL_FIXTURE_PURCHASE, plan: tillAddPlan(now), purchasePlan, cover, tooLow: false } }
      }
      return { status: 200, body: { purchase: TILL_FIXTURE_PURCHASE, plan: null, purchasePlan: tillPlan(now), cover, tooLow: false } }
    }
    default:
      return null
  }
}
