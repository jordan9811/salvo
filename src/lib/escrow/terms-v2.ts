/**
 * What one leg of a V2 purchase costs, in TypeScript: SalvoEscrowV2's
 * `_priceUse` and `_settle`, rule for rule, so the phone can ask its wallet
 * for exactly what the contract will pull (spec section 5.3: one approve of
 * the sum of every leg's amount and deposit).
 *
 * The rules, from the contract (spec section 8.3):
 *   - R, the value left, is the card's value before the first sale, then the
 *     listing's remainingCents. 0 < used <= R.
 *   - left = R - used is at most the listing's residualCapCents.
 *   - A remainder another buyer's deposit covers is used whole.
 *   - amount = ceil(used x price x (1 - haircut) / value). The haircut applies
 *     only to a remainder no deposit covers (decision 3).
 *   - The deposit is `left` at face: left x 10000 units.
 *   - The buyer's own covering deposit comes back in the same transaction,
 *     netted, so a leg either pulls or pays back, never both.
 *
 * The contract stays the one that decides; this only lets the phone ask for
 * the right allowance and say no before it pays. tests/escrow-v2-hashes.test.ts
 * holds it to the contract on 200 generated legs.
 *
 * Isomorphic: no imports but types. The browser loads this.
 */

import type { EscrowTermsV2 } from './hashes-v2'

const UNITS_PER_CENT = 10_000n
const BPS = 10_000n

/**
 * ceil(used x price x (BPS - haircut) / (value x BPS)), in token units: the
 * contract's priceFor. With no haircut it is legCostCents (src/lib/demand/quote.ts)
 * in token units. It rounds up, so a rounding error never comes out of the seller's side.
 */
export function priceForV2(price: bigint, valueCents: number, usedCents: number, haircutBps: number): bigint {
  if (valueCents <= 0 || haircutBps < 0 || BigInt(haircutBps) >= BPS) throw new RangeError('price args')
  const n = BigInt(usedCents) * price * (BPS - BigInt(haircutBps))
  const q = BigInt(valueCents) * BPS
  return n === 0n ? 0n : (n - 1n) / q + 1n
}

/** The listing as gate() reads it, plus what the buyer knows about the covering deposit. */
export interface ListingNowV2 {
  /** gate().remainingCents. 0 before the first sale. */
  remainingCents: number
  /** gate().sales. */
  sales: number
  /** gate().bondDeposit: the deposit whose bond covers what is left, 0 if none. */
  bondDeposit: bigint
  /**
   * When the buyer is that deposit's depositor: its bond still held, in token
   * units (getDeposit(bondDeposit).bond). null when it is someone else's or there is none.
   */
  ownBond: bigint | null
}

/** Why the contract would refuse the use, by its own revert text. */
export type UseRefusalV2 = 'used' | 'left' | 'remainder whole'

export interface UseQuoteV2 {
  usedCents: number
  /** The cents this sale leaves on the card, deposited at face. */
  leftCents: number
  /** What the seller is paid for the cents used, in token units. */
  amount: bigint
  /** The deposit at face for the cents left, in token units. */
  bond: bigint
  /** Whether the remainder haircut came off the price. */
  haircut: boolean
  /** What the contract pulls from the buyer: amount plus bond, less their own deposit back. */
  pull: bigint
  /** What it pays the buyer back when their own deposit exceeds the new amount and bond. */
  refund: bigint
}

/**
 * The cost of using `usedCents` of a V2 listing now, or the contract's reason
 * to refuse. Only the use rules: the ticket's own checks (value left, sales,
 * card, time, signature) are the ticket's.
 */
export function quoteUseV2(t: EscrowTermsV2, now: ListingNowV2, usedCents: number): UseQuoteV2 | { refused: UseRefusalV2 } {
  const have = now.sales === 0 ? t.valueCents : now.remainingCents
  if (!Number.isSafeInteger(usedCents) || usedCents <= 0 || usedCents > have) return { refused: 'used' }
  const left = have - usedCents
  if (left > t.residualCapCents) return { refused: 'left' }
  const covered = now.bondDeposit !== 0n
  if (covered && left !== 0 && now.ownBond === null) return { refused: 'remainder whole' }
  const haircut = now.sales > 0 && !covered
  const amount = priceForV2(t.price, t.valueCents, usedCents, haircut ? t.remainderHaircutBps : 0)
  const bond = BigInt(left) * UNITS_PER_CENT
  const due = amount + bond
  const back = covered && now.ownBond !== null ? now.ownBond : 0n
  return {
    usedCents,
    leftCents: left,
    amount,
    bond,
    haircut,
    pull: due >= back ? due - back : 0n,
    refund: back > due ? back - due : 0n,
  }
}
