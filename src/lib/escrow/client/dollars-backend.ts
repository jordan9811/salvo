/**
 * The dollars rail as the till sees it: SalvoEscrowV2 behind the till's one
 * interface (unified spec section 5.1: src/lib/till/types.ts), so the till's
 * screens plug it in and draw it exactly as they draw the card rail. Tap,
 * type, pay, scan: the same keypad, the same "Scan 1 of 2", the same words.
 *
 * WHAT THE TILL'S SCREENS COUNT ON (src/app/pay/[store]/use-till.ts), and
 * this backend holds to each:
 *   - prepare is called once the total has stopped changing, while the
 *     shopper's finger is still on the keypad, and again at the tap; the
 *     second finds the first done (or waits for it), so the tap only signs
 *     and sends;
 *   - Pay sends a key, one per tap, kept on the phone before it is sent. A
 *     payment this phone signed and the chain has not settled is "still
 *     going" (refused.ts STILL_GOING): the key is kept, and the next tap with
 *     it finds this purchase by its key and finishes it, never pays again;
 *   - once the total changes, the code on screen is the purchase's last: the
 *     till shows only Done on it, settles it with done(), and pays what is
 *     still owed as a new purchase;
 *   - a report after Done, from the till or from Account for 48 hours, names
 *     the purchase by its handle alone: the handle and this phone's book are
 *     all it needs, whatever page the purchase was made on.
 *
 * WHAT IT DOES, AND IN WHAT ORDER (spec sections 5.3, 5.4 and 6.2):
 *   - quote: the shopper's own store credit at that store first, at no cost,
 *     oldest first (credit-v2.ts: /account's list, the signed-in account's
 *     only); the rest from the till's planner over V2 supply (our server's
 *     planTill), checked here card by card against the chain (load-v2.ts),
 *     and against what this phone may still spend this week. A plan covers
 *     the whole total or is not offered, and a card limit filled by the
 *     shopper's own credit never refuses one: fewer of their own cards are
 *     used, as route/plan.ts does. A leftover bought whole is scanned before
 *     the shopper's own credit (#plan says why).
 *   - prepare: one ticket per card, the chain read they were checked at, and
 *     the one batch filled from the hosts; a new total on the same cards
 *     keeps the tickets and fills the batch again.
 *   - pay: one batch, no prompt: the value used and the deposit on the last
 *     card's leftover, approved and paid together. Every card is paid and
 *     opened before the first code is drawn; card 2 is handed over on Next.
 *   - done: the register needed no more cards. A later card is paid but
 *     never drawn: it is kept as the shopper's store credit (keepRest when
 *     cents were left on it for the next shopper), said on the receipt, and
 *     the credit names the sale it came from, so a report about it later is
 *     a report on that sale. One the chain does not take now is kept on its
 *     purchase (pendingKeeps) and asked again, soon while the till is open
 *     and whenever the till or Account opens (catchUp), and the receipt says
 *     so, never that it is credit already. One whose rest went to someone
 *     else meanwhile is kept at what this sale paid for, and said.
 *   - done with a card: once the till moves past a card that leaves cents
 *     for the next shopper (Next past it, Done, "Register says paid"), the
 *     phone tells our server, with the proof that card's reply key signed
 *     when it was opened (done-proof-v2.ts), and the leftover goes on sale
 *     at once instead of resting two hours (till-quote-v2.ts restingV2).
 *     Never waited on: Next and Done answer first, and a proof that does not
 *     land leaves the two-hour rest, as before. Never for a card the register
 *     may not have taken (never drawn, reported, kept, or bought whole).
 *   - the receipt: covered and saved are only what the register took. A
 *     card reported as not working and what is still store credit of a card
 *     it did not take were paid at the tap too, and are said apart.
 *   - report: on the card on screen, "it didn't scan" and "declined" are a
 *     dispute (the payout waits for the seller to refund), and "not used"
 *     (the total came down past what the card may keep) makes it the
 *     shopper's credit; the later cards are kept as credit, and what is still
 *     owed is planned again, those cards first. After Done, "that card was
 *     empty" on another shopper's leftover is a contest inside its two hours
 *     (the money back at once, their deposit to the seller) and a dispute
 *     after; anything else is a dispute. Each report is kept on its purchase
 *     from the tap (records-v2.ts pendingReports) and sent on its own at once;
 *     one that does not land is sent again whenever the till or Account opens
 *     (catchUp), and until it lands the screen says it has not, never that
 *     the seller's payment waits.
 *   - a tap asked again by its key is rebuilt from the purchase it made (the
 *     plan it paid, kept on the record), never from the plan the retry sent:
 *     the keypad prices again after a Pay that did not finish, and that plan
 *     names other cards, or another total. And once this phone keeps a
 *     purchase under a key, no refusal ends the key: only a purchase the
 *     chain never took is over.
 *   - changeTotal: the cards after the one on screen are closed first, as
 *     for done. Up: what is on the card on screen beyond what it covers goes
 *     first, as a register takes it (its leftover bought out of its deposit,
 *     or the shopper's own card's balance), then a plan for the rest, those
 *     closed cards first. Down: the card on screen covers less (reduceUse
 *     while its new leftover fits the cap, the shopper's own credit given
 *     back, or more left as credit on a card bought whole); past the cap it
 *     must not be scanned (tooLow), and "not used" then makes it the
 *     shopper's credit.
 *   - unfinishedPays: a Pay of this account's that may have gone through
 *     and never finished on this phone, found in the V2 book by its tap's
 *     key, so a key the till kept and lost with a sign-out still leads back;
 *     and a purchase that went through whose screen went with a card
 *     showing, offered again on that card.
 *   - a reload never loses a card the shopper paid for. Each till purchase
 *     is kept on the phone as it stands on screen (records-v2.ts
 *     TillScreenV2: the plan, the card showing, finished or not, changed by
 *     a new total or not), one paid wholly from store credit included,
 *     before any credit comes off it. Asked again by its key, it comes back
 *     on the card that was showing, as it stood there (Purchase.standing):
 *     a card the shopper was told not to scan comes back as that, and the
 *     rest still owed under a card is planned again. Left PARK_AFTER_MS
 *     with nobody on it, catchUp makes every card it never drew the
 *     shopper's store credit, and a card they were told not to scan too,
 *     well before its leftover rests out (quote-v2.ts LEFTOVER_REST_MS) and
 *     could be another shopper's.
 *   - a tap's key finds only this account's purchase. The V2 book outlives
 *     a sign-out, and a till tab still holding the first account's key or
 *     its "Show it" drew that account's codes for whoever signed in next.
 *   - signed out, it stops. Every move asks the phone's store first who is
 *     signed in (#stillSignedIn): once the account this till opened with is
 *     not, it pays nothing, opens no purchase and sends nothing, and
 *     src/lib/till/client/dollars.ts opens a new one for whoever is.
 *
 * Browser only by use; imports nothing Node-only, and nothing that touches
 * the card rail. Never logs a card or key, and hands the till a card only as
 * the store's barcode payload.
 */

import type { Hex } from 'viem'
import { MERCHANT_BARCODE_PROFILES } from '@/lib/barcode/merchants'
import type { TapStep } from '@/lib/till/timing'
import { STILL_GOING, TillRefused } from '@/lib/till/client/refused'
import type {
  CatchUpOutcome,
  ChangeAnswer,
  EndedPurchase,
  Leg,
  LegCode,
  LegCover,
  Owed,
  PaymentMethod,
  Purchase,
  PurchaseHandle,
  ReportAnswer,
  ReportOutcome,
  Requote,
  RoutePlan,
  RoutePreference,
  Standing,
  TillBackend,
  TillReceipt,
  Unavailable,
  UnfinishedPay,
} from '@/lib/till/types'
import { UNITS_PER_CENT } from '../manifest'
import { ESCROW_MERCHANTS, MODE_BLIND, type EscrowMerchantName } from '../merchants'
import { LEFTOVER_REST_MS, type QuoteLegV2, type QuoteV2 } from '../quote-v2'
import { EscrowRpcError } from '../runbook/rpc'
import type { EscrowApiV2, EscrowPublicConfigV2 } from './api-v2'
import { cardBarcode, cardBarcodePayload, storeUsesPdf417 } from './barcode'
import type { CardSecret, CardStore } from './card-store'
import { keptOwnId, mirrorCreditToOwnV2, openTillCreditV2, setTillCreditBalanceV2, tillCreditV2, type OwnCardBook, type TillCreditV2 } from './credit-v2'
import { LoadPending, LoadRefused, type LoadStep } from './load'
import {
  cardIdV2,
  checkQuoteV2,
  discardPreparedV2,
  executeLoadV2,
  fillBatchV2,
  prepareLoadV2,
  quoteTillV2,
  resumePurchaseV2,
  reusePreparedV2,
  sameCardsV2,
  unfinishedPurchasesV2,
  type CheckedQuoteV2,
  type LoadDepsV2,
  type PreparedLoadV2,
  type TillAskV2,
} from './load-v2'
import {
  dropPendingKeep,
  notePendingKeep,
  notePendingReport,
  type BatchedAction,
  type CreditRecordV2,
  type DeviceBookV2,
  type PendingKeepV2,
  type PurchaseLegV2,
  type PurchaseRecordV2,
  type TillScreenV2,
} from './records-v2'
import {
  buyRestV2,
  keepCardV2,
  keepPaidV2,
  KEEP_REST_SENTENCE,
  reduceUseV2,
  reportActionV2,
  SaleRefused,
  sendPendingReportsV2,
  sendReportV2,
  type PendingReportsOutcome,
  type SaleDepsV2,
} from './sale-v2'
import { spendableUnits, type ChainAccess, type DeviceWallet } from './wallet'
import { keyScopedForV2 } from './wallet-v2'

export interface DollarsBackendDeps {
  store: CardStore
  book: DeviceBookV2
  api: EscrowApiV2
  config: EscrowPublicConfigV2
  access: ChainAccess
  /** The shopper's access key, or null when this phone has none yet. */
  wallet: DeviceWallet | null
  /**
   * /account's store credit (card-store.ts ownCards, ownCardSecret,
   * saveOwnCard: the CardStore is one). Given, it is the one list both rails
   * use, and every card this rail makes the shopper's is added to it. Null:
   * V2's own credit records are the list.
   */
  ownCards?: OwnCardBook | null
  /** "Use my store credit first" (spec section 3.1 settings). On unless the shopper turned it off. */
  ownCreditFirst?: boolean
  /**
   * The account signed in on this phone (its passkey address): only its V2
   * store credit is the till's, and only its purchases are caught up. Left
   * out, the access key's account; null, nobody's.
   */
  account?: Hex | null
  onStep?: (s: LoadStep) => void
  /** Each step of the tap, timed (scripts/till-timing.ts). */
  onMark?: (step: TapStep, ms: number) => void
  sleep?: (ms: number) => Promise<void>
  /** The clock, ms: how long a purchase has been left on a screen nobody opens. Left out, the phone's. */
  now?: () => number
}

/** One card of the shopper's own credit in a plan. */
interface OwnLeg {
  credit: TillCreditV2
  appliedCents: number
}

/** Where one card of a plan comes from: the shopper's own credit, or a card the V2 batch buys, by its place in that batch. */
type Slot = { kind: 'own'; own: OwnLeg } | { kind: 'v2'; scanOrder: number }

const ownOf = (slots: readonly Slot[]): OwnLeg[] => slots.flatMap((s) => (s.kind === 'own' ? [s.own] : []))

interface PlanContext {
  /** What the V2 cards were asked to cover, or null when the plan buys none. */
  ask: TillAskV2 | null
  quote: QuoteV2 | null
  /** The chain check this phone made of the quote as it priced it: the prepare uses it while it is young. */
  checked: CheckedQuoteV2 | null
  prepared: PreparedLoadV2 | null
  /** A prepare going on now: a second call waits for it rather than asking Lit twice. */
  preparing: Promise<void> | null
  /** Why preparing found the plan no longer buyable (a card used since, say): Pay plans again. Nothing was charged. */
  stale: LoadRefused | null
  /** The plan's cards in scan order, each with where it comes from. */
  slots: Slot[]
  /** When the tap first asked for this plan, ms, and whether its wait for the prepare is marked yet (ticket_wait). */
  tapAt: number | null
  waitMarked: boolean
}

/** A prepare going on, and the plan it is for: a new total on the same cards waits for its tickets. */
interface Flight {
  ctx: PlanContext
  done: Promise<void>
}

/** What a code is drawn from: the plan as it stands, its cards, and when it was paid. */
interface Paid {
  plan: RoutePlan
  slots: Slot[]
  record: PurchaseRecordV2 | null
  /** When it was paid, ms: each code's window runs from here. */
  paidAt: number
}

interface PurchaseContext extends Paid {
  handle: PurchaseHandle
  /** Sentences for the shopper not said yet: a card the register did not need that is not their credit yet, say. */
  notes: string[]
  /** Cards settled for good: reported, or kept as credit after the register needed no more. */
  closed: Set<number>
  /** The last card whose code was drawn: the one on screen, until the purchase is finished. */
  shown: number
  /** Done, or the card on screen reported: no more codes are drawn from it, and a report now is about a card the register took. */
  finished: boolean
  /** card-store.ts ids of the cards it bought and left the shopper's, never drawn: what is planned again uses them first. */
  kept: string[]
  /** The reports made from it: pay() sends again any the chain does not have yet. */
  reports: BatchedAction[]
  /**
   * Cards on screen, by place, bought whole after the total went up (their
   * rest bought out of the deposit, so nobody is sold what the register
   * takes): what the register leaves on one is the shopper's credit.
   */
  whole: Set<number>
  /**
   * Cards kept as the shopper's credit while a card they were told not to
   * scan is on screen, not said yet: "not used" next plans what is owed on
   * them first, so they are said then, or not at all (#sayKept).
   */
  unsaid: KeptCard[]
  /** Paid or opened again on this screen: kept on the phone as it changes (TillScreenV2). One rebuilt from a handle (Account) is not. */
  onScreen: boolean
  /** A new total changed it on screen: opened again, the rest its cards leave of that total is planned again under the card (standingOf). */
  changed: boolean
}

interface PlanOptions {
  /** Credit the plan may not use: a card that just failed. */
  skip?: ReadonlySet<string>
  /** Listings it may not use. */
  exclude?: readonly string[]
  /** card-store.ts ids of credit it uses first, whatever "use my store credit first" says: cards bought for this total and never drawn. */
  first?: readonly string[]
}

const NOT_SET_UP = 'Allow this phone to pay with dollars in Account: one Face ID.'
const NEW_ESCROW = 'Salvo Pay has a new escrow. Allow this phone to spend on it in Account: one Face ID.'
const COULD_NOT_CHECK = 'We could not check your dollars just now.'
const LABEL = 'dollars'
/** Said when a lower total is more than the shopper's own cards at the end can give back. */
const TOO_LOW = 'The total came down more than this card covers, so it cannot change here. Tell us from your receipt.'
/** The payment may have gone through: the key is kept, and the next tap finishes it. */
const MAY_HAVE_PAID = 'We could not tell if that went through. Tap Pay again: you will not pay twice.'
/** Paid, or maybe paid, and the cards not on this phone yet: the same tap again finishes it. */
const STILL_FINISHING = 'Your payment may have gone through, and your cards are not on this phone yet. Tap Pay again in a moment: you will not pay twice.'
/** Asked again with a key whose tap never signed anything. */
const NEVER_LEFT = 'That Pay never left this phone, so nothing was charged. Type the total and pay again.'
const CARD_TAKEN = 'Another shopper just used one of those cards.'
/** A card the register did not need, that the chain did not make the shopper's yet. */
const KEEP_LATER = 'A card the register did not need is not in your store credit yet. Salvo asks again each time you open the till or Account.'
/** The card on screen not used, and the chain did not make it the shopper's yet. */
const NOT_USED_LATER = 'That card was not used. It goes into your store credit once the chain takes it: Salvo asks again each time you open the till or Account.'
/** The shopper's own card did not work: nothing was bought, and it is still theirs. */
const OWN_FAILED = 'That card did not work. Nothing was charged for it, and it is still in your store credit.'
/** A report on the card on screen that did not reach the chain yet: until it does, nothing holds the seller's payment. */
const REPORT_LATER = 'That card did not work. Your report has not reached the chain yet. It is saved on this phone and sent again each time you open the till or Account.'
/** The rest of the card on screen could not be bought just now, so the total stays as it was: asked again by the same tap. */
const CHANGE_LATER = 'We could not change the total just now. Nothing more was paid. Try the new total again.'
/** A card the purchase paid for and the register did not scan, made the shopper's: said, since the receipt counts what it cost. */
const keptNote = (at: number, balanceCents: number): string => `Card ${at} was not scanned. Its ${dollarsOfCents(balanceCents)} is in your store credit now.`
/** What the register left on a card bought whole after the total went up. */
const restNote = (at: number, balanceCents: number): string => `Card ${at} has ${dollarsOfCents(balanceCents)} left on it. It is in your store credit now.`
/** An unfinished Pay is offered again for as long as its purchase handle acts. */
const UNFINISHED_MS = 48 * 3_600_000
/**
 * A purchase whose page went with a card on screen is offered again, on that
 * card, while its leftover still rests (quote-v2.ts LEFTOVER_REST_MS): after
 * that the rest of its last card may be another shopper's.
 */
const OPEN_OFFER_MS = LEFTOVER_REST_MS
/**
 * Left that long with nobody on its screen, every card such a purchase never
 * drew becomes the shopper's store credit when the till or Account opens,
 * well before its leftover can go to anyone else.
 */
const PARK_AFTER_MS = 15 * 60_000
/** A till tap paid wholly from store credit, kept with nobody signed in on this phone: found again by its key alone. */
const NOBODY = '0x0000000000000000000000000000000000000000' as Hex
const ENDED = 'That Pay already went through. It is in Account.'
/** The account this till was opened for signed out of this browser, or another took its place (#stillSignedIn). */
const SIGNED_OUT = 'The account this till opened with is not signed in on this browser any more, so it pays nothing here. Open the till again.'
/** A purchase another account made on this phone: never opened by this one. */
const NOT_THIS_ACCOUNT = 'That purchase was made by another account, not the one signed in here.'
/** A purchase opened again whose rest could not be planned just now: the card stays on screen, and a new total plans it. */
const REST_LATER = 'We could not price the rest of the total just now. Nothing more was paid. Try the new total again.'
/** Cards a purchase left on a screen nobody opened never drew, now the shopper's: said once. */
const parkedLine = (store: string, n: number): string =>
  n === 1 ? `At ${store}, a card your last purchase did not show is in your store credit now.` : `At ${store}, ${n} cards your last purchase did not show are in your store credit now.`
/** The card a purchase left on screen marked not to be scanned, made the shopper's: said once. */
const parkedNotUsedLine = (store: string): string => `At ${store}, the card you were told not to scan is in your store credit now.`
/** How long a code stays on the phone: the report window (spec section 5.3 step 3). */
const CODE_WINDOW_MS = 48 * 3_600_000
/** A card's "done" is sent this many times at most while the till is open, waiting longer each time. */
const DONE_TRIES = 3
const DONE_PAUSE_MS = 2_000
const centsOf = (units: bigint | number): number => Math.ceil(Number(units) / UNITS_PER_CENT)
const dollars = (units: bigint): string => `$${(Number(units) / UNITS_PER_CENT / 100).toFixed(2)}`
const dollarsOfCents = (cents: number): string => `$${(cents / 100).toFixed(2)}`
/** A send that did not happen or may not have: the report stays kept on its purchase, to be sent again. */
const notSent = (err: unknown): boolean => err instanceof SaleRefused || err instanceof EscrowRpcError || err instanceof LoadRefused
/**
 * The plan went stale between the quote and the tap (a card used by another
 * shopper since), with nothing charged: Pay offers the new price. Any other
 * refusal is said as it is: planning again would only pick the same card.
 */
const staleCodes: ReadonlySet<string> = new Set(['not_for_sale'])

function randomRef(prefix: string): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(12))
  return `${prefix}_${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`
}

const isMerchant = (m: string): m is EscrowMerchantName => Object.prototype.hasOwnProperty.call(ESCROW_MERCHANTS, m)

/** The store as the till names it: "Target", never its id. */
function storeName(m: string): string {
  if (m === 'salvotest') return 'the Salvo test store'
  return MERCHANT_BARCODE_PROFILES[m as keyof typeof MERCHANT_BARCODE_PROFILES]?.displayName ?? m
}

const lowerHex = (s: string): string => s.toLowerCase()

/** A card of credit known only by the plan's ref: what a purchase opened again from its handle has for a card since used up. */
function creditByRef(ref: string): TillCreditV2 {
  const ownId = ref.startsWith('own:') ? ref.slice(4) : null
  const creditId = ref.startsWith('v2:') ? ref.slice(3) : null
  return { ref, balanceCents: 0, since: 0, ownId, creditId, cardId: null }
}

/** A bought card a purchase kept as the shopper's credit: its place in the purchase, and what is on it. */
interface KeptCard {
  at: number
  cardId: string
  balanceCents: number
}

/**
 * How much of a bought card is still the shopper's store credit, not yet
 * used: its credit's balance, up to what it held when it became theirs; or
 * what is to be kept, while the chain has not taken it yet; or nothing.
 */
function stillCredit(l: PurchaseLegV2, credit: CreditRecordV2 | undefined, keep: PendingKeepV2 | undefined): number {
  if (l.usedCents <= 0) return 0
  if (credit !== undefined) return Math.min(Math.max(0, l.usedCents - (credit.takenCents ?? 0)), Math.max(0, credit.balanceCents))
  return keep === undefined ? 0 : Math.max(0, l.usedCents - keep.takenCents)
}

/**
 * How the card on screen, the plan's last, stands against the plan's total,
 * as a new total leaves it (changeTotal): its cards covering more than the
 * total, it must not be scanned (tooLow), and nothing of it is needed when
 * the cards before it cover the total (notNeeded); covering less,
 * `owedCents` is still to pay.
 *
 * FROM THE PLAN ALONE. A paid plan covers its total exactly; only a total
 * that came down past what the card may keep leaves its cards covering
 * more. So the answer to a new total, and a screen opened again from the
 * phone, stand as the till showed them, whatever the phone kept beside the
 * plan. A refusal changes no plan, so a card not to be scanned stays so.
 */
function standingOf(plan: RoutePlan): { tooLow: boolean; notNeeded: boolean; owedCents: number } {
  const covered = plan.legs.reduce((n, l) => n + l.appliedCents, 0)
  const before = covered - (plan.legs[plan.legs.length - 1]?.appliedCents ?? 0)
  const tooLow = covered > plan.totalCents
  return { tooLow, notNeeded: tooLow && before >= plan.totalCents, owedCents: Math.max(0, plan.totalCents - covered) }
}

/**
 * The dollars rail on SalvoEscrowV2, as a TillBackend. One per till screen;
 * src/lib/till/client/dollars.ts opens the phone's session for it.
 */
export class DollarsBackendV2 implements TillBackend {
  readonly rail = 'stablecoin' as const
  readonly #d: DollarsBackendDeps
  readonly #plans = new Map<string, PlanContext>()
  readonly #purchases = new Map<string, PurchaseContext>()
  #lastPrepared: PreparedLoadV2 | null = null
  /** The last prepare started, while it runs: a new total on the same cards waits for it and uses its tickets. */
  #flight: Flight | null = null
  /** Each prepare's number, in the order they start. */
  #prepares = 0
  /** A prepare numbered below this lands for a total the screen left, on other cards: what it fetched is dropped, never used. */
  #dropBelow = 0
  /** card-store.ts ids of the cards whose "done" this page has sent (#doneWith): each once. */
  readonly #told = new Set<string>()

  constructor(d: DollarsBackendDeps) {
    this.#d = d
  }

  get #own(): OwnCardBook | null {
    return this.#d.ownCards ?? null
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now()
  }

  /** Whose V2 credit and purchases are this till's: the account signed in. */
  get #account(): Hex | null {
    return this.#d.account !== undefined ? this.#d.account : (this.#d.wallet?.account ?? null)
  }

  /** The depositor this till's purchases are kept under (#ownTap): the account, else its key's, else nobody. */
  #me(): Hex {
    return lowerHex(this.#account ?? this.#d.wallet?.account ?? NOBODY) as Hex
  }

  /**
   * Is the account this till was opened for still the one signed in on this
   * browser, with the key it was opened with? Asked before every move.
   *
   * A TILL LEFT OPEN MUST STOP WHEN ITS ACCOUNT SIGNS OUT. Everything here
   * was read once, as the page opened: the key, the account, its store
   * credit. Signing out in another tab (card-store.ts forgetAccount) took
   * them off the phone, and this page went on paying from that account's
   * dollars with the key still in its memory, and drew its store credit's
   * codes, for whoever used the tab next. The phone's store says who is
   * signed in now; anything else means this till pays nothing, opens no
   * purchase and sends nothing. A till opened with nobody signed in has no
   * account to protect: src/lib/till/client/dollars.ts opens a new one for
   * whoever signs in.
   */
  async #stillSignedIn(): Promise<boolean> {
    const me = this.#account
    if (me === null) return true
    const w = this.#d.wallet
    const [passkey, key] = await Promise.all([
      this.#d.store.passkey().catch(() => null),
      w === null ? Promise.resolve(null) : this.#d.store.accessKey(w.role).catch(() => null),
    ])
    if (passkey === null || lowerHex(passkey.address) !== lowerHex(me)) return false
    return w === null || (key !== null && lowerHex(key.accessKeyAddress) === lowerHex(w.accessKeyAddress))
  }

  async #refuseSignedOut(): Promise<void> {
    if (!(await this.#stillSignedIn())) throw new LoadRefused('unavailable', SIGNED_OUT)
  }

  #credit(merchant: EscrowMerchantName): Promise<TillCreditV2[]> {
    return tillCreditV2(this.#d.book, merchant, this.#own, this.#account)
  }

  #wallet(): DeviceWallet {
    const w = this.#d.wallet
    if (w === null || !keyScopedForV2(w, this.#d.config.escrow)) throw new LoadRefused('unavailable', NOT_SET_UP)
    return w
  }

  #loadDeps(): LoadDepsV2 {
    const d = this.#d
    return {
      store: d.store,
      book: d.book,
      api: d.api,
      config: d.config,
      access: d.access,
      wallet: this.#wallet(),
      ...(d.sleep ? { sleep: d.sleep } : {}),
      ...(d.onMark ? { onMark: d.onMark } : {}),
    }
  }

  #saleDeps(): SaleDepsV2 {
    const d = this.#d
    return { store: d.store, book: d.book, config: d.config, access: d.access, wallet: this.#wallet() }
  }

  /** What this phone may still put into the escrow this week, in token units: the allowance and the balance, less fee headroom. */
  async #spendable(w: DeviceWallet): Promise<{ units: bigint; balance: bigint; problem: string | null }> {
    const [allowance, balance] = await Promise.all([w.allowance(this.#d.access.hosts), w.balance(this.#d.access.hosts)])
    if (allowance.ended) return { units: 0n, balance, problem: 'The allowance on this phone has ended. Set it up again in Account to pay with dollars.' }
    return { units: spendableUnits(balance, allowance, this.#d.access.sponsorUrl !== null), balance, problem: null }
  }

  async method(): Promise<PaymentMethod> {
    if (!(await this.#stillSignedIn())) return { ready: false, label: LABEL, spendableCents: 0, problem: SIGNED_OUT, checked: true, setUp: false }
    const w = this.#d.wallet
    if (w === null) return { ready: false, label: LABEL, spendableCents: 0, problem: NOT_SET_UP, checked: true, setUp: false }
    if (!keyScopedForV2(w, this.#d.config.escrow)) return { ready: false, label: LABEL, spendableCents: 0, problem: NEW_ESCROW, checked: true, setUp: false }
    try {
      const { units, balance, problem } = await this.#spendable(w)
      const spendableCents = Math.floor(Number(units) / UNITS_PER_CENT)
      const empty = problem === null && spendableCents === 0 ? 'There are no dollars on this phone to spend. Add some in Account.' : null
      return {
        ready: problem === null && empty === null,
        label: `dollars (${dollars(balance)})`,
        spendableCents,
        problem: problem ?? empty,
        checked: true,
        setUp: true,
      }
    } catch (err) {
      if (!(err instanceof EscrowRpcError)) throw err
      return { ready: false, label: LABEL, spendableCents: 0, problem: COULD_NOT_CHECK, checked: false, setUp: true }
    }
  }

  /**
   * Plan `totalCents` at `merchant`: own credit first, then V2 cards, the
   * whole total or nothing. `skip` leaves out credit the plan may not use (a
   * card that just failed); `exclude` leaves out listings; `first` is credit
   * used first whatever the setting.
   *
   * A CARD LIMIT FILLED BY THE SHOPPER'S OWN CREDIT NEVER REFUSES A PURCHASE.
   * With "use my store credit first", two small credits could fill a limit of
   * two cards and leave a total there were cards on sale for unpaid. So when
   * their own cards leave something owed, fewer of them are used, the newest
   * left out first, until a bought card fits beside them (route/plan.ts does
   * the same on the card rail's planner).
   */
  async #plan(merchant: string, totalCents: number, preference: RoutePreference, o: PlanOptions = {}): Promise<RoutePlan | Unavailable> {
    if (!isMerchant(merchant)) return { unavailable: 'Salvo Pay does not sell cards for that store.' }
    if (!Number.isSafeInteger(totalCents) || totalCents < 1) return { unavailable: 'Type the total first.' }
    const skip = o.skip ?? new Set<string>()
    const first = o.first ?? []
    const exclude = o.exclude ?? []
    const ownAll: OwnLeg[] = []
    let rest = totalCents
    const credit = await this.#credit(merchant)
    // Cards a purchase bought for this total and never drew come first,
    // whatever the setting: they were bought for it. Then the rest of the
    // shopper's credit, oldest first, while "use my store credit first" is on.
    const isFirst = (c: TillCreditV2): boolean => c.cardId !== null && first.includes(c.cardId)
    const usable = [...credit.filter(isFirst), ...(this.#d.ownCreditFirst === false ? [] : credit.filter((c) => !isFirst(c)))]
    for (const c of usable) {
      if (rest === 0 || ownAll.length >= preference.maxCards) break
      if (skip.has(c.ref)) continue
      const applied = Math.min(rest, c.balanceCents)
      ownAll.push({ credit: c, appliedCents: applied })
      rest -= applied
    }
    let own = ownAll
    let owed = rest
    let quote: QuoteV2 | null = null
    let ask: TillAskV2 | null = null
    let checked: CheckedQuoteV2 | null = null
    let refused: Unavailable | null = null
    const notEnough: Unavailable = { unavailable: `There is not enough at ${storeName(merchant)} right now to cover ${dollarsOfCents(totalCents)}.` }
    const w = this.#d.wallet
    const keyed = w !== null && keyScopedForV2(w, this.#d.config.escrow)
    if (owed > 0 && keyed) {
      for (let n = Math.min(ownAll.length, preference.maxCards - 1); n >= 0; n--) {
        own = ownAll.slice(0, n)
        owed = totalCents - own.reduce((sum, x) => sum + x.appliedCents, 0)
        ask = {
          merchant,
          totalCents: owed,
          depositor: w.account,
          preference: { ...preference, maxCards: (preference.maxCards - n) as RoutePreference['maxCards'] },
          ...(exclude.length > 0 ? { exclude } : {}),
        }
        try {
          const q = await quoteTillV2({ api: this.#d.api }, ask)
          // The whole total or nothing: a part left to pay another way is not a plan this till offers.
          if (q.uncoveredCents > 0) {
            refused = notEnough
            continue
          }
          const [check, { units }] = await Promise.all([checkQuoteV2(this.#loadDeps(), ask, q), this.#spendable(w)])
          const pull = check.chain.reduce((sum, c) => sum + c.use.pull, 0n)
          // Fewer of their own cards only means more to pay: said now.
          if (pull > units) return { unavailable: `That is more than this phone can spend in dollars this week (${dollars(units)} left).` }
          quote = q
          checked = check
          owed = 0
          break
        } catch (err) {
          if (!(err instanceof LoadRefused)) throw err
          // Nothing listed at all, and none of the shopper's own credit: the till says so in its own words.
          if (err.code === 'nothing_listed') {
            refused = ownAll.length === 0 ? { unavailable: err.message, nothingListed: true } : notEnough
            break
          }
          refused = { unavailable: err.message }
        }
      }
    }
    // NO KEY, STILL A PRICE. A phone that cannot pay with dollars yet (none set
    // up, or a key for the old escrow) is shown what the store's cards would
    // cost all the same: the same quote, under nobody's address, held for
    // nobody. Pay stays off, and the way it pays says what to do in Account.
    // Only the plain case: no store credit of its own, nothing to leave out.
    if (owed > 0 && !keyed && ownAll.length === 0 && exclude.length === 0) {
      try {
        const q = await quoteTillV2({ api: this.#d.api }, { merchant, totalCents: owed, depositor: NOBODY, preference, preview: true })
        if (q.uncoveredCents > 0) {
          refused = notEnough
        } else {
          quote = q
          owed = 0
        }
      } catch (err) {
        if (!(err instanceof LoadRefused)) throw err
        refused = err.code === 'nothing_listed' ? { unavailable: err.message, nothingListed: true } : { unavailable: err.message }
      }
    }
    if (owed > 0) {
      if (refused !== null) return refused
      // A phone with no key for this escrow buys no cards, so what the shopper's own credit leaves owed waits on
      // dollars set up here, and is said as that: "not enough at Target" was not true with cards on sale there.
      if (!keyed) return { unavailable: w === null ? NOT_SET_UP : NEW_ESCROW }
      return ownAll.length === 0 ? { unavailable: `Nothing at ${storeName(merchant)} right now.`, nothingListed: true } : notEnough
    }
    // Scan order. Every card here is paid before the first is drawn, so a
    // register that says paid early leaves the later cards paid and never
    // scanned. A leftover bought whole is scanned before the shopper's own
    // credit: their credit costs nothing to hand back, while a leftover nobody
    // scanned is one whose earlier shopper's deposit comes back two hours
    // later with no scan to prove it. The last card stays last: it is the one
    // used in part, and the one a lower total takes off.
    const v2Legs = quote?.legs ?? []
    const lastV2 = v2Legs[v2Legs.length - 1]
    const ahead = v2Legs.filter((l) => l !== lastV2 && l.source === 'remainder' && l.leftCents === 0)
    const slots: Slot[] = [
      ...ahead.map((l): Slot => ({ kind: 'v2', scanOrder: l.scanOrder })),
      ...own.map((x): Slot => ({ kind: 'own', own: x })),
      ...v2Legs.filter((l) => !ahead.includes(l)).map((l): Slot => ({ kind: 'v2', scanOrder: l.scanOrder })),
    ]
    const legs = slots.map((s, i): Leg => {
      const at = { scanIndex: i + 1, scanOf: slots.length }
      if (s.kind === 'own') {
        const c = s.own.credit
        return { ref: c.ref, source: 'own_credit', firstInLine: false, faceCents: c.balanceCents, appliedCents: s.own.appliedCents, costCents: 0, leftoverCents: c.balanceCents - s.own.appliedCents, depositCents: 0, ...at }
      }
      const l = v2Legs.find((x) => x.scanOrder === s.scanOrder) as QuoteLegV2
      return {
        ref: l.intentId,
        source: l.source,
        // A leftover is a card waiting first in line for the next shopper.
        firstInLine: l.source === 'remainder',
        faceCents: l.remainingCents,
        appliedCents: l.usedCents,
        costCents: centsOf(l.amountUnits),
        leftoverCents: l.leftCents,
        depositCents: l.leftCents,
        ...at,
      }
    })
    const quoteRef = randomRef('plan')
    const plan: RoutePlan = {
      rail: 'stablecoin',
      merchant,
      totalCents,
      legs,
      costCents: quote?.priceCents ?? 0,
      // What the cards bought save. The shopper's own credit is their money, not a saving.
      savingCents: quote?.savingCents ?? 0,
      depositCents: quote?.depositCents ?? 0,
      uncoveredCents: 0,
      preference,
      quoteRef,
      expiresAt: quote?.expiresAt ?? new Date(Date.now() + 120_000).toISOString(),
    }
    this.#plans.set(quoteRef, { ask: quote === null ? null : ask, quote, checked, prepared: null, preparing: null, stale: null, slots, tapAt: null, waitMarked: false })
    return plan
  }

  async quote(a: { merchant: string; totalCents: number; preference: RoutePreference }): Promise<RoutePlan | Unavailable> {
    if (!(await this.#stillSignedIn())) return { unavailable: SIGNED_OUT }
    return this.#plan(a.merchant, a.totalCents, a.preference)
  }

  #context(plan: RoutePlan): PlanContext {
    const ctx = this.#plans.get(plan.quoteRef)
    if (ctx === undefined) throw new LoadRefused('quote_mismatch', 'That plan is not one this phone made. Type the total again.')
    return ctx
  }

  /**
   * No plan keeps tickets whose keys are moving on: reused by another plan,
   * or zeroed. Its pay prepares again (load-v2.ts refuses a zeroed one).
   */
  #letGo(prepared: PreparedLoadV2 | null): void {
    if (prepared === null) return
    for (const ctx of this.#plans.values()) if (ctx.prepared === prepared) ctx.prepared = null
  }

  /**
   * Ask for the tickets and fill the batch now: the till calls this once the
   * total has stopped changing, and again at the tap (`tap`), which then
   * finds it done or waits for it. Same cards, same tickets. A plan found
   * stale (a card used since) is kept as stale, for Pay to price again,
   * rather than thrown.
   *
   * A TOTAL THAT CHANGES DROPS ITS TICKETS. The till prepares 0.4 s after
   * the total stops changing, so a shopper still typing can start one for a
   * total they then change. A new total on the same cards in the same state
   * waits for those tickets and uses them (a V2 ticket binds the card's
   * state, never the cents used, and reusePreparedV2 prices the new cents
   * again). One on other cards does not wait behind them: it asks Lit at
   * once, and what the old total fetched is zeroed when it lands, never paid
   * with.
   *
   * `tap`: the tap is the one waiting. How long it waits is marked
   * (ticket_wait), and a batch filled a while ago is left to the tap's own
   * one round of reads (load-v2.ts freshenPreparedV2) rather than filled
   * again here first.
   */
  async prepare(plan: RoutePlan, opts: { tap?: boolean } = {}): Promise<void> {
    // A plan already paid, or one this screen never made: nothing to fetch for it (Pay finds a paid one by its key).
    const ctx = this.#plans.get(plan.quoteRef)
    if (ctx === undefined || ctx.quote === null || ctx.ask === null || ctx.stale !== null) return
    const tap = opts.tap === true
    if (tap) ctx.tapAt ??= Date.now()
    try {
      await this.#preparing(ctx, tap)
    } finally {
      if (tap) this.#markWait(ctx)
    }
  }

  #preparing(ctx: PlanContext, tap: boolean): Promise<void> {
    if (ctx.preparing !== null) return ctx.preparing
    // Ready: the tap reads what has aged in its own round.
    if (tap && ctx.prepared !== null) return Promise.resolve()
    const before = this.#flight
    const n = ++this.#prepares
    const run = (async () => {
      if (before !== null && before.ctx !== ctx && ctx.prepared === null) {
        if (sameCardsV2(before.ctx.quote, ctx.quote)) await before.done
        else this.#dropBelow = n
      }
      // Nothing fetched for an account no longer signed in here: Pay refuses it.
      if (await this.#stillSignedIn()) await this.#prepareNow(ctx, n, tap)
    })()
    const tracked = run.finally(() => {
      if (ctx.preparing === tracked) ctx.preparing = null
      if (this.#flight?.ctx === ctx) this.#flight = null
    })
    ctx.preparing = tracked
    this.#flight = { ctx, done: tracked.catch(() => undefined) }
    return tracked
  }

  /** The tap's wait for this plan's prepare, marked once: 0 when it was ready before the tap. */
  #markWait(ctx: PlanContext): void {
    if (ctx.tapAt === null || ctx.waitMarked) return
    ctx.waitMarked = true
    this.#d.onMark?.('ticket_wait', Date.now() - ctx.tapAt)
  }

  async #prepareNow(ctx: PlanContext, n: number, tap: boolean): Promise<void> {
    if (ctx.quote === null || ctx.ask === null) return
    const started = Date.now()
    const d = this.#loadDeps()
    try {
      if (ctx.prepared === null) {
        const last = this.#lastPrepared
        const reused = reusePreparedV2(last, ctx.quote, ctx.ask, this.#d.config.escrow)
        this.#letGo(last)
        if (reused === null) discardPreparedV2(last)
        this.#lastPrepared = null
        if (reused !== null) {
          ctx.prepared = reused
        } else {
          const fresh = await prepareLoadV2(d, ctx.ask, ctx.quote, ctx.checked)
          // Fetched for a total the screen has left, on other cards: dropped, never used.
          if (n < this.#dropBelow) {
            discardPreparedV2(fresh)
            return
          }
          ctx.prepared = fresh
        }
        this.#lastPrepared = ctx.prepared
      }
      // A batch filled for other cents used, or long enough ago that its fees may have moved: filled again while the shopper types.
      if (!tap) await fillBatchV2(d, ctx.prepared)
      this.#d.onMark?.('prepare', Date.now() - started)
    } catch (err) {
      if (err instanceof LoadRefused && staleCodes.has(err.code)) {
        ctx.stale = err
        return
      }
      throw err
    }
  }

  /**
   * The purchase a tap with this key made on this phone, or null when that
   * tap never got as far as keeping one.
   *
   * THIS ACCOUNT'S ONLY. The V2 book outlives a sign-out, and a till tab
   * left open keeps the key of a tap it never heard back from, and its "Show
   * it". Signed in as someone else, that tab sent the first account's key,
   * and this opened its purchase and drew its paid, unscanned codes onto the
   * second account's screen, as #purchase never does from a handle. Found
   * under another account, it is refused in so many words, never offered as
   * a tap that never left the phone.
   */
  async #byKey(key: string): Promise<PurchaseRecordV2 | null> {
    const found = (await this.#d.book.purchases()).find((p) => p.till?.key === key) ?? null
    if (found !== null && lowerHex(found.depositor) !== this.#me()) throw new LoadRefused('unavailable', NOT_THIS_ACCOUNT)
    return found
  }

  /**
   * Pay the plan; the first card's code. `after`, the purchase this one
   * finishes: its cards are already left out of a plan from report or
   * changeTotal, and any report it made that the chain does not have yet is
   * sent again first, on its own. `key`: the tap's; a purchase this phone
   * already made with it is finished and handed back, never paid again.
   * `resume`: only that.
   */
  async pay(plan: RoutePlan, opts: { after?: Purchase; key?: string; resume?: boolean } = {}): Promise<Purchase | Requote | EndedPurchase> {
    await this.#refuseSignedOut()
    const key = opts.key ?? null
    if (key !== null) {
      const found = await this.#byKey(key)
      if (found !== null) return this.#settled(() => this.#resume(found, plan), key)
    }
    if (opts.resume === true) throw new LoadRefused('not_charged', NEVER_LEFT)
    return this.#settled(() => this.#payNew(plan, opts.after, key), key)
  }

  /**
   * Run a Pay, and say what it came to in the till's words. A payment that
   * may have gone through keeps the tap's key (STILL_GOING): the next tap
   * with it finishes this one.
   *
   * ONCE THIS PHONE KEEPS A PURCHASE UNDER THE KEY, NOTHING ENDS THE KEY.
   * Whatever goes wrong after that (a card not on this phone yet, a refusal
   * on the way to the first code), the purchase may be paid: an ended key
   * let the next tap make a new one and pay a second time. Only a purchase
   * the chain never took (failed) is over.
   */
  async #settled<T>(run: () => Promise<T>, key: string | null): Promise<T> {
    try {
      return await run()
    } catch (err) {
      // The escrow pages' own words say "Finish it"; the till's way to finish is the same tap again.
      if (err instanceof LoadPending) throw new TillRefused(STILL_GOING, STILL_FINISHING, 0)
      if (err instanceof TillRefused && err.code === STILL_GOING) throw err
      const kept = key === null ? null : await this.#byKey(key).catch(() => null)
      if (kept !== null && kept.state !== 'failed') {
        throw new TillRefused(STILL_GOING, err instanceof LoadRefused || err instanceof SaleRefused ? STILL_FINISHING : MAY_HAVE_PAID, 0)
      }
      throw err
    }
  }

  async #payNew(plan: RoutePlan, after: Purchase | undefined, key: string | null): Promise<Purchase | Requote> {
    const ctx = this.#context(plan)
    const own = ownOf(ctx.slots)
    // Checked before anything is paid: the credit this plan uses is still there.
    const credit = await this.#credit(plan.merchant as EscrowMerchantName)
    for (const o of own) {
      const c = credit.find((x) => x.ref === o.credit.ref)
      if (c === undefined || c.balanceCents < o.appliedCents) {
        this.#plans.delete(plan.quoteRef)
        throw new LoadRefused('quote_mismatch', 'Your store credit changed since this plan. Type the total again. Nothing was charged.')
      }
      o.credit = c
    }
    if (after !== undefined) await this.#sendAgain(after)
    let record: PurchaseRecordV2 | null = null
    if (ctx.quote !== null) {
      // The tap: whatever it waits for the prepare is its ticket wait. Twice at most: a prepare dropped
      // for a total since changed is asked again for this one.
      ctx.tapAt ??= Date.now()
      for (let i = 0; i < 2 && ctx.prepared === null && ctx.stale === null; i++) await this.prepare(plan, { tap: true })
      this.#markWait(ctx)
      if (ctx.stale !== null || ctx.prepared === null) return this.#requote(plan, ctx.stale)
      const prepared = ctx.prepared
      if (this.#lastPrepared === prepared) this.#lastPrepared = null
      // Spent from here, whatever happens: a plan is paid once. A purchase that
      // may have gone through is finished by its key, never paid again.
      this.#letGo(prepared)
      this.#plans.delete(plan.quoteRef)
      // The plan is kept with the tap: a retry with this key is rebuilt from it, whatever plan the retry sends.
      const tap = { key: key ?? randomRef('tap'), own: own.map((o) => ({ ref: o.credit.ref, appliedCents: o.appliedCents })), ownTaken: false, plan }
      try {
        record = await executeLoadV2(this.#loadDeps(), prepared, this.#d.onStep, [], tap)
      } catch (err) {
        // The card moved on between the prepare and the tap, and nothing was charged: the new price.
        if (err instanceof LoadRefused && staleCodes.has(err.code)) return this.#requote(plan, err)
        throw err
      }
    } else {
      // Paid wholly from the shopper's own credit: nothing goes to the chain, but the tap is kept before anything comes off.
      record = await this.#ownTap(plan, own, key)
    }
    this.#plans.delete(plan.quoteRef)
    record = (await this.#takeOwn(record, own)) ?? record
    const paid: Paid = { plan, slots: ctx.slots, record, paidAt: record.createdAt }
    return this.#started(paid, record.id)
  }

  /**
   * A tap paid wholly from the shopper's own store credit buys nothing on the
   * chain, but is kept in the V2 book like any other, before any of that
   * credit comes off: a page that dies after that is found again by its key
   * ("Check it" used to say nothing was charged, with the credit already
   * gone), or as a purchase left on screen, which gives back what it never
   * showed. No legs: nothing on it is the chain's.
   */
  async #ownTap(plan: RoutePlan, own: readonly OwnLeg[], key: string | null): Promise<PurchaseRecordV2> {
    const record: PurchaseRecordV2 = {
      version: 2,
      id: randomRef('own'),
      createdAt: this.#now(),
      merchant: plan.merchant as EscrowMerchantName,
      depositor: lowerHex(this.#account ?? this.#d.wallet?.account ?? NOBODY) as Hex,
      escrow: lowerHex(this.#d.config.escrow) as Hex,
      totalCents: plan.totalCents,
      uncoveredCents: 0,
      pullUnits: '0',
      txHash: null,
      raw: null,
      sponsorSet: false,
      state: 'done',
      legs: [],
      before: [],
      till: { key: key ?? randomRef('tap'), own: own.map((o) => ({ ref: o.credit.ref, appliedCents: o.appliedCents })), ownTaken: false, plan },
      problem: null,
    }
    await this.#d.book.savePurchase(record)
    return record
  }

  /**
   * The shopper's own cards are theirs: nothing is paid for them, and what
   * the plan uses comes off what this phone believes is on them, once. With
   * a V2 batch, its purchase notes that it was taken, so a resume never
   * takes it again.
   */
  async #takeOwn(record: PurchaseRecordV2 | null, own: readonly OwnLeg[]): Promise<PurchaseRecordV2 | null> {
    if (record?.till?.ownTaken === true) return record
    for (const o of own) await this.#setCredit(o, o.credit, Math.max(0, o.credit.balanceCents - o.appliedCents))
    if (record === null || record.till === undefined) return record
    const now = (await this.#d.book.purchase(record.id)) ?? record
    if (now.till !== undefined) now.till.ownTaken = true
    await this.#d.book.savePurchase(now)
    return now
  }

  /** The plan priced again for the same total after the card it planned moved on: nothing was charged. */
  async #requote(plan: RoutePlan, why: LoadRefused | null): Promise<Requote> {
    this.#plans.delete(plan.quoteRef)
    const again = await this.#plan(plan.merchant, plan.totalCents, plan.preference)
    if ('unavailable' in again) throw why ?? new LoadRefused('not_for_sale', `${CARD_TAKEN} ${again.unavailable} Nothing was charged.`)
    return { requote: again, message: CARD_TAKEN }
  }

  /**
   * A paid plan's first code, and the purchase kept on this screen, and on
   * the phone (#keepScreen). `screen`: how it stood on a screen that went (a
   * reload, a closed tab): it comes back on the card that was showing, never
   * on card 1 again.
   */
  async #started(paid: Paid, ref: string, screen: TillScreenV2 | null = null): Promise<Purchase> {
    const handle: PurchaseHandle = { rail: 'stablecoin', ref, plan: paid.plan }
    const shown = screen === null ? 1 : Math.min(Math.max(1, screen.shown), paid.plan.legs.length)
    const code = await this.#code(paid, shown)
    const pc: PurchaseContext = {
      ...paid,
      handle,
      notes: [],
      closed: new Set(),
      shown,
      finished: false,
      kept: [...(screen?.kept ?? [])],
      reports: [],
      whole: new Set(screen?.whole ?? []),
      unsaid: [],
      onScreen: true,
      changed: screen?.changed === true,
    }
    this.#purchases.set(ref, pc)
    await this.#keepScreen(pc)
    return this.#onScreen(pc, code)
  }

  /**
   * The purchase on screen as the till gets it: its card's code and, once a
   * new total changed it or its card must not be scanned, how that card
   * stands (standingOf), so a screen opened again shows it as the till did.
   *
   * A CARD NOT TO BE SCANNED NEVER COMES BACK AS ONE TO SCAN. Opened again
   * as a plain code, it said it covered the old total, with Done under it:
   * scanned, the register took the new total from a card paid for the old
   * one, and Done settled it as used, while the chain kept on sale only
   * the leftover it listed before. What a changed total leaves owed is
   * planned again under it (the plan made then went with its page), the
   * cards the purchase kept first, as changeTotal plans it.
   */
  async #onScreen(pc: PurchaseContext, code: LegCode): Promise<Purchase> {
    const out: Purchase = { ...pc.handle, code }
    const st = standingOf(pc.plan)
    if (pc.finished || (!pc.changed && !st.tooLow)) return out
    let owed: Owed = null
    if (pc.changed && st.owedCents > 0) {
      try {
        owed = await this.#plan(pc.plan.merchant, st.owedCents, pc.plan.preference, { first: pc.kept })
      } catch (err) {
        // Not priced now: the card stays on screen, and the shopper is told how to plan the rest.
        if (!notSent(err)) throw err
        owed = { unavailable: REST_LATER }
      }
    }
    const standing: Standing = { owed, cover: this.#cover(pc), tooLow: st.tooLow, notNeeded: st.notNeeded }
    return { ...out, standing }
  }

  /**
   * Keep the purchase as it stands on this screen on the phone
   * (TillScreenV2): the plan, the card showing, whether it is finished, and
   * whether a new total changed it. A phone that cannot write it still pays:
   * only a reload would lose it.
   */
  async #keepScreen(pc: PurchaseContext): Promise<void> {
    if (!pc.onScreen || pc.record === null) return
    const s: TillScreenV2 = {
      version: 2,
      ref: pc.record.id,
      plan: pc.plan,
      shown: pc.shown,
      finished: pc.finished,
      whole: [...pc.whole],
      kept: [...pc.kept],
      ...(pc.changed ? { changed: true as const } : {}),
      at: this.#now(),
    }
    await this.#d.book.saveScreen(s).catch(() => undefined)
  }

  /** Is purchase `id` open on this screen now, a card of it showing? */
  #showingHere(id: string): boolean {
    const pc = this.#purchases.get(id)
    return pc !== undefined && pc.onScreen && !pc.finished
  }

  /** A purchase as a screen left it, opened again from the phone's book. */
  async #reopened(record: PurchaseRecordV2, s: TillScreenV2): Promise<PurchaseContext> {
    const slots = await this.#slotsOf(s.plan, record)
    return {
      plan: s.plan,
      slots,
      record,
      paidAt: record.createdAt,
      handle: { rail: 'stablecoin', ref: record.id, plan: s.plan },
      notes: [],
      closed: new Set(),
      shown: s.shown,
      finished: s.finished,
      kept: [...s.kept],
      reports: [],
      whole: new Set(s.whole),
      unsaid: [],
      onScreen: false,
      changed: s.changed === true,
    }
  }

  /**
   * A tap asked about again by its key: finish what it paid for (safe any
   * number of times, never paying twice), take the shopper's own credit off
   * once, and hand the purchase back with its first code. One this screen
   * already ended is said to have ended.
   *
   * REBUILT FROM THE PURCHASE, NEVER FROM THE PLAN SENT WITH THE RETRY. The
   * keypad prices the total again after a Pay that did not finish, so the
   * retry can name other cards (the first ones are drained now) or another
   * total. Rebuilt from that, the purchase was "not on this phone", the key
   * ended, and the next tap paid again; or it came back saying it covered
   * the new total while the chain booked the old one. The plan it paid is
   * kept on its record (TillTapV2.plan), so it comes back as it was paid, and
   * the till changes its total to the one typed (use-till.ts landPurchase).
   */
  async #resume(found: PurchaseRecordV2, sent: RoutePlan): Promise<Purchase | EndedPurchase> {
    const open = this.#purchases.get(found.id)
    if (open?.onScreen === true) {
      if (open.finished) return { ended: open.handle, receipt: await this.#receipt(open), message: ENDED }
      return this.#onScreen(open, await this.#code(open, open.shown))
    }
    // A catch-up giving back what this purchase never showed finishes first: the screen is read after it.
    if (this.#catching !== null) await this.#catching.catch(() => undefined)
    // How it stood on a screen that went: the plan as it stood there, and the card that was showing.
    const screen = await this.#d.book.screen(found.id)
    // Paid wholly from store credit: nothing on the chain to finish.
    let record = found.legs.length === 0 ? found : await resumePurchaseV2(this.#loadDeps(), found.id, this.#d.onStep)
    if (screen?.finished === true) {
      const pc = await this.#reopened(record, screen)
      return { ended: pc.handle, receipt: await this.#receipt(pc), message: ENDED }
    }
    // A purchase made before its plan was kept is rebuilt from the plan sent, as it was then.
    const plan = screen?.plan ?? found.till?.plan ?? sent
    const slots = await this.#slotsOf(plan, record)
    const own = ownOf(slots)
    // The credit as it is now, so it is taken off once from what is on it.
    const credit = await this.#credit(plan.merchant as EscrowMerchantName)
    for (const o of own) o.credit = credit.find((c) => c.ref === o.credit.ref) ?? o.credit
    record = (await this.#takeOwn(record, own)) ?? record
    return this.#started({ plan, slots, record, paidAt: record.createdAt }, record.id, screen)
  }

  /** Each card of a plan, from where it comes, worked out again from the plan and the purchase this phone kept. */
  async #slotsOf(plan: RoutePlan, record: PurchaseRecordV2 | null): Promise<Slot[]> {
    const merchant = plan.merchant as EscrowMerchantName
    const credit = isMerchant(plan.merchant) ? await this.#credit(merchant) : []
    return plan.legs.map((leg): Slot => {
      if (leg.source === 'own_credit') return { kind: 'own', own: { credit: credit.find((c) => c.ref === leg.ref) ?? creditByRef(leg.ref), appliedCents: leg.appliedCents } }
      const r = record?.legs.find((l) => l.intentId === leg.ref)
      if (r === undefined) throw new LoadRefused('unavailable', 'That purchase is not on this phone.')
      return { kind: 'v2', scanOrder: r.scanOrder }
    })
  }

  /** What this phone believes is on a card of credit in a plan now: the list's number, or the plan's own copy once the list leaves it out (used up). */
  async #creditNow(merchant: EscrowMerchantName, o: OwnLeg): Promise<TillCreditV2> {
    return (await this.#credit(merchant)).find((c) => c.ref === o.credit.ref) ?? o.credit
  }

  /** Set what is on it, and keep the plan's copy in step, so a card used up and given back is given back once. */
  async #setCredit(o: OwnLeg, now: TillCreditV2, balanceCents: number): Promise<void> {
    await setTillCreditBalanceV2(this.#d.book, this.#own, now, balanceCents)
    o.credit = { ...now, balanceCents }
  }

  /** Send these reports on their own, now. One that fails stays kept on its purchase, for catchUp, pay(), finish() or sendPendingReports(). */
  async #sendNow(actions: readonly BatchedAction[]): Promise<BatchedAction[]> {
    const landed: BatchedAction[] = []
    for (const a of actions) {
      try {
        await sendReportV2(this.#saleDeps(), a)
        landed.push(a)
      } catch (err) {
        if (!notSent(err)) throw err
      }
    }
    return landed
  }

  /** Send again, each on its own, what this purchase reported that the chain does not have yet. One that fails again stays kept. */
  async #sendAgain(p: Purchase): Promise<void> {
    const pc = this.#purchases.get(p.ref)
    if (pc === undefined) return
    for (const id of new Set(pc.reports.map((a) => a.purchaseId))) {
      try {
        await sendPendingReportsV2(this.#saleDeps(), id)
      } catch (err) {
        if (!notSent(err)) throw err
      }
    }
  }

  /** The code for `scanIndex`, from this phone's own store, as the store's barcode payload. */
  async #code(pc: Paid, scanIndex: number): Promise<LegCode> {
    const plan = pc.plan
    const leg = plan.legs[scanIndex - 1]
    const slot = pc.slots[scanIndex - 1]
    if (leg === undefined || slot === undefined) throw new RangeError('no such card in this purchase')
    const merchant = plan.merchant as EscrowMerchantName
    let card: CardSecret | null
    let silenceIsSale = true
    if (slot.kind === 'own') {
      card = await openTillCreditV2(this.#d.store, this.#own, slot.own.credit)
    } else {
      const v2 = pc.record?.legs.find((l) => l.scanOrder === slot.scanOrder)
      if (pc.record === null || v2 === undefined || v2.depositId === null) throw new LoadRefused('unavailable', 'That card is not on this phone yet. Tap Pay again to finish it.')
      card = await this.#d.store.cardSecret(cardIdV2(pc.record.escrow, v2.depositId))
      // A store nobody can read: no answer from the shopper counts as the code having worked.
      silenceIsSale = v2.mode === MODE_BLIND
    }
    if (card === null) throw new LoadRefused('unavailable', 'That card is not on this phone.')
    return {
      scanIndex,
      scanOf: leg.scanOf,
      coversCents: leg.appliedCents,
      leftoverCents: leg.leftoverCents,
      depositCents: leg.depositCents,
      barcode: cardBarcodePayload(merchant, card),
      pdf417: storeUsesPdf417(merchant) ? (await cardBarcode(merchant, card)).svg : null,
      expiresAt: new Date(pc.paidAt + CODE_WINDOW_MS).toISOString(),
      silenceIsSale,
    }
  }

  /**
   * The purchase behind a handle: the one on this screen, or one opened
   * again from this phone's book (a report from Account, after the till page
   * is gone). One opened again is finished: its codes were shown and the
   * register took them.
   *
   * Only while this till's account is still signed in here (`acting`: a
   * receipt only reads), and only this account's: a handle names any
   * purchase in the phone's book, and the book outlives a sign-out, so a
   * till opened again for nobody, or for someone else, drew the first
   * account's codes from its handle.
   */
  async #purchase(p: PurchaseHandle, acting = true): Promise<PurchaseContext> {
    if (acting) await this.#refuseSignedOut()
    const here = this.#purchases.get(p.ref)
    if (here !== undefined) return here
    const record = await this.#d.book.purchase(p.ref)
    if (record !== null && lowerHex(record.depositor) !== this.#me()) throw new LoadRefused('unavailable', NOT_THIS_ACCOUNT)
    const slots = await this.#slotsOf(p.plan, record)
    const pc: PurchaseContext = {
      plan: p.plan,
      slots,
      record,
      paidAt: record?.createdAt ?? Date.now(),
      handle: { rail: 'stablecoin', ref: p.ref, plan: p.plan },
      notes: [],
      closed: new Set(),
      shown: p.plan.legs.length,
      finished: true,
      kept: [],
      reports: [],
      whole: new Set(),
      unsaid: [],
      onScreen: false,
      changed: false,
    }
    this.#purchases.set(p.ref, pc)
    return pc
  }

  /** The card at `scanIndex` scanned: the next card's code, drawn only now. */
  async next(p: Purchase, scanIndex: number): Promise<LegCode> {
    const pc = await this.#purchase(p)
    if (!Number.isInteger(scanIndex) || scanIndex < 1 || scanIndex >= pc.plan.legs.length) {
      throw new LoadRefused('unavailable', 'That was the last card. Tap Done.')
    }
    const code = await this.#code(pc, scanIndex + 1)
    pc.shown = Math.max(pc.shown, scanIndex + 1)
    await this.#keepScreen(pc)
    // The card before it scanned: its leftover need not rest for the next shopper.
    if (!pc.finished) this.#doneWith(pc, [scanIndex])
    return code
  }

  /**
   * The register needed no more cards than `scanIndex`: every later card is
   * kept as store credit, never drawn here, and said, since the receipt
   * counts what it cost. A card the chain did not make the shopper's yet is
   * said on the receipt, never counted as credit. A card on screen bought
   * whole after the total went up leaves what the register did not take as
   * the shopper's credit, said too.
   */
  async done(p: Purchase, scanIndex: number): Promise<TillReceipt> {
    const pc = await this.#purchase(p)
    const open = !pc.finished
    this.#sayKept(pc, await this.#closeAfter(pc, scanIndex), null)
    if (!pc.finished && pc.whole.has(scanIndex)) await this.#sayRest(pc, scanIndex)
    pc.finished = true
    await this.#keepScreen(pc)
    // Every card up to the one on screen scanned: their leftovers need not rest for the next shopper.
    if (open) this.#doneWith(pc, Array.from({ length: scanIndex }, (_, i) => i + 1))
    const receipt = await this.#receipt(pc)
    const note = this.#takeNotes(pc)
    return note === null ? receipt : { ...receipt, note }
  }

  /**
   * The till is done with cards `ats` of this purchase: each scanned, and the
   * till moved past it. Each that leaves cents on its card for the next
   * shopper tells our server so, with the proof its reply key signed when it
   * was opened (done-proof-v2.ts), and its leftover goes on sale at once
   * instead of resting two hours (till-quote-v2.ts restingV2).
   *
   * ONLY A CARD THE REGISTER TOOK. The rest protects the value this shopper
   * paid for on a card still unscanned, so a card the register may not have
   * taken is never said done: one reported, or kept as their credit (never
   * drawn, or not used), keeps its rest. Nor one bought whole after the total
   * went up: nothing on it is for sale.
   *
   * NEVER IN THE WAY, NEVER TWICE. Sent after Next or Done has its answer, and
   * never waited on: a phone that cannot reach us leaves the leftover its two
   * hours, as before. Once per card on this page.
   */
  #doneWith(pc: PurchaseContext, ats: readonly number[]): void {
    const record = pc.record
    if (record === null) return
    for (const at of ats) {
      const slot = pc.slots[at - 1]
      if (slot?.kind !== 'v2' || pc.closed.has(at) || pc.whole.has(at)) continue
      const leg = record.legs.find((l) => l.scanOrder === slot.scanOrder)
      const proof = leg?.doneProof
      if (leg === undefined || proof === undefined || proof.depositId !== leg.depositId || leg.leftCents <= 0) continue
      if (leg.refunded === true || leg.reported !== undefined) continue
      const id = cardIdV2(record.escrow, proof.depositId)
      if (this.#told.has(id)) continue
      this.#told.add(id)
      void this.#tell(record.escrow, leg.replyPublicKey, proof)
    }
  }

  /** Send one card's "done", a few times while the page is open. Never throws. */
  async #tell(escrow: Hex, replyKey: Hex, proof: { depositId: string; signature: Hex }): Promise<void> {
    const sleep = this.#d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    try {
      for (let i = 0; i < DONE_TRIES; i++) {
        if (i > 0) await sleep(DONE_PAUSE_MS * i)
        const a = await this.#d.api.done(escrow, proof.depositId, replyKey, proof.signature)
        // Kept; or refused for good, since a proof that is wrong stays wrong. Busy, unreachable or not on chain yet: asked again.
        if (a.status === 200 || (a.status >= 400 && a.status < 500 && a.status !== 429 && a.body.error !== 'no_purchase')) return
      }
    } catch {
      // Not sent: the leftover rests its two hours, as it did before a phone could say done.
    }
  }

  /** The sentences a purchase has for the shopper and has not said, once each, or null. */
  #takeNotes(pc: PurchaseContext): string | null {
    const notes = [...new Set(pc.notes.splice(0))]
    return notes.length === 0 ? null : notes.join(' ')
  }

  /**
   * Say each card just kept as the shopper's credit, and any kept before and
   * not said yet. Not one the plan for what is still owed uses first: that
   * plan says so ("from your store credit"), and it is about to be scanned,
   * so "in your store credit now" would not be true for long. `later`: the
   * card on screen must not be scanned, and "not used" plans what is owed on
   * these cards next, so they wait to be said until then (a note said now
   * named a card the next plan scanned).
   */
  #sayKept(pc: PurchaseContext, kept: readonly KeptCard[], owed: Owed, later = false): void {
    const using = new Set<string>()
    if (owed !== null && !('unavailable' in owed)) {
      for (const s of this.#plans.get(owed.quoteRef)?.slots ?? []) if (s.kind === 'own' && s.own.credit.cardId !== null) using.add(s.own.credit.cardId)
    }
    for (const k of [...pc.unsaid.splice(0), ...kept]) {
      if (using.has(k.cardId)) continue
      if (later) pc.unsaid.push(k)
      else pc.notes.push(keptNote(k.at, k.balanceCents))
    }
  }

  /** What the register left on the card at `at`, bought whole after the total went up: said, once it is credit. */
  async #sayRest(pc: PurchaseContext, at: number): Promise<void> {
    const slot = pc.slots[at - 1]
    const v2 = slot?.kind === 'v2' ? pc.record?.legs.find((l) => l.scanOrder === slot.scanOrder) : undefined
    if (pc.record === null || v2 === undefined || v2.depositId === null) return
    const credit = await this.#d.book.credit(cardIdV2(pc.record.escrow, v2.depositId))
    if (credit !== null && credit.balanceCents > 0) pc.notes.push(restNote(at, credit.balanceCents))
  }

  /**
   * The cards after `scanIndex` are not needed at this register: the
   * shopper's own go back on their credit; a bought one is kept as their
   * credit (spec section 5.4, "it's your credit"), buying its leftover with
   * its own deposit when one was left on it, and naming its sale. Returns
   * the bought cards kept, for the caller to say.
   *
   * ONE THE CHAIN DID NOT TAKE IS NEVER LOST. It was paid for: swallowed, it
   * was never drawn, never credit, and nothing asked again. So it is kept on
   * its purchase (pendingKeeps), asked again soon while the till is open and
   * whenever the till or Account opens (catchUp), and the shopper is told it
   * is not credit yet. One the chain says can never be kept is said in its
   * own words.
   */
  async #closeAfter(pc: PurchaseContext, scanIndex: number): Promise<KeptCard[]> {
    const merchant = pc.plan.merchant as EscrowMerchantName
    const kept: KeptCard[] = []
    for (const [i, slot] of pc.slots.entries()) {
      const at = i + 1
      if (at <= scanIndex || pc.closed.has(at)) continue
      pc.closed.add(at)
      if (slot.kind === 'own') {
        const now = await this.#creditNow(merchant, slot.own)
        await this.#setCredit(slot.own, now, now.balanceCents + slot.own.appliedCents)
        continue
      }
      if (pc.record === null) continue
      // Kept already (a run cut short, then opened again from the phone): never kept twice, which would set its balance back.
      const already = await this.#keptAlready(pc.record, slot.scanOrder)
      if (already !== null) {
        if (!pc.kept.includes(already)) pc.kept.push(already)
        continue
      }
      const sentence = await this.#keepOrLater(pc.record.id, slot.scanOrder, KEEP_LATER)
      if (typeof sentence === 'string') pc.notes.push(sentence)
      else {
        pc.kept.push(sentence.cardId)
        kept.push({ at, cardId: sentence.cardId, balanceCents: sentence.balanceCents })
      }
    }
    if (pc.record !== null) pc.record = (await this.#d.book.purchase(pc.record.id)) ?? pc.record
    return kept
  }

  /** The card-store.ts id of a bought card of this purchase that is the shopper's credit already, or null. */
  async #keptAlready(record: PurchaseRecordV2, scanOrder: number): Promise<string | null> {
    const leg = record.legs.find((l) => l.scanOrder === scanOrder)
    if (leg === undefined || leg.depositId === null) return null
    const cardId = cardIdV2(record.escrow, leg.depositId)
    return (await this.#d.book.credit(cardId)) === null ? null : cardId
  }

  /**
   * Keep a bought card as the shopper's credit, the register having taken
   * `takenCents` of it; or, when the chain did not take it now, keep it on
   * its purchase to ask again (catchUp) and say `later`; or, when the chain
   * says it never can be, say why.
   */
  async #keepOrLater(purchaseId: string, scanOrder: number, later: string, takenCents = 0): Promise<CreditRecordV2 | string> {
    const tried = await this.#tryKeep(purchaseId, scanOrder, takenCents)
    if ('credit' in tried) {
      await dropPendingKeep(this.#d.book, purchaseId, scanOrder)
      return tried.credit
    }
    if ('never' in tried) return tried.never
    await notePendingKeep(this.#d.book, purchaseId, { scanOrder, takenCents, at: Date.now() })
    return later
  }

  /**
   * Make a bought card the shopper's credit: the whole card (keepCardV2,
   * buying its rest out of its deposit); or, when its rest went to someone
   * else meanwhile (another shopper used it, or the seller was paid first),
   * what this sale paid for, which is still on the card and theirs
   * (keepPaidV2). Never dropped for that: it was paid for. `later`: the chain
   * did not answer now, and asking again may; `never`: it never will, said.
   */
  async #tryKeep(purchaseId: string, scanOrder: number, takenCents: number): Promise<{ credit: CreditRecordV2 } | { never: string } | { later: true }> {
    try {
      return { credit: await this.#keep(purchaseId, scanOrder, takenCents) }
    } catch (err) {
      if (!(err instanceof SaleRefused) && !(err instanceof EscrowRpcError)) throw err
      if (!(err instanceof SaleRefused) || !err.lasting) return { later: true }
      if (!err.restGone) return { never: err.message }
    }
    try {
      const credit = await keepPaidV2(this.#saleDeps(), purchaseId, scanOrder, takenCents)
      await mirrorCreditToOwnV2(this.#own, this.#d.store, credit)
      return { credit }
    } catch (err) {
      if (!(err instanceof SaleRefused) && !(err instanceof EscrowRpcError)) throw err
      return err instanceof SaleRefused && err.lasting ? { never: err.message } : { later: true }
    }
  }

  /** keepCardV2, and the card goes on /account's list of credit too. */
  async #keep(purchaseId: string, scanOrder: number, takenCents: number): Promise<CreditRecordV2> {
    const credit = await keepCardV2(this.#saleDeps(), purchaseId, scanOrder, takenCents)
    await mirrorCreditToOwnV2(this.#own, this.#d.store, credit)
    return credit
  }

  /**
   * What the purchase came to: what the cards the register took cost and the
   * value they brought, and the deposit still held. Nothing is held on a card
   * here.
   *
   * COVERED AND SAVED ARE ONLY WHAT THE REGISTER TOOK. Every card was paid at
   * the tap, so two kinds are said apart, never as covered or saved: a card
   * reported as not working (a dispute, or a report not landed yet: its
   * seller may refund it), and what is still the shopper's store credit of a
   * card the register did not take (kept, or to be kept), which counts as
   * used once the till spends it. The till says each in its own sentence.
   */
  async #receipt(pc: PurchaseContext): Promise<TillReceipt> {
    const record = pc.record === null ? null : ((await this.#d.book.purchase(pc.record.id)) ?? pc.record)
    if (record === null) return { paidCents: 0, savedCents: 0, depositCents: 0, keptCents: 0 }
    const credits = (await this.#d.book.credits()).filter((c) => c.purchaseId === record.id)
    let allUnits = 0n
    let creditUnits = 0n
    let disputedUnits = 0n
    let used = 0
    let deposit = 0
    for (const l of record.legs) {
      if (l.refunded === true) continue
      const amount = BigInt(l.amountUnits)
      allUnits += amount
      deposit += l.leftCents
      if (l.reported === 'dispute' || (record.pendingReports ?? []).some((a) => a.scanOrder === l.scanOrder)) {
        disputedUnits += amount
        continue
      }
      const still = stillCredit(
        l,
        credits.find((c) => c.scanOrder === l.scanOrder),
        (record.pendingKeeps ?? []).find((k) => k.scanOrder === l.scanOrder),
      )
      if (still > 0) creditUnits += (amount * BigInt(still)) / BigInt(l.usedCents)
      used += l.usedCents - still
    }
    // What the chain pulled, added up in token units and rounded up once, as
    // the Pay button and #priced round it: rounded card by card, two cards of
    // 1000.4 cents each said $20.02 paid for a $20.01 button. The two kinds
    // said apart are rounded down, so the three add up to that.
    const creditCents = Math.floor(Number(creditUnits) / UNITS_PER_CENT)
    const disputedCents = Math.floor(Number(disputedUnits) / UNITS_PER_CENT)
    const paid = centsOf(allUnits) - creditCents - disputedCents
    const out: TillReceipt = { paidCents: paid, savedCents: Math.max(0, used - paid), depositCents: deposit, keptCents: 0 }
    if (creditCents > 0) out.creditPaidCents = creditCents
    if (disputedCents > 0) out.disputedCents = disputedCents
    return out
  }

  async receipt(p: PurchaseHandle): Promise<TillReceipt> {
    return this.#receipt(await this.#purchase(p, false))
  }

  /** A card found empty is nobody's credit: any credit this phone holds of it goes to nothing. */
  async #zeroCredit(merchant: EscrowMerchantName, cardId: string): Promise<void> {
    for (const c of await this.#credit(merchant)) {
      if (c.cardId === cardId) await setTillCreditBalanceV2(this.#d.book, this.#own, c, 0)
    }
  }

  /**
   * Something went wrong with card `scanIndex` (ReportOutcome says what).
   *   - the card on screen: "not used" makes it the shopper's credit; "it
   *     didn't scan" or "declined" is a dispute on it. The cards after it are
   *     kept as credit, as for done, and what the cards before it did not
   *     cover is planned again, those kept cards first, while the report goes;
   *   - after Done, or a card already passed: "empty" or anything else, as a
   *     report on the card's sale, and nothing more is owed: the register
   *     took it. The note says what the report did.
   * Every report is kept on its purchase before anything else and sent on
   * its own now; one that cannot be sent now stays kept, and catchUp (the
   * till or Account opening), pay() on the plan, finish() or
   * sendPendingReports() send it again.
   *
   * WHAT THE SCREEN SAYS IS WHAT HAPPENED. On the card on screen, `line`
   * replaces the till's own sentence whenever it would not be true: the
   * shopper's own card (nothing was bought, so no seller refunds anything),
   * a report that did not reach the chain yet, a card not used that the
   * chain did not make theirs yet. `note` says the rest (a later card not
   * credit yet).
   */
  async report(p: PurchaseHandle, scanIndex: number, o: ReportOutcome): Promise<ReportAnswer> {
    const pc = await this.#purchase(p)
    const plan = pc.plan
    const leg = plan.legs[scanIndex - 1]
    const slot = pc.slots[scanIndex - 1]
    if (leg === undefined || slot === undefined) throw new RangeError('no such card in this purchase')
    const settled = pc.finished || scanIndex < pc.shown
    if (!settled && scanIndex > pc.shown) throw new LoadRefused('unavailable', 'That card is not on screen yet.')
    const merchant = plan.merchant as EscrowMerchantName
    const skip = new Set<string>()
    const exclude: string[] = []
    const actions: BatchedAction[] = []
    let refusal: string | null = null
    /** On the card on screen: the sentence for what became of it, when the till's own would not be true. */
    let line: string | null = null
    const reason = o === 'not_used' ? null : o
    // Kept on its purchase before anything is planned or sent: nothing can lose it.
    const note = async (purchaseId: string, scanOrder: number): Promise<void> => {
      if (reason === null) return
      try {
        const action = await reportActionV2(this.#saleDeps(), purchaseId, scanOrder, reason)
        await notePendingReport(this.#d.book, action)
        actions.push(action)
      } catch (err) {
        if (!(err instanceof SaleRefused)) throw err
        refusal = err.message
      }
    }
    if (slot.kind === 'own') {
      const own = slot.own
      skip.add(own.credit.ref)
      const now = await this.#creditNow(merchant, own)
      // A card of credit kept from a sale still open: "empty" or anything
      // else is a report on that sale. A bought leftover found spent inside
      // its two hours gets the shopper's money back and the earlier shopper's
      // deposit pays the seller (decision 1); later, while its payout waits,
      // it is a dispute the seller can refund.
      const from = now.creditId === null ? null : await this.#d.book.credit(now.creditId)
      if ((o === 'empty' || o === 'problem') && from?.purchaseId !== undefined && from.scanOrder !== undefined) await note(from.purchaseId, from.scanOrder)
      // An empty card holds nothing; one not used, or that would not scan, still holds what it did, unless the register took it already.
      await this.#setCredit(own, now, o === 'empty' ? 0 : settled ? now.balanceCents : now.balanceCents + own.appliedCents)
      // Their own card did not work: nothing was bought, so nobody refunds anything, and it is still theirs.
      if (!settled && (o === 'didnt_scan' || o === 'declined')) line = OWN_FAILED
    } else if (pc.record !== null) {
      exclude.push(leg.ref)
      if (o === 'not_used' && !settled) {
        // Not to be scanned: the total came down past what it may keep. It is
        // the shopper's now, at what they paid, and pays what is still owed
        // first; or, not taken by the chain yet, it is said so, never as credit.
        const kept = await this.#keepOrLater(pc.record.id, slot.scanOrder, NOT_USED_LATER)
        if (typeof kept === 'string') line = kept
        else pc.kept.push(kept.cardId)
      } else {
        await note(pc.record.id, slot.scanOrder)
        const depositId = pc.record.legs.find((l) => l.scanOrder === slot.scanOrder)?.depositId ?? null
        // A card bought whole after the total went up, that did not work on screen: what it was to leave is nobody's credit.
        const failedWhole = !settled && pc.whole.has(scanIndex)
        if ((o === 'empty' || failedWhole) && depositId !== null) await this.#zeroCredit(merchant, cardIdV2(pc.record.escrow, depositId))
        if (failedWhole) await dropPendingKeep(this.#d.book, pc.record.id, slot.scanOrder)
      }
    }
    pc.reports.push(...actions)
    pc.closed.add(scanIndex)
    if (settled) {
      const landed = await this.#sendNow(actions)
      return { owed: null, owedCents: 0, receipt: await this.#receipt(pc), kept: null, note: this.#noteOf(o, actions, landed, refusal, leg), line: null }
    }
    pc.finished = true
    const covered = plan.legs.slice(0, scanIndex - 1).reduce((n, l) => n + l.appliedCents, 0)
    const owedCents = Math.max(0, plan.totalCents - covered)
    let owed: Owed = null
    let sending: Promise<BatchedAction[]> | null = null
    let landed: BatchedAction[] = []
    let kept: KeptCard[] = []
    try {
      kept = await this.#closeAfter(pc, scanIndex)
      sending = this.#sendNow(actions)
      if (owedCents > 0) owed = await this.#plan(merchant, owedCents, plan.preference, { skip, exclude, first: pc.kept })
    } finally {
      landed = await (sending ?? this.#sendNow(actions))
    }
    // A dispute that did not land holds nothing yet: the screen says so, never that the payment waits.
    if (line === null && reason !== null && slot.kind === 'v2') {
      if (refusal !== null) line = refusal
      else if (actions.some((a) => !landed.includes(a))) line = REPORT_LATER
    }
    this.#sayKept(pc, kept, owed)
    await this.#keepScreen(pc)
    return { owed, owedCents, receipt: await this.#receipt(pc), kept: null, note: this.#takeNotes(pc), line }
  }

  /** What a report on a card already settled did, in a sentence. */
  #noteOf(o: ReportOutcome, actions: readonly BatchedAction[], landed: readonly BatchedAction[], refusal: string | null, leg: Leg): string {
    const a = actions[0]
    if (a === undefined) {
      if (refusal !== null) return refusal
      return o === 'empty' ? 'Got it. That card is off your store credit.' : 'Got it. That was your own card, so take it up with the store.'
    }
    if (!landed.includes(a)) return 'Got it. The report is saved on this phone and has not reached the chain yet. Salvo sends it again each time you open the till or Account.'
    if (a.kind === 'contest') return `Got it. Your ${dollarsOfCents(leg.costCents)} for that card is back in your dollars.`
    return 'Got it. The seller’s payment for that card waits 48 hours, so they can refund you.'
  }

  /** The plan priced from what the chain charged for its bought cards: cost, saving, and the deposit still held. */
  #priced(pc: PurchaseContext, plan: RoutePlan): RoutePlan {
    if (pc.record === null) return plan
    const live = pc.record.legs.filter((l) => l.refunded !== true)
    const cost = centsOf(live.reduce((n, l) => n + BigInt(l.amountUnits), 0n))
    return { ...plan, costCents: cost, savingCents: live.reduce((n, l) => n + l.usedCents, 0) - cost, depositCents: live.reduce((n, l) => n + l.leftCents, 0) }
  }

  /** The card on screen, as the plan now has it. */
  #cover(pc: PurchaseContext): LegCover | null {
    const leg = pc.plan.legs[pc.shown - 1]
    if (leg === undefined || pc.finished) return null
    return { scanIndex: leg.scanIndex, coversCents: leg.appliedCents, leftoverCents: leg.leftoverCents, depositCents: leg.depositCents }
  }

  /**
   * The total changed after paying. The till shows the card on screen as
   * this purchase's last from here (its scanOf becomes its scanIndex, and
   * Done settles it), so the cards after it are closed first, never drawn,
   * as for done: the shopper's own go back on their credit, a bought one is
   * kept as theirs. Then, against what the cards up to the one on screen
   * cover: up, what is on the card on screen beyond what it covers first
   * (#useShown), then a plan for the rest, those kept cards first; down, the
   * card on screen covers less (reduceUse while its new leftover fits the
   * cap, the shopper's own credit given back, or more left as their credit
   * on a card bought whole), and nothing is owed. Past the cap the card must
   * not be scanned: tooLow, and "not used" then keeps it.
   *
   * UP, THE CARD ON SCREEN GOES FIRST. A register takes a gift card's
   * balance up to what is due. Planned as new cards beside it, the extra was
   * taken from the card on screen anyway: from a leftover the chain still
   * listed for the next shopper behind this shopper's deposit (who then
   * found it short, and the deposit went to the seller), or from the
   * shopper's own credit while this phone still counted it.
   */
  async changeTotal(p: Purchase, totalCents: number): Promise<ChangeAnswer> {
    try {
      return await this.#changeTotal(p, totalCents)
    } finally {
      // As it now stands, on the phone too: whatever came of it, a reload finds it so.
      const pc = this.#purchases.get(p.ref)
      if (pc !== undefined) await this.#keepScreen(pc)
    }
  }

  async #changeTotal(p: Purchase, totalCents: number): Promise<ChangeAnswer> {
    const pc = await this.#purchase(p)
    // How the card on screen stands comes from the plan as it now stands (standingOf), so a refusal, which
    // changes no plan, leaves a card not to be scanned so; and a screen opened again stands as this says.
    const answer = (owed: Owed): ChangeAnswer => {
      const st = pc.finished ? null : standingOf(pc.plan)
      return {
        purchase: { ...pc.handle, code: p.code },
        owed,
        cover: this.#cover(pc),
        tooLow: st?.tooLow === true,
        notNeeded: st?.notNeeded === true,
      }
    }
    if (!Number.isSafeInteger(totalCents) || totalCents < 1) return answer({ unavailable: 'Type the new total.' })
    if (pc.finished) return answer({ unavailable: 'That purchase is finished. Type the new total for what is still to pay.' })
    // From here the card on screen is the purchase's last, against a total typed on screen: kept so (TillScreenV2 changed).
    pc.changed = true
    const kept = await this.#closeAfter(pc, pc.shown)
    // The cards closed are said, unless what is still owed is planned on them first: with the card on screen
    // not to be scanned, that plan comes with "not used", so they are said then.
    const said = (owed: Owed): ChangeAnswer => {
      this.#sayKept(pc, kept, owed, standingOf(pc.plan).tooLow)
      return answer(owed)
    }
    if (pc.shown < pc.plan.legs.length) {
      this.#stand(pc, this.#priced(pc, { ...pc.plan, legs: pc.plan.legs.slice(0, pc.shown).map((l): Leg => ({ ...l, scanOf: pc.shown })) }))
    }
    const before = pc.plan.legs.slice(0, -1).reduce((n, l) => n + l.appliedCents, 0)
    const coveredOf = (legs: readonly Leg[]): number => legs.reduce((n, l) => n + l.appliedCents, 0)
    if (totalCents > coveredOf(pc.plan.legs)) {
      const refused = await this.#useShown(pc, totalCents - before)
      if (refused !== null) return said(refused)
    }
    const plan = pc.plan
    const covered = coveredOf(plan.legs)
    if (totalCents >= covered) {
      this.#stand(pc, { ...plan, totalCents })
      const owed: Owed = totalCents > covered ? await this.#plan(plan.merchant, totalCents - covered, plan.preference, { first: pc.kept }) : null
      return said(owed)
    }
    const cut = covered - totalCents
    const last = pc.slots[pc.shown - 1]
    // Not this card at all: the cards before it already cover the new total.
    if (before >= totalCents) {
      this.#stand(pc, { ...plan, totalCents })
      return said(null)
    }
    // Bought whole here after the total went up: the register takes less of it and leaves the shopper more credit. No cap: none of it is the next shopper's.
    if (last?.kind === 'v2' && pc.whole.has(pc.shown)) {
      const refused = await this.#setWhole(pc, totalCents - before)
      if (refused !== null) return said(refused)
      this.#stand(pc, { ...pc.plan, totalCents })
      return said(null)
    }
    if (last === undefined || last.kind === 'own' || pc.record === null) {
      // The shopper's own cards at the end give the cut back to their credit, the last first.
      let can = 0
      for (let i = plan.legs.length - 1; i >= 0 && pc.slots[i]?.kind === 'own'; i--) can += (plan.legs[i] as Leg).appliedCents
      if (can < cut) return said({ unavailable: TOO_LOW })
      this.#stand(pc, { ...plan, totalCents, legs: await this.#giveBackCredit(pc, plan.legs, cut) })
      return said(null)
    }
    try {
      const usedNow = pc.record.legs.reduce((n, l) => n + (l.refunded === true ? 0 : l.usedCents), 0)
      const record = await reduceUseV2(this.#saleDeps(), pc.record.id, usedNow - cut, last.scanOrder)
      pc.record = record
      const legs = plan.legs.map((l, i): Leg => {
        const slot = pc.slots[i]
        const v2 = slot?.kind === 'v2' ? record.legs.find((r) => r.scanOrder === slot.scanOrder) : undefined
        if (v2 === undefined) return l
        return { ...l, appliedCents: v2.usedCents, costCents: centsOf(BigInt(v2.amountUnits)), leftoverCents: v2.leftCents, depositCents: v2.leftCents }
      })
      this.#stand(pc, this.#priced(pc, { ...plan, totalCents, legs }))
      return said(null)
    } catch (err) {
      if (!(err instanceof SaleRefused)) throw err
      // More would be left on it than it may keep for the next shopper: it must not be scanned.
      if (err.message === KEEP_REST_SENTENCE) {
        // Not to be scanned. The new total stands, so "not used" plans what the cards before it leave.
        this.#stand(pc, { ...plan, totalCents })
        return said(null)
      }
      return said({ unavailable: err.message })
    }
  }

  /**
   * The total went up to `due` for the card on screen (what the cards before
   * it leave): whatever is on that card beyond what it covers is used first,
   * since the register takes it anyway.
   *   - the shopper's own card: the extra comes off its balance;
   *   - a bought card with cents left on it for the next shopper: that rest
   *     is bought out of its own deposit first (buyRestV2), so the chain
   *     never lists what the register is about to take, and the whole card
   *     is the shopper's (#setWhole);
   *   - one bought whole already: the register takes more of it.
   * A card used up by this purchase holds nothing more. One whose rest
   * another shopper has now gives this purchase nothing more either, and
   * the extra is planned as other cards. Returns why it cannot be done now,
   * or null.
   */
  async #useShown(pc: PurchaseContext, due: number): Promise<Unavailable | null> {
    const i = pc.shown - 1
    const leg = pc.plan.legs[i]
    const slot = pc.slots[i]
    if (leg === undefined || slot === undefined || due <= leg.appliedCents) return null
    if (slot.kind === 'own') {
      const now = await this.#creditNow(pc.plan.merchant as EscrowMerchantName, slot.own)
      const take = Math.min(due - leg.appliedCents, now.balanceCents)
      if (take <= 0) return null
      await this.#setCredit(slot.own, now, now.balanceCents - take)
      slot.own.appliedCents += take
      const legs = [...pc.plan.legs]
      legs[i] = { ...leg, appliedCents: leg.appliedCents + take, leftoverCents: Math.max(0, leg.leftoverCents - take) }
      this.#stand(pc, { ...pc.plan, legs })
      return null
    }
    if (pc.record === null) return null
    if (!pc.whole.has(pc.shown)) {
      const v2 = pc.record.legs.find((l) => l.scanOrder === slot.scanOrder)
      if (v2 === undefined || v2.leftCents === 0) return null
      try {
        pc.record = await buyRestV2(this.#saleDeps(), pc.record.id, slot.scanOrder)
      } catch (err) {
        if (!(err instanceof SaleRefused) && !(err instanceof EscrowRpcError)) throw err
        if (err instanceof SaleRefused && err.restGone) return null
        return { unavailable: err instanceof SaleRefused && err.lasting ? err.message : CHANGE_LATER }
      }
      pc.whole.add(pc.shown)
    }
    return this.#setWhole(pc, due)
  }

  /**
   * The card on screen, bought whole by this purchase: the register takes
   * `due` of it, all of it at most, and what it leaves is the shopper's
   * store credit. Kept as it changes, so a page closed before Done loses
   * none of it; said at Done. Nothing is sent: the chain has it as theirs.
   */
  async #setWhole(pc: PurchaseContext, due: number): Promise<Unavailable | null> {
    const i = pc.shown - 1
    const leg = pc.plan.legs[i]
    const slot = pc.slots[i]
    const v2 = slot?.kind === 'v2' ? pc.record?.legs.find((l) => l.scanOrder === slot.scanOrder) : undefined
    if (leg === undefined || slot?.kind !== 'v2' || pc.record === null || v2 === undefined || v2.depositId === null) return null
    const face = v2.usedCents
    const applied = Math.min(face, Math.max(0, due))
    const rest = face - applied
    const cardId = cardIdV2(pc.record.escrow, v2.depositId)
    const credit = await this.#d.book.credit(cardId)
    if (credit !== null) {
      await this.#d.book.saveCredit({ ...credit, takenCents: applied })
      const ownId = this.#own === null ? null : keptOwnId(cardId)
      await setTillCreditBalanceV2(this.#d.book, this.#own, { ref: '', balanceCents: credit.balanceCents, since: credit.since, ownId, creditId: cardId, cardId }, rest)
    } else if (rest > 0) {
      const kept = await this.#keepOrLater(pc.record.id, slot.scanOrder, KEEP_LATER, applied)
      if (typeof kept === 'string') pc.notes.push(kept)
    } else {
      await dropPendingKeep(this.#d.book, pc.record.id, slot.scanOrder)
    }
    pc.record = (await this.#d.book.purchase(pc.record.id)) ?? pc.record
    const legs = [...pc.plan.legs]
    legs[i] = { ...leg, faceCents: face, appliedCents: applied, costCents: centsOf(BigInt(v2.amountUnits)), leftoverCents: rest, depositCents: 0 }
    this.#stand(pc, this.#priced(pc, { ...pc.plan, legs }))
    return null
  }

  /**
   * The shopper's own cards at the end of a purchase, for less than planned:
   * the cut comes off the last of them first, and goes back on their credit.
   */
  async #giveBackCredit(pc: PurchaseContext, planned: readonly Leg[], cut: number): Promise<Leg[]> {
    let left = cut
    const legs = [...planned]
    const merchant = pc.plan.merchant as EscrowMerchantName
    for (let i = legs.length - 1; i >= 0 && left > 0; i--) {
      const slot = pc.slots[i]
      if (slot?.kind !== 'own') break
      const o = slot.own
      const leg = legs[i] as Leg
      const back = Math.min(left, leg.appliedCents)
      const now = await this.#creditNow(merchant, o)
      await this.#setCredit(o, now, now.balanceCents + back)
      o.appliedCents -= back
      legs[i] = { ...leg, appliedCents: leg.appliedCents - back, leftoverCents: leg.leftoverCents + back }
      left -= back
    }
    return legs
  }

  /** The purchase now stands as `plan`. Its handle keeps its ref. */
  #stand(pc: PurchaseContext, plan: RoutePlan): void {
    pc.plan = plan
    pc.handle = { ...pc.handle, plan }
  }

  /** The purchases on this phone the signed-in account made on this escrow. */
  async #mine(): Promise<PurchaseRecordV2[]> {
    const me = this.#account
    // Signed out since this till opened: none are this till's to finish, offer again or catch up.
    if (me === null || !(await this.#stillSignedIn())) return []
    const escrow = lowerHex(this.#d.config.escrow)
    return (await this.#d.book.purchases()).filter((p) => lowerHex(p.depositor) === lowerHex(me) && lowerHex(p.escrow) === escrow)
  }

  /**
   * V2 purchases this account made on this phone, paid or maybe paid and
   * not finished, and any holding a report or a card to keep that the chain
   * does not have yet.
   */
  async unfinished(): Promise<PurchaseRecordV2[]> {
    const mine = await this.#mine()
    const ids = new Set(mine.map((p) => p.id))
    const open = (await unfinishedPurchasesV2(this.#d.book)).filter((p) => ids.has(p.id))
    const openIds = new Set(open.map((p) => p.id))
    const owing = mine.filter((p) => !openIds.has(p.id) && ((p.pendingReports ?? []).length > 0 || (p.pendingKeeps ?? []).length > 0))
    return [...open, ...owing]
  }

  /**
   * The till's Pays this account made on this phone that may have gone
   * through and never finished here: paid, or maybe paid, with no cards on
   * screen. Newest first, one per store, while the purchase handle acts.
   *
   * FOUND IN THE V2 BOOK, NOT ONLY BY THE KEY KEPT FOR IT. The key the till
   * keeps before a Pay is sent (client/recent.ts) goes when the account
   * signs out of this browser, while the purchase it points at stays in the
   * V2 book. Signed in again, this is how the till's "Check it" and
   * /account still find it: by the tap's own key, kept on the purchase, for
   * the account that made it only.
   *
   * AND ONE THAT WENT THROUGH WITH A CARD ON A SCREEN THAT WENT (`open`). A
   * reload, a dropped tab or a tap on Account with "Scan 1 of 2" showing
   * left every card paid and nothing to show them: the till had ended the
   * Pay, and only the page's memory knew the purchase was still on screen.
   * Now the till keeps it (TillScreenV2), and offers it again on the card
   * that was showing, while its leftover still rests.
   */
  async unfinishedPays(now: number = this.#now()): Promise<UnfinishedPay[]> {
    const out: UnfinishedPay[] = []
    for (const p of await this.#mine()) {
      if (p.till?.plan === undefined || now - p.createdAt >= UNFINISHED_MS) continue
      if (out.some((o) => o.store === p.merchant)) continue
      if (p.state === 'signed' || p.state === 'paid') {
        out.push({ key: p.till.key, store: p.merchant, plan: p.till.plan, at: p.createdAt })
        continue
      }
      if (p.state !== 'done' || this.#showingHere(p.id)) continue
      const s = await this.#d.book.screen(p.id)
      if (s === null || s.finished || now - s.at >= OPEN_OFFER_MS) continue
      out.push({ key: p.till.key, store: p.merchant, plan: s.plan, at: p.createdAt, open: { shown: s.shown, scanOf: s.plan.legs.length } })
    }
    return out
  }

  #catching: Promise<CatchUpOutcome> | null = null

  /**
   * What this account still owes the chain from its purchases on this
   * phone, sent now, each on its own: a card the register did not need that
   * is to be the shopper's credit, and a report that did not land. The till
   * and Account call this as they open, so "Salvo asks again each time you
   * open the till or Account" is true. One that fails again stays kept. A
   * card whose rest went to someone else meanwhile is kept at what this sale
   * paid for (#tryKeep); one the chain says can never be kept is dropped, and
   * either is said (CatchUpOutcome.said). Never pays for anything. One run at
   * a time; safe to call any number of times.
   */
  catchUp(): Promise<CatchUpOutcome> {
    if (this.#catching !== null) return this.#catching
    const run = this.#catchUpNow().finally(() => {
      this.#catching = null
    })
    this.#catching = run
    return run
  }

  async #catchUpNow(): Promise<CatchUpOutcome> {
    const out: CatchUpOutcome = { kept: 0, reported: 0, waiting: 0 }
    const said: string[] = []
    const w = this.#d.wallet
    const keyed = w !== null && keyScopedForV2(w, this.#d.config.escrow)
    for (const mine of await this.#mine()) {
      // A purchase left on a screen nobody opens gives back what it never showed. One paid from store credit alone needs no key.
      if (keyed || mine.legs.length === 0) {
        try {
          await this.#parkIfLeft(mine, said)
        } catch (err) {
          // Cut short: what it noted stays noted, and the next catch-up finishes it.
          if (!notSent(err) && !(err instanceof RangeError)) throw err
          out.waiting += 1
        }
      }
      if (!keyed) continue
      // Read again: parking may have kept cards on it.
      const p = (await this.#d.book.purchase(mine.id)) ?? mine
      for (const k of p.pendingKeeps ?? []) {
        const leg = p.legs.find((l) => l.scanOrder === k.scanOrder)
        // Kept already (a run whose last step did not finish): never kept twice, which would set its balance back.
        if (leg?.depositId != null && (await this.#d.book.credit(cardIdV2(p.escrow, leg.depositId))) !== null) {
          await dropPendingKeep(this.#d.book, p.id, k.scanOrder)
          continue
        }
        const tried = await this.#tryKeep(p.id, k.scanOrder, k.takenCents)
        if ('later' in tried) {
          out.waiting += 1
          continue
        }
        await dropPendingKeep(this.#d.book, p.id, k.scanOrder)
        const at = `At ${storeName(p.merchant)}`
        if ('never' in tried) {
          // Never dropped without a word: the shopper paid for it.
          said.push(`${at}, a card the register did not need was not kept as store credit. ${tried.never}`)
          continue
        }
        out.kept += 1
        // Less than the whole card: its rest went to someone else meanwhile, and what they paid for is what they have.
        if (leg !== undefined && tried.credit.balanceCents < leg.remainingCents - k.takenCents) {
          said.push(`${at}, a card the register did not need is in your store credit now, at the ${dollarsOfCents(tried.credit.balanceCents)} you paid for. Its rest could not be kept.`)
        }
      }
      if ((p.pendingReports ?? []).length === 0) continue
      try {
        const r = await sendPendingReportsV2(this.#saleDeps(), p.id)
        out.reported += r.sent + r.landed
        out.waiting += r.waiting
      } catch (err) {
        if (!notSent(err)) throw err
        out.waiting += 1
      }
    }
    return said.length === 0 ? out : { ...out, said }
  }

  /**
   * A purchase whose screen went with a card showing (TillScreenV2), left
   * PARK_AFTER_MS with nobody on it: every card after that one, which this
   * phone never drew, is the shopper's now, as "Register says paid" would
   * make it. Their own credit goes back on their store credit; a bought card
   * is kept as theirs, its rest bought out of its deposit, so nobody else is
   * ever sold what they paid for and never saw. The card that was showing
   * stays the purchase's last, offered again while its leftover rests
   * (unfinishedPays); after that it counts as used, as any card shown does,
   * and "Something went wrong?" is there for 48 hours. Unless it was marked
   * not to be scanned: then it is the shopper's credit too (#parkNotUsed).
   *
   * NEVER TWICE. Each bought card is noted to keep (pendingKeeps) and the
   * screen kept without those cards before anything is given back, so a run
   * cut short is finished by the next catch-up, never run again on what it
   * already gave back.
   */
  async #parkIfLeft(p: PurchaseRecordV2, said: string[]): Promise<void> {
    if (p.state !== 'done' || this.#showingHere(p.id)) return
    const s = await this.#d.book.screen(p.id)
    if (s === null || s.finished || this.#now() - s.at < PARK_AFTER_MS) return
    if (standingOf(s.plan).tooLow) return this.#parkNotUsed(p, s, said)
    if (s.shown >= s.plan.legs.length) return
    const pc = await this.#reopened(p, s)
    // A bought card the shopper's credit already (kept before the page went) is left as it is: kept twice, its balance went back.
    const after: Slot[] = []
    for (const slot of pc.slots.slice(s.shown)) {
      if (slot.kind === 'v2' && (await this.#keptAlready(p, slot.scanOrder)) !== null) continue
      after.push(slot)
    }
    for (const slot of after) {
      if (slot.kind === 'v2') await notePendingKeep(this.#d.book, p.id, { scanOrder: slot.scanOrder, takenCents: 0, at: this.#now() })
    }
    pc.record = (await this.#d.book.purchase(p.id)) ?? pc.record
    // The card that was showing is its last now, as after a new total.
    this.#stand(pc, this.#priced(pc, { ...pc.plan, legs: pc.plan.legs.slice(0, s.shown).map((l): Leg => ({ ...l, scanOf: s.shown })) }))
    const parked: TillScreenV2 = { ...s, plan: pc.plan }
    await this.#d.book.saveScreen(parked)
    const merchant = pc.plan.merchant as EscrowMerchantName
    let given = 0
    for (const slot of after) {
      if (slot.kind === 'own') {
        const now = await this.#creditNow(merchant, slot.own)
        await this.#setCredit(slot.own, now, now.balanceCents + slot.own.appliedCents)
        given += 1
        continue
      }
      // Not taken now: it stays noted, and the catch-up asks again.
      const kept = await this.#keepOrLater(p.id, slot.scanOrder, KEEP_LATER)
      if (typeof kept === 'string') continue
      parked.kept = [...parked.kept, kept.cardId]
      given += 1
    }
    if (parked.kept.length > s.kept.length) await this.#d.book.saveScreen(parked)
    if (given > 0) said.push(parkedLine(storeName(p.merchant), given))
  }

  /**
   * A purchase left on a screen nobody opens with its card marked not to be
   * scanned (the total came down past what it may keep): that card is the
   * shopper's store credit, as "not used" makes it, and the purchase is
   * finished, no longer offered again.
   *
   * NEVER COUNTED AS USED. Left as the purchase's last card shown, it
   * counted as used once its leftover rested, at the value the old total
   * used: the shopper paid for value the register never took, and the
   * chain still listed only the old leftover, so the rest was a windfall
   * for the next shopper's register. And never twice: the card is noted to
   * keep and the screen kept finished before anything is given back, so a
   * run cut short is finished by the next catch-up (pendingKeeps).
   */
  async #parkNotUsed(p: PurchaseRecordV2, s: TillScreenV2, said: string[]): Promise<void> {
    const pc = await this.#reopened(p, s)
    const slot = pc.slots[s.shown - 1]
    if (slot === undefined) return
    if (slot.kind === 'v2') await notePendingKeep(this.#d.book, p.id, { scanOrder: slot.scanOrder, takenCents: 0, at: this.#now() })
    await this.#d.book.saveScreen({ ...s, finished: true })
    const store = storeName(p.merchant)
    if (slot.kind === 'own') {
      const now = await this.#creditNow(pc.plan.merchant as EscrowMerchantName, slot.own)
      await this.#setCredit(slot.own, now, now.balanceCents + slot.own.appliedCents)
      said.push(parkedNotUsedLine(store))
      return
    }
    const kept = await this.#keepOrLater(p.id, slot.scanOrder, KEEP_LATER)
    // Not taken now: it stays noted, and the catch-up asks again.
    if (kept === KEEP_LATER) return
    if (typeof kept === 'string') {
      // The chain says it never can be: said once, and not asked again.
      await dropPendingKeep(this.#d.book, p.id, slot.scanOrder)
      said.push(`At ${store}, the card you were told not to scan was not kept as store credit. ${kept}`)
      return
    }
    await this.#d.book.saveScreen({ ...s, finished: true, kept: [...s.kept, kept.cardId] })
    said.push(parkedNotUsedLine(store))
  }

  /**
   * Finish one: look its batch up, or open the cards it paid for, then send
   * any report it still holds. A purchase that can never land sends the
   * reports it carried on their own before saying so. Safe to call any
   * number of times; never pays twice.
   */
  async finish(purchaseId: string): Promise<PurchaseRecordV2> {
    await this.#refuseSignedOut()
    let record: PurchaseRecordV2
    try {
      record = await resumePurchaseV2(this.#loadDeps(), purchaseId, this.#d.onStep)
    } catch (err) {
      if (err instanceof LoadRefused) {
        const failed = await this.#d.book.purchase(purchaseId)
        if (failed?.state === 'failed') {
          for (const id of new Set(failed.before.map((b) => b.purchaseId))) await sendPendingReportsV2(this.#saleDeps(), id)
        }
      }
      throw err
    }
    await sendPendingReportsV2(this.#saleDeps(), purchaseId)
    return (await this.#d.book.purchase(purchaseId)) ?? record
  }

  /**
   * Send, each on its own, the reports this purchase still holds: one that
   * could not be sent at the tap. Safe to call again.
   */
  async sendPendingReports(p: PurchaseHandle): Promise<PendingReportsOutcome> {
    const pc = await this.#purchase(p)
    if (pc.record === null) return { sent: 0, landed: 0, waiting: 0, dropped: 0 }
    return sendPendingReportsV2(this.#saleDeps(), pc.record.id)
  }

  /**
   * Keep card `scanIndex` as store credit: the register took `takenCents` of
   * it ("Register says paid" is 0).
   */
  async keepRest(p: PurchaseHandle, scanIndex: number, takenCents: number): Promise<CreditRecordV2> {
    const pc = await this.#purchase(p)
    const slot = pc.slots[scanIndex - 1]
    if (slot === undefined) throw new RangeError('no such card in this purchase')
    if (pc.record === null || slot.kind === 'own') throw new SaleRefused('That card is already yours.')
    const credit = await this.#keep(pc.record.id, slot.scanOrder, takenCents)
    pc.closed.add(scanIndex)
    pc.kept.push(credit.cardId)
    await this.#keepScreen(pc)
    return credit
  }
}
