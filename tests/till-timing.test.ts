/**
 * The till's timer and the answers it runs against offline
 * (src/lib/till/timing.ts, scripts/till-fixtures.ts, scripts/till-timing.ts).
 *
 * Pinned:
 *   - the timer drives the till the way a shopper does: quote, pay, Next
 *     once per card after the first, Done on the last, and times each step
 *     on the clock it is given;
 *   - no plan is reported, not timed;
 *   - the fixture answers the audit and the offline timer use are ones the
 *     real card backend accepts, and their money adds up the way the
 *     planner prices it, so a screenshot never shows a sum the server
 *     would not make;
 *   - a tap that comes before the prepare is done (--tap-after-ms) waits for
 *     it inside the tap, as the till's does;
 *   - the script is offline unless told --live, never prints the cookie, and
 *     prints each run's tap step by step in the order the till marks them;
 *   - the till prints the same steps to the console only when this browser
 *     asks for them, each a name and milliseconds, nothing else.
 *
 * No server, no network.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BLIND_RESIDUAL_CAP_CENTS } from '@/lib/barcode/reveal'
import { legCostCents } from '@/lib/route/plan'
import { cardBackend } from '@/lib/till/client/card-backend'
import { markRender, tapMarks } from '@/lib/till/client/tap-marks'
import { summarize, TAP_STEPS, timeTillPurchase } from '@/lib/till/timing'
import type { LegCode, Purchase, RoutePlan, TillBackend } from '@/lib/till/types'
import {
  TILL_FIXTURE_PURCHASE,
  TILL_FIXTURE_STORE,
  TILL_FIXTURE_TOTAL_CENTS,
  TILL_FIXTURE_TOTAL_DOWN_CENTS,
  TILL_FIXTURE_TOTAL_UP_CENTS,
  tillAccountView,
  tillAddPlan,
  tillCode,
  tillOwedPlan,
  tillPlan,
  tillRouteAnswer,
} from '../scripts/till-fixtures'

const PREF = { mode: 'in_and_out' as const, maxCards: 2 as const }

/** A backend that answers from the fixture and advances a fake clock by a set time per step. */
function steppedBackend(costs: Record<string, number>, clock: { t: number }, calls: string[]): TillBackend {
  const plan = tillPlan()
  const step = async <T>(name: string, v: T): Promise<T> => {
    calls.push(name)
    clock.t += costs[name] ?? 0
    return v
  }
  const purchase: Purchase = { rail: 'card', ref: 'p', plan, code: tillCode(1, null) }
  return {
    rail: 'card',
    method: () => step('method', { ready: true, label: 'card', spendableCents: 20_000, problem: null, checked: true }),
    quote: () => step('quote', plan),
    prepare: () => step('prepare', undefined),
    pay: () => step('pay', purchase),
    next: (_p, i) => step(`next:${i}`, tillCode(2, null) as LegCode),
    done: (_p, i) => step(`done:${i}`, { paidCents: plan.costCents, savedCents: plan.savingCents, depositCents: plan.depositCents, keptCents: 0 }),
    report: () => step('report', { owed: null, owedCents: 0, receipt: { paidCents: 0, savedCents: 0, depositCents: 0, keptCents: 0 }, kept: null, note: null }),
    changeTotal: (p) => step('change', { purchase: p, owed: null, cover: null, tooLow: false, notNeeded: false }),
    receipt: () => step('receipt', { paidCents: plan.costCents, savedCents: plan.savingCents, depositCents: plan.depositCents, keptCents: 0 }),
  }
}

/** The fixture's answers, as the routes would send them, through a fetch. */
function fixtureFetch(seen: string[]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push(url)
    if (url === '/api/account') return Response.json(tillAccountView())
    const step = /^\/api\/card\/till\/([a-z]+)$/.exec(url)?.[1] ?? ''
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    const got = tillRouteAnswer(step, body, () => null)
    if (got === null) return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json(got.body, { status: got.status })
  }
}

describe('the timer', () => {
  it('quotes, pays, taps Next through every card and Done on the last, timing each', async () => {
    const clock = { t: 0 }
    const calls: string[] = []
    const backend = steppedBackend({ quote: 120, prepare: 5, pay: 1_400, 'next:1': 300, 'done:2': 80 }, clock, calls)
    const out = await timeTillPurchase(backend, { merchant: 'target', totalCents: 5_213, preference: PREF }, () => clock.t)
    expect(calls).toEqual(['quote', 'prepare', 'pay', 'next:1', 'done:2'])
    // Prepare runs while the shopper types, so the tap is pay alone; the first code is drawn after it.
    expect(out).toEqual({ quoteMs: 120, prepareMs: 5, payMs: 1_400, renderMs: 0, nextMs: [300], doneMs: 80, cards: 2, costCents: 4_692, depositCents: 387 })
    const drawn: number[] = []
    const timed = await timeTillPurchase(backend, { merchant: 'target', totalCents: 5_213, preference: PREF }, () => clock.t, (code) => {
      drawn.push(code.scanIndex)
      clock.t += 12
    })
    expect(drawn).toEqual([1])
    expect(timed).toMatchObject({ payMs: 1_400, renderMs: 12 })
  })

  it('a tap before the prepare is done asks for it again as the tap, and its wait is inside the tap', async () => {
    const clock = { t: 0 }
    const calls: string[] = []
    const backend = steppedBackend({ quote: 120, pay: 1_400, 'next:1': 300, 'done:2': 80 }, clock, calls)
    let finish: () => void = () => undefined
    const keypads = new Promise<void>((r) => {
      finish = r
    })
    backend.prepare = (_plan, opts) => {
      calls.push(opts?.tap === true ? 'prepare:tap' : 'prepare')
      if (opts?.tap !== true) return keypads
      // The tickets come 0.93 s after the tap, as measured on 2026-10-14.
      clock.t += 930
      finish()
      return Promise.resolve()
    }
    const out = await timeTillPurchase(backend, { merchant: 'target', totalCents: 5_213, preference: PREF }, () => clock.t, undefined, {
      afterMs: 1_470,
      pause: async (ms) => {
        clock.t += ms
      },
    })
    expect(calls).toEqual(['quote', 'prepare', 'prepare:tap', 'pay', 'next:1', 'done:2'])
    expect(out).toMatchObject({ prepareMs: 2_400, payMs: 2_330 })
  })

  it('reports no plan rather than timing one', async () => {
    const clock = { t: 0 }
    const backend: TillBackend = { ...steppedBackend({}, clock, []), quote: async () => ({ unavailable: 'Nothing is listed for this store right now.' }) }
    expect(await timeTillPurchase(backend, { merchant: 'target', totalCents: 5_213, preference: PREF }, () => clock.t)).toEqual({
      unavailable: 'Nothing is listed for this store right now.',
    })
  })

  it('summarises with the median', () => {
    expect(summarize([])).toBeNull()
    expect(summarize([30, 10, 20])).toEqual({ median: 20, min: 10, max: 30, n: 3 })
    expect(summarize([40, 10, 20, 30])).toEqual({ median: 25, min: 10, max: 40, n: 4 })
  })
})

describe('the fixture answers', () => {
  it('are accepted by the real card backend, step by step', async () => {
    const seen: string[] = []
    const backend = cardBackend(fixtureFetch(seen))
    expect(await backend.method()).toEqual({ ready: true, label: 'card •••• 4242', spendableCents: 20_000, problem: null, checked: true, setUp: true })
    const plan = await backend.quote({ merchant: TILL_FIXTURE_STORE, totalCents: TILL_FIXTURE_TOTAL_CENTS, preference: PREF })
    expect('unavailable' in plan).toBe(false)
    const paid = await backend.pay(plan as RoutePlan)
    if ('requote' in paid || 'ended' in paid) throw new Error('the fixture never changes its price')
    const p = paid
    expect(p.ref).toBe(TILL_FIXTURE_PURCHASE)
    expect(p.code.scanIndex).toBe(1)
    const second = await backend.next(p, 1)
    expect([second.scanIndex, second.scanOf, second.leftoverCents]).toEqual([2, 2, 387])
    expect(await backend.done(p, 2)).toEqual({ paidCents: 4_692, savedCents: 521, depositCents: 387, keptCents: 0 })
    const failed = await backend.report(p, 1, 'declined')
    expect(failed.owed).toEqual(expect.objectContaining({ costCents: 4_692, legs: [expect.objectContaining({ scanOf: 1 })] }))
    // At Target the card that did not work keeps its hold, and the answer says so.
    expect(failed.kept).toEqual({ cents: 1_890, until: 'next_shopper' })
    expect(failed.receipt.keptCents).toBe(1_890)
    expect(await backend.report(p, 1, 'empty')).toMatchObject({ owed: null, note: expect.stringContaining('released') })
    expect((await backend.changeTotal(p, 5_000)).owed).toBeNull()
    expect(await backend.changeTotal(p, TILL_FIXTURE_TOTAL_UP_CENTS)).toMatchObject({ owed: { totalCents: 3_413 }, tooLow: false })
    expect(await backend.changeTotal(p, TILL_FIXTURE_TOTAL_DOWN_CENTS)).toMatchObject({ owed: { unavailable: expect.any(String) }, tooLow: true })
    const more = await backend.pay(failed.owed as RoutePlan, { after: p })
    if ('requote' in more || 'ended' in more) throw new Error('the fixture never changes its price')
    expect([more.ref, more.code.scanOf]).toEqual([`${TILL_FIXTURE_PURCHASE}-2`, 1])
    expect(seen.every((u) => u === '/api/account' || u.startsWith('/api/card/till/'))).toBe(true)
  })

  it('add up the way the planner prices a purchase', () => {
    for (const plan of [tillPlan(), tillOwedPlan(), tillAddPlan()]) {
      const legs = plan.legs
      expect(legs.reduce((n, l) => n + l.appliedCents, 0)).toBe(plan.totalCents)
      expect(legs.reduce((n, l) => n + l.costCents, 0)).toBe(plan.costCents)
      expect(plan.savingCents).toBe(plan.totalCents - plan.costCents)
      expect(plan.depositCents).toBe(legs.reduce((n, l) => n + l.depositCents, 0))
      expect(plan.uncoveredCents).toBe(0)
      // At most one card part used, the last, its leftover inside Target's cap and deposited at face
      // when it is a dollar or more; less than that is never sold again, so it gets none.
      const partial = legs.filter((l) => l.leftoverCents > 0)
      expect(partial.length).toBeLessThanOrEqual(1)
      for (const l of partial) {
        expect(l.scanIndex).toBe(l.scanOf)
        expect(l.leftoverCents).toBeLessThanOrEqual(DEFAULT_BLIND_RESIDUAL_CAP_CENTS)
        expect(l.depositCents).toBe(l.leftoverCents >= 100 ? l.leftoverCents : 0)
        expect(l.faceCents).toBe(l.appliedCents + l.leftoverCents)
      }
      legs.forEach((l, i) => expect([l.scanIndex, l.scanOf]).toEqual([i + 1, legs.length]))
    }
    // Every card at 10% off its face, priced by the planner's own formula.
    const [remainder, fresh] = tillPlan().legs
    expect(remainder?.costCents).toBe(legCostCents(2_100, 3_150, 3_500))
    expect(fresh?.costCents).toBe(legCostCents(3_113, 3_150, 3_500))
    expect(tillOwedPlan().legs[0]?.costCents).toBe(legCostCents(5_213, 4_950, 5_500))
    expect(tillAddPlan().legs[0]?.costCents).toBe(legCostCents(3_413, 3_150, 3_500))
    // The remainder waits first in line and is used whole.
    expect(remainder).toEqual(expect.objectContaining({ source: 'remainder', firstInLine: true, leftoverCents: 0 }))
  })
})

describe('scripts/till-timing.ts', () => {
  const text = readFileSync(resolve(process.cwd(), 'scripts/till-timing.ts'), 'utf8')

  it('is offline unless told --live', () => {
    expect(text).toMatch(/const live = ARGS\.flags\.has\('live'\)/)
    expect(text).toMatch(/fetcher = offlineFetch\(rttMs\)/)
    // The dollars rail has no live mode: a live tap is signed by a key only the shopper's phone holds.
    expect(text).toMatch(/if \(live && rail !== 'card'\) throw new TimingAbort/)
    // The one call that can leave this process is the live fetch.
    expect(text.match(/\bfetch\(/g)?.length).toBe(1)
    expect(text).toMatch(/return fetch\(new URL\(input, base\)/)
  })

  it("prints each run's tap step by step, in the order the till marks them", () => {
    expect(TAP_STEPS).toEqual(['prepare', 'ticket_wait', 'reads', 'sign', 'send', 'included', 'second_host', 'release', 'render'])
    expect(text).toMatch(/const STEPS: readonly TapStep\[\] = TAP_STEPS/)
    expect(text).toMatch(/say\(`  the tap        : \$\{breakdown\(steps\)\}`\)/)
    // A release asks the route's own check first, so a host behind (--behind) shows the route's wait.
    expect(text).toMatch(/t\.server\.routeChecks = true/)
    expect(text).toMatch(/if \(behind\) hostBehind\(t\)/)
  })

  it('reads the cookie by the key-file rule and never prints it', () => {
    expect(text).toMatch(/readSecretFile\(cookieFile, REPO_ROOTS, '--cookie-file'\)/)
    // The value goes to one place, the live fetch's header, and is never put in a sentence.
    expect(text).toMatch(/fetcher = liveFetch\(base, cookie\)/)
    expect(text).toMatch(/headers\.set\('Cookie', cookie\)/)
    expect(text.match(/[(,]\s*cookie\s*[,)]/g)?.length).toBe(2)
    expect(text).not.toMatch(/\$\{cookie\}|say\(cookie/)
    // Everything printed goes through say().
    expect(text.match(/console\.\w+\(/g)?.length).toBe(1)
  })
})

describe("the till's console marks", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
    else Object.defineProperty(globalThis, 'localStorage', saved)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const setting = (value: string | null): void => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => (k === 'salvo:till-timing' ? value : null) } })
  }

  it('print nothing unless this browser asks, and then only each step and its milliseconds', () => {
    setting(null)
    expect(tapMarks()).toBeUndefined()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked')
      },
    })
    expect(tapMarks()).toBeUndefined()
    setting('1')
    const lines: string[] = []
    vi.spyOn(console, 'info').mockImplementation((line: string) => {
      lines.push(line)
    })
    const mark = tapMarks()
    mark?.('ticket_wait', 520.4)
    mark?.('second_host', 461)
    expect(lines).toEqual(['[till timing] ticket wait 520 ms', '[till timing] second host 461 ms'])
    // The render, from the code in hand to the frame after it is painted.
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => {
      f()
      return 0
    })
    markRender(performance.now())
    expect(lines[2]).toMatch(/^\[till timing\] render \d+ ms$/)
  })
})
