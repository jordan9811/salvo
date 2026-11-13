'use client'

/**
 * The seller's discount, 1% to 99%, on one slider.
 *
 * FINE WHERE PEOPLE PRICE, FAST PAST IT. Almost every card lists between 1%
 * and 40% off, so the first 70% of the track moves one percent at a time
 * across that range. The last 30% of the track runs from 40% to 99%, about
 * two percent a step, so a seller who wants a card gone today can reach it
 * without a second control. The old slider stopped at 40%, which read as a
 * rule when it was only a number in three files: both servers take up to 99%.
 */

import type { CSSProperties } from 'react'

export const DISCOUNT_MIN = 1
export const DISCOUNT_MAX = 99
/** Where the fine range ends: one percent a step up to here. */
const KNEE = 40
/** The share of the track the fine range takes, out of STEPS. */
const KNEE_AT = 70
const STEPS = 100

/** Slider position (0 to 100) to a whole-percent discount. */
export function discountAt(position: number): number {
  const p = Math.min(STEPS, Math.max(0, Math.round(position)))
  if (p <= KNEE_AT) return Math.round(DISCOUNT_MIN + ((KNEE - DISCOUNT_MIN) * p) / KNEE_AT)
  return Math.round(KNEE + ((DISCOUNT_MAX - KNEE) * (p - KNEE_AT)) / (STEPS - KNEE_AT))
}

/** A discount to the slider position that shows it: the smallest position reading that discount. */
export function positionOf(discount: number): number {
  const d = Math.min(DISCOUNT_MAX, Math.max(DISCOUNT_MIN, Math.round(discount)))
  for (let p = 0; p <= STEPS; p++) if (discountAt(p) >= d) return p
  return STEPS
}

export function DiscountSlider({ id, discount, onChange }: { id: string; discount: number; onChange: (d: number) => void }) {
  const position = positionOf(discount)
  return (
    <input
      id={id}
      type="range"
      min={0}
      max={STEPS}
      value={position}
      onChange={(e) => onChange(discountAt(Number(e.target.value)))}
      aria-valuemin={DISCOUNT_MIN}
      aria-valuemax={DISCOUNT_MAX}
      aria-valuenow={discount}
      aria-valuetext={`${discount} percent off`}
      style={{ '--fill': `${position}%` } as CSSProperties}
    />
  )
}
