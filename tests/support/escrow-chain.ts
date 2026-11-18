/**
 * SalvoEscrowV1 fixtures over TestChain. Test-only; never referenced from src/.
 *
 * Deploys the COMMITTED artifacts (contracts/out/*.json, src/lib/escrow/artifact.ts),
 * never a fresh compile, so every test runs the exact bytes the Lit template
 * will pin. tests/escrow-contract.test.ts separately proves those artifacts
 * equal a fresh compile.
 *
 * The listing and ticket hashes here are written out independently of the
 * contract's own view functions (viem's ABI encoder and EIP-712 hasher), so a
 * test that lists with these ids and opens with these tickets also proves the
 * contract hashes the way the template and the browser will.
 */

import {
  concat,
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from 'viem'
import { ESCROW_ABI, ESCROW_BYTECODE } from '@/lib/escrow/artifact'
import mockTokenArtifact from '../../contracts/out/MockToken.json'
import { TestChain, type DeployResult } from './evm'

/** The MockToken surface the tests use. A test checks it against the compiled ABI. */
export const MOCK_TOKEN_ABI = parseAbi([
  'constructor(uint8 decimals_)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function FEE_SINK() view returns (address)',
  'function BLOCK_REVERT() view returns (uint8)',
  'function BLOCK_RETURN_FALSE() view returns (uint8)',
  'function noReturn() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function blocked(address) view returns (uint8)',
  'function hookTarget() view returns (address)',
  'function hookData() view returns (bytes)',
  'function hookArmed() view returns (bool)',
  'function hookCalled() view returns (bool)',
  'function hookOk() view returns (bool)',
  'function hookReturn() view returns (bytes)',
  'function mint(address to, uint256 amount)',
  'function setNoReturn(bool on)',
  'function setFeeBps(uint256 bps)',
  'function setBlocked(address who, uint8 mode)',
  'function setHook(address target, bytes data)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
])

function hexOf(v: unknown, what: string): Hex {
  if (typeof v !== 'string' || !/^0x([0-9a-f]{2})+$/.test(v)) throw new Error(`${what} is not hex`)
  return v as Hex
}

export const MOCK_TOKEN_BYTECODE: Hex = hexOf(mockTokenArtifact.bytecode, 'MockToken bytecode')

export const MODE_READABLE = 1
export const MODE_BLIND = 2
export const LISTING_ACTIVE = 1
export const LISTING_SOLD = 2
export const LISTING_CANCELLED = 3
export const DEPOSIT_OPENED = 1
export const DEPOSIT_RELEASED = 2
export const DEPOSIT_REFUNDED = 3
export const UNITS_PER_CENT = 10_000n
export const RELEASE_DELAY = 86_400n
export const DISPUTE_HOLD = 172_800n
export const MAX_TICKET_TTL = 900n

/** Mirrors the contract's Terms struct, in the types viem encodes it with. */
export interface Terms {
  seller: Hex
  price: bigint
  valueCents: number
  residualCapCents: number
  merchant: number
  mode: number
  listingExpiry: number
  salt: Hex
}

/** Mirrors the contract's Ticket struct. */
export interface Ticket {
  replyKeyHash: Hex
  openBalanceCents: number
  cardTag: Hex
  notAfter: number
  signature: Hex
}

export const TERMS_TYPE =
  'SalvoTerms(uint256 chainId,address escrow,address token,address seller,uint96 price,uint32 valueCents,uint16 residualCapCents,uint8 merchant,uint8 mode,uint40 listingExpiry,bytes32 salt)'
export const LISTING_TYPE = 'SalvoListing(bytes32 coreHash,bytes32 envelopeHash)'
export const OPEN_TYPE =
  'Open(bytes32 listingId,address depositor,bytes32 replyKeyHash,uint32 openBalanceCents,bytes32 cardTag,uint40 notAfter)'

const id = (s: string): Hex => keccak256(toHex(s))

export function coreHash(chainId: bigint, escrow: Hex, token: Hex, t: Terms): Hex {
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
        { type: 'uint8' },
        { type: 'uint8' },
        { type: 'uint40' },
        { type: 'bytes32' },
      ],
      [
        id(TERMS_TYPE),
        chainId,
        escrow,
        token,
        t.seller,
        t.price,
        t.valueCents,
        t.residualCapCents,
        t.merchant,
        t.mode,
        t.listingExpiry,
        t.salt,
      ],
    ),
  )
}

export function commitmentOf(chainId: bigint, escrow: Hex, token: Hex, t: Terms, envelopeHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [id(LISTING_TYPE), coreHash(chainId, escrow, token, t), envelopeHash],
    ),
  )
}

export function listingIdOf(seller: Hex, commitment: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [seller, commitment]))
}

export interface OpenFields {
  listingId: Hex
  depositor: Hex
  replyKeyHash: Hex
  openBalanceCents: number
  cardTag: Hex
  notAfter: number
}

/** The ticket digest by the EIP-712 standard (viem), not by the contract's view. */
export function openDigest(chainId: bigint, escrow: Hex, f: OpenFields): Hex {
  return hashTypedData({
    domain: { name: 'SalvoEscrow', version: '1', chainId, verifyingContract: escrow },
    types: {
      Open: [
        { name: 'listingId', type: 'bytes32' },
        { name: 'depositor', type: 'address' },
        { name: 'replyKeyHash', type: 'bytes32' },
        { name: 'openBalanceCents', type: 'uint32' },
        { name: 'cardTag', type: 'bytes32' },
        { name: 'notAfter', type: 'uint40' },
      ],
    },
    primaryType: 'Open',
    message: f,
  })
}

/** A ticket as the template signs it: 65 bytes r||s||v, low s, v in {27,28}. */
export async function signTicket(signer: PrivateKeyAccount, chainId: bigint, escrow: Hex, f: OpenFields): Promise<Ticket> {
  const signature = await signer.sign({ hash: openDigest(chainId, escrow, f) })
  return {
    replyKeyHash: f.replyKeyHash,
    openBalanceCents: f.openBalanceCents,
    cardTag: f.cardTag,
    notAfter: f.notAfter,
    signature,
  }
}

export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** The same signature with s' = n - s and v flipped: valid for ecrecover, refused by the low-s rule. */
export function highS(signature: Hex): Hex {
  const r = signature.slice(2, 66)
  const s = BigInt(`0x${signature.slice(66, 130)}`)
  const v = parseInt(signature.slice(130, 132), 16)
  const s2 = (SECP256K1_N - s).toString(16).padStart(64, '0')
  return `0x${r}${s2}${(v === 27 ? 28 : 27).toString(16)}`
}

export function withV(signature: Hex, v: number): Hex {
  return concat([`0x${signature.slice(2, 130)}`, toHex(v, { size: 1 })])
}

/** Deploy MockToken with `decimals` (6 is pathUSD's). */
export async function deployMockToken(chain: TestChain, from: Hex, decimals = 6): Promise<Hex> {
  return chain.deploy(from, encodeDeployData({ abi: MOCK_TOKEN_ABI, bytecode: MOCK_TOKEN_BYTECODE, args: [decimals] }))
}

export function escrowInitCode(litSigner: Hex, token: Hex): Hex {
  return encodeDeployData({ abi: ESCROW_ABI, bytecode: ESCROW_BYTECODE, args: [litSigner, token] })
}

export async function deployEscrowResult(chain: TestChain, from: Hex, litSigner: Hex, token: Hex): Promise<DeployResult> {
  return chain.deployResult(from, escrowInitCode(litSigner, token))
}

export async function deployEscrow(chain: TestChain, from: Hex, litSigner: Hex, token: Hex): Promise<Hex> {
  return chain.deploy(from, escrowInitCode(litSigner, token))
}

/** A viem client whose eth_call runs on `chain`, for typed reads of the escrow and the token. */
export function readerFor(chain: TestChain): PublicClient {
  return createPublicClient({ transport: custom(chain) })
}

/** Calldata builders, typed against the committed ABI. */
export const escrowCall = {
  list: (commitment: Hex): Hex => encodeFunctionData({ abi: ESCROW_ABI, functionName: 'list', args: [commitment] }),
  cancelListing: (listingId: Hex): Hex =>
    encodeFunctionData({ abi: ESCROW_ABI, functionName: 'cancelListing', args: [listingId] }),
  depositAndOpen: (t: Terms, envelopeHash: Hex, k: Ticket): Hex =>
    encodeFunctionData({ abi: ESCROW_ABI, functionName: 'depositAndOpen', args: [t, envelopeHash, k] }),
  dispute: (depositId: bigint, reasonHash: Hex): Hex =>
    encodeFunctionData({ abi: ESCROW_ABI, functionName: 'dispute', args: [depositId, reasonHash] }),
  rekey: (depositId: bigint, replyKeyHash: Hex): Hex =>
    encodeFunctionData({ abi: ESCROW_ABI, functionName: 'rekey', args: [depositId, replyKeyHash] }),
  release: (depositId: bigint): Hex => encodeFunctionData({ abi: ESCROW_ABI, functionName: 'release', args: [depositId] }),
  sellerRefund: (depositId: bigint, amount: bigint): Hex =>
    encodeFunctionData({ abi: ESCROW_ABI, functionName: 'sellerRefund', args: [depositId, amount] }),
  claim: (to: Hex): Hex => encodeFunctionData({ abi: ESCROW_ABI, functionName: 'claim', args: [to] }),
}

export const tokenCall = {
  mint: (to: Hex, amount: bigint): Hex => encodeFunctionData({ abi: MOCK_TOKEN_ABI, functionName: 'mint', args: [to, amount] }),
  approve: (spender: Hex, amount: bigint): Hex =>
    encodeFunctionData({ abi: MOCK_TOKEN_ABI, functionName: 'approve', args: [spender, amount] }),
  setNoReturn: (on: boolean): Hex => encodeFunctionData({ abi: MOCK_TOKEN_ABI, functionName: 'setNoReturn', args: [on] }),
  setFeeBps: (bps: bigint): Hex => encodeFunctionData({ abi: MOCK_TOKEN_ABI, functionName: 'setFeeBps', args: [bps] }),
  setBlocked: (who: Hex, mode: number): Hex =>
    encodeFunctionData({ abi: MOCK_TOKEN_ABI, functionName: 'setBlocked', args: [who, mode] }),
  setHook: (target: Hex, data: Hex): Hex =>
    encodeFunctionData({ abi: MOCK_TOKEN_ABI, functionName: 'setHook', args: [target, data] }),
}
