/**
 * The byte-level pieces the browser seal and reply share: secp256k1 ECDH,
 * HKDF-SHA256, AES-256-GCM and base64, on @noble/curves and WebCrypto.
 *
 * Every one mirrors a Node call in src/lib/vault/lit/envelope-crypto.ts and a
 * function in the frozen template, so the three agree to the byte:
 *   sharedX     Node `ecdh.computeSecret` and ethers `computeSharedSecret`: the
 *               shared point's x coordinate, 32 bytes
 *   hkdf32      Node `hkdfSync('sha256', ikm, salt, info, 32)` and the
 *               template's `hkdf32` (RFC 5869, one expand block)
 *   aesGcm*     AES-256-GCM with a 16-byte tag appended, as the template's
 *               WebCrypto calls produce and expect
 *
 * Isomorphic: no Node imports. WebCrypto is `globalThis.crypto`, which every
 * browser and Node 20+ provide.
 *
 * Never logs. Callers zero the secrets they hold; a WebCrypto key made here is
 * non-extractable and lives only for one call.
 */

import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

/** A compressed secp256k1 public key in lower-case hex: what the template accepts. */
export const PUB_RE = /^0x0[23][0-9a-f]{64}$/
/** Strict base64 with padding, as Node's `toString('base64')` writes it. */
export const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
export const TAG_BYTES = 16

/**
 * A copy on a fresh ArrayBuffer. WebCrypto's types want `ArrayBuffer`-backed
 * views, and a copy we own is also one we can zero.
 */
export function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return own(utf8ToBytes(text))
}

/** Lower-case hex sha256 of UTF-8 text: the template's `sha256Hex`. */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)))
}

/** The 33 bytes of a compressed public key, after checking it is one and lies on the curve. */
export function pointBytes(pub: string): Uint8Array {
  if (!PUB_RE.test(pub)) throw new RangeError('expected a compressed secp256k1 public key')
  const bytes = hexToBytes(pub.slice(2))
  // Throws for an x with no point on the curve. A bad key must fail here, not inside ECDH.
  secp256k1.ProjectivePoint.fromHex(bytes).assertValidity()
  return bytes
}

/** ECDH: the x coordinate of secret x pub. The caller zeroes the result. */
export function sharedX(secretKey: Uint8Array, pub: Uint8Array): Uint8Array<ArrayBuffer> {
  const point = secp256k1.getSharedSecret(secretKey, pub, true)
  try {
    return own(point.subarray(1))
  } finally {
    point.fill(0)
  }
}

/** RFC 5869 HKDF-SHA256, 32 bytes. The caller zeroes the result. */
export async function hkdf32(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const base = await globalThis.crypto.subtle.importKey('raw', own(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: own(salt), info: utf8(info) },
    base,
    256,
  )
  return new Uint8Array(bits)
}

async function aesKey(key: Uint8Array, use: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', own(key), { name: 'AES-GCM' }, false, [use])
}

/** AES-256-GCM. Returns ciphertext with the 16-byte tag appended. */
export async function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  additionalData: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const k = await aesKey(key, 'encrypt')
  const out = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: own(iv), additionalData: own(additionalData), tagLength: 128 },
    k,
    own(plaintext),
  )
  return new Uint8Array(out)
}

/** AES-256-GCM over ciphertext-plus-tag. Throws when the tag does not verify; nothing unauthenticated comes back. */
export async function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  additionalData: Uint8Array,
  sealed: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const k = await aesKey(key, 'decrypt')
  const out = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: own(iv), additionalData: own(additionalData), tagLength: 128 },
    k,
    own(sealed),
  )
  return new Uint8Array(out)
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  if (!B64_RE.test(text)) throw new RangeError('expected base64')
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
