/**
 * What the escrow server code runs against: the templates it trusts, the two
 * RPC hosts it reads, and how it reaches Lit.
 *
 * In production every value is fixed: the committed templates ESCROW_V1 and
 * ESCROW_V2, the two hosts they pin, Lit's pinned origin, and the clock. V2's
 * template counts only once every pin is set (config-v2.ts); until then the
 * server runs V1 alone, exactly as before. None comes from env,
 * for the reason config.ts gives: a different value could only make our
 * server disagree with Lit, never change what Lit does.
 *
 * Tests replace them with `__setEscrowRuntimeForTests`, so the routes run the
 * real template (pinned the way the lead will pin it) against an in-process
 * chain and fake Lit, with no network.
 *
 * Server-only (templates.ts uses node:crypto). No network call here.
 */

import { ESCROW_V1, ESCROW_V2, type EscrowTemplate } from '@/lib/vault/lit/templates'
import type { LitCallConfig } from '@/lib/vault/lit/transport'
import type { HostsConfig } from './runbook/rpc'

export interface EscrowRuntime {
  template: EscrowTemplate
  /**
   * salvo-vault-escrow/2, for SalvoEscrowV2. Absent: the committed ESCROW_V2
   * (templateV2Of). Optional so a test that runs V1 alone need not name it.
   */
  templateV2?: EscrowTemplate<'salvo-vault-escrow/2'>
  /**
   * Whether V2 is open to our pages (config-v2.ts escrowV2Live). Absent: the
   * committed ESCROW_V2_LIVE. Tests that run V2's routes set it true.
   */
  v2Live?: boolean
  /** The two pinned hosts. Empty in production: rpc.ts then uses the template's own pair. */
  hosts: HostsConfig
  /** How Lit is reached. Empty in production: transport.ts pins the origin. The key is added per call. */
  lit: Omit<LitCallConfig, 'apiKey'>
  /** Milliseconds. For reservations and rate limits only, never for a chain decision. */
  now: () => number
}

let override: Partial<EscrowRuntime> | null = null

export function escrowRuntime(): EscrowRuntime {
  return {
    template: override?.template ?? ESCROW_V1,
    templateV2: override?.templateV2 ?? ESCROW_V2,
    ...(override?.v2Live === undefined ? {} : { v2Live: override.v2Live }),
    hosts: override?.hosts ?? {},
    lit: override?.lit ?? {},
    now: override?.now ?? Date.now,
  }
}

/** The V2 template this runtime trusts: its own, or the committed ESCROW_V2. */
export function templateV2Of(rt: EscrowRuntime): EscrowTemplate<'salvo-vault-escrow/2'> {
  return rt.templateV2 ?? ESCROW_V2
}

/** Tests only. Pass null to go back to production values. */
export function __setEscrowRuntimeForTests(r: Partial<EscrowRuntime> | null): void {
  override = r
}
