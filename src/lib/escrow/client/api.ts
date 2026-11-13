/**
 * The escrow pages' calls to our own server: config, quote, ticket, release
 * and listings (src/app/api/escrow/*).
 *
 * NOTHING OUR SERVER SAYS IS TAKEN ON TRUST HERE. Every answer is parsed to
 * an exact shape. The facts that decide where money and cards go (the
 * escrow's address, the card service's signer and sealing key, the escrow's
 * code hash) come from this page's own build (escrow-pins.ts, artifact.ts),
 * and a config that names any other is refused whole. Everything else is
 * checked against those, or against the chain, before anything is signed
 * (load.ts, sell.ts). So a server that changed only its answers could make
 * the page refuse, never seal a card to another key or sign an allowance
 * over to another contract. A server that changed the page's own code is the
 * page-trust residual the spec states (section 19, item 1).
 *
 * Bodies carry only the keys each route names. No key is ever named like card
 * material (the routes refuse such a body whole, src/lib/escrow/http.ts).
 *
 * Browser only by use; imports nothing Node-only.
 */

import type { Hex } from 'viem'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { ESCROW_V1_PINS } from '@/lib/vault/lit/escrow-pins'
import type { TicketView } from '../runbook/smoke'
import { RUNTIME_KECCAK } from '../artifact'
import { ESCROW_RPC_URLS } from '../hosts'
import { ESCROW_CHAIN_ID, MAX_VALUE_CENTS, PATH_USD, UNITS_PER_CENT } from '../manifest'
import { ESCROW_MERCHANTS, MODE_BLIND, MODE_READABLE, type EscrowMerchantName, type EscrowMode } from '../merchants'
import { B64_RE, PUB_RE, fromBase64, pointBytes } from './primitives'

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const ANY_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HASH_RE = /^0x[0-9a-f]{64}$/
const ANY_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const SIG_RE = /^0x[0-9a-fA-F]{130}$/
const INTENT_RE = /^esc_[0-9a-f]{64}$/
const DEPOSIT_RE = /^[1-9][0-9]{0,14}$/

/** The public facts every quote and listing is checked against. */
export interface EscrowPublicConfig {
  chainId: typeof ESCROW_CHAIN_ID
  rpcUrls: readonly string[]
  /** The escrow the template pins, lower-case. */
  escrow: Hex
  token: Hex
  /** The template's signer: the escrow's `litSigner`, and every ticket's signer. */
  identity: Hex
  /** The template's sealing key. */
  encPub: string
  escrowCodehash: Hex
  /** Https origin of a fee sponsor, or null: then the device pays its own fee in pathUSD. */
  sponsorUrl: string | null
  /**
   * Whether our server would take a seller's listing at all today: the custody
   * guard allows the escrow and the test list has someone on it. Only says
   * what the seller's page shows; the server checks it again for every listing.
   */
  listingOpen: boolean
  limits: {
    ticketTtlReadableSeconds: number
    ticketTtlBlindSeconds: number
    maxTicketTtlSeconds: number
    releaseDelaySeconds: number
    disputeHoldSeconds: number
  }
}

export type ConfigOutcome =
  | { state: 'ready'; config: EscrowPublicConfig }
  /** ESCROW_RAIL is not `testnet` on this server. */
  | { state: 'off' }
  /** On, but the template is not fully pinned yet. */
  | { state: 'not_ready' }
  /** We could not reach our own server, or it answered something we refuse. */
  | { state: 'error' }

export type Answer = { status: number; body: Record<string, unknown> }

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const lower = (s: string): Hex => s.toLowerCase() as Hex
const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : null

/** The four envelope fields, in the template's exact formats, or null. */
export function envelopeOf(value: unknown): LitEnvelope | null {
  const e = rec(value)
  if (e === null || Object.keys(e).sort().join(',') !== 'ct,eph,iv,tag') return null
  const { ct, eph, iv, tag } = e
  if (typeof ct !== 'string' || typeof eph !== 'string' || typeof iv !== 'string' || typeof tag !== 'string') return null
  const len = (s: string): number | null => (s.length <= 1024 && B64_RE.test(s) ? fromBase64(s).length : null)
  const ctLen = len(ct)
  if (ctLen === null || ctLen < 1 || ctLen > 512 || len(iv) !== 12 || len(tag) !== 16 || !PUB_RE.test(eph)) return null
  try {
    pointBytes(eph)
  } catch {
    return null
  }
  return { ct, eph, iv, tag }
}

/** What this page was built to trust: the escrow, and the card service's signer and sealing key. */
export interface PagePins {
  escrow: Hex
  identity: Hex
  encPub: string
}

/** Where the UI audit's dev server puts its fixture pins (scripts/ui-states-escrow.ts). */
const FIXTURE_PINS_GLOBAL = '__SALVO_ESCROW_FIXTURE_PINS__'

function pinsOf(v: unknown): PagePins | null {
  const o = rec(v)
  if (o === null) return null
  const { escrow, identity, encPub } = o
  if (typeof escrow !== 'string' || !ADDRESS_RE.test(escrow)) return null
  if (typeof identity !== 'string' || !ADDRESS_RE.test(identity)) return null
  if (typeof encPub !== 'string' || !PUB_RE.test(encPub)) return null
  return { escrow: escrow as Hex, identity: identity as Hex, encPub }
}

/**
 * The pins this page was built with (escrow-pins.ts), or null while the
 * template is not pinned yet: then nothing can be listed or loaded here,
 * whatever our server says.
 *
 * A DEVELOPMENT BUILD ONLY may take the UI audit's fixture pins from a page
 * global, so the audit can walk every screen without the real card service.
 * A production build replaces NODE_ENV with "production" when it compiles,
 * so this branch is not in any page we serve.
 */
export function pagePins(): PagePins | null {
  if (process.env.NODE_ENV === 'development') {
    const fixture = pinsOf((globalThis as Record<string, unknown>)[FIXTURE_PINS_GLOBAL])
    if (fixture !== null) return fixture
  }
  const p = ESCROW_V1_PINS
  if (p.escrowAddress === null || p.identity === null || p.encPub === null) return null
  return pinsOf({ escrow: p.escrowAddress, identity: p.identity, encPub: p.encPub })
}

/**
 * Parse GET /api/escrow/config against `pins`, what this page was built to
 * trust. Refused unless the chain, hosts and token are exactly the page's
 * own, and the escrow, identity, sealing key and code hash are exactly its
 * pins: the server can say whether the rail is on and name a fee sponsor,
 * and nothing that decides where money or a card goes.
 */
export function parseEscrowConfig(status: number, body: unknown, pins: PagePins | null = pagePins()): ConfigOutcome {
  const b = rec(body)
  if (status === 503 && b?.error === 'escrow_rail_off') return { state: 'off' }
  if (status !== 200 || b === null) return { state: 'error' }
  if (b.ready !== true || pins === null) return { state: 'not_ready' }
  const chain = rec(b.chain)
  const tpl = rec(b.template)
  const limits = rec(b.limits)
  if (chain === null || tpl === null || limits === null) return { state: 'error' }
  if (chain.chainId !== ESCROW_CHAIN_ID || chain.testnet !== true) return { state: 'error' }
  const urls = chain.rpcUrls
  if (!Array.isArray(urls) || urls.length !== ESCROW_RPC_URLS.length || urls.some((u, i) => u !== ESCROW_RPC_URLS[i])) {
    return { state: 'error' }
  }
  if (b.token !== PATH_USD) return { state: 'error' }
  if (tpl.intact !== true) return { state: 'not_ready' }
  // A server that names anything else is not one this page can use: a deploy
  // between two builds, or a server answering what it should not.
  if (b.escrow !== pins.escrow) return { state: 'error' }
  if (typeof tpl.identity !== 'string' || !ANY_ADDRESS_RE.test(tpl.identity) || lower(tpl.identity) !== pins.identity) return { state: 'error' }
  if (tpl.encPub !== pins.encPub) return { state: 'error' }
  if (tpl.escrowCodehash !== RUNTIME_KECCAK) return { state: 'error' }
  let sponsorUrl: string | null = null
  if (b.sponsorUrl !== null && b.sponsorUrl !== undefined) {
    try {
      const u = new URL(String(b.sponsorUrl))
      if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return { state: 'error' }
      sponsorUrl = u.origin
    } catch {
      return { state: 'error' }
    }
  }
  const n = (k: string): number | null => int(limits[k], 1, 10_000_000)
  const readable = n('ticketTtlReadableSeconds')
  const blind = n('ticketTtlBlindSeconds')
  const maxTtl = n('maxTicketTtlSeconds')
  const releaseDelay = n('releaseDelaySeconds')
  const disputeHold = n('disputeHoldSeconds')
  if (readable === null || blind === null || maxTtl === null || releaseDelay === null || disputeHold === null) return { state: 'error' }
  return {
    state: 'ready',
    config: {
      chainId: ESCROW_CHAIN_ID,
      rpcUrls: ESCROW_RPC_URLS,
      escrow: pins.escrow,
      token: PATH_USD,
      identity: pins.identity,
      encPub: pins.encPub,
      escrowCodehash: RUNTIME_KECCAK,
      sponsorUrl,
      listingOpen: b.listingOpen === true,
      limits: {
        ticketTtlReadableSeconds: readable,
        ticketTtlBlindSeconds: blind,
        maxTicketTtlSeconds: maxTtl,
        releaseDelaySeconds: releaseDelay,
        disputeHoldSeconds: disputeHold,
      },
    },
  }
}

/** One card of a quote, as the device reads it. */
export interface QuoteLegView {
  intentId: string
  listingId: Hex
  manifest: string
  envelope: LitEnvelope
  priceUnits: number
  valueCents: number
  scanOrder: number
  seller: Hex
  mode: EscrowMode
}

export interface QuoteView {
  merchant: EscrowMerchantName
  spendCents: number
  loadCents: number
  priceUnits: number
  priceCents: number
  savingCents: number
  leftoverCents: number
  legs: QuoteLegView[]
  expiresAt: string
}

/** A quote in exactly the shape the quote route writes, or null. The numbers are checked in load.ts. */
export function parseQuote(value: unknown): QuoteView | null {
  const q = rec(value)
  if (q === null || typeof q.merchant !== 'string' || !Object.prototype.hasOwnProperty.call(ESCROW_MERCHANTS, q.merchant)) return null
  const big = 2 * MAX_VALUE_CENTS * UNITS_PER_CENT
  const spendCents = int(q.spendCents, 1, 2 * MAX_VALUE_CENTS)
  const loadCents = int(q.loadCents, 1, 2 * MAX_VALUE_CENTS)
  const priceUnits = int(q.priceUnits, 1, big)
  const priceCents = int(q.priceCents, 1, 2 * MAX_VALUE_CENTS)
  const savingCents = int(q.savingCents, -2 * MAX_VALUE_CENTS, 2 * MAX_VALUE_CENTS)
  const leftoverCents = int(q.leftoverCents, -2 * MAX_VALUE_CENTS, 2 * MAX_VALUE_CENTS)
  if (spendCents === null || loadCents === null || priceUnits === null || priceCents === null || savingCents === null || leftoverCents === null) {
    return null
  }
  if (typeof q.expiresAt !== 'string' || !Array.isArray(q.legs) || q.legs.length < 1 || q.legs.length > 2) return null
  const legs: QuoteLegView[] = []
  for (const raw of q.legs) {
    const l = rec(raw)
    if (l === null) return null
    const envelope = envelopeOf(l.envelope)
    const scanOrder = int(l.scanOrder, 1, 2)
    const lp = int(l.priceUnits, 1, MAX_VALUE_CENTS * UNITS_PER_CENT)
    const lv = int(l.valueCents, 1, MAX_VALUE_CENTS)
    if (typeof l.intentId !== 'string' || !INTENT_RE.test(l.intentId)) return null
    if (typeof l.listingId !== 'string' || !HASH_RE.test(l.listingId)) return null
    if (typeof l.manifest !== 'string' || l.manifest.length > 2048) return null
    if (typeof l.seller !== 'string' || !ADDRESS_RE.test(l.seller)) return null
    if (l.mode !== MODE_READABLE && l.mode !== MODE_BLIND) return null
    if (envelope === null || scanOrder === null || lp === null || lv === null) return null
    legs.push({
      intentId: l.intentId,
      listingId: l.listingId as Hex,
      manifest: l.manifest,
      envelope,
      priceUnits: lp,
      valueCents: lv,
      scanOrder,
      seller: l.seller as Hex,
      mode: l.mode,
    })
  }
  return {
    merchant: q.merchant as EscrowMerchantName,
    spendCents,
    loadCents,
    priceUnits,
    priceCents,
    savingCents,
    leftoverCents,
    legs,
    expiresAt: q.expiresAt,
  }
}

/** A ticket in exactly the shape the template signs, or null. Its meaning is checked in load.ts. */
export function parseTicket(value: unknown): TicketView | null {
  const k = rec(value)
  if (k === null) return null
  if (typeof k.listingId !== 'string' || !ANY_HASH_RE.test(k.listingId)) return null
  if (typeof k.depositor !== 'string' || !ANY_ADDRESS_RE.test(k.depositor)) return null
  if (typeof k.replyKeyHash !== 'string' || !ANY_HASH_RE.test(k.replyKeyHash)) return null
  if (typeof k.cardTag !== 'string' || !ANY_HASH_RE.test(k.cardTag)) return null
  const openBalanceCents = int(k.openBalanceCents, 0, 0xffff_ffff)
  const notAfter = int(k.notAfter, 1, 1_099_511_627_775)
  if (openBalanceCents === null || notAfter === null) return null
  if (typeof k.signature !== 'string' || !SIG_RE.test(k.signature)) return null
  return {
    listingId: lower(k.listingId),
    depositor: lower(k.depositor),
    replyKeyHash: lower(k.replyKeyHash),
    openBalanceCents,
    cardTag: lower(k.cardTag),
    notAfter,
    signature: k.signature as Hex,
  }
}

/** The plain sentence a refusal carries, or a fallback. Never the server's raw text beyond its `message`. */
export function sentenceOf(a: Answer, fallback: string): string {
  const m = a.body.message
  return typeof m === 'string' && m.length > 0 && m.length <= 400 ? m : fallback
}

/**
 * Our own escrow routes. `fetchImpl` is the page's fetch; tests pass one that
 * calls the route handlers. `pins` is what the config is held to: this
 * page's own build, unless a test runs a build pinned another way.
 */
export class EscrowApi {
  readonly #fetch: FetchLike
  readonly #pins: PagePins | null

  constructor(fetchImpl: FetchLike, pins: PagePins | null = pagePins()) {
    this.#fetch = fetchImpl
    this.#pins = pins
  }

  async #send(path: string, init: RequestInit): Promise<Answer> {
    let res: Response
    try {
      res = await this.#fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin' })
    } catch {
      return { status: 0, body: { error: 'network', message: 'We could not reach Salvo. Check your connection and try again.' } }
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body: rec(body) ?? {} }
  }

  #post(path: string, body: Record<string, unknown>): Promise<Answer> {
    return this.#send(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }

  async config(): Promise<ConfigOutcome> {
    const a = await this.#send('/api/escrow/config', { method: 'GET' })
    return a.status === 0 ? { state: 'error' } : parseEscrowConfig(a.status, a.body, this.#pins)
  }

  quote(merchant: EscrowMerchantName, spendCents: number, depositor: Hex): Promise<Answer> {
    return this.#post('/api/escrow/quote', { merchant, spendCents, depositor })
  }

  ticket(intentId: string, depositor: Hex, replyKeyHash: Hex): Promise<Answer> {
    return this.#post('/api/escrow/ticket', { intentId, depositor, replyKeyHash })
  }

  release(depositId: string, replyKey: Hex): Promise<Answer> {
    if (!DEPOSIT_RE.test(depositId)) throw new RangeError('a deposit id is a decimal string')
    return this.#post('/api/escrow/release', { depositId, replyKey })
  }

  /**
   * `cardFingerprint` (card-fingerprint.ts), when sent, is kept with the
   * listing, so a card sold here cannot be listed again on the new escrow.
   */
  listing(manifest: string, envelope: LitEnvelope, txHash: Hex, cardFingerprint?: Hex): Promise<Answer> {
    return this.#post('/api/escrow/listings', { manifest, envelope, txHash, ...(cardFingerprint === undefined ? {} : { cardFingerprint }) })
  }
}

/** The page's API client, on the browser's own fetch. */
export function escrowApi(fetchImpl: FetchLike = (input, init) => fetch(input, init)): EscrowApi {
  return new EscrowApi(fetchImpl)
}
