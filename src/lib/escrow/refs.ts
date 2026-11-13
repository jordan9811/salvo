/**
 * How the rest of the codebase tells an escrow purchase or listing from its own.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS. Escrow orders live in the same Order table as every
 * other rail, with NO schema change: the rail is the existing `mpp` value and
 * the payment ref is `escrow:<chainKey>:<escrow>:<depositId>`. That reuse is
 * cheap and it is dangerous, because every path that refunds, settles,
 * reconciles, fulfils or emails about an `mpp` order was written for money
 * that reached OUR Tempo wallet. An escrow purchase never touches our wallet:
 * the shopper paid SalvoEscrowV1, and only the seller can give money back. So
 * a deadline refund of an escrow order would pay the shopper a second time,
 * out of our pocket, for a card they already hold.
 *
 * So one predicate decides it, `isEscrowPaymentRef`, and every one of those
 * paths asks it first (reconcile, crypto-refund, order creation and
 * transitions, fulfilment, the gift-card daily cap). A test per path holds it.
 * ===========================================================================
 *
 * Escrow LISTINGS sit in the Intent table the same way, told apart by their
 * own form factor (`escrow_sealed`), which no other path lists, sweeps,
 * quotes or buys, and by their id (`esc_` and the listing id), which the
 * shared transition rule refuses. Their state follows the chain, and only
 * the keeper (keeper.ts) moves them.
 *
 * Pure: no Node imports, no database, no network. Type-only Prisma import.
 */

import type { Prisma } from '@prisma/client'
import type { Hex } from 'viem'

/** Every escrow payment ref starts with this. Compared without case: a lookalike is refused too. */
export const ESCROW_REF_PREFIX = 'escrow:'

/**
 * The Intent.formFactor of an escrow listing. Not a `FormFactor` an adapter
 * supplies: nothing on our side redeems it. Every query that lists, sweeps,
 * quotes or buys supply names the form factors it wants, so this one is left
 * out of all of them by construction (the balance sweep, browseOffers and
 * one-screen all name theirs).
 */
export const ESCROW_INTENT_FORM_FACTOR = 'escrow_sealed'

/** The sealed ref's algorithm for an escrow listing (src/lib/vault/escrow-backend.ts says the same). */
const ESCROW_ALGORITHM_PREFIX = 'chipotle:escrow'

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const CHAIN_KEY_RE = /^[a-z0-9-]{1,40}$/
const DEPOSIT_ID_RE = /^[1-9][0-9]{0,14}$/
const LISTING_ID_RE = /^0x[0-9a-f]{64}$/

/**
 * True for any payment ref that names an escrow purchase, or looks like one.
 * Case and surrounding space are ignored on purpose: a guard that a ref
 * written as `Escrow:` slips past is not a guard.
 */
export function isEscrowPaymentRef(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && ref.trim().toLowerCase().startsWith(ESCROW_REF_PREFIX)
}

/** Prisma: "not an escrow order". For every query that would otherwise sweep one up. */
export const NOT_ESCROW_ORDER: Prisma.OrderWhereInput = {
  NOT: { paymentRef: { startsWith: ESCROW_REF_PREFIX, mode: 'insensitive' } },
}

/** The payment ref of one escrow deposit. The escrow address is written lower-case. */
export function escrowPaymentRef(chainKey: string, escrow: Hex, depositId: bigint): string {
  return `${ESCROW_REF_PREFIX}${chainKey}:${escrow.toLowerCase()}:${depositId.toString()}`
}

export interface EscrowPaymentRef {
  chainKey: string
  escrow: Hex
  depositId: bigint
}

/** The parts of a ref `escrowPaymentRef` wrote, or null for anything else. */
export function parseEscrowPaymentRef(ref: string | null | undefined): EscrowPaymentRef | null {
  if (typeof ref !== 'string' || !ref.startsWith(ESCROW_REF_PREFIX)) return null
  const parts = ref.slice(ESCROW_REF_PREFIX.length).split(':')
  if (parts.length !== 3) return null
  const [chainKey, escrow, id] = parts as [string, string, string]
  if (!CHAIN_KEY_RE.test(chainKey) || !ADDRESS_RE.test(escrow) || !DEPOSIT_ID_RE.test(id)) return null
  return { chainKey, escrow: escrow as Hex, depositId: BigInt(id) }
}

/**
 * The Intent id of an escrow listing: fixed by its on-chain listing id, so a
 * listing posted twice is one row, and the keeper finds a deposit's listing
 * without a search.
 */
export function escrowIntentIdFor(listingId: Hex): string {
  const id = listingId.toLowerCase()
  if (!LISTING_ID_RE.test(id)) throw new RangeError('a listing id is 32 bytes of hex')
  return `esc_${id.slice(2)}`
}

/**
 * True for an id escrowIntentIdFor wrote, or one that looks like it. Every
 * other Intent id is a cuid, so this never names one of ours. It exists for
 * the paths that hold only an id when they move a listing (the shared
 * transition rule, src/lib/intent/state.ts), so even those refuse an escrow
 * listing without reading its row.
 */
export function isEscrowIntentId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^esc_[0-9a-f]{64}$/i.test(id.trim())
}

/**
 * True for an escrow listing: its form factor, its id, or a sealed ref that
 * names the escrow backend. Any one is enough, so a row with one and not the
 * others is still refused by every path that must leave escrow listings alone.
 */
export function isEscrowIntent(row: { id?: string; formFactor: string; sealedRef?: unknown }): boolean {
  if (row.formFactor === ESCROW_INTENT_FORM_FACTOR) return true
  if (isEscrowIntentId(row.id)) return true
  const ref = row.sealedRef
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) return false
  const algorithm = (ref as Record<string, unknown>).algorithm
  return typeof algorithm === 'string' && algorithm.startsWith(ESCROW_ALGORITHM_PREFIX)
}

/**
 * A path that acts on our own money, or on an order or listing it owns,
 * was handed an escrow one. Thrown before anything moves.
 */
export class EscrowRailRefusedError extends Error {
  constructor(what: string) {
    super(
      `refusing to ${what}: it is an escrow purchase or listing. The chain holds that money and ` +
        `only its seller can return it; our wallet never pays an escrow shopper.`,
    )
    this.name = 'EscrowRailRefusedError'
  }
}
