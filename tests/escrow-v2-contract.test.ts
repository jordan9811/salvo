/**
 * SalvoEscrowV2, run for real: the committed bytes on an in-process EVM
 * (tests/support/evm.ts), against MockToken, with SalvoEscrowV1 deployed at
 * its pinned Moderato address from its pinned deployer, so a test can sell a
 * card on V1 and show that V2 never reads it. No network.
 *
 * What is pinned here, because the custody claim and the shopper's promise
 * rest on each one:
 *   - MONEY ROUTES. Tokens leave the escrow only to a deposit's seller, its
 *     buyer, the holder of the deposit a sale covered, or an address it already
 *     owes. A fuzzed run checks this on every step, with the balance rule:
 *     escrow balance == every Opened deposit's amount + every held bond +
 *     every `owed`, read from chain state alone.
 *   - PARTIAL USE. A buyer pays the listing's price for the cents used and
 *     deposits the cents left at face. What is left stays listed, tracked as
 *     remainingCents, and the next buyer of it must use it whole while another
 *     buyer's deposit covers it (spec section 8.3).
 *   - THE DEPOSIT'S LIFE. Held; back after the next buyer's 2-hour contest
 *     window, at blind and readable stores alike, or paid to the seller when
 *     that sale is contested; back by rule at 7 days; the seller's word between
 *     5 and 7 days; a Lit confirm read moves a shortfall to the seller only. A
 *     seller's refund moves only the sale's own payment: it lists nothing again
 *     and frees no deposit, except that a refunded first sale closes the listing.
 *   - THE TICKET. Every `require` fires at its exact edge, and a ticket is
 *     bound to the listing's value left and sales count, so a stale one reverts.
 *   - THE BYTES. The committed artifact equals a fresh compile; no
 *     DELEGATECALL, CALLCODE, SELFDESTRUCT, CREATE or CREATE2; the ABI is
 *     exactly the list below; the runtime hash does not depend on constructor
 *     arguments.
 *
 * The listing and ticket hashes are written out here independently of the
 * contract's own views (viem's ABI encoder and EIP-712 hasher), so a test that
 * lists with these ids and opens with these tickets also proves the contract
 * hashes the way the V2 template and the browser must.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  hashTypedData,
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
  ESCROW_V2_ABI,
  ESCROW_V2_BYTECODE,
  ESCROW_V2_RUNTIME_BYTECODE,
  ESCROW_V2_SOLC_SETTINGS,
  ESCROW_V2_SOLC_VERSION,
  ESCROW_V2_SOURCE_SHA256,
  RUNTIME_KECCAK_V2,
} from '@/lib/escrow/artifact-v2'
import { ESCROW_ABI as ESCROW_V1_ABI, RUNTIME_KECCAK as RUNTIME_KECCAK_V1 } from '@/lib/escrow/artifact'
import { ESCROW_V1_PINS } from '@/lib/vault/lit/escrow-pins'
import { compileEscrow, driftedFiles, ESCROW_V2_JSON_PATH, SOLC_PIN } from '../scripts/escrow-compile'
import { TestChain, revertText, testAddress, type CallResult } from './support/evm'
import {
  MOCK_TOKEN_ABI,
  commitmentOf as commitmentOfV1,
  deployMockToken,
  escrowCall as v1Call,
  escrowInitCode as v1InitCode,
  highS,
  listingIdOf,
  readerFor,
  signTicket as signTicketV1,
  tokenCall,
  withV,
  type Terms as TermsV1,
} from './support/escrow-chain'

// ------------------------------------------------------------------ actors and constants
const LIT = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const ROGUE = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const DEPLOYER = testAddress(1)
const SELLER = testAddress(2)
const BUYER = testAddress(3)
const STRANGER = testAddress(4)
const BUYER2 = testAddress(5)
const SELLER2 = testAddress(6)
const BUYER3 = testAddress(7)
const ACTORS = [SELLER, SELLER2, BUYER, BUYER2, BUYER3, STRANGER] as const
const T0 = 1_790_000_000n
/** $1,000,000 in 6-decimal units: no test runs out of money by accident. */
const FUNDS = 1_000_000_000_000n
const ECRECOVER: Hex = '0x0000000000000000000000000000000000000001'
const ZERO32: Hex = `0x${'00'.repeat(32)}`
const V1_DEPLOYER = ESCROW_V1_PINS.escrowDeployer as Hex
const V1_ADDRESS = ESCROW_V1_PINS.escrowAddress as Hex

const MODE_READABLE = 1
const MODE_BLIND = 2
const LISTING = { ACTIVE: 1, DRAINED: 2, CANCELLED: 3, SPENT: 4 } as const
const DEPOSIT = { OPENED: 1, RELEASED: 2, REFUNDED: 3, CONTESTED: 4 } as const
const BOND = { NONE: 0, HELD: 1, RETURNED: 2, FORFEITED: 3 } as const
const UNITS_PER_CENT = 10_000n
const RELEASE_DELAY = 86_400n
const DISPUTE_HOLD = 172_800n
const MAX_TICKET_TTL = 900n
const CONTEST_WINDOW = 7_200n
const BOND_REVIEW_AFTER = 432_000n
const BOND_MAX_AGE = 604_800n
const CONFIRM_DELAY = 900n

const TERMS_TYPE =
  'SalvoTerms(uint256 chainId,address escrow,address token,address seller,uint96 price,uint32 valueCents,uint16 residualCapCents,uint16 remainderHaircutBps,uint8 merchant,uint8 mode,uint40 listingExpiry,bytes32 salt)'
const LISTING_TYPE = 'SalvoListing(bytes32 coreHash,bytes32 envelopeHash)'
const OPEN_TYPE =
  'OpenV2(bytes32 listingId,address depositor,bytes32 replyKeyHash,uint32 openBalanceCents,bytes32 cardTag,uint32 remainingCents,uint16 sales,uint40 notAfter)'
const CONFIRM_TYPE = 'Confirm(bytes32 listingId,uint64 bondDeposit,uint32 balance,uint40 readAt)'

// ------------------------------------------------------------------ V2 shapes and hashes
/** Mirrors the contract's Terms struct, in the types viem encodes it with. */
interface Terms {
  seller: Hex
  price: bigint
  valueCents: number
  residualCapCents: number
  remainderHaircutBps: number
  merchant: number
  mode: number
  listingExpiry: number
  salt: Hex
}

/** Mirrors the contract's Ticket struct. */
interface Ticket {
  replyKeyHash: Hex
  openBalanceCents: number
  cardTag: Hex
  remainingCents: number
  sales: number
  notAfter: number
  signature: Hex
}

interface OpenFields {
  listingId: Hex
  depositor: Hex
  replyKeyHash: Hex
  openBalanceCents: number
  cardTag: Hex
  remainingCents: number
  sales: number
  notAfter: number
}

const typeId = (s: string): Hex => keccak256(toHex(s))

function coreHash(chainId: bigint, escrow: Hex, token: Hex, t: Terms): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint96' },
        { type: 'uint32' },
        { type: 'uint16' },
        { type: 'uint16' },
        { type: 'uint8' },
        { type: 'uint8' },
        { type: 'uint40' },
        { type: 'bytes32' },
      ],
      [
        typeId(TERMS_TYPE),
        chainId,
        escrow,
        token,
        t.seller,
        t.price,
        t.valueCents,
        t.residualCapCents,
        t.remainderHaircutBps,
        t.merchant,
        t.mode,
        t.listingExpiry,
        t.salt,
      ],
    ),
  )
}

function commitmentOf(chainId: bigint, escrow: Hex, token: Hex, t: Terms, envelopeHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [typeId(LISTING_TYPE), coreHash(chainId, escrow, token, t), envelopeHash],
    ),
  )
}

const domain = (chainId: bigint, escrow: Hex) => ({ name: 'SalvoEscrow', version: '2', chainId, verifyingContract: escrow }) as const

/** The ticket digest by the EIP-712 standard (viem), not by the contract's view. */
function openDigest(chainId: bigint, escrow: Hex, f: OpenFields): Hex {
  return hashTypedData({
    domain: domain(chainId, escrow),
    types: {
      OpenV2: [
        { name: 'listingId', type: 'bytes32' },
        { name: 'depositor', type: 'address' },
        { name: 'replyKeyHash', type: 'bytes32' },
        { name: 'openBalanceCents', type: 'uint32' },
        { name: 'cardTag', type: 'bytes32' },
        { name: 'remainingCents', type: 'uint32' },
        { name: 'sales', type: 'uint16' },
        { name: 'notAfter', type: 'uint40' },
      ],
    },
    primaryType: 'OpenV2',
    message: f,
  })
}

interface ConfirmFields {
  listingId: Hex
  bondDeposit: bigint
  balance: number
  readAt: number
}

function confirmDigest(chainId: bigint, escrow: Hex, f: ConfirmFields): Hex {
  return hashTypedData({
    domain: domain(chainId, escrow),
    types: {
      Confirm: [
        { name: 'listingId', type: 'bytes32' },
        { name: 'bondDeposit', type: 'uint64' },
        { name: 'balance', type: 'uint32' },
        { name: 'readAt', type: 'uint40' },
      ],
    },
    primaryType: 'Confirm',
    message: f,
  })
}

/** Calldata builders, typed against the committed V2 ABI. */
const v2 = {
  list: (commitment: Hex): Hex => encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'list', args: [commitment] }),
  cancelListing: (listingId: Hex): Hex => encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'cancelListing', args: [listingId] }),
  depositAndOpen: (t: Terms, eh: Hex, used: number, k: Ticket): Hex =>
    encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'depositAndOpen', args: [t, eh, used, k] }),
  dispute: (id: bigint, reason: Hex): Hex => encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'dispute', args: [id, reason] }),
  contestRemainder: (id: bigint, reason: Hex): Hex =>
    encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'contestRemainder', args: [id, reason] }),
  reduceUse: (t: Terms, eh: Hex, id: bigint, newUsed: number): Hex =>
    encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'reduceUse', args: [t, eh, id, newUsed] }),
  keepRest: (t: Terms, eh: Hex, id: bigint): Hex => encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'keepRest', args: [t, eh, id] }),
  rekey: (id: bigint, reply: Hex): Hex => encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'rekey', args: [id, reply] }),
  release: (id: bigint): Hex => encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'release', args: [id] }),
  releaseBond: (id: bigint): Hex => encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'releaseBond', args: [id] }),
  sellerCloseRemainder: (listingId: Hex, spent: boolean): Hex =>
    encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'sellerCloseRemainder', args: [listingId, spent] }),
  confirmRemainder: (listingId: Hex, balance: number, readAt: number, sig: Hex): Hex =>
    encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'confirmRemainder', args: [listingId, balance, readAt, sig] }),
  sellerRefund: (id: bigint, amount: bigint): Hex =>
    encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'sellerRefund', args: [id, amount] }),
  claim: (to: Hex): Hex => encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'claim', args: [to] }),
}

// ------------------------------------------------------------------ the world
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
  /** The card's tag: every ticket for this listing carries it, as Lit computes it from the one sealed card. */
  tag: Hex
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

type V1Mode = 'escrow' | 'none' | 'not-an-escrow'

/**
 * A chain with the token, SalvoEscrowV1 at its pinned address (by default),
 * and SalvoEscrowV2, every actor funded and approved. V1 is created by its
 * real deployer as that account's first contract, which is how it got its
 * address on Moderato: TestChain runs calls from any address without a key.
 * V2 never reads it; the V1 cases below prove that.
 */
async function setup(opts: { chainId?: bigint; v1?: V1Mode } = {}): Promise<Env> {
  const chain = await TestChain.create({ timestamp: T0, ...(opts.chainId === undefined ? {} : { chainId: opts.chainId }) })
  const token = await deployMockToken(chain, DEPLOYER)
  const v1 = opts.v1 ?? 'escrow'
  if (v1 === 'escrow') expect(await chain.deploy(V1_DEPLOYER, v1InitCode(LIT.address, token))).toBe(V1_ADDRESS)
  if (v1 === 'not-an-escrow') expect(await deployMockToken(chain, V1_DEPLOYER)).toBe(V1_ADDRESS)
  const escrow = await deployV2(chain, LIT.address, token)
  for (const who of ACTORS) {
    await mustSend(chain, DEPLOYER, token, tokenCall.mint(who, FUNDS))
    await mustSend(chain, who, token, tokenCall.approve(escrow, maxUint256))
    if (v1 === 'escrow') await mustSend(chain, who, token, tokenCall.approve(V1_ADDRESS, maxUint256))
  }
  return { chain, reader: readerFor(chain), token, escrow }
}

function v2InitCode(litSigner: Hex, token: Hex): Hex {
  return encodeDeployData({ abi: ESCROW_V2_ABI, bytecode: ESCROW_V2_BYTECODE, args: [litSigner, token] })
}

async function deployV2(chain: TestChain, litSigner: Hex, token: Hex): Promise<Hex> {
  return chain.deploy(DEPLOYER, v2InitCode(litSigner, token))
}

/** A $20 blind card at 10% off: 9,000 units a cent, so prices here are round. Cap $5, haircut 25%. */
function terms(env: Env, over: Partial<Terms> = {}): Terms {
  return {
    seller: SELLER,
    price: 18_000_000n,
    valueCents: 2_000,
    residualCapCents: 500,
    remainderHaircutBps: 2_500,
    merchant: 9,
    mode: MODE_BLIND,
    listingExpiry: now(env) + 365 * 86_400,
    salt: fresh32('salt'),
    ...over,
  }
}

async function listTerms(env: Env, t: Terms, tag: Hex = fresh32('tag')): Promise<Listed> {
  const envelopeHash = fresh32('envelope')
  const commitment = commitmentOf(env.chain.chainId, env.escrow, env.token, t, envelopeHash)
  await mustSend(env.chain, t.seller, env.escrow, v2.list(commitment))
  return { t, envelopeHash, listingId: listingIdOf(t.seller, commitment), tag }
}

async function listed(env: Env, over: Partial<Terms> = {}, tag?: Hex): Promise<Listed> {
  return listTerms(env, terms(env, over), tag)
}

/** A readable $20 card: Lit reads the balance. Cap $10. */
async function listedReadable(env: Env, over: Partial<Terms> = {}, tag?: Hex): Promise<Listed> {
  return listed(env, { mode: MODE_READABLE, residualCapCents: 1_000, merchant: 1, ...over }, tag)
}

interface Gate {
  signer: Hex
  token: Hex
  listingSeller: Hex
  listingState: number
  depositState: number
  depositListingId: Hex
  replyKeyHash: Hex
  depositor: Hex
  remainingCents: number
  sales: number
  bondDeposit: bigint
}

async function gate(env: Env, listingId: Hex, depositId = 0n): Promise<Gate> {
  const g = await env.reader.readContract({ address: env.escrow, abi: ESCROW_V2_ABI, functionName: 'gate', args: [listingId, depositId] })
  return {
    signer: lower(g[0]),
    token: lower(g[1]),
    listingSeller: lower(g[2]),
    listingState: g[3],
    depositState: g[4],
    depositListingId: g[5],
    replyKeyHash: g[6],
    depositor: lower(g[7]),
    remainingCents: g[8],
    sales: g[9],
    bondDeposit: g[10],
  }
}

/** The value Lit sees as left: valueCents before the first sale, else the listing's remainingCents. */
async function valueLeft(env: Env, l: Listed): Promise<{ have: number; sales: number }> {
  const g = await gate(env, l.listingId)
  return { have: g.sales === 0 ? l.t.valueCents : g.remainingCents, sales: g.sales }
}

interface TicketOpts {
  signer?: PrivateKeyAccount
  chainId?: bigint
  escrow?: Hex
}

/** A ticket as the V2 template signs it, for the listing's state on chain now unless `fields` say otherwise. */
async function ticketFor(env: Env, l: Listed, fields: Partial<OpenFields> = {}, opts: TicketOpts = {}): Promise<Ticket> {
  const { have, sales } = await valueLeft(env, l)
  const f: OpenFields = {
    listingId: l.listingId,
    depositor: BUYER,
    replyKeyHash: fresh32('reply'),
    openBalanceCents: l.t.mode === MODE_READABLE ? have : 0,
    cardTag: l.tag,
    remainingCents: have,
    sales,
    notAfter: now(env) + 600,
    ...fields,
  }
  const signature = await (opts.signer ?? LIT).sign({ hash: openDigest(opts.chainId ?? env.chain.chainId, opts.escrow ?? env.escrow, f) })
  return {
    replyKeyHash: f.replyKeyHash,
    openBalanceCents: f.openBalanceCents,
    cardTag: f.cardTag,
    remainingCents: f.remainingCents,
    sales: f.sales,
    notAfter: f.notAfter,
    signature,
  }
}

/** depositAndOpen as an eth_call: the verdict without spending anything. */
async function tryOpen(env: Env, l: Listed, used: number, k: Ticket, from: Hex = BUYER): Promise<CallResult> {
  return env.chain.call(from, env.escrow, v2.depositAndOpen(l.t, l.envelopeHash, used, k))
}

async function open(env: Env, l: Listed, used: number, k: Ticket, from: Hex = BUYER): Promise<CallResult> {
  return env.chain.send(from, env.escrow, v2.depositAndOpen(l.t, l.envelopeHash, used, k))
}

async function depositCount(env: Env): Promise<bigint> {
  return env.reader.readContract({ address: env.escrow, abi: ESCROW_V2_ABI, functionName: 'depositCount' })
}

/** Ticket and open `used` cents as `buyer`. Returns the deposit id and the receipt. */
async function buy(env: Env, l: Listed, used: number, buyer: Hex = BUYER, fields: Partial<OpenFields> = {}): Promise<{ id: bigint; r: CallResult; k: Ticket }> {
  const k = await ticketFor(env, l, { depositor: buyer, ...fields })
  const r = await open(env, l, used, k, buyer)
  if (!r.ok) throw new Error(`open failed: ${r.revert ?? '?'}`)
  return { id: await depositCount(env), r, k }
}

async function balanceOf(env: Env, who: Hex): Promise<bigint> {
  return env.reader.readContract({ address: env.token, abi: MOCK_TOKEN_ABI, functionName: 'balanceOf', args: [who] })
}

async function deposit(env: Env, id: bigint) {
  return env.reader.readContract({ address: env.escrow, abi: ESCROW_V2_ABI, functionName: 'getDeposit', args: [id] })
}

async function listing(env: Env, listingId: Hex) {
  return env.reader.readContract({ address: env.escrow, abi: ESCROW_V2_ABI, functionName: 'getListing', args: [listingId] })
}

async function owed(env: Env, who: Hex): Promise<bigint> {
  return env.reader.readContract({ address: env.escrow, abi: ESCROW_V2_ABI, functionName: 'owed', args: [who] })
}

interface Stats {
  sold: number
  disputes: number
  refunds: number
  paidOut: bigint
  remaindersShort: number
  bondsClaimed: number
}

async function stats(env: Env, who: Hex): Promise<Stats> {
  const [sold, disputes, refunds, paidOut, remaindersShort, bondsClaimed] = await env.reader.readContract({
    address: env.escrow,
    abi: ESCROW_V2_ABI,
    functionName: 'sellerStats',
    args: [who],
  })
  return { sold, disputes, refunds, paidOut, remaindersShort, bondsClaimed }
}

async function shortfalls(env: Env, who: Hex): Promise<number> {
  return env.reader.readContract({ address: env.escrow, abi: ESCROW_V2_ABI, functionName: 'buyerShortfalls', args: [who] })
}

async function cardOf(env: Env, tag: Hex): Promise<{ owner: Hex; deposit: bigint; listing: Hex }> {
  const ask = { address: env.escrow, abi: ESCROW_V2_ABI, args: [tag] } as const
  return {
    owner: lower(await env.reader.readContract({ ...ask, functionName: 'cardOwner' })),
    deposit: await env.reader.readContract({ ...ask, functionName: 'cardDeposit' }),
    listing: await env.reader.readContract({ ...ask, functionName: 'cardListing' }),
  }
}

async function priceFor(env: Env, price: bigint, valueCents: number, usedCents: number, haircutBps = 0): Promise<bigint> {
  return env.reader.readContract({
    address: env.escrow,
    abi: ESCROW_V2_ABI,
    functionName: 'priceFor',
    args: [price, BigInt(valueCents), BigInt(usedCents), BigInt(haircutBps)],
  })
}

/** A Lit confirm read of a listing, signed over the listing's bond deposit on chain now unless told otherwise. */
async function confirmSig(env: Env, l: Listed, balance: number, readAt: number, over: { bondDeposit?: bigint; signer?: PrivateKeyAccount } = {}): Promise<Hex> {
  const bondDeposit = over.bondDeposit ?? (await gate(env, l.listingId)).bondDeposit
  return (over.signer ?? LIT).sign({ hash: confirmDigest(env.chain.chainId, env.escrow, { listingId: l.listingId, bondDeposit, balance, readAt }) })
}

async function confirm(env: Env, l: Listed, balance: number, readAt: number, over: { bondDeposit?: bigint; signer?: PrivateKeyAccount } = {}): Promise<CallResult> {
  return env.chain.send(STRANGER, env.escrow, v2.confirmRemainder(l.listingId, balance, readAt, await confirmSig(env, l, balance, readAt, over)))
}

function escrowEvents(env: Env, r: CallResult) {
  return r.logs
    .filter((l) => l.address === env.escrow)
    .map((l) => decodeEventLog({ abi: ESCROW_V2_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }))
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

/**
 * legCostCents from src/lib/route/plan.ts, the function itself, compiled from
 * its own source text. This file never loads the app's modules; reading the
 * source keeps the comparison with the real function rather than a copy of it.
 */
function loadLegCostCents(): (applied: number, price: number, face: number) => number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const text = readFileSync(resolve(root, 'src/lib/route/plan.ts'), 'utf8')
  const m = /export function legCostCents\([\s\S]*?\r?\n\}\r?\n/.exec(text)
  if (!m) throw new Error('legCostCents not found in src/lib/route/plan.ts')
  const js = ts.transpileModule(m[0].replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  // The body is pure arithmetic over its three arguments; it names nothing else.
  const fn: unknown = new Function(`${js}\nreturn legCostCents`)()
  if (typeof fn !== 'function') throw new Error('legCostCents did not compile to a function')
  return fn as (applied: number, price: number, face: number) => number
}

// --------------------------------------------------------------------------------------------
describe('SalvoEscrowV2 bytes and ABI', () => {
  it('the committed artifacts equal a fresh compile with the pinned solc, and V2 compiles with no warnings', () => {
    const result = compileEscrow()
    expect(driftedFiles(result)).toEqual([])
    expect(result.escrowV2.warnings).toEqual([])
    expect(result.escrowV2.contractName).toBe('SalvoEscrowV2')
    expect(ESCROW_V2_SOLC_VERSION.startsWith(`${SOLC_PIN}+`)).toBe(true)
    expect(ESCROW_V2_SOLC_SETTINGS).toEqual({
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      viaIR: false,
      metadata: { bytecodeHash: 'none', appendCBOR: false },
    })
    expect(result.escrowV2.sourceSha256).toBe(ESCROW_V2_SOURCE_SHA256)
    expect(result.escrowV2.runtimeKeccak).toBe(RUNTIME_KECCAK_V2)
    // Adding V2 left V1's frozen bytes alone.
    expect(result.escrow.runtimeKeccak).toBe(RUNTIME_KECCAK_V1)
    expect(RUNTIME_KECCAK_V1).toBe(ESCROW_V1_PINS.escrowCodehash)
    expect(RUNTIME_KECCAK_V2).not.toBe(RUNTIME_KECCAK_V1)
  }, 120_000)

  it('has no DELEGATECALL, CALLCODE, SELFDESTRUCT, CREATE or CREATE2, and fits the 24 KiB code limit', () => {
    const ops = opcodes(ESCROW_V2_RUNTIME_BYTECODE)
    for (const [name, op] of [
      ['DELEGATECALL', 0xf4],
      ['CALLCODE', 0xf2],
      ['SELFDESTRUCT', 0xff],
      ['CREATE', 0xf0],
      ['CREATE2', 0xf5],
    ] as const) {
      expect(ops.has(op), name).toBe(false)
    }
    // The only outward calls: CALL to the token; STATICCALL to the token and ecrecover.
    expect([0xf1, 0xf2, 0xf4, 0xfa].filter((op) => ops.has(op))).toEqual([0xf1, 0xfa])
    expect((ESCROW_V2_RUNTIME_BYTECODE.length - 2) / 2).toBeLessThanOrEqual(24_576)
    // V1's address is nowhere in the bytes: V2 cannot call it.
    expect(ESCROW_V2_RUNTIME_BYTECODE.toLowerCase()).not.toContain(V1_ADDRESS.slice(2))
    expect(ESCROW_V2_BYTECODE.toLowerCase()).not.toContain(V1_ADDRESS.slice(2))
  })

  it('the committed V2 artifact is not git-ignored', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const git = spawnSync('git', ['check-ignore', '--no-index', '-v', ESCROW_V2_JSON_PATH, 'src/lib/escrow/artifact-v2.ts'], { cwd: root, encoding: 'utf8' })
    if (git.error === undefined && git.status !== 128) {
      expect({ status: git.status, ignoredBy: git.stdout.trim() }).toEqual({ status: 1, ignoredBy: '' })
    }
    const attrs = readFileSync(resolve(root, '.gitattributes'), 'utf8').split(/\r?\n/).map((l) => l.trim())
    expect(attrs).toContain('contracts/** text eol=lf')
    expect(attrs).toContain('src/lib/escrow/artifact-v2.ts text eol=lf')
  })

  it('exposes exactly this ABI: spec section 8 as built', () => {
    // Where the build departs from the letter of spec section 8, on purpose (each is in the
    // contract's comments):
    //   - reduceUse and keepRest take (Terms, envelopeHash) before the deposit id, so pricing
    //     needs no extra storage slot per listing; the terms are checked against the listing.
    //   - Listing adds lastDeposit and mode; Deposit's bond is uint64 (at most $10 at face), so
    //     the V2 fields fit one slot; `covers` is also set on a buyer's own remainder sale, and
    //     contestUntil alone marks the contestable kind.
    //   - openDigest takes the ticket struct; Confirm and priceFor are views, for the twins.
    //   - No V1 constant and no read of V1's cardOwner: a V2 card tag is never a V1 one (8.3).
    //   - CONFIRM_DELAY: how soon after a sale a clean read closes its buyer's window (7.2).
    type P = { type: string; name?: string; indexed?: boolean; components?: readonly P[] }
    const param = (p: P): string => {
      const base = p.type.startsWith('tuple') ? `(${(p.components ?? []).map(param).join(', ')})${p.type.slice(5)}` : p.type
      return [base, p.indexed ? 'indexed' : '', p.name ?? ''].filter((s) => s !== '').join(' ')
    }
    const line = (i: (typeof ESCROW_V2_ABI)[number]): string => {
      if (i.type === 'function') {
        const outs = i.outputs.map(param).join(', ')
        return `function ${i.name}(${i.inputs.map(param).join(', ')}) ${i.stateMutability}${outs ? ` returns (${outs})` : ''}`
      }
      if (i.type === 'event') return `event ${i.name}(${i.inputs.map(param).join(', ')})${i.anonymous ? ' anonymous' : ''}`
      return `constructor(${i.inputs.map(param).join(', ')}) ${i.stateMutability}`
    }
    const TERMS =
      '(address seller, uint96 price, uint32 valueCents, uint16 residualCapCents, uint16 remainderHaircutBps, uint8 merchant, uint8 mode, uint40 listingExpiry, bytes32 salt)'
    const TICKET = '(bytes32 replyKeyHash, uint32 openBalanceCents, bytes32 cardTag, uint32 remainingCents, uint16 sales, uint40 notAfter, bytes signature)'
    expect(ESCROW_V2_ABI.map(line).sort()).toEqual(
      [
        'constructor(address litSigner_, address token_) nonpayable',
        'event BondForfeited(uint256 indexed depositId, uint256 amount)',
        'event BondReturned(uint256 indexed depositId, uint256 amount)',
        'event Claimed(address indexed to, uint256 amount)',
        'event Contested(uint256 indexed depositId, uint256 indexed covers, bytes32 reasonHash)',
        'event Disputed(uint256 indexed depositId, bytes32 reasonHash, uint40 releaseAt)',
        'event Listed(bytes32 indexed listingId, address indexed seller, bytes32 commitment)',
        'event ListingCancelled(bytes32 indexed listingId)',
        'event Opened(uint256 indexed depositId, bytes32 indexed listingId, address indexed depositor, bytes32 cardTag, uint32 openBalanceCents, uint40 releaseAt)',
        'event Owed(address indexed to, uint256 amount)',
        'event Refunded(uint256 indexed depositId, uint256 toDepositor, uint256 remaining)',
        'event Rekeyed(uint256 indexed depositId, bytes32 replyKeyHash)',
        'event Released(uint256 indexed depositId, uint256 amount)',
        'event RemainderClosed(bytes32 indexed listingId, bool spent)',
        'event RemainderConfirmed(bytes32 indexed listingId, uint32 balanceCents, uint40 readAt, uint256 toSeller)',
        'event RestKept(uint256 indexed depositId, uint32 restCents, uint256 restPrice)',
        'event UseReduced(uint256 indexed depositId, uint32 usedCents, uint32 leftCents, uint256 refund)',
        'event Used(bytes32 indexed listingId, uint256 indexed depositId, uint32 usedCents, uint32 leftCents, uint256 bond)',
        'function BOND_FORFEITED() view returns (uint8)',
        'function BOND_HELD() view returns (uint8)',
        'function BOND_MAX_AGE() view returns (uint256)',
        'function BOND_NONE() view returns (uint8)',
        'function BOND_RETURNED() view returns (uint8)',
        'function BOND_REVIEW_AFTER() view returns (uint256)',
        'function BPS() view returns (uint256)',
        'function CAP_BLIND() view returns (uint256)',
        'function CAP_READABLE() view returns (uint256)',
        'function CONFIRM_DELAY() view returns (uint256)',
        'function CONFIRM_TYPEHASH() view returns (bytes32)',
        'function CONTEST_WINDOW() view returns (uint256)',
        'function DEPOSIT_CONTESTED() view returns (uint8)',
        'function DEPOSIT_OPENED() view returns (uint8)',
        'function DEPOSIT_REFUNDED() view returns (uint8)',
        'function DEPOSIT_RELEASED() view returns (uint8)',
        'function DISPUTE_HOLD() view returns (uint256)',
        'function LISTING_ACTIVE() view returns (uint8)',
        'function LISTING_CANCELLED() view returns (uint8)',
        'function LISTING_DRAINED() view returns (uint8)',
        'function LISTING_SPENT() view returns (uint8)',
        'function LISTING_TYPEHASH() view returns (bytes32)',
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
        'function buyerShortfalls(address) view returns (uint32)',
        'function cancelListing(bytes32 listingId) nonpayable',
        'function cardDeposit(bytes32) view returns (uint256)',
        'function cardListing(bytes32) view returns (bytes32)',
        'function cardOwner(bytes32) view returns (address)',
        'function claim(address to) nonpayable',
        `function commitmentOf(${TERMS} t, bytes32 envelopeHash) view returns (bytes32)`,
        'function confirmDigest(bytes32 listingId, uint64 bondDeposit, uint32 balance, uint40 readAt) view returns (bytes32)',
        'function confirmRemainder(bytes32 listingId, uint32 balance, uint40 readAt, bytes sig) nonpayable',
        'function contestRemainder(uint256 id, bytes32 reasonHash) nonpayable',
        `function coreHashOf(${TERMS} t) view returns (bytes32)`,
        `function depositAndOpen(${TERMS} t, bytes32 envelopeHash, uint32 usedCents, ${TICKET} k) nonpayable returns (uint256 id)`,
        'function depositCount() view returns (uint256)',
        'function dispute(uint256 id, bytes32 reasonHash) nonpayable',
        'function domainSeparator() view returns (bytes32)',
        'function gate(bytes32 listingId, uint256 depositId) view returns (address signer, address tokenAddress, address listingSeller, uint8 listingState, uint8 depositState, bytes32 depositListingId, bytes32 replyKeyHash, address depositor, uint32 remainingCents, uint16 sales, uint64 bondDeposit)',
        'function getDeposit(uint256 id) view returns ((address depositor, uint40 openedAt, uint40 releaseAt, uint8 state, bool disputed, address seller, uint96 amount, bytes32 listingId, bytes32 replyKeyHash, bytes32 cardTag, uint32 usedCents, uint32 leftAfterCents, uint16 saleIndex, uint64 bond, uint8 bondState, uint64 covers, uint40 contestUntil))',
        'function getListing(bytes32 listingId) view returns ((address seller, uint8 state, uint40 createdAt, uint32 remainingCents, uint16 sales, uint64 bondDeposit, uint40 bondSince, uint40 confirmedAt, uint64 lastDeposit, uint8 mode))',
        `function keepRest(${TERMS} t, bytes32 envelopeHash, uint256 id) nonpayable`,
        'function list(bytes32 commitment) nonpayable returns (bytes32 listingId)',
        'function listingIdOf(address seller, bytes32 commitment) pure returns (bytes32)',
        'function litSigner() view returns (address)',
        `function openDigest(bytes32 listingId, address depositor, ${TICKET} k) view returns (bytes32)`,
        'function owed(address) view returns (uint256)',
        'function priceFor(uint256 price, uint256 valueCents, uint256 usedCents, uint256 haircutBps) pure returns (uint256)',
        `function reduceUse(${TERMS} t, bytes32 envelopeHash, uint256 id, uint32 newUsedCents) nonpayable`,
        'function rekey(uint256 id, bytes32 replyKeyHash) nonpayable',
        'function release(uint256 id) nonpayable',
        'function releaseBond(uint256 id) nonpayable',
        'function sellerCloseRemainder(bytes32 listingId, bool spent) nonpayable',
        'function sellerRefund(uint256 id, uint96 refundAmount) nonpayable',
        'function sellerStats(address) view returns (uint32 sold, uint32 disputes, uint32 refunds, uint96 paidOut, uint32 remaindersShort, uint32 bondsClaimed)',
        'function token() view returns (address)',
      ].sort(),
    )
    // gate() is 11 static words: one eth_call, within the template's 3-call batches.
    const g = ESCROW_V2_ABI.find((i) => i.type === 'function' && i.name === 'gate')
    expect(g && 'outputs' in g ? g.outputs.length : 0).toBe(11)
  })
})

// --------------------------------------------------------------------------------------------
describe('constructor, constants and hashes', () => {
  it('refuses a zero signer, a token with no code, and a token whose decimals are not 6', async () => {
    const chain = await TestChain.create({ timestamp: T0 })
    const token6 = await deployMockToken(chain, DEPLOYER, 6)
    const token18 = await deployMockToken(chain, DEPLOYER, 18)
    const res = (signer: Hex, token: Hex) => chain.deployResult(DEPLOYER, v2InitCode(signer, token))
    expect((await res(zeroAddress, token6)).revert).toBe('signer')
    expect((await res(LIT.address, testAddress(99))).revert).toBe('token')
    expect((await res(LIT.address, token18)).revert).toBe('decimals')
    const escrow = await deployV2(chain, LIT.address, token6)
    expect((await res(LIT.address, escrow)).revert).toBe('decimals')
  })

  it('has the same runtime code hash whatever the constructor arguments, equal to RUNTIME_KECCAK_V2', async () => {
    const chain = await TestChain.create({ timestamp: T0 })
    const tokenA = await deployMockToken(chain, DEPLOYER)
    const tokenB = await deployMockToken(chain, DEPLOYER)
    const a = await deployV2(chain, LIT.address, tokenA)
    const b = await deployV2(chain, ROGUE.address, tokenB)
    expect(await chain.codeHash(a)).toBe(RUNTIME_KECCAK_V2)
    expect(await chain.codeHash(b)).toBe(RUNTIME_KECCAK_V2)
    expect(keccak256(ESCROW_V2_RUNTIME_BYTECODE)).toBe(RUNTIME_KECCAK_V2)
    const reader = readerFor(chain)
    expect(lower(await reader.readContract({ address: b, abi: ESCROW_V2_ABI, functionName: 'litSigner' }))).toBe(lower(ROGUE.address))
    expect(lower(await reader.readContract({ address: b, abi: ESCROW_V2_ABI, functionName: 'token' }))).toBe(tokenB)
  })

  it('keeps V1 constants and adds the V2 ones', async () => {
    const env = await setup()
    const r = env.reader
    const ask = { address: env.escrow, abi: ESCROW_V2_ABI } as const
    expect(await r.readContract({ ...ask, functionName: 'VERSION' })).toBe('salvo-escrow/2')
    expect(await r.readContract({ ...ask, functionName: 'RELEASE_DELAY' })).toBe(RELEASE_DELAY)
    expect(await r.readContract({ ...ask, functionName: 'DISPUTE_HOLD' })).toBe(DISPUTE_HOLD)
    expect(await r.readContract({ ...ask, functionName: 'MAX_TICKET_TTL' })).toBe(MAX_TICKET_TTL)
    expect(await r.readContract({ ...ask, functionName: 'MAX_VALUE_CENTS' })).toBe(50_000n)
    expect(await r.readContract({ ...ask, functionName: 'NEW_SELLER_BLIND_CAP_CENTS' })).toBe(2_500n)
    expect(await r.readContract({ ...ask, functionName: 'UNITS_PER_CENT' })).toBe(UNITS_PER_CENT)
    expect(await r.readContract({ ...ask, functionName: 'CONTEST_WINDOW' })).toBe(CONTEST_WINDOW)
    expect(await r.readContract({ ...ask, functionName: 'BOND_REVIEW_AFTER' })).toBe(BOND_REVIEW_AFTER)
    expect(await r.readContract({ ...ask, functionName: 'BOND_MAX_AGE' })).toBe(BOND_MAX_AGE)
    expect(await r.readContract({ ...ask, functionName: 'CAP_BLIND' })).toBe(500n)
    expect(await r.readContract({ ...ask, functionName: 'CAP_READABLE' })).toBe(1_000n)
    expect(await r.readContract({ ...ask, functionName: 'CONFIRM_DELAY' })).toBe(CONFIRM_DELAY)
    expect([
      await r.readContract({ ...ask, functionName: 'LISTING_ACTIVE' }),
      await r.readContract({ ...ask, functionName: 'LISTING_DRAINED' }),
      await r.readContract({ ...ask, functionName: 'LISTING_CANCELLED' }),
      await r.readContract({ ...ask, functionName: 'LISTING_SPENT' }),
      await r.readContract({ ...ask, functionName: 'DEPOSIT_OPENED' }),
      await r.readContract({ ...ask, functionName: 'DEPOSIT_RELEASED' }),
      await r.readContract({ ...ask, functionName: 'DEPOSIT_REFUNDED' }),
      await r.readContract({ ...ask, functionName: 'DEPOSIT_CONTESTED' }),
      await r.readContract({ ...ask, functionName: 'BOND_NONE' }),
      await r.readContract({ ...ask, functionName: 'BOND_HELD' }),
      await r.readContract({ ...ask, functionName: 'BOND_RETURNED' }),
      await r.readContract({ ...ask, functionName: 'BOND_FORFEITED' }),
    ]).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 0, 1, 2, 3])
  })

  it('hashes terms, listings, tickets and confirms the way viem and the EIP-712 standard do, under domain version 2', async () => {
    const env = await setup()
    const r = env.reader
    const ask = { address: env.escrow, abi: ESCROW_V2_ABI } as const
    expect(await r.readContract({ ...ask, functionName: 'TERMS_TYPEHASH' })).toBe(typeId(TERMS_TYPE))
    expect(await r.readContract({ ...ask, functionName: 'LISTING_TYPEHASH' })).toBe(typeId(LISTING_TYPE))
    expect(await r.readContract({ ...ask, functionName: 'OPEN_TYPEHASH' })).toBe(typeId(OPEN_TYPE))
    expect(await r.readContract({ ...ask, functionName: 'CONFIRM_TYPEHASH' })).toBe(typeId(CONFIRM_TYPE))
    const t = terms(env, { mode: MODE_READABLE, residualCapCents: 250, remainderHaircutBps: 1_234, merchant: 1, valueCents: 4_321 })
    const eh = fresh32('envelope')
    expect(await r.readContract({ ...ask, functionName: 'coreHashOf', args: [t] })).toBe(coreHash(env.chain.chainId, env.escrow, env.token, t))
    const c = commitmentOf(env.chain.chainId, env.escrow, env.token, t, eh)
    expect(await r.readContract({ ...ask, functionName: 'commitmentOf', args: [t, eh] })).toBe(c)
    expect(await r.readContract({ ...ask, functionName: 'listingIdOf', args: [SELLER, c] })).toBe(listingIdOf(SELLER, c))
    // The haircut is part of the terms: a different haircut is a different listing.
    expect(coreHash(env.chain.chainId, env.escrow, env.token, { ...t, remainderHaircutBps: 1_235 })).not.toBe(coreHash(env.chain.chainId, env.escrow, env.token, t))
    const f: OpenFields = {
      listingId: fresh32('l'),
      depositor: BUYER,
      replyKeyHash: fresh32('r'),
      openBalanceCents: 4_321,
      cardTag: fresh32('t'),
      remainingCents: 4_000,
      sales: 3,
      notAfter: now(env) + 300,
    }
    const k: Ticket = { ...f, signature: '0x' }
    expect(await r.readContract({ ...ask, functionName: 'openDigest', args: [f.listingId, f.depositor, k] })).toBe(openDigest(env.chain.chainId, env.escrow, f))
    const cf: ConfirmFields = { listingId: fresh32('l'), bondDeposit: 7n, balance: 321, readAt: now(env) - 5 }
    expect(await r.readContract({ ...ask, functionName: 'confirmDigest', args: [cf.listingId, cf.bondDeposit, cf.balance, cf.readAt] })).toBe(
      confirmDigest(env.chain.chainId, env.escrow, cf),
    )
    // Domain version "2": a V1 ticket digest for the same fields can never verify here.
    const ds = await r.readContract({ ...ask, functionName: 'domainSeparator' })
    expect(ds).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
          [typeId('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), typeId('SalvoEscrow'), typeId('2'), env.chain.chainId, env.escrow],
        ),
      ),
    )
  })

  it('priceFor: ceil(used x price x (1 - haircut) / value), equal to legCostCents with no haircut, never above face', async () => {
    const env = await setup()
    const legCostCents = loadLegCostCents()
    let seed = 12345
    const rand = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % n
    }
    for (let i = 0; i < 60; i++) {
      const valueCents = 1 + rand(50_000)
      const price = 1n + BigInt(rand(valueCents * 10_000))
      const used = rand(valueCents + 1)
      const h = rand(10_000)
      const got = await priceFor(env, price, valueCents, used)
      expect(got, `used ${used} of ${valueCents} at ${price}`).toBe(BigInt(legCostCents(used, Number(price), valueCents)))
      // Exact rational ceiling, in bigint, for the haircut.
      const n = BigInt(used) * price * BigInt(10_000 - h)
      const q = BigInt(valueCents) * 10_000n
      const want = n === 0n ? 0n : (n - 1n) / q + 1n
      expect(await priceFor(env, price, valueCents, used, h)).toBe(want)
      expect(want).toBeLessThanOrEqual(BigInt(used) * UNITS_PER_CENT)
    }
    // Rounds up, never down: 1 cent of a 3-cent card sold for 10 units is 4 units.
    expect(await priceFor(env, 10n, 3, 1)).toBe(4n)
    expect(legCostCents(1, 10, 3)).toBe(4)
    // Guards: a zero value or a 100% haircut is refused.
    const bad = async (args: readonly [bigint, bigint, bigint, bigint]) =>
      env.chain.call(STRANGER, env.escrow, encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'priceFor', args }))
    expectRevert(await bad([1n, 0n, 1n, 0n]), 'price args')
    expectRevert(await bad([1n, 1n, 1n, 10_000n]), 'price args')
  })
})

// --------------------------------------------------------------------------------------------
describe('list and cancelListing', () => {
  it('keys the listing id to msg.sender; refuses a zero or reused commitment', async () => {
    const env = await setup()
    const t = terms(env)
    const eh = fresh32('envelope')
    const c = commitmentOf(env.chain.chainId, env.escrow, env.token, t, eh)
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.list(c))
    expect(escrowEvents(env, r)).toEqual([{ eventName: 'Listed', args: { listingId: listingIdOf(SELLER, c), seller: expect.stringMatching(new RegExp(SELLER.slice(2), 'i')), commitment: c } }])
    const l = await listing(env, listingIdOf(SELLER, c))
    expect({ seller: lower(l.seller), state: l.state, createdAt: l.createdAt, remainingCents: l.remainingCents, sales: l.sales }).toEqual({
      seller: SELLER,
      state: LISTING.ACTIVE,
      createdAt: now(env),
      remainingCents: 0,
      sales: 0,
    })
    // A copied commitment is the copier's own listing, which SELLER's terms can never open.
    await mustSend(env.chain, STRANGER, env.escrow, v2.list(c))
    expect(listingIdOf(STRANGER, c)).not.toBe(listingIdOf(SELLER, c))
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.list(ZERO32)), 'commitment')
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.list(c)), 'exists')
  })

  it('cancelListing: seller only, Active only; an unsold listing just closes', async () => {
    const env = await setup()
    const l = await listed(env)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.cancelListing(l.listingId)), 'not seller')
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.cancelListing(fresh32('nope'))), 'not seller')
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.cancelListing(l.listingId))
    expect(escrowEvents(env, r).map((e) => e.eventName)).toEqual(['ListingCancelled'])
    expect(transfers(env, r)).toEqual([])
    expect((await listing(env, l.listingId)).state).toBe(LISTING.CANCELLED)
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.cancelListing(l.listingId)), 'not active')
    expectRevert(await tryOpen(env, l, 2_000, await ticketFor(env, l)), 'listing not active')
    // A drained listing has nothing to cancel.
    const d = await listed(env)
    await buy(env, d, 2_000)
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.cancelListing(d.listingId)), 'not active')
  })

  it('the seller marks a remainder "I used it myself": the deposit goes back and the card is free to list again', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    expect(await cardOf(env, l.tag)).toEqual({ owner: zeroAddress, deposit: 0n, listing: l.listingId })
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.cancelListing(l.listingId))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 3_000_000n }])
    expect(escrowEvents(env, r).map((e) => e.eventName)).toEqual(['BondReturned', 'ListingCancelled'])
    expect(await deposit(env, a.id)).toMatchObject({ bond: 0n, bondState: BOND.RETURNED, state: DEPOSIT.OPENED, amount: 15_300_000n })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.CANCELLED, bondDeposit: 0n })
    expect((await cardOf(env, l.tag)).listing).toBe(ZERO32)
    // The sale itself still pays the seller on schedule.
    env.chain.advance(RELEASE_DELAY)
    const paid = await mustSend(env.chain, STRANGER, env.escrow, v2.release(a.id))
    expect(transfers(env, paid)).toEqual([{ from: env.escrow, to: SELLER, value: 15_300_000n }])
    // The same physical card, listed afresh, sells.
    const again = await listed(env, { valueCents: 300, price: 2_700_000n }, l.tag)
    await buy(env, again, 300, BUYER2)
    expect(await balanceOf(env, env.escrow)).toBe(2_700_000n)
  })
})

// --------------------------------------------------------------------------------------------
describe('depositAndOpen: terms', () => {
  it('refuses an unknown mode, a value outside 1 to 50,000 cents, and a price outside 1 to value x 10,000', async () => {
    const env = await setup()
    for (const mode of [0, 3, 255]) {
      const l = await listed(env, { mode })
      expectRevert(await tryOpen(env, l, 2_000, await ticketFor(env, l)), 'mode')
    }
    for (const valueCents of [0, 50_001]) {
      const l = await listedReadable(env, { valueCents, price: 1n })
      expectRevert(await tryOpen(env, l, 1, await ticketFor(env, l)), 'value')
    }
    const top = await listedReadable(env, { valueCents: 50_000, price: 1n })
    expectOk(await tryOpen(env, top, 50_000, await ticketFor(env, top)))
    const zero = await listed(env, { price: 0n })
    expectRevert(await tryOpen(env, zero, 2_000, await ticketFor(env, zero)), 'price')
    const over = await listed(env, { price: 2_000n * UNITS_PER_CENT + 1n })
    expectRevert(await tryOpen(env, over, 2_000, await ticketFor(env, over)), 'price')
    const edge = await listed(env, { price: 2_000n * UNITS_PER_CENT })
    expectOk(await tryOpen(env, edge, 2_000, await ticketFor(env, edge)))
  })

  it('bounds the residual cap by mode: 500 cents blind, 1,000 readable', async () => {
    const env = await setup()
    const blindOver = await listed(env, { residualCapCents: 501 })
    expectRevert(await tryOpen(env, blindOver, 2_000, await ticketFor(env, blindOver)), 'cap')
    const blindEdge = await listed(env, { residualCapCents: 500 })
    expectOk(await tryOpen(env, blindEdge, 1_500, await ticketFor(env, blindEdge)))
    const readOver = await listedReadable(env, { residualCapCents: 1_001 })
    expectRevert(await tryOpen(env, readOver, 2_000, await ticketFor(env, readOver)), 'cap')
    const readEdge = await listedReadable(env, { residualCapCents: 1_000 })
    expectOk(await tryOpen(env, readEdge, 1_000, await ticketFor(env, readEdge, { openBalanceCents: 3_000 })))
  })

  it('bounds the haircut below 100%, so every sale pays its seller something', async () => {
    const env = await setup()
    const full = await listed(env, { remainderHaircutBps: 10_000 })
    expectRevert(await tryOpen(env, full, 2_000, await ticketFor(env, full)), 'haircut')
    const edge = await listed(env, { remainderHaircutBps: 9_999 })
    expectOk(await tryOpen(env, edge, 2_000, await ticketFor(env, edge)))
  })

  it('refuses at and after the listing expiry, the own listing, and terms that hash to no Active listing', async () => {
    const env = await setup()
    const l = await listed(env, { listingExpiry: now(env) + 10 })
    env.chain.setTime(BigInt(l.t.listingExpiry - 1))
    expectOk(await tryOpen(env, l, 2_000, await ticketFor(env, l)))
    env.chain.setTime(BigInt(l.t.listingExpiry))
    expectRevert(await tryOpen(env, l, 2_000, await ticketFor(env, l)), 'listing expired')

    const mine = await listed(env)
    expectRevert(await tryOpen(env, mine, 2_000, await ticketFor(env, mine, { depositor: SELLER }), SELLER), 'own listing')
    const ghost: Listed = { ...mine, listingId: fresh32('id'), envelopeHash: fresh32('e') }
    expectRevert(await tryOpen(env, ghost, 2_000, await ticketFor(env, ghost)), 'listing not active')
    const repriced: Listed = { ...mine, t: { ...mine.t, price: mine.t.price - 1n } }
    expectRevert(await tryOpen(env, repriced, 2_000, await ticketFor(env, mine)), 'listing not active')
    const drained = await listed(env)
    await buy(env, drained, 2_000)
    expectRevert(await tryOpen(env, drained, 1, await ticketFor(env, drained, { depositor: BUYER2 }), BUYER2), 'listing not active')
  })

  it('caps a blind card above $25 until its seller has been paid at least its value, as V1', async () => {
    const env = await setup()
    const big = { valueCents: 2_501, price: 2_501n * 9_000n, residualCapCents: 0 }
    const capped = await listed(env, big)
    expectRevert(await tryOpen(env, capped, 2_501, await ticketFor(env, capped)), 'new seller cap')
    const readable = await listedReadable(env, big)
    expectOk(await tryOpen(env, readable, 2_501, await ticketFor(env, readable)))
    // Paid out exactly 2,501 cents' worth: uncapped. An Opened sale is not paid.
    const s = await buy(env, await listed(env, { valueCents: 2_500, price: 25_000_000n, residualCapCents: 0 }), 2_500, BUYER2)
    const s2 = await buy(env, await listed(env, { valueCents: 1, price: 10_000n, residualCapCents: 0 }), 1, BUYER2)
    expectRevert(await tryOpen(env, capped, 2_501, await ticketFor(env, capped)), 'new seller cap')
    env.chain.advance(RELEASE_DELAY)
    await mustSend(env.chain, STRANGER, env.escrow, v2.release(s.id))
    expectRevert(await tryOpen(env, capped, 2_501, await ticketFor(env, capped)), 'new seller cap')
    await mustSend(env.chain, STRANGER, env.escrow, v2.release(s2.id))
    expect((await stats(env, SELLER)).paidOut).toBe(2_501n * UNITS_PER_CENT)
    expectOk(await tryOpen(env, capped, 2_501, await ticketFor(env, capped)))
  })
})

// --------------------------------------------------------------------------------------------
describe('depositAndOpen: the ticket', () => {
  it('refuses a zero reply key hash and a zero card tag', async () => {
    const env = await setup()
    const l = await listed(env)
    expectRevert(await tryOpen(env, l, 2_000, await ticketFor(env, l, { replyKeyHash: ZERO32 })), 'reply key')
    expectRevert(await tryOpen(env, l, 2_000, await ticketFor(env, l, { cardTag: ZERO32 })), 'card tag')
  })

  it('binds the value left and the sales count: a ticket from before the last sale reverts', async () => {
    const env = await setup()
    const l = await listed(env)
    const early = await ticketFor(env, l, { depositor: BUYER2 })
    expect({ remainingCents: early.remainingCents, sales: early.sales }).toEqual({ remainingCents: 2_000, sales: 0 })
    expectOk(await tryOpen(env, l, 2_000, early, BUYER2))
    await buy(env, l, 1_700)
    expectRevert(await tryOpen(env, l, 300, early, BUYER2), 'stale ticket')
    const k = await ticketFor(env, l, { depositor: BUYER2 })
    expect({ remainingCents: k.remainingCents, sales: k.sales }).toEqual({ remainingCents: 300, sales: 1 })
    expectRevert(await tryOpen(env, l, 300, { ...k, remainingCents: 299 }, BUYER2), 'stale ticket')
    expectRevert(await tryOpen(env, l, 300, { ...k, sales: 2 }, BUYER2), 'stale ticket')
    // Each is signed: a stale ticket patched to today's numbers no longer verifies.
    expectRevert(await tryOpen(env, l, 300, { ...early, remainingCents: 300, sales: 1 }, BUYER2), 'not lit')
    expectOk(await tryOpen(env, l, 300, k, BUYER2))
  })

  it("lets only the card's owner sell it: no double sale, and a buyer resells once paid out", async () => {
    const env = await setup()
    const tag = fresh32('card')
    const first = await listed(env, {}, tag)
    const s = await buy(env, first, 2_000, BUYER)
    expect(await cardOf(env, tag)).toEqual({ owner: BUYER, deposit: s.id, listing: ZERO32 })
    const again = await listed(env, {}, tag)
    expectRevert(await tryOpen(env, again, 2_000, await ticketFor(env, again, { depositor: BUYER2 }), BUYER2), "card not seller's")
    const early = await listed(env, { seller: BUYER }, tag)
    expectRevert(await tryOpen(env, early, 2_000, await ticketFor(env, early, { depositor: BUYER2 }), BUYER2), 'card not paid out')
    env.chain.advance(RELEASE_DELAY)
    await mustSend(env.chain, STRANGER, env.escrow, v2.release(s.id))
    const resold = await buy(env, early, 2_000, BUYER2)
    expect(await cardOf(env, tag)).toEqual({ owner: BUYER2, deposit: resold.id, listing: ZERO32 })
  })

  it('one live listing per physical card, and a remainder sells only under the card it began with', async () => {
    const env = await setup()
    const tag = fresh32('card')
    const a = await listed(env, {}, tag)
    const b = await listed(env, {}, tag)
    // Both unsold: either may sell first.
    expectOk(await tryOpen(env, b, 2_000, await ticketFor(env, b)))
    await buy(env, a, 1_700)
    expect((await cardOf(env, tag)).listing).toBe(a.listingId)
    // A has a remainder on sale: the same card under B is refused, partly or whole.
    expectRevert(await tryOpen(env, b, 2_000, await ticketFor(env, b, { depositor: BUYER2 }), BUYER2), 'card listed')
    expectRevert(await tryOpen(env, b, 1_700, await ticketFor(env, b, { depositor: BUYER2 }), BUYER2), 'card listed')
    // A's remainder under another tag is refused: Lit's tag for this listing never changes.
    expectRevert(await tryOpen(env, a, 300, await ticketFor(env, a, { depositor: BUYER2, cardTag: fresh32('other') }), BUYER2), 'card listed')
    expectOk(await tryOpen(env, a, 300, await ticketFor(env, a, { depositor: BUYER2 }), BUYER2))
  })

  it('accepts a ticket up to and including notAfter, at most 15 minutes ahead', async () => {
    const env = await setup()
    const l = await listed(env)
    const k = await ticketFor(env, l, { notAfter: now(env) + 5 })
    env.chain.setTime(BigInt(k.notAfter))
    expectOk(await tryOpen(env, l, 2_000, k))
    env.chain.setTime(BigInt(k.notAfter + 1))
    expectRevert(await tryOpen(env, l, 2_000, k), 'ticket time')
    expectOk(await tryOpen(env, l, 2_000, await ticketFor(env, l, { notAfter: now(env) + Number(MAX_TICKET_TTL) })))
    expectRevert(await tryOpen(env, l, 2_000, await ticketFor(env, l, { notAfter: now(env) + Number(MAX_TICKET_TTL) + 1 })), 'ticket time')
  })

  it('readable: R <= balance <= R + cap at the exact edges, first sale and remainder alike; blind: balance 0', async () => {
    const env = await setup()
    const l = await listedReadable(env, { residualCapCents: 500 })
    const at = async (openBalanceCents: number, used = 2_000) => tryOpen(env, l, used, await ticketFor(env, l, { openBalanceCents }))
    expectRevert(await at(1_999), 'balance')
    expectOk(await at(2_000))
    expectOk(await at(2_500))
    expectRevert(await at(2_501), 'balance')
    expectRevert(await at(0), 'balance')
    await buy(env, l, 1_600)
    const rem = async (openBalanceCents: number) => tryOpen(env, l, 400, await ticketFor(env, l, { depositor: BUYER2, openBalanceCents }), BUYER2)
    expectRevert(await rem(399), 'balance')
    expectOk(await rem(400))
    expectOk(await rem(900))
    expectRevert(await rem(901), 'balance')
    const blind = await listed(env)
    expectRevert(await tryOpen(env, blind, 2_000, await ticketFor(env, blind, { openBalanceCents: 1 })), 'blind balance')
  })

  it('refuses a ticket from any key but litSigner, its high-s twin, a bad v, a bad length, and r = 0', async () => {
    const env = await setup()
    const l = await listed(env)
    expectRevert(await tryOpen(env, l, 2_000, await ticketFor(env, l, {}, { signer: ROGUE })), 'not lit')
    const k = await ticketFor(env, l)
    const twin = highS(k.signature)
    const digest = openDigest(env.chain.chainId, env.escrow, {
      listingId: l.listingId,
      depositor: BUYER,
      replyKeyHash: k.replyKeyHash,
      openBalanceCents: k.openBalanceCents,
      cardTag: k.cardTag,
      remainingCents: k.remainingCents,
      sales: k.sales,
      notAfter: k.notAfter,
    })
    const input = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [digest, parseInt(twin.slice(130, 132), 16), `0x${twin.slice(2, 66)}`, `0x${twin.slice(66, 130)}`],
    )
    const rec = await env.chain.call(BUYER, ECRECOVER, input)
    expect(lower(`0x${rec.returnData.slice(26)}`)).toBe(lower(LIT.address))
    expectRevert(await tryOpen(env, l, 2_000, { ...k, signature: twin }), 'sig s')
    expectRevert(await tryOpen(env, l, 2_000, { ...k, signature: withV(k.signature, 0) }), 'sig v')
    expectRevert(await tryOpen(env, l, 2_000, { ...k, signature: withV(k.signature, 1) }), 'sig v')
    expectRevert(await tryOpen(env, l, 2_000, { ...k, signature: `0x${k.signature.slice(2, 130)}` }), 'sig length')
    expectRevert(await tryOpen(env, l, 2_000, { ...k, signature: `${k.signature}00` }), 'sig length')
    expectRevert(await tryOpen(env, l, 2_000, { ...k, signature: `0x${'00'.repeat(32)}${k.signature.slice(66)}` }), 'sig')
    expectOk(await tryOpen(env, l, 2_000, k))
  })

  it('binds every signed field, the depositor, the listing, the escrow, the chain, and domain version 2', async () => {
    const env = await setup()
    const l = await listed(env)
    const forOther = await ticketFor(env, l, { depositor: BUYER2 })
    expectRevert(await tryOpen(env, l, 2_000, forOther, BUYER), 'not lit')
    expectOk(await tryOpen(env, l, 2_000, forOther, BUYER2))
    const other = await listed(env, {}, l.tag)
    expectRevert(await tryOpen(env, other, 2_000, await ticketFor(env, l)), 'not lit')
    const k = await ticketFor(env, l)
    expectRevert(await tryOpen(env, l, 2_000, { ...k, replyKeyHash: fresh32('swap') }), 'not lit')
    expectRevert(await tryOpen(env, l, 2_000, { ...k, cardTag: fresh32('swap') }), 'not lit')
    expectRevert(await tryOpen(env, l, 2_000, { ...k, notAfter: k.notAfter - 1 }), 'not lit')
    const rl = await listedReadable(env, { residualCapCents: 100 })
    const rk = await ticketFor(env, rl, { openBalanceCents: 2_050 })
    expectRevert(await tryOpen(env, rl, 2_000, { ...rk, openBalanceCents: 2_000 }), 'not lit')
    expectOk(await tryOpen(env, rl, 2_000, rk))
    // Another escrow instance on this chain.
    expectRevert(await tryOpen(env, l, 2_000, await ticketFor(env, l, {}, { escrow: testAddress(55) })), 'not lit')
    // Another chain, even at the same escrow address.
    const away = await setup({ chainId: 4_217n })
    expect(away.escrow).toBe(env.escrow)
    const la = await listed(away)
    expectRevert(await tryOpen(away, la, 2_000, await ticketFor(away, la, {}, { chainId: env.chain.chainId })), 'not lit')
    expectOk(await tryOpen(away, la, 2_000, await ticketFor(away, la)))
    // A V1 ticket (domain version "1", type Open without remainingCents and sales) for the
    // same listing id, depositor and fields never verifies on V2.
    const v1Ticket = await signTicketV1(LIT, env.chain.chainId, env.escrow, {
      listingId: l.listingId,
      depositor: BUYER,
      replyKeyHash: k.replyKeyHash,
      openBalanceCents: 0,
      cardTag: l.tag,
      notAfter: k.notAfter,
    })
    expectRevert(await tryOpen(env, l, 2_000, { ...k, signature: v1Ticket.signature }), 'not lit')
  })
})

// --------------------------------------------------------------------------------------------
describe('SalvoEscrowV1 is not consulted', () => {
  /**
   * Sells `tag` on V1 to `buyer`, so V1's cardOwner names them. The tag here is hand-made and
   * shared with the V2 listing below, which no real Lit run can produce: each template keys its
   * tags with its own CID-derived key (tests/lit-escrow-v2-template.test.ts shows the two tags
   * for one card differ). Even this best case for a V1 check finds none.
   */
  async function soldOnV1(env: Env, tag: Hex, buyer: Hex): Promise<void> {
    const t: TermsV1 = {
      seller: SELLER2,
      price: 4_400_000n,
      valueCents: 500,
      residualCapCents: 0,
      merchant: 9,
      mode: MODE_BLIND,
      listingExpiry: now(env) + 86_400,
      salt: fresh32('salt'),
    }
    const eh = fresh32('envelope')
    const c = commitmentOfV1(env.chain.chainId, V1_ADDRESS, env.token, t, eh)
    await mustSend(env.chain, SELLER2, V1_ADDRESS, v1Call.list(c))
    const k = await signTicketV1(LIT, env.chain.chainId, V1_ADDRESS, {
      listingId: listingIdOf(SELLER2, c),
      depositor: buyer,
      replyKeyHash: fresh32('reply'),
      openBalanceCents: 0,
      cardTag: tag,
      notAfter: now(env) + 600,
    })
    await mustSend(env.chain, buyer, V1_ADDRESS, v1Call.depositAndOpen(t, eh, k))
    const owner = await env.reader.readContract({ address: V1_ADDRESS, abi: ESCROW_V1_ABI, functionName: 'cardOwner', args: [tag] })
    expect(lower(owner)).toBe(buyer)
  }

  it("never reads V1's cardOwner: no V2 tag is ever a V1 tag, so the check could only cost gas and claim a protection it lacks", async () => {
    const env = await setup()
    const tag = fresh32('card')
    await soldOnV1(env, tag, BUYER3)
    // V1 names BUYER3, yet SELLER's V2 listing of that tag sells: V2 decides from its own records.
    const seller = await listed(env, {}, tag)
    expectOk(await tryOpen(env, seller, 2_000, await ticketFor(env, seller)))
    const theirs = await listed(env, { seller: BUYER3 }, tag)
    expectOk(await tryOpen(env, theirs, 2_000, await ticketFor(env, theirs)))
    // No V1 getter and no V1 address in the ABI or bytes (the bytes test checks the address).
    const names: string[] = ESCROW_V2_ABI.map((i) => ('name' in i ? i.name : i.type))
    expect(names).not.toContain('V1')
    // V2's own card records still stop a double sale here.
    await buy(env, seller, 2_000)
    expectRevert(await tryOpen(env, theirs, 2_000, await ticketFor(env, theirs, { depositor: BUYER2 }), BUYER2), "card not seller's")
  })

  it('whatever sits at the V1 address, code that is no escrow or none at all, changes nothing', async () => {
    for (const v1 of ['none', 'not-an-escrow'] as const) {
      const env = await setup({ v1 })
      if (v1 === 'none') expect(await env.chain.getCode(V1_ADDRESS)).toBe('0x')
      const l = await listed(env)
      expectOk(await tryOpen(env, l, 2_000, await ticketFor(env, l)))
    }
  })
})

// --------------------------------------------------------------------------------------------
describe('depositAndOpen: the value used', () => {
  it('0 < used <= R, and the cents left fit the cap, at the exact edges', async () => {
    const env = await setup()
    const l = await listed(env)
    const k = await ticketFor(env, l)
    expectRevert(await tryOpen(env, l, 0, k), 'used')
    expectRevert(await tryOpen(env, l, 2_001, k), 'used')
    expectOk(await tryOpen(env, l, 2_000, k))
    expectOk(await tryOpen(env, l, 1_500, k))
    expectRevert(await tryOpen(env, l, 1_499, k), 'left')
    // No cap, no leftover: the card is used whole.
    const whole = await listed(env, { residualCapCents: 0 })
    const kw = await ticketFor(env, whole)
    expectRevert(await tryOpen(env, whole, 1_999, kw), 'left')
    expectOk(await tryOpen(env, whole, 2_000, kw))
    // On a remainder, R is what is left.
    await buy(env, l, 1_700)
    const k2 = await ticketFor(env, l, { depositor: BUYER2 })
    expectRevert(await tryOpen(env, l, 301, k2, BUYER2), 'used')
  })

  it('a remainder another buyer deposited for is used whole; its own holder may use part of it', async () => {
    const env = await setup()
    const l = await listed(env)
    await buy(env, l, 1_700)
    const other = await ticketFor(env, l, { depositor: BUYER2 })
    expectRevert(await tryOpen(env, l, 200, other, BUYER2), 'remainder whole')
    expectRevert(await tryOpen(env, l, 1, other, BUYER2), 'remainder whole')
    expectOk(await tryOpen(env, l, 300, other, BUYER2))
    expectOk(await tryOpen(env, l, 1, await ticketFor(env, l, { depositor: BUYER }), BUYER))
  })
})

// --------------------------------------------------------------------------------------------
describe('depositAndOpen: the money and the records', () => {
  it('a partial first sale pulls the price of the cents used plus the cents left at face, in one transfer', async () => {
    const env = await setup()
    const l = await listed(env)
    const k = await ticketFor(env, l)
    const before = await balanceOf(env, BUYER)
    const r = await open(env, l, 1_700, k)
    expectOk(r)
    // 1,700 cents at 9,000 units a cent, plus 300 cents at 10,000.
    expect(transfers(env, r)).toEqual([{ from: BUYER, to: env.escrow, value: 15_300_000n + 3_000_000n }])
    expect(await balanceOf(env, BUYER)).toBe(before - 18_300_000n)
    expect(await priceFor(env, l.t.price, l.t.valueCents, 1_700)).toBe(15_300_000n)
    const d = await deposit(env, 1n)
    expect({ ...d, depositor: lower(d.depositor), seller: lower(d.seller) }).toEqual({
      depositor: BUYER,
      openedAt: now(env),
      releaseAt: now(env) + Number(RELEASE_DELAY),
      state: DEPOSIT.OPENED,
      disputed: false,
      seller: SELLER,
      amount: 15_300_000n,
      listingId: l.listingId,
      replyKeyHash: k.replyKeyHash,
      cardTag: l.tag,
      usedCents: 1_700,
      leftAfterCents: 300,
      saleIndex: 0,
      bond: 3_000_000n,
      bondState: BOND.HELD,
      covers: 0n,
      contestUntil: 0,
    })
    const li = await listing(env, l.listingId)
    expect({ ...li, seller: lower(li.seller) }).toEqual({
      seller: SELLER,
      state: LISTING.ACTIVE,
      createdAt: now(env),
      remainingCents: 300,
      sales: 1,
      bondDeposit: 1n,
      bondSince: now(env),
      confirmedAt: 0,
      lastDeposit: 1n,
      mode: MODE_BLIND,
    })
    expect(await cardOf(env, l.tag)).toEqual({ owner: zeroAddress, deposit: 0n, listing: l.listingId })
    expect(escrowEvents(env, r)).toEqual([
      {
        eventName: 'Opened',
        args: {
          depositId: 1n,
          listingId: l.listingId,
          depositor: expect.stringMatching(new RegExp(BUYER.slice(2), 'i')),
          cardTag: l.tag,
          openBalanceCents: 0,
          releaseAt: now(env) + Number(RELEASE_DELAY),
        },
      },
      { eventName: 'Used', args: { listingId: l.listingId, depositId: 1n, usedCents: 1_700, leftCents: 300, bond: 3_000_000n } },
    ])
    expect(await gate(env, l.listingId, 1n)).toEqual({
      signer: lower(LIT.address),
      token: env.token,
      listingSeller: SELLER,
      listingState: LISTING.ACTIVE,
      depositState: DEPOSIT.OPENED,
      depositListingId: l.listingId,
      replyKeyHash: k.replyKeyHash,
      depositor: BUYER,
      remainingCents: 300,
      sales: 1,
      bondDeposit: 1n,
    })
  })

  it('a whole-card sale is V1\'s sale: the price, no deposit, the listing drained and the card the buyer\'s', async () => {
    const env = await setup()
    const l = await listed(env)
    const { id, r } = await buy(env, l, 2_000)
    expect(transfers(env, r)).toEqual([{ from: BUYER, to: env.escrow, value: 18_000_000n }])
    expect(await deposit(env, id)).toMatchObject({ amount: 18_000_000n, usedCents: 2_000, leftAfterCents: 0, bond: 0n, bondState: BOND.NONE })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.DRAINED, remainingCents: 0, sales: 1, bondDeposit: 0n })
    expect(await cardOf(env, l.tag)).toEqual({ owner: BUYER, deposit: id, listing: ZERO32 })
  })

  it('a readable remainder sale holds the earlier deposit for its 2-hour window, as a blind one does: the ticket read is from before the purchase', async () => {
    const env = await setup()
    const l = await listedReadable(env)
    const a = await buy(env, l, 1_500)
    const tB = env.chain.timestamp + 60n
    env.chain.setTime(tB)
    const k = await ticketFor(env, l, { depositor: BUYER2, openBalanceCents: 650 })
    const r = await open(env, l, 500, k, BUYER2)
    expectOk(r)
    // Only B's payment moves: the read proved the 500 was there when Lit looked, not when B uses it.
    expect(transfers(env, r)).toEqual([{ from: BUYER2, to: env.escrow, value: 4_500_000n }])
    expect(escrowEvents(env, r).map((e) => e.eventName)).toEqual(['Opened', 'Used'])
    expect(await deposit(env, a.id)).toMatchObject({ bond: 5_000_000n, bondState: BOND.HELD })
    expect(await deposit(env, 2n)).toMatchObject({ covers: a.id, contestUntil: Number(tB + CONTEST_WINDOW), saleIndex: 1, usedCents: 500, leftAfterCents: 0, bond: 0n })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.DRAINED, bondDeposit: a.id, sales: 2, lastDeposit: 2n })
    expect(await cardOf(env, l.tag)).toEqual({ owner: BUYER2, deposit: 2n, listing: ZERO32 })
    // Uncontested for 2 hours, it comes back.
    env.chain.setTime(tB + CONTEST_WINDOW - 1n)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.releaseBond(a.id)), 'bond held')
    env.chain.setTime(tB + CONTEST_WINDOW)
    expectRevert(await env.chain.send(BUYER2, env.escrow, v2.contestRemainder(2n, fresh32('r'))), 'too late')
    const back = await mustSend(env.chain, STRANGER, env.escrow, v2.releaseBond(a.id))
    expect(transfers(env, back)).toEqual([{ from: env.escrow, to: BUYER, value: 5_000_000n }])
  })

  it('your own remainder: use part of it, and your deposit is netted into the payment, one transfer', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    // Use 200 of the 300 left: price 1,800,000 plus 1,000,000 deposit for the 100 left,
    // against 3,000,000 already deposited. 200,000 comes back.
    const own = await buy(env, l, 200, BUYER)
    expect(transfers(env, own.r)).toEqual([{ from: env.escrow, to: BUYER, value: 200_000n }])
    expect(await deposit(env, a.id)).toMatchObject({ bond: 0n, bondState: BOND.RETURNED })
    expect(await deposit(env, own.id)).toMatchObject({
      amount: 1_800_000n,
      usedCents: 200,
      leftAfterCents: 100,
      bond: 1_000_000n,
      bondState: BOND.HELD,
      covers: a.id,
      contestUntil: 0,
      saleIndex: 1,
    })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.ACTIVE, remainingCents: 100, sales: 2, bondDeposit: own.id, lastDeposit: own.id })
    expect(escrowEvents(env, own.r).map((e) => e.eventName)).toEqual(['Opened', 'Used', 'BondReturned'])
    // No haircut on your own bonded remainder (Decision 3), and the rest of it whole too.
    const last = await buy(env, l, 100, BUYER)
    expect(transfers(env, last.r)).toEqual([{ from: env.escrow, to: BUYER, value: 100_000n }])
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.DRAINED, bondDeposit: 0n })
    expect(await balanceOf(env, env.escrow)).toBe(15_300_000n + 1_800_000n + 900_000n)
  })

  it('your own remainder at no discount nets to zero: no transfer at all', async () => {
    const env = await setup()
    const l = await listed(env, { price: 20_000_000n })
    await buy(env, l, 1_700)
    const own = await buy(env, l, 300, BUYER)
    expect(transfers(env, own.r)).toEqual([])
    expect(await deposit(env, own.id)).toMatchObject({ amount: 3_000_000n, bond: 0n })
  })

  it('opens a remainder and a fresh partial card in one atomic batch, or neither', async () => {
    const env = await setup()
    const rem = await listed(env)
    await buy(env, rem, 1_700, BUYER)
    const fresh = await listed(env, { seller: SELLER2 })
    await mustSend(env.chain, BUYER2, env.token, tokenCall.approve(env.escrow, 0n))
    // $20 at the till: the 300-cent remainder whole, then 1,700 of a fresh card, leaving 300
    // on it at face. One approve for the prices plus the deposit.
    const due = 2_700_000n + 15_300_000n + 3_000_000n
    const before = await balanceOf(env, BUYER2)
    const ok = await env.chain.batch(BUYER2, [
      { to: env.token, data: tokenCall.approve(env.escrow, due) },
      { to: env.escrow, data: v2.depositAndOpen(rem.t, rem.envelopeHash, 300, await ticketFor(env, rem, { depositor: BUYER2 })) },
      { to: env.escrow, data: v2.depositAndOpen(fresh.t, fresh.envelopeHash, 1_700, await ticketFor(env, fresh, { depositor: BUYER2 })) },
    ])
    expect(ok.ok).toBe(true)
    expect(await balanceOf(env, BUYER2)).toBe(before - due)
    expect(await env.reader.readContract({ address: env.token, abi: MOCK_TOKEN_ABI, functionName: 'allowance', args: [BUYER2, env.escrow] })).toBe(0n)
    // A stale second leg (someone bought part of it first) undoes the first leg too.
    const a2 = await listed(env)
    const b2 = await listed(env, { seller: SELLER2 })
    const kb = await ticketFor(env, b2, { depositor: BUYER2 })
    await buy(env, b2, 1_800, BUYER3)
    const failed = await env.chain.batch(BUYER2, [
      { to: env.token, data: tokenCall.approve(env.escrow, 40_000_000n) },
      { to: env.escrow, data: v2.depositAndOpen(a2.t, a2.envelopeHash, 2_000, await ticketFor(env, a2, { depositor: BUYER2 })) },
      { to: env.escrow, data: v2.depositAndOpen(b2.t, b2.envelopeHash, 1_700, kb) },
    ])
    expect(failed).toMatchObject({ ok: false, failedAt: 2 })
    expect(failed.results[2]?.revert).toBe('stale ticket')
    expect(await balanceOf(env, BUYER2)).toBe(before - due)
    expect((await listing(env, a2.listingId)).sales).toBe(0)
  })
})

// --------------------------------------------------------------------------------------------
describe('the residual deposit: blind remainder sales', () => {
  /** A buys 1,700 of a $20 blind card (300 left, 3,000,000 deposited); B buys the 300 whole. */
  async function covered(env: Env) {
    const l = await listed(env)
    const a = await buy(env, l, 1_700, BUYER)
    const tB = env.chain.timestamp + 60n
    env.chain.setTime(tB)
    const b = await buy(env, l, 300, BUYER2)
    return { l, a, b, tB }
  }

  it("the next buyer's sale covers the deposit; it comes back once the 2-hour window passes uncontested", async () => {
    const env = await setup()
    const { l, a, b, tB } = await covered(env)
    expect(transfers(env, b.r)).toEqual([{ from: BUYER2, to: env.escrow, value: 2_700_000n }])
    expect(await deposit(env, b.id)).toMatchObject({ amount: 2_700_000n, covers: a.id, contestUntil: Number(tB + CONTEST_WINDOW), saleIndex: 1, bond: 0n })
    expect(await deposit(env, a.id)).toMatchObject({ bond: 3_000_000n, bondState: BOND.HELD })
    // Drained, and the deposit it covered is still the listing's until the window resolves it.
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.DRAINED, remainingCents: 0, bondDeposit: a.id, lastDeposit: b.id })
    env.chain.setTime(tB + CONTEST_WINDOW - 1n)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.releaseBond(a.id)), 'bond held')
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.release(b.id)), 'too early')
    env.chain.setTime(tB + CONTEST_WINDOW)
    expectRevert(await env.chain.send(BUYER2, env.escrow, v2.contestRemainder(b.id, fresh32('r'))), 'too late')
    const r = await mustSend(env.chain, STRANGER, env.escrow, v2.releaseBond(a.id))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 3_000_000n }])
    expect(escrowEvents(env, r)).toEqual([{ eventName: 'BondReturned', args: { depositId: a.id, amount: 3_000_000n } }])
    expect(await deposit(env, a.id)).toMatchObject({ bond: 0n, bondState: BOND.RETURNED })
    expect((await listing(env, l.listingId)).bondDeposit).toBe(0n)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.releaseBond(a.id)), 'not held')
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.releaseBond(b.id)), 'not held')
    env.chain.setTime(tB + RELEASE_DELAY)
    const paid = await mustSend(env.chain, STRANGER, env.escrow, v2.release(b.id))
    expect(transfers(env, paid)).toEqual([{ from: env.escrow, to: SELLER, value: 2_700_000n }])
  })

  it("the covering sale's payout returns the covered deposit, if nobody released it earlier", async () => {
    const env = await setup()
    const { a, b, tB } = await covered(env)
    env.chain.setTime(tB + RELEASE_DELAY)
    const r = await mustSend(env.chain, STRANGER, env.escrow, v2.release(b.id))
    expect(transfers(env, r)).toEqual([
      { from: env.escrow, to: SELLER, value: 2_700_000n },
      { from: env.escrow, to: BUYER, value: 3_000_000n },
    ])
    expect(escrowEvents(env, r).map((e) => e.eventName)).toEqual(['BondReturned', 'Released'])
    expect(await deposit(env, a.id)).toMatchObject({ bondState: BOND.RETURNED })
    expect(await stats(env, SELLER)).toMatchObject({ sold: 1, paidOut: 2_700_000n, remaindersShort: 0 })
  })

  it('"that card was empty": the next buyer is refunded from their own payment, the deposit pays the seller at face, the listing is spent', async () => {
    const env = await setup()
    const { l, a, b, tB } = await covered(env)
    const reason = fresh32('empty')
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.contestRemainder(b.id, reason)), 'not depositor')
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.contestRemainder(a.id, reason)), 'not a remainder sale')
    env.chain.setTime(tB + CONTEST_WINDOW - 1n)
    const sellerBefore = await balanceOf(env, SELLER)
    const r = await mustSend(env.chain, BUYER2, env.escrow, v2.contestRemainder(b.id, reason))
    expect(transfers(env, r)).toEqual([
      { from: env.escrow, to: BUYER2, value: 2_700_000n },
      { from: env.escrow, to: SELLER, value: 3_000_000n },
    ])
    expect(escrowEvents(env, r)).toEqual([
      { eventName: 'BondForfeited', args: { depositId: a.id, amount: 3_000_000n } },
      { eventName: 'Contested', args: { depositId: b.id, covers: a.id, reasonHash: reason } },
      { eventName: 'Refunded', args: { depositId: b.id, toDepositor: 2_700_000n, remaining: 0n } },
    ])
    // Decision 1: the seller is never worse off. Face for the remainder, at least what B paid.
    expect((await balanceOf(env, SELLER)) - sellerBefore).toBe(3_000_000n)
    expect(3_000_000n).toBeGreaterThanOrEqual(2_700_000n)
    expect(await deposit(env, b.id)).toMatchObject({ state: DEPOSIT.CONTESTED, amount: 0n })
    expect(await deposit(env, a.id)).toMatchObject({ state: DEPOSIT.OPENED, bond: 0n, bondState: BOND.FORFEITED })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.SPENT, bondDeposit: 0n })
    // The contested purchase is undone: the card is the seller's again.
    expect(await cardOf(env, l.tag)).toEqual({ owner: SELLER, deposit: 0n, listing: ZERO32 })
    expect(await stats(env, SELLER)).toMatchObject({ remaindersShort: 1, bondsClaimed: 0 })
    expect(await shortfalls(env, BUYER)).toBe(1)
    expect(await shortfalls(env, BUYER2)).toBe(0)
    // Nothing more on B's deposit; A's own sale still pays the seller on schedule.
    expectRevert(await env.chain.send(BUYER2, env.escrow, v2.contestRemainder(b.id, reason)), 'state')
    expectRevert(await env.chain.send(BUYER2, env.escrow, v2.dispute(b.id, reason)), 'no dispute')
    expectRevert(await env.chain.send(BUYER2, env.escrow, v2.rekey(b.id, fresh32('k'))), 'state')
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.sellerRefund(b.id, 1n)), 'state')
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.releaseBond(a.id)), 'not held')
    env.chain.setTime(BigInt((await deposit(env, a.id)).releaseAt))
    const paid = await mustSend(env.chain, STRANGER, env.escrow, v2.release(a.id))
    expect(transfers(env, paid)).toEqual([{ from: env.escrow, to: SELLER, value: 15_300_000n }])
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.release(b.id)), 'state')
    expect(await balanceOf(env, env.escrow)).toBe(0n)
  })

  it('readable: the earlier buyer spends the remainder after the next one pays; the next contests, is refunded, and the deposit pays the seller', async () => {
    const env = await setup()
    // A $100 readable card at 10% off, cap $10. A uses $90 and leaves $10, deposited at face.
    const l = await listedReadable(env, { valueCents: 10_000, price: 90_000_000n })
    const a = await buy(env, l, 9_000)
    // B's ticket reads $10, so B must use it whole, and pays. A still knows the number.
    const b = await buy(env, l, 1_000, BUYER2, { openBalanceCents: 1_000 })
    expect(transfers(env, b.r)).toEqual([{ from: BUYER2, to: env.escrow, value: 9_000_000n }])
    expect(await deposit(env, a.id)).toMatchObject({ bond: 10_000_000n, bondState: BOND.HELD })
    // A checks out online with the $10 before B scans. B finds it empty and says so.
    env.chain.advance(600)
    const r = await mustSend(env.chain, BUYER2, env.escrow, v2.contestRemainder(b.id, fresh32('empty')))
    expect(transfers(env, r)).toEqual([
      { from: env.escrow, to: BUYER2, value: 9_000_000n },
      { from: env.escrow, to: SELLER, value: 10_000_000n },
    ])
    expect(await deposit(env, a.id)).toMatchObject({ bond: 0n, bondState: BOND.FORFEITED })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.SPENT, bondDeposit: 0n })
    expect(await shortfalls(env, BUYER)).toBe(1)
    // A's race gained nothing: A paid for the $90 used and lost the $10 deposit for the $10 spent.
    expect(FUNDS - (await balanceOf(env, BUYER))).toBe(81_000_000n + 10_000_000n)
    expect(FUNDS - (await balanceOf(env, BUYER2))).toBe(0n)
  })

  it('a dispute does not take away the contest, and the contest works on a part-refunded sale', async () => {
    const env = await setup()
    const { a, b } = await covered(env)
    await mustSend(env.chain, BUYER2, env.escrow, v2.dispute(b.id, fresh32('d')))
    await mustSend(env.chain, SELLER, env.escrow, v2.sellerRefund(b.id, 700_000n))
    const r = await mustSend(env.chain, BUYER2, env.escrow, v2.contestRemainder(b.id, fresh32('r')))
    expect(transfers(env, r)).toEqual([
      { from: env.escrow, to: BUYER2, value: 2_000_000n },
      { from: env.escrow, to: SELLER, value: 3_000_000n },
    ])
    expect((await deposit(env, a.id)).bondState).toBe(BOND.FORFEITED)
  })
})

// --------------------------------------------------------------------------------------------
describe('the residual deposit: by rule, by the seller, by self-use', () => {
  it('releaseBond at 7 days by rule; the remainder stays listed with no deposit, and the haircut comes off its price', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const tA = env.chain.timestamp
    env.chain.setTime(tA + BOND_MAX_AGE - 1n)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.releaseBond(a.id)), 'bond held')
    env.chain.setTime(tA + BOND_MAX_AGE)
    const r = await mustSend(env.chain, STRANGER, env.escrow, v2.releaseBond(a.id))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 3_000_000n }])
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.ACTIVE, remainingCents: 300, bondDeposit: 0n, sales: 1 })
    // Decision 3: with no deposit covering it, the remainder is priced 25% lower. Any buyer may
    // use part of it, and then deposits for what they leave.
    const b = await buy(env, l, 200, BUYER2)
    const cut = await priceFor(env, l.t.price, l.t.valueCents, 200, 2_500)
    expect(cut).toBe(1_350_000n)
    expect(transfers(env, b.r)).toEqual([{ from: BUYER2, to: env.escrow, value: cut + 1_000_000n }])
    expect(await deposit(env, b.id)).toMatchObject({ amount: cut, covers: 0n, contestUntil: 0, bond: 1_000_000n, saleIndex: 1 })
    expect(await listing(env, l.listingId)).toMatchObject({ remainingCents: 100, bondDeposit: b.id })
    expectRevert(await env.chain.send(BUYER2, env.escrow, v2.contestRemainder(b.id, fresh32('r'))), 'not a remainder sale')
    // B's deposit covers the last 100: no haircut on it.
    const c = await buy(env, l, 100, BUYER3)
    expect(transfers(env, c.r)).toEqual([{ from: BUYER3, to: env.escrow, value: 900_000n }])
  })

  it('releaseBond waits for a covering sale inside its window, even past 7 days', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const tA = env.chain.timestamp
    env.chain.setTime(tA + BOND_MAX_AGE - 3_600n)
    const b = await buy(env, l, 300, BUYER2)
    env.chain.setTime(tA + BOND_MAX_AGE)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.releaseBond(a.id)), 'bond held')
    env.chain.setTime(tA + BOND_MAX_AGE + 3_600n)
    expectOk(await env.chain.send(STRANGER, env.escrow, v2.releaseBond(a.id)))
    expect((await deposit(env, b.id)).state).toBe(DEPOSIT.OPENED)
  })

  it('sellerCloseRemainder(spent): only the seller, from 5 days to before 7; the deposit pays the seller and counts', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const tA = env.chain.timestamp
    env.chain.setTime(tA + BOND_REVIEW_AFTER - 1n)
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.sellerCloseRemainder(l.listingId, true)), 'too early')
    env.chain.setTime(tA + BOND_REVIEW_AFTER)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.sellerCloseRemainder(l.listingId, true)), 'not seller')
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.sellerCloseRemainder(l.listingId, true)), 'not seller')
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.sellerCloseRemainder(l.listingId, true))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: SELLER, value: 3_000_000n }])
    expect(escrowEvents(env, r)).toEqual([
      { eventName: 'BondForfeited', args: { depositId: a.id, amount: 3_000_000n } },
      { eventName: 'RemainderClosed', args: { listingId: l.listingId, spent: true } },
    ])
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.SPENT, remainingCents: 0, bondDeposit: 0n })
    expect(await stats(env, SELLER)).toMatchObject({ bondsClaimed: 1, remaindersShort: 0 })
    expect(await shortfalls(env, BUYER)).toBe(0)
    expect((await cardOf(env, l.tag)).listing).toBe(ZERO32)
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.sellerCloseRemainder(l.listingId, true)), 'not active')
  })

  it('sellerCloseRemainder: at 7 days "spent" is too late; "not spent" returns the deposit and keeps the remainder listed', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const tA = env.chain.timestamp
    env.chain.setTime(tA + BOND_MAX_AGE)
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.sellerCloseRemainder(l.listingId, true)), 'too late')
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.sellerCloseRemainder(l.listingId, false))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 3_000_000n }])
    expect(await deposit(env, a.id)).toMatchObject({ bondState: BOND.RETURNED })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.ACTIVE, remainingCents: 300, bondDeposit: 0n })
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.sellerCloseRemainder(l.listingId, false)), 'no deposit')
    // Never while a covering sale is resolving: the listing is then drained.
    const l2 = await listed(env)
    await buy(env, l2, 1_700)
    await buy(env, l2, 300, BUYER2)
    env.chain.advance(BOND_REVIEW_AFTER)
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.sellerCloseRemainder(l2.listingId, true)), 'not active')
  })
})

// --------------------------------------------------------------------------------------------
describe('confirmRemainder: a Lit read moves a shortfall to the seller only', () => {
  /** A buys 1,500 of a $20 readable card: 500 left, 5,000,000 deposited. */
  async function readableSold(env: Env) {
    const l = await listedReadable(env)
    const a = await buy(env, l, 1_500)
    const tA = Number(env.chain.timestamp)
    env.chain.advance(900)
    return { l, a, tA }
  }

  it('readable listings with a sale only; readAt after the deposit opened, after the last read, not in the future; signed by Lit', async () => {
    const env = await setup()
    const blind = await listed(env)
    await buy(env, blind, 1_700)
    env.chain.advance(60)
    expectRevert(await confirm(env, blind, 100, now(env)), 'mode')
    const unsold = await listedReadable(env)
    expectRevert(await confirm(env, unsold, 100, now(env)), 'no remainder')
    const { l, tA } = await readableSold(env)
    expectRevert(await confirm(env, l, 500, tA), 'read time')
    expectRevert(await confirm(env, l, 500, now(env) + 1), 'read time')
    expectRevert(await confirm(env, l, 500, tA + 1, { signer: ROGUE }), 'not lit')
    expectRevert(await confirm(env, l, 500, tA + 1, { bondDeposit: 0n }), 'not lit')
    expectRevert(await confirm(env, l, 500, tA + 1, { bondDeposit: 99n }), 'not lit')
    const sig = await confirmSig(env, l, 500, tA + 1)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.confirmRemainder(l.listingId, 499, tA + 1, sig)), 'not lit')
    // A clean read changes nothing but the time of the last read.
    const r = await confirm(env, l, 500, tA + 1)
    expectOk(r)
    expect(transfers(env, r)).toEqual([])
    expect(escrowEvents(env, r)).toEqual([{ eventName: 'RemainderConfirmed', args: { listingId: l.listingId, balanceCents: 500, readAt: tA + 1, toSeller: 0n } }])
    expect(await listing(env, l.listingId)).toMatchObject({ remainingCents: 500, confirmedAt: tA + 1 })
    expectRevert(await confirm(env, l, 500, tA + 1), 'read time')
    // More on the card than is left never raises what is left.
    expectOk(await confirm(env, l, 900, tA + 2))
    expect((await listing(env, l.listingId)).remainingCents).toBe(500)
  })

  it('a shortfall in the first read after the sale: face of the shortfall to the seller, what is left lowered, counted against the buyer', async () => {
    const env = await setup()
    const { l, a } = await readableSold(env)
    const staleForB = await ticketFor(env, l, { depositor: BUYER2 })
    const readAt = now(env)
    const r = await confirm(env, l, 200, readAt)
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: SELLER, value: 3_000_000n }])
    expect(escrowEvents(env, r)).toEqual([
      { eventName: 'BondForfeited', args: { depositId: a.id, amount: 3_000_000n } },
      { eventName: 'RemainderConfirmed', args: { listingId: l.listingId, balanceCents: 200, readAt, toSeller: 3_000_000n } },
    ])
    expect(await deposit(env, a.id)).toMatchObject({ bond: 2_000_000n, bondState: BOND.HELD })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.ACTIVE, remainingCents: 200, bondDeposit: a.id, confirmedAt: readAt })
    // The buyer's, so not the seller's too: one shortfall counts against one side.
    expect(await shortfalls(env, BUYER)).toBe(1)
    expect(await stats(env, SELLER)).toMatchObject({ remaindersShort: 0 })
    // The next buyer's ticket from before the read is stale; a fresh one buys the 200, and what
    // is left of A's deposit comes back once that sale's window passes.
    expectRevert(await tryOpen(env, l, 500, staleForB, BUYER2), 'stale ticket')
    const b = await buy(env, l, 200, BUYER2)
    expect(transfers(env, b.r)).toEqual([{ from: BUYER2, to: env.escrow, value: 1_800_000n }])
    env.chain.advance(CONTEST_WINDOW)
    const back = await mustSend(env.chain, STRANGER, env.escrow, v2.releaseBond(a.id))
    expect(transfers(env, back)).toEqual([{ from: env.escrow, to: BUYER, value: 2_000_000n }])
    // A second shortfall later on another card, after a clean read 15 minutes after its sale,
    // pays the seller and counts against the seller, not the buyer.
    const l2 = await listedReadable(env)
    await buy(env, l2, 1_500, BUYER3)
    env.chain.advance(CONFIRM_DELAY)
    expectOk(await confirm(env, l2, 500, now(env)))
    env.chain.advance(60)
    const r2 = await confirm(env, l2, 450, now(env))
    expect(transfers(env, r2)).toEqual([{ from: env.escrow, to: SELLER, value: 500_000n }])
    expect(await shortfalls(env, BUYER3)).toBe(0)
    expect(await stats(env, SELLER)).toMatchObject({ remaindersShort: 1 })
  })

  it("a clean read sooner than 15 minutes after the sale does not close the buyer's window; one at 15 minutes does", async () => {
    const env = await setup()
    const l = await listedReadable(env)
    await buy(env, l, 1_500, BUYER)
    // A posts a clean read a minute after paying, before scanning, then spends the 500 left.
    env.chain.advance(60)
    expectOk(await confirm(env, l, 500, now(env)))
    env.chain.advance(1_800)
    const r = await confirm(env, l, 0, now(env))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: SELLER, value: 5_000_000n }])
    // Still A's window: it counts against A, and not against the honest seller.
    expect(await shortfalls(env, BUYER)).toBe(1)
    expect(await stats(env, SELLER)).toMatchObject({ remaindersShort: 0 })
    // The edge, on SELLER2's cards: a clean read a second short of 15 minutes leaves the
    // window open; one at 15 minutes closes it.
    for (const [buyer, after] of [[BUYER2, CONFIRM_DELAY - 1n], [BUYER3, CONFIRM_DELAY]] as const) {
      const l2 = await listedReadable(env, { seller: SELLER2 })
      await buy(env, l2, 1_500, buyer)
      env.chain.advance(after)
      expectOk(await confirm(env, l2, 500, now(env)))
      env.chain.advance(60)
      expectOk(await confirm(env, l2, 400, now(env)))
    }
    expect(await shortfalls(env, BUYER2)).toBe(1)
    expect(await shortfalls(env, BUYER3)).toBe(0)
    expect(await stats(env, SELLER2)).toMatchObject({ remaindersShort: 1 })
  })

  it('a read of zero: the whole deposit to the seller and the listing spent', async () => {
    const env = await setup()
    const { l, a } = await readableSold(env)
    const r = await confirm(env, l, 0, now(env))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: SELLER, value: 5_000_000n }])
    expect(await deposit(env, a.id)).toMatchObject({ bond: 0n, bondState: BOND.FORFEITED })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.SPENT, remainingCents: 0, bondDeposit: 0n })
    expect((await cardOf(env, l.tag)).listing).toBe(ZERO32)
    env.chain.advance(1)
    expectRevert(await confirm(env, l, 0, now(env)), 'no remainder')
  })

  it('with no deposit left (returned by rule), a read lowers what is left and moves nothing', async () => {
    const env = await setup()
    const { l, a, tA } = await readableSold(env)
    env.chain.setTime(BigInt(tA) + BOND_MAX_AGE)
    await mustSend(env.chain, STRANGER, env.escrow, v2.releaseBond(a.id))
    const r = await confirm(env, l, 100, now(env), { bondDeposit: 0n })
    expect(transfers(env, r)).toEqual([])
    expect(await listing(env, l.listingId)).toMatchObject({ remainingCents: 100, bondDeposit: 0n })
    expect(await shortfalls(env, BUYER)).toBe(0)
  })
})

// --------------------------------------------------------------------------------------------
describe('what stops a buyer claiming less than they used (spec section 8.5)', () => {
  it('readable: detected by the confirm read, the cheat pays the discount on the shortfall more than an honest buyer', async () => {
    // A really uses 1,800 of a $20 card at 10% off. Honest: claims 1,800. Cheat: claims 1,500.
    const honest = await setup()
    const lh = await listedReadable(honest)
    const h = await buy(honest, lh, 1_800)
    honest.chain.advance(900)
    expectOk(await confirm(honest, lh, 200, now(honest)))
    await buy(honest, lh, 200, BUYER2)
    // The next buyer's 2-hour window passes uncontested.
    honest.chain.advance(CONTEST_WINDOW)
    await mustSend(honest.chain, STRANGER, honest.escrow, v2.releaseBond(h.id))

    const cheat = await setup()
    const lc = await listedReadable(cheat)
    const c = await buy(cheat, lc, 1_500)
    cheat.chain.advance(900)
    expectOk(await confirm(cheat, lc, 200, now(cheat)))
    await buy(cheat, lc, 200, BUYER2)
    cheat.chain.advance(CONTEST_WINDOW)
    await mustSend(cheat.chain, STRANGER, cheat.escrow, v2.releaseBond(c.id))

    const spent = async (env: Env) => FUNDS - (await balanceOf(env, BUYER))
    expect(transfers(honest, h.r)).toEqual([{ from: BUYER, to: honest.escrow, value: 16_200_000n + 2_000_000n }])
    expect(transfers(cheat, c.r)).toEqual([{ from: BUYER, to: cheat.escrow, value: 13_500_000n + 5_000_000n }])
    // Both deposits for the real 200 came back; the cheat's other 300 at face went to the seller.
    expect(await spent(honest)).toBe(16_200_000n)
    expect(await spent(cheat)).toBe(16_500_000n)
    // d x shortfall: 10% of 300 cents at face.
    expect((await spent(cheat)) - (await spent(honest))).toBe(300_000n)
  })

  it('blind: undetected, the cheat saves at most the price of the cap; detected by the next buyer, the whole deposit is lost', async () => {
    // The card is really used whole (2,000). The cheat claims 1,500 and leaves 500 "on it".
    const quiet = await setup()
    const lq = await listed(quiet)
    const q = await buy(quiet, lq, 1_500)
    quiet.chain.advance(BOND_MAX_AGE)
    await mustSend(quiet.chain, STRANGER, quiet.escrow, v2.releaseBond(q.id))
    const saved = 18_000_000n - (FUNDS - (await balanceOf(quiet, BUYER)))
    expect(saved).toBe(4_500_000n)
    expect(saved).toBeLessThanOrEqual(await priceFor(quiet, lq.t.price, lq.t.valueCents, lq.t.residualCapCents))

    const caught = await setup()
    const lc = await listed(caught)
    await buy(caught, lc, 1_500)
    const b = await buy(caught, lc, 500, BUYER2)
    await mustSend(caught.chain, BUYER2, caught.escrow, v2.contestRemainder(b.id, fresh32('empty')))
    // 13,500,000 for the 1,500 claimed plus the 5,000,000 deposit, all gone: more than the
    // 18,000,000 an honest buyer pays for the whole card.
    expect(FUNDS - (await balanceOf(caught, BUYER))).toBe(18_500_000n)
    expect(FUNDS - (await balanceOf(caught, BUYER2))).toBe(0n)
  })
})

// --------------------------------------------------------------------------------------------
describe('reduceUse: the total went down', () => {
  it('claims fewer cents on the latest sale: the price difference back, the deposit up by face, one pull', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_800)
    const r = await mustSend(env.chain, BUYER, env.escrow, v2.reduceUse(l.t, l.envelopeHash, a.id, 1_600))
    // 1,800,000 of price back, 2,000,000 more deposited: 200,000 pulled.
    expect(transfers(env, r)).toEqual([{ from: BUYER, to: env.escrow, value: 200_000n }])
    expect(escrowEvents(env, r)).toEqual([{ eventName: 'UseReduced', args: { depositId: a.id, usedCents: 1_600, leftCents: 400, refund: 1_800_000n } }])
    expect(await deposit(env, a.id)).toMatchObject({ amount: 14_400_000n, usedCents: 1_600, leftAfterCents: 400, bond: 4_000_000n, bondState: BOND.HELD })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.ACTIVE, remainingCents: 400, bondDeposit: a.id })
    expect(await priceFor(env, l.t.price, l.t.valueCents, 1_600)).toBe(14_400_000n)
    // The cap still holds: 1,499 would leave 501.
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.reduceUse(l.t, l.envelopeHash, a.id, 1_499)), 'left')
    expectOk(await env.chain.send(BUYER, env.escrow, v2.reduceUse(l.t, l.envelopeHash, a.id, 1_500)))
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.reduceUse(l.t, l.envelopeHash, a.id, 1_500)), 'used')
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.reduceUse(l.t, l.envelopeHash, a.id, 0)), 'used')
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.reduceUse(l.t, l.envelopeHash, a.id, 1_400)), 'not depositor')
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.reduceUse({ ...l.t, salt: fresh32('s') }, l.envelopeHash, a.id, 1_499)), 'terms')
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.reduceUse(l.t, fresh32('e'), a.id, 1_499)), 'terms')
    // Only before the payout.
    const releaseAt = BigInt((await deposit(env, a.id)).releaseAt)
    env.chain.setTime(releaseAt)
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.reduceUse(l.t, l.envelopeHash, a.id, 1_499)), 'state')
  })

  it('reopens a listing the sale drained: the card is the seller\'s again and the cents given back are for sale', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 2_000)
    expect(await cardOf(env, l.tag)).toEqual({ owner: BUYER, deposit: a.id, listing: ZERO32 })
    const r = await mustSend(env.chain, BUYER, env.escrow, v2.reduceUse(l.t, l.envelopeHash, a.id, 1_800))
    expect(transfers(env, r)).toEqual([{ from: BUYER, to: env.escrow, value: 200_000n }])
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.ACTIVE, remainingCents: 200, bondDeposit: a.id, bondSince: now(env) })
    expect(await cardOf(env, l.tag)).toEqual({ owner: SELLER, deposit: 0n, listing: l.listingId })
    expectRevert(await tryOpen(env, l, 100, await ticketFor(env, l, { depositor: BUYER2 }), BUYER2), 'remainder whole')
    await buy(env, l, 200, BUYER2)
  })

  it('never on a remainder sale, a sale that is not the latest, or a listing the seller closed', async () => {
    const env = await setup()
    // A blind remainder sale.
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const b = await buy(env, l, 300, BUYER2)
    expectRevert(await env.chain.send(BUYER2, env.escrow, v2.reduceUse(l.t, l.envelopeHash, b.id, 200)), 'remainder sale')
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.reduceUse(l.t, l.envelopeHash, a.id, 1_600)), 'not latest')
    // A readable remainder sale.
    const rl = await listedReadable(env)
    await buy(env, rl, 1_500)
    const rb = await buy(env, rl, 500, BUYER2)
    expectRevert(await env.chain.send(BUYER2, env.escrow, v2.reduceUse(rl.t, rl.envelopeHash, rb.id, 400)), 'remainder sale')
    // A remainder no deposit covered.
    const ul = await listed(env)
    const ua = await buy(env, ul, 1_700)
    env.chain.advance(BOND_MAX_AGE)
    await mustSend(env.chain, STRANGER, env.escrow, v2.releaseBond(ua.id))
    const ub = await buy(env, ul, 200, BUYER2)
    expectRevert(await env.chain.send(BUYER2, env.escrow, v2.reduceUse(ul.t, ul.envelopeHash, ub.id, 100)), 'remainder sale')
    // Your own remainder sale may be changed; the sale it used may not.
    const ol = await listed(env)
    const oa = await buy(env, ol, 1_700)
    const ob = await buy(env, ol, 200, BUYER)
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.reduceUse(ol.t, ol.envelopeHash, oa.id, 1_600)), 'not latest')
    const r = await mustSend(env.chain, BUYER, env.escrow, v2.reduceUse(ol.t, ol.envelopeHash, ob.id, 150))
    expect(transfers(env, r)).toEqual([{ from: BUYER, to: env.escrow, value: 50_000n }])
    expect(await listing(env, ol.listingId)).toMatchObject({ remainingCents: 150, bondDeposit: ob.id })
    // The seller closed the listing ("I used it myself").
    const cl = await listed(env)
    const ca = await buy(env, cl, 1_700)
    await mustSend(env.chain, SELLER, env.escrow, v2.cancelListing(cl.listingId))
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.reduceUse(cl.t, cl.envelopeHash, ca.id, 1_600)), 'listing')
  })
})

// --------------------------------------------------------------------------------------------
describe('keepRest: keep the rest of this card as your own credit', () => {
  it('buys what is left at the sale\'s price out of its own deposit, returns the rest, and the card is the buyer\'s', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.keepRest(l.t, l.envelopeHash, a.id)), 'not depositor')
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.keepRest({ ...l.t, price: 1n }, l.envelopeHash, a.id)), 'terms')
    const r = await mustSend(env.chain, BUYER, env.escrow, v2.keepRest(l.t, l.envelopeHash, a.id))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 300_000n }])
    expect(escrowEvents(env, r)).toEqual([
      { eventName: 'RestKept', args: { depositId: a.id, restCents: 300, restPrice: 2_700_000n } },
      { eventName: 'BondReturned', args: { depositId: a.id, amount: 300_000n } },
    ])
    expect(await deposit(env, a.id)).toMatchObject({ amount: 18_000_000n, usedCents: 2_000, leftAfterCents: 0, bond: 0n, bondState: BOND.RETURNED, state: DEPOSIT.OPENED })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.DRAINED, remainingCents: 0, bondDeposit: 0n })
    expect(await cardOf(env, l.tag)).toEqual({ owner: BUYER, deposit: a.id, listing: ZERO32 })
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.keepRest(l.t, l.envelopeHash, a.id)), 'no rest')
    // The seller is paid for the whole card; then the card is the buyer's to sell.
    env.chain.advance(RELEASE_DELAY)
    const paid = await mustSend(env.chain, STRANGER, env.escrow, v2.release(a.id))
    expect(transfers(env, paid)).toEqual([{ from: env.escrow, to: SELLER, value: 18_000_000n }])
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.keepRest(l.t, l.envelopeHash, a.id)), 'state')
    const resale = await listed(env, { seller: BUYER, valueCents: 100, price: 900_000n }, l.tag)
    expectOk(await tryOpen(env, resale, 100, await ticketFor(env, resale, { depositor: BUYER2 }), BUYER2))
  })

  it('only on the latest sale while its own deposit still covers the rest; a remainder no deposit covered keeps its haircut', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const own = await buy(env, l, 200, BUYER)
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.keepRest(l.t, l.envelopeHash, a.id)), 'no rest')
    expectOk(await env.chain.send(BUYER, env.escrow, v2.keepRest(l.t, l.envelopeHash, own.id)))
    // After 7 days the deposit is gone by rule, though the sale may still be unpaid.
    const l2 = await listed(env)
    const a2 = await buy(env, l2, 1_700)
    env.chain.advance(BOND_MAX_AGE)
    await mustSend(env.chain, STRANGER, env.escrow, v2.releaseBond(a2.id))
    expect((await deposit(env, a2.id)).state).toBe(DEPOSIT.OPENED)
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.keepRest(l2.t, l2.envelopeHash, a2.id)), 'no rest')
    // That remainder, used in part with the haircut, keeps the haircut on its rest.
    const b2 = await buy(env, l2, 200, BUYER2)
    const r = await mustSend(env.chain, BUYER2, env.escrow, v2.keepRest(l2.t, l2.envelopeHash, b2.id))
    const restPrice = await priceFor(env, l2.t.price, l2.t.valueCents, 100, 2_500)
    expect(restPrice).toBe(675_000n)
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER2, value: 1_000_000n - restPrice }])
  })
})

// --------------------------------------------------------------------------------------------
describe('sellerRefund', () => {
  it('seller only, 1 unit to all that is left, only while Opened; a part refund changes nothing else', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.sellerRefund(a.id, 1n)), 'not seller')
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.sellerRefund(a.id, 0n)), 'amount')
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.sellerRefund(a.id, 15_300_001n)), 'amount')
    const before = await listing(env, l.listingId)
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.sellerRefund(a.id, 300_000n))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 300_000n }])
    expect(await deposit(env, a.id)).toMatchObject({ state: DEPOSIT.OPENED, amount: 15_000_000n, bond: 3_000_000n, bondState: BOND.HELD })
    expect(await listing(env, l.listingId)).toEqual(before)
    env.chain.advance(RELEASE_DELAY)
    await mustSend(env.chain, STRANGER, env.escrow, v2.release(a.id))
    expectRevert(await env.chain.send(SELLER, env.escrow, v2.sellerRefund(a.id, 1n)), 'state')
    expect(await stats(env, SELLER)).toMatchObject({ sold: 1, refunds: 1, paidOut: 15_000_000n })
  })

  it('a full refund of a first partial sale ends it and closes the listing: price and deposit back in one transfer, nothing listed again', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.sellerRefund(a.id, 15_300_000n))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 18_300_000n }])
    expect(escrowEvents(env, r)).toEqual([
      { eventName: 'BondReturned', args: { depositId: a.id, amount: 3_000_000n } },
      { eventName: 'ListingCancelled', args: { listingId: l.listingId } },
      { eventName: 'Refunded', args: { depositId: a.id, toDepositor: 15_300_000n, remaining: 0n } },
    ])
    expect(await deposit(env, a.id)).toMatchObject({ state: DEPOSIT.REFUNDED, amount: 0n, bond: 0n, bondState: BOND.RETURNED })
    // As V1, nothing the refunded buyer has seen goes back on sale by itself.
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.CANCELLED, sales: 1, lastDeposit: a.id, bondDeposit: 0n })
    expectRevert(await tryOpen(env, l, 2_000, await ticketFor(env, l, { depositor: BUYER2 }), BUYER2), 'listing not active')
    expect(await cardOf(env, l.tag)).toEqual({ owner: zeroAddress, deposit: 0n, listing: ZERO32 })
    // The card is the seller's: listed again on purpose, it sells whole at the full price.
    const again = await listed(env, {}, l.tag)
    const b = await buy(env, again, 2_000, BUYER2)
    expect(transfers(env, b.r)).toEqual([{ from: BUYER2, to: env.escrow, value: 18_000_000n }])
    expect((await deposit(env, b.id)).saleIndex).toBe(0)
  })

  it('a full refund of a drained whole sale gives the card back and closes the listing, as V1', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 2_000)
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.sellerRefund(a.id, 18_000_000n))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 18_000_000n }])
    expect(await cardOf(env, l.tag)).toEqual({ owner: SELLER, deposit: 0n, listing: ZERO32 })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.CANCELLED, sales: 1 })
  })

  it('a full refund of a blind remainder sale moves only its payment: nothing is listed again, and the deposit it covered waits out its window', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const tB = env.chain.timestamp + 60n
    env.chain.setTime(tB)
    const b = await buy(env, l, 300, BUYER2)
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.sellerRefund(b.id, 2_700_000n))
    // A's deposit is not the refund's to free: a refunded purchase is not one that held up.
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER2, value: 2_700_000n }])
    expect(escrowEvents(env, r).map((e) => e.eventName)).toEqual(['Refunded'])
    expect(await deposit(env, a.id)).toMatchObject({ bond: 3_000_000n, bondState: BOND.HELD })
    // B has seen the number too, so the 300 cents are not for sale again by themselves.
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.DRAINED, remainingCents: 0, sales: 2, lastDeposit: b.id, bondDeposit: a.id })
    expect(await cardOf(env, l.tag)).toEqual({ owner: SELLER, deposit: 0n, listing: ZERO32 })
    // The refunded sale can no longer be contested; its window still runs, then A's deposit is back.
    expectRevert(await env.chain.send(BUYER2, env.escrow, v2.contestRemainder(b.id, fresh32('r'))), 'state')
    env.chain.setTime(tB + CONTEST_WINDOW - 1n)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.releaseBond(a.id)), 'bond held')
    env.chain.setTime(tB + CONTEST_WINDOW)
    const back = await mustSend(env.chain, STRANGER, env.escrow, v2.releaseBond(a.id))
    expect(transfers(env, back)).toEqual([{ from: env.escrow, to: BUYER, value: 3_000_000n }])
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.keepRest(l.t, l.envelopeHash, a.id)), 'no rest')
  })

  it('a full refund of a blind remainder sale after its window moves only its payment: the deposit already came back', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const b = await buy(env, l, 300, BUYER2)
    env.chain.advance(CONTEST_WINDOW)
    await mustSend(env.chain, STRANGER, env.escrow, v2.releaseBond(a.id))
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.sellerRefund(b.id, 2_700_000n))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER2, value: 2_700_000n }])
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.DRAINED, remainingCents: 0, bondDeposit: 0n })
  })

  it('a full refund of your own remainder sale moves only its price: your deposit stays, covering what you left', async () => {
    const env = await setup()
    const l = await listed(env)
    await buy(env, l, 1_700)
    // A uses all $20 at the till, then buys one cent of their own $3.00 remainder: the $3.00
    // deposit nets against $2.99 at face plus the cent's price, so the new sale holds 9,000 units.
    const own = await buy(env, l, 1, BUYER)
    expect(transfers(env, own.r)).toEqual([{ from: env.escrow, to: BUYER, value: 1_000n }])
    expect(await deposit(env, own.id)).toMatchObject({ amount: 9_000n, bond: 2_990_000n, bondState: BOND.HELD })
    // The seller refunds that cent. Only its price moves; the $2.99 deposit is not the refund's to free.
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.sellerRefund(own.id, 9_000n))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 9_000n }])
    expect(escrowEvents(env, r).map((e) => e.eventName)).toEqual(['Refunded'])
    expect(await deposit(env, own.id)).toMatchObject({ state: DEPOSIT.REFUNDED, amount: 0n, bond: 2_990_000n, bondState: BOND.HELD })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.ACTIVE, remainingCents: 299, sales: 2, lastDeposit: own.id, bondDeposit: own.id })
    // So the next buyer is covered as before: the rest is used whole, with no haircut, and
    // "that card was empty" pays the seller out of A's deposit.
    expectRevert(await tryOpen(env, l, 200, await ticketFor(env, l, { depositor: BUYER2 }), BUYER2), 'remainder whole')
    const b = await buy(env, l, 299, BUYER2)
    expect(transfers(env, b.r)).toEqual([{ from: BUYER2, to: env.escrow, value: 2_691_000n }])
    const c = await mustSend(env.chain, BUYER2, env.escrow, v2.contestRemainder(b.id, fresh32('empty')))
    expect(transfers(env, c)).toEqual([
      { from: env.escrow, to: BUYER2, value: 2_691_000n },
      { from: env.escrow, to: SELLER, value: 2_990_000n },
    ])
    expect(await shortfalls(env, BUYER)).toBe(1)
  })

  it('a full refund of an earlier sale whose deposit a later sale covers moves only its price: the deposit stays for that window', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const b = await buy(env, l, 300, BUYER2)
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.sellerRefund(a.id, 15_300_000n))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 15_300_000n }])
    expect(await deposit(env, a.id)).toMatchObject({ state: DEPOSIT.REFUNDED, bond: 3_000_000n, bondState: BOND.HELD })
    expect(await listing(env, l.listingId)).toMatchObject({ state: LISTING.DRAINED, lastDeposit: b.id, bondDeposit: a.id })
    // B's contest still finds it: the seller is paid the face of what B found empty.
    const c = await mustSend(env.chain, BUYER2, env.escrow, v2.contestRemainder(b.id, fresh32('empty')))
    expect(transfers(env, c)).toEqual([
      { from: env.escrow, to: BUYER2, value: 2_700_000n },
      { from: env.escrow, to: SELLER, value: 3_000_000n },
    ])
  })

  it('a full refund of a sale that is no longer the latest changes no listing', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    await buy(env, l, 200, BUYER)
    const before = await listing(env, l.listingId)
    const r = await mustSend(env.chain, SELLER, env.escrow, v2.sellerRefund(a.id, 15_300_000n))
    // A's deposit was already netted into the later sale: only the price comes back.
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 15_300_000n }])
    expect(await listing(env, l.listingId)).toEqual(before)
  })
})

// --------------------------------------------------------------------------------------------
describe('dispute, rekey and release', () => {
  it('dispute: depositor only, once, before payout; holds the payout 48 h more and counts against the seller', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const releaseAt = (await deposit(env, a.id)).releaseAt
    const reason = fresh32('reason')
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.dispute(a.id, reason)), 'not depositor')
    const r = await mustSend(env.chain, BUYER, env.escrow, v2.dispute(a.id, reason))
    expect(escrowEvents(env, r)).toEqual([{ eventName: 'Disputed', args: { depositId: a.id, reasonHash: reason, releaseAt: releaseAt + Number(DISPUTE_HOLD) } }])
    expect(transfers(env, r)).toEqual([])
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.dispute(a.id, reason)), 'no dispute')
    expect((await stats(env, SELLER)).disputes).toBe(1)
    env.chain.setTime(BigInt(releaseAt) + DISPUTE_HOLD - 1n)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.release(a.id)), 'too early')
    env.chain.setTime(BigInt(releaseAt) + DISPUTE_HOLD)
    const paid = await mustSend(env.chain, STRANGER, env.escrow, v2.release(a.id))
    // Only the price: the deposit for the 300 left is not the seller's.
    expect(transfers(env, paid)).toEqual([{ from: env.escrow, to: SELLER, value: 15_300_000n }])
    expect((await deposit(env, a.id)).bondState).toBe(BOND.HELD)
    const late = await buy(env, await listed(env), 2_000)
    env.chain.setTime(BigInt((await deposit(env, late.id)).releaseAt))
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.dispute(late.id, reason)), 'too late')
  })

  it('rekey: depositor only, non-zero, while Opened or Released, never after a refund', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 2_000)
    const next = fresh32('key')
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.rekey(a.id, next)), 'not depositor')
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.rekey(a.id, ZERO32)), 'reply key')
    const r = await mustSend(env.chain, BUYER, env.escrow, v2.rekey(a.id, next))
    expect(escrowEvents(env, r)).toEqual([{ eventName: 'Rekeyed', args: { depositId: a.id, replyKeyHash: next } }])
    expect((await gate(env, l.listingId, a.id)).replyKeyHash).toBe(next)
    env.chain.advance(RELEASE_DELAY)
    await mustSend(env.chain, STRANGER, env.escrow, v2.release(a.id))
    expectOk(await env.chain.send(BUYER, env.escrow, v2.rekey(a.id, fresh32('after'))))
    const refunded = await buy(env, await listed(env), 2_000)
    await mustSend(env.chain, SELLER, env.escrow, v2.sellerRefund(refunded.id, 18_000_000n))
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.rekey(refunded.id, next)), 'state')
  })

  it('release: anyone, not before releaseAt, pays only the seller, once', async () => {
    const env = await setup()
    const a = await buy(env, await listed(env), 2_000)
    const releaseAt = BigInt((await deposit(env, a.id)).releaseAt)
    env.chain.setTime(releaseAt - 1n)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.release(a.id)), 'too early')
    env.chain.setTime(releaseAt)
    const r = await mustSend(env.chain, BUYER3, env.escrow, v2.release(a.id))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: SELLER, value: 18_000_000n }])
    expect(escrowEvents(env, r)).toEqual([{ eventName: 'Released', args: { depositId: a.id, amount: 18_000_000n } }])
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.release(a.id)), 'state')
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.release(999n)), 'state')
    expect(await balanceOf(env, env.escrow)).toBe(0n)
  })
})

// --------------------------------------------------------------------------------------------
describe('owed and claim: a blocked recipient never strands the other party', () => {
  it('a blocked deposit holder: the return becomes owed, and claim pays it once unblocked', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    env.chain.advance(BOND_MAX_AGE)
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(BUYER, 1))
    const r = await mustSend(env.chain, STRANGER, env.escrow, v2.releaseBond(a.id))
    expect(transfers(env, r)).toEqual([])
    expect(escrowEvents(env, r).map((e) => e.eventName)).toEqual(['BondReturned', 'Owed'])
    expect(await owed(env, BUYER)).toBe(3_000_000n)
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.claim(BUYER)), 'transfer failed')
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(BUYER, 0))
    const c = await mustSend(env.chain, STRANGER, env.escrow, v2.claim(BUYER))
    expect(transfers(env, c)).toEqual([{ from: env.escrow, to: BUYER, value: 3_000_000n }])
    expectRevert(await env.chain.send(STRANGER, env.escrow, v2.claim(BUYER)), 'nothing owed')
  })

  it('a blocked earlier buyer does not stop the next sale; a blocked seller does not stop a contest', async () => {
    const env = await setup()
    // A readable remainder sale goes through; after its window the earlier deposit returns, into owed.
    const rl = await listedReadable(env)
    const ra = await buy(env, rl, 1_500)
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(BUYER, 2))
    const b = await buy(env, rl, 500, BUYER2)
    expect(transfers(env, b.r)).toEqual([{ from: BUYER2, to: env.escrow, value: 4_500_000n }])
    env.chain.advance(CONTEST_WINDOW)
    const back = await mustSend(env.chain, STRANGER, env.escrow, v2.releaseBond(ra.id))
    expect(transfers(env, back)).toEqual([])
    expect(await owed(env, BUYER)).toBe(5_000_000n)
    // Your own remainder's netted return, into owed too.
    const ol = await listed(env)
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(BUYER, 0))
    await buy(env, ol, 1_700)
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(BUYER, 1))
    const own = await buy(env, ol, 200, BUYER)
    expect(transfers(env, own.r)).toEqual([])
    expect(await owed(env, BUYER)).toBe(5_200_000n)
    // A blind contest with the seller blocked: the buyer is refunded, the seller is owed.
    const cl = await listed(env)
    await buy(env, cl, 1_700, BUYER3)
    const cb = await buy(env, cl, 300, BUYER2)
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(SELLER, 1))
    const r = await mustSend(env.chain, BUYER2, env.escrow, v2.contestRemainder(cb.id, fresh32('r')))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER2, value: 2_700_000n }])
    expect(await owed(env, SELLER)).toBe(3_000_000n)
  })
})

// --------------------------------------------------------------------------------------------
describe('reentrancy and token quirks', () => {
  async function hookOutcome(env: Env): Promise<{ called: boolean; ok: boolean; reason: string }> {
    const a = { address: env.token, abi: MOCK_TOKEN_ABI } as const
    return {
      called: await env.reader.readContract({ ...a, functionName: 'hookCalled' }),
      ok: await env.reader.readContract({ ...a, functionName: 'hookOk' }),
      reason: revertText(await env.reader.readContract({ ...a, functionName: 'hookReturn' })),
    }
  }

  it('a token calling back into any money path mid-transfer is refused by the guard', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const rl = await listedReadable(env)
    await buy(env, rl, 1_500)
    const sig = await confirmSig(env, rl, 100, now(env))
    const k = await ticketFor(env, l, { depositor: env.token })
    const calls: [string, Hex][] = [
      ['release', v2.release(a.id)],
      ['releaseBond', v2.releaseBond(a.id)],
      ['claim', v2.claim(SELLER)],
      ['contestRemainder', v2.contestRemainder(a.id, fresh32('r'))],
      ['reduceUse', v2.reduceUse(l.t, l.envelopeHash, a.id, 1_600)],
      ['keepRest', v2.keepRest(l.t, l.envelopeHash, a.id)],
      ['sellerRefund', v2.sellerRefund(a.id, 1n)],
      ['sellerCloseRemainder', v2.sellerCloseRemainder(l.listingId, false)],
      ['cancelListing', v2.cancelListing(l.listingId)],
      ['confirmRemainder', v2.confirmRemainder(rl.listingId, 100, now(env), sig)],
      ['depositAndOpen', v2.depositAndOpen(l.t, l.envelopeHash, 300, k)],
    ]
    for (const [name, data] of calls) {
      await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setHook(env.escrow, data))
      // Any purchase pulls from the buyer, and the token calls back during that pull.
      const fresh = await listed(env, { seller: SELLER2 })
      expectOk(await open(env, fresh, 2_000, await ticketFor(env, fresh, { depositor: BUYER2 }), BUYER2))
      expect(await hookOutcome(env), name).toEqual({ called: true, ok: false, reason: 'reentrant' })
    }
    // Payouts too: a hook during release's payout cannot release the bond early.
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setHook(env.escrow, v2.releaseBond(a.id)))
    env.chain.advance(RELEASE_DELAY)
    expectOk(await env.chain.send(STRANGER, env.escrow, v2.release(a.id)))
    expect(await hookOutcome(env)).toEqual({ called: true, ok: false, reason: 'reentrant' })
    expect((await deposit(env, a.id)).bondState).toBe(BOND.HELD)
  })

  it('refuses a fee-on-transfer token on every pull: a sale and a reduceUse', async () => {
    const env = await setup()
    const l = await listed(env)
    const a = await buy(env, l, 1_800)
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setFeeBps(100n))
    const fresh = await listed(env)
    expectRevert(await open(env, fresh, 1_700, await ticketFor(env, fresh)), 'pull amount')
    expectRevert(await env.chain.send(BUYER, env.escrow, v2.reduceUse(l.t, l.envelopeHash, a.id, 1_600)), 'pull amount')
    expect(await deposit(env, a.id)).toMatchObject({ usedCents: 1_800, bond: 2_000_000n })
  })

  it('refuses when the pull fails: no allowance, no balance, or the token returns false', async () => {
    const env = await setup()
    const l = await listed(env)
    await mustSend(env.chain, BUYER, env.token, tokenCall.approve(env.escrow, 18_299_999n))
    expectRevert(await open(env, l, 1_700, await ticketFor(env, l)), 'pull')
    await mustSend(env.chain, BUYER, env.token, tokenCall.approve(env.escrow, 18_300_000n))
    expectOk(await env.chain.call(BUYER, env.escrow, v2.depositAndOpen(l.t, l.envelopeHash, 1_700, await ticketFor(env, l))))
    const broke = testAddress(77)
    await mustSend(env.chain, broke, env.token, tokenCall.approve(env.escrow, maxUint256))
    expectRevert(await open(env, l, 1_700, await ticketFor(env, l, { depositor: broke }), broke), 'pull')
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(env.escrow, 2))
    expectRevert(await open(env, l, 1_700, await ticketFor(env, l)), 'pull')
  })

  it('works with a token that returns no value, in and out', async () => {
    const env = await setup()
    await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setNoReturn(true))
    const l = await listed(env)
    const a = await buy(env, l, 1_700)
    const own = await buy(env, l, 200, BUYER)
    expect(transfers(env, own.r)).toEqual([{ from: env.escrow, to: BUYER, value: 200_000n }])
    env.chain.advance(BOND_MAX_AGE)
    await mustSend(env.chain, STRANGER, env.escrow, v2.release(a.id))
    await mustSend(env.chain, STRANGER, env.escrow, v2.release(own.id))
    const r = await mustSend(env.chain, STRANGER, env.escrow, v2.releaseBond(own.id))
    expect(transfers(env, r)).toEqual([{ from: env.escrow, to: BUYER, value: 1_000_000n }])
    expect(await owed(env, BUYER)).toBe(0n)
    expect(await owed(env, SELLER)).toBe(0n)
    expect(await balanceOf(env, env.escrow)).toBe(0n)
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

  interface Known {
    depositor: Hex
    seller: Hex
    listingId: Hex
    covers: bigint
    state: number
    amount: bigint
    bondState: number
    bond: bigint
    contestUntil: number
  }

  /** Weighted by repetition. A contest is only open for 2 hours, so it is drawn often. */
  const OPS = [
    'list', 'list', 'buy', 'buy', 'buy', 'buy', 'buy', 'buy',
    'release', 'release', 'releaseBond', 'releaseBond', 'contest', 'contest', 'contest', 'contest',
    'reduce', 'reduce', 'keepRest', 'refund', 'cancel', 'close', 'confirm', 'confirm',
    'dispute', 'claim', 'block', 'advance', 'advance',
  ] as const

  async function run(seed: number, steps: number, done: Map<string, number>): Promise<void> {
    const env = await setup()
    const rand = rng(seed)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
    const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
    const buyers = [BUYER, BUYER2, BUYER3] as const
    const listings: Listed[] = []
    const ofListing = new Map<Hex, Listed>()
    const idsOf = new Map<Hex, bigint[]>()
    const known = new Map<bigint, Known>()
    const owedModel = new Map<Hex, bigint>()
    /** Each listing's state as last read, so most buys go to a listing that can sell. */
    const stateOf = new Map<Hex, number>()

    const refresh = async (id: bigint): Promise<void> => {
      const d = await deposit(env, id)
      known.set(id, {
        depositor: lower(d.depositor),
        seller: lower(d.seller),
        listingId: d.listingId,
        covers: d.covers,
        state: d.state,
        amount: d.amount,
        bondState: d.bondState,
        bond: d.bond,
        contestUntil: d.contestUntil,
      })
    }
    const holderOf = (id: bigint): Hex | null => (id === 0n ? null : (known.get(id)?.depositor ?? null))
    /** Mostly a deposit the op can act on, sometimes any deposit at all, so refusals are exercised too. */
    const pickId = (op: string): bigint | null => {
      const n = known.size
      if (n === 0) return null
      const fits = (k: Known): boolean => {
        if (op === 'releaseBond') return k.bondState === BOND.HELD
        if (op === 'keepRest') return k.state === DEPOSIT.OPENED && k.bondState === BOND.HELD
        if (op === 'contest') return k.state === DEPOSIT.OPENED && k.contestUntil > now(env)
        return k.state === DEPOSIT.OPENED
      }
      const good = [...known.entries()].filter(([, k]) => fits(k)).map(([id]) => id)
      if (good.length > 0 && rand() < 0.8) return pick(good)
      return BigInt(rand() < 0.7 ? Math.max(1, n - Math.floor(rand() * 5)) : 1 + Math.floor(rand() * n))
    }

    const checkListing = async (l: Listed, where: string): Promise<void> => {
      const li = await listing(env, l.listingId)
      stateOf.set(l.listingId, li.state)
      const held = (idsOf.get(l.listingId) ?? []).filter((id) => known.get(id)?.bondState === BOND.HELD)
      expect(held.length, `${where} one held deposit per listing`).toBeLessThanOrEqual(1)
      if (held.length === 1) expect(li.bondDeposit, `${where} the held deposit is the listing's`).toBe(held[0])
      if (li.sales === 0) expect(li.remainingCents, where).toBe(0)
      if (li.state === LISTING.DRAINED || li.state === LISTING.SPENT) expect(li.remainingCents, where).toBe(0)
      if (li.state === LISTING.ACTIVE && li.sales > 0) {
        expect(li.remainingCents, `${where} what is left`).toBeGreaterThan(0)
        expect(li.remainingCents, `${where} what is left fits the cap`).toBeLessThanOrEqual(l.t.residualCapCents)
      }
      if (li.state === LISTING.ACTIVE && li.bondDeposit !== 0n) {
        const b = known.get(li.bondDeposit)
        expect({ bondState: b?.bondState, bond: b?.bond }, `${where} the deposit is what is left at face`).toEqual({
          bondState: BOND.HELD,
          bond: BigInt(li.remainingCents) * UNITS_PER_CENT,
        })
      }
    }

    const checkBalance = async (where: string): Promise<void> => {
      let due = 0n
      for (const d of known.values()) {
        if (d.state === DEPOSIT.OPENED) due += d.amount
        if (d.bondState === BOND.HELD) due += d.bond
      }
      for (const v of owedModel.values()) due += v
      expect(await balanceOf(env, env.escrow), `${where}: balance == opened + held + owed`).toBe(due)
    }

    const checkAll = async (where: string): Promise<void> => {
      const cached = new Map(known)
      for (const id of cached.keys()) await refresh(id)
      // Nothing an op did not name changed behind the cache's back.
      expect([...known.entries()], `${where} untouched deposits`).toEqual([...cached.entries()])
      for (const who of ACTORS) expect(await owed(env, who), `${where} owed ${who}`).toBe(owedModel.get(who) ?? 0n)
      await checkBalance(where)
      for (const l of listings) await checkListing(l, where)
      let total = await balanceOf(env, env.escrow)
      for (const who of ACTORS) total += await balanceOf(env, who)
      expect(total, `${where}: nothing minted or burned`).toBe(FUNDS * BigInt(ACTORS.length))
    }

    for (let step = 0; step < steps; step++) {
      const where = `seed ${seed} step ${step}`
      let op: (typeof OPS)[number] = listings.length < 2 ? 'list' : pick(OPS)
      const selling = listings.filter((l) => stateOf.get(l.listingId) === LISTING.ACTIVE)
      if (op === 'buy' && selling.length === 0) op = 'list'
      let r: CallResult | null = null
      let caller: Hex = STRANGER
      let allowed: Hex[] = []
      let touched: Listed | null = null
      let predicted: boolean | null = null
      const id = pickId(op)
      const d = id === null ? null : (known.get(id) ?? null)
      if (d === null && ['release', 'releaseBond', 'contest', 'reduce', 'keepRest', 'refund', 'dispute'].includes(op)) op = 'advance'

      if (op === 'list') {
        const readable = rand() < 0.35
        const valueCents = readable ? int(1, 5_000) : int(1, 2_500)
        const l = await listed(env, {
          seller: pick([SELLER, SELLER2] as const),
          mode: readable ? MODE_READABLE : MODE_BLIND,
          merchant: readable ? 1 : 9,
          valueCents,
          price: BigInt(int(1, valueCents * 10_000)),
          residualCapCents: readable ? int(0, 1_000) : int(0, 500),
          remainderHaircutBps: int(0, 5_000),
        })
        listings.push(l)
        ofListing.set(l.listingId, l)
        idsOf.set(l.listingId, [])
        stateOf.set(l.listingId, LISTING.ACTIVE)
      } else if (op === 'buy') {
        const l = rand() < 0.9 ? pick(selling) : pick(listings)
        touched = l
        const li = await listing(env, l.listingId)
        const have = li.sales === 0 ? l.t.valueCents : li.remainingCents
        const holder = holderOf(li.bondDeposit)
        caller = holder !== null && rand() < 0.3 ? holder : rand() < 0.04 ? l.t.seller : pick(buyers)
        const roll = rand()
        // Another buyer's deposit covers it: mostly use it whole, as the till does.
        const whole = holder !== null && caller !== holder ? 0.8 : 0.4
        const used = roll < whole ? have : roll < 0.85 ? have - int(0, l.t.residualCapCents) : int(0, have + 5)
        const cap = l.t.residualCapCents
        const bal = l.t.mode === MODE_READABLE ? (rand() < 0.9 ? have + int(0, cap) : have - 1) : rand() < 0.95 ? 0 : 1
        const stale = rand() < 0.05
        const k = await ticketFor(env, l, { depositor: caller, openBalanceCents: Math.max(0, bal), ...(stale ? { sales: li.sales + 1 } : {}) })
        const left = have - used
        predicted =
          li.state === LISTING.ACTIVE &&
          caller !== l.t.seller &&
          !stale &&
          used > 0 &&
          used <= have &&
          left <= cap &&
          (li.bondDeposit === 0n || holder === caller || left === 0) &&
          (l.t.mode === MODE_READABLE ? bal >= have && bal <= have + cap : bal === 0)
        allowed = [caller, ...(holder === null ? [] : [holder])]
        r = await open(env, l, Math.max(0, used), k, caller)
        if (r.ok) {
          const newId = await depositCount(env)
          idsOf.get(l.listingId)?.push(newId)
          await refresh(newId)
        }
      } else if (op === 'cancel' || op === 'close' || op === 'confirm') {
        const all = op === 'confirm' ? listings.filter((l) => l.t.mode === MODE_READABLE) : listings
        // Mostly a listing with a remainder for sale.
        const live = all.filter((l) => stateOf.get(l.listingId) === LISTING.ACTIVE && (idsOf.get(l.listingId)?.length ?? 0) > 0)
        const pool = live.length > 0 && rand() < 0.8 ? live : all
        if (pool.length > 0) {
          const l = pick(pool)
          touched = l
          const li = await listing(env, l.listingId)
          const holder = holderOf(li.bondDeposit)
          allowed = [l.t.seller, ...(holder === null ? [] : [holder])]
          if (op === 'cancel') {
            caller = rand() < 0.85 ? l.t.seller : pick(ACTORS)
            r = await env.chain.send(caller, env.escrow, v2.cancelListing(l.listingId))
          } else if (op === 'close') {
            // Half the time the seller is asked at the review time, as the keeper will ask.
            if (rand() < 0.5) env.chain.advance(BOND_REVIEW_AFTER + BigInt(int(0, 172_800)))
            caller = rand() < 0.85 ? l.t.seller : pick(ACTORS)
            r = await env.chain.send(caller, env.escrow, v2.sellerCloseRemainder(l.listingId, rand() < 0.5))
          } else {
            const balance = int(0, li.remainingCents + 50)
            const readAt = now(env) - int(0, 2)
            const sig = await confirmSig(env, l, balance, readAt, rand() < 0.9 ? {} : { bondDeposit: li.bondDeposit + 1n })
            r = await env.chain.send(STRANGER, env.escrow, v2.confirmRemainder(l.listingId, balance, readAt, sig))
          }
        }
      } else if (d !== null && id !== null && op !== 'claim' && op !== 'block' && op !== 'advance') {
        const l = ofListing.get(d.listingId)
        if (!l) throw new Error(`${where}: unknown listing`)
        touched = l
        const holder = holderOf(d.covers)
        allowed = [d.seller, d.depositor, ...(holder === null ? [] : [holder])]
        if (op === 'release') {
          r = await env.chain.send(pick(ACTORS), env.escrow, v2.release(id))
        } else if (op === 'releaseBond') {
          // Sometimes at the deadline the keeper calls it on: past a contest window, or 7 days.
          if (rand() < 0.3) env.chain.advance(pick([CONTEST_WINDOW, BOND_MAX_AGE]))
          r = await env.chain.send(pick(ACTORS), env.escrow, v2.releaseBond(id))
        } else if (op === 'contest') {
          caller = rand() < 0.8 ? d.depositor : pick(ACTORS)
          r = await env.chain.send(caller, env.escrow, v2.contestRemainder(id, fresh32('reason')))
        } else if (op === 'reduce') {
          caller = rand() < 0.85 ? d.depositor : pick(ACTORS)
          const now0 = await deposit(env, id)
          r = await env.chain.send(caller, env.escrow, v2.reduceUse(l.t, l.envelopeHash, id, int(0, now0.usedCents)))
        } else if (op === 'keepRest') {
          caller = rand() < 0.85 ? d.depositor : pick(ACTORS)
          r = await env.chain.send(caller, env.escrow, v2.keepRest(l.t, l.envelopeHash, id))
        } else if (op === 'refund') {
          caller = rand() < 0.85 ? d.seller : pick(ACTORS)
          const roll = rand()
          const amount = roll < 0.4 ? d.amount : roll < 0.8 ? 1n + BigInt(Math.floor(rand() * Number(d.amount))) : roll < 0.9 ? 0n : d.amount + 1n
          r = await env.chain.send(caller, env.escrow, v2.sellerRefund(id, amount))
        } else {
          caller = rand() < 0.85 ? d.depositor : pick(ACTORS)
          r = await env.chain.send(caller, env.escrow, v2.dispute(id, fresh32('reason')))
        }
      } else if (op === 'claim') {
        const due = [...owedModel.entries()].filter(([, v]) => v > 0n).map(([who]) => who)
        const to = due.length > 0 && rand() < 0.8 ? pick(due) : pick(ACTORS)
        allowed = [to]
        r = await env.chain.send(pick(ACTORS), env.escrow, v2.claim(to))
      } else if (op === 'block') {
        await mustSend(env.chain, DEPLOYER, env.token, tokenCall.setBlocked(pick(ACTORS), pick([0, 0, 1, 2] as const)))
      } else {
        env.chain.advance(pick([0, 1, 60, 3_600, 7_199, 7_200, 7_200, 86_400, 86_400, 172_800, 432_000, 432_000, 604_800]))
      }

      if (r !== null) {
        if (predicted !== null) expect({ ok: r.ok, revert: r.revert }, `${where} ${op}`).toEqual(predicted ? { ok: true, revert: null } : { ok: false, revert: expect.any(String) })
        if (r.ok) done.set(op, (done.get(op) ?? 0) + 1)
        // Tokens leave the escrow only to this op's seller, buyer or covered deposit's holder,
        // and come in only from the caller.
        for (const m of transfers(env, r)) {
          if (m.from === env.escrow) expect(allowed, `${where} ${op}: paid ${m.to}`).toContain(m.to)
          else expect({ from: m.from, to: m.to }, `${where} ${op}: pulled`).toEqual({ from: caller, to: env.escrow })
        }
        for (const e of escrowEvents(env, r)) {
          if (e.eventName === 'Owed') {
            const to = lower(e.args.to)
            expect(allowed, `${where} ${op}: owed ${to}`).toContain(to)
            owedModel.set(to, (owedModel.get(to) ?? 0n) + e.args.amount)
          }
          if (e.eventName === 'Claimed') owedModel.set(lower(e.args.to), 0n)
        }
        if (touched) {
          for (const tid of idsOf.get(touched.listingId) ?? []) await refresh(tid)
          await checkListing(touched, `${where} ${op}`)
        }
      }
      await checkBalance(`${where} ${op}`)
      if (step % 30 === 29) await checkAll(where)
    }
    await checkAll(`seed ${seed} end`)
  }

  it('escrow balance == opened + held + owed after every step, and tokens leave only to a seller, buyer, deposit holder or owed', async () => {
    const done = new Map<string, number>()
    for (const seed of [1, 7, 42, 20261012]) await run(seed, 400, done)
    console.log(`fuzz: successful calls by op ${JSON.stringify(Object.fromEntries([...done.entries()].sort()))}`)
    // The runs must exercise money, not only refusals.
    const count = (op: string): number => done.get(op) ?? 0
    expect(count('buy')).toBeGreaterThan(150)
    for (const op of ['release', 'releaseBond', 'contest', 'reduce', 'keepRest', 'refund', 'confirm', 'close', 'claim']) {
      expect(count(op), op).toBeGreaterThan(0)
    }
  }, 300_000)
})
