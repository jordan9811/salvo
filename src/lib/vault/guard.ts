/**
 * The custody guard — PHASE3_BRIEF, blocking prerequisite.
 *
 * The rule, stated once: **no multi-user supply path may seal a real seller
 * secret under `LocalEnvelopeVault`.** The brief is explicit that this is
 * enforced in code, not policy, so it lives here as a function every supply path
 * must call rather than as a paragraph in a doc someone reads once.
 *
 * Why it matters: `VAULT_MASTER_KEY` was fine while every sealed card belonged
 * to the operator — the operator decrypting the operator's own card is not a
 * trust failure. The moment a third party's card is sealed under that same key,
 * it becomes precisely the honeypot the architecture exists to avoid: one env
 * compromise yields every seller's card.
 *
 * FAIL CLOSED. Backends are classified explicitly and an UNRECOGNISED backend is
 * refused for seller secrets. A future backend has to be deliberately declared
 * non-custodial to carry third-party cards; forgetting to classify it means
 * seller onboarding stops, which is the safe direction to fail.
 */

import { parseEscrowManifest } from '../escrow/manifest'
import { parseEscrowSealRecord } from '../escrow/seal-record'
import type { AccountOwner } from '../supply/accounts'
import { CHIPOTLE_ESCROW_ALGORITHM, CHIPOTLE_ESCROW_BACKEND } from './escrow-backend'
import { ESCROW_V1, templateIntegrity } from './lit/templates'
import type { AccessCondition, CardSecret, SecretRef, SecretVault } from './types'

/**
 * A single party's key alone decrypts. Prefix match on a ':' boundary, so a
 * backend can version its suffix freely but `local-envelopeX` matches nothing.
 *
 * `chipotle:attested` is the Lit vault. Its key lives inside Lit's enclave, but
 * the template opens a card whenever our own server signs for it, so our server
 * alone can open any card sealed there. That is custodial, whatever the enclave.
 */
const CUSTODIAL_BACKEND_PREFIXES = ['local-envelope', 'chipotle:attested'] as const

/**
 * EXACT backend tags only, never prefixes. Empty on purpose: a tag lands here only
 * together with a reviewed template whose unlock rule checks a fact our server
 * cannot forge, with that template's sha256 inside the tag.
 *
 * It used to hold the prefix `chipotle`, on the claim that Lit enforced the
 * condition network-side. It never did: the old client called endpoints that do
 * not exist, and Lit V3 enforces only what the template checks.
 *
 * The escrow template (salvo-vault-escrow/1) is the first whose rule reads a
 * fact our server cannot fake: a final on-chain purchase. Since 2026-10-10 its
 * escrow is deployed on the Tempo Moderato testnet and its live smoke on Lit
 * passed, but it has not been reviewed, so its tag
 * (CHIPOTLE_ESCROW_BACKEND) is NOT here and classifies `unknown`. It lands as
 * one exact literal, with the reviewer's name and the date, only once every
 * condition in spec section 11 holds (Phase 5). tests/escrow-guard.test.ts
 * fails if anything is added before then.
 *
 * A note on what this protects. An object can still claim any tag string; only
 * the type checker stops that. The guard is server code, so it keeps our own
 * decisions honest. What protects a card already sealed is the CID binding inside
 * Lit, not this set.
 */
const NON_CUSTODIAL_BACKENDS: ReadonlySet<string> = new Set<string>()

/**
 * Test doubles. Permitted for seller secrets so the multi-user supply layer can
 * be built and tested before the real backend exists — but refused outright when
 * NODE_ENV is production, so a test double can never quietly become the
 * production custody model.
 */
const TEST_BACKEND_PREFIXES = ['in-memory'] as const

/**
 * Every escrow backend, any version or hash. A plain string prefix on purpose,
 * not a ':' boundary: refusing a lookalike such as `chipotle:escrowX` for a
 * server-side seal costs nothing.
 */
const ESCROW_BACKEND_PREFIX = 'chipotle:escrow'

export type BackendCustody = 'custodial' | 'non_custodial' | 'test_only' | 'unknown'

const hasPrefix = (b: string, p: string): boolean => b === p || b.startsWith(p + ':')

export function classifyBackend(backend: string): BackendCustody {
  if (CUSTODIAL_BACKEND_PREFIXES.some((p) => hasPrefix(backend, p))) return 'custodial'
  if (NON_CUSTODIAL_BACKENDS.has(backend)) return 'non_custodial'
  if (TEST_BACKEND_PREFIXES.some((p) => hasPrefix(backend, p))) return 'test_only'
  return 'unknown'
}

export class CustodialVaultRefusedError extends Error {
  readonly backend: string
  readonly ownerId: string

  constructor(backend: string, ownerId: string, detail: string) {
    super(
      `refusing to seal a seller secret under "${backend}": ${detail}. ` +
        `Seller ${ownerId}'s card must be sealed under a backend where no single ` +
        `party can decrypt it alone. See PHASE3_BRIEF.md, blocking prerequisite.`,
    )
    this.name = 'CustodialVaultRefusedError'
    this.backend = backend
    this.ownerId = ownerId
  }
}

/**
 * Throw unless `vault` may hold a secret belonging to `owner`.
 *
 * Operator-owned secrets are unrestricted: the operator holding a key to their
 * own card is the status quo, not a custody failure. Everything else must clear
 * the classification above.
 */
export function assertVaultAllowedForOwner(vault: SecretVault, owner: AccountOwner): void {
  // Before the operator carve-out: nobody, the operator included, may seal an
  // escrow listing from plaintext on our server. The whole point of that rail
  // is that the card is sealed in the seller's browser and never reaches us.
  if (vault.backend.startsWith(ESCROW_BACKEND_PREFIX)) {
    throw new CustodialVaultRefusedError(
      vault.backend,
      owner.ownerId,
      "escrow seals are made in the seller's browser, never from plaintext on our server",
    )
  }

  if (owner.kind === 'operator') return

  const custody = classifyBackend(vault.backend)

  if (custody === 'custodial') {
    throw new CustodialVaultRefusedError(
      vault.backend,
      owner.ownerId,
      'a single party (the operator) can decrypt it alone',
    )
  }

  if (custody === 'unknown') {
    throw new CustodialVaultRefusedError(
      vault.backend,
      owner.ownerId,
      'this backend has not been classified as non-custodial (failing closed)',
    )
  }

  if (custody === 'test_only' && process.env.NODE_ENV === 'production') {
    throw new CustodialVaultRefusedError(
      vault.backend,
      owner.ownerId,
      'this is a test-only backend and must never hold a real secret in production',
    )
  }
}

/**
 * The ONLY sanctioned way to seal a secret that belongs to a supplying account.
 *
 * Supply paths call this rather than `vault.seal` directly, so the custody check
 * cannot be forgotten: forgetting it means calling the wrong function, which is
 * greppable, rather than omitting a line, which is invisible.
 */
export async function sealForOwner(
  vault: SecretVault,
  secret: CardSecret,
  condition: AccessCondition,
  owner: AccountOwner,
): Promise<SecretRef> {
  assertVaultAllowedForOwner(vault, owner)
  return vault.seal(secret, condition)
}

/**
 * The parts of a sealed ref the guard reads. `lit` is whatever the ref holds
 * there: the guard names the escrow only when it parses as an escrow seal
 * record (src/lib/escrow/seal-record.ts), which an attested record never does.
 * Read back from the database or a request body, so every field is untrusted.
 */
export interface GuardedSealedRef {
  algorithm: string
  lit?: unknown
}

/**
 * The backend a sealed ref belongs to, for classification.
 *
 * The escrow tag only when the ref says escrow AND its `lit` block is a
 * well-formed escrow seal record (exactly its seven keys, no sealSignature)
 * naming salvo-vault-escrow/1 with exactly the pinned sha256 and CID AND the
 * template in this build is intact. Anything less is the ref's bare
 * `algorithm`, which classifies as `unknown` (or `custodial`, for an attested
 * ref), never as the escrow. So a ref cannot borrow the escrow's standing by
 * naming it loosely.
 *
 * The escrow listings route classifies each browser-sealed ref with this,
 * through assertSealedRefAllowedForOwner.
 */
export function backendOfSealedRef(ref: GuardedSealedRef): string {
  /*
    ONLY THE VERIFIED PATH BELOW MAY NAME THE ESCROW BACKEND. A ref is data
    from a browser or the database, so its algorithm can say anything,
    including the full reviewed tag ("chipotle:escrow:v1@sha256:..."). Passing
    that through would skip every pin check once the tag joins
    NON_CUSTODIAL_BACKENDS, and would let a ref sealed to the custodial
    attested template, or to a drifted escrow template, pass as reviewed. Any
    escrow-looking algorithm that is not the bare one is answered with the bare
    one, which classifies as unknown and is refused.
  */
  if (ref.algorithm !== CHIPOTLE_ESCROW_ALGORITHM) {
    return ref.algorithm.startsWith('chipotle:escrow') ? CHIPOTLE_ESCROW_ALGORITHM : ref.algorithm
  }
  const lit = parseEscrowSealRecord(ref.lit)
  if (lit === null || lit.template !== ESCROW_V1.id) return ref.algorithm
  if (lit.templateSha256 !== ESCROW_V1.sha256 || lit.cid !== ESCROW_V1.cid) return ref.algorithm
  if (!templateIntegrity(ESCROW_V1).intact) return ref.algorithm
  return CHIPOTLE_ESCROW_BACKEND
}

/**
 * Throw unless a ref sealed elsewhere (in a seller's browser) may be recorded
 * as `owner`'s listing.
 *
 * The operator carve-out is the same as `assertVaultAllowedForOwner`'s. For
 * anyone else, two rules, both required:
 *   1. The manifest's seller is this owner. An escrow seller's owner id is
 *      `seller:` plus their lower-case address (the Intent's accountId, spec
 *      section 12), so a seller cannot file someone else's listing as theirs.
 *      The manifest is read as the template reads it, so it must also name
 *      the escrow the template pins; until one is pinned, none does.
 *   2. The backend is `non_custodial`. Until the escrow tag passes review and
 *      joins NON_CUSTODIAL_BACKENDS, this refuses every seller.
 * The seller check runs first only so the refusal names the plainer problem.
 *
 * The escrow listings route calls it before writing an Intent
 * (src/lib/escrow/listing.ts, acceptSealedListing).
 */
export function assertSealedRefAllowedForOwner(ref: GuardedSealedRef, owner: AccountOwner): void {
  if (owner.kind === 'operator') return

  const backend = backendOfSealedRef(ref)
  const record = parseEscrowSealRecord(ref.lit)
  const manifest = record === null ? null : parseEscrowManifest(record.manifest, ESCROW_V1.escrowAddress)

  if (manifest !== null && owner.ownerId !== `seller:${manifest.seller}`) {
    throw new CustodialVaultRefusedError(backend, owner.ownerId, "the listing's seller address is not this account")
  }

  const custody = classifyBackend(backend)
  if (custody !== 'non_custodial') {
    throw new CustodialVaultRefusedError(
      backend,
      owner.ownerId,
      custody === 'custodial'
        ? 'a single party (the operator) can decrypt it alone'
        : 'this backend has not passed the custody review (failing closed)',
    )
  }

  if (manifest === null) {
    throw new CustodialVaultRefusedError(backend, owner.ownerId, 'the ref names no escrow seller to check (failing closed)')
  }
}
