/**
 * Our wallet never pays an escrow shopper, and nothing settles an escrow sale
 * twice (lead override 1: escrow orders ride rail `mpp` with an
 * `escrow:<chainKey>:<escrow>:<depositId>` payment ref, no migration).
 *
 * Every existing path that could refund, settle, reconcile, fulfil, email
 * about or otherwise act on an mpp order, or match, cancel, sweep or sell a
 * listing, is driven here at an escrow order or listing, and each one must
 * leave it exactly as it was:
 *
 *   order creation (every rail's intake, the MPP receipt path included)
 *   order transitions, the shared door every settle path goes through
 *   reconcile: findDueForRefund, refundOrder, issueRefund, the cron sweep
 *   crypto-refund: refundCrypto refuses before it touches a key
 *   fulfilment: the worker's claim list and the operator's one-tap link
 *   the hold sweep (pay on scan), run with a fake Stripe client
 *   the reveal service: open, settle, the stale and contested sweeps, the
 *   order page's code link and the buyer's evidence form
 *   intents: transition, the shared transition rule, abort-and-refund,
 *   match, cancel, buy, quote, browse, the balance sweep and its merchant
 *   list, the seller list route, the cancel route, the seller's estimate
 *   the gift-card daily cap
 *
 * All of it with ESCROW_RAIL unset, as production runs, and with positive
 * controls showing the other rails' orders and listings handled as before.
 * The rows are written the way the keeper writes them (keeper.ts). The two
 * money transports are spies that fail the test if they are ever reached.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'

vi.mock('@/lib/crypto-refund', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crypto-refund')>()
  const never = async (): Promise<never> => {
    throw new Error('a crypto refund was attempted')
  }
  return { ...actual, refundCrypto: vi.fn(never), refundTempo: vi.fn(never), refundX402: vi.fn(never) }
})

vi.mock('@/lib/notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notify')>()
  return { ...actual, pushOperator: vi.fn(async () => ({ sent: false })) }
})

const { prisma } = await import('@/lib/db')
const { mailer } = await import('@/lib/email')
const cryptoRefund = await import('@/lib/crypto-refund')
const { createPaidOrder, markEventProcessed, transitionOrderStandalone } = await import('@/lib/orders')
const { findDueForRefund, reconcile, refundOrder } = await import('@/lib/reconcile')
const { claimableOrders, fulfillOne } = await import('@/lib/fulfillment')
const { abortAndRefund, balanceWatchSweep, cancelIntent, matchIntentsTogether, transitionIntent } = await import('@/lib/intent/service')
const { sweepAllMerchants } = await import('@/lib/intent/sweep')
const { browseOffers, buyOffer, cancelListing, OfferUnavailableError } = await import('@/lib/supply/listing-service')
const { quoteDemand } = await import('@/lib/demand/quote')
const { readGiftCardDaily } = await import('@/lib/inventory')
const { resolveHolds } = await import('@/lib/hold/sweep')
const { __setStripeClientForTests } = await import('@/lib/stripe')
const { POST: cancelRoute } = await import('@/app/api/supply/cancel/route')
const { GET: sellerListings } = await import('@/app/api/supply/listings/route')
const { POST: estimateRoute } = await import('@/app/api/supply/estimate/route')
const { GET: orderSummary } = await import('@/app/api/orders/[id]/summary/route')
const { POST: evidenceRoute } = await import('@/app/api/barcode/evidence/route')
const { openReveal, resolveContestedReveals, resolveStaleReveals, settleReveal } = await import('@/lib/barcode/reveal-service')
const { LocalEnvelopeVault, generateMasterKey } = await import('@/lib/vault/envelope')
const { assertIntentTransition } = await import('@/lib/intent/state')
const { DISPUTED_MARK } = await import('@/lib/escrow/quote')
const refs = await import('@/lib/escrow/refs')
const { createFakeStripe } = await import('./support/fake-stripe')
const { makeIntake, resetDb, setEnv } = await import('./helpers')
import type { SupplyAdapter } from '@/lib/supply/types'

const ESCROW = `0x${'ab'.repeat(20)}` as const
const LISTING = `0x${'cd'.repeat(32)}` as const
const SHOPPER = `0x${'11'.repeat(20)}`
const SELLER = `0x${'22'.repeat(20)}`
const REF = refs.escrowPaymentRef('tempo-moderato', ESCROW, 7n)
const HOUR = 3_600_000

const ORIGINAL = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  HOLD_ALLOWANCE_CENTS: process.env.HOLD_ALLOWANCE_CENTS,
  OPERATOR_SECRET: process.env.OPERATOR_SECRET,
  ESCROW_RAIL: process.env.ESCROW_RAIL,
}

beforeEach(async () => {
  await resetDb()
  vi.clearAllMocks()
  setEnv({
    CREDITS_AVAILABLE: '10',
    MAX_ORDERS_PER_DAY: '50',
    INTAKE_PAUSED: 'false',
    REFUND_LEAD_MINUTES: '90',
    // As production runs: the rail is off. Every guard here holds without it,
    // and every positive control shows the other rails unchanged.
    ESCROW_RAIL: undefined,
  })
})

afterEach(() => {
  __setStripeClientForTests(null)
  vi.restoreAllMocks()
})

afterAll(async () => {
  setEnv(ORIGINAL)
  await resetDb()
  await prisma.$disconnect()
})

/** An escrow order as the keeper writes it: fulfilling, past its deadline, so every sweep would want it. */
async function escrowOrder(over: Record<string, unknown> = {}) {
  return prisma.order.create({
    data: {
      buyerEmail: '',
      kind: 'gift_card',
      merchantId: 'bestbuy',
      deadlineAt: new Date(Date.now() - 2 * HOUR),
      qty: 1,
      priceCents: 4_840,
      rail: 'mpp',
      paymentRef: REF,
      payerAddress: SHOPPER,
      state: 'fulfilling',
      ...over,
    },
  })
}

/** An escrow listing row. `state` and `matchedOrderId` as the keeper leaves them. */
async function escrowIntent(
  state: 'offered' | 'executing',
  matchedOrderId: string | null = null,
  over: { merchantId?: string; failureReason?: string | null; listingId?: `0x${string}` } = {},
) {
  return prisma.intent.create({
    data: {
      id: refs.escrowIntentIdFor(over.listingId ?? LISTING),
      state,
      merchantId: over.merchantId ?? 'bestbuy',
      failureReason: over.failureReason ?? null,
      accountId: `seller:${SELLER}`,
      formFactor: refs.ESCROW_INTENT_FORM_FACTOR,
      faceValueCents: 5_000,
      priceCents: 4_400,
      discountBps: 1_200,
      expiresAt: new Date(Date.now() + 48 * HOUR),
      last4: '',
      sealedRef: { id: LISTING, algorithm: 'chipotle:escrow:v1', conditionDigest: `escrow:${LISTING}` },
      matchedOrderId,
    },
  })
}

const snapshot = async (orderId: string) => {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  const events = await prisma.orderEvent.count({ where: { orderId } })
  return { state: o.state, priceCents: o.priceCents, refundRef: o.refundRef, paymentRef: o.paymentRef, events }
}

function expectNoMoneyMoved(): void {
  expect(cryptoRefund.refundCrypto).not.toHaveBeenCalled()
  expect(cryptoRefund.refundTempo).not.toHaveBeenCalled()
  expect(cryptoRefund.refundX402).not.toHaveBeenCalled()
}

describe('isEscrowPaymentRef decides it, for every spelling', () => {
  it('names escrow refs and lookalikes, and nothing else', () => {
    expect(REF).toBe(`escrow:tempo-moderato:${ESCROW}:7`)
    expect(refs.parseEscrowPaymentRef(REF)).toEqual({ chainKey: 'tempo-moderato', escrow: ESCROW, depositId: 7n })
    for (const r of [REF, ' escrow:x', 'ESCROW:tempo-moderato:0x1:1', 'Escrow:']) expect(refs.isEscrowPaymentRef(r)).toBe(true)
    for (const r of ['0xabc', 'cs_test_1', 'hold:cus_1:none', 'escro:', '', null, undefined]) expect(refs.isEscrowPaymentRef(r)).toBe(false)
    expect(refs.parseEscrowPaymentRef('ESCROW:tempo-moderato:0x1:1')).toBeNull()
  })
})

describe('order creation: no intake writes an escrow order', () => {
  it('createPaidOrder (the MPP receipt path, x402 and Stripe) refuses an escrow ref or key and writes nothing', async () => {
    const cases: Array<{ paymentRef: string; idempotencyKey: string }> = [
      { paymentRef: REF, idempotencyKey: 'key-1' },
      { paymentRef: ` ESCROW:tempo-moderato:${ESCROW}:7`, idempotencyKey: 'key-2' },
      { paymentRef: '0xok', idempotencyKey: `escrow:42431:${ESCROW}:deposit:000000000000007` },
    ]
    for (const c of cases) {
      await expect(
        createPaidOrder({ intake: makeIntake(), rail: 'mpp', payerAddress: SHOPPER, ...c }),
      ).rejects.toBeInstanceOf(refs.EscrowRailRefusedError)
    }
    expect(await prisma.order.count()).toBe(0)
    expect(await prisma.processedEvent.count()).toBe(0)
  })

  it('no webhook can pre-record the keeper\'s idempotency row, which would hide a real purchase from it', async () => {
    await expect(markEventProcessed(`escrow:42431:${ESCROW}:deposit:000000000000007`, 'mpp')).rejects.toBeInstanceOf(
      refs.EscrowRailRefusedError,
    )
    expect(await prisma.processedEvent.count()).toBe(0)
  })

  it('the MPP route creates orders only through createPaidOrder', () => {
    const route = readFileSync(resolve(process.cwd(), 'src/app/api/mpp/order/route.ts'), 'utf8')
    expect(route).toContain('createPaidOrder(')
    expect(route).not.toMatch(/prisma\.order\.(create|update|upsert)/)
  })
})

describe('order transitions: the shared door is shut to escrow orders', () => {
  it('transitionOrder refuses every move, and the order is unchanged', async () => {
    const o = await escrowOrder()
    const before = await snapshot(o.id)
    for (const to of ['failed', 'fulfilled'] as const) {
      await expect(transitionOrderStandalone(o.id, to, { actor: 'cron', reason: 'test' })).rejects.toBeInstanceOf(refs.EscrowRailRefusedError)
    }
    expect(await snapshot(o.id)).toEqual(before)
  })
})

describe('reconcile and crypto-refund never pay an escrow shopper', () => {
  it('findDueForRefund skips an escrow order past its deadline, and the sweep refunds only the others', async () => {
    const o = await escrowOrder()
    const before = await snapshot(o.id)
    // A positive control: an x402 order due now is still refunded.
    const { order: x402 } = await createPaidOrder({
      intake: makeIntake({ showtimeUtc: new Date(Date.now() + 30 * 60_000) }),
      rail: 'x402',
      paymentRef: '0xsettled',
      payerAddress: SHOPPER,
      idempotencyKey: 'key-x402',
    })
    vi.mocked(cryptoRefund.refundCrypto).mockResolvedValueOnce({ txHash: '0xback', explorer: 'https://x.invalid', amountAtomic: '1', from: '0x0' })
    const sendRefunded = vi.spyOn(mailer, 'sendRefunded')

    const due = await findDueForRefund(new Date())
    expect(due.map((d) => d.id)).toEqual([x402.id])
    const report = await reconcile(new Date())
    expect(report).toMatchObject({ scanned: 1, refunded: 1 })
    expect(cryptoRefund.refundCrypto).toHaveBeenCalledTimes(1)
    expect(cryptoRefund.refundCrypto).toHaveBeenCalledWith('x402', SHOPPER, 900, '0xsettled')
    expect(sendRefunded).toHaveBeenCalledTimes(1)
    expect(await snapshot(o.id)).toEqual(before)
  })

  it('refundOrder on an escrow order refuses before its first write, sends nothing and emails nobody', async () => {
    const o = await escrowOrder()
    const before = await snapshot(o.id)
    const sendRefunded = vi.spyOn(mailer, 'sendRefunded')
    const out = await refundOrder(o, 'deadline', new Date())
    expect(out).toMatchObject({ orderId: o.id, refunded: false, refundRef: null, money: null, emailSent: false })
    expect(out.error).toMatch(/escrow/)
    expect(sendRefunded).not.toHaveBeenCalled()
    expectNoMoneyMoved()
    expect(await snapshot(o.id)).toEqual(before)
  })

  it('refundCrypto refuses an escrow ref before it reads a key or a setting', async () => {
    const actual = await vi.importActual<typeof import('@/lib/crypto-refund')>('@/lib/crypto-refund')
    for (const rail of ['mpp', 'x402'] as const) {
      await expect(actual.refundCrypto(rail, SHOPPER, 4_840, REF)).rejects.toBeInstanceOf(refs.EscrowRailRefusedError)
    }
  })
})

describe('fulfilment never claims an escrow order', () => {
  it('the worker list excludes it whatever its kind, and the operator link skips it', async () => {
    // Even dressed as a paid ticket, which the keeper never writes.
    const o = await escrowOrder({ kind: 'ticket', state: 'paid', deadlineAt: new Date(Date.now() + 48 * HOUR) })
    const before = await snapshot(o.id)
    expect((await claimableOrders(50)).map((c) => c.id)).not.toContain(o.id)
    const out = await fulfillOne(o.id, { actor: 'operator' })
    expect(out).toMatchObject({ result: 'skipped' })
    expect(out.result === 'skipped' ? out.reason : '').toMatch(/escrow/)
    expect(await snapshot(o.id)).toEqual(before)
  })
})

describe('the hold sweep leaves escrow orders and listings alone', () => {
  it('scans neither, and changes nothing', async () => {
    setEnv({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: undefined, HOLD_ALLOWANCE_CENTS: '20000' })
    __setStripeClientForTests(createFakeStripe() as unknown as Stripe)
    const o = await escrowOrder()
    const i = await escrowIntent('executing', o.id)
    const before = await snapshot(o.id)
    const report = await resolveHolds({ runKey: 'test' })
    expect(report).toMatchObject({ scanned: 0, captured: 0, released: 0, failed: 0 })
    expect(await snapshot(o.id)).toEqual(before)
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: i.id } })).state).toBe('executing')
    expectNoMoneyMoved()
  })
})

describe('intents: only the keeper moves an escrow listing', () => {
  it('transitionIntent and abortAndRefund refuse; the sale and its order are unchanged and nothing is refunded', async () => {
    const o = await escrowOrder()
    const i = await escrowIntent('executing', o.id)
    const before = await snapshot(o.id)
    await expect(transitionIntent(i.id, 'completed', { expect: 'executing' })).rejects.toBeInstanceOf(refs.EscrowRailRefusedError)
    await expect(abortAndRefund(i, 'test', new Date())).rejects.toBeInstanceOf(refs.EscrowRailRefusedError)
    const after = await prisma.intent.findUniqueOrThrow({ where: { id: i.id } })
    expect(after).toMatchObject({ state: 'executing', matchedOrderId: o.id, failureReason: null })
    expect(await snapshot(o.id)).toEqual(before)
    expectNoMoneyMoved()
  })

  it('an offered escrow listing cannot be matched, cancelled, bought, quoted or browsed by the other rail', async () => {
    const i = await escrowIntent('offered')
    const { order } = await createPaidOrder({
      intake: makeIntake(),
      rail: 'stripe',
      paymentRef: 'cs_other',
      idempotencyKey: 'key-other',
    })
    await expect(matchIntentsTogether([{ intentId: i.id, orderId: order.id }])).rejects.toBeInstanceOf(refs.EscrowRailRefusedError)
    // And by form factor alone, for a row whose id does not give it away.
    const odd = await prisma.intent.create({
      data: { ...(await prisma.intent.findUniqueOrThrow({ where: { id: i.id } })), id: 'odd_escrow_row', sealedRef: {} },
    })
    await expect(matchIntentsTogether([{ intentId: odd.id, orderId: order.id }])).rejects.toThrow(/changed state concurrently/)
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: odd.id } })).state).toBe('offered')
    await prisma.intent.delete({ where: { id: odd.id } })
    await expect(cancelListing(i.id)).rejects.toBeInstanceOf(refs.EscrowRailRefusedError)
    await expect(cancelIntent(i.id, 'seller_reclaimed')).rejects.toBeInstanceOf(refs.EscrowRailRefusedError)
    const orders = await prisma.order.count()
    await expect(buyOffer({ intentId: i.id, buyerEmail: 'a@example.com' })).rejects.toBeInstanceOf(OfferUnavailableError)
    expect(await prisma.order.count()).toBe(orders)

    const unnamed = await quoteDemand({ merchantId: 'bestbuy', orderTotalCents: 5_000 })
    expect(unnamed).toMatchObject({ kind: 'no_quote' })
    // Positive control: named, the escrow quote can see it.
    const named = await quoteDemand({ merchantId: 'bestbuy', orderTotalCents: 5_000, formFactor: refs.ESCROW_INTENT_FORM_FACTOR })
    expect(named).toMatchObject({ kind: 'quote' })
    expect(await browseOffers('bestbuy')).toEqual([])

    const row = await prisma.intent.findUniqueOrThrow({ where: { id: i.id } })
    expect(row).toMatchObject({ state: 'offered', matchedOrderId: null, cancellationReason: null })
  })

  it('the balance sweep neither probes nor cancels an escrow listing, and builds no adapter for it', async () => {
    const i = await escrowIntent('offered')
    const checkBalance = vi.fn(async () => ({ available: false, remainingUnits: 0 }))
    const adapter = { merchantId: 'bestbuy', formFactor: 'bearer', checkBalance } as unknown as SupplyAdapter
    const swept = await balanceWatchSweep({ adapter })
    expect(swept).toMatchObject({ scanned: 0, cancelled: 0 })
    expect(checkBalance).not.toHaveBeenCalled()
    const resolveAdapter = vi.fn(async () => adapter)
    const all = await sweepAllMerchants({ resolveAdapter })
    expect(all.merchants).toBe(0)
    expect(resolveAdapter).not.toHaveBeenCalled()
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: i.id } })).state).toBe('offered')
  })

  it('the cancel route sends the seller to the chain, and the public seller list leaves escrow listings out', async () => {
    const i = await escrowIntent('offered')
    const res = await cancelRoute(
      new Request('http://localhost:3000/api/supply/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intentId: i.id }),
      }),
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('cancel_on_chain')
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: i.id } })).state).toBe('offered')

    const list = (await (await sellerListings()).json()) as { listings: Array<{ intentId: string }> }
    expect(list.listings.map((l) => l.intentId)).not.toContain(i.id)
  })
})

describe('the gift-card daily cap', () => {
  it('counts no escrow purchase: nothing of ours was exposed', async () => {
    await escrowOrder({ createdAt: new Date() })
    expect((await readGiftCardDaily()).spentCents).toBe(0)
  })
})

describe('the shared intent rule refuses an escrow listing by its id alone', () => {
  it('so a path that holds only an id, and then writes the row itself, cannot move one', () => {
    const id = refs.escrowIntentIdFor(LISTING)
    expect(refs.isEscrowIntentId(id)).toBe(true)
    expect(refs.isEscrowIntentId(id.toUpperCase().replace('ESC_', 'esc_'))).toBe(true)
    for (const other of ['clx0abc123', `esc_${'a'.repeat(63)}`, `esc_${'a'.repeat(65)}`, '', null, undefined]) {
      expect(refs.isEscrowIntentId(other)).toBe(false)
    }
    for (const [from, to] of [['executing', 'completed'], ['offered', 'matched'], ['offered', 'cancelled'], ['execution_failed', 'refunded']] as const) {
      expect(() => assertIntentTransition(from, to, id)).toThrow(refs.EscrowRailRefusedError)
      // Positive control: any other id moves by the table as before.
      expect(() => assertIntentTransition(from, to, 'clx0abc123')).not.toThrow()
    }
  })
})

describe('the reveal paths never open, settle or sweep an escrow sale', () => {
  const OTHER_LISTING = `0x${'ef'.repeat(32)}` as const

  // The reveal service is the other rail's and is not changed for this one.
  // These are the doors it shares: the reveal and settle routes need a token
  // only a successful open mints, and both sweeps select by their own markers.
  it('openReveal is denied, settleReveal refuses or holds, and neither sweep finds one, at either kind of store', async () => {
    const vault = new LocalEnvelopeVault({ masterKey: Buffer.from(generateMasterKey(), 'hex') })
    const read = vi.fn(async () => ({ balanceCents: 5_000 }))
    // A store nobody can read (the evidence path) with no mark, and a store
    // with a balance page while its buyer's dispute stands.
    const blind = await escrowOrder({ merchantId: 'target' })
    const blindIntent = await escrowIntent('executing', blind.id, { merchantId: 'target' })
    const readable = await escrowOrder({ merchantId: 'bestbuy' })
    const readableIntent = await escrowIntent('executing', readable.id, { listingId: OTHER_LISTING, failureReason: DISPUTED_MARK })
    const sales = [
      { order: blind, intent: blindIntent },
      { order: readable, intent: readableIntent },
    ]
    const before = await Promise.all(sales.map(async (s) => [await snapshot(s.order.id), await prisma.intent.findUniqueOrThrow({ where: { id: s.intent.id } })]))

    const outcomes: string[] = []
    for (const { order, intent } of sales) {
      const proof = { intentId: intent.id, orderId: order.id, escrowFunded: true, matched: true }
      const opened = await openReveal({ intentId: intent.id, vault, proof, balanceReader: { read } })
      expect(opened.result).toBe('denied')
      for (const answer of [{ buyerConfirmation: true }, { buyerReportsFailure: true }, {}]) {
        const settled = await settleReveal({ intentId: intent.id, vault, proof, balanceReader: { read }, ...answer }).then(
          (out) => out.result,
          (err: unknown) => (err instanceof refs.EscrowRailRefusedError ? 'refused' : `threw ${String(err)}`),
        )
        outcomes.push(`${intent.merchantId} ${Object.keys(answer)[0] ?? 'no answer'}: ${settled}`)
      }
    }
    expect(outcomes).toEqual([
      // A "yes" would release the window, and the release writes the row
      // itself after the shared rule: that rule refuses the escrow id, so
      // nothing is written. A "no" would refund, and is refused at its first move.
      'target buyerConfirmation: refused',
      'target buyerReportsFailure: refused',
      'target no answer: held',
      // A store with a balance page settles on a balance read at open, which an
      // escrow sale never has, so it holds before reading anything.
      'bestbuy buyerConfirmation: held',
      'bestbuy buyerReportsFailure: held',
      'bestbuy no answer: held',
    ])

    expect(await resolveStaleReveals({ vault, readerFor: () => ({ read }), graceMs: 0, now: new Date(Date.now() + 30 * 24 * HOUR) })).toMatchObject({ scanned: 0 })
    expect(await resolveContestedReveals({ now: new Date(Date.now() + 30 * 24 * HOUR) })).toMatchObject({ scanned: 0 })

    expect(read).not.toHaveBeenCalled()
    const after = await Promise.all(sales.map(async (s) => [await snapshot(s.order.id), await prisma.intent.findUniqueOrThrow({ where: { id: s.intent.id } })]))
    expect(after).toEqual(before)
    expectNoMoneyMoved()
  })

  it('the order page offers no code for one, and the evidence form will not take a report about one', async () => {
    setEnv({ OPERATOR_SECRET: 'x'.repeat(32) })
    const o = await escrowOrder()
    await escrowIntent('executing', o.id)
    const before = await snapshot(o.id)

    const summaryUrl = 'http://localhost:3000/api/orders/' + o.id + '/summary'
    const summary = (await (await orderSummary(new Request(summaryUrl), { params: Promise.resolve({ id: o.id }) })).json()) as Record<string, unknown>
    expect(summary).toMatchObject({ orderId: o.id, revealToken: null, opensLeft: null, holdMode: false })

    const report = (body: Record<string, unknown>) =>
      evidenceRoute(new Request('http://localhost:3000/api/barcode/evidence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    // No escrow order has an email, so no address ever matches one.
    expect((await report({ orderId: o.id, buyerEmail: 'someone@example.com', claim: 'failed' })).status).toBe(403)
    expect((await report({ orderId: o.id, buyerEmail: '', claim: 'failed' })).status).toBe(400)
    expect(await snapshot(o.id)).toEqual(before)
  })
})

describe("the seller's estimate prices the pool without escrow listings", () => {
  it('counts the pool positions it always did, and none of the escrow book', async () => {
    const estimate = async () =>
      (await (
        await estimateRoute(
          new Request('http://localhost:3000/api/supply/estimate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ merchantId: 'bestbuy', faceValueCents: 5_000, discountBps: 1_000 }),
          }),
        )
      ).json()) as { poolPositions: number }
    await escrowIntent('offered')
    expect((await estimate()).poolPositions).toBe(1)
    // Positive control: a listing of ours is in the pool as before.
    await prisma.intent.create({
      data: {
        state: 'offered',
        merchantId: 'bestbuy',
        accountId: 'operator:operator:0',
        formFactor: 'in_store_barcode',
        faceValueCents: 5_000,
        priceCents: 4_500,
        discountBps: 1_000,
        expiresAt: new Date(Date.now() + 48 * HOUR),
        last4: '1234',
        sealedRef: {},
      },
    })
    expect((await estimate()).poolPositions).toBe(2)
  })
})

describe('with ESCROW_RAIL unset, the mpp rail refunds exactly as before', () => {
  it('a plain mpp order past its deadline is refunded from our wallet, and an escrow one beside it is not', async () => {
    expect(process.env.ESCROW_RAIL).toBeUndefined()
    const escrow = await escrowOrder()
    const before = await snapshot(escrow.id)
    const { order: plain } = await createPaidOrder({
      intake: makeIntake({ showtimeUtc: new Date(Date.now() + 30 * 60_000) }),
      rail: 'mpp',
      paymentRef: '0xmpp_settled',
      payerAddress: SHOPPER,
      idempotencyKey: 'key-mpp',
    })
    vi.mocked(cryptoRefund.refundCrypto).mockResolvedValueOnce({ txHash: '0xback', explorer: 'https://x.invalid', amountAtomic: '1', from: '0x0' })
    const report = await reconcile(new Date())
    expect(report).toMatchObject({ scanned: 1, refunded: 1 })
    expect(cryptoRefund.refundCrypto).toHaveBeenCalledTimes(1)
    expect(cryptoRefund.refundCrypto).toHaveBeenCalledWith('mpp', SHOPPER, plain.priceCents, '0xmpp_settled')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: plain.id } })).state).toBe('refunded')
    expect(await snapshot(escrow.id)).toEqual(before)
  })
})
