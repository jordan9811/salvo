/**
 * A platform authenticator for tests: what `navigator.credentials.create` and
 * `.get` do on a phone with Face ID, for P-256 passkeys. Test-only; never
 * referenced from src/.
 *
 * It answers in the browser's own shapes, so viem/tempo's WebAuthnP256 code
 * runs unchanged: a create returns a credential whose response has
 * getPublicKey() (SPKI DER); a get returns authenticator data (rpId hash, UP
 * and UV set, a sign count), the client data JSON with the challenge in
 * base64url, and a DER ECDSA signature over authData || sha256(clientData).
 *
 * Like a real authenticator it keeps ONE passkey per site and user handle: a
 * second create with the same handle replaces the first. That is the hazard
 * wallet.ts's random handle exists for, and tests can see it here.
 *
 * Every prompt is counted (a Face ID), and a test can make the next one fail
 * the way a cancelled Face ID does.
 *
 * A get that names no credential is a discoverable request, as the account
 * sign-in makes (src/lib/account/client/passkey.ts): like a phone's picker,
 * it answers with this site's newest passkey, or fails as an empty sheet the
 * person closes does. `creates` counts only the passkeys made, so a test can
 * prove a sign-in made none.
 */

import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'

const SPKI_P256_PREFIX = Uint8Array.from(Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'))

const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url')
const buf = (b: Uint8Array): ArrayBuffer => Uint8Array.from(b).buffer
const bytesOf = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return v
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  throw new TypeError('expected bytes')
}

interface Stored {
  id: string
  privateKey: Uint8Array
  rpId: string
  userHandle: string
}

/** A NotAllowedError, as a cancelled or timed-out Face ID gives. */
class FakeNotAllowedError extends Error {
  constructor() {
    super('The operation either timed out or was not allowed.')
    this.name = 'NotAllowedError'
  }
}

export class FakeAuthenticator {
  readonly origin: string
  readonly credentials = new Map<string, Stored>()
  /** Every create and get: each is a Face ID on a phone. */
  prompts = 0
  /** Make the next prompt fail as a cancelled Face ID does. */
  refuseNext = false
  /** Every create: each one is a new passkey, so a new account. */
  creates = 0
  private signCount = 0

  constructor(origin = 'http://localhost:3000') {
    this.origin = origin
  }

  private prompt(): void {
    this.prompts += 1
    if (this.refuseNext) {
      this.refuseNext = false
      throw new FakeNotAllowedError()
    }
  }

  /** navigator.credentials.create for one P-256 passkey. */
  readonly createFn = async (options?: unknown): Promise<never> => {
    this.prompt()
    this.creates += 1
    const pk = ((options ?? {}) as { publicKey?: Record<string, unknown> }).publicKey ?? {}
    const rp = (pk.rp ?? {}) as { id?: string }
    const user = (pk.user ?? {}) as { id?: unknown }
    if (typeof rp.id !== 'string' || rp.id === '') throw new TypeError('no relying party id')
    const userHandle = bytesToHex(bytesOf(user.id))
    // One passkey per site and user handle: a second create with the same handle replaces the first.
    for (const [id, c] of this.credentials) if (c.rpId === rp.id && c.userHandle === userHandle) this.credentials.delete(id)
    const privateKey = p256.utils.randomPrivateKey()
    const publicKey = p256.getPublicKey(privateKey, false)
    const idBytes = randomBytes(16)
    const id = b64url(idBytes)
    this.credentials.set(id, { id, privateKey, rpId: rp.id, userHandle })
    const spki = new Uint8Array([...SPKI_P256_PREFIX, ...publicKey])
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: b64url(bytesOf(pk.challenge ?? new Uint8Array())), origin: this.origin }),
    )
    return {
      id,
      rawId: buf(idBytes),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: buf(clientData),
        attestationObject: new ArrayBuffer(0),
        getPublicKey: () => buf(spki),
        getPublicKeyAlgorithm: () => -7,
        getTransports: () => ['internal'],
        getAuthenticatorData: () => new ArrayBuffer(0),
      },
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    } as never
  }

  /** navigator.credentials.get: signs the challenge with the passkey it names. */
  readonly getFn = async (options?: unknown): Promise<never> => {
    this.prompt()
    const pk = ((options ?? {}) as { publicKey?: Record<string, unknown> }).publicKey ?? {}
    const allowed = Array.isArray(pk.allowCredentials) ? (pk.allowCredentials as Array<{ id: unknown }>) : []
    const rpId = typeof pk.rpId === 'string' ? pk.rpId : ''
    // Named credentials, or, for a discoverable request, the picker's newest one for this site.
    const c =
      allowed.length > 0
        ? allowed.map((a) => this.credentials.get(b64url(bytesOf(a.id)))).find((x) => x !== undefined && x.rpId === rpId)
        : [...this.credentials.values()].filter((x) => x.rpId === rpId).at(-1)
    if (c === undefined) throw new FakeNotAllowedError()
    this.signCount += 1
    const flags = 0x05 // user present, user verified
    const authData = new Uint8Array([
      ...sha256(new TextEncoder().encode(rpId)),
      flags,
      (this.signCount >>> 24) & 0xff,
      (this.signCount >>> 16) & 0xff,
      (this.signCount >>> 8) & 0xff,
      this.signCount & 0xff,
    ])
    const clientData = new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.get', challenge: b64url(bytesOf(pk.challenge)), origin: this.origin, crossOrigin: false }),
    )
    const digest = sha256(new Uint8Array([...authData, ...sha256(clientData)]))
    const signature = p256.sign(digest, c.privateKey).toDERRawBytes()
    return {
      id: c.id,
      rawId: buf(Buffer.from(c.id, 'base64url')),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: buf(clientData),
        authenticatorData: buf(authData),
        signature: buf(signature),
        userHandle: buf(Buffer.from(c.userHandle, 'hex')),
      },
      getClientExtensionResults: () => ({}),
    } as never
  }
}
