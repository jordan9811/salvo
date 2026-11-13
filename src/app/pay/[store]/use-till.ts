'use client'

/**
 * The till's moves, whichever backend pays (unified-account spec 5.1).
 *
 * ===========================================================================
 * ONE PURCHASE AT A TIME ON SCREEN, AND ONE CODE AT A TIME IN IT. Pay returns
 * card 1's code and nothing else; card 2 exists on this phone only once Next
 * is tapped. A card that does not work ends the purchase it was in: the
 * server plans what is still owed, and "Pay $X more" is a new purchase that
 * leaves the old one's shown cards out. The receipt adds them up.
 *
 * A CODE ON SCREEN STAYS ON SCREEN UNTIL IT IS SETTLED. When the total goes
 * up with a code showing, the extra is planned, and its button sits under the
 * same code ("Scanned · pay $X more"): the card is settled only once the
 * shopper says it scanned. Leaving the code for a screen without it lost the
 * barcode and settled the card on a tap that never saw it scan.
 *
 * A TAP WITH NO ANSWER IS ASKED AGAIN THE SAME WAY. Pay sends a key; when no
 * answer comes back, or the server says that tap is still going through, the
 * next tap sends the same key, and the server hands back what the first one
 * did. Any other answer ends the key. The key is kept on the phone before Pay
 * is sent, so a page closed or reloaded while it went through can still ask,
 * from the same till.
 *
 * A PAY THIS PHONE NEVER HEARD BACK FROM IS CHECKED BEFORE ANOTHER. After a
 * reload the till says so, and Pay waits until "Check it" has an answer:
 * a new tap there made a new key, bought a second time, and wrote over the
 * only record of the first, whose card 1 had been held and shown. While the
 * check runs nothing leads away, as while Pay runs: it can open a code too.
 * A purchase it finds is kept for Account, one that has already ended
 * included.
 *
 * SO IS A PURCHASE WHOSE PAGE WENT WITH A CARD ON SCREEN. On the dollars
 * rail every card is paid at the tap. A reload with "Scan 1 of 2" showing
 * used to come back to an empty keypad: the cards were paid and nothing
 * showed them. The rail keeps each purchase as it stands on screen, so the
 * till offers it again ("Check it") and it comes back on the card that was
 * showing, as it stood there (phaseOnScreen: not to be scanned, or with the
 * rest still owed under it), under the record this phone already keeps for
 * it. The offer is asked again at the tap, for whoever is signed in then
 * (stillOffered): never another account's, from a tab left open.
 *
 * A CARD THE SHOPPER WAS TOLD NOT TO SCAN IS NEVER SHOWN WITHOUT A WORD. On
 * the dollars rail "not used" makes it their store credit, and when that
 * credit pays the rest, its code comes back at once, saying so
 * (owedStartsAtOnce), never behind a "Pay $0.00 more" tap.
 *
 * THE KEY FINDS ONE PURCHASE, WHATEVER TOTAL IS SENT WITH IT. When the total
 * on the register changed between a tap with no answer and the next, the
 * purchase that comes back is for the old one: its total is changed to the
 * one typed, the way "The total changed" changes it (landPurchase).
 *
 * A KEPT KEY GOES BACK WITH ITS OWN PLAN, TO ITS OWN RAIL. The keypad used to
 * price the total again after a Pay with no answer, and the next tap sent
 * the old key with the new plan: on the dollars rail that plan named other
 * cards, the purchase was "not on this phone", the key ended, and the tap
 * after paid a second time. And the till's rail can change (the per-visit
 * "Pay by card instead", or the rail found once both checks answer), while a
 * key, "Check it" and a purchase on screen all belong to the rail that took
 * them: asked on the other, they found nothing, said nothing was charged,
 * and dropped the only record of a Pay that went through. So a kept key is
 * sent again with the plan it went with, to that plan's rail; "Check it"
 * asks the rail its Pay was made on; Next, Done, a report and a new total go
 * to the purchase's own rail; and the till changes rail only on an idle
 * keypad, with no key kept and nothing to check.
 *
 * WHAT WAS PAID STAYS ON THE PHONE FOR 48 HOURS (client/recent.ts), so
 * "Something went wrong?" can be opened again from Account. Never a code.
 * ===========================================================================
 *
 * The quote is asked 300 ms after typing stops, and an answer for a total
 * that has since changed is dropped, so the button never offers a price for
 * a number that is no longer on screen. A price Pay itself came back with
 * stays on the button for the total it was made for: the quote's price is
 * one the server has just refused to buy.
 *
 * WHAT THE TAP NEEDS IS FETCHED WHILE THE SHOPPER TYPES (spec 5.3). Once a
 * price is on the button for the total on screen and that total has not
 * moved for 0.4 s, the backend prepares it, at once when the price lands
 * after that: on the dollars rail, a ticket for each card, the chain read
 * they are checked at, and the batch's nonce, fees and gas, so the tap only
 * signs and sends; on the card rail, nothing. A price for a total no longer
 * on screen is never prepared, and the dollars rail drops what a total the
 * shopper went on to change had fetched (dollars-backend.ts prepare). A
 * prepare that fails is said by the tap, which prepares again (a second call
 * finds the first going and waits for it), never while typing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { openCardStore, type CardStore } from '@/lib/escrow/client/card-store'
import { NO_ANSWER, STILL_GOING, TillRefused } from '@/lib/till/client/refused'
import { endPendingPay, keepPendingPay, keepTillPurchase, recentTillPurchases, unfinishedPay } from '@/lib/till/client/recent'
import { markRender } from '@/lib/till/client/tap-marks'
import type {
  ChangeAnswer,
  EndedPurchase,
  KeptHold,
  LegCode,
  PaymentMethod,
  Purchase,
  PurchaseHandle,
  Rail,
  ReportAnswer,
  Requote,
  ReportOutcome,
  RoutePlan,
  RoutePreference,
  TillBackend,
  TillReceipt,
  Unavailable,
  UnfinishedPay,
} from '@/lib/till/types'
import { CREDIT_PAYS_REST, PRICE_CHANGED, caughtUpLine, costsNothing, offersCredit, otherTotalLine, owedLine, type OwedWhy } from '../till-copy'

/** How long typing must stop before the till asks for a price. */
const QUOTE_DEBOUNCE_MS = 300
/**
 * How long the total must stay as typed before what the tap needs is fetched
 * for its price. Measured 2026-10-14: at 0.8 s the tap still waited 0.93 s
 * for the tickets, which take about 2.4 s (one Lit run each, in parallel).
 */
const PREPARE_AFTER_MS = 400
/** How long a card check that could not be read waits before it is asked again, and how many times. */
const METHOD_RETRY_MS = 5_000
const METHOD_RETRIES = 6

export type QuoteState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; plan: RoutePlan }
  | { kind: 'unavailable'; message: string; nothingListed: boolean }

export type TillPhase =
  | { kind: 'keypad' }
  | { kind: 'paying' }
  /**
   * A code on screen. `then`: the total went up, and this is the plan for
   * the rest, paid once this card has scanned. `tooLow`: the total came down
   * past what can stay on this card, so it must not be scanned; `notNeeded`
   * with it when the cards before it already cover the new total. `note`:
   * why this card is on screen, when that is not plain (a card the shopper
   * was told not to scan, now their store credit, paying the rest).
   */
  | { kind: 'scan'; purchase: Purchase; code: LegCode; then: RoutePlan | null; tooLow: boolean; notNeeded: boolean; note?: string }
  /**
   * The rest is still owed, with no code on screen. `why`: what became of the
   * card before (it failed, it was not used, or it went through and the rest
   * came back at a new price). `kept`: its hold, when kept. `line`: the
   * backend's own sentence for that card, said instead of the till's when the
   * till's would not be true (ReportAnswer.line); `note`: anything more.
   */
  | { kind: 'owed'; purchase: Purchase; owed: RoutePlan; kept: KeptHold | null; why: OwedWhy; line: string | null; note: string | null }
  /** A card did not work and nothing on sale covers the rest. */
  | { kind: 'uncovered'; purchases: PurchaseHandle[]; owedCents: number; kept: KeptHold | null; why: OwedWhy; line: string | null; note: string | null }
  | { kind: 'done'; purchases: PurchaseHandle[] }

type ScanPhase = Extract<TillPhase, { kind: 'scan' }>

const ZERO: TillReceipt = { paidCents: 0, savedCents: 0, depositCents: 0, keptCents: 0 }

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong on our side. Nothing was charged.'
}

export function sumReceipts(rs: Iterable<TillReceipt>): TillReceipt {
  let total = ZERO
  for (const r of rs) {
    const credit = (total.creditPaidCents ?? 0) + (r.creditPaidCents ?? 0)
    const disputed = (total.disputedCents ?? 0) + (r.disputedCents ?? 0)
    total = {
      paidCents: total.paidCents + r.paidCents,
      savedCents: total.savedCents + r.savedCents,
      depositCents: total.depositCents + r.depositCents,
      keptCents: total.keptCents + r.keptCents,
      // Paid beside the cards that worked: summed apart, so never said as covered or saved.
      ...(credit > 0 ? { creditPaidCents: credit } : {}),
      ...(disputed > 0 ? { disputedCents: disputed } : {}),
    }
  }
  return total
}

/**
 * When the till asks the dollars rail again what the chain did not take just
 * now (a card to keep as store credit, a report), while the page is open:
 * soon, then less often. A leftover goes back on sale once its quote's hold
 * ends, and a sale pays its seller on a clock, so the next time the till or
 * Account opens may be too late.
 */
export const ASK_AGAIN_MS: readonly number[] = [5_000, 15_000, 45_000]

/**
 * Where a report on the card on screen leaves the till. The code on screen is
 * settled now, so it never goes back to it: the receipt when nothing more is
 * owed; what is still owed, said with what became of the card (not used, or
 * did not work, and whether its hold was kept); or, when nothing on sale
 * covers the rest, what the register still needs, never a receipt.
 */
export function phaseAfterReport(out: ReportAnswer, purchase: Purchase, purchases: PurchaseHandle[], outcome: ReportOutcome): TillPhase {
  const why: OwedWhy = outcome === 'not_used' ? 'not_used' : 'failed'
  const said = { line: out.line ?? null, note: out.note }
  if (out.owed === null) return { kind: 'done', purchases }
  if ('unavailable' in out.owed) return { kind: 'uncovered', purchases, owedCents: out.owedCents, kept: out.kept, why, ...said }
  return { kind: 'owed', purchase, owed: out.owed, kept: out.kept, why, ...said }
}

/**
 * Does what a report leaves owed start at once, with no tap? Only after "not
 * used", and only a plan paid wholly from the shopper's own store credit:
 * the card they were told not to scan is their credit now, and that credit
 * pays the rest. Behind a tap, the screen that had just said not to scan the
 * card offered "Pay $0.00 more", then showed that same card with no word of
 * why.
 */
export function owedStartsAtOnce(out: Pick<ReportAnswer, 'owed'>, outcome: ReportOutcome): boolean {
  return outcome === 'not_used' && out.owed !== null && !('unavailable' in out.owed) && costsNothing(out.owed)
}

/**
 * The other way's plan for this total, when the till may offer it: that way
 * can pay now, or the plan takes nothing from it, the shopper's own store
 * credit covering all of it. An empty dollars balance, or a week's allowance
 * used up, never strands store credit that pays the whole total.
 */
export function otherWayPlan(method: PaymentMethod, out: RoutePlan | Unavailable): RoutePlan | null {
  if ('unavailable' in out) return null
  return method.ready || costsNothing(out) ? out : null
}

/**
 * Could the shopper's own store credit here pay this total, while the till
 * pays by card? Only the dollars rail pays from store credit, so the till
 * then asks that rail's price too, and offers it when it costs nothing.
 */
export function creditMayPay(input: { rail: Rail; cents: number; creditCents: number }): boolean {
  return input.rail === 'card' && input.cents > 0 && input.cents <= input.creditCents
}

/**
 * What the shopper switched on this till. "Pay by card instead" (or "with
 * dollars") holds for the rest of the visit (`visit`). "Use your store
 * credit instead" holds for one purchase (`once`): it offered their credit
 * for the total on screen, never the dollars rail for every purchase after
 * it. Held for the visit, the next "Pay again" priced in dollars and took
 * them from the dollars balance, or, on a phone with no dollars set up, said
 * there was not enough at a store with cards on sale.
 */
export interface RailSwitch {
  visit: Rail | null
  once: Rail | null
}

export const NO_SWITCH: RailSwitch = { visit: null, once: null }

/** The way the shopper switched the till to, a switch for one purchase first; null when they switched nothing. */
export function switchedRail(s: RailSwitch): Rail | null {
  return s.once ?? s.visit
}

/** The other way's button, tapped: for one purchase when it offers the shopper's store credit (offersCredit), else for the visit. */
export function switchTo(s: RailSwitch, rail: Rail, plan: RoutePlan | null): RailSwitch {
  return offersCredit(rail, plan) ? { ...s, once: rail } : { visit: rail, once: null }
}

/** The purchase a switch was made for is over: the till goes back to the visit's way, or the account's. */
export function endOnce(s: RailSwitch): RailSwitch {
  return s.once === null ? s : { ...s, once: null }
}

/**
 * Is a switch to store credit outgrown, on an idle keypad? It was offered
 * for a total the credit here covers: once the total typed is more, the
 * till goes back to its own way, rather than pricing the rest in dollars.
 * The purchase it was made for ends it too ("Pay again", "Start again").
 */
export function onceOutgrown(input: { idle: boolean; cents: number; creditCents: number }): boolean {
  return input.idle && input.cents > input.creditCents
}

/**
 * Where a new total leaves the code on screen. It stays on screen, as the
 * last card of its purchase, covering what the server now says it covers.
 * More owed: the plan for it waits under the code until the card has
 * scanned. Too low: the card must not be scanned.
 */
export function phaseAfterChange(code: LegCode, out: ChangeAnswer): ScanPhase {
  const cover = out.cover !== null && out.cover.scanIndex === code.scanIndex ? out.cover : null
  return {
    kind: 'scan',
    purchase: out.purchase,
    code: {
      ...code,
      scanOf: code.scanIndex,
      ...(cover ? { coversCents: cover.coversCents, leftoverCents: cover.leftoverCents, depositCents: cover.depositCents } : {}),
    },
    then: out.owed !== null && !('unavailable' in out.owed) ? out.owed : null,
    tooLow: out.tooLow,
    notNeeded: out.tooLow && out.notNeeded,
  }
}

/**
 * Where a purchase put on screen leaves the till: its code, to scan; or, one
 * opened again after its page went whose total had changed there
 * (Purchase.standing, the dollars rail's), its card as it stood, as a new
 * total leaves it: not to be scanned, or with the rest to pay under it, and
 * why the rest has no plan when it has none.
 *
 * A CARD THE SHOPPER WAS TOLD NOT TO SCAN NEVER COMES BACK AS ONE TO SCAN.
 * Opened again as a plain code, "Show it" put back its barcode under the
 * old total's "covers", with Done: scanned, the register took the new total
 * from it, and Done settled it as used at the old one.
 */
export function phaseOnScreen(p: Purchase, note?: string): { phase: ScanPhase; error: string | null } {
  const { standing, ...purchase } = p
  if (standing === undefined) {
    return { phase: { kind: 'scan', purchase, code: p.code, then: null, tooLow: false, notNeeded: false, ...(note === undefined ? {} : { note }) }, error: null }
  }
  const error = standing.owed !== null && 'unavailable' in standing.owed ? standing.owed.unavailable : null
  return { phase: phaseAfterChange(p.code, { purchase, ...standing }), error }
}

/**
 * Is the Pay the till offers to check still this phone's to check, as the
 * phone has it now? Asked again at the tap, for whoever is signed in then.
 * The offer is read as the till opens, and a tab left open while its
 * account signed out in another tab went on offering it: the next
 * account's tap asked with the first one's key, for the first one's cards.
 */
export function stillOffered(asking: UnfinishedPay, now: UnfinishedPay | null): now is UnfinishedPay {
  return now !== null && now.key === asking.key && now.plan.rail === asking.plan.rail
}

/**
 * Where Pay's purchase leaves the till, for the total typed.
 *
 * A PURCHASE FOR ANOTHER TOTAL IS AN EARLIER TAP'S, found again by its key
 * after no answer came back: the server never buys twice for one key, and
 * resumes by the key, whatever total the tap sent. Shown as it came, it
 * covered the old total, and nothing on the scan screen says the total: the
 * cards paid $52.13 and the register still wanted $3.00 after Done. So its
 * total is changed to the one typed, as "The total changed" changes it. If
 * that cannot be asked now, the code stays and the screen says what to do.
 */
export async function landPurchase(
  backend: Pick<TillBackend, 'changeTotal'>,
  out: Purchase,
  typedCents: number,
): Promise<{ purchase: Purchase; phase: ScanPhase; error: string | null }> {
  const plain: ScanPhase = { kind: 'scan', purchase: out, code: out.code, then: null, tooLow: false, notNeeded: false }
  if (out.plan.totalCents === typedCents) return { purchase: out, phase: plain, error: null }
  try {
    const changed = await backend.changeTotal(out, typedCents)
    const error = changed.owed !== null && 'unavailable' in changed.owed ? changed.owed.unavailable : null
    return { purchase: changed.purchase, phase: phaseAfterChange(out.code, changed), error }
  } catch (err) {
    return { purchase: out, phase: plain, error: `${messageOf(err)} ${otherTotalLine(out.plan.totalCents, typedCents)}` }
  }
}

/**
 * Should the keypad ask for a price now?
 *
 *   idle   nothing typed
 *   keep   the price on the button is the one Pay just came back with for
 *          this very total (a drains-only plan when the card would not hold
 *          a deposit, or a new price): asking again would put back the
 *          plan the server just refused, and the next tap would loop
 *   keep   also while a tap's key is kept: the next tap sends that key with
 *          the plan it went with, never a new price (useTill's payWithKey)
 *   ask    anything else
 */
export function quoteNeed(input: { phase: TillPhase['kind']; cents: number; requotedFor: number | null; keyKept?: boolean }): 'idle' | 'keep' | 'ask' | 'off' {
  if (input.phase !== 'keypad') return 'off'
  if (input.keyKept === true) return 'keep'
  if (input.cents <= 0) return 'idle'
  return input.requotedFor === input.cents ? 'keep' : 'ask'
}

/**
 * When to prepare the price on the button, in ms from now, or null for
 * never: 0.4 s after the total stopped changing, and so at once for a price
 * that lands after that. A price for another total than the one on screen
 * is never prepared: its tickets would only be dropped. Pure.
 */
export function prepareDelayMs(input: { planCents: number; cents: number; typedAt: number; now: number }): number | null {
  if (input.planCents !== input.cents) return null
  return Math.max(0, PREPARE_AFTER_MS - (input.now - input.typedAt))
}

/**
 * May Pay be tapped, as far as the payment method goes? Only a definite
 * answer that it cannot pay stops it. A check that could not be read says
 * nothing either way: the server decides at Pay, and the screen asks again.
 */
export function payBlockedBy(method: PaymentMethod | null): boolean {
  return method !== null && !method.ready && method.checked
}

/**
 * Is the Pay button off? While a Pay or a check of an unfinished one is going
 * through (`busy`), with no price, when the way it pays definitely cannot
 * (unless the plan takes nothing from it: the shopper's own store credit
 * covers all of it), while a Pay this phone never heard back from waits to
 * be checked (a tap then would buy again beside it), and while the till is
 * still finding which way it pays (`railPending`: a purchase started on the
 * way it guessed first is one on the wrong rail).
 */
export function payDisabled(input: {
  paying: boolean
  busy: boolean
  plan: RoutePlan | null
  method: PaymentMethod | null
  unfinished: boolean
  railPending: boolean
}): boolean {
  return (
    input.paying ||
    input.busy ||
    input.plan === null ||
    input.railPending ||
    (payBlockedBy(input.method) && !costsNothing(input.plan)) ||
    input.unfinished
  )
}

/**
 * Does this refusal leave the tap's key to be sent again? No answer at all,
 * or the server saying the tap is still going through. Ended there, the next
 * tap made a new key, and so a second purchase beside the first.
 */
export function keepsKey(err: unknown): boolean {
  return err instanceof TillRefused && (err.code === NO_ANSWER || err.code === STILL_GOING)
}

/**
 * This account's dollars Pay at this store that may have gone through and
 * never finished here, or that went through with a card on a screen that
 * went, from the rail's own book; or null. Never throws.
 */
async function dollarsUnfinished(backend: TillBackend, store: string): Promise<UnfinishedPay | null> {
  const found = await (backend.unfinishedPays?.() ?? Promise.resolve([])).catch(() => [])
  return found.find((p) => p.store === store) ?? null
}

/** The record this phone already keeps for a purchase (one found again after a reload), so Account lists it once. Never throws. */
async function keptRecordOf(store: CardStore | null, ref: string): Promise<{ id: string; at: number } | null> {
  if (store === null) return null
  const r = (await store.tillPurchases().catch(() => [])).find((x) => x.purchase.ref === ref)
  return r === undefined ? null : { id: r.id, at: r.createdAt }
}

/** A key for one tap: random, and never anything about the shopper. */
function newPayKey(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The id this phone keeps a purchase by. */
function newRecordId(): string {
  return `${Date.now().toString(36)}-${newPayKey().slice(0, 8)}`
}

type PayAnswer = Purchase | Requote | EndedPurchase
const isRequote = (out: PayAnswer): out is Requote => 'requote' in out
const isEnded = (out: PayAnswer): out is EndedPurchase => 'ended' in out

/** A tap's key that got no answer, and the plan it was sent with: the next tap sends both again, to that plan's rail. */
export interface KeptPay {
  key: string
  plan: RoutePlan
}

/**
 * What a Pay sends: a kept key goes back with the plan it went with,
 * whatever plan the screen has now, and so to that plan's rail
 * (`plan.rail`); with none kept, a new key and this plan.
 */
export function payToSend(held: KeptPay | null, plan: RoutePlan, newKey: () => string): KeptPay {
  return held === null ? { key: newKey(), plan } : held
}

/**
 * May the till take up another rail now? Only on an idle keypad: not while a
 * Pay or a check runs, not while a key is kept or a Pay waits to be
 * checked, and never with a code on screen or a purchase still owed.
 */
export function railMayChange(input: { phase: TillPhase['kind']; busy: boolean; keyKept: boolean; unfinished: boolean }): boolean {
  return input.phase === 'keypad' && !input.busy && !input.keyKept && !input.unfinished
}

/**
 * The till's moves. `backends`: both rails, so every move goes to the rail it
 * belongs to. `rail`: the way the keypad should price and pay; it is taken
 * up only on an idle keypad (no Pay or check going, no key kept, nothing to
 * check). `railPending`: that way is not known yet, so Pay waits.
 */
export function useTill(input: {
  store: string
  backends: Readonly<Record<Rail, TillBackend>>
  rail: Rail
  railPending: boolean
  preference: RoutePreference
}) {
  const { store, backends, rail, railPending, preference } = input
  const [cents, setCents] = useState(0)
  const [quote, setQuote] = useState<QuoteState>({ kind: 'idle' })
  const [phase, setPhase] = useState<TillPhase>({ kind: 'keypad' })
  const [method, setMethod] = useState<PaymentMethod | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** A sentence that is not an error: a Pay asked about again had already gone through. */
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** A Pay this phone sent here and never heard back from, before this page; or one that went through with a card on a screen that went (`open`). */
  const [unfinished, setUnfinished] = useState<UnfinishedPay | null>(null)
  /** What each purchase came to, by its record id. */
  const [receipts, setReceipts] = useState<Map<string, TillReceipt>>(new Map())
  /** Every purchase this visit, for the receipt's "Something went wrong?", with the id this phone keeps it by. */
  const purchases = useRef<Array<{ id: string; purchase: PurchaseHandle; at: number }>>([])
  /** The key of a Pay that got no answer, with its plan: the next Pay sends both again (KeptPay). */
  const payKey = useRef<KeptPay | null>(null)
  /** The same, for the screen: Pay stays on its plan, and the rail stays put. */
  const [keptPay, setKeptPay] = useState<KeptPay | null>(null)
  const holdKey = useCallback((k: KeptPay | null) => {
    payKey.current = k
    setKeptPay(k)
  }, [])
  /** The total a price from Pay itself is on the button for. */
  const requotedFor = useRef<number | null>(null)
  const device = useRef<CardStore | null>(null)

  // What the dollars rail could not get onto the chain just now is asked again
  // soon (ASK_AGAIN_MS), and said once it lands. Never pays for anything.
  const askTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const askAgainSoon = useCallback(
    (step = 0) => {
      if (askTimer.current !== null) clearTimeout(askTimer.current)
      askTimer.current = null
      const wait = ASK_AGAIN_MS[step]
      if (wait === undefined) return
      askTimer.current = setTimeout(() => {
        askTimer.current = null
        void (backends.stablecoin.catchUp?.() ?? Promise.resolve(null)).then(
          (out) => {
            if (out === null) return
            const line = caughtUpLine(out)
            if (line !== null) setNotice(line)
            if (out.waiting > 0) askAgainSoon(step + 1)
          },
          () => askAgainSoon(step + 1),
        )
      }, wait)
    },
    [backends],
  )
  useEffect(
    () => () => {
      if (askTimer.current !== null) clearTimeout(askTimer.current)
    },
    [],
  )
  /** A dollars answer with something said beside it (a card not credit yet, a report not landed): asked again soon. */
  const sayingMore = useCallback(
    (rail: Rail, said: Array<string | null | undefined>) => {
      if (rail === 'stablecoin' && said.some((x) => typeof x === 'string' && x !== '')) askAgainSoon()
    },
    [askAgainSoon],
  )

  // The way the keypad prices and pays. It follows `rail` only on an idle
  // keypad: a switch while Pay runs, a key is kept, a Pay waits to be checked
  // or a code is on screen would send that purchase's moves to a rail that
  // never heard of it.
  const [active, setActive] = useState<Rail>(rail)
  const idle = railMayChange({ phase: phase.kind, busy, keyKept: keptPay !== null, unfinished: unfinished !== null })
  useEffect(() => {
    if (!idle || rail === active) return
    requotedFor.current = null
    setActive(rail)
  }, [idle, rail, active])
  const backend = backends[active]

  const checkMethod = useCallback(() => {
    void backend.method().then(setMethod, () => undefined)
  }, [backend])
  const methodRef = useRef<PaymentMethod | null>(null)
  methodRef.current = method
  const methodRetries = useRef(0)

  useEffect(() => {
    let live = true
    setMethod(null)
    methodRetries.current = 0
    void backend.method().then(
      (m) => {
        if (live) setMethod(m)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [backend])

  // The phone's store, once per store. Not again when the rail changes: read
  // while a Pay was going through, its own pending record came back as a Pay
  // that "did not finish", and blocked Pay for good.
  useEffect(() => {
    let live = true
    void openCardStore()
      .then(async (s) => {
        device.current = s
        // Old purchases go when a till opens, not only when Account reads them.
        await recentTillPurchases(s).catch(() => undefined)
        // The key kept for a Pay, or, once that went with a sign-out, the dollars rail's own book (by the tap's key on the purchase).
        const p = (await unfinishedPay(s, store).catch(() => null)) ?? (await dollarsUnfinished(backends.stablecoin, store))
        if (live && p !== null) setUnfinished(p)
      })
      .catch(() => undefined)
    // What this account's purchases still owe the chain from this phone (a
    // card to keep as store credit, a report that did not land, the cards a
    // purchase left on a screen nobody opened never showed): sent now, as
    // the till's words promise, and said once it lands. Nothing is paid for.
    void (backends.stablecoin.catchUp?.() ?? Promise.resolve(null)).then(
      (out) => {
        if (!live || out === null) return
        const line = caughtUpLine(out)
        if (line !== null) setNotice(line)
        if (out.waiting > 0) askAgainSoon()
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [store, backends, askAgainSoon])

  // A card check that could not be read is asked again: on a short wait, and
  // whenever the phone comes back to this page. Pay stays open meanwhile.
  useEffect(() => {
    if (method === null) return
    if (method.checked) {
      methodRetries.current = 0
      return
    }
    const t =
      methodRetries.current < METHOD_RETRIES
        ? setTimeout(() => {
            methodRetries.current += 1
            checkMethod()
          }, METHOD_RETRY_MS)
        : undefined
    const onShow = () => {
      if (document.visibilityState === 'visible') checkMethod()
    }
    document.addEventListener('visibilitychange', onShow)
    return () => {
      if (t !== undefined) clearTimeout(t)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [method, checkMethod])

  // The price, once typing stops. A reply for an older total is dropped.
  const asked = useRef(0)
  useEffect(() => {
    const need = quoteNeed({ phase: phase.kind, cents, requotedFor: requotedFor.current, keyKept: keptPay !== null })
    if (need === 'off' || need === 'keep') return
    requotedFor.current = null
    if (need === 'idle') {
      setQuote({ kind: 'idle' })
      return
    }
    setQuote({ kind: 'loading' })
    const ask = ++asked.current
    const t = setTimeout(() => {
      void backend
        .quote({ merchant: store, totalCents: cents, preference })
        .then((out) => {
          if (ask !== asked.current) return
          setQuote(
            'unavailable' in out
              ? { kind: 'unavailable', message: out.unavailable, nothingListed: out.nothingListed === true }
              : { kind: 'ready', plan: out },
          )
        })
        .catch((err: unknown) => {
          if (ask === asked.current) setQuote({ kind: 'unavailable', message: messageOf(err), nothingListed: false })
        })
    }, QUOTE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [cents, store, preference, backend, phase.kind, keptPay])

  // What the tap needs, fetched while the total stays as typed.
  const typedAt = useRef(0)
  useEffect(() => {
    typedAt.current = Date.now()
  }, [cents])
  useEffect(() => {
    if (quote.kind !== 'ready' || phase.kind !== 'keypad' || keptPay !== null) return
    const plan = quote.plan
    const wait = prepareDelayMs({ planCents: plan.totalCents, cents, typedAt: typedAt.current, now: Date.now() })
    if (wait === null) return
    const t = setTimeout(() => {
      void backend.prepare(plan).catch(() => undefined)
    }, wait)
    return () => clearTimeout(t)
  }, [quote, cents, phase.kind, backend, keptPay])

  // A price came back, so the server answers here: a card check that failed is
  // worth asking again, once per price.
  useEffect(() => {
    const m = methodRef.current
    if (quote.kind === 'ready' && m !== null && !m.checked) checkMethod()
  }, [quote, checkMethod])

  /** Keep a purchase on this phone as it stands now, and what it came to. */
  const persist = useCallback(
    (id: string, receipt: TillReceipt | null) => {
      const entry = purchases.current.find((p) => p.id === id)
      if (!entry) return
      void keepTillPurchase(device.current, {
        id,
        store,
        purchase: entry.purchase,
        receipt: receipt ?? ZERO,
        createdAt: entry.at,
      })
    },
    [store],
  )

  const idOf = useCallback((p: PurchaseHandle): string => purchases.current.find((e) => e.purchase.ref === p.ref)?.id ?? '', [])

  const keep = useCallback(
    (p: PurchaseHandle, r: TillReceipt) => {
      const id = idOf(p)
      setReceipts((m) => new Map(m).set(id, r))
      persist(id, r)
    },
    [idOf, persist],
  )

  /** The purchase took a new handle (a new total): keep the new one under the same id. */
  const replaced = useCallback(
    (before: Purchase, after: Purchase) => {
      const entry = purchases.current.find((e) => e.purchase.ref === before.ref)
      if (!entry) return
      entry.purchase = after
      persist(entry.id, receipts.get(entry.id) ?? null)
    },
    [persist, receipts],
  )

  const run = useCallback(async (step: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await step()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * A purchase this phone now has: kept for Account, before anything else
   * happens to it. `kept`: the record this phone already keeps for it (one
   * found again after a reload), kept under the same id, so Account lists it
   * once.
   */
  const remember = useCallback(
    (p: PurchaseHandle, receipt: TillReceipt | null, kept: { id: string; at: number } | null = null): string => {
      const id = kept?.id ?? newRecordId()
      purchases.current = [...purchases.current.filter((e) => e.id !== id), { id, purchase: p, at: kept?.at ?? Date.now() }]
      if (receipt !== null) setReceipts((m) => new Map(m).set(id, receipt))
      persist(id, receipt)
      return id
    },
    [persist],
  )

  /**
   * A purchase on screen, its code showing, or its card as it stood on a
   * screen that went (phaseOnScreen). `note`: why this card is on screen,
   * when that is not plain.
   */
  const started = useCallback(
    (p: Purchase, kept: { id: string; at: number } | null = null, note?: string) => {
      const on = phaseOnScreen(p, note)
      remember(on.phase.purchase, null, kept)
      setPhase(on.phase)
      if (on.error !== null) setError(on.error)
    },
    [remember],
  )

  /** A tap asked about again whose purchase had already ended: kept for Account, and said. */
  const keepEnded = useCallback(
    (out: EndedPurchase, kept: { id: string; at: number } | null = null) => {
      remember(out.ended, out.receipt, kept)
      setNotice(out.message)
    },
    [remember],
  )

  /**
   * Pay a plan with this tap's key. A new price is said and put on the
   * button, with nothing held. No answer, or a tap still going through,
   * keeps the key for the next tap; any other answer ends it. The key is on
   * the phone before the request leaves it. A kept key is sent again with
   * the plan it went with, to that plan's rail, whatever plan is passed.
   */
  const payWithKey = useCallback(
    async (plan: RoutePlan, opts: { after?: Purchase; resume?: boolean } = {}): Promise<PayAnswer> => {
      const { key, plan: sending } = payToSend(payKey.current, plan, newPayKey)
      holdKey({ key, plan: sending })
      if (!opts.resume) await keepPendingPay(device.current, { key, store, plan: sending, at: Date.now() })
      try {
        const out = await backends[sending.rail].pay(sending, {
          key,
          ...(opts.after ? { after: opts.after } : {}),
          ...(opts.resume ? { resume: true } : {}),
        })
        holdKey(null)
        await endPendingPay(device.current, store)
        return out
      } catch (err) {
        if (!keepsKey(err)) {
          holdKey(null)
          await endPendingPay(device.current, store)
        }
        throw err
      }
    },
    [backends, store, holdKey],
  )

  /** What the Pay button pays: the plan a kept key went with, else the price on it. */
  const buttonPlan: RoutePlan | null = keptPay?.plan ?? (quote.kind === 'ready' ? quote.plan : null)

  /** The one tap. Never while a Pay this phone never heard back from waits to be checked, nor while the way it pays is not known. */
  const pay = useCallback(async () => {
    const held = payKey.current
    const plan = held?.plan ?? (quote.kind === 'ready' ? quote.plan : null)
    if (plan === null || unfinished !== null || (held === null && railPending)) return
    // The total on the register: a kept key's purchase is changed to it once found.
    const typed = held !== null && cents > 0 ? cents : plan.totalCents
    setPhase({ kind: 'paying' })
    setError(null)
    setNotice(null)
    try {
      // A kept key's purchase is found by the key: there is nothing to fetch for its plan. The tap waits on what
      // the keypad has not finished fetching (dollars marks how long).
      if (held === null) await backends[plan.rail].prepare(plan, { tap: true })
      const out = await payWithKey(plan)
      if (isRequote(out)) {
        // The new price stays on the button for this total: the quote would put back the old one.
        requotedFor.current = out.requote.totalCents
        setQuote({ kind: 'ready', plan: out.requote })
        setError(`${out.message} ${PRICE_CHANGED}`)
        setPhase({ kind: 'keypad' })
        return
      }
      if (isEnded(out)) {
        keepEnded(out)
        setPhase({ kind: 'keypad' })
        return
      }
      const inHand = performance.now()
      remember(out, null)
      const landed = await landPurchase(backends[out.rail], out, typed)
      if (landed.purchase !== out) replaced(out, landed.purchase)
      setPhase(landed.phase)
      if (landed.error !== null) setError(landed.error)
      markRender(inHand)
    } catch (err) {
      setError(messageOf(err))
      setPhase({ kind: 'keypad' })
    }
  }, [quote, cents, unfinished, railPending, backends, payWithKey, keepEnded, remember, replaced])

  /**
   * "Check it": ask what a Pay this phone never heard back from did, with its
   * own key, on the rail it was made on. Never pays afresh. Pay waits for an
   * answer: no answer, or a tap still going through, leaves it waiting.
   */
  const resumeUnfinished = useCallback(
    () =>
      run(async () => {
        if (unfinished === null) return
        // Asked again first, for whoever is signed in now: one found for an account signed out since (another
        // tab, "Use that account here"), or finished in another tab, is no longer this phone's to ask about.
        const offered = unfinished
        const now = device.current === null ? null : ((await unfinishedPay(device.current, store).catch(() => null)) ?? (await dollarsUnfinished(backends.stablecoin, store)))
        if (!stillOffered(offered, now)) {
          if (payKey.current?.key === offered.key) holdKey(null)
          setUnfinished(now)
          return
        }
        const asking = now
        holdKey({ key: asking.key, plan: asking.plan })
        setNotice(null)
        try {
          const out = await payWithKey(asking.plan, { resume: true })
          setUnfinished(null)
          // One this phone kept before its page went is the same purchase: kept under its own record.
          if (isEnded(out)) keepEnded(out, await keptRecordOf(device.current, out.ended.ref))
          else if (!isRequote(out)) started(out, await keptRecordOf(device.current, out.ref))
        } catch (err) {
          if (keepsKey(err)) {
            // Still unfinished, and still asked about the same way.
            setUnfinished(asking)
          } else {
            holdKey(null)
            setUnfinished(null)
          }
          throw err
        }
      }),
    [run, unfinished, store, backends, holdKey, payWithKey, started, keepEnded],
  )

  /** The card on screen scanned: show the next one. Asked of the rail that paid it. */
  const next = useCallback(
    () =>
      run(async () => {
        if (phase.kind !== 'scan') return
        const code = await backends[phase.purchase.rail].next(phase.purchase, phase.code.scanIndex)
        setPhase({ kind: 'scan', purchase: phase.purchase, code, then: null, tooLow: false, notNeeded: false })
      }),
    [phase, backends, run],
  )

  const finished = useCallback(() => setPhase({ kind: 'done', purchases: purchases.current.map((e) => e.purchase) }), [])

  /** A receipt that says more than its sums (a card not store credit yet): said on the screen after it. */
  const settled = useCallback(
    (p: PurchaseHandle, r: TillReceipt) => {
      keep(p, r)
      if (r.note !== undefined) setNotice(r.note)
      sayingMore(p.rail, [r.note])
    },
    [keep, sayingMore],
  )

  /** The card on screen was the last the register needed: Done, or "Register says paid". */
  const done = useCallback(
    () =>
      run(async () => {
        if (phase.kind !== 'scan') return
        settled(phase.purchase, await backends[phase.purchase.rail].done(phase.purchase, phase.code.scanIndex))
        finished()
      }),
    [phase, backends, run, settled, finished],
  )

  /** The total went up with this card on screen: it scanned, so settle it, then pay the rest. */
  const scannedThenPay = useCallback(
    () =>
      run(async () => {
        if (phase.kind !== 'scan' || phase.then === null) return
        settled(phase.purchase, await backends[phase.purchase.rail].done(phase.purchase, phase.code.scanIndex))
        const out = await payWithKey(phase.then, { after: phase.purchase })
        if (isRequote(out)) {
          // The card went through; the rest waits, at its new price, with no code on screen.
          setPhase({ kind: 'owed', purchase: phase.purchase, owed: out.requote, kept: null, why: 'scanned', line: null, note: null })
          setError(`${out.message} ${PRICE_CHANGED}`)
          return
        }
        if (isEnded(out)) {
          keepEnded(out)
          finished()
          return
        }
        started(out)
      }),
    [phase, backends, run, settled, payWithKey, started, keepEnded, finished],
  )

  /**
   * "Pay $X more": a new purchase for what is still owed, leaving the old
   * one's shown cards out. `note`: said on the code it opens.
   */
  const payOwedOf = useCallback(
    async (owed: Extract<TillPhase, { kind: 'owed' }>, note?: string) => {
      const out = await payWithKey(owed.owed, { after: owed.purchase })
      if (isRequote(out)) {
        setPhase({ ...owed, owed: out.requote })
        setError(`${out.message} ${PRICE_CHANGED}`)
        return
      }
      if (isEnded(out)) {
        keepEnded(out)
        finished()
        return
      }
      started(out, null, note)
    },
    [payWithKey, started, keepEnded, finished],
  )

  /** The card on screen did not work, or must not be used. */
  const report = useCallback(
    (o: ReportOutcome) =>
      run(async () => {
        if (phase.kind !== 'scan') return
        const out = await backends[phase.purchase.rail].report(phase.purchase, phase.code.scanIndex, o)
        keep(phase.purchase, out.receipt)
        const after = phaseAfterReport(out, phase.purchase, purchases.current.map((e) => e.purchase), o)
        // Nothing more owed: what the backend had to say goes on the receipt's
        // screen, and a card not used is said as what became of it, as the
        // screen for what is still owed says it.
        if (after.kind === 'done') {
          const line = out.line ?? (o === 'not_used' ? owedLine('not_used', out.kept, phase.purchase.rail) : null)
          const said = [line, out.note].filter((x): x is string => x !== null).join(' ')
          if (said !== '') setNotice(said)
        }
        sayingMore(phase.purchase.rail, [out.line, out.note])
        setPhase(after)
        // The card they were told not to scan is their store credit now, and it pays the rest: shown at once, with why.
        if (after.kind === 'owed' && owedStartsAtOnce(out, o)) await payOwedOf(after, CREDIT_PAYS_REST)
      }),
    [phase, backends, run, keep, sayingMore, payOwedOf],
  )

  /** The register total changed while a code is on screen. */
  const changeTotal = useCallback(
    (totalCents: number) =>
      run(async () => {
        if (phase.kind !== 'scan') return
        const out = await backends[phase.purchase.rail].changeTotal(phase.purchase, totalCents)
        replaced(phase.purchase, out.purchase)
        if (out.owed !== null && 'unavailable' in out.owed) setError(out.owed.unavailable)
        setPhase(phaseAfterChange(phase.code, out))
      }),
    [phase, backends, run, replaced],
  )

  /** "Pay $X more", tapped. */
  const payOwed = useCallback(
    () =>
      run(async () => {
        if (phase.kind !== 'owed') return
        await payOwedOf(phase)
      }),
    [phase, run, payOwedOf],
  )

  /** After Done: something went wrong with a card, inside its window. The note says it was taken. Asked of the rail that paid it. */
  const reportAfter = useCallback(
    async (purchase: PurchaseHandle, scanIndex: number, o: 'empty' | 'problem'): Promise<string> => {
      const out = await backends[purchase.rail].report(purchase, scanIndex, o)
      keep(purchase, out.receipt)
      sayingMore(purchase.rail, [out.note])
      return out.note ?? 'Got it.'
    },
    [backends, keep, sayingMore],
  )

  const startOver = useCallback(() => {
    purchases.current = []
    holdKey(null)
    requotedFor.current = null
    setReceipts(new Map())
    setCents(0)
    setError(null)
    setNotice(null)
    setPhase({ kind: 'keypad' })
  }, [holdKey])

  return {
    cents,
    setCents,
    quote,
    /** What the Pay button pays now: a kept key's plan, else the price on it. */
    plan: buttonPlan,
    keptPay,
    /** The way the keypad prices and pays now. */
    rail: active,
    phase,
    method,
    checkMethod,
    error,
    notice,
    busy,
    unfinished,
    resumeUnfinished,
    receipt: sumReceipts(receipts.values()),
    pay,
    next,
    done,
    scannedThenPay,
    report,
    changeTotal,
    payOwed,
    reportAfter,
    startOver,
  }
}
