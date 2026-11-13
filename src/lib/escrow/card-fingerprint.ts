/**
 * One card, across both escrows: a fingerprint the seller's browser computes
 * from the card it is sealing, so our listing route can refuse a card V1 sold
 * from being listed again on V2 (unified spec section 8.7, the known gap).
 *
 * WHY THE CHAIN CANNOT DO IT. Each Lit template keys its card tag with its
 * own CID-derived key (templates/escrow-v2.ts cardTag), so the tag V2 computes
 * for a card is never the tag V1 recorded, and V2 never reads V1. No server
 * holds a key that could join them, and none is added: our server sees only
 * ciphertext and public terms.
 *
 * WHAT IT IS. PBKDF2-SHA256 over the store's id and the card number, in the
 * form the template tags it (a Best Buy 18-digit number starting 88 is the
 * 16 digits after it), with a fixed public salt and 600,000 iterations. Fixed
 * and keyless on purpose, so the same card gives the same fingerprint on any
 * device and under either escrow. The iterations are what keep it from being
 * a card number in disguise: a 16-digit gift card number has maybe 10^12
 * likely values, and at this cost one GPU needs years to walk them, where a
 * plain hash would take minutes. It never includes the PIN.
 *
 * WHAT IT IS NOT. A proof. The seller's own browser computes it, and the
 * template never checks it, because the frozen templates cannot. So it stops
 * an honest relisting and a careless one; a seller who edits their page can
 * send any value. What bounds that seller is the V1 freeze (nothing new sells
 * on V1 once V2 is configured), V2's new-seller cap on blind cards over $25
 * (V2 keeps its own paidOut), the readable stores' balance read, and the
 * buyer's contest and dispute. The buyer's phone holds the card after a
 * purchase and can recompute the fingerprint to show the listing lied.
 *
 * WHAT CARRIES NONE. A V1 listing recorded before this file existed has no
 * fingerprint, so nothing can match it. Every V1 listing now must carry one
 * (listing.ts), and a seller with any V1 listing at a store that carries
 * none lists nothing at that store on V2 until it is resolved: one sold, by
 * its buyer's phone, which holds the card and supplies the fingerprint
 * (listing-v2.ts recordV1FingerprintByBuyer); one still listed, by taking it
 * back.
 *
 * Isomorphic: WebCrypto only (the browser's, or Node's globalThis.crypto).
 */

import type { Hex } from 'viem'
import type { IntentState } from '@/lib/intent/types'
import { escrowMerchantById, type EscrowMerchantId } from './merchants'

export const CARD_FINGERPRINT_RE = /^0x[0-9a-f]{64}$/
/** OWASP's floor for PBKDF2-HMAC-SHA256. About a second on a phone, once per listing. */
export const CARD_FINGERPRINT_ITERATIONS = 600_000
const SALT = 'salvo/escrow/card-fingerprint/v1'

/** One physical card, one key: the template's cardKey, so both forms of a Best Buy number are one card. */
function cardKey(merchant: EscrowMerchantId, cardNumber: string): string {
  if (merchant === 1 && cardNumber.length === 18 && cardNumber.startsWith('88')) return cardNumber.slice(2)
  return cardNumber
}

/**
 * The card's fingerprint, as `0x` and 64 lower-case hex digits. Throws for a
 * store the escrow does not know or a number that is not that store's digits:
 * a fingerprint of a typo would match nothing and protect nothing.
 */
export async function cardFingerprint(merchant: EscrowMerchantId, cardNumber: string): Promise<Hex> {
  const m = escrowMerchantById(merchant)
  if (m === null) throw new RangeError('the escrow does not know this store')
  if (!m.card.test(cardNumber)) throw new RangeError("that is not this store's card number format")
  const enc = new TextEncoder()
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(`${merchant}|${cardKey(merchant, cardNumber)}`), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations: CARD_FINGERPRINT_ITERATIONS },
    key,
    256,
  )
  return `0x${[...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')}` as Hex
}

/** The fingerprint, if `v` is one in its exact form (lower-case), else null. */
export function parseCardFingerprint(v: unknown): Hex | null {
  return typeof v === 'string' && CARD_FINGERPRINT_RE.test(v) ? (v as Hex) : null
}

/** Another listing, of either escrow, that carries the same fingerprint. */
export interface FingerprintMatch {
  version: 1 | 2
  /** Its Intent row's state, as the keeper keeps it. */
  state: IntentState
  /** Who listed it, lower-case. */
  seller: Hex
  /** Who bought the card whole (V1) or its last value (V2), lower-case; null if nobody did. */
  buyer: Hex | null
  /**
   * For an offered row, what its own escrow shows now: `active` for sale;
   * `sold` sold whole (V1) or drained (V2) before the keeper recorded it;
   * `closed` cancelled, expired or found spent. Null when not read, which
   * counts as for sale.
   */
  chain: 'active' | 'sold' | 'closed' | null
  /** When it was listed, in ms. One card has one live listing at a time, so the newest sale is the latest owner's. */
  listedAt: number
}

/** Why a card may not be listed again, in the order the route reports them. */
export type FingerprintRefusal =
  /** Another listing of the card is still for sale, on either escrow. */
  | 'card_listed'
  /** The card was sold to someone else. */
  | 'card_sold'
  /** This seller bought the card, and that purchase is not paid out yet (or not yet in our books). */
  | 'card_not_paid_out'

const SOLD: ReadonlySet<IntentState> = new Set(['matched', 'executing', 'completed'])

/**
 * May `seller` list the card these matches share? Null when yes.
 *   - A listing still for sale (offered, and not closed on chain) blocks every
 *     new one, the seller's own too: one live listing per card.
 *   - The newest sale decides who owns the card now: its buyer may sell it
 *     on, once that purchase is paid out (until then its seller may still
 *     refund it); everyone else is refused. An older sale is superseded by a
 *     newer one, so a card can pass through any number of owners.
 *   - A listing the chain shows sold that our books have not caught up with
 *     is that newest sale, its buyer not yet known: its seller is refused,
 *     anyone else waits until the keeper records it.
 *   - A listing cancelled, expired or refunded in full sold nothing: the card
 *     went back to its seller, and an older sale still decides.
 */
export function fingerprintVerdict(matches: readonly FingerprintMatch[], seller: Hex): FingerprintRefusal | null {
  const who = seller.toLowerCase()
  let worst: FingerprintRefusal | null = null
  const rank = (r: FingerprintRefusal): number => ({ card_listed: 3, card_sold: 2, card_not_paid_out: 1 })[r]
  const note = (r: FingerprintRefusal): void => {
    if (worst === null || rank(r) > rank(worst)) worst = r
  }
  let latest: FingerprintMatch | null = null
  for (const m of matches) {
    if (m.state === 'offered' && (m.chain === 'active' || m.chain === null)) note('card_listed')
    const sold = SOLD.has(m.state) || (m.state === 'offered' && m.chain === 'sold')
    if (sold && (latest === null || m.listedAt > latest.listedAt)) latest = m
  }
  if (latest !== null) {
    if (latest.state === 'offered') note(latest.seller.toLowerCase() === who ? 'card_sold' : 'card_not_paid_out')
    else if (latest.buyer === null || latest.buyer.toLowerCase() !== who) note('card_sold')
    else if (latest.state !== 'completed') note('card_not_paid_out')
  }
  // cancelled, execution_failed, refunded: the card is its seller's again.
  return worst
}
