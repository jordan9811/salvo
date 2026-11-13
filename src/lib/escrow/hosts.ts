/**
 * The two Moderato RPC hosts the frozen escrow template reads, in its order.
 *
 * WHY A FILE OF ITS OWN. The shopper's phone and the seller's browser read the
 * chain from these same two hosts (spec section 8.3 steps 2 and 5), through the
 * runbook's JSON-RPC client. That client used to take this list from
 * config.ts, and config.ts imports the template registry, which hashes with
 * node:crypto. A browser bundle cannot load that. So the list lives here, with
 * no imports at all, and config.ts re-exports it for the server and scripts.
 *
 * The template's `RPCS` is the copy that decides; tests/lit-escrow-template.test.ts
 * holds this list equal to it.
 *
 * Isomorphic: no imports. The browser loads this.
 */

/** The template's RPCS, in its order. Both must answer and agree for any card to open. */
export const ESCROW_RPC_URLS = ['https://rpc.moderato.tempo.xyz', 'https://tempo-moderato-testnet.drpc.org'] as const
