/**
 * The V2 escrow listing manifest: the 14-key canonical JSON a seller's browser
 * writes next to a card sealed for salvo-vault-escrow/2 and SalvoEscrowV2.
 *
 * V1's manifest (manifest.ts) plus one term, `remainderHaircutBps`: the part
 * of the price a remainder sells without when no deposit covers it (spec
 * sections 6.4 and 17, decision 3). It is inside the on-chain terms, so it is
 * inside the listing id, and the template recomputes that id from this text.
 * `residualCapCents` keeps its name and gains a second meaning: the most a
 * sale may leave on the card, so it now also fits the contract's cap for the
 * mode ($5 blind, $10 readable) as well as the store's.
 *
 * `parseEscrowManifestV2` mirrors the template's `readManifest` rule for rule,
 * as manifest.ts does for V1, and for the same reason: the template decides,
 * and this lets our server and the seller's page refuse the same manifests
 * for free. tests/lit-escrow-v2-template.test.ts runs both on the same inputs.
 * The escrow pin is an argument here too, compared as text, never lower-cased.
 *
 * Isomorphic: no Node imports. The browser loads this.
 */

import { canonicalJson, parseCanonicalJson } from '@/lib/vault/lit/canonical'
import { ESCROW_CHAIN_ID, MAX_VALUE_CENTS, PATH_USD, UNITS_PER_CENT } from './manifest'
import { escrowMerchantById, MODE_READABLE, type EscrowMerchant, type EscrowMerchantId, type EscrowMode } from './merchants'

export const ESCROW_V2_TEMPLATE_ID = 'salvo-vault-escrow/2'
/** The most a sale may leave on a card where nobody can read the balance: SalvoEscrowV2.CAP_BLIND. */
export const CAP_BLIND_CENTS = 500
/** The same where Lit reads the balance: SalvoEscrowV2.CAP_READABLE. */
export const CAP_READABLE_CENTS = 1000
/** The contract needs the haircut below 10000 basis points: a remainder never sells for nothing. */
export const MAX_HAIRCUT_BPS = 9999
/** The largest uint40: the contract stores the expiry in 40 bits. */
const MAX_EXPIRY = 1_099_511_627_775
const MANIFEST_KEYS = 14
const MAX_MANIFEST_CHARS = 2048
const ADDR_RE = /^0x[0-9a-f]{40}$/
const SALT_RE = /^[0-9a-f]{64}$/

/** A parsed V2 manifest. Addresses are lower-case; `salt` is 64 hex digits without 0x. */
export interface EscrowManifestV2 {
  v: 2
  template: typeof ESCROW_V2_TEMPLATE_ID
  chainId: typeof ESCROW_CHAIN_ID
  escrow: `0x${string}`
  token: `0x${string}`
  seller: `0x${string}`
  merchant: EscrowMerchantId
  mode: EscrowMode
  valueCents: number
  /** Token base units for the whole card. A sale pays its share for the cents it uses. */
  price: number
  /** The most a sale may leave on the card; readable, also the most the balance may exceed what is left. */
  residualCapCents: number
  /** Off the price of a remainder no deposit covers. 0 to 9999. */
  remainderHaircutBps: number
  /** Unix seconds. */
  listingExpiry: number
  salt: string
}

export type EscrowManifestV2Input = Omit<EscrowManifestV2, 'v' | 'template' | 'chainId' | 'token'>

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

/** The most `residualCapCents` may be for this store in this mode: the store's cap and the contract's, whichever is lower. */
export function residualCapLimitV2(mc: EscrowMerchant, mode: EscrowMode): number {
  return Math.min(mc.capCents, mode === MODE_READABLE ? CAP_READABLE_CENTS : CAP_BLIND_CENTS)
}

/** The template's readManifest, on an already-parsed object. */
function checkFields(m: Record<string, unknown>, escrow: string): EscrowManifestV2 | null {
  if (m.v !== 2 || m.template !== ESCROW_V2_TEMPLATE_ID || m.chainId !== ESCROW_CHAIN_ID || m.token !== PATH_USD) return null
  if (typeof m.escrow !== 'string' || !ADDR_RE.test(m.escrow) || m.escrow !== escrow) return null
  if (typeof m.seller !== 'string' || !ADDR_RE.test(m.seller)) return null
  if (!isInt(m.merchant)) return null
  const mc = escrowMerchantById(m.merchant)
  if (!mc) return null
  if (!(mc.modes as readonly unknown[]).includes(m.mode)) return null
  const mode = m.mode as EscrowMode
  if (!isInt(m.valueCents) || m.valueCents < 1 || m.valueCents > MAX_VALUE_CENTS) return null
  if (!isInt(m.price) || m.price < 1 || m.price > m.valueCents * UNITS_PER_CENT) return null
  if (!isInt(m.residualCapCents) || m.residualCapCents < 0 || m.residualCapCents > residualCapLimitV2(mc, mode)) return null
  if (!isInt(m.remainderHaircutBps) || m.remainderHaircutBps < 0 || m.remainderHaircutBps > MAX_HAIRCUT_BPS) return null
  if (!isInt(m.listingExpiry) || m.listingExpiry < 1 || m.listingExpiry > MAX_EXPIRY) return null
  if (typeof m.salt !== 'string' || !SALT_RE.test(m.salt)) return null
  return m as unknown as EscrowManifestV2
}

/**
 * The manifest, if `text` is exactly one salvo-vault-escrow/2 pinning `escrow`
 * would accept: canonical, 14 keys, v 2, this chain, template and token, that
 * escrow, a known merchant in a mode it allows, and every number in range.
 * Anything else is null, and so is everything while `escrow` is null (V2 is
 * not deployed yet) or not lower-case. A V1 manifest is refused: it has 13
 * keys, v 1 and the other template.
 */
export function parseEscrowManifestV2(text: string, escrow: `0x${string}` | null): EscrowManifestV2 | null {
  if (escrow === null || !ADDR_RE.test(escrow)) return null
  const m = parseCanonicalJson(text, MANIFEST_KEYS, MAX_MANIFEST_CHARS)
  return m ? checkFields(m, escrow) : null
}

/**
 * The canonical V2 manifest text for a new listing. As buildEscrowManifest:
 * the seller is lower-cased, the escrow must already be the pin exactly as
 * pinned, and anything the template would refuse throws instead of being
 * written, because a card sealed under it could never be sold.
 */
export function buildEscrowManifestV2(input: EscrowManifestV2Input): string {
  const text = canonicalJson({
    v: 2,
    template: ESCROW_V2_TEMPLATE_ID,
    chainId: ESCROW_CHAIN_ID,
    escrow: input.escrow,
    token: PATH_USD,
    seller: input.seller.toLowerCase(),
    merchant: input.merchant,
    mode: input.mode,
    valueCents: input.valueCents,
    price: input.price,
    residualCapCents: input.residualCapCents,
    remainderHaircutBps: input.remainderHaircutBps,
    listingExpiry: input.listingExpiry,
    salt: input.salt,
  })
  if (!parseEscrowManifestV2(text, input.escrow)) {
    throw new RangeError('escrow manifest is out of range for salvo-vault-escrow/2')
  }
  return text
}
