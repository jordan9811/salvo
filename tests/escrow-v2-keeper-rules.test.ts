/**
 * The V2 keeper's decisions, as pure functions (keeper-v2-rules.ts). Each is
 * the contract's own rule read off chain, so these cases are the contract's
 * edges: tests/escrow-v2-server.test.ts runs the same rules against the real
 * SalvoEscrowV2. No database, no network.
 */

import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { ESCROW_V2_LIMITS } from '@/lib/escrow/config-v2'
import {
  bondActionV2,
  confirmDueV2,
  intentPath,
  intentTargetV2,
  payoutDueV2,
  saleOutcomeV2,
  shortfallIsBuyersV2,
  V2_SECONDS,
} from '@/lib/escrow/keeper-v2-rules'
import { MODE_BLIND, MODE_READABLE } from '@/lib/escrow/merchants'
import { V2_STATE, type DepositViewV2, type ListingViewV2 } from '@/lib/escrow/runbook/reads-v2'
import { ALL_INTENT_STATES, canTransitionIntent, LEGAL_INTENT_TRANSITIONS } from '@/lib/intent/state'

const T = 1_790_000_000
const ZERO: Hex = '0x0000000000000000000000000000000000000000'

function listing(over: Partial<ListingViewV2> = {}): ListingViewV2 {
  return {
    seller: ZERO,
    state: V2_STATE.listing.ACTIVE,
    createdAt: T,
    remainingCents: 0,
    sales: 0,
    bondDeposit: 0n,
    bondSince: 0,
    confirmedAt: 0,
    lastDeposit: 0n,
    mode: MODE_BLIND,
    ...over,
  }
}

function sale(over: Partial<DepositViewV2> = {}): DepositViewV2 {
  return {
    depositor: ZERO,
    openedAt: T,
    releaseAt: T + 86_400,
    state: V2_STATE.deposit.OPENED,
    disputed: false,
    seller: ZERO,
    amount: 1n,
    listingId: `0x${'0'.repeat(64)}`,
    replyKeyHash: `0x${'0'.repeat(64)}`,
    cardTag: `0x${'0'.repeat(64)}`,
    usedCents: 1,
    leftAfterCents: 0,
    saleIndex: 0,
    bond: 0n,
    bondState: V2_STATE.bond.NONE,
    covers: 0n,
    contestUntil: 0,
    ...over,
  }
}

describe('the clocks', () => {
  it('are the contract numbers the config route serves', () => {
    expect(V2_SECONDS).toEqual({
      contestWindow: ESCROW_V2_LIMITS.contestWindowSeconds,
      bondReviewAfter: ESCROW_V2_LIMITS.bondReviewAfterSeconds,
      bondMaxAge: ESCROW_V2_LIMITS.bondMaxAgeSeconds,
      confirmDelay: ESCROW_V2_LIMITS.confirmDelaySeconds,
    })
  })
})

describe('our listing row follows the listing', () => {
  const expiry = T + 30 * 86_400

  it('offered while Active, with what is left once a sale has used some; the face value before', () => {
    expect(intentTargetV2(listing(), null, T, expiry, 'offered')).toEqual({ state: 'offered', balanceCents: null, cancellation: null })
    expect(intentTargetV2(listing({ sales: 1, remainingCents: 400 }), sale(), T, expiry, 'offered')).toEqual({
      state: 'offered',
      balanceCents: 400,
      cancellation: null,
    })
  })

  it('cancelled once expired: the contract sells nothing at or after the expiry', () => {
    expect(intentTargetV2(listing(), null, expiry, expiry, 'offered')).toMatchObject({ state: 'cancelled', cancellation: 'expired' })
    expect(intentTargetV2(listing(), null, expiry - 1, expiry, 'offered')).toMatchObject({ state: 'offered' })
  })

  it('drained: executing until the sale that drained it settles, then completed, or refunded if its seller refunded it', () => {
    const drained = listing({ state: V2_STATE.listing.DRAINED, sales: 2, lastDeposit: 2n })
    expect(intentTargetV2(drained, sale(), T, expiry, 'offered')).toMatchObject({ state: 'executing', balanceCents: 0 })
    expect(intentTargetV2(drained, sale({ state: V2_STATE.deposit.RELEASED }), T, expiry, 'executing')).toMatchObject({ state: 'completed' })
    expect(intentTargetV2(drained, sale({ state: V2_STATE.deposit.REFUNDED }), T, expiry, 'executing')).toMatchObject({ state: 'refunded' })
  })

  it('cancelled or spent: an unsold row is cancelled, a sold one refunded', () => {
    const cancelled = listing({ state: V2_STATE.listing.CANCELLED })
    expect(intentTargetV2(cancelled, null, T, expiry, 'offered')).toMatchObject({ state: 'cancelled', cancellation: 'seller_reclaimed' })
    expect(intentTargetV2(cancelled, sale({ state: V2_STATE.deposit.REFUNDED }), T, expiry, 'executing')).toMatchObject({ state: 'refunded' })
    const spent = listing({ state: V2_STATE.listing.SPENT, sales: 1 })
    expect(intentTargetV2(spent, sale(), T, expiry, 'offered')).toMatchObject({ state: 'cancelled', cancellation: 'balance_dropped' })
    expect(intentTargetV2(spent, sale({ state: V2_STATE.deposit.CONTESTED }), T, expiry, 'executing')).toMatchObject({ state: 'refunded' })
  })

  it('a terminal row never moves, and no listing on chain is no target', () => {
    for (const s of ['completed', 'cancelled', 'refunded'] as const) expect(intentTargetV2(listing(), null, T, expiry, s)).toBeNull()
    expect(intentTargetV2(listing({ state: 0 }), null, T, expiry, 'offered')).toBeNull()
  })
})

describe('moves go through the intent table, edge by edge', () => {
  it('finds the shortest legal path, and every step is a legal move', () => {
    expect(intentPath('offered', 'offered')).toEqual([])
    expect(intentPath('offered', 'executing')).toEqual(['matched', 'executing'])
    expect(intentPath('executing', 'completed')).toEqual(['completed'])
    expect(intentPath('executing', 'refunded')).toEqual(['execution_failed', 'refunded'])
    expect(intentPath('offered', 'completed')).toEqual(['matched', 'executing', 'completed'])
    for (const from of ALL_INTENT_STATES) {
      for (const to of ALL_INTENT_STATES) {
        const path = intentPath(from, to)
        if (path === null) continue
        let at = from
        for (const step of path) {
          expect(canTransitionIntent(at, step), `${from} -> ${to} via ${at} -> ${step}`).toBe(true)
          at = step
        }
        expect(at).toBe(to)
      }
    }
  })

  it('a drained listing that reopens waits for the executing -> offered edge the till adds, and takes it once it is there', () => {
    expect(intentPath('executing', 'offered')).toEqual(LEGAL_INTENT_TRANSITIONS.executing.includes('offered') ? ['offered'] : null)
    // A terminal row has nowhere to go.
    expect(intentPath('completed', 'offered')).toBeNull()
  })
})

describe('payouts', () => {
  it('a sale is paid at releaseAt, never before, and a leftover sale not before its contest window ends', () => {
    expect(saleOutcomeV2(sale())).toBe('open')
    expect(saleOutcomeV2(sale({ state: V2_STATE.deposit.CONTESTED }))).toBe('contested')
    expect(saleOutcomeV2(sale({ state: 0 }))).toBe('missing')
    const d = sale({ releaseAt: T + 86_400 })
    expect(payoutDueV2(d, T + 86_399)).toBe(false)
    expect(payoutDueV2(d, T + 86_400)).toBe(true)
    expect(payoutDueV2(sale({ releaseAt: T, contestUntil: T + 10 }), T + 9)).toBe(false)
    expect(payoutDueV2(sale({ state: V2_STATE.deposit.RELEASED, releaseAt: T }), T + 1)).toBe(false)
  })
})

describe('the deposit on a leftover', () => {
  const held = sale({ bondState: V2_STATE.bond.HELD, bond: 4_000_000n })

  it('comes back two hours after the next shopper used the leftover, at the edge and not a second before (decision 1)', () => {
    const l = listing({ state: V2_STATE.listing.DRAINED, bondDeposit: 1n, bondSince: T, lastDeposit: 2n })
    const covering = sale({ covers: 1n, contestUntil: T + 7_200 })
    expect(bondActionV2(held, 1n, l, covering, T + 7_199)).toEqual({ kind: 'wait', until: T + 7_200, review: false })
    expect(bondActionV2(held, 1n, l, covering, T + 7_200)).toEqual({ kind: 'return', why: 'next_use_held' })
  })

  it('comes back at once on a cancelled listing, and by rule at seven days with no sale resolving it', () => {
    expect(bondActionV2(held, 1n, listing({ state: V2_STATE.listing.CANCELLED, bondSince: T, lastDeposit: 1n }), held, T)).toEqual({
      kind: 'return',
      why: 'listing_cancelled',
    })
    const l = listing({ sales: 1, remainingCents: 400, bondDeposit: 1n, bondSince: T, lastDeposit: 1n })
    expect(bondActionV2(held, 1n, l, held, T + 7 * 86_400 - 1)).toMatchObject({ kind: 'wait', until: T + 7 * 86_400 })
    expect(bondActionV2(held, 1n, l, held, T + 7 * 86_400)).toEqual({ kind: 'return', why: 'max_age' })
  })

  it('asks the seller from day five to day seven, while it is unsold', () => {
    const l = listing({ sales: 1, remainingCents: 400, bondDeposit: 1n, bondSince: T, lastDeposit: 1n })
    expect(bondActionV2(held, 1n, l, held, T + 5 * 86_400 - 1)).toMatchObject({ kind: 'wait', review: false })
    expect(bondActionV2(held, 1n, l, held, T + 5 * 86_400)).toMatchObject({ kind: 'wait', review: true })
  })

  it('is nothing to do once returned or forfeited', () => {
    for (const bondState of [V2_STATE.bond.NONE, V2_STATE.bond.RETURNED, V2_STATE.bond.FORFEITED]) {
      expect(bondActionV2(sale({ bondState }), 1n, listing({ state: V2_STATE.listing.CANCELLED }), null, T)).toEqual({ kind: 'none' })
    }
  })

  it("the buyer's own leftover use is not a covering sale: it nets their deposit in the same transaction", () => {
    // A buyer's own leftover use returns the deposit itself; a sale with no contest window covers nothing here.
    const l = listing({ sales: 2, remainingCents: 100, bondDeposit: 1n, bondSince: T, lastDeposit: 2n })
    expect(bondActionV2(held, 1n, l, sale({ covers: 1n, contestUntil: 0 }), T + 3 * 3_600)).toMatchObject({ kind: 'wait' })
  })
})

describe('the readable read', () => {
  const readable = listing({ mode: MODE_READABLE, sales: 1, remainingCents: 500, bondDeposit: 1n, bondSince: T })
  const basis = sale({ openedAt: T })

  it('is due fifteen minutes after the sale that left the leftover, once', () => {
    expect(confirmDueV2(readable, basis, T + 899, false)).toBe(false)
    expect(confirmDueV2(readable, basis, T + 900, false)).toBe(true)
    // A read that late is already posted: not again.
    expect(confirmDueV2({ ...readable, confirmedAt: T + 900 }, basis, T + 2_000, false)).toBe(false)
    // An earlier read (the buyer's own, before the window ended) does not close it.
    expect(confirmDueV2({ ...readable, confirmedAt: T + 60 }, basis, T + 900, false)).toBe(true)
  })

  it('is due at once when a ticket found it short, but never in the sale\'s own second or twice in one', () => {
    expect(confirmDueV2(readable, basis, T + 1, true)).toBe(true)
    expect(confirmDueV2(readable, basis, T, true)).toBe(false)
    expect(confirmDueV2({ ...readable, confirmedAt: T + 5 }, basis, T + 5, true)).toBe(false)
  })

  it('never for a blind card, before a sale, after it is closed, or with no deposit and no short report', () => {
    expect(confirmDueV2({ ...readable, mode: MODE_BLIND }, basis, T + 900, true)).toBe(false)
    expect(confirmDueV2({ ...readable, sales: 0 }, basis, T + 900, true)).toBe(false)
    expect(confirmDueV2({ ...readable, state: V2_STATE.listing.DRAINED }, basis, T + 900, true)).toBe(false)
    expect(confirmDueV2({ ...readable, bondDeposit: 0n }, basis, T + 900, false)).toBe(false)
    expect(confirmDueV2(readable, null, T + 900, true)).toBe(false)
  })

  it("a short read counts against the deposit's buyer only while their window is open", () => {
    expect(shortfallIsBuyersV2(readable, basis, 300)).toBe(true)
    expect(shortfallIsBuyersV2(readable, basis, 500)).toBe(false)
    expect(shortfallIsBuyersV2({ ...readable, confirmedAt: T + 900 }, basis, 300)).toBe(false)
    expect(shortfallIsBuyersV2({ ...readable, bondDeposit: 0n }, basis, 300)).toBe(false)
  })
})
