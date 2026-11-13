/**
 * The till's quote: live supply read and handed to the planner
 * (unified-account spec 6.3; src/lib/demand/till-quote.ts).
 *
 * What the database decides, pinned here: which rows are on sale, which wait
 * first in line and in what order, what each is planned at and priced at,
 * the store's cap, and the shopper's setting carried through the shop's own
 * quote. The planner's rules themselves are tests/route-plan.test.ts.
 *
 * Rows are seeded straight into the table: nothing here opens a card, so no
 * vault and no Stripe are involved.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { TillQuoteRequest } from '@/lib/demand/till-quote'

const { prisma } = await import('@/lib/db')
const { quoteTill, CARD_MIN_CHARGE_CENTS, capForMerchant } = await import('@/lib/demand/till-quote')
const { isNoQuote } = await import('@/lib/demand/quote')
const { quoteSpend } = await import('@/lib/demand/one-screen')
const { STRIPE_MIN_CHARGE_CENTS } = await import('@/lib/hold/ref')
const { ESCROW_INTENT_FORM_FACTOR } = await import('@/lib/escrow/refs')
const { resetDb, setEnv } = await import('./helpers')

const DAY_MS = 24 * 3600_000
const ORIGINAL = { BM_INFERENCE_HAIRCUT_BPS: process.env.BM_INFERENCE_HAIRCUT_BPS }

beforeEach(async () => {
  await resetDb()
  setEnv({ BM_INFERENCE_HAIRCUT_BPS: undefined })
})

afterAll(async () => {
  setEnv(ORIGINAL)
  await resetDb()
  await prisma.$disconnect()
})

let seq = 0

/** One listing, offered, at `off` percent: `face` cents of card for `face * (1 - off)`. */
async function seed(over: {
  face: number
  off?: number
  merchantId?: string
  lastKnownBalanceCents?: number | null
  failureReason?: string | null
  lastCheckedAt?: Date | null
  formFactor?: string
  accountId?: string
  expiresAt?: Date
}): Promise<string> {
  seq += 1
  const off = over.off ?? 10
  const row = await prisma.intent.create({
    data: {
      id: `int_tq${seq}`,
      state: 'offered',
      merchantId: over.merchantId ?? 'target',
      accountId: over.accountId ?? 'operator',
      formFactor: over.formFactor ?? 'in_store_barcode',
      faceValueCents: over.face,
      priceCents: Math.round(over.face * (1 - off / 100)),
      discountBps: off * 100,
      expiresAt: over.expiresAt ?? new Date(Date.now() + 3 * DAY_MS),
      last4: String(1000 + seq).slice(-4),
      sealedRef: {},
      failureReason: over.failureReason ?? null,
      lastKnownBalanceCents: over.lastKnownBalanceCents ?? null,
      lastCheckedAt: over.lastCheckedAt ?? null,
    },
  })
  return row.id
}

/** A bought order made at `createdAt`: the purchase a marker names. */
async function orderAt(createdAt: Date): Promise<string> {
  seq += 1
  const row = await prisma.order.create({
    data: {
      buyerEmail: 'first@example.com',
      kind: 'gift_card',
      merchantId: 'bestbuy',
      deadlineAt: new Date(Date.now() + DAY_MS),
      qty: 1,
      priceCents: 1_000,
      rail: 'stripe',
      paymentRef: `cs_tq_${seq}`,
      state: 'fulfilled',
      createdAt,
    },
  })
  return row.id
}

async function quote(totalCents: number, extra: Partial<TillQuoteRequest> = {}) {
  const out = await quoteTill('card', { merchantId: 'target', totalCents, ...extra })
  if (isNoQuote(out)) throw new Error(`expected a quote, got: ${out.reason}`)
  return out
}

describe('the floor and the cap', () => {
  it('restates the card charge floor exactly', () => {
    expect(CARD_MIN_CHARGE_CENTS).toBe(STRIPE_MIN_CHARGE_CENTS)
  })

  it('uses the cap the reveal enforces: $5 where nobody can read the balance, $10 where we can', async () => {
    expect(capForMerchant('target')).toBe(500)
    expect(capForMerchant('bestbuy')).toBe(1_000)
    await seed({ face: 2_700 })
    await seed({ face: 2_700, merchantId: 'bestbuy' })
    // $20 on a $27 card leaves $7: over Target's cap, inside Best Buy's.
    expect(isNoQuote(await quoteTill('card', { merchantId: 'target', totalCents: 2_000 }))).toBe(true)
    const bestbuy = await quoteTill('card', { merchantId: 'bestbuy', totalCents: 2_000 })
    expect(bestbuy).toMatchObject({ kind: 'quote', residualCents: 700, depositCents: 700 })
  })
})

describe('the deposit', () => {
  it('is quoted only for a leftover that can be listed again: a dollar or more', async () => {
    await seed({ face: 2_000, merchantId: 'bestbuy' })
    // 75c left: too small to list again (relist.ts), so retired, with no deposit.
    expect(await quoteTill('card', { merchantId: 'bestbuy', totalCents: 1_925 })).toMatchObject({
      kind: 'quote',
      residualCents: 75,
      depositCents: 0,
    })
    expect(await quoteTill('card', { merchantId: 'bestbuy', totalCents: 1_900 })).toMatchObject({
      kind: 'quote',
      residualCents: 100,
      depositCents: 100,
    })
  })
})

describe('what is on sale', () => {
  it('says there is no live supply in the words the shop recognises', async () => {
    const out = await quoteTill('card', { merchantId: 'target', totalCents: 2_000 })
    expect(out).toEqual({ kind: 'no_quote', reason: 'no live supply for merchant target' })
  })

  it('never quotes an escrow listing, another store, an expired card, or one left out', async () => {
    await seed({ face: 2_000, formFactor: ESCROW_INTENT_FORM_FACTOR })
    await seed({ face: 2_000, merchantId: 'walmart' })
    await seed({ face: 2_000, expiresAt: new Date(Date.now() - 1_000) })
    const excluded = await seed({ face: 2_000 })
    await seed({ face: 2_000, accountId: 'disputed' })
    const out = await quoteTill('card', {
      merchantId: 'target',
      totalCents: 2_000,
      excludeIntentIds: [excluded],
      excludeAccountIds: ['disputed'],
    })
    expect(isNoQuote(out)).toBe(true)
  })

  it('refuses the dollars rail plainly: it keeps its own quote until it can sell part of a card', async () => {
    await seed({ face: 2_000 })
    const out = await quoteTill('stablecoin', { merchantId: 'target', totalCents: 2_000 })
    expect(out).toMatchObject({ kind: 'no_quote' })
  })
})

describe('first in line', () => {
  it('plans a remainder at its own value, whole, priced at its listing discount', async () => {
    // $3.87 left on a $60 card listed at 10% off, with a deposit behind it.
    const r = await seed({ face: 6_000, lastKnownBalanceCents: 387, failureReason: 'REMAINDER|ord_a|pi_dep' })
    await seed({ face: 2_000 })
    const q = await quote(2_387)
    expect(q.legs.map((l) => [l.intentId, l.source, l.appliedCents, l.costCents, l.remainderOf])).toEqual([
      [r, 'remainder', 387, 349, 'ord_a'],
      [expect.any(String), 'fresh', 2_000, 1_800, null],
    ])
    expect(q.priceCents).toBe(2_149)
  })

  it('takes the haircut off the price of a remainder with no deposit left behind it', async () => {
    await seed({ face: 6_000, lastKnownBalanceCents: 387, failureReason: 'REMAINDER|ord_a|' })
    const q = await quote(387)
    // 349c less 25%, rounded up for the seller.
    expect(q.legs[0]).toMatchObject({ source: 'remainder', appliedCents: 387, costCents: 262 })
    setEnv({ BM_INFERENCE_HAIRCUT_BPS: '0' })
    expect((await quote(387)).legs[0]?.costCents).toBe(349)
  })

  it('never quotes a remainder whose value is not on the row', async () => {
    await seed({ face: 6_000, lastKnownBalanceCents: null, failureReason: 'REMAINDER|ord_a|pi_dep' })
    expect(isNoQuote(await quoteTill('card', { merchantId: 'target', totalCents: 387 }))).toBe(true)
  })

  it('takes the oldest first when only one fits', async () => {
    const newer = await seed({
      face: 2_000,
      lastKnownBalanceCents: 300,
      failureReason: 'REMAINDER|ord_new|pi_new',
      lastCheckedAt: new Date(Date.now() - 60_000),
    })
    const older = await seed({
      face: 2_000,
      lastKnownBalanceCents: 300,
      failureReason: 'REMAINDER|ord_old|pi_old',
      lastCheckedAt: new Date(Date.now() - 3_600_000),
    })
    await seed({ face: 2_000 })
    const q = await quote(2_300)
    expect(q.legs.map((l) => l.intentId)).toContain(older)
    expect(q.legs.map((l) => l.intentId)).not.toContain(newer)
  })

  it('keeps the line by when each card joined it, not by its last balance check', async () => {
    // Best Buy, where balance-watch rewrites lastCheckedAt on every check: the
    // older remainder was checked a moment ago, the newer one two hours ago.
    const olderOrder = await orderAt(new Date(Date.now() - 3 * 3_600_000))
    const newerOrder = await orderAt(new Date(Date.now() - 3_600_000))
    const older = await seed({
      face: 2_000,
      merchantId: 'bestbuy',
      lastKnownBalanceCents: 300,
      failureReason: `REMAINDER|${olderOrder}|pi_old`,
      lastCheckedAt: new Date(),
    })
    const newer = await seed({
      face: 2_000,
      merchantId: 'bestbuy',
      lastKnownBalanceCents: 300,
      failureReason: `REMAINDER|${newerOrder}|pi_new`,
      lastCheckedAt: new Date(Date.now() - 2 * 3_600_000),
    })
    await seed({ face: 2_000, merchantId: 'bestbuy' })
    const q = await quoteTill('card', { merchantId: 'bestbuy', totalCents: 2_300 })
    if (isNoQuote(q)) throw new Error(`expected a quote, got: ${q.reason}`)
    expect(q.legs.map((l) => l.intentId)).toContain(older)
    expect(q.legs.map((l) => l.intentId)).not.toContain(newer)
  })

  it('a card behind a kept hold waits first in line too, used whole', async () => {
    const held = await seed({ face: 2_000, off: 20, failureReason: 'UNSCANNED|ord_kept' })
    await seed({ face: 1_000, off: 20 })
    const q = await quote(2_500)
    expect(q.legs[0]).toMatchObject({ intentId: held, firstInLine: true, appliedCents: 2_000, fullyDrained: true })
  })
})

describe('the shopper setting', () => {
  it('is in and out with two cards when none is given, and most savings when asked', async () => {
    // One $50 card at 5% off, or a $30 and a $20 at 20% off.
    await seed({ face: 5_000, off: 5, merchantId: 'bestbuy' })
    await seed({ face: 3_000, off: 20, merchantId: 'bestbuy' })
    await seed({ face: 2_000, off: 20, merchantId: 'bestbuy' })

    const fast = await quoteTill('card', { merchantId: 'bestbuy', totalCents: 5_000 })
    const cheap = await quoteTill('card', { merchantId: 'bestbuy', totalCents: 5_000, preference: { mode: 'most_savings' } })
    if (isNoQuote(fast) || isNoQuote(cheap)) throw new Error('expected quotes')
    expect(fast).toMatchObject({ priceCents: 4_750, preference: { mode: 'in_and_out', maxCards: 2 } })
    expect(fast.legs).toHaveLength(1)
    expect(cheap).toMatchObject({ priceCents: 4_000, preference: { mode: 'most_savings', maxCards: 4 } })
    expect(cheap.legs).toHaveLength(2)

    // Through the shop's own quote, the same.
    const offer = await quoteSpend({ merchantId: 'bestbuy', spendCents: 5_000, preference: { mode: 'most_savings' } })
    expect(offer).toMatchObject({ priceCents: 4_000, cards: 2 })
    expect(await quoteSpend({ merchantId: 'bestbuy', spendCents: 5_000 })).toMatchObject({ priceCents: 4_750, cards: 1 })
  })

  it('a malformed setting is the default, not a refusal', async () => {
    await seed({ face: 2_000 })
    const q = await quote(2_000, { preference: { mode: 'warp', maxCards: 99 } })
    expect(q.preference).toEqual({ mode: 'in_and_out', maxCards: 2 })
  })
})
