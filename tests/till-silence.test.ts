/**
 * Silence counts as worked, at a store nobody can check (unified-account spec
 * 5.2 step 5).
 *
 * At Target and Walmart a window with no answer used to hold, and the stale
 * sweep refunded it after 24 hours. The code had been on a register's screen,
 * so a shopper who said nothing got their money back and kept the number.
 * Now the sweep, which takes a window only once the settle credential has died
 * (the window plus 20 minutes), settles silence as worked and takes the price.
 *
 * Pinned, in the direction that costs money:
 *   - no answer: captured once the window plus 20 minutes has passed, and
 *     never refunded at 24 hours;
 *   - not one minute early, while the shopper can still answer;
 *   - the shopper's own settle with no answer still holds;
 *   - a paid-at-buy order is released the same way, not refunded;
 *   - a store whose balance we read is unchanged: an unreadable probe still
 *     refunds at 24 hours, because silence there is the probe's, not theirs;
 *   - a release on silence opens the 48-hour dispute window like any tier-3
 *     settlement, so the shopper can still say it failed.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import type { BalanceReader, BalanceReading } from '@/lib/barcode/reveal-service'

vi.mock('@/lib/notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notify')>()
  return { ...actual, pushOperator: vi.fn(async () => ({ sent: false })) }
})

const { prisma } = await import('@/lib/db')
const { LocalEnvelopeVault, generateMasterKey } = await import('@/lib/vault/envelope')
const { createListing } = await import('@/lib/supply/listing-service')
const { buySpend } = await import('@/lib/demand/one-screen')
const { STALE_REVEAL_GRACE_MS, STALE_REVEAL_REFUND_AFTER_MS, openReveal, resolveStaleReveals, settleReveal } =
  await import('@/lib/barcode/reveal-service')
const { revealWindowMs } = await import('@/lib/barcode/reveal')
const { __setStripeClientForTests } = await import('@/lib/stripe')
const ref = await import('@/lib/hold/ref')
const { createFakeStripe } = await import('./support/fake-stripe')
const { resetDb, setEnv } = await import('./helpers')

const MIN_MS = 60_000
const DAY_MS = 24 * 60 * MIN_MS
const ORIGINAL = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  OPERATOR_SECRET: process.env.OPERATOR_SECRET,
  VAULT_MASTER_KEY: process.env.VAULT_MASTER_KEY,
  HOLD_ALLOWANCE_CENTS: process.env.HOLD_ALLOWANCE_CENTS,
}

let fake: ReturnType<typeof createFakeStripe>

beforeEach(async () => {
  await resetDb()
  setEnv({
    STRIPE_SECRET_KEY: 'sk_test_abc',
    OPERATOR_SECRET: 'x'.repeat(32),
    HOLD_ALLOWANCE_CENTS: '20000',
    VAULT_MASTER_KEY: generateMasterKey(),
    CREDITS_AVAILABLE: '10',
    MAX_ORDERS_PER_DAY: '50',
    INTAKE_PAUSED: 'false',
  })
  fake = createFakeStripe()
  __setStripeClientForTests(fake as unknown as Stripe)
})

afterEach(() => {
  __setStripeClientForTests(null)
})

afterAll(async () => {
  setEnv(ORIGINAL)
  await resetDb()
  await prisma.$disconnect()
})

const vault = () => new LocalEnvelopeVault()
const later = (ms: number) => new Date(Date.now() + ms)
const reader = (balanceCents: number | null): BalanceReader => ({
  read: async (): Promise<BalanceReading> => ({ balanceCents }),
})
const proofFor = (intentId: string, orderId: string) => ({ intentId, orderId, escrowFunded: true, matched: true })
const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })

/** The moment the sweep may first take a window opened now. */
const pastGrace = () => later(revealWindowMs() + STALE_REVEAL_GRACE_MS + MIN_MS)

/** A $20 code on screen, 20% off, so $16.00 held. Target unless told otherwise. */
async function openCode(opts: { merchantId?: string; payer?: boolean; balance?: number | null } = {}) {
  const merchantId = opts.merchantId ?? 'target'
  const listing = await createListing({
    merchantId,
    cardNumber: merchantId === 'target' ? '04112345678901234567890123' : '6006491234567890123',
    ...(merchantId === 'target' ? {} : { pin: '4821' }),
    faceValueCents: 2_000,
    discountBps: 2_000,
    expiresAt: later(3 * DAY_MS),
  })
  const payer = opts.payer === false ? null : fake.seedBuyer()
  const out = await buySpend({
    merchantId,
    spendCents: 2_000,
    buyerEmail: 'shopper@example.com',
    ...(payer ? { payer: { customerId: payer.customerId } } : {}),
  })
  const opened = await openReveal({
    intentId: listing.id,
    vault: vault(),
    proof: proofFor(listing.id, out.orderId),
    balanceReader: reader(opts.balance === undefined ? null : opts.balance),
    ...(payer ? { verifiedCustomerId: payer.customerId } : {}),
  })
  if (opened.result !== 'revealed') throw new Error(`expected a code, got ${opened.result}`)
  const pi = ref.parseHoldRef((await orderRow(out.orderId)).paymentRef)?.paymentIntentId ?? null
  return { intentId: listing.id, orderId: out.orderId, pi }
}

const sweep = (now: Date, balance: number | null = null) =>
  resolveStaleReveals({ vault: vault(), readerFor: () => reader(balance), now })

describe('a Target code nobody answered', () => {
  it('is captured once the window plus 20 minutes has passed', async () => {
    const c = await openCode()

    const report = await sweep(pastGrace())

    expect(report).toMatchObject({ scanned: 1, settled: 1, refunded: 0 })
    expect(fake.paymentIntent(c.pi ?? '')).toMatchObject({ status: 'succeeded', amount_received: 1_600 })
    const order = await orderRow(c.orderId)
    expect(order.state).toBe('fulfilled')
    expect(ref.moneyState(order)).toBe('charged')
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: c.intentId } })).state).toBe('completed')
  })

  it('is left alone while the shopper can still answer', async () => {
    const c = await openCode()

    const report = await sweep(later(revealWindowMs() + STALE_REVEAL_GRACE_MS - MIN_MS))

    expect(report.settled).toBe(0)
    expect(fake.paymentIntent(c.pi ?? '').status).toBe('requires_capture')
    expect(fake.callsTo('paymentIntents.capture')).toEqual([])
  })

  it('is never refunded at 24 hours', async () => {
    const c = await openCode()
    expect((await sweep(pastGrace())).settled).toBe(1)

    // A day on, a second run finds nothing to do and moves no money.
    const report = await sweep(later(STALE_REVEAL_REFUND_AFTER_MS + DAY_MS))

    expect(report).toMatchObject({ scanned: 0, refunded: 0 })
    expect(fake.callsTo('paymentIntents.cancel')).toEqual([])
    expect(fake.callsTo('paymentIntents.capture')).toHaveLength(1)
    expect((await orderRow(c.orderId)).state).toBe('fulfilled')
  })

  it('a settle from the shopper\'s own screen with no answer still holds', async () => {
    const c = await openCode()

    const out = await settleReveal({ intentId: c.intentId, vault: vault(), proof: proofFor(c.intentId, c.orderId), balanceReader: reader(null) })

    expect(out.result).toBe('held')
    expect(fake.paymentIntent(c.pi ?? '').status).toBe('requires_capture')
  })

  it('opens the 48-hour dispute window, as every settlement on the shopper\'s word does', async () => {
    const c = await openCode()
    const out = await settleReveal({
      intentId: c.intentId,
      vault: vault(),
      proof: proofFor(c.intentId, c.orderId),
      balanceReader: reader(null),
      window: (await prisma.intent.findUniqueOrThrow({ where: { id: c.intentId } })).failureReason,
      silenceIsWorked: true,
      now: pastGrace(),
    })
    expect(out).toMatchObject({ result: 'released', opensDispute: true, charged: true })
  })

  it('a paid-at-buy order is released the same way, not refunded', async () => {
    const c = await openCode({ payer: false })
    expect(c.pi).toBeNull()

    const report = await sweep(pastGrace())

    expect(report).toMatchObject({ settled: 1, refunded: 0 })
    expect((await orderRow(c.orderId)).state).toBe('fulfilled')
  })
})

describe('a store whose balance we read is unchanged', () => {
  it('an unreadable probe still holds, then refunds after 24 hours', async () => {
    const c = await openCode({ merchantId: 'bestbuy', balance: 2_000 })

    // The probe fails: silence there is the probe's, not the shopper's.
    expect(await sweep(pastGrace(), null)).toMatchObject({ settled: 0, held: 1 })
    expect(fake.paymentIntent(c.pi ?? '').status).toBe('requires_capture')

    const report = await sweep(later(revealWindowMs() + STALE_REVEAL_REFUND_AFTER_MS + MIN_MS), null)
    expect(report.refunded).toBe(1)
    expect(fake.paymentIntent(c.pi ?? '').status).toBe('canceled')
  })

  it('a drained card still settles on the balance, whatever the flag says', async () => {
    const c = await openCode({ merchantId: 'bestbuy', balance: 2_000 })
    expect((await sweep(pastGrace(), 0)).settled).toBe(1)
    expect(fake.paymentIntent(c.pi ?? '')).toMatchObject({ status: 'succeeded', amount_received: 1_600 })
  })
})
