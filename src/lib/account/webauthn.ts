/**
 * One passkey assertion, checked and read the same way on the phone and on
 * our server (unified-account spec, section 3.2).
 *
 * ===========================================================================
 * AN ASSERTION DOES NOT SAY WHICH KEY SIGNED IT. A passkey's public key comes
 * back only once, when it is made, and this phone kept it then
 * (card-store.ts, the passkey record). A fresh Safari tab or a Home Screen
 * icon has its own empty store, so it has the passkey (iCloud Keychain syncs
 * it) but not the key. ECDSA lets the key be recovered from a signature, up
 * to a choice of two: `recoverPublicKeys` gives both, and the caller keeps
 * the one with an account behind it, or asks for a second assertion and keeps
 * the key both share (spec 3.2, step 2).
 *
 * WHAT A GOOD ASSERTION IS, all of it, for whoever checks one:
 *   - the client data says `webauthn.get`, names our origin, is not
 *     cross-origin, and carries exactly the challenge we asked about;
 *   - the authenticator data is for our relying party (its SHA-256 opens it)
 *     and says the person was present and verified (Face ID, not a tap);
 *   - the P-256 signature over authData || SHA-256(clientData) verifies under
 *     the key named. High-s signatures are accepted: authenticators send
 *     them and WebCrypto does not normalise.
 * ===========================================================================
 *
 * Isomorphic and pure: @noble only, no Node builtins, no storage, no network.
 * The server (src/lib/account/session.ts) verifies with it, and the phone
 * (client/passkey.ts) recovers with it.
 */

import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import type { Hex } from 'viem'
import { Account as TempoAccount } from 'viem/tempo'

/** One `navigator.credentials.get` answer, as base64url text, ready for JSON. */
export interface AssertionParts {
  credentialId: string
  authenticatorData: string
  clientDataJSON: string
  /** DER, as the authenticator gives it. */
  signature: string
}

/** Where a passkey belongs: our page's origin, and its hostname as the relying party id. */
export interface RelyingParty {
  origin: string
  rpId: string
}

export const B64URL_RE = /^[A-Za-z0-9_-]{1,4096}$/
/** An uncompressed P-256 key without its 04 prefix: what the passkey record and viem/tempo hold. */
export const PASSKEY_PUBLIC_KEY_RE = /^0x[0-9a-f]{128}$/

/** User present, and user verified: Face ID, not just a tap. */
const FLAG_UP = 0x01
const FLAG_UV = 0x04

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!B64URL_RE.test(text)) throw new RangeError('expected base64url')
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** What a passkey signs: SHA-256 of authData || SHA-256(clientDataJSON). */
function signedDigest(authData: Uint8Array, clientData: Uint8Array): Uint8Array {
  const clientHash = sha256(clientData)
  const joined = new Uint8Array(authData.length + clientHash.length)
  joined.set(authData, 0)
  joined.set(clientHash, authData.length)
  return sha256(joined)
}

interface Decoded {
  authData: Uint8Array
  clientData: Uint8Array
  signature: ReturnType<typeof p256.Signature.fromDER>
}

/** The assertion's bytes, or null when any part is not what an authenticator sends. */
function decode(a: AssertionParts): Decoded | null {
  try {
    const authData = fromBase64Url(a.authenticatorData)
    const clientData = fromBase64Url(a.clientDataJSON)
    // DER only. An authenticator never sends the 64-byte compact form, so one
    // that arrives here was made by something else.
    const signature = p256.Signature.fromDER(fromBase64Url(a.signature))
    return { authData, clientData, signature }
  } catch {
    return null
  }
}

/**
 * Is this a good assertion of `challenge`, for `rp`, by `publicKey`? Every
 * check in the header, and false for anything malformed: never a throw.
 */
export function verifyAssertion(a: AssertionParts, input: { challenge: string; publicKey: Hex; rp: RelyingParty }): boolean {
  if (!PASSKEY_PUBLIC_KEY_RE.test(input.publicKey)) return false
  const d = decode(a)
  if (d === null) return false

  let client: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(d.clientData))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    client = parsed as Record<string, unknown>
  } catch {
    return false
  }
  if (client.type !== 'webauthn.get') return false
  if (client.challenge !== toBase64Url(utf8ToBytes(input.challenge))) return false
  if (client.origin !== input.rp.origin) return false
  if (client.crossOrigin === true) return false

  // rpIdHash (32) and flags (1), then the sign count (4).
  if (d.authData.length < 37) return false
  if (bytesToHex(d.authData.subarray(0, 32)) !== bytesToHex(sha256(utf8ToBytes(input.rp.rpId)))) return false
  const flags = d.authData[32] ?? 0
  if ((flags & FLAG_UP) === 0 || (flags & FLAG_UV) === 0) return false

  try {
    return p256.verify(d.signature, signedDigest(d.authData, d.clientData), hexToBytes(`04${input.publicKey.slice(2)}`))
  } catch {
    return false
  }
}

/**
 * The two public keys this assertion's signature could have come from, as
 * the passkey record holds them. One is the passkey's; which one, the
 * signature alone cannot say. Empty when the assertion does not decode.
 */
export function recoverPublicKeys(a: AssertionParts): Hex[] {
  const d = decode(a)
  if (d === null) return []
  const digest = signedDigest(d.authData, d.clientData)
  const out: Hex[] = []
  for (const bit of [0, 1]) {
    try {
      const point = d.signature.addRecoveryBit(bit).recoverPublicKey(digest)
      out.push(`0x${bytesToHex(point.toRawBytes(false).subarray(1))}`)
    } catch {
      // No point for this bit: the other one is the key.
    }
  }
  return out
}

/** The Tempo account a passkey controls, lower case, exactly as wallet.ts derives it when the passkey is made. */
export function passkeyAddress(publicKey: Hex): Hex {
  return TempoAccount.fromWebAuthnP256({ id: 'salvo', publicKey }).address.toLowerCase() as Hex
}
