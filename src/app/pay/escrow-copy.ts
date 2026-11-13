/**
 * Salvo Pay: what the escrow branch of /sell, and the first escrow's cards
 * on /account, say about money, a card and a sale, in one place.
 *
 * WHY THESE LIVE OUTSIDE THE COMPONENTS, as hold-copy.ts does for the other
 * rail. Each sentence here was once written inline against the wrong
 * question: "Nothing was made" after a passkey was made, "pays you a day
 * after the sale" on a sale already paid, a re-quote under a payment that had
 * gone through, and no word under the Load button that a blind card cannot be
 * checked or refunded. Each now answers from the state it describes, and
 * tests/escrow-copy.test.ts holds each one to it.
 *
 * Isomorphic and pure: no React, no storage, no network.
 */

import type { CardRecord, ListingRecord, PurchaseRecord } from '@/lib/escrow/client/card-store'
import type { ListingView } from '@/lib/escrow/client/sell'
import type { ListingRecordV2 } from '@/lib/escrow/client/records-v2'
import type { ListingViewV2Seller } from '@/lib/escrow/client/sell-v2'
import { MODE_BLIND, MODE_READABLE } from '@/lib/escrow/merchants'
import { UNITS_PER_CENT } from '@/lib/escrow/manifest'
import { money } from '../ui'

/** pathUSD base units as dollars, rounded down to the cent: what is there, never more. */
const unitsMoney = (units: bigint): string => money(Number(units / BigInt(UNITS_PER_CENT)))

const when = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/**
 * Setup stopped. The passkey is made, and kept, at the first Face ID, before
 * the second: so after a stop at the second, the page must not say nothing
 * was made. `passkeyKept` is read from the phone's store after the stop.
 */
export function setupStoppedSentence(input: { cancelled: boolean; passkeyKept: boolean }): string {
  const head = input.cancelled ? 'Setup was cancelled.' : 'Setup did not finish.'
  const tail = input.cancelled ? '' : ' Try again.'
  if (input.passkeyKept) return `${head} Your passkey is saved, so finishing takes one more Face ID. Nothing was sent or charged.${tail}`
  return `${head} Nothing was made, sent or charged.${tail}`
}

/** How many Face IDs setup asks for: two the first time, one once the passkey exists. */
export function setupFaceIdLine(passkeyKept: boolean): string {
  return passkeyKept ? 'Setting up asks for Face ID once, and sends nothing.' : 'Setting up asks for Face ID twice, and sends nothing.'
}

/**
 * What /account may say about a first-escrow card's code that does not scan (it
 * was /cards). "The card still holds
 * its value" is true only of a checked card, whose balance Lit read with the
 * store just before the sale (spec section 8.7). Nobody read an unchecked
 * one's, and its seller still knows the number, so for those the page says
 * that, and the one clock that matters: only the seller can refund it, and
 * only until they are paid, a day after the Load. No page offers a way to ask
 * yet, and the line says so rather than send the shopper looking. A card kept
 * before the mode was recorded is read as unchecked.
 *
 * Nothing at all with no cards: every line is about a card the shopper holds.
 */
export function cardsHelp(cards: ReadonlyArray<Pick<CardRecord, 'mode'>>): string[] {
  if (cards.length === 0) return []
  const lines = ['What is left on a card stays on it, yours to spend next time.']
  if (cards.every((c) => c.mode === MODE_READABLE)) {
    lines.push('Its balance was read with the store just before you paid. If a code does not scan, the card still holds its value.')
  } else {
    lines.push(
      "Nobody could check a card's balance before you bought it, and its seller has the number too. If a code does not scan, only its seller can refund it, and only until they are paid, a day after you loaded. Refunds are not on these pages yet.",
    )
  }
  return lines
}

/**
 * Said on /account when Finish it cannot reach Salvo. The message sits above the
 * card list, so the cards are below it; with none on the phone, there is
 * nothing to point to.
 */
export function cardsOfflineLine(hasCards: boolean): string {
  const head = 'Salvo is not answering right now, so this cannot finish yet.'
  return hasCards ? `${head} Your cards below still show.` : head
}

/**
 * What a first-escrow purchase still finishing says, on /account, from its own
 * state. One that is 'paid' is known to be paid: the chain showed it, and only
 * the card has not come back. Only a 'signed' one may not have gone through.
 */
export function pendingLine(p: Pick<PurchaseRecord, 'state' | 'problem' | 'legs'>): string {
  if (p.problem !== null) return p.problem
  if (p.state === 'paid') {
    const which = p.legs.length > 1 ? 'Your cards have' : 'Your card has'
    return `Your payment went through. ${which} not reached this phone yet. Tap Finish it. Nothing will be paid twice.`
  }
  return 'Your payment may have gone through. Nothing will be paid twice. Tap Finish it to check.'
}

/** The heading of a first-escrow purchase still finishing, on /account: a paid one went through. */
export function pendingHeadline(p: Pick<PurchaseRecord, 'state'>): string {
  return p.state === 'paid' ? 'your payment went through.' : 'your payment went through, or may have.'
}

/** Said next to the seller's Copy button: who may list on the test chain, and what the address is for. */
export const TEST_LIST_LINE =
  "On the test chain a seller must be on Salvo's test list. Send this address to whoever invited you to test, and they can add you."

/**
 * Said under "not open yet" on the escrow branch of /sell. The seller account
 * needs no card, so it can be set up now, and its address is what the test
 * list needs. Nothing on the page checks again by itself, so it says reload.
 */
export const LISTING_CLOSED_NEXT =
  'You can set up your seller account now and send its address to be added. Reload this page once listing opens.'

/** What the seller's access key can do, said at setup. With no fee sponsor, its two calls pay their fee from the account. */
export const SELLER_KEY_LINE =
  'List a card and take it back. It cannot pay or refund anyone. Without a fee sponsor, those two pay a small network fee from your test dollars.'

/**
 * Said once a card is listed, next to the download. The file is a sealed copy
 * of the listing; nothing reads it yet. Selling from it without Salvo is a
 * later phase (spec section 8.13), so the line does not promise it.
 */
export const LISTING_FILE_LINE = 'Keep your listing file: it is a sealed copy of this listing. A later version can sell from it without Salvo.'

/** Said at the top of the escrow branch of /sell, before the store and the number. */
export const ESCROW_SELL_WARNING = 'Test network. Test dollars only.'
/** Behind the warning's bubble: why a real card does not belong here yet. */
export const ESCROW_SELL_WARNING_MORE =
  'Buyers pay with free test dollars, so anyone could buy a card listed here for nothing. List only your own card, right before you test it. You are paid in test dollars.'

export interface SaleLine {
  pill: string
  line: string
  /** A sale that is due: the seller can collect it now with Get paid. */
  canCollect: boolean
  /** On chain, unsold, not ended, and not recorded by Salvo: Send to Salvo again can help. */
  canResend: boolean
  /** Not on the chain: the seller may remove it from this device. */
  canRemove: boolean
}

/**
 * One of a seller's listings, in words, from the chain: the listing's state,
 * and for a sold card its sale's (getDeposit), never the listing's alone. A
 * listing stays "sold" forever, so only the sale says held, disputed, paid
 * or refunded. `chainTime` is the chain's clock at the read; `owedUnits` is
 * what the escrow holds for this seller because the token would not send it
 * (owed), which no sale's state shows.
 *
 * DUE IS DUE, DISPUTED OR NOT. The contract's release() asks only that the
 * sale is held and its time has come, and a dispute has already moved that
 * time 48 hours on. So a disputed sale past its time is collectable like any
 * other, and the row never says the escrow holds money until a time gone by.
 *
 * AN UNSOLD LISTING ENDS. It stays Active on chain after its expiry, but the
 * contract refuses every purchase from then, so the row says it ended.
 */
export function saleLine(
  view: ListingView | undefined,
  r: Pick<ListingRecord, 'posted' | 'listingExpiry'>,
  chainTime: number,
  owedUnits: bigint = 0n,
): SaleLine {
  const no = (pill: string, line: string): SaleLine => ({ pill, line, canCollect: false, canResend: false, canRemove: false })
  if (view === undefined) return no('', 'We cannot read the chain right now.')
  if (view.state === 'listed') {
    // Ended first: Salvo cannot record an ended listing, so it is never offered again.
    if (chainTime >= r.listingExpiry) return no('Ended', 'Ended without a sale. No buyer can buy it now, and the card is yours to use.')
    if (!r.posted) {
      return { ...no('Listed, not recorded', 'Salvo has not recorded this yet, so no buyer can see it. Send it to Salvo again.'), canResend: true }
    }
    return no('Listed (hidden)', `Hidden until a buyer's quote picks it. Ends ${new Date(r.listingExpiry * 1000).toLocaleDateString()}.`)
  }
  if (view.state === 'cancelled') return no('Taken back', 'Taken back. The card is yours to use.')
  if (view.state === 'not_on_chain') {
    return { ...no('Not on chain', 'This listing is not on the chain. Nothing is for sale, and you can remove it from this device.'), canRemove: true }
  }
  const sale = view.sale
  if (sale === null) return no('Sold', 'Sold. Please do not use this card now. We cannot find the sale on the chain yet.')
  const amount = unitsMoney(sale.amountUnits)
  if (sale.state === 'paid') {
    // Released means the escrow paid it out, to the account or, when the
    // token refused, into what it owes. Which one, per sale, the chain does
    // not say; while anything is owed, the row does not claim it arrived.
    if (owedUnits > 0n) return no('Paid out', `Paid out ${amount}. The token held some of your payouts back; they wait in the escrow until you tap Claim.`)
    return no('Paid', `Paid ${amount} to your account.`)
  }
  if (sale.state === 'refunded') return no('Refunded', 'Refunded. The card is yours again.')
  if (chainTime >= sale.releaseAt) {
    if (sale.disputed) {
      return { ...no('Disputed', `The buyer said it did not scan, and the hold is over. Your ${amount} is ready. Tap Get paid to collect it.`), canCollect: true }
    }
    return { ...no('Sold', `Sold. Your ${amount} is ready. Tap Get paid to collect it.`), canCollect: true }
  }
  if (sale.disputed) {
    return no('Disputed', `The buyer says it did not scan, so the escrow holds your ${amount} until ${when(sale.releaseAt)}. Please do not use this card now.`)
  }
  return no('Sold', `Sold. Your ${amount} is yours to collect from ${when(sale.releaseAt)}. Please do not use this card now.`)
}

/**
 * The money beside a seller's row, after "$20.00 card": from the sale, not
 * the listing. A listing stays sold forever, so a refunded sale says it went
 * back to the buyer, and a part refund shows what the sale still holds. Null
 * where nothing is for sale: taken back, ended, or not on chain.
 */
export function sellerMoneyLine(view: ListingView | undefined, r: Pick<ListingRecord, 'priceUnits' | 'listingExpiry'>, chainTime: number): string | null {
  const price = BigInt(r.priceUnits)
  if (view === undefined) return `${unitsMoney(price)} if it sells`
  if (view.state === 'listed') return chainTime >= r.listingExpiry ? null : `${unitsMoney(price)} if it sells`
  if (view.state !== 'sold') return null
  const sale = view.sale
  if (sale === null) return `${unitsMoney(price)} from the sale`
  if (sale.state === 'refunded') return 'refunded to the buyer'
  if (sale.amountUnits < price) return `${unitsMoney(sale.amountUnits)} from the sale, after a part refund`
  return `${unitsMoney(sale.amountUnits)} from the sale`
}

/** Said above a seller's rows while the escrow holds payouts the token would not send. Null when it holds none. */
export function owedLine(owedUnits: bigint): string | null {
  if (owedUnits <= 0n) return null
  return `The escrow holds ${unitsMoney(owedUnits)} of your payouts that the token would not send to your account. Tap Claim to try again.`
}

// ---------------------------------------------------------------------------
// Selling on SalvoEscrowV2 (/sell once V2 is open)
// ---------------------------------------------------------------------------

/** What a seller may do with one V2 listing, beside its line. */
export interface SaleLineV2 extends SaleLine {
  /** Unsold, on chain, not ended: Take it back. */
  canTakeBack: boolean
  /** Part sold, the rest for sale: "I used it myself" closes it, and any deposit on it goes back to its shopper. */
  canMarkUsed: boolean
  /** Five to seven days after a shopper's deposit started covering the rest: Still there, or It's gone. */
  canReview: boolean
}

/**
 * One of a seller's V2 listings, in words, from the chain (sell-v2.ts
 * listingStatesV2): the listing, and its latest sale. A V2 card sells in
 * parts, so a listing with cents left stays for sale after a sale, and the
 * sale line says that sale only. `chainTime` is the chain's clock at the
 * read. Every word is about what the chain shows: a payout is "ready" only
 * once release() would take it (its time and its contest window both past).
 */
export function saleLineV2(
  view: ListingViewV2Seller | undefined,
  r: Pick<ListingRecordV2, 'posted' | 'listingExpiry' | 'valueCents'>,
  chainTime: number,
): SaleLineV2 {
  const none = { canCollect: false, canResend: false, canRemove: false, canTakeBack: false, canMarkUsed: false, canReview: false }
  const no = (pill: string, line: string): SaleLineV2 => ({ pill, line, ...none })
  if (view === undefined) return no('', 'We cannot read the chain right now.')
  if (view.state === 'not_on_chain') {
    return { ...no('Not on chain', 'This listing is not on the chain. Nothing is for sale, and you can remove it from this device.'), canRemove: true }
  }
  const sale = view.lastSale
  const saleWords = (): { line: string; canCollect: boolean } => {
    if (sale === null) return { line: '', canCollect: false }
    const amount = unitsMoney(sale.amountUnits)
    if (sale.state === 'paid') return { line: ` Paid ${amount} for the last sale.`, canCollect: false }
    if (sale.state === 'refunded') return { line: ' The last sale was refunded to its shopper.', canCollect: false }
    if (sale.state === 'contested') return { line: ' The last shopper found the rest empty, so their payment went back to them, and the deposit on it paid you.', canCollect: false }
    const due = Math.max(sale.releaseAt, sale.contestUntil)
    if (chainTime >= due) return { line: ` Your ${amount} from the last sale is ready. Tap Get paid, or Salvo pays it soon.`, canCollect: true }
    if (sale.disputed) return { line: ` The last shopper says it did not scan, so the escrow holds your ${amount} until ${when(due)}.`, canCollect: false }
    return { line: ` Your ${amount} from the last sale is paid to you from ${when(due)}.`, canCollect: false }
  }
  const s = saleWords()
  const withSale = (x: SaleLineV2): SaleLineV2 => ({ ...x, line: `${x.line}${s.line}`, canCollect: s.canCollect })
  if (view.state === 'listed') {
    if (view.sales === 0) {
      if (chainTime >= r.listingExpiry) return no('Ended', 'Ended without a sale. No shopper can buy it now, and the card is yours to use.')
      if (!r.posted) return { ...no('Listed, not recorded', 'Salvo has not recorded this yet, so no shopper can see it. Send it to Salvo again.'), canResend: true }
      return { ...no('Listed', `For sale until ${new Date(r.listingExpiry * 1000).toLocaleDateString()}. Take it back any time before it sells.`), canTakeBack: true }
    }
    const left = money(view.remainingCents)
    const review = view.review !== null && chainTime >= view.review.from && chainTime < view.review.until
    const line = view.covered
      ? `${left} left on it, for the next shopper. The shopper who used the rest put down a deposit for it. Please do not use this card.`
      : `${left} left on it, for sale. Please do not use this card. If you used the rest yourself, tap I used it myself.`
    return withSale({ ...no('Part sold', line), canMarkUsed: true, canReview: review })
  }
  if (view.state === 'drained') return withSale(no('Sold', 'Sold, all of it. Please do not use this card.'))
  if (view.state === 'cancelled') return withSale(no('Taken back', view.sales === 0 ? 'Taken back. The card is yours to use.' : 'Closed. What was left on it is yours to use.'))
  return withSale(no('Spent', 'The rest was found spent, and the deposit on it paid you.'))
}
