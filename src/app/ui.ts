/**
 * Shared data helpers for the product surfaces.
 *
 * ===========================================================================
 * THIS FILE USED TO CARRY A STYLE SYSTEM AND NO LONGER DOES.
 *
 * It exported `COLORS` and an `S` map of inline React style objects, which was
 * the second of three competing style systems in the app — globals.css being
 * the first and a private copy inside reveal-client.tsx the third. Inline
 * styles also cannot express `:hover`, `:focus-visible`, `:disabled` or a media
 * query, so every interactive element styled that way was inert to a keyboard
 * and dead on hover.
 *
 * Styling now lives in globals.css as one component system. What remains here
 * is what it always should have been: the small amount of shared DATA the
 * surfaces need.
 * ===========================================================================
 */

import { MERCHANT_BARCODE_PROFILES } from '@/lib/barcode/merchants'

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * The merchants a buyer or seller can pick, DERIVED from the registry.
 *
 * This was a hand-written pair that had to be edited in lockstep with
 * `MERCHANT_BARCODE_PROFILES`, so adding a merchant meant remembering a second
 * file — and forgetting produced a merchant the engine supports and the UI
 * cannot offer, which looks exactly like it is unsupported.
 *
 * `balanceReadable` rides along because the seller screen has to say when a
 * card cannot be verified, and that is a property of the merchant rather than
 * something the screen should be deciding for itself.
 */
export const SUPPORTED_MERCHANTS: ReadonlyArray<{
  id: string
  name: string
  balanceReadable: boolean
  /** What the seller types: not always the card number. See merchants.ts. */
  numberLabel: string
  numberHint: string | null
}> = Object.values(MERCHANT_BARCODE_PROFILES).map((p) => ({
  id: p.merchantId,
  name: p.displayName,
  balanceReadable: p.balanceLookup !== null,
  numberLabel: p.numberLabel,
  numberHint: p.numberHint ?? null,
}))

/** Never empty — the registry is a non-empty literal — but typed safely. */
export const DEFAULT_MERCHANT_ID: string = SUPPORTED_MERCHANTS[0]?.id ?? 'bestbuy'

export function merchantName(id: string | null): string {
  return SUPPORTED_MERCHANTS.find((m) => m.id === id)?.name ?? (id ?? 'Store')
}

/** True when we can read this merchant's balance ourselves. */
export function merchantBalanceReadable(id: string | null): boolean {
  return SUPPORTED_MERCHANTS.find((m) => m.id === id)?.balanceReadable ?? false
}

/**
 * What a seller needs to know before listing a card we cannot verify.
 *
 * Null for a readable merchant, so the caller renders nothing rather than a
 * reassuring no-op.
 *
 * It lives HERE rather than in `listing-service` because it is UI copy and that
 * module imports prisma — a client component pulling it in would drag the
 * database client into the browser bundle. It was briefly written in both
 * places; the dead-export check caught the copy nobody called, which is exactly
 * the duplicate-message drift that check exists to stop.
 */
export function blindMerchantNotice(id: string | null): string | null {
  const m = SUPPORTED_MERCHANTS.find((x) => x.id === id)
  if (!m || m.balanceReadable) return null
  // Deliberately does NOT restate "we can't check <merchant> balances" — the
  // heading above it says that, and rendering both put the same sentence on
  // screen twice.
  return (
    `${m.name} doesn't publish a lookup we can read. Your card is still welcome, but we go on ` +
    `the figure you enter, and if a buyer says it didn't work we have no ledger to check them ` +
    `against. Only list what you're sure is on the card.`
  )
}
