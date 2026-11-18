/**
 * FakeTempoRpc: the two Tempo Moderato RPC hosts the escrow templates pin,
 * served over one in-process EVM (tests/support/evm.ts) that runs the real,
 * committed SalvoEscrowV1 or SalvoEscrowV2 (both, for V2: it reads V1). Test-only;
 * never referenced from src/. It is a `fetch`, handed to the fake Lit sandbox,
 * so nothing opens a socket.
 *
 * WHAT IT IS FAITHFUL TO, because the template's chain gate depends on each:
 *   - The JSON-RPC methods the template sends: eth_chainId,
 *     eth_getBlockByNumber ("finalized" or a hex number), eth_getCode and
 *     eth_call at a block number. On Tempo `finalized` equals `latest`
 *     (measured, spec section 2), so a host reports the head as finalized.
 *   - dRPC's free plan: a batch of more than 3 calls is refused, with error
 *     code 31 on every item and HTTP 200 (measured, spec section 2). Both
 *     hosts refuse here, so a template that batches 4 fails on both.
 *   - Reverts come back as geth does: code 3 and the revert data.
 *   - A redirect obeys fetch's `redirect` option: "error" rejects, "manual"
 *     sees the 3xx, and "follow" (the default) silently gets an answer from
 *     the mirror. That is the dangerous case, so a template that forgets
 *     `redirect: "error"` passes here and a test catches it.
 *
 * PER HOST, a test can make it misbehave: down (network error or an HTTP
 * status), stall (answers only by rejecting when aborted), lag (finalized N
 * blocks behind), redirect, an oversize body (valid JSON padded past the
 * template's 262144-character cap), or lie (rewrite any result).
 *
 * WHAT IT IS NOT: history. The EVM keeps only current state, so a read at an
 * older block returns current state. Block headers for older numbers come
 * from heads this fake has seen (every request records the head; `observe()`
 * records it on demand); a block it never saw is null, as an unknown block is.
 * A test that lags a host must not change state inside the lag window.
 */

import { bytesToHex, hexToBigInt, hexToBytes, isHex, numberToHex, type Hex } from 'viem'
import { createAddressFromString } from '@ethereumjs/util'
import { EvmRpcError, type TestChain } from './evm'
import { deployMockToken } from './escrow-chain'

/** The template's RPCS, in its order. */
export const TEMPO_RPC_HOSTS = ['https://rpc.moderato.tempo.xyz', 'https://tempo-moderato-testnet.drpc.org'] as const
export type TempoRpcHost = (typeof TEMPO_RPC_HOSTS)[number]

/** pathUSD on Moderato. The template accepts no other token. */
export const PATH_USD_ADDRESS: Hex = '0x20c0000000000000000000000000000000000000'

/**
 * A `lie` that replaces word `i` (0-based) of every eth_call result with
 * `word` (64 hex digits): gate() is one call, 8 words on V1 and 11 on V2, so
 * this is how a test makes a host report another seller, state or value left.
 */
export function gateWordLie(i: number, word: string): (call: RpcCall, result: unknown) => unknown {
  if (!/^[0-9a-f]{64}$/.test(word)) throw new Error('gateWordLie: a word is 64 lower-case hex digits')
  return (call: RpcCall, result: unknown): unknown => {
    if (call.method !== 'eth_call' || typeof result !== 'string') return result
    const at = 2 + 64 * i
    return result.slice(0, at) + word + result.slice(at + 64)
  }
}

/** The template refuses a body longer than this many characters. */
export const TEMPLATE_MAX_BODY = 262_144
const DRPC_BATCH_ERROR = { code: 31, message: 'Batch of more than 3 requests are not allowed on free plan' }

export interface RpcCall {
  method: string
  params: unknown[]
}

export interface HostBehaviour {
  /** 'network': fetch rejects. A number: that HTTP status. */
  down?: 'network' | number
  /** Never answers; rejects with the abort reason when the caller aborts. */
  stall?: boolean
  /** Report `finalized` (and serve blocks up to) this many blocks behind the head. */
  lag?: number
  /** Answer with a 302 to a mirror. */
  redirect?: boolean
  /** Pad the JSON body with spaces past the template's cap. */
  oversize?: boolean
  /** Rewrite a result before it is sent. Return the result unchanged to leave it be. */
  lie?: (call: RpcCall, result: unknown) => unknown
  /** Most calls in one batch. Default 3. */
  maxBatch?: number
}

export interface RpcRequestRecord {
  host: TempoRpcHost
  httpMethod: string
  redirect: RequestRedirect | undefined
  /** Whether the caller passed an AbortSignal (the template's timeout). */
  signalled: boolean
  bodyText: string
  /** The JSON-RPC calls in the request, in order. Empty when the body did not parse. */
  calls: RpcCall[]
  outcome: 'answered' | 'network' | 'status' | 'stalled' | 'redirect-refused' | 'redirect-manual' | 'redirect-followed'
}

interface Header {
  number: Hex
  hash: Hex
  timestamp: Hex
}

function hostOf(input: string | URL | Request): TempoRpcHost | null {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let origin: string
  try {
    origin = new URL(href).origin
  } catch {
    return null
  }
  return TEMPO_RPC_HOSTS.find((h) => h === origin) ?? null
}

function rpcError(id: unknown, code: number, message: string, data?: Hex): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }
}

export class FakeTempoRpc {
  readonly chain: TestChain
  readonly requests: RpcRequestRecord[] = []
  private readonly behaviour = new Map<TempoRpcHost, HostBehaviour>()
  private readonly history = new Map<bigint, Header>()

  constructor(chain: TestChain) {
    this.chain = chain
    this.observe()
  }

  /** Set one host's behaviour, replacing what it had. `{}` makes it honest again. */
  setHost(host: TempoRpcHost | 0 | 1, b: HostBehaviour): void {
    this.behaviour.set(typeof host === 'number' ? TEMPO_RPC_HOSTS[host] : host, b)
  }

  /** Make both hosts honest and forget the request log. */
  reset(): void {
    this.behaviour.clear()
    this.requests.length = 0
  }

  /** Record the current head, so a lagging host can serve it after the chain moves on. */
  observe(): void {
    this.history.set(this.chain.blockNumber, {
      number: numberToHex(this.chain.blockNumber),
      hash: this.chain.blockHash(),
      timestamp: numberToHex(this.chain.timestamp),
    })
  }

  /** The largest batch any caller sent. */
  largestBatch(): number {
    return this.requests.reduce((n, r) => Math.max(n, r.calls.length), 0)
  }

  /** A `fetch` for the two pinned hosts. Any other URL is a test bug and throws. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const host = hostOf(input)
    if (host === null) throw new Error('FakeTempoRpc: not one of the pinned RPC hosts')
    this.observe()
    const b = this.behaviour.get(host) ?? {}
    const bodyText = typeof init?.body === 'string' ? init.body : ''
    const record: RpcRequestRecord = {
      host,
      httpMethod: (init?.method ?? 'GET').toUpperCase(),
      redirect: init?.redirect,
      signalled: init?.signal !== undefined && init.signal !== null,
      bodyText,
      calls: [],
      outcome: 'answered',
    }
    this.requests.push(record)

    let parsed: unknown = null
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      parsed = null
    }
    const items: unknown[] = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed]
    record.calls = items.map((x) => {
      const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>
      return { method: String(o.method), params: Array.isArray(o.params) ? o.params : [] }
    })

    if (b.down === 'network') {
      record.outcome = 'network'
      throw new TypeError('fetch failed')
    }
    if (typeof b.down === 'number') {
      record.outcome = 'status'
      return new Response('{"error":"unavailable"}', { status: b.down, headers: { 'Content-Type': 'application/json' } })
    }
    if (b.stall) {
      record.outcome = 'stalled'
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    if (b.redirect) {
      const mode = init?.redirect ?? 'follow'
      if (mode === 'error') {
        record.outcome = 'redirect-refused'
        throw new TypeError('fetch failed: unexpected redirect')
      }
      if (mode === 'manual') {
        record.outcome = 'redirect-manual'
        return new Response(null, { status: 302, headers: { Location: 'https://mirror.invalid/' } })
      }
      // Followed: the mirror answers honestly. Only redirect:"error" stops this.
      record.outcome = 'redirect-followed'
    }
    if (record.httpMethod !== 'POST') return new Response('method not allowed', { status: 405 })
    if (parsed === null || typeof parsed !== 'object') {
      return new Response(JSON.stringify(rpcError(null, -32700, 'parse error')), { status: 200 })
    }

    const maxBatch = b.maxBatch ?? 3
    let out: unknown
    if (Array.isArray(parsed) && parsed.length > maxBatch) {
      out = parsed.map((x) => rpcError((x as { id?: unknown } | null)?.id ?? null, DRPC_BATCH_ERROR.code, DRPC_BATCH_ERROR.message))
    } else {
      const answers: unknown[] = []
      for (const [i, item] of items.entries()) {
        const id = (item as { id?: unknown } | null)?.id ?? null
        const call = record.calls[i] ?? { method: '', params: [] }
        try {
          const result = await this.answer(call, b)
          answers.push({ jsonrpc: '2.0', id, result: b.lie ? b.lie(call, result) : result })
        } catch (err) {
          if (err instanceof EvmRpcError) answers.push(rpcError(id, err.code, err.message, err.data))
          else throw err
        }
      }
      out = Array.isArray(parsed) ? answers : answers[0]
    }

    let text = JSON.stringify(out)
    if (b.oversize) text += ' '.repeat(Math.max(1, TEMPLATE_MAX_BODY + 1 - text.length))
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  /** The head this host admits to. */
  private hostHead(b: HostBehaviour): bigint {
    return this.chain.blockNumber - BigInt(b.lag ?? 0)
  }

  /** A block tag as a number this host will serve, or null when it does not know that block. */
  private blockNumberOf(tag: unknown, b: HostBehaviour): bigint | null {
    const head = this.hostHead(b)
    if (tag === 'finalized' || tag === 'latest' || tag === 'safe' || tag === undefined) return head >= 1n ? head : null
    if (typeof tag !== 'string' || !isHex(tag)) throw new EvmRpcError(-32602, 'invalid block tag')
    const n = hexToBigInt(tag)
    return n <= head ? n : null
  }

  private header(n: bigint): Header | null {
    if (n === this.chain.blockNumber) {
      return { number: numberToHex(n), hash: this.chain.blockHash(), timestamp: numberToHex(this.chain.timestamp) }
    }
    return this.history.get(n) ?? null
  }

  private async answer(call: RpcCall, b: HostBehaviour): Promise<unknown> {
    const p = call.params
    switch (call.method) {
      case 'eth_chainId':
        return numberToHex(this.chain.chainId)
      case 'eth_blockNumber':
        return numberToHex(this.hostHead(b))
      case 'eth_getBlockByNumber': {
        const n = this.blockNumberOf(p[0], b)
        return n === null ? null : this.header(n)
      }
      case 'eth_getCode': {
        if (this.blockNumberOf(p[1], b) === null) throw new EvmRpcError(-32000, 'header not found')
        return this.chain.request({ method: 'eth_getCode', params: [p[0]] })
      }
      case 'eth_call': {
        if (this.blockNumberOf(p[1], b) === null) throw new EvmRpcError(-32000, 'header not found')
        return this.chain.request({ method: 'eth_call', params: [p[0]] })
      }
      default:
        throw new EvmRpcError(-32601, `the method ${call.method} does not exist/is not available`)
    }
  }
}

/**
 * Put a MockToken (6 decimals, so the escrow's constructor accepts it) at the
 * pathUSD address, where the template requires the escrow's token to be.
 * Deploys one normally, then copies its runtime code: decimals is immutable,
 * so it lives in the code, and every other slot starts at zero anyway.
 */
export async function installPathUsd(chain: TestChain, deployer: Hex): Promise<Hex> {
  const scratch = await deployMockToken(chain, deployer, 6)
  const code = await chain.getCode(scratch)
  await chain.evm.stateManager.putCode(createAddressFromString(PATH_USD_ADDRESS), hexToBytes(code))
  if (bytesToHex(await chain.evm.stateManager.getCode(createAddressFromString(PATH_USD_ADDRESS))) !== code) {
    throw new Error('installPathUsd: code did not land')
  }
  return PATH_USD_ADDRESS
}
