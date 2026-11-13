/**
 * The till on the card rail (unified-account spec 5.2 and 5.4;
 * src/lib/till/card-till.ts and /api/card/till/*).
 *
 * Pinned:
 *
 *   - Pay holds every card at once and opens card 1 only: card 2 has a hold
 *     and no code until Next;
 *   - Next settles the card on screen as worked and opens the next; Done
 *     settles the last, and a remainder goes back on sale behind its deposit;
 *   - "Register says paid" closes the cards never shown: holds released,
 *     cards straight back on sale, the deposit released;
 *   - Pay is safe to tap again after no answer came back: the same key finds
 *     the same purchase and sends card 1's code again, and a Next whose
 *     answer was lost sends the next code again; a retry while the first tap
 *     still undoes a declined deposit, or buys its drains-only try, waits for
 *     it rather than buying a second purchase;
 *   - the price on the button is a ceiling: a plan that costs more, scans
 *     more cards or holds a bigger deposit is not bought, and comes back as a
 *     new price with nothing held;
 *   - "It didn't scan" at Target keeps the hold and puts the card first in
 *     line (open decision 2), says so, and plans the rest with the cards that
 *     were never shown back in the pool;
 *   - the receipt never counts a kept hold as paid, and counts what a
 *     deposit paid;
 *   - where the store lets us read: the next shopper's read proves the rest
 *     and returns the deposit at once, or finds it short and the deposit pays
 *     the missing part; the first shopper's own read bills less when the card
 *     paid less, within the cap, behind a new deposit for all that is left;
 *     with no such deposit to be had the card is billed as planned and the
 *     old deposit stays behind what the plan left; past the cap the read
 *     credits nothing, no deposit is asked, and the card is billed whole and
 *     is theirs; it takes the excess from their own deposit when it paid
 *     more, with a new deposit for the rest held first, never under the
 *     smallest charge, and a take that fails for a moment is finished by
 *     the hold sweep on that deposit;
 *   - a total that changed: codes not shown are closed; down within the cap
 *     bills the shown card less behind a larger deposit; down past it says
 *     the card must not be scanned, and when the cards before it cover the
 *     total, that it is not needed; up uses the rest of the part-used card,
 *     charged from the deposit only once the card has worked, never before:
 *     a card that then does not scan, or a total lowered again, took nothing;
 *   - a page closed before Pay answered asks with the same key and finds the
 *     purchase, and an unknown key buys nothing;
 *   - the receipt route says what a purchase came to, silence included;
 *   - a card that will not hold the deposit gets a plan with no leftover;
 *   - a shopper with two remainder reports gets no remainders;
 *   - the till's own sentences never ask for another total;
 *   - a settled card can be reported for a person inside 48 hours;
 *   - the routes: only our own page, only the phone that paid, a card saved
 *     first, and no processor customer id in anything the page holds.
 *
 * FakeStripe is the only card processor. Target reads nothing; Best Buy reads
 * from a table. No network.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'

vi.mock('@/lib/notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notify')>()
  return { ...actual, pushOperator: vi.fn(async () => ({ sent: false })) }
})

const { prisma } = await import('@/lib/db')
const { pushOperator } = await import('@/lib/notify')
const { LocalEnvelopeVault, generateMasterKey } = await import('@/lib/vault/envelope')
const till = await import('@/lib/till/card-till')
const { quoteTill } = await import('@/lib/demand/till-quote')
const { spendLegFor } = await import('@/lib/demand/spend-leg')
const remainder = await import('@/lib/supply/remainder')
const { mintCardCookie } = await import('@/lib/hold/cookie')
const { mintAccountCookie } = await import('@/lib/account/session')
const { resolveStaleReveals, STALE_REVEAL_GRACE_MS } = await import('@/lib/barcode/reveal-service')
const { resolveHolds } = await import('@/lib/hold/sweep')
const { revealWindowMs } = await import('@/lib/barcode/reveal')
const { mintPurchaseRef } = await import('@/lib/till/purchase')
const { __setStripeClientForTests } = await import('@/lib/stripe')
const { createFakeStripe } = await import('./support/fake-stripe')
const world = await import('./support/till-world')
const { resetDb, setEnv } = await import('./helpers')
const quoteRoute = await import('@/app/api/card/till/quote/route')
const payRoute = await import('@/app/api/card/till/pay/route')
const nextRoute = await import('@/app/api/card/till/next/route')
const reportRoute = await import('@/app/api/card/till/report/route')
const receiptRoute = await import('@/app/api/card/till/receipt/route')

const { Balances, later, listTarget, listBestBuy, tillDeps, orderRow, intentRow, eventsOf, DAY_MS } = world

const APP = 'http://localhost:3000'
const SECRET = 'x'.repeat(32)
const ORIGINAL = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  OPERATOR_SECRET: process.env.OPERATOR_SECRET,
  VAULT_MASTER_KEY: process.env.VAULT_MASTER_KEY,
  HOLD_ALLOWANCE_CENTS: process.env.HOLD_ALLOWANCE_CENTS,
  APP_URL: process.env.APP_URL,
}

let fake: ReturnType<typeof createFakeStripe>

// Each test runs two or three shoppers through the shared Railway database.
vi.setConfig({ testTimeout: 90_000 })

beforeEach(async () => {
  await resetDb()
  vi.clearAllMocks()
  setEnv({
    STRIPE_SECRET_KEY: 'sk_test_abc',
    OPERATOR_SECRET: SECRET,
    HOLD_ALLOWANCE_CENTS: '20000',
    VAULT_MASTER_KEY: generateMasterKey(),
    CREDITS_AVAILABLE: '50',
    MAX_ORDERS_PER_DAY: '100',
    INTAKE_PAUSED: 'false',
    APP_URL: APP,
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

const kindOf = (orderId: string, kind: 'pos_hold' | 'pos_bond') =>
  fake.paymentIntentsForOrder(orderId).filter((pi) => pi.metadata?.salvo_kind === kind)

/** Two Target cards at 20% off, $20 and $40: $56.13 takes all of one and most of the other. */
async function twoTargetCards() {
  const twenty = await listTarget(2_000)
  const forty = await listTarget(4_000)
  return { twenty, forty }
}

type PayInput = Parameters<typeof till.payCardTill>[0]

/** Pay, and the purchase it made: a new price is a failure here. */
async function paid(input: PayInput, deps = tillDeps()) {
  const out = await till.payCardTill(input, deps)
  if (out.kind !== 'paid') throw new Error(`expected a purchase, got a new price: ${out.message}`)
  return out.paid
}

async function pay(merchantId: string, total: number, deps = tillDeps()) {
  const { customerId } = fake.seedBuyer()
  const p = await paid({ merchantId, totalCents: total, preference: null, customerId }, deps)
  return { ...p, customerId }
}

describe('Pay, Next, Done', () => {
  it('holds every card at once, and shows only card 1', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    expect(p.plan.legs).toHaveLength(2)
    expect(p.plan.legs.map((l) => l.scanIndex)).toEqual([1, 2])
    // The used-up card first, the part-used one last, with the deposit.
    expect(p.plan.legs[0]).toMatchObject({ leftoverCents: 0, depositCents: 0 })
    expect(p.plan.legs[1]).toMatchObject({ leftoverCents: 387, depositCents: 387 })
    expect(p.code).toMatchObject({ scanIndex: 1, scanOf: 2, leftoverCents: 0, depositCents: 0 })

    const [one, two] = p.ref.legs
    // Card 2: held, and not shown.
    expect(kindOf(two?.orderId ?? '', 'pos_hold')).toEqual([expect.objectContaining({ status: 'requires_capture' })])
    expect(kindOf(two?.orderId ?? '', 'pos_bond')).toEqual([expect.objectContaining({ status: 'requires_capture', amount: 387 })])
    expect(await orderRow(two?.orderId ?? '')).toMatchObject({ state: 'paid' })
    expect(await intentRow(two?.intentId ?? '')).toMatchObject({ state: 'matched' })
    // Card 1: its code is out.
    expect(await orderRow(one?.orderId ?? '')).toMatchObject({ state: 'fulfilling' })
    // No plan or code carries a listing or order id.
    expect(JSON.stringify(p.plan)).not.toContain(one?.intentId ?? '_')
    expect(JSON.stringify(p.code)).not.toContain(one?.orderId ?? '_')
  })

  it('Next settles card 1 as worked and opens card 2; Done settles card 2 and lists its rest behind the deposit', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [one, two] = p.ref.legs

    const code2 = await till.nextCardTill(p.ref, 1, tillDeps())
    expect(code2).toMatchObject({ scanIndex: 2, scanOf: 2, leftoverCents: 387, depositCents: 387 })
    expect(kindOf(one?.orderId ?? '', 'pos_hold')[0]?.status).toBe('succeeded')
    expect(await orderRow(one?.orderId ?? '')).toMatchObject({ state: 'fulfilled' })

    const receipt = await till.doneCardTill(p.ref, 2, tillDeps())
    expect(receipt).toEqual({ paidCents: p.plan.costCents, savedCents: 5_613 - p.plan.costCents, depositCents: 387, keptCents: 0 })
    const bond = kindOf(two?.orderId ?? '', 'pos_bond')[0]
    expect(await intentRow(two?.intentId ?? '')).toMatchObject({
      state: 'offered',
      lastKnownBalanceCents: 387,
      failureReason: `REMAINDER|${two?.orderId}|${bond?.id}`,
    })
  })

  it('"Register says paid" closes card 2 unshown: hold released, back on sale as listed, deposit released', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [, two] = p.ref.legs

    const receipt = await till.doneCardTill(p.ref, 1, tillDeps())
    expect(receipt.depositCents).toBe(0)
    expect(kindOf(two?.orderId ?? '', 'pos_hold')[0]?.status).toBe('canceled')
    expect(kindOf(two?.orderId ?? '', 'pos_bond')[0]?.status).toBe('canceled')
    expect(await orderRow(two?.orderId ?? '')).toMatchObject({ state: 'refunded' })
    // Never shown, so nothing about the card changed: on sale again, not retired.
    expect(await intentRow(two?.intentId ?? '')).toMatchObject({ state: 'offered', matchedOrderId: null, failureReason: null })
  })
})

describe('a Pay that does not wait on itself', () => {
  /** Hold every create but card 1's own hold until card 1 is claimed, or 10 s pass; say what card 1 was then. */
  function holdBackOthers(cardOne: string) {
    const seen: Array<{ claimed: boolean; liveWhileHeldBack: boolean }> = []
    const create = fake.paymentIntents.create.bind(fake.paymentIntents)
    ;(fake.paymentIntents as { create: typeof create }).create = async (params, opts) => {
      if (params.metadata?.intent_id !== cardOne || params.metadata?.salvo_kind !== 'pos_hold') {
        let claimed = false
        for (let waited = 0; waited < 10_000 && !claimed; waited += 25) {
          claimed = (await intentRow(cardOne)).state === 'executing'
          if (!claimed) await new Promise((r) => setTimeout(r, 25))
        }
        // Card 1 is open now; give it time to go live, which it must not while this hold is out.
        await new Promise((r) => setTimeout(r, 300))
        const order = (await intentRow(cardOne)).matchedOrderId
        const live = order !== null && (await orderRow(order)).state !== 'paid'
        seen.push({ claimed, liveWhileHeldBack: live })
      }
      return create(params, opts)
    }
    return seen
  }

  it('opens card 1 while card 2 and the deposit are still being held, and shows it only once both have held', async () => {
    const { twenty } = await twoTargetCards()
    const seen = holdBackOthers(twenty.id)
    const p = await pay('target', 5_613)

    // Card 2's hold and the deposit both waited, and card 1 was claimed while they did, but not shown.
    expect(seen).toEqual([
      { claimed: true, liveWhileHeldBack: false },
      { claimed: true, liveWhileHeldBack: false },
    ])
    expect(p.code).toMatchObject({ scanIndex: 1, scanOf: 2 })
    expect(await orderRow(p.ref.legs[0]?.orderId ?? '')).toMatchObject({ state: 'fulfilling' })
  })

  it('a deposit that will not hold while card 1 is open: card 1 was never shown, its hold is released, and it is back on sale as listed', async () => {
    const { twenty, forty } = await twoTargetCards()
    // The decline goes on the deposit's own create, after it was held back.
    const create = fake.paymentIntents.create.bind(fake.paymentIntents)
    ;(fake.paymentIntents as { create: typeof create }).create = (params, opts) => {
      if (params.metadata?.salvo_kind === 'pos_bond') fake.failNext('paymentIntents.create', 'decline')
      return create(params, opts)
    }
    const seen = holdBackOthers(twenty.id)
    const { customerId } = fake.seedBuyer()
    // No plan with no leftover covers $56.13 from a $20 and a $40 card.
    await expect(till.payCardTill({ merchantId: 'target', totalCents: 5_613, preference: null, customerId }, tillDeps())).rejects.toMatchObject({
      code: 'deposit_declined',
    })
    expect(seen.every((s) => s.claimed && !s.liveWhileHeldBack)).toBe(true)

    const cardOneHolds = fake.paymentIntentsForOrder(
      String(
        fake
          .callsTo('paymentIntents.create')
          .map((c) => (c.params as Stripe.PaymentIntentCreateParams).metadata ?? {})
          .find((m) => m.intent_id === twenty.id && m.salvo_kind === 'pos_hold')?.order_id ?? '_',
      ),
    )
    expect(cardOneHolds).toEqual([expect.objectContaining({ status: 'canceled' })])
    const order = cardOneHolds[0]?.metadata?.order_id ?? ''
    // Never on screen: the order never reached fulfilling, and closed with nothing charged.
    expect(await eventsOf(order)).not.toContain('B&M reveal window opened')
    expect((await prisma.orderEvent.findMany({ where: { orderId: order, toState: 'fulfilling' } })).length).toBe(0)
    expect(await orderRow(order)).toMatchObject({ state: 'refunded' })
    for (const id of [twenty.id, forty.id]) {
      expect(await intentRow(id)).toMatchObject({ state: 'offered', matchedOrderId: null, failureReason: null })
    }
    const live = (await prisma.order.findMany()).flatMap((o) => fake.paymentIntentsForOrder(o.id)).filter((pi) => pi.status === 'requires_capture')
    expect(live).toEqual([])
  })

  it('checks card 1\'s hold on the answer its create gave, and reads it afresh only once, last, before the code goes live', async () => {
    await twoTargetCards()
    const before = fake.callsTo('paymentIntents.retrieve').length
    const p = await pay('target', 5_613)
    const reads = fake.callsTo('paymentIntents.retrieve').slice(before)
    const cardOneHold = kindOf(p.ref.legs[0]?.orderId ?? '', 'pos_hold')[0]?.id
    expect(reads.map((c) => (c.params as { id: string }).id)).toEqual([cardOneHold])
  })
})

describe('a purchase read once', () => {
  const eventReads = () => [vi.spyOn(prisma.orderEvent, 'findMany'), vi.spyOn(prisma.orderEvent, 'findFirst'), vi.spyOn(prisma.orderEvent, 'count')]
  const countOf = (spies: ReturnType<typeof eventReads>) => spies.reduce((n, s) => n + s.mock.calls.length, 0)

  it('Pay, Next and Done each read the purchase\'s events a handful of times, not card by card', async () => {
    await twoTargetCards()
    const { customerId } = fake.seedBuyer()

    let spies = eventReads()
    const p = await paid({ merchantId: 'target', totalCents: 5_613, preference: null, customerId })
    // Was 20 (measured 2026-10-13).
    expect(countOf(spies)).toBeLessThanOrEqual(6)
    spies.forEach((s) => s.mockRestore())

    spies = eventReads()
    await till.nextCardTill(p.ref, 1, tillDeps())
    // Was 15.
    expect(countOf(spies)).toBeLessThanOrEqual(10)
    spies.forEach((s) => s.mockRestore())

    spies = eventReads()
    const receipt = await till.doneCardTill(p.ref, 2, tillDeps())
    // Was 20.
    expect(countOf(spies)).toBeLessThanOrEqual(8)
    spies.forEach((s) => s.mockRestore())
    expect(receipt).toEqual({ paidCents: p.plan.costCents, savedCents: 5_613 - p.plan.costCents, depositCents: 387, keptCents: 0 })

    spies = eventReads()
    expect(await till.receiptFor(p.ref)).toEqual(receipt)
    expect(countOf(spies)).toBe(1)
    spies.forEach((s) => s.mockRestore())
  })

  it('answers each question as the one-order readers do: deposits taken and replaced, bills, and whose remainder it is', async () => {
    const { billedCents, billedIn } = await import('@/lib/hold/stripe-hold')
    const { orderEventsFor, spendLegIn } = await import('@/lib/demand/spend-leg')
    const balances = new Balances()
    // A $25 Best Buy card: the register takes $1.00 more than planned, so the
    // deposit pays it and a new one is held for the $2.00 still there.
    const { cardNumber: number } = await listBestBuy(2_500)
    balances.set(number, 2_500)
    const a = await pay('bestbuy', 2_200, tillDeps(balances))
    balances.set(number, 200)
    await till.doneCardTill(a.ref, 1, tillDeps(balances))
    // The next shopper buys what is left.
    const b = await pay('bestbuy', 200, tillDeps(balances))

    const orders = [...a.ref.legs, ...b.ref.legs].map((l) => l.orderId)
    expect(new Set(orders).size).toBe(2)
    const first = orders[0] ?? ''
    expect(await eventsOf(first)).toEqual(expect.arrayContaining([expect.stringMatching(/^DEPOSIT_TAKEN\|/)]))
    expect(await remainder.remainderOfFor(orders[1] ?? '')).toBe(first)
    for (const id of orders) {
      const order = await orderRow(id)
      const ev = await orderEventsFor(id)
      expect(spendLegIn(ev)).toEqual(await spendLegFor(id))
      expect(remainder.depositHoldIn(ev)).toEqual(await remainder.depositHoldFor(id))
      expect(remainder.liveDepositIn(ev)).toEqual(await remainder.liveDepositFor(id))
      const taken = (await eventsOf(id)).filter((r) => r.startsWith('DEPOSIT_TAKEN|')).reduce((n, r) => n + Number(r.split('|')[2]), 0)
      expect(remainder.depositTakenIn(ev)).toBe(taken)
      expect(remainder.remainderOfIn(ev)).toBe(await remainder.remainderOfFor(id))
      expect(billedIn(order, ev)).toBe(await billedCents(order))
    }
  })
})

describe('a tap whose answer was lost', () => {
  it('Pay again with the same key finds the same purchase and sends card 1\'s code again: never a second purchase', async () => {
    await twoTargetCards()
    await twoTargetCards()
    const { customerId } = fake.seedBuyer()
    const input = { merchantId: 'target', totalCents: 5_613, preference: null, customerId, key: 'k'.repeat(24) }

    const first = await paid(input)
    const holds = fake.callsTo('paymentIntents.create').length
    // The answer never reached the phone; the shopper taps Pay again.
    const again = await paid(input)

    expect(again.ref.legs).toEqual(first.ref.legs)
    expect(again.code).toMatchObject({ scanIndex: 1, barcode: first.code.barcode, expiresAt: first.code.expiresAt })
    expect(fake.callsTo('paymentIntents.create').length).toBe(holds)
    expect(await prisma.order.count()).toBe(2)
    // A new key is a new tap: a second purchase, on the other cards.
    const other = await paid({ ...input, key: 'j'.repeat(24) })
    expect(other.ref.legs.map((l) => l.orderId)).not.toEqual(first.ref.legs.map((l) => l.orderId))
  })

  it('a retry that lands while the first tap is still holding its cards waits for it, rather than racing it', async () => {
    await twoTargetCards()
    const { customerId } = fake.seedBuyer()
    const input = { merchantId: 'target', totalCents: 5_613, preference: null, customerId, key: 'r'.repeat(24) }
    let retried: unknown = null
    // The retry arrives as the first tap places its first hold.
    fake.beforeNext('paymentIntents.create', async () => {
      retried = await till.payCardTill(input, tillDeps()).catch((e: unknown) => e)
    })
    const first = await paid(input)
    // Its own code, so the phone keeps the key for the next tap rather than minting a new one.
    expect(retried).toMatchObject({ code: 'still_going', message: expect.stringContaining('You will not pay twice') })
    // The first tap's purchase stands, held once, and the next tap finds it.
    const again = await paid(input)
    expect(again.ref.legs).toEqual(first.ref.legs)
    expect(fake.paymentIntentsForOrder(first.ref.legs[0]?.orderId ?? '').filter((pi) => pi.metadata?.salvo_kind === 'pos_hold')).toHaveLength(1)
  })

  it('a retry while the first tap undoes a declined deposit and buys its drains-only try waits for it: one purchase', async () => {
    // $16.13 two ways: part of a $20 card at 20% off (cheaper, with a $3.87
    // deposit), or all of a $16.13 card at 5% off. Two of those, so a second
    // purchase could be bought.
    await listTarget(2_000, 2_000)
    await listTarget(1_613, 500)
    await listTarget(1_613, 500)
    const { customerId } = fake.seedBuyer()
    const input = { merchantId: 'target', totalCents: 1_613, preference: null, customerId, key: 'u'.repeat(24) }
    let retried: unknown = null
    // The retry lands once the first purchase is undone, while the first tap
    // reads the card again for its drains-only try.
    const arm = (): void =>
      fake.beforeNext('customers.retrieve', async () => {
        const orders = await prisma.order.findMany()
        if (retried === null && orders.length > 0 && orders.every((o) => o.state === 'refunded')) {
          retried = await till.payCardTill(input, tillDeps()).catch((e: unknown) => e)
        } else if (retried === null) arm()
      })
    let armed = false
    const create = fake.paymentIntents.create.bind(fake.paymentIntents)
    ;(fake.paymentIntents as { create: typeof create }).create = (params, opts) => {
      if (params.metadata?.salvo_kind === 'pos_bond') {
        fake.failNext('paymentIntents.create', 'decline')
        if (!armed) {
          armed = true
          arm()
        }
      }
      return create(params, opts)
    }

    const first = await paid(input)
    // The finding: the retry found the undone purchase ended with nothing
    // held, claimed the key afresh, and bought a second purchase.
    expect(retried).toMatchObject({ code: 'still_going', message: expect.stringContaining('You will not pay twice') })
    const live = (await prisma.order.findMany()).filter((o) => o.state !== 'refunded')
    expect(live.map((o) => o.id)).toEqual(first.ref.legs.map((l) => l.orderId))
    // The next tap with the same key finds the purchase that stands.
    const again = await paid(input)
    expect(again.ref.legs).toEqual(first.ref.legs)
  })

  it('Next again sends the next code again, inside its window, instead of refusing', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const code2 = await till.nextCardTill(p.ref, 1, tillDeps())
    const again = await till.nextCardTill(p.ref, 1, tillDeps())
    expect(again).toMatchObject({ scanIndex: 2, barcode: code2.barcode, expiresAt: code2.expiresAt })
  })
})

describe('a page closed before Pay answered', () => {
  it('asks with the same key and finds the purchase; an unknown key buys nothing', async () => {
    await twoTargetCards()
    await twoTargetCards()
    const { customerId } = fake.seedBuyer()
    const input = { merchantId: 'target', totalCents: 5_613, preference: null, customerId, key: 'q'.repeat(24) }
    const first = await paid(input)
    const holds = fake.callsTo('paymentIntents.create').length

    const again = await till.payCardTill({ ...input, resumeOnly: true }, tillDeps())
    if (again.kind !== 'paid') throw new Error('expected the purchase')
    expect(again.paid.ref.legs).toEqual(first.ref.legs)
    expect(again.paid.code).toMatchObject({ scanIndex: 1, barcode: first.code.barcode })
    expect(fake.callsTo('paymentIntents.create').length).toBe(holds)

    await expect(till.payCardTill({ ...input, key: 'z'.repeat(24), resumeOnly: true }, tillDeps())).rejects.toMatchObject({ code: 'closed' })
    expect(await prisma.order.count()).toBe(2)
  })

  it('a purchase that has already ended comes back with its handle, so the phone keeps it for Account', async () => {
    await twoTargetCards()
    const { customerId } = fake.seedBuyer()
    const input = { merchantId: 'target', totalCents: 5_613, preference: null, customerId, key: 'e'.repeat(24) }
    const first = await paid(input)
    // Card 1 went through and the register needed no more; then the page closed.
    await till.doneCardTill(first.ref, 1, tillDeps())

    const again = await till.payCardTill({ ...input, resumeOnly: true }, tillDeps())
    // The finding: "That purchase already went through. Check Account", and
    // nothing for Account to list, since the phone never had its handle.
    expect(again).toMatchObject({ kind: 'ended', message: expect.stringContaining('It is in Account') })
    if (again.kind !== 'ended') throw new Error('expected the ended purchase')
    expect(again.ref.legs).toEqual(first.ref.legs)
    expect(again.plan.legs).toEqual([expect.objectContaining({ scanIndex: 1 })])
  })

  it('a purchase whose first card went through comes back on the next card not yet shown', async () => {
    await twoTargetCards()
    const { customerId } = fake.seedBuyer()
    const input = { merchantId: 'target', totalCents: 5_613, preference: null, customerId, key: 'n'.repeat(24) }
    const first = await paid(input)
    // Card 1 is settled by silence, card 2 was never shown, and the answer was lost.
    await resolveStaleReveals({ vault: new LocalEnvelopeVault(), readerFor: () => ({ read: async () => ({ balanceCents: null }) }), now: later(revealWindowMs() + STALE_REVEAL_GRACE_MS + 60_000) })
    expect(await orderRow(first.ref.legs[0]?.orderId ?? '')).toMatchObject({ state: 'fulfilled' })
    expect(await orderRow(first.ref.legs[1]?.orderId ?? '')).toMatchObject({ state: 'paid' })

    const again = await till.payCardTill({ ...input, resumeOnly: true }, tillDeps())
    // It used to send card 1 again, which had gone through, and refuse.
    expect(again).toMatchObject({ kind: 'paid', paid: { code: { scanIndex: 2, scanOf: 2 } } })
  })
})

describe('the receipt route', () => {
  it('says what a purchase came to, a card settled by silence included', async () => {
    await listTarget(2_000)
    const mine = fake.seedBuyer().customerId
    const cookie = { cookie: `salvo_card=${encodeURIComponent(mintCardCookie(mine))}` }
    const post = (path: string, body: unknown) =>
      new Request(`${APP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: APP, ...cookie }, body: JSON.stringify(body) })
    const paidRes = await payRoute.POST(post('/api/card/till/pay', { store: 'target', totalCents: 2_000 }))
    const { purchase } = (await paidRes.json()) as { purchase: string }
    // The shopper pockets the phone: no Done. Silence settles it after the window.
    await resolveStaleReveals({ vault: new LocalEnvelopeVault(), readerFor: () => ({ read: async () => ({ balanceCents: null }) }), now: later(revealWindowMs() + STALE_REVEAL_GRACE_MS + 60_000) })
    const res = await receiptRoute.POST(post('/api/card/till/receipt', { purchase }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ receipt: { paidCents: 1_600, savedCents: 400 } })
  })
})

describe('the price on the button', () => {
  it('a plan that costs more than the button said is not bought: nothing is held, and the new price comes back', async () => {
    await twoTargetCards()
    const { customerId } = fake.seedBuyer()
    const q = await till.quoteCardTill({ merchantId: 'target', totalCents: 5_613, preference: null })
    if ('unavailable' in q) throw new Error(q.unavailable)

    const out = await till.payCardTill(
      { merchantId: 'target', totalCents: 5_613, preference: null, customerId, ceiling: { costCents: q.costCents - 1, cards: 2, depositCents: 387 } },
      tillDeps(),
    )
    expect(out).toMatchObject({ kind: 'requote', plan: { costCents: q.costCents, totalCents: 5_613 } })
    expect(fake.callsTo('paymentIntents.create')).toEqual([])
    expect(await prisma.order.count()).toBe(0)

    // The same tap at the price now shown buys it.
    const ok = await paid({ merchantId: 'target', totalCents: 5_613, preference: null, customerId, ceiling: { costCents: q.costCents, cards: 2, depositCents: 387 } })
    expect(ok.plan.costCents).toBe(q.costCents)
  })

  it('a card that will not hold the deposit gets the full-drain plan as a new price, and the next tap buys it with no deposit asked', async () => {
    // $16.13 two ways: part of a $20 card at 20% off (cheaper), or all of a
    // $16.13 card at 5% off.
    await listTarget(2_000, 2_000)
    const exact = await listTarget(1_613, 500)
    const create = fake.paymentIntents.create.bind(fake.paymentIntents)
    ;(fake.paymentIntents as { create: typeof create }).create = (params, opts) => {
      if (params.metadata?.salvo_kind === 'pos_bond') fake.failNext('paymentIntents.create', 'decline')
      return create(params, opts)
    }
    const { customerId } = fake.seedBuyer()
    const q = await till.quoteCardTill({ merchantId: 'target', totalCents: 1_613, preference: null })
    if ('unavailable' in q) throw new Error(q.unavailable)
    const out = await till.payCardTill(
      { merchantId: 'target', totalCents: 1_613, preference: null, customerId, ceiling: { costCents: q.costCents, cards: 1, depositCents: q.depositCents } },
      tillDeps(),
    )
    if (out.kind !== 'requote') throw new Error('expected a new price')
    expect(out.message).toMatch(/would not hold the \$3\.87 deposit/)
    expect(out.plan).toMatchObject({ depositCents: 0 })
    expect(till.quotedDrainsOnly(out.plan.quoteRef)).toBe(true)
    // Nothing is held from the first tap.
    const live = (await prisma.order.findMany()).flatMap((o) => fake.paymentIntentsForOrder(o.id)).filter((pi) => pi.status === 'requires_capture')
    expect(live).toEqual([])

    const bonds = () => fake.callsTo('paymentIntents.create').filter((c) => JSON.stringify(c).includes('pos_bond')).length
    const before = bonds()
    const bought = await paid({
      merchantId: 'target',
      totalCents: 1_613,
      preference: null,
      customerId,
      ceiling: { costCents: out.plan.costCents, cards: out.plan.legs.length, depositCents: 0 },
      drainsOnly: true,
    })
    expect(bought.ref.legs.map((l) => l.intentId)).toEqual([exact.id])
    expect(bonds()).toBe(before)
  })
})

describe('when a card does not work', () => {
  it('"It didn\'t scan" at Target keeps the hold, says so, puts the card first in line, and plans the rest', async () => {
    await twoTargetCards()
    // A second pair, so the rest can be covered without this purchase's cards.
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [one, two] = p.ref.legs

    const out = await till.reportCardTill(p.ref, 1, 'didnt_scan', null, tillDeps())
    // Card 1's hold is kept, its card first in line for the next shopper, and the answer says so.
    expect(kindOf(one?.orderId ?? '', 'pos_hold')[0]?.status).toBe('requires_capture')
    expect(await intentRow(one?.intentId ?? '')).toMatchObject({ state: 'offered', failureReason: `UNSCANNED|${one?.orderId}` })
    expect(out.kept).toEqual({ cents: (await orderRow(one?.orderId ?? '')).priceCents, until: 'next_shopper' })
    // Card 2 never showed: released, and its deposit.
    expect(kindOf(two?.orderId ?? '', 'pos_hold')[0]?.status).toBe('canceled')
    expect(kindOf(two?.orderId ?? '', 'pos_bond')[0]?.status).toBe('canceled')
    // The whole total is still owed.
    expect(out.owedCents).toBe(5_613)
    expect(out.owed).toMatchObject({ totalCents: 5_613 })

    // The receipt holds the kept card apart: not paid, and not saved on.
    const receipt = await till.receiptFor(p.ref)
    expect(receipt).toEqual({ paidCents: 0, savedCents: 0, depositCents: 0, keptCents: out.kept?.cents })

    // "Pay $X more" never routes the kept card back to the shopper behind it.
    const more = await paid(
      { merchantId: 'target', totalCents: 5_613, preference: null, customerId: p.customerId, excludeIntentIds: await till.shownLegIntentIds(p.ref) },
      tillDeps(),
    )
    expect(more.ref.legs.map((l) => l.intentId)).not.toContain(one?.intentId)
  })

  it('the rest is planned with the cards never shown back in the pool, so a card just closed can cover it', async () => {
    // $35, $20, $20 at Target. $52.13 is a $20 card used up and the $35 one part used.
    const big = await listTarget(3_500)
    await listTarget(2_000)
    await listTarget(2_000)
    const p = await pay('target', 5_213)
    expect(p.ref.legs[1]?.intentId).toBe(big.id)

    const out = await till.reportCardTill(p.ref, 1, 'declined', null, tillDeps())
    // Only the $35 card and the other $20 card are left: together they cover it.
    expect(out.owed).toMatchObject({ totalCents: 5_213 })
    const more = await paid(
      { merchantId: 'target', totalCents: 5_213, preference: null, customerId: p.customerId, excludeIntentIds: await till.shownLegIntentIds(p.ref) },
      tillDeps(),
    )
    expect(more.ref.legs.map((l) => l.intentId)).toContain(big.id)
  })

  it('nothing on sale covers the rest: says what the register still needs, and holds nothing more', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const out = await till.reportCardTill(p.ref, 1, 'declined', null, tillDeps())
    expect(out.owedCents).toBe(5_613)
    expect(out.owed).toEqual({ unavailable: 'We cannot cover $56.13 at this store right now.' })
  })

  it('a report whose answer was lost, sent again, works out the same rest and settles nothing twice', async () => {
    await twoTargetCards()
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const first = await till.reportCardTill(p.ref, 1, 'didnt_scan', null, tillDeps())
    const again = await till.reportCardTill(p.ref, 1, 'didnt_scan', null, tillDeps())
    expect(again).toMatchObject({ owedCents: first.owedCents, kept: first.kept })
    expect(fake.callsTo('paymentIntents.capture')).toEqual([])
  })

  it('a card already settled cannot be reported as not working, but a person can be told inside 48 hours', async () => {
    await listTarget(2_000)
    const p = await pay('target', 2_000)
    await till.doneCardTill(p.ref, 1, tillDeps())
    await expect(till.reportCardTill(p.ref, 1, 'declined', null, tillDeps())).rejects.toMatchObject({ code: 'closed' })

    const out = await till.reportCardTill(p.ref, 1, 'problem', null, tillDeps())
    expect(out).toMatchObject({ owed: null, kept: null, note: expect.stringContaining('A person will look at this card') })
    expect((await eventsOf(p.ref.legs[0]?.orderId ?? '')).some((r) => r.startsWith('BUYER_EVIDENCE|failed|'))).toBe(true)
    expect(vi.mocked(pushOperator).mock.calls.map(([o]) => o.title)).toContain('[ACTION NEEDED] till shopper reports a problem with a card')
    await expect(till.reportCardTill(p.ref, 1, 'problem', null, tillDeps(null, later(49 * 3600_000)))).rejects.toMatchObject({ code: 'closed' })
  })
})

describe('the till\'s own sentences', () => {
  it('never ask for another total: the register\'s is the one there is', async () => {
    await listTarget(2_500)
    await listTarget(10_000)
    const none = await till.quoteCardTill({ merchantId: 'target', totalCents: 6_000, preference: null })
    expect(none).toEqual({ unavailable: 'We cannot cover $60.00 at this store right now.' })
    const short = await till.quoteCardTill({ merchantId: 'target', totalCents: 90_000, preference: null })
    expect('unavailable' in short && short.unavailable).not.toMatch(/try|smaller|round|different amount/i)
  })

  it('say nothing is listed, with a flag the screen keys on rather than the words', async () => {
    expect(await till.quoteCardTill({ merchantId: 'target', totalCents: 2_000, preference: null })).toEqual({
      unavailable: 'Nothing is listed for this store right now.',
      nothingListed: true,
    })
  })
})

describe('where the store lets us read', () => {
  it('the first shopper\'s own read bills less when the card paid less, behind a new deposit for all that is left', async () => {
    const balances = new Balances()
    // A $25 Best Buy card at 4% off: $24.00 for all of it.
    const { listing, cardNumber: number } = await listBestBuy(2_500)
    balances.set(number, 2_500)
    const p = await pay('bestbuy', 2_200, tillDeps(balances))
    const order = p.ref.legs[0]?.orderId ?? ''
    const old = kindOf(order, 'pos_bond')[0]
    expect(old).toMatchObject({ amount: 300 })
    // The register took $20.00, not $22.00: $5.00 is left, within the $10 cap.
    balances.set(number, 500)
    await till.doneCardTill(p.ref, 1, tillDeps(balances))
    // ceil(2000 * 2400 / 2500): the price of what the card paid.
    expect(kindOf(order, 'pos_hold')[0]).toMatchObject({ status: 'succeeded', amount_received: 1_920 })
    expect(await eventsOf(order)).toContain('BILL|1920')
    // The $5.00 has a deposit for all of it, at face, and the $3.00 one is released.
    const fresh = kindOf(order, 'pos_bond').find((b) => b.id !== old?.id)
    expect(fresh).toMatchObject({ status: 'requires_capture', amount: 500 })
    expect(fake.paymentIntent(old?.id ?? '').status).toBe('canceled')
    expect(await intentRow(listing.id)).toMatchObject({ state: 'offered', lastKnownBalanceCents: 500, failureReason: `REMAINDER|${order}|${fresh?.id}` })
  })

  it('within the cap, a deposit for all that is left that cannot be held: billed as planned, the old deposit behind what the plan left', async () => {
    const balances = new Balances()
    // A $25 Best Buy card at 4% off: $22.00 planned, $3.00 left behind a $3.00 deposit.
    const { listing, cardNumber: number } = await listBestBuy(2_500)
    balances.set(number, 2_500)
    const p = await pay('bestbuy', 2_200, tillDeps(balances))
    const order = p.ref.legs[0]?.orderId ?? ''
    const old = kindOf(order, 'pos_bond')[0]
    expect(old).toMatchObject({ amount: 300 })
    // The register took $20.00, and the shopper's card will not hold $5.00.
    balances.set(number, 500)
    fake.failNext('paymentIntents.create', 'decline')
    const receipt = await till.doneCardTill(p.ref, 1, tillDeps(balances))
    // The finding: billed $19.20 for $20.00, the $5.00 retired on a seen number.
    expect(kindOf(order, 'pos_hold')[0]).toMatchObject({ status: 'succeeded', amount_received: 2_112 })
    expect(fake.paymentIntent(old?.id ?? '').status).toBe('requires_capture')
    expect(await intentRow(listing.id)).toMatchObject({ state: 'offered', lastKnownBalanceCents: 300, failureReason: `REMAINDER|${order}|${old?.id}` })
    expect((await eventsOf(order)).some((r) => r.startsWith('REMAINDER_RETIRED|'))).toBe(false)
    expect(receipt).toMatchObject({ paidCents: 2_112, depositCents: 300 })
  })

  it('past the cap only with what the plan left: billed as planned, and the next shopper buys the plan\'s rest behind the old deposit', async () => {
    const balances = new Balances()
    // A $25 Best Buy card at 4% off: $22.00 planned, $3.00 left behind a $3.00 deposit.
    const { listing, cardNumber: number } = await listBestBuy(2_500)
    balances.set(number, 2_500)
    const a = await pay('bestbuy', 2_200, tillDeps(balances))
    const order = a.ref.legs[0]?.orderId ?? ''
    const old = kindOf(order, 'pos_bond')[0]
    // The register took $14.90: $10.10 left, past the $10 cap, $7.10 of it already paid for.
    balances.set(number, 1_010)
    await till.doneCardTill(a.ref, 1, tillDeps(balances))
    expect(kindOf(order, 'pos_hold')[0]).toMatchObject({ status: 'succeeded', amount_received: 2_112 })
    expect(kindOf(order, 'pos_bond')).toHaveLength(1)
    expect(await intentRow(listing.id)).toMatchObject({ state: 'offered', lastKnownBalanceCents: 300, failureReason: `REMAINDER|${order}|${old?.id}` })

    // The next shopper's $3.00 opens on it, and their read proves the rest: the deposit comes back.
    const b = await pay('bestbuy', 300, tillDeps(balances))
    expect(b.ref.legs[0]?.intentId).toBe(listing.id)
    expect(fake.paymentIntent(old?.id ?? '').status).toBe('canceled')
  })

  it('a $60 card used for $1, past the cap: billed as planned, no deposit asked, and the card is theirs', async () => {
    const balances = new Balances()
    // A $60 Best Buy card at 4% off, all of it planned: $57.60, no deposit.
    const { listing, cardNumber: number } = await listBestBuy(6_000)
    balances.set(number, 6_000)
    const p = await pay('bestbuy', 6_000, tillDeps(balances))
    const order = p.ref.legs[0]?.orderId ?? ''
    expect(p.plan).toMatchObject({ depositCents: 0, costCents: 5_760 })
    // The register took $1.00. $59.00 is left, past the $10 cap.
    balances.set(number, 5_900)
    const receipt = await till.doneCardTill(p.ref, 1, tillDeps(balances))
    // The finding: billed 96 cents, and the $59 listed behind a deposit
    // released a day before it lapses, or retired when none could be held.
    expect(kindOf(order, 'pos_hold')[0]).toMatchObject({ status: 'succeeded', amount_received: 5_760 })
    expect(kindOf(order, 'pos_bond')).toEqual([])
    expect(await intentRow(listing.id)).toMatchObject({ state: 'completed' })
    expect((await eventsOf(order)).some((r) => r.startsWith('REMAINDER_RETIRED|'))).toBe(false)
    expect(receipt).toMatchObject({ paidCents: 5_760, savedCents: 240, depositCents: 0 })
  })

  it('a $150 card typed whole and used for $1, with a deposit the allowance cannot hold: never 90 cents, never a loss', async () => {
    const balances = new Balances()
    // A $150 Best Buy card at 10% off: Pay holds $135.00.
    const { listing, cardNumber: number } = await listBestBuy(15_000, 1_000)
    balances.set(number, 15_000)
    const p = await pay('bestbuy', 15_000, tillDeps(balances))
    const order = p.ref.legs[0]?.orderId ?? ''
    expect(p.plan).toMatchObject({ depositCents: 0, costCents: 13_500 })
    // A $1.00 item. A $149.00 deposit beside the $135.00 hold is past the $200 allowance.
    balances.set(number, 14_900)
    const receipt = await till.doneCardTill(p.ref, 1, tillDeps(balances))
    expect(kindOf(order, 'pos_hold')[0]).toMatchObject({ status: 'succeeded', amount_received: 13_500 })
    expect(fake.callsTo('paymentIntents.create').filter((c) => JSON.stringify(c).includes('pos_bond'))).toEqual([])
    expect(await intentRow(listing.id)).toMatchObject({ state: 'completed' })
    expect((await eventsOf(order)).some((r) => r.startsWith('REMAINDER_RETIRED|'))).toBe(false)
    expect(vi.mocked(pushOperator).mock.calls.map(([o]) => o.title)).not.toContain(
      '[ACTION NEEDED] the rest of a till card was retired with nothing behind it',
    )
    expect(receipt).toMatchObject({ paidCents: 13_500, depositCents: 0 })
  })

  it('past the cap with a deposit: billed whole, the price of what the plan left taken from that deposit, and nothing listed', async () => {
    const balances = new Balances()
    // A $55 Best Buy card at 4% off: $50.00 planned for $48.00, $5.00 left behind a $5.00 deposit.
    const { listing, cardNumber: number } = await listBestBuy(5_500)
    balances.set(number, 5_500)
    const p = await pay('bestbuy', 5_000, tillDeps(balances))
    const order = p.ref.legs[0]?.orderId ?? ''
    const bond = kindOf(order, 'pos_bond')[0]
    expect(bond).toMatchObject({ amount: 500 })
    // The register took $10.00: $45.00 left, past the cap.
    balances.set(number, 4_500)
    const receipt = await till.doneCardTill(p.ref, 1, tillDeps(balances))
    // The finding: billed $9.60, the $45 listed behind a new $45 deposit.
    expect(kindOf(order, 'pos_hold')[0]).toMatchObject({ status: 'succeeded', amount_received: 4_800 })
    expect(kindOf(order, 'pos_bond')).toHaveLength(1)
    expect(fake.paymentIntent(bond?.id ?? '')).toMatchObject({ status: 'succeeded', amount_received: 480 })
    expect(await intentRow(listing.id)).toMatchObject({ state: 'completed' })
    expect(receipt).toMatchObject({ paidCents: 5_280, savedCents: 220, depositCents: 0 })
  })

  it('a full drain that left $5 within the cap is billed for $55 and the $5 listed behind a deposit placed then', async () => {
    const balances = new Balances()
    const { listing, cardNumber: number } = await listBestBuy(6_000)
    balances.set(number, 6_000)
    const p = await pay('bestbuy', 6_000, tillDeps(balances))
    const order = p.ref.legs[0]?.orderId ?? ''
    expect(kindOf(order, 'pos_bond')).toEqual([])
    balances.set(number, 500)
    await till.doneCardTill(p.ref, 1, tillDeps(balances))
    expect(kindOf(order, 'pos_hold')[0]).toMatchObject({ status: 'succeeded', amount_received: 5_280 })
    const bond = kindOf(order, 'pos_bond')[0]
    expect(bond).toMatchObject({ status: 'requires_capture', amount: 500 })
    expect(await intentRow(listing.id)).toMatchObject({ state: 'offered', lastKnownBalanceCents: 500, failureReason: `REMAINDER|${order}|${bond?.id}` })
  })

  it('takes the excess from the first shopper\'s own deposit when the card paid more, holding a new one for the rest first', async () => {
    const balances = new Balances()
    // A $25 Best Buy card at 4% off: $24.00 for all of it.
    const { listing, cardNumber: number } = await listBestBuy(2_500)
    balances.set(number, 2_500)
    const p = await pay('bestbuy', 2_200, tillDeps(balances))
    const order = p.ref.legs[0]?.orderId ?? ''
    const bond = kindOf(order, 'pos_bond')[0]
    expect(bond).toMatchObject({ amount: 300 })
    // The register took $23.00, $1.00 more than the plan applied.
    balances.set(number, 200)
    await till.doneCardTill(p.ref, 1, tillDeps(balances))
    expect(kindOf(order, 'pos_hold')[0]).toMatchObject({ status: 'succeeded', amount_received: 2_112 })
    // ceil(100 * 2400 / 2500) from the deposit, and the rest of it released.
    expect(fake.paymentIntent(bond?.id ?? '')).toMatchObject({ status: 'succeeded', amount_received: 96 })
    expect(await eventsOf(order)).toContain(`DEPOSIT_TAKEN|${bond?.id}|96|1|-`)
    // The $2.00 still there is on sale behind a new deposit for all of it: the
    // finding left it with none, to a shopper who knows its number.
    const fresh = kindOf(order, 'pos_bond').find((b) => b.id !== bond?.id)
    expect(fresh).toMatchObject({ status: 'requires_capture', amount: 200 })
    expect(await intentRow(listing.id)).toMatchObject({ state: 'offered', lastKnownBalanceCents: 200, failureReason: `REMAINDER|${order}|${fresh?.id}` })
  })

  it('takes nothing for an excess under the smallest charge: written off, and the deposit stays behind the rest', async () => {
    const balances = new Balances()
    const { listing, cardNumber: number } = await listBestBuy(2_500)
    balances.set(number, 2_500)
    const p = await pay('bestbuy', 2_200, tillDeps(balances))
    const order = p.ref.legs[0]?.orderId ?? ''
    const bond = kindOf(order, 'pos_bond')[0]
    // The register took 5c more than the plan applied: its price is 5c.
    balances.set(number, 295)
    await till.doneCardTill(p.ref, 1, tillDeps(balances))
    expect(fake.paymentIntent(bond?.id ?? '')).toMatchObject({ status: 'requires_capture', amount_received: 0 })
    expect(await eventsOf(order)).toContain(`DEPOSIT_UNCHARGED|${bond?.id}|5`)
    expect(await intentRow(listing.id)).toMatchObject({ state: 'offered', failureReason: `REMAINDER|${order}|${bond?.id}` })
  })

  it('the next shopper\'s read proves the rest, and the deposit comes back at once', async () => {
    const balances = new Balances()
    // A $25 Best Buy card at 4% off: $24.00 for all of it.
    const { listing, cardNumber: number } = await listBestBuy(2_500)
    balances.set(number, 2_500)
    const a = await pay('bestbuy', 2_200, tillDeps(balances))
    const aOrder = a.ref.legs[0]?.orderId ?? ''
    balances.set(number, 300)
    await till.doneCardTill(a.ref, 1, tillDeps(balances))
    const bond = kindOf(aOrder, 'pos_bond')[0]
    expect(fake.paymentIntent(bond?.id ?? '').status).toBe('requires_capture')

    const b = await pay('bestbuy', 300, tillDeps(balances))
    expect(b.ref.legs[0]?.intentId).toBe(listing.id)
    expect(fake.paymentIntent(bond?.id ?? '').status).toBe('canceled')
    expect(await eventsOf(aOrder)).toContain(`DEPOSIT_RETURNED|${bond?.id}`)
  })

  it('the next shopper\'s read finds it short: they are refunded, and the deposit pays what is missing', async () => {
    const balances = new Balances()
    // A $25 Best Buy card at 4% off: $24.00 for all of it.
    const { cardNumber: number } = await listBestBuy(2_500)
    balances.set(number, 2_500)
    const a = await pay('bestbuy', 2_200, tillDeps(balances))
    const aOrder = a.ref.legs[0]?.orderId ?? ''
    balances.set(number, 300)
    await till.doneCardTill(a.ref, 1, tillDeps(balances))
    const bond = kindOf(aOrder, 'pos_bond')[0]

    // Someone spent $1.20 of it after A's clean read.
    balances.set(number, 180)
    const { customerId } = fake.seedBuyer()
    await expect(
      till.payCardTill({ merchantId: 'bestbuy', totalCents: 300, preference: null, customerId }, tillDeps(balances)),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(fake.paymentIntent(bond?.id ?? '')).toMatchObject({ status: 'succeeded', amount_received: 120 })
    // After a clean read of A's own, the loss is not counted against A.
    expect(await eventsOf(aOrder)).toContain(`DEPOSIT_TAKEN|${bond?.id}|120|0|-`)
  })
})

describe('when the total changes', () => {
  it('down, with card 2 not shown: card 2 is closed, and nothing more is owed', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [one, two] = p.ref.legs
    const covered = (await spendLegFor(one?.orderId ?? ''))?.appliedCents ?? 0

    const out = await till.changeCardTill(p.ref, covered, null, SECRET, tillDeps())
    expect(out.plan).toBeNull()
    expect(out.ref.totalCents).toBe(covered)
    expect(kindOf(two?.orderId ?? '', 'pos_hold')[0]?.status).toBe('canceled')
    expect(await intentRow(two?.intentId ?? '')).toMatchObject({ state: 'offered' })
    // The purchase as it stands: the one card shown, at the new total.
    expect(out.purchasePlan).toMatchObject({ totalCents: covered, legs: [expect.objectContaining({ scanIndex: 1 })] })
    expect(out.cover).toEqual({ scanIndex: 1, coversCents: covered, leftoverCents: 0, depositCents: 0 })
  })

  it('down below the card on screen, within the cap: billed less, behind a deposit for its new leftover, and the screen told', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [one] = p.ref.legs
    const leg = await spendLegFor(one?.orderId ?? '')
    const applied = leg?.appliedCents ?? 0

    const out = await till.changeCardTill(p.ref, applied - 200, null, SECRET, tillDeps())
    expect(out.plan).toBeNull()
    expect(await spendLegFor(one?.orderId ?? '')).toMatchObject({ appliedCents: applied - 200, leftoverCents: 200 })
    const bond = kindOf(one?.orderId ?? '', 'pos_bond')[0]
    expect(bond).toMatchObject({ status: 'requires_capture', amount: 200 })
    expect(out.cover).toEqual({ scanIndex: 1, coversCents: applied - 200, leftoverCents: 200, depositCents: 200 })

    await till.doneCardTill(out.ref, 1, tillDeps())
    const intent = await intentRow(one?.intentId ?? '')
    const price = Math.ceil(((applied - 200) * intent.priceCents) / intent.faceValueCents)
    expect(kindOf(one?.orderId ?? '', 'pos_hold')[0]).toMatchObject({ status: 'succeeded', amount_received: price })
    expect(intent).toMatchObject({ state: 'offered', lastKnownBalanceCents: 200, failureReason: `REMAINDER|${one?.orderId}|${bond?.id}` })
  })

  it('down by more than the cap leaves on the card: the card must not be scanned, and nothing about it changed', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [one] = p.ref.legs
    const applied = (await spendLegFor(one?.orderId ?? ''))?.appliedCents ?? 0
    const out = await till.changeCardTill(p.ref, applied - 600, null, SECRET, tillDeps())
    expect(out.tooLow).toBe(true)
    expect(out.notNeeded).toBe(false)
    expect(out.plan).toMatchObject({ unavailable: expect.stringContaining('Use other cards') })
    expect(await spendLegFor(one?.orderId ?? '')).toMatchObject({ appliedCents: applied })

    // "Use other cards": it is reported not used, so its hold is kept at Target, and the new total is planned.
    const report = await till.reportCardTill(out.ref, 1, 'not_used', null, tillDeps())
    expect(report.kept).toMatchObject({ until: 'next_shopper' })
    expect(report.owedCents).toBe(applied - 600)
  })

  it('down, with a remainder on screen: it is used in full or not at all, so it is not scanned, and nothing about it changed', async () => {
    await twoTargetCards()
    const a = await pay('target', 5_613)
    await till.nextCardTill(a.ref, 1, tillDeps())
    await till.doneCardTill(a.ref, 2, tillDeps())
    const aBond = kindOf(a.ref.legs[1]?.orderId ?? '', 'pos_bond')[0]

    // The next shopper's $3.87 takes the remainder whole.
    const b = await pay('target', 387)
    const [leg] = b.ref.legs
    expect(leg?.intentId).toBe(a.ref.legs[1]?.intentId)
    const out = await till.changeCardTill(b.ref, 300, null, SECRET, tillDeps())
    expect(out).toMatchObject({ tooLow: true, notNeeded: false, plan: { unavailable: expect.stringContaining('used in full') } })
    expect(await spendLegFor(leg?.orderId ?? '')).toMatchObject({ appliedCents: 387, leftoverCents: 0 })
    expect(kindOf(leg?.orderId ?? '', 'pos_bond')).toEqual([])
    // The first shopper's deposit still stands behind it, untouched.
    expect(fake.paymentIntent(aBond?.id ?? '').status).toBe('requires_capture')
  })

  it('down, with a card on screen that a kept hold stands behind: used in full or not at all', async () => {
    await twoTargetCards()
    const a = await pay('target', 5_613)
    const [one] = a.ref.legs
    await till.reportCardTill(a.ref, 1, 'didnt_scan', null, tillDeps())
    const kept = kindOf(one?.orderId ?? '', 'pos_hold')[0]
    const face = (await intentRow(one?.intentId ?? '')).faceValueCents

    const b = await pay('target', face)
    const [leg] = b.ref.legs
    expect(leg?.intentId).toBe(one?.intentId)
    const out = await till.changeCardTill(b.ref, face - 200, null, SECRET, tillDeps())
    expect(out).toMatchObject({ tooLow: true, plan: { unavailable: expect.stringContaining('used in full') } })
    expect(await spendLegFor(leg?.orderId ?? '')).toMatchObject({ appliedCents: face, leftoverCents: 0 })
    expect(kindOf(leg?.orderId ?? '', 'pos_bond')).toEqual([])
    expect(fake.paymentIntent(kept?.id ?? '').status).toBe('requires_capture')
  })

  it('too low by a typo, then the right total: the second change plans it as if the first never was', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [one] = p.ref.legs
    // They mean $55.13 and type $5.13.
    const typo = await till.changeCardTill(p.ref, 513, null, SECRET, tillDeps())
    expect(typo).toMatchObject({ tooLow: true, notNeeded: false })
    expect(await spendLegFor(one?.orderId ?? '')).toMatchObject({ appliedCents: 2_000, leftoverCents: 0 })
    // "The total changed" again, from the screen that says not to scan it.
    const right = await till.changeCardTill(typo.ref, 5_513, null, SECRET, tillDeps())
    expect(right).toMatchObject({ tooLow: false, cover: { scanIndex: 1, coversCents: 2_000 } })
    expect(right.plan).toMatchObject({ totalCents: 3_513 })
    expect(right.ref.totalCents).toBe(5_513)
  })

  it('up, with the part-used card on screen: its rest is used whole, paid from the deposit', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [, two] = p.ref.legs
    await till.nextCardTill(p.ref, 1, tillDeps())
    const bond = kindOf(two?.orderId ?? '', 'pos_bond')[0]

    const out = await till.changeCardTill(p.ref, 6_000, null, SECRET, tillDeps())
    expect(out.plan).toBeNull()
    expect(await spendLegFor(two?.orderId ?? '')).toMatchObject({ leftoverCents: 0 })
    // Nothing is taken before the register has taken the card.
    expect(fake.paymentIntent(bond?.id ?? '')).toMatchObject({ status: 'requires_capture', amount_received: 0 })
    expect(fake.callsTo('paymentIntents.capture').filter((c) => JSON.stringify(c).includes(bond?.id ?? '_'))).toEqual([])
    const intent = await intentRow(two?.intentId ?? '')
    const before = p.plan.legs[1]?.appliedCents ?? 0
    const card = before + 387
    const extra = Math.ceil((card * intent.priceCents) / intent.faceValueCents) - Math.ceil((before * intent.priceCents) / intent.faceValueCents)

    // What the deposit paid is paid: it is on the receipt, and not counted as saved.
    const receipt = await till.doneCardTill(out.ref, 2, tillDeps())
    expect(fake.paymentIntent(bond?.id ?? '')).toMatchObject({ status: 'succeeded', amount_received: extra })
    expect(await eventsOf(two?.orderId ?? '')).toContain(`DEPOSIT_TAKEN|${bond?.id}|${extra}|0|-`)
    expect((await intentRow(two?.intentId ?? '')).state).toBe('completed')
    expect(receipt.paidCents).toBe(p.plan.costCents + extra)
    expect(receipt.savedCents).toBe(6_000 - (p.plan.costCents + extra))
  })

  it('up by less than the leftover: what is still left gets its own deposit first, and goes back on sale behind it', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [, two] = p.ref.legs
    await till.nextCardTill(p.ref, 1, tillDeps())
    const old = kindOf(two?.orderId ?? '', 'pos_bond')[0]

    // $1.00 more: the card covers $17.13 of its $20, leaving $2.87.
    const out = await till.changeCardTill(p.ref, 5_713, null, SECRET, tillDeps())
    expect(out.plan).toBeNull()
    expect(out.cover).toMatchObject({ scanIndex: 2, leftoverCents: 287, depositCents: 287 })
    // Nothing moves until the card has worked.
    expect(fake.paymentIntent(old?.id ?? '').status).toBe('requires_capture')
    expect(kindOf(two?.orderId ?? '', 'pos_bond')).toHaveLength(1)

    await till.doneCardTill(out.ref, 2, tillDeps())
    // The price of the $1.00, ceil(1713 * 0.8) - ceil(1613 * 0.8), from the old deposit, at release.
    expect(fake.paymentIntent(old?.id ?? '')).toMatchObject({ status: 'succeeded', amount_received: 80 })
    const fresh = kindOf(two?.orderId ?? '', 'pos_bond').find((b) => b.id !== old?.id)
    expect(fresh).toMatchObject({ status: 'requires_capture', amount: 287 })
    // The $2.87 the shopper has seen is never on sale with nothing behind it.
    expect(await intentRow(two?.intentId ?? '')).toMatchObject({
      state: 'offered',
      lastKnownBalanceCents: 287,
      failureReason: `REMAINDER|${two?.orderId}|${fresh?.id}`,
    })
  })

  it('up by less than the leftover, and the take from the old deposit fails for a moment: the hold sweep finishes it, never cancels it', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [, two] = p.ref.legs
    await till.nextCardTill(p.ref, 1, tillDeps())
    const old = kindOf(two?.orderId ?? '', 'pos_bond')[0]
    const out = await till.changeCardTill(p.ref, 5_713, null, SECRET, tillDeps())
    // Card 2's own capture lands; the take from the old deposit does not.
    fake.failNext('paymentIntents.capture', 'connection', { after: 1 })
    await till.doneCardTill(out.ref, 2, tillDeps())
    expect(fake.paymentIntent(old?.id ?? '')).toMatchObject({ status: 'requires_capture', amount_received: 0 })
    // Decided before the money: the sweep finishes it from here.
    expect(await eventsOf(two?.orderId ?? '')).toContain(`DEPOSIT_OWED|${old?.id}|80|0|-`)

    await resolveHolds({ runKey: 'run-owed', now: later(20 * 60_000) })
    // The finding: the orphan rule cancelled it as a stray, so the $1.00 the
    // card covered past its hold was never charged.
    expect(fake.paymentIntent(old?.id ?? '')).toMatchObject({ status: 'succeeded', amount_received: 80 })
    expect(await eventsOf(two?.orderId ?? '')).toContain(`DEPOSIT_TAKEN|${old?.id}|80|0|-`)
    // The new deposit, behind the rest of the card on sale, is untouched.
    const fresh = kindOf(two?.orderId ?? '', 'pos_bond').find((b) => b.id !== old?.id)
    expect(fresh?.status).toBe('requires_capture')
    expect(await intentRow(two?.intentId ?? '')).toMatchObject({ state: 'offered', failureReason: `REMAINDER|${two?.orderId}|${fresh?.id}` })
  })

  it('up by a cent: nothing is taken under the smallest charge, and the deposit stays behind the rest', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [, two] = p.ref.legs
    await till.nextCardTill(p.ref, 1, tillDeps())
    const old = kindOf(two?.orderId ?? '', 'pos_bond')[0]

    const out = await till.changeCardTill(p.ref, 5_614, null, SECRET, tillDeps())
    expect(out.cover).toMatchObject({ leftoverCents: 386, depositCents: 386 })
    await till.doneCardTill(out.ref, 2, tillDeps())
    // Never raised to 50c: the 1c is written off, and the deposit it was owed from stands behind the rest.
    expect(fake.paymentIntent(old?.id ?? '')).toMatchObject({ status: 'requires_capture', amount_received: 0 })
    expect((await eventsOf(two?.orderId ?? '')).some((r) => r.startsWith(`DEPOSIT_UNCHARGED|${old?.id}|`))).toBe(true)
    expect(await intentRow(two?.intentId ?? '')).toMatchObject({ state: 'offered', lastKnownBalanceCents: 386, failureReason: `REMAINDER|${two?.orderId}|${old?.id}` })
  })

  it('up, then the card does not scan: nothing was taken from the deposit, which waits with the kept hold', async () => {
    await twoTargetCards()
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [, two] = p.ref.legs
    await till.nextCardTill(p.ref, 1, tillDeps())
    const bond = kindOf(two?.orderId ?? '', 'pos_bond')[0]
    const out = await till.changeCardTill(p.ref, 5_813, null, SECRET, tillDeps())
    const captures = fake.callsTo('paymentIntents.capture').length

    const report = await till.reportCardTill(out.ref, 2, 'didnt_scan', null, tillDeps())
    expect(report.kept).toMatchObject({ until: 'next_shopper' })
    // The finding: about $1.60 was captured at the change and never given back.
    expect(fake.paymentIntent(bond?.id ?? '')).toMatchObject({ status: 'requires_capture', amount_received: 0 })
    expect(fake.callsTo('paymentIntents.capture').length).toBe(captures)
    expect((await eventsOf(two?.orderId ?? '')).some((r) => r.startsWith('DEPOSIT_TAKEN|'))).toBe(false)
  })

  it('up, then back down: the card is charged for what it covered at the end, never for the way up', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [, two] = p.ref.legs
    await till.nextCardTill(p.ref, 1, tillDeps())
    const bond = kindOf(two?.orderId ?? '', 'pos_bond')[0]
    const hold = kindOf(two?.orderId ?? '', 'pos_hold')[0]
    // Up $2.00, then the item comes off and the total is $56.26: 13c more than at Pay.
    const up = await till.changeCardTill(p.ref, 5_813, null, SECRET, tillDeps())
    const down = await till.changeCardTill(up.ref, 5_626, null, SECRET, tillDeps())
    expect(down.cover).toMatchObject({ leftoverCents: 374, depositCents: 374 })
    await till.doneCardTill(down.ref, 2, tillDeps())
    // The code's own hold, at its price, and nothing from the deposit: the 10c
    // the 13c costs is under the smallest charge, and written off.
    expect(fake.paymentIntent(hold?.id ?? '')).toMatchObject({ status: 'succeeded', amount_received: hold?.amount })
    expect(fake.paymentIntent(bond?.id ?? '')).toMatchObject({ status: 'requires_capture', amount_received: 0 })
    expect(await intentRow(two?.intentId ?? '')).toMatchObject({ state: 'offered', lastKnownBalanceCents: 374, failureReason: `REMAINDER|${two?.orderId}|${bond?.id}` })
  })

  it('down to what the cards before it cover: the card on screen is not needed, and the screen says Done', async () => {
    await twoTargetCards()
    const p = await pay('target', 5_613)
    const [one] = p.ref.legs
    await till.nextCardTill(p.ref, 1, tillDeps())
    const covered = (await spendLegFor(one?.orderId ?? ''))?.appliedCents ?? 0
    const out = await till.changeCardTill(p.ref, covered, null, SECRET, tillDeps())
    expect(out).toMatchObject({ tooLow: true, notNeeded: true, plan: { unavailable: expect.stringContaining('Tap Done') } })
    // "Done" reports it not used: nothing more is owed.
    const report = await till.reportCardTill(out.ref, 2, 'not_used', null, tillDeps())
    expect(report.owed).toBeNull()
  })
})

describe('a card that will not hold the deposit', () => {
  it('gets a plan with no leftover instead, when one covers the total and no price was set', async () => {
    await listTarget(2_000, 2_000)
    const exact = await listTarget(1_613, 500)
    const create = fake.paymentIntents.create.bind(fake.paymentIntents)
    ;(fake.paymentIntents as { create: typeof create }).create = (params, opts) => {
      if (params.metadata?.salvo_kind === 'pos_bond') fake.failNext('paymentIntents.create', 'decline')
      return create(params, opts)
    }
    const p = await pay('target', 1_613)
    expect(p.plan).toMatchObject({ depositCents: 0 })
    expect(p.ref.legs.map((l) => l.intentId)).toEqual([exact.id])
  })

  it('is told the deposit could not be held when nothing else covers it, with nothing left held', async () => {
    await listTarget(2_000)
    const create = fake.paymentIntents.create.bind(fake.paymentIntents)
    ;(fake.paymentIntents as { create: typeof create }).create = (params, opts) => {
      if (params.metadata?.salvo_kind === 'pos_bond') fake.failNext('paymentIntents.create', 'decline')
      return create(params, opts)
    }
    const { customerId } = fake.seedBuyer()
    const out = till.payCardTill({ merchantId: 'target', totalCents: 1_613, preference: null, customerId }, tillDeps())
    await expect(out).rejects.toMatchObject({ code: 'deposit_declined', message: expect.stringContaining('$3.87') })
    const live = [...(await prisma.order.findMany())].flatMap((o) => fake.paymentIntentsForOrder(o.id)).filter((pi) => pi.status === 'requires_capture')
    expect(live).toEqual([])
    expect((await prisma.intent.findFirstOrThrow()).state).toBe('offered')
  })
})

describe('a shopper who keeps reporting remainders', () => {
  it('gets no remainders and no part-used last card after two reports in 30 days', async () => {
    const { customerId } = fake.seedBuyer()
    for (let i = 0; i < 2; i++) {
      const order = await prisma.order.create({
        data: {
          buyerEmail: 'b@example.com',
          kind: 'gift_card',
          merchantId: 'target',
          deadlineAt: later(DAY_MS),
          qty: 1,
          priceCents: 300,
          rail: 'stripe',
          paymentRef: `hold:${customerId}:none`,
          state: 'refunded',
        },
      })
      await remainder.recordRemainderEmpty(order, { aOrderId: `ord_a${i}`, shortCents: 300 }, null)
    }
    expect(await remainder.remainderStrikes({ customerId, fingerprint: null })).toBe(2)

    // A remainder waits first in line; a whole card is also on sale.
    const rem = await listTarget(2_000)
    await prisma.intent.update({ where: { id: rem.id }, data: { lastKnownBalanceCents: 500, failureReason: 'REMAINDER|ord_x|pi_x' } })
    await listTarget(500)
    const barred = await quoteTill('card', { merchantId: 'target', totalCents: 500, buyer: { customerId, fingerprint: null } })
    if ('reason' in barred) throw new Error(barred.reason)
    expect(barred.legs.map((l) => l.source)).toEqual(['fresh'])
    const anyone = await quoteTill('card', { merchantId: 'target', totalCents: 500 })
    if ('reason' in anyone) throw new Error(anyone.reason)
    expect(anyone.legs.map((l) => l.source)).toEqual(['remainder'])
  })
})

describe('the routes', () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${APP}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP, ...headers },
      body: JSON.stringify(body),
    })
  const cookieFor = (customerId: string) => ({ cookie: `salvo_card=${encodeURIComponent(mintCardCookie(customerId))}` })

  it('refuse a request from another site before reading anything', async () => {
    const res = await quoteRoute.POST(post('/api/card/till/quote', { store: 'target', totalCents: 500 }, { origin: 'https://evil.example' }))
    expect(res.status).toBe(403)
  })

  it('quote with no card, and refuse to pay without one', async () => {
    await listTarget(2_000)
    const quoted = await quoteRoute.POST(post('/api/card/till/quote', { store: 'target', totalCents: 1_613 }))
    expect(quoted.status).toBe(200)
    const body = (await quoted.json()) as { plan: { costCents: number; legs: unknown[] } }
    expect(body.plan).toMatchObject({ costCents: 1_291 })
    expect(JSON.stringify(body)).not.toMatch(/intent|ord_|cus_/)

    const paidRes = await payRoute.POST(post('/api/card/till/pay', { store: 'target', totalCents: 1_613 }))
    expect(paidRes.status).toBe(409)
    expect(await paidRes.json()).toMatchObject({ error: 'card_required' })
  })

  it('pay with this browser\'s card, hand the page no processor id, and act on a purchase only from the phone that paid', async () => {
    await twoTargetCards()
    const mine = fake.seedBuyer().customerId
    const paidRes = await payRoute.POST(post('/api/card/till/pay', { store: 'target', totalCents: 5_613 }, cookieFor(mine)))
    expect(paidRes.status).toBe(200)
    const text = await paidRes.text()
    // The handle lives in the page's script: the card customer is in it only as a tag.
    expect(text).not.toMatch(/cus_/)
    const body = JSON.parse(text) as { purchase: string; code: { scanIndex: number; barcode: string } }
    expect(body.code.scanIndex).toBe(1)

    const theirs = fake.seedBuyer().customerId
    const stolen = await nextRoute.POST(post('/api/card/till/next', { purchase: body.purchase, scanIndex: 1 }, cookieFor(theirs)))
    expect(stolen.status).toBe(403)
    expect(await stolen.json()).toMatchObject({ error: 'card_not_here' })

    const forged = mintPurchaseRef({ legs: [{ orderId: 'o1', intentId: 'i1' }], customerId: mine, merchantId: 'target', totalCents: 100 }, 'y'.repeat(32))
    const refused = await nextRoute.POST(post('/api/card/till/next', { purchase: forged, scanIndex: 1 }, cookieFor(mine)))
    expect(refused.status).toBe(401)

    const next = await nextRoute.POST(post('/api/card/till/next', { purchase: body.purchase, scanIndex: 1 }, cookieFor(mine)))
    expect(next.status).toBe(200)
    expect(await next.json()).toMatchObject({ code: { scanIndex: 2, scanOf: 2 } })
  })

  it('a purchase made with this browser\'s own card still acts here once that card is saved to the account', async () => {
    await twoTargetCards()
    const mine = fake.seedBuyer().customerId
    const paidRes = await payRoute.POST(post('/api/card/till/pay', { store: 'target', totalCents: 5_613 }, cookieFor(mine)))
    const { purchase } = (await paidRes.json()) as { purchase: string }
    // "Save it to my account": a new customer, linked, which the session names
    // and pays with from now on; the card cookie this browser had stays.
    const linked = fake.seedBuyer().customerId
    const both = { cookie: `${cookieFor(mine).cookie}; salvo_account=${encodeURIComponent(mintAccountCookie(`0x${'a'.repeat(40)}`, linked))}` }

    // The finding: 403 card_not_here, "Open this on the phone you paid with", on the phone that paid.
    const receipt = await receiptRoute.POST(post('/api/card/till/receipt', { purchase }, both))
    expect(receipt.status).toBe(200)
    const next = await nextRoute.POST(post('/api/card/till/next', { purchase, scanIndex: 1 }, both))
    expect(next.status).toBe(200)
    expect(await next.json()).toMatchObject({ code: { scanIndex: 2 } })
    // Another browser's account still cannot.
    const theirs = { cookie: `salvo_account=${encodeURIComponent(mintAccountCookie(`0x${'b'.repeat(40)}`, fake.seedBuyer().customerId))}` }
    expect((await receiptRoute.POST(post('/api/card/till/receipt', { purchase }, theirs))).status).toBe(403)
  })

  it('a Pay whose answer was lost before a sign-in is found under the card that paid, and never bought twice', async () => {
    await twoTargetCards()
    await twoTargetCards()
    const mine = fake.seedBuyer().customerId
    const key = 'm'.repeat(24)
    const lost = await payRoute.POST(post('/api/card/till/pay', { store: 'target', totalCents: 5_613, key }, cookieFor(mine)))
    const first = (await lost.json()) as { code: { barcode: string } }
    const orders = await prisma.order.count()
    const linked = fake.seedBuyer().customerId
    const both = { cookie: `${cookieFor(mine).cookie}; salvo_account=${encodeURIComponent(mintAccountCookie(`0x${'c'.repeat(40)}`, linked))}` }

    // "Check it" after signing in. The finding: "That Pay did not go through,
    // so nothing was charged", while card 1 was held and shown.
    const checked = await payRoute.POST(post('/api/card/till/pay', { store: 'target', totalCents: 5_613, key, resume: true }, both))
    expect(checked.status).toBe(200)
    expect(await checked.json()).toMatchObject({ code: { scanIndex: 1, barcode: first.code.barcode } })
    // Pay tapped again with the same key: the same purchase, on the card that paid.
    const again = await payRoute.POST(post('/api/card/till/pay', { store: 'target', totalCents: 5_613, key }, both))
    expect(await again.json()).toMatchObject({ code: { scanIndex: 1, barcode: first.code.barcode } })
    expect(await prisma.order.count()).toBe(orders)
  })

  it('pay answers a price past the button with the new price, and holds nothing', async () => {
    await twoTargetCards()
    const mine = fake.seedBuyer().customerId
    const res = await payRoute.POST(
      post('/api/card/till/pay', { store: 'target', totalCents: 5_613, quoted: { costCents: 100, cards: 2, depositCents: 387 } }, cookieFor(mine)),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ requote: { totalCents: 5_613 }, message: expect.stringContaining('price changed') })
    expect(fake.callsTo('paymentIntents.create')).toEqual([])
  })

  it('report says when the card\'s hold is kept, and what is still owed', async () => {
    await twoTargetCards()
    const mine = fake.seedBuyer().customerId
    const paidRes = await payRoute.POST(post('/api/card/till/pay', { store: 'target', totalCents: 5_613 }, cookieFor(mine)))
    const { purchase } = (await paidRes.json()) as { purchase: string }
    const res = await reportRoute.POST(post('/api/card/till/report', { purchase, scanIndex: 1, outcome: 'declined' }, cookieFor(mine)))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      unavailable: 'We cannot cover $56.13 at this store right now.',
      owedCents: 5_613,
      kept: { until: 'next_shopper', cents: expect.any(Number) },
      receipt: { paidCents: 0, keptCents: expect.any(Number) },
    })
  })
})
