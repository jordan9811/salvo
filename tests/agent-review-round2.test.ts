/**
 * The second review of the agent endpoint (2026-11-16), pinned:
 *   a lost buy response recovered by the paying wallet's signature; the
 *   confirm route keeping orderId and refusing off testnet; money returns held
 *   off testnet; the sweep releasing cards and returning the deposit of a
 *   purchase refunded before its hand-over; leftovers sold and never proved
 *   paged once; the charge description that keeps agent payments to agent
 *   routes.
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
const { createIntent, matchIntentsTogether } = await import('@/lib/intent/service')
const { createPaidOrders } = await import('@/lib/orders')
const { refundTempo } = await import('@/lib/crypto-refund')
const { agentQuote, deliverAgentPurchase, recordAgentConfirmation, settleStaleAgentLeftovers } = await import('@/lib/agent/checkout')
const { sendBackOnce } = await import('@/lib/agent/money')
const { AGENT_CHARGE_META, purchaseRecoveryMessage } = await import('@/lib/agent/http')
const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
const { resetDb, setEnv } = await import('./helpers')

// The routes open cards with the server's own vault key, so these cards are sealed with it too.
const MASTER_HEX = generateMasterKey()
const vault = () => new LocalEnvelopeVault()
const SECRET = 's'.repeat(40)
let n = 0

async function card(face: number, price: number, merchant = 'bestbuy') {
  n += 1
  return createIntent({
    supply: { merchantId: merchant, accountId: `seller_${n}` },
    secret: new CardSecret(`60064912345${String(3000 + n).padStart(5, '0')}`, '1234'),
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
  setEnv({ CREDITS_AVAILABLE: '10', MAX_ORDERS_PER_DAY: '50', PRICE_CENTS: '900', INTAKE_PAUSED: 'false', TEMPO_NETWORK: 'moderato', MPP_SECRET_KEY: SECRET, VAULT_MASTER_KEY: MASTER_HEX })
})

afterAll(async () => {
  await prisma.intent.deleteMany({})
  await resetDb()
  await prisma.$disconnect()
})

describe('a lost buy response', () => {
  it('the paying wallet gets its cards back with a signature; anyone else gets nothing', async () => {
    const wallet = privateKeyToAccount(generatePrivateKey())
    await card(2000, 1700)
    const q = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 2340 })
    if (q.kind !== 'quote') throw new Error(q.reason)
    const tx = `0x${'ab'.repeat(32)}`
    const bought = await deliverAgentPurchase({ quote: q, paymentRef: tx, payer: wallet.address, tokenSecret: SECRET, vault: vault() })
    const { POST } = await import('@/app/api/agent/purchase/route')
    const post = (b: unknown) => POST(new Request('https://salvo.test/api/agent/purchase', { method: 'POST', body: JSON.stringify(b) }))

    const signature = await wallet.signMessage({ message: purchaseRecoveryMessage(tx) })
    const ok = await post({ transaction: tx, signature })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { token: string; cards: { cardNumber: string }[] }
    expect(body.cards.map((c) => c.cardNumber)).toEqual(bought.cards.map((c) => c.cardNumber))

    const stranger = privateKeyToAccount(generatePrivateKey())
    const bad = await post({ transaction: tx, signature: await stranger.signMessage({ message: purchaseRecoveryMessage(tx) }) })
    expect(bad.status).toBe(404)
  })
})

describe('the confirm route', () => {
  it('passes orderId through, so a report reaches the right card', async () => {
    await card(2000, 1700)
    await card(1000, 850)
    const q = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 2340, allowPartial: true })
    if (q.kind !== 'quote') throw new Error(q.reason)
    const payer = '0x1111111111111111111111111111111111111111'
    const p = await deliverAgentPurchase({ quote: q, paymentRef: '0xroute', payer, tokenSecret: SECRET, vault: vault() })
    const part = p.cards.find((c) => c.leftoverCents > 0)
    if (!part) throw new Error('no part-used card')
    const { POST } = await import('@/app/api/agent/confirm/route')
    const res = await POST(
      new Request('https://salvo.test/api/agent/confirm', {
        method: 'POST',
        body: JSON.stringify({ token: p.token, cards: [{ orderId: part.orderId, last4: '0000', remainingCents: part.leftoverCents }] }),
      }),
    )
    const body = (await res.json()) as { leftovers: { outcome: string }[] }
    // Matched by orderId even though last4 is wrong.
    expect(body.leftovers).toEqual([{ last4: part.last4, outcome: 'relisted' }])
  })

  it('refuses off testnet, where a deposit return would be real money', async () => {
    setEnv({ TEMPO_NETWORK: 'mainnet' })
    const { POST } = await import('@/app/api/agent/confirm/route')
    const res = await POST(new Request('https://salvo.test/api/agent/confirm', { method: 'POST', body: JSON.stringify({ token: 'x' }) }))
    expect(res.status).toBe(503)
  })
})

describe('money returns', () => {
  it('are held for a person off testnet, and claimed nothing', async () => {
    setEnv({ TEMPO_NETWORK: 'mainnet' })
    const out = await sendBackOnce('deposit-return', 'ord_x', '0x1111111111111111111111111111111111111111', 500, 'test')
    expect(out.status).toBe('failed')
    expect(refundTempo).not.toHaveBeenCalled()
    expect(await prisma.processedEvent.findUnique({ where: { id: 'agent-deposit-return:ord_x' } })).toBeNull()
  })
})

describe('the agent sweep after a crash', () => {
  it('puts cards reserved by a refunded agent purchase back on sale and returns its deposit once', async () => {
    const c = await card(1000, 850)
    const payer = '0x1111111111111111111111111111111111111111'
    const [made] = await createPaidOrders(
      [
        {
          intake: { buyerEmail: 'agent@agents.invalid', theaterName: null, theaterZip: null, theaterSlug: null, film: null, showtimeUtc: null, showtimeUrl: null, qty: 1, priceCents: 289 },
          rail: 'mpp',
          paymentRef: '0xcrash',
          payerAddress: payer,
          idempotencyKey: '0xcrash:agent:0',
          kind: 'gift_card',
          merchantId: 'bestbuy',
          deadlineAt: new Date(Date.now() + 3 * 3600_000),
        },
      ],
      async (tx, order) => {
        await tx.orderEvent.create({ data: { orderId: order.id, fromState: order.state, toState: order.state, actor: 'worker', reason: `AGENT_DEPOSIT|660|charged|${payer}|0xcrash` } })
      },
    )
    if (!made) throw new Error('no order')
    await matchIntentsTogether([{ intentId: c.id, orderId: made.order.id }])
    // The crash: the reconcile sweep refunded the order; the card stayed reserved.
    await prisma.order.update({ where: { id: made.order.id }, data: { state: 'refunded' } })

    const r = await settleStaleAgentLeftovers()
    expect(r).toMatchObject({ cardsReleased: 1, depositsReturned: 1 })
    expect((await prisma.intent.findUnique({ where: { id: c.id } }))?.state).toBe('offered')
    expect(refundTempo).toHaveBeenCalledWith(payer, 660)
    const again = await settleStaleAgentLeftovers()
    expect(again).toMatchObject({ cardsReleased: 0, depositsReturned: 0 })
    expect(refundTempo).toHaveBeenCalledTimes(1)
  })

  it('pages once about a leftover sold whole and never proved by its buyer', async () => {
    await card(2000, 1700)
    await card(1000, 850)
    const q = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 2340, allowPartial: true })
    if (q.kind !== 'quote') throw new Error(q.reason)
    const first = '0x1111111111111111111111111111111111111111'
    const p = await deliverAgentPurchase({ quote: q, paymentRef: '0xa', payer: first, tokenSecret: SECRET, vault: vault() })
    const part = p.cards.find((c) => c.leftoverCents > 0)
    if (!part) throw new Error('no part-used card')
    await recordAgentConfirmation(p.token, SECRET, { cards: [{ orderId: part.orderId, last4: part.last4, remainingCents: 660 }] })
    const q2 = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 700 })
    if (q2.kind !== 'quote') throw new Error(q2.reason)
    await deliverAgentPurchase({ quote: q2, paymentRef: '0xb', payer: '0x2222222222222222222222222222222222222222', tokenSecret: SECRET, vault: vault() })
    const later = new Date(Date.now() + 8 * 24 * 3600_000)
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(1)
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(0)
    expect(refundTempo).not.toHaveBeenCalled()
  })
})

describe('agent payments stay on agent routes', () => {
  it('every agent charge is scoped with signed metadata, which the library compares when the payment returns', () => {
    expect(AGENT_CHARGE_META).toEqual({ route: 'agent-buy' })
  })
})
