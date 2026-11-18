/**
 * LocalEnvelopeVault — the v1 SecretVault backend.
 *
 * Envelope encryption: a fresh 256-bit data key per secret encrypts the card,
 * and the master key encrypts the data key. Both use AES-256-GCM.
 *
 * WHY OPERATOR CARDS STAY HERE AND NOT IN LIT. ChipotleVault (./chipotle.ts)
 * is built for Lit's current service, but its only unlock rule today is "our
 * server signed this". That is custodial too. Moving the operator's own cards
 * there would add a paid Lit run to every reveal and a Lit outage to every
 * settlement, and take no power away from us. This backend is deliberately the
 * WEAKEST trust model of the options (we hold the master key), and that is
 * recorded in FINDINGS.md rather than papered over. Cards move off it when a
 * vault template's unlock rule reads a fact our server cannot forge (the escrow
 * contract). That is a new class implementing SecretVault, and more moves with
 * it: the four places that open a card (the reveal and settle routes,
 * scripts/reconcile.ts and scripts/redeem-intent.ts) construct this class
 * directly, so a card sealed anywhere else would fail to open there. They need
 * a dispatcher on `ref.algorithm` first, with outage kept apart from denial in
 * reveal-service. And the public sell screen has to stop recording a
 * stranger's card as the operator's.
 *
 * The access condition is bound into the AEAD as additional authenticated data.
 * That means a tampered condition does not merely fail a policy check — it
 * fails DECRYPTION. An attacker who can rewrite the stored condition still
 * cannot read the card.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import {
  CardSecret,
  denyReason,
  UnsealDeniedError,
  type AccessCondition,
  type ConditionProof,
  type SecretRef,
  type SecretVault,
} from './types'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12

export class VaultNotConfiguredError extends Error {
  constructor() {
    super(
      'VAULT_MASTER_KEY is not set. Generate one with `pnpm vault:key` and set it ' +
        'before sealing or unsealing any card secret.',
    )
    this.name = 'VaultNotConfiguredError'
  }
}

/**
 * Would `LocalEnvelopeVault` be able to seal right now? The same check its
 * `masterKey()` makes, without sealing anything and without naming the key.
 * Exists so the sell screen can say listing is off BEFORE a stranger types a
 * card number and PIN, instead of finding out from the refusal.
 */
export function localVaultConfigured(): boolean {
  const raw = process.env.VAULT_MASTER_KEY
  if (!raw || raw.trim() === '') return false
  return Buffer.from(raw.trim(), 'hex').length === KEY_BYTES
}

/** Canonical serialisation of the condition. Order is fixed on purpose. */
export function conditionDigest(condition: AccessCondition): string {
  const canonical = [
    `kind=${condition.kind}`,
    `intent=${condition.intentId}`,
    `order=${condition.orderId}`,
    `expires=${condition.expiresAt.toISOString()}`,
  ].join('|')
  return createHash('sha256').update(canonical).digest('hex')
}

export interface LocalEnvelopeVaultOptions {
  /** 32-byte master key. Falls back to VAULT_MASTER_KEY (64 hex chars). */
  masterKey?: Buffer
}

export class LocalEnvelopeVault implements SecretVault {
  readonly backend = 'local-envelope:aes-256-gcm'

  private readonly injectedKey: Buffer | undefined

  constructor(opts: LocalEnvelopeVaultOptions = {}) {
    this.injectedKey = opts.masterKey
  }

  private masterKey(): Buffer {
    if (this.injectedKey) return this.injectedKey
    const raw = process.env.VAULT_MASTER_KEY
    if (!raw || raw.trim() === '') throw new VaultNotConfiguredError()
    const key = Buffer.from(raw.trim(), 'hex')
    if (key.length !== KEY_BYTES) {
      throw new VaultNotConfiguredError()
    }
    return key
  }

  async seal(secret: CardSecret, condition: AccessCondition): Promise<SecretRef> {
    const master = this.masterKey()
    const digest = conditionDigest(condition)

    // Per-secret data key. Reusing a key across secrets would let a single
    // compromise unlock everything.
    const dataKey = randomBytes(KEY_BYTES)
    const iv = randomBytes(IV_BYTES)

    const cipher = createCipheriv(ALGORITHM, dataKey, iv)
    // Bind the condition cryptographically, not just by policy.
    cipher.setAAD(Buffer.from(digest, 'hex'))

    const { cardNumber, pin } = secret.reveal()
    const plaintext = JSON.stringify({ cardNumber, pin: pin ?? null })
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()

    // Wrap the data key under the master key.
    const wrapIv = randomBytes(IV_BYTES)
    const wrapper = createCipheriv(ALGORITHM, master, wrapIv)
    wrapper.setAAD(Buffer.from(digest, 'hex'))
    const wrappedKey = Buffer.concat([wrapper.update(dataKey), wrapper.final()])
    const wrapAuthTag = wrapper.getAuthTag()

    // The data key exists in this process only for the lifetime of this call.
    dataKey.fill(0)

    return {
      id: randomUUID(),
      algorithm: this.backend,
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      wrappedKey: wrappedKey.toString('base64'),
      wrappedKeyIv: wrapIv.toString('base64'),
      wrappedKeyAuthTag: wrapAuthTag.toString('base64'),
      conditionDigest: digest,
      boundOrderId: condition.orderId,
      expiresAt: condition.expiresAt.toISOString(),
      sealedAt: new Date().toISOString(),
    }
  }

  async unseal(ref: SecretRef, proof: ConditionProof): Promise<CardSecret> {
    const master = this.masterKey()

    // Rebuild the condition this ref was sealed to, then check the proof
    // against it. FAIL CLOSED: any unmet condition throws before a single byte
    // is decrypted.
    const condition: AccessCondition = {
      kind: 'escrow_funded_and_matched',
      intentId: proof.intentId,
      // From the REF, not the proof: a listing-bound seal recorded `null`, and
      // rebuilding from the proof would produce a digest that never matches.
      // `undefined` means a ref sealed before this field existed, which was
      // always order-bound.
      orderId: ref.boundOrderId === undefined ? proof.orderId : ref.boundOrderId,
      expiresAt: new Date(ref.expiresAt),
    }

    const expectedDigest = conditionDigest(condition)
    const a = Buffer.from(expectedDigest, 'hex')
    const b = Buffer.from(ref.conditionDigest, 'hex')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      // The proof describes a different condition than the one sealed. Could be
      // a mismatched intent/order, or a tampered ref.
      throw new UnsealDeniedError(
        'condition_tampered',
        'the presented condition does not match the sealed one',
      )
    }

    const denial = denyReason(condition, proof)
    if (denial) {
      throw new UnsealDeniedError(denial, `access condition not satisfied for ref ${ref.id}`)
    }

    let dataKey: Buffer | null = null
    try {
      const unwrap = createDecipheriv(ALGORITHM, master, Buffer.from(ref.wrappedKeyIv, 'base64'))
      unwrap.setAAD(Buffer.from(ref.conditionDigest, 'hex'))
      unwrap.setAuthTag(Buffer.from(ref.wrappedKeyAuthTag, 'base64'))
      dataKey = Buffer.concat([
        unwrap.update(Buffer.from(ref.wrappedKey, 'base64')),
        unwrap.final(),
      ])

      const decipher = createDecipheriv(ALGORITHM, dataKey, Buffer.from(ref.iv, 'base64'))
      decipher.setAAD(Buffer.from(ref.conditionDigest, 'hex'))
      decipher.setAuthTag(Buffer.from(ref.authTag, 'base64'))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ref.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')

      const parsed: unknown = JSON.parse(plaintext)
      const { cardNumber, pin } = parsed as { cardNumber: string; pin: string | null }
      return new CardSecret(cardNumber, pin ?? undefined)
    } catch (err) {
      if (err instanceof UnsealDeniedError) throw err
      // A GCM auth failure means the ref or its condition was altered. Do not
      // leak the underlying crypto error, which can be an oracle.
      throw new UnsealDeniedError(
        'condition_tampered',
        'ciphertext failed authentication; the ref or its condition was altered',
      )
    } finally {
      dataKey?.fill(0)
    }
  }
}

/** Generate a master key. Used by `pnpm vault:key`. */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString('hex')
}
