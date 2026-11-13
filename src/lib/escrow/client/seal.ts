/**
 * The seller's browser seals a card to the escrow template, so the card's
 * plaintext is never posted to our server (spec invariant 8).
 *
 * This is `sealToTemplate` (src/lib/vault/lit/envelope-crypto.ts) on browser
 * crypto, and it must stay byte-compatible with it and with the template's
 * `openCard`:
 *   - a fresh secp256k1 ephemeral key (@noble/curves); ECDH with the
 *     template's pinned `encPub`, x coordinate only (what Node's ECDH and
 *     ethers return)
 *   - HKDF-SHA256 to 32 bytes: salt = the compressed ephemeral key, info =
 *     "salvo/vault/seal/v1|" + sha256 hex of the manifest. A manifest we did
 *     not seal under cannot even derive the key
 *   - AES-256-GCM, a random 12-byte IV, the manifest as additional data, so a
 *     manifest edited by one byte fails the tag inside Lit
 *
 * The output is a LitEnvelope, the same four base64/hex fields Node writes.
 * tests/escrow-seal-browser.test.ts seals here and opens inside the real
 * template.
 *
 * What this does not do: check that `encPub` is the template's. The caller
 * passes only the key built into the page (src/lib/vault/lit/escrow-pins.ts):
 * api.ts refuses a config that names any other, so our server cannot pick the
 * key a card is sealed to. Spec section 8.2 step 3 also asks for a pinned bind
 * signature over the key; none is recorded yet, so the pin is the check.
 *
 * Isomorphic: no Node imports. Never logs; zeroes every secret it made.
 */

import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { TAG_BYTES, aesGcmEncrypt, hkdf32, pointBytes, sha256Hex, sharedX, toBase64, utf8 } from './primitives'

const SEAL_INFO = 'salvo/vault/seal/v1|'
/** The template refuses ciphertext outside 1..512 bytes. */
const MAX_PLAINTEXT_BYTES = 512

/**
 * Seal `plaintext` (the card's JSON, `{cardNumber, pin}`, as UTF-8) to the
 * template key `encPub` under `manifestText`. The caller zeroes `plaintext`.
 *
 * The escrow branch of /sell seals the card with this (sell.ts).
 */
export async function sealInBrowser(encPub: string, plaintext: Uint8Array, manifestText: string): Promise<LitEnvelope> {
  if (plaintext.length < 1 || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new RangeError('card secret exceeds the Lit vault template limits')
  }
  const encPoint = pointBytes(encPub)
  const ephSecret = secp256k1.utils.randomPrivateKey()
  const eph = secp256k1.getPublicKey(ephSecret, true)

  let shared: Uint8Array | null = null
  let key: Uint8Array | null = null
  try {
    shared = sharedX(ephSecret, encPoint)
    key = await hkdf32(shared, eph, SEAL_INFO + sha256Hex(manifestText))
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const sealed = await aesGcmEncrypt(key, iv, utf8(manifestText), plaintext)
    const cut = sealed.length - TAG_BYTES
    return {
      ct: toBase64(sealed.subarray(0, cut)),
      eph: `0x${bytesToHex(eph)}`,
      iv: toBase64(iv),
      tag: toBase64(sealed.subarray(cut)),
    }
  } finally {
    ephSecret.fill(0)
    shared?.fill(0)
    key?.fill(0)
  }
}
