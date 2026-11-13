/**
 * Leapfrog routing: which cards pay for one purchase at the till, and how
 * much of each (unified-account spec, section 6).
 *
 * ===========================================================================
 * WHAT THIS DECIDES, AND WHAT IT LEAVES TO THE CALLER.
 *
 * Given a total and the cards on offer at one store, pick the cards, what
 * each covers at the register and what each costs, in the order they are
 * scanned. The caller reads the supply and the shopper's setting, and does
 * everything with money. This module reads nothing and writes nothing, so
 * every rule below is tested on its own, exhaustively where it can be.
 *
 * It replaces "exact full drain first, then smallest first" (planCardMatch)
 * for the till, for three reasons the old matcher could not meet:
 *
 *   - THE LEFTOVER OF ONE PURCHASE IS THE NEXT PURCHASE'S FIRST CARD. A card
 *     left part used goes back on sale with the first shopper's deposit
 *     behind it, and the deposit only comes back once someone uses the rest.
 *     So a card waiting first in line is used, whole, before fresh supply.
 *   - THE SHOPPER CHOOSES. "Most savings" spends more cards to pay less; "In
 *     and out" pays a little more to scan fewer. Both stay inside the cap.
 *   - EXACT FIT IS A TIE-BREAK, NOT A GOAL. The old matcher would rather scan
 *     three cards that sum exactly than one card with a small leftover. With
 *     a deposit on the leftover, an exact fit buys nothing a shopper wants.
 * ===========================================================================
 *
 * THE RULES, in the spec's order:
 *
 *   1. Own credit first: drained at cost 0. If it covers the total, only own
 *      cards are used, the last one part used. No cap: it is their card.
 *      Fewer of their own cards only when that many leaves no plan, so the
 *      card limit spent on their own credit never refuses a purchase.
 *   2. Cards first in line, oldest first, each used WHOLE and only where it
 *      is no more than what is still owed: a remainder, or a card a shopper
 *      said did not scan, with their hold kept behind it (unscanned.ts). A
 *      remainder is never the part-used card, so its value is never split.
 *   3. Fresh cards: an exhaustive search over at most 18 candidates, falling
 *      back to planCardMatch above that. At most ONE card is left part used,
 *      its leftover within the cap, and every card costs at least the floor.
 *   4. Score, by the shopper's setting. See `better`.
 *   5. No full plan is no plan. The spec's partial cover ("then $X your usual
 *      way") is not built: the shopper rejected paying the rest another way.
 *   6. Scan order: own, remainders, fresh, the part-used card last.
 *   7. Deposit: the part-used card's leftover at face, when it reaches the
 *      floor. Below it the leftover gets no deposit and is retired as a loss.
 *
 * THE CAP IS NEVER EXCEEDED, and the property test holds that over random
 * pools. It is enforced here, at the reveal (decideReveal), and nowhere is it
 * a preference: the setting only chooses among plans already inside it.
 *
 * Pure. Imports only types and the matcher, so the dollars rail may use it.
 */

import { isNoMatch, planCardMatch, type CardCandidate } from '../supply/matching'
import { tillScanOrder } from './scan-order'

// ===========================================================================
// The shopper's setting
// ===========================================================================

export type RouteMode = 'most_savings' | 'in_and_out'

export interface RoutePreference {
  mode: RouteMode
  maxCards: 1 | 2 | 3 | 4 | 5
}

/**
 * The most cards one purchase may use, whatever the setting. Target takes up
 * to ten gift cards per transaction; five keeps a till queue moving, and the
 * slider in the account page stops there.
 */
export const MAX_TILL_CARDS = 5

/** In and out, two cards: exactly what the shop did before the setting existed. */
export const DEFAULT_ROUTE_PREFERENCE: Readonly<RoutePreference> = { mode: 'in_and_out', maxCards: 2 }

/** "Most savings" with no slider set. */
const MOST_SAVINGS_DEFAULT_CARDS = 4

/**
 * A setting from anywhere (a request body, the device's settings record) as
 * one the planner can use. Anything unrecognised is the default, never an
 * error: a malformed setting should cost a shopper a few cents, not a refusal
 * at a register.
 */
export function routePreference(raw?: { mode?: unknown; maxCards?: unknown } | null): RoutePreference {
  const mode: RouteMode = raw?.mode === 'most_savings' ? 'most_savings' : 'in_and_out'
  const fallback = mode === 'most_savings' ? MOST_SAVINGS_DEFAULT_CARDS : DEFAULT_ROUTE_PREFERENCE.maxCards
  const n = raw?.maxCards
  const maxCards =
    typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_TILL_CARDS ? n : fallback
  return { mode, maxCards: maxCards as RoutePreference['maxCards'] }
}

// ===========================================================================
// The price of a leg (spec 6.4)
// ===========================================================================

/**
 * Price one card leg.
 *
 * Pro-rated against that intent's own discount, so a seller offering 12% off is
 * paid as if 12% off whatever fraction of their card is used. Averaging across
 * the plan would quietly redistribute between sellers.
 *
 * A REMAINDER IS PRICED THE SAME WAY, on its own value, at the seller's
 * original discount: face and price stay as listed when it is listed again, so
 * this one formula prices both. On chain, `priceFor` must give the same result.
 *
 * Rounds UP. A rounding error must not come out of the seller's side.
 */
export function legCostCents(
  appliedCents: number,
  intentPriceCents: number,
  intentFaceValueCents: number,
): number {
  if (intentFaceValueCents <= 0) return appliedCents
  return Math.ceil((appliedCents * intentPriceCents) / intentFaceValueCents)
}

/**
 * A price less the haircut, rounded up for the seller as the price itself is.
 *
 * THE HAIRCUT COMES OFF THE PRICE, NEVER OFF THE VALUE PLANNED. Planning a
 * remainder at 75% of itself would let the register take the other 25% from
 * it, and that 25% would be left on the last card, past the cap. The haircut
 * protects the next shopper from a remainder that turns out short; taking it
 * off what they pay does that without moving the leftover.
 */
function afterHaircut(costCents: number, haircutBps: number): number {
  if (haircutBps <= 0) return costCents
  return Math.ceil((costCents * (10_000 - Math.min(10_000, haircutBps))) / 10_000)
}

// ===========================================================================
// Input and output
// ===========================================================================

/** Where a card in a plan came from. */
export type LegSource = 'own_credit' | 'remainder' | 'fresh'

/** One of the shopper's own cards: theirs, so it costs nothing to use. */
export interface OwnCredit {
  ref: string
  balanceCents: number
}

/** A card on offer. */
export interface TillCandidate {
  /** The listing: the intent id on the card rail. */
  ref: string
  /** The seller, so a demoted seller's cards can be kept whole. */
  accountId: string
  /** What the card holds as planned: its face, or a remainder's own value. */
  balanceCents: number
  /** The listing's price and face, which set its discount. */
  priceCents: number
  faceValueCents: number
}

/** A card waiting first in line. Oldest first, as the caller passes them. */
export interface FirstInLineCandidate extends TillCandidate {
  /**
   * `remainder`: what an earlier purchase left on a card. `unscanned`: a whole
   * card whose last shopper said it did not scan, with their hold kept behind
   * it until the next scan shows the truth.
   */
  kind: 'remainder' | 'unscanned'
  /**
   * Whether money stands behind it: the first shopper's deposit for a
   * remainder, the kept hold for an unscanned card. A remainder with nothing
   * behind it is priced with the haircut off (open decision 3).
   */
  covered: boolean
}

export interface PlanTillInput {
  totalCents: number
  /** The shopper's own cards. Used first, at cost 0, when `ownCreditFirst`. */
  own?: readonly OwnCredit[]
  /** Cards first in line, OLDEST FIRST. */
  firstInLine?: readonly FirstInLineCandidate[]
  fresh: readonly TillCandidate[]
  /** The most one part-used card may be left with: the store's cap. */
  capCents: number
  preference: RoutePreference
  /** The smallest a card's price may be. Card 50 (a card charge's floor), dollars 1. */
  minLegCostCents: number
  /** The smallest leftover that gets a deposit. Card 50, dollars 1. */
  minDepositCents: number
  /** Taken off a remainder's price when nothing stands behind it. */
  haircutBps: number
  /** Default on. Off, the shopper's own cards are not used at all. */
  ownCreditFirst?: boolean
  /**
   * A shopper with repeated remainder shortfalls or reports, or repeated Nos
   * at a store nobody can check (spec 7.5): nothing waiting first in line,
   * and no part-used last card, so nothing is left behind them.
   */
  buyerBarred?: boolean
  /**
   * Sellers whose remainders came up short for different buyers (spec 7.5):
   * their cards are used whole only, so they never leave a remainder.
   */
  demotedAccountIds?: readonly string[]
}

/** One card of a plan. Named as the till's Leg (spec 5.1), plus `fullyDrained`. */
export interface TillLeg {
  ref: string
  source: LegSource
  /** A card that was waiting first in line, of either kind. */
  firstInLine: boolean
  /** What the card held as planned before this purchase. */
  faceCents: number
  /** What it covers at the register. */
  appliedCents: number
  /** What the shopper pays for that. 0 for their own card. */
  costCents: number
  /** What is left on it after. Non-zero on the one part-used card only. */
  leftoverCents: number
  /** The deposit held against that leftover, at face. */
  depositCents: number
  fullyDrained: boolean
  /** Its place in the scan order, from 1, of `scanOf`. */
  scanIndex: number
  scanOf: number
}

export interface TillPlan {
  totalCents: number
  /** In scan order. */
  legs: TillLeg[]
  /** What the shopper pays, all cards together. */
  costCents: number
  savingCents: number
  /** Held against the part-used card's leftover. 0 when none is left, or too little. */
  depositCents: number
  /** Left on cards that are not the shopper's own. Within the cap by construction. */
  leftoverCents: number
  preference: RoutePreference
}

export interface NoTillPlan {
  kind: 'no_plan'
  reason: string
}

export function isNoTillPlan(v: TillPlan | NoTillPlan): v is NoTillPlan {
  return (v as NoTillPlan).kind === 'no_plan'
}

// ===========================================================================
// The planner
// ===========================================================================

/** The same bound the matcher uses: 2^18 subsets is still instant. */
const EXHAUSTIVE_LIMIT = 18

/** A leftover this small cannot be listed again (relist.ts), so it is avoided when another plan exists. */
const AWKWARD_LEFTOVER_MAX_CENTS = 99

interface Draft {
  ref: string
  source: LegSource
  firstInLine: boolean
  faceCents: number
  appliedCents: number
  costCents: number
  leftoverCents: number
}

interface Scored {
  drafts: Draft[]
  cost: number
  cards: number
  leftover: number
  waiting: number
  awkward: number
  partialBalance: number
  key: string
}

interface Ctx {
  cap: number
  minLeg: number
  haircutBps: number
  demoted: ReadonlySet<string>
  barred: boolean
}

/**
 * Plan one purchase. Returns the best plan by the shopper's setting, or why
 * none exists. Never a plan that leaves more than the cap on a card that is
 * not the shopper's own, and never one that covers less than the total.
 */
export function planTill(input: PlanTillInput): TillPlan | NoTillPlan {
  const total = input.totalCents
  if (!Number.isSafeInteger(total) || total <= 0) {
    return { kind: 'no_plan', reason: `order total ${total} is not fillable` }
  }
  const preference = routePreference(input.preference)
  const ctx: Ctx = {
    cap: Math.max(0, input.capCents),
    minLeg: Math.max(0, input.minLegCostCents),
    haircutBps: Math.max(0, input.haircutBps),
    demoted: new Set(input.demotedAccountIds ?? []),
    barred: input.buyerBarred === true,
  }
  const finish = (drafts: Draft[]) => finishPlan(drafts, total, preference, input.minDepositCents)

  // --- 1. Own credit -------------------------------------------------------
  // Largest first, so the fewest of their own cards covers it.
  const own =
    input.ownCreditFirst === false
      ? []
      : [...(input.own ?? [])]
          .filter((c) => c.balanceCents > 0)
          .sort((a, b) => b.balanceCents - a.balanceCents || a.ref.localeCompare(b.ref))
  const ownCovering = coverWithOwn(own, total, preference.maxCards)
  if (ownCovering) return finish(ownCovering)

  // Not enough on their own: drain the largest, leaving a place for a card
  // on sale to close the purchase. Fewer of their own only when that many
  // leaves no plan at all: a card limit spent on their own credit must not
  // refuse a purchase the market could cover.
  // A barred shopper gets nothing that waits first in line: a remainder would
  // leave them deciding someone's deposit, and a card behind a kept hold
  // someone's hold (spec 7.5; supply/remainder.ts counts both kinds of No).
  const queue = (input.firstInLine ?? []).filter(
    (c) => c.balanceCents > 0 && !ctx.barred && (c.kind !== 'remainder' || !ctx.demoted.has(c.accountId)),
  )
  for (let n = Math.min(own.length, preference.maxCards - 1); n >= 0; n--) {
    const chosen = bestAfterOwn(own.slice(0, n).map(ownWhole), total, queue, input.fresh, preference, ctx)
    if (chosen) return finish(chosen.drafts)
  }

  // --- 5. No full plan ------------------------------------------------------
  // The wording carries the phrase the shop turns into a sentence a shopper
  // can act on ("short of"); see one-screen.ts `humanise`.
  const available =
    sum(own.map((c) => c.balanceCents)) +
    sum(queue.map((c) => c.balanceCents)) +
    sum(input.fresh.map((c) => Math.max(0, c.balanceCents)))
  if (available < total) {
    return { kind: 'no_plan', reason: `available balance ${available}c is short of ${total}c` }
  }
  return {
    kind: 'no_plan',
    reason:
      `no plan covers ${total}c within ${preference.maxCards} cards, a ${ctx.cap}c leftover and a ` +
      `${ctx.minLeg}c floor on each card, at a saving`,
  }
}

/**
 * Steps 2 to 4 with these own cards drained: the best plan by the shopper's
 * setting, or null when none covers the rest.
 */
function bestAfterOwn(
  ownDrafts: Draft[],
  total: number,
  queue: readonly FirstInLineCandidate[],
  fresh: readonly TillCandidate[],
  preference: RoutePreference,
  ctx: Ctx,
): Scored | null {
  const owed = total - sum(ownDrafts.map((d) => d.appliedCents))
  const slots = preference.maxCards - ownDrafts.length

  // --- 2. First in line ----------------------------------------------------
  // A remainder from a demoted seller, and anything waiting for a barred
  // shopper, was left out of the queue for someone else.
  const prefix: FirstInLineCandidate[] = []
  let rest = owed
  for (const card of queue) {
    if (card.balanceCents > rest) continue
    if (wholeCost(card, ctx) < ctx.minLeg) continue
    const closes = card.balanceCents === rest
    // Leave a place for the card that closes the purchase, unless this one does.
    if (prefix.length + 1 > slots || (!closes && prefix.length + 1 >= slots)) continue
    prefix.push(card)
    rest -= card.balanceCents
    if (rest === 0) break
  }

  // --- 3 and 4. Fresh cards, and the score ---------------------------------
  // Every shorter prefix too, longest first, so a plan that skips a waiting
  // card is still found when the shopper's setting prefers it. The score
  // breaks a tie on card count toward the plan that uses more of them.
  let best: Scored | null = null
  const consider = (drafts: Draft[]) => {
    const scored = score(drafts, total, ctx)
    if (scored && (best === null || better(scored, best, preference.mode))) best = scored
  }
  // Only cards on sale may be part used. A card first in line has someone
  // else's money behind it (a remainder's deposit, or an unscanned card's
  // kept hold), so it is used whole or skipped, never split: a shorter
  // prefix skips it.
  const pool: Array<TillCandidate & { firstInLine: boolean }> = fresh.map((c) => ({ ...c, firstInLine: false }))
  for (let k = prefix.length; k >= 0; k--) {
    const taken = prefix.slice(0, k)
    const takenDrafts = taken.map((c) => firstInLineWhole(c, ctx))
    const owedRest = owed - sum(taken.map((c) => c.balanceCents))
    if (owedRest === 0) {
      consider([...ownDrafts, ...takenDrafts])
      continue
    }
    eachCompletion(owedRest, pool, slots - k, ctx, (completion) =>
      consider([...ownDrafts, ...takenDrafts, ...completion]),
    )
  }
  return best
}

/** Own cards alone, when they cover the total within the card limit. */
function coverWithOwn(own: readonly OwnCredit[], total: number, maxCards: number): Draft[] | null {
  const picked: OwnCredit[] = []
  let covered = 0
  for (const card of own) {
    if (picked.length >= maxCards) break
    picked.push(card)
    covered += card.balanceCents
    if (covered >= total) break
  }
  if (covered < total || picked.length === 0) return null
  // All used up but the last, which covers what is still owed. Its leftover
  // stays the shopper's own, so no cap and no deposit apply to it.
  return picked.map((card, i) => {
    if (i < picked.length - 1) return ownWhole(card)
    const applied = total - (covered - card.balanceCents)
    return {
      ref: card.ref,
      source: 'own_credit' as const,
      firstInLine: false,
      faceCents: card.balanceCents,
      appliedCents: applied,
      costCents: 0,
      leftoverCents: card.balanceCents - applied,
    }
  })
}

function ownWhole(card: OwnCredit): Draft {
  return {
    ref: card.ref,
    source: 'own_credit',
    firstInLine: false,
    faceCents: card.balanceCents,
    appliedCents: card.balanceCents,
    costCents: 0,
    leftoverCents: 0,
  }
}

/** What a waiting card costs used whole, with the haircut when nothing stands behind a remainder. */
function wholeCost(card: FirstInLineCandidate, ctx: Ctx): number {
  const cost = legCostCents(card.balanceCents, card.priceCents, card.faceValueCents)
  return card.kind === 'remainder' && !card.covered ? afterHaircut(cost, ctx.haircutBps) : cost
}

function firstInLineWhole(card: FirstInLineCandidate, ctx: Ctx): Draft {
  return {
    ref: card.ref,
    // An unscanned card is a whole fresh card that happens to be waiting.
    source: card.kind === 'remainder' ? 'remainder' : 'fresh',
    firstInLine: true,
    faceCents: card.balanceCents,
    appliedCents: card.balanceCents,
    costCents: wholeCost(card, ctx),
    leftoverCents: 0,
  }
}

function freshLeg(card: TillCandidate & { firstInLine: boolean }, appliedCents: number): Draft {
  return {
    ref: card.ref,
    source: 'fresh',
    firstInLine: card.firstInLine,
    faceCents: card.balanceCents,
    appliedCents,
    costCents: legCostCents(appliedCents, card.priceCents, card.faceValueCents),
    leftoverCents: card.balanceCents - appliedCents,
  }
}

/**
 * Every way to cover `owed` from `pool` with at most `slots` cards, all used
 * up but at most one, that one's leftover within the cap. Calls `visit` with
 * each. Above the exhaustive limit, the matcher's one plan.
 *
 * SUPERSETS COUNT. A covering set with one more card can cost less, when the
 * extra card is cheaper and takes value off a dearer one, so the search does
 * not stop at the first set that covers. The leftover only grows as cards are
 * added, so a branch whose leftover passes the cap is cut there.
 */
function eachCompletion(
  owed: number,
  pool: ReadonlyArray<TillCandidate & { firstInLine: boolean }>,
  slots: number,
  ctx: Ctx,
  visit: (drafts: Draft[]) => void,
): void {
  if (slots <= 0 || owed <= 0) return
  // A barred shopper leaves nothing behind: full drains only.
  const cap = ctx.barred ? 0 : ctx.cap
  const usable = pool.filter((c) => c.balanceCents > 0)

  if (usable.length > EXHAUSTIVE_LIMIT) {
    const byRef = new Map(usable.map((c) => [c.ref, c]))
    const asCandidates: CardCandidate[] = usable.map((c) => ({
      intentId: c.ref,
      accountId: c.accountId,
      merchantId: '',
      balanceCents: c.balanceCents,
    }))
    const plan = planCardMatch(owed, asCandidates, { residualCapCents: cap, maxCards: slots })
    if (isNoMatch(plan)) return
    const drafts: Draft[] = []
    for (const leg of plan.legs) {
      const card = byRef.get(leg.card.intentId)
      if (!card) return
      if (!leg.fullyDrained && ctx.demoted.has(card.accountId)) return
      drafts.push(freshLeg(card, leg.appliedCents))
    }
    visit(drafts)
    return
  }

  const sorted = [...usable].sort((a, b) => b.balanceCents - a.balanceCents || a.ref.localeCompare(b.ref))
  const picked: Array<TillCandidate & { firstInLine: boolean }> = []

  const emit = (covered: number) => {
    const leftover = covered - owed
    if (leftover === 0) {
      visit(picked.map((c) => freshLeg(c, c.balanceCents)))
      return
    }
    // Any one card may be the part-used one, provided the rest do not
    // already cover the purchase, which is the same as it holding more than
    // the leftover. Each choice prices differently, so each is a plan.
    for (const partial of picked) {
      if (partial.balanceCents <= leftover) continue
      if (ctx.demoted.has(partial.accountId)) continue
      visit(
        picked.map((c) =>
          c === partial ? freshLeg(c, c.balanceCents - leftover) : freshLeg(c, c.balanceCents),
        ),
      )
    }
  }

  const dfs = (start: number, covered: number) => {
    if (picked.length > 0 && covered >= owed) emit(covered)
    if (picked.length === slots) return
    for (let i = start; i < sorted.length; i++) {
      const card = sorted[i]
      if (!card) continue
      const next = covered + card.balanceCents
      if (next - owed > cap) continue
      picked.push(card)
      dfs(i + 1, next)
      picked.pop()
    }
  }
  dfs(0, 0)
}

/** A candidate plan's score, or null when it breaks a rule and cannot be offered. */
function score(drafts: Draft[], total: number, ctx: Ctx): Scored | null {
  let cost = 0
  let applied = 0
  let leftover = 0
  let partials = 0
  let partialBalance = 0
  let waiting = 0
  for (const d of drafts) {
    applied += d.appliedCents
    cost += d.costCents
    if (d.firstInLine) waiting += 1
    if (d.source === 'own_credit') continue
    // The floor on every card someone is charged for: a card rail charge
    // under 50c fails at the till, after the shopper was quoted.
    if (d.costCents < ctx.minLeg) return null
    if (d.leftoverCents > 0) {
      partials += 1
      leftover += d.leftoverCents
      partialBalance = d.faceCents
    }
  }
  // Belt and braces over the construction above: these are the rules the
  // reveal and the shopper rely on, so a plan that breaks one is dropped.
  if (applied !== total || partials > 1 || leftover > (ctx.barred ? 0 : ctx.cap)) return null
  // No saving is no product.
  if (cost >= total) return null
  const refs = drafts.map((d) => d.ref).sort()
  const partialRef = drafts.find((d) => d.source !== 'own_credit' && d.leftoverCents > 0)?.ref ?? ''
  return {
    drafts,
    cost,
    cards: drafts.length,
    leftover,
    waiting,
    awkward: leftover >= 1 && leftover <= AWKWARD_LEFTOVER_MAX_CENTS ? 1 : 0,
    partialBalance,
    key: `${refs.join(',')}|${partialRef}`,
  }
}

/**
 * Is `a` strictly better than `b` for this shopper?
 *
 *   Most savings:   lower cost, then fewer cards, then more waiting cards used.
 *   In and out:     fewer cards, then more waiting cards used, then lower cost.
 *   then, in both:  no leftover of 1c to 99c, then the smaller leftover (so an
 *                   exact fit wins only here, as a tie-break), then the
 *                   part-used card with more on it (the smaller cards are the
 *                   ones used up, as the matcher's smallest-first drain did),
 *                   then a fixed order of ids.
 *
 * "More waiting cards used" comes straight after card count: when two plans
 * scan as many cards, the one that moves a deposit or a kept hold along wins
 * (spec 6.2 step 4).
 *
 * A LEFTOVER OF 1c TO 99c IS AVOIDED, BUT NEVER AT THE SHOPPER'S EXPENSE. It is
 * too small to list again (relist.ts), so on the card rail it is a loss of
 * under a dollar. Ranked above the setting, it would make "Most savings" pay
 * dollars more to save that loss, which is not what the shopper asked for. So
 * it ranks straight after the setting's own keys: among plans the shopper
 * would call equal, the one that leaves nothing, or a dollar or more, wins.
 */
function better(a: Scored, b: Scored, mode: RouteMode): boolean {
  const keys =
    mode === 'most_savings'
      ? [a.cost - b.cost, a.cards - b.cards, b.waiting - a.waiting]
      : [a.cards - b.cards, b.waiting - a.waiting, a.cost - b.cost]
  keys.push(a.awkward - b.awkward, a.leftover - b.leftover, b.partialBalance - a.partialBalance)
  for (const d of keys) if (d !== 0) return d < 0
  return a.key < b.key
}

function finishPlan(
  drafts: Draft[],
  totalCents: number,
  preference: RoutePreference,
  minDepositCents: number,
): TillPlan {
  const ordered = tillScanOrder(drafts.map((d) => ({ ...d, fullyDrained: d.leftoverCents === 0 })))
  const legs: TillLeg[] = ordered.map((d, i) => {
    // Only a card on sale carries a deposit: an own card's leftover is theirs.
    const deposit =
      d.source !== 'own_credit' && d.leftoverCents > 0 && d.leftoverCents >= minDepositCents ? d.leftoverCents : 0
    return {
      ref: d.ref,
      source: d.source,
      firstInLine: d.firstInLine,
      faceCents: d.faceCents,
      appliedCents: d.appliedCents,
      costCents: d.costCents,
      leftoverCents: d.leftoverCents,
      depositCents: deposit,
      fullyDrained: d.fullyDrained,
      scanIndex: i + 1,
      scanOf: ordered.length,
    }
  })
  const costCents = sum(legs.map((l) => l.costCents))
  return {
    totalCents,
    legs,
    costCents,
    savingCents: totalCents - costCents,
    depositCents: sum(legs.map((l) => l.depositCents)),
    leftoverCents: sum(legs.filter((l) => l.source !== 'own_credit').map((l) => l.leftoverCents)),
    preference,
  }
}

function sum(xs: readonly number[]): number {
  return xs.reduce((n, x) => n + x, 0)
}
