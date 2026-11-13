/**
 * The till's planner (unified-account spec 6; src/lib/route/plan.ts).
 *
 * Pure, so every rule is pinned on its own, and the search is checked against
 * a brute force over every subset and every choice of part-used card:
 *
 *   - own credit first, alone when it covers the total;
 *   - cards first in line, oldest first, used whole, never part used;
 *   - at most one part-used card, its leftover never over the cap (a property
 *     over random pools), what the cards apply always the total;
 *   - "Most savings" and "In and out", and the card limit, honoured inside it;
 *   - the 50c and 1c floors; scan order; exact fit only as a tie-break; the
 *     haircut on the price and never on the value planned;
 *   - the deposit on the leftover, at face, from its floor up.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROUTE_PREFERENCE,
  MAX_TILL_CARDS,
  isNoTillPlan,
  legCostCents,
  planTill,
  routePreference,
  type FirstInLineCandidate,
  type OwnCredit,
  type PlanTillInput,
  type RoutePreference,
  type TillCandidate,
  type TillPlan,
} from '@/lib/route/plan'
import { tillScanOrder } from '@/lib/route/scan-order'
import { legCostCents as quoteLegCostCents } from '@/lib/demand/quote'

const IN_AND_OUT: RoutePreference = { mode: 'in_and_out', maxCards: 2 }
const MOST_SAVINGS: RoutePreference = { mode: 'most_savings', maxCards: 4 }

/** A card on sale: `face` dollars-in-cents at `off` percent. */
function card(ref: string, face: number, off: number, accountId = 'seller'): TillCandidate {
  return { ref, accountId, balanceCents: face, faceValueCents: face, priceCents: Math.round(face * (1 - off / 100)) }
}

/** A remainder: `left` cents still on a card listed at `face` and `off` percent. */
function remainder(ref: string, left: number, face: number, off: number, covered = true, accountId = 'seller'): FirstInLineCandidate {
  return { ...card(ref, face, off, accountId), balanceCents: left, kind: 'remainder', covered }
}

function base(over: Partial<PlanTillInput> & Pick<PlanTillInput, 'totalCents'>): PlanTillInput {
  return {
    fresh: [],
    capCents: 500,
    preference: IN_AND_OUT,
    minLegCostCents: 50,
    minDepositCents: 50,
    haircutBps: 2_500,
    ...over,
  }
}

function plan(input: PlanTillInput): TillPlan {
  const out = planTill(input)
  if (isNoTillPlan(out)) throw new Error(`expected a plan, got: ${out.reason}`)
  return out
}

const refs = (p: TillPlan) => p.legs.map((l) => l.ref)

describe('the setting', () => {
  it('defaults to in and out with two cards, which is what the shop did before', () => {
    expect(DEFAULT_ROUTE_PREFERENCE).toEqual({ mode: 'in_and_out', maxCards: 2 })
    expect(routePreference(undefined)).toEqual({ mode: 'in_and_out', maxCards: 2 })
    expect(routePreference(null)).toEqual({ mode: 'in_and_out', maxCards: 2 })
  })

  it('gives most savings four cards unless the slider says otherwise, and never more than five', () => {
    expect(routePreference({ mode: 'most_savings' })).toEqual({ mode: 'most_savings', maxCards: 4 })
    expect(routePreference({ mode: 'most_savings', maxCards: 5 })).toEqual({ mode: 'most_savings', maxCards: 5 })
    expect(routePreference({ mode: 'in_and_out', maxCards: 1 })).toEqual({ mode: 'in_and_out', maxCards: 1 })
    expect(MAX_TILL_CARDS).toBe(5)
    for (const bad of [0, 6, 2.5, '3', null, Number.NaN]) {
      expect(routePreference({ mode: 'in_and_out', maxCards: bad }).maxCards, String(bad)).toBe(2)
    }
    expect(routePreference({ mode: 'fastest', maxCards: 3 })).toEqual({ mode: 'in_and_out', maxCards: 3 })
  })
})

describe('the price of a leg', () => {
  it('is the one formula both quotes use, rounded up for the seller', () => {
    expect(quoteLegCostCents).toBe(legCostCents)
    expect(legCostCents(5_000, 4_500, 5_000)).toBe(4_500)
    expect(legCostCents(1, 3, 7)).toBe(1)
    expect(legCostCents(100, 0, 0)).toBe(100)
  })

  it('prices a remainder on its own value at the seller original discount', () => {
    // $3.87 left on a $60 card listed at 10% off.
    const p = plan(base({ totalCents: 387, firstInLine: [remainder('r', 387, 6_000, 10)] }))
    expect(p.legs).toEqual([
      expect.objectContaining({ ref: 'r', source: 'remainder', appliedCents: 387, costCents: 349, leftoverCents: 0 }),
    ])
    expect(p.legs[0]?.costCents).toBe(legCostCents(387, 5_400, 6_000))
  })
})

describe('own credit first', () => {
  const own: OwnCredit[] = [
    { ref: 'own-small', balanceCents: 500 },
    { ref: 'own-big', balanceCents: 1_300 },
  ]

  it('uses only their own cards when they cover the total, the last one part used, at no cost', () => {
    const p = plan(base({ totalCents: 1_500, own, fresh: [card('f', 5_000, 10)] }))
    expect(refs(p)).toEqual(['own-big', 'own-small'])
    expect(p.legs.map((l) => [l.source, l.appliedCents, l.leftoverCents])).toEqual([
      ['own_credit', 1_300, 0],
      ['own_credit', 200, 300],
    ])
    // Their leftover is theirs: no cap, no deposit, and nothing to pay.
    expect(p).toMatchObject({ costCents: 0, savingCents: 1_500, depositCents: 0, leftoverCents: 0 })
  })

  it('drains their own cards and closes the rest with a card on sale', () => {
    const p = plan(base({ totalCents: 2_000, own: [{ ref: 'own', balanceCents: 500 }], fresh: [card('f', 1_500, 10)] }))
    expect(p.legs.map((l) => [l.ref, l.source, l.appliedCents])).toEqual([
      ['own', 'own_credit', 500],
      ['f', 'fresh', 1_500],
    ])
    expect(p.costCents).toBe(1_350)
  })

  it('drains fewer of their own cards only when that many leaves no plan', () => {
    // Two cards at most. With their $5 drained, one card on sale must cover
    // $45, and none can within the cap; the $30 and $20 cover $50 together.
    const fresh = [card('thirty', 3_000, 10), card('twenty', 2_000, 10)]
    const p = plan(base({ totalCents: 5_000, own: [{ ref: 'own', balanceCents: 500 }], fresh }))
    expect(refs(p).sort()).toEqual(['thirty', 'twenty'])
    // With a third card allowed, their own is used again.
    const three = plan(
      base({ totalCents: 5_000, own: [{ ref: 'own', balanceCents: 500 }], fresh, preference: { mode: 'in_and_out', maxCards: 3 } }),
    )
    expect(three.legs[0]).toMatchObject({ ref: 'own', source: 'own_credit', appliedCents: 500 })
    expect(three.costCents).toBeLessThan(p.costCents)
  })

  it('is not used at all with the setting off', () => {
    const p = plan(base({ totalCents: 1_500, own, ownCreditFirst: false, fresh: [card('f', 1_500, 10)] }))
    expect(refs(p)).toEqual(['f'])
  })
})

describe('cards first in line', () => {
  it('uses a remainder whole before fresh supply, oldest first', () => {
    // Both fit, but two cards leave one place beside the closing card.
    const p = plan(
      base({
        totalCents: 2_300,
        firstInLine: [remainder('older', 300, 2_000, 10), remainder('newer', 300, 2_000, 10)],
        fresh: [card('f', 2_000, 10)],
      }),
    )
    expect(p.legs.map((l) => [l.ref, l.appliedCents, l.leftoverCents])).toEqual([
      ['older', 300, 0],
      ['f', 2_000, 0],
    ])
  })

  it('takes every one that fits when the card limit allows', () => {
    const p = plan(
      base({
        totalCents: 2_600,
        preference: { mode: 'in_and_out', maxCards: 3 },
        firstInLine: [remainder('older', 300, 2_000, 10), remainder('newer', 300, 2_000, 10)],
        fresh: [card('f', 2_000, 10)],
      }),
    )
    expect(refs(p)).toEqual(['older', 'newer', 'f'])
  })

  it('never splits a remainder, and skips one larger than what is owed', () => {
    const p = plan(base({ totalCents: 1_000, firstInLine: [remainder('big', 1_200, 5_000, 10)], fresh: [card('f', 1_000, 10)] }))
    expect(refs(p)).toEqual(['f'])
    // No fresh card at all: the remainder is not stretched into a part-used card.
    expect(isNoTillPlan(planTill(base({ totalCents: 1_000, firstInLine: [remainder('big', 1_200, 5_000, 10)] })))).toBe(true)
  })

  it('a waiting card that closes the purchase exactly may take the last place', () => {
    const p = plan(
      base({
        totalCents: 2_300,
        firstInLine: [remainder('small', 300, 2_000, 10), remainder('closer', 2_000, 5_000, 10)],
      }),
    )
    expect(p.legs.map((l) => [l.ref, l.source, l.fullyDrained])).toEqual([
      ['small', 'remainder', true],
      ['closer', 'remainder', true],
    ])
    expect(p.leftoverCents).toBe(0)
  })

  it('in and out still prefers fewer cards over using a remainder', () => {
    // One fresh card covers it; the remainder would make it two.
    const p = plan(base({ totalCents: 1_800, firstInLine: [remainder('r', 300, 2_000, 10)], fresh: [card('f', 2_000, 10)] }))
    expect(refs(p)).toEqual(['f'])
  })

  it('on a tie in card count, uses the remainder', () => {
    // Two cards either way: remainder + a fresh card, or two fresh cards.
    const p = plan(
      base({
        totalCents: 2_500,
        firstInLine: [remainder('r', 500, 2_000, 10)],
        fresh: [card('a', 2_000, 10), card('b', 500, 10)],
      }),
    )
    expect(refs(p).sort()).toEqual(['a', 'r'])
  })

  it('an unscanned card waits first in line too, whole, with no haircut', () => {
    const held: FirstInLineCandidate = { ...card('held', 2_000, 20), kind: 'unscanned', covered: true }
    const p = plan(base({ totalCents: 2_500, firstInLine: [held], fresh: [card('f', 1_000, 20)] }))
    expect(p.legs.map((l) => [l.ref, l.source, l.firstInLine, l.appliedCents, l.costCents])).toEqual([
      ['held', 'fresh', true, 2_000, 1_600],
      ['f', 'fresh', false, 500, 400],
    ])
  })

  it('an unscanned card is never the part-used card: someone else is holding money on it', () => {
    const held: FirstInLineCandidate = { ...card('held', 2_000, 20), kind: 'unscanned', covered: true }
    // Alone it cannot be split, so there is no plan.
    expect(planTill(base({ totalCents: 1_800, firstInLine: [held] }))).toMatchObject({ kind: 'no_plan' })
    // With a card on sale, that card is the one part used, and the held one waits.
    const p = plan(base({ totalCents: 1_800, firstInLine: [held], fresh: [card('f', 2_000, 20)] }))
    expect(p.legs.map((l) => [l.ref, l.firstInLine, l.appliedCents, l.leftoverCents])).toEqual([['f', false, 1_800, 200]])
  })

  it('a remainder is never the part-used card either', () => {
    const p = plan(base({ totalCents: 300, firstInLine: [remainder('r', 500, 2_000, 10)], fresh: [card('f', 500, 10)] }))
    expect(refs(p)).toEqual(['f'])
  })
})

describe('the haircut', () => {
  it('comes off the price of a remainder with nothing behind it, never off its value', () => {
    const bare = plan(base({ totalCents: 400, firstInLine: [remainder('r', 400, 2_000, 10, false)] }))
    const covered = plan(base({ totalCents: 400, firstInLine: [remainder('r', 400, 2_000, 10, true)] }))
    // Covered by a deposit: no haircut (open decision 3).
    expect(covered.legs[0]).toMatchObject({ appliedCents: 400, costCents: 360 })
    // Bare: the whole $4 is still what it covers; only the price drops 25%.
    expect(bare.legs[0]).toMatchObject({ appliedCents: 400, costCents: 270, leftoverCents: 0 })
  })

  it('so a bare remainder never grows the last card leftover', () => {
    const input = (covered: boolean) =>
      base({ totalCents: 2_300, firstInLine: [remainder('r', 400, 2_000, 10, covered)], fresh: [card('f', 2_000, 10)] })
    const bare = plan(input(false))
    const covered = plan(input(true))
    expect(bare.legs.map((l) => [l.ref, l.appliedCents, l.leftoverCents])).toEqual(
      covered.legs.map((l) => [l.ref, l.appliedCents, l.leftoverCents]),
    )
    expect(bare.costCents).toBeLessThan(covered.costCents)
  })
})

describe('the preferences', () => {
  // A $50 card at 5% off covers it alone; a $30 and a $20 at 20% off together.
  const fresh = [card('one', 5_000, 5), card('thirty', 3_000, 20), card('twenty', 2_000, 20)]

  it('in and out scans fewer cards and pays a little more', () => {
    const p = plan(base({ totalCents: 5_000, fresh, capCents: 1_000 }))
    expect(refs(p)).toEqual(['one'])
    expect(p.costCents).toBe(4_750)
  })

  it('most savings scans more cards to pay less', () => {
    const p = plan(base({ totalCents: 5_000, fresh, capCents: 1_000, preference: MOST_SAVINGS }))
    expect(refs(p).sort()).toEqual(['thirty', 'twenty'])
    expect(p.costCents).toBe(4_000)
  })

  it('most savings still keeps to the card limit', () => {
    const p = plan(base({ totalCents: 5_000, fresh, capCents: 1_000, preference: { mode: 'most_savings', maxCards: 1 } }))
    expect(refs(p)).toEqual(['one'])
  })

  it('more cards are only used when they cost less', () => {
    // Same discount everywhere: one card is as cheap as three.
    const even = [card('a', 3_000, 10), card('b', 1_000, 10), card('c', 1_000, 10), card('d', 2_000, 10)]
    const p = plan(base({ totalCents: 3_000, fresh: even, preference: MOST_SAVINGS }))
    expect(refs(p)).toEqual(['a'])
  })
})

describe('exact fit', () => {
  it('is a tie-break only: one card with a small leftover beats two that sum exactly', () => {
    const fresh = [card('twenty', 2_000, 10), card('ten', 1_000, 10), card('thirty-five', 3_500, 10)]
    for (const preference of [IN_AND_OUT, MOST_SAVINGS]) {
      const p = plan(base({ totalCents: 3_000, fresh, preference }))
      expect(refs(p), preference.mode).toEqual(['thirty-five'])
      expect(p.leftoverCents).toBe(500)
    }
  })

  it('wins when everything else ties', () => {
    const p = plan(base({ totalCents: 3_000, fresh: [card('thirty-two', 3_200, 10), card('thirty', 3_000, 10)] }))
    expect(refs(p)).toEqual(['thirty'])
    expect(p.leftoverCents).toBe(0)
  })
})

describe('leftovers', () => {
  it('never more than the cap: too much left is no plan', () => {
    const out = planTill(base({ totalCents: 2_000, fresh: [card('f', 2_600, 10)] }))
    expect(isNoTillPlan(out)).toBe(true)
    expect(plan(base({ totalCents: 2_100, fresh: [card('f', 2_600, 10)] })).leftoverCents).toBe(500)
  })

  it('avoids a leftover of 1c to 99c among plans the shopper would call equal', () => {
    // $20.50 at one price on either card: 50c left on one, $1.50 on the other.
    const fresh = [card('twenty-one', 2_100, 10), card('twenty-two', 2_200, 10)]
    for (const preference of [IN_AND_OUT, MOST_SAVINGS]) {
      const p = plan(base({ totalCents: 2_050, fresh, preference }))
      expect(refs(p), preference.mode).toEqual(['twenty-two'])
      expect(p).toMatchObject({ leftoverCents: 150, costCents: 1_845 })
    }
  })

  it('but never makes most savings pay more to avoid one', () => {
    // 50c left on a $21 card at 30% off, against two cards at 10% off.
    const fresh = [card('twenty-one', 2_100, 30), card('twenty', 2_000, 10), card('five', 500, 10)]
    const p = plan(base({ totalCents: 2_050, fresh, preference: MOST_SAVINGS }))
    expect(refs(p)).toEqual(['twenty-one'])
    expect(p).toMatchObject({ leftoverCents: 50, costCents: 1_435 })
  })

  it('keeps one when nothing else covers the total', () => {
    const p = plan(base({ totalCents: 2_050, fresh: [card('twenty-one', 2_100, 10)] }))
    expect(p.leftoverCents).toBe(50)
  })

  it('a part-used card with more on it is left part used, so the smaller cards are the ones used up', () => {
    // $30 and $25 at Target for $50: either could be part used, at one price.
    const p = plan(base({ totalCents: 5_000, fresh: [card('thirty', 3_000, 10), card('twenty-five', 2_500, 10)] }))
    expect(p.legs.map((l) => [l.ref, l.appliedCents, l.leftoverCents])).toEqual([
      ['twenty-five', 2_500, 0],
      ['thirty', 2_500, 500],
    ])
  })
})

describe('the deposit', () => {
  it('is the leftover at face, on the part-used card only', () => {
    const p = plan(base({ totalCents: 4_790, fresh: [card('a', 4_000, 10), card('b', 1_200, 10)] }))
    const partial = p.legs.find((l) => !l.fullyDrained)
    expect(partial).toMatchObject({ leftoverCents: 410, depositCents: 410 })
    expect(p.legs.filter((l) => l.fullyDrained).every((l) => l.depositCents === 0)).toBe(true)
    expect(p.depositCents).toBe(410)
  })

  it('is not taken on a leftover under its floor', () => {
    const p = plan(base({ totalCents: 2_060, fresh: [card('f', 2_100, 10)] }))
    expect(p).toMatchObject({ leftoverCents: 40, depositCents: 0 })
    expect(plan(base({ totalCents: 2_060, minDepositCents: 1, fresh: [card('f', 2_100, 10)] })).depositCents).toBe(40)
  })
})

describe('the floors', () => {
  it('refuses a card priced under 50c on the card rail, and allows it at 1c on dollars', () => {
    // $20.30 from a $20 card and a 40c one: whichever is part used, one of
    // them costs under 50c (36c for the 40c card used up, 27c for 30c of it).
    const fresh = [card('twenty', 2_000, 10), card('forty-cents', 40, 10)]
    expect(isNoTillPlan(planTill(base({ totalCents: 2_030, fresh })))).toBe(true)
    const dollars = plan(base({ totalCents: 2_030, fresh, minLegCostCents: 1 }))
    expect(dollars.legs.map((l) => [l.ref, l.appliedCents, l.costCents])).toEqual([
      ['forty-cents', 40, 36],
      ['twenty', 1_990, 1_791],
    ])
  })

  it('finds another plan rather than refuse when the cheap card can be avoided', () => {
    const fresh = [card('twenty', 2_000, 10), card('forty-cents', 40, 10), card('twenty-one', 2_100, 10)]
    const p = plan(base({ totalCents: 2_030, fresh }))
    expect(refs(p)).toEqual(['twenty-one'])
  })

  it('a remainder priced under the floor is left for someone else', () => {
    const p = plan(base({ totalCents: 1_040, firstInLine: [remainder('r', 40, 2_000, 10)], fresh: [card('f', 1_100, 10)] }))
    expect(refs(p)).toEqual(['f'])
  })
})

describe('shoppers and sellers with a record', () => {
  it('a barred shopper gets no remainders and no part-used last card', () => {
    const input = base({
      totalCents: 2_300,
      buyerBarred: true,
      firstInLine: [remainder('r', 300, 2_000, 10)],
      fresh: [card('twenty', 2_000, 10), card('twenty-four', 2_400, 10), card('three', 300, 10)],
    })
    const p = plan(input)
    expect(refs(p).sort()).toEqual(['three', 'twenty'])
    expect(p.leftoverCents).toBe(0)
    expect(isNoTillPlan(planTill({ ...input, fresh: [card('twenty-four', 2_400, 10)] }))).toBe(true)
  })

  it('a demoted seller is used whole only: never part used, and no remainder of theirs', () => {
    const p = plan(
      base({
        totalCents: 2_000,
        demotedAccountIds: ['shady'],
        firstInLine: [remainder('theirs', 300, 2_000, 10, true, 'shady')],
        fresh: [card('shady-card', 2_400, 10, 'shady'), card('honest', 2_200, 10, 'honest')],
      }),
    )
    expect(refs(p)).toEqual(['honest'])
  })
})

describe('scan order', () => {
  it('own, remainders, fresh, and the part-used card last', () => {
    const p = plan(
      base({
        totalCents: 4_000,
        preference: { mode: 'most_savings', maxCards: 5 },
        own: [{ ref: 'own', balanceCents: 500 }],
        // Bare, so its haircut makes the plan that uses it the cheapest.
        firstInLine: [remainder('r', 400, 2_000, 10, false)],
        fresh: [card('fresh-whole', 1_000, 10), card('fresh-part', 2_500, 10)],
      }),
    )
    expect(p.legs.map((l) => [l.ref, l.source, l.fullyDrained, l.scanIndex, l.scanOf])).toEqual([
      ['own', 'own_credit', true, 1, 4],
      ['r', 'remainder', true, 2, 4],
      ['fresh-whole', 'fresh', true, 3, 4],
      ['fresh-part', 'fresh', false, 4, 4],
    ])
  })

  it('keeps the old rule for legs with no source', () => {
    const legs = [
      { id: 'part', fullyDrained: false },
      { id: 'a', fullyDrained: true },
      { id: 'b', fullyDrained: true },
    ]
    expect(tillScanOrder(legs).map((l) => l.id)).toEqual(['a', 'b', 'part'])
    expect(legs.map((l) => l.id)).toEqual(['part', 'a', 'b'])
  })
})

describe('no plan', () => {
  it('says the supply is short, in the words the shop turns into a sentence', () => {
    const out = planTill(base({ totalCents: 10_000, fresh: [card('f', 2_000, 10)] }))
    expect(out).toEqual({ kind: 'no_plan', reason: 'available balance 2000c is short of 10000c' })
  })

  it('never covers part of the total and leaves the rest to the shopper', () => {
    // Two $20 cards, $50 owed: no "then $10 your usual way".
    const out = planTill(base({ totalCents: 5_000, fresh: [card('a', 2_000, 10), card('b', 2_000, 10)] }))
    expect(isNoTillPlan(out)).toBe(true)
  })

  it('refuses a total that is not a positive whole number of cents', () => {
    for (const total of [0, -5, 1.5, Number.NaN]) {
      expect(isNoTillPlan(planTill(base({ totalCents: total, fresh: [card('f', 2_000, 10)] }))), String(total)).toBe(true)
    }
  })
})

// ===========================================================================
// The search against a brute force, and the rules as a property
// ===========================================================================

/** A seeded generator, so a failure names a case that can be run again. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface OracleScore {
  awkward: number
  cost: number
  cards: number
  leftover: number
}

/**
 * Every subset of the fresh cards and every choice of part-used card, scored
 * by the spec's words, independently of the planner's own code.
 */
function oracle(input: PlanTillInput): OracleScore | null {
  const cards = input.fresh
  const n = cards.length
  let best: OracleScore | null = null
  const keys = (s: OracleScore) =>
    input.preference.mode === 'most_savings'
      ? [s.cost, s.cards, s.awkward, s.leftover]
      : [s.cards, s.cost, s.awkward, s.leftover]
  const less = (a: OracleScore, b: OracleScore) => {
    const ka = keys(a)
    const kb = keys(b)
    for (let i = 0; i < ka.length; i++) if ((ka[i] ?? 0) !== (kb[i] ?? 0)) return (ka[i] ?? 0) < (kb[i] ?? 0)
    return false
  }
  for (let mask = 1; mask < 1 << n; mask++) {
    const set = cards.filter((_, i) => mask & (1 << i))
    if (set.length > input.preference.maxCards) continue
    const covered = set.reduce((s, c) => s + c.balanceCents, 0)
    const leftover = covered - input.totalCents
    if (leftover < 0 || leftover > input.capCents) continue
    const partials = leftover === 0 ? [null] : set.filter((c) => c.balanceCents > leftover)
    for (const partial of partials) {
      const costs = set.map((c) =>
        legCostCents(c === partial ? c.balanceCents - leftover : c.balanceCents, c.priceCents, c.faceValueCents),
      )
      if (costs.some((x) => x < input.minLegCostCents)) continue
      const cost = costs.reduce((s, x) => s + x, 0)
      if (cost >= input.totalCents) continue
      const s = { awkward: leftover >= 1 && leftover <= 99 ? 1 : 0, cost, cards: set.length, leftover }
      if (!best || less(s, best)) best = s
    }
  }
  return best
}

function randomFresh(r: () => number, count: number): TillCandidate[] {
  return Array.from({ length: count }, (_, i) => {
    const face = 100 * (1 + Math.floor(r() * 60)) + (r() < 0.3 ? Math.floor(r() * 100) : 0)
    return card(`c${i}`, face, 1 + Math.floor(r() * 30), `s${Math.floor(r() * 3)}`)
  })
}

describe('the search, against a brute force', () => {
  it('finds the best plan the spec describes, for both settings, over random pools', () => {
    const r = rng(20261012)
    let compared = 0
    for (let run = 0; run < 400; run++) {
      const fresh = randomFresh(r, 1 + Math.floor(r() * 7))
      const totalCents = 100 + Math.floor(r() * 9_000)
      const preference: RoutePreference = {
        mode: r() < 0.5 ? 'most_savings' : 'in_and_out',
        maxCards: (1 + Math.floor(r() * 5)) as RoutePreference['maxCards'],
      }
      const input = base({ totalCents, fresh, preference, capCents: r() < 0.5 ? 500 : 1_000 })
      const want = oracle(input)
      const got = planTill(input)
      if (want === null) {
        expect(isNoTillPlan(got), `run ${run}: the brute force found no plan`).toBe(true)
        continue
      }
      if (isNoTillPlan(got)) throw new Error(`run ${run}: no plan, but the brute force found ${JSON.stringify(want)}`)
      compared += 1
      expect(
        {
          awkward: got.leftoverCents >= 1 && got.leftoverCents <= 99 ? 1 : 0,
          cost: got.costCents,
          cards: got.legs.length,
          leftover: got.leftoverCents,
        },
        `run ${run}`,
      ).toEqual(want)
    }
    // Enough of the runs had a plan for this to mean something.
    expect(compared).toBeGreaterThan(100)
  })
})

describe('the rules, as a property', () => {
  it('holds for random pools with own credit, remainders, held cards and every setting', () => {
    const r = rng(7)
    let planned = 0
    for (let run = 0; run < 1_500; run++) {
      const fresh = randomFresh(r, Math.floor(r() * 9))
      const firstInLine: FirstInLineCandidate[] = Array.from({ length: Math.floor(r() * 4) }, (_, i) =>
        r() < 0.7
          ? remainder(`r${i}`, 50 + Math.floor(r() * 950), 5_000, 1 + Math.floor(r() * 20), r() < 0.6, `s${i % 3}`)
          : { ...card(`h${i}`, 500 + Math.floor(r() * 4_000), 15), kind: 'unscanned' as const, covered: true },
      )
      const own: OwnCredit[] = r() < 0.2 ? [{ ref: 'own', balanceCents: 100 + Math.floor(r() * 3_000) }] : []
      const capCents = [0, 500, 1_000][Math.floor(r() * 3)] ?? 500
      const minLegCostCents = r() < 0.5 ? 50 : 1
      const preference: RoutePreference = {
        mode: r() < 0.5 ? 'most_savings' : 'in_and_out',
        maxCards: (1 + Math.floor(r() * 5)) as RoutePreference['maxCards'],
      }
      const input = base({
        totalCents: 50 + Math.floor(r() * 8_000),
        fresh,
        firstInLine,
        own,
        capCents,
        minLegCostCents,
        minDepositCents: minLegCostCents,
        preference,
        buyerBarred: r() < 0.1,
        demotedAccountIds: r() < 0.2 ? ['s1'] : [],
      })
      const p = planTill(input)
      if (isNoTillPlan(p)) continue
      planned += 1
      const where = `run ${run}`
      const market = p.legs.filter((l) => l.source !== 'own_credit')
      const partials = market.filter((l) => l.leftoverCents > 0)

      // What the cards apply is always exactly the total.
      expect(p.legs.reduce((s, l) => s + l.appliedCents, 0), where).toBe(input.totalCents)
      // Within the card limit, each card once.
      expect(p.legs.length, where).toBeLessThanOrEqual(preference.maxCards)
      expect(new Set(p.legs.map((l) => l.ref)).size, where).toBe(p.legs.length)
      // At most one part-used card on sale, and never over the cap.
      expect(partials.length, where).toBeLessThanOrEqual(1)
      expect(p.leftoverCents, where).toBeLessThanOrEqual(input.buyerBarred ? 0 : capCents)
      for (const l of p.legs) {
        expect(l.appliedCents, where).toBeGreaterThan(0)
        expect(l.appliedCents + l.leftoverCents, where).toBe(l.faceCents)
      }
      // Every card someone pays for clears the floor; their own costs nothing.
      for (const l of market) expect(l.costCents, where).toBeGreaterThanOrEqual(minLegCostCents)
      for (const l of p.legs.filter((x) => x.source === 'own_credit')) expect(l.costCents, where).toBe(0)
      // A remainder is used whole, and only for a shopper who is not barred.
      for (const l of p.legs.filter((x) => x.source === 'remainder')) {
        expect(l.fullyDrained, where).toBe(true)
        expect(input.buyerBarred, where).toBe(false)
      }
      // A demoted seller is never left part used.
      const sellerOf = new Map([...fresh, ...firstInLine].map((c) => [c.ref, c.accountId]))
      for (const l of partials) {
        expect(input.demotedAccountIds ?? [], where).not.toContain(sellerOf.get(l.ref))
      }
      // The part-used card is scanned last.
      const firstPart = p.legs.findIndex((l) => !l.fullyDrained)
      if (firstPart !== -1) {
        expect(p.legs.slice(firstPart + 1).some((l) => l.fullyDrained), where).toBe(false)
      }
      expect(p.legs.map((l) => l.scanIndex), where).toEqual(p.legs.map((_, i) => i + 1))
      // The deposit is the leftover at face, from its floor up.
      for (const l of market) {
        expect(l.depositCents, where).toBe(l.leftoverCents >= input.minDepositCents && l.leftoverCents > 0 ? l.leftoverCents : 0)
      }
      // A saving, always.
      expect(p.costCents, where).toBeLessThan(input.totalCents)
      expect(p.savingCents, where).toBe(input.totalCents - p.costCents)
    }
    expect(planned).toBeGreaterThan(300)
  })
})
