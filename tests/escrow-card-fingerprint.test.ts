/**
 * One card across both escrows (card-fingerprint.ts): the fingerprint the
 * seller's page computes, and the verdict the listing route gives on every
 * other listing that carries it. V2 cannot see V1's card tags, so this is
 * what keeps a card sold on V1 from being sold again on V2. No database.
 */

import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { cardFingerprint, CARD_FINGERPRINT_ITERATIONS, CARD_FINGERPRINT_RE, fingerprintVerdict, parseCardFingerprint, type FingerprintMatch } from '@/lib/escrow/card-fingerprint'
import { plaintextKeyIn } from '@/lib/escrow/http'

const ME: Hex = '0x00000000000000000000000000000000000000a1'
const OTHER: Hex = '0x00000000000000000000000000000000000000b2'

describe('the fingerprint', () => {
  it('is the same for the same card on any device, and never the card', async () => {
    const card = '9999123412341234'
    const a = await cardFingerprint(9, card)
    expect(a).toMatch(CARD_FINGERPRINT_RE)
    expect(await cardFingerprint(9, card)).toBe(a)
    expect(a).not.toContain(card)
    expect(a).not.toContain(Buffer.from(card).toString('hex'))
    expect(CARD_FINGERPRINT_ITERATIONS).toBeGreaterThanOrEqual(600_000)
  })

  it('differs by card and by store, and reads both forms of a Best Buy number as one card', async () => {
    const bestbuy = '6123456789012345'
    const fp = await cardFingerprint(1, bestbuy)
    expect(await cardFingerprint(1, `88${bestbuy}`)).toBe(fp)
    expect(await cardFingerprint(2, bestbuy)).not.toBe(fp)
    expect(await cardFingerprint(1, '6123456789012346')).not.toBe(fp)
  })

  it("refuses a store the escrow does not know and a number not in the store's format", async () => {
    await expect(cardFingerprint(9, '1234')).rejects.toThrow(RangeError)
    await expect(cardFingerprint(3, '12345678901234567890123456x')).rejects.toThrow(RangeError)
    await expect(cardFingerprint(7 as never, '9999123412341234')).rejects.toThrow(RangeError)
  })

  it('is parsed only in its exact form, and its field name is not one the routes take for card material', () => {
    expect(parseCardFingerprint(`0x${'ab'.repeat(32)}`)).toBe(`0x${'ab'.repeat(32)}`)
    for (const bad of [`0x${'AB'.repeat(32)}`, `0x${'ab'.repeat(31)}`, 'ab'.repeat(32), 42, null, undefined]) {
      expect(parseCardFingerprint(bad)).toBeNull()
    }
    expect(plaintextKeyIn({ manifest: '{}', cardFingerprint: `0x${'ab'.repeat(32)}` })).toBeNull()
  })
})

describe('the verdict on other listings of the same card', () => {
  const m = (over: Partial<FingerprintMatch>): FingerprintMatch => ({ version: 1, state: 'offered', seller: OTHER, buyer: null, chain: 'active', listedAt: 1, ...over })
  const THIRD: Hex = '0x00000000000000000000000000000000000000c3'

  it('a card sold on V1 cannot be listed again by its seller or anyone but its buyer', () => {
    const soldOnV1 = m({ version: 1, state: 'completed', seller: OTHER, buyer: '0x00000000000000000000000000000000000000c3' })
    expect(fingerprintVerdict([soldOnV1], OTHER)).toBe('card_sold')
    expect(fingerprintVerdict([soldOnV1], ME)).toBe('card_sold')
  })

  it('its buyer may sell it on once that purchase is paid out, not before', () => {
    expect(fingerprintVerdict([m({ state: 'completed', buyer: ME })], ME)).toBeNull()
    expect(fingerprintVerdict([m({ state: 'executing', buyer: ME })], ME)).toBe('card_not_paid_out')
    // Addresses compare without case.
    expect(fingerprintVerdict([m({ state: 'completed', buyer: ME.toUpperCase().replace('0X', '0x') as Hex })], ME)).toBeNull()
  })

  it('a listing still for sale blocks every new one, the seller\'s own too, until the chain shows it closed', () => {
    expect(fingerprintVerdict([m({ seller: ME, chain: 'active' })], ME)).toBe('card_listed')
    expect(fingerprintVerdict([m({ version: 2, chain: null })], ME)).toBe('card_listed')
    expect(fingerprintVerdict([m({ chain: 'closed' })], ME)).toBeNull()
  })

  it('a listing cancelled, expired or refunded in full blocks nothing: the card went back to its seller', () => {
    for (const state of ['cancelled', 'refunded', 'execution_failed'] as const) {
      expect(fingerprintVerdict([m({ state, buyer: OTHER })], ME)).toBeNull()
    }
  })

  it('every match must allow it, and the plainest refusal is the one given', () => {
    const chain = [m({ version: 1, state: 'completed', buyer: ME, listedAt: 1 }), m({ version: 2, state: 'completed', seller: ME, buyer: OTHER, listedAt: 2 })]
    // Sold on V1 to me, then I sold it on V2 to someone else: I may not list it again.
    expect(fingerprintVerdict(chain, ME)).toBe('card_sold')
    expect(fingerprintVerdict([m({ state: 'executing', buyer: ME }), m({ chain: 'active' }), m({ state: 'completed', buyer: OTHER })], ME)).toBe('card_listed')
    expect(fingerprintVerdict([], ME)).toBeNull()
  })

  it('the newest sale decides: a card that passed through two sales may be sold on by its current owner, and by nobody else', () => {
    // The seller sold it to OTHER, who sold it back to ME: two sales, in that order.
    const first = m({ version: 2, state: 'completed', seller: THIRD, buyer: OTHER, listedAt: 1 })
    const second = m({ version: 2, state: 'completed', seller: OTHER, buyer: ME, listedAt: 2 })
    expect(fingerprintVerdict([second, first], ME)).toBeNull()
    expect(fingerprintVerdict([first, second], ME)).toBeNull()
    expect(fingerprintVerdict([first, second], OTHER)).toBe('card_sold')
    expect(fingerprintVerdict([first, second], THIRD)).toBe('card_sold')
    // Sold on V1 to OTHER, then on V2 by OTHER to ME: the same.
    expect(fingerprintVerdict([m({ version: 1, state: 'completed', seller: THIRD, buyer: OTHER, listedAt: 1 }), { ...second, version: 2 }], ME)).toBeNull()
    // A sale back that is not paid out yet still waits.
    expect(fingerprintVerdict([first, { ...second, state: 'executing' }], ME)).toBe('card_not_paid_out')
    // A later listing that was cancelled sold nothing: the older sale still decides.
    expect(fingerprintVerdict([first, m({ state: 'cancelled', seller: OTHER, listedAt: 3 })], OTHER)).toBeNull()
    expect(fingerprintVerdict([first, m({ state: 'cancelled', seller: OTHER, listedAt: 3 })], ME)).toBe('card_sold')
  })

  it('a listing the chain shows sold, before the keeper records it, refuses its seller, and anyone else waits', () => {
    for (const version of [1, 2] as const) {
      const sold = m({ version, state: 'offered', chain: 'sold', seller: OTHER, listedAt: 5 })
      expect(fingerprintVerdict([sold], OTHER)).toBe('card_sold')
      expect(fingerprintVerdict([sold], ME)).toBe('card_not_paid_out')
      // It is the newest sale: an older one to someone else does not decide for its buyer.
      expect(fingerprintVerdict([m({ state: 'completed', seller: THIRD, buyer: OTHER, listedAt: 1 }), sold], ME)).toBe('card_not_paid_out')
    }
    // Only cancelled, expired or found spent sets the card free.
    expect(fingerprintVerdict([m({ state: 'offered', chain: 'closed', seller: OTHER })], OTHER)).toBeNull()
  })
})
