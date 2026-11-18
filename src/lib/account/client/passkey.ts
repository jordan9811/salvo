/**
 * "Continue with Face ID": the phone's half of one Salvo account
 * (unified-account spec, section 3.2).
 *
 * ===========================================================================
 * FIND THE PASSKEY BEFORE MAKING ONE. The account is the passkey, and iCloud
 * Keychain syncs it to every Safari tab and Home Screen icon on the phone, but
 * each of those keeps its own empty store. Making a passkey whenever the
 * store is empty gave a second account in every new container, through every
 * page that sets one up: /account, and the dollars setup on /account and /sell
 * too (wallet.ts setUpDeviceWallet). So nothing here makes a passkey before
 * asking the phone for the Salvo passkey it has (a discoverable
 * `credentials.get`): sign-in asks, and makes one only for a shopper who has
 * none and says so (createAccount); `ensurePasskey`, which the dollars setup
 * calls, asks, and makes one only when the phone offers none.
 *
 * ONE FACE ID FINDS IT AND SIGNS IN. The assertion that finds the passkey is
 * the one our server verifies. Its public key is recovered from the
 * signature (webauthn.ts), which leaves two candidates, and the right one is
 * the one with an account behind it, in this order:
 *   1. this phone's own record of the passkey, when it has one;
 *   2. dollars on chain at one address and not the other;
 *   3. a saved card linked to one address and not the other (our server
 *      looks, inside the same sign-in);
 *   4. neither: one more Face ID with the same passkey, and the key both
 *      signatures recover to is the passkey's. A random point recovers from
 *      one signature, never from two.
 * The key found is written to this phone's store as the passkey record, so
 * the next sign-in here, and the dollars setup, use it with no recovery and
 * never make another.
 *
 * A CANCELLED SHEET IS NOT "MAKE ME A NEW ACCOUNT". A phone with no Salvo
 * passkey shows an empty sheet, and the shopper closes it; a shopper who
 * closed it by mistake looks the same. So a cancel answers `found: false`,
 * and the page asks before createAccount runs. An automatic create there
 * would be the duplicate account this file exists to stop.
 *
 * SIGNING IN TO OUR SERVER IS FOR THE CARD. The dollars rail needs no server
 * session: its access key signs on the phone. A passkey made here is not
 * signed in until something needs it (saving a card), and then
 * ensureSignedIn asks for the one Face ID it costs.
 * ===========================================================================
 *
 * Browser only by use; imports nothing Node-only. Tests pass a fake
 * authenticator, a fake IndexedDB and the routes in-process. Never logs a
 * key.
 */

import type { Hex } from 'viem'
import type { CardStore, PasskeyRecord } from '@/lib/escrow/client/card-store'
import type { FetchLike } from '@/lib/escrow/client/api'
import { PATH_USD } from '@/lib/escrow/manifest'
import { tokenBalanceAt } from '@/lib/escrow/runbook/reads'
import { agreedFinalizedBlock, type HostsConfig } from '@/lib/escrow/runbook/rpc'
import { PublicKey, WebAuthnP256, WebCryptoP256 } from 'viem/tempo'
import type { PasskeyOptions } from '@/lib/escrow/client/wallet'
import { settingsFromPrefs, prefsOf, type AccountSettings } from '../settings'
import { fromBase64Url, passkeyAddress, recoverPublicKeys, toBase64Url, type AssertionParts } from '../webauthn'

// ===========================================================================
// What our server says
// ===========================================================================

/** This browser's account, as GET /api/account and the sign-in answer it. No card processor id is ever in it. */
export interface AccountView {
  signedIn: boolean
  /** The passkey's Tempo address, lower case, when signed in. */
  address: Hex | null
  /** Whether paying by card can run on this server at all. */
  cardRail: boolean
  /** The saved card, by brand and last four digits only. */
  card: { brand: string | null; last4: string } | null
  /**
   * The card is the account's own, on every device it signs in on. False for
   * a card this browser saved on its own: it pays here only, until it is
   * saved under the account.
   */
  cardLinked: boolean
  /** False when the card processor could not be asked: then `card` says nothing either way. */
  cardKnown: boolean
  /** Held on that card right now, for purchases at the till. */
  heldCents: number
  /** The most the card rail holds at once. */
  allowanceCents: number
  /** The settings the card customer carries, for a phone that has none yet. */
  settings: AccountSettings | null
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const cents = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0)

/** An answer from our account routes as a view, or null when it is not one. */
export function parseAccountView(body: unknown): AccountView | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (typeof b.signedIn !== 'boolean') return null
  const address = typeof b.address === 'string' && ADDRESS_RE.test(b.address) ? (b.address as Hex) : null
  const c = typeof b.card === 'object' && b.card !== null ? (b.card as Record<string, unknown>) : null
  const card =
    c !== null && typeof c.last4 === 'string' && /^\d{4}$/.test(c.last4)
      ? { brand: typeof c.brand === 'string' ? c.brand : null, last4: c.last4 }
      : null
  return {
    signedIn: b.signedIn && address !== null,
    address,
    cardRail: b.cardRail === true,
    card,
    cardLinked: card !== null && b.cardLinked === true,
    cardKnown: b.cardKnown !== false,
    heldCents: cents(b.heldCents),
    allowanceCents: cents(b.allowanceCents),
    settings: typeof b.prefs === 'string' ? settingsFromPrefs(b.prefs) : null,
  }
}

/**
 * Our server's word on a first-escrow card's fingerprint (listing-v2.ts
 * recordV1FingerprintByBuyer): kept now, kept before, a sale this account
 * did not buy, or no such sale.
 */
export type V1MatchAnswer = 'recorded' | 'already' | 'not_yours' | 'no_sale'

export type SignInAnswer =
  | { kind: 'ok'; view: AccountView }
  /** Neither key had an account behind it: one more Face ID decides. */
  | { kind: 'which' }
  | { kind: 'refused'; message: string }

const sentence = (body: unknown, fallback: string): string => {
  const m = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).message : undefined
  return typeof m === 'string' && m.length > 0 && m.length < 300 ? m : fallback
}

/** Our account routes, from the page. Same-origin fetches, so the HttpOnly cookies ride along. */
export class AccountApi {
  readonly #fetch: FetchLike

  constructor(fetchImpl: FetchLike) {
    this.#fetch = fetchImpl
  }

  async #json(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const res = await this.#fetch(path, { cache: 'no-store', ...init })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body }
  }

  /** This browser's account, or null when our server did not answer. */
  async view(): Promise<AccountView | null> {
    try {
      const a = await this.#json('/api/account')
      return a.status === 200 ? parseAccountView(a.body) : null
    } catch {
      return null
    }
  }

  /** A fresh challenge, good for five minutes, in this browser only. */
  async challenge(): Promise<string> {
    const a = await this.#json('/api/account/challenge')
    const c = typeof a.body === 'object' && a.body !== null ? (a.body as Record<string, unknown>).challenge : undefined
    if (a.status !== 200 || typeof c !== 'string') throw new AccountRefused(sentence(a.body, 'Sign-in is not available right now.'))
    return c
  }

  async signIn(body: AssertionParts & { challenge: string; publicKey: Hex; altPublicKey: Hex | null }): Promise<SignInAnswer> {
    const a = await this.#json('/api/account/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (a.status === 409) return { kind: 'which' }
    const view = a.status === 200 ? parseAccountView(a.body) : null
    if (view === null || !view.signedIn) return { kind: 'refused', message: sentence(a.body, 'We could not sign you in. Nothing was changed.') }
    return { kind: 'ok', view }
  }

  /**
   * Sign this browser out: the session, and the account's card with it. True
   * when our server said so. The passkey stays in the phone's keychain.
   */
  async signOut(): Promise<boolean> {
    try {
      const a = await this.#json('/api/account/session', { method: 'DELETE' })
      return a.status === 200
    } catch {
      return false
    }
  }

  /**
   * Give our server the fingerprint of a card this account bought on the
   * first escrow (match-v1.ts): never the card. Our server's word on it, or
   * null when it did not answer or this browser is not signed in to it.
   */
  async matchV1Card(depositId: string, cardFingerprint: Hex): Promise<V1MatchAnswer | null> {
    try {
      const a = await this.#json('/api/escrow/fingerprint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ depositId, cardFingerprint }),
      })
      const o = a.status === 200 && typeof a.body === 'object' && a.body !== null ? (a.body as Record<string, unknown>).outcome : undefined
      return o === 'recorded' || o === 'already' || o === 'not_yours' || o === 'no_sale' ? o : null
    } catch {
      return null
    }
  }

  /** Copy the settings to the card customer. False when there is none to copy to, or our server did not take them. */
  async savePrefs(s: AccountSettings): Promise<boolean> {
    try {
      const a = await this.#json('/api/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs: prefsOf(s) }),
      })
      return a.status === 200 && typeof a.body === 'object' && a.body !== null && (a.body as Record<string, unknown>).saved === true
    } catch {
      return false
    }
  }
}

/** The page's account API, on the browser's own fetch. */
export function accountApi(fetchImpl: FetchLike = (input, init) => fetch(input, init)): AccountApi {
  return new AccountApi(fetchImpl)
}

/**
 * Sign this browser out of our server, then forget the account in it: the
 * passkey record, the dollars keys, the settings, the store credit and the
 * till's card purchases; a dollars purchase is kept, for its own account
 * only (card-store.ts forgetAccount). The server first, so a
 * sign-out that did not reach it says so and forgets nothing: the card would
 * still pay here. The passkey itself stays in the phone's keychain.
 */
export async function signOutHere(d: { store: CardStore; api: AccountApi }): Promise<void> {
  if (!(await d.api.signOut())) throw new AccountRefused('That did not work. You are still signed in. Try again.')
  await d.store.forgetAccount()
}

/**
 * The dollars key in a page's memory, only while it is `address`'s. A page
 * keeps the key it loaded; signed out and signed in as someone else without
 * a reload, it showed the first account's allowance, ticked its rail, and
 * Finish it would have signed with its key. Null for anyone else's.
 */
export function keyOfAccount<W extends { account: string }>(wallet: W | null, address: string): W | null {
  return wallet !== null && wallet.account.toLowerCase() === address.toLowerCase() ? wallet : null
}

/** Our server said no, in a sentence the page can show. */
export class AccountRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountRefused'
  }
}

// ===========================================================================
// The authenticator
// ===========================================================================

/** A Face ID the person cancelled, or a sheet with no passkey on it, however deep the library wrapped it. */
export function faceIdCancelled(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e instanceof Error && i < 6; e = (e as Error & { cause?: unknown }).cause, i++) {
    if (e.name === 'NotAllowedError' || e.name === 'AbortError') return true
  }
  return false
}

function rpIdOf(o: PasskeyOptions): string {
  if (o.rpId !== undefined && o.rpId !== '') return o.rpId
  const host = typeof location === 'undefined' ? '' : location.hostname
  if (host === '') throw new Error('a passkey needs the page hostname')
  return host
}

const bytesOf = (v: ArrayBuffer | ArrayBufferView): Uint8Array =>
  v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength)

/**
 * One Face ID: the phone signs `challenge` with a Salvo passkey. With a
 * credential id, only that passkey; without one, any this site has, and the
 * phone shows its own picker (a discoverable request).
 */
async function assert(o: PasskeyOptions, input: { challenge: string; rpId: string; credentialId?: string }): Promise<AssertionParts> {
  const options: CredentialRequestOptions = {
    publicKey: {
      challenge: new TextEncoder().encode(input.challenge),
      rpId: input.rpId,
      userVerification: 'required',
      timeout: 60_000,
      ...(input.credentialId !== undefined ? { allowCredentials: [{ type: 'public-key' as const, id: fromBase64Url(input.credentialId) }] } : {}),
    },
  }
  // The tests' authenticator takes the browser's own options; ox types its hook more narrowly.
  const got = o.getFn ? await o.getFn(options as never) : await navigator.credentials.get(options)
  if (got === null || typeof got !== 'object') {
    const e = new Error('no passkey was offered')
    e.name = 'NotAllowedError'
    throw e
  }
  const cred = got as PublicKeyCredential
  const r = cred.response as AuthenticatorAssertionResponse
  return {
    credentialId: typeof cred.id === 'string' && cred.id !== '' ? cred.id : toBase64Url(bytesOf(cred.rawId)),
    authenticatorData: toBase64Url(bytesOf(r.authenticatorData)),
    clientDataJSON: toBase64Url(bytesOf(r.clientDataJSON)),
    signature: toBase64Url(bytesOf(r.signature)),
  }
}

// ===========================================================================
// Signing in
// ===========================================================================

export type SignInStep = 'face_id' | 'checking' | 'face_id_again'

export type SignInOutcome =
  | { found: true; passkey: PasskeyRecord; view: AccountView }
  /** No Salvo passkey was offered, or the shopper closed the sheet. Nothing was made. */
  | { found: false }

export interface SignInDeps {
  store: CardStore
  api: AccountApi
  passkey?: PasskeyOptions
  /** Whether an address holds dollars, read from the chain. Absent where the dollars rail is off. */
  hasDollars?: (address: Hex) => Promise<boolean>
  onStep?: (step: SignInStep) => void
}

/** One Face ID with this phone's own passkey, and our server's session for it. */
async function signInWith(d: SignInDeps, passkey: PasskeyRecord, challenge?: string): Promise<AccountView> {
  const c = challenge ?? (await d.api.challenge())
  d.onStep?.('face_id')
  const a = await assert(d.passkey ?? {}, { challenge: c, rpId: passkey.rpId, credentialId: passkey.credentialId })
  d.onStep?.('checking')
  const answer = await d.api.signIn({ ...a, challenge: c, publicKey: passkey.publicKey, altPublicKey: null })
  if (answer.kind !== 'ok') throw new AccountRefused(answer.kind === 'refused' ? answer.message : 'We could not sign you in. Nothing was changed.')
  return answer.view
}

/**
 * Find this shopper's passkey and sign in with it: the steps in the header.
 * `challenge` is one the page fetched before the tap, so the Face ID sheet
 * opens straight from the tap. Throws AccountRefused for our server's no,
 * and passes a failed Face ID through unless it is the first, searching one.
 */
export async function continueWithFaceId(
  d: SignInDeps,
  opts: {
    challenge?: string
    /**
     * Ask the phone even when this browser keeps a passkey record: the
     * shopper chose to sign in with the account this browser's session names,
     * not the one its store kept. The one found replaces the record, and
     * when it is another account, the kept one is forgotten here first.
     */
    discover?: boolean
    /** This browser's record, when the caller already knows it: no store read before the sheet. */
    existing?: PasskeyRecord | null
  } = {},
): Promise<SignInOutcome> {
  const o = d.passkey ?? {}
  // A caller that already knows this browser's record says so, and nothing is
  // awaited before the Face ID sheet: Safari opens it only straight from a tap.
  const existing = opts.existing !== undefined ? opts.existing : await d.store.passkey()
  if (existing !== null && opts.discover !== true) {
    const view = await signInWith(d, existing, opts.challenge)
    return { found: true, passkey: existing, view }
  }

  const rpId = rpIdOf(o)
  const challenge = opts.challenge ?? (await d.api.challenge())
  d.onStep?.('face_id')
  let first: AssertionParts
  try {
    first = await assert(o, { challenge, rpId })
  } catch (err) {
    if (faceIdCancelled(err)) return { found: false }
    throw err
  }
  d.onStep?.('checking')
  const candidates = recoverPublicKeys(first)
  if (candidates.length === 0) throw new AccountRefused('That passkey could not be read. Nothing was changed.')

  let chosen: Hex | null = candidates.length === 1 ? (candidates[0] as Hex) : null
  if (chosen === null && d.hasDollars !== undefined) {
    const peek = d.hasDollars
    const has = await Promise.all(candidates.map((k) => peek(passkeyAddress(k)).catch(() => false)))
    const hits = candidates.filter((_, i) => has[i] === true)
    if (hits.length === 1) chosen = hits[0] as Hex
  }

  let signed: { parts: AssertionParts; challenge: string } = { parts: first, challenge }
  let answer = await d.api.signIn({
    ...first,
    challenge,
    publicKey: chosen ?? (candidates[0] as Hex),
    altPublicKey: chosen === null ? (candidates[1] ?? null) : null,
  })
  if (answer.kind === 'which') {
    const again = await d.api.challenge()
    d.onStep?.('face_id_again')
    const second = await assert(o, { challenge: again, rpId, credentialId: first.credentialId })
    d.onStep?.('checking')
    const both = recoverPublicKeys(second).filter((k) => candidates.includes(k))
    if (both.length !== 1) throw new AccountRefused('That passkey could not be read. Nothing was changed.')
    chosen = both[0] as Hex
    signed = { parts: second, challenge: again }
    answer = await d.api.signIn({ ...second, challenge: again, publicKey: chosen, altPublicKey: null })
  }
  if (answer.kind !== 'ok') throw new AccountRefused(answer.kind === 'refused' ? answer.message : 'We could not sign you in. Nothing was changed.')

  // Our server says which address it signed in; the key is the candidate that derives it.
  const publicKey = candidates.find((k) => passkeyAddress(k) === answer.view.address)
  if (publicKey === undefined) throw new AccountRefused('We could not sign you in. Nothing was changed.')
  const record: PasskeyRecord = {
    credentialId: signed.parts.credentialId,
    publicKey,
    address: passkeyAddress(publicKey),
    rpId,
    createdAt: Date.now(),
  }
  // ANOTHER ACCOUNT IN PLACE OF THE ONE THIS BROWSER KEPT: the first is
  // forgotten here first, as signing out does (card-store.ts forgetAccount).
  // Only the record was replaced, and the till pays from this browser's
  // store credit with no account on it: the second account was handed the
  // first's gift cards, its settings, its purchases and its unanswered Pays.
  if (existing !== null && existing.address.toLowerCase() !== record.address.toLowerCase()) await d.store.forgetAccount()
  await d.store.savePasskey(record)
  return { found: true, passkey: record, view: answer.view }
}

/**
 * Our server's session for this phone's passkey: the one in hand when it is
 * already this account's, or one Face ID for a new one. Saving a card needs
 * it, so the card lands on this account.
 */
export async function ensureSignedIn(d: SignInDeps, passkey: PasskeyRecord, current: AccountView | null, challenge?: string | null): Promise<AccountView> {
  if (current !== null && current.signedIn && current.address === passkey.address) return current
  // A challenge fetched before the tap: Safari opens the sheet only straight from it.
  return signInWith(d, passkey, challenge ?? undefined)
}

/**
 * A new account: a new passkey on this phone (one Face ID). Only after
 * continueWithFaceId found none and the shopper asked for one, so it never
 * makes a second account beside one they have.
 */
export async function createAccount(store: CardStore, o: PasskeyOptions = {}): Promise<PasskeyRecord> {
  return createPasskey(store, o)
}

/**
 * The device's passkey account, for the dollars setup on any page (wallet.ts
 * setUpDeviceWallet): this browser's own record; else the Salvo passkey the
 * phone already has, found and kept; else a new one.
 *
 * ===========================================================================
 * NEVER A NEW PASSKEY WHILE THE PHONE HAS ONE. This used to make a passkey
 * whenever this browser's store was empty. Safari can clear a site's store
 * after a week without a visit, and every Home Screen icon has its own: so
 * "Set up with Face ID" on /sell or /pay made a second account beside the one
 * in iCloud Keychain, and its card and listings split from the first. Now the
 * phone is asked first, with a challenge made here (no server is needed to
 * read a public key), and the key is recovered from the signature: one
 * signature leaves two candidates, and a second Face ID with the same passkey
 * keeps the one both share, as sign-in does when nothing else tells them
 * apart. Only an empty sheet, or one the shopper closes, makes a new
 * passkey, which is what an empty store always did.
 * ===========================================================================
 */
export async function ensurePasskey(store: CardStore, o: PasskeyOptions = {}): Promise<PasskeyRecord> {
  const existing = await store.passkey()
  if (existing !== null) return existing
  const found = await findPasskey(store, o)
  return found ?? createPasskey(store, o)
}

/**
 * TESTER ACCOUNT: an account with no passkey at all, a P-256 key made and
 * kept in this browser (card-store.ts deviceKey). For a laptop that can
 * offer no Windows Hello. Nothing is sent. TO REPLACE after the Target test.
 */
export async function createDeviceAccount(store: CardStore): Promise<PasskeyRecord> {
  const keyPair = await WebCryptoP256.createKeyPair({ extractable: false })
  const publicKey = PublicKey.toHex(keyPair.publicKey, { includePrefix: false }) as Hex
  const record: PasskeyRecord = {
    credentialId: 'device-key',
    publicKey,
    address: passkeyAddress(publicKey),
    rpId: rpIdOf({}),
    createdAt: Date.now(),
    deviceKey: keyPair,
  }
  await store.savePasskey(record)
  return record
}

/** The Salvo passkey this phone already has, kept as this browser's record, or null when it offers none. */
async function findPasskey(store: CardStore, o: PasskeyOptions): Promise<PasskeyRecord | null> {
  const rpId = rpIdOf(o)
  const challenge = () => toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)))
  let first: AssertionParts
  try {
    first = await assert(o, { challenge: challenge(), rpId })
  } catch (err) {
    if (faceIdCancelled(err)) return null
    throw err
  }
  const candidates = recoverPublicKeys(first)
  let chosen: Hex | null = candidates.length === 1 ? (candidates[0] as Hex) : null
  if (chosen === null) {
    const second = await assert(o, { challenge: challenge(), rpId, credentialId: first.credentialId })
    const both = recoverPublicKeys(second).filter((k) => candidates.includes(k))
    if (both.length !== 1) throw new Error('that passkey could not be read')
    chosen = both[0] as Hex
  }
  const record: PasskeyRecord = {
    credentialId: first.credentialId,
    publicKey: chosen,
    address: passkeyAddress(chosen),
    rpId,
    createdAt: Date.now(),
  }
  await store.savePasskey(record)
  return record
}

/**
 * A new passkey, so a new account: one Face ID.
 *
 * A FRESH RANDOM USER HANDLE EACH TIME. viem's default handle is the label
 * itself, so every "Salvo Pay" passkey would share one. A platform
 * authenticator keeps one passkey per site and handle, and making a second
 * with the same handle replaces the first, which is the only key to that
 * first account and its money. A random handle keeps every account its own.
 */
async function createPasskey(store: CardStore, o: PasskeyOptions): Promise<PasskeyRecord> {
  const rpId = rpIdOf(o)
  const credential = await WebAuthnP256.createCredential({
    label: 'Salvo Pay',
    rpId,
    userId: globalThis.crypto.getRandomValues(new Uint8Array(16)),
    ...(o.createFn ? { createFn: o.createFn } : {}),
  })
  const record: PasskeyRecord = {
    credentialId: credential.id,
    publicKey: credential.publicKey,
    address: passkeyAddress(credential.publicKey),
    rpId,
    createdAt: Date.now(),
  }
  await store.savePasskey(record)
  return record
}

/** The dollars at an address, in pathUSD base units, as both hosts agree. Needs no access key. */
export async function dollarBalance(hosts: HostsConfig, address: Hex): Promise<bigint> {
  return tokenBalanceAt(hosts, await agreedFinalizedBlock(hosts), PATH_USD, address)
}
