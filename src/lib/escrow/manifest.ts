/**
 * The escrow listing manifest: the 13-key canonical JSON a seller's browser
 * writes next to the sealed card.
 *
 * The manifest is the AES-GCM additional data of the seal, so its exact text
 * is part of the ciphertext: a manifest edited by one byte never decrypts. Its
 * terms are also inside the seller's on-chain commitment (hashes.ts), so the
 * text, the envelope and the listing all have to agree before Lit signs a
 * ticket or releases a card.
 *
 * `parseEscrowManifest` mirrors the template's `readManifest` rule for rule.
 * The template's copy is the one that decides; this one lets our server and
 * the seller's page refuse the same manifests for free.
 * tests/lit-escrow-template.test.ts runs both on the same inputs.
 *
 * One of those rules is that the manifest names the escrow the template pins
 * (its `ESCROW`, ESCROW_V1.escrowAddress on the server). This file takes that
 * address as an argument rather than importing it, so the browser can pass the
 * pin it was built with and a test can pass the address of its own build.
 * The template compares the two as text, so a pin that is not lower-case
 * matches no manifest at all. This file fails the same way: it never
 * lower-cases a pin to make it fit.
 *
 * Isomorphic: no Node imports. The browser loads this.
 */

import { canonicalJson, parseCanonicalJson } from '@/lib/vault/lit/canonical'
import { escrowMerchantById, type EscrowMerchantId, type EscrowMode } from './merchants'

/** The fixed values every escrow manifest names. They equal the template's constants (a test holds them equal). */
export const ESCROW_TEMPLATE_ID = 'salvo-vault-escrow/1'
export const ESCROW_CHAIN_ID = 42431
/** Tempo's pathUSD TIP-20, 6 decimals. The only token the template accepts. */
export const PATH_USD: `0x${string}` = '0x20c0000000000000000000000000000000000000'
/** One cent in pathUSD base units. */
export const UNITS_PER_CENT = 10_000
/** $500. The contract and the template both refuse more. */
export const MAX_VALUE_CENTS = 50_000
/** The largest uint40: the contract stores the expiry in 40 bits. */
const MAX_EXPIRY = 1_099_511_627_775
const MANIFEST_KEYS = 13
const MAX_MANIFEST_CHARS = 2048
const ADDR_RE = /^0x[0-9a-f]{40}$/
const SALT_RE = /^[0-9a-f]{64}$/

/** A parsed manifest. Addresses are lower-case; `salt` is 64 hex digits without 0x. */
export interface EscrowManifest {
  v: 1
  template: typeof ESCROW_TEMPLATE_ID
  chainId: typeof ESCROW_CHAIN_ID
  escrow: `0x${string}`
  token: `0x${string}`
  seller: `0x${string}`
  merchant: EscrowMerchantId
  mode: EscrowMode
  valueCents: number
  /** Token base units the shopper pays. At most valueCents x 10000. */
  price: number
  residualCapCents: number
  /** Unix seconds. */
  listingExpiry: number
  salt: string
}

export type EscrowManifestInput = Omit<EscrowManifest, 'v' | 'template' | 'chainId' | 'token'>

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

/** The template's readManifest, on an already-parsed object. */
function checkFields(m: Record<string, unknown>, escrow: string): EscrowManifest | null {
  if (m.v !== 1 || m.template !== ESCROW_TEMPLATE_ID || m.chainId !== ESCROW_CHAIN_ID || m.token !== PATH_USD) return null
  if (typeof m.escrow !== 'string' || !ADDR_RE.test(m.escrow) || m.escrow !== escrow) return null
  if (typeof m.seller !== 'string' || !ADDR_RE.test(m.seller)) return null
  if (!isInt(m.merchant)) return null
  const mc = escrowMerchantById(m.merchant)
  if (!mc) return null
  if (!(mc.modes as readonly unknown[]).includes(m.mode)) return null
  if (!isInt(m.valueCents) || m.valueCents < 1 || m.valueCents > MAX_VALUE_CENTS) return null
  if (!isInt(m.price) || m.price < 1 || m.price > m.valueCents * UNITS_PER_CENT) return null
  if (!isInt(m.residualCapCents) || m.residualCapCents < 0 || m.residualCapCents > mc.capCents) return null
  if (!isInt(m.listingExpiry) || m.listingExpiry < 1 || m.listingExpiry > MAX_EXPIRY) return null
  if (typeof m.salt !== 'string' || !SALT_RE.test(m.salt)) return null
  return m as unknown as EscrowManifest
}

/**
 * The manifest, if `text` is exactly one the template pinning `escrow` would
 * accept: canonical, 13 keys, this chain, template and token, that escrow, a
 * known merchant in a mode it allows, and every number in range. Anything else
 * is null, and so is everything while `escrow` is null (no address pinned yet)
 * or not lower-case. A checksummed pin is refused, not lower-cased: the
 * template compares its own pin to the manifest as text, so with that pin it
 * would refuse every listing, and a twin that said yes would hide that.
 */
export function parseEscrowManifest(text: string, escrow: `0x${string}` | null): EscrowManifest | null {
  if (escrow === null || !ADDR_RE.test(escrow)) return null
  const m = parseCanonicalJson(text, MANIFEST_KEYS, MAX_MANIFEST_CHARS)
  return m ? checkFields(m, escrow) : null
}

/**
 * The canonical manifest text for a new listing. The seller's address is
 * lower-cased here (the template accepts nothing else); everything else must
 * already be in range. Throws rather than writing a manifest the template
 * would refuse, because a seal under it could never be sold. `input.escrow`
 * must be the template's pinned escrow exactly as pinned, lower-case: it is
 * not lower-cased here, so a checksummed copy throws instead of writing a
 * manifest that matches our check and not the template's. The check is
 * against that address, so it cannot catch a wrong one.
 *
 * The escrow branch of /sell builds its manifest with this (client/sell.ts).
 */
export function buildEscrowManifest(input: EscrowManifestInput): string {
  const text = canonicalJson({
    v: 1,
    template: ESCROW_TEMPLATE_ID,
    chainId: ESCROW_CHAIN_ID,
    escrow: input.escrow,
    token: PATH_USD,
    seller: input.seller.toLowerCase(),
    merchant: input.merchant,
    mode: input.mode,
    valueCents: input.valueCents,
    price: input.price,
    residualCapCents: input.residualCapCents,
    listingExpiry: input.listingExpiry,
    salt: input.salt,
  })
  if (!parseEscrowManifest(text, input.escrow)) {
    throw new RangeError('escrow manifest is out of range for salvo-vault-escrow/1')
  }
  return text
}
