/**
 * Salvo as an endpoint agents call: the quote, the purchase, the token, and
 * the /api/agent routes' refusals.
 *
 * The Tempo refund transport is mocked (a network call); the refund PATH
 * (reconcile.refundOrder) is the real one.
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
const { refundCrypto } = await import('@/lib/crypto-refund')
const {
  AgentPurchaseError,
  agentQuote,
  deliverAgentPurchase,
  planWholeCards,
  purchaseToken,
  readPurchaseToken,
  recordAgentConfirmation,
  redeliverAgentPurchase,
} = await import('@/lib/agent/checkout')
const { resetDb, setEnv } = await import('./helpers')

const MASTER = Buffer.from(generateMasterKey(), 'hex')
const vault = () => new LocalEnvelopeVault({ masterKey: MASTER })
const SECRET = 's'.repeat(40)
const PAYER = '0x1111111111111111111111111111111111111111'
let n = 0

async function card(opts: { face: number; price: number; merchant?: string; orderBound?: boolean; formFactor?: string }) {
  n += 1
  const number = `04260127512${String(1000 + n).padStart(4, '0')}`
  return createIntent({
    supply: { merchantId: opts.merchant ?? 'target', accountId: `seller_${n}` },
    secret: new CardSecret(number, '12345678'),
    faceValueCents: opts.face,
    priceCents: opts.price,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    formFactor: opts.formFactor ?? 'bearer',
    vault: vault(),
    orderId: opts.orderBound ? 'ord_somebody_else' : null,
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

describe('whole cards up to the cart', () => {
  it('takes the largest cards that fit, never going over, at most the card limit', () => {
    const c = (b: number) => ({ balanceCents: b })
    expect(planWholeCards(2340, [c(500), c(2000), c(300), c(100)]).map((x) => x.balanceCents)).toEqual([2000, 300])
    expect(planWholeCards(100, [c(500)])).toEqual([])
    expect(planWholeCards(10_000, Array.from({ length: 12 }, () => c(100)), 10)).toHaveLength(10)
  })
})

describe('the purchase token', () => {
  it('round-trips and refuses a forgery', () => {
    const t = purchaseToken(['o1', 'o2'], PAYER.toUpperCase(), SECRET)
    expect(readPurchaseToken(t, SECRET)).toEqual({ orderIds: ['o1', 'o2'], payer: PAYER })
    expect(readPurchaseToken(t, 'x'.repeat(40))).toBeNull()
    expect(readPurchaseToken(`${Buffer.from(JSON.stringify({ o: ['o3'], p: PAYER })).toString('base64url')}.${t.split('.')[1]}`, SECRET)).toBeNull()
    expect(readPurchaseToken('garbage', SECRET)).toBeNull()
  })
})

describe('the quote', () => {
  it('quotes whole discounted cards Salvo can open, and leaves the rest as the remainder', async () => {
    await card({ face: 2000, price: 1700 })
    await card({ face: 300, price: 270 })
    await card({ face: 5000, price: 4000 }) // too big for the cart
    await card({ face: 1000, price: 1000 }) // no discount
    await card({ face: 1500, price: 1000, orderBound: true }) // sealed to someone else's order
    await card({ face: 1500, price: 1000, merchant: 'bestbuy' }) // another store
    await card({ face: 1500, price: 1000, formFactor: 'in_store_barcode' }) // not an online card
    const q = await agentQuote({ merchantId: 'Target', cartTotalCents: 2340 })
    if (q.kind !== 'quote') throw new Error(q.reason)
    expect(q.coveredCents).toBe(2300)
    expect(q.priceCents).toBe(1970)
    expect(q.savingCents).toBe(330)
    expect(q.remainderCents).toBe(40)
    expect(q.cards.map((c) => c.valueCents)).toEqual([2000, 300])
  })

  it('says no, rather than quoting no saving or nothing', async () => {
    expect((await agentQuote({ merchantId: 'target', cartTotalCents: 2000 })).kind).toBe('no_quote')
    await card({ face: 1000, price: 1000 })
    expect((await agentQuote({ merchantId: 'target', cartTotalCents: 2000 })).kind).toBe('no_quote')
    expect((await agentQuote({ merchantId: 'target', cartTotalCents: -5 })).kind).toBe('no_quote')
    expect((await agentQuote({ merchantId: 'target', cartTotalCents: 1_000_000 })).kind).toBe('no_quote')
  })
})

describe('the purchase', () => {
  async function quoted() {
    await card({ face: 2000, price: 1700 })
    await card({ face: 300, price: 270 })
    const q = await agentQuote({ merchantId: 'target', cartTotalCents: 2340 })
    if (q.kind !== 'quote') throw new Error(q.reason)
    return q
  }

  it('hands over the card numbers, marks the orders fulfilled, and the token fetches and confirms them', async () => {
    const q = await quoted()
    const p = await deliverAgentPurchase({ quote: q, paymentRef: '0xpaid1', payer: PAYER, tokenSecret: SECRET, vault: vault() })
    expect(p.cards).toHaveLength(2)
    expect(p.cards.every((c) => /^\d{15}$/.test(c.cardNumber) && c.accessNumber === '12345678')).toBe(true)
    expect(p.cards.map((c) => c.applyCents)).toEqual([2000, 300])
    expect(p.priceCents).toBe(1970)
    const orders = await prisma.order.findMany({ where: { id: { in: p.orderIds } } })
    expect(orders.every((o) => o.state === 'fulfilled' && o.rail === 'mpp' && o.payerAddress === PAYER && o.kind === 'gift_card')).toBe(true)
    expect(orders.reduce((s, o) => s + o.priceCents, 0)).toBe(1970)
    const intents = await prisma.intent.findMany({ where: { matchedOrderId: { in: p.orderIds } } })
    expect(intents.every((i) => i.state === 'completed')).toBe(true)
    expect(refundCrypto).not.toHaveBeenCalled()

    const again = await redeliverAgentPurchase(p.token, SECRET, vault())
    expect(again?.map((c) => c.cardNumber)).toEqual(p.cards.map((c) => c.cardNumber))
    expect(await redeliverAgentPurchase(p.token, 'y'.repeat(40), vault())).toBeNull()

    expect(await recordAgentConfirmation(p.token, SECRET, { appliedCents: 2300, storeOrderNumber: '9123 4567' })).toEqual({ leftovers: [], deposits: [] })
    const ev = await prisma.orderEvent.findMany({ where: { orderId: { in: p.orderIds }, reason: { startsWith: 'EVIDENCE|' } } })
    expect(ev).toHaveLength(2)
    expect(ev[0]?.reason).toBe('EVIDENCE|buyer_confirmation|applied=2300|order=91234567|agent')
  })

  it('refuses before making any order when a card was taken after the quote (the route returns the charge)', async () => {
    const q = await quoted()
    const taken = q.cards[1]?.intentId ?? ''
    await prisma.intent.update({ where: { id: taken }, data: { state: 'matched', matchedOrderId: 'ord_other' } })
    const err = await deliverAgentPurchase({ quote: q, paymentRef: '0xpaid2', payer: PAYER, tokenSecret: SECRET, vault: vault() }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentPurchaseError)
    expect((err as InstanceType<typeof AgentPurchaseError>).code).toBe('price_changed')
    expect(await prisma.order.count({ where: { paymentRef: '0xpaid2' } })).toBe(0)
    expect(refundCrypto).not.toHaveBeenCalled()
    expect((await prisma.intent.findUnique({ where: { id: q.cards[0]?.intentId ?? '' } }))?.state).toBe('offered')
  })

  it('a card that will not open: everything refunded, and every card back on sale', async () => {
    const q = await quoted()
    const wrong = new LocalEnvelopeVault({ masterKey: Buffer.from(generateMasterKey(), 'hex') })
    const err = await deliverAgentPurchase({ quote: q, paymentRef: '0xpaid3', payer: PAYER, tokenSecret: SECRET, vault: wrong }).catch((e: unknown) => e)
    expect((err as InstanceType<typeof AgentPurchaseError>).code).toBe('open_failed_refunded')
    expect(refundCrypto).toHaveBeenCalledTimes(2)
    const orders = await prisma.order.findMany({ where: { paymentRef: '0xpaid3' } })
    expect(orders.every((o) => o.state === 'refunded')).toBe(true)
    const intents = await prisma.intent.findMany({ where: { id: { in: q.cards.map((c) => c.intentId) } } })
    expect(intents.every((i) => i.state === 'offered' && i.matchedOrderId === null)).toBe(true)
  })

  it('two agents paying for the same cards at once: one gets them, the other is refunded in full, never both', async () => {
    const q = await quoted()
    const results = await Promise.allSettled([
      deliverAgentPurchase({ quote: q, paymentRef: '0xraceA', payer: PAYER, tokenSecret: SECRET, vault: vault() }),
      deliverAgentPurchase({ quote: q, paymentRef: '0xraceB', payer: PAYER, tokenSecret: SECRET, vault: vault() }),
    ])
    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    const code = (lost[0]?.reason as InstanceType<typeof AgentPurchaseError>).code
    expect(['price_changed', 'taken_refunded']).toContain(code)
    const loserRef = (await prisma.order.findFirst({ where: { paymentRef: '0xraceA', state: 'fulfilled' } })) ? '0xraceB' : '0xraceA'
    const loserOrders = await prisma.order.findMany({ where: { paymentRef: loserRef } })
    // Refunded in full when it got as far as making orders; nothing to refund when it did not.
    expect(loserOrders.every((o) => o.state === 'refunded')).toBe(true)
    expect(vi.mocked(refundCrypto).mock.calls.length).toBe(loserOrders.length)
    const winnerRef = loserRef === '0xraceA' ? '0xraceB' : '0xraceA'
    expect((await prisma.order.findMany({ where: { paymentRef: winnerRef } })).every((o) => o.state === 'fulfilled')).toBe(true)
  })

  it('a replayed payment makes no second purchase and moves no money', async () => {
    const q = await quoted()
    await deliverAgentPurchase({ quote: q, paymentRef: '0xonce', payer: PAYER, tokenSecret: SECRET, vault: vault() })
    await card({ face: 2000, price: 1700 })
    await card({ face: 300, price: 270 })
    const q2 = await agentQuote({ merchantId: 'target', cartTotalCents: 2340 })
    if (q2.kind !== 'quote') throw new Error(q2.reason)
    const err = await deliverAgentPurchase({ quote: q2, paymentRef: '0xonce', payer: PAYER, tokenSecret: SECRET, vault: vault() }).catch((e: unknown) => e)
    expect((err as InstanceType<typeof AgentPurchaseError>).code).toBe('already_processed')
    expect(refundCrypto).not.toHaveBeenCalled()
    expect(await prisma.order.count({ where: { paymentRef: '0xonce' } })).toBe(2)
    expect((await prisma.intent.findMany({ where: { id: { in: q2.cards.map((c) => c.intentId) } } })).every((i) => i.state === 'offered')).toBe(true)
  })

  it('agent orders are not born inside the refund sweep window', async () => {
    const q = await quoted()
    const p = await deliverAgentPurchase({ quote: q, paymentRef: '0xdeadline', payer: PAYER, tokenSecret: SECRET, vault: vault() })
    const o = await prisma.order.findUnique({ where: { id: p.orderIds[0] ?? '' } })
    const lead = 90 * 60_000
    expect((o?.deadlineAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(lead)
  })
})

describe('the routes refuse before any money moves', () => {
  it('buy refuses off testnet, and on a bad body, a missing quote or a price above the cap', async () => {
    const { POST } = await import('@/app/api/agent/buy/route')
    const { __resetMppRuntime } = await import('@/lib/mpp')
    const post = (b: unknown) => POST(new Request('https://salvo.test/api/agent/buy', { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } }))

    setEnv({ TEMPO_NETWORK: 'mainnet', TEMPO_PRIVATE_KEY: `0x${'1'.repeat(64)}`, MPP_SECRET_KEY: SECRET })
    __resetMppRuntime()
    expect((await post({ merchant: 'target', cartTotalCents: 2340, maxPriceCents: 1970 })).status).toBe(503)

    setEnv({ TEMPO_NETWORK: 'moderato' })
    __resetMppRuntime()
    expect((await post({ merchant: 'target' })).status).toBe(400)
    expect((await post({ merchant: 'target', cartTotalCents: 2340, maxPriceCents: 1970 })).status).toBe(409)

    await card({ face: 2000, price: 1700 })
    const over = await post({ merchant: 'target', cartTotalCents: 2340, maxPriceCents: 1500 })
    expect(over.status).toBe(409)
    expect(((await over.json()) as { error: string }).error).toBe('price_changed')

    const challenge = await post({ merchant: 'target', cartTotalCents: 2340, maxPriceCents: 1700 })
    expect(challenge.status).toBe(402)
    expect(refundCrypto).not.toHaveBeenCalled()
  })

  it('quote answers with a buy body, or no quote and why', async () => {
    const { POST } = await import('@/app/api/agent/quote/route')
    const post = (b: unknown) => POST(new Request('https://salvo.test/api/agent/quote', { method: 'POST', body: JSON.stringify(b) }))
    expect(((await (await post({ merchant: 'target', cartTotalCents: 2340 })).json()) as { quote: unknown }).quote).toBeNull()
    await card({ face: 2000, price: 1700 })
    const body = (await (await post({ merchant: 'target', cartTotalCents: 2340 })).json()) as { quote: { priceCents: number; cards: unknown[] }; buy: { body: { maxPriceCents: number } } }
    expect(body.quote.priceCents).toBe(1700)
    expect(body.buy.body.maxPriceCents).toBe(1700)
    expect(JSON.stringify(body)).not.toContain('seller_')
  })

  it('points an agent at the Salvo host it called, and only at a known one', async () => {
    const { GET } = await import('@/app/api/agent/route')
    const urls = async (host: string) => {
      const body = (await GET(new Request('http://internal/api/agent', { headers: { host } })).json()) as { steps: { url?: string }[] }
      return body.steps.map((s) => s.url).filter((u): u is string => typeof u === 'string')
    }
    expect((await urls('salvoapp.xyz')).every((u) => u.startsWith('https://salvoapp.xyz/api/agent/'))).toBe(true)
    expect((await urls('evil.example')).every((u) => u.startsWith('http://localhost:3000/api/agent/'))).toBe(true)
  })
})
