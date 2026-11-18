/**
 * Phase 9, Gate 1 — what a merchant's own gift card looks like at their POS.
 *
 * ===========================================================================
 * THIS REGISTRY IS THE WHOLE REASON B&M SCALES.
 *
 * The ecommerce channel needs a captured checkout, a selector set, and a
 * maintenance treadmill per merchant. This channel needs one row: which
 * symbology their scanner reads, and where their stores are. Everything else —
 * the reveal, the balance checks, the escrow, the dispute — is identical across
 * every merchant that issues a gift card.
 *
 * That is why the pass renders THEIR barcode format rather than something of
 * ours. We are presenting their instrument to their POS; the scanner has no
 * idea we exist and needs none.
 * ===========================================================================
 */

import type { BarcodeFormat } from './wallet'

/**
 * A store location the pass should wake up near.
 *
 * Apple caps `relevantLocations` at 10 entries per pass, which is a real
 * constraint rather than a guideline: an 11th is silently ignored, so a naive
 * "ship every store" would produce a pass that triggers at whichever ten
 * happened to serialise first. See `relevantLocationsFor`.
 */
export interface StoreLocation {
  latitude: number
  longitude: number
  /** Shown on the lock screen when the pass surfaces. */
  relevantText?: string
}

export interface MerchantBarcodeProfile {
  merchantId: string
  displayName: string
  /**
   * The symbology THEIR scanner reads.
   *
   * Wrong symbology is not a soft failure — the scanner simply does not beep,
   * the buyer is standing at a till holding a phone, and the reveal window is
   * burning. Defaulting is worse than refusing, which is why
   * `barcodeFormatFor` throws on an unknown merchant rather than guessing
   * PDF417.
   */
  format: BarcodeFormat
  /**
   * How the number is encoded in the barcode payload.
   *
   * Most US gift cards encode the raw PAN. Some prefix it, and some carry the
   * PIN in the same symbol separated by a delimiter. Modelled as a template so
   * a new merchant is a data change.
   *
   * `{card}` and `{pin}` are substituted. A profile that omits `{pin}` never
   * puts the PIN in the barcode at all.
   */
  payloadTemplate: string
  /** Human-readable text under the barcode. Never the full number. */
  altTextTemplate: string
  /**
   * What the seller is asked to type, and a hint under it.
   *
   * THE NUMBER IN THE BARCODE IS NOT ALWAYS THE CARD NUMBER. A Target eGift
   * card's in-store barcode carries 26 digits: the 15-digit card number, then
   * 11 more that are not the access number and cannot be derived from anything
   * else on the card. Asking for "card number" there stores a number the
   * register will not take. So each store says which number it needs, and for
   * a store like that, it is the one printed under the barcode.
   */
  numberLabel: string
  numberHint?: string
  /**
   * Which balance-reading adapter serves this merchant, or null for none.
   *
   * ONE TABLE, NOT TWO. This used to live in a separate
   * `MERCHANTS_WITH_PUBLIC_BALANCE` array, so "which merchants exist" and
   * "which can be read" were maintained in different files and could disagree.
   * A merchant is now one row, and `BALANCE_BLIND` is a property of that row
   * rather than absence from a second list.
   *
   * Null is a normal, supported state — it selects ObservedSettlement — not an
   * unsupported one.
   */
  balanceLookup: BalanceLookupKey | null
  /**
   * Why this merchant has no balance lookup. Null when it has one.
   *
   * Recorded so "we looked and there is nothing" is distinguishable from
   * "nobody has looked yet" — a distinction the Phase 2 screen lost when it
   * guessed URLs and filed the 404s as absence.
   */
  balanceLookupNote?: string
}

/** Adapters that can read a merchant balance. Each needs code, not just data. */
export type BalanceLookupKey = 'bestbuy' | 'nike' | 'target'

export const APPLE_MAX_RELEVANT_LOCATIONS = 10

/**
 * Known merchants.
 *
 * Deliberately small and hand-written. Every entry here is a claim about what a
 * real scanner does, and an unverified guess in this table produces a silent
 * failure at a till — so it grows one confirmed merchant at a time, not from a
 * bulk import.
 */
export const MERCHANT_BARCODE_PROFILES: Readonly<Record<string, MerchantBarcodeProfile>> = {
  bestbuy: {
    merchantId: 'bestbuy',
    displayName: 'Best Buy',
    format: 'PKBarcodeFormatCode128',
    payloadTemplate: '{card}',
    altTextTemplate: '•••• {last4}',
    numberLabel: 'Card number',
    balanceLookup: 'bestbuy',
  },
  nike: {
    merchantId: 'nike',
    displayName: 'Nike',
    format: 'PKBarcodeFormatCode128',
    payloadTemplate: '{card}',
    altTextTemplate: '•••• {last4}',
    numberLabel: 'Card number',
    balanceLookup: 'nike',
  },
  /*
   * PDF417, AND THE NUMBER UNDER THE BARCODE. Taken from a real Target eGift
   * card's own "Scan in store to redeem" barcode, the first format in this
   * table read off a real card rather than inferred: a PDF417 symbol carrying
   * 26 digits, longer than the 15-digit card number. Physical Target cards are
   * not yet checked, which is why the reveal still offers the 1D codes after it.
   */
  target: {
    merchantId: 'target',
    displayName: 'Target',
    format: 'PKBarcodeFormatPDF417',
    payloadTemplate: '{card}',
    altTextTemplate: '•••• {last4}',
    numberLabel: 'Number under the barcode',
    numberHint:
      'The long number printed under the barcode, not the card number. On a Target eGift card it is 26 digits.',
    // Readable only once a Target session is on disk (balance-readers.ts
    // readerConfigured): the balance page needs a Target sign-in, measured
    // 2026-10-23. Until then Target is blind, as before.
    balanceLookup: 'target',
  },
  walmart: {
    merchantId: 'walmart',
    displayName: 'Walmart',
    format: 'PKBarcodeFormatCode128',
    payloadTemplate: '{card}',
    altTextTemplate: '•••• {last4}',
    numberLabel: 'Card number',
    balanceLookup: null,
    balanceLookupNote:
      'A genuinely public, no-login, server-rendered balance form exists at ' +
      'walmart.com/account/giftcards/balance (gc-number, 16 digits + securitycode, 4-digit PIN). ' +
      'Deliberately NOT wired, and the reason is the finding: the page serves cleanly to a ' +
      'residential IP and returns a PerimeterX "press and hold" wall to a datacenter one. ' +
      'Declaring a merchant BALANCE_READABLE whose probe is blocked is WORSE than declaring it ' +
      'blind — a readable merchant with a failing probe refuses the reveal and refunds, closing ' +
      'the channel, while a blind one settles on evidence and works. Wire this the day we have ' +
      'residential egress, not before.',
  },
}

export class UnknownMerchantBarcodeError extends Error {
  constructor(merchantId: string) {
    super(
      `No barcode profile for merchant "${merchantId}". Refusing to guess a symbology.\n\n` +
        `A wrong format does not fail loudly — the scanner just does not beep while the buyer ` +
        `stands at the till and the reveal window expires. Add a verified profile to ` +
        `MERCHANT_BARCODE_PROFILES in src/lib/barcode/merchants.ts.`,
    )
    this.name = 'UnknownMerchantBarcodeError'
  }
}

export function barcodeProfileFor(merchantId: string): MerchantBarcodeProfile {
  const p = MERCHANT_BARCODE_PROFILES[merchantId.toLowerCase().trim()]
  if (!p) throw new UnknownMerchantBarcodeError(merchantId)
  return p
}

export function hasBarcodeProfile(merchantId: string): boolean {
  return Boolean(MERCHANT_BARCODE_PROFILES[merchantId.toLowerCase().trim()])
}

/**
 * Render the payload the scanner will actually read.
 *
 * Takes the card material at REVEAL time, never at provisioning time — the
 * separation that makes the pre-provisioned pass safe to sit in a wallet.
 */
export function renderBarcodePayload(
  profile: MerchantBarcodeProfile,
  card: { cardNumber: string; pin?: string | null },
): string {
  return profile.payloadTemplate
    .replace('{card}', card.cardNumber)
    .replace('{pin}', card.pin ?? '')
}

export function renderAltText(profile: MerchantBarcodeProfile, last4: string): string {
  return profile.altTextTemplate.replace('{last4}', last4)
}

/**
 * Choose which store locations go into the pass.
 *
 * NEAREST FIRST, capped at Apple's limit. Sorting matters because the cap is a
 * silent truncation: an unsorted list of 400 stores yields ten arbitrary ones,
 * and the buyer's pass wakes up for a store three states away while staying
 * quiet outside the one they shop at.
 *
 * When the buyer's home is unknown the order is left as given, which at least
 * makes the truncation the caller's deliberate choice rather than an artefact
 * of iteration order.
 */
export function relevantLocationsFor(
  stores: readonly StoreLocation[],
  near?: { latitude: number; longitude: number } | null,
  limit: number = APPLE_MAX_RELEVANT_LOCATIONS,
): StoreLocation[] {
  if (!near) return stores.slice(0, limit)

  const withDistance = stores.map((s) => ({
    store: s,
    d: haversineKm(near.latitude, near.longitude, s.latitude, s.longitude),
  }))
  withDistance.sort((a, b) => a.d - b.d)
  return withDistance.slice(0, limit).map((x) => x.store)
}

/** Great-circle distance in km. Exported for tests and for the browse path. */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * The manual browse path — Gate 1's requirement for users with location
 * services off.
 *
 * Not a degraded mode. A meaningful share of people keep location permissions
 * off permanently, and a channel that only works for the others is a channel
 * with a silent eligibility rule nobody told the buyer about.
 */
export interface BrowseEntry {
  merchantId: string
  displayName: string
  /** Null when we cannot compute it — location off, or no stores known. */
  nearestKm: number | null
}

export function browseMerchants(
  merchantIds: readonly string[],
  storesByMerchant: Readonly<Record<string, readonly StoreLocation[]>>,
  near?: { latitude: number; longitude: number } | null,
): BrowseEntry[] {
  const entries: BrowseEntry[] = []
  for (const id of merchantIds) {
    if (!hasBarcodeProfile(id)) continue
    const profile = barcodeProfileFor(id)
    const stores = storesByMerchant[id] ?? []
    let nearestKm: number | null = null
    if (near && stores.length > 0) {
      nearestKm = Math.min(
        ...stores.map((s) => haversineKm(near.latitude, near.longitude, s.latitude, s.longitude)),
      )
    }
    entries.push({ merchantId: id, displayName: profile.displayName, nearestKm })
  }

  // Nearest first when we know, alphabetical when we do not — a stable order
  // either way, because a list that reshuffles between renders is unusable.
  entries.sort((a, b) => {
    if (a.nearestKm !== null && b.nearestKm !== null) return a.nearestKm - b.nearestKm
    if (a.nearestKm !== null) return -1
    if (b.nearestKm !== null) return 1
    return a.displayName.localeCompare(b.displayName)
  })
  return entries
}
