/**
 * The escrow keeper (spec sections 8.6 and 12, with the lead's override: no
 * migration, rail mpp, an escrow: payment ref).
 *
 * Runs against the real SalvoEscrowV1 on the in-process EVM, pinned and
 * deployed the way the runbook does it, with fake Lit running the real
 * template for tickets. Each case drives the chain into a state, runs the
 * keeper, and checks the books follow `getDeposit` and `gate`, never a
 * client's word:
 *   - orders come from deposits only, once each, however often it runs
 *   - a deposit for a listing we never recorded makes no order
 *   - payouts are sent only with a keeper key, only once due, and only as
 *     `release(id)` or `claim(to)` to the escrow
 *   - part refund, dispute and full refund are read from the deposit
 *   - a listing cancelled or expired on chain leaves the offered book
 *   - the rail switch and the pins gate everything, before any read
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeFunctionResult, encodeFunctionData, erc20Abi, keccak256, parseTransaction, stringToHex, toFunctionSelector, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { prisma } from '@/lib/db'
import { describeKeeper, runEscrowKeeper } from '@/lib/escrow/keeper'
import { PATH_USD } from '@/lib/escrow/manifest'
import { escrowIntentIdFor, escrowPaymentRef } from '@/lib/escrow/refs'
import { __setEscrowRuntimeForTests } from '@/lib/escrow/runtime'
import { findDueForRefund, reconcile } from '@/lib/reconcile'
import { ESCROW_V1 } from '@/lib/vault/lit/templates'
import { MOCK_TOKEN_ABI, escrowCall, tokenCall } from './support/escrow-chain'
import {
  SELLER,
  SHOPPER,
  buyCard,
  closeServerWorld,
  listOnChain,
  listedCard,
  sealCard,
  serverWorld,
  type ServerWorld,
} from './support/escrow-server-world'
import { testAddress } from './support/evm'
import { resetDb } from './helpers'

const RAIL = process.env.ESCROW_RAIL
const USAGE_KEY = process.env.LIT_VAULT_USAGE_KEY
const DAY = 86_400
const RELEASE = toFunctionSelector('release(uint256)')
const CLAIM = toFunctionSelector('claim(address)')

beforeEach(async () => {
  await resetDb()
  process.env.ESCROW_RAIL = 'testnet'
  // Fake Lit's key for the shoppers' tickets. The keeper itself never calls Lit.
  process.env.LIT_VAULT_USAGE_KEY = 'usage-key-for-tests'
})

afterEach(() => {
  closeServerWorld()
  for (const [k, v] of [['ESCROW_RAIL', RAIL], ['LIT_VAULT_USAGE_KEY', USAGE_KEY]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

afterAll(async () => {
  await resetDb()
  await prisma.$disconnect()
})

async function keep(w: ServerWorld, opts: { key?: string | null; apply?: boolean } = {}) {
  return runEscrowKeeper({ apply: opts.apply ?? true, keeperKey: opts.key ?? null, rt: w.rt })
}

async function balanceOf(w: ServerWorld, who: Hex): Promise<bigint> {
  const r = await w.node.chain.call(testAddress(1), PATH_USD, encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [who] }))
  return decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: r.returnData })
}

/** Every transaction the keeper sent (after the world's own deploy): to and selector. */
function sentTxs(w: ServerWorld): Array<{ to: string; selector: string }> {
  return w.node.sent('eth_sendRawTransaction').slice(w.setupTxs).map((r) => {
    const tx = parseTransaction(r.params[0] as Hex)
    return { to: (tx.to ?? '').toLowerCase(), selector: (tx.data ?? '0x').slice(0, 10) }
  })
}

describe('the keeper is off unless the rail is on and an escrow is pinned', () => {
  it('reads nothing and writes nothing while ESCROW_RAIL is not testnet', async () => {
    const w = await serverWorld()
    const l = await listedCard(w)
    await buyCard(w, l)
    for (const value of [undefined, 'off', '', 'mainnet', 'test net']) {
      if (value === undefined) delete process.env.ESCROW_RAIL
      else process.env.ESCROW_RAIL = value
      const before = w.node.requests.length
      const r = await keep(w, { key: generatePrivateKey() })
      expect(r).toMatchObject({ ran: false, skipped: 'rail_off', ordersCreated: 0 })
      expect(w.node.requests.length).toBe(before)
    }
    expect(await prisma.order.count()).toBe(0)
    expect(describeKeeper(await keep(w))).toBe('escrow-keeper skipped (rail_off)')
  })

  it('the 15-minute cron loads the keeper only behind ESCROW_RAIL=testnet, and isolates it', () => {
    const cron = readFileSync(resolve(process.cwd(), 'scripts/reconcile.ts'), 'utf8')
    const gate = cron.indexOf('if (escrowRailOn()) {')
    const load = cron.indexOf("await import('../src/lib/escrow/keeper')")
    expect(gate).toBeGreaterThan(0)
    expect(load).toBeGreaterThan(gate)
    // One load, and nothing else of the escrow's: production never reads it while the rail is off.
    expect(cron.match(/src\/lib\/escrow\//g)).toHaveLength(2)
    expect(cron.slice(gate, load)).not.toMatch(/\belse\b/)
    // The key is the cron's own setting, passed as is; with none the keeper sends nothing.
    expect(cron).toContain('keeperKey: process.env.ESCROW_KEEPER_KEY ?? null')
    expect(cron.indexOf('escrow-keeper FAILED')).toBeGreaterThan(load)
  })

  it('reads nothing while the committed template has no usable escrow pin', async () => {
    const w = await serverWorld()
    __setEscrowRuntimeForTests({ ...w.rt, template: ESCROW_V1 })
    const before = w.node.requests.length
    const r = await runEscrowKeeper({ apply: true, keeperKey: null })
    if (ESCROW_V1.escrowAddress === null) {
      expect(r).toMatchObject({ ran: false, skipped: 'escrow_not_pinned' })
      expect(w.node.requests.length).toBe(before)
    }
  })
})

describe('orders come from the chain, once each', () => {
  it('records a purchase as one mpp order with an escrow ref, and moves its listing to executing', async () => {
    const w = await serverWorld()
    const l = await listedCard(w)
    const b = await buyCard(w, l)

    // A dry run reads and reports, and writes nothing.
    const dry = await keep(w, { apply: false })
    expect(dry).toMatchObject({ ran: true, applied: false, depositCount: 1, newDeposits: 1, ordersCreated: 0 })
    expect(await prisma.order.count()).toBe(0)

    const r = await keep(w)
    expect(r).toMatchObject({ ran: true, depositCount: 1, newDeposits: 1, ordersCreated: 1, foreignDeposits: 0, errors: [] })
    const order = await prisma.order.findFirstOrThrow()
    expect(order).toMatchObject({
      rail: 'mpp',
      kind: 'gift_card',
      state: 'fulfilling',
      merchantId: 'salvotest',
      paymentRef: escrowPaymentRef('tempo-moderato', w.escrow, b.depositId),
      payerAddress: SHOPPER,
      priceCents: Math.ceil(l.manifest.price / 10_000),
      buyerEmail: '',
      refundRef: null,
    })
    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ fromState: null, toState: 'fulfilling', actor: 'chain' })
    expect(events[0]?.reason).toMatch(/^ESCROW\|Opened\|deposit:1\|block:\d+$/)
    const intent = await prisma.intent.findUniqueOrThrow({ where: { id: l.intentId } })
    expect(intent).toMatchObject({ state: 'executing', matchedOrderId: order.id })

    // Again, and again: nothing new.
    for (let i = 0; i < 2; i++) {
      const again = await keep(w)
      expect(again).toMatchObject({ newDeposits: 0, ordersCreated: 0 })
    }
    expect(await prisma.order.count()).toBe(1)
    expect(await prisma.processedEvent.count({ where: { orderId: order.id } })).toBe(1)
  })

  it('makes no order for a deposit of a listing we never recorded, and notes it once', async () => {
    const w = await serverWorld()
    const l = await sealCard(w)
    await listOnChain(w, l)
    await buyCard(w, l)
    const r = await keep(w)
    expect(r).toMatchObject({ newDeposits: 1, ordersCreated: 0, foreignDeposits: 1 })
    expect(await prisma.order.count()).toBe(0)
    expect(await prisma.processedEvent.count()).toBe(1)
    expect(await keep(w)).toMatchObject({ newDeposits: 0, foreignDeposits: 0 })
  })

  it('an escrow order is invisible to the refund daemon, however late it is', async () => {
    const w = await serverWorld()
    const l = await listedCard(w)
    await buyCard(w, l)
    await keep(w)
    const farFuture = new Date(Date.now() + 400 * DAY * 1000)
    expect(await findDueForRefund(farFuture)).toEqual([])
    const report = await reconcile(farFuture)
    expect(report).toMatchObject({ scanned: 0, refunded: 0, failedToRefund: 0 })
    expect((await prisma.order.findFirstOrThrow()).state).toBe('fulfilling')
  })
})

describe('payouts', () => {
  it('without a keeper key, reports a due payout and sends nothing', async () => {
    const w = await serverWorld()
    const l = await listedCard(w)
    await buyCard(w, l)
    await keep(w)
    expect((await keep(w)).payoutsDue).toBe(0)
    w.node.advance(DAY)
    const r = await keep(w)
    expect(r).toMatchObject({ payoutsDue: 1, payoutsSent: 0, keeperKey: false })
    expect(sentTxs(w)).toEqual([])
    expect((await prisma.order.findFirstOrThrow()).state).toBe('fulfilling')
  })

  it('a malformed key counts as no key, and is never echoed', async () => {
    const w = await serverWorld()
    const l = await listedCard(w)
    await buyCard(w, l)
    await keep(w)
    w.node.advance(DAY)
    const secret = `0x${'z'.repeat(64)}`
    const r = await keep(w, { key: secret })
    expect(r).toMatchObject({ keeperKey: false, payoutsDue: 1, payoutsSent: 0 })
    expect(JSON.stringify(r)).not.toContain('zzzz')
    expect(describeKeeper(r)).toContain('keeperKey=missing')
  })

  it('with a key, pays the seller only once due, as release(id) to the escrow, then books it fulfilled', async () => {
    const w = await serverWorld()
    const l = await listedCard(w)
    const b = await buyCard(w, l)
    const key = generatePrivateKey()
    await keep(w, { key })
    w.node.advance(DAY - 5)
    expect(await keep(w, { key })).toMatchObject({ payoutsDue: 0, payoutsSent: 0 })
    expect(sentTxs(w)).toEqual([])

    w.node.advance(5)
    const sellerBefore = await balanceOf(w, SELLER)
    const r = await keep(w, { key })
    expect(r).toMatchObject({ payoutsDue: 1, payoutsSent: 1, errors: [] })
    expect(sentTxs(w)).toEqual([{ to: w.escrow, selector: RELEASE }])
    expect((await balanceOf(w, SELLER)) - sellerBefore).toBe(BigInt(l.manifest.price))
    const sentEvent = await prisma.orderEvent.findFirst({ where: { reason: { startsWith: 'ESCROW|ReleaseSent|' } } })
    expect(sentEvent?.reason).toMatch(/^ESCROW\|ReleaseSent\|deposit:1\|block:\d+\|tx:0x[0-9a-f]{64}$/)
    expect(sentEvent?.actor).toBe('keeper')

    const booked = await keep(w, { key })
    expect(booked).toMatchObject({ released: 1, payoutsDue: 0, payoutsSent: 0 })
    const order = await prisma.order.findFirstOrThrow()
    expect(order.state).toBe('fulfilled')
    expect(order.fulfilledAt).not.toBeNull()
    expect(order.refundRef).toBeNull()
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: l.intentId } })).state).toBe('completed')
    const reasons = (await prisma.orderEvent.findMany({ where: { orderId: order.id } })).map((e) => e.reason)
    expect(reasons.some((x) => x?.startsWith(`ESCROW|Released|deposit:${b.depositId}`))).toBe(true)
    // Nothing more is ever sent for it.
    await keep(w, { key })
    expect(sentTxs(w)).toHaveLength(1)
  })
})

describe('refunds and disputes are read from the deposit', () => {
  it('a part refund lowers the amount and keeps the sale open; a dispute is marked; a full refund closes it', async () => {
    const w = await serverWorld()
    const l = await listedCard(w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const b = await buyCard(w, l)
    await keep(w)

    // The seller gives back $5.00 of the $18.00.
    expect((await w.node.chain.send(SELLER, w.escrow, escrowCall.sellerRefund(b.depositId, 5_000_000n))).ok).toBe(true)
    const part = await keep(w)
    expect(part).toMatchObject({ partRefunds: 1, refunded: 0, released: 0 })
    let order = await prisma.order.findFirstOrThrow()
    expect(order.state).toBe('fulfilling')
    expect(order.priceCents).toBe(1_300)
    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } })
    expect(events.at(-1)?.reason).toMatch(/^ESCROW\|Refunded\|deposit:1\|block:\d+\|part refund, 13000000 units still held for the seller$/)
    expect((await keep(w)).partRefunds).toBe(0)

    // The shopper disputes: the seller's other listings leave quotes, and the payout waits 48 h more.
    const deadline = order.deadlineAt.getTime()
    expect((await w.node.chain.send(SHOPPER, w.escrow, escrowCall.dispute(b.depositId, keccak256(stringToHex('no scan'))))).ok).toBe(true)
    expect((await keep(w)).disputes).toBe(1)
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: l.intentId } })).failureReason).toBe('escrow_disputed')
    order = await prisma.order.findFirstOrThrow()
    expect(order.deadlineAt.getTime() - deadline).toBe(2 * DAY * 1000)
    expect((await keep(w)).disputes).toBe(0)

    // The seller refunds the rest: closed, refunded, and nothing of ours moved.
    const shopperBefore = await balanceOf(w, SHOPPER)
    expect((await w.node.chain.send(SELLER, w.escrow, escrowCall.sellerRefund(b.depositId, 13_000_000n))).ok).toBe(true)
    expect((await balanceOf(w, SHOPPER)) - shopperBefore).toBe(13_000_000n)
    const full = await keep(w, { key: generatePrivateKey() })
    expect(full).toMatchObject({ refunded: 1, payoutsDue: 0 })
    order = await prisma.order.findFirstOrThrow()
    expect(order).toMatchObject({ state: 'refunded', refundRef: null })
    const intent = await prisma.intent.findUniqueOrThrow({ where: { id: l.intentId } })
    expect(intent.state).toBe('refunded')
    expect(sentTxs(w)).toEqual([])
    const trail = (await prisma.orderEvent.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } })).map(
      (e) => `${e.fromState}->${e.toState}`,
    )
    expect(trail.slice(-2)).toEqual(['fulfilling->failed', 'failed->refunded'])
  })
})

describe('listings follow the chain', () => {
  it('a listing cancelled on chain is cancelled here, and one past its expiry is expired', async () => {
    const w = await serverWorld()
    const cancelled = await listedCard(w)
    const expiring = await listedCard(w, { expiresIn: 600 })
    const live = await listedCard(w)
    expect((await w.node.chain.send(SELLER, w.escrow, escrowCall.cancelListing(cancelled.listingId))).ok).toBe(true)
    w.node.advance(601)
    const r = await keep(w)
    expect(r).toMatchObject({ listingsCancelled: 1, listingsExpired: 1, errors: [] })
    const row = async (id: string) => prisma.intent.findUniqueOrThrow({ where: { id } })
    expect(await row(cancelled.intentId)).toMatchObject({ state: 'cancelled', cancellationReason: 'seller_reclaimed' })
    expect(await row(expiring.intentId)).toMatchObject({ state: 'cancelled', cancellationReason: 'expired' })
    expect((await row(live.intentId)).state).toBe('offered')
    expect((await row(live.intentId)).lastCheckedAt).not.toBeNull()
    expect(escrowIntentIdFor(live.listingId)).toBe(live.intentId)
  })
})

describe('claims', () => {
  it('a payout the token refused is claimed once it can land, and only as claim(to)', async () => {
    const w = await serverWorld()
    const l = await listedCard(w)
    await buyCard(w, l)
    const key = generatePrivateKey()
    await keep(w, { key })

    const blockRevert = decodeFunctionResult({
      abi: MOCK_TOKEN_ABI,
      functionName: 'BLOCK_REVERT',
      data: (await w.node.chain.call(testAddress(1), PATH_USD, encodeFunctionData({ abi: MOCK_TOKEN_ABI, functionName: 'BLOCK_REVERT' }))).returnData,
    })
    expect((await w.node.chain.send(testAddress(1), PATH_USD, tokenCall.setBlocked(SELLER, blockRevert))).ok).toBe(true)

    w.node.advance(DAY)
    expect(await keep(w, { key })).toMatchObject({ payoutsSent: 1 })
    // Released, but the token refused the seller: it waits as `owed`. The
    // claim's dry run reverts while the block stands, so nothing is sent.
    const blocked = await keep(w, { key })
    expect(blocked).toMatchObject({ released: 1, claimsDue: 1, claimsSent: 0 })
    expect(blocked.errors.join(' ')).toMatch(/claim\(/)
    expect(await balanceOf(w, SELLER)).toBe(0n)

    expect((await w.node.chain.send(testAddress(1), PATH_USD, tokenCall.setBlocked(SELLER, 0))).ok).toBe(true)
    const claimed = await keep(w, { key })
    expect(claimed).toMatchObject({ claimsDue: 1, claimsSent: 1 })
    expect(await balanceOf(w, SELLER)).toBe(BigInt(l.manifest.price))
    expect(await keep(w, { key })).toMatchObject({ claimsDue: 0, claimsSent: 0 })

    // Everything the keeper ever sent went to the escrow, as release or claim.
    const sent = sentTxs(w)
    expect(sent.length).toBeGreaterThanOrEqual(2)
    for (const tx of sent) {
      expect(tx.to).toBe(w.escrow)
      expect([RELEASE, CLAIM]).toContain(tx.selector)
    }
  })
})
