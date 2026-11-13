/**
 * SalvoEscrowV1, run for real: the committed bytes on an in-process EVM
 * (tests/support/evm.ts), against MockToken. No network.
 *
 * What is pinned here, because the custody claim rests on each one:
 *   - MONEY ROUTES. Tokens leave the escrow only to a deposit's seller, its
 *     depositor, or an address it already owes. A fuzzed run checks this on
 *     every step, with the balance rule: escrow balance == every Opened
 *     deposit's amount + every `owed`.
 *   - THE TICKET. Every `require` in _checkTerms and _checkTicket fires at its
 *     exact edge, and a ticket cannot be replayed by another buyer, on another
 *     listing, on another escrow, or on another chain.
 *   - THE BYTES. No DELEGATECALL, CALLCODE or SELFDESTRUCT; the ABI is exactly
 *     the committed artifact's (spec section 5 as amended by this build, not
 *     its first draft); the runtime hash does not depend on constructor
 *     arguments; the committed artifact equals a fresh compile with the pinned
 *     solc, and git does not ignore it.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import {
  decodeEventLog,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  maxUint256,
  toHex,
  zeroAddress,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  ESCROW_ABI,
  ESCROW_RUNTIME_BYTECODE,
  ESCROW_SOURCE_SHA256,
  RUNTIME_KECCAK,
  SOLC_SETTINGS,
  SOLC_VERSION,
} from '@/lib/escrow/artifact'
import { compileEscrow, driftedFiles, ESCROW_JSON_PATH, MOCK_TOKEN_JSON_PATH, SOLC_PIN } from '../scripts/escrow-compile'
import mockTokenArtifact from '../contracts/out/MockToken.json'
import { TestChain, revertText, testAddress, type CallResult } from './support/evm'
import {
  DEPOSIT_OPENED,
  DEPOSIT_REFUNDED,
  DEPOSIT_RELEASED,
  DISPUTE_HOLD,
  LISTING_ACTIVE,
  LISTING_CANCELLED,
  LISTING_SOLD,
  LISTING_TYPE,
  MAX_TICKET_TTL,
  MOCK_TOKEN_ABI,
  MODE_BLIND,
  MODE_READABLE,
  OPEN_TYPE,
  RELEASE_DELAY,
  TERMS_TYPE,
  UNITS_PER_CENT,
  commitmentOf,
  coreHash,
  deployEscrow,
  deployEscrowResult,
  deployMockToken,
  escrowCall,
  highS,
  listingIdOf,
  openDigest,
  readerFor,
  signTicket,
  tokenCall,
  withV,
  type OpenFields,
  type Terms,
  type Ticket,
} from './support/escrow-chain'

const LIT = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const ROGUE = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const DEPLOYER = testAddress(1)
const SELLER = testAddress(2)
const BUYER = testAddress(3)
const STRANGER = testAddress(4)
const BUYER2 = testAddress(5)
const SELLER2 = testAddress(6)
const T0 = 1_790_000_000n
/** $1,000,000 in 6-decimal units: no test runs out of money by accident. */
const FUNDS = 1_000_000_000_000n
const ECRECOVER: Hex = '0x0000000000000000000000000000000000000001'

interface Env {
  chain: TestChain
  reader: PublicClient
  token: Hex
  escrow: Hex
}

interface Listed {
  t: Terms
  envelopeHash: Hex
  listingId: Hex
}

let uniq = 0
const fresh32 = (label: string): Hex => keccak256(toHex(`${label}-${++uniq}`))
const lower = (a: string): Hex => a.toLowerCase() as Hex
const now = (env: Env): number => Number(env.chain.timestamp)

async function mustSend(chain: TestChain, from: Hex, to: Hex, data: Hex): Promise<CallResult> {
  const r = await chain.send(from, to, data)
  if (!r.ok) throw new Error(`send failed: ${r.revert ?? '?'}`)
  return r
}

function expectRevert(r: CallResult, reason: string): void {
  expect({ ok: r.ok, revert: r.revert }).toEqual({ ok: false, revert: reason })
}

function expectOk(r: CallResult): void {
  expect({ ok: r.ok, revert: r.revert }).toEqual({ ok: true, revert: null })
}

async function setup(opts: { chainId?: bigint } = {}): Promise<Env> {
  const chain = await TestChain.create({ timestamp: T0, ...(opts.chainId === undefined ? {} : { chainId: opts.chainId }) })
  const token = await deployMockToken(chain, DEPLOYER)
  const escrow = await deployEscrow(chain, DEPLOYER, LIT.address, token)
  for (const who of [SELLER, SELLER2, BUYER, BUYER2, STRANGER]) {
    await mustSend(chain, DEPLOYER, token, tokenCall.mint(who, FUNDS))
    await mustSend(chain, who, token, tokenCall.approve(escrow, maxUint256))
  }
  return { chain, reader: readerFor(chain), token, escrow }
}

function terms(env: Env, over: Partial<Terms> = {}): Terms {
  return {
    seller: SELLER,
    price: 4_400_000n,
    valueCents: 500,
    residualCapCents: 0,
    merchant: 9,
    mode: MODE_BLIND,
    listingExpiry: now(env) + 86_400,
    salt: fresh32('salt'),
    ...over,
  }
}

async function listTerms(env: Env, t: Terms, envelopeHash: Hex = fresh32('envelope')): Promise<Listed> {
  const commitment = commitmentOf(env.chain.chainId, env.escrow, env.token, t, envelopeHash)
  await mustSend(env.chain, t.seller, env.escrow, escrowCall.list(commitment))
  return { t, envelopeHash, listingId: listingIdOf(t.seller, commitment) }
}

async function listed(env: Env, over: Partial<Terms> = {}): Promise<Listed> {
  return listTerms(env, terms(env, over))
}

interface TicketOpts {
  signer?: PrivateKeyAccount
  chainId?: bigint
  escrow?: Hex
}

async function ticketFor(env: Env, l: Listed, fields: Partial<OpenFields> = {}, opts: TicketOpts = {}): Promise<Ticket> {
  const f: OpenFields = {
    listingId: l.listingId,
    depositor: BUYER,
    replyKeyHash: fresh32('reply'),
    openBalanceCents: l.t.mode === MODE_READABLE ? l.t.valueCents : 0,
    cardTag: fresh32('tag'),
    notAfter: now(env) + 600,
    ...fields,
  }
  return signTicket(opts.signer ?? LIT, opts.chainId ?? env.chain.chainId, opts.escrow ?? env.escrow, f)
}

/** depositAndOpen as an eth_call: the verdict without spending the listing. */
async function tryOpen(env: Env, l: Listed, k: Ticket, from: Hex = BUYER): Promise<CallResult> {
  return env.chain.call(from, env.escrow, escrowCall.depositAndOpen(l.t, l.envelopeHash, k))
}

async function open(env: Env, l: Listed, k: Ticket, from: Hex = BUYER): Promise<CallResult> {
  return env.chain.send(from, env.escrow, escrowCall.depositAndOpen(l.t, l.envelopeHash, k))
}

/** List, ticket and open in one go. Returns the deposit id. */
async function sold(env: Env, over: Partial<Terms> = {}, buyer: Hex = BUYER, cardTag?: Hex): Promise<{ id: bigint; l: Listed; k: Ticket }> {
  const l = await listed(env, over)
  const k = await ticketFor(env, l, { depositor: buyer, ...(cardTag === undefined ? {} : { cardTag }) })
  const r = await open(env, l, k, buyer)
  if (!r.ok) throw new Error(`open failed: ${r.revert ?? '?'}`)
  const id = await env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'depositCount' })
  return { id, l, k }
}

async function balanceOf(env: Env, who: Hex): Promise<bigint> {
  return env.reader.readContract({ address: env.token, abi: MOCK_TOKEN_ABI, functionName: 'balanceOf', args: [who] })
}

async function deposit(env: Env, id: bigint) {
  return env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'getDeposit', args: [id] })
}

async function owed(env: Env, who: Hex): Promise<bigint> {
  return env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'owed', args: [who] })
}

async function stats(env: Env, who: Hex): Promise<{ sold: number; disputes: number; refunds: number; paidOut: bigint }> {
  const [s, d, r, p] = await env.reader.readContract({
    address: env.escrow,
    abi: ESCROW_ABI,
    functionName: 'sellerStats',
    args: [who],
  })
  return { sold: s, disputes: d, refunds: r, paidOut: p }
}

async function cardOf(env: Env, tag: Hex): Promise<{ owner: Hex; deposit: bigint }> {
  const ask = { address: env.escrow, abi: ESCROW_ABI, args: [tag] } as const
  return {
    owner: lower(await env.reader.readContract({ ...ask, functionName: 'cardOwner' })),
    deposit: await env.reader.readContract({ ...ask, functionName: 'cardDeposit' }),
  }
}

async function releaseWhenDue(env: Env, id: bigint): Promise<CallResult> {
  const at = BigInt((await deposit(env, id)).releaseAt)
  if (env.chain.timestamp < at) env.chain.setTime(at)
  return mustSend(env.chain, STRANGER, env.escrow, escrowCall.release(id))
}

function escrowEvents(env: Env, r: CallResult) {
  return r.logs
    .filter((l) => l.address === env.escrow)
    .map((l) => decodeEventLog({ abi: ESCROW_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }))
}

interface Move {
  from: Hex
  to: Hex
  value: bigint
}

function transfers(env: Env, r: CallResult): Move[] {
  const out: Move[] = []
  for (const l of r.logs) {
    if (l.address !== env.token) continue
    const e = decodeEventLog({ abi: MOCK_TOKEN_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] })
    if (e.eventName === 'Transfer') out.push({ from: lower(e.args.from), to: lower(e.args.to), value: e.args.value })
  }
  return out
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

// --------------------------------------------------------------------------------------------
describe('SalvoEscrowV1 bytes and ABI', () => {
  it('the committed artifacts equal a fresh compile with the pinned solc, and the escrow compiles with no warnings', () => {
    const result = compileEscrow()
    expect(driftedFiles(result)).toEqual([])
    expect(result.escrow.warnings).toEqual([])
    expect(SOLC_VERSION.startsWith(`${SOLC_PIN}+`)).toBe(true)
    expect(SOLC_SETTINGS).toEqual({
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      viaIR: false,
      metadata: { bytecodeHash: 'none', appendCBOR: false },
    })
    expect(result.escrow.sourceSha256).toBe(ESCROW_SOURCE_SHA256)
    expect(result.escrow.runtimeKeccak).toBe(RUNTIME_KECCAK)
    expect(mockTokenArtifact.bytecode).toBe(result.mockToken.bytecode)
  }, 120_000)

  it('has no DELEGATECALL, CALLCODE, SELFDESTRUCT, CREATE or CREATE2, and fits the 24 KiB code limit', () => {
    const ops = opcodes(ESCROW_RUNTIME_BYTECODE)
    for (const [name, op] of [
      ['DELEGATECALL', 0xf4],
      ['CALLCODE', 0xf2],
      ['SELFDESTRUCT', 0xff],
      ['CREATE', 0xf0],
      ['CREATE2', 0xf5],
    ] as const) {
      expect(ops.has(op), name).toBe(false)
    }
    // The only outward calls: CALL to the token, STATICCALL to the token and to ecrecover.
    expect([0xf1, 0xf2, 0xf4, 0xfa].filter((op) => ops.has(op))).toEqual([0xf1, 0xfa])
    expect((ESCROW_RUNTIME_BYTECODE.length - 2) / 2).toBeLessThanOrEqual(24_576)
  })

  it('the committed artifacts are not git-ignored, so every commit and fresh clone has them', () => {
    // An unanchored `out/` rule, meant for Next's export folder, once matched
    // contracts/out/ too. Both JSON files were left out of every commit, and a
    // fresh clone failed to typecheck on the MockToken.json import.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const rules = readFileSync(resolve(root, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
    for (const bad of ['out', 'out/', 'out/*', '**/out', '**/out/', 'contracts', 'contracts/', 'contracts/out', 'contracts/out/']) {
      expect(rules, bad).not.toContain(bad)
    }
    expect(rules).toContain('/out/')
    // And git itself agrees, where git is there to ask. Exit 1: no path is ignored.
    const git = spawnSync('git', ['check-ignore', '--no-index', '-v', ESCROW_JSON_PATH, MOCK_TOKEN_JSON_PATH], { cwd: root, encoding: 'utf8' })
    if (git.error === undefined && git.status !== 128) {
      expect({ status: git.status, ignoredBy: git.stdout.trim() }).toEqual({ status: 1, ignoredBy: '' })
    }
  })

  it('exposes exactly the ABI of the committed artifact: spec section 5 as amended, not its first draft', () => {
    // Where the build departs from the first draft of section 5, on purpose:
    //   - Refunded's third field is `remaining`, not `toSeller`: a part refund
    //     pays the seller nothing early and leaves the deposit Opened.
    //   - The blind cap counts money paid out (SellerStats.paidOut), not sales,
    //     so NEW_SELLER_SALES is gone.
    //   - cardDeposit and Deposit.cardTag let a buyer resell a card only once
    //     their purchase is paid out, and a full refund hand it back.
    // Review condition 2 compares the deployed escrow with this list.
    const names = ESCROW_ABI.map((i) => ('name' in i ? i.name : i.type))
    expect(names).not.toContain('NEW_SELLER_SALES')
    expect(names).toContain('cardDeposit')
    const refunded = ESCROW_ABI.find((i) => i.type === 'event' && i.name === 'Refunded')
    expect(refunded && 'inputs' in refunded ? refunded.inputs.map((p) => p.name) : []).toEqual(['depositId', 'toDepositor', 'remaining'])

    type P = { type: string; name?: string; indexed?: boolean; components?: readonly P[] }
    const param = (p: P): string => {
      const base = p.type.startsWith('tuple') ? `(${(p.components ?? []).map(param).join(', ')})${p.type.slice(5)}` : p.type
      return [base, p.indexed ? 'indexed' : '', p.name ?? ''].filter((s) => s !== '').join(' ')
    }
    const line = (i: (typeof ESCROW_ABI)[number]): string => {
      if (i.type === 'function') {
        const outs = i.outputs.map(param).join(', ')
        return `function ${i.name}(${i.inputs.map(param).join(', ')}) ${i.stateMutability}${outs ? ` returns (${outs})` : ''}`
      }
      if (i.type === 'event') return `event ${i.name}(${i.inputs.map(param).join(', ')})${i.anonymous ? ' anonymous' : ''}`
      return `constructor(${i.inputs.map(param).join(', ')}) ${i.stateMutability}`
    }
    const TERMS = '(address seller, uint96 price, uint32 valueCents, uint16 residualCapCents, uint8 merchant, uint8 mode, uint40 listingExpiry, bytes32 salt)'
    expect(ESCROW_ABI.map(line).sort()).toEqual(
      [
        'constructor(address litSigner_, address token_) nonpayable',
        'event Claimed(address indexed to, uint256 amount)',
        'event Disputed(uint256 indexed depositId, bytes32 reasonHash, uint40 releaseAt)',
        'event Listed(bytes32 indexed listingId, address indexed seller, bytes32 commitment)',
        'event ListingCancelled(bytes32 indexed listingId)',
        'event Opened(uint256 indexed depositId, bytes32 indexed listingId, address indexed depositor, bytes32 cardTag, uint32 openBalanceCents, uint40 releaseAt)',
        'event Owed(address indexed to, uint256 amount)',
        'event Refunded(uint256 indexed depositId, uint256 toDepositor, uint256 remaining)',
        'event Rekeyed(uint256 indexed depositId, bytes32 replyKeyHash)',
        'event Released(uint256 indexed depositId, uint256 amount)',
        'function DEPOSIT_OPENED() view returns (uint8)',
        'function DEPOSIT_REFUNDED() view returns (uint8)',
        'function DEPOSIT_RELEASED() view returns (uint8)',
        'function DISPUTE_HOLD() view returns (uint256)',
        'function LISTING_ACTIVE() view returns (uint8)',
        'function LISTING_CANCELLED() view returns (uint8)',
        'function LISTING_SOLD() view returns (uint8)',
        'function LISTING_TYPEHASH() view returns (bytes32)',
        'function MAX_RESIDUAL_CAP_CENTS() view returns (uint256)',
        'function MAX_TICKET_TTL() view returns (uint256)',
        'function MAX_VALUE_CENTS() view returns (uint256)',
        'function MODE_BLIND() view returns (uint8)',
        'function MODE_READABLE() view returns (uint8)',
        'function NEW_SELLER_BLIND_CAP_CENTS() view returns (uint256)',
        'function OPEN_TYPEHASH() view returns (bytes32)',
        'function RELEASE_DELAY() view returns (uint256)',
        'function TERMS_TYPEHASH() view returns (bytes32)',
        'function UNITS_PER_CENT() view returns (uint256)',
        'function VERSION() view returns (string)',
        'function cancelListing(bytes32 listingId) nonpayable',
        'function cardDeposit(bytes32) view returns (uint256)',
        'function cardOwner(bytes32) view returns (address)',
        'function claim(address to) nonpayable',
        `function commitmentOf(${TERMS} t, bytes32 envelopeHash) view returns (bytes32)`,
        `function coreHashOf(${TERMS} t) view returns (bytes32)`,
        `function depositAndOpen(${TERMS} t, bytes32 envelopeHash, (bytes32 replyKeyHash, uint32 openBalanceCents, bytes32 cardTag, uint40 notAfter, bytes signature) k) nonpayable returns (uint256 id)`,
        'function depositCount() view returns (uint256)',
        'function dispute(uint256 id, bytes32 reasonHash) nonpayable',
        'function domainSeparator() view returns (bytes32)',
        'function gate(bytes32 listingId, uint256 depositId) view returns (address signer, address tokenAddress, address listingSeller, uint8 listingState, uint8 depositState, bytes32 depositListingId, bytes32 replyKeyHash, address depositor)',
        'function getDeposit(uint256 id) view returns ((address depositor, uint40 openedAt, uint40 releaseAt, uint8 state, bool disputed, address seller, uint96 amount, bytes32 listingId, bytes32 replyKeyHash, bytes32 cardTag))',
        'function getListing(bytes32 listingId) view returns ((address seller, uint8 state, uint40 createdAt))',
        'function list(bytes32 commitment) nonpayable returns (bytes32 listingId)',
        'function listingIdOf(address seller, bytes32 commitment) pure returns (bytes32)',
        'function litSigner() view returns (address)',
        'function openDigest(bytes32 listingId, address depositor, bytes32 replyKeyHash, uint32 openBalanceCents, bytes32 cardTag, uint40 notAfter) view returns (bytes32)',
        'function owed(address) view returns (uint256)',
        'function rekey(uint256 id, bytes32 replyKeyHash) nonpayable',
        'function release(uint256 id) nonpayable',
        'function sellerRefund(uint256 id, uint96 refundAmount) nonpayable',
        'function sellerStats(address) view returns (uint32 sold, uint32 disputes, uint32 refunds, uint96 paidOut)',
        'function token() view returns (address)',
      ].sort(),
    )
  })

  it('MockToken compiles to the ABI the fixtures encode against', () => {
    const sig = (i: { type: string; name?: string; inputs?: readonly { type: string }[] }): string =>
      `${i.type} ${i.name ?? ''}(${(i.inputs ?? []).map((p) => p.type).join(',')})`
    const compiled = (mockTokenArtifact.abi as { type: string; name?: string; inputs?: { type: string }[] }[]).map(sig).sort()
    expect(MOCK_TOKEN_ABI.map(sig).sort()).toEqual(compiled)
  })
})

// --------------------------------------------------------------------------------------------
describe('TestChain as an RPC', () => {
  it('serves chain id, head block and code, and surfaces a revert reason through viem', async () => {
    const env = await setup()
    expect(await env.chain.request({ method: 'eth_chainId' })).toBe('0xa5bf')
    expect(await env.chain.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] })).toEqual({
      number: `0x${env.chain.blockNumber.toString(16)}`,
      hash: env.chain.blockHash(),
      timestamp: `0x${T0.toString(16)}`,
    })
    expect(keccak256((await env.chain.request({ method: 'eth_getCode', params: [env.escrow, 'latest'] })) as Hex)).toBe(RUNTIME_KECCAK)
    const l = await listed(env)
    const k = await ticketFor(env, l, {}, { signer: ROGUE })
    await expect(
      env.reader.simulateContract({
        address: env.escrow,
        abi: ESCROW_ABI,
        functionName: 'depositAndOpen',
        args: [l.t, l.envelopeHash, k],
        account: BUYER,
      }),
    ).rejects.toThrow(/not lit/)
    // eth_call kept nothing: the same listing still opens.
    expectOk(await open(env, l, await ticketFor(env, l)))
  })
})

// --------------------------------------------------------------------------------------------
describe('constructor and constants', () => {
  it('refuses a zero signer, a token with no code, and a token whose decimals are not 6', async () => {
    const chain = await TestChain.create({ timestamp: T0 })
    const token6 = await deployMockToken(chain, DEPLOYER, 6)
    const token18 = await deployMockToken(chain, DEPLOYER, 18)
    expect((await deployEscrowResult(chain, DEPLOYER, zeroAddress, token6)).revert).toBe('signer')
    expect((await deployEscrowResult(chain, DEPLOYER, LIT.address, testAddress(99))).revert).toBe('token')
    expect((await deployEscrowResult(chain, DEPLOYER, LIT.address, token18)).revert).toBe('decimals')
    // A contract with no decimals() at all: the staticcall fails.
    const escrow = await deployEscrow(chain, DEPLOYER, LIT.address, token6)
    expect((await deployEscrowResult(chain, DEPLOYER, LIT.address, escrow)).revert).toBe('decimals')
  })

  it('has the same runtime code hash whatever the constructor arguments, equal to RUNTIME_KECCAK', async () => {
    const chain = await TestChain.create({ timestamp: T0 })
    const tokenA = await deployMockToken(chain, DEPLOYER)
    const tokenB = await deployMockToken(chain, DEPLOYER)
    const a = await deployEscrow(chain, DEPLOYER, LIT.address, tokenA)
    const b = await deployEscrow(chain, DEPLOYER, ROGUE.address, tokenB)
    expect(await chain.codeHash(a)).toBe(RUNTIME_KECCAK)
    expect(await chain.codeHash(b)).toBe(RUNTIME_KECCAK)
    expect(keccak256(ESCROW_RUNTIME_BYTECODE)).toBe(RUNTIME_KECCAK)
    const reader = readerFor(chain)
    expect(lower(await reader.readContract({ address: b, abi: ESCROW_ABI, functionName: 'litSigner' }))).toBe(lower(ROGUE.address))
    expect(lower(await reader.readContract({ address: b, abi: ESCROW_ABI, functionName: 'token' }))).toBe(tokenB)
  })

  it('hashes terms, listings and tickets the way viem and the EIP-712 standard do', async () => {
    const env = await setup()
    const r = env.reader
    const ask = { address: env.escrow, abi: ESCROW_ABI } as const
    expect(await r.readContract({ ...ask, functionName: 'VERSION' })).toBe('salvo-escrow/1')
    expect(await r.readContract({ ...ask, functionName: 'TERMS_TYPEHASH' })).toBe(keccak256(toHex(TERMS_TYPE)))
    expect(await r.readContract({ ...ask, functionName: 'LISTING_TYPEHASH' })).toBe(keccak256(toHex(LISTING_TYPE)))
    expect(await r.readContract({ ...ask, functionName: 'OPEN_TYPEHASH' })).toBe(keccak256(toHex(OPEN_TYPE)))
    expect(await r.readContract({ ...ask, functionName: 'RELEASE_DELAY' })).toBe(RELEASE_DELAY)
    expect(await r.readContract({ ...ask, functionName: 'DISPUTE_HOLD' })).toBe(DISPUTE_HOLD)
    expect(await r.readContract({ ...ask, functionName: 'MAX_TICKET_TTL' })).toBe(MAX_TICKET_TTL)
    expect(await r.readContract({ ...ask, functionName: 'UNITS_PER_CENT' })).toBe(UNITS_PER_CENT)
    const t = terms(env, { mode: MODE_READABLE, residualCapCents: 250, merchant: 1, valueCents: 4321 })
    const eh = fresh32('envelope')
    expect(await r.readContract({ ...ask, functionName: 'coreHashOf', args: [t] })).toBe(coreHash(env.chain.chainId, env.escrow, env.token, t))
    const c = commitmentOf(env.chain.chainId, env.escrow, env.token, t, eh)
    expect(await r.readContract({ ...ask, functionName: 'commitmentOf', args: [t, eh] })).toBe(c)
    expect(await r.readContract({ ...ask, functionName: 'listingIdOf', args: [SELLER, c] })).toBe(listingIdOf(SELLER, c))
    const f: OpenFields = {
      listingId: fresh32('l'),
      depositor: BUYER,
      replyKeyHash: fresh32('r'),
      openBalanceCents: 4321,
      cardTag: fresh32('t'),
      notAfter: now(env) + 300,
    }
    expect(
      await r.readContract({
        ...ask,
        functionName: 'openDigest',
        args: [f.listingId, f.depositor, f.replyKeyHash, f.openBalanceCents, f.cardTag, f.notAfter],
      }),
    ).toBe(openDigest(env.chain.chainId, env.escrow, f))
  })
})

// --------------------------------------------------------------------------------------------
describe('list and cancelListing', () => {
  it('keys the listing id to msg.sender, so a copied commitment is a different listing', async () => {
    const env = await setup()
    const t = terms(env)
    const eh = fresh32('envelope')
    const c = commitmentOf(env.chain.chainId, env.escrow, env.token, t, eh)
    const r = await mustSend(env.chain, SELLER, env.escrow, escrowCall.list(c))
    const ev = escrowEvents(env, r)
    expect(ev).toHaveLength(1)
    expect(ev[0]?.eventName).toBe('Listed')
    const mine = listingIdOf(SELLER, c)
    expect(ev[0]?.args).toMatchObject({ listingId: mine, commitment: c })
    // A front-runner copying the commitment gets its own id, and it cannot be bought with the seller's terms.
    await mustSend(env.chain, STRANGER, env.escrow, escrowCall.list(c))
    const theirs = listingIdOf(STRANGER, c)
    expect(theirs).not.toBe(mine)
    const listing = await env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'getListing', args: [theirs] })
    expect(lower(listing.seller)).toBe(STRANGER)
    expect(listing.state).toBe(LISTING_ACTIVE)
    expect(listing.createdAt).toBe(now(env))
    // Their copy is useless: terms name SELLER, so the only listing they hash to is SELLER's.
    const l: Listed = { t, envelopeHash: eh, listingId: mine }
    expectOk(await tryOpen(env, l, await ticketFor(env, l)))
    await mustSend(env.chain, SELLER, env.escrow, escrowCall.cancelListing(mine))
    expectRevert(await tryOpen(env, l, await ticketFor(env, l)), 'listing not active')
  })

  it('refuses a zero commitment and a commitment the seller already used, even after a cancel', async () => {
    const env = await setup()
    expectRevert(await env.chain.send(SELLER, env.escrow, escrowCall.list(`0x${'00'.repeat(32)}`)), 'commitment')
    const c = fresh32('commitment')
    await mustSend(env.chain, SELLER, env.escrow, escrowCall.list(c))
    expectRevert(await env.chain.send(SELLER, env.escrow, escrowCall.list(c)), 'exists')
    await mustSend(env.chain, SELLER, env.escrow, escrowCall.cancelListing(listingIdOf(SELLER, c)))
    expectRevert(await env.chain.send(SELLER, env.escrow, escrowCall.list(c)), 'exists')
  })

  it('cancelListing: seller only, Active only', async () => {
    const env = await setup()
    const l = await listed(env)
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.cancelListing(l.listingId)), 'not seller')
    expectRevert(await env.chain.send(SELLER, env.escrow, escrowCall.cancelListing(fresh32('nope'))), 'not seller')
    const r = await mustSend(env.chain, SELLER, env.escrow, escrowCall.cancelListing(l.listingId))
    expect(escrowEvents(env, r).map((e) => e.eventName)).toEqual(['ListingCancelled'])
    const listing = await env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'getListing', args: [l.listingId] })
    expect(listing.state).toBe(LISTING_CANCELLED)
    expectRevert(await env.chain.send(SELLER, env.escrow, escrowCall.cancelListing(l.listingId)), 'not active')
    // Once sold, never cancellable.
    const s = await sold(env)
    expectRevert(await env.chain.send(SELLER, env.escrow, escrowCall.cancelListing(s.l.listingId)), 'not active')
  })
})

// --------------------------------------------------------------------------------------------
describe('depositAndOpen: terms', () => {
  it('refuses an unknown mode', async () => {
    const env = await setup()
    for (const mode of [0, 3, 255]) {
      const l = await listed(env, { mode })
      expectRevert(await tryOpen(env, l, await ticketFor(env, l)), 'mode')
    }
  })

  it('bounds the value: 1 to 50,000 cents', async () => {
    const env = await setup()
    for (const valueCents of [0, 50_001]) {
      const l = await listed(env, { valueCents, mode: MODE_READABLE, price: 1n })
      expectRevert(await tryOpen(env, l, await ticketFor(env, l)), 'value')
    }
    const top = await listed(env, { valueCents: 50_000, mode: MODE_READABLE, price: 1n })
    expectOk(await tryOpen(env, top, await ticketFor(env, top)))
    const bottom = await listed(env, { valueCents: 1, price: 1n })
    expectOk(await tryOpen(env, bottom, await ticketFor(env, bottom)))
  })

  it('bounds the price: above 0 and at most value x 10,000 units', async () => {
    const env = await setup()
    const zero = await listed(env, { price: 0n })
    expectRevert(await tryOpen(env, zero, await ticketFor(env, zero)), 'price')
    const over = await listed(env, { valueCents: 500, price: 500n * UNITS_PER_CENT + 1n })
    expectRevert(await tryOpen(env, over, await ticketFor(env, over)), 'price')
    const edge = await listed(env, { valueCents: 500, price: 500n * UNITS_PER_CENT })
    expectOk(await tryOpen(env, edge, await ticketFor(env, edge)))
  })

  it('bounds the residual cap at 1,000 cents', async () => {
    const env = await setup()
    const over = await listed(env, { mode: MODE_READABLE, residualCapCents: 1_001 })
    expectRevert(await tryOpen(env, over, await ticketFor(env, over)), 'cap')
    const edge = await listed(env, { mode: MODE_READABLE, residualCapCents: 1_000 })
    expectOk(await tryOpen(env, edge, await ticketFor(env, edge, { openBalanceCents: 1_500 })))
  })

  it('refuses at and after the listing expiry, accepts the second before', async () => {
    const env = await setup()
    const l = await listed(env, { listingExpiry: now(env) + 10 })
    env.chain.setTime(BigInt(l.t.listingExpiry - 1))
    expectOk(await tryOpen(env, l, await ticketFor(env, l)))
    env.chain.setTime(BigInt(l.t.listingExpiry))
    expectRevert(await tryOpen(env, l, await ticketFor(env, l)), 'listing expired')
  })

  it('refuses the seller buying their own listing', async () => {
    const env = await setup()
    const l = await listed(env)
    expectRevert(await tryOpen(env, l, await ticketFor(env, l, { depositor: SELLER }), SELLER), 'own listing')
  })

  it('caps a blind card above $25 until its seller has been paid at least its value; readable cards are not capped', async () => {
    const env = await setup()
    const big = { valueCents: 2_501, price: 2_501n * UNITS_PER_CENT }
    const capped = await listed(env, big)
    expectRevert(await tryOpen(env, capped, await ticketFor(env, capped)), 'new seller cap')
    const atCap = await listed(env, { valueCents: 2_500 })
    expectOk(await tryOpen(env, atCap, await ticketFor(env, atCap)))
    const readable = await listed(env, { ...big, mode: MODE_READABLE })
    expectOk(await tryOpen(env, readable, await ticketFor(env, readable)))

    // A record farmed with 1-unit sales to a second address lifts nothing:
    // three finished sales, but 3 units paid.
    const farmed = [
      await sold(env, { valueCents: 1, price: 1n }, BUYER2),
      await sold(env, { valueCents: 1, price: 1n }, BUYER2),
      await sold(env, { valueCents: 1, price: 1n }, BUYER2),
    ]
    for (const f of farmed) await releaseWhenDue(env, f.id)
    expect(await stats(env, SELLER)).toEqual({ sold: 3, disputes: 0, refunds: 0, paidOut: 3n })
    const stillCapped = await listed(env, big)
    expectRevert(await tryOpen(env, stillCapped, await ticketFor(env, stillCapped)), 'new seller cap')

    // Opened is not paid, and a refund is not a sale.
    const open1 = await sold(env, { valueCents: 30_000, price: 25_009_996n, mode: MODE_READABLE })
    const refunded = await sold(env, { valueCents: 2_500, price: 25_000_000n })
    await mustSend(env.chain, SELLER, env.escrow, escrowCall.sellerRefund(refunded.id, 25_000_000n))
    const capped2 = await listed(env, big)
    expectRevert(await tryOpen(env, capped2, await ticketFor(env, capped2)), 'new seller cap')

    // Paid out: 3 + 25,009,996 units, 1 short of $25.01. Then exactly $25.01.
    await releaseWhenDue(env, open1.id)
    expect((await stats(env, SELLER)).paidOut).toBe(25_009_999n)
    const short = await listed(env, big)
    expectRevert(await tryOpen(env, short, await ticketFor(env, short)), 'new seller cap')
    const cent = await sold(env, { valueCents: 1, price: 1n }, BUYER2)
    await releaseWhenDue(env, cent.id)
    expect((await stats(env, SELLER)).paidOut).toBe(2_501n * UNITS_PER_CENT)
    const uncapped = await listed(env, big)
    expectOk(await tryOpen(env, uncapped, await ticketFor(env, uncapped)))
    const over = await listed(env, { valueCents: 2_502, price: 1n })
    expectRevert(await tryOpen(env, over, await ticketFor(env, over)), 'new seller cap')
    // The cap is per seller: another seller is still new.
    const other = await listed(env, { ...big, seller: SELLER2 })
    expectRevert(await tryOpen(env, other, await ticketFor(env, other)), 'new seller cap')
  })

  it('refuses terms that hash to no Active listing: never listed, other envelope, cancelled, or sold', async () => {
    const env = await setup()
    const t = terms(env)
    const ghost: Listed = { t, envelopeHash: fresh32('e'), listingId: fresh32('id') }
    expectRevert(await tryOpen(env, ghost, await ticketFor(env, ghost)), 'listing not active')

    const l = await listed(env)
    const swapped: Listed = { ...l, envelopeHash: fresh32('other envelope') }
    expectRevert(await tryOpen(env, swapped, await ticketFor(env, l)), 'listing not active')
    const repriced: Listed = { ...l, t: { ...l.t, price: l.t.price - 1n } }
    expectRevert(await tryOpen(env, repriced, await ticketFor(env, l)), 'listing not active')

    await mustSend(env.chain, SELLER, env.escrow, escrowCall.cancelListing(l.listingId))
    expectRevert(await tryOpen(env, l, await ticketFor(env, l)), 'listing not active')

    const s = await sold(env)
    expectRevert(await tryOpen(env, s.l, await ticketFor(env, s.l, { depositor: BUYER2 }), BUYER2), 'listing not active')
  })
})

// --------------------------------------------------------------------------------------------
describe('depositAndOpen: the ticket', () => {
  it('refuses a zero reply key hash and a zero card tag', async () => {
    const env = await setup()
    const l = await listed(env)
    expectRevert(await tryOpen(env, l, await ticketFor(env, l, { replyKeyHash: `0x${'00'.repeat(32)}` })), 'reply key')
    expectRevert(await tryOpen(env, l, await ticketFor(env, l, { cardTag: `0x${'00'.repeat(32)}` })), 'card tag')
  })

  it('lets only the current owner of a card sell it: no double sale, and the buyer resells once paid out', async () => {
    const env = await setup()
    const tag = fresh32('card')
    const first = await sold(env, {}, BUYER, tag)
    expect(await cardOf(env, tag)).toEqual({ owner: BUYER, deposit: first.id })
    // The seller lists the same card again: refused, whoever buys.
    const again = await listed(env)
    expectRevert(await tryOpen(env, again, await ticketFor(env, again, { cardTag: tag })), "card not seller's")
    // Two live listings of one card: the second buyer is refused once the first sale lands.
    const dupA = await listed(env)
    const dupB = await listed(env)
    const tag2 = fresh32('card')
    expectOk(await open(env, dupA, await ticketFor(env, dupA, { cardTag: tag2 })))
    expectRevert(await tryOpen(env, dupB, await ticketFor(env, dupB, { cardTag: tag2, depositor: BUYER2 }), BUYER2), "card not seller's")
    // The buyer may not resell while their own purchase can still be refunded:
    // a refund hands the card back to its seller.
    const early = await listed(env, { seller: BUYER })
    expectRevert(await tryOpen(env, early, await ticketFor(env, early, { cardTag: tag, depositor: BUYER2 }), BUYER2), 'card not paid out')
    // Once it is paid out, the card is theirs to sell.
    await releaseWhenDue(env, first.id)
    const resale = await listed(env, { seller: BUYER })
    const r = await open(env, resale, await ticketFor(env, resale, { cardTag: tag, depositor: BUYER2 }), BUYER2)
    expectOk(r)
    const resaleId = await env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'depositCount' })
    expect(await cardOf(env, tag)).toEqual({ owner: BUYER2, deposit: resaleId })
    expect((await deposit(env, resaleId)).cardTag).toBe(tag)
    expect(first.id).toBe(1n)
  })

  it('a full refund gives the card back to its seller; the refunded buyer cannot sell it', async () => {
    const env = await setup()
    const tag = fresh32('card')
    const s = await sold(env, { price: 3_000_000n }, BUYER, tag)
    // A part refund leaves the sale, and the card, with the buyer.
    await mustSend(env.chain, SELLER, env.escrow, escrowCall.sellerRefund(s.id, 1_000_000n))
    expect(await cardOf(env, tag)).toEqual({ owner: BUYER, deposit: s.id })
    // Refunding the rest undoes the sale.
    await mustSend(env.chain, SELLER, env.escrow, escrowCall.sellerRefund(s.id, 2_000_000n))
    expect(await cardOf(env, tag)).toEqual({ owner: SELLER, deposit: 0n })
    // The refunded buyer cannot sell it, now or later.
    const theirs = await listed(env, { seller: BUYER })
    expectRevert(await tryOpen(env, theirs, await ticketFor(env, theirs, { cardTag: tag, depositor: BUYER2 }), BUYER2), "card not seller's")
    // The seller can sell it again, and the new buyer owns it.
    const again = await listed(env)
    expectOk(await open(env, again, await ticketFor(env, again, { cardTag: tag, depositor: BUYER2 }), BUYER2))
    const id = await env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'depositCount' })
    expect(await cardOf(env, tag)).toEqual({ owner: BUYER2, deposit: id })
  })

  it('accepts a ticket up to and including notAfter, and refuses one second later', async () => {
    const env = await setup()
    const l = await listed(env)
    const k = await ticketFor(env, l, { notAfter: now(env) + 5 })
    env.chain.setTime(BigInt(k.notAfter))
    expectOk(await tryOpen(env, l, k))
    env.chain.setTime(BigInt(k.notAfter + 1))
    expectRevert(await tryOpen(env, l, k), 'ticket time')
  })

  it('refuses a ticket that lives longer than 15 minutes from now', async () => {
    const env = await setup()
    const l = await listed(env)
    expectOk(await tryOpen(env, l, await ticketFor(env, l, { notAfter: now(env) + Number(MAX_TICKET_TTL) })))
    expectRevert(await tryOpen(env, l, await ticketFor(env, l, { notAfter: now(env) + Number(MAX_TICKET_TTL) + 1 })), 'ticket time')
  })

  it('readable: the balance must be at least the value and at most value + cap, at the exact edges', async () => {
    const env = await setup()
    const l = await listed(env, { mode: MODE_READABLE, valueCents: 4_000, residualCapCents: 500, price: 30_000_000n })
    const at = async (openBalanceCents: number) => tryOpen(env, l, await ticketFor(env, l, { openBalanceCents }))
    expectRevert(await at(3_999), 'balance')
    expectOk(await at(4_000))
    expectOk(await at(4_500))
    expectRevert(await at(4_501), 'balance')
    expectRevert(await at(0), 'balance')
  })

  it('blind: the ticket must carry a zero balance', async () => {
    const env = await setup()
    const l = await listed(env)
    expectRevert(await tryOpen(env, l, await ticketFor(env, l, { openBalanceCents: 500 })), 'blind balance')
    expectRevert(await tryOpen(env, l, await ticketFor(env, l, { openBalanceCents: 1 })), 'blind balance')
  })

  it('refuses a ticket from any key but litSigner', async () => {
    const env = await setup()
    const l = await listed(env)
    expectRevert(await tryOpen(env, l, await ticketFor(env, l, {}, { signer: ROGUE })), 'not lit')
  })

  it('refuses the high-s twin of a valid signature, although ecrecover accepts it', async () => {
    const env = await setup()
    const l = await listed(env)
    const k = await ticketFor(env, l)
    const twin = highS(k.signature)
    // Prove the twin is a working signature, so only the low-s rule stops it.
    const digest = openDigest(env.chain.chainId, env.escrow, {
      listingId: l.listingId,
      depositor: BUYER,
      replyKeyHash: k.replyKeyHash,
      openBalanceCents: k.openBalanceCents,
      cardTag: k.cardTag,
      notAfter: k.notAfter,
    })
    const input = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [digest, parseInt(twin.slice(130, 132), 16), `0x${twin.slice(2, 66)}`, `0x${twin.slice(66, 130)}`],
    )
    const rec = await env.chain.call(BUYER, ECRECOVER, input)
    expect(lower(`0x${rec.returnData.slice(26)}`)).toBe(lower(LIT.address))
    expectRevert(await tryOpen(env, l, { ...k, signature: twin }), 'sig s')
    expectOk(await tryOpen(env, l, k))
  })

  it('refuses v of 0 or 1, a short or long signature, and one that recovers to no address', async () => {
    const env = await setup()
    const l = await listed(env)
    const k = await ticketFor(env, l)
    expect([27, 28]).toContain(parseInt(k.signature.slice(130, 132), 16))
    expectRevert(await tryOpen(env, l, { ...k, signature: withV(k.signature, 0) }), 'sig v')
    expectRevert(await tryOpen(env, l, { ...k, signature: withV(k.signature, 1) }), 'sig v')
    expectRevert(await tryOpen(env, l, { ...k, signature: `0x${k.signature.slice(2, 130)}` }), 'sig length')
    expectRevert(await tryOpen(env, l, { ...k, signature: `${k.signature}00` }), 'sig length')
    expectRevert(await tryOpen(env, l, { ...k, signature: '0x' }), 'sig length')
    // r = 0 is not a point: ecrecover returns the zero address.
    expectRevert(await tryOpen(env, l, { ...k, signature: `0x${'00'.repeat(32)}${k.signature.slice(66)}` }), 'sig')
  })

  it('refuses a ticket naming another depositor, another listing, or other fields than it signed', async () => {
    const env = await setup()
    const l = await listed(env)
    const forOther = await ticketFor(env, l, { depositor: BUYER2 })
    expectRevert(await tryOpen(env, l, forOther, BUYER), 'not lit')
    expectOk(await tryOpen(env, l, forOther, BUYER2))
    // A ticket for one listing does not open another with the same terms shape.
    const other = await listed(env)
    expectRevert(await tryOpen(env, other, await ticketFor(env, l)), 'not lit')
    // Each signed field is bound: change one and the signature no longer matches.
    const k = await ticketFor(env, l)
    expectRevert(await tryOpen(env, l, { ...k, replyKeyHash: fresh32('swap') }), 'not lit')
    expectRevert(await tryOpen(env, l, { ...k, cardTag: fresh32('swap') }), 'not lit')
    expectRevert(await tryOpen(env, l, { ...k, notAfter: k.notAfter - 1 }), 'not lit')
    const rl = await listed(env, { mode: MODE_READABLE, residualCapCents: 100 })
    const rk = await ticketFor(env, rl, { openBalanceCents: rl.t.valueCents + 50 })
    expectRevert(await tryOpen(env, rl, { ...rk, openBalanceCents: rl.t.valueCents }), 'not lit')
    expectOk(await tryOpen(env, rl, rk))
  })

  it('refuses a ticket signed for another escrow instance on the same chain', async () => {
    const env = await setup()
    const second = await deployEscrow(env.chain, DEPLOYER, LIT.address, env.token)
    await mustSend(env.chain, BUYER, env.token, tokenCall.approve(second, maxUint256))
    const envB: Env = { ...env, escrow: second }
    const l = await listed(envB)
    expectRevert(await tryOpen(envB, l, await ticketFor(envB, l, {}, { escrow: env.escrow })), 'not lit')
    expectOk(await tryOpen(envB, l, await ticketFor(envB, l)))
  })

  it('refuses a ticket signed for another chain id, even at the same escrow address', async () => {
    const home = await setup()
    const away = await setup({ chainId: 4_217n })
    expect(away.escrow).toBe(home.escrow)
    const l = await listed(away)
    expectRevert(await tryOpen(away, l, await ticketFor(away, l, {}, { chainId: home.chain.chainId })), 'not lit')
    expectOk(await tryOpen(away, l, await ticketFor(away, l)))
    const ds = await away.reader.readContract({ address: away.escrow, abi: ESCROW_ABI, functionName: 'domainSeparator' })
    const dsHome = await home.reader.readContract({ address: home.escrow, abi: ESCROW_ABI, functionName: 'domainSeparator' })
    expect(ds).not.toBe(dsHome)
  })
})

// --------------------------------------------------------------------------------------------
describe('depositAndOpen: the money', () => {
  it('pulls exactly the price, records the deposit, sells the listing and hands the card to the buyer', async () => {
    const env = await setup()
    const l = await listed(env, { price: 4_400_000n })
    const k = await ticketFor(env, l)
    const before = { buyer: await balanceOf(env, BUYER), escrow: await balanceOf(env, env.escrow) }
    const r = await open(env, l, k)
    expectOk(r)
    expect(transfers(env, r)).toEqual([{ from: BUYER, to: env.escrow, value: 4_400_000n }])
    expect(await balanceOf(env, BUYER)).toBe(before.buyer - 4_400_000n)
    expect(await balanceOf(env, env.escrow)).toBe(before.escrow + 4_400_000n)
    const d = await deposit(env, 1n)
    expect({ ...d, depositor: lower(d.depositor), seller: lower(d.seller) }).toEqual({
      depositor: BUYER,
      openedAt: now(env),
      releaseAt: now(env) + Number(RELEASE_DELAY),
      state: DEPOSIT_OPENED,
      disputed: false,
      seller: SELLER,
      amount: 4_400_000n,
      listingId: l.listingId,
      replyKeyHash: k.replyKeyHash,
      cardTag: k.cardTag,
    })
    const [opened] = escrowEvents(env, r)
    expect(opened?.eventName).toBe('Opened')
    expect(opened?.args).toEqual({
      depositId: 1n,
      listingId: l.listingId,
      depositor: expect.stringMatching(new RegExp(BUYER.slice(2), 'i')),
      cardTag: k.cardTag,
      openBalanceCents: 0,
      releaseAt: now(env) + Number(RELEASE_DELAY),
    })
    const gate = await env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'gate', args: [l.listingId, 1n] })
    expect([lower(gate[0]), lower(gate[1]), lower(gate[2]), gate[3], gate[4], gate[5], gate[6], lower(gate[7])]).toEqual([
      lower(LIT.address),
      env.token,
      SELLER,
      LISTING_SOLD,
      DEPOSIT_OPENED,
      l.listingId,
      k.replyKeyHash,
      BUYER,
    ])
    expect(lower(await env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'cardOwner', args: [k.cardTag] }))).toBe(BUYER)
  })

  it('refuses a fee-on-transfer token: the escrow must receive exactly the price', async () => {
    const env = await setup()
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setFeeBps(100n))
    const l = await listed(env)
    const before = await balanceOf(env, BUYER)
    expectRevert(await open(env, l, await ticketFor(env, l)), 'pull amount')
    expect(await balanceOf(env, BUYER)).toBe(before)
  })

  it('refuses when the pull fails: no allowance, no balance, or the token returns false', async () => {
    const env = await setup()
    const l = await listed(env)
    await mustSend(env.chain, BUYER, env.token, tokenCall.approve(env.escrow, l.t.price - 1n))
    expectRevert(await open(env, l, await ticketFor(env, l)), 'pull')
    await mustSend(env.chain, BUYER, env.token, tokenCall.approve(env.escrow, maxUint256))
    const broke = testAddress(77)
    await mustSend(env.chain, broke, env.token, tokenCall.approve(env.escrow, maxUint256))
    expectRevert(await open(env, l, await ticketFor(env, l, { depositor: broke }), broke), 'pull')
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(env.escrow, 2))
    expectRevert(await open(env, l, await ticketFor(env, l)), 'pull')
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(env.escrow, 0))
    expectOk(await open(env, l, await ticketFor(env, l)))
  })

  it('works with a token that returns no value, in and out', async () => {
    const env = await setup()
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setNoReturn(true))
    const s = await sold(env, { price: 1_000_000n })
    expect(await balanceOf(env, env.escrow)).toBe(1_000_000n)
    env.chain.advance(RELEASE_DELAY)
    const before = await balanceOf(env, SELLER)
    expectOk(await env.chain.send(STRANGER, env.escrow, escrowCall.release(s.id)))
    expect(await balanceOf(env, SELLER)).toBe(before + 1_000_000n)
    expect(await owed(env, SELLER)).toBe(0n)
  })

  it('opens two cards in one atomic batch (approve + two opens), or neither', async () => {
    const env = await setup()
    await mustSend(env.chain, BUYER, env.token, tokenCall.approve(env.escrow, 0n))
    const a = await listed(env, { price: 3_000_000n })
    const b = await listed(env, { price: 2_500_000n, seller: SELLER2 })
    const before = await balanceOf(env, BUYER)
    const ok = await env.chain.batch(BUYER, [
      { to: env.token, data: tokenCall.approve(env.escrow, 5_500_000n) },
      { to: env.escrow, data: escrowCall.depositAndOpen(a.t, a.envelopeHash, await ticketFor(env, a)) },
      { to: env.escrow, data: escrowCall.depositAndOpen(b.t, b.envelopeHash, await ticketFor(env, b)) },
    ])
    expect(ok.ok).toBe(true)
    expect(await balanceOf(env, BUYER)).toBe(before - 5_500_000n)
    expect(await env.reader.readContract({ address: env.token, abi: MOCK_TOKEN_ABI, functionName: 'allowance', args: [BUYER, env.escrow] })).toBe(0n)
    expect(lower((await deposit(env, 1n)).seller)).toBe(SELLER)
    expect(lower((await deposit(env, 2n)).seller)).toBe(SELLER2)

    // The second leg sold a moment earlier: the whole batch reverts and nothing is charged.
    const c = await listed(env, { price: 1_000_000n })
    const d = await listed(env, { price: 1_000_000n, seller: SELLER2 })
    await mustSend(env.chain, BUYER2, env.escrow, escrowCall.depositAndOpen(d.t, d.envelopeHash, await ticketFor(env, d, { depositor: BUYER2 })))
    const kc = await ticketFor(env, c)
    const failed = await env.chain.batch(BUYER, [
      { to: env.token, data: tokenCall.approve(env.escrow, 2_000_000n) },
      { to: env.escrow, data: escrowCall.depositAndOpen(c.t, c.envelopeHash, kc) },
      { to: env.escrow, data: escrowCall.depositAndOpen(d.t, d.envelopeHash, await ticketFor(env, d)) },
    ])
    expect(failed).toMatchObject({ ok: false, failedAt: 2 })
    expect(failed.results[2]?.revert).toBe('listing not active')
    expect(await balanceOf(env, BUYER)).toBe(before - 5_500_000n)
    expect(await env.reader.readContract({ address: env.token, abi: MOCK_TOKEN_ABI, functionName: 'allowance', args: [BUYER, env.escrow] })).toBe(0n)
    expect(await env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'depositCount' })).toBe(3n)
    const gate = await env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'gate', args: [c.listingId, 0n] })
    expect(gate[3]).toBe(LISTING_ACTIVE)
    expect(await env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'cardOwner', args: [kc.cardTag] })).toBe(zeroAddress)

    // The same listing twice in one batch: the second open refuses, so neither lands.
    const e = await listed(env, { price: 1_000_000n })
    const twice = await env.chain.batch(BUYER, [
      { to: env.token, data: tokenCall.approve(env.escrow, 2_000_000n) },
      { to: env.escrow, data: escrowCall.depositAndOpen(e.t, e.envelopeHash, await ticketFor(env, e)) },
      { to: env.escrow, data: escrowCall.depositAndOpen(e.t, e.envelopeHash, await ticketFor(env, e)) },
    ])
    expect(twice).toMatchObject({ ok: false, failedAt: 2 })
    expect(await balanceOf(env, BUYER)).toBe(before - 5_500_000n)
  })
})

// --------------------------------------------------------------------------------------------
describe('dispute and rekey', () => {
  it('dispute: depositor only, once, before payout; holds the payout 48 h more and counts against the seller', async () => {
    const env = await setup()
    const s = await sold(env)
    const releaseAt = (await deposit(env, s.id)).releaseAt
    const reason = fresh32('reason')
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.dispute(s.id, reason)), 'not depositor')
    expectRevert(await env.chain.send(SELLER, env.escrow, escrowCall.dispute(s.id, reason)), 'not depositor')
    env.chain.setTime(BigInt(releaseAt - 1))
    const r = await mustSend(env.chain, BUYER, env.escrow, escrowCall.dispute(s.id, reason))
    expect(escrowEvents(env, r)).toEqual([
      { eventName: 'Disputed', args: { depositId: s.id, reasonHash: reason, releaseAt: releaseAt + Number(DISPUTE_HOLD) } },
    ])
    const d = await deposit(env, s.id)
    expect({ disputed: d.disputed, releaseAt: d.releaseAt, state: d.state }).toEqual({
      disputed: true,
      releaseAt: releaseAt + Number(DISPUTE_HOLD),
      state: DEPOSIT_OPENED,
    })
    expect(await stats(env, SELLER)).toEqual({ sold: 0, disputes: 1, refunds: 0, paidOut: 0n })
    expectRevert(await env.chain.send(BUYER, env.escrow, escrowCall.dispute(s.id, reason)), 'no dispute')
    expect(transfers(env, r)).toEqual([])

    // At releaseAt it is too late.
    const late = await sold(env)
    env.chain.setTime(BigInt((await deposit(env, late.id)).releaseAt))
    expectRevert(await env.chain.send(BUYER, env.escrow, escrowCall.dispute(late.id, reason)), 'too late')
    // After payout or refund, nothing to dispute.
    await mustSend(env.chain, STRANGER, env.escrow, escrowCall.release(late.id))
    expectRevert(await env.chain.send(BUYER, env.escrow, escrowCall.dispute(late.id, reason)), 'no dispute')
    const refunded = await sold(env)
    await mustSend(env.chain, SELLER, env.escrow, escrowCall.sellerRefund(refunded.id, refunded.l.t.price))
    expectRevert(await env.chain.send(BUYER, env.escrow, escrowCall.dispute(refunded.id, reason)), 'no dispute')
    expectRevert(await env.chain.send(BUYER, env.escrow, escrowCall.dispute(999n, reason)), 'not depositor')
  })

  it('rekey: depositor only, non-zero, while Opened or Released, never after a refund', async () => {
    const env = await setup()
    const s = await sold(env)
    const next = fresh32('new reply key')
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.rekey(s.id, next)), 'not depositor')
    expectRevert(await env.chain.send(SELLER, env.escrow, escrowCall.rekey(s.id, next)), 'not depositor')
    expectRevert(await env.chain.send(BUYER, env.escrow, escrowCall.rekey(s.id, `0x${'00'.repeat(32)}`)), 'reply key')
    const r = await mustSend(env.chain, BUYER, env.escrow, escrowCall.rekey(s.id, next))
    expect(escrowEvents(env, r)).toEqual([{ eventName: 'Rekeyed', args: { depositId: s.id, replyKeyHash: next } }])
    expect((await deposit(env, s.id)).replyKeyHash).toBe(next)
    env.chain.advance(RELEASE_DELAY)
    await mustSend(env.chain, STRANGER, env.escrow, escrowCall.release(s.id))
    const after = fresh32('after payout')
    expectOk(await env.chain.send(BUYER, env.escrow, escrowCall.rekey(s.id, after)))
    const gate = await env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'gate', args: [s.l.listingId, s.id] })
    expect(gate[6]).toBe(after)

    const refunded = await sold(env)
    await mustSend(env.chain, SELLER, env.escrow, escrowCall.sellerRefund(refunded.id, refunded.l.t.price))
    expectRevert(await env.chain.send(BUYER, env.escrow, escrowCall.rekey(refunded.id, next)), 'state')
    expectRevert(await env.chain.send(BUYER, env.escrow, escrowCall.rekey(999n, next)), 'not depositor')
  })
})

// --------------------------------------------------------------------------------------------
describe('release and sellerRefund', () => {
  it('release: anyone, not before releaseAt, pays only the seller and counts the sale', async () => {
    const env = await setup()
    const s = await sold(env, { price: 2_000_000n })
    const releaseAt = (await deposit(env, s.id)).releaseAt
    env.chain.setTime(BigInt(releaseAt - 1))
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.release(s.id)), 'too early')
    env.chain.setTime(BigInt(releaseAt))
    const r = await mustSend(env.chain, STRANGER, env.escrow, escrowCall.release(s.id))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: SELLER, value: 2_000_000n }])
    expect(escrowEvents(env, r)).toEqual([{ eventName: 'Released', args: { depositId: s.id, amount: 2_000_000n } }])
    expect((await deposit(env, s.id)).state).toBe(DEPOSIT_RELEASED)
    expect(await stats(env, SELLER)).toEqual({ sold: 1, disputes: 0, refunds: 0, paidOut: 2_000_000n })
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.release(s.id)), 'state')
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.release(999n)), 'state')
    expect(await balanceOf(env, env.escrow)).toBe(0n)
  })

  it('release after a dispute waits for the extra 48 h', async () => {
    const env = await setup()
    const s = await sold(env)
    const releaseAt = (await deposit(env, s.id)).releaseAt
    await mustSend(env.chain, BUYER, env.escrow, escrowCall.dispute(s.id, fresh32('r')))
    env.chain.setTime(BigInt(releaseAt))
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.release(s.id)), 'too early')
    env.chain.setTime(BigInt(releaseAt) + DISPUTE_HOLD - 1n)
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.release(s.id)), 'too early')
    env.chain.setTime(BigInt(releaseAt) + DISPUTE_HOLD)
    expectOk(await env.chain.send(STRANGER, env.escrow, escrowCall.release(s.id)))
  })

  it('sellerRefund: seller only, from 1 unit to all that is left, only while Opened', async () => {
    const env = await setup()
    const full = await sold(env, { price: 3_000_000n })
    expectRevert(await env.chain.send(BUYER, env.escrow, escrowCall.sellerRefund(full.id, 1n)), 'not seller')
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.sellerRefund(full.id, 1n)), 'not seller')
    expectRevert(await env.chain.send(SELLER, env.escrow, escrowCall.sellerRefund(full.id, 0n)), 'amount')
    expectRevert(await env.chain.send(SELLER, env.escrow, escrowCall.sellerRefund(full.id, 3_000_001n)), 'amount')
    const r = await mustSend(env.chain, SELLER, env.escrow, escrowCall.sellerRefund(full.id, 3_000_000n))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 3_000_000n }])
    expect(escrowEvents(env, r)).toEqual([{ eventName: 'Refunded', args: { depositId: full.id, toDepositor: 3_000_000n, remaining: 0n } }])
    expect(await deposit(env, full.id)).toMatchObject({ state: DEPOSIT_REFUNDED, amount: 0n })
    expectRevert(await env.chain.send(SELLER, env.escrow, escrowCall.sellerRefund(full.id, 1n)), 'state')
    env.chain.advance(RELEASE_DELAY)
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.release(full.id)), 'state')

    // Never after payout.
    const paid = await sold(env)
    await releaseWhenDue(env, paid.id)
    expectRevert(await env.chain.send(SELLER, env.escrow, escrowCall.sellerRefund(paid.id, 1n)), 'state')
    expect(await balanceOf(env, env.escrow)).toBe(0n)
  })

  it('a part refund pays only the buyer now: the deposit stays Opened and the seller waits for the payout', async () => {
    const env = await setup()
    // The seller refunds 1 unit the moment the sale lands.
    const s = await sold(env, { price: 3_000_000n })
    const before = await deposit(env, s.id)
    const sellerBefore = await balanceOf(env, SELLER)
    const r = await mustSend(env.chain, SELLER, env.escrow, escrowCall.sellerRefund(s.id, 1n))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 1n }])
    expect(escrowEvents(env, r)).toEqual([{ eventName: 'Refunded', args: { depositId: s.id, toDepositor: 1n, remaining: 2_999_999n } }])
    expect(await deposit(env, s.id)).toEqual({ ...before, amount: 2_999_999n })
    expect(await balanceOf(env, SELLER)).toBe(sellerBefore)
    // Nothing is paid early.
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.release(s.id)), 'too early')
    // The buyer keeps every right: dispute, and rekey.
    expectOk(await env.chain.send(BUYER, env.escrow, escrowCall.dispute(s.id, fresh32('r'))))
    expectOk(await env.chain.send(BUYER, env.escrow, escrowCall.rekey(s.id, fresh32('new key'))))
    const gate = await env.reader.readContract({ address: env.escrow, abi: ESCROW_ABI, functionName: 'gate', args: [s.l.listingId, s.id] })
    expect(gate[4]).toBe(DEPOSIT_OPENED)
    // Another part during the dispute, then the payout pays the rest after the hold.
    await mustSend(env.chain, SELLER, env.escrow, escrowCall.sellerRefund(s.id, 499_999n))
    const releaseAt = BigInt((await deposit(env, s.id)).releaseAt)
    expect(releaseAt).toBe(BigInt(before.releaseAt) + DISPUTE_HOLD)
    env.chain.setTime(releaseAt - 1n)
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.release(s.id)), 'too early')
    env.chain.setTime(releaseAt)
    const paid = await mustSend(env.chain, STRANGER, env.escrow, escrowCall.release(s.id))
    expect(transfers(env, paid)).toEqual([{ from: env.escrow, to: SELLER, value: 2_500_000n }])
    // Two Refunded events, then Released, for one deposit. An event name is not
    // the order's state: a keeper reads getDeposit(id).state.
    expect(escrowEvents(env, paid)).toEqual([{ eventName: 'Released', args: { depositId: s.id, amount: 2_500_000n } }])
    expect((await deposit(env, s.id)).state).toBe(DEPOSIT_RELEASED)
    expect(await stats(env, SELLER)).toEqual({ sold: 1, disputes: 1, refunds: 2, paidOut: 2_500_000n })
    expect(await balanceOf(env, env.escrow)).toBe(0n)
  })
})

// --------------------------------------------------------------------------------------------
describe('owed and claim', () => {
  it('a blocked seller does not stall the payout: it becomes owed, and claim pays it once unblocked', async () => {
    const env = await setup()
    const s = await sold(env, { price: 2_000_000n })
    env.chain.advance(RELEASE_DELAY)
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(SELLER, 1))
    const before = await balanceOf(env, SELLER)
    const r = await mustSend(env.chain, STRANGER, env.escrow, escrowCall.release(s.id))
    expect(transfers(env, r)).toEqual([])
    expect(escrowEvents(env, r).map((e) => e.eventName)).toEqual(['Released', 'Owed'])
    expect(await owed(env, SELLER)).toBe(2_000_000n)
    expect(await balanceOf(env, SELLER)).toBe(before)
    expect(await balanceOf(env, env.escrow)).toBe(2_000_000n)

    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.claim(SELLER)), 'transfer failed')
    expect(await owed(env, SELLER)).toBe(2_000_000n)
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(SELLER, 0))
    const c = await mustSend(env.chain, STRANGER, env.escrow, escrowCall.claim(SELLER))
    expect(transfers(env, c)).toEqual([{ from: env.escrow, to: SELLER, value: 2_000_000n }])
    expect(escrowEvents(env, c)).toEqual([{ eventName: 'Claimed', args: { to: expect.stringMatching(new RegExp(SELLER.slice(2), 'i')), amount: 2_000_000n } }])
    expect(await owed(env, SELLER)).toBe(0n)
    expect(await balanceOf(env, env.escrow)).toBe(0n)
    expectRevert(await env.chain.send(STRANGER, env.escrow, escrowCall.claim(SELLER)), 'nothing owed')
  })

  it('a blocked buyer does not strand anyone in a refund (token returns false)', async () => {
    const env = await setup()
    const s = await sold(env, { price: 3_000_000n })
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(BUYER, 2))
    const r = await mustSend(env.chain, SELLER, env.escrow, escrowCall.sellerRefund(s.id, 1_000_000n))
    expect(transfers(env, r)).toEqual([])
    expect(await owed(env, BUYER)).toBe(1_000_000n)
    expect(await deposit(env, s.id)).toMatchObject({ state: DEPOSIT_OPENED, amount: 2_000_000n })
    expectRevert(await env.chain.send(BUYER, env.escrow, escrowCall.claim(BUYER)), 'transfer failed')
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(BUYER, 0))
    expectOk(await env.chain.send(STRANGER, env.escrow, escrowCall.claim(BUYER)))
    expect(await owed(env, BUYER)).toBe(0n)
    // The rest still reaches the seller on schedule.
    const paid = await releaseWhenDue(env, s.id)
    expect(transfers(env, paid)).toEqual([{ from: env.escrow, to: SELLER, value: 2_000_000n }])
    expect(await balanceOf(env, env.escrow)).toBe(0n)
  })
})

// --------------------------------------------------------------------------------------------
describe('reentrancy', () => {
  async function hookOutcome(env: Env): Promise<{ called: boolean; ok: boolean; reason: string }> {
    const a = { address: env.token, abi: MOCK_TOKEN_ABI } as const
    return {
      called: await env.reader.readContract({ ...a, functionName: 'hookCalled' }),
      ok: await env.reader.readContract({ ...a, functionName: 'hookOk' }),
      reason: revertText(await env.reader.readContract({ ...a, functionName: 'hookReturn' })),
    }
  }

  it('a token calling back into release or claim mid-payout is refused', async () => {
    const env = await setup()
    const one = await sold(env)
    const two = await sold(env)
    env.chain.advance(RELEASE_DELAY)
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setHook(env.escrow, escrowCall.release(two.id)))
    expectOk(await env.chain.send(STRANGER, env.escrow, escrowCall.release(one.id)))
    expect(await hookOutcome(env)).toEqual({ called: true, ok: false, reason: 'reentrant' })
    expect((await deposit(env, two.id)).state).toBe(DEPOSIT_OPENED)
    // Due all along: only the guard stopped it.
    expectOk(await env.chain.send(STRANGER, env.escrow, escrowCall.release(two.id)))

    // A real owed balance, so a refused claim can only be the guard.
    const three = await sold(env)
    const four = await sold(env)
    env.chain.advance(RELEASE_DELAY)
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(SELLER, 1))
    await mustSend(env.chain, STRANGER, env.escrow, escrowCall.release(three.id))
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(SELLER, 0))
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setHook(env.escrow, escrowCall.claim(SELLER)))
    expectOk(await env.chain.send(STRANGER, env.escrow, escrowCall.release(four.id)))
    expect(await hookOutcome(env)).toEqual({ called: true, ok: false, reason: 'reentrant' })
    expect(await owed(env, SELLER)).toBe(three.l.t.price)
  })

  it('a token calling back during the pull of depositAndOpen is refused', async () => {
    const env = await setup()
    const due = await sold(env)
    env.chain.advance(RELEASE_DELAY)
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setHook(env.escrow, escrowCall.release(due.id)))
    const l = await listed(env)
    expectOk(await open(env, l, await ticketFor(env, l)))
    expect(await hookOutcome(env)).toEqual({ called: true, ok: false, reason: 'reentrant' })
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setHook(env.escrow, escrowCall.sellerRefund(due.id, 1n)))
    const l2 = await listed(env)
    expectOk(await open(env, l2, await ticketFor(env, l2)))
    expect(await hookOutcome(env)).toEqual({ called: true, ok: false, reason: 'reentrant' })
    expect((await deposit(env, due.id)).state).toBe(DEPOSIT_OPENED)
  })
})

// --------------------------------------------------------------------------------------------
describe('fuzzed money invariant', () => {
  /** mulberry32: small, seeded, reproducible. A failure names its seed and step. */
  function rng(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  interface ModelDeposit {
    id: bigint
    depositor: Hex
    seller: Hex
    amount: bigint
    releaseAt: bigint
    state: number
    disputed: boolean
  }

  async function run(seed: number, steps: number): Promise<number> {
    const env = await setup()
    const rand = rng(seed)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
    const sellers = [SELLER, SELLER2, testAddress(20)] as const
    const buyers = [BUYER, BUYER2, testAddress(21)] as const
    const everyone = [...sellers, ...buyers, STRANGER] as const
    for (const who of [testAddress(20), testAddress(21)]) {
      await mustSend(env.chain, DEPLOYER, env.token, tokenCall.mint(who, FUNDS))
      await mustSend(env.chain, who, env.token, tokenCall.approve(env.escrow, maxUint256))
    }
    const deposits: ModelDeposit[] = []
    const owedModel = new Map<Hex, bigint>()
    const paidModel = new Map<Hex, bigint>()
    const blockedModel = new Map<Hex, number>()
    let opened = 0

    const pay = (to: Hex, amount: bigint, out: Move[]): void => {
      if (amount === 0n) return
      if ((blockedModel.get(to) ?? 0) !== 0) owedModel.set(to, (owedModel.get(to) ?? 0n) + amount)
      else out.push({ from: env.escrow, to, value: amount })
    }

    const checkBalance = async (where: string): Promise<void> => {
      const openSum = deposits.filter((d) => d.state === DEPOSIT_OPENED).reduce((s, d) => s + d.amount, 0n)
      const owedSum = [...owedModel.values()].reduce((s, v) => s + v, 0n)
      expect(await balanceOf(env, env.escrow), where).toBe(openSum + owedSum)
    }

    const checkAll = async (where: string): Promise<void> => {
      let openSum = 0n
      for (const d of deposits) {
        const c = await deposit(env, d.id)
        expect({ state: c.state, releaseAt: BigInt(c.releaseAt), disputed: c.disputed, amount: c.amount }, `${where} deposit ${d.id}`).toEqual({
          state: d.state,
          releaseAt: d.releaseAt,
          disputed: d.disputed,
          amount: d.amount,
        })
        if (c.state === DEPOSIT_OPENED) openSum += c.amount
      }
      let owedSum = 0n
      for (const who of everyone) {
        const o = await owed(env, who)
        expect(o, `${where} owed ${who}`).toBe(owedModel.get(who) ?? 0n)
        owedSum += o
      }
      // The rule itself, from chain state alone.
      expect(await balanceOf(env, env.escrow), where).toBe(openSum + owedSum)
      // A seller's paidOut is exactly what release() credited them.
      for (const who of sellers) expect((await stats(env, who)).paidOut, `${where} paidOut ${who}`).toBe(paidModel.get(who) ?? 0n)
      // Nothing is minted or burned on the way: every unit is somewhere.
      let total = await balanceOf(env, env.escrow)
      for (const who of everyone) total += await balanceOf(env, who)
      expect(total, where).toBe(FUNDS * BigInt(everyone.length))
    }

    for (let step = 0; step < steps; step++) {
      const where = `seed ${seed} step ${step}`
      const op = pick(['open', 'open', 'open', 'dispute', 'release', 'release', 'refund', 'claim', 'block', 'advance', 'advance'] as const)
      const d = deposits.length > 0 ? pick(deposits) : null
      let r: CallResult | null = null
      let expectOkNow = true
      const expected: Move[] = []

      if (op === 'open') {
        const seller = pick(sellers)
        const buyer = pick(buyers)
        const readable = rand() < 0.3
        const valueCents = readable ? 1 + Math.floor(rand() * 50_000) : 1 + Math.floor(rand() * 2_500)
        const residualCapCents = readable ? Math.floor(rand() * 1_001) : 0
        const price = 1n + BigInt(Math.floor(rand() * valueCents * 10_000))
        const l = await listed(env, { seller, valueCents, price, residualCapCents, mode: readable ? MODE_READABLE : MODE_BLIND })
        const k = await ticketFor(env, l, {
          depositor: buyer,
          openBalanceCents: readable ? valueCents + Math.floor(rand() * (residualCapCents + 1)) : 0,
        })
        r = await open(env, l, k, buyer)
        opened++
        deposits.push({
          id: BigInt(opened),
          depositor: buyer,
          seller,
          amount: price,
          releaseAt: env.chain.timestamp + RELEASE_DELAY,
          state: DEPOSIT_OPENED,
          disputed: false,
        })
        expect(transfers(env, r), where).toEqual(r.ok ? [{ from: buyer, to: env.escrow, value: price }] : [])
      } else if (op === 'dispute' && d) {
        const caller = rand() < 0.8 ? d.depositor : pick(everyone)
        expectOkNow = caller === d.depositor && d.state === DEPOSIT_OPENED && !d.disputed && env.chain.timestamp < d.releaseAt
        r = await env.chain.send(caller, env.escrow, escrowCall.dispute(d.id, fresh32('reason')))
        if (expectOkNow) {
          d.disputed = true
          d.releaseAt += DISPUTE_HOLD
        }
      } else if (op === 'release' && d) {
        expectOkNow = d.state === DEPOSIT_OPENED && env.chain.timestamp >= d.releaseAt
        r = await env.chain.send(pick(everyone), env.escrow, escrowCall.release(d.id))
        if (expectOkNow) {
          d.state = DEPOSIT_RELEASED
          paidModel.set(d.seller, (paidModel.get(d.seller) ?? 0n) + d.amount)
          pay(d.seller, d.amount, expected)
        }
      } else if (op === 'refund' && d) {
        const caller = rand() < 0.8 ? d.seller : pick(everyone)
        const roll = rand()
        const amount = roll < 0.1 ? 0n : roll < 0.2 ? d.amount + 1n : roll < 0.4 ? d.amount : 1n + BigInt(Math.floor(rand() * Number(d.amount)))
        expectOkNow = caller === d.seller && d.state === DEPOSIT_OPENED && amount > 0n && amount <= d.amount
        r = await env.chain.send(caller, env.escrow, escrowCall.sellerRefund(d.id, amount))
        if (expectOkNow) {
          // Only the buyer's share moves; the rest waits for release().
          d.amount -= amount
          if (d.amount === 0n) d.state = DEPOSIT_REFUNDED
          pay(d.depositor, amount, expected)
        }
      } else if (op === 'claim') {
        const to = pick(everyone)
        const due = owedModel.get(to) ?? 0n
        expectOkNow = due > 0n && (blockedModel.get(to) ?? 0) === 0
        r = await env.chain.send(pick(everyone), env.escrow, escrowCall.claim(to))
        if (expectOkNow) {
          owedModel.set(to, 0n)
          expected.push({ from: env.escrow, to, value: due })
        }
      } else if (op === 'block') {
        const who = pick(everyone)
        const mode = pick([0, 0, 1, 2] as const)
        await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(who, mode))
        blockedModel.set(who, mode)
      } else if (op === 'advance') {
        env.chain.advance(pick([0, 1, 60, 3_600, 43_200, 86_399, 86_400, 172_800]))
      }

      if (r !== null) {
        expect({ ok: r.ok, revert: r.revert === null ? null : 'some' }, `${where} ${op}: ${r.revert ?? ''}`).toEqual({
          ok: expectOkNow,
          revert: expectOkNow ? null : 'some',
        })
        // Tokens leave the escrow only to the deposit's seller or depositor, or to an address it owed.
        const out = transfers(env, r).filter((m) => m.from === env.escrow)
        expect(out, `${where} ${op}`).toEqual(expected)
      }
      await checkBalance(where)
      if (step % 25 === 24) await checkAll(where)
    }
    await checkAll(`seed ${seed} end`)
    return deposits.length
  }

  it('escrow balance == open deposits + owed after every step, and tokens leave only to depositor, seller or owed', async () => {
    let total = 0
    for (const seed of [1, 7, 42, 20261007]) total += await run(seed, 150)
    // The runs must actually exercise money, not only refusals.
    expect(total).toBeGreaterThan(100)
  }, 180_000)
})
