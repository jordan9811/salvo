/**
 * The escrow template's merchant table, for code outside Lit.
 *
 * The frozen template (src/lib/vault/lit/templates/escrow-v1.ts) carries its
 * own copy, and that copy is the one that decides: a listing whose merchant,
 * mode or residual cap it refuses never gets a ticket. This file exists so the
 * seller's page and the server refuse the same things first, for free, instead
 * of finding out from a paid Lit run. tests/lit-escrow-template.test.ts reads
 * the template's table out of the source with node:vm and requires this one to
 * equal it, so the two cannot drift.
 *
 * The numeric ids are what goes on chain (Terms.merchant, a uint8) and into the
 * manifest. The names match src/lib/barcode/merchants.ts profile keys.
 *
 * Isomorphic: no Node imports. The browser loads this.
 */

/** Lit reads the card's balance before opening it. */
export const MODE_READABLE = 1
/** Nobody reads the balance; the shopper is protected by the rules in spec section 8.8. */
export const MODE_BLIND = 2
export type EscrowMode = typeof MODE_READABLE | typeof MODE_BLIND

export type EscrowMerchantName = 'bestbuy' | 'nike' | 'target' | 'walmart' | 'salvotest'
export type EscrowMerchantId = 1 | 2 | 3 | 4 | 9

export interface EscrowMerchant {
  id: EscrowMerchantId
  name: EscrowMerchantName
  /** The modes a listing may use. Best Buy and Nike allow blind too, so a blocked reader blocks nothing. */
  modes: readonly EscrowMode[]
  /** The most `residualCapCents` a listing may set: how far the live balance may exceed the card value. */
  capCents: number
  /** The card number format. A card that does not match gets `card_invalid`, never a ticket. */
  card: RegExp
  /** The PIN format, or null when the store has no PIN. A null PIN is always accepted. */
  pin: RegExp | null
  /** Which balance reader the template runs in readable mode, or null when it has none. */
  reader: 'bestbuy' | 'nike' | null
}

export const ESCROW_MERCHANTS: Readonly<Record<EscrowMerchantName, EscrowMerchant>> = Object.freeze({
  bestbuy: { id: 1, name: 'bestbuy', modes: [MODE_READABLE, MODE_BLIND], capCents: 1000, card: /^[0-9]{12,19}$/, pin: /^[0-9]{3,8}$/, reader: 'bestbuy' },
  nike: { id: 2, name: 'nike', modes: [MODE_READABLE, MODE_BLIND], capCents: 1000, card: /^[0-9]{12,19}$/, pin: /^[0-9]{3,8}$/, reader: 'nike' },
  // Target's barcode number is 26 digits (src/lib/barcode/merchants.ts).
  target: { id: 3, name: 'target', modes: [MODE_BLIND], capCents: 500, card: /^[0-9]{26}$/, pin: null, reader: null },
  walmart: { id: 4, name: 'walmart', modes: [MODE_BLIND], capCents: 500, card: /^[0-9]{16}$/, pin: /^[0-9]{4}$/, reader: null },
  // Not a store. Test cards for the live smoke: 9999 and twelve random digits.
  salvotest: { id: 9, name: 'salvotest', modes: [MODE_BLIND], capCents: 500, card: /^9999[0-9]{12}$/, pin: null, reader: null },
})

const BY_ID: ReadonlyMap<number, EscrowMerchant> = new Map(Object.values(ESCROW_MERCHANTS).map((m) => [m.id, m]))

/** The merchant with this on-chain id, or null for any id the template does not know. */
export function escrowMerchantById(id: number): EscrowMerchant | null {
  return BY_ID.get(id) ?? null
}

/**
 * Would the template accept this card for this merchant? The same two checks
 * it makes after decrypting, so a seller hears "wrong number" before sealing.
 *
 * The escrow branch of /sell calls it before sealing (client/sell.ts).
 */
export function escrowCardFormatOk(m: EscrowMerchant, card: { cardNumber: string; pin: string | null }): boolean {
  if (!m.card.test(card.cardNumber)) return false
  if (card.pin === null) return true
  return m.pin !== null && m.pin.test(card.pin)
}
