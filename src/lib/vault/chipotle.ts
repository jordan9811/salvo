/**
 * ChipotleVault — a SecretVault whose key lives only inside Lit's enclave
 * (Lit V3, "Chipotle"). It is CUSTODIAL, and labelled so.
 *
 * HOW IT WORKS. A card is encrypted on our server, with no Lit call, to the
 * public key of one exact piece of code: the vault template in ./lit/templates.
 * Lit derives that template's private key from the IPFS CID of its bytes, inside
 * its enclave, and hands it to nobody: not us, not our Lit account key. Opening
 * a card is one Lit run of the template. It checks its gate, decrypts, and
 * returns the card encrypted to a one-time key only this process holds, so Lit's
 * response and logs never see the card in clear.
 *
 * The per-card terms (the manifest: intent, order, expiry, attestor) travel as
 * data, but they are the AES-GCM additional data and are mixed into the key
 * derivation. A manifest we did not seal cannot decrypt our ciphertext.
 *
 * That protects what we sealed. It does not say who sealed it. The template's
 * key and the attestor address are public, so anyone who can write a ref can
 * seal a card of their choosing under an unchanged manifest, and the template
 * would open it. So every seal also carries our attestor's signature over the
 * manifest and the envelope (the seal receipt), and unseal checks it before it
 * signs anything.
 *
 * ===========================================================================
 * BE CLEAR ABOUT THE TRADE.
 *
 * Anyone can run the template, so what it checks before opening a card is the
 * whole defence. The only check we can write today is "our server signed this":
 * the attestor key passed to this class. So our server can open any card sealed
 * here, alone. That is custodial, and the guard says so: the backend tag starts
 * `chipotle:attested`, a custodial prefix, and a seller's card is refused under
 * it exactly as under LocalEnvelopeVault.
 *
 * What it changes is where the key is. The database plus VAULT_MASTER_KEY opens
 * nothing sealed here; it takes the attestor key and a Lit run.
 *
 * What would make it non-custodial is a gate that reads a fact our server
 * cannot fake: an escrow deposit on chain. That is a new template beside this
 * one, with its own CID and key, not an edit to this one. The contract for it is
 * not written.
 * ===========================================================================
 *
 * NO PRODUCTION PATH CONSTRUCTS THIS CLASS. Every card is recorded as the
 * operator's and sealed in LocalEnvelopeVault, including any card a stranger
 * types into the public sell screen (an open decision). The resolver only
 * reads `describeConfig` for the readiness report, and the lead's live smoke
 * (`pnpm lit:smoke --live`) is the one place it talks to Lit.
 *
 * FAIL CLOSED, AND CHEAPLY. Every check that can run here does, before anything
 * is sent: is this ref ours, do its parts agree, and the same `denyReason` every
 * backend runs. A local refusal costs nothing and sends nothing. Outage
 * (ChipotleRequestError) and denial (UnsealDeniedError) stay separate, and
 * neither ever falls back to the local vault.
 */

import { createHash, ECDH, randomUUID, timingSafeEqual } from 'node:crypto'
import { recoverMessageAddress } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import {
  CardSecret,
  denyReason,
  UnsealDeniedError,
  type AccessCondition,
  type ConditionProof,
  type SecretRef,
  type SecretVault,
} from './types'
import { conditionDigest } from './envelope'
import { classifyBackend, type BackendCustody } from './guard'
import { canonicalJson, parseCanonicalJson } from './lit/canonical'
import { createReplyKey, envelopeSha256, sealToTemplate, type LitEnvelope } from './lit/envelope-crypto'
import { ChipotleNotConfiguredError, ChipotleRequestError } from './lit/errors'
import { parseLitSealRecord, type LitSealRecord } from './lit/ref'
import { ATTESTED_V1, VAULT_TEMPLATES, assertTemplateIntact, templateIntegrity } from './lit/templates'
import { LIT_NETWORK, runLitAction, type LitActionResult } from './lit/transport'

// Existing import paths keep working.
export { ChipotleNotConfiguredError, ChipotleRequestError }

export const CHIPOTLE_ATTESTED_ALGORITHM = 'chipotle:attested:v1'
/** Carries the template's ACTUAL sha256, so an edited template reports a different tag. */
export const CHIPOTLE_ATTESTED_BACKEND = `chipotle:attested:v1@sha256:${templateIntegrity(ATTESTED_V1).sha256}`

/** What the template accepts as an id. Today's `int_…` ids and cuids fit. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const PUB_RE = /^0x0[23][0-9a-f]{64}$/
const B64_RE = /^[A-Za-z0-9+/]{1,1024}={0,2}$/
const OPEN_DOMAIN = 'salvo/vault/open/v1'
/**
 * The seal receipt's domain. It never reaches Lit: the template accepts only
 * a 7-key attestation in OPEN_DOMAIN, so a receipt can never pass as an open.
 */
const SEAL_RECEIPT_DOMAIN = 'salvo/vault/seal-receipt/v1'
const MANIFEST_MAX_CHARS = 2048
const MAX_CARD_CHARS = 128
const MAX_PIN_CHARS = 64
const MAX_PLAINTEXT_BYTES = 512
const DEFAULT_DEADLINE_MS = 15_000

/** Old Lit settings. Nothing reads them now; readiness names them so they get removed. */
const LEGACY_ENV = [
  'LIT_CHIPOTLE_API_KEY',
  'LIT_CHIPOTLE_BASE_URL',
  'LIT_CHIPOTLE_ENCRYPT_PATH',
  'LIT_CHIPOTLE_DECRYPT_PATH',
  'LIT_CHIPOTLE_EXECUTE_PATH',
] as const

export interface ChipotleVaultOptions {
  /** Required. No env fallback: no production path builds this vault this phase. */
  attestorKey: `0x${string}`
  /** Execute-only usage key. Falls back to LIT_VAULT_USAGE_KEY. Needed only to unseal. */
  usageKey?: string
  /** Template encryption key. Falls back to the pinned ATTESTED_V1.encPub. */
  encPub?: string
  /** Tests only. Production always uses LIT_ORIGIN. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Whole-unseal deadline, default 15000 ms. */
  deadlineMs?: number
  /** Clock for the attestation's issuedAt. Default () => new Date(). */
  clock?: () => Date
  /** Tests only: no real waits between retries. */
  sleep?: (ms: number) => Promise<void>
}

/** LIT_* settings are read directly, with blank meaning unset (the env() schema does not carry them). */
function envValue(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? '').trim()
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The template's own envelope check, run here first so a broken ref costs nothing. */
function envelopeLooksSealed(e: LitEnvelope): boolean {
  if (!PUB_RE.test(e.eph)) return false
  try {
    // Decompressing validates the point is on the curve.
    ECDH.convertKey(e.eph.slice(2), 'secp256k1', 'hex', 'hex', 'uncompressed')
  } catch {
    return false
  }
  const len = (b64: string): number =>
    B64_RE.test(b64) ? Buffer.from(b64, 'base64').length : -1
  const ct = len(e.ct)
  return len(e.iv) === 12 && len(e.tag) === 16 && ct >= 1 && ct <= MAX_PLAINTEXT_BYTES
}

/** What the attestor signs at seal time: this manifest, this envelope, nothing else. */
function sealReceipt(manifest: string, envelope: LitEnvelope): string {
  return canonicalJson({
    domain: SEAL_RECEIPT_DOMAIN,
    manifestSha256: sha256Hex(manifest),
    envelopeSha256: envelopeSha256(envelope),
  })
}

function readCard(value: unknown): { cardNumber: string; pin: string | null } | null {
  if (!isRecord(value)) return null
  const { cardNumber, pin } = value
  if (typeof cardNumber !== 'string' || cardNumber.length < 1 || cardNumber.length > MAX_CARD_CHARS) {
    return null
  }
  if (pin !== null && (typeof pin !== 'string' || pin.length > MAX_PIN_CHARS)) return null
  return { cardNumber, pin }
}

export class ChipotleVault implements SecretVault {
  readonly backend = CHIPOTLE_ATTESTED_BACKEND

  // Private fields, so logging the vault object never prints a key.
  readonly #opts: ChipotleVaultOptions
  readonly #account: PrivateKeyAccount
  readonly #attestor: string

  constructor(opts: ChipotleVaultOptions) {
    // The template's bytes are its key. A drifted copy would seal cards that the
    // real template cannot open, so refuse to exist rather than seal one.
    assertTemplateIntact(ATTESTED_V1)
    let account: PrivateKeyAccount
    try {
      account = privateKeyToAccount(opts.attestorKey)
    } catch {
      // Never echo the value: the library's message can include it.
      throw new ChipotleNotConfiguredError(['attestorKey (not a valid secp256k1 private key)'])
    }
    this.#opts = opts
    this.#account = account
    this.#attestor = account.address.toLowerCase()
  }

  /**
   * What is set and what is missing. Names and booleans only, never a value.
   * Synchronous and offline: the readiness report on /api/health is built from it.
   */
  static describeConfig(env: NodeJS.ProcessEnv = process.env): {
    backend: string
    custody: BackendCustody
    template: string
    templateSha256: string
    templateCid: string
    templateIntact: boolean
    encPubPinned: boolean
    usageKeyPresent: boolean
    missing: string[]
    legacyEnvPresent: string[]
  } {
    const integrity = templateIntegrity(ATTESTED_V1)
    const usageKeyPresent = envValue(env, 'LIT_VAULT_USAGE_KEY') !== ''
    return {
      backend: CHIPOTLE_ATTESTED_BACKEND,
      custody: classifyBackend(CHIPOTLE_ATTESTED_BACKEND),
      template: ATTESTED_V1.id,
      templateSha256: integrity.sha256,
      templateCid: integrity.cid,
      templateIntact: integrity.intact,
      encPubPinned: ATTESTED_V1.encPub !== null,
      usageKeyPresent,
      missing: usageKeyPresent ? [] : ['LIT_VAULT_USAGE_KEY'],
      legacyEnvPresent: LEGACY_ENV.filter((name) => envValue(env, name) !== ''),
    }
  }

  /** The template's public encryption key: the option, or the pinned one. They must agree. */
  #encPub(): string {
    const given = this.#opts.encPub
    const pinned = ATTESTED_V1.encPub
    if (given !== undefined && pinned !== null && given !== pinned) {
      throw new ChipotleNotConfiguredError(['encPub option disagrees with the pinned template key'])
    }
    const encPub = given ?? pinned
    if (encPub === null) {
      throw new ChipotleNotConfiguredError([
        'template encryption key (run pnpm lit:smoke --live, then pin ATTESTED_V1.encPub)',
      ])
    }
    if (!PUB_RE.test(encPub)) {
      throw new ChipotleNotConfiguredError([
        'template encryption key (expected a compressed secp256k1 key in lowercase hex)',
      ])
    }
    return encPub
  }

  #usageKey(): string {
    const key = (this.#opts.usageKey ?? process.env.LIT_VAULT_USAGE_KEY ?? '').trim()
    if (key === '') throw new ChipotleNotConfiguredError(['LIT_VAULT_USAGE_KEY'])
    // The account key can delete groups, mint keys and spend credit. It must
    // never be the key a server holds to run the vault, even by mistake.
    const accountKeys = [envValue(process.env, 'LIT_CHIPOTLE_ACCOUNT_KEY'), envValue(process.env, 'LIT_CHIPOTLE_API_KEY')]
    if (accountKeys.some((k) => k !== '' && k === key)) {
      throw new ChipotleNotConfiguredError([
        'LIT_VAULT_USAGE_KEY (equals the Lit account key; run pnpm lit:setup for an execute-only key)',
      ])
    }
    return key
  }

  /** True only when this vault's attestor signed the receipt for exactly this manifest and envelope. */
  async #sealedHere(lit: LitSealRecord, envelope: LitEnvelope): Promise<boolean> {
    try {
      const signer = await recoverMessageAddress({
        message: sealReceipt(lit.manifest, envelope),
        signature: lit.sealSignature,
      })
      return signer.toLowerCase() === this.#attestor
    } catch {
      // A signature that does not even parse was not made here.
      return false
    }
  }

  async seal(secret: CardSecret, condition: AccessCondition): Promise<SecretRef> {
    const encPub = this.#encPub()

    // Refuse now what the template would refuse at open. A card sealed with an
    // id the template rejects could never be opened, and nobody would know
    // until a buyer paid for it. Errors name the field, never the value.
    if (!ID_RE.test(condition.intentId)) throw new RangeError('intentId is not a valid Lit vault id')
    if (condition.orderId !== null && !ID_RE.test(condition.orderId)) {
      throw new RangeError('orderId is not a valid Lit vault id')
    }
    const expiresAt = condition.expiresAt.getTime()
    // A past expiry is allowed: it seals, and every open is then refused.
    if (!Number.isSafeInteger(expiresAt)) throw new RangeError('expiresAt is not a valid Lit vault expiry')

    const { cardNumber, pin } = secret.reveal()
    const plaintext = Buffer.from(JSON.stringify({ cardNumber, pin: pin ?? null }), 'utf8')
    try {
      if (
        cardNumber.length < 1 ||
        cardNumber.length > MAX_CARD_CHARS ||
        (pin !== undefined && pin.length > MAX_PIN_CHARS) ||
        plaintext.length > MAX_PLAINTEXT_BYTES
      ) {
        throw new RangeError('card secret exceeds the Lit vault template limits')
      }

      const manifest = canonicalJson({
        v: 1,
        template: ATTESTED_V1.id,
        verifier: ATTESTED_V1.verifier,
        intentId: condition.intentId,
        orderId: condition.orderId,
        expiresAt,
        attestor: this.#attestor,
      })
      const envelope = sealToTemplate(encPub, plaintext, manifest)
      const integrity = templateIntegrity(ATTESTED_V1)
      const lit: LitSealRecord = {
        v: 1,
        network: LIT_NETWORK,
        template: ATTESTED_V1.id,
        templateSha256: integrity.sha256,
        cid: integrity.cid,
        encPub,
        manifest,
        // Sealing needs only public values, so the envelope alone proves
        // nothing about who made it. This signature does.
        sealSignature: await this.#account.signMessage({ message: sealReceipt(manifest, envelope) }),
      }

      return {
        id: randomUUID(),
        algorithm: CHIPOTLE_ATTESTED_ALGORITHM,
        ciphertext: envelope.ct,
        iv: envelope.iv,
        authTag: envelope.tag,
        // The ephemeral public key. There is no wrapped data key: the template
        // redoes the ECDH inside Lit. Empty is the honest value for the rest.
        wrappedKey: envelope.eph,
        wrappedKeyIv: '',
        wrappedKeyAuthTag: '',
        conditionDigest: conditionDigest(condition),
        // Always written, null for a listing. Without it a listing seal rebuilds
        // the wrong condition and can never be opened.
        boundOrderId: condition.orderId,
        expiresAt: condition.expiresAt.toISOString(),
        sealedAt: new Date().toISOString(),
        lit,
      }
    } finally {
      plaintext.fill(0)
    }
  }

  async unseal(ref: SecretRef, proof: ConditionProof): Promise<CardSecret> {
    // ---- 1. Is this ours? -------------------------------------------------
    if (ref.algorithm !== CHIPOTLE_ATTESTED_ALGORITHM) {
      throw new UnsealDeniedError('not_found', 'sealed by another backend')
    }
    if (ref.lit === undefined) {
      throw new UnsealDeniedError('not_found', 'this ref carries no Lit seal record')
    }
    let lit: LitSealRecord
    try {
      lit = parseLitSealRecord(ref.lit)
    } catch {
      throw new UnsealDeniedError(
        'not_found',
        'the Lit seal record is malformed or from a version this build does not read',
      )
    }
    const template = Object.hasOwn(VAULT_TEMPLATES, lit.template)
      ? VAULT_TEMPLATES[lit.template]
      : undefined
    if (!template || template.sha256 !== lit.templateSha256 || template.cid !== lit.cid) {
      throw new UnsealDeniedError(
        'not_found',
        'sealed under template bytes this build does not carry; restore those exact bytes to open it',
      )
    }
    if (lit.network !== LIT_NETWORK) {
      throw new UnsealDeniedError('not_found', 'sealed on another Lit network')
    }
    assertTemplateIntact(template)

    // ---- 2. Do the ref's parts agree, and did we seal it? -----------------
    // The database copy is untrusted. An edited manifest, CID or envelope of
    // ours fails to decrypt inside Lit anyway; catching it here costs nothing.
    // A whole new envelope under an unchanged manifest would decrypt, so the
    // seal receipt below is the check that stops it.
    if (ref.boundOrderId === undefined) {
      throw new UnsealDeniedError('condition_tampered', 'the ref does not record which order it was sealed to')
    }
    const m = parseCanonicalJson(lit.manifest, 7, MANIFEST_MAX_CHARS)
    if (
      !m ||
      m.v !== 1 ||
      m.template !== lit.template ||
      m.verifier !== template.verifier ||
      typeof m.intentId !== 'string' ||
      m.orderId !== ref.boundOrderId ||
      typeof m.expiresAt !== 'number' ||
      m.expiresAt !== Date.parse(ref.expiresAt) ||
      typeof m.attestor !== 'string'
    ) {
      throw new UnsealDeniedError('condition_tampered', 'the sealed manifest disagrees with the ref')
    }
    if (lit.encPub !== this.#encPub()) {
      throw new UnsealDeniedError('condition_tampered', 'sealed to a different template key')
    }
    if (m.attestor !== this.#attestor) {
      throw new UnsealDeniedError('condition_tampered', 'this card names a different attestor')
    }
    const condition: AccessCondition = {
      kind: 'escrow_funded_and_matched',
      intentId: m.intentId,
      orderId: ref.boundOrderId,
      expiresAt: new Date(m.expiresAt),
    }
    const expected = Buffer.from(conditionDigest(condition), 'hex')
    const recorded = Buffer.from(ref.conditionDigest, 'hex')
    if (expected.length !== recorded.length || !timingSafeEqual(expected, recorded)) {
      throw new UnsealDeniedError('condition_tampered', 'the presented condition does not match the sealed one')
    }
    const envelope: LitEnvelope = {
      ct: ref.ciphertext,
      eph: ref.wrappedKey,
      iv: ref.iv,
      tag: ref.authTag,
    }
    if (!envelopeLooksSealed(envelope)) {
      throw new UnsealDeniedError('condition_tampered', 'the sealed envelope is malformed')
    }
    // encPub and the attestor address sit in every ref, so sealing to this
    // manifest needs no secret. Only our attestor key can sign the receipt.
    if (!(await this.#sealedHere(lit, envelope))) {
      throw new UnsealDeniedError('condition_tampered', 'this envelope was not sealed by this server')
    }

    // ---- 3. Policy ---------------------------------------------------------
    // The same pre-check every backend runs. Here it is also the authority: the
    // template trusts our signature, and we sign only after this passes. That
    // is exactly why this mode is custodial.
    const denial = denyReason(condition, proof)
    if (denial) {
      throw new UnsealDeniedError(denial, `access condition not satisfied for ref ${ref.id}`)
    }
    if (!ID_RE.test(proof.orderId)) {
      // The template would refuse this order id. Refuse it here, for free.
      throw new UnsealDeniedError('lit_denied', 'the order id is not one the Lit vault template accepts')
    }

    // ---- 4. Config ---------------------------------------------------------
    const usageKey = this.#usageKey()
    const encPub = lit.encPub

    // ---- 5. Attest ---------------------------------------------------------
    // issuedAt is the vault clock, not proof.now: proof.now is for denyReason;
    // the enclave compares issuedAt with its own clock.
    const reply = createReplyKey()
    const payload = canonicalJson({
      domain: OPEN_DOMAIN,
      manifestSha256: sha256Hex(lit.manifest),
      envelopeSha256: envelopeSha256(envelope),
      intentId: proof.intentId,
      orderId: proof.orderId,
      issuedAt: (this.#opts.clock ?? (() => new Date()))().getTime(),
      replyKey: reply.publicKey,
    })
    const signature = await this.#account.signMessage({ message: payload })

    // ---- 6. Run ------------------------------------------------------------
    const result = await runLitAction(
      {
        apiKey: usageKey,
        ...(this.#opts.baseUrl === undefined ? {} : { baseUrl: this.#opts.baseUrl }),
        ...(this.#opts.fetchImpl === undefined ? {} : { fetchImpl: this.#opts.fetchImpl }),
        deadlineMs: this.#opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
        ...(this.#opts.sleep === undefined ? {} : { sleep: this.#opts.sleep }),
      },
      template.source,
      { op: 'open', manifest: lit.manifest, envelope, attestation: { payload, signature } },
    )

    // ---- 7. Read the result --------------------------------------------------
    return readOpenResponse(result, (b64) => reply.open(b64, payload, encPub))
  }
}

function readOpenResponse(
  result: LitActionResult,
  openReply: (b64: string) => Buffer,
): CardSecret {
  const r = result.response
  if (isRecord(r) && r.ok === true && typeof r.reply === 'string') {
    let plain: Buffer | null = null
    try {
      plain = openReply(r.reply)
      const card = readCard(JSON.parse(plain.toString('utf8')))
      if (!card) throw new Error('reply did not hold a card')
      return new CardSecret(card.cardNumber, card.pin ?? undefined)
    } catch {
      throw new ChipotleRequestError(result.status, 'bad_response', 'reply could not be opened')
    } finally {
      plain?.fill(0)
    }
  }
  if (isRecord(r) && r.ok === false && r.error === 'access_denied') {
    throw new UnsealDeniedError('lit_denied', 'the Lit action refused to open this seal')
  }
  if (isRecord(r) && r.ok === false && r.error === 'open_failed') {
    throw new ChipotleRequestError(
      result.status,
      'action_failed',
      'the action could not open this seal (edited ref, wrong template key, or a runtime without WebCrypto AES-GCM)',
    )
  }
  throw new ChipotleRequestError(result.status, 'bad_response', 'the action answered in an unknown shape')
}
