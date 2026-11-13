/**
 * Salvo Pay: what the escrow branch of /sell, and the first escrow's cards on
 * /account, say about the money, the card and the sale
 * (src/app/pay/escrow-copy.ts).
 *
 * Every sentence here is read where a person decides something: whether to
 * pay, whether they were charged, whether to set up again, whether to use a
 * card that sold. Each must be true of the state it describes. Pure
 * functions, no database.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  cardsHelp,
  cardsOfflineLine,
  LISTING_CLOSED_NEXT,
  LISTING_FILE_LINE,
  owedLine,
  pendingHeadline,
  pendingLine,
  saleLine,
  saleLineV2,
  SELLER_KEY_LINE,
  sellerMoneyLine,
  setupFaceIdLine,
  setupStoppedSentence,
} from '@/app/pay/escrow-copy'
import type { ListingView } from '@/lib/escrow/client/sell'
import type { ListingViewV2Seller, SaleViewV2 } from '@/lib/escrow/client/sell-v2'
import { MODE_BLIND, MODE_READABLE } from '@/lib/escrow/merchants'

describe('setup', () => {
  it('never says nothing was made once the passkey was made at the first Face ID', () => {
    const afterFirst = setupStoppedSentence({ cancelled: true, passkeyKept: true })
    expect(afterFirst).not.toMatch(/Nothing was made/)
    expect(afterFirst).toBe('Setup was cancelled. Your passkey is saved, so finishing takes one more Face ID. Nothing was sent or charged.')
    expect(setupStoppedSentence({ cancelled: true, passkeyKept: false })).toBe('Setup was cancelled. Nothing was made, sent or charged.')
    expect(setupStoppedSentence({ cancelled: false, passkeyKept: true })).toMatch(/^Setup did not finish\. Your passkey is saved.*Try again\.$/)
    expect(setupStoppedSentence({ cancelled: false, passkeyKept: false })).toBe('Setup did not finish. Nothing was made, sent or charged. Try again.')
  })

  it('says one Face ID once the passkey exists, two before', () => {
    expect(setupFaceIdLine(false)).toMatch(/twice/)
    expect(setupFaceIdLine(true)).toMatch(/once/)
  })
})

describe("a seller's row", () => {
  const listed = { posted: true, listingExpiry: 2_000_000_000 }
  const sold = (sale: ListingView['sale']): ListingView => ({ state: 'sold', sale })
  const held = { depositId: '7', state: 'held' as const, releaseAt: 1_800_000_000, disputed: false, amountUnits: 17_600_000n }

  it('follows the sale, not the listing: held until a time, ready to collect, disputed, paid, refunded', () => {
    const before = saleLine(sold(held), listed, 1_799_999_000)
    expect(before.line).toMatch(/^Sold\. Your \$17\.60 is yours to collect from .+\. Please do not use this card now\.$/)
    expect(before.canCollect).toBe(false)
    const due = saleLine(sold(held), listed, 1_800_000_000)
    expect(due).toEqual({ pill: 'Sold', line: 'Sold. Your $17.60 is ready. Tap Get paid to collect it.', canCollect: true, canResend: false, canRemove: false })
    // Disputed, before its (already held-over) time: held, with the time.
    const disputed = saleLine(sold({ ...held, disputed: true }), listed, 1_799_999_000)
    expect(disputed.pill).toBe('Disputed')
    expect(disputed.canCollect).toBe(false)
    expect(disputed.line).toMatch(/holds your \$17\.60 until/)
    expect(saleLine(sold({ ...held, state: 'paid' }), listed, 0)).toMatchObject({ pill: 'Paid', line: 'Paid $17.60 to your account.', canCollect: false })
    expect(saleLine(sold({ ...held, state: 'refunded' }), listed, 0).line).toBe('Refunded. The card is yours again.')
    // No sale found yet: no promise of a payout at all.
    expect(saleLine(sold(null), listed, 0).line).not.toMatch(/pays you|collect/)
  })

  it('a disputed sale past its time is collectable like any other: release() asks only that the time has come', () => {
    // releaseAt already carries the dispute's 48 hours (the contract adds them).
    const past = saleLine(sold({ ...held, disputed: true }), listed, 1_900_000_000)
    expect(past.canCollect).toBe(true)
    expect(past.line).toBe('The buyer said it did not scan, and the hold is over. Your $17.60 is ready. Tap Get paid to collect it.')
    expect(past.line).not.toMatch(/holds your .* until/)
    expect(saleLine(sold({ ...held, disputed: true }), listed, 1_800_000_000).canCollect).toBe(true)
  })

  it('an unsold listing past its end says it ended, never "ends" on a day gone by', () => {
    const ended = saleLine({ state: 'listed', sale: null }, listed, 2_000_000_000)
    expect(ended).toMatchObject({ pill: 'Ended', line: 'Ended without a sale. No buyer can buy it now, and the card is yours to use.', canCollect: false })
    expect(saleLine({ state: 'listed', sale: null }, listed, 1_999_999_999).line).toMatch(/^Hidden until a buyer's quote picks it\. Ends /)
    expect(sellerMoneyLine({ state: 'listed', sale: null }, { priceUnits: 17_600_000, listingExpiry: 2_000_000_000 }, 2_000_000_000)).toBeNull()
  })

  it("the money beside a row is the sale's: refunded to the buyer, what a part refund left, or what it paid", () => {
    const r = { priceUnits: 17_600_000, listingExpiry: 2_000_000_000 }
    expect(sellerMoneyLine({ state: 'listed', sale: null }, r, 0)).toBe('$17.60 if it sells')
    expect(sellerMoneyLine(sold(held), r, 0)).toBe('$17.60 from the sale')
    expect(sellerMoneyLine(sold({ ...held, state: 'refunded', amountUnits: 0n }), r, 0)).toBe('refunded to the buyer')
    expect(sellerMoneyLine(sold({ ...held, amountUnits: 7_600_000n }), r, 0)).toBe('$7.60 from the sale, after a part refund')
    expect(sellerMoneyLine(sold({ ...held, state: 'paid' }), r, 0)).toBe('$17.60 from the sale')
    expect(sellerMoneyLine({ state: 'cancelled', sale: null }, r, 0)).toBeNull()
  })

  it('a payout the token would not send is never said to have reached the account, and Claim is offered', () => {
    const paid = sold({ ...held, state: 'paid' })
    expect(saleLine(paid, listed, 0, 0n).line).toBe('Paid $17.60 to your account.')
    const heldBack = saleLine(paid, listed, 0, 17_600_000n)
    expect(heldBack.line).not.toMatch(/to your account/)
    expect(heldBack.line).toMatch(/tap Claim/)
    expect(owedLine(0n)).toBeNull()
    expect(owedLine(17_600_000n)).toBe('The escrow holds $17.60 of your payouts that the token would not send to your account. Tap Claim to try again.')
  })

  it('offers Send to Salvo again only where it can help, and Remove only for a listing the chain does not have', () => {
    const notPosted = { posted: false, listingExpiry: 2_000_000_000 }
    expect(saleLine({ state: 'listed', sale: null }, notPosted, 0)).toMatchObject({ canResend: true, canRemove: false })
    // Ended: our server cannot record it, so it is not offered, whatever "try again" would say.
    expect(saleLine({ state: 'listed', sale: null }, notPosted, 2_000_000_000)).toMatchObject({ pill: 'Ended', canResend: false })
    expect(saleLine({ state: 'listed', sale: null }, listed, 0).canResend).toBe(false)
    expect(saleLine({ state: 'not_on_chain', sale: null }, notPosted, 0)).toMatchObject({ pill: 'Not on chain', canRemove: true, canResend: false })
    expect(saleLine({ state: 'not_on_chain', sale: null }, notPosted, 0).line).toMatch(/you can remove it from this device/)
    for (const v of [sold(held), { state: 'cancelled' as const, sale: null }]) expect(saleLine(v, notPosted, 0)).toMatchObject({ canResend: false, canRemove: false })
  })

  it('a listing Salvo never recorded says no buyer can see it, not that a quote will pick it', () => {
    const notPosted = saleLine({ state: 'listed', sale: null }, { posted: false, listingExpiry: 2_000_000_000 }, 0)
    expect(notPosted.line).toMatch(/^Salvo has not recorded this yet, so no buyer can see it\./)
    expect(notPosted.line).not.toMatch(/quote picks it/)
    expect(saleLine({ state: 'listed', sale: null }, listed, 0).line).toMatch(/^Hidden until a buyer's quote picks it\./)
    expect(saleLine(undefined, listed, 0).line).toBe('We cannot read the chain right now.')
  })
})

describe("a seller's row on the new escrow", () => {
  const listed = { posted: true, listingExpiry: 2_000_000_000, valueCents: 2_000 }
  const view = (v: Partial<ListingViewV2Seller>): ListingViewV2Seller => ({
    state: 'listed',
    remainingCents: 2_000,
    sales: 0,
    covered: false,
    review: null,
    lastSale: null,
    ...v,
  })
  const held: SaleViewV2 = { depositId: '9', state: 'held', releaseAt: 1_800_000_000, disputed: false, amountUnits: 14_400_000n, usedCents: 1_600, contestUntil: 0 }

  it('unsold: for sale until its end, Take it back; ended and unrecorded say so, and nothing else is offered', () => {
    const forSale = saleLineV2(view({}), listed, 1_000)
    expect(forSale).toMatchObject({ pill: 'Listed', canTakeBack: true, canMarkUsed: false, canCollect: false, canReview: false })
    expect(forSale.line).toMatch(/^For sale until .+\. Take it back any time before it sells\.$/)
    expect(saleLineV2(view({}), listed, 2_000_000_000)).toMatchObject({ pill: 'Ended', canTakeBack: false })
    expect(saleLineV2(view({}), { ...listed, posted: false }, 0)).toMatchObject({ canResend: true, canTakeBack: false })
    expect(saleLineV2(view({ state: 'not_on_chain' }), listed, 0)).toMatchObject({ pill: 'Not on chain', canRemove: true })
    expect(saleLineV2(undefined, listed, 0).line).toBe('We cannot read the chain right now.')
  })

  it('part sold: what is left, I used it myself, and the last sale paid only once its time and its contest window are both past', () => {
    const part = view({ sales: 1, remainingCents: 400, covered: true, lastSale: held })
    const before = saleLineV2(part, listed, 1_799_999_000)
    expect(before).toMatchObject({ pill: 'Part sold', canMarkUsed: true, canTakeBack: false, canCollect: false })
    expect(before.line).toMatch(/^\$4\.00 left on it, for the next shopper\. The shopper who used the rest put down a deposit for it\./)
    expect(before.line).toMatch(/Your \$14\.40 from the last sale is paid to you from /)
    expect(saleLineV2(part, listed, 1_800_000_000)).toMatchObject({ canCollect: true })
    // A sale that used another shopper's leftover waits for its two-hour window too.
    const contested = view({ sales: 1, remainingCents: 400, lastSale: { ...held, contestUntil: 1_800_007_200 } })
    expect(saleLineV2(contested, listed, 1_800_000_000).canCollect).toBe(false)
    expect(saleLineV2(contested, listed, 1_800_007_200).canCollect).toBe(true)
    // Disputed: held, with the time it is held to.
    expect(saleLineV2(view({ sales: 1, lastSale: { ...held, disputed: true } }), listed, 1_000).line).toMatch(/says it did not scan, so the escrow holds your \$14\.40 until/)
  })

  it('the seller is asked about an unsold leftover only inside the five to seven days, and the ends say what the chain did', () => {
    const covered = view({ sales: 1, remainingCents: 300, covered: true, review: { from: 1_000, until: 2_000 } })
    expect(saleLineV2(covered, listed, 999).canReview).toBe(false)
    expect(saleLineV2(covered, listed, 1_000).canReview).toBe(true)
    expect(saleLineV2(covered, listed, 2_000).canReview).toBe(false)
    expect(saleLineV2(view({ state: 'drained', sales: 2, lastSale: { ...held, state: 'paid' } }), listed, 0)).toMatchObject({ pill: 'Sold', line: 'Sold, all of it. Please do not use this card. Paid $14.40 for the last sale.' })
    expect(saleLineV2(view({ state: 'cancelled', sales: 1 }), listed, 0).line).toBe('Closed. What was left on it is yours to use.')
    expect(saleLineV2(view({ state: 'cancelled' }), listed, 0).line).toBe('Taken back. The card is yours to use.')
    expect(saleLineV2(view({ state: 'spent', sales: 1 }), listed, 0).line).toBe('The rest was found spent, and the deposit on it paid you.')
    for (const v of [covered, view({}), view({ state: 'spent' })]) expect(saleLineV2(v, listed, 1_500).line).not.toMatch(/—|Stripe/)
  })
})

describe("the first escrow's cards, on /account (they were /cards)", () => {
  it('promises a card still holds its value only when its balance was read before the sale; an unchecked one says what is true', () => {
    const blind = cardsHelp([{ mode: MODE_BLIND }]).join(' ')
    expect(blind).not.toMatch(/still holds its value/)
    expect(blind).toMatch(/Nobody could check a card's balance before you bought it, and its seller has the number too\./)
    // Not "ask for a refund": no page offers a way to ask. Who can refund, until when, and that it is not here yet.
    expect(blind).toMatch(/only its seller can refund it, and only until they are paid, a day after you loaded\. Refunds are not on these pages yet\./)
    expect(blind).not.toMatch(/ask for a refund/i)
    // A card kept before the mode was recorded is read as unchecked; so is a mix.
    expect(cardsHelp([{}]).join(' ')).not.toMatch(/still holds its value/)
    expect(cardsHelp([{ mode: MODE_READABLE }, { mode: MODE_BLIND }]).join(' ')).not.toMatch(/still holds its value/)
    expect(cardsHelp([{ mode: MODE_READABLE }]).join(' ')).toMatch(/If a code does not scan, the card still holds its value\./)
    for (const lines of [cardsHelp([]), cardsHelp([{ mode: MODE_READABLE }])]) expect(lines.join(' ')).not.toMatch(/—|Stripe/)
  })

  it('says nothing about a bought card on a phone with none, and points to the cards where they are', () => {
    expect(cardsHelp([])).toEqual([])
    // The message sits above the list.
    expect(cardsOfflineLine(true)).toBe('Salvo is not answering right now, so this cannot finish yet. Your cards below still show.')
    expect(cardsOfflineLine(false)).toBe('Salvo is not answering right now, so this cannot finish yet.')
    for (const line of [cardsOfflineLine(true), cardsOfflineLine(false)]) expect(line).not.toMatch(/above/)
  })
})

describe('a purchase still finishing', () => {
  const legs = [{}] as never[]
  it('a paid one says it went through; only one that may not have landed says "may have"', () => {
    expect(pendingLine({ state: 'paid', problem: null, legs })).toBe(
      'Your payment went through. Your card has not reached this phone yet. Tap Finish it. Nothing will be paid twice.',
    )
    expect(pendingLine({ state: 'paid', problem: null, legs: [{}, {}] as never[] })).toMatch(/^Your payment went through\. Your cards have not/)
    expect(pendingLine({ state: 'signed', problem: null, legs })).toMatch(/^Your payment may have gone through\./)
    expect(pendingLine({ state: 'paid', problem: null, legs })).not.toMatch(/may have/)
    // A sentence the Load kept is said as it is.
    expect(pendingLine({ state: 'signed', problem: 'Tap Finish it in a moment.', legs })).toBe('Tap Finish it in a moment.')
    expect(pendingHeadline({ state: 'paid' })).toBe('your payment went through.')
    expect(pendingHeadline({ state: 'signed' })).toBe('your payment went through, or may have.')
  })
})

describe('the seller', () => {
  it('while listing is closed says the account can be set up now and to reload once it opens, never that the page opens by itself', () => {
    expect(LISTING_CLOSED_NEXT).toMatch(/set up your seller account now/)
    expect(LISTING_CLOSED_NEXT).toMatch(/Reload this page once listing opens\./)
    expect(LISTING_CLOSED_NEXT).not.toMatch(/opens the form/)
  })

  it('never promises the listing file sells a card without Salvo: nothing reads it yet', () => {
    expect(LISTING_FILE_LINE).not.toMatch(/can be sold without Salvo/)
    expect(LISTING_FILE_LINE).toMatch(/sealed copy of this listing\. A later version can sell from it without Salvo\./)
  })

  it("says what the seller key does, and that without a sponsor its two calls pay a fee, with no refund on offer", () => {
    expect(SELLER_KEY_LINE).not.toMatch(/refund to a buyer always asks/)
    expect(SELLER_KEY_LINE).not.toMatch(/never move your money/)
    expect(SELLER_KEY_LINE).toMatch(/small network fee from your test dollars/)
  })
})

describe('the screens say what these say', () => {
  /*
    Read as source: this suite's transform does not take JSX. Each screen
    must use the function above, not its own inline sentence, or a test here
    could pass while the page says the old words.
  */
  const src = (f: string): string => readFileSync(resolve(process.cwd(), f), 'utf8')

  it("/account: the first escrow's cards, their help and a purchase still finishing say the copy's words", () => {
    const account = src('src/app/account/account-client.tsx')
    expect(account).toContain('cardsHelp(keepable)')
    expect(account).not.toMatch(/still holds its value|nowhere else in clear/)
    // The offline sentence points below, and only when there are cards; a pending purchase says its own state.
    expect(account).toContain('cardsOfflineLine(bought.length > 0)')
    expect(account).toContain('{pendingLine(p)}')
    expect(account).toContain('{pendingHeadline(p)}')
    // Finished with the first escrow's own resume, which never pays twice.
    // Signed with this account's key as the page holds it now (account-client.tsx keyOfAccount), one allowed a moment ago included.
    expect(account).toContain('await resumePurchase({ store, api: ready.api, config: ready.config, access: ready.access, wallet }, id)')
  })

  it("/sell on the new escrow: each row is the copy's, and the first escrow's listings stay below, settling as before", () => {
    const v2 = src('src/app/sell/escrow-sell-v2.tsx')
    expect(v2).toContain('const said = saleLineV2(view, r, chainTime)')
    expect(v2).toContain('owedLine(owed)')
    expect(v2).toContain('listCardV2(deps,')
    expect(v2).not.toMatch(/listCard\(deps,/)
    const sell = src('src/app/sell/escrow-sell.tsx')
    expect(sell).toContain('{keyed ? <SellFormV2 session={v2} wallet={wallet} /> : <SellerSetUp session={session} v2={v2} onDone={onWallet} />}')
    expect(sell).toContain('{wallet !== null && <SellForm session={session} wallet={wallet} firstEscrowOnly />}')
    expect(sell).toContain("setUpDeviceWalletV2(session.store, 'seller', { escrow: v2.config.escrow, v1Escrow: v2.config.v1Escrow })")
  })

  it("/sell: each row's money line and the Claim notice are the copy's", () => {
    const sell = src('src/app/sell/escrow-sell.tsx')
    expect(sell).toContain('sellerMoneyLine(view, r, chainTime)')
    expect(sell).toContain('saleLine(view, r, chainTime, owed)')
    expect(sell).toContain('owedLine(owed)')
    expect(sell).not.toContain("'from the sale' : 'if it sells'")
  })

  it('/sell: the seller account is offered while listing is closed, and the rows offer only what can help', () => {
    const sell = src('src/app/sell/escrow-sell.tsx')
    // Setup takes no card, so it is not behind listingOpen: its address is what the test list needs.
    expect(sell).toContain('{session.wallet !== null ? <SellForm session={session} wallet={session.wallet} /> : <SellerSetUp session={session} onDone={setWallet} />}')
    expect(src('src/app/sell/escrow-sell-v2.tsx')).toContain('{TEST_LIST_LINE}')
    expect(sell).not.toMatch(/session\.config\.listingOpen \? \(\s*<SellerSetUp/)
    expect(sell).toContain('{LISTING_CLOSED_NEXT}')
    expect(sell).not.toContain('This page opens the form once listing opens')
    expect(sell).toContain('{LISTING_FILE_LINE}')
    expect(sell).not.toContain('can be sold without Salvo')
    expect(sell).toContain('{SELLER_KEY_LINE}')
    expect(sell).not.toContain('a refund to a') // the old setup line offered a refund no page has
    // Send to Salvo again only where it helps, Remove for a listing never on chain, and the route's own words.
    expect(sell).toContain('{said.canResend && (')
    expect(sell).not.toContain("state === 'listed' && !r.posted")
    expect(sell).toContain('{said.canRemove && (')
    expect(sell).toContain('const why = await recordListing(deps, r)')
  })
})
