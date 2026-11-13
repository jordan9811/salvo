/**
 * Which rows the keepers read, what they write to find a party again, and
 * what the scripts that run them print and fail on (keeper.ts,
 * keeper-v2.ts). Pure: no database, no chain. The same paths against the
 * real schema are tests/escrow-keeper.test.ts and tests/escrow-v2-books.test.ts.
 *
 * Pinned:
 *   - the V2 keeper reads every settled row whose leftover may still hold a
 *     deposit, in turn, bounded by the listing's expiry; never only the
 *     newest rows, which a busy week would push older held deposits out of;
 *   - a V2 sale's seller is written on its order's Opened event and read
 *     back, so a payout the token refused is claimed for a week, as on V1;
 *   - V1's frozen mark follows the freeze both ways, and no other mark is
 *     touched;
 *   - V2's errors and its unsent work reach the scripts, and fail the run.
 */

import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { keeperErrors, keeperLeftUnsent, v1FrozenMarkMove, type KeeperReport } from '@/lib/escrow/keeper'
import { openedReasonV2, sellerOfOpenedV2, settledSweepQueryV2, type KeeperReportV2 } from '@/lib/escrow/keeper-v2'
import { ESCROW_V2_TEMPLATE_ID } from '@/lib/escrow/manifest-v2'

const DAY_MS = 86_400_000
const SELLER: Hex = '0x00000000000000000000000000000000000000a5'

describe('the V2 keeper reads every settled row that may hold a deposit, in turn', () => {
  it('bounded by the listing expiry, least recently read first, a batch at a time', () => {
    const now = 1_790_000_000_000
    const q = settledSweepQueryV2(now)
    // Eight days after the expiry: a deposit lives at most seven from the last sale, and no sale follows the expiry.
    expect(q.where.expiresAt).toEqual({ gte: new Date(now - 8 * DAY_MS) })
    // Not when the row last changed: reading a row stamps it, which moves that.
    expect(Object.keys(q.where)).not.toContain('updatedAt')
    expect(q.where.state).toEqual({ in: ['completed', 'cancelled', 'refunded'] })
    expect(q.where.sealedRef).toEqual({ path: ['lit', 'template'], equals: ESCROW_V2_TEMPLATE_ID })
    expect(q.orderBy).toEqual([{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }])
    expect(q.take).toBe(100)
  })
})

describe("a V2 sale's seller is found again for a week", () => {
  it("the Opened event names the seller, and reads back; events that do not, read as none", () => {
    const reason = openedReasonV2(42n, 1_234n, { usedCents: 1_700, leftAfterCents: 300, saleIndex: 0, seller: '0x00000000000000000000000000000000000000A5' })
    expect(reason).toBe(`ESCROW|Opened|deposit:42|block:1234|used:1700|left:300|sale:0|seller:${SELLER}`)
    expect(sellerOfOpenedV2(reason)).toBe(SELLER)
    expect(sellerOfOpenedV2('ESCROW|Opened|deposit:42|block:1234|used:1700|left:300|sale:0')).toBeNull()
    expect(sellerOfOpenedV2(`ESCROW|Released|deposit:42|seller:${SELLER}`)).toBeNull()
    expect(sellerOfOpenedV2(`ESCROW|Opened|deposit:42|seller:${SELLER}x`)).toBeNull()
  })
})

describe("V1's frozen mark follows the freeze both ways", () => {
  it('on while frozen, off once V2 is switched off again; another mark is never touched', () => {
    const frozenMark = 'escrow_suspect|v1_frozen|2026-10-12T00:00:00.000Z'
    expect(v1FrozenMarkMove(true, null)).toBe('mark')
    expect(v1FrozenMarkMove(true, frozenMark)).toBeNull()
    expect(v1FrozenMarkMove(false, frozenMark)).toBe('clear')
    expect(v1FrozenMarkMove(false, null)).toBeNull()
    expect(v1FrozenMarkMove(false, 'escrow_suspect|card_listed|2026-10-12T00:00:00.000Z')).toBeNull()
    expect(v1FrozenMarkMove(false, 'escrow: the seller refunded the buyer in full')).toBeNull()
  })
})

describe("V2's errors and unsent work reach the scripts", () => {
  const v1 = (over: Partial<KeeperReport> = {}): KeeperReport => ({
    ran: true,
    skipped: null,
    applied: true,
    keeperKey: true,
    block: '1',
    depositCount: 0,
    newDeposits: 0,
    ordersCreated: 0,
    foreignDeposits: 0,
    released: 0,
    refunded: 0,
    partRefunds: 0,
    disputes: 0,
    listingsCancelled: 0,
    listingsExpired: 0,
    payoutsDue: 0,
    payoutsSent: 0,
    claimsDue: 0,
    claimsSent: 0,
    errors: [],
    ...over,
  })
  const v2 = (over: Partial<KeeperReportV2> = {}): KeeperReportV2 => ({
    ran: true,
    skipped: null,
    applied: true,
    keeperKey: true,
    block: '1',
    depositCount: 0,
    newDeposits: 0,
    ordersCreated: 0,
    foreignDeposits: 0,
    released: 0,
    refunded: 0,
    contested: 0,
    partRefunds: 0,
    disputes: 0,
    listingsMoved: 0,
    listingsWaiting: 0,
    payoutsDue: 0,
    payoutsSent: 0,
    bondsDue: 0,
    bondsSent: 0,
    sellerReviews: 0,
    confirmsDue: 0,
    confirmsSent: 0,
    claimsDue: 0,
    claimsSent: 0,
    errors: [],
    ...over,
  })

  it("every error of both runs, V2's marked, so the cron log shows it and the run fails", () => {
    expect(keeperErrors(v1({ errors: ['order 1: a'], v2: v2({ errors: ['releaseBond(3): reverted (too early)'] }) }))).toEqual([
      'order 1: a',
      'v2: releaseBond(3): reverted (too early)',
    ])
    expect(keeperErrors(v1())).toEqual([])
    expect(keeperErrors(v1({ v2: v2() }))).toEqual([])
  })

  it('anything due and unsent, on either escrow', () => {
    expect(keeperLeftUnsent(v1({ v2: v2() }))).toBe(false)
    expect(keeperLeftUnsent(v1({ payoutsDue: 1 }))).toBe(true)
    for (const over of [{ payoutsDue: 1 }, { bondsDue: 1 }, { confirmsDue: 1 }, { claimsDue: 2, claimsSent: 1 }]) {
      expect(keeperLeftUnsent(v1({ v2: v2(over) }))).toBe(true)
    }
    expect(keeperLeftUnsent(v1({ v2: v2({ bondsDue: 1, bondsSent: 1 }) }))).toBe(false)
  })
})
