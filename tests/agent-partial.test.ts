/**
 * Partial use at the agent endpoint: one part-used card with a refundable
 * deposit for its leftover, the leftover back on sale, and the deposit
 * returned when the next agent's checkout proves the leftover was there.
 *
 * Tempo refunds are mocked (a network call); the refund path is the real one.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/crypto-refund', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crypto-refund')>()
  const refund = vi.fn(async () => ({ txHash: '0xrefund', explorer: 'https://explore.testnet.tempo.xyz/tx/0xrefund' }))
  return { ...actual, refundTempo: refund, refundCrypto: refund }
})

const { prisma } = await import('@/lib/db')
const { CardSecret } = await import('@/lib/vault/types')
const { LocalEnvelopeVault, generateMasterKey } = await import('@/lib/vault/envelope')
const { createIntent } = await import('@/lib/intent/service')
const { refundTempo } = await import('@/lib/crypto-refund')
const {
  agentQuote,
  chargeCents,
  deliverAgentPurchase,
  planPartialCard,
  recordAgentConfirmation,
  redeliverAgentPurchase,
  settleStaleAgentLeftovers,
  AgentPurchaseError,
} = await import('@/lib/agent/checkout')
const { partialInBuyerAccount, partialInSalvoAccount, storePolicy } = await import('@/lib/agent/stores')
const { decodeAgentRemainder, decodeLeftover } = await import('@/lib/agent/markers')
const { resetDb, setEnv } = await import('./helpers')

const MASTER = Buffer.from(generateMasterKey(), 'hex')
const vault = () => new LocalEnvelopeVault({ masterKey: MASTER })
const SECRET = 's'.repeat(40)
const FIRST = '0x1111111111111111111111111111111111111111'
const NEXT = '0x2222222222222222222222222222222222222222'
let n = 0

async function card(face: number, price: number, merchant = 'bestbuy') {
  n += 1
  return createIntent({
    supply: { merchantId: merchant, accountId: `seller_${n}` },
    secret: new CardSecret(`60064912345${String(1000 + n).padStart(5, '0')}`, '1234'),
    faceValueCents: face,
    priceCents: price,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    formFactor: 'bearer',
    vault: vault(),
    orderId: null,
    owner: { kind: 'operator', ownerId: 'operator:0' },
  })
}

beforeEach(async () => {
  await prisma.intent.deleteMany({})
  await resetDb()
  vi.clearAllMocks()
  setEnv({ CREDITS_AVAILABLE: '10', MAX_ORDERS_PER_DAY: '50', PRICE_CENTS: '900', INTAKE_PAUSED: 'false' })
})

afterAll(async () => {
  await prisma.intent.deleteMany({})
  await resetDb()
  await prisma.$disconnect()
})

describe('store rules', () => {
  it('Target locks a card to the account, so no partial in the buyer account, but exact amounts in Salvo account', () => {
    const t = storePolicy('Target')
    expect(partialInBuyerAccount(t)).toBe(false)
    expect(partialInSalvoAccount(t)).toBe(true)
    expect(t.maxCardsPerOrder).toBe(10)
  })
  it('Best Buy keeps the card unlocked and applies amounts itself: partial in the buyer account is fine', () => {
    expect(partialInBuyerAccount(storePolicy('bestbuy'))).toBe(true)
    expect(partialInSalvoAccount(storePolicy('bestbuy'))).toBe(false)
  })
  it('an unchecked store gets the careful answer: locking, one card, nothing partial', () => {
    const u = storePolicy('somewhere-new')
    expect(u.locksToAccount).toBe(true)
    expect(u.maxCardsPerOrder).toBe(1)
    expect(partialInBuyerAccount(u) || partialInSalvoAccount(u)).toBe(false)
  })
})

describe('the part-used card', () => {
  const c = (b: number, rate = 0.85) => ({ balanceCents: b, costFor: (x: number) => Math.ceil(x * rate) })
  it('picks the smallest card bigger than the gap, under the leftover cap, that is still a discount', () => {
    expect(planPartialCard(340, [c(5000), c(1000), c(600)])?.card.balanceCents).toBe(600)
    expect(planPartialCard(340, [c(10_000)], 5000)).toBeNull()
    expect(planPartialCard(340, [c(1000, 1)])).toBeNull()
    expect(planPartialCard(0, [c(1000)])).toBeNull()
  })
})

describe('quoting partial use', () => {
  it('covers the whole cart at Best Buy with one part-used card and a deposit for its leftover', async () => {
    await card(2000, 1700)
    await card(1000, 850)
    const q = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 2340, allowPartial: true })
    if (q.kind !== 'quote') throw new Error(q.reason)
    expect(q.coveredCents).toBe(2340)
    expect(q.remainderCents).toBe(0)
    const part = q.cards.find((x) => x.leftoverCents > 0)
    expect(part).toMatchObject({ valueCents: 1000, applyCents: 340, leftoverCents: 660, depositCents: 660, costCents: 289 })
    expect(q.priceCents).toBe(1700 + 289)
    expect(chargeCents(q)).toBe(1700 + 289 + 660)
  })

  it('stays whole without the opt-in, and says why at a store that locks cards', async () => {
    await card(2000, 1700)
    await card(1000, 850)
    const plain = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 2340 })
    if (plain.kind !== 'quote') throw new Error(plain.reason)
    expect(plain.cards.every((x) => x.leftoverCents === 0)).toBe(true)
    expect(plain.depositCents).toBe(0)

    await card(2000, 1700, 'target')
    await card(1000, 850, 'target')
    const t = await agentQuote({ merchantId: 'target', cartTotalCents: 2340, allowPartial: true })
    if (t.kind !== 'quote') throw new Error(t.reason)
    expect(t.depositCents).toBe(0)
    expect(t.partialNote).toMatch(/ties a card to the account/)
  })
})

describe('the deposit, from sale to return', () => {
  async function firstSale() {
    await card(2000, 1700)
    await card(1000, 850)
    const q = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 2340, allowPartial: true })
    if (q.kind !== 'quote') throw new Error(q.reason)
    const p = await deliverAgentPurchase({ quote: q, paymentRef: '0xfirst', payer: FIRST, tokenSecret: SECRET, vault: vault() })
    const part = p.cards.find((x) => x.leftoverCents > 0)
    if (!part) throw new Error('no part-used card')
    return { q, p, part }
  }

  it('hands over the part-used card with its amount, holds it marked, and hands it out again only to its agent', async () => {
    const { p, part } = await firstSale()
    expect(part).toMatchObject({ applyCents: 340, leftoverCents: 660 })
    const intent = await prisma.intent.findFirst({ where: { matchedOrderId: part.orderId } })
    expect(intent?.state).toBe('executing')
    expect(decodeLeftover(intent?.failureReason)).toEqual({ orderId: part.orderId, leftoverCents: 660, depositCents: 660, payer: FIRST })
    const again = await redeliverAgentPurchase(p.token, SECRET, vault())
    expect(again?.find((x) => x.orderId === part.orderId)).toMatchObject({ applyCents: 340, leftoverCents: 660 })
  })

  it('a leftover reported intact goes back on sale; the next agent proves it and the first deposit comes back once', async () => {
    const { p, part } = await firstSale()
    const res = await recordAgentConfirmation(p.token, SECRET, { cards: [{ last4: part.last4, appliedCents: 340, remainingCents: 660 }] })
    expect(res?.leftovers).toEqual([{ last4: part.last4, outcome: 'relisted' }])
    const relisted = await prisma.intent.findFirst({ where: { last4: part.last4 } })
    expect(relisted).toMatchObject({ state: 'offered', lastKnownBalanceCents: 660, matchedOrderId: null })
    expect(decodeAgentRemainder(relisted?.failureReason)).toEqual({ orderId: part.orderId, depositCents: 660, payer: FIRST })
    // Once relisted, the first agent can no longer fetch that number; its whole card it still can.
    const again = await redeliverAgentPurchase(p.token, SECRET, vault())
    expect(again?.map((c) => c.last4)).not.toContain(part.last4)
    expect(again).toHaveLength(1)

    const q2 = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 700 })
    if (q2.kind !== 'quote') throw new Error(q2.reason)
    expect(q2.cards).toMatchObject([{ last4: part.last4, valueCents: 660 }])
    const p2 = await deliverAgentPurchase({ quote: q2, paymentRef: '0xnext', payer: NEXT, tokenSecret: SECRET, vault: vault() })
    vi.mocked(refundTempo).mockClear()
    const res2 = await recordAgentConfirmation(p2.token, SECRET, { cards: [{ last4: part.last4, appliedCents: 660 }] })
    expect(res2?.deposits).toEqual([{ orderId: part.orderId, outcome: 'returned' }])
    expect(refundTempo).toHaveBeenCalledWith(FIRST, 660)
    // A second confirm does not pay it twice.
    const res3 = await recordAgentConfirmation(p2.token, SECRET, { cards: [{ last4: part.last4, appliedCents: 660 }] })
    expect(res3?.deposits).toEqual([])
    expect(refundTempo).toHaveBeenCalledTimes(1)
  })

  it('takes the deposit when the agent reports less left than it was paid to leave', async () => {
    const { p, part } = await firstSale()
    const res = await recordAgentConfirmation(p.token, SECRET, { cards: [{ last4: part.last4, appliedCents: 1000, remainingCents: 0 }] })
    expect(res?.leftovers).toEqual([{ last4: part.last4, outcome: 'taken' }])
    expect((await prisma.intent.findFirst({ where: { last4: part.last4 } }))?.state).toBe('completed')
    expect(refundTempo).not.toHaveBeenCalled()
  })

  it('holds the first deposit for a person when the next agent reports the leftover short (a free lie must not take it)', async () => {
    const { p, part } = await firstSale()
    await recordAgentConfirmation(p.token, SECRET, { cards: [{ last4: part.last4, remainingCents: 660 }] })
    const q2 = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 700 })
    if (q2.kind !== 'quote') throw new Error(q2.reason)
    const p2 = await deliverAgentPurchase({ quote: q2, paymentRef: '0xnext2', payer: NEXT, tokenSecret: SECRET, vault: vault() })
    const res = await recordAgentConfirmation(p2.token, SECRET, { cards: [{ last4: part.last4, appliedCents: 100 }] })
    expect(res?.deposits).toEqual([{ orderId: part.orderId, outcome: 'held' }])
    expect(refundTempo).not.toHaveBeenCalled()
    // Held for a person, who now decides alone: nothing returns it automatically on top (round 4).
    expect(await prisma.processedEvent.findUnique({ where: { id: `agent-deposit-return:${part.orderId}` } })).not.toBeNull()
  })

  it('waits when nothing is reported, and the sweep takes the deposit after a week', async () => {
    const { p, part } = await firstSale()
    const res = await recordAgentConfirmation(p.token, SECRET, { appliedCents: 2340 })
    expect(res?.leftovers).toEqual([{ last4: part.last4, outcome: 'waiting' }])
    expect((await settleStaleAgentLeftovers(new Date())).unreported).toBe(0)
    expect((await settleStaleAgentLeftovers(new Date(Date.now() + 8 * 24 * 3600_000))).unreported).toBe(1)
    expect((await prisma.intent.findFirst({ where: { last4: part.last4 } }))?.state).toBe('completed')
    const ev = await prisma.orderEvent.findFirst({ where: { orderId: part.orderId, reason: { contains: 'never-reported' } } })
    expect(ev).not.toBeNull()
  })

  it('returns the deposit with the price, once, when a card will not open before the hand-over', async () => {
    await card(2000, 1700)
    await card(1000, 850)
    const q = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 2340, allowPartial: true })
    if (q.kind !== 'quote') throw new Error(q.reason)
    const wrong = new LocalEnvelopeVault({ masterKey: Buffer.from(generateMasterKey(), 'hex') })
    const err = await deliverAgentPurchase({ quote: q, paymentRef: '0xlost', payer: FIRST, tokenSecret: SECRET, vault: wrong }).catch((e: unknown) => e)
    expect((err as InstanceType<typeof AgentPurchaseError>).code).toBe('open_failed_refunded')
    // Two orders refunded, plus the deposit.
    expect(refundTempo).toHaveBeenCalledTimes(3)
    expect(refundTempo).toHaveBeenCalledWith(FIRST, 660)
    // The settle sweep must not send that deposit back a second time.
    expect((await settleStaleAgentLeftovers()).depositsReturned).toBe(0)
    expect(refundTempo).toHaveBeenCalledTimes(3)
  })
})
