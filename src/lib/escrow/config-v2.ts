/**
 * SalvoEscrowV2 on our server: when it counts as configured, what the config
 * route says about it, and the V1 freeze that follows (unified spec sections
 * 8.7 and 16, phase 3).
 *
 * CONFIGURED MEANS EVERY PIN. salvo-vault-escrow/2 is trusted only once the
 * lead's runbook has pinned the escrow address and its deployer, the identity
 * and sealing key from the live bind, and the creation transaction that
 * verifyEscrowCreation passed (deployment.ts). Until then the template still
 * refuses every manifest, nothing on our side reads or relays for V2, and V1
 * runs exactly as before.
 *
 * CONFIGURED IS NOT OPEN. The pins only say V2 is deployed and bound, and
 * the runbook commits them (the smoke needs every one) before anything on
 * our pages can pay or sell on V2. So shoppers meet V2, and V1 freezes, only
 * once ESCROW_V2_LIVE below is true as well. It was flipped in the change
 * that brought the till's V2 quote route and pages (phase 3b: dollars pay at
 * the till, /sell lists on V2), never by the pin steps.
 *
 * THE V1 FREEZE. Once V2 is open (escrowV2Live), V1 takes nothing new: no
 * listing, no quote, no ticket. Each V2 card tag is keyed by V2's own Lit
 * key, so V2 can never see a card V1 sold; a V1 that kept selling would let
 * one card be sold on both. What V1 already sold still settles: its
 * releases, payouts, refunds and claims run as before, and the keeper
 * follows V1 until it is empty.
 *
 * Server-only (templates.ts uses node:crypto). No network call, no database.
 */

import { ESCROW_V2, templateIntegrity, type EscrowTemplate } from '@/lib/vault/lit/templates'
import { ESCROW_LIMITS } from './config'
import { escrowPinProblems } from './deployment'
import { CAP_BLIND_CENTS, CAP_READABLE_CENTS, ESCROW_V2_TEMPLATE_ID, MAX_HAIRCUT_BPS } from './manifest-v2'
import { PATH_USD } from './manifest'
import { templateV2Of, type EscrowRuntime } from './runtime'

export type EscrowTemplateV2 = EscrowTemplate<'salvo-vault-escrow/2'>

/** SalvoEscrowV2's numbers, beside V1's that it keeps (spec section 8.2). */
export const ESCROW_V2_LIMITS = Object.freeze({
  ...ESCROW_LIMITS,
  /** CAP_BLIND: the most a sale may leave on a card nobody can read. */
  capBlindCents: CAP_BLIND_CENTS,
  /** CAP_READABLE: the same where Lit reads the balance. */
  capReadableCents: CAP_READABLE_CENTS,
  maxHaircutBps: MAX_HAIRCUT_BPS,
  /** CONTEST_WINDOW: how long the next shopper may say a leftover was empty. */
  contestWindowSeconds: 7_200,
  /** BOND_REVIEW_AFTER: from then the seller may say what became of an unsold leftover. */
  bondReviewAfterSeconds: 432_000,
  /** BOND_MAX_AGE: a deposit no sale is resolving comes back by rule at this age. */
  bondMaxAgeSeconds: 604_800,
  /** CONFIRM_DELAY: a readable store's balance read this long after a sale closes that buyer's window. */
  confirmDelaySeconds: 900,
})

/** Why this V2 template cannot be used yet, or null when every pin is set and it is intact. */
export function templateV2NotReady(t: EscrowTemplateV2): string | null {
  if (t.id !== ESCROW_V2_TEMPLATE_ID) return 'this is not the salvo-vault-escrow/2 template'
  if (!templateIntegrity(t).intact) return 'the V2 escrow template no longer matches its pins'
  if (t.escrowAddress === null || escrowPinProblems(t).length > 0) return 'the V2 escrow address is not pinned'
  if (t.identity === null) return "the V2 escrow template's signer is not pinned"
  if (t.encPub === null) return "the V2 escrow template's sealing key is not pinned"
  if (t.escrowCreationTx === null) return "the V2 escrow's creation transaction is not pinned"
  return null
}

/** Is SalvoEscrowV2 configured here: deployed, bound and pinned? */
export function escrowV2Configured(rt: EscrowRuntime): boolean {
  return templateV2NotReady(templateV2Of(rt)) === null
}

/**
 * Do our pages pay and sell on SalvoEscrowV2? True since the till pays in
 * dollars on V2 (phase 3b): new sales go to V2, and V1 takes nothing new,
 * while what V1 already sold still releases, pays out and refunds. Testnet
 * only (ESCROW_RAIL=testnet), and not reviewed. The pin steps never touch
 * this line: committing V2's pins alone cannot freeze V1.
 */
export const ESCROW_V2_LIVE: boolean = true

/**
 * Is V2 open to shoppers and sellers: configured, and switched on
 * (ESCROW_V2_LIVE, or the runtime's own `v2Live` in tests)? The V2 listing,
 * ticket and confirm routes and the config route's V2 block answer only then.
 * The keeper and the release route need configured only: what was sold on
 * V2 settles whatever this says.
 */
export function escrowV2Live(rt: EscrowRuntime): boolean {
  return (rt.v2Live ?? ESCROW_V2_LIVE) && escrowV2Configured(rt)
}

/**
 * Is V1 frozen: no new V1 listing, quote or ticket? Exactly when V2 is open
 * (escrowV2Live), never on V2's pins alone. Its sales already made still
 * release, pay out and refund.
 */
export function escrowV1Frozen(rt: EscrowRuntime): boolean {
  return escrowV2Live(rt)
}

/** What a V1 route says once V1 is frozen. Plain words; the page offers the new escrow. */
export const V1_FROZEN_SENTENCE = 'Salvo Pay has moved to its new escrow. Reload the page to use it.'

/** The V2 block of GET /api/escrow/config. Null until V2 is configured. */
export interface EscrowConfigV2 {
  escrow: `0x${string}`
  token: `0x${string}`
  template: {
    id: typeof ESCROW_V2_TEMPLATE_ID
    sha256: string
    cid: string
    intact: boolean
    identity: `0x${string}`
    encPub: `0x0${'2' | '3'}${string}`
    escrowCodehash: `0x${string}`
    escrowCreationTx: `0x${string}`
  }
  limits: typeof ESCROW_V2_LIMITS
}

/**
 * V2's public facts for the config route, or null while it is not
 * configured. All pins, all public. As for V1, the pages hold our server to
 * the values built into them (escrow-pins.ts, ESCROW_V2_PINS) and refuse a
 * config that names anything else.
 */
export function escrowConfigV2(t: EscrowTemplateV2 = ESCROW_V2): EscrowConfigV2 | null {
  if (templateV2NotReady(t) !== null) return null
  if (t.escrowAddress === null || t.identity === null || t.encPub === null || t.escrowCreationTx === null) return null
  return {
    escrow: t.escrowAddress,
    token: PATH_USD,
    template: {
      id: ESCROW_V2_TEMPLATE_ID,
      sha256: t.sha256,
      cid: t.cid,
      intact: templateIntegrity(t).intact,
      identity: t.identity,
      encPub: t.encPub,
      escrowCodehash: t.escrowCodehash,
      escrowCreationTx: t.escrowCreationTx,
    },
    limits: ESCROW_V2_LIMITS,
  }
}
