/**
 * SecretVault — the encryption seam (PHASE2_BRIEF §2).
 *
 * The interface is the point. Two backends implement it: LocalEnvelopeVault,
 * which holds every real card today under VAULT_MASTER_KEY (each recorded as
 * the operator's, including any card a stranger types into the public sell
 * screen: an open decision), and ChipotleVault, which seals to a key that
 * exists only inside Lit's enclave (Lit V3, called over its REST API, no SDK
 * dependency).
 * Both are custodial: ChipotleVault opens a card when our own server signs for it.
 * A backend whose unlock rule reads a fact our server cannot fake implements
 * this interface, but it does not drop in on its own. The four places that open
 * a card (the reveal and settle routes, scripts/reconcile.ts and
 * scripts/redeem-intent.ts) build LocalEnvelopeVault directly, so they need a
 * dispatcher on `ref.algorithm` first. And the public sell screen has to stop
 * recording a stranger's card as the operator's.
 *
 * THE INVARIANT: a card secret never exists in plaintext in logs, in the
 * database, or on-chain. That is enforced three ways, in decreasing order of
 * strength:
 *   1. CardSecret redacts itself on serialise/inspect — you cannot log it by
 *      accident even if you try.
 *   2. The access condition is bound into the AEAD as additional data, so
 *      tampering with it breaks decryption cryptographically rather than
 *      failing an `if`.
 *   3. unseal() fails closed on every unmet condition.
 */

import type { LitSealRecord } from './lit/ref'

/** Opaque handle to a sealed secret. Safe to persist and to broadcast. */
export interface SecretRef {
  id: string
  /** e.g. "aes-256-gcm+envelope". Lets a future backend be identified. */
  algorithm: string
  /** Base64 ciphertext. Never plaintext. */
  ciphertext: string
  iv: string
  authTag: string
  /** The per-secret data key, wrapped by the master key. */
  wrappedKey: string
  wrappedKeyIv: string
  wrappedKeyAuthTag: string
  /** Digest of the access condition this was sealed to. */
  conditionDigest: string
  /**
   * The order this ref was sealed to, or null for a listing-bound seal.
   *
   * Recorded so `unseal` rebuilds the condition from what was SEALED rather
   * than from what the caller presents. Tampering with it is caught anyway —
   * the digest goes into the AEAD, so a changed value simply fails to decrypt.
   */
  boundOrderId?: string | null
  /**
   * Present only on a Lit vault seal: which template, CID, network and template
   * key it was sealed to, the manifest the template checks, and our attestor's
   * signature proving we made the envelope. Absent on every local ref.
   * Untrusted when read back; see parseLitSealRecord.
   */
  lit?: LitSealRecord
  /** Mirrors the condition, so a caller can expire a ref without unsealing. */
  expiresAt: string
  sealedAt: string
}

/**
 * v1 access condition: escrow funded AND order matched AND not expired.
 *
 * Phase 3 widens this to on-chain conditions (the Lit shape). The digest that
 * goes into the AEAD is computed over these fields, so widening it is a
 * versioned change rather than a silent one.
 */
export interface AccessCondition {
  kind: 'escrow_funded_and_matched'
  intentId: string
  /**
   * The order this seal is pinned to, or NULL for a listing-bound seal.
   *
   * ===========================================================================
   * WHY THIS IS NULLABLE, AND WHAT IT COSTS.
   *
   * The digest below goes into the AEAD as additional authenticated data, so a
   * non-null orderId pins the ciphertext to one specific order — you cannot
   * open that card on behalf of any other, and that is a CRYPTOGRAPHIC
   * guarantee rather than a checked one.
   *
   * That is the right binding when the order already exists. It is impossible
   * when it does not: a seller lists a card before any buyer appears, so there
   * is no order id to seal against. The product promise is "scan it in, forget
   * about it", and a model that requires the seller to be present when a buyer
   * arrives cannot deliver it.
   *
   * So a LISTING seals with `null`, which pins the ciphertext to the INTENT and
   * nothing more. The order binding does not disappear — it moves to an
   * explicit assertion that the presented order is the one the intent is
   * currently matched to, made against the database by the unsealing caller
   * (`assertProofMatchesListing`). The intent state machine already guarantees
   * an intent has at most one matched order and cannot be re-matched once
   * executing.
   *
   * BE CLEAR ABOUT THE TRADE: for the custodial backend this genuinely moves
   * one guarantee from cryptography to a runtime check. For the non-custodial
   * backend it is arguably more correct — Lit evaluates a condition about the
   * LISTING's current state network-side, which is exactly the shape of
   * condition it is built for, rather than an order id fixed months earlier.
   *
   * Order-bound seals are unchanged. Nothing already sealed behaves differently.
   * ===========================================================================
   */
  orderId: string | null
  expiresAt: Date
}

/** What the caller presents to prove the condition holds. */
export interface ConditionProof {
  intentId: string
  orderId: string
  /** Escrow actually holds the buyer's funds. */
  escrowFunded: boolean
  /** The intent is matched to this order. */
  matched: boolean
  /** Evaluation time. Injected so expiry is testable without clock mocking. */
  now?: Date
}

/** Machine-readable reasons unseal refused. Never includes secret material. */
export type UnsealDenialCode =
  | 'escrow_not_funded'
  /** A listing-bound seal was presented without an order to bind it to. */
  | 'order_missing'
  | 'order_not_matched'
  | 'expired'
  | 'intent_mismatch'
  | 'order_mismatch'
  | 'condition_tampered'
  | 'not_found'
  /** The Lit action's gate refused. */
  | 'lit_denied'

export class UnsealDeniedError extends Error {
  readonly code: UnsealDenialCode

  constructor(code: UnsealDenialCode, message: string) {
    super(`unseal denied (${code}): ${message}`)
    this.name = 'UnsealDeniedError'
    this.code = code
  }
}

/**
 * A card secret.
 *
 * Deliberately a CLASS, not a plain object. `toJSON` and Node's inspect hook
 * both return a redaction marker, so console.log, JSON.stringify, a Prisma
 * write, an error `cause`, and a structured logger all emit "[redacted
 * CardSecret]" rather than a card number. Reading the value requires calling
 * .reveal() explicitly, which is greppable in review.
 */
export class CardSecret {
  static readonly REDACTED = '[redacted CardSecret]'

  readonly #cardNumber: string
  readonly #pin: string | undefined

  constructor(cardNumber: string, pin?: string) {
    this.#cardNumber = cardNumber
    this.#pin = pin
  }

  /** Explicit, greppable accessor. The ONLY way to get plaintext out. */
  reveal(): { cardNumber: string; pin: string | undefined } {
    return { cardNumber: this.#cardNumber, pin: this.#pin }
  }

  /** Last four, for operator-facing display. Never the full number. */
  get last4(): string {
    return this.#cardNumber.slice(-4)
  }

  toJSON(): string {
    return CardSecret.REDACTED
  }

  toString(): string {
    return CardSecret.REDACTED
  }

  /** node:util.inspect / console.log hook. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return CardSecret.REDACTED
  }
}

export interface SecretVault {
  /** Seal a card secret to an access condition. Returns a pointer only. */
  seal(secret: CardSecret, condition: AccessCondition): Promise<SecretRef>
  /** Unseal only when the condition is satisfied. Fails closed otherwise. */
  unseal(ref: SecretRef, proof: ConditionProof): Promise<CardSecret>
  /** Identifies the backend, for logging and for FINDINGS. */
  readonly backend: string
}

/**
 * Shared condition evaluation, so every backend fails closed identically and a
 * new backend cannot accidentally be more permissive than the default one.
 * Returns null when the proof satisfies the condition.
 */
export function denyReason(
  condition: AccessCondition,
  proof: ConditionProof,
): UnsealDenialCode | null {
  if (proof.intentId !== condition.intentId) return 'intent_mismatch'

  if (condition.orderId === null) {
    // Listing-bound. The seal pins the intent; the ORDER is verified by the
    // caller against `intent.matchedOrderId` before we get here — see
    // assertProofMatchesListing. What this layer can still insist on is that an
    // order was presented at all, so a listing seal can never be opened with no
    // order in hand.
    if (proof.orderId.trim() === '') return 'order_missing'
  } else if (proof.orderId !== condition.orderId) {
    return 'order_mismatch'
  }
  if (!proof.escrowFunded) return 'escrow_not_funded'
  if (!proof.matched) return 'order_not_matched'
  const now = proof.now ?? new Date()
  if (now.getTime() > condition.expiresAt.getTime()) return 'expired'
  return null
}
