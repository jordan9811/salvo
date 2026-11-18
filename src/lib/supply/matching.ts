/**
 * Gate 4 — card-set matching.
 *
 * THE SECURITY GOAL, stated first because it drives every trade-off here:
 * **a card should be fully drained when it is used, so a number leaked
 * afterwards is worthless.** A card left with $40 on it is a bearer instrument
 * someone can still spend; a card left with $0 is a dead string.
 *
 * Strict full-drain-only starves the pool — it would refuse every order that
 * does not exactly equal some subset of available balances, which is almost all
 * of them. So the rule is relaxed in exactly one direction, and only as far as
 * necessary:
 *
 *   1. Prefer a set of cards that sum EXACTLY to the order. Every card dies.
 *   2. Otherwise drain cards fully and close the gap with ONE partial card,
 *      provided the leftover on it is under `residualCapCents` (default $10).
 *   3. A leftover at or above the cap is not a fill. Better to not match than to
 *      leave a spendable card behind.
 *
 * Best Buy's checkout accepts multiple gift cards on one order, which is what
 * makes (1) and (2) possible at all.
 *
 * This module is pure — no I/O, no adapter, no database — so the policy can be
 * tested exhaustively and reasoned about on its own.
 */

/** A card available to fill an order. */
export interface CardCandidate {
  intentId: string
  accountId: string
  merchantId: string
  /** Spendable balance, in cents. */
  balanceCents: number
}

/** One card's contribution to filling an order. */
export interface MatchLeg {
  card: CardCandidate
  /** How much of the order this card covers, in cents. */
  appliedCents: number
  /** True when the card is left at zero. */
  fullyDrained: boolean
  /** What remains on the card afterwards. Non-zero only on a partial leg. */
  residualCents: number
}

export interface MatchPlan {
  legs: MatchLeg[]
  /** Always equals the order total when a plan is returned. */
  totalAppliedCents: number
  /** True when EVERY leg is fully drained — nothing spendable left anywhere. */
  fullDrain: boolean
  /** Total spendable value left across all legs. 0 on a full drain. */
  residualCents: number
  /** 0..1. Every full drain outranks every partial. See scorePlan. */
  score: number
  strategy: 'exact_full_drain' | 'capped_partial'
}

export interface NoMatch {
  kind: 'no_match'
  reason: string
}

export interface MatchOptions {
  /**
   * Largest leftover tolerated on the single partial card. Default $10.
   * Set to 0 to require strict full drain.
   */
  residualCapCents?: number
  /**
   * Ceiling on cards per order. Real checkouts get unwieldy and each extra card
   * is another chance to trip a fraud rule, so this is a practical limit rather
   * than an arithmetic one.
   */
  maxCards?: number
}

export const DEFAULT_RESIDUAL_CAP_CENTS = 1000
export const DEFAULT_MAX_CARDS = 5

/**
 * Score a plan. The ordering property that matters:
 *
 *   every full drain  >  every capped partial
 *
 * so a partial can never outrank a full drain no matter how few cards it uses.
 * Within each class, fewer cards is better (less checkout friction), and among
 * partials a smaller leftover is better.
 */
export function scorePlan(
  legs: MatchLeg[],
  residualCapCents: number,
): { score: number; fullDrain: boolean; residualCents: number } {
  const residualCents = legs.reduce((n, l) => n + l.residualCents, 0)
  const fullDrain = residualCents === 0

  // Card-count penalty is small enough that it never crosses the class boundary.
  const cardPenalty = Math.min(0.09, (legs.length - 1) * 0.01)

  if (fullDrain) {
    return { score: 1 - cardPenalty, fullDrain: true, residualCents: 0 }
  }

  // Partials live strictly below 0.5; full drains live at 0.91..1.
  const cap = residualCapCents > 0 ? residualCapCents : 1
  const residualRatio = Math.min(1, residualCents / cap)
  return {
    score: Math.max(0, 0.5 - residualRatio * 0.4 - cardPenalty),
    fullDrain: false,
    residualCents,
  }
}

function buildPlan(
  legs: MatchLeg[],
  targetCents: number,
  residualCapCents: number,
  strategy: MatchPlan['strategy'],
): MatchPlan {
  const { score, fullDrain, residualCents } = scorePlan(legs, residualCapCents)
  return {
    legs,
    totalAppliedCents: targetCents,
    fullDrain,
    residualCents,
    score,
    strategy,
  }
}

/**
 * Find a subset summing EXACTLY to the target, preferring fewer cards.
 *
 * Exhaustive over subsets when the pool is small, which is the realistic case
 * for one merchant's live intents. Above that it falls back to a bounded
 * descending-greedy probe rather than hanging: a missed exact match degrades to
 * a capped partial, which is a worse plan but still a correct one.
 */
export function findExactDrainSet(
  cards: readonly CardCandidate[],
  targetCents: number,
  maxCards: number,
): CardCandidate[] | null {
  if (targetCents <= 0) return null

  const usable = cards.filter((c) => c.balanceCents > 0 && c.balanceCents <= targetCents)
  if (usable.length === 0) return null

  const EXHAUSTIVE_LIMIT = 18
  if (usable.length <= EXHAUSTIVE_LIMIT) {
    let best: CardCandidate[] | null = null
    const n = usable.length

    for (let mask = 1; mask < 1 << n; mask++) {
      const picked: CardCandidate[] = []
      let sum = 0
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) {
          const c = usable[i]
          if (!c) continue
          picked.push(c)
          sum += c.balanceCents
          if (sum > targetCents || picked.length > maxCards) break
        }
      }
      if (sum !== targetCents || picked.length > maxCards) continue
      if (!best || picked.length < best.length) best = picked
      if (best.length === 1) break
    }
    return best
  }

  // Large pool: descending greedy. Not guaranteed optimal, and that is stated
  // rather than hidden — the caller still gets a correct plan or none.
  const sorted = [...usable].sort((a, b) => b.balanceCents - a.balanceCents)
  const picked: CardCandidate[] = []
  let remaining = targetCents
  for (const c of sorted) {
    if (picked.length >= maxCards) break
    if (c.balanceCents <= remaining) {
      picked.push(c)
      remaining -= c.balanceCents
    }
    if (remaining === 0) return picked
  }
  return remaining === 0 ? picked : null
}

/**
 * Plan how to fill `targetCents` from the available cards.
 *
 * Returns the highest-scoring plan, or NoMatch with a reason. Never returns a
 * plan whose leftover exceeds the cap.
 */
export function planCardMatch(
  targetCents: number,
  cards: readonly CardCandidate[],
  opts: MatchOptions = {},
): MatchPlan | NoMatch {
  const residualCapCents = opts.residualCapCents ?? DEFAULT_RESIDUAL_CAP_CENTS
  const maxCards = opts.maxCards ?? DEFAULT_MAX_CARDS

  if (targetCents <= 0) {
    return { kind: 'no_match', reason: `order total ${targetCents} is not fillable` }
  }

  const pool = cards.filter((c) => c.balanceCents > 0)
  if (pool.length === 0) {
    return { kind: 'no_match', reason: 'no cards with a positive balance' }
  }

  const totalAvailable = pool.reduce((n, c) => n + c.balanceCents, 0)
  if (totalAvailable < targetCents) {
    return {
      kind: 'no_match',
      reason: `available balance ${totalAvailable}c is short of ${targetCents}c`,
    }
  }

  // --- 1. Exact full drain. Every card dies; nothing spendable survives. -----
  const exact = findExactDrainSet(pool, targetCents, maxCards)
  if (exact) {
    const legs: MatchLeg[] = exact.map((card) => ({
      card,
      appliedCents: card.balanceCents,
      fullyDrained: true,
      residualCents: 0,
    }))
    return buildPlan(legs, targetCents, residualCapCents, 'exact_full_drain')
  }

  // --- 2. Full drains + ONE capped partial ----------------------------------
  // Drain smallest-first: it clears low-value cards out of the pool, which is
  // both the "balance-natural draining" behaviour the substrate asks for and the
  // way to leave the fewest spendable stragglers behind.
  const ascending = [...pool].sort(
    (a, b) => a.balanceCents - b.balanceCents || a.intentId.localeCompare(b.intentId),
  )

  const drained: CardCandidate[] = []
  let remaining = targetCents

  for (const card of ascending) {
    if (drained.length >= maxCards - 1) break
    if (card.balanceCents >= remaining) break
    drained.push(card)
    remaining -= card.balanceCents
  }

  if (remaining === 0) {
    // The greedy pass happened to land exactly. Still a full drain.
    const legs: MatchLeg[] = drained.map((card) => ({
      card,
      appliedCents: card.balanceCents,
      fullyDrained: true,
      residualCents: 0,
    }))
    return buildPlan(legs, targetCents, residualCapCents, 'exact_full_drain')
  }

  // Close the gap with the card leaving the SMALLEST leftover.
  const used = new Set(drained.map((c) => c.intentId))
  let closer: CardCandidate | null = null
  let closerResidual = Number.POSITIVE_INFINITY

  for (const card of pool) {
    if (used.has(card.intentId)) continue
    if (card.balanceCents < remaining) continue
    const residual = card.balanceCents - remaining
    if (residual < closerResidual) {
      closer = card
      closerResidual = residual
    }
  }

  if (!closer) {
    return {
      kind: 'no_match',
      reason: `no single card can cover the remaining ${remaining}c within ${maxCards} cards`,
    }
  }

  if (closerResidual > residualCapCents) {
    return {
      kind: 'no_match',
      reason:
        `closing this order would leave ${closerResidual}c on a card, above the ` +
        `${residualCapCents}c residual cap — refusing rather than leaving a spendable card behind`,
    }
  }

  const legs: MatchLeg[] = [
    ...drained.map((card) => ({
      card,
      appliedCents: card.balanceCents,
      fullyDrained: true,
      residualCents: 0,
    })),
    {
      card: closer,
      appliedCents: remaining,
      fullyDrained: closerResidual === 0,
      residualCents: closerResidual,
    },
  ]

  return buildPlan(
    legs,
    targetCents,
    residualCapCents,
    closerResidual === 0 ? 'exact_full_drain' : 'capped_partial',
  )
}

export function isNoMatch(v: MatchPlan | NoMatch): v is NoMatch {
  return (v as NoMatch).kind === 'no_match'
}

/**
 * Plan with some cards FIRST IN LINE: used whole, oldest first, before any
 * other card, wherever they fit.
 *
 * WHY A CARD IS FIRST IN LINE. A card whose last shopper said it did not scan
 * goes back on sale with their hold kept behind it, and only the next
 * shopper's scan can show whether they told the truth (barcode/unscanned.ts).
 * A card nobody routes to keeps that hold on an honest shopper's card for
 * days, so routing sends the next purchase it fits to it first.
 *
 * USED WHOLE, AND ONLY WHERE IT FITS. A first-in-line card is taken only when
 * its whole balance is no more than what is still owed, so it never becomes
 * the part-used card, and only while the plan stays within `maxCards`. The
 * rest of the order is planned exactly as `planCardMatch` plans any order.
 * When no plan uses one, the plain plan is returned and the card waits for a
 * purchase it fits: being first in line never refuses an order.
 */
export function planWithFirstInLine(
  targetCents: number,
  firstInLine: readonly CardCandidate[],
  others: readonly CardCandidate[],
  opts: MatchOptions = {},
): MatchPlan | NoMatch {
  const residualCapCents = opts.residualCapCents ?? DEFAULT_RESIDUAL_CAP_CENTS
  const maxCards = opts.maxCards ?? DEFAULT_MAX_CARDS
  const plain = () => planCardMatch(targetCents, [...firstInLine, ...others], opts)
  if (targetCents <= 0 || firstInLine.length === 0) return plain()

  const taken: CardCandidate[] = []
  let remaining = targetCents
  for (const card of firstInLine) {
    if (card.balanceCents <= 0 || card.balanceCents > remaining) continue
    const closes = card.balanceCents === remaining
    // Leave a place for the card that closes the order, unless this one does.
    if (taken.length + 1 > maxCards || (!closes && taken.length + 1 >= maxCards)) break
    taken.push(card)
    remaining -= card.balanceCents
    if (remaining === 0) break
  }
  if (taken.length === 0) return plain()

  const whole: MatchLeg[] = taken.map((card) => ({
    card,
    appliedCents: card.balanceCents,
    fullyDrained: true,
    residualCents: 0,
  }))
  if (remaining === 0) return buildPlan(whole, targetCents, residualCapCents, 'exact_full_drain')

  const used = new Set(taken.map((c) => c.intentId))
  const rest = planCardMatch(
    remaining,
    [...firstInLine, ...others].filter((c) => !used.has(c.intentId)),
    { residualCapCents, maxCards: maxCards - taken.length },
  )
  if (isNoMatch(rest)) return plain()
  return buildPlan([...whole, ...rest.legs], targetCents, residualCapCents, rest.strategy)
}
