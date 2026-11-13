/**
 * What this device keeps about its SalvoEscrowV2 purchases, listings and
 * store credit: public bookkeeping, in its own IndexedDB database
 * (`salvo-pay-v2`), beside the V1 one card-store.ts opens.
 *
 * WHY A DATABASE OF ITS OWN. The V1 pages finish every purchase they find and
 * show every listing they find, by V1's rules: a V2 purchase under V1's
 * `purchase:` slots would be "finished" against the wrong contract, and a V2
 * listing under `listing:` would read as never on chain and could be
 * forgotten. Here they are out of V1's sight, and V1's records out of V2's.
 *
 * NO SECRET IS KEPT HERE. A purchase is chain ids, hashes, manifests (public
 * terms), envelopes (ciphertext only Lit can open) and amounts; a listing the
 * same; a credit is a card id and a balance. The secrets stay where V1 keeps
 * them, sealed under card-store.ts's non-extractable key: each card's reply
 * key until its card is opened, and each card's number and PIN after. A
 * card's "done" proof (done-proof-v2.ts) is a signature that can only end its
 * own leftover's rest early, so it is kept here with its card.
 *
 * Losing this database loses no money and no card: the cards are in
 * card-store.ts's database, and every purchase is on chain.
 *
 * Browser only by use; imports nothing Node-only. Tests pass a fake
 * IDBFactory (tests/support/fake-indexeddb.ts). Never logs a value.
 */

import type { Hex } from 'viem'
import type { RoutePlan } from '@/lib/till/types'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import type { EscrowMerchantName, EscrowMode } from '../merchants'
import { DeviceStorageError, type CardRecord } from './card-store'

const DB_NAME = 'salvo-pay-v2'
const DB_VERSION = 1
const STORE = 'kv'

/** One card of a V2 purchase. */
export interface PurchaseLegV2 {
  intentId: string
  listingId: Hex
  /** The 14-key V2 manifest, exactly as sealed. The release reply is keyed to its hash. */
  manifest: string
  envelope: LitEnvelope
  mode: EscrowMode
  source: 'remainder' | 'fresh'
  /** The value left on the card when this purchase was planned. */
  remainingCents: number
  /** The listing's sales then: the ticket names it, so the deposit's saleIndex is this. */
  sales: number
  /** The deposit that covered what was left then, 0 if none. */
  bondDeposit: string
  usedCents: number
  leftCents: number
  amountUnits: string
  bondUnits: string
  scanOrder: number
  replyKeyId: string
  replyPublicKey: Hex
  replyKeyHash: Hex
  /** The ticket's last valid second (chain time). After it, this batch can only revert. */
  ticketNotAfter: number
  depositId: string | null
  released: boolean
  /** Refunded in full by its seller, or contested: the money is back, and a key not yet used is gone. */
  refunded?: boolean
  /** A report this phone sent about the card: a contest (refunded at once) or a dispute (the payout held). */
  reported?: 'contest' | 'dispute'
  /**
   * "Done with this card" for its deposit, signed by the card's reply key when
   * the card was opened, before that key was deleted (done-proof-v2.ts). Sent
   * only once the till is done with the card, so its leftover need not rest
   * for the next shopper. A signature, not a key: it opens nothing.
   */
  doneProof?: { depositId: string; signature: Hex }
}

/** A call the batch made before paying: the "that card was empty" or "it didn't scan" on an earlier card. */
export interface BatchedAction {
  /** contest: contestRemainder, the payment back at once. dispute: the payout held 48 hours for the seller to refund. */
  kind: 'contest' | 'dispute'
  reason: 'empty' | 'didnt_scan' | 'declined' | 'problem'
  /** The purchase and card it was about. */
  purchaseId: string
  scanOrder: number
  depositId: string
}

/**
 * The till's tap that made a purchase (dollars-backend.ts): its key, one per
 * tap and sent again on a retry, so a retry or a reload finds this purchase
 * instead of paying twice; the plan it paid; and the shopper's own store
 * credit the same plan used beside the cards bought, taken off what this
 * phone believes is on it exactly once.
 */
export interface TillTapV2 {
  key: string
  /** The plan's cards of the shopper's own credit, by the plan's ref, and the cents each covers. */
  own: Array<{ ref: string; appliedCents: number }>
  /** True once those cents came off the balances this phone keeps. */
  ownTaken: boolean
  /**
   * The plan this tap paid, as it was paid. A tap asked again by its key is
   * rebuilt from this, never from the plan sent with the retry: the keypad
   * prices the total again after a Pay that did not finish, and that new
   * plan names other cards, or another total. Absent on a purchase made
   * before the till kept it.
   */
  plan?: RoutePlan
}

/**
 * A till purchase as it stands on the till's screen (dollars-backend.ts),
 * kept on this phone as it changes, in a slot of its own beside its purchase:
 * the plan as it stands now, the last card drawn, whether the till is
 * finished with it, and whether a new total changed it. Never a code: a
 * card's code is drawn again from card-store.ts.
 *
 * WHY. Every card of a purchase is paid at the tap. While this lived only in
 * the page's memory, a reload or a closed tab with a card on screen lost the
 * purchase: the till offered nothing to show again, no card it never drew
 * became the shopper's store credit, and the store credit it planned stayed
 * taken off. Kept here, the till shows the card that was on screen again,
 * and a purchase left long enough gives back every card it never showed
 * (dollars-backend.ts catchUp).
 *
 * AS IT STOOD AFTER A NEW TOTAL, TOO. Kept without that, a card the till had
 * said not to scan came back as a plain code saying it covered the old
 * total, with Done under it, and left there it counted as used: the
 * shopper paid for value the register never took. And the rest still owed
 * under a card was dropped, so Done ended on a receipt while the register
 * still wanted money.
 */
export interface TillScreenV2 {
  version: 2
  /** The purchase's id in this book. */
  ref: string
  /** The plan as it stands now: a new total changes it. */
  plan: RoutePlan
  /** The last card whose code was drawn, from 1. */
  shown: number
  /** Done, or the card on screen reported: nothing more is drawn from it. */
  finished: boolean
  /** Places of cards bought whole after the total went up: what the register leaves on one is the shopper's. */
  whole: number[]
  /** card-store.ts ids of the cards it bought and left the shopper's, never drawn: what is planned again uses them first. */
  kept: string[]
  /**
   * The total changed with the card showing (dollars-backend.ts
   * changeTotal). The plan's total is then the new one, and how the card
   * stands comes from the plan, as the till showed it: past what it may
   * keep, it must not be scanned ("not used" keeps it); short of the
   * total, the rest is planned again under it. Left out: the card as drawn.
   */
  changed?: true
  /** When it last changed, ms. */
  at: number
}

/**
 * A card of a purchase that the register did not need and that is to be the
 * shopper's store credit (sale-v2.ts keepCardV2), which the chain did not
 * take when it was asked: tried again whenever the till or Account opens,
 * until it is credit, or the chain says it never can be.
 */
export interface PendingKeepV2 {
  scanOrder: number
  /** What the register took of it: 0 for a card never scanned. */
  takenCents: number
  at: number
}

export interface PurchaseRecordV2 {
  version: 2
  id: string
  createdAt: number
  merchant: EscrowMerchantName
  depositor: Hex
  escrow: Hex
  /** What the shopper typed, and what the cards leave to pay the usual way. */
  totalCents: number
  uncoveredCents: number
  /** What the one approve allowed, in token units: what the contract pulls for every card together. */
  pullUnits: string
  txHash: Hex | null
  raw: Hex | null
  sponsorSet: boolean
  feeSponsored?: boolean
  state: 'signed' | 'paid' | 'done' | 'failed'
  /**
   * Empty for a till tap paid wholly from the shopper's own store credit: it
   * buys nothing on the chain, and is kept here only for its tap, so a page
   * that dies after the credit came off finds it again (dollars-backend.ts).
   */
  legs: PurchaseLegV2[]
  before: BatchedAction[]
  /**
   * Reports the shopper made about this purchase's own cards that the chain
   * does not have yet: kept from the moment "that card was empty" or "it
   * didn't scan" is tapped, until one lands (markReported takes it off), or
   * can no longer be made. The till sends each on its own at the tap
   * (dollars-backend.ts); one that did not land then is sent again
   * (sale-v2.ts sendPendingReportsV2), so no report is ever lost with a plan.
   */
  pendingReports?: BatchedAction[]
  /** Made at the till: its tap. Absent on a purchase made before the till paid in dollars. */
  till?: TillTapV2
  /** Cards to keep as store credit that the chain did not take yet (PendingKeepV2). */
  pendingKeeps?: PendingKeepV2[]
  problem: string | null
}

/** A seller's V2 listing, as this browser made it. The card itself is not here. */
export interface ListingRecordV2 {
  version: 2
  listingId: Hex
  seller: Hex
  merchant: EscrowMerchantName
  valueCents: number
  priceUnits: number
  listingExpiry: number
  manifest: string
  envelope: LitEnvelope
  /** card-fingerprint.ts: what our server checks across both escrows. A slow keyless hash, never the card. */
  cardFingerprint: Hex
  txHash: Hex | null
  posted: boolean
  createdAt: number
  /** For a card sold back: the card on this device it came from. */
  fromCard?: string
  /**
   * For a card the shopper typed into /account and sold from there: that
   * store credit's id. Saved before the listing is sent, so from then on the
   * card is not their credit, at the till or on /account, whatever answer
   * comes back (credit-v2.ts listedAgainV2).
   */
  fromOwn?: string
}

/**
 * A card this device's owner holds as store credit at one store (spec
 * section 11): the rest of a card they kept (keepRest), or a whole card a
 * purchase left theirs. `balanceCents` is what this device believes is on
 * it: what was left when it became theirs, less what the till has used of it
 * since. The card's number and PIN are card-store.ts's, under `cardId`.
 */
export interface CreditRecordV2 {
  id: string
  merchant: EscrowMerchantName
  /** The card-store.ts card it is. */
  cardId: string
  balanceCents: number
  /** How it became theirs. */
  source: 'kept' | 'bought_whole'
  /** The escrow and deposit that made it theirs: a sale back waits until that deposit is paid out. */
  escrow: Hex
  depositId: string
  /**
   * The account it is the store credit of: the passkey address that bought
   * it. Only that account's /account and till list it, so a browser signed
   * out and signed in as someone else never hands them this card. Absent on
   * a credit kept before this was written: its purchase's depositor says
   * (creditAccountV2).
   */
  account?: Hex
  /**
   * For a card kept from a V2 purchase on this phone: that purchase and the
   * card's place in it. While its sale is open, "that card was empty" about
   * this credit is a report on that sale (dollars-backend.ts report): a
   * contest inside its two hours, a dispute after.
   */
  purchaseId?: string
  scanOrder?: number
  since: number
  /**
   * What the register took of the card when it became credit: 0 for a card
   * never scanned (absent on one kept before this was written, which was
   * never scanned). The till's receipt counts that much as used, and the
   * rest as store credit bought, never as covered or saved.
   */
  takenCents?: number
  /** Set once it is listed again (credit-v2.ts sellBackV2). */
  listedAs?: Hex
}

/**
 * A V2 card as card-store.ts keeps it: V1's card record plus what V2 adds.
 * `valueCents` is the cents this card covers at the till (the cents used),
 * so a screen that shows V1's cards shows what this one is good for.
 */
export interface CardRecordV2 extends CardRecord {
  escrowVersion: 2
  usedCents: number
  /** Cents left on the card after this purchase: the seller's, listed for the next shopper, with this phone's deposit on them. */
  leftCents: number
  /** The value on the card when this purchase used it. */
  remainingCents: number
}

/** Is this card-store.ts card a V2 one? */
export function isCardV2(c: CardRecord): c is CardRecordV2 {
  return (c as Partial<CardRecordV2>).escrowVersion === 2
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new DeviceStorageError('a request failed'))
  })
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new DeviceStorageError('a write failed'))
    tx.onabort = () => reject(tx.error ?? new DeviceStorageError('a write was cancelled'))
  })
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** This device's V2 book. One per page; open it with `openDeviceBookV2`. */
export class DeviceBookV2 {
  readonly #db: IDBDatabase

  private constructor(db: IDBDatabase) {
    this.#db = db
  }

  /** Open (and on first use create) the database. Throws DeviceStorageError when the browser refuses. */
  static async open(factory: IDBFactory | null): Promise<DeviceBookV2> {
    if (factory === null) throw new DeviceStorageError('no IndexedDB')
    let req: IDBOpenDBRequest
    try {
      req = factory.open(DB_NAME, DB_VERSION)
    } catch {
      throw new DeviceStorageError('IndexedDB is blocked')
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onupgradeneeded = () => {
        const d = req.result
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(new DeviceStorageError('IndexedDB would not open'))
      req.onblocked = () => reject(new DeviceStorageError('another tab holds an older copy open'))
    })
    return new DeviceBookV2(db)
  }

  async #run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const tx = this.#db.transaction(STORE, mode)
    const req = fn(tx.objectStore(STORE))
    const [value] = await Promise.all([done(req), finished(tx)])
    return value
  }

  async #get(slot: string): Promise<unknown> {
    return this.#run('readonly', (s) => s.get(slot))
  }

  async #put(slot: string, value: unknown): Promise<void> {
    await this.#run('readwrite', (s) => s.put(value, slot))
  }

  async #delete(slot: string): Promise<void> {
    await this.#run('readwrite', (s) => s.delete(slot))
  }

  async #all(prefix: string): Promise<Record<string, unknown>[]> {
    const keys = await this.#run('readonly', (s) => s.getAllKeys())
    const out: Record<string, unknown>[] = []
    for (const k of keys.filter((x): x is string => typeof x === 'string' && x.startsWith(prefix)).sort()) {
      const v = await this.#get(k)
      if (isRecord(v)) out.push(v)
    }
    return out
  }

  async savePurchase(p: PurchaseRecordV2): Promise<void> {
    await this.#put(`purchase:${p.id}`, p)
  }

  async purchase(id: string): Promise<PurchaseRecordV2 | null> {
    const v = await this.#get(`purchase:${id}`)
    return isRecord(v) && v.version === 2 ? (v as unknown as PurchaseRecordV2) : null
  }

  /** Newest first. */
  async purchases(): Promise<PurchaseRecordV2[]> {
    return (await this.#all('purchase:'))
      .filter((v) => v.version === 2)
      .map((v) => v as unknown as PurchaseRecordV2)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async saveListing(r: ListingRecordV2): Promise<void> {
    await this.#put(`listing:${r.listingId}`, r)
  }

  async deleteListing(listingId: Hex): Promise<void> {
    await this.#delete(`listing:${listingId}`)
  }

  /** Newest first. */
  async listings(): Promise<ListingRecordV2[]> {
    return (await this.#all('listing:'))
      .filter((v) => v.version === 2)
      .map((v) => v as unknown as ListingRecordV2)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async saveCredit(c: CreditRecordV2): Promise<void> {
    await this.#put(`credit:${c.id}`, c)
  }

  async credit(id: string): Promise<CreditRecordV2 | null> {
    const v = await this.#get(`credit:${id}`)
    return isRecord(v) ? (v as unknown as CreditRecordV2) : null
  }

  /** Oldest first: the till uses the oldest credit first. */
  async credits(): Promise<CreditRecordV2[]> {
    return (await this.#all('credit:')).map((v) => v as unknown as CreditRecordV2).sort((a, b) => a.since - b.since)
  }

  /** Keep a till purchase as it stands on screen (TillScreenV2). Its own slot, so a write to its purchase never undoes it. */
  async saveScreen(s: TillScreenV2): Promise<void> {
    await this.#put(`screen:${s.ref}`, s)
  }

  /** How purchase `ref` stood on the till's screen, or null when the till never kept it. */
  async screen(ref: string): Promise<TillScreenV2 | null> {
    const v = await this.#get(`screen:${ref}`)
    return isRecord(v) && v.version === 2 ? (v as unknown as TillScreenV2) : null
  }
}

/** Note on each purchase the reports that landed: a contested card's money is back, so its card is marked refunded. No longer pending. */
export async function markReported(book: DeviceBookV2, actions: readonly BatchedAction[]): Promise<void> {
  for (const a of actions) {
    const p = await book.purchase(a.purchaseId)
    const leg = p?.legs.find((l) => l.scanOrder === a.scanOrder)
    if (p === null || leg === undefined) continue
    if (a.kind === 'contest') leg.refunded = true
    leg.reported = a.kind
    p.pendingReports = (p.pendingReports ?? []).filter((x) => x.depositId !== a.depositId)
    await book.savePurchase(p)
  }
}

/**
 * Keep a report the shopper just made on the purchase it is about, before
 * anything is planned or sent. One per card: a newer report replaces it.
 */
export async function notePendingReport(book: DeviceBookV2, a: BatchedAction): Promise<void> {
  const p = await book.purchase(a.purchaseId)
  if (p === null) return
  p.pendingReports = [...(p.pendingReports ?? []).filter((x) => x.depositId !== a.depositId), a]
  await book.savePurchase(p)
}

/**
 * Whose store credit this is: its account, or, for one kept before that was
 * written, the depositor of the purchase it came from. Null when neither is
 * known: then it is nobody's on this phone, and never listed.
 */
export function creditAccountV2(c: CreditRecordV2, purchases: readonly PurchaseRecordV2[]): Hex | null {
  if (c.account !== undefined) return c.account.toLowerCase() as Hex
  const p = c.purchaseId === undefined ? undefined : purchases.find((x) => x.id === c.purchaseId)
  return p === undefined ? null : (p.depositor.toLowerCase() as Hex)
}

/** This account's V2 store credit, oldest first: what /account and the till may list for whoever is signed in. */
export async function creditsOfV2(book: Pick<DeviceBookV2, 'credits' | 'purchases'>, account: Hex | null): Promise<CreditRecordV2[]> {
  if (account === null) return []
  const [credits, purchases] = await Promise.all([book.credits(), book.purchases()])
  const me = account.toLowerCase()
  return credits.filter((c) => creditAccountV2(c, purchases) === me)
}

/** Keep a card to make the shopper's credit on its purchase, for catchUp to ask the chain again. One per card. */
export async function notePendingKeep(book: DeviceBookV2, purchaseId: string, k: PendingKeepV2): Promise<void> {
  const p = await book.purchase(purchaseId)
  if (p === null) return
  p.pendingKeeps = [...(p.pendingKeeps ?? []).filter((x) => x.scanOrder !== k.scanOrder), k]
  await book.savePurchase(p)
}

/** The card is the shopper's credit now, or never can be: no longer pending. */
export async function dropPendingKeep(book: DeviceBookV2, purchaseId: string, scanOrder: number): Promise<void> {
  const p = await book.purchase(purchaseId)
  if (p === null || (p.pendingKeeps ?? []).every((x) => x.scanOrder !== scanOrder)) return
  p.pendingKeeps = (p.pendingKeeps ?? []).filter((x) => x.scanOrder !== scanOrder)
  await book.savePurchase(p)
}

/** Forget a pending report the chain can no longer take (the sale was paid out, or refunded, meanwhile). */
export async function dropPendingReport(book: DeviceBookV2, a: Pick<BatchedAction, 'purchaseId' | 'depositId'>): Promise<void> {
  const p = await book.purchase(a.purchaseId)
  if (p === null) return
  p.pendingReports = (p.pendingReports ?? []).filter((x) => x.depositId !== a.depositId)
  await book.savePurchase(p)
}

/**
 * The page's V2 book, on the browser's own IndexedDB.
 */
export function openDeviceBookV2(factory: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB): Promise<DeviceBookV2> {
  return DeviceBookV2.open(factory)
}
