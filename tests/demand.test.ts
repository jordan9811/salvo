/**
 * Gate 4 â€” the buyer-side demand path.
 *
 * Before this, a buyer could not initiate anything: every path in the system
 * started from the operator or from a seller. What is tested here is the missing
 * half â€” ask for a merchant and an amount, get real supply priced with a real
 * discount, and turn that into an escrow-funded order through the EXISTING
 * intake path rather than a second one.
 *
 * The two properties worth breaking the build over:
 *
 *   1. A quote is never better than the supply behind it. It prices against
 *      last-known balance, skips expired and already-matched intents, and
 *      refuses rather than quoting a non-saving.
 *   2. Claiming supply is ALL OR NOTHING. A half-claimed quote is an order the
 *      buyer paid for that cannot be filled as sold.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'
import {
  QUOTE_TTL_MS,
  isNoQuote,
  legCostCents,
  publicQuote,
  quoteDemand,
  type DemandQuote,
} from '@/lib/demand/quote'
import {
  NativeOrderGateway,
  SupplyRaceLostError,
  claimSupply,
  resolveDemandGateway,
} from '@/lib/demand/gateway'
import { resetDb } from './helpers'

const MERCHANT = 'bestbuy'
const NOW = new Date('2026-09-01T18:00:00.000Z')
const LATER = new Date(NOW.getTime() + 7 * 24 * 3600_000)

/**
 * `resetDb()` clears orders but NOT intents â€” it predates the intent table. That
 * is a real test-isolation gap for a suite like this one, which QUERIES BROADLY
 * ("all live supply for this merchant") rather than by id: one case's leftover
 * offer silently becomes another case's supply. Cleared here rather than in the
 * shared helper, so this change cannot perturb the other 16 suites.
 */
beforeEach(async () => {
  await resetDb()
  await prisma.intent.deleteMany({})
})

afterAll(async () => {
  await prisma.intent.deleteMany({})
  await resetDb()
  await prisma.$disconnect()
})

let n = 0

/**
 * Seed a live offer. Written directly rather than through createIntent because
 * quoting is a READ path â€” going through the seal/custody machinery would test
 * that instead, and it is already tested elsewhere.
 */
async function offer(over: {
  faceValueCents?: number
  priceCents?: number
  lastKnownBalanceCents?: number | null
  state?: string
  expiresAt?: Date
  merchantId?: string
  last4?: string
} = {}) {
  n += 1
  const faceValueCents = over.faceValueCents ?? 5000
  // 10% off unless told otherwise.
  const priceCents = over.priceCents ?? Math.round(faceValueCents * 0.9)

  return prisma.intent.create({
    data: {
      id: `int_${n}_${Math.random().toString(36).slice(2, 8)}`,
      state: (over.state ?? 'offered') as 'offered',
      merchantId: over.merchantId ?? MERCHANT,
      accountId: `acct_${n}`,
      formFactor: 'bearer',
      faceValueCents,
      priceCents,
      discountBps: Math.round(((faceValueCents - priceCents) / faceValueCents) * 10_000),
      expiresAt: over.expiresAt ?? LATER,
      last4: over.last4 ?? String(1000 + n),
      lastKnownBalanceCents: over.lastKnownBalanceCents ?? null,
      sealedRef: { id: `ref_${n}`, algorithm: 'in-memory:test-only' },
    },
  })
}

function asQuote(v: Awaited<ReturnType<typeof quoteDemand>>): DemandQuote {
  if (isNoQuote(v)) throw new Error(`expected a quote, got: ${v.reason}`)
  return v
}

// ===========================================================================
// Quoting
// ===========================================================================
describe('quoteDemand â€” a buyer can finally ask for something', () => {
  it('prices a single card against a matching order total', async () => {
    await offer({ faceValueCents: 5000, priceCents: 4500 })
    const q = asQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW }))

    expect(q.orderTotalCents).toBe(5000)
    expect(q.priceCents).toBe(4500)
    expect(q.savingCents).toBe(500)
    expect(q.discountBps).toBe(1000) // 10%
    expect(q.fullDrain).toBe(true)
  })

  it('combines several cards, and prices each at ITS OWN discount', async () => {
    // 20% off and 5% off. Averaging would quietly redistribute between sellers.
    await offer({ faceValueCents: 3000, priceCents: 2400 })
    await offer({ faceValueCents: 2000, priceCents: 1900 })

    const q = asQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW }))
    expect(q.legs).toHaveLength(2)
    expect(q.priceCents).toBe(4300)
    expect(q.legs.every((l) => l.fullyDrained)).toBe(true)
  })

  it('quotes against LAST-KNOWN BALANCE, not face value', async () => {
    // Balance-watch saw this card drop to $20. Quoting $50 of value would sell
    // something that is not there.
    await offer({ faceValueCents: 5000, priceCents: 4500, lastKnownBalanceCents: 2000 })
    const q = await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW })
    expect(isNoQuote(q)).toBe(true)

    const smaller = asQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 2000, now: NOW }))
    expect(smaller.orderTotalCents).toBe(2000)
  })

  it('ignores intents that are not offered', async () => {
    await offer({ state: 'matched' })
    await offer({ state: 'cancelled' })
    const q = await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW })
    expect(isNoQuote(q)).toBe(true)
  })

  it('ignores EXPIRED supply', async () => {
    // An expired intent cannot be unsealed even if matched, so quoting it would
    // be quoting something undeliverable.
    await offer({ expiresAt: new Date(NOW.getTime() - 1000) })
    const q = await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW })
    expect(isNoQuote(q)).toBe(true)
  })

  it('ignores other merchants', async () => {
    await offer({ merchantId: 'target' })
    const q = await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW })
    expect(isNoQuote(q)).toBe(true)
    if (!isNoQuote(q)) return
    expect(q.reason).toContain('no live supply')
  })

  it('REFUSES to quote a non-saving rather than showing 0%', async () => {
    await offer({ faceValueCents: 5000, priceCents: 5000 })
    const q = await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW })
    expect(isNoQuote(q)).toBe(true)
    if (!isNoQuote(q)) return
    expect(q.reason).toContain('no saving')
  })

  it('rejects a nonsense total', async () => {
    expect(isNoQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 0 }))).toBe(true)
    expect(isNoQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: -5 }))).toBe(true)
    expect(isNoQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 1.5 }))).toBe(true)
  })

  it('carries the full-drain property through from the matcher', async () => {
    // $55 card on a $50 order: a capped partial, and the quote says so.
    await offer({ faceValueCents: 5500, priceCents: 5000 })
    const q = asQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW }))
    expect(q.fullDrain).toBe(false)
    expect(q.residualCents).toBe(500)
    expect(q.legs[0]?.fullyDrained).toBe(false)
  })

  it('is short-lived, because supply is live', async () => {
    await offer()
    const q = asQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW }))
    expect(q.expiresAt.getTime()).toBe(NOW.getTime() + QUOTE_TTL_MS)
  })

  it('rounds a leg cost UP, so rounding never comes out of the seller', () => {
    // 1c of a 3c-priced 7c card: 0.428â€¦c. Must not round down to 0.
    expect(legCostCents(1, 3, 7)).toBe(1)
    expect(legCostCents(5000, 4500, 5000)).toBe(4500)
    expect(legCostCents(2500, 4500, 5000)).toBe(2250)
    // A zero face value cannot be pro-rated; charge face rather than free.
    expect(legCostCents(100, 0, 0)).toBe(100)
  })
})

describe('the public quote leaks no seller identity', () => {
  it('omits accountId entirely', async () => {
    await offer()
    const q = asQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW }))
    const serialised = JSON.stringify(publicQuote(q))
    expect(serialised).not.toContain('acct_')
    // What a buyer legitimately needs is present.
    expect(serialised).toContain('discountBps')
    expect(serialised).toContain('last4')
  })
})

// ===========================================================================
// Claiming supply â€” all or nothing
// ===========================================================================
describe('claimSupply', () => {
  it('moves every leg offered â†’ matched, bound to the order', async () => {
    const a = await offer({ faceValueCents: 3000, priceCents: 2700 })
    const b = await offer({ faceValueCents: 2000, priceCents: 1800 })
    const q = asQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW }))

    const claimed = await claimSupply(q, 'order-xyz')
    expect(claimed.sort()).toEqual([a.id, b.id].sort())

    for (const id of claimed) {
      const row = await prisma.intent.findUnique({ where: { id } })
      expect(row?.state).toBe('matched')
      expect(row?.matchedOrderId).toBe('order-xyz')
    }
  })

  it('RELEASES what it took when a later leg loses the race', async () => {
    const a = await offer({ faceValueCents: 3000, priceCents: 2700 })
    const b = await offer({ faceValueCents: 2000, priceCents: 1800 })
    const q = asQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW }))

    // Another buyer takes one leg out from under this quote.
    const contested = q.legs[1]?.intentId ?? b.id
    await prisma.intent.update({
      where: { id: contested },
      data: { state: 'matched', matchedOrderId: 'someone-elses-order' },
    })

    await expect(claimSupply(q, 'order-xyz')).rejects.toThrow(SupplyRaceLostError)

    // The uncontested card is back on the market, not stranded in `matched`
    // against an order that will now be refunded.
    const survivor = q.legs[0]?.intentId ?? a.id
    const row = await prisma.intent.findUnique({ where: { id: survivor } })
    expect(row?.state).toBe('offered')
    expect(row?.matchedOrderId).toBeNull()
  })

  it('names the race as expected rather than exceptional', async () => {
    await offer()
    const q = asQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW }))
    await prisma.intent.update({
      where: { id: q.legs[0]?.intentId ?? '' },
      data: { state: 'cancelled' },
    })

    try {
      await claimSupply(q, 'order-1')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SupplyRaceLostError)
      expect((err as Error).message).toContain('quotes are not reservations')
    }
  })
})

// ===========================================================================
// PHASE 5 â€” the assumption Phase 4 surfaced is now resolved by migration
// ===========================================================================
describe('the order shape', () => {
  it('is native, and there is no longer a choice to make', () => {
    // Phase 4 shipped two gateways and deferred the decision. Phase 5 ran the
    // migration and deleted the ticket-shaped one â€” a fallback that writes a
    // fake showtime into the column the refund daemon keys on is exactly the
    // kind of thing that survives for years because it "still works".
    expect(resolveDemandGateway().shape).toBe('native')
  })
})

describe('NativeOrderGateway â€” reuses the intake path rather than forking it', () => {
  it('creates a real order and claims the supply behind it', async () => {
    await offer({ faceValueCents: 5000, priceCents: 4500 })
    const q = asQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW }))

    const res = await new NativeOrderGateway().create({
      quote: q,
      buyerEmail: 'buyer@example.com',
      rail: 'stripe',
      paymentRef: `cs_${Math.random().toString(36).slice(2)}`,
      idempotencyKey: `key_${Math.random().toString(36).slice(2)}`,
    })

    expect(res.idempotentReplay).toBe(false)
    expect(res.matchedIntentIds).toHaveLength(1)
    // The buyer pays the QUOTED price, not the face value.
    expect(res.order.priceCents).toBe(4500)
    // PHASE 5: the supply deadline now lands in `deadlineAt`, its own column,
    // rather than being stuffed into showtimeUtc. This is the assertion that
    // changed when the native order shape landed.
    expect(res.order.deadlineAt.getTime()).toBe(q.expiresAt.getTime())
    expect(res.order.kind).toBe('gift_card')
    expect(res.order.merchantId).toBe(MERCHANT)
    // And the ticket-domain columns are genuinely absent rather than fabricated.
    expect(res.order.showtimeUtc).toBeNull()
    expect(res.order.theaterName).toBeNull()
    expect(res.order.film).toBeNull()

    const intent = await prisma.intent.findUnique({ where: { id: res.matchedIntentIds[0] ?? '' } })
    expect(intent?.state).toBe('matched')
    expect(intent?.matchedOrderId).toBe(res.order.id)
  })

  it('is idempotent, and a replay does NOT re-claim supply', async () => {
    await offer({ faceValueCents: 5000, priceCents: 4500 })
    const q = asQuote(await quoteDemand({ merchantId: MERCHANT, orderTotalCents: 5000, now: NOW }))
    const gw = new NativeOrderGateway()
    const key = `key_${Math.random().toString(36).slice(2)}`
    const paymentRef = `cs_${Math.random().toString(36).slice(2)}`

    const first = await gw.create({
      quote: q,
      buyerEmail: 'buyer@example.com',
      rail: 'stripe',
      paymentRef,
      idempotencyKey: key,
    })
    const replay = await gw.create({
      quote: q,
      buyerEmail: 'buyer@example.com',
      rail: 'stripe',
      paymentRef,
      idempotencyKey: key,
    })

    expect(replay.order.id).toBe(first.order.id)
    expect(replay.idempotentReplay).toBe(true)
    expect(replay.matchedIntentIds).toHaveLength(0)
  })
})
