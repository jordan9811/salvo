/**
 * The escrow runbook's view of Tempo Moderato: plain JSON-RPC to the two hosts
 * the template pins, read so that both must agree (spec section 15).
 *
 * WHY BOTH HOSTS. The template opens a card only when both pinned hosts agree
 * byte for byte at one finalized block (spec invariant 5). A deploy or a smoke
 * that checked one host could pass while the template refuses forever, or
 * pass on a host that lies. So every read the scripts gate on goes to both,
 * at one agreed finalized block, and a disagreement stops the run.
 *
 * WHAT IT SENDS. Single JSON-RPC calls, never batches (the dRPC free plan
 * refuses more than 3 per batch, measured), always with `redirect: "error"`,
 * so a redirect cannot carry a signed transaction to a host we did not pick.
 * Writes are transactions signed here with a key the caller holds; the only
 * thing that leaves is the signed bytes. A signed transaction is sent to the
 * first host, and the same bytes to the second only if the first could not be
 * reached. The same bytes are the same transaction, so this can never send two.
 *
 * WHAT NEVER COMES BACK OUT in an error: a request body, a key, a signed
 * transaction. Errors name the host, the method, and at most 160 printable
 * characters of the node's own error message (a revert reason, "nonce too
 * low"), which a public RPC shows to anyone.
 *
 * Plain EIP-1559 transactions only. Never a Tempo 0x76 batch: a deploy must be
 * a plain create (spec section 5), and the smoke's accounts are plain keys.
 * Fees on Tempo are paid in pathUSD for these (research: EVM compatibility,
 * "fallback in the case of a non-TIP-20 contract"), so every sender needs
 * pathUSD from the faucet first.
 *
 * Server, scripts and the browser. The shopper's phone and the seller's page
 * read the chain through this file too (src/lib/escrow/client/), so it
 * imports nothing Node-only: the host list comes from hosts.ts, not
 * config.ts, which reaches node:crypto. Makes a network call only when a
 * caller asks; tests pass a fake `fetchImpl` and never touch the network.
 */

import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { ESCROW_RPC_URLS } from '../hosts'
import { ESCROW_CHAIN_ID, PATH_USD } from '../manifest'

export const MODERATO_CHAIN_ID_HEX = `0x${ESCROW_CHAIN_ID.toString(16)}` as Hex
/** The template's MAX_HEAD_SPREAD: hosts further apart than this are not reading one chain. */
const MAX_HEAD_SPREAD = 30n
/** Tempo's per-transaction gas cap. */
export const TEMPO_TX_GAS_CAP = 30_000_000n
const DEFAULT_TIMEOUT_MS = 15_000
/**
 * How many times a busy host is asked again. Tempo's public host began
 * answering bursts with HTTP 429 (measured 2026-10-14, a page listing a
 * card); a till that stops at the first 429 fails a shopper at the register.
 * Every call here is a read or the same signed bytes again, so asking again
 * can never send two transactions.
 */
export const BUSY_RETRIES = 3
/** The first wait after a busy answer; each next one doubles, up to BUSY_WAIT_MAX_MS. */
const BUSY_WAIT_MS = 250
const BUSY_WAIT_MAX_MS = 2_000
/** A code read is about 23 KB of hex; nothing we ask for comes near this. */
const MAX_BODY_CHARS = 2_000_000
const MAX_MESSAGE_CHARS = 160
const ERROR_SELECTOR = '0x08c379a0'
const HEX_RE = /^0x[0-9a-fA-F]*$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HASH_RE = /^0x[0-9a-fA-F]{64}$/
const QUANTITY_RE = /^0x[0-9a-fA-F]{1,64}$/

export interface HostsConfig {
  /** The hosts, in the template's order. Default: the two it pins. Tests pass the same URLs with a fake fetch. */
  urls?: readonly string[]
  fetchImpl?: typeof fetch
  /** Per request. Default 15 s. */
  timeoutMs?: number
  /** Between polls. Tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>
  /** Milliseconds, for poll deadlines. Default Date.now. */
  now?: () => number
  /**
   * Fund from one of our own testnet accounts instead of the faucet. Tempo's
   * faucet (tempo_fundAddress) began answering every call with HTTP 413
   * "request too large" on 2026-10-12, so the runbook can name a key file
   * whose account already holds test pathUSD. An incoming transfer, like the
   * faucet's, leaves the receiver's nonce at 0.
   */
  funder?: { account: PrivateKeyAccount; amountUnits: bigint }
  /**
   * Tries again after a host says it is busy: HTTP 429 or 503, or, in a
   * browser, a request that never got a reply (Tempo's 429 carries no CORS
   * header, so the page sees only a failed fetch). Default BUSY_RETRIES.
   */
  busyRetries?: number
}

export type RpcFailureKind =
  | 'network'
  | 'timeout'
  | 'status'
  | 'bad_response'
  | 'rpc'
  | 'revert'
  /** A host is not on chain 42431. */
  | 'chain_id'
  /** The two hosts answered the same question differently. */
  | 'disagree'
  /** The hosts' finalized heads are more than 30 blocks apart. */
  | 'head_spread'

export class EscrowRpcError extends Error {
  readonly host: string
  readonly kind: RpcFailureKind
  /** The JSON-RPC error code, or the HTTP status for `status`. */
  readonly code: number | null
  /** For `revert`: the Error(string) reason, or "revert" when there was none. */
  readonly reason: string | null

  constructor(host: string, kind: RpcFailureKind, detail: string, code: number | null = null, reason: string | null = null) {
    super(`${host}: ${detail}`)
    this.name = 'EscrowRpcError'
    this.host = host
    this.kind = kind
    this.code = code
    this.reason = reason
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

function urlsOf(cfg: HostsConfig): readonly string[] {
  const urls = cfg.urls ?? ESCROW_RPC_URLS
  if (urls.length < 2) throw new RangeError('the escrow runbook reads at least two RPC hosts')
  return urls
}

function hostName(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'rpc'
  }
}

/** A node's own error text, cut short and stripped to printable ASCII. */
function cleanMessage(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  return s.replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_MESSAGE_CHARS)
}

function isTimeout(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined
  return name === 'TimeoutError' || name === 'AbortError'
}

/** The Error(string) reason in revert data or a node's message, or "revert". */
export function revertReasonOf(data: unknown, message: unknown): string {
  if (typeof data === 'string' && data.startsWith(ERROR_SELECTOR) && HEX_RE.test(data) && data.length >= 10 + 128) {
    try {
      const [reason] = decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}`)
      return cleanMessage(reason)
    } catch {
      // Fall through to the message.
    }
  }
  const m = cleanMessage(message)
  const at = m.indexOf('execution reverted: ')
  if (at >= 0) return m.slice(at + 'execution reverted: '.length)
  return 'revert'
}

function isRevert(code: unknown, message: string): boolean {
  return code === 3 || /revert/i.test(message)
}

/** A busy host's own word on when to ask again (Retry-After, in seconds), or null. */
function retryAfterMs(res: Response | null): number | null {
  const v = res?.headers.get('retry-after')
  if (v === null || v === undefined) return null
  const s = Number(v)
  return Number.isFinite(s) && s >= 0 ? s * 1000 : null
}

/**
 * One JSON-RPC call to host `index`. Never a batch. Throws EscrowRpcError
 * with fixed text and the node's short message. A busy host (HTTP 429 or
 * 503, or no reply at all) is asked again up to busyRetries times, waiting
 * longer each time; a timeout is not, since waiting again would double it.
 */
export async function rpcCall(cfg: HostsConfig, index: number, method: string, params: readonly unknown[]): Promise<unknown> {
  const url = urlsOf(cfg)[index]
  if (url === undefined) throw new RangeError('no such RPC host')
  const host = hostName(url)
  const doFetch = cfg.fetchImpl ?? fetch
  const retries = Math.max(0, cfg.busyRetries ?? BUSY_RETRIES)
  let res: Response | null = null
  for (let attempt = 0; ; attempt++) {
    let busy: EscrowRpcError | null = null
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        // A redirect would take a signed transaction to a host nobody chose.
        redirect: 'error',
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
      if (res.status === 429 || res.status === 503) busy = new EscrowRpcError(host, 'status', `${method}: HTTP ${res.status}`, res.status)
    } catch (err) {
      if (isTimeout(err)) throw new EscrowRpcError(host, 'timeout', `${method}: no answer in time`)
      res = null
      busy = new EscrowRpcError(host, 'network', `${method}: could not reach the host`)
    }
    if (busy === null) break
    if (attempt >= retries) throw busy
    const wait = Math.min(retryAfterMs(res) ?? BUSY_WAIT_MS * 2 ** attempt, BUSY_WAIT_MAX_MS)
    await (cfg.sleep ?? realSleep)(wait)
  }
  if (res === null) throw new EscrowRpcError(host, 'network', `${method}: could not reach the host`)
  let text: string
  try {
    text = await res.text()
  } catch (err) {
    if (isTimeout(err)) throw new EscrowRpcError(host, 'timeout', `${method}: no answer in time`)
    throw new EscrowRpcError(host, 'network', `${method}: the connection dropped mid-reply`)
  }
  if (res.status !== 200) throw new EscrowRpcError(host, 'status', `${method}: HTTP ${res.status}`, res.status)
  if (text.length > MAX_BODY_CHARS) throw new EscrowRpcError(host, 'bad_response', `${method}: the reply was too large`)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new EscrowRpcError(host, 'bad_response', `${method}: the reply was not JSON`)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new EscrowRpcError(host, 'bad_response', `${method}: the reply was not one JSON-RPC answer`)
  }
  const o = body as Record<string, unknown>
  if (o.error !== undefined) {
    const e = (typeof o.error === 'object' && o.error !== null ? o.error : {}) as Record<string, unknown>
    const code = typeof e.code === 'number' ? e.code : null
    const message = cleanMessage(e.message)
    if (isRevert(code, message)) {
      const reason = revertReasonOf(e.data, e.message)
      throw new EscrowRpcError(host, 'revert', `${method}: execution reverted (${reason})`, code, reason)
    }
    throw new EscrowRpcError(host, 'rpc', `${method}: ${message || 'error'}${code === null ? '' : ` (code ${code})`}`, code)
  }
  if (!('result' in o)) throw new EscrowRpcError(host, 'bad_response', `${method}: the reply has no result`)
  return o.result
}

/** The same call on every host, in parallel, in host order. */
async function onEveryHost(cfg: HostsConfig, method: string, params: readonly unknown[]): Promise<unknown[]> {
  return Promise.all(urlsOf(cfg).map((_u, i) => rpcCall(cfg, i, method, params)))
}

/** Stable text for comparing two hosts' answers: hex in lower case, bigints as decimal. */
function comparable(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (typeof x === 'bigint') return x.toString()
    if (typeof x === 'string' && HEX_RE.test(x)) return x.toLowerCase()
    return x
  })
}

function agreeOrThrow<T>(cfg: HostsConfig, values: readonly T[], what: string): T {
  const first = values[0] as T
  const text = comparable(first)
  for (const [i, v] of values.entries()) {
    if (comparable(v) !== text) {
      throw new EscrowRpcError(hostName(urlsOf(cfg)[i] ?? ''), 'disagree', `the hosts disagree about ${what}`)
    }
  }
  return first
}

function quantity(v: unknown, what: string, host: string): bigint {
  if (typeof v !== 'string' || !QUANTITY_RE.test(v)) throw new EscrowRpcError(host, 'bad_response', `${what} is not a hex quantity`)
  return BigInt(v)
}

function hexOf(v: unknown, what: string, host: string, re: RegExp = HEX_RE): Hex {
  if (typeof v !== 'string' || !re.test(v)) throw new EscrowRpcError(host, 'bad_response', `${what} is not the expected hex`)
  return v.toLowerCase() as Hex
}

function record(v: unknown, what: string, host: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new EscrowRpcError(host, 'bad_response', `${what} is not an object`)
  }
  return v as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// One agreed block
// ---------------------------------------------------------------------------

export interface AgreedBlock {
  number: bigint
  /** The block number as a hex tag, for reads at it. */
  tag: Hex
  hash: Hex
  /** Seconds. The chain's clock, which the template and the contract use. */
  timestamp: bigint
}

/** The agreed block, and each host's own finalized head when it was read, in host order. */
export interface AgreedHeads {
  block: AgreedBlock
  heads: bigint[]
}

/** A block number as the hex tag a read at it takes. */
export const blockTag = (n: bigint): Hex => `0x${n.toString(16)}` as Hex

/**
 * The block every gated read is made at, the way the template picks it: both
 * hosts on chain 42431, the lower of their finalized heads, at most 30 blocks
 * apart, and both reporting the same hash and time for it. On Tempo
 * `finalized` equals `latest` (measured), so this is also the newest final state.
 */
export async function agreedFinalizedBlock(cfg: HostsConfig): Promise<AgreedBlock> {
  return (await agreedFinalizedBlockAndHeads(cfg)).block
}

/**
 * agreedFinalizedBlock, with each host's own head beside it: the release
 * route reads the host that is ahead to tell a purchase one block old from
 * one that is not there (lit-escrow.ts ReleaseChecks).
 *
 * ONE ROUND WHEN THE HOSTS ARE LEVEL, TWO WHEN ONE IS BEHIND, never three.
 * The chain ids and the finalized heads are asked at once: a host on
 * another chain is still refused before anything it said is used. A host
 * whose finalized head is the lower one has already said what that block
 * is (a block's header is its hash and time, whichever tag it is asked by,
 * and a finalized block never changes), so only a host that is ahead is
 * asked for it. Every host's hash and time for the block must still agree.
 */
export async function agreedFinalizedBlockAndHeads(cfg: HostsConfig): Promise<AgreedHeads> {
  const urls = urlsOf(cfg)
  const [ids, heads] = await Promise.all([onEveryHost(cfg, 'eth_chainId', []), onEveryHost(cfg, 'eth_getBlockByNumber', ['finalized', false])])
  for (const [i, id] of ids.entries()) {
    if (typeof id !== 'string' || id.toLowerCase() !== MODERATO_CHAIN_ID_HEX) {
      throw new EscrowRpcError(hostName(urls[i] ?? ''), 'chain_id', 'is not Tempo Moderato (chain 42431)')
    }
  }
  const numbers = heads.map((h, i) => {
    const host = hostName(urls[i] ?? '')
    return quantity(record(h, 'the finalized block', host).number, 'the finalized block number', host)
  })
  let lo = numbers[0] ?? 0n
  let hi = lo
  for (const n of numbers) {
    if (n < lo) lo = n
    if (n > hi) hi = n
  }
  if (hi - lo > MAX_HEAD_SPREAD) {
    throw new EscrowRpcError('rpc hosts', 'head_spread', `the hosts' finalized heads are ${hi - lo} blocks apart (most allowed: 30)`)
  }
  const tag = blockTag(lo)
  const blocks = await Promise.all(heads.map((h, i) => (numbers[i] === lo ? h : rpcCall(cfg, i, 'eth_getBlockByNumber', [tag, false]))))
  const seen = blocks.map((b, i) => {
    const host = hostName(urls[i] ?? '')
    const o = record(b, `block ${lo}`, host)
    return { hash: hexOf(o.hash, 'the block hash', host, HASH_RE), timestamp: quantity(o.timestamp, 'the block time', host) }
  })
  const agreed = agreeOrThrow(cfg, seen, `block ${lo}`)
  return { block: { number: lo, tag, hash: agreed.hash, timestamp: agreed.timestamp }, heads: numbers }
}

/** Host `index`'s own finalized head, alone: what a wait for a host that is behind asks. */
export async function finalizedHeadOn(cfg: HostsConfig, index: number): Promise<bigint> {
  const host = hostName(urlsOf(cfg)[index] ?? '')
  const h = await rpcCall(cfg, index, 'eth_getBlockByNumber', ['finalized', false])
  return quantity(record(h, 'the finalized block', host).number, 'the finalized block number', host)
}

/**
 * eth_call on host `index` alone, at block `tag`. Never a gated read: what
 * one host says decides nothing on its own (the release route asks the host
 * that is ahead only whether waiting for the other could help).
 */
export async function callOnHost(cfg: HostsConfig, index: number, tag: Hex, call: { to: Hex; data: Hex }): Promise<Hex> {
  const host = hostName(urlsOf(cfg)[index] ?? '')
  return hexOf(await rpcCall(cfg, index, 'eth_call', [{ to: call.to, data: call.data }, tag]), 'the call result', host)
}

/** The same read at `block` on every host; they must agree. */
export async function readAgreed(cfg: HostsConfig, block: AgreedBlock, method: string, params: readonly unknown[]): Promise<unknown> {
  return agreeOrThrow(cfg, await onEveryHost(cfg, method, [...params, block.tag]), method)
}

/** The code at `address` on both hosts at `block`. */
export async function codeAt(cfg: HostsConfig, block: AgreedBlock, address: Hex): Promise<Hex> {
  return hexOf(await readAgreed(cfg, block, 'eth_getCode', [address]), 'the code', 'rpc hosts')
}

export type Simulation = { ok: true; returnData: Hex } | { ok: false; reason: string }

/**
 * eth_call at `block` on both hosts, reverts included: both must return the
 * same bytes or revert for the same reason. Free, and changes nothing.
 */
export async function simulateAt(cfg: HostsConfig, block: AgreedBlock, call: { from?: Hex; to: Hex; data: Hex }): Promise<Simulation> {
  const tx = { ...(call.from === undefined ? {} : { from: call.from }), to: call.to, data: call.data }
  const outcomes = await Promise.all(
    urlsOf(cfg).map(async (url, i): Promise<Simulation> => {
      try {
        return { ok: true, returnData: hexOf(await rpcCall(cfg, i, 'eth_call', [tx, block.tag]), 'the call result', hostName(url)) }
      } catch (err) {
        if (err instanceof EscrowRpcError && err.kind === 'revert') return { ok: false, reason: err.reason ?? 'revert' }
        throw err
      }
    }),
  )
  return agreeOrThrow(cfg, outcomes, 'eth_call')
}

/** eth_call that must succeed on both hosts; a revert throws. */
export async function callAt(cfg: HostsConfig, block: AgreedBlock, call: { from?: Hex; to: Hex; data: Hex }): Promise<Hex> {
  const r = await simulateAt(cfg, block, call)
  if (!r.ok) throw new EscrowRpcError('rpc hosts', 'revert', `eth_call reverted (${r.reason})`, 3, r.reason)
  return r.returnData
}

/** Each host's `pending` transaction count for `address`. A fresh deployer reads [0, 0]. */
export async function pendingNonces(cfg: HostsConfig, address: Hex): Promise<number[]> {
  const urls = urlsOf(cfg)
  const counts = await onEveryHost(cfg, 'eth_getTransactionCount', [address, 'pending'])
  return counts.map((c, i) => Number(quantity(c, 'the transaction count', hostName(urls[i] ?? ''))))
}

// ---------------------------------------------------------------------------
// Transactions and receipts
// ---------------------------------------------------------------------------

export interface ChainLog {
  address: Hex
  topics: Hex[]
  data: Hex
  logIndex: number
}

export interface ChainReceipt {
  transactionHash: Hex
  status: 'success' | 'reverted'
  blockNumber: bigint
  blockHash: Hex
  contractAddress: Hex | null
  gasUsed: bigint
  logs: ChainLog[]
}

/** The fields of a transaction the runbook reads. Fits verifyEscrowCreation's EscrowCreationTx. */
export interface ChainTx {
  hash: Hex
  from: Hex
  to: Hex | null
  nonce: bigint
  input: Hex
  /** As the node reports it, e.g. "0x2". verifyEscrowCreation accepts the plain-create ones. */
  type: string
  blockNumber: bigint | null
}

function parseReceipt(v: unknown, host: string): ChainReceipt {
  const o = record(v, 'the receipt', host)
  const status = o.status === '0x1' || o.status === 1 ? 'success' : o.status === '0x0' || o.status === 0 ? 'reverted' : null
  if (status === null) throw new EscrowRpcError(host, 'bad_response', 'the receipt has no status')
  if (!Array.isArray(o.logs)) throw new EscrowRpcError(host, 'bad_response', 'the receipt has no logs list')
  return {
    transactionHash: hexOf(o.transactionHash, 'the receipt hash', host, HASH_RE),
    status,
    blockNumber: quantity(o.blockNumber, 'the receipt block', host),
    blockHash: hexOf(o.blockHash, 'the receipt block hash', host, HASH_RE),
    contractAddress:
      o.contractAddress === null || o.contractAddress === undefined
        ? null
        : hexOf(o.contractAddress, 'the contract address', host, ADDRESS_RE),
    gasUsed: quantity(o.gasUsed, 'the gas used', host),
    logs: o.logs.map((raw, j) => {
      const l = record(raw, 'a log', host)
      if (!Array.isArray(l.topics)) throw new EscrowRpcError(host, 'bad_response', 'a log has no topics')
      return {
        address: hexOf(l.address, 'a log address', host, ADDRESS_RE),
        topics: l.topics.map((t) => hexOf(t, 'a log topic', host, HASH_RE)),
        data: hexOf(l.data, 'log data', host),
        logIndex: typeof l.logIndex === 'string' ? Number(quantity(l.logIndex, 'a log index', host)) : j,
      }
    }),
  }
}

function parseTx(v: unknown, host: string): ChainTx {
  const o = record(v, 'the transaction', host)
  const type = typeof o.type === 'string' ? o.type.toLowerCase() : ''
  return {
    hash: hexOf(o.hash, 'the transaction hash', host, HASH_RE),
    from: hexOf(o.from, 'the sender', host, ADDRESS_RE),
    to: o.to === null || o.to === undefined ? null : hexOf(o.to, 'the recipient', host, ADDRESS_RE),
    nonce: quantity(o.nonce, 'the nonce', host),
    input: hexOf(o.input, 'the input', host),
    type,
    blockNumber: o.blockNumber === null || o.blockNumber === undefined ? null : quantity(o.blockNumber, 'the block', host),
  }
}

/** A transaction and its receipt as both hosts report them, which must agree. Null while either has no receipt yet. */
export async function transactionOnBothHosts(cfg: HostsConfig, hash: Hex): Promise<{ tx: ChainTx; receipt: ChainReceipt } | null> {
  const urls = urlsOf(cfg)
  const receipts = await onEveryHost(cfg, 'eth_getTransactionReceipt', [hash])
  if (receipts.some((r) => r === null)) return null
  const txs = await onEveryHost(cfg, 'eth_getTransactionByHash', [hash])
  if (txs.some((t) => t === null)) return null
  const parsed = urls.map((u, i) => ({ tx: parseTx(txs[i], hostName(u)), receipt: parseReceipt(receipts[i], hostName(u)) }))
  return agreeOrThrow(cfg, parsed, `transaction ${hash}`)
}

/**
 * Wait until `hash` has the same receipt on both hosts and both call its block
 * finalized. A receipt alone is not enough: the template reads both hosts at
 * the lower finalized head, so a purchase only one host has finalized cannot
 * open a card yet. Throws `timeout` after `timeoutMs`; the transaction may
 * still land, so the caller says to look it up by hash.
 */
export async function waitForFinal(
  cfg: HostsConfig,
  hash: Hex,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ tx: ChainTx; receipt: ChainReceipt; waitedMs: number }> {
  const now = cfg.now ?? Date.now
  const sleep = cfg.sleep ?? realSleep
  const started = now()
  const timeoutMs = opts.timeoutMs ?? 120_000
  for (;;) {
    const both = await transactionOnBothHosts(cfg, hash)
    if (both !== null) {
      const block = await agreedFinalizedBlock(cfg)
      if (block.number >= both.receipt.blockNumber) return { ...both, waitedMs: now() - started }
    }
    if (now() - started > timeoutMs) {
      throw new EscrowRpcError(
        'rpc hosts',
        'timeout',
        `transaction ${hash} is not final on both hosts after ${Math.round(timeoutMs / 1000)} s; it may still land, so look it up by hash before sending anything else`,
      )
    }
    await sleep(opts.pollMs ?? 500)
  }
}

/** A receipt as both hosts report it, which must agree. Null while either has none yet. */
export async function receiptOnBothHosts(cfg: HostsConfig, hash: Hex): Promise<ChainReceipt | null> {
  const urls = urlsOf(cfg)
  const receipts = await onEveryHost(cfg, 'eth_getTransactionReceipt', [hash])
  if (receipts.some((r) => r === null)) return null
  return agreeOrThrow(
    cfg,
    urls.map((u, i) => parseReceipt(receipts[i], hostName(u))),
    `the receipt of ${hash}`,
  )
}

/**
 * `waitForFinal` for a Tempo 0x76 batch, which the phone and the seller's page
 * send: the same receipt on both hosts, in a block both call finalized.
 *
 * WHY THE RECEIPT ALONE. A 0x76 transaction carries a list of calls, not one
 * `to` and `input`, so the plain-transaction fields waitForFinal compares are
 * not there to compare. Everything the escrow pages act on is in the receipt:
 * its status, and the escrow's own events (Listed, Opened), which reads.ts
 * decodes from it. Throws `timeout` after `timeoutMs`; the batch may still
 * land, so the caller keeps its hash and looks it up again before sending
 * anything new.
 */
export async function waitForReceiptFinal(
  cfg: HostsConfig,
  hash: Hex,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ receipt: ChainReceipt; block: AgreedBlock; waitedMs: number }> {
  const now = cfg.now ?? Date.now
  const sleep = cfg.sleep ?? realSleep
  const started = now()
  const timeoutMs = opts.timeoutMs ?? 60_000
  for (;;) {
    const receipt = await receiptOnBothHosts(cfg, hash)
    if (receipt !== null) {
      const block = await agreedFinalizedBlock(cfg)
      if (block.number >= receipt.blockNumber) return { receipt, block, waitedMs: now() - started }
    }
    if (now() - started > timeoutMs) {
      throw new EscrowRpcError(
        'rpc hosts',
        'timeout',
        `transaction ${hash} is not final on both hosts after ${Math.round(timeoutMs / 1000)} s; it may still land`,
      )
    }
    await sleep(opts.pollMs ?? 400)
  }
}

// ---------------------------------------------------------------------------
// The till's fast path: one host's receipt, then the other's agreement
// ---------------------------------------------------------------------------

/** Each host's receipt is asked for this often while a purchase waits on it. */
export const RECEIPT_POLL_MS = 100

/** A host's word that it has no such method: JSON-RPC's "method not found", or the node saying so in words. */
function methodMissing(err: unknown): boolean {
  return err instanceof EscrowRpcError && err.kind === 'rpc' && (err.code === -32601 || /does not exist|not available|not supported|method not found|unknown method/i.test(err.message))
}

/** A node's word that it already has these bytes: they are sent. */
function alreadyKnown(err: unknown): boolean {
  return err instanceof EscrowRpcError && err.kind === 'rpc' && /already known|known transaction/i.test(err.message)
}

/** An error that says nothing about whether the bytes reached the host. */
function unreachable(err: unknown): boolean {
  return err instanceof EscrowRpcError && ['network', 'timeout', 'status'].includes(err.kind)
}

/**
 * How signed bytes left: `receipt` is the first host's receipt when it sent
 * and waited in one call (eth_sendRawTransactionSync, EIP-7966), null when
 * the receipt is still to be asked for; `host` is the host that took them.
 */
export interface SentRaw {
  receipt: ChainReceipt | null
  host: number
}

/**
 * Send signed bytes and, where the host can, wait for the receipt in the same
 * call: eth_sendRawTransactionSync on the first host (Tempo's own answers it;
 * dRPC does not). A host without it gets eth_sendRawTransaction instead. As
 * sendSigned: the second host is tried only when the first could not be
 * reached, and the same bytes are the same transaction, so this can never
 * send two. A node's refusal (nonce, funds) is an answer and is thrown.
 *
 * A sync call that timed out on the host's side ("not included yet") still
 * sent the bytes: the receipt is then asked for, never the bytes sent again.
 */
export async function sendRawFast(cfg: HostsConfig, raw: Hex, hash: Hex): Promise<SentRaw> {
  const urls = urlsOf(cfg)
  let last: unknown = null
  for (let i = 0; i < urls.length; i++) {
    const host = hostName(urls[i] ?? '')
    if (i === 0) {
      try {
        const got = await rpcCall(cfg, 0, 'eth_sendRawTransactionSync', [raw])
        const receipt = parseReceipt(got, host)
        if (receipt.transactionHash !== hash) throw new EscrowRpcError(host, 'bad_response', 'eth_sendRawTransactionSync answered for another transaction')
        return { receipt, host: 0 }
      } catch (err) {
        if (alreadyKnown(err)) return { receipt: null, host: 0 }
        // EIP-7966's own timeout: sent, not in a block yet. The receipt is asked for next.
        if (err instanceof EscrowRpcError && err.kind === 'rpc' && (err.code === 4 || /timed? ?out|not (yet )?included/i.test(err.message))) return { receipt: null, host: 0 }
        if (unreachable(err)) {
          last = err
          continue
        }
        if (!methodMissing(err)) throw err
      }
    }
    try {
      const got = await rpcCall(cfg, i, 'eth_sendRawTransaction', [raw])
      if (typeof got === 'string' && got.toLowerCase() !== hash) throw new EscrowRpcError(host, 'bad_response', 'eth_sendRawTransaction answered with another hash')
      return { receipt: null, host: i }
    } catch (err) {
      if (alreadyKnown(err)) return { receipt: null, host: i }
      if (!unreachable(err)) throw err
      last = err
    }
  }
  throw last instanceof Error ? last : new Error('no host took the transaction')
}

/**
 * One host's receipt for `hash`, asked every RECEIPT_POLL_MS until it has
 * one. Throws `timeout` after `timeoutMs`: the transaction may still land.
 * On Tempo a receipt is in a block, and finalized equals latest (measured
 * 2026-10-13), so one host's receipt is that host's final word; the other
 * host is asked separately (receiptAgreed).
 */
export async function receiptOnHost(cfg: HostsConfig, index: number, hash: Hex, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<ChainReceipt> {
  const now = cfg.now ?? Date.now
  const sleep = cfg.sleep ?? realSleep
  const started = now()
  const host = hostName(urlsOf(cfg)[index] ?? '')
  for (;;) {
    let got: unknown = null
    try {
      got = await rpcCall(cfg, index, 'eth_getTransactionReceipt', [hash])
    } catch (err) {
      if (!unreachable(err)) throw err
    }
    if (got !== null && got !== undefined) return parseReceipt(got, host)
    if (now() - started > (opts.timeoutMs ?? 60_000)) {
      throw new EscrowRpcError(host, 'timeout', `transaction ${hash} has no receipt on this host yet; it may still land`)
    }
    await sleep(opts.pollMs ?? RECEIPT_POLL_MS)
  }
}

/**
 * The second host's agreement with a receipt the first host gave: every host
 * has the same receipt, and both call its block finalized. What
 * waitForReceiptFinal returns, for a receipt already in hand, asked every
 * RECEIPT_POLL_MS rather than every 400 ms. A host that reports another
 * receipt throws `disagree`.
 */
export async function receiptAgreed(
  cfg: HostsConfig,
  first: ChainReceipt,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ receipt: ChainReceipt; block: AgreedBlock; waitedMs: number }> {
  const now = cfg.now ?? Date.now
  const sleep = cfg.sleep ?? realSleep
  const started = now()
  const timeoutMs = opts.timeoutMs ?? 60_000
  const urls = urlsOf(cfg)
  const others = await Promise.all(
    urls.map((_u, i) => receiptOnHost(cfg, i, first.transactionHash, { timeoutMs, pollMs: opts.pollMs ?? RECEIPT_POLL_MS })),
  )
  const receipt = agreeOrThrow(cfg, [first, ...others], `the receipt of ${first.transactionHash}`)
  for (;;) {
    const block = await agreedFinalizedBlock(cfg)
    if (block.number >= receipt.blockNumber) return { receipt, block, waitedMs: now() - started }
    if (now() - started > timeoutMs) {
      throw new EscrowRpcError('rpc hosts', 'timeout', `transaction ${first.transactionHash} is not final on both hosts yet; it may still land`)
    }
    await sleep(opts.pollMs ?? RECEIPT_POLL_MS)
  }
}

export interface SignedTx {
  raw: Hex
  hash: Hex
  from: Hex
  to: Hex | null
  nonce: number
  gas: bigint
  /** What the node estimated, before the margin. */
  gasEstimate: bigint
}

/**
 * Sign one plain EIP-1559 transaction from `account`, with a gas limit the
 * first host estimated plus 30%, and fees from its gas price. Sends nothing.
 *
 * The estimate is a dry run of the real call, so a call that would revert
 * (a constructor refusing its arguments, a listing already sold) throws a
 * `revert` here, and nothing has been sent. Gas matters more than usual on
 * Tempo: a new storage slot costs 250,000 gas, and a deploy that runs out of
 * gas still uses up the deployer's nonce 0 for good.
 */
export async function signTransaction(
  cfg: HostsConfig,
  account: PrivateKeyAccount,
  req: { to: Hex | null; data: Hex; nonce?: number },
): Promise<SignedTx> {
  const from = account.address.toLowerCase() as Hex
  const host = hostName(urlsOf(cfg)[0] ?? '')
  const nonce =
    req.nonce ?? Number(quantity(await rpcCall(cfg, 0, 'eth_getTransactionCount', [from, 'pending']), 'the nonce', host))
  const call = { from, ...(req.to === null ? {} : { to: req.to }), data: req.data }
  const gasEstimate = quantity(await rpcCall(cfg, 0, 'eth_estimateGas', [call]), 'the gas estimate', host)
  if (gasEstimate > TEMPO_TX_GAS_CAP) {
    throw new EscrowRpcError(host, 'rpc', `the transaction needs ${gasEstimate} gas, over Tempo's 30M cap`)
  }
  const padded = (gasEstimate * 13n + 9n) / 10n
  const gas = padded > TEMPO_TX_GAS_CAP ? TEMPO_TX_GAS_CAP : padded
  const gasPrice = quantity(await rpcCall(cfg, 0, 'eth_gasPrice', []), 'the gas price', host)
  const maxFeePerGas = gasPrice * 2n > 0n ? gasPrice * 2n : 1n
  let tip = 0n
  try {
    tip = quantity(await rpcCall(cfg, 0, 'eth_maxPriorityFeePerGas', []), 'the priority fee', host)
  } catch (err) {
    // Not every node serves it; a zero tip still pays the base fee.
    if (!(err instanceof EscrowRpcError) || (err.kind !== 'rpc' && err.kind !== 'bad_response')) throw err
  }
  const maxPriorityFeePerGas = tip > maxFeePerGas ? maxFeePerGas : tip
  const raw = await account.signTransaction({
    type: 'eip1559',
    chainId: ESCROW_CHAIN_ID,
    nonce,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    ...(req.to === null ? {} : { to: req.to }),
    data: req.data,
    value: 0n,
  })
  return { raw, hash: keccak256(raw), from, to: req.to, nonce, gas, gasEstimate }
}

/**
 * Send signed bytes. To the first host; to the second only if the first could
 * not be reached (the same bytes are the same transaction, so this never sends
 * two). A host that already has it counts as sent. Returns the hash.
 */
export async function sendSigned(cfg: HostsConfig, tx: SignedTx): Promise<Hex> {
  const urls = urlsOf(cfg)
  let lastError: unknown = null
  for (let i = 0; i < urls.length; i++) {
    try {
      const got = await rpcCall(cfg, i, 'eth_sendRawTransaction', [tx.raw])
      if (typeof got !== 'string' || got.toLowerCase() !== tx.hash) {
        throw new EscrowRpcError(hostName(urls[i] ?? ''), 'bad_response', 'eth_sendRawTransaction answered with another hash')
      }
      return tx.hash
    } catch (err) {
      if (err instanceof EscrowRpcError && err.kind === 'rpc' && /already known|known transaction/i.test(err.message)) {
        return tx.hash
      }
      // Only an unreachable host is worth the other one. A refusal (nonce too
      // low, no funds) is an answer, and the other host would give it too.
      if (!(err instanceof EscrowRpcError) || !['network', 'timeout', 'status'].includes(err.kind)) throw err
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no host took the transaction')
}

/** Sign, send and wait for one transaction to be final on both hosts. A reverted receipt is returned, not thrown. */
export async function sendAndWait(
  cfg: HostsConfig,
  account: PrivateKeyAccount,
  req: { to: Hex | null; data: Hex; nonce?: number },
  opts: { timeoutMs?: number; onSigned?: (tx: SignedTx) => void } = {},
): Promise<{ signed: SignedTx; tx: ChainTx; receipt: ChainReceipt; ms: number }> {
  const now = cfg.now ?? Date.now
  const started = now()
  const signed = await signTransaction(cfg, account, req)
  opts.onSigned?.(signed)
  await sendSigned(cfg, signed)
  const final = await waitForFinal(cfg, signed.hash, opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs })
  return { signed, tx: final.tx, receipt: final.receipt, ms: now() - started }
}

const TRANSFER_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

/**
 * Ask the faucet for test dollars (tempo_fundAddress, faucet-enabled testnet
 * hosts only, so the first host). It mints to the address from the faucet's
 * own account: an incoming transfer, so the address's nonce stays 0.
 *
 * With `cfg.funder`, no faucet: one pathUSD transfer of `amountUnits` from
 * the funder to the address, final on both hosts, and its hash. Also an
 * incoming transfer, so the address's nonce stays 0 here too. A transfer that
 * lands reverted throws.
 */
export async function requestFaucet(cfg: HostsConfig, address: Hex): Promise<Hex[]> {
  if (cfg.funder !== undefined) {
    const data = encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [address, cfg.funder.amountUnits] })
    const sent = await sendAndWait({ ...cfg, funder: undefined }, cfg.funder.account, { to: PATH_USD, data })
    if (sent.receipt.status !== 'success') {
      throw new EscrowRpcError(hostName(urlsOf(cfg)[0] ?? ''), 'bad_response', 'the funding transfer reverted')
    }
    return [sent.signed.hash]
  }
  const host = hostName(urlsOf(cfg)[0] ?? '')
  const got = await rpcCall(cfg, 0, 'tempo_fundAddress', [address])
  if (!Array.isArray(got)) throw new EscrowRpcError(host, 'bad_response', 'tempo_fundAddress did not answer with a list')
  return got.map((h) => hexOf(h, 'a faucet transaction hash', host, HASH_RE))
}

/** Sleep through `cfg`, so tests do not wait. */
export function hostSleep(cfg: HostsConfig, ms: number): Promise<void> {
  return (cfg.sleep ?? realSleep)(ms)
}
