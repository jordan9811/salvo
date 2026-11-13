/**
 * Who gets leftovers: the off-chain rules that steer routing on the dollars
 * rail, and nothing else (unified spec sections 7.2, 7.5 and 17, decision 1).
 *
 *   - A BUYER with 2 or more remainder reports or shortfalls in 30 days gets
 *     no leftovers and no partly used last card. A report is their "that
 *     card was empty" (contestRemainder): they were refunded from their own
 *     payment and the first shopper's deposit paid the seller. A shortfall is
 *     a leftover they left that was found short. Reports are why this rule
 *     exists: a next shopper who lies "empty" costs an honest first shopper
 *     up to $5, and this stops them doing it twice.
 *   - A SELLER whose leftovers 2 or more different buyers found short gets
 *     whole-card use only: their cards are never left partly used, so no
 *     deposit of theirs rides on a leftover they could spend unmarked.
 *   - A seller with a sale under an open dispute sells nothing new.
 *
 * The chain keeps lifetime counts (buyerShortfalls, sellerStats); the 30 days
 * are ours, from the events the keeper writes on each order as it sees them
 * (keeper-v2.ts): `ESCROW|Contested|` on the reporting buyer's order and
 * `ESCROW|Shortfall|` on the order whose leftover was found short. No
 * migration: they are OrderEvent rows like every other chain event.
 *
 * The rules are pure. The readers below them are for the router, which lands
 * with the till's merge, and the buyer's is also the V2 ticket route's gate on
 * a leftover.
 */

import type { Hex } from 'viem'
import { prisma } from '@/lib/db'
import { ESCROW_REF_PREFIX } from './refs'

/** How far back a report or shortfall counts. */
export const STANDING_WINDOW_MS = 30 * 86_400_000
/** Reports and shortfalls together, at or above which a buyer gets no leftovers. */
export const STANDING_LIMIT = 2

/** The reason text keeper-v2.ts writes on the reporting buyer's order when a leftover sale is contested. */
export const REPORT_EVENT_PREFIX = 'ESCROW|Contested|'
/** The reason text keeper-v2.ts writes on the order whose leftover was found short. */
export const SHORTFALL_EVENT_PREFIX = 'ESCROW|Shortfall|'
/** Order.failureReason of a V2 sale under an open dispute: the seller is named, so the router can skip them. */
export const DISPUTE_ORDER_PREFIX = 'escrow_disputed|seller:'

export interface BuyerEvent {
  kind: 'report' | 'shortfall'
  at: Date
}

export interface BuyerStanding {
  reports: number
  shortfalls: number
  /** May the router send this buyer to another seller's leftover? */
  remaindersAllowed: boolean
  /** May the router leave this buyer a partly used last card (and a deposit on it)? */
  partialLastAllowed: boolean
}

/** A buyer's standing from their events (spec section 7.5): 2 or more in 30 days and they get neither. */
export function buyerStanding(events: readonly BuyerEvent[], now: Date): BuyerStanding {
  const from = now.getTime() - STANDING_WINDOW_MS
  const recent = events.filter((e) => e.at.getTime() > from && e.at.getTime() <= now.getTime())
  const reports = recent.filter((e) => e.kind === 'report').length
  const shortfalls = recent.length - reports
  const ok = reports + shortfalls < STANDING_LIMIT
  return { reports, shortfalls, remaindersAllowed: ok, partialLastAllowed: ok }
}

/** One of a seller's leftovers found short, and who found it. */
export interface SellerShort {
  buyer: Hex
}

/**
 * A seller's standing: whole cards only once 2 or more different buyers found
 * their leftovers short. Different buyers, so one buyer's lie never costs a
 * seller this. Never a time window: a seller can mark self-use for free.
 */
export function sellerWholeCardOnly(shorts: readonly SellerShort[]): boolean {
  return new Set(shorts.map((s) => s.buyer.toLowerCase())).size >= STANDING_LIMIT
}

/** The seller named in a V2 order's dispute mark, or null. */
export function disputedSellerOf(failureReason: string | null): Hex | null {
  if (failureReason === null || !failureReason.startsWith(DISPUTE_ORDER_PREFIX)) return null
  const s = failureReason.slice(DISPUTE_ORDER_PREFIX.length)
  return /^0x[0-9a-f]{40}$/.test(s) ? (s as Hex) : null
}

/**
 * A buyer's standing from our books. The V2 ticket route asks it before a
 * leftover's ticket; the router (planTill, with the till's merge) asks it
 * before offering a leftover or a partly used last card.
 */
export async function escrowBuyerStanding(buyer: Hex, now: Date = new Date()): Promise<BuyerStanding> {
  const rows = await prisma.orderEvent.findMany({
    where: {
      createdAt: { gt: new Date(now.getTime() - STANDING_WINDOW_MS) },
      order: { payerAddress: buyer.toLowerCase(), paymentRef: { startsWith: ESCROW_REF_PREFIX } },
      OR: [{ reason: { startsWith: REPORT_EVENT_PREFIX } }, { reason: { startsWith: SHORTFALL_EVENT_PREFIX } }],
    },
    select: { reason: true, createdAt: true },
    take: 100,
  })
  return buyerStanding(
    rows.map((r) => ({ kind: (r.reason ?? '').startsWith(REPORT_EVENT_PREFIX) ? 'report' : 'shortfall', at: r.createdAt })),
    now,
  )
}

/**
 * Sellers the router gives whole-card use only, from our books: each
 * `ESCROW|Contested|` event names the seller, and its order's payer is the
 * buyer who found the leftover short.
 */
export async function escrowWholeCardSellers(): Promise<Hex[]> {
  const rows = await prisma.orderEvent.findMany({
    where: { reason: { startsWith: REPORT_EVENT_PREFIX }, order: { paymentRef: { startsWith: ESCROW_REF_PREFIX } } },
    select: { reason: true, order: { select: { payerAddress: true } } },
    take: 2_000,
  })
  const by = new Map<Hex, SellerShort[]>()
  for (const r of rows) {
    const m = /\|seller:(0x[0-9a-f]{40})(\||$)/.exec(r.reason ?? '')
    const buyer = r.order.payerAddress
    if (m === null || buyer === null) continue
    const seller = m[1] as Hex
    by.set(seller, [...(by.get(seller) ?? []), { buyer: buyer as Hex }])
  }
  return [...by.entries()].filter(([, shorts]) => sellerWholeCardOnly(shorts)).map(([seller]) => seller)
}

/**
 * Sellers with a V2 sale under an open dispute: the router skips all their
 * listings, as the V1 quote skips sellers whose V1 sale is disputed.
 */
export async function escrowDisputedSellersV2(): Promise<Hex[]> {
  const rows = await prisma.order.findMany({
    where: { state: 'fulfilling', failureReason: { startsWith: DISPUTE_ORDER_PREFIX }, paymentRef: { startsWith: ESCROW_REF_PREFIX } },
    select: { failureReason: true },
    take: 500,
  })
  return [...new Set(rows.map((r) => disputedSellerOf(r.failureReason)).filter((s): s is Hex => s !== null))]
}
