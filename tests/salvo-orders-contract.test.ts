/**
 * SalvoOrders, run for real: the committed bytes on the in-process EVM
 * (tests/support/evm.ts), against MockToken (pathUSD's stand-in, with its fee,
 * blocked-payee and reentrant-hook switches) and MockUSDC (Circle's FiatToken
 * EIP-3009 and blacklist, copied with its revert texts). No network, no database.
 *
 * What is pinned here, because an agent's money rests on each one:
 *   - TWO ROADS OUT. An open order pays out only on the runner's signature
 *     (refund to the buyer, the rest to payout) or, after the deadline, wholly
 *     back to the buyer. Each road is taken once; the other then refuses.
 *   - THE SIGNATURE. A settle signature is good for one order (its id, buyer,
 *     amount, deadline and terms), one refund and one result, on one contract on
 *     one chain, from the runner only, low-s only. Each of those is broken here
 *     and refused, including another order that a reorg put at the same id.
 *   - THE AUTHORIZATION. A relayer can submit a buyer's USDC authorization but
 *     cannot change the terms, amount, deadline or buyer it opens, cannot use
 *     it twice, and cannot use it on another deployment or chain. A buyer whose
 *     address has code (a smart wallet, an EIP-7702 account) is checked by
 *     EIP-1271, as real USDC v2.2 does, and can pay through the bytes form.
 *   - NOBODY BLOCKS THE OTHER. A payee the token refuses is credited as owed;
 *     the other party is still paid.
 *   - THE BOOKS. After every test, for every contract it deployed: token
 *     balance == every OPEN order's amount + every owed credit. The credits are
 *     read for every address any Owed event in the test named, so a new payee
 *     needs no list kept by hand.
 *
 * Settle signatures and USDC authorizations are made with viem signTypedData
 * and the typed-data shapes artifact.ts exports, so a test the contract accepts
 * proves those shapes are the contract's.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  hashDomain,
  hashTypedData,
  hexToBytes,
  getAddress,
  isAddress,
  keccak256,
  maxUint256,
  parseAbi,
  parseSignature,
  toHex,
  zeroAddress,
  type Hex,
  type PrivateKeyAccount,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  ORDERS_ABI,
  ORDERS_BYTECODE,
  ORDERS_EIP712_NAME,
  ORDERS_EIP712_VERSION,
  ORDERS_RUNTIME_TEMPLATE,
  ORDERS_RUNTIME_TEMPLATE_KECCAK,
  ORDERS_SOLC_SETTINGS,
  ORDERS_SOLC_VERSION,
  ORDERS_SOURCE_SHA256,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  SETTLE_TYPES,
  ordersAuthorizationNonce,
  ordersDomain,
  ordersRuntimeCode,
  ordersRuntimeKeccak,
} from '@/lib/agent/orders/artifact'
import { RUNTIME_KECCAK as RUNTIME_KECCAK_V1 } from '@/lib/escrow/artifact'
import { RUNTIME_KECCAK_V2 } from '@/lib/escrow/artifact-v2'
import mockUsdcArtifact from '../contracts/out/MockUSDC.json'
import mockWalletArtifact from '../contracts/out/MockSmartWallet.json'
import {
  compileEscrow,
  driftedFiles,
  MOCK_USDC_JSON_PATH,
  MOCK_WALLET_JSON_PATH,
  ORDERS_JSON_PATH,
  ORDERS_TS_PATH,
  SOLC_PIN,
} from '../scripts/escrow-compile'
import { TestChain, revertText, testAddress, type CallResult } from './support/evm'
import { MOCK_TOKEN_ABI, deployMockToken, highS, readerFor, tokenCall, withV } from './support/escrow-chain'

// ------------------------------------------------------------------ actors and constants
const RUNNER = privateKeyToAccount(`0x${'33'.repeat(32)}`)
const ROGUE = privateKeyToAccount(`0x${'44'.repeat(32)}`)
/** The Base buyer: signs USDC authorizations, never sends a transaction. */
const AGENT = privateKeyToAccount(`0x${'55'.repeat(32)}`)
/** The key behind a smart-wallet buyer (MockSmartWallet). */
const WALLET_OWNER = privateKeyToAccount(`0x${'66'.repeat(32)}`)
const DEPLOYER = testAddress(1)
const BUYER = testAddress(3)
const STRANGER = testAddress(4)
const BUYER2 = testAddress(5)
const RELAYER = testAddress(9)
const PAYOUT = testAddress(10)
const OTHER_PAYOUT = testAddress(11)
/** Read by the books on top of every address an Owed event named, so a credit is never missed. */
const PAYEES: readonly Hex[] = [BUYER, BUYER2, STRANGER, RELAYER, PAYOUT, OTHER_PAYOUT, AGENT.address, RUNNER.address]
const BASE_SEPOLIA = 84_532n
const FUNDS = 1_000_000_000_000n
const AMOUNT = 25_000_000n // $25
const DAY = 86_400n
const MAX_DURATION = 30n * DAY
const TERMS: Hex = keccak256(toHex('order terms 1'))
const TERMS2: Hex = keccak256(toHex('order terms 2'))
const RESULT: Hex = keccak256(toHex('fulfilled: order 1001'))
const ZERO32: Hex = `0x${'00'.repeat(32)}`
const STATE = { NONE: 0, OPEN: 1, SETTLED: 2, RECLAIMED: 3 } as const
const BLOCK_REVERT = 1
const BLOCK_RETURN_FALSE = 2
const SETTLE_TYPE =
  'Settle(uint256 id,address buyer,uint96 amount,uint40 deadline,bytes32 termsHash,bytes32 resultHash,uint96 refund)'
const RECEIVE_TYPE =
  'ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'

/** The MockUSDC surface these tests use. A test checks it against the compiled ABI. */
const USDC_ABI = parseAbi([
  'constructor(string name_)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function version() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function isBlacklisted(address) view returns (bool)',
  'function FEE_SINK() view returns (address)',
  'function feeBps() view returns (uint256)',
  'function balanceOfReverts() view returns (bool)',
  'function saysNoAfterMove(address) view returns (bool)',
  'function hookTarget() view returns (address)',
  'function hookData() view returns (bytes)',
  'function hookArmed() view returns (bool)',
  'function hookCalled() view returns (bool)',
  'function hookOk() view returns (bool)',
  'function hookReturn() view returns (bytes)',
  'function setBalanceOfReverts(bool on)',
  'function setSaysNoAfterMove(address who, bool on)',
  'function setHook(address target, bytes data)',
  'function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)',
  'function CANCEL_AUTHORIZATION_TYPEHASH() view returns (bytes32)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function mint(address to, uint256 amount)',
  'function setFeeBps(uint256 bps)',
  'function setBlacklisted(address who, bool on)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
])

function hexOf(v: unknown, what: string): Hex {
  if (typeof v !== 'string' || !/^0x([0-9a-f]{2})+$/.test(v)) throw new Error(`${what} is not hex`)
  return v as Hex
}
const USDC_BYTECODE = hexOf(mockUsdcArtifact.bytecode, 'MockUSDC bytecode')
const WALLET_ABI = parseAbi([
  'constructor(address owner_)',
  'function owner() view returns (address)',
  'function WRAP_TAG() view returns (bytes32)',
  'function isValidSignature(bytes32 digest, bytes signature) view returns (bytes4)',
])
const WALLET_BYTECODE = hexOf(mockWalletArtifact.bytecode, 'MockSmartWallet bytecode')
const WRAP_TAG = keccak256(toHex('MockSmartWallet wrapped signature'))

// ------------------------------------------------------------------ the world
interface Env {
  chain: TestChain
  token: Hex
  orders: Hex
}

/** Every contract a test deployed. afterEach checks each one's books. */
const live: Env[] = []

const OWED_TOPIC = keccak256(toHex('Owed(address,uint256)'))
/** Per chain: every "contract:address" an Owed event named, read off every send's logs. */
const owedSeen = new WeakMap<TestChain, Set<string>>()

/** Wrap the chain's send once, so every call a test makes (hooks included) reports its Owed events. */
function watchOwed(chain: TestChain): void {
  if (owedSeen.has(chain)) return
  const seen = new Set<string>()
  owedSeen.set(chain, seen)
  const send = chain.send.bind(chain)
  chain.send = async (from: Hex, to: Hex, data: Hex): Promise<CallResult> => {
    const r = await send(from, to, data)
    for (const l of r.logs) {
      const who = l.topics[1]
      if (l.topics[0] === OWED_TOPIC && who !== undefined) seen.add(`${l.address.toLowerCase()}:0x${who.slice(26).toLowerCase()}`)
    }
    return r
  }
}

afterEach(async () => {
  for (const env of live.splice(0)) await expectBooks(env)
})

function initCode(token: Hex, runner: Hex = RUNNER.address, payout: Hex = PAYOUT): Hex {
  return encodeDeployData({ abi: ORDERS_ABI, bytecode: ORDERS_BYTECODE, args: [token, runner, payout] })
}

async function deployOrders(chain: TestChain, token: Hex, runner: Hex = RUNNER.address, payout: Hex = PAYOUT): Promise<Env> {
  watchOwed(chain)
  const orders = await chain.deploy(DEPLOYER, initCode(token, runner, payout))
  const env = { chain, token, orders }
  live.push(env)
  return env
}

async function deployUsdc(chain: TestChain, name = 'USDC'): Promise<Hex> {
  return chain.deploy(DEPLOYER, encodeDeployData({ abi: USDC_ABI, bytecode: USDC_BYTECODE, args: [name] }))
}

/** A MockToken world: BUYER and BUYER2 funded and approved, as the Tempo agent's approve + open. */
async function tokenWorld(opts: { chainId?: bigint } = {}): Promise<Env> {
  const chain = await TestChain.create(opts.chainId === undefined ? {} : { chainId: opts.chainId })
  const token = await deployMockToken(chain, DEPLOYER)
  const env = await deployOrders(chain, token)
  for (const who of [BUYER, BUYER2]) {
    ok(await chain.send(DEPLOYER, token, tokenCall.mint(who, FUNDS)))
    ok(await chain.send(who, token, tokenCall.approve(env.orders, maxUint256)))
  }
  return env
}

/** A MockUSDC world: AGENT funded, and nothing approved. */
async function usdcWorld(opts: { chainId?: bigint } = {}): Promise<Env> {
  const chain = await TestChain.create(opts.chainId === undefined ? {} : { chainId: opts.chainId })
  const token = await deployUsdc(chain)
  const env = await deployOrders(chain, token)
  ok(await chain.send(DEPLOYER, token, usdcCall('mint', [AGENT.address, FUNDS])))
  return env
}

// ------------------------------------------------------------------ calls and reads
function ok(r: CallResult): CallResult {
  expect(r.revert).toBeNull()
  expect(r.ok).toBe(true)
  return r
}

function reverts(r: CallResult, reason: string): void {
  expect(r.ok).toBe(false)
  expect(r.revert).toBe(reason)
}

const call = {
  open: (termsHash: Hex, amount: bigint, deadline: bigint): Hex =>
    encodeFunctionData({ abi: ORDERS_ABI, functionName: 'open', args: [termsHash, amount, Number(deadline)] }),
  settle: (id: bigint, resultHash: Hex, refund: bigint, signature: Hex): Hex =>
    encodeFunctionData({ abi: ORDERS_ABI, functionName: 'settle', args: [id, resultHash, refund, signature] }),
  reclaim: (id: bigint): Hex => encodeFunctionData({ abi: ORDERS_ABI, functionName: 'reclaim', args: [id] }),
  claim: (to: Hex): Hex => encodeFunctionData({ abi: ORDERS_ABI, functionName: 'claim', args: [to] }),
  openWithAuthorization: (a: Auth): Hex =>
    encodeFunctionData({
      abi: ORDERS_ABI,
      functionName: 'openWithAuthorization',
      args: [a.buyer, a.termsHash, a.amount, Number(a.deadline), a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s],
    }),
  /** The bytes form, with the signature given or (by default) the auth's own r,s,v. */
  openWithAuthorizationSignature: (a: Auth, signature: Hex = a.signature): Hex =>
    encodeFunctionData({
      abi: ORDERS_ABI,
      functionName: 'openWithAuthorizationSignature',
      args: [a.buyer, a.termsHash, a.amount, Number(a.deadline), a.validAfter, a.validBefore, a.nonce, signature],
    }),
}

type UsdcWrite =
  | 'mint'
  | 'setFeeBps'
  | 'setBlacklisted'
  | 'approve'
  | 'receiveWithAuthorization'
  | 'setBalanceOfReverts'
  | 'setSaysNoAfterMove'
  | 'setHook'
function usdcCall(functionName: UsdcWrite, args: readonly unknown[]): Hex {
  // parseAbi keeps the argument types; this one helper takes them loosely and viem checks them at encode.
  return encodeFunctionData({ abi: USDC_ABI, functionName, args } as Parameters<typeof encodeFunctionData>[0])
}

async function order(env: Env, id: bigint) {
  return readerFor(env.chain).readContract({ address: env.orders, abi: ORDERS_ABI, functionName: 'getOrder', args: [id] })
}

async function owed(env: Env, who: Hex): Promise<bigint> {
  return readerFor(env.chain).readContract({ address: env.orders, abi: ORDERS_ABI, functionName: 'owed', args: [who] })
}

async function balance(env: Env, who: Hex): Promise<bigint> {
  return readerFor(env.chain).readContract({ address: env.token, abi: MOCK_TOKEN_ABI, functionName: 'balanceOf', args: [who] })
}

async function orderCount(env: Env): Promise<bigint> {
  return readerFor(env.chain).readContract({ address: env.orders, abi: ORDERS_ABI, functionName: 'orderCount' })
}

/** The books: token balance == every OPEN order's amount + every owed credit. */
async function expectBooks(env: Env): Promise<void> {
  let open = 0n
  const n = await orderCount(env)
  for (let id = 1n; id <= n; id++) {
    const o = await order(env, id)
    expect([STATE.OPEN, STATE.SETTLED, STATE.RECLAIMED]).toContain(o.state)
    if (o.state === STATE.OPEN) open += o.amount
  }
  const named = [...(owedSeen.get(env.chain) ?? [])]
    .filter((k) => k.startsWith(`${env.orders.toLowerCase()}:`))
    .map((k) => k.slice(k.indexOf(':') + 1))
  const everyone = new Set<string>([...PAYEES.map((a) => a.toLowerCase()), ...named])
  let credits = 0n
  for (const who of everyone) credits += await owed(env, who as Hex)
  expect(await balance(env, env.orders)).toBe(open + credits)
}

/** The orders contract's events in a call, with every address lowercased so they compare plainly. */
function events(env: Env, r: CallResult): { eventName: string; args: Record<string, unknown> }[] {
  return r.logs
    .filter((l) => l.address === env.orders)
    .map((l) => {
      const e = decodeEventLog({ abi: ORDERS_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] })
      const args: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(e.args)) args[k] = typeof v === 'string' && isAddress(v) ? v.toLowerCase() : v
      return { eventName: e.eventName, args }
    })
}

/** Token Transfer events in a call, as (to, value), lowercased. */
function transfers(env: Env, r: CallResult): { from: string; to: string; value: bigint }[] {
  const out: { from: string; to: string; value: bigint }[] = []
  for (const l of r.logs) {
    if (l.address !== env.token) continue
    const e = decodeEventLog({ abi: USDC_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] })
    if (e.eventName === 'Transfer') out.push({ from: e.args.from.toLowerCase(), to: e.args.to.toLowerCase(), value: e.args.value })
  }
  return out
}

function deadlineIn(env: Env, seconds: bigint = 3_600n): bigint {
  return env.chain.timestamp + seconds
}

/** Open an order from `from` with MockToken; returns its id. */
async function openOrder(env: Env, opts: { from?: Hex; terms?: Hex; amount?: bigint; deadline?: bigint } = {}): Promise<bigint> {
  const before = await orderCount(env)
  ok(await env.chain.send(opts.from ?? BUYER, env.orders, call.open(opts.terms ?? TERMS, opts.amount ?? AMOUNT, opts.deadline ?? deadlineIn(env))))
  return before + 1n
}

// ------------------------------------------------------------------ signing, as the TypeScript side will
interface SettleSignOpts {
  signer?: PrivateKeyAccount
  chainId?: bigint
  contract?: Hex
  id?: bigint
  buyer?: Hex
  amount?: bigint
  deadline?: number
  termsHash?: Hex
  resultHash?: Hex
  refund?: bigint
}

/**
 * The runner's settle signature, made with viem signTypedData and artifact.ts's shapes. The
 * order's buyer, amount, deadline and terms come from getOrder(id), as the runner reads them.
 */
async function signSettle(env: Env, id: bigint, resultHash: Hex, refund: bigint, o: SettleSignOpts = {}): Promise<Hex> {
  const onChain = await order(env, id)
  return (o.signer ?? RUNNER).signTypedData({
    domain: ordersDomain(o.chainId ?? env.chain.chainId, o.contract ?? env.orders),
    types: SETTLE_TYPES,
    primaryType: 'Settle',
    message: {
      id: o.id ?? id,
      buyer: o.buyer ?? onChain.buyer,
      amount: o.amount ?? onChain.amount,
      deadline: o.deadline ?? onChain.deadline,
      termsHash: o.termsHash ?? onChain.termsHash,
      resultHash: o.resultHash ?? resultHash,
      refund: o.refund ?? refund,
    },
  })
}

interface Auth {
  buyer: Hex
  termsHash: Hex
  amount: bigint
  deadline: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
  v: number
  r: Hex
  s: Hex
  /** The same signature as 65 bytes r,s,v, for the bytes form. */
  signature: Hex
}

interface AuthOpts {
  signer?: PrivateKeyAccount
  termsHash?: Hex
  amount?: bigint
  deadline?: bigint
  validAfter?: bigint
  validBefore?: bigint
  /** What the signed authorization names as payee; the contract by default. */
  to?: Hex
  /** Sign this nonce instead of the order's bound one. */
  nonce?: Hex
  chainId?: bigint
  /** The orders contract the nonce is bound to; env.orders by default. */
  boundTo?: Hex
  /** The chain id in the token's domain; the nonce's chain by default. */
  domainChainId?: bigint
  /** Who the authorization is from; the signer by default. A smart wallet's address, signed by its owner key. */
  from?: Hex
}

/** A Base buyer's EIP-3009 authorization for one order, made with viem signTypedData. */
async function authorize(env: Env, o: AuthOpts = {}): Promise<Auth> {
  const signer = o.signer ?? AGENT
  const from = o.from ?? signer.address
  const chainId = o.chainId ?? env.chain.chainId
  const termsHash = o.termsHash ?? TERMS
  const amount = o.amount ?? AMOUNT
  const deadline = o.deadline ?? deadlineIn(env)
  const validAfter = o.validAfter ?? 0n
  const validBefore = o.validBefore ?? deadlineIn(env, 600n)
  const nonce =
    o.nonce ??
    ordersAuthorizationNonce({ chainId, contract: o.boundTo ?? env.orders, buyer: from, termsHash, amount, deadline })
  const signature = await signer.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: o.domainChainId ?? chainId, verifyingContract: env.token },
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: { from, to: o.to ?? env.orders, value: amount, validAfter, validBefore, nonce },
  })
  const { r, s, v, yParity } = parseSignature(signature)
  return { buyer: from, termsHash, amount, deadline, validAfter, validBefore, nonce, v: Number(v ?? BigInt(yParity + 27)), r, s, signature }
}

/** Walks bytecode as instructions, skipping PUSH data, so a 0xff inside a constant is not an opcode. */
function opcodes(code: Hex): Set<number> {
  const b = hexToBytes(code)
  const out = new Set<number>()
  for (let i = 0; i < b.length; i++) {
    const op = b[i] ?? 0
    out.add(op)
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f
  }
  return out
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

// --------------------------------------------------------------------------------------------
describe('SalvoOrders bytes and ABI', () => {
  it('the committed artifacts equal a fresh compile with the pinned solc, with no warnings', () => {
    const result = compileEscrow()
    expect(driftedFiles(result)).toEqual([])
    expect(result.orders.warnings).toEqual([])
    expect(result.mockUsdc.warnings).toEqual([])
    expect(result.files.has(ORDERS_JSON_PATH)).toBe(true)
    expect(result.files.has(ORDERS_TS_PATH)).toBe(true)
    expect(result.files.has(MOCK_USDC_JSON_PATH)).toBe(true)
    expect(result.files.has(MOCK_WALLET_JSON_PATH)).toBe(true)
    expect(result.mockWallet.warnings).toEqual([])
    expect(ORDERS_SOLC_VERSION.startsWith(`${SOLC_PIN}+`)).toBe(true)
    expect(ORDERS_SOLC_SETTINGS).toEqual({
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      viaIR: false,
      metadata: { bytecodeHash: 'none', appendCBOR: false },
    })
    expect(result.orders.sourceSha256).toBe(ORDERS_SOURCE_SHA256)
    expect(result.orders.runtimeKeccak).toBe(ORDERS_RUNTIME_TEMPLATE_KECCAK)
    expect(keccak256(ORDERS_RUNTIME_TEMPLATE)).toBe(ORDERS_RUNTIME_TEMPLATE_KECCAK)
    // Adding SalvoOrders to the compile left both live escrows' bytes alone.
    expect(result.escrow.runtimeKeccak).toBe(RUNTIME_KECCAK_V1)
    expect(result.escrowV2.runtimeKeccak).toBe(RUNTIME_KECCAK_V2)
    expect(result.escrow.immutables).toEqual({})
    expect(result.escrowV2.immutables).toEqual({})
  }, 120_000)

  it('has no DELEGATECALL, CALLCODE, SELFDESTRUCT, CREATE or CREATE2, calls out only by CALL and STATICCALL, and fits 24 KiB', () => {
    const ops = opcodes(ORDERS_RUNTIME_TEMPLATE)
    for (const [name, op] of [
      ['DELEGATECALL', 0xf4],
      ['CALLCODE', 0xf2],
      ['SELFDESTRUCT', 0xff],
      ['CREATE', 0xf0],
      ['CREATE2', 0xf5],
    ] as const) {
      expect(ops.has(op), name).toBe(false)
    }
    // CALL to the token; STATICCALL to the token (balanceOf) and ecrecover.
    expect([0xf1, 0xf2, 0xf4, 0xfa].filter((op) => ops.has(op))).toEqual([0xf1, 0xfa])
    expect((ORDERS_RUNTIME_TEMPLATE.length - 2) / 2).toBeLessThanOrEqual(24_576)
  })

  it('the committed artifacts are not git-ignored and are pinned to LF', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const git = spawnSync('git', ['check-ignore', '--no-index', '-v', ORDERS_JSON_PATH, ORDERS_TS_PATH, MOCK_USDC_JSON_PATH, MOCK_WALLET_JSON_PATH], {
      cwd: root,
      encoding: 'utf8',
    })
    if (git.error === undefined && git.status !== 128) {
      expect({ status: git.status, ignoredBy: git.stdout.trim() }).toEqual({ status: 1, ignoredBy: '' })
    }
    const attrs = readFileSync(resolve(root, '.gitattributes'), 'utf8').split(/\r?\n/).map((l) => l.trim())
    expect(attrs).toContain('contracts/** text eol=lf')
    expect(attrs).toContain(`${ORDERS_TS_PATH} text eol=lf`)
  })

  it('exposes exactly this ABI: spec section 2 as built', () => {
    // Beyond the letter of section 2, on purpose: the public constants and immutables (each a
    // getter), orderCount, owed with its Owed and Claimed events (V2's _pay credits a refused
    // payout, so claim is in), VERSION, and openWithAuthorizationSignature (the bytes form a
    // buyer with code needs). Opened indexes buyer and termsHash so a relayer can find an order.
    type P = { type: string; name?: string; indexed?: boolean; components?: readonly P[] }
    const param = (p: P): string => {
      const base = p.type.startsWith('tuple') ? `(${(p.components ?? []).map(param).join(', ')})${p.type.slice(5)}` : p.type
      return [base, p.indexed ? 'indexed' : '', p.name ?? ''].filter((s) => s !== '').join(' ')
    }
    const line = (i: (typeof ORDERS_ABI)[number]): string => {
      if (i.type === 'function') {
        const outs = i.outputs.map(param).join(', ')
        return `function ${i.name}(${i.inputs.map(param).join(', ')}) ${i.stateMutability}${outs ? ` returns (${outs})` : ''}`
      }
      if (i.type === 'event') return `event ${i.name}(${i.inputs.map(param).join(', ')})${i.anonymous ? ' anonymous' : ''}`
      return `constructor(${i.inputs.map(param).join(', ')}) ${i.stateMutability}`
    }
    expect(ORDERS_ABI.map(line).sort()).toEqual(
      [
        'constructor(address token_, address runner_, address payout_) nonpayable',
        'event Claimed(address indexed to, uint256 amount)',
        'event Opened(uint256 indexed id, address indexed buyer, uint96 amount, uint40 deadline, bytes32 indexed termsHash)',
        'event Owed(address indexed to, uint256 amount)',
        'event Reclaimed(uint256 indexed id)',
        'event Settled(uint256 indexed id, bytes32 resultHash, uint96 refund)',
        'function MAX_DURATION() view returns (uint256)',
        'function ORDER_OPEN() view returns (uint8)',
        'function ORDER_RECLAIMED() view returns (uint8)',
        'function ORDER_SETTLED() view returns (uint8)',
        'function SETTLE_TYPEHASH() view returns (bytes32)',
        'function VERSION() view returns (string)',
        'function authorizationNonce(address buyer, bytes32 termsHash, uint96 amount, uint40 deadline) view returns (bytes32)',
        'function claim(address to) nonpayable',
        'function domainSeparator() view returns (bytes32)',
        'function getOrder(uint256 id) view returns ((address buyer, uint96 amount, uint40 deadline, uint8 state, bytes32 termsHash))',
        'function open(bytes32 termsHash, uint96 amount, uint40 deadline) nonpayable returns (uint256 id)',
        'function openWithAuthorization(address buyer, bytes32 termsHash, uint96 amount, uint40 deadline, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) nonpayable returns (uint256 id)',
        'function openWithAuthorizationSignature(address buyer, bytes32 termsHash, uint96 amount, uint40 deadline, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature) nonpayable returns (uint256 id)',
        'function orderCount() view returns (uint256)',
        'function owed(address) view returns (uint256)',
        'function payout() view returns (address)',
        'function reclaim(uint256 id) nonpayable',
        'function runner() view returns (address)',
        'function settle(uint256 id, bytes32 resultHash, uint96 refund, bytes signature) nonpayable',
        'function settleDigest(uint256 id, bytes32 resultHash, uint96 refund) view returns (bytes32)',
        'function token() view returns (address)',
      ].sort(),
    )
  })

  it('MockUSDC compiles to the ABI these tests encode against', () => {
    const sig = (i: { type: string; name?: string; inputs?: readonly { type: string }[] }): string =>
      `${i.type} ${i.name ?? ''}(${(i.inputs ?? []).map((p) => p.type).join(',')})`
    const compiled = (mockUsdcArtifact.abi as { type: string; name?: string; inputs?: { type: string }[] }[]).map(sig).sort()
    expect(USDC_ABI.map(sig).sort()).toEqual(compiled)
  })

  it('the deployed runtime code is ordersRuntimeCode(args), so one hash pins code, token, runner and payout', async () => {
    const env = await tokenWorld()
    const args = { token: env.token, runner: RUNNER.address, payout: PAYOUT }
    expect(await env.chain.getCode(env.orders)).toBe(ordersRuntimeCode(args))
    expect(await env.chain.codeHash(env.orders)).toBe(ordersRuntimeKeccak(args))
    expect(ordersRuntimeKeccak(args)).not.toBe(ORDERS_RUNTIME_TEMPLATE_KECCAK)
    // Each argument changes the hash: a pin on it catches a deployment with another runner,
    // payout or token.
    const other = await deployOrders(env.chain, env.token, ROGUE.address, PAYOUT)
    expect(await env.chain.codeHash(other.orders)).toBe(ordersRuntimeKeccak({ ...args, runner: ROGUE.address }))
    expect(ordersRuntimeKeccak({ ...args, runner: ROGUE.address })).not.toBe(ordersRuntimeKeccak(args))
    expect(ordersRuntimeKeccak({ ...args, payout: OTHER_PAYOUT })).not.toBe(ordersRuntimeKeccak(args))
    expect(ordersRuntimeKeccak({ ...args, token: STRANGER })).not.toBe(ordersRuntimeKeccak(args))
    expect(() => ordersRuntimeCode({ ...args, runner: '0x1234' })).toThrow('runner is not an address')
    // And the getters read the same values back.
    const r = readerFor(env.chain)
    expect(await r.readContract({ address: env.orders, abi: ORDERS_ABI, functionName: 'token' })).toBe(getAddress(env.token))
    expect(await r.readContract({ address: env.orders, abi: ORDERS_ABI, functionName: 'runner' })).toBe(RUNNER.address)
    expect(await r.readContract({ address: env.orders, abi: ORDERS_ABI, functionName: 'payout' })).toBe(getAddress(PAYOUT))
    expect(await r.readContract({ address: env.orders, abi: ORDERS_ABI, functionName: 'VERSION' })).toBe('salvo-orders/1')
  })

  it('the constructor refuses a token with no code or not 6 decimals, and a zero runner or payout', async () => {
    const chain = await TestChain.create()
    const token = await deployMockToken(chain, DEPLOYER)
    const token18 = await deployMockToken(chain, DEPLOYER, 18)
    expect((await chain.deployResult(DEPLOYER, initCode(STRANGER))).revert).toBe('token')
    expect((await chain.deployResult(DEPLOYER, initCode(token18))).revert).toBe('decimals')
    expect((await chain.deployResult(DEPLOYER, initCode(token, zeroAddress))).revert).toBe('runner')
    expect((await chain.deployResult(DEPLOYER, initCode(token, RUNNER.address, zeroAddress))).revert).toBe('payout')
    expect((await chain.deployResult(DEPLOYER, initCode(token))).ok).toBe(true)
  })

  it('the contract hashes as viem does: typehash, domain, settle digest and authorization nonce', async () => {
    const env = await tokenWorld()
    const r = readerFor(env.chain)
    const id = await openOrder(env)
    expect(await r.readContract({ address: env.orders, abi: ORDERS_ABI, functionName: 'SETTLE_TYPEHASH' })).toBe(keccak256(toHex(SETTLE_TYPE)))
    const domain = ordersDomain(env.chain.chainId, env.orders)
    expect(domain).toMatchObject({ name: ORDERS_EIP712_NAME, version: ORDERS_EIP712_VERSION })
    expect(await r.readContract({ address: env.orders, abi: ORDERS_ABI, functionName: 'domainSeparator' })).toBe(hashDomain({
      domain,
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
      },
    }))
    const o = await order(env, id)
    const digest = hashTypedData({
      domain,
      types: SETTLE_TYPES,
      primaryType: 'Settle',
      message: { id, buyer: BUYER, amount: AMOUNT, deadline: o.deadline, termsHash: TERMS, resultHash: RESULT, refund: 7n },
    })
    expect(await r.readContract({ address: env.orders, abi: ORDERS_ABI, functionName: 'settleDigest', args: [id, RESULT, 7n] })).toBe(digest)
    // The nonce, written out by hand and by the exported helper, equals the contract's.
    const deadline = Number(deadlineIn(env))
    const byHand = keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint96' }, { type: 'uint40' }],
        [env.chain.chainId, env.orders, AGENT.address, TERMS, AMOUNT, deadline],
      ),
    )
    const helper = ordersAuthorizationNonce({ chainId: env.chain.chainId, contract: env.orders, buyer: AGENT.address, termsHash: TERMS, amount: AMOUNT, deadline })
    expect(helper).toBe(byHand)
    expect(
      await r.readContract({ address: env.orders, abi: ORDERS_ABI, functionName: 'authorizationNonce', args: [AGENT.address, TERMS, AMOUNT, deadline] }),
    ).toBe(byHand)
    // The settle digest written out by hand from the typehash, as the contract builds it.
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint96' }, { type: 'uint40' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint96' }],
        [keccak256(toHex(SETTLE_TYPE)), id, BUYER, AMOUNT, o.deadline, TERMS, RESULT, 7n],
      ),
    )
    const domainSep = await r.readContract({ address: env.orders, abi: ORDERS_ABI, functionName: 'domainSeparator' })
    expect(keccak256(`0x1901${domainSep.slice(2)}${structHash.slice(2)}`)).toBe(digest)
    // MockUSDC's typehash is Circle's.
    const usdc = await usdcWorld()
    expect(await readerFor(usdc.chain).readContract({ address: usdc.token, abi: USDC_ABI, functionName: 'RECEIVE_WITH_AUTHORIZATION_TYPEHASH' })).toBe(
      keccak256(toHex(RECEIVE_TYPE)),
    )
  })
})

// --------------------------------------------------------------------------------------------
describe('open', () => {
  it('pulls the amount from the caller, records the order, counts ids from 1 and emits Opened', async () => {
    const env = await tokenWorld()
    const deadline = deadlineIn(env)
    const before = await balance(env, BUYER)
    const r = ok(await env.chain.send(BUYER, env.orders, call.open(TERMS, AMOUNT, deadline)))
    expect(events(env, r)).toEqual([
      { eventName: 'Opened', args: { id: 1n, buyer: BUYER, amount: AMOUNT, deadline: Number(deadline), termsHash: TERMS } },
    ])
    expect(transfers(env, r)).toEqual([{ from: BUYER, to: env.orders, value: AMOUNT }])
    expect(await balance(env, BUYER)).toBe(before - AMOUNT)
    const o = await order(env, 1n)
    expect(o.buyer).toBe(getAddress(BUYER))
    expect(o).toMatchObject({ amount: AMOUNT, deadline: Number(deadline), state: STATE.OPEN, termsHash: TERMS })
    expect(await openOrder(env, { from: BUYER2, terms: TERMS2, amount: 1n })).toBe(2n)
    expect(await orderCount(env)).toBe(2n)
    expect((await order(env, 0n)).state).toBe(STATE.NONE)
    expect((await order(env, 3n)).state).toBe(STATE.NONE)
  })

  it('refuses a zero amount, a zero terms hash, and a deadline that is not in (now, now + 30 days]', async () => {
    const env = await tokenWorld()
    const now = env.chain.timestamp
    reverts(await env.chain.send(BUYER, env.orders, call.open(TERMS, 0n, now + 60n)), 'amount')
    reverts(await env.chain.send(BUYER, env.orders, call.open(ZERO32, AMOUNT, now + 60n)), 'terms')
    reverts(await env.chain.send(BUYER, env.orders, call.open(TERMS, AMOUNT, now)), 'deadline')
    reverts(await env.chain.send(BUYER, env.orders, call.open(TERMS, AMOUNT, now - 1n)), 'deadline')
    reverts(await env.chain.send(BUYER, env.orders, call.open(TERMS, AMOUNT, now + MAX_DURATION + 1n)), 'deadline')
    ok(await env.chain.send(BUYER, env.orders, call.open(TERMS, AMOUNT, now + MAX_DURATION)))
    ok(await env.chain.send(BUYER, env.orders, call.open(TERMS, AMOUNT, now + 1n)))
    expect(await orderCount(env)).toBe(2n)
  })

  it('refuses when the pull fails: no allowance, too little money, or a fee-taking token', async () => {
    const env = await tokenWorld()
    reverts(await env.chain.send(STRANGER, env.orders, call.open(TERMS, AMOUNT, deadlineIn(env))), 'pull')
    reverts(await env.chain.send(BUYER, env.orders, call.open(TERMS, FUNDS + 1n, deadlineIn(env))), 'pull')
    ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setFeeBps(100n)))
    reverts(await env.chain.send(BUYER, env.orders, call.open(TERMS, AMOUNT, deadlineIn(env))), 'pull amount')
    expect(await orderCount(env)).toBe(0n)
    expect(await balance(env, env.orders)).toBe(0n)
  })

  it('accepts a token whose transfers return no data', async () => {
    const env = await tokenWorld()
    ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setNoReturn(true)))
    const id = await openOrder(env)
    ok(await env.chain.send(STRANGER, env.orders, call.settle(id, RESULT, 5n, await signSettle(env, id, RESULT, 5n))))
    expect(await balance(env, PAYOUT)).toBe(AMOUNT - 5n)
  })
})

// --------------------------------------------------------------------------------------------
describe('settle', () => {
  it('fulfilled (refund 0): anyone submits the runner signature and payout gets the whole amount', async () => {
    const env = await tokenWorld()
    const id = await openOrder(env)
    const sig = await signSettle(env, id, RESULT, 0n)
    const r = ok(await env.chain.send(STRANGER, env.orders, call.settle(id, RESULT, 0n, sig)))
    expect(events(env, r)).toEqual([{ eventName: 'Settled', args: { id, resultHash: RESULT, refund: 0n } }])
    expect(transfers(env, r)).toEqual([{ from: env.orders, to: PAYOUT, value: AMOUNT }])
    expect((await order(env, id)).state).toBe(STATE.SETTLED)
    expect(await balance(env, PAYOUT)).toBe(AMOUNT)
  })

  it('a part refund splits the amount; a full refund is a failed order and pays the buyer everything', async () => {
    const env = await tokenWorld()
    const a = await openOrder(env)
    const b = await openOrder(env, { terms: TERMS2 })
    const start = await balance(env, BUYER)
    const part = 10_000_000n
    const r1 = ok(await env.chain.send(RELAYER, env.orders, call.settle(a, RESULT, part, await signSettle(env, a, RESULT, part))))
    expect(transfers(env, r1)).toEqual([
      { from: env.orders, to: BUYER, value: part },
      { from: env.orders, to: PAYOUT, value: AMOUNT - part },
    ])
    const failed = keccak256(toHex('failed: store declined'))
    const r2 = ok(await env.chain.send(BUYER, env.orders, call.settle(b, failed, AMOUNT, await signSettle(env, b, failed, AMOUNT))))
    expect(transfers(env, r2)).toEqual([{ from: env.orders, to: BUYER, value: AMOUNT }])
    expect(events(env, r2)).toEqual([{ eventName: 'Settled', args: { id: b, resultHash: failed, refund: AMOUNT } }])
    expect(await balance(env, BUYER)).toBe(start + part + AMOUNT)
    expect(await balance(env, PAYOUT)).toBe(AMOUNT - part)
  })

  it('still settles after the deadline while the order is open', async () => {
    const env = await tokenWorld()
    const deadline = deadlineIn(env, 60n)
    const id = await openOrder(env, { deadline })
    env.chain.setTime(deadline + DAY)
    ok(await env.chain.send(STRANGER, env.orders, call.settle(id, RESULT, 0n, await signSettle(env, id, RESULT, 0n))))
    expect((await order(env, id)).state).toBe(STATE.SETTLED)
  })

  it('refuses a refund above the amount, even signed by the runner', async () => {
    const env = await tokenWorld()
    const id = await openOrder(env)
    reverts(await env.chain.send(STRANGER, env.orders, call.settle(id, RESULT, AMOUNT + 1n, await signSettle(env, id, RESULT, AMOUNT + 1n))), 'refund')
  })

  it('refuses an order that is not open: none, settled twice, or already reclaimed', async () => {
    const env = await tokenWorld()
    const sig0 = await signSettle(env, 0n, RESULT, 0n, { termsHash: ZERO32 })
    reverts(await env.chain.send(STRANGER, env.orders, call.settle(0n, RESULT, 0n, sig0)), 'not open')
    reverts(await env.chain.send(STRANGER, env.orders, call.settle(99n, RESULT, 0n, await signSettle(env, 99n, RESULT, 0n, { termsHash: ZERO32 }))), 'not open')

    const id = await openOrder(env)
    const sig = await signSettle(env, id, RESULT, 0n)
    ok(await env.chain.send(STRANGER, env.orders, call.settle(id, RESULT, 0n, sig)))
    // The identical message again, and a different one: both refused. One order, one settlement.
    reverts(await env.chain.send(STRANGER, env.orders, call.settle(id, RESULT, 0n, sig)), 'not open')
    reverts(await env.chain.send(STRANGER, env.orders, call.settle(id, RESULT, AMOUNT, await signSettle(env, id, RESULT, AMOUNT))), 'not open')
    // Reclaim after settle.
    env.chain.setTime(deadlineIn(env, DAY))
    reverts(await env.chain.send(BUYER, env.orders, call.reclaim(id)), 'not open')

    // Settle after reclaim.
    const id2 = await openOrder(env, { deadline: deadlineIn(env, 60n) })
    const sig2 = await signSettle(env, id2, RESULT, 0n)
    env.chain.advance(61n)
    ok(await env.chain.send(BUYER, env.orders, call.reclaim(id2)))
    reverts(await env.chain.send(STRANGER, env.orders, call.settle(id2, RESULT, 0n, sig2)), 'not open')
    expect(await balance(env, PAYOUT)).toBe(AMOUNT)
  })

  it('refuses a signature for another id, refund, result or terms, or from anyone but the runner', async () => {
    const env = await tokenWorld()
    const a = await openOrder(env)
    const b = await openOrder(env)
    const send = (sig: Hex, refund = 0n): Promise<CallResult> => env.chain.send(STRANGER, env.orders, call.settle(a, RESULT, refund, sig))
    // Order b has the same terms, amount and buyer as a: only the id tells their signatures apart.
    reverts(await send(await signSettle(env, b, RESULT, 0n)), 'signer')
    reverts(await send(await signSettle(env, a, RESULT, 1n)), 'signer')
    reverts(await send(await signSettle(env, a, RESULT, 0n), 1n), 'signer')
    reverts(await send(await signSettle(env, a, keccak256(toHex('another result')), 0n)), 'signer')
    reverts(await send(await signSettle(env, a, RESULT, 0n, { termsHash: TERMS2 })), 'signer')
    reverts(await send(await signSettle(env, a, RESULT, 0n, { signer: ROGUE })), 'signer')
    // The payout address and the buyer cannot sign either; only the runner key.
    reverts(await send(await signSettle(env, a, RESULT, 0n, { signer: AGENT })), 'signer')
    expect((await order(env, a)).state).toBe(STATE.OPEN)
    ok(await send(await signSettle(env, a, RESULT, 0n)))
  })

  it('refuses a high-s twin, a bad v, a short signature and one that recovers to nobody', async () => {
    const env = await tokenWorld()
    const id = await openOrder(env)
    const sig = await signSettle(env, id, RESULT, 0n)
    const send = (s: Hex): Promise<CallResult> => env.chain.send(STRANGER, env.orders, call.settle(id, RESULT, 0n, s))
    // The twin is a valid ECDSA signature for the same digest and signer: refused for its s alone.
    const twin = highS(sig)
    expect(BigInt(`0x${twin.slice(66, 130)}`)).toBeGreaterThan(SECP256K1_N / 2n)
    reverts(await send(twin), 'sig s')
    reverts(await send(withV(sig, 0)), 'sig v')
    reverts(await send(withV(sig, 1)), 'sig v')
    reverts(await send(withV(sig, 29)), 'sig v')
    reverts(await send(`0x${sig.slice(2, 130)}`), 'sig length')
    reverts(await send(`${sig}00`), 'sig length')
    // r = 0 is no point on the curve: ecrecover answers the zero address.
    reverts(await send(`0x${'00'.repeat(32)}${'00'.repeat(31)}01${'1b'}`), 'sig')
    // The flipped v recovers someone else: a well-formed signature by not-the-runner.
    reverts(await send(withV(sig, parseInt(sig.slice(130), 16) === 27 ? 28 : 27)), 'signer')
    ok(await send(sig))
  })

  it('refuses a signature made for another contract with the same order', async () => {
    const env = await tokenWorld()
    const twin = await deployOrders(env.chain, env.token)
    ok(await env.chain.send(BUYER, env.token, tokenCall.approve(twin.orders, maxUint256)))
    ok(await env.chain.send(BUYER, twin.orders, call.open(TERMS, AMOUNT, deadlineIn(env))))
    const id = await openOrder(env)
    expect(id).toBe(1n)
    const forTwin = await signSettle(twin, 1n, RESULT, 0n)
    reverts(await env.chain.send(STRANGER, env.orders, call.settle(id, RESULT, 0n, forTwin)), 'signer')
    reverts(await env.chain.send(STRANGER, env.orders, call.settle(id, RESULT, 0n, await signSettle(env, id, RESULT, 0n, { contract: twin.orders }))), 'signer')
    ok(await env.chain.send(STRANGER, twin.orders, call.settle(1n, RESULT, 0n, forTwin)))
  })

  it('refuses a signature made for another chain, even at the same address with the same order', async () => {
    const moderato = await tokenWorld()
    const base = await tokenWorld({ chainId: BASE_SEPOLIA })
    // Same deployer, same nonces: the same addresses on both chains. Only the chain id differs.
    expect(base.orders).toBe(moderato.orders)
    const deadline = deadlineIn(moderato)
    const idM = await openOrder(moderato, { deadline })
    const idB = await openOrder(base, { deadline })
    expect(idB).toBe(idM)
    const onModerato = await signSettle(moderato, idM, RESULT, 0n)
    reverts(await base.chain.send(STRANGER, base.orders, call.settle(idB, RESULT, 0n, onModerato)), 'signer')
    reverts(
      await moderato.chain.send(STRANGER, moderato.orders, call.settle(idM, RESULT, 0n, await signSettle(moderato, idM, RESULT, 0n, { chainId: BASE_SEPOLIA }))),
      'signer',
    )
    ok(await base.chain.send(STRANGER, base.orders, call.settle(idB, RESULT, 0n, await signSettle(base, idB, RESULT, 0n))))
    ok(await moderato.chain.send(STRANGER, moderato.orders, call.settle(idM, RESULT, 0n, onModerato)))
  })

  it('a reorg that puts another order at the same id does not carry the signature over to it', async () => {
    // Two histories of one chain: same chain id, same contract address. In the first, the
    // agent's order is id 1 and the runner signs it. In the second, a copy of it (same terms)
    // landed first and took id 1, with another buyer, a tiny amount, or another deadline.
    const signed = await tokenWorld()
    const deadline = deadlineIn(signed)
    const id = await openOrder(signed, { deadline })
    const sig = await signSettle(signed, id, RESULT, 0n)
    const copies: { from: Hex; amount: bigint; deadline: bigint }[] = [
      { from: BUYER2, amount: AMOUNT, deadline },
      { from: BUYER, amount: 1n, deadline },
      { from: BUYER, amount: AMOUNT, deadline: deadline + 1n },
    ]
    for (const copy of copies) {
      const reorged = await tokenWorld()
      expect(reorged.orders).toBe(signed.orders)
      expect(await openOrder(reorged, { ...copy, terms: TERMS })).toBe(id)
      reverts(await reorged.chain.send(STRANGER, reorged.orders, call.settle(id, RESULT, 0n, sig)), 'signer')
      expect((await order(reorged, id)).state).toBe(STATE.OPEN)
    }
    // The order it was made for takes it.
    ok(await signed.chain.send(STRANGER, signed.orders, call.settle(id, RESULT, 0n, sig)))
    // And each field is in the signed message: change any one and the runner's key no longer matches.
    const env = await tokenWorld()
    const a = await openOrder(env)
    const send = (s: Hex): Promise<CallResult> => env.chain.send(STRANGER, env.orders, call.settle(a, RESULT, 0n, s))
    reverts(await send(await signSettle(env, a, RESULT, 0n, { buyer: BUYER2 })), 'signer')
    reverts(await send(await signSettle(env, a, RESULT, 0n, { amount: AMOUNT - 1n })), 'signer')
    reverts(await send(await signSettle(env, a, RESULT, 0n, { deadline: Number(deadlineIn(env)) + 1 })), 'signer')
    ok(await send(await signSettle(env, a, RESULT, 0n)))
  })
})

// --------------------------------------------------------------------------------------------
describe('reclaim', () => {
  it('refuses at one second early and at the deadline itself; after it, anyone sends the whole amount to the buyer', async () => {
    const env = await tokenWorld()
    const deadline = deadlineIn(env, 600n)
    const id = await openOrder(env, { deadline })
    const start = await balance(env, BUYER)
    env.chain.setTime(deadline - 1n)
    reverts(await env.chain.send(BUYER, env.orders, call.reclaim(id)), 'too early')
    env.chain.setTime(deadline)
    reverts(await env.chain.send(BUYER, env.orders, call.reclaim(id)), 'too early')
    env.chain.setTime(deadline + 1n)
    const r = ok(await env.chain.send(STRANGER, env.orders, call.reclaim(id)))
    expect(events(env, r)).toEqual([{ eventName: 'Reclaimed', args: { id } }])
    expect(transfers(env, r)).toEqual([{ from: env.orders, to: BUYER, value: AMOUNT }])
    expect(await balance(env, BUYER)).toBe(start + AMOUNT)
    expect((await order(env, id)).state).toBe(STATE.RECLAIMED)
    reverts(await env.chain.send(BUYER, env.orders, call.reclaim(id)), 'not open')
    reverts(await env.chain.send(BUYER, env.orders, call.reclaim(42n)), 'not open')
  })
})

// --------------------------------------------------------------------------------------------
describe('a payee the token refuses', () => {
  it('a blocked buyer is owed its refund and the payout is still paid; the reverse too; claim pays later', async () => {
    for (const mode of [BLOCK_REVERT, BLOCK_RETURN_FALSE]) {
      const env = await tokenWorld()
      const a = await openOrder(env)
      const b = await openOrder(env)
      const part = 4_000_000n
      ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setBlocked(BUYER, mode)))
      const r = ok(await env.chain.send(STRANGER, env.orders, call.settle(a, RESULT, part, await signSettle(env, a, RESULT, part))))
      expect(events(env, r)).toEqual([
        { eventName: 'Settled', args: { id: a, resultHash: RESULT, refund: part } },
        { eventName: 'Owed', args: { to: BUYER, amount: part } },
      ])
      expect(await balance(env, PAYOUT)).toBe(AMOUNT - part)
      expect(await owed(env, BUYER)).toBe(part)
      await expectBooks(env)
      reverts(await env.chain.send(BUYER, env.orders, call.claim(BUYER)), 'transfer failed')

      // The payout blocked instead: the buyer's refund still goes out.
      ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setBlocked(BUYER, 0)))
      ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setBlocked(PAYOUT, mode)))
      const buyerBefore = await balance(env, BUYER)
      ok(await env.chain.send(STRANGER, env.orders, call.settle(b, RESULT, part, await signSettle(env, b, RESULT, part))))
      expect(await balance(env, BUYER)).toBe(buyerBefore + part)
      expect(await owed(env, PAYOUT)).toBe(AMOUNT - part)
      await expectBooks(env)

      // Anyone may push a claim; it pays only the one owed.
      const c = ok(await env.chain.send(STRANGER, env.orders, call.claim(BUYER)))
      expect(events(env, c)).toEqual([{ eventName: 'Claimed', args: { to: BUYER, amount: part } }])
      expect(await balance(env, BUYER)).toBe(buyerBefore + 2n * part)
      reverts(await env.chain.send(BUYER, env.orders, call.claim(BUYER)), 'nothing owed')
      ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setBlocked(PAYOUT, 0)))
      ok(await env.chain.send(STRANGER, env.orders, call.claim(PAYOUT)))
      expect(await balance(env, PAYOUT)).toBe(2n * (AMOUNT - part))
      reverts(await env.chain.send(STRANGER, env.orders, call.claim(STRANGER)), 'nothing owed')
    }
  })

  it('a blocked buyer reclaiming is owed, not stuck', async () => {
    const env = await tokenWorld()
    const deadline = deadlineIn(env, 60n)
    const id = await openOrder(env, { deadline })
    ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setBlocked(BUYER, BLOCK_REVERT)))
    env.chain.setTime(deadline + 1n)
    ok(await env.chain.send(STRANGER, env.orders, call.reclaim(id)))
    expect((await order(env, id)).state).toBe(STATE.RECLAIMED)
    expect(await owed(env, BUYER)).toBe(AMOUNT)
  })

  it('a token that moves the money and then says no is not paid twice through owed', async () => {
    // Without the balance re-read in _pay, both payees would be paid AND credited, and a claim
    // would then pay again out of the third order's money: the books check catches that too.
    const env = await usdcWorld()
    for (const terms of [TERMS, TERMS2, RESULT]) {
      ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { termsHash: terms }))))
    }
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('setSaysNoAfterMove', [PAYOUT, true])))
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('setSaysNoAfterMove', [AGENT.address, true])))
    const part = 2_000_000n
    const r = ok(await env.chain.send(RELAYER, env.orders, call.settle(1n, RESULT, part, await signSettle(env, 1n, RESULT, part))))
    expect(events(env, r)).toEqual([{ eventName: 'Settled', args: { id: 1n, resultHash: RESULT, refund: part } }])
    expect(await balance(env, PAYOUT)).toBe(AMOUNT - part)
    expect(await balance(env, AGENT.address)).toBe(FUNDS - 3n * AMOUNT + part)
    expect(await owed(env, PAYOUT)).toBe(0n)
    expect(await owed(env, AGENT.address)).toBe(0n)
    await expectBooks(env)
    // A reclaim the same way.
    env.chain.advance(DAY)
    ok(await env.chain.send(RELAYER, env.orders, call.reclaim(2n)))
    expect(await owed(env, AGENT.address)).toBe(0n)
    expect(await balance(env, env.orders)).toBe(AMOUNT)
  })
})

// --------------------------------------------------------------------------------------------
describe('reentrancy', () => {
  it('a token calling back during a payout or a pull is refused, and nothing moves twice', async () => {
    const env = await tokenWorld()
    const a = await openOrder(env)
    const b = await openOrder(env)
    const sigA = await signSettle(env, a, RESULT, 0n)
    const sigB = await signSettle(env, b, RESULT, 0n)
    const r = readerFor(env.chain)
    /** What the token's one-shot callback did on the last transfer. */
    const hook = async (): Promise<{ called: boolean; ok: boolean; reason: string }> => ({
      called: await r.readContract({ address: env.token, abi: MOCK_TOKEN_ABI, functionName: 'hookCalled' }),
      ok: await r.readContract({ address: env.token, abi: MOCK_TOKEN_ABI, functionName: 'hookOk' }),
      reason: revertText(await r.readContract({ address: env.token, abi: MOCK_TOKEN_ABI, functionName: 'hookReturn' })),
    })
    const refused = { called: true, ok: false, reason: 'reentrant' }

    // During a's payout: settle a again, then (next payout) settle b, then claim.
    ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setHook(env.orders, call.settle(a, RESULT, 0n, sigA))))
    const first = ok(await env.chain.send(STRANGER, env.orders, call.settle(a, RESULT, 0n, sigA)))
    expect(await hook()).toEqual(refused)
    expect(transfers(env, first)).toEqual([{ from: env.orders, to: PAYOUT, value: AMOUNT }])
    ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setHook(env.orders, call.claim(PAYOUT))))
    ok(await env.chain.send(STRANGER, env.orders, call.settle(b, RESULT, 0n, sigB)))
    expect(await hook()).toEqual(refused)
    expect((await order(env, a)).state).toBe(STATE.SETTLED)
    expect((await order(env, b)).state).toBe(STATE.SETTLED)
    expect(await balance(env, PAYOUT)).toBe(2n * AMOUNT)

    // During a reclaim's payout: settle another open order.
    const c = await openOrder(env, { deadline: deadlineIn(env, 60n) })
    const d = await openOrder(env)
    ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setHook(env.orders, call.settle(d, RESULT, 0n, await signSettle(env, d, RESULT, 0n)))))
    env.chain.advance(61n)
    ok(await env.chain.send(STRANGER, env.orders, call.reclaim(c)))
    expect(await hook()).toEqual(refused)
    expect((await order(env, d)).state).toBe(STATE.OPEN)

    // During an open's pull: open again, and reclaim an order that is still OPEN and past its
    // deadline, so the inner reclaim has something to take and only the lock stops it.
    const e = await openOrder(env, { deadline: deadlineIn(env, 60n) })
    env.chain.advance(61n)
    expect((await order(env, e)).state).toBe(STATE.OPEN)
    for (const data of [call.open(TERMS, AMOUNT, deadlineIn(env)), call.reclaim(e)]) {
      ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setHook(env.orders, data)))
      await openOrder(env)
      expect(await hook()).toEqual(refused)
      await expectBooks(env)
    }
    expect((await order(env, e)).state).toBe(STATE.OPEN)
    expect(await orderCount(env)).toBe(7n)
    // Unhooked, the same reclaim goes through: the order really was there to take.
    ok(await env.chain.send(STRANGER, env.orders, call.reclaim(e)))
  })

  it('a token calling back during openWithAuthorization is refused: open, reclaim, settle and claim', async () => {
    const env = await usdcWorld()
    // An order past its deadline (something for an inner reclaim to take) and one to settle.
    const past = await authorize(env, { termsHash: TERMS2, deadline: deadlineIn(env, 60n) })
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(past)))
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { termsHash: RESULT }))))
    const sig2 = await signSettle(env, 2n, RESULT, 0n)
    env.chain.advance(61n)
    const r = readerFor(env.chain)
    const inner = [
      call.openWithAuthorization(await authorize(env, { termsHash: keccak256(toHex('inner')) })),
      call.reclaim(1n),
      call.settle(2n, RESULT, 0n, sig2),
      call.claim(PAYOUT),
    ]
    for (const [i, data] of inner.entries()) {
      ok(await env.chain.send(DEPLOYER, env.token, usdcCall('setHook', [env.orders, data])))
      const outer = await authorize(env, { termsHash: keccak256(toHex(`outer ${i}`)) })
      ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(outer)))
      expect(await r.readContract({ address: env.token, abi: USDC_ABI, functionName: 'hookCalled' })).toBe(true)
      expect(await r.readContract({ address: env.token, abi: USDC_ABI, functionName: 'hookOk' })).toBe(false)
      expect(revertText(await r.readContract({ address: env.token, abi: USDC_ABI, functionName: 'hookReturn' }))).toBe('reentrant')
    }
    expect((await order(env, 1n)).state).toBe(STATE.OPEN)
    expect((await order(env, 2n)).state).toBe(STATE.OPEN)
    expect(await orderCount(env)).toBe(6n)
  })
})

// --------------------------------------------------------------------------------------------
describe('openWithAuthorization (USDC, EIP-3009)', () => {
  it('a relayer opens the order for the signer; the token burns the nonce; the runner settles it', async () => {
    const env = await usdcWorld()
    const auth = await authorize(env)
    const r = ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(auth)))
    expect(events(env, r)).toEqual([
      { eventName: 'Opened', args: { id: 1n, buyer: AGENT.address.toLowerCase(), amount: AMOUNT, deadline: Number(auth.deadline), termsHash: TERMS } },
    ])
    expect(transfers(env, r)).toEqual([{ from: AGENT.address.toLowerCase(), to: env.orders, value: AMOUNT }])
    const used = r.logs
      .filter((l) => l.address === env.token)
      .map((l) => decodeEventLog({ abi: USDC_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }))
      .filter((e) => e.eventName === 'AuthorizationUsed')
    expect(used).toEqual([{ eventName: 'AuthorizationUsed', args: { authorizer: AGENT.address, nonce: auth.nonce } }])
    const reader = readerFor(env.chain)
    expect(await reader.readContract({ address: env.token, abi: USDC_ABI, functionName: 'authorizationState', args: [AGENT.address, auth.nonce] })).toBe(true)
    expect(await balance(env, AGENT.address)).toBe(FUNDS - AMOUNT)
    expect(await balance(env, RELAYER)).toBe(0n)
    expect(await order(env, 1n)).toEqual({ buyer: AGENT.address, amount: AMOUNT, deadline: Number(auth.deadline), state: STATE.OPEN, termsHash: TERMS })
    await expectBooks(env)
    ok(await env.chain.send(RELAYER, env.orders, call.settle(1n, RESULT, 0n, await signSettle(env, 1n, RESULT, 0n))))
    expect(await balance(env, PAYOUT)).toBe(AMOUNT)
  })

  it('a relayer cannot change the buyer, terms, amount or deadline: the nonce no longer matches, or the signature does not', async () => {
    const env = await usdcWorld()
    const auth = await authorize(env)
    const changes: Partial<Auth>[] = [
      { buyer: BUYER2 },
      { termsHash: TERMS2 },
      { amount: AMOUNT - 1n },
      { amount: AMOUNT + 1n },
      { deadline: auth.deadline + 1n },
      { deadline: auth.deadline - 1n },
    ]
    for (const change of changes) {
      const tampered = { ...auth, ...change }
      // Keeping the signed nonce: the contract sees the parameters are not the ones signed.
      reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(tampered)), 'nonce')
      // Recomputing the nonce for the new parameters: now the buyer's signature does not cover it.
      const nonce = ordersAuthorizationNonce({ chainId: env.chain.chainId, contract: env.orders, ...tampered })
      reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization({ ...tampered, nonce })), 'FiatTokenV2: invalid signature')
    }
    // The window and the signature itself are the token's to check.
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization({ ...auth, validBefore: auth.validBefore + 1n })), 'FiatTokenV2: invalid signature')
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization({ ...auth, validAfter: 1n })), 'FiatTokenV2: invalid signature')
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization({ ...auth, v: auth.v === 27 ? 28 : 27 })), 'FiatTokenV2: invalid signature')
    const highSValue = toHex(SECP256K1_N - BigInt(auth.s), { size: 32 })
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization({ ...auth, s: highSValue })), "ECRecover: invalid signature 's' value")
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization({ ...auth, v: 29 })), "ECRecover: invalid signature 'v' value")
    expect(await orderCount(env)).toBe(0n)
    // Untouched, it still opens.
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(auth)))
  })

  it('an authorization signed for another payee, or with a nonce not bound to the order, opens nothing', async () => {
    const env = await usdcWorld()
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { to: RELAYER }))), 'FiatTokenV2: invalid signature')
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { nonce: keccak256(toHex('random')) }))), 'nonce')
  })

  it('a replay is refused by the token: one authorization, one order', async () => {
    const env = await usdcWorld()
    const auth = await authorize(env)
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(auth)))
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(auth)), 'FiatTokenV2: authorization is used or canceled')
    reverts(await env.chain.send(STRANGER, env.orders, call.openWithAuthorization(auth)), 'FiatTokenV2: authorization is used or canceled')
    expect(await orderCount(env)).toBe(1n)
    expect(await balance(env, AGENT.address)).toBe(FUNDS - AMOUNT)
  })

  it('an authorization for one deployment opens nothing on another contract or another chain', async () => {
    const env = await usdcWorld()
    const twin = await deployOrders(env.chain, env.token)
    const auth = await authorize(env)
    reverts(await env.chain.send(RELAYER, twin.orders, call.openWithAuthorization(auth)), 'nonce')
    // Bound to the twin's nonce, but still signed with the first contract as payee: the token says no.
    reverts(await env.chain.send(RELAYER, twin.orders, call.openWithAuthorization(await authorize(env, { boundTo: twin.orders }))), 'FiatTokenV2: invalid signature')

    const base = await usdcWorld({ chainId: BASE_SEPOLIA })
    expect(base.orders).toBe(env.orders)
    expect(base.token).toBe(env.token)
    reverts(await base.chain.send(RELAYER, base.orders, call.openWithAuthorization(auth)), 'nonce')
    // The right nonce for Base, signed under Moderato's token domain: the token says no.
    reverts(
      await base.chain.send(RELAYER, base.orders, call.openWithAuthorization(await authorize(base, { domainChainId: env.chain.chainId }))),
      'FiatTokenV2: invalid signature',
    )
  })

  it('the token checks its window: not before validAfter, not at validBefore', async () => {
    const env = await usdcWorld()
    const now = env.chain.timestamp
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { validAfter: now }))), 'FiatTokenV2: authorization is not yet valid')
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { validBefore: now }))), 'FiatTokenV2: authorization is expired')
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { validAfter: now - 1n, validBefore: now + 1n }))))
  })

  it('only the payee may redeem: the authorization cannot be spent by calling the token directly', async () => {
    const env = await usdcWorld()
    const a = await authorize(env)
    const direct = usdcCall('receiveWithAuthorization', [AGENT.address, env.orders, a.amount, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s])
    reverts(await env.chain.send(RELAYER, env.token, direct), 'FiatTokenV2: caller must be the payee')
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(a)))
  })

  it('checks the order the same way open does: zero buyer, amount, terms, deadline', async () => {
    const env = await usdcWorld()
    const now = env.chain.timestamp
    const bound = async (o: AuthOpts & { buyer?: Hex }): Promise<Auth> => {
      const a = await authorize(env, o)
      const buyer = o.buyer ?? a.buyer
      return { ...a, buyer, nonce: ordersAuthorizationNonce({ chainId: env.chain.chainId, contract: env.orders, buyer, termsHash: a.termsHash, amount: a.amount, deadline: a.deadline }) }
    }
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await bound({ buyer: zeroAddress }))), 'buyer')
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await bound({ amount: 0n }))), 'amount')
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await bound({ termsHash: ZERO32 }))), 'terms')
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await bound({ deadline: now }))), 'deadline')
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await bound({ deadline: now + MAX_DURATION + 1n }))), 'deadline')
    expect(await orderCount(env)).toBe(0n)
  })

  it('refuses a token that takes a fee: the contract must receive exactly the amount', async () => {
    const env = await usdcWorld()
    const auth = await authorize(env)
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('setFeeBps', [100n])))
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(auth)), 'pull amount')
    // The refusal undid the token's side too: the nonce is unspent and the buyer kept the money.
    const reader = readerFor(env.chain)
    expect(await reader.readContract({ address: env.token, abi: USDC_ABI, functionName: 'authorizationState', args: [AGENT.address, auth.nonce] })).toBe(false)
    expect(await balance(env, AGENT.address)).toBe(FUNDS)
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('setFeeBps', [0n])))
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(auth)))
  })

  it('a buyer USDC refuses to pay (blacklisted) is owed; the payout share still goes out; claim pays once allowed', async () => {
    const env = await usdcWorld()
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env))))
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { termsHash: TERMS2 }))))
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { termsHash: RESULT, deadline: deadlineIn(env, 60n) }))))
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('setBlacklisted', [AGENT.address, true])))
    const part = 3_000_000n
    ok(await env.chain.send(RELAYER, env.orders, call.settle(1n, RESULT, part, await signSettle(env, 1n, RESULT, part))))
    expect(await balance(env, PAYOUT)).toBe(AMOUNT - part)
    expect(await owed(env, AGENT.address)).toBe(part)
    await expectBooks(env)
    // A failed order to a blacklisted buyer: all of it owed, nothing to payout.
    ok(await env.chain.send(RELAYER, env.orders, call.settle(2n, RESULT, AMOUNT, await signSettle(env, 2n, RESULT, AMOUNT))))
    expect(await owed(env, AGENT.address)).toBe(part + AMOUNT)
    expect(await balance(env, PAYOUT)).toBe(AMOUNT - part)
    // A reclaim too.
    env.chain.advance(61n)
    ok(await env.chain.send(RELAYER, env.orders, call.reclaim(3n)))
    expect(await owed(env, AGENT.address)).toBe(part + 2n * AMOUNT)
    await expectBooks(env)
    reverts(await env.chain.send(RELAYER, env.orders, call.claim(AGENT.address)), 'transfer failed')
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('setBlacklisted', [AGENT.address, false])))
    ok(await env.chain.send(RELAYER, env.orders, call.claim(AGENT.address)))
    expect(await balance(env, AGENT.address)).toBe(FUNDS - AMOUNT + part)
    expect(await owed(env, AGENT.address)).toBe(0n)
  })

  it('a blacklisted payout is owed; the buyer refund still goes out', async () => {
    const env = await usdcWorld()
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env))))
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('setBlacklisted', [PAYOUT, true])))
    const part = 5_000_000n
    ok(await env.chain.send(RELAYER, env.orders, call.settle(1n, RESULT, part, await signSettle(env, 1n, RESULT, part))))
    expect(await balance(env, AGENT.address)).toBe(FUNDS - AMOUNT + part)
    expect(await owed(env, PAYOUT)).toBe(AMOUNT - part)
  })

  it('approve + open also works on USDC', async () => {
    const env = await usdcWorld()
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('mint', [BUYER, AMOUNT])))
    ok(await env.chain.send(BUYER, env.token, usdcCall('approve', [env.orders, AMOUNT])))
    expect(await openOrder(env)).toBe(1n)
    expect(await balance(env, BUYER)).toBe(0n)
  })

  it('a copy relayed first opens the same order; Salvo\'s own relay then reverts, and the Opened log finds the order exactly', async () => {
    const env = await usdcWorld()
    const auth = await authorize(env)
    // Someone who saw the calldata sends it first. The order opens exactly as the buyer signed.
    const first = ok(await env.chain.send(STRANGER, env.orders, call.openWithAuthorization(auth)))
    // Salvo's relay of the same authorization: refused by the token, and nothing else moves.
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(auth)), 'FiatTokenV2: authorization is used or canceled')
    // What a relayer does next: the nonce is spent ...
    const reader = readerFor(env.chain)
    expect(await reader.readContract({ address: env.token, abi: USDC_ABI, functionName: 'authorizationState', args: [AGENT.address, auth.nonce] })).toBe(true)
    // ... so it looks for Opened by its two indexed fields, buyer and termsHash, which a quote makes unique.
    const opened = first.logs.filter((l) => l.address === env.orders)
    expect(opened).toHaveLength(1)
    const topics = opened[0]?.topics ?? []
    expect(topics[2]).toBe(encodeAbiParameters([{ type: 'address' }], [AGENT.address]))
    expect(topics[3]).toBe(TERMS)
    expect(BigInt(topics[1] ?? '0x0')).toBe(1n)
    expect(await order(env, 1n)).toEqual({ buyer: AGENT.address, amount: AMOUNT, deadline: Number(auth.deadline), state: STATE.OPEN, termsHash: TERMS })
    expect(await orderCount(env)).toBe(1n)
  })

  it('a token with no receiveWithAuthorization (pathUSD) refuses both forms with "authorization"', async () => {
    const env = await tokenWorld()
    const auth = await authorize(env)
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(auth)), 'authorization')
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorizationSignature(auth)), 'authorization')
    expect(await orderCount(env)).toBe(0n)
  })

  it('a token whose balanceOf fails: nothing opens, but settle and reclaim still pay out', async () => {
    const env = await usdcWorld()
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env))))
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { termsHash: TERMS2 }))))
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { termsHash: RESULT }))))
    const part = 1_000_000n
    const sig1 = await signSettle(env, 1n, RESULT, part)
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('setBalanceOfReverts', [true])))
    // A pull cannot be checked, so nothing opens.
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { termsHash: keccak256(toHex('fourth')) }))), 'balanceOf')
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('mint', [BUYER, AMOUNT])))
    ok(await env.chain.send(BUYER, env.token, usdcCall('approve', [env.orders, AMOUNT])))
    reverts(await env.chain.send(BUYER, env.orders, call.open(TERMS, AMOUNT, deadlineIn(env))), 'balanceOf')
    // A payout needs only a working transfer.
    ok(await env.chain.send(RELAYER, env.orders, call.settle(1n, RESULT, part, sig1)))
    expect((await order(env, 1n)).state).toBe(STATE.SETTLED)
    // A refused payout with no readable balance is owed in full, as in V2.
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('setBlacklisted', [PAYOUT, true])))
    ok(await env.chain.send(RELAYER, env.orders, call.settle(2n, RESULT, 0n, await signSettle(env, 2n, RESULT, 0n))))
    // The agent's way out does not depend on balanceOf either.
    env.chain.advance(DAY)
    ok(await env.chain.send(STRANGER, env.orders, call.reclaim(3n)))
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('setBalanceOfReverts', [false])))
    expect(await balance(env, PAYOUT)).toBe(AMOUNT - part)
    expect(await owed(env, PAYOUT)).toBe(AMOUNT)
    expect(await balance(env, AGENT.address)).toBe(FUNDS - 2n * AMOUNT + part)
  })

  it('the bytes form opens for a buyer with no code, under the same bindings, and shares the one nonce', async () => {
    const env = await usdcWorld()
    const auth = await authorize(env)
    // The bound nonce is checked the same way.
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorizationSignature({ ...auth, amount: AMOUNT + 1n })), 'nonce')
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorizationSignature({ ...auth, termsHash: TERMS2 })), 'nonce')
    // A buyer with no code is ECDSA: 65 bytes, low s.
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorizationSignature(auth, `0x${auth.signature.slice(2, 130)}`)), 'ECRecover: invalid signature length')
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorizationSignature(auth, highS(auth.signature))), "ECRecover: invalid signature 's' value")
    const r = ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorizationSignature(auth)))
    expect(events(env, r)).toEqual([
      { eventName: 'Opened', args: { id: 1n, buyer: AGENT.address.toLowerCase(), amount: AMOUNT, deadline: Number(auth.deadline), termsHash: TERMS } },
    ])
    // The same authorization through the other form is a replay.
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(auth)), 'FiatTokenV2: authorization is used or canceled')
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorizationSignature(auth)), 'FiatTokenV2: authorization is used or canceled')
    expect(await orderCount(env)).toBe(1n)
  })

  it('a buyer with code (smart wallet, EIP-7702) is checked by EIP-1271, as USDC v2.2 does, and pays through either form its signature fits', async () => {
    const env = await usdcWorld()
    const wallet = await env.chain.deploy(DEPLOYER, encodeDeployData({ abi: WALLET_ABI, bytecode: WALLET_BYTECODE, args: [WALLET_OWNER.address] }))
    ok(await env.chain.send(DEPLOYER, env.token, usdcCall('mint', [wallet, FUNDS])))
    const reader = readerFor(env.chain)
    expect(await reader.readContract({ address: wallet, abi: WALLET_ABI, functionName: 'WRAP_TAG' })).toBe(WRAP_TAG)

    // A 65-byte signature by the wallet's owner key: USDC asks the wallet, the wallet says yes.
    // The v,r,s form carries it.
    const plain = await authorize(env, { signer: WALLET_OWNER, from: wallet })
    expect(plain.buyer).toBe(wallet)
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(plain)))
    expect((await order(env, 1n)).buyer).toBe(getAddress(wallet))

    // A bad signature for a buyer with code is the wallet's "no", never ECRecover's checks:
    // the token answers "invalid signature" where an EOA would get the 'v' value text.
    const another = await authorize(env, { signer: WALLET_OWNER, from: wallet, termsHash: TERMS2 })
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorization({ ...another, v: 29 })), 'FiatTokenV2: invalid signature')
    // The agent's own key is not the wallet's owner.
    reverts(
      await env.chain.send(RELAYER, env.orders, call.openWithAuthorization(await authorize(env, { signer: AGENT, from: wallet, termsHash: TERMS2 }))),
      'FiatTokenV2: invalid signature',
    )

    // A longer signature, as a smart wallet's often is, fits only the bytes form.
    const wrapped: Hex = `0x${WRAP_TAG.slice(2)}${another.signature.slice(2)}`
    expect((wrapped.length - 2) / 2).toBe(97)
    reverts(await env.chain.send(RELAYER, env.orders, call.openWithAuthorizationSignature(another, `0x${'00'.repeat(32)}${another.signature.slice(2)}`)), 'FiatTokenV2: invalid signature')
    ok(await env.chain.send(RELAYER, env.orders, call.openWithAuthorizationSignature(another, wrapped)))
    expect(await order(env, 2n)).toMatchObject({ buyer: getAddress(wallet), amount: AMOUNT, state: STATE.OPEN, termsHash: TERMS2 })
    expect(await balance(env, wallet)).toBe(FUNDS - 2n * AMOUNT)

    // Refunds go back to the wallet.
    ok(await env.chain.send(RELAYER, env.orders, call.settle(2n, RESULT, AMOUNT, await signSettle(env, 2n, RESULT, AMOUNT))))
    expect(await balance(env, wallet)).toBe(FUNDS - AMOUNT)
  })
})

// --------------------------------------------------------------------------------------------
describe('many orders at once', () => {
  it('keeps the books through an interleaved run of opens, settles, reclaims, refusals and claims', async () => {
    const env = await tokenWorld()
    const step = async (fn: () => Promise<unknown>): Promise<void> => {
      await fn()
      await expectBooks(env)
    }
    const ids: bigint[] = []
    for (let i = 0; i < 6; i++) {
      await step(async () => ids.push(await openOrder(env, { from: i % 2 === 0 ? BUYER : BUYER2, amount: AMOUNT + BigInt(i), deadline: deadlineIn(env, 600n + BigInt(i)) })))
    }
    const [o1, o2, o3, o4, o5, o6] = ids as [bigint, bigint, bigint, bigint, bigint, bigint]
    await step(async () => ok(await env.chain.send(STRANGER, env.orders, call.settle(o1, RESULT, 0n, await signSettle(env, o1, RESULT, 0n)))))
    await step(async () => ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setBlocked(BUYER2, BLOCK_RETURN_FALSE))))
    await step(async () => ok(await env.chain.send(STRANGER, env.orders, call.settle(o2, RESULT, 7n, await signSettle(env, o2, RESULT, 7n)))))
    await step(async () => ok(await env.chain.send(STRANGER, env.orders, call.settle(o3, RESULT, AMOUNT + 2n, await signSettle(env, o3, RESULT, AMOUNT + 2n)))))
    await step(async () => reverts(await env.chain.send(STRANGER, env.orders, call.reclaim(o4)), 'too early'))
    env.chain.advance(700n)
    await step(async () => ok(await env.chain.send(STRANGER, env.orders, call.reclaim(o4))))
    await step(async () => ok(await env.chain.send(STRANGER, env.orders, call.settle(o5, RESULT, 1n, await signSettle(env, o5, RESULT, 1n)))))
    await step(async () => ok(await env.chain.send(DEPLOYER, env.token, tokenCall.setBlocked(BUYER2, 0))))
    await step(async () => ok(await env.chain.send(BUYER2, env.orders, call.claim(BUYER2))))
    expect((await order(env, o6)).state).toBe(STATE.OPEN)
    expect(await balance(env, env.orders)).toBe(AMOUNT + 5n)
  })
})
