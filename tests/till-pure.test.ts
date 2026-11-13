/**
 * The till's pure parts, each pinned on its own (unified-account spec 5, 7
 * and 9.3):
 *
 *   - the purchase handle: only ours verifies, it carries the scan order, it
 *     names the card customer only as a tag the server binds back from the
 *     browser's own cookie, and it runs out after 48 hours;
 *   - the deposit's rules (src/lib/hold/bond.ts): released once the rest of
 *     the card proves itself, a day before it lapses, or when nothing stands
 *     behind it; taken only on a recorded report or a shortfall found on
 *     sale, never more than it holds and never under the smallest charge;
 *     kept while a kept hold stands behind its whole card;
 *   - what one till card is charged at its release (bond.ts settleTillLeg):
 *     less used, within the cap, is billed less behind a deposit for all
 *     that is left, held first, and as planned when that deposit cannot be
 *     held; past the cap the read credits nothing and the card is billed
 *     whole; more used, or a total that went up, is charged from the deposit
 *     at release, with a new deposit held first; only the plan's own
 *     leftover is ever retired as a booked loss;
 *   - the keypad types like a register;
 *   - the till's words never name the card processor or the camera, and say
 *     what the spec's screens say.
 */

import { describe, expect, it } from 'vitest'
import { bindPurchaseRef, mintPurchaseRef, verifyPurchaseRef, PURCHASE_REF_TTL_SEC } from '@/lib/till/purchase'
import { BOND_NEAR_LAPSE_MS, decideBond, legPriceOf, settleTillLeg } from '@/lib/hold/bond'
import { applyKey, KEYPAD_MAX_CENTS } from '@/app/pay/[store]/keys'
import * as copy from '@/app/pay/till-copy'
import type { RoutePlan } from '@/lib/till/types'

const SECRET = 's'.repeat(32)
const NOW = new Date('2026-10-12T15:00:00Z')
const HOUR = 3600_000
const DAY = 24 * HOUR

const purchase = {
  legs: [
    { orderId: 'cord1', intentId: 'cint1' },
    { orderId: 'cord2', intentId: 'cint2' },
  ],
  customerId: 'cus_abc123',
  merchantId: 'target',
  totalCents: 5_213,
}

describe('the purchase handle', () => {
  const read = (text: string, customerId = purchase.customerId, now = NOW) => {
    const unbound = verifyPurchaseRef(text, SECRET, now)
    return unbound === null ? null : bindPurchaseRef(unbound, customerId, SECRET)
  }

  it('round-trips the cards in scan order, the customer, the store and the total', () => {
    const text = mintPurchaseRef(purchase, SECRET, NOW)
    expect(read(text)).toEqual({
      ...purchase,
      expiresAt: new Date(NOW.getTime() + PURCHASE_REF_TTL_SEC * 1000),
    })
  })

  it('names no card customer: the page that holds it never learns the processor id', () => {
    const text = mintPurchaseRef(purchase, SECRET, NOW)
    expect(text).not.toContain('cus_')
    expect(text).not.toContain('abc123')
    // Bound back only from the browser's own customer.
    expect(read(text, 'cus_other1')).toBeNull()
  })

  it('is refused when it is not ours, when it is changed, and once it has run out', () => {
    const text = mintPurchaseRef(purchase, SECRET, NOW)
    expect(verifyPurchaseRef(text, 'x'.repeat(32), NOW)).toBeNull()
    // Naming someone else's order changes the signed text.
    expect(verifyPurchaseRef(text.replace('cord2', 'cord9'), SECRET, NOW)).toBeNull()
    // A tag for another customer, swapped in, breaks the signature.
    const other = mintPurchaseRef({ ...purchase, customerId: 'cus_other1' }, SECRET, NOW).split('.')[2] ?? ''
    expect(verifyPurchaseRef(text.replace(text.split('.')[2] ?? '', other), SECRET, NOW)).toBeNull()
    expect(read(text, purchase.customerId, new Date(NOW.getTime() + 49 * HOUR))).toBeNull()
    expect(read(text, purchase.customerId, new Date(NOW.getTime() + 47 * HOUR))).not.toBeNull()
    for (const bad of ['', 'tp1', 'a.b.c.d.e.f.g', `${text}x`]) expect(verifyPurchaseRef(bad, SECRET, NOW)).toBeNull()
  })

  it('is minted only for a well-formed purchase of one to five cards', () => {
    expect(() => mintPurchaseRef({ ...purchase, legs: [] }, SECRET, NOW)).toThrow()
    const six = Array.from({ length: 6 }, (_, i) => ({ orderId: `o${i}`, intentId: `i${i}` }))
    expect(() => mintPurchaseRef({ ...purchase, legs: six }, SECRET, NOW)).toThrow()
    expect(() => mintPurchaseRef({ ...purchase, legs: [{ orderId: 'a:b', intentId: 'c' }] }, SECRET, NOW)).toThrow()
    expect(() => mintPurchaseRef({ ...purchase, customerId: 'nobody' }, SECRET, NOW)).toThrow()
    expect(() => mintPurchaseRef({ ...purchase, totalCents: 0 }, SECRET, NOW)).toThrow()
  })
})

describe('the deposit rules', () => {
  const live = { status: 'requires_capture', captureBefore: new Date(NOW.getTime() + 4 * DAY) }
  const aOrder = { id: 'ordA', state: 'fulfilled' }
  const listed = { state: 'offered', failureReason: 'REMAINDER|ordA|pi_dep', matchedOrderId: null, expiresAt: new Date(NOW.getTime() + 30 * DAY) }
  const base = {
    aOrder,
    depositCents: 387,
    bond: live,
    card: listed,
    remainderNamesThis: true,
    next: null,
    readable: false,
    minTakeCents: 50,
    shortOnSaleCents: null,
    now: NOW,
  }

  it('waits while the rest of the card is first in line', () => {
    expect(decideBond(base)).toMatchObject({ act: 'wait' })
  })

  it('waits while the first shopper\'s own code is being settled', () => {
    const card = { ...listed, state: 'executing', failureReason: 'REVEAL_OPEN|x', matchedOrderId: 'ordA' }
    expect(decideBond({ ...base, aOrder: { id: 'ordA', state: 'fulfilling' }, card, remainderNamesThis: false })).toMatchObject({ act: 'wait' })
  })

  it('is released a day before it would lapse, and the rest stays first in line with none', () => {
    const bond = { ...live, captureBefore: new Date(NOW.getTime() + BOND_NEAR_LAPSE_MS - 1) }
    expect(decideBond({ ...base, bond })).toEqual({ act: 'release', why: expect.any(String), clearMarker: true })
  })

  it('takes the deposit, up to what it holds, only on a recorded report', () => {
    const next = { id: 'ordB', state: 'refunded', shortCents: 387 }
    const card = { ...listed, state: 'refunded', failureReason: null, matchedOrderId: 'ordB' }
    expect(decideBond({ ...base, card, remainderNamesThis: false, next })).toMatchObject({ act: 'capture', cents: 387 })
    expect(decideBond({ ...base, card, remainderNamesThis: false, next: { ...next, shortCents: 9_000 } })).toMatchObject({ act: 'capture', cents: 387 })
    // The same refund with no report says nothing about the rest: released.
    expect(decideBond({ ...base, card, remainderNamesThis: false, next: { ...next, shortCents: null } })).toMatchObject({ act: 'release' })
  })

  it('never takes less than the smallest charge: a shortfall under it is written off and the deposit released', () => {
    const next = { id: 'ordB', state: 'refunded', shortCents: 5 }
    const card = { ...listed, state: 'refunded', failureReason: null, matchedOrderId: 'ordB' }
    expect(decideBond({ ...base, card, remainderNamesThis: false, next })).toMatchObject({ act: 'release' })
    expect(decideBond({ ...base, card, remainderNamesThis: false, next: { ...next, shortCents: 50 } })).toMatchObject({ act: 'capture', cents: 50 })
  })

  it('takes a shortfall found while the rest was on sale, for the seller, and not as a strike', () => {
    expect(decideBond({ ...base, shortOnSaleCents: 200 })).toEqual({
      act: 'capture',
      cents: 200,
      why: expect.any(String),
      strike: false,
    })
    // Up to what it holds; under the smallest charge it stays behind the rest.
    expect(decideBond({ ...base, shortOnSaleCents: 9_000 })).toMatchObject({ act: 'capture', cents: 387 })
    expect(decideBond({ ...base, shortOnSaleCents: 20 })).toMatchObject({ act: 'wait' })
  })

  it('waits with a kept hold that stands behind the whole card, after "it didn\'t scan" on it', () => {
    // The kept hold covers what the card was to apply; this deposit, the rest at face.
    const kept = { ...listed, failureReason: 'UNSCANNED|ordA' }
    expect(decideBond({ ...base, aOrder: { id: 'ordA', state: 'fulfilling' }, card: kept, remainderNamesThis: false })).toMatchObject({
      act: 'wait',
    })
    // Another order's kept hold says nothing about this deposit.
    expect(decideBond({ ...base, card: { ...listed, failureReason: 'UNSCANNED|ordZ' }, remainderNamesThis: false })).toMatchObject({
      act: 'release',
    })
  })

  it('waits out the next shopper\'s report window at a store nobody can check, and releases once they are charged', () => {
    const card = { ...listed, state: 'completed', failureReason: null, matchedOrderId: 'ordB' }
    expect(decideBond({ ...base, card, remainderNamesThis: false, next: { id: 'ordB', state: 'fulfilling', shortCents: null } })).toMatchObject({ act: 'wait' })
    expect(decideBond({ ...base, card, remainderNamesThis: false, next: { id: 'ordB', state: 'fulfilled', shortCents: null } })).toMatchObject({ act: 'release' })
  })

  it('releases at once where the next shopper\'s balance read proved the rest', () => {
    const card = { ...listed, state: 'executing', failureReason: 'REVEAL_OPEN|x', matchedOrderId: 'ordB' }
    const next = { id: 'ordB', state: 'fulfilling', shortCents: null }
    // Their window is open: their own settle decides it.
    expect(decideBond({ ...base, card, remainderNamesThis: false, next, readable: true })).toMatchObject({ act: 'wait' })
    const done = { ...card, state: 'completed', failureReason: null }
    expect(decideBond({ ...base, card: done, remainderNamesThis: false, next, readable: true })).toMatchObject({ act: 'release' })
  })

  it('is released when nothing stands behind it: the first code failed, the card was marked used, or it expired', () => {
    expect(decideBond({ ...base, aOrder: { id: 'ordA', state: 'refunded' } })).toMatchObject({ act: 'release' })
    expect(decideBond({ ...base, card: { ...listed, state: 'cancelled' }, remainderNamesThis: false })).toMatchObject({ act: 'release' })
    expect(decideBond({ ...base, card: { ...listed, expiresAt: new Date(NOW.getTime() - 1) } })).toMatchObject({ act: 'release', clearMarker: true })
  })

  it('does nothing to a deposit the processor has already decided', () => {
    expect(decideBond({ ...base, bond: { ...live, status: 'canceled' } })).toEqual({ act: 'done', clearMarker: true })
    expect(decideBond({ ...base, bond: { ...live, status: 'succeeded' }, remainderNamesThis: false })).toEqual({ act: 'done', clearMarker: false })
    expect(decideBond({ ...base, bond: null })).toEqual({ act: 'done', clearMarker: true })
  })
})

describe('what one till card is charged at its release', () => {
  // A $60 Best Buy card at 10% off, bought whole: its hold is $54.00.
  const whole = { holdCents: 5_400, boughtCents: 6_000, priceCents: 5_400, faceValueCents: 6_000 }
  const base = (over: Partial<Parameters<typeof settleTillLeg>[0]> = {}) => ({
    usedCents: 6_000,
    leftCents: 0,
    appliedCents: 6_000,
    holdCents: 5_400,
    depositCents: 0,
    capCents: 1_000,
    relistMinCents: 100,
    minChargeCents: 50,
    priceOf: legPriceOf(whole),
    ...over,
  })

  /** The ways to settle, best first. None lists more than the cap, and the last lists nothing and needs no deposit. */
  const ways = (over: Partial<Parameters<typeof settleTillLeg>[0]> = {}) => {
    const out = settleTillLeg(base(over))
    for (const w of out) expect(w.listCents).toBeLessThanOrEqual(1_000)
    expect(out.at(-1)).toMatchObject({ listCents: 0, newDeposit: false })
    return out
  }

  it('a $60 card used for $1, past the cap: never billed less, nothing listed, and nothing retired', () => {
    // The finding: billed 90 cents, and the $59 retired as a loss on a number
    // the shopper had seen, when the $59 deposit could not be held.
    expect(ways({ usedCents: 100, leftCents: 5_900 })).toEqual([
      { billCents: null, fromDepositCents: 0, strike: false, listCents: 0, newDeposit: false, paidForCents: 6_000, lossCents: 0, theirs: true },
    ])
  })

  it('a $150 card typed whole and used for $1: the hold is the bill, with no $149 deposit to ask for', () => {
    // 10% off: the hold is $135. The finding: 90 cents billed, the rest retired.
    const p = legPriceOf({ holdCents: 13_500, boughtCents: 15_000, priceCents: 13_500, faceValueCents: 15_000 })
    const [only, ...more] = ways({ usedCents: 100, leftCents: 14_900, appliedCents: 15_000, holdCents: 13_500, priceOf: p })
    expect(more).toEqual([])
    expect(only).toMatchObject({ billCents: null, fromDepositCents: 0, listCents: 0, newDeposit: false, lossCents: 0, theirs: true })
  })

  it('past the cap with a deposit: billed whole, the price of what the plan left taken from the deposit behind it', () => {
    // A $55 card, $50 planned with $5 left behind a $5 deposit; the register took $10.
    const p = legPriceOf({ holdCents: 4_500, boughtCents: 5_000, priceCents: 4_950, faceValueCents: 5_500 })
    const out = ways({ usedCents: 1_000, leftCents: 4_500, appliedCents: 5_000, holdCents: 4_500, depositCents: 500, priceOf: p })
    // The finding listed $45 behind a new $45 deposit, released a day before it lapses.
    expect(out).toEqual([
      { billCents: null, fromDepositCents: 450, strike: false, listCents: 0, newDeposit: false, paidForCents: 5_500, lossCents: 0, theirs: true },
    ])
  })

  it('past the cap only with what the plan left: settled as planned, the old deposit behind what the plan left', () => {
    // $51 planned on the $60 card, $9 behind a $9 deposit; the register took $49: $11 left.
    const p = legPriceOf({ holdCents: 4_590, boughtCents: 5_100, priceCents: 5_400, faceValueCents: 6_000 })
    const out = ways({ usedCents: 4_900, leftCents: 1_100, appliedCents: 5_100, holdCents: 4_590, depositCents: 900, priceOf: p })
    expect(out).toEqual([
      { billCents: null, fromDepositCents: 0, strike: false, listCents: 900, newDeposit: false, paidForCents: 5_100, lossCents: 0, theirs: false },
      { billCents: null, fromDepositCents: 0, strike: false, listCents: 0, newDeposit: false, paidForCents: 5_100, lossCents: 900, theirs: false },
    ])
  })

  it('within the cap, less used is billed less behind a new deposit for all that is left; failing that, as planned', () => {
    const [read, planned, last] = ways({ usedCents: 5_500, leftCents: 500 })
    expect(read).toMatchObject({ billCents: 4_950, fromDepositCents: 0, listCents: 500, newDeposit: true, lossCents: 0 })
    // That deposit cannot be held: billed as planned. The $5 the register did
    // not take was paid for, so nothing is the seller's and nothing is lost.
    expect(planned).toMatchObject({ billCents: null, listCents: 0, paidForCents: 6_000, lossCents: 0 })
    expect(last).toMatchObject({ billCents: null, listCents: 0, lossCents: 0 })
  })

  it('within the cap, a deposit that cannot be held leaves the old one behind what the plan left', () => {
    // A $25 card at 4% off, $22 planned with $3 behind a $3 deposit; the register took $20.
    const p = legPriceOf({ holdCents: 2_112, boughtCents: 2_200, priceCents: 2_400, faceValueCents: 2_500 })
    const [read, planned, last] = ways({ usedCents: 2_000, leftCents: 500, appliedCents: 2_200, holdCents: 2_112, depositCents: 300, priceOf: p })
    expect(read).toMatchObject({ billCents: 1_920, listCents: 500, newDeposit: true })
    expect(planned).toMatchObject({ billCents: null, fromDepositCents: 0, listCents: 300, newDeposit: false, paidForCents: 2_200, lossCents: 0 })
    // Nothing can be listed at all: only the plan's own $3 is retired.
    expect(last).toMatchObject({ billCents: null, listCents: 0, paidForCents: 2_200, lossCents: 300 })
  })

  it('within the cap, a deposit that already covers what is left is enough', () => {
    const [read] = ways({ usedCents: 5_800, leftCents: 200, appliedCents: 5_900, depositCents: 300 })
    expect(read).toMatchObject({ listCents: 200, newDeposit: false })
  })

  it('more used is charged from the deposit, with a new one for what is left held first, and it counts against them', () => {
    // A $25 card at 4% off, $22 planned, $3 left behind a $3 deposit; the register took $23.
    const p = legPriceOf({ holdCents: 2_112, boughtCents: 2_200, priceCents: 2_400, faceValueCents: 2_500 })
    const [settle] = ways({ usedCents: 2_300, leftCents: 200, appliedCents: 2_200, holdCents: 2_112, depositCents: 300, priceOf: p })
    expect(settle).toMatchObject({ billCents: null, fromDepositCents: 96, strike: true, listCents: 200, newDeposit: true })
  })

  it('a total that went up on screen is charged at release, from the deposit, and is not a strike', () => {
    // A $20 card at 20% off: $16.13 bought, then $17.13 used, $2.87 left.
    const p = legPriceOf({ holdCents: 1_291, boughtCents: 1_613, priceCents: 1_600, faceValueCents: 2_000 })
    const [settle] = ways({ usedCents: 1_713, leftCents: 287, appliedCents: 1_713, holdCents: 1_291, depositCents: 387, priceOf: p })
    expect(settle).toMatchObject({ billCents: null, fromDepositCents: 80, strike: false, listCents: 287, newDeposit: true })
  })

  it('an extra under the smallest charge is not taken, and the deposit stays behind the rest', () => {
    const p = legPriceOf({ holdCents: 1_291, boughtCents: 1_613, priceCents: 1_600, faceValueCents: 2_000 })
    const [settle] = ways({ usedCents: 1_614, leftCents: 386, appliedCents: 1_614, holdCents: 1_291, depositCents: 387, priceOf: p })
    expect(settle).toMatchObject({ fromDepositCents: 1, newDeposit: false, listCents: 386 })
  })

  it('a rest under a dollar is retired as a booked loss, as the planner\'s own are', () => {
    const [settle] = ways({ usedCents: 5_950, leftCents: 50 })
    expect(settle).toMatchObject({ listCents: 0, lossCents: 50, newDeposit: false })
  })

  it('prices value up to the hold as the hold did, and value past it at the card\'s own price', () => {
    // A remainder bought with a quarter off its price: never charged the haircut back.
    const haircut = legPriceOf({ holdCents: 300, boughtCents: 500, priceCents: 4_000, faceValueCents: 5_000 })
    expect(haircut(500)).toBe(300)
    expect(haircut(250)).toBe(150)
    // A fresh card: the whole card costs what it costs bought whole.
    const fresh = legPriceOf({ holdCents: 1_291, boughtCents: 1_613, priceCents: 1_600, faceValueCents: 2_000 })
    expect(fresh(2_000)).toBe(1_600)
    expect(fresh(1_000)).toBe(800)
  })
})

describe('the keypad', () => {
  it('types from the cents up, like a register', () => {
    let c = 0
    for (const k of ['5', '2', '1', '3'] as const) c = applyKey(c, k)
    expect(c).toBe(5_213)
    expect(applyKey(52, '00')).toBe(5_200)
    expect(applyKey(5_213, 'back')).toBe(521)
    expect(applyKey(0, 'back')).toBe(0)
  })

  it('stops at its most', () => {
    expect(applyKey(KEYPAD_MAX_CENTS, '9')).toBe(KEYPAD_MAX_CENTS)
    expect(applyKey(99_999, '00')).toBe(99_999)
  })
})

describe('the till\'s words', () => {
  const plan: RoutePlan = {
    rail: 'card',
    merchant: 'target',
    totalCents: 5_213,
    legs: [
      { ref: '1', source: 'fresh', firstInLine: false, faceCents: 4_000, appliedCents: 4_000, costCents: 3_600, leftoverCents: 0, depositCents: 0, scanIndex: 1, scanOf: 2 },
      { ref: '2', source: 'fresh', firstInLine: false, faceCents: 1_600, appliedCents: 1_213, costCents: 1_190, leftoverCents: 387, depositCents: 387, scanIndex: 2, scanOf: 2 },
    ],
    costCents: 4_790,
    savingCents: 423,
    depositCents: 387,
    uncoveredCents: 0,
    preference: { mode: 'in_and_out', maxCards: 2 },
    quoteRef: 'card:target:5213',
    expiresAt: NOW.toISOString(),
  }

  it('say what the spec\'s screens say', () => {
    expect(copy.payLabel(plan)).toBe('Pay $47.90 for $52.13 · 2 cards')
    expect(copy.depositLine(plan)).toBe('$3.87 deposit · back when the next shopper uses the rest')
    expect(copy.saveLine(plan, { ready: true, label: 'card •••• 4242', spendableCents: 20_000, problem: null, checked: true })).toBe(
      'You save $4.23 · from your card •••• 4242 · held now, taken only for what you use',
    )
    expect(copy.scanTitle(1, 2)).toBe('Scan 1 of 2')
    expect(copy.coversLine({ coversCents: 4_000, leftoverCents: 0, depositCents: 0 })).toBe('covers $40.00')
    expect(copy.coversLine({ coversCents: 1_213, leftoverCents: 387, depositCents: 387 })).toBe(
      'covers $12.13 · $3.87 stays on it for the next shopper',
    )
    const r = { paidCents: 4_790, savedCents: 423, depositCents: 387, keptCents: 0 }
    expect(copy.doneLine(r)).toBe('Paid $47.90 · saved $4.23.')
    expect(copy.depositBackLine(r)).toBe('Your $3.87 deposit comes back when the next shopper uses the rest (at most 7 days).')
    expect(copy.keptBackLine(r)).toBeNull()
    expect(copy.nothingListed('Target')).toBe('Nothing at Target right now. Pay your usual way.')
  })

  it("say store credit as store credit: a plan it pays in full takes nothing from the dollars, and never says so", () => {
    // The finding: "You save $0.00 · from your dollars ($250.00)" over a plan paid wholly from store credit.
    const dollars = { ready: true, label: 'dollars ($250.00)', spendableCents: 25_000, problem: null, checked: true }
    const credit: RoutePlan = {
      ...plan,
      rail: 'stablecoin',
      legs: [{ ref: 'own:typed-1', source: 'own_credit', firstInLine: false, faceCents: 4_000, appliedCents: 3_213, costCents: 0, leftoverCents: 787, depositCents: 0, scanIndex: 1, scanOf: 1 }],
      totalCents: 3_213,
      costCents: 0,
      savingCents: 0,
      depositCents: 0,
    }
    expect(copy.saveLine(credit, dollars)).toBe('You save $0.00 · $32.13 from your store credit')
    expect(copy.costsNothing(credit)).toBe(true)
    // Part credit, part bought: both said.
    const mixed: RoutePlan = { ...plan, rail: 'stablecoin', legs: [{ ...credit.legs[0]!, appliedCents: 300, scanOf: 2 }, { ...plan.legs[1]!, scanIndex: 2 }] }
    expect(copy.saveLine(mixed, dollars)).toBe('You save $4.23 · $3.00 from your store credit · from your dollars ($250.00)')
    expect(copy.costsNothing(mixed)).toBe(false)
    expect(copy.costsNothing(null)).toBe(false)
  })

  it('say the store credit pays only in dollars, and never "nothing here" beside the price the other way has', () => {
    // The finding: the card rail never uses store credit, and "pays first next time" was false there.
    expect(copy.NOT_USED_KEPT).toBe('That card was not used. It is in your store credit now, and pays first the next time you pay with dollars.')
    expect(copy.creditDollarsOnly('Target')).toBe('Your store credit at Target pays only when you pay with dollars.')
    expect(copy.nothingThisWay('stablecoin', 'Target')).toBe('Nothing in dollars at Target right now.')
    expect(copy.nothingThisWay('card', 'Target')).toBe('Nothing by card at Target right now.')
  })

  it('say a leftover stays for the next shopper only when a deposit stands behind it', () => {
    // 37c left, too little for a deposit: it is retired, never sold again.
    expect(copy.coversLine({ coversCents: 2_713, leftoverCents: 37, depositCents: 0 })).toBe('covers $27.13')
  })

  it('promise only what Try again does: the other kind of barcode', () => {
    expect(copy.SHEET.tryAgainHint).toBe('The other kind of barcode.')
    expect(copy.SHEET.tryAgainHint).not.toMatch(/bright/i)
  })

  it('say a kept hold for what it is, and never call it paid', () => {
    expect(copy.keptLine({ cents: 1_890, until: 'next_shopper' })).toMatch(/^We keep \$18\.90 on hold for that card until the next shopper tries it\./)
    expect(copy.keptBackLine({ paidCents: 4_692, savedCents: 521, depositCents: 0, keptCents: 1_890 })).toMatch(/^\$18\.90 is still on hold/)
    expect(copy.stillOwedTitle(3_113)).toBe('The register still needs $31.13.')
    expect(copy.stillOwedLine({ paidCents: 1_890, savedCents: 210, depositCents: 0, keptCents: 0 })).toMatch(/covered \$21\.00, for \$18\.90/)
  })

  it('say what became of the card before "Pay $X more": through, not used, or did not work', () => {
    // The finding: "That card did not work" over a card that had just been charged.
    expect(copy.owedLine('scanned', null)).toBe('That card went through. The price for the rest changed.')
    expect(copy.owedLine('not_used', null)).toBe('That card was not used, so nothing was charged for it.')
    expect(copy.owedLine('failed', null)).toBe(copy.NOTHING_CHARGED)
    // A kept hold is money still held: said whatever the reason.
    expect(copy.owedLine('not_used', { cents: 1_890, until: 'next_shopper' })).toMatch(/^We keep \$18\.90 on hold/)
  })

  it('show the button the state it is in: pricing, no price, or the total still to type', () => {
    expect(copy.pricingLabel(5_213)).toBe('Pricing $52.13…')
    expect(copy.NO_PRICE).not.toBe(copy.TYPE_TOTAL)
    expect(copy.NO_PRICE).not.toMatch(/type/i)
  })

  it('never name the card processor, a camera, or typing a card number, and use no em dash', () => {
    const plain = { ...plan, depositCents: 0 }
    const lines = [
      copy.payLabel(plan),
      copy.payMoreLabel(plan),
      copy.saveLine(plan, null),
      copy.depositLine(plain) ?? '',
      copy.PAYING,
      copy.SILENCE_LINE,
      copy.NEXT,
      copy.DONE,
      copy.DIDNT_SCAN,
      copy.REGISTER_PAID,
      ...Object.values(copy.SHEET),
      copy.SOMETHING_WRONG,
      copy.SOMETHING_WRONG_HINT,
      copy.NEED_CARD,
      copy.DISPUTED,
      copy.NOT_USED_KEPT,
      copy.creditDollarsOnly('Target'),
      copy.nothingThisWay('stablecoin', 'Target'),
      copy.nothingThisWay('card', 'Target'),
      copy.otherRailLabel('card', plan),
      copy.otherRailLabel('stablecoin', null),
      copy.TYPE_TOTAL,
      copy.NO_PRICE,
      copy.pricingLabel(5_213),
      copy.PRICE_CHANGED,
      copy.USE_OTHER_CARDS,
      copy.NOTHING_CHARGED,
      copy.START_AGAIN,
      copy.RECENT_PURCHASES,
      copy.keptLine({ cents: 1_890, until: 'next_shopper' }),
      copy.DO_NOT_SCAN,
      copy.NOT_USED,
      copy.SCANNED_PRICE_CHANGED,
      copy.CHECK_AGAIN,
      copy.SHOW_LAST_PAY,
      copy.unfinishedPayLine('Target', plan),
      copy.openPurchaseLine('Target', { shown: 2, scanOf: 2 }),
      copy.SHOW_OPEN,
      copy.FINISH_OPEN_FIRST,
      copy.USE_AS_CREDIT,
      copy.TOO_LOW_CREDIT,
      copy.CREDIT_PAYS_REST,
      copy.keptBackLine({ paidCents: 0, savedCents: 0, depositCents: 0, keptCents: 1_890 }) ?? '',
      copy.stillOwedTitle(3_113),
      copy.stillOwedLine({ paidCents: 1_890, savedCents: 210, depositCents: 0, keptCents: 0 }),
      copy.alsoPaidLine({ paidCents: 0, savedCents: 0, depositCents: 0, keptCents: 0, creditPaidCents: 1_440, disputedCents: 1_600 }) ?? '',
      copy.caughtUpLine({ kept: 2, reported: 1, waiting: 0 }) ?? '',
      copy.thenLine(plan),
      copy.scannedPayMoreLabel(plan),
      copy.emptyLabel(plan.legs[1] ?? plan.legs[0]!),
      copy.problemLabel(plan.legs[0]!),
    ]
    for (const line of lines) {
      expect(line, line).not.toMatch(/stripe|camera|type (the|your) card|card number/i)
      expect(line, line).not.toContain('—')
      // The total is the register's: no line asks for another one.
      expect(line, line).not.toMatch(/try a (little|different|smaller|round)|try another|smaller amount|round amount|different amount/i)
    }
  })
})
