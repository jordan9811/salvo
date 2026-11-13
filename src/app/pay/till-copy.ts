/**
 * Every sentence the till says, in one place (unified-account spec 4).
 *
 * The same words on both rails, so they are written against the till's own
 * types and never against a rail. Short sentences, plain words. Never the
 * card processor's name, never a camera, never a field to type a card number:
 * tests/till-copy.test.ts reads this file for the first.
 *
 * NEVER "TRY ANOTHER AMOUNT". The total is the register's, so no sentence
 * here asks the shopper to type a different one.
 *
 * Pure: no React, so a test can read every line.
 */

import type { CatchUpOutcome, KeptHold, Leg, PaymentMethod, Rail, RoutePlan, TillReceipt } from '@/lib/till/types'

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

const cardsWord = (n: number): string => (n === 1 ? '1 card' : `${n} cards`)

/** The one button: "Pay $47.90 for $52.13 · 2 cards". */
export function payLabel(plan: RoutePlan): string {
  return `Pay ${dollars(plan.costCents)} for ${dollars(plan.totalCents)} · ${cardsWord(plan.legs.length)}`
}

/** The button while the price for a typed total is on its way. */
export function pricingLabel(cents: number): string {
  return `Pricing ${dollars(cents)}…`
}

/** The button when no plan covers the total typed. The reason is said under it. */
export const NO_PRICE = 'No price for this total'

/**
 * Under it: what they save, and where the money comes from. A card is held
 * and taken only for what is used; dollars are paid at the tap, for only
 * what is used, from the balance the label names. The shopper's own store
 * credit is said as that: a plan paid wholly from it takes nothing from
 * their dollars, and never says it does.
 */
export function saveLine(plan: RoutePlan, method: PaymentMethod | null): string {
  const how = plan.rail === 'card' ? ' · held now, taken only for what you use' : ''
  const credit = plan.legs.reduce((n, l) => n + (l.source === 'own_credit' ? l.appliedCents : 0), 0)
  const fromCredit = credit > 0 ? ` · ${dollars(credit)} from your store credit` : ''
  const from = method?.ready && plan.costCents + plan.depositCents > 0 ? ` · from your ${method.label}${how}` : ''
  return `You save ${dollars(plan.savingCents)}${fromCredit}${from}`
}

/** A plan that takes nothing from the way the till pays: the shopper's own store credit covers all of it. */
export function costsNothing(plan: RoutePlan | null): boolean {
  return plan !== null && plan.legs.length > 0 && plan.legs.every((l) => l.source === 'own_credit') && plan.costCents === 0 && plan.depositCents === 0
}

/** The deposit, when the plan leaves part of its last card: "$3.87 deposit · back when the next shopper uses the rest". */
export function depositLine(plan: RoutePlan): string | null {
  return plan.depositCents > 0 ? `${dollars(plan.depositCents)} deposit · back when the next shopper uses the rest` : null
}

/**
 * "Pay $30.40 more · 1 card", after a card did not work or the total went
 * up. A plan paid wholly from the shopper's own store credit pays nothing,
 * so it says what it uses: never "Pay $0.00 more".
 */
export function payMoreLabel(plan: RoutePlan): string {
  if (costsNothing(plan)) return `Use ${dollars(plan.totalCents)} of your store credit · ${cardsWord(plan.legs.length)}`
  return `Pay ${dollars(plan.costCents)} more for ${dollars(plan.totalCents)} · ${cardsWord(plan.legs.length)}`
}

/** The price moved between the quote and the tap: nothing was held, and the button now says the new price. */
export const PRICE_CHANGED = 'The price changed. Nothing was charged. Tap again to pay the new price.'

export const PAYING = 'Paying…'

/** "Scan 1 of 2". */
export function scanTitle(scanIndex: number, scanOf: number): string {
  return `Scan ${scanIndex} of ${scanOf}`
}

/**
 * What this card does at the register. A leftover is said to stay for the
 * next shopper only when a deposit stands behind it: one too small for a
 * deposit is not sold again.
 */
export function coversLine(code: { coversCents: number; leftoverCents: number; depositCents: number }): string {
  return code.leftoverCents > 0 && code.depositCents > 0
    ? `covers ${dollars(code.coversCents)} · ${dollars(code.leftoverCents)} stays on it for the next shopper`
    : `covers ${dollars(code.coversCents)}`
}

/** A store nobody can check: no answer counts as the code having worked. */
export const SILENCE_LINE = 'If you do not tap anything, we count this card as used.'

export const NEXT = 'Scanned · next'
export const DONE = 'Done'
export const DIDNT_SCAN = 'It didn’t scan'
export const REGISTER_PAID = 'Register says paid'

/** The total went up while this card is on screen: scan it, then pay the rest (or, from store credit, use it). */
export function scannedPayMoreLabel(owed: RoutePlan): string {
  return costsNothing(owed) ? `Scanned · use ${dollars(owed.totalCents)} of your store credit` : `Scanned · pay ${dollars(owed.costCents)} more`
}

/** Under the code when the total went up: what comes after this card. */
export function thenLine(owed: RoutePlan): string {
  if (costsNothing(owed)) return `The total went up. Scan this card first, then your store credit pays the other ${dollars(owed.totalCents)}.`
  return `The total went up. Scan this card first, then pay ${dollars(owed.costCents)} more for the other ${dollars(owed.totalCents)}.`
}

/** The "It didn't scan" sheet. There is never an option to type the number. */
export const SHEET = {
  title: 'What happened?',
  tryAgain: 'Try again',
  tryAgainHint: 'The other kind of barcode.',
  declined: 'The register declined it',
  stillNot: 'It still didn’t scan',
  totalChanged: 'The total changed',
  newTotal: 'The new total',
  apply: 'Use this total',
  close: 'Back to the code',
} as const

/** The total came down past what can stay on the card on screen: the one way on, by card. */
export const USE_OTHER_CARDS = 'Use other cards'

/** The same on dollars: the card is paid for, so "not used" makes it the shopper's store credit, which then pays the rest. */
export const USE_AS_CREDIT = 'Use it as your store credit'

/**
 * The button under a card that must not be scanned, said as what it does.
 * By card, its hold goes and other cards pay the rest. In dollars it was
 * paid at the tap: it becomes the shopper's store credit, and that credit
 * pays the rest first. "Use other cards" there was followed by this same
 * card's code.
 */
export function tooLowLabel(rail: Rail): string {
  return rail === 'stablecoin' ? USE_AS_CREDIT : USE_OTHER_CARDS
}

/** Dollars, under "Do not scan this card": why, and what the button does. */
export const TOO_LOW_CREDIT =
  'The total came down past what this card may keep for the next shopper. As your store credit it is all yours, and it pays what is left.'

/** On the code a card not used opens again, now the shopper's store credit and paying the rest. */
export const CREDIT_PAYS_REST = 'This card is your store credit now, and it pays what is left. What it does not use stays yours.'

/** In place of "Scan 1 of 2" when the card on screen must not be scanned. Its barcode is not drawn. */
export const DO_NOT_SCAN = 'Do not scan this card'

/** After a card did not work and its hold was released. */
export const NOTHING_CHARGED = 'That card did not work, so nothing was charged for it.'

/** Dollars: after a card did not work. It was paid at the tap, so its seller's payment is held for them to refund. */
export const DISPUTED = 'That card did not work. Its seller’s payment waits 48 hours, so they can refund you.'

/** Why the till is asking for the rest: what happened to the card before. */
export type OwedWhy = 'failed' | 'not_used' | 'scanned'

/** After the shopper was told not to scan a card, and did not. */
export const NOT_USED = 'That card was not used, so nothing was charged for it.'

/** Dollars: a card paid at the tap and not used is the shopper's own now. Only the dollars till pays from store credit. */
export const NOT_USED_KEPT = 'That card was not used. It is in your store credit now, and pays first the next time you pay with dollars.'

/** After a card that went through, when the rest came back at a new price. */
export const SCANNED_PRICE_CHANGED = 'That card went through. The price for the rest changed.'

/**
 * The line over "Pay $X more": what became of the card before, from why the
 * till is here. A kept hold is said whatever the reason, because it is money
 * still held.
 */
export function owedLine(why: OwedWhy, kept: KeptHold | null, rail: Rail = 'card'): string {
  if (kept !== null) return keptLine(kept)
  if (why === 'scanned') return SCANNED_PRICE_CHANGED
  if (rail === 'stablecoin') return why === 'not_used' ? NOT_USED_KEPT : DISPUTED
  return why === 'not_used' ? NOT_USED : NOTHING_CHARGED
}

/** After a card did not work at a store nobody can check, where its hold is kept. */
export function keptLine(kept: KeptHold): string {
  return `We keep ${dollars(kept.cents)} on hold for that card until the next shopper tries it. If their scan works, we release it. If the card was used, we take it.`
}

/** The end. */
export function doneLine(r: TillReceipt): string {
  return `Paid ${dollars(r.paidCents)} · saved ${dollars(r.savedCents)}.`
}

/**
 * Dollars: what was paid at the tap beside the cards the register took,
 * each said as what it is, never as covered or saved: the cards the register
 * did not take, now store credit, and a card that did not work.
 */
export function alsoPaidLine(r: TillReceipt): string | null {
  const credit = r.creditPaidCents ?? 0
  const disputed = r.disputedCents ?? 0
  const parts = [credit > 0 ? `${dollars(credit)} for store credit` : null, disputed > 0 ? `${dollars(disputed)} for a card that did not work` : null].filter(
    (x): x is string => x !== null,
  )
  return parts.length === 0 ? null : `You also paid ${parts.join(' and ')}.`
}

/** What the till asked the chain again and got, while the page was open: said in place of "not yet". */
export function caughtUpLine(out: CatchUpOutcome): string | null {
  const parts = [
    out.kept > 0 ? (out.kept === 1 ? 'The card the register did not need is in your store credit now.' : 'The cards the register did not need are in your store credit now.') : null,
    out.reported > 0 ? 'Your report has reached the chain now.' : null,
    ...(out.said ?? []),
  ].filter((x): x is string => x !== null)
  return parts.length === 0 ? null : parts.join(' ')
}

export function depositBackLine(r: TillReceipt): string | null {
  return r.depositCents > 0
    ? `Your ${dollars(r.depositCents)} deposit comes back when the next shopper uses the rest (at most 7 days).`
    : null
}

/** On the receipt: a hold kept for a card that did not work. Not paid, and not taken unless the card was used. */
export function keptBackLine(r: TillReceipt): string | null {
  return r.keptCents > 0
    ? `${dollars(r.keptCents)} is still on hold for the card that did not work. It is taken only if that card turns out to have been used.`
    : null
}

/** When a card did not work and nothing on sale covers the rest. */
export function stillOwedTitle(owedCents: number): string {
  return `The register still needs ${dollars(owedCents)}.`
}

export function stillOwedLine(r: TillReceipt, rail: Rail = 'card'): string {
  const covered = r.paidCents + r.savedCents
  const nothingMore = rail === 'card' ? 'so nothing more was held' : 'so nothing more was paid'
  return covered > 0
    ? `The cards that worked covered ${dollars(covered)}, for ${dollars(r.paidCents)}. We have nothing more that covers the rest, ${nothingMore}.`
    : `We have nothing more that covers it, ${nothingMore}.`
}

export const START_AGAIN = 'Start again'

export const SOMETHING_WRONG = 'Something went wrong?'
export const SOMETHING_WRONG_HINT =
  'Tell us within 48 hours. If a card was the rest of someone else’s card and it was empty, say so within 2 hours, and you do not pay for it.'

/** "That card was empty", for a remainder on the receipt. */
export function emptyLabel(leg: Leg): string {
  return `Card ${leg.scanIndex} was empty`
}

/** Anything else wrong with a card on the receipt. A person looks. */
export function problemLabel(leg: Leg): string {
  return `Card ${leg.scanIndex}: something else went wrong`
}

/** Account's list of what was paid at the till, for 48 hours. */
export const RECENT_PURCHASES = 'Recent purchases at the till'

/** One recent purchase, in its row. */
export function recentLine(storeName: string, plan: RoutePlan, at: number): string {
  const time = new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${storeName} · ${dollars(plan.totalCents)} · ${time}`
}

/** Nothing on sale here at all. */
export function nothingListed(storeName: string): string {
  return `Nothing at ${storeName} right now. Pay your usual way.`
}

/** The other way's price, while this phone cannot pay that way yet. */
export function previewLine(rail: Rail, plan: RoutePlan): string {
  return `${payLabel(plan)} · with ${rail === 'card' ? 'a card' : 'dollars'}`
}

/** Nothing on sale this way, while the other way has a price on screen: never "nothing here". */
export function nothingThisWay(rail: Rail, storeName: string): string {
  return rail === 'card' ? `Nothing by card at ${storeName} right now.` : `Nothing in dollars at ${storeName} right now.`
}

/** On the card rail, to a shopper with store credit here: the till pays from it only in dollars. */
export function creditDollarsOnly(storeName: string): string {
  return `Your store credit at ${storeName} pays only when you pay with dollars.`
}

export const NEED_CARD = 'Save a card in Account to pay here.'

/** Beside "We could not check your card": asks again. */
export const CHECK_AGAIN = 'Try again'

/**
 * A Pay this phone sent, whose answer never came back: the page was closed
 * or reloaded while it was going through. Asking again finds what it did,
 * and never pays twice.
 */
export function unfinishedPayLine(storeName: string, plan: RoutePlan): string {
  return `Your Pay of ${dollars(plan.costCents)} for ${dollars(plan.totalCents)} at ${storeName} did not finish on this phone.`
}
export const SHOW_LAST_PAY = 'Check it'

/** Under Pay while a Pay this phone never heard back from waits to be checked. */
export const CHECK_LAST_PAY_FIRST = 'Check your last Pay first. It may have gone through, and Pay would buy again beside it.'

/**
 * Dollars: a purchase that went through, whose page went (a reload, a closed
 * tab) with one of its cards on screen. Every card of it is paid for, so the
 * till shows it again on that card before another Pay.
 */
export function openPurchaseLine(storeName: string, open: { shown: number; scanOf: number }): string {
  return `Your last purchase at ${storeName} is still open on this phone. Card ${open.shown} of ${open.scanOf} was on screen.`
}
export const SHOW_OPEN = 'Show it'

/** Under Pay while such a purchase waits to be shown again. */
export const FINISH_OPEN_FIRST = 'Show your last purchase first. Its cards are paid for.'

/**
 * A purchase came back for another total than the one typed (a tap asked
 * again after no answer) and its total could not be changed just now.
 */
export function otherTotalLine(paidCents: number, typedCents: number): string {
  return `This is the Pay you tapped before, for ${dollars(paidCents)}. If the register says ${dollars(typedCents)}, tap ${DIDNT_SCAN}, then ${SHEET.totalChanged}.`
}

/**
 * Does the other way's button offer the shopper's own store credit? A
 * dollars plan it pays all of, at no cost. The button then says so, and a
 * tap on it switches for that one purchase (use-till.ts switchTo).
 */
export function offersCredit(rail: Rail, plan: RoutePlan | null): boolean {
  return rail === 'stablecoin' && costsNothing(plan)
}

/**
 * Under the keypad when the shopper's usual way cannot pay this total and the
 * other can: "Pay by card instead · $48.30". A dollars plan paid wholly from
 * their own store credit is said as that, never as dollars at $0.00.
 */
export function otherRailLabel(rail: Rail, plan: RoutePlan | null): string {
  if (offersCredit(rail, plan)) return 'Use your store credit instead'
  const way = rail === 'card' ? 'Pay by card instead' : 'Pay with dollars instead'
  return plan === null ? way : `${way} · ${dollars(plan.costCents)}`
}

/** The keypad's empty state. */
export const TYPE_TOTAL = 'Type the total on the register.'

/** Beside the store's name: the other stores, one tap each. */
export const CHANGE_STORE = 'Change'
export const OTHER_STORES = 'Other stores'

/** Under "Nothing at Target right now": the demo, which is the rest of the flow with nothing real behind it. */
export const SAMPLE_PURCHASE = 'Walk through a sample purchase'

/** The till with no store named (/pay): pick one, once. */
export const PICK_STORE = 'Which store are you in?'
/** Under a store with no cards on sale. */
export const NOTHING_ON_SALE = 'nothing on sale yet'
/** Under a store on the picker: the liquidity, before any account. "1 card · $20 · up to 40% off". */
export function onSaleLine(s: { cards: number; totalValueCents: number; bestDiscountBps: number }): string {
  const off = s.bestDiscountBps > 0 ? ` · up to ${Math.round(s.bestDiscountBps / 100)}% off` : ''
  return `${cardsWord(s.cards)} · ${dollars(s.totalValueCents)}${off}`
}
export const PICK_STORE_HINT = 'Next time Salvo opens on the store you pick. Change is one tap away on the till.'
export const OPENING_STORE = 'Opening your last store…'
