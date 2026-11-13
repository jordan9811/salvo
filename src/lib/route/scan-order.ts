/**
 * The order the cashier scans a purchase's cards in.
 *
 * ===========================================================================
 * WHY ORDER MATTERS AT ALL. A register applies each gift card up to what is
 * still owed. Scan the part-used card first and it drains, leaving one of the
 * whole cards part used instead, with its remainder on a barcode the shopper
 * has seen and above anything the plan bounded. So the one part-used card is
 * always last, and every card before it is used up.
 * ===========================================================================
 *
 * Among the used-up cards: the shopper's own first, then remainders, then
 * fresh cards. Any order would pay the same, so this one says which card is
 * which on the screen in the order a person would expect: their own credit,
 * then the leftover another shopper's purchase left first in line, then the
 * rest. The sort is stable, so cards of one kind keep the planner's order.
 *
 * This generalises one-screen's `scanOrder`, which knew only "used up" and
 * "part used". A leg with no `source` is ranked as a fresh card, so every
 * caller of the old rule gets exactly the old order.
 *
 * Pure and type-only on its one import, so the dollars rail may use it.
 */

import type { LegSource } from './plan'

function rank(leg: { fullyDrained: boolean; source?: LegSource }): number {
  if (!leg.fullyDrained) return 3
  if (leg.source === 'own_credit') return 0
  if (leg.source === 'remainder') return 1
  return 2
}

/** The legs in scan order. Never mutates its input. */
export function tillScanOrder<T extends { fullyDrained: boolean; source?: LegSource }>(legs: readonly T[]): T[] {
  return [...legs].sort((a, b) => rank(a) - rank(b))
}
