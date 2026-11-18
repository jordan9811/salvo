/**
 * The fourth and fifth reviews of the agent endpoint (2026-11-16), pinned:
 *   a refused credential is looked at only when it is a challenge we issued
 *   for this route, by its real (lower-case) transaction, push or pull; a page
 *   about it only for money the chain shows arrived; a deposit handed to a
 *   person can no longer be returned automatically; an agent order refunds on
 *   testnet only; orders that were created although their write reported an
 *   error are unwound, not refunded twice; only money bound to the refused
 *   challenge counts, and an unreadable chain is said, not read as unpaid; a
 *   payment returned by hand is recorded first and can then never buy.
 * Rounds 6 to 8 follow at the end: what a person is told, and when.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ loseCreateAck: false, failClaim: '' }))

// One kind of claim can be made to fail, as a database error would.
vi.mock('@/lib/agent/money', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/money')>()
  return {
    ...actual,
    claimMoneyMove: (async (...args: Parameters<typeof actual.claimMoneyMove>) => {
      if (flags.failClaim !== '' && flags.failClaim === args[0]) throw new Error('database unreachable')
      return actual.claimMoneyMove(...args)
    }) as typeof actual.claimMoneyMove,
  }
})

vi.mock('@/lib/crypto-refund', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crypto-refund')>()
  const refund = vi.fn(async () => ({ txHash: '0xrefund', explorer: 'https://explore.testnet.tempo.xyz/tx/0xrefund' }))
  return { ...actual, refundTempo: refund, refundCrypto: refund }
})

// The order write commits, then its answer is lost.
vi.mock('@/lib/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orders')>()
  return {
    ...actual,
    createPaidOrders: (async (...args: Parameters<typeof actual.createPaidOrders>) => {
      const made = await actual.createPaidOrders(...args)
      if (flags.loseCreateAck) throw new Error('connection reset after commit')
      return made
    }) as typeof actual.createPaidOrders,
  }
})

const { prisma } = await import('@/lib/db')
const { CardSecret } = await import('@/lib/vault/types')
const { LocalEnvelopeVault, generateMasterKey } = await import('@/lib/vault/envelope')
const { createIntent } = await import('@/lib/intent/service')
const { refundTempo } = await import('@/lib/crypto-refund')
const { refundOrder } = await import('@/lib/reconcile')
const { agentQuote, deliverAgentPurchase, recordAgentConfirmation, settleStaleAgentLeftovers, AgentPurchaseError } = await import('@/lib/agent/checkout')
const { AGENT_CHARGE_META, refusedPayment } = await import('@/lib/agent/http')
const { challengeNonceHex, paymentToUs } = await import('@/lib/agent/chain')
const { claimMoneyMove, recordManualReturn, returnMarkersSince, sendBackOnce } = await import('@/lib/agent/money')
const { mppRuntime, __resetMppRuntime, centsToAmountString, tempoPayTo, tempoCurrency, TRANSFER_TOPIC } = await import('@/lib/mpp')
const { Challenge, Credential } = await import('mppx')
const { encodeEventTopics, keccak256 } = await import('viem')
const { Abis } = await import('viem/tempo')
const { resetDb, setEnv } = await import('./helpers')

const MASTER = Buffer.from(generateMasterKey(), 'hex')
const vault = () => new LocalEnvelopeVault({ masterKey: MASTER })
const SECRET = 's'.repeat(40)
const FIRST = '0x1111111111111111111111111111111111111111'
const NEXT = '0x2222222222222222222222222222222222222222'
let n = 0

async function card(face: number, price: number) {
  n += 1
  return createIntent({
    supply: { merchantId: 'bestbuy', accountId: `seller_${n}` },
    secret: new CardSecret(`60064912345${String(4000 + n).padStart(5, '0')}`, '1234'),
    faceValueCents: face,
    priceCents: price,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    formFactor: 'bearer',
    vault: vault(),
    orderId: null,
    owner: { kind: 'operator', ownerId: 'operator:0' },
  })
}

/** A first agent's leftover, reported intact and bought whole by a second agent. */
async function leftoverBoughtByNext() {
  await card(2000, 1700)
  await card(1000, 850)
  const q = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 2340, allowPartial: true })
  if (q.kind !== 'quote') throw new Error(q.reason)
  const p = await deliverAgentPurchase({ quote: q, paymentRef: `0xfirst${n}`, payer: FIRST, tokenSecret: SECRET, vault: vault() })
  const part = p.cards.find((c) => c.leftoverCents > 0)
  if (!part) throw new Error('no part-used card')
  await recordAgentConfirmation(p.token, SECRET, { cards: [{ orderId: part.orderId, last4: part.last4, remainingCents: part.leftoverCents }] })
  const q2 = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 700 })
  if (q2.kind !== 'quote') throw new Error(q2.reason)
  const p2 = await deliverAgentPurchase({ quote: q2, paymentRef: `0xnext${n}`, payer: NEXT, tokenSecret: SECRET, vault: vault() })
  return { part, p2 }
}

beforeEach(async () => {
  await prisma.intent.deleteMany({})
  await resetDb()
  vi.clearAllMocks()
  flags.loseCreateAck = false
  flags.failClaim = ''
  setEnv({ CREDITS_AVAILABLE: '10', MAX_ORDERS_PER_DAY: '50', PRICE_CENTS: '900', INTAKE_PAUSED: 'false', TEMPO_NETWORK: 'moderato', TEMPO_PRIVATE_KEY: `0x${'1'.repeat(64)}`, MPP_SECRET_KEY: SECRET, NTFY_TOPIC: undefined, NTFY_SERVER: undefined, AGENT_RETURN_MARKERS_SINCE: '2026-01-01T00:00:00Z' })
  __resetMppRuntime()
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await prisma.intent.deleteMany({})
  await resetDb()
  await prisma.$disconnect()
})

/** A real challenge from our payment runtime, with or without the agent route's metadata. */
async function issuedChallenge(meta: boolean) {
  const opts = meta ? { amount: centsToAmountString(1700), meta: AGENT_CHARGE_META } : { amount: centsToAmountString(1700) }
  const res = await mppRuntime().mppx.compose(['tempo/charge', opts] as const)(new Request('https://salvo.test/api/agent/buy', { method: 'POST' }))
  if (res.status !== 402) throw new Error('expected a challenge')
  return Challenge.fromResponse(res.challenge as Response)
}

function withCredential(challenge: unknown, payload: Record<string, string>): Request {
  const auth = Credential.serialize(Credential.from({ challenge, payload } as never))
  return new Request('https://salvo.test/api/agent/buy', { method: 'POST', headers: { Authorization: auth } })
}

describe('a refused credential', () => {
  it('is looked at only for a challenge we issued for this route, by its lower-case transaction', async () => {
    const ours = await issuedChallenge(true)
    const hash = `0x${'AB'.repeat(32)}`
    expect(refusedPayment(withCredential(ours, { type: 'hash', hash }), SECRET)).toMatchObject({ transaction: hash.toLowerCase(), mode: 'push' })

    // Pull: the hash of the signed transaction it carries.
    const signed = `0x${'76'.repeat(80)}`
    expect(refusedPayment(withCredential(ours, { type: 'transaction', signature: signed }), SECRET)).toMatchObject({ transaction: keccak256(signed as `0x${string}`).toLowerCase(), mode: 'pull' })

    // Another route's challenge, and a made-up one: not ours to look at.
    const shop = await issuedChallenge(false)
    expect(refusedPayment(withCredential(shop, { type: 'hash', hash }), SECRET)).toBeNull()
    expect(refusedPayment(withCredential({ ...ours, id: 'forged' }, { type: 'hash', hash }), SECRET)).toBeNull()
  })

  it('counts only money bound to that challenge arriving at our address, and says when the chain cannot be read', async () => {
    // The event topic is the real TIP-20 one.
    const [memoTopic] = encodeEventTopics({ abi: Abis.tip20, eventName: 'TransferWithMemo' })
    const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`
    const memoFor = (id: string) => `0x${'ef'.repeat(25)}${challengeNonceHex(id)}`
    const amount = `0x${(17_000_000).toString(16)}`
    const transfer = { address: tempoCurrency(), topics: [TRANSFER_TOPIC, pad(FIRST), pad(tempoPayTo())], data: amount }
    const bound = { address: tempoCurrency(), topics: [memoTopic, pad(FIRST), pad(tempoPayTo()), memoFor('ch_A')], data: amount }
    // A memo leg to someone else does not count.
    const elsewhere = { address: tempoCurrency(), topics: [memoTopic, pad(FIRST), pad(NEXT), memoFor('ch_A')], data: `0x${(50_000).toString(16)}` }
    const answer = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(body as object) }))))
    const tx = `0x${'cd'.repeat(32)}`

    answer({ result: { status: '0x1', logs: [transfer, bound, elsewhere] } })
    expect(await paymentToUs(tx, 'ch_A')).toEqual({ status: 'paid', payer: FIRST, cents: 1700 })
    // Paid us, but for another challenge (or another route's payment): not this one's money.
    expect(await paymentToUs(tx, 'ch_B')).toEqual({ status: 'none' })
    answer({ result: { status: '0x1', logs: [transfer] } })
    expect(await paymentToUs(tx, 'ch_A')).toEqual({ status: 'none' })
    answer({ result: { status: '0x0', logs: [transfer, bound] } })
    expect(await paymentToUs(tx, 'ch_A')).toEqual({ status: 'none' })
    answer({ result: null })
    expect(await paymentToUs(tx, 'ch_A')).toEqual({ status: 'none' })
    answer({ error: { message: 'rate limited' } })
    expect((await paymentToUs(tx, 'ch_A')).status).toBe('unknown')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout') }))
    expect((await paymentToUs(tx, 'ch_A')).status).toBe('unknown')
    vi.unstubAllGlobals()
  })
})

describe('a payment returned by hand', () => {
  const tx = `0x${'ee'.repeat(32)}`

  it('is recorded before it is sent, and can then neither buy nor be returned again', async () => {
    expect(await recordManualReturn(tx.toUpperCase().replace('0X', '0x'))).toBe('recorded')
    // The buy route's first step for this payment now fails: no purchase.
    expect(await claimMoneyMove('payment-use', tx)).toBe(false)
    expect((await sendBackOnce('charge-back', tx, FIRST, 500, 'test')).status).toBe('already')
    expect(await recordManualReturn(tx)).toBe('already')
  })

  it('is refused while a purchase may still be running, and for a payment that bought something', async () => {
    await claimMoneyMove('payment-use', tx)
    expect(await recordManualReturn(tx)).toBe('in_flight')
    expect(await recordManualReturn(tx, new Date(Date.now() + 16 * 60_000))).toBe('recorded')

    await card(1000, 850)
    const q = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 1000 })
    if (q.kind !== 'quote') throw new Error(q.reason)
    await deliverAgentPurchase({ quote: q, paymentRef: `0x${'f1'.repeat(32)}`, payer: FIRST, tokenSecret: SECRET, vault: vault() })
    expect(await recordManualReturn(`0x${'f1'.repeat(32)}`)).toBe('has_orders')
  })
})

describe('a deposit handed to a person', () => {
  it('a short report from the next buyer holds it, and a later full report cannot return it', async () => {
    const { part, p2 } = await leftoverBoughtByNext()
    vi.mocked(refundTempo).mockClear()
    const order = p2.orderIds[0] ?? ''
    const short = await recordAgentConfirmation(p2.token, SECRET, { cards: [{ orderId: order, last4: part.last4, appliedCents: 100 }] })
    expect(short?.deposits).toEqual([{ orderId: part.orderId, outcome: 'held' }])
    const full = await recordAgentConfirmation(p2.token, SECRET, { cards: [{ orderId: order, last4: part.last4, appliedCents: 660 }] })
    expect(full?.deposits).toEqual([])
    expect(refundTempo).not.toHaveBeenCalled()
  })

  it('a leftover the sweep flagged as never proved cannot be returned by a late report', async () => {
    const { part, p2 } = await leftoverBoughtByNext()
    vi.mocked(refundTempo).mockClear()
    expect((await settleStaleAgentLeftovers(new Date(Date.now() + 8 * 24 * 3600_000))).needsOperator).toBe(1)
    const late = await recordAgentConfirmation(p2.token, SECRET, { cards: [{ orderId: p2.orderIds[0] ?? '', last4: part.last4, appliedCents: 660 }] })
    expect(late?.deposits).toEqual([])
    expect(refundTempo).not.toHaveBeenCalled()
  })
})

describe('agent order refunds', () => {
  it('run on testnet only', async () => {
    await card(1000, 850)
    const q = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 1000 })
    if (q.kind !== 'quote') throw new Error(q.reason)
    const p = await deliverAgentPurchase({ quote: q, paymentRef: '0xtestnetonly', payer: FIRST, tokenSecret: SECRET, vault: vault() })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: p.orderIds[0] ?? '' } })
    // A paid, due order as the cron would find it after a switch to mainnet.
    await prisma.order.update({ where: { id: order.id }, data: { state: 'paid' } })
    setEnv({ TEMPO_NETWORK: 'mainnet' })
    vi.mocked(refundTempo).mockClear()
    const out = await refundOrder(await prisma.order.findUniqueOrThrow({ where: { id: order.id } }), 'test')
    expect(out.refunded).toBe(false)
    expect(refundTempo).not.toHaveBeenCalled()
  })
})

describe('orders created although their write reported an error', () => {
  it('are unwound once: no whole-charge return on top, cards back on sale', async () => {
    const c = await card(2000, 1700)
    const q = await agentQuote({ merchantId: 'bestbuy', cartTotalCents: 2000 })
    if (q.kind !== 'quote') throw new Error(q.reason)
    flags.loseCreateAck = true
    const err = await deliverAgentPurchase({ quote: q, paymentRef: '0xlostack', payer: FIRST, tokenSecret: SECRET, vault: vault() }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentPurchaseError)
    expect((err as InstanceType<typeof AgentPurchaseError>).code).toBe('create_failed_refunded')
    const orders = await prisma.order.findMany({ where: { paymentRef: '0xlostack' } })
    expect(orders.map((o) => o.state)).toEqual(['refunded'])
    expect(refundTempo).toHaveBeenCalledTimes(1)
    // The order's own refund, once (through the rail dispatcher); nothing on top.
    expect(refundTempo).toHaveBeenCalledWith('mpp', FIRST, 1700, '0xlostack')
    expect((await prisma.intent.findUnique({ where: { id: c.id } }))?.state).toBe('offered')
  })
})

describe('round 6: what a person is told, and when', () => {
  const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`

  /** fetch for both the chain (a receipt bound to `challengeId`) and the push service (`ntfyStatus`). */
  function network(challengeId: string, ntfyStatus: () => number) {
    const [memoTopic] = encodeEventTopics({ abi: Abis.tip20, eventName: 'TransferWithMemo' })
    const log = { address: tempoCurrency(), topics: [memoTopic, pad(FIRST), pad(tempoPayTo()), `0x${'ef'.repeat(25)}${challengeNonceHex(challengeId)}`], data: `0x${(17_000_000).toString(16)}` }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).includes('ntfy.test')
          ? new Response('', { status: ntfyStatus() })
          : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: '0x1', logs: [log] } })),
      ),
    )
  }

  it('a refused payment that arrived is paged once by the sweep after its challenge expired, and again if the page failed', async () => {
    const tx = `0x${'a1'.repeat(32)}`
    await claimMoneyMove('refused-seen', `${tx}|ch_R`)
    setEnv({ NTFY_TOPIC: 'salvo-test', NTFY_SERVER: 'https://ntfy.test' })
    let status = 400
    network('ch_R', () => status)
    // Too soon: a purchase using it could still be running.
    expect((await settleStaleAgentLeftovers(new Date())).needsOperator).toBe(0)
    const later = new Date(Date.now() + 20 * 60_000)
    // The page fails: not silent, the next run tries again.
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(0)
    status = 200
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(1)
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(0)
    vi.unstubAllGlobals()
  })

  it('a refused payment a purchase used after all is never paged', async () => {
    const tx = `0x${'a2'.repeat(32)}`
    await claimMoneyMove('refused-seen', `${tx}|ch_U`)
    await claimMoneyMove('payment-use', tx)
    await claimMoneyMove('stranded-page', tx)
    network('ch_U', () => 200)
    expect((await settleStaleAgentLeftovers(new Date(Date.now() + 20 * 60_000))).needsOperator).toBe(0)
    vi.unstubAllGlobals()
  })

  it('a use that ended with nothing bought can be recorded at once', async () => {
    const tx = `0x${'a3'.repeat(32)}`
    await claimMoneyMove('payment-use', tx)
    await claimMoneyMove('use-ended', tx)
    expect(await recordManualReturn(tx)).toBe('recorded')
  })

  it('a failed automatic return is still owed when recorded, once', async () => {
    const tx = `0x${'a4'.repeat(32)}`
    vi.mocked(refundTempo).mockRejectedValueOnce(new Error('rpc down'))
    expect((await sendBackOnce('charge-back', tx, FIRST, 500, 'test')).status).toBe('failed')
    expect(await recordManualReturn(tx)).toBe('auto_failed')
    expect(await recordManualReturn(tx)).toBe('already')
  })
})

describe('round 7: nothing owed is left without a page', () => {
  it('drops a refused record once its challenge expired with nothing bound to it on chain', async () => {
    const tx = `0x${'b1'.repeat(32)}`
    await claimMoneyMove('refused-seen', `${tx}|ch_N`)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: '0x1', logs: [] } }))))
    expect((await settleStaleAgentLeftovers(new Date(Date.now() + 20 * 60_000))).needsOperator).toBe(0)
    expect(await prisma.processedEvent.findUnique({ where: { id: `agent-refused-seen:${tx}|ch_N` } })).toBeNull()
    vi.unstubAllGlobals()
  })

  it('an automatic return that died mid-send is paged once, and recording it says it is still owed', async () => {
    const tx = `0x${'b2'.repeat(32)}`
    // The claim, then the process died: no return-sent, no return-failed.
    await claimMoneyMove('charge-back', tx)
    expect(await recordManualReturn(tx)).toBe('in_flight')
    const later = new Date(Date.now() + 20 * 60_000)
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(1)
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(0)
    expect(await recordManualReturn(tx, later)).toBe('auto_failed')
    expect(await recordManualReturn(tx, later)).toBe('already')
  })

  it('a finished automatic return, or one recorded by hand, is never paged as unfinished', async () => {
    const sent = `0x${'b3'.repeat(32)}`
    expect((await sendBackOnce('charge-back', sent, FIRST, 500, 'test')).status).toBe('sent')
    const byHand = `0x${'b4'.repeat(32)}`
    expect(await recordManualReturn(byHand)).toBe('recorded')
    const later = new Date(Date.now() + 20 * 60_000)
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(0)
    expect(await recordManualReturn(sent, later)).toBe('already')
    expect(await recordManualReturn(byHand, later)).toBe('already')
  })
})

describe('round 8: the cutoff, an unreadable chain, and pages that did not land', () => {
  type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>
  const ntfyCalls = (f: { mock: { calls: Parameters<Fetch>[] } }) => f.mock.calls.filter(([u]) => String(u).includes('ntfy.test'))

  it('the cutoff defaults to after the deploy and can be moved; a recorded failure is owed on either side of it', async () => {
    setEnv({ AGENT_RETURN_MARKERS_SINCE: undefined })
    expect(returnMarkersSince().toISOString()).toBe('2026-11-16T14:00:00.000Z')
    setEnv({ AGENT_RETURN_MARKERS_SINCE: 'not a time' })
    expect(returnMarkersSince().toISOString()).toBe('2026-11-16T14:00:00.000Z')
    // The cutoff still ahead: a return claimed now is from before the markers.
    setEnv({ AGENT_RETURN_MARKERS_SINCE: new Date(Date.now() + 3600_000).toISOString() })
    const later = new Date(Date.now() + 20 * 60_000)
    const old = `0x${'c1'.repeat(32)}`
    await claimMoneyMove('charge-back', old)
    // No ending recorded, claimed before the cutoff: taken as done, as before, and not paged.
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(0)
    expect(await recordManualReturn(old, later)).toBe('already')
    // A recorded failure is still owed, cutoff or not.
    const failed = `0x${'c2'.repeat(32)}`
    vi.mocked(refundTempo).mockRejectedValueOnce(new Error('rpc down'))
    expect((await sendBackOnce('charge-back', failed, FIRST, 500, 'test')).status).toBe('failed')
    expect(await recordManualReturn(failed, later)).toBe('auto_failed')
  })

  it('a failed return whose page did not get through is paged by the sweep, once; one whose page landed is not paged again', async () => {
    // Before the cutoff, too: a recorded failure is swept whenever it happened.
    setEnv({ NTFY_TOPIC: 'salvo-test', NTFY_SERVER: 'https://ntfy.test', AGENT_RETURN_MARKERS_SINCE: new Date(Date.now() + 3600_000).toISOString() })
    let status = 400
    const calls = vi.fn<Fetch>(async () => new Response('', { status }))
    vi.stubGlobal('fetch', calls)
    const lost = `0x${'c3'.repeat(32)}`
    vi.mocked(refundTempo).mockRejectedValueOnce(new Error('rpc down'))
    expect((await sendBackOnce('charge-back', lost, FIRST, 500, 'test')).status).toBe('failed')
    status = 200
    const landed = `0x${'c4'.repeat(32)}`
    vi.mocked(refundTempo).mockRejectedValueOnce(new Error('rpc down'))
    expect((await sendBackOnce('charge-back', landed, FIRST, 500, 'test')).status).toBe('failed')
    const later = new Date(Date.now() + 20 * 60_000)
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(1)
    const page = String(ntfyCalls(calls).at(-1)?.[1]?.body)
    expect(page).toContain(`whole charge for payment ${lost}, failed`)
    expect(page).not.toContain(landed)
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(0)
    vi.unstubAllGlobals()
  })

  it('a failed deposit return whose page did not get through is paged by the sweep, with who and how much', async () => {
    const { part, p2 } = await leftoverBoughtByNext()
    setEnv({ NTFY_TOPIC: 'salvo-test', NTFY_SERVER: 'https://ntfy.test' })
    let status = 400
    const calls = vi.fn<Fetch>(async () => new Response('', { status }))
    vi.stubGlobal('fetch', calls)
    vi.mocked(refundTempo).mockRejectedValueOnce(new Error('rpc down'))
    const full = await recordAgentConfirmation(p2.token, SECRET, { cards: [{ orderId: p2.orderIds[0] ?? '', last4: part.last4, appliedCents: 660 }] })
    expect(full?.deposits).toEqual([{ orderId: part.orderId, outcome: 'return_failed' }])
    status = 200
    const later = new Date(Date.now() + 20 * 60_000)
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(1)
    const page = String(ntfyCalls(calls).at(-1)?.[1]?.body)
    expect(page).toContain(`deposit for order ${part.orderId}, failed`)
    expect(page).toContain(`payer: ${FIRST}`)
    expect(page).toMatch(/amount: \d+c/)
    expect((await settleStaleAgentLeftovers(later)).needsOperator).toBe(0)
    vi.unstubAllGlobals()
  })

  it('a refused payment the chain cannot read: the agent is told to resend, never to pay again, and a failed record pages at once', async () => {
    setEnv({ NTFY_TOPIC: 'salvo-test', NTFY_SERVER: 'https://ntfy.test' })
    const calls = vi.fn<Fetch>(async (url) =>
      String(url).includes('ntfy.test') ? new Response('', { status: 200 }) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } })),
    )
    vi.stubGlobal('fetch', calls)
    const { POST } = await import('@/app/api/agent/buy/route')
    const challenge = await issuedChallenge(true)
    const hash = `0x${'c5'.repeat(32)}`
    const req = () => {
      const signed = withCredential(challenge, { type: 'hash', hash })
      return new Request(signed.url, { method: 'POST', headers: signed.headers, body: JSON.stringify({ merchant: 'bestbuy', cartTotalCents: 2000, maxPriceCents: 2000 }) })
    }
    flags.failClaim = 'refused-seen'
    const res = await POST(req())
    expect(res.status).toBe(503)
    const out = (await res.json()) as { error: string; message: string }
    expect(out.error).toBe('payment_unverified')
    expect(out.message).toContain('Do NOT make a new payment')
    expect(out.message).toContain('Resend this same request')
    expect(ntfyCalls(calls)).toHaveLength(1)
    expect(String(ntfyCalls(calls)[0]?.[1]?.body)).toContain('unreadable just now')
    // Recorded this time: no page now, the sweep follows it up.
    flags.failClaim = ''
    expect((await POST(req())).status).toBe(503)
    expect(ntfyCalls(calls)).toHaveLength(1)
    expect(await prisma.processedEvent.count({ where: { id: { startsWith: `agent-refused-seen:${hash}|` } } })).toBe(1)
    // Resent while the chain shows nothing (still pending): the same answer,
    // never a fresh challenge the agent's client would pay again.
    vi.stubGlobal('fetch', vi.fn<Fetch>(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }))))
    const again = await POST(req())
    expect(again.status).toBe(503)
    expect(again.headers.get('www-authenticate')).toBeNull()
    vi.unstubAllGlobals()
  })
})
