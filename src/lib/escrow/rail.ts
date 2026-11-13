/**
 * Is the escrow rail switched on here? (lead override: OFF unless ESCROW_RAIL=testnet)
 *
 * Every escrow route answers 503 with a plain sentence, every escrow page
 * shows "not available", and the cron keeper does nothing, unless the setting
 * is exactly the word `testnet`. Production does not set it.
 *
 * The same rule readiness.ts applies (its `escrow_rail_off` blocker); a test
 * holds the two equal for every value. Kept here, apart from readiness, so a
 * route can ask without building a whole readiness report.
 *
 * Reads process.env directly, never src/lib/env.ts: that module names the
 * Stripe keys, and nothing on this rail may reach it (spec invariant 12).
 */

type Env = Readonly<Record<string, string | undefined>>

/** True only when ESCROW_RAIL is `testnet` (any case, surrounding space ignored). */
export function escrowRailOn(env: Env = process.env): boolean {
  return (env.ESCROW_RAIL ?? '').trim().toLowerCase() === 'testnet'
}

/** What a page or a route says while the rail is off. No reasons, no settings named. */
export const ESCROW_RAIL_OFF_SENTENCE = 'Salvo Pay is not available here.'
