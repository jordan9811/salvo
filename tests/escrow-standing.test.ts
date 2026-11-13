/**
 * Who gets leftovers on the dollars rail (standing.ts; unified spec sections
 * 7.2, 7.5 and 17, decision 1): two reports or shortfalls in 30 days and a
 * buyer gets no leftovers and no partly used last card; two different buyers
 * finding a seller's leftovers short and that seller's cards are used whole.
 * The pure rules only; the readers over our books need Postgres.
 */

import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import {
  buyerStanding,
  DISPUTE_ORDER_PREFIX,
  disputedSellerOf,
  REPORT_EVENT_PREFIX,
  sellerWholeCardOnly,
  SHORTFALL_EVENT_PREFIX,
  STANDING_LIMIT,
  STANDING_WINDOW_MS,
} from '@/lib/escrow/standing'

const NOW = new Date('2026-10-12T12:00:00Z')
const DAY = 86_400_000
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY)
const A: Hex = '0x00000000000000000000000000000000000000a1'
const B: Hex = '0x00000000000000000000000000000000000000b2'

describe('a buyer', () => {
  it('keeps leftovers after one report, and loses them and the partly used last card at the second in 30 days', () => {
    expect(STANDING_LIMIT).toBe(2)
    expect(STANDING_WINDOW_MS).toBe(30 * DAY)
    expect(buyerStanding([], NOW)).toEqual({ reports: 0, shortfalls: 0, remaindersAllowed: true, partialLastAllowed: true })
    expect(buyerStanding([{ kind: 'report', at: ago(3) }], NOW)).toMatchObject({ reports: 1, remaindersAllowed: true, partialLastAllowed: true })
    expect(buyerStanding([{ kind: 'report', at: ago(3) }, { kind: 'report', at: ago(29) }], NOW)).toEqual({
      reports: 2,
      shortfalls: 0,
      remaindersAllowed: false,
      partialLastAllowed: false,
    })
  })

  it('counts reports and shortfalls together', () => {
    expect(buyerStanding([{ kind: 'report', at: ago(1) }, { kind: 'shortfall', at: ago(2) }], NOW)).toMatchObject({
      reports: 1,
      shortfalls: 1,
      remaindersAllowed: false,
    })
    expect(buyerStanding([{ kind: 'shortfall', at: ago(1) }, { kind: 'shortfall', at: ago(2) }], NOW)).toMatchObject({ partialLastAllowed: false })
  })

  it('forgets what is older than 30 days, and ignores anything dated after now', () => {
    expect(buyerStanding([{ kind: 'report', at: ago(30) }, { kind: 'report', at: ago(1) }], NOW)).toMatchObject({ reports: 1, remaindersAllowed: true })
    expect(buyerStanding([{ kind: 'report', at: ago(-1) }, { kind: 'report', at: ago(1) }], NOW)).toMatchObject({ reports: 1, remaindersAllowed: true })
  })
})

describe('a seller', () => {
  it('is held to whole cards only once two different buyers found their leftovers short', () => {
    expect(sellerWholeCardOnly([])).toBe(false)
    expect(sellerWholeCardOnly([{ buyer: A }, { buyer: A }, { buyer: A.toUpperCase().replace('0X', '0x') as Hex }])).toBe(false)
    expect(sellerWholeCardOnly([{ buyer: A }, { buyer: B }])).toBe(true)
  })

  it('under an open dispute is named on the order, and nothing else parses as one', () => {
    expect(disputedSellerOf(`${DISPUTE_ORDER_PREFIX}${A}`)).toBe(A)
    for (const bad of [null, '', 'escrow_disputed', `${DISPUTE_ORDER_PREFIX}0xnotanaddress`, `${DISPUTE_ORDER_PREFIX}${A.toUpperCase()}`]) {
      expect(disputedSellerOf(bad)).toBeNull()
    }
  })
})

describe('the events the keeper writes are the ones the readers look for', () => {
  it('have distinct prefixes, so a report is never read as a shortfall', () => {
    expect(REPORT_EVENT_PREFIX).toBe('ESCROW|Contested|')
    expect(SHORTFALL_EVENT_PREFIX).toBe('ESCROW|Shortfall|')
    expect(REPORT_EVENT_PREFIX.startsWith(SHORTFALL_EVENT_PREFIX) || SHORTFALL_EVENT_PREFIX.startsWith(REPORT_EVENT_PREFIX)).toBe(false)
  })
})
