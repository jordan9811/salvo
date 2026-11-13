/**
 * The escrow rail's configuration: the chain facts the frozen template pins,
 * and the template's own pins. Nothing here comes from env.
 *
 * WHERE EACH VALUE COMES FROM, and why it is not configurable:
 *   - Chain, RPC hosts and token are written into the template's source, and
 *     the source is the template's key. A different value here could only make
 *     our server disagree with Lit, never change what Lit does. So they are
 *     constants, held equal to the template's text by a test.
 *   - The template's sha256, CID and the escrow code hash come from
 *     src/lib/vault/lit/templates.ts (ESCROW_V1), which recomputes them at load.
 *     Identity and encPub come from the live bind (spec section 15, step 7),
 *     pinned in escrow-pins.ts on 2026-10-10.
 *   - The escrow ADDRESS is pinned in the template too (ESCROW_V1.escrowAddress),
 *     because the template trusts that one deployment and no other: a code hash
 *     covers code, not storage. So an env value could only point our server at
 *     a contract Lit refuses. The chain registry's env name for it
 *     (CHAIN_TEMPO_MODERATO_ESCROW_ADDRESS) is not read here; readiness flags it
 *     when it disagrees with the pin. Pinned on 2026-10-10 to the live
 *     Moderato deployment, whose creation transaction passed
 *     verifyEscrowCreation (deployment.ts) live: the address alone cannot
 *     show what storage the deployer's init code started it with.
 *
 * This file does not import src/lib/mpp.ts or the chain registry, although both
 * name the same Moderato facts: nothing on the escrow rail may reach a module
 * that touches Stripe (spec invariant 12). A test holds the values equal instead.
 *
 * Server-only (templates.ts uses node:crypto). Makes no network call; never
 * logs a value.
 */

import { ESCROW_V1, templateIntegrity, type EscrowTemplate } from '@/lib/vault/lit/templates'
import { ESCROW_RPC_URLS } from './hosts'
import { ESCROW_CHAIN_ID, ESCROW_TEMPLATE_ID, MAX_VALUE_CENTS, PATH_USD, UNITS_PER_CENT } from './manifest'

// The list lives in hosts.ts so the browser can load it without this file's
// node:crypto import; re-exported so the server and scripts keep one name.
export { ESCROW_RPC_URLS }

export const ESCROW_CHAIN_KEY = 'tempo-moderato'
/** The registry's env name for the Moderato escrow address. Readiness checks it against the pin. */
export const ESCROW_ADDRESS_ENV = 'CHAIN_TEMPO_MODERATO_ESCROW_ADDRESS'

/** The contract's and the template's numbers, in one place for pages and routes. */
export const ESCROW_LIMITS = Object.freeze({
  unitsPerCent: UNITS_PER_CENT,
  maxValueCents: MAX_VALUE_CENTS,
  /** The contract's MAX_RESIDUAL_CAP_CENTS. Each merchant's own cap may be lower (merchants.ts). */
  maxResidualCapCents: 1_000,
  /** Seconds from Load until anyone may pay the seller. */
  releaseDelaySeconds: 86_400,
  /** Extra seconds a dispute holds the payout. */
  disputeHoldSeconds: 172_800,
  /** The contract refuses a ticket valid for longer than this. */
  maxTicketTtlSeconds: 900,
  /** How long the template makes a ticket valid, from the finalized block's time. */
  ticketTtlReadableSeconds: 300,
  ticketTtlBlindSeconds: 600,
  /**
   * A blind card worth more than this needs its seller already paid at least
   * its value by finished sales (the contract's paidOut). A count of sales is
   * not used: it is cheap to farm with tiny sales to a second address.
   */
  newSellerBlindCapCents: 2_500,
})

export interface EscrowConfig {
  chain: {
    key: typeof ESCROW_CHAIN_KEY
    chainId: typeof ESCROW_CHAIN_ID
    testnet: true
    rpcUrls: typeof ESCROW_RPC_URLS
  }
  /** The escrow the template pins, lower-case. Null until pinned: then no listing can sell. */
  escrowAddress: `0x${string}` | null
  token: `0x${string}`
  template: {
    id: typeof ESCROW_TEMPLATE_ID
    sha256: string
    cid: string
    /** False when the source no longer hashes to its pins. Nothing should seal or relay then. */
    intact: boolean
    encPub: `0x0${'2' | '3'}${string}` | null
    identity: `0x${string}` | null
    escrowCodehash: `0x${string}`
  }
  limits: typeof ESCROW_LIMITS
}

/**
 * The escrow rail's configuration. Sync and side-effect free, and the same in
 * every environment: every value is a pin. `t` is the committed template in
 * production; tests pass the pinned build they run (src/lib/escrow/runtime.ts).
 * GET /api/escrow/config serves it, and readiness reads it.
 */
export function escrowConfig(t: EscrowTemplate = ESCROW_V1): EscrowConfig {
  return {
    chain: { key: ESCROW_CHAIN_KEY, chainId: ESCROW_CHAIN_ID, testnet: true, rpcUrls: ESCROW_RPC_URLS },
    escrowAddress: t.escrowAddress,
    token: PATH_USD,
    template: {
      id: t.id,
      sha256: t.sha256,
      cid: t.cid,
      intact: templateIntegrity(t).intact,
      encPub: t.encPub,
      identity: t.identity,
      escrowCodehash: t.escrowCodehash,
    },
    limits: ESCROW_LIMITS,
  }
}
