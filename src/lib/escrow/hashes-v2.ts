/**
 * The hashes that tie a sealed listing to SalvoEscrowV2, in TypeScript.
 *
 * As for V1 (hashes.ts), three copies of each hash exist and all three must
 * agree to the byte: the contract's views (contracts/SalvoEscrowV2.sol), the
 * frozen Lit template (templates/escrow-v2.ts), and this file.
 * tests/escrow-v2-hashes.test.ts runs all three, and viem's EIP-712 hasher, on
 * 200 generated cases.
 *
 *   coreHashV2       the listing's terms, now with remainderHaircutBps
 *   commitmentV2     coreHashV2 plus the sealed envelope's hash; what goes on chain
 *   openDigestV2     the ticket Lit signs: OpenV2, under domain version "2". It
 *                    binds the value left and the sales count, never the cents used
 *   confirmDigestV2  a balance Lit read, for confirmRemainder
 *
 * What did not change is reused from hashes.ts as it is: listingIdOf (the
 * seller and the commitment), envelopeHashOf, and replyPayload (its escrow
 * and manifest hash already tell a V2 reply from a V1 one).
 *
 * Isomorphic: viem only, no Node imports. The browser loads this.
 */

import { encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { envelopeHashOf, listingIdOf } from './hashes'
import { PATH_USD } from './manifest'
import type { EscrowManifestV2 } from './manifest-v2'

const TERMS_TYPE =
  'SalvoTerms(uint256 chainId,address escrow,address token,address seller,uint96 price,uint32 valueCents,uint16 residualCapCents,uint16 remainderHaircutBps,uint8 merchant,uint8 mode,uint40 listingExpiry,bytes32 salt)'
const LISTING_TYPE = 'SalvoListing(bytes32 coreHash,bytes32 envelopeHash)'
const OPEN_TYPE =
  'OpenV2(bytes32 listingId,address depositor,bytes32 replyKeyHash,uint32 openBalanceCents,bytes32 cardTag,uint32 remainingCents,uint16 sales,uint40 notAfter)'
const CONFIRM_TYPE = 'Confirm(bytes32 listingId,uint64 bondDeposit,uint32 balance,uint40 readAt)'
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'

const typeHash = (s: string): Hex => keccak256(stringToHex(s))
const TERMS_TYPEHASH = typeHash(TERMS_TYPE)
const LISTING_TYPEHASH = typeHash(LISTING_TYPE)
const OPEN_TYPEHASH = typeHash(OPEN_TYPE)
const CONFIRM_TYPEHASH = typeHash(CONFIRM_TYPE)
const DOMAIN_TYPEHASH = typeHash(DOMAIN_TYPE)
const NAME_HASH = typeHash('SalvoEscrow')
const VERSION_HASH = typeHash('2')

/** SalvoEscrowV2's Terms struct, in the types viem encodes it with. */
export interface EscrowTermsV2 {
  seller: Hex
  price: bigint
  valueCents: number
  residualCapCents: number
  remainderHaircutBps: number
  merchant: number
  mode: number
  listingExpiry: number
  /** bytes32: 0x and 64 hex digits. */
  salt: Hex
}

/** The fields a V2 ticket signs (spec section 8.6, OpenV2). */
export interface OpenV2Fields {
  listingId: Hex
  depositor: Hex
  replyKeyHash: Hex
  openBalanceCents: number
  cardTag: Hex
  /** The value left that Lit saw: valueCents before the first sale. */
  remainingCents: number
  /** The listing's sales that Lit saw. */
  sales: number
  notAfter: number
}

/** A balance Lit read, as confirmRemainder takes it. */
export interface ConfirmFields {
  listingId: Hex
  /** The deposit covering what was left when Lit read it; 0 if none. */
  bondDeposit: bigint
  balance: number
  readAt: number
}

/** keccak256(abi.encode(TERMS_TYPEHASH, chainId, escrow, token, t)): the contract's coreHashOf. */
export function coreHashV2(chainId: bigint | number, escrow: Hex, token: Hex, t: EscrowTermsV2): Hex {
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
        TERMS_TYPEHASH,
        BigInt(chainId),
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

/** keccak256(abi.encode(LISTING_TYPEHASH, coreHashV2, envelopeHash)): the contract's commitmentOf. */
export function commitmentV2(chainId: bigint | number, escrow: Hex, token: Hex, t: EscrowTermsV2, envelopeHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [LISTING_TYPEHASH, coreHashV2(chainId, escrow, token, t), envelopeHash],
    ),
  )
}

/** The EIP-712 digest of `structHash` under {name "SalvoEscrow", version "2", chainId, escrow}. */
function digestV2(chainId: bigint | number, escrow: Hex, structHash: Hex): Hex {
  const domain = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, BigInt(chainId), escrow],
    ),
  )
  return keccak256(`0x1901${domain.slice(2)}${structHash.slice(2)}`)
}

/** secp256k1's order n, halved: SalvoEscrowV2._recover refuses a signature whose s is above it (HALF_N). */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n
const SIG_RE = /^0x[0-9a-fA-F]{130}$/

/**
 * Is this signature in the one form SalvoEscrowV2._recover takes: 65 bytes,
 * v 27 or 28, s in the lower half of the curve's order? viem's recoverAddress
 * also takes the high-s twin of a signature, which the contract refuses, so
 * every check that a ticket or a read will land asks this too. Who signed
 * it is recoverAddress's question, not this one's.
 */
export function signatureFormOkV2(signature: Hex): boolean {
  if (!SIG_RE.test(signature)) return false
  const v = parseInt(signature.slice(130), 16)
  return (v === 27 || v === 28) && BigInt(`0x${signature.slice(66, 130)}`) <= HALF_N
}

/**
 * The digest a V2 ticket signs, written out the way the contract writes it.
 * It names the value left and the sales count, so a ticket from before
 * another sale no longer matches the chain and the contract refuses it.
 */
export function openDigestV2(chainId: bigint | number, escrow: Hex, f: OpenV2Fields): Hex {
  const struct = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'uint32' },
        { type: 'bytes32' },
        { type: 'uint32' },
        { type: 'uint16' },
        { type: 'uint40' },
      ],
      [
        OPEN_TYPEHASH,
        f.listingId,
        f.depositor,
        f.replyKeyHash,
        f.openBalanceCents,
        f.cardTag,
        f.remainingCents,
        f.sales,
        f.notAfter,
      ],
    ),
  )
  return digestV2(chainId, escrow, struct)
}

/**
 * The digest of a balance read Lit signed for confirmRemainder.
 *
 * @wiring-exempt: phase 2 (spec section 16) builds V2 offline. The confirm route and the keeper's 15-minute read land in phase 3.
 */
export function confirmDigestV2(chainId: bigint | number, escrow: Hex, f: ConfirmFields): Hex {
  const struct = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'uint32' }, { type: 'uint40' }],
      [CONFIRM_TYPEHASH, f.listingId, f.bondDeposit, f.balance, f.readAt],
    ),
  )
  return digestV2(chainId, escrow, struct)
}

/** SalvoEscrowV2's Terms for a parsed V2 manifest. */
export function termsOfManifestV2(m: EscrowManifestV2): EscrowTermsV2 {
  return {
    seller: m.seller,
    price: BigInt(m.price),
    valueCents: m.valueCents,
    residualCapCents: m.residualCapCents,
    remainderHaircutBps: m.remainderHaircutBps,
    merchant: m.merchant,
    mode: m.mode,
    listingExpiry: m.listingExpiry,
    salt: `0x${m.salt}`,
  }
}

/**
 * The listing id a V2 manifest and its envelope commit to: what the seller's
 * `list` registers on SalvoEscrowV2 and what the template recomputes before
 * every ticket, release and confirm. Always over pathUSD.
 */
export function listingIdOfSealV2(m: EscrowManifestV2, envelope: LitEnvelope): Hex {
  const c = commitmentV2(m.chainId, m.escrow, PATH_USD, termsOfManifestV2(m), envelopeHashOf(envelope))
  return listingIdOf(m.seller, c)
}
