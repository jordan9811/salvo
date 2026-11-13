/**
 * What the shopper's phone and the seller's page keep on the device: one
 * IndexedDB database, with every secret in it sealed by one non-extractable
 * AES-GCM key (spec section 7, "Reply keys", and section 10.2).
 *
 * WHAT IS KEPT, AND HOW
 *   - The passkey account: its credential id, public key and address. Public;
 *     the private half lives in the platform authenticator, never here.
 *   - Each access key: a WebCrypto P-256 key pair whose private half was made
 *     non-extractable, so it is stored as a CryptoKey handle that can sign and
 *     can never be read out, by us or by anyone holding this database.
 *   - A pending key authorization: the passkey's signature that lets that
 *     access key spend, until the first transaction carries it on chain. It is
 *     a signed public statement, not a secret.
 *   - Reply keys, one per card: 32 secret bytes, SEALED. Deleted once the card
 *     they open is decrypted and stored.
 *   - Bought cards: the number and PIN SEALED, the store, value and scan order
 *     beside them, so the cards page can list them without opening any.
 *   - Purchases still in flight, and a seller's own listings: chain ids,
 *     hashes, manifests and envelopes. The envelope is ciphertext only Lit can
 *     open, and the manifest is public terms.
 *   - The account's settings, in one `settings` slot (unified-account spec
 *     3.1): what it pays with and how the till picks cards. Not secret. The
 *     store a till last opened on has its own slot beside it.
 *   - Which of the first escrow's cards this phone has matched for an
 *     account (account/client/match-v1.ts): card ids only.
 *   - Store credit (spec 11): the shopper's own gift cards, typed into
 *     /account on this phone, the number and PIN SEALED like a bought card's;
 *     and cards bought here that the shopper counts as credit, which point at
 *     the bought card's own box rather than copy it.
 *   - The card till's purchases, for 48 hours: the server's signed handle on
 *     each, its cards and what it came to, so "Something went wrong?" still
 *     works after the till page is closed. No card number is in them: the
 *     code a card showed is dropped before one is kept (saveTillPurchase).
 *     And the one Pay still going through, by its key, so a page closed
 *     before it answered can ask what it did.
 *
 * NEW SLOTS, NOT A NEW VERSION. Settings, store credit and till purchases are new keys in
 * the same `kv` store, so the database version stays 1 and nothing already
 * kept on a phone moves or has to be upgraded.
 *
 * WHY ONE WRAPPING KEY, MADE NON-EXTRACTABLE. A sealed box needs that key to
 * open, and the key cannot be exported, only used, by this origin, in this
 * browser. A copy of the database files alone opens nothing. Each box is
 * bound to its own slot name as AES-GCM additional data, so a box moved to
 * another slot fails to open rather than opening as something else.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST: script running on our own origin. It can
 * ask the key to decrypt like we do, at any time, without asking the person:
 * every card bought on this phone and kept here, leftovers included, not just
 * the one on screen. That is the page-trust residual the spec states (section
 * 19, item 1) and docs/mechanism/custody.md repeats, not something storage
 * can fix while the key needs no Face ID to use.
 *
 * Safari may clear a site's storage after seven days without a visit
 * (home-screen web apps are exempt). Losing this database loses no money:
 * the account is the passkey, and a bought card can be released again to a
 * new reply key once the root passkey rekeys it (spec section 8.10, a later
 * phase). The pages say so and suggest Add to Home Screen.
 *
 * Browser only by use, but imports nothing Node-only. Tests pass a fake
 * IDBFactory (tests/support/fake-indexeddb.ts). Never logs a value.
 */

import type { Hex } from 'viem'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import type { PurchaseHandle, RoutePlan, TillReceipt } from '@/lib/till/types'
import type { EscrowMerchantName, EscrowMode } from '../merchants'

const DB_NAME = 'salvo-pay'
const DB_VERSION = 1
const STORE = 'kv'
const WRAP_KEY_SLOT = 'wrap-key'
const AAD_PREFIX = 'salvo-pay|'

/** Storage is missing or refused: a private window, blocked site data, or a full disk. */
export class DeviceStorageError extends Error {
  constructor(detail: string) {
    super(`This browser would not let Salvo Pay keep anything on this device (${detail}).`)
    this.name = 'DeviceStorageError'
  }
}

/** An AES-GCM box: a random 12-byte IV and the ciphertext with its 16-byte tag. */
export interface SealedBox {
  iv: Uint8Array<ArrayBuffer>
  ct: Uint8Array<ArrayBuffer>
}

/** The passkey account. All public. */
export interface PasskeyRecord {
  credentialId: string
  /** Uncompressed P-256 public key, hex, without the 04 prefix: what viem's fromWebAuthnP256 takes. */
  publicKey: Hex
  /** The Tempo account address the passkey controls. */
  address: Hex
  rpId: string
  createdAt: number
  /**
   * TESTER ACCOUNT, no passkey: a P-256 key kept in this browser signs as
   * the root instead of Face ID (wallet.ts rootAccountOf). Made by "Set up
   * without Face ID" on /sell, for a laptop with no Windows Hello. Lost with
   * the browser's data. TO REPLACE with a password-protected key and a backup
   * file once the Target test is done (2026-10-22).
   */
  deviceKey?: { privateKey: CryptoKey; publicKey: P256PublicKey }
}

export type KeyRole = 'shopper' | 'seller'

/** A P-256 public key as ox and viem/tempo hold it. */
export interface P256PublicKey {
  prefix: number
  x: bigint
  y: bigint
}

/** One call scope an access key is allowed, as Tempo's key authorization names it. */
export interface CallScope {
  address: Hex
  selector: Hex
  recipients?: readonly Hex[]
}

/** What an access key may do, as signed into its key authorization. */
export interface KeyRestrictions {
  /** Unix seconds. */
  expiry: number
  /** Spending limits per TIP-20 token. Empty for a key that can never move a token. */
  limits: ReadonlyArray<{ token: Hex; limit: bigint; period?: number }>
  /** Never empty: an empty list would mean "any call". */
  scopes: readonly CallScope[]
}

export interface AccessKeyRecord {
  role: KeyRole
  /** The account (the passkey's address) this key signs for. */
  account: Hex
  accessKeyAddress: Hex
  /** privateKey is a non-extractable CryptoKey handle. */
  keyPair: { privateKey: CryptoKey; publicKey: P256PublicKey }
  restrictions: KeyRestrictions
  createdAt: number
}

/** One card of a purchase. */
export interface PurchaseLeg {
  intentId: string
  listingId: Hex
  /** The 13-key manifest, exactly as sealed. The release reply is keyed to its hash. */
  manifest: string
  envelope: LitEnvelope
  valueCents: number
  priceUnits: number
  scanOrder: number
  /** The slot of this card's sealed reply key. */
  replyKeyId: string
  replyPublicKey: Hex
  replyKeyHash: Hex
  /** The ticket's last valid second (chain time). After it, this batch can only revert. */
  ticketNotAfter: number
  /** Set once the purchase is final and its Opened event read. */
  depositId: string | null
  /** True once the card is decrypted and stored. */
  released: boolean
  /**
   * True when the seller refunded this card's sale in full before this phone
   * opened it: the money went back, and the card is the seller's again, so
   * its reply key is gone. Absent on purchases kept before this was added.
   */
  refunded?: boolean
}

export type PurchaseState =
  /** The batch is signed and its hash kept, and it may or may not have been sent. */
  | 'signed'
  /** The batch is final on chain, the deposits read. Cards not all released yet. */
  | 'paid'
  /** Every card is stored. */
  | 'done'
  /** The batch reverted or never landed: nothing was paid for these cards. */
  | 'failed'

export interface PurchaseRecord {
  id: string
  createdAt: number
  merchant: EscrowMerchantName
  depositor: Hex
  escrow: Hex
  txHash: Hex | null
  /**
   * The signed batch, kept so a page that died before sending it can send the
   * very same bytes again. Public once sent; it holds no key and no card.
   */
  raw: Hex | null
  /**
   * Whether a fee sponsor was set when this purchase was signed. Only then can
   * anyone but this phone hold its signed batch, so with none, a purchase that
   * never kept a hash was never sent. Absent on purchases kept before this was
   * added: read as set.
   */
  sponsorSet?: boolean
  /** Whether the signed batch is the sponsor's to pay the fee for. Absent until signed, or on older purchases. */
  feeSponsored?: boolean
  state: PurchaseState
  legs: PurchaseLeg[]
  /** A plain sentence for the last thing that went wrong, or null. */
  problem: string | null
}

export interface CardRecord {
  /** `<escrow>:<depositId>`: unique per purchase, so a later card never replaces a leftover one. */
  id: string
  escrow: Hex
  depositId: string
  listingId: Hex
  merchant: EscrowMerchantName
  valueCents: number
  priceUnits: number
  scanOrder: number
  /** How many cards the purchase had, for "Scan 1 of 2". */
  ofCards: number
  /** Shown under the code, as the reveal screen does. */
  last4: string
  boughtAt: number
  /**
   * The listing's mode: 1 when Lit read the balance before the sale, 2 when
   * nobody could. What /account may promise about a code that does not scan
   * depends on it. Absent on cards kept before this was added: read as 2.
   */
  mode?: EscrowMode
  /** The card's `{cardNumber, pin}` as JSON, sealed. */
  box: SealedBox
}

/** A seller's listing, as this browser made it. The card itself is not here. */
export interface ListingRecord {
  listingId: Hex
  seller: Hex
  merchant: EscrowMerchantName
  valueCents: number
  priceUnits: number
  listingExpiry: number
  manifest: string
  envelope: LitEnvelope
  /** The `list` transaction, once signed. */
  txHash: Hex | null
  /** True once our server recorded it. */
  posted: boolean
  createdAt: number
  /**
   * The deposit that bought it, once the seller's page has found it on chain
   * (sell.ts listingStates). Absent on listings kept before this was added.
   */
  depositId?: string | null
}

/**
 * One card of the shopper's own store credit. Theirs, so the till uses it at
 * no cost. `balanceCents` is what the shopper says is on it: nobody reads a
 * blind store's balance, and the till only plans with it.
 */
export interface OwnCardRecord {
  /** Random for a typed card; `kept-<card id>` for a card bought on this phone. */
  id: string
  merchant: EscrowMerchantName
  balanceCents: number
  last4: string
  addedAt: number
  /** A card bought on this phone: the CardRecord whose box holds its number. Absent for a typed card. */
  keptCardId?: string
  /** A typed card's `{cardNumber, pin}` as JSON, sealed. Absent for a kept card. */
  box?: SealedBox
}

/** The decrypted card. The caller drops it as soon as the code is drawn. */
export interface CardSecret {
  cardNumber: string
  pin: string | null
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

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(s))

function isBox(v: unknown): v is SealedBox {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Record<string, unknown>
  return b.iv instanceof Uint8Array && b.ct instanceof Uint8Array && b.iv.length === 12 && b.ct.length > 16
}

const CARD_SECRET_KEYS = 'cardNumber,pin'

function cardSecretOf(v: unknown): CardSecret | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (Object.keys(o).sort().join(',') !== CARD_SECRET_KEYS) return null
  if (typeof o.cardNumber !== 'string' || o.cardNumber.length < 1 || o.cardNumber.length > 128) return null
  if (o.pin !== null && (typeof o.pin !== 'string' || o.pin.length > 64)) return null
  return { cardNumber: o.cardNumber, pin: o.pin }
}

/**
 * The device's store. One per page; open it with `openCardStore`.
 */
export class CardStore {
  readonly #db: IDBDatabase
  #wrapKey: CryptoKey | null = null

  private constructor(db: IDBDatabase) {
    this.#db = db
  }

  /** Open (and on first use create) the database. Throws DeviceStorageError when the browser refuses. */
  static async open(factory: IDBFactory | null): Promise<CardStore> {
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
    return new CardStore(db)
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

  async #slotsWith(prefix: string): Promise<string[]> {
    const keys = await this.#run('readonly', (s) => s.getAllKeys())
    return keys.filter((k): k is string => typeof k === 'string' && k.startsWith(prefix)).sort()
  }

  // -------------------------------------------------------------------------
  // The wrapping key
  // -------------------------------------------------------------------------

  /**
   * The one non-extractable AES-GCM key every box is sealed with. Made on
   * first use and written with `add`, never `put`: two tabs opening the store
   * at once must not each write their own key, or the boxes sealed under the
   * first would never open again. The loser of that race reads the winner's.
   */
  async #key(): Promise<CryptoKey> {
    if (this.#wrapKey !== null) return this.#wrapKey
    let key: CryptoKey
    const existing = await this.#get(WRAP_KEY_SLOT)
    if (existing instanceof CryptoKey) {
      key = existing
    } else {
      const made = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      try {
        await this.#run('readwrite', (s) => s.add(made, WRAP_KEY_SLOT))
        key = made
      } catch {
        const winner = await this.#get(WRAP_KEY_SLOT)
        if (!(winner instanceof CryptoKey)) throw new DeviceStorageError('the device key could not be kept')
        key = winner
      }
    }
    this.#wrapKey = key
    return key
  }

  async #seal(slot: string, plain: Uint8Array): Promise<SealedBox> {
    const key = await this.#key()
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(
      await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(AAD_PREFIX + slot) }, key, new Uint8Array(plain)),
    )
    return { iv, ct }
  }

  /** Throws when the box was sealed for another slot, by another key, or changed. */
  async #open(slot: string, box: SealedBox): Promise<Uint8Array<ArrayBuffer>> {
    const key = await this.#key()
    return new Uint8Array(
      await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv, additionalData: utf8(AAD_PREFIX + slot) }, key, box.ct),
    )
  }

  // -------------------------------------------------------------------------
  // The passkey account and access keys
  // -------------------------------------------------------------------------

  async passkey(): Promise<PasskeyRecord | null> {
    const v = await this.#get('passkey')
    return typeof v === 'object' && v !== null ? (v as PasskeyRecord) : null
  }

  async savePasskey(r: PasskeyRecord): Promise<void> {
    await this.#put('passkey', r)
  }

  async accessKey(role: KeyRole): Promise<AccessKeyRecord | null> {
    const v = await this.#get(`access-key:${role}`)
    if (typeof v !== 'object' || v === null) return null
    const r = v as AccessKeyRecord
    return r.keyPair?.privateKey instanceof CryptoKey ? r : null
  }

  async saveAccessKey(r: AccessKeyRecord): Promise<void> {
    await this.#put(`access-key:${r.role}`, r)
  }

  async deleteAccessKey(role: KeyRole): Promise<void> {
    await this.#delete(`access-key:${role}`)
  }

  /** The passkey-signed authorization an access key's first transaction carries. Keyed by account and key. */
  async pendingAuthorization(name: string): Promise<unknown> {
    return (await this.#get(`pending-auth:${name}`)) ?? undefined
  }

  async savePendingAuthorization(name: string, authorization: unknown): Promise<void> {
    await this.#put(`pending-auth:${name}`, authorization)
  }

  async deletePendingAuthorization(name: string): Promise<void> {
    await this.#delete(`pending-auth:${name}`)
  }

  // -------------------------------------------------------------------------
  // Reply keys
  // -------------------------------------------------------------------------

  /** Seal and keep one card's reply key. The caller zeroes its own copy. */
  async saveReplyKey(id: string, secretKey: Uint8Array): Promise<void> {
    if (secretKey.length !== 32) throw new RangeError('a reply key is 32 bytes')
    const slot = `reply:${id}`
    await this.#put(slot, await this.#seal(slot, secretKey))
  }

  /** The reply key's 32 bytes, or null when it is gone. The caller zeroes them. */
  async replyKey(id: string): Promise<Uint8Array | null> {
    const slot = `reply:${id}`
    const box = await this.#get(slot)
    if (!isBox(box)) return null
    const bytes = await this.#open(slot, box)
    if (bytes.length !== 32) {
      bytes.fill(0)
      return null
    }
    return bytes
  }

  async deleteReplyKey(id: string): Promise<void> {
    await this.#delete(`reply:${id}`)
  }

  // -------------------------------------------------------------------------
  // Purchases in flight
  // -------------------------------------------------------------------------

  async savePurchase(p: PurchaseRecord): Promise<void> {
    await this.#put(`purchase:${p.id}`, p)
  }

  async purchase(id: string): Promise<PurchaseRecord | null> {
    const v = await this.#get(`purchase:${id}`)
    return typeof v === 'object' && v !== null ? (v as PurchaseRecord) : null
  }

  /** Newest first. */
  async purchases(): Promise<PurchaseRecord[]> {
    const out: PurchaseRecord[] = []
    for (const slot of await this.#slotsWith('purchase:')) {
      const v = await this.#get(slot)
      if (typeof v === 'object' && v !== null) out.push(v as PurchaseRecord)
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  /**
   * Seal and keep a decrypted card. Idempotent per card id: a release retried
   * after a crash writes the same card again, never a second one.
   */
  async saveCard(meta: Omit<CardRecord, 'box'>, secret: CardSecret): Promise<void> {
    const slot = `card:${meta.id}`
    const plain = utf8(JSON.stringify({ cardNumber: secret.cardNumber, pin: secret.pin }))
    try {
      await this.#put(slot, { ...meta, box: await this.#seal(slot, plain) } satisfies CardRecord)
    } finally {
      plain.fill(0)
    }
  }

  /** Is this card on this device? Nothing is decrypted. */
  async hasCard(id: string): Promise<boolean> {
    const v = await this.#get(`card:${id}`)
    return typeof v === 'object' && v !== null && isBox((v as CardRecord).box)
  }

  /** Every card on this device, newest first. Nothing is decrypted. */
  async cards(): Promise<CardRecord[]> {
    const out: CardRecord[] = []
    for (const slot of await this.#slotsWith('card:')) {
      const v = await this.#get(slot)
      if (typeof v === 'object' && v !== null && isBox((v as CardRecord).box)) out.push(v as CardRecord)
    }
    return out.sort((a, b) => b.boughtAt - a.boughtAt || a.scanOrder - b.scanOrder)
  }

  /** Open one card's number and PIN. Null when the card is not here or its box does not open. */
  async cardSecret(id: string): Promise<CardSecret | null> {
    const slot = `card:${id}`
    const v = await this.#get(slot)
    if (typeof v !== 'object' || v === null || !isBox((v as CardRecord).box)) return null
    let bytes: Uint8Array | null = null
    try {
      bytes = await this.#open(slot, (v as CardRecord).box)
      return cardSecretOf(JSON.parse(new TextDecoder().decode(bytes)))
    } catch {
      return null
    } finally {
      bytes?.fill(0)
    }
  }

  // -------------------------------------------------------------------------
  // A seller's listings
  // -------------------------------------------------------------------------

  async saveListing(r: ListingRecord): Promise<void> {
    await this.#put(`listing:${r.listingId}`, r)
  }

  /** Forget a listing this browser kept: one that never reached the chain (sell.ts forgetListing). */
  async deleteListing(listingId: Hex): Promise<void> {
    await this.#delete(`listing:${listingId}`)
  }

  /** Newest first. */
  async listings(): Promise<ListingRecord[]> {
    const out: ListingRecord[] = []
    for (const slot of await this.#slotsWith('listing:')) {
      const v = await this.#get(slot)
      if (typeof v === 'object' && v !== null) out.push(v as ListingRecord)
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  // -------------------------------------------------------------------------
  // The account's settings
  // -------------------------------------------------------------------------

  /** The settings as kept, unread: src/lib/account/settings.ts says what they mean. Null when none are kept. */
  async accountSettings(): Promise<unknown> {
    return (await this.#get('settings')) ?? null
  }

  async saveAccountSettings(value: object): Promise<void> {
    await this.#put('settings', value)
  }

  /**
   * The store a till last opened on, for a /pay with none named. Its own
   * slot, never the settings': opening a till is not a choice the shopper
   * made, and the settings slot is how sign-in tells whether this browser
   * has choices of its own to keep (account/client/settings.ts).
   */
  async lastStore(): Promise<string | null> {
    const v = await this.#get(LAST_STORE_SLOT)
    return typeof v === 'string' ? v : null
  }

  async saveLastStore(id: string): Promise<void> {
    await this.#put(LAST_STORE_SLOT, id)
  }

  // -------------------------------------------------------------------------
  // The first escrow's cards, matched (account/client/match-v1.ts)
  // -------------------------------------------------------------------------

  /** The first escrow's cards this phone has settled for `account`: their fingerprints given, or nothing to give. Never asked again. */
  async matchedV1(account: Hex): Promise<Set<string>> {
    const prefix = `${MATCHED_V1_SLOT}:${account.toLowerCase()}:`
    return new Set((await this.#slotsWith(prefix)).map((s) => s.slice(prefix.length)))
  }

  /** Not secret: the card's id and when, no number and no fingerprint. */
  async saveMatchedV1(account: Hex, cardId: string): Promise<void> {
    await this.#put(`${MATCHED_V1_SLOT}:${account.toLowerCase()}:${cardId}`, { at: Date.now() })
  }

  // -------------------------------------------------------------------------
  // Store credit
  // -------------------------------------------------------------------------

  /**
   * Keep one card of store credit. A typed card's number and PIN are sealed
   * to its own slot; a kept card's stay in the bought card's box. Idempotent
   * per id, so saving again changes the balance and nothing else.
   */
  async saveOwnCard(meta: Omit<OwnCardRecord, 'box'>, secret: CardSecret | null): Promise<void> {
    const slot = `own:${meta.id}`
    if (secret === null) {
      if (meta.keptCardId === undefined) throw new RangeError('a typed card needs its number')
      await this.#put(slot, { ...meta } satisfies OwnCardRecord)
      return
    }
    const plain = utf8(JSON.stringify({ cardNumber: secret.cardNumber, pin: secret.pin }))
    try {
      await this.#put(slot, { ...meta, box: await this.#seal(slot, plain) } satisfies OwnCardRecord)
    } finally {
      plain.fill(0)
    }
  }

  /** Every card of store credit on this phone, newest first. Nothing is decrypted. */
  async ownCards(): Promise<OwnCardRecord[]> {
    const out: OwnCardRecord[] = []
    for (const slot of await this.#slotsWith('own:')) {
      const v = await this.#get(slot)
      if (typeof v !== 'object' || v === null) continue
      const r = v as OwnCardRecord
      if (isBox(r.box) || typeof r.keptCardId === 'string') out.push(r)
    }
    return out.sort((a, b) => b.addedAt - a.addedAt)
  }

  /** Open one card of store credit: a typed card's own box, or the bought card it points at. */
  async ownCardSecret(id: string): Promise<CardSecret | null> {
    const slot = `own:${id}`
    const v = await this.#get(slot)
    if (typeof v !== 'object' || v === null) return null
    const r = v as OwnCardRecord
    if (typeof r.keptCardId === 'string') return this.cardSecret(r.keptCardId)
    if (!isBox(r.box)) return null
    let bytes: Uint8Array | null = null
    try {
      bytes = await this.#open(slot, r.box)
      return cardSecretOf(JSON.parse(new TextDecoder().decode(bytes)))
    } catch {
      return null
    } finally {
      bytes?.fill(0)
    }
  }

  /** Forget one card of store credit. A kept card stays under My cards: only its place in the credit goes. */
  async deleteOwnCard(id: string): Promise<void> {
    await this.#delete(`own:${id}`)
  }

  // -------------------------------------------------------------------------
  // The card till's purchases, for "Something went wrong?"
  // -------------------------------------------------------------------------

  /**
   * Keep one till purchase on this phone: its signed handle, its cards and
   * what it came to, so its receipt and "Something went wrong?" can be opened
   * again from Account after the till page is gone. Not secret: the handle
   * acts only for the card customer this browser pays with. Idempotent per id.
   *
   * NEVER A CODE. A purchase on screen carries its first card's code, which
   * is a gift card number, and this slot is not sealed. So only the fields a
   * report needs are copied in, by name: whatever else a caller hands over
   * (the code it had on screen) never reaches the disk.
   */
  async saveTillPurchase(r: TillPurchaseRecord): Promise<void> {
    const { rail, ref, plan } = r.purchase
    const kept: TillPurchaseRecord = {
      id: r.id,
      store: r.store,
      purchase: { rail, ref, plan },
      receipt: r.receipt,
      createdAt: r.createdAt,
      ...(r.signedOut === true ? { signedOut: true as const } : {}),
    }
    await this.#put(`till:${r.id}`, kept)
  }

  /** Every till purchase kept here, newest first. One kept with a code by an earlier build is kept again without it. */
  async tillPurchases(): Promise<TillPurchaseRecord[]> {
    const out: TillPurchaseRecord[] = []
    for (const slot of await this.#slotsWith('till:')) {
      const v = await this.#get(slot)
      if (typeof v !== 'object' || v === null || typeof (v as TillPurchaseRecord).createdAt !== 'number') continue
      const r = v as TillPurchaseRecord
      if (typeof r.purchase === 'object' && r.purchase !== null && 'code' in r.purchase) await this.saveTillPurchase(r)
      out.push({ ...r, purchase: { rail: r.purchase.rail, ref: r.purchase.ref, plan: r.purchase.plan } })
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  async deleteTillPurchase(id: string): Promise<void> {
    await this.#delete(`till:${id}`)
  }

  /**
   * The till's Pay still going through, kept before it is sent: its key, the
   * store and the plan the button showed. A page closed or reloaded before
   * Pay answered leaves this behind, and the till asks with the same key what
   * that tap did. One per store: a Pay at another store never writes over
   * one this phone has not heard back from yet.
   */
  async savePendingTillPay(r: PendingTillPay): Promise<void> {
    await this.#put(`${PENDING_SLOT}:${r.store}`, { key: r.key, store: r.store, plan: r.plan, at: r.at })
  }

  /** Every Pay this phone has not heard back from, one per store. An earlier build's single slot is read too. */
  async pendingTillPays(): Promise<PendingTillPay[]> {
    const out: PendingTillPay[] = []
    for (const slot of await this.#slotsWith(PENDING_SLOT)) {
      const r = pendingOf(await this.#get(slot))
      if (r !== null && !out.some((o) => o.store === r.store)) out.push(r)
    }
    return out
  }

  async deletePendingTillPay(store: string): Promise<void> {
    await this.#delete(`${PENDING_SLOT}:${store}`)
    if (pendingOf(await this.#get(PENDING_SLOT))?.store === store) await this.#delete(PENDING_SLOT)
  }

  /**
   * Forget the account on this browser: its passkey record, both access keys
   * and their pending authorizations, its settings and the store its till
   * last opened on, its store credit, and the till's purchases and
   * unanswered Pays. Signing out runs this, and so does signing in here as
   * another account (passkey.ts continueWithFaceId). Signing out on someone else's phone
   * or computer must leave nothing that pays, signs or shows as that account:
   * an access key left here signed a purchase with no prompt, and the record
   * kept the next person from signing in as themselves. An access key's
   * private half lives only in this store, made non-extractable, so deleting
   * it ends it.
   *
   * Not the gift cards bought here with dollars, or a purchase of them still
   * in flight: those open nowhere else yet (spec 8.10), and deleting them
   * would lose them.
   *
   * A DOLLARS PURCHASE IS KEPT, MARKED. Its handle points into the V2 book,
   * which outlives the sign-out, and it is how its account reports a card
   * for 48 hours. Marked `signedOut`, it is listed again only for the
   * account whose V2 purchase it is (client/recent.ts recentTillPurchasesOf).
   * A Pay still going through needs no key kept here: the dollars rail finds
   * it in the V2 book by the tap's own key, for that account only
   * (dollars-backend.ts unfinishedPays). A card purchase acts only for this
   * browser's card customer, and goes.
   */
  async forgetAccount(): Promise<void> {
    const named = ['passkey', 'access-key:shopper', 'access-key:seller', 'settings', LAST_STORE_SLOT]
    const prefixed = (await Promise.all(['pending-auth:', 'own:', PENDING_SLOT].map((p) => this.#slotsWith(p)))).flat()
    for (const slot of [...named, ...prefixed]) await this.#delete(slot)
    for (const r of await this.tillPurchases()) {
      if (r.purchase.rail === 'stablecoin') await this.saveTillPurchase({ ...r, signedOut: true })
      else await this.deleteTillPurchase(r.id)
    }
  }
}

/** The slot prefix of the till's unanswered Pays; the bare name is an earlier build's one slot. */
const PENDING_SLOT = 'till-pending'
/** The store a till last opened on (CardStore.lastStore). */
const LAST_STORE_SLOT = 'last-store'
/** The first escrow's cards settled for an account: `v1-match:<account>:<card id>`. */
const MATCHED_V1_SLOT = 'v1-match'

function pendingOf(v: unknown): PendingTillPay | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Partial<PendingTillPay>
  return typeof r.key === 'string' && typeof r.store === 'string' && typeof r.at === 'number' && typeof r.plan === 'object' && r.plan !== null
    ? { key: r.key, store: r.store, plan: r.plan, at: r.at }
    : null
}

/** A Pay sent from the till whose answer has not come back yet. */
export interface PendingTillPay {
  /** The tap's key: asked again with it, the server finds what that tap did. */
  key: string
  store: string
  plan: RoutePlan
  at: number
}

/** A till purchase as this phone keeps it. */
export interface TillPurchaseRecord {
  id: string
  /** The store's id. */
  store: string
  /** Its handle and cards. Never its code (saveTillPurchase). */
  purchase: PurchaseHandle
  receipt: TillReceipt
  createdAt: number
  /** A dollars purchase kept across a sign-out: listed only for the account whose V2 purchase it is (forgetAccount). */
  signedOut?: true
}

/** The page's store, on the browser's own IndexedDB. */
export function openCardStore(factory: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB): Promise<CardStore> {
  return CardStore.open(factory)
}
