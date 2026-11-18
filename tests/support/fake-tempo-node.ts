/**
 * FakeTempoNode: the two pinned Moderato hosts as the runbook scripts see
 * them, over one in-process EVM (tests/support/evm.ts). Test-only; never
 * referenced from src/. It is a `fetch`, so nothing opens a socket.
 *
 * FakeTempoRpc (fake-tempo-rpc.ts) serves the template's four read methods
 * and stays the template's view of the chain. This serves what the scripts
 * also need, over the same TestChain:
 *   - signed transactions: eth_sendRawTransaction takes a real signed EIP-1559
 *     transaction (viem parses it and recovers the sender), checks the chain
 *     id and the sender's nonce, runs it on the EVM from that sender, and
 *     closes the block. A create lands at keccak(rlp(sender, nonce)), and a
 *     reverted transaction still uses up its nonce, as on a real chain.
 *   - eth_getTransactionByHash, eth_getTransactionReceipt (with logs),
 *     eth_getTransactionCount, eth_estimateGas (a dry run; a revert answers
 *     code 3 with the reason), eth_gasPrice, eth_maxPriorityFeePerGas.
 *   - tempo_fundAddress: mints 1M test pathUSD to the address from a faucet
 *     account, so the funded address's nonce stays 0.
 *   - eth_chainId, eth_getBlockByNumber, eth_getCode and eth_call at any
 *     block the node has served (state is always current: no history).
 *
 * PER HOST, a test can make it misbehave: down (network error or an HTTP
 * status), lag (finalized and receipts N blocks behind), a redirect, or a lie
 * (rewrite any result). Every request is recorded, with its body, so a test
 * can prove what was and was not sent.
 *
 * NOT MODELED: fees (Tempo charges pathUSD; here gas is free), a mempool (a
 * transaction runs as soon as it arrives), or Tempo's gas schedule.
 */

import { Account, createAddressFromString } from '@ethereumjs/util'
import {
  bytesToHex,
  encodeFunctionData,
  hexToBigInt,
  hexToBytes,
  isHex,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from 'viem'
import { EvmRpcError, TestChain, revertText, testAddress, type EvmLog } from './evm'
import { MOCK_TOKEN_ABI } from './escrow-chain'
import { FakeTempoRpc, PATH_USD_ADDRESS, TEMPO_RPC_HOSTS, installPathUsd, type TempoRpcHost } from './fake-tempo-rpc'

const CALL_GAS = 30_000_000n
const FAUCET_AMOUNT = 1_000_000_000_000n
/** What eth_gasPrice answers. Tempo's real price is whatever its node says; the scripts only pass it on. */
const GAS_PRICE = 2n

export interface NodeHostBehaviour {
  down?: 'network' | number
  /** Report finalized blocks, and receipts, this many blocks behind the head. */
  lag?: number
  redirect?: boolean
  lie?: (method: string, params: unknown[], result: unknown) => unknown
  /** Refuse tempo_fundAddress, as a host without the faucet does. */
  noFaucet?: boolean
}

export interface NodeRequest {
  host: TempoRpcHost
  method: string
  params: unknown[]
  redirect: RequestRedirect | undefined
  bodyText: string
}

interface StoredTx {
  hash: Hex
  from: Hex
  to: Hex | null
  nonce: bigint
  input: Hex
  type: Hex
  gas: bigint
  blockNumber: bigint
  blockHash: Hex
  status: boolean
  contractAddress: Hex | null
  gasUsed: bigint
  logs: Array<EvmLog & { logIndex: number }>
}

interface Header {
  number: bigint
  hash: Hex
  timestamp: bigint
}

function hostOf(input: string | URL | Request): TempoRpcHost | null {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  try {
    const origin = new URL(href).origin
    return TEMPO_RPC_HOSTS.find((h) => h === origin) ?? null
  } catch {
    return null
  }
}

/** What an extension answers for a method it does not serve: the node answers it as usual. */
export const NOT_SERVED: unique symbol = Symbol('not served')

/**
 * A layer over the node for methods it does not model itself, such as Tempo's
 * own 0x76 transactions and its AccountKeychain (fake-tempo-wallet.ts). It may
 * throw EvmRpcError, which is answered as a node error.
 */
export type NodeExtension = (method: string, params: unknown[], host: TempoRpcHost) => Promise<unknown>

export class FakeTempoNode {
  readonly chain: TestChain
  /** The template's view of the same chain, for fake Lit's actionFetch. */
  readonly rpc: FakeTempoRpc
  readonly requests: NodeRequest[] = []
  readonly faucet: Hex = testAddress(900)
  private readonly behaviour = new Map<TempoRpcHost, NodeHostBehaviour>()
  private readonly txs = new Map<Hex, StoredTx>()
  private readonly headers = new Map<bigint, Header>()
  private faucetCounter = 0
  private extension: NodeExtension | null = null

  /** Serve more methods through `ext`; it answers NOT_SERVED to leave one to the node. */
  extend(ext: NodeExtension): void {
    this.extension = ext
  }

  /**
   * Land a Tempo 0x76 batch that an extension has already checked: every call
   * from `from`, all or nothing, in one new block, recorded under `hash` with
   * the escrow's and the token's logs. A reverted batch is recorded too, with
   * no logs, as a real node records a failed transaction.
   */
  async landBatch(hash: Hex, from: Hex, calls: ReadonlyArray<{ to: Hex; data: Hex }>, nonce: bigint): Promise<boolean> {
    if (this.txs.has(hash)) throw new EvmRpcError(-32000, 'already known')
    const r = await this.chain.batch(from, calls)
    const logs = r.ok ? r.results.flatMap((c) => c.logs) : []
    const gasUsed = r.results.reduce((n, c) => n + c.gasUsed, 0n)
    this.store({ hash, from, to: null, nonce, input: '0x', type: '0x76', gas: CALL_GAS, status: r.ok, contractAddress: null, gasUsed, logs })
    return r.ok
  }

  private constructor(chain: TestChain) {
    this.chain = chain
    this.rpc = new FakeTempoRpc(chain)
    this.observe()
  }

  /** A chain with a 6-decimal MockToken at the pathUSD address, as the escrow needs. */
  static async create(opts: { timestamp?: bigint; blockNumber?: bigint } = {}): Promise<FakeTempoNode> {
    const chain = await TestChain.create({ timestamp: opts.timestamp ?? 1_790_000_000n, blockNumber: opts.blockNumber ?? 5_000n })
    await installPathUsd(chain, testAddress(901))
    return new FakeTempoNode(chain)
  }

  setHost(host: TempoRpcHost | 0 | 1, b: NodeHostBehaviour): void {
    this.behaviour.set(typeof host === 'number' ? TEMPO_RPC_HOSTS[host] : host, b)
  }

  /** Every request the scripts sent with this method. */
  sent(method: string): NodeRequest[] {
    return this.requests.filter((r) => r.method === method)
  }

  /** The current head's header, recorded so a lagging host can still serve it later. */
  private observe(): Header {
    const h = { number: this.chain.blockNumber, hash: this.chain.blockHash(), timestamp: this.chain.timestamp }
    this.headers.set(h.number, h)
    return h
  }

  /** Move the chain's clock (and open a new block). */
  advance(seconds: bigint | number): void {
    this.observe()
    this.chain.advance(seconds)
    this.observe()
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const host = hostOf(input)
    if (host === null) throw new Error('FakeTempoNode: not one of the pinned RPC hosts')
    this.observe()
    const b = this.behaviour.get(host) ?? {}
    const bodyText = typeof init?.body === 'string' ? init.body : ''
    let parsed: unknown = null
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      parsed = null
    }
    const items = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed]
    for (const item of items) {
      const o = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
      this.requests.push({
        host,
        method: String(o.method),
        params: Array.isArray(o.params) ? o.params : [],
        redirect: init?.redirect,
        bodyText,
      })
    }
    if (b.down === 'network') throw new TypeError('fetch failed')
    if (typeof b.down === 'number') return new Response('{"error":"unavailable"}', { status: b.down })
    if (b.redirect) {
      if ((init?.redirect ?? 'follow') === 'error') throw new TypeError('fetch failed: unexpected redirect')
      return new Response(null, { status: 302, headers: { Location: 'https://mirror.invalid/' } })
    }
    if ((init?.method ?? 'GET').toUpperCase() !== 'POST' || parsed === null || typeof parsed !== 'object') {
      return new Response('bad request', { status: 400 })
    }
    const answers: unknown[] = []
    for (const item of items) {
      const o = item as Record<string, unknown>
      const method = String(o.method)
      const params = Array.isArray(o.params) ? (o.params as unknown[]) : []
      try {
        const result = await this.answer(host, b, method, params)
        answers.push({ jsonrpc: '2.0', id: o.id ?? null, result: b.lie ? b.lie(method, params, result) : result })
      } catch (err) {
        if (!(err instanceof EvmRpcError)) throw err
        answers.push({
          jsonrpc: '2.0',
          id: o.id ?? null,
          error: err.data === undefined ? { code: err.code, message: err.message } : { code: err.code, message: err.message, data: err.data },
        })
      }
    }
    const out = Array.isArray(parsed) ? answers : answers[0]
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  private hostHead(b: NodeHostBehaviour): bigint {
    return this.chain.blockNumber - BigInt(b.lag ?? 0)
  }

  /** A block tag this host will serve, as a number, or null for a block it does not have. */
  private blockOf(tag: unknown, b: NodeHostBehaviour): bigint | null {
    const head = this.hostHead(b)
    if (tag === undefined || tag === 'latest' || tag === 'finalized' || tag === 'safe' || tag === 'pending') return head
    if (typeof tag !== 'string' || !isHex(tag)) throw new EvmRpcError(-32602, 'invalid block tag')
    const n = hexToBigInt(tag)
    return n <= head ? n : null
  }

  private headerJson(n: bigint): Record<string, unknown> | null {
    const h = n === this.chain.blockNumber ? this.observe() : this.headers.get(n)
    if (!h) return null
    return { number: numberToHex(h.number), hash: h.hash, timestamp: numberToHex(h.timestamp), baseFeePerGas: '0x0' }
  }

  private async nonceOf(address: Hex): Promise<bigint> {
    const acc = await this.chain.evm.stateManager.getAccount(createAddressFromString(address))
    return acc?.nonce ?? 0n
  }

  /** Run a call or create and keep nothing: eth_estimateGas's dry run. */
  private async dryRun(from: Hex, to: Hex | null, data: Hex): Promise<{ ok: boolean; gasUsed: bigint; returnData: Hex; revert: string }> {
    const evm = this.chain.evm
    await evm.journal.checkpoint()
    try {
      const caller = createAddressFromString(from)
      const res = await evm.runCall({
        caller,
        origin: caller,
        ...(to === null ? {} : { to: createAddressFromString(to) }),
        data: hexToBytes(data),
        gasLimit: CALL_GAS,
        block: {
          header: {
            number: this.chain.blockNumber,
            coinbase: createAddressFromString('0x0000000000000000000000000000000000000000'),
            timestamp: this.chain.timestamp,
            difficulty: 0n,
            prevRandao: new Uint8Array(32),
            gasLimit: CALL_GAS,
            baseFeePerGas: 0n,
            getBlobGasPrice: () => 1n,
          },
        },
      })
      const ex = res.execResult
      const returnData = bytesToHex(ex.returnValue)
      const failed = ex.exceptionError !== undefined
      return {
        ok: !failed,
        // Plus the intrinsic cost, as a real estimate includes it.
        gasUsed: ex.executionGasUsed + 21_000n + BigInt((data.length - 2) / 2) * 16n,
        returnData,
        revert: failed ? (ex.exceptionError?.error === 'revert' ? revertText(returnData) : String(ex.exceptionError?.error)) : '',
      }
    } finally {
      await evm.journal.revert()
      await evm.journal.cleanup()
    }
  }

  /** Close the block a transaction ran in, and open the next. */
  private seal(): Header {
    const h = this.observe()
    this.chain.advance(1)
    this.observe()
    return h
  }

  private store(t: Omit<StoredTx, 'blockNumber' | 'blockHash' | 'logs'> & { logs: EvmLog[] }): StoredTx {
    const h = this.seal()
    const stored: StoredTx = { ...t, blockNumber: h.number, blockHash: h.hash, logs: t.logs.map((l, i) => ({ ...l, logIndex: i })) }
    this.txs.set(t.hash, stored)
    return stored
  }

  private async sendRaw(raw: unknown): Promise<Hex> {
    if (typeof raw !== 'string' || !isHex(raw)) throw new EvmRpcError(-32602, 'invalid raw transaction')
    const hash = keccak256(raw)
    if (this.txs.has(hash)) throw new EvmRpcError(-32000, 'already known')
    const tx = parseTransaction(raw)
    if (tx.type !== 'eip1559' && tx.type !== 'legacy' && tx.type !== 'eip2930') throw new EvmRpcError(-32000, 'transaction type not supported')
    if (tx.chainId !== Number(this.chain.chainId)) throw new EvmRpcError(-32000, 'invalid chain id for signer')
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction'] })).toLowerCase() as Hex
    const expected = await this.nonceOf(from)
    const nonce = BigInt(tx.nonce ?? 0)
    if (nonce < expected) throw new EvmRpcError(-32000, `nonce too low: next nonce ${expected}, tx nonce ${nonce}`)
    if (nonce > expected) throw new EvmRpcError(-32000, `nonce too high: next nonce ${expected}, tx nonce ${nonce}`)
    const to = tx.to ? (tx.to.toLowerCase() as Hex) : null
    const data = (tx.data ?? '0x') as Hex
    const gas = tx.gas ?? 0n
    const dry = await this.dryRun(from, to, data)
    if (dry.ok && gas < dry.gasUsed) throw new EvmRpcError(-32000, `intrinsic gas too low: have ${gas}, want ${dry.gasUsed}`)
    const typeHex: Hex = tx.type === 'eip1559' ? '0x2' : tx.type === 'eip2930' ? '0x1' : '0x0'
    if (to === null) {
      const r = await this.chain.deployResult(from, data)
      this.store({ hash, from, to: null, nonce, input: data, type: typeHex, gas, status: r.ok, contractAddress: r.ok ? r.address : null, gasUsed: r.gasUsed, logs: r.logs })
    } else {
      const r = await this.chain.send(from, to, data)
      this.store({ hash, from, to, nonce, input: data, type: typeHex, gas, status: r.ok, contractAddress: null, gasUsed: r.gasUsed, logs: r.logs })
    }
    return hash
  }

  /** Mint test pathUSD from the faucet account: an incoming transfer, recorded as the faucet's own transaction. */
  async fund(address: Hex, amount: bigint = FAUCET_AMOUNT): Promise<Hex> {
    const data = encodeFunctionData({ abi: MOCK_TOKEN_ABI, functionName: 'mint', args: [address, amount] })
    const nonce = await this.nonceOf(this.faucet)
    const r = await this.chain.send(this.faucet, PATH_USD_ADDRESS, data)
    if (!r.ok) throw new Error(`FakeTempoNode: faucet mint failed: ${r.revert ?? '?'}`)
    const hash = keccak256(`0x${(++this.faucetCounter).toString(16).padStart(8, '0')}${address.slice(2)}` as Hex)
    this.store({ hash, from: this.faucet, to: PATH_USD_ADDRESS, nonce, input: data, type: '0x2', gas: CALL_GAS, status: true, contractAddress: null, gasUsed: r.gasUsed, logs: r.logs })
    return hash
  }

  /** Bump an address's nonce without running anything, as if it had sent a transaction elsewhere. */
  async burnNonce(address: Hex): Promise<void> {
    const at = createAddressFromString(address)
    const acc = (await this.chain.evm.stateManager.getAccount(at)) ?? new Account()
    acc.nonce += 1n
    await this.chain.evm.stateManager.putAccount(at, acc)
  }

  /** A stored transaction's receipt as a node reports it, whatever any host's lag: what a send that waits answers. */
  receiptFor(hash: Hex): Record<string, unknown> | null {
    const t = this.txs.get(hash)
    return t ? this.receiptJson(t) : null
  }

  /** A stored transaction as a node reports it. A test's `lie` can rewrite it per host. */
  txJson(hash: Hex): Record<string, unknown> | null {
    const t = this.txs.get(hash)
    if (!t) return null
    return {
      hash: t.hash,
      from: t.from,
      to: t.to,
      nonce: numberToHex(t.nonce),
      input: t.input,
      type: t.type,
      gas: numberToHex(t.gas),
      blockNumber: numberToHex(t.blockNumber),
      blockHash: t.blockHash,
      chainId: numberToHex(this.chain.chainId),
      value: '0x0',
    }
  }

  private receiptJson(t: StoredTx): Record<string, unknown> {
    return {
      transactionHash: t.hash,
      status: t.status ? '0x1' : '0x0',
      blockNumber: numberToHex(t.blockNumber),
      blockHash: t.blockHash,
      contractAddress: t.contractAddress,
      gasUsed: numberToHex(t.gasUsed),
      logs: t.logs.map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        logIndex: numberToHex(l.logIndex),
        blockNumber: numberToHex(t.blockNumber),
        transactionHash: t.hash,
      })),
    }
  }

  private async answer(host: TempoRpcHost, b: NodeHostBehaviour, method: string, p: unknown[]): Promise<unknown> {
    if (this.extension !== null) {
      const served = await this.extension(method, p, host)
      if (served !== NOT_SERVED) return served
    }
    switch (method) {
      case 'eth_chainId':
        return numberToHex(this.chain.chainId)
      case 'eth_blockNumber':
        return numberToHex(this.hostHead(b))
      case 'eth_getBlockByNumber': {
        const n = this.blockOf(p[0], b)
        return n === null ? null : this.headerJson(n)
      }
      case 'eth_getCode': {
        if (this.blockOf(p[1], b) === null) throw new EvmRpcError(-32000, 'header not found')
        return this.chain.request({ method: 'eth_getCode', params: [p[0]] })
      }
      case 'eth_call': {
        if (this.blockOf(p[1], b) === null) throw new EvmRpcError(-32000, 'header not found')
        return this.chain.request({ method: 'eth_call', params: [p[0]] })
      }
      case 'eth_getTransactionCount': {
        const a = p[0]
        if (typeof a !== 'string') throw new EvmRpcError(-32602, 'bad address')
        return numberToHex(await this.nonceOf(a as Hex))
      }
      case 'eth_gasPrice':
        return numberToHex(GAS_PRICE)
      case 'eth_maxPriorityFeePerGas':
        return '0x0'
      case 'eth_estimateGas': {
        const call = (p[0] ?? {}) as Record<string, unknown>
        const from = typeof call.from === 'string' ? (call.from.toLowerCase() as Hex) : testAddress(0)
        const to = typeof call.to === 'string' ? (call.to.toLowerCase() as Hex) : null
        const data = (typeof call.data === 'string' ? call.data : typeof call.input === 'string' ? call.input : '0x') as Hex
        const dry = await this.dryRun(from, to, data)
        if (!dry.ok) throw new EvmRpcError(3, `execution reverted${dry.revert === 'revert' ? '' : `: ${dry.revert}`}`, dry.returnData)
        return numberToHex(dry.gasUsed)
      }
      case 'eth_sendRawTransaction':
        return this.sendRaw(p[0])
      case 'eth_getTransactionByHash': {
        const t = typeof p[0] === 'string' ? this.txs.get(p[0].toLowerCase() as Hex) : undefined
        if (!t || t.blockNumber > this.hostHead(b)) return null
        return this.txJson(t.hash)
      }
      case 'eth_getTransactionReceipt': {
        const t = typeof p[0] === 'string' ? this.txs.get(p[0].toLowerCase() as Hex) : undefined
        if (!t || t.blockNumber > this.hostHead(b)) return null
        return this.receiptJson(t)
      }
      case 'tempo_fundAddress': {
        if (b.noFaucet || host !== TEMPO_RPC_HOSTS[0]) throw new EvmRpcError(-32601, 'the method tempo_fundAddress does not exist/is not available')
        const a = p[0]
        if (typeof a !== 'string') throw new EvmRpcError(-32602, 'bad address')
        return [await this.fund(a.toLowerCase() as Hex)]
      }
      default:
        throw new EvmRpcError(-32601, `the method ${method} does not exist/is not available`)
    }
  }
}
