/**
 * The till's backends (unified-account spec 5.1; src/lib/till/client/).
 *
 * The card backend is fetches to /api/card/till/* and GET /api/account, and
 * nothing else, so it is driven here against a fake fetch that records every
 * request and answers as the routes do. Pinned:
 *
 *   - each step posts exactly what its route reads, the purchase handle
 *     passed back untouched, the shopper's setting with every plan, and Pay
 *     the price its button said and the tap's key;
 *   - "Pay $X more" names the purchase it finishes;
 *   - a new price comes back as one, with nothing held;
 *   - a refusal reaches the screen as the route's own code and sentence, and
 *     a dropped connection never says nothing was charged: it may have been;
 *     nor does a Pay answer it cannot read (a body cut off, a gateway's page,
 *     a server error with no till code), which keeps the tap's key;
 *   - how a card can pay is read from the account, never from a card id;
 *   - the dollars backend is the unwired seam, not a stub that half works.
 *
 * No server, no database, no network.
 */

import { describe, expect, it } from 'vitest'
import { NO_ANSWER, cardBackend, TillRefused } from '@/lib/till/client/card-backend'
import { keepsKey } from '@/app/pay/[store]/use-till'
import { backendFor } from '@/lib/till/client/backend'
import type { LegCode, Purchase, RoutePlan } from '@/lib/till/types'

interface Seen {
  url: string
  method: string
  body: Record<string, unknown> | null
}

/** A fetch that answers from a table, and keeps what it was asked. */
function fakeFetch(answers: Record<string, { status?: number; body: unknown } | (() => never)>) {
  const seen: Seen[] = []
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null })
    const a = answers[url]
    if (a === undefined) throw new Error(`no answer for ${url}`)
    if (typeof a === 'function') a()
    const { status = 200, body } = a as { status?: number; body: unknown }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetcher, seen }
}

const PREF = { mode: 'most_savings' as const, maxCards: 4 as const }
const plan: RoutePlan = {
  rail: 'card',
  merchant: 'target',
  totalCents: 5_213,
  legs: [],
  costCents: 4_790,
  savingCents: 423,
  depositCents: 387,
  uncoveredCents: 0,
  preference: PREF,
  quoteRef: 'card:target:5213',
  expiresAt: '2026-10-12T15:00:00.000Z',
}
const code: LegCode = {
  scanIndex: 1,
  scanOf: 2,
  coversCents: 4_000,
  leftoverCents: 0,
  depositCents: 0,
  barcode: '04112345678901234567890123',
  pdf417: null,
  expiresAt: '2026-10-12T15:01:30.000Z',
  silenceIsSale: true,
}
const purchase: Purchase = { rail: 'card', ref: 'tp1.signed', plan, code }

describe('the card backend', () => {
  it('quotes with the store, the total and the shopper\'s setting', async () => {
    const { fetcher, seen } = fakeFetch({ '/api/card/till/quote': { body: { plan } } })
    const out = await cardBackend(fetcher).quote({ merchant: 'target', totalCents: 5_213, preference: PREF })
    expect(out).toEqual(plan)
    expect(seen).toEqual([{ url: '/api/card/till/quote', method: 'POST', body: { store: 'target', totalCents: 5_213, preference: PREF } }])
  })

  it('passes a quote the server could not make through as a sentence', async () => {
    const { fetcher } = fakeFetch({ '/api/card/till/quote': { body: { unavailable: 'Nothing is listed for this store right now.' } } })
    expect(await cardBackend(fetcher).quote({ merchant: 'target', totalCents: 100, preference: PREF })).toEqual({
      unavailable: 'Nothing is listed for this store right now.',
    })
  })

  it('pays with the price its button said and the tap\'s key, and returns the purchase handle with card 1\'s code', async () => {
    const { fetcher, seen } = fakeFetch({ '/api/card/till/pay': { body: { purchase: 'tp1.signed', plan, code } } })
    expect(await cardBackend(fetcher).pay(plan, { key: 'k'.repeat(32) })).toEqual(purchase)
    expect(seen[0]?.body).toEqual({
      store: 'target',
      totalCents: 5_213,
      preference: PREF,
      quoted: { costCents: 4_790, cards: 0, depositCents: 387 },
      quoteRef: 'card:target:5213',
      key: 'k'.repeat(32),
    })
  })

  it('names the purchase "Pay $X more" finishes', async () => {
    const { fetcher, seen } = fakeFetch({ '/api/card/till/pay': { body: { purchase: 'tp1.more', plan, code } } })
    await cardBackend(fetcher).pay(plan, { after: purchase })
    expect(seen[0]?.body).toMatchObject({ after: 'tp1.signed' })
  })

  it('hands back a new price, with nothing held, when the plan now costs more than the button said', async () => {
    const dearer = { ...plan, costCents: 4_880 }
    const { fetcher } = fakeFetch({ '/api/card/till/pay': { body: { requote: dearer, message: 'The price changed. Nothing was charged.' } } })
    expect(await cardBackend(fetcher).pay(plan)).toEqual({ requote: dearer, message: 'The price changed. Nothing was charged.' })
  })

  it('asks for the next code, and for Done, with the card just scanned', async () => {
    const two = { ...code, scanIndex: 2, leftoverCents: 387 }
    const { fetcher, seen } = fakeFetch({
      '/api/card/till/next': { body: { code: two } },
      '/api/card/till/done': { body: { receipt: { paidCents: 4_790, savedCents: 423, depositCents: 387 } } },
    })
    const b = cardBackend(fetcher)
    expect(await b.next(purchase, 1)).toEqual(two)
    // An answer from before kept holds were said reads as none kept.
    expect(await b.done(purchase, 2)).toEqual({ paidCents: 4_790, savedCents: 423, depositCents: 387, keptCents: 0 })
    expect(seen.map((s) => s.body)).toEqual([
      { purchase: 'tp1.signed', scanIndex: 1 },
      { purchase: 'tp1.signed', scanIndex: 2 },
    ])
  })

  it('reports a card, and reads what is still owed, the receipt so far, and a hold kept', async () => {
    const receipt = { paidCents: 3_600, savedCents: 400, depositCents: 0, keptCents: 1_190 }
    const kept = { cents: 1_190, until: 'next_shopper' }
    const { fetcher, seen } = fakeFetch({ '/api/card/till/report': { body: { plan, owedCents: 1_213, receipt, kept, note: null } } })
    expect(await cardBackend(fetcher).report(purchase, 2, 'declined')).toEqual({ owed: plan, owedCents: 1_213, receipt, kept, note: null })
    expect(seen[0]?.body).toEqual({ purchase: 'tp1.signed', scanIndex: 2, outcome: 'declined', preference: PREF })

    const none = fakeFetch({ '/api/card/till/report': { body: { plan: null, receipt, note: 'Got it.' } } })
    expect(await cardBackend(none.fetcher).report(purchase, 2, 'empty')).toMatchObject({ owed: null, kept: null, note: 'Got it.' })
    const short = fakeFetch({ '/api/card/till/report': { body: { unavailable: 'We cannot cover $12.13 at this store right now.', owedCents: 1_213, receipt } } })
    expect((await cardBackend(short.fetcher).report(purchase, 2, 'didnt_scan')).owed).toEqual({
      unavailable: 'We cannot cover $12.13 at this store right now.',
    })
  })

  it('changes the total: the purchase\'s new handle and cards, the card on screen as it covers now, and whether it may be scanned', async () => {
    const after = { ...plan, totalCents: 5_000, legs: [] }
    const cover = { scanIndex: 1, coversCents: 4_000, leftoverCents: 0, depositCents: 0 }
    const { fetcher, seen } = fakeFetch({
      '/api/card/till/change': { body: { purchase: 'tp1.moved', plan: null, purchasePlan: after, cover, tooLow: false } },
    })
    const out = await cardBackend(fetcher).changeTotal(purchase, 5_000)
    expect(out).toEqual({ purchase: { ...purchase, ref: 'tp1.moved', plan: after }, owed: null, cover, tooLow: false, notNeeded: false })
    expect(seen[0]?.body).toEqual({ purchase: 'tp1.signed', totalCents: 5_000, preference: PREF })

    const low = fakeFetch({ '/api/card/till/change': { body: { purchase: 'tp1.moved', unavailable: 'Do not scan it.', cover, tooLow: true } } })
    expect(await cardBackend(low.fetcher).changeTotal(purchase, 100)).toMatchObject({ owed: { unavailable: 'Do not scan it.' }, tooLow: true, notNeeded: false })
    // Too low, and the cards before it already cover the total: the screen offers Done.
    const covered = fakeFetch({ '/api/card/till/change': { body: { purchase: 'tp1.moved', unavailable: 'Tap Done.', cover, tooLow: true, notNeeded: true } } })
    expect(await cardBackend(covered.fetcher).changeTotal(purchase, 100)).toMatchObject({ tooLow: true, notNeeded: true })
  })

  it('turns a refusal into the route\'s own code and sentence', async () => {
    const { fetcher } = fakeFetch({
      '/api/card/till/pay': { status: 402, body: { error: 'deposit_declined', message: 'We could not hold the $3.87 deposit on your card. Nothing was charged.' } },
    })
    const err = await cardBackend(fetcher).pay(plan).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TillRefused)
    expect(err).toMatchObject({ code: 'deposit_declined', status: 402, message: expect.stringContaining('Nothing was charged') })
  })

  it('never says nothing was charged when no answer came back: the request may have acted', async () => {
    const lost = () => {
      throw new TypeError('Failed to fetch')
    }
    const { fetcher } = fakeFetch({ '/api/card/till/next': lost, '/api/card/till/pay': lost })
    const b = cardBackend(fetcher)
    const next = await b.next(purchase, 1).catch((e: unknown) => e)
    expect(next).toMatchObject({ code: NO_ANSWER, message: 'We could not tell if that went through. Try again.' })
    const pay = await b.pay(plan, { key: 'k'.repeat(32) }).catch((e: unknown) => e)
    expect(pay).toMatchObject({ code: NO_ANSWER, message: expect.stringContaining('you will not pay twice') })
    expect(String((pay as Error).message)).not.toMatch(/nothing was charged/i)
  })

  it('a Pay answer it cannot read is no answer, never "nothing was charged": the key is kept for the same tap', async () => {
    const answer = (res: () => Response) => async (): Promise<Response> => res()
    const json = (status: number, body: unknown) => () =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    const lost = [
      // Pay held every card and opened card 1; the body was cut off on store signal.
      () => new Response('{"purchase":"tp1.signed","plan":{"rail"', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      // A gateway in front of us.
      () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
      json(504, {}),
      json(502, { error: 'bad_gateway', message: 'upstream timed out' }),
      // Our own server failed on its side: it cannot say what was held first.
      json(500, { error: 'internal_error', message: 'Something went wrong on our side. Nothing was charged.' }),
      // A 200 with no purchase in it.
      json(200, { ok: true }),
      json(200, null),
    ]
    for (const res of lost) {
      const err = await cardBackend(answer(res)).pay(plan, { key: 'k'.repeat(32) }).catch((e: unknown) => e)
      // The finding: TillRefused('failed', '... Nothing was charged.'), the key and the pending record dropped.
      expect(err).toMatchObject({ code: NO_ANSWER, message: expect.stringContaining('you will not pay twice') })
      expect(String((err as Error).message)).not.toMatch(/nothing was charged/i)
      expect(keepsKey(err)).toBe(true)
    }

    // A refusal the till sent ends the tap, server errors included when they are the till's own.
    for (const [status, error] of [[502, 'try_again'], [503, 'hold_closed'], [402, 'deposit_declined'], [409, 'closed']] as const) {
      const err = await cardBackend(answer(json(status, { error, message: 'Nothing was charged.' }))).pay(plan, { key: 'k'.repeat(32) }).catch((e: unknown) => e)
      expect(err).toMatchObject({ code: error, status })
      expect(keepsKey(err)).toBe(false)
    }

    // Next, too, says it could not tell rather than that nothing happened.
    const next = await cardBackend(answer(lost[1] as () => Response)).next(purchase, 1).catch((e: unknown) => e)
    expect(next).toMatchObject({ code: NO_ANSWER, message: 'We could not tell if that went through. Try again.' })
  })

  it('reads how a card can pay from the account: ready, what is left of the allowance, or why not', async () => {
    const ready = fakeFetch({ '/api/account': { body: { cardRail: true, card: { brand: 'visa', last4: '4242' }, cardKnown: true, heldCents: 4_000, allowanceCents: 20_000 } } })
    expect(await cardBackend(ready.fetcher).method()).toEqual({ ready: true, label: 'card •••• 4242', spendableCents: 16_000, problem: null, checked: true, setUp: true })

    const noCard = fakeFetch({ '/api/account': { body: { cardRail: true, card: null, cardKnown: true, heldCents: 0, allowanceCents: 20_000 } } })
    expect(await cardBackend(noCard.fetcher).method()).toMatchObject({ ready: false, problem: 'Save a card in Account to pay here.', setUp: false })

    const off = fakeFetch({ '/api/account': { body: { cardRail: false, card: null } } })
    expect(await cardBackend(off.fetcher).method()).toMatchObject({ ready: false, problem: 'Card payments are off here right now.' })

    // Could not be asked: says nothing either way, so the till asks again and Pay stays open.
    const down = fakeFetch({ '/api/account': { status: 500, body: {} } })
    expect(await cardBackend(down.fetcher).method()).toMatchObject({ ready: false, checked: false })
    // Not known to be set up or not: the till's rail rule (settings.ts tillRail) reads it as unknown.
    expect(await cardBackend(down.fetcher).method()).not.toHaveProperty('setUp')
    expect(await cardBackend(noCard.fetcher).method()).toMatchObject({ checked: true })
  })
})

describe('which backend pays', () => {
  it('is the card backend on the card rail, and the phone’s own escrow backend for dollars', () => {
    expect(backendFor('card').rail).toBe('card')
    // The dollars rail opens what it needs on first use: making one reads and sends nothing.
    expect(backendFor('stablecoin').rail).toBe('stablecoin')
  })
})
