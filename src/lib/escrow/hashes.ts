/**
 * The hashes that tie a sealed listing to SalvoEscrowV1, in TypeScript.
 *
 * Three copies of each hash exist and all three must agree to the byte: the
 * contract's views (contracts/SalvoEscrowV1.sol), the frozen Lit template
 * (templates/escrow-v1.ts), and this file. If ours drifts, a seller's browser
 * commits to a listing id that no ticket will ever match, or a shopper's phone
 * accepts a ticket the contract refuses. tests/escrow-hashes.test.ts runs all
 * three on 200 generated cases.
 *
 *   coreHash     the listing's terms, bound to chain, escrow and token
 *   commitment   coreHash plus the sealed envelope's hash; this is what goes on chain
 *   listingIdOf  commitment keyed to the seller, so nobody can front-run a listing
 *   openDigest   the EIP-712 digest a Lit ticket signs
 *   replyPayload the text the release reply key is derived from
 *
 * Isomorphic: viem and canonical JSON only, no Node imports. The browser loads this.
 */

import { encodeAbiParameters, keccak256, sha256, stringToHex, type Hex } from 'viem'
import { canonicalJson } from '@/lib/vault/lit/canonical'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { PATH_USD, type EscrowManifest } from './manifest'

const TERMS_TYPE =
  'SalvoTerms(uint256 chainId,address escrow,address token,address seller,uint96 price,uint32 valueCents,uint16 residualCapCents,uint8 merchant,uint8 mode,uint40 listingExpiry,bytes32 salt)'
const LISTING_TYPE = 'SalvoListing(bytes32 coreHash,bytes32 envelopeHash)'
const OPEN_TYPE =
  'Open(bytes32 listingId,address depositor,bytes32 replyKeyHash,uint32 openBalanceCents,bytes32 cardTag,uint40 notAfter)'
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
/** The template's REPLY_DOMAIN: names what a release reply is for. */
const REPLY_DOMAIN = 'salvo/escrow/reply/v1'

const typeHash = (s: string): Hex => keccak256(stringToHex(s))
const TERMS_TYPEHASH = typeHash(TERMS_TYPE)
const LISTING_TYPEHASH = typeHash(LISTING_TYPE)
const OPEN_TYPEHASH = typeHash(OPEN_TYPE)
const DOMAIN_TYPEHASH = typeHash(DOMAIN_TYPE)
const NAME_HASH = typeHash('SalvoEscrow')
const VERSION_HASH = typeHash('1')

/** The contract's Terms struct, in the types viem encodes it with. */
export interface EscrowTerms {
  seller: Hex
  price: bigint
  valueCents: number
  residualCapCents: number
  merchant: number
  mode: number
  listingExpiry: number
  /** bytes32: 0x and 64 hex digits. */
  salt: Hex
}

/** The fields a Lit ticket signs (spec section 5, Open). */
export interface OpenFields {
  listingId: Hex
  depositor: Hex
  replyKeyHash: Hex
  openBalanceCents: number
  cardTag: Hex
  notAfter: number
}

/** keccak256(abi.encode(TERMS_TYPEHASH, chainId, escrow, token, t)): the contract's coreHashOf. */
export function coreHash(chainId: bigint | number, escrow: Hex, token: Hex, t: EscrowTerms): Hex {
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
        TERMS_TYPEHASH,
        BigInt(chainId),
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

/** keccak256(abi.encode(LISTING_TYPEHASH, coreHash, envelopeHash)): the contract's commitmentOf. */
export function commitment(chainId: bigint | number, escrow: Hex, token: Hex, t: EscrowTerms, envelopeHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [LISTING_TYPEHASH, coreHash(chainId, escrow, token, t), envelopeHash],
    ),
  )
}

/** keccak256(abi.encode(seller, commitment)). The seller is inside, so a copied commitment is another listing. */
export function listingIdOf(seller: Hex, commitmentHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [seller, commitmentHash]))
}

/**
 * The EIP-712 digest of a ticket: domain {name "SalvoEscrow", version "1",
 * chainId, verifyingContract escrow}, type Open. Written out the way the
 * contract writes it, so a test can hold it against viem's own typed-data hash.
 *
 * The server checks each ticket Lit signs against it (lit-escrow.ts), and the
 * Load client checks it again before it pays.
 */
export function openDigest(chainId: bigint | number, escrow: Hex, f: OpenFields): Hex {
  const domain = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, BigInt(chainId), escrow],
    ),
  )
  const struct = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'uint32' },
        { type: 'bytes32' },
        { type: 'uint40' },
      ],
      [OPEN_TYPEHASH, f.listingId, f.depositor, f.replyKeyHash, f.openBalanceCents, f.cardTag, f.notAfter],
    ),
  )
  return keccak256(`0x1901${domain.slice(2)}${struct.slice(2)}`)
}

const sha256Hex = (text: string): string => sha256(stringToHex(text)).slice(2)

/**
 * The canonical text a release reply is keyed to: the template's `payload`.
 * The phone passes it to the reply key's `open`, so a reply made for one
 * deposit, escrow or manifest never decrypts as another. `depositId` is the
 * decimal string the template was sent, not a number.
 *
 * The server refuses a release reply keyed to anything else (lit-escrow.ts),
 * and the Load client opens each reply with it.
 */
export function replyPayload(chainId: number, depositId: string, escrow: Hex, manifestText: string): string {
  return canonicalJson({
    chainId,
    depositId,
    domain: REPLY_DOMAIN,
    escrow: escrow.toLowerCase(),
    manifestSha256: sha256Hex(manifestText),
  })
}

/** sha256 of the envelope's canonical JSON, as bytes32: the `envelopeHash` the seller commits to. */
export function envelopeHashOf(e: LitEnvelope): Hex {
  return sha256(stringToHex(canonicalJson({ ct: e.ct, eph: e.eph, iv: e.iv, tag: e.tag })))
}

/** The contract's Terms for a parsed manifest. */
export function termsOfManifest(m: EscrowManifest): EscrowTerms {
  return {
    seller: m.seller,
    price: BigInt(m.price),
    valueCents: m.valueCents,
    residualCapCents: m.residualCapCents,
    merchant: m.merchant,
    mode: m.mode,
    listingExpiry: m.listingExpiry,
    salt: `0x${m.salt}`,
  }
}

/**
 * The listing id a manifest and its envelope commit to: what the seller's
 * `list` registers and what the template recomputes before every ticket and
 * release. Always over pathUSD, the only token the manifest allows.
 *
 * The listings route (listing.ts) and the Load client recompute ids with this.
 */
export function listingIdOfSeal(m: EscrowManifest, envelope: LitEnvelope): Hex {
  const c = commitment(m.chainId, m.escrow, PATH_USD, termsOfManifest(m), envelopeHashOf(envelope))
  return listingIdOf(m.seller, c)
}
