/**
 * The shopper's per-card reply key, on the phone.
 *
 * The template never returns a card in clear. Its `release` encrypts the card
 * to the reply key whose keccak256 the shopper's own `depositAndOpen` put on
 * chain, so Lit's response, our relay and our logs only ever hold ciphertext.
 * This file makes that key and opens what comes back.
 *
 * It mirrors `createReplyKey().open` (src/lib/vault/lit/envelope-crypto.ts)
 * on browser crypto, label for label:
 *   - ECDH between the reply key and the template's `encPub`, x coordinate only
 *   - info = "salvo/vault/reply/v1|" + sha256 hex of the payload text
 *   - HKDF-SHA256 with salt = the compressed reply public key: info + "|key"
 *     gives the AES key, info + "|iv" gives a block whose first 12 bytes are the IV
 *   - AES-256-GCM, additional data = info, 16-byte tag appended
 * The IV is derived, not random: one payload names one deposit, escrow and
 * manifest, so a key and IV never encrypt two different cards.
 *
 * One fresh key per card (spec section 7). Phase 3 keeps `secretKey` in
 * IndexedDB wrapped by a non-extractable AES-GCM key and deletes it once the
 * card is decrypted. Until then it is the caller's to zero.
 *
 * Isomorphic: no Node imports. Never logs.
 */

import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'
import { TAG_BYTES, aesGcmDecrypt, fromBase64, hkdf32, pointBytes, sha256Hex, sharedX, utf8 } from './primitives'

const REPLY_INFO = 'salvo/vault/reply/v1|'

export interface BrowserReplyKey {
  /** 32 bytes. Never leaves the device. */
  secretKey: Uint8Array
  /** Compressed, lower-case hex: what the release request sends as `replyKey`. */
  publicKey: `0x${string}`
  /** keccak256 of the 33 public key bytes: what the ticket and `depositAndOpen` carry. */
  replyKeyHash: `0x${string}`
}

/**
 * A fresh reply key for one card.
 *
 * The Load client (load.ts) makes one per card when it asks for that card's ticket.
 */
export function createBrowserReplyKey(): BrowserReplyKey {
  const secretKey = secp256k1.utils.randomPrivateKey()
  const pub = secp256k1.getPublicKey(secretKey, true)
  return {
    secretKey,
    publicKey: `0x${bytesToHex(pub)}`,
    replyKeyHash: `0x${bytesToHex(keccak_256(pub))}`,
  }
}

/**
 * Decrypt a release `reply` (base64) for the reply key `secretKey`, given the
 * `payloadText` the template returned with it and the template's `encPub`.
 * Returns the card's JSON bytes; the caller zeroes them. Throws on any
 * mismatch: a wrong key, payload or `encPub` never yields bytes.
 *
 * The caller checks the payload names the deposit it asked for (hashes.ts
 * `replyPayload`) before trusting the card.
 *
 * The Load client (load.ts) opens each release with this.
 */
export async function openReply(
  secretKey: Uint8Array,
  replyB64: string,
  payloadText: string,
  encPub: string,
): Promise<Uint8Array> {
  const sealed = fromBase64(replyB64)
  if (sealed.length <= TAG_BYTES) throw new RangeError('reply is too short')
  const encPoint = pointBytes(encPub)
  const pub = secp256k1.getPublicKey(secretKey, true)

  let shared: Uint8Array | null = null
  let key: Uint8Array | null = null
  let ivBlock: Uint8Array | null = null
  try {
    shared = sharedX(secretKey, encPoint)
    const info = REPLY_INFO + sha256Hex(payloadText)
    key = await hkdf32(shared, pub, `${info}|key`)
    ivBlock = await hkdf32(shared, pub, `${info}|iv`)
    return await aesGcmDecrypt(key, ivBlock.subarray(0, 12), utf8(info), sealed)
  } finally {
    shared?.fill(0)
    key?.fill(0)
    ivBlock?.fill(0)
  }
}
