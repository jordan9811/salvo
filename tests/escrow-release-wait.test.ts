/**
 * The release route's chain check when one host is a block behind (measured
 * live on 2026-10-14: dRPC ran about a block behind Tempo's own host, so a
 * purchase one block old was "not there yet" on the phone's first ask, and
 * the card came a second later on its retry). Offline and database-free:
 * SalvoEscrowV2 on the in-process chain behind the two fake hosts, read
 * through the route's own reader and check (lit-escrow.ts releaseChecks).
 *
 * Pinned:
 *   - a deposit the host ahead shows and the agreed count does not yet is
 *     waited for, asking only the host behind for its head until it moves,
 *     then the count again: found on the first ask, at the block both hosts
 *     agree on, which the deposit is then read at;
 *   - one wait at a time: both cards of one purchase join the same wait;
 *   - a flood of made-up ids, with a host behind, waits for nothing and reads
 *     no more than a read did before (eight calls, six with the hosts level),
 *     and nothing more within the second;
 *   - a host that never catches up: "not there yet" after at most fourteen
 *     looks at its head, and the same read is never waited on again;
 *   - the agreed block is one round with the hosts level and two with one
 *     behind, asking only the host ahead for the block, and a host whose own
 *     head disagrees is still refused.
 *
 * No database, no network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeFunctionData, encodeFunctionResult } from 'viem'
import { ESCROW_V2_ABI } from '@/lib/escrow/artifact-v2'
import { SalvoEscrowV2Reader } from '@/lib/escrow/chain-v2'
import { __clearReleaseMemoryForTests, releaseChecks } from '@/lib/escrow/lit-escrow'
import { depositCountV2At } from '@/lib/escrow/runbook/reads-v2'
import { agreedFinalizedBlock, agreedFinalizedBlockAndHeads, rpcCall, type HostsConfig } from '@/lib/escrow/runbook/rpc'
import { closeServerWorldV2, listV2, serverWorldV2, SHOPPER_A, SHOPPER_B, useCardV2, type ServerWorldV2 } from './support/escrow-server-world-v2'
import { TEMPO_RPC_HOSTS } from './support/fake-tempo-rpc'

const RAIL = process.env.ESCROW_RAIL
const USAGE_KEY = process.env.LIT_VAULT_USAGE_KEY
/** The route's clock: fixed, so a read stays young for the whole test unless a test moves it. */
const NOW = 1_790_000_000_000
const DEPOSIT_COUNT = encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'depositCount' })
const [TEMPO, DRPC] = TEMPO_RPC_HOSTS.map((u) => new URL(u).host) as [string, string]

beforeEach(() => {
  process.env.ESCROW_RAIL = 'testnet'
  process.env.LIT_VAULT_USAGE_KEY = 'usage-key-for-tests'
  __clearReleaseMemoryForTests()
})

afterEach(() => {
  closeServerWorldV2()
  __clearReleaseMemoryForTests()
  for (const [k, v] of [['ESCROW_RAIL', RAIL], ['LIT_VAULT_USAGE_KEY', USAGE_KEY]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

interface Traced {
  host: string
  method: string
  params: unknown[]
}

/** The hosts the route reads, with every call kept in order, and how many rounds they came in (a call made while none was going starts one). */
function traced(w: ServerWorldV2): { hosts: HostsConfig; calls: Traced[]; rounds: () => number; reset: () => void } {
  const inner = w.hosts.fetchImpl as typeof fetch
  const calls: Traced[] = []
  let going = 0
  let rounds = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { method?: string; params?: unknown[] }
    calls.push({ host: new URL(String(input)).host, method: String(body.method), params: body.params ?? [] })
    if (going === 0) rounds += 1
    going += 1
    try {
      return await inner(input, init)
    } finally {
      going -= 1
    }
  }) as typeof fetch
  return {
    hosts: { ...w.hosts, urls: TEMPO_RPC_HOSTS, fetchImpl },
    calls,
    rounds: () => rounds,
    reset: () => {
      calls.length = 0
      rounds = 0
    },
  }
}

const heads = (calls: Traced[], host: string): number => calls.filter((c) => c.host === host && c.method === 'eth_getBlockByNumber' && c.params[0] === 'finalized').length

/**
 * dRPC a block behind: its head two of the fake's blocks back (the fake opens
 * an empty block after each it seals, and useCardV2's purchases land in the
 * block open then, `landedAt`). The fake keeps no history, so both hosts
 * answer the count at a block before `landedAt` as the one before those
 * purchases: the read the route decides "not there yet" on.
 */
function behind(w: ServerWorldV2, landedAt: bigint, countBefore: bigint, more: (m: string, p: unknown[], r: unknown) => unknown = (_m, _p, r) => r): void {
  const history = (method: string, params: unknown[], result: unknown): unknown => {
    const call = (params[0] ?? {}) as Record<string, unknown>
    const tag = params[1]
    if (method === 'eth_call' && call.data === DEPOSIT_COUNT && typeof tag === 'string' && tag.startsWith('0x') && BigInt(tag) < landedAt) {
      return encodeFunctionResult({ abi: ESCROW_V2_ABI, functionName: 'depositCount', result: countBefore })
    }
    return result
  }
  w.node.setHost(0, { lie: history })
  w.node.setHost(1, { lag: 2, lie: (m, p, r) => more(m, p, history(m, p, r)) })
}

/** One card bought in the block open now, then the chain moves on a block, with dRPC left behind the purchase. */
async function oneBought(w: ServerWorldV2): Promise<bigint> {
  const l = await listV2(w, { valueCents: 2_000 })
  const landedAt = w.node.chain.blockNumber
  const b = await useCardV2(w, l, SHOPPER_A, 2_000)
  w.node.advance(1)
  behind(w, landedAt, b.depositId - 1n)
  return b.depositId
}

describe('a purchase one block old on the host behind', () => {
  it('is waited for, asking only that host for its head until it moves, and found on the first ask', async () => {
    const w = await serverWorldV2()
    const id = await oneBought(w)
    const t = traced(w)
    // The measured condition: at the block both hosts agree on, the purchase is not there yet.
    expect(await depositCountV2At(t.hosts, await agreedFinalizedBlock(t.hosts), w.escrow)).toBe(id - 1n)
    t.reset()

    const out = await releaseChecks.exists(new SalvoEscrowV2Reader(w.escrow, t.hosts), id, NOW)
    expect(out).toMatchObject({ exists: true, count: id })
    // Read once (both hosts), looked at the host behind once, read again: Tempo's host was asked for its head twice, dRPC's three times.
    expect([heads(t.calls, TEMPO), heads(t.calls, DRPC)]).toEqual([2, 3])
    // Each read also asked the host ahead alone for its count at its own head: only ever a reason to wait.
    const counts = t.calls.filter((c) => c.method === 'eth_call' && (c.params[0] as Record<string, unknown>).data === DEPOSIT_COUNT)
    expect([counts.filter((c) => c.host === TEMPO).length, counts.filter((c) => c.host === DRPC).length]).toEqual([4, 2])
    // The block the count was read at, for the deposit to be read at too: one the host behind now has.
    expect(out.block).not.toBeNull()
    expect(await depositCountV2At(t.hosts, out.block ?? (await agreedFinalizedBlock(t.hosts)), w.escrow)).toBe(id)
  })

  it('one wait at a time: both cards of a purchase join it', async () => {
    const w = await serverWorldV2()
    const [l1, l2] = [await listV2(w, { valueCents: 2_000 }), await listV2(w, { valueCents: 1_600 })]
    const landedAt = w.node.chain.blockNumber
    const b1 = await useCardV2(w, l1, SHOPPER_A, 2_000)
    const b2 = await useCardV2(w, l2, SHOPPER_A, 1_200)
    w.node.advance(1)
    behind(w, landedAt, b1.depositId - 1n)
    const t = traced(w)
    const reader = new SalvoEscrowV2Reader(w.escrow, t.hosts)
    const [x, y] = await Promise.all([releaseChecks.exists(reader, b1.depositId, NOW), releaseChecks.exists(reader, b2.depositId, NOW)])
    expect([x.exists, y.exists]).toEqual([true, true])
    // The same calls one card's wait makes: one read, one look at the host behind, one read again.
    expect([heads(t.calls, TEMPO), heads(t.calls, DRPC)]).toEqual([2, 3])
  })

  it('a flood of made-up ids waits for nothing and reads no more than before: eight calls with a host behind, six level, nothing more within the second', async () => {
    const w = await serverWorldV2()
    const id = await oneBought(w)
    const t = traced(w)
    const reader = new SalvoEscrowV2Reader(w.escrow, t.hosts)
    // Just past what either host shows: the host ahead does not show it, so nothing is waited for.
    expect((await releaseChecks.exists(reader, id + 1n, NOW)).exists).toBe(false)
    expect(t.calls).toHaveLength(8)
    expect(heads(t.calls, DRPC)).toBe(1)
    t.reset()
    for (let i = 0n; i < 200n; i++) {
      expect((await releaseChecks.exists(reader, id + 1n + i * 7n, NOW)).exists).toBe(false)
    }
    expect(t.calls).toHaveLength(0)
    // A second on, the hosts level: one read, six calls.
    w.node.setHost(1, {})
    expect((await releaseChecks.exists(reader, id + 1n, NOW + 1_000)).exists).toBe(false)
    expect(t.calls).toHaveLength(6)
    expect(t.rounds()).toBe(2)
  })

  it('a host that never catches up: not there after at most fourteen looks at its head, and that read is never waited on again', async () => {
    const w = await serverWorldV2()
    const l = await listV2(w, { valueCents: 2_000 })
    const landedAt = w.node.chain.blockNumber
    const b = await useCardV2(w, l, SHOPPER_B, 2_000)
    w.node.advance(1)
    behind(w, landedAt, b.depositId - 1n)
    // dRPC stuck where it is.
    const stuck = await rpcCall(w.hosts, 1, 'eth_getBlockByNumber', ['finalized', false])
    behind(w, landedAt, b.depositId - 1n, (m, p, r) => (m === 'eth_getBlockByNumber' && p[0] === 'finalized' ? stuck : r))
    const t = traced(w)
    const reader = new SalvoEscrowV2Reader(w.escrow, t.hosts)
    expect((await releaseChecks.exists(reader, b.depositId, NOW)).exists).toBe(false)
    expect([heads(t.calls, TEMPO), heads(t.calls, DRPC)]).toEqual([1, 15])
    t.reset()
    // The phone's retry, within the second: answered from that read, with no wait.
    expect((await releaseChecks.exists(reader, b.depositId, NOW)).exists).toBe(false)
    expect(t.calls).toHaveLength(0)
  })
})

describe('the agreed block', () => {
  it('is one round with the hosts level, two with one behind, and only the host ahead is asked for the block', async () => {
    const w = await serverWorldV2()
    for (let i = 0; i < 4; i++) w.node.advance(1)
    const t = traced(w)
    const level = await agreedFinalizedBlockAndHeads(t.hosts)
    expect(t.rounds()).toBe(1)
    expect(t.calls.map((c) => c.method).sort()).toEqual(['eth_chainId', 'eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber'])
    expect(level.heads).toEqual([level.block.number, level.block.number])

    w.node.setHost(1, { lag: 2 })
    t.reset()
    const lagged = await agreedFinalizedBlockAndHeads(t.hosts)
    expect(t.rounds()).toBe(2)
    expect(lagged.block.number).toBe(lagged.heads[0] as bigint - 2n)
    expect(lagged.heads[1]).toBe(lagged.block.number)
    const byNumber = t.calls.filter((c) => c.method === 'eth_getBlockByNumber' && c.params[0] !== 'finalized')
    expect(byNumber.map((c) => [c.host, c.params[0]])).toEqual([[TEMPO, `0x${lagged.block.number.toString(16)}`]])
    expect(lagged.block.hash).toBe((await agreedFinalizedBlock(w.hosts)).hash)
  })

  it('still refuses a host whose own head says another hash or time for the block, or another chain', async () => {
    const w = await serverWorldV2()
    w.node.setHost(1, { lag: 2, lie: (m, p, r) => (m === 'eth_getBlockByNumber' && p[0] === 'finalized' && r !== null ? { ...(r as object), hash: `0x${'ab'.repeat(32)}` } : r) })
    await expect(agreedFinalizedBlockAndHeads(w.hosts)).rejects.toMatchObject({ kind: 'disagree' })
    w.node.setHost(0, { lie: (m, p, r) => (m === 'eth_getBlockByNumber' && p[0] !== 'finalized' && r !== null ? { ...(r as object), timestamp: '0x1' } : r) })
    w.node.setHost(1, { lag: 2 })
    await expect(agreedFinalizedBlockAndHeads(w.hosts)).rejects.toMatchObject({ kind: 'disagree' })
    w.node.setHost(0, {})
    w.node.setHost(1, { lie: (m, _p, r) => (m === 'eth_chainId' ? '0x1' : r) })
    await expect(agreedFinalizedBlockAndHeads(w.hosts)).rejects.toMatchObject({ kind: 'chain_id' })
  })
})
