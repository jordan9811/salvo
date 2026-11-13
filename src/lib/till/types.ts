/**
 * The till's one interface (unified-account spec 5.1): every screen of
 * /pay/[store] talks to this, whichever rail pays.
 *
 * ===========================================================================
 * ONE INTERFACE, TWO BACKENDS. The card rail is a set of fetches to
 * /api/card/till/* (client/card-backend.ts): our server holds the shopper's
 * card and opens each code. The dollars rail is the phone itself paying
 * SalvoEscrowV2 and drawing each code from Lit (client/dollars.ts, on
 * src/lib/escrow/client/dollars-backend.ts): the value used and the deposit
 * on the last card's leftover in one batch, with no prompt. The screens
 * cannot tell them apart, so the keypad, the "Scan 1 of 2" screens and every
 * sentence are written once.
 * ===========================================================================
 *
 * Pure: types only, so both rails and every screen may import it.
 */

import type { RoutePreference } from '../route/plan'

export type { RoutePreference }

export type Rail = 'card' | 'stablecoin'

/** Where a card in a plan came from. */
export type LegSource = 'own_credit' | 'remainder' | 'fresh'

/** One card of a plan, as the screens show it. */
export interface Leg {
  /** An opaque name for this card within the plan. Never a listing id. */
  ref: string
  source: LegSource
  /** A card that was waiting first in line: a remainder, or a card another shopper said did not scan. */
  firstInLine: boolean
  /** What the card held as planned. */
  faceCents: number
  /** What it covers at the register. */
  appliedCents: number
  /** What the shopper pays for that. */
  costCents: number
  /** What stays on it for the next shopper. Non-zero on the last card only. */
  leftoverCents: number
  /** The deposit held against that leftover, at face. */
  depositCents: number
  /** Its place in the scan order, from 1, of `scanOf`. */
  scanIndex: number
  scanOf: number
}

/** A priced plan for one total at one store. */
export interface RoutePlan {
  rail: Rail
  merchant: string
  totalCents: number
  /** In scan order. */
  legs: Leg[]
  costCents: number
  savingCents: number
  depositCents: number
  /**
   * Always 0. A plan covers the whole total or is not offered: the shopper
   * rejected paying the rest another way (spec section 4's "then $X your
   * usual way" is not built).
   */
  uncoveredCents: number
  preference: RoutePreference
  /** Opaque to the screens. The card rail plans again at Pay and ignores it. */
  quoteRef: string
  expiresAt: string
}

/** No plan for a total, in the till's own sentence. */
export interface Unavailable {
  unavailable: string
  /** Nothing is listed at this store at all, whatever the total. */
  nothingListed?: boolean
}

/** One card's code, ready to scan. */
export interface LegCode {
  scanIndex: number
  scanOf: number
  /** What this card covers at the register. */
  coversCents: number
  /** What the register leaves on it. */
  leftoverCents: number
  /**
   * The deposit standing behind that leftover, at face. Only a leftover with
   * one goes to the next shopper; one too small for a deposit is not sold
   * again, so the screen does not say it stays for anyone.
   */
  depositCents: number
  /** The payload the store's barcodes encode. */
  barcode: string
  /** The store's own 2D code, drawn by the server, or null. */
  pdf417: string | null
  /** When this code's window closes. */
  expiresAt: string
  /** A store nobody can check: no answer counts as the code having worked. */
  silenceIsSale: boolean
}

/** A paid plan, with the first card's code. */
export interface Purchase {
  rail: Rail
  /** Opaque to the screens: the backend's own handle on the purchase. */
  ref: string
  plan: RoutePlan
  /** Leg 1's code. Later codes come one at a time, from `next`. */
  code: LegCode
  /**
   * Dollars: a purchase opened again after its page went (a reload, a
   * closed tab) whose total had changed on that page, or whose card on
   * screen must not be scanned: how that card stood there, as a new total
   * answers it, so the till shows it so (not to be scanned, or with the
   * rest to pay under it), never as a plain code to scan. Left out: the
   * code as drawn. Never kept on the phone (a handle is kept by its own
   * fields only).
   */
  standing?: Standing
}

/** How the card on screen stands after a new total: what ChangeAnswer says beside the purchase. */
export type Standing = Omit<ChangeAnswer, 'purchase'>

/**
 * A purchase without its code: what the phone keeps once a code is off
 * screen, and all a report needs. A code is a gift card number, shown inside
 * its window and never kept (client/recent.ts). Nor how its card stood on a
 * screen that went: that is said once, as the purchase comes back.
 */
export type PurchaseHandle = Omit<Purchase, 'code' | 'standing'>

/**
 * What the shopper says went wrong.
 *
 *   didnt_scan, declined  the code on screen did not work at the register
 *   not_used              the code on screen is not to be scanned: the total
 *                         came down past what can stay on the card
 *   empty                 a remainder already settled turned out empty,
 *                         inside its two hours
 *   problem               anything else about a card already settled, inside
 *                         48 hours: a person looks at it
 */
export type ReportOutcome = 'didnt_scan' | 'declined' | 'not_used' | 'empty' | 'problem'

/** How a rail can pay right now. */
export interface PaymentMethod {
  ready: boolean
  /** "Visa •••• 4242", or the rail's own label. */
  label: string
  /** The most this rail can pay now, in cents. */
  spendableCents: number
  /** Why it cannot pay, in a sentence for the screen, or null. */
  problem: string | null
  /**
   * False when the rail could not be asked (a dropped connection, a processor
   * that did not answer): then `ready` says nothing either way, the screen
   * asks again, and Pay stays open for the server to decide.
   */
  checked: boolean
  /**
   * Set up on this account, whether or not it can pay this minute: a key for
   * the escrow the till pays on, a saved card. The till picks a rail by it
   * when neither can pay, so the shopper is told what is wrong with the way
   * they set up, and while a rail could not be checked (settings.ts
   * tillRail). Left out: not known.
   */
  setUp?: boolean
}

/** The end of a purchase. */
export interface TillReceipt {
  /** Taken for the cards that worked, deposits taken for them included. */
  paidCents: number
  savedCents: number
  /** The deposit still held for the next shopper, or 0. */
  depositCents: number
  /**
   * Still held, not taken, for a card that did not work at a store nobody
   * can check: until the next shopper tries it, or a person checks it.
   */
  keptCents: number
  /**
   * Dollars: paid at the tap for cards the register did not take that are
   * the shopper's store credit (or will be, once the chain takes them), as
   * far as it is not spent since. Never in paidCents or savedCents.
   */
  creditPaidCents?: number
  /**
   * Dollars: paid at the tap for cards reported as not working, which their
   * sellers can refund. Never in paidCents or savedCents.
   */
  disputedCents?: number
  /** Something the receipt must say beside the sums: a card the register did not need that is not store credit yet, say. */
  note?: string
}

/** What is still owed after a card failed or the total changed: a plan, why there is none, or null when nothing is. */
export type Owed = RoutePlan | Unavailable | null

/**
 * A card that did not work, whose hold is kept rather than released
 * (barcode/unscanned.ts), until the next shopper's scan shows the truth.
 */
export interface KeptHold {
  cents: number
  until: 'next_shopper'
}

/** What a report came to. */
export interface ReportAnswer {
  owed: Owed
  /** What the register still needs after the cards that worked: what `owed` plans, or what nothing covers. */
  owedCents: number
  /** What the purchase came to so far. */
  receipt: TillReceipt
  /** The hold kept for the card reported, or null when it was released or there was none. */
  kept: KeptHold | null
  /**
   * A sentence saying the report was taken, for a card already settled; for
   * the card on screen, anything more the shopper must know (a later card
   * not store credit yet). Null when there is none.
   */
  note: string | null
  /**
   * For the card on screen: what became of it, in place of the till's own
   * sentence, when that would not be true (the shopper's own card did not
   * work, a report not on the chain yet). Null, or left out: the till's own.
   */
  line?: string | null
}

/** What catchUp sent: cards made store credit, reports that landed, and what still waits. */
export interface CatchUpOutcome {
  kept: number
  reported: number
  waiting: number
  /** What the shopper must be told: a card kept for less than it held, or one that could never be kept. Left out when nothing. */
  said?: string[]
}

/** A Pay sent from the till that may have gone through and never finished on this phone: asked again with its own key, never paid afresh. */
export interface UnfinishedPay {
  key: string
  store: string
  /** The plan it was sent with: "Check it" sends it again with the key, to its rail. */
  plan: RoutePlan
  at: number
  /**
   * Dollars: it went through, and its page went (a reload, a closed tab)
   * with this card of it on screen. Asked again with its key, it comes back
   * on that card. Left out: a Pay that may not have gone through.
   */
  open?: { shown: number; scanOf: number }
}

/** The plan cost more than the button said when Pay planned it again: nothing was held, and this is the new price. */
export interface Requote {
  requote: RoutePlan
  message: string
}

/**
 * A tap asked about again whose purchase had already ended: settled, with no
 * code left to show. Its handle comes back all the same, so the phone keeps
 * it for Account and its receipt, and what it came to.
 */
export interface EndedPurchase {
  ended: PurchaseHandle
  receipt: TillReceipt
  message: string
}

/** What the card on screen covers now, after a new total. Its code is unchanged. */
export type LegCover = Pick<LegCode, 'scanIndex' | 'coversCents' | 'leftoverCents' | 'depositCents'>

/** What a new total came to. */
export interface ChangeAnswer {
  purchase: Purchase
  owed: Owed
  /** The card on screen as it now stands, or null when no code is on screen any more. */
  cover: LegCover | null
  /** The total came down by more than can stay on the card on screen: it must not be scanned. */
  tooLow: boolean
  /** Too low, and the cards before it already cover the new total: nothing more is needed. */
  notNeeded: boolean
}

export interface TillBackend {
  readonly rail: Rail
  method(): Promise<PaymentMethod>
  quote(a: { merchant: string; totalCents: number; preference: RoutePreference }): Promise<RoutePlan | Unavailable>
  /**
   * Dollars: fetch tickets for the planned cards. Card: nothing. `tap`: the
   * tap is waiting on it now (dollars marks how long), not the keypad.
   */
  prepare(plan: RoutePlan, opts?: { tap?: boolean }): Promise<void>
  /**
   * Pays the plan and returns leg 1's code, or the new price when the plan
   * now costs more than the button said (nothing is held then). `after`: the
   * purchase this one finishes, whose shown cards it leaves out ("Pay $X
   * more", "Add $X"). `key`: one per tap, sent again on a retry after no
   * answer came back, so the retry finds the purchase the first tap made
   * instead of paying twice. `resume`: only find what that key's tap did,
   * never pay afresh (a Pay whose page was closed before it answered). A tap
   * asked about again whose purchase has already ended is an EndedPurchase.
   */
  pay(plan: RoutePlan, opts?: { after?: Purchase; key?: string; resume?: boolean }): Promise<Purchase | Requote | EndedPurchase>
  /** The card at `scanIndex` scanned: settle it, and return the next card's code. */
  next(p: Purchase, scanIndex: number): Promise<LegCode>
  /** The card at `scanIndex` was the last one the register needed. */
  done(p: Purchase, scanIndex: number): Promise<TillReceipt>
  /** Something went wrong with the card at `scanIndex` (see ReportOutcome). */
  report(p: PurchaseHandle, scanIndex: number, o: ReportOutcome): Promise<ReportAnswer>
  /** The register total changed after Pay: the purchase as it stands, the card on screen, and what is still owed. */
  changeTotal(p: Purchase, totalCents: number): Promise<ChangeAnswer>
  /** What the purchase came to, as it stands now: a card settled by silence, after the phone stopped asking, included. */
  receipt(p: PurchaseHandle): Promise<TillReceipt>
  /**
   * Send what this account's purchases still owe the chain from this phone
   * (dollars: a card to keep as store credit, a report that did not land).
   * Called as the till and Account open. Pays for nothing. The card rail
   * keeps nothing on the phone to send, and has none.
   */
  catchUp?(): Promise<CatchUpOutcome>
  /**
   * Dollars: this account's Pays that may have gone through and never
   * finished on this phone, found in its own book, so a key lost with a
   * sign-out still leads back to them. The card rail asks our server by the
   * key, and has none.
   */
  unfinishedPays?(): Promise<UnfinishedPay[]>
}
