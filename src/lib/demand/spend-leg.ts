/**
 * What one card of an in-store purchase covers at the register, kept on its order.
 *
 * ===========================================================================
 * WHY THE ORDER HAS TO CARRY IT. A spend is one order per card, and each order
 * records only its own PRICE. The reveal measured exposure against that price:
 * face minus what the shopper paid. But a shopper who pays $54 for all of a $60
 * card at 10% off has used the whole $60, and nothing is left on it for anyone.
 * Measured against the price, that card showed $6 of "exposure" and was refused
 * at a blind store, whose cap is $5, even though a full drain leaves $0.
 *
 * Exposure is the value left on the card beyond what this purchase applies to
 * the bill (docs/mechanism/settlement.md, "the residual cap"). The price is not
 * that number, and the applied value is. So the buy writes the applied value
 * here, once per card, and the reveal reads it back.
 * ===========================================================================
 *
 * WHERE, AND WHY THAT IS NOT A MIGRATION. An `OrderEvent` with no state change,
 * the same pattern as the hold's HOLD_TRY marker (src/lib/hold/stripe-hold.ts)
 * and the buyer's account (src/lib/barcode/buyer-evidence.ts). Shape:
 *
 *   SPEND_LEG|<appliedCents>|<i>of<n>|<leftoverCents>
 *
 * `i` is the card's place in the scan order, from 1. `leftoverCents` is what
 * the plan leaves on that card: 0 on every card but the one partly used.
 *
 * AN ORDER WITHOUT ONE IS MEASURED AS IT ALWAYS WAS, against its price. That is
 * every order bought before this marker existed, and every order not bought as
 * a spend. The price is the larger exposure of the two, so the fallback can
 * only refuse more, never less.
 *
 * Stripe-free and pure apart from the two database calls, so the till code
 * that must not reach Stripe can use it.
 */

import type { Order, OrderEvent } from '@prisma/client'
import { prisma, type Tx } from '../db'

const SPEND_LEG_MARKER = 'SPEND_LEG'

/** Written at intake, beside the order's own creation event. */
const SPEND_LEG_ACTOR = 'intake'

/**
 * One of an order's events, as a reader over events already read takes it.
 * The till reads every event of a purchase in one query and answers each
 * question from those (till/card-till.ts PurchaseEvents), by the same rule
 * as the one-order reader beside it here.
 */
export type EventRow = Pick<OrderEvent, 'orderId' | 'reason' | 'actor' | 'toState'>

export interface SpendLeg {
  /** What this card covers at the register, in cents. */
  appliedCents: number
  /** Its place in the scan order, from 1. */
  index: number
  /** How many cards the purchase uses. */
  of: number
  /** What the plan leaves on this card afterwards, in cents. */
  leftoverCents: number
}

function encodeSpendLeg(leg: SpendLeg): string {
  return `${SPEND_LEG_MARKER}|${leg.appliedCents}|${leg.index}of${leg.of}|${leg.leftoverCents}`
}

/** Read a marker back. Null for anything that is not a well-formed one. */
export function decodeSpendLeg(reason: string | null | undefined): SpendLeg | null {
  if (!reason || !reason.startsWith(`${SPEND_LEG_MARKER}|`)) return null
  const [, appliedRaw, place, leftoverRaw, ...rest] = reason.split('|')
  if (rest.length > 0 || appliedRaw === undefined || place === undefined || leftoverRaw === undefined) return null
  const m = /^(\d+)of(\d+)$/.exec(place)
  const applied = Number(appliedRaw)
  const leftover = Number(leftoverRaw)
  const index = Number(m?.[1])
  const of = Number(m?.[2])
  if (!m || !Number.isSafeInteger(applied) || applied <= 0) return null
  if (!Number.isSafeInteger(leftover) || leftover < 0) return null
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(of) || index < 1 || index > of) return null
  return { appliedCents: applied, index, of, leftoverCents: leftover }
}

/**
 * Write the marker for one card's order. No state change: both states are the
 * order's current one, as for every marker on this table.
 */
export async function recordSpendLeg(order: Pick<Order, 'id' | 'state'>, leg: SpendLeg, db: Tx = prisma): Promise<void> {
  const reason = encodeSpendLeg(leg)
  // Refused rather than written, so a bad figure can never become the number
  // a reveal measures against.
  if (decodeSpendLeg(reason) === null) throw new Error(`not a valid spend leg: ${reason}`)
  await db.orderEvent.create({
    data: {
      orderId: order.id,
      fromState: order.state,
      toState: order.state,
      reason,
      actor: SPEND_LEG_ACTOR,
    },
  })
}

/**
 * The marker on this order, or null when it was not bought as a spend.
 *
 * THE LATEST WINS. The card till writes a second one when the register total
 * changes after a code is shown (src/lib/till/card-till.ts): the card then
 * covers a different amount and leaves a different leftover, and every later
 * reader (the release, a re-open's exposure check) must see the revision.
 */
export async function spendLegFor(orderId: string): Promise<SpendLeg | null> {
  const row = await prisma.orderEvent.findFirst({
    where: { orderId, actor: SPEND_LEG_ACTOR, reason: { startsWith: `${SPEND_LEG_MARKER}|` } },
    orderBy: { createdAt: 'desc' },
  })
  return decodeSpendLeg(row?.reason)
}

/** spendLegFor's answer, from the order's events already read, newest first. */
export function spendLegIn(newestFirst: readonly EventRow[]): SpendLeg | null {
  return decodeSpendLeg(
    newestFirst.find((e) => e.actor === SPEND_LEG_ACTOR && (e.reason ?? '').startsWith(`${SPEND_LEG_MARKER}|`))?.reason,
  )
}

/**
 * The marker as the buy wrote it, before any change of total revised it: what
 * the card's hold was priced for. Null when the order was not bought as a
 * spend. From the order's events already read, newest first: the first one
 * written.
 */
export function spendLegAtBuyIn(newestFirst: readonly EventRow[]): SpendLeg | null {
  let first: string | null = null
  for (const e of newestFirst) {
    if (e.actor === SPEND_LEG_ACTOR && (e.reason ?? '').startsWith(`${SPEND_LEG_MARKER}|`)) first = e.reason
  }
  return decodeSpendLeg(first)
}

/**
 * Every event on one order, newest first, in one read: for a step that asks
 * several of the questions above of the same order with nothing written in
 * between (reveal-service.ts finishRelease).
 */
export async function orderEventsFor(orderId: string): Promise<EventRow[]> {
  return prisma.orderEvent.findMany({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
    select: { orderId: true, reason: true, actor: true, toState: true },
  })
}

/**
 * What the card held when this purchase was planned: what it applies plus
 * what it leaves. The face for a fresh card; for a remainder listed again
 * (supply/remainder.ts), only what the last purchase left on it.
 *
 * A STORE NOBODY CAN READ IS MEASURED ON THIS, not on the face. There the
 * reveal's exposure is the declared value less what this code applies, and a
 * remainder measured against its original face read as the whole spent part
 * left exposed, so it was refused at every blind store. Never above the face:
 * the plan cannot have found more on the card than was listed. An order with
 * no spend leg is measured on the face, as it always was.
 */
export function cardValueCents(leg: SpendLeg | null, faceValueCents: number): number {
  if (!leg) return faceValueCents
  return Math.min(faceValueCents, leg.appliedCents + leg.leftoverCents)
}

/**
 * The value this order's card applies at the register: the spend leg when the
 * order has one, else its price. The number exposure is measured against.
 */
export async function appliedValueCents(order: { id: string; priceCents: number }): Promise<number> {
  return (await spendLegFor(order.id))?.appliedCents ?? order.priceCents
}

// ===========================================================================
// A card till leg
// ===========================================================================

/** On an order the card till bought (src/lib/till/card-till.ts). */
const TILL_LEG_MARKER = 'TILL_LEG'

/**
 * Mark an order as a card till leg, at buy, beside its spend leg.
 *
 * WHY IT MATTERS AFTER THE BUY. At a store whose balance we read, the till
 * bills what the card actually paid, and takes any excess from the shopper's
 * own deposit (unified-account spec 5.2 step 6). The shop, which predates the
 * till and holds no deposit, charges its price as it always has; this marker
 * is how the settle tells the two apart.
 */
export async function recordTillLeg(order: Pick<Order, 'id' | 'state'>, db: Tx = prisma): Promise<void> {
  await db.orderEvent.create({
    data: {
      orderId: order.id,
      fromState: order.state,
      toState: order.state,
      reason: TILL_LEG_MARKER,
      actor: SPEND_LEG_ACTOR,
    },
  })
}

/** Was this order bought by the card till? From the order's events already read. */
export function isTillLegIn(events: readonly EventRow[]): boolean {
  return events.some((e) => e.actor === SPEND_LEG_ACTOR && e.reason === TILL_LEG_MARKER)
}
