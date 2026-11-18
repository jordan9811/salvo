/**
 * TestChain: an in-process EVM for the escrow tests. Test-only; never
 * referenced from src/. Nothing here opens a socket.
 *
 * It is @ethereumjs/evm over its simple in-memory state, with a block clock
 * the test moves by hand, so time-based rules (ticket expiry, payout delay,
 * dispute hold) are tested at exact seconds instead of by sleeping.
 *
 * WHAT IT MODELS, because the escrow depends on each of these:
 *   - The chain id. Tempo Moderato's 42431 by default; another id for the
 *     cross-chain replay test. CHAINID and the EIP-712 domain read it.
 *   - Cancun rules, the same target the contract is compiled for, including
 *     the ecrecover precompile the ticket check uses.
 *   - Calls from any address, with msg.sender == tx.origin, as an access key
 *     sends them.
 *   - Atomic batches. A Tempo 0x76 transaction runs its calls all or nothing,
 *     so `batch` does too: one failing call undoes the calls before it.
 *   - eth_call. `call` runs against the current state and keeps nothing.
 *   - An EIP-1193 `request` for the read methods a viem client or an RPC fake
 *     needs: eth_chainId, eth_blockNumber, eth_getCode, eth_call,
 *     eth_getBlockByNumber. Reads are always at the current head.
 *
 * WHAT IT DOES NOT: Tempo's gas schedule (250k per new storage slot), fee
 * tokens, the TIP-20 precompile, signed transactions, or history. The contract
 * relies on none of these; the live smoke covers the chain itself.
 */

import { createEVM, type EVM, type EVMRunCallOpts, type Log } from '@ethereumjs/evm'
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common'
import { createAddressFromString, createZeroAddress } from '@ethereumjs/util'
import {
  bytesToHex,
  decodeAbiParameters,
  hexToBigInt,
  hexToBytes,
  isAddress,
  isHex,
  keccak256,
  numberToHex,
  type Hex,
} from 'viem'

export const MODERATO_CHAIN_ID = 42431n
/** Each call gets the Tempo per-transaction cap, so gas never decides a test. */
const CALL_GAS = 30_000_000n
const ERROR_SELECTOR = '0x08c379a0'
const PANIC_SELECTOR = '0x4e487b71'
const ZERO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000'

export interface EvmLog {
  address: Hex
  topics: Hex[]
  data: Hex
}

export interface CallResult {
  ok: boolean
  returnData: Hex
  /** Empty when the call failed: a revert keeps no logs. */
  logs: EvmLog[]
  gasUsed: bigint
  /**
   * Why it failed, when it did: the Error(string) text, `panic:0x..` for a
   * Panic(uint256), the raw revert data when it is neither, or the EVM's own
   * error (out of gas, invalid opcode). null on success.
   */
  revert: string | null
}

export interface DeployResult extends CallResult {
  address: Hex | null
}

export interface BatchCall {
  to: Hex
  data: Hex
}

type EvmBlock = NonNullable<EVMRunCallOpts['block']>

/** A JSON-RPC style error, shaped like geth's, so viem decodes the revert. */
export class EvmRpcError extends Error {
  readonly code: number
  readonly data: Hex | undefined
  constructor(code: number, message: string, data?: Hex) {
    super(message)
    this.name = 'EvmRpcError'
    this.code = code
    this.data = data
  }
}

/** Error(string) text, `panic:0x..`, or the raw data. Exported for reading a token hook's captured reply. */
export function revertText(data: Hex): string {
  if (data.startsWith(ERROR_SELECTOR) && data.length >= 10 + 128) {
    const [reason] = decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}`)
    return reason
  }
  if (data.startsWith(PANIC_SELECTOR) && data.length === 10 + 64) {
    const [code] = decodeAbiParameters([{ type: 'uint256' }], `0x${data.slice(10)}`)
    return `panic:${numberToHex(code)}`
  }
  return data === '0x' ? 'revert' : data
}

function toLogs(logs: Log[] | undefined): EvmLog[] {
  return (logs ?? []).map(([address, topics, data]) => ({
    address: bytesToHex(address),
    topics: topics.map((t) => bytesToHex(t)),
    data: bytesToHex(data),
  }))
}

function addressArg(v: unknown, what: string): Hex {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw new EvmRpcError(-32602, `bad ${what}`)
  return v.toLowerCase() as Hex
}

export class TestChain {
  readonly evm: EVM
  readonly chainId: bigint
  /** The head block. Moves only when a test moves it (`setTime`, `advance`). */
  blockNumber: bigint
  /** Seconds. Every call runs with this as block.timestamp. */
  timestamp: bigint

  private constructor(evm: EVM, chainId: bigint, blockNumber: bigint, timestamp: bigint) {
    this.evm = evm
    this.chainId = chainId
    this.blockNumber = blockNumber
    this.timestamp = timestamp
  }

  static async create(opts: { chainId?: bigint; timestamp?: bigint; blockNumber?: bigint } = {}): Promise<TestChain> {
    const chainId = opts.chainId ?? MODERATO_CHAIN_ID
    const common = createCustomCommon({ chainId: Number(chainId) }, Mainnet, { hardfork: Hardfork.Cancun })
    const evm = await createEVM({ common })
    return new TestChain(evm, chainId, opts.blockNumber ?? 1n, opts.timestamp ?? 1_790_000_000n)
  }

  /** Move the clock to `t` seconds and open the next block. Time never goes back. */
  setTime(t: bigint): void {
    if (t < this.timestamp) throw new Error('TestChain: time only moves forward')
    this.timestamp = t
    this.blockNumber += 1n
  }

  advance(seconds: bigint | number): void {
    this.setTime(this.timestamp + BigInt(seconds))
  }

  private block(): EvmBlock {
    return {
      header: {
        number: this.blockNumber,
        coinbase: createZeroAddress(),
        timestamp: this.timestamp,
        difficulty: 0n,
        prevRandao: new Uint8Array(32),
        gasLimit: CALL_GAS,
        baseFeePerGas: 0n,
        getBlobGasPrice: () => 1n,
      },
    }
  }

  private async run(from: Hex, to: Hex | null, data: Hex): Promise<DeployResult> {
    const caller = createAddressFromString(from)
    const res = await this.evm.runCall({
      caller,
      origin: caller,
      ...(to === null ? {} : { to: createAddressFromString(to) }),
      data: hexToBytes(data),
      gasLimit: CALL_GAS,
      block: this.block(),
    })
    const ex = res.execResult
    const returnData = bytesToHex(ex.returnValue)
    const failed = ex.exceptionError !== undefined
    return {
      ok: !failed,
      returnData,
      logs: failed ? [] : toLogs(ex.logs),
      gasUsed: ex.executionGasUsed,
      revert: failed ? (ex.exceptionError?.error === 'revert' ? revertText(returnData) : String(ex.exceptionError?.error)) : null,
      address: !failed && res.createdAddress ? (res.createdAddress.toString().toLowerCase() as Hex) : null,
    }
  }

  /** Close a "transaction": forget warm slots and touched accounts, as a block would. */
  private async endTx(): Promise<void> {
    await this.evm.journal.cleanup()
  }

  /** Deploy `initCode` (creation code plus encoded constructor args). Reports a refusal; never throws. */
  async deployResult(from: Hex, initCode: Hex): Promise<DeployResult> {
    const r = await this.run(from, null, initCode)
    await this.endTx()
    return r
  }

  /** Deploy and return the address, or throw with the constructor's reason. */
  async deploy(from: Hex, initCode: Hex): Promise<Hex> {
    const r = await this.deployResult(from, initCode)
    if (!r.ok || r.address === null) throw new Error(`deploy failed: ${r.revert ?? 'no address'}`)
    return r.address
  }

  /** A state-changing call. A failed call changes nothing. */
  async send(from: Hex, to: Hex, data: Hex): Promise<CallResult> {
    const { address: _ignored, ...r } = await this.run(from, to, data)
    await this.endTx()
    return r
  }

  /** eth_call: runs at the current state and keeps nothing, not even the caller's nonce. */
  async call(from: Hex, to: Hex, data: Hex): Promise<CallResult> {
    await this.evm.journal.checkpoint()
    try {
      const { address: _ignored, ...r } = await this.run(from, to, data)
      return r
    } finally {
      await this.evm.journal.revert()
      await this.endTx()
    }
  }

  /**
   * One Tempo 0x76 transaction: every call from `from`, in order, all or
   * nothing. The first failure undoes the calls before it.
   */
  async batch(from: Hex, calls: readonly BatchCall[]): Promise<{ ok: boolean; results: CallResult[]; failedAt: number | null }> {
    await this.evm.journal.checkpoint()
    const results: CallResult[] = []
    let failedAt: number | null = null
    let keep = false
    try {
      for (const [i, c] of calls.entries()) {
        const { address: _ignored, ...r } = await this.run(from, c.to, c.data)
        results.push(r)
        if (!r.ok) {
          failedAt = i
          break
        }
      }
      keep = failedAt === null
    } finally {
      // A thrown error (a harness bug, not a revert) also undoes the batch.
      if (keep) await this.evm.journal.commit()
      else await this.evm.journal.revert()
      await this.endTx()
    }
    return { ok: keep, results, failedAt }
  }

  async getCode(address: Hex): Promise<Hex> {
    return bytesToHex(await this.evm.stateManager.getCode(createAddressFromString(address)))
  }

  async codeHash(address: Hex): Promise<Hex> {
    return keccak256(await this.getCode(address))
  }

  /**
   * A deterministic stand-in for the head block's hash. Real hashes cover the
   * header; here it only has to differ per (chain, number, time).
   */
  blockHash(): Hex {
    return keccak256(`0x${[this.chainId, this.blockNumber, this.timestamp].map((n) => n.toString(16).padStart(64, '0')).join('')}`)
  }

  /**
   * EIP-1193 reads at the current head, for viem's `custom()` transport or an
   * RPC fake. A revert is thrown as geth does: code 3, the revert data in `data`.
   */
  async request(args: { method: string; params?: readonly unknown[] | undefined }): Promise<unknown> {
    const params = args.params ?? []
    switch (args.method) {
      case 'eth_chainId':
        return numberToHex(this.chainId)
      case 'eth_blockNumber':
        return numberToHex(this.blockNumber)
      case 'eth_getCode':
        return this.getCode(addressArg(params[0], 'address'))
      case 'eth_getBlockByNumber':
        return {
          number: numberToHex(this.blockNumber),
          hash: this.blockHash(),
          timestamp: numberToHex(this.timestamp),
        }
      case 'eth_call': {
        const tx = params[0]
        if (typeof tx !== 'object' || tx === null) throw new EvmRpcError(-32602, 'bad call')
        const { from, to, data, input } = tx as Record<string, unknown>
        const body = data ?? input ?? '0x'
        if (typeof body !== 'string' || !isHex(body)) throw new EvmRpcError(-32602, 'bad data')
        const r = await this.call(from === undefined ? ZERO_ADDRESS : addressArg(from, 'from'), addressArg(to, 'to'), body)
        if (!r.ok) {
          throw new EvmRpcError(3, `execution reverted${r.revert === 'revert' ? '' : `: ${r.revert ?? ''}`}`, r.returnData)
        }
        return r.returnData
      }
      default:
        throw new EvmRpcError(-32601, `TestChain does not serve ${args.method}`)
    }
  }
}

/** A test address from a small number, for actors that never sign anything. */
export function testAddress(n: number): Hex {
  return `0x${(0x5a170000 + n).toString(16).padStart(40, '0')}`
}

/** Decode a uint256 return value. */
export function word(data: Hex): bigint {
  return data === '0x' ? 0n : hexToBigInt(data)
}
