/**
 * The V2 escrow pages' calls to our own server, and the V2 half of its config
 * (unified spec sections 5.3 and 8.7).
 *
 * THE SAME RULE AS V1 (api.ts): nothing our server says is taken on trust.
 * The facts that decide where money and cards go (SalvoEscrowV2's address,
 * salvo-vault-escrow/2's signer and sealing key, the V2 code hash) come from
 * this page's own build (escrow-pins.ts ESCROW_V2_PINS, artifact-v2.ts), and
 * a config that names any other is refused whole. Until the lead pins V2,
 * those pins are null and this page refuses every V2 config: nothing can be
 * listed on or bought from V2 here, whatever our server says.
 *
 * WHAT THE SERVER MAY SAY. Whether V2 is on and takes listings, whether V1 is
 * frozen, a fee sponsor, and the contract's numbers for the page's words.
 * Each number is checked against the contract's own constant, so a server
 * cannot make the page promise a longer contest window than the chain keeps.
 *
 * THE ROUTES. V2 shares V1's routes: a ticket's card names its escrow by the
 * listing it was sealed for, a release names its escrow (deposit ids run from
 * 1 on each), and a listing's manifest names its template. The quote is the
 * till's (planTill), in the shape quote-v2.ts writes.
 *
 * Bodies carry only the keys each route names, and never a key named like
 * card material. Browser only by use; imports nothing Node-only.
 */

import type { Hex } from 'viem'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { ESCROW_V1_PINS, ESCROW_V2_PINS } from '@/lib/vault/lit/escrow-pins'
import { RUNTIME_KECCAK_V2 } from '../artifact-v2'
import { ESCROW_RPC_URLS } from '../hosts'
import { ESCROW_CHAIN_ID, MAX_VALUE_CENTS, PATH_USD, UNITS_PER_CENT } from '../manifest'
import { CAP_BLIND_CENTS, CAP_READABLE_CENTS, ESCROW_V2_TEMPLATE_ID } from '../manifest-v2'
import { ESCROW_MERCHANTS, MODE_BLIND, MODE_READABLE, type EscrowMerchantName } from '../merchants'
import { MAX_QUOTE_LEGS_V2, type QuoteLegV2, type QuoteV2 } from '../quote-v2'
import type { TicketViewV2 } from '../runbook/smoke-v2'
import { envelopeOf, type Answer, type FetchLike, type PagePins } from './api'
import { PUB_RE } from './primitives'

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const ANY_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HASH_RE = /^0x[0-9a-f]{64}$/
const ANY_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const SIG_RE = /^0x[0-9a-fA-F]{130}$/
const INTENT_RE = /^esc_[0-9a-f]{64}$/
const DEPOSIT_RE = /^[1-9][0-9]{0,14}$/
const QUOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const FINGERPRINT_RE = /^0x[0-9a-f]{64}$/

/**
 * SalvoEscrowV2's own constants (contracts/SalvoEscrowV2.sol). The config
 * must carry exactly these: the page tells the shopper when a deposit comes
 * back and how long they may say a card was empty, and only the chain's
 * numbers are true.
 */
const V2_CONSTANTS = Object.freeze({
  maxTicketTtlSeconds: 900,
  releaseDelaySeconds: 86_400,
  disputeHoldSeconds: 172_800,
  capBlindCents: CAP_BLIND_CENTS,
  capReadableCents: CAP_READABLE_CENTS,
  contestWindowSeconds: 7_200,
  bondReviewAfterSeconds: 432_000,
  bondMaxAgeSeconds: 604_800,
  confirmDelaySeconds: 900,
})

/** The public facts every V2 quote, ticket and listing is checked against. */
export interface EscrowPublicConfigV2 {
  version: 2
  chainId: typeof ESCROW_CHAIN_ID
  rpcUrls: readonly string[]
  /** SalvoEscrowV2, as this page pins it, lower-case. */
  escrow: Hex
  token: Hex
  /** salvo-vault-escrow/2's signer: SalvoEscrowV2's litSigner, and every V2 ticket's signer. */
  identity: Hex
  /** salvo-vault-escrow/2's sealing key. */
  encPub: string
  escrowCodehash: Hex
  sponsorUrl: string | null
  /** Whether our server takes V2 listings today. The server checks again for every listing. */
  listingOpen: boolean
  /** True once V2 is configured: V1 takes no new listing, quote or ticket. */
  v1Frozen: boolean
  /**
   * V1's escrow as this page pins it, or null. Its sales still settle, so the
   * V2 keys keep V1's no-money calls (a seller's cancel, a buyer's dispute).
   */
  v1Escrow: Hex | null
  limits: {
    ticketTtlReadableSeconds: number
    ticketTtlBlindSeconds: number
    maxTicketTtlSeconds: number
    releaseDelaySeconds: number
    disputeHoldSeconds: number
    capBlindCents: number
    capReadableCents: number
    contestWindowSeconds: number
    bondReviewAfterSeconds: number
    bondMaxAgeSeconds: number
    confirmDelaySeconds: number
  }
}

export type ConfigOutcomeV2 =
  | { state: 'ready'; config: EscrowPublicConfigV2 }
  /** ESCROW_RAIL is not `testnet` on this server. */
  | { state: 'off' }
  /** V2 is not configured on the server, or not pinned in this page yet. */
  | { state: 'not_ready' }
  /** We could not reach our own server, or it answered something we refuse. */
  | { state: 'error' }

const lower = (s: string): Hex => s.toLowerCase() as Hex
const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : null

/** Where the UI audit's dev server puts its V2 fixture pins (scripts/ui-states-dollars.ts). */
const FIXTURE_PINS_V2_GLOBAL = '__SALVO_ESCROW_FIXTURE_PINS_V2__'

/** A page global's pins, exactly in the pins' shape, or null. */
function fixturePinsV2(v: unknown): PagePins | null {
  const o = rec(v)
  if (o === null) return null
  const { escrow, identity, encPub } = o
  if (typeof escrow !== 'string' || !ADDRESS_RE.test(escrow)) return null
  if (typeof identity !== 'string' || !ADDRESS_RE.test(identity)) return null
  if (typeof encPub !== 'string' || !PUB_RE.test(encPub)) return null
  return { escrow: escrow as Hex, identity: identity as Hex, encPub }
}

/**
 * What this page was built to trust for V2, or null while V2 is not pinned:
 * then nothing is listed or bought on V2 here.
 *
 * A DEVELOPMENT BUILD ONLY may take the UI audit's V2 fixture pins from a
 * page global, as api.ts pagePins does for V1, so the audit can walk the
 * dollars till without the real card service. A production build replaces
 * NODE_ENV with "production" when it compiles, so this branch is not in any
 * page we serve.
 */
export function pagePinsV2(): PagePins | null {
  if (process.env.NODE_ENV === 'development') {
    const fixture = fixturePinsV2((globalThis as Record<string, unknown>)[FIXTURE_PINS_V2_GLOBAL])
    if (fixture !== null) return fixture
  }
  const p = ESCROW_V2_PINS
  if (p.escrowAddress === null || p.identity === null || p.encPub === null) return null
  if (!ADDRESS_RE.test(p.escrowAddress) || !ADDRESS_RE.test(p.identity) || !PUB_RE.test(p.encPub)) return null
  return { escrow: p.escrowAddress, identity: p.identity, encPub: p.encPub }
}

/** V1's escrow as this page pins it, lower-case, or null. */
function pinnedV1Escrow(): Hex | null {
  const a = ESCROW_V1_PINS.escrowAddress
  return a !== null && ADDRESS_RE.test(a) ? a : null
}

/**
 * Parse GET /api/escrow/config's V2 block against `pins`. Refused unless the
 * chain, hosts and token are this page's own, and the V2 escrow, identity,
 * sealing key and code hash are exactly its pins.
 */
export function parseEscrowConfigV2(status: number, body: unknown, pins: PagePins | null = pagePinsV2(), v1Escrow: Hex | null = pinnedV1Escrow()): ConfigOutcomeV2 {
  const b = rec(body)
  if (status === 503 && b?.error === 'escrow_rail_off') return { state: 'off' }
  if (status !== 200 || b === null) return { state: 'error' }
  const v2 = rec(b.v2)
  if (v2 === null || v2.ready !== true || pins === null) return { state: 'not_ready' }
  const chain = rec(b.chain)
  const tpl = rec(v2.template)
  const limits = rec(v2.limits)
  if (chain === null || tpl === null || limits === null) return { state: 'error' }
  if (chain.chainId !== ESCROW_CHAIN_ID || chain.testnet !== true) return { state: 'error' }
  const urls = chain.rpcUrls
  if (!Array.isArray(urls) || urls.length !== ESCROW_RPC_URLS.length || urls.some((u, i) => u !== ESCROW_RPC_URLS[i])) return { state: 'error' }
  if (v2.token !== PATH_USD) return { state: 'error' }
  if (tpl.id !== ESCROW_V2_TEMPLATE_ID) return { state: 'error' }
  if (tpl.intact !== true) return { state: 'not_ready' }
  if (v2.escrow !== pins.escrow) return { state: 'error' }
  if (typeof tpl.identity !== 'string' || !ANY_ADDRESS_RE.test(tpl.identity) || lower(tpl.identity) !== pins.identity) return { state: 'error' }
  if (tpl.encPub !== pins.encPub) return { state: 'error' }
  if (tpl.escrowCodehash !== RUNTIME_KECCAK_V2) return { state: 'error' }
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
  if (readable === null || blind === null || readable > V2_CONSTANTS.maxTicketTtlSeconds || blind > V2_CONSTANTS.maxTicketTtlSeconds) return { state: 'error' }
  for (const [k, v] of Object.entries(V2_CONSTANTS)) if (n(k) !== v) return { state: 'error' }
  return {
    state: 'ready',
    config: {
      version: 2,
      chainId: ESCROW_CHAIN_ID,
      rpcUrls: ESCROW_RPC_URLS,
      escrow: pins.escrow,
      token: PATH_USD,
      identity: pins.identity,
      encPub: pins.encPub,
      escrowCodehash: RUNTIME_KECCAK_V2,
      sponsorUrl,
      listingOpen: v2.listingOpen === true,
      v1Frozen: b.v1Frozen === true,
      v1Escrow,
      limits: { ticketTtlReadableSeconds: readable, ticketTtlBlindSeconds: blind, ...V2_CONSTANTS },
    },
  }
}

/** One leg of a V2 quote in exactly the shape quote-v2.ts writes, or null. Its meaning is checked in quote-v2.ts and load-v2.ts. */
function quoteLegOf(raw: unknown): QuoteLegV2 | null {
  const l = rec(raw)
  if (l === null) return null
  const envelope = envelopeOf(l.envelope)
  const cents = (v: unknown): number | null => int(v, 0, MAX_VALUE_CENTS)
  const remainingCents = cents(l.remainingCents)
  const usedCents = cents(l.usedCents)
  const leftCents = cents(l.leftCents)
  const sales = int(l.sales, 0, 0xffff)
  const bondDeposit = int(l.bondDeposit, 0, Number.MAX_SAFE_INTEGER)
  const amountUnits = int(l.amountUnits, 0, MAX_VALUE_CENTS * UNITS_PER_CENT)
  const bondUnits = int(l.bondUnits, 0, MAX_VALUE_CENTS * UNITS_PER_CENT)
  const scanOrder = int(l.scanOrder, 1, MAX_QUOTE_LEGS_V2)
  if (typeof l.intentId !== 'string' || !INTENT_RE.test(l.intentId)) return null
  if (typeof l.listingId !== 'string' || !HASH_RE.test(l.listingId)) return null
  if (typeof l.manifest !== 'string' || l.manifest.length > 2048) return null
  if (typeof l.seller !== 'string' || !ADDRESS_RE.test(l.seller)) return null
  if (l.mode !== MODE_READABLE && l.mode !== MODE_BLIND) return null
  if (l.source !== 'remainder' && l.source !== 'fresh') return null
  if (envelope === null || remainingCents === null || usedCents === null || leftCents === null || sales === null) return null
  if (bondDeposit === null || amountUnits === null || bondUnits === null || scanOrder === null) return null
  return {
    intentId: l.intentId,
    listingId: l.listingId as Hex,
    manifest: l.manifest,
    envelope,
    seller: l.seller as Hex,
    mode: l.mode,
    source: l.source,
    remainingCents,
    sales,
    bondDeposit,
    usedCents,
    leftCents,
    amountUnits,
    bondUnits,
    scanOrder,
  }
}

/** A V2 quote in exactly the shape quote-v2.ts writes, or null. The numbers are checked in quote-v2.ts. */
export function parseQuoteV2(value: unknown): QuoteV2 | null {
  const q = rec(value)
  if (q === null || q.version !== 2) return null
  if (typeof q.merchant !== 'string' || !Object.prototype.hasOwnProperty.call(ESCROW_MERCHANTS, q.merchant)) return null
  if (typeof q.quoteId !== 'string' || !QUOTE_ID_RE.test(q.quoteId) || typeof q.expiresAt !== 'string' || q.expiresAt.length > 40) return null
  const most = MAX_QUOTE_LEGS_V2 * MAX_VALUE_CENTS
  const totalCents = int(q.totalCents, 1, most)
  const coveredCents = int(q.coveredCents, 0, most)
  const uncoveredCents = int(q.uncoveredCents, 0, most)
  const amountUnits = int(q.amountUnits, 0, most * UNITS_PER_CENT)
  const bondUnits = int(q.bondUnits, 0, most * UNITS_PER_CENT)
  const priceCents = int(q.priceCents, 0, most)
  const depositCents = int(q.depositCents, 0, most)
  const savingCents = int(q.savingCents, -most, most)
  if (totalCents === null || coveredCents === null || uncoveredCents === null || amountUnits === null || bondUnits === null) return null
  if (priceCents === null || depositCents === null || savingCents === null) return null
  if (!Array.isArray(q.legs) || q.legs.length < 1 || q.legs.length > MAX_QUOTE_LEGS_V2) return null
  const legs: QuoteLegV2[] = []
  for (const raw of q.legs) {
    const leg = quoteLegOf(raw)
    if (leg === null) return null
    legs.push(leg)
  }
  return {
    version: 2,
    quoteId: q.quoteId,
    merchant: q.merchant as EscrowMerchantName,
    totalCents,
    coveredCents,
    uncoveredCents,
    amountUnits,
    bondUnits,
    priceCents,
    depositCents,
    savingCents,
    legs,
    expiresAt: q.expiresAt,
  }
}

/** A V2 ticket answer: the ticket in the shape the template signs, and the deposit the chain said covers what is left. */
export interface TicketAnswerV2 {
  ticket: TicketViewV2
  /** Not signed. The phone holds it to its own chain read before it pays. */
  bondDeposit: bigint
}

/** The ticket route's V2 answer `{ticket, bondDeposit, listingId, ttlSeconds, version: 2}`, or null. Its meaning is checked in load-v2.ts. */
export function parseTicketV2(body: Record<string, unknown>): TicketAnswerV2 | null {
  if (body.version !== 2) return null
  const k = rec(body.ticket)
  const bondDeposit = int(body.bondDeposit, 0, Number.MAX_SAFE_INTEGER)
  if (k === null || bondDeposit === null) return null
  if (typeof k.listingId !== 'string' || !ANY_HASH_RE.test(k.listingId)) return null
  if (typeof k.depositor !== 'string' || !ANY_ADDRESS_RE.test(k.depositor)) return null
  if (typeof k.replyKeyHash !== 'string' || !ANY_HASH_RE.test(k.replyKeyHash)) return null
  if (typeof k.cardTag !== 'string' || !ANY_HASH_RE.test(k.cardTag)) return null
  const openBalanceCents = int(k.openBalanceCents, 0, 0xffff_ffff)
  const remainingCents = int(k.remainingCents, 0, 0xffff_ffff)
  const sales = int(k.sales, 0, 0xffff)
  const notAfter = int(k.notAfter, 1, 1_099_511_627_775)
  if (openBalanceCents === null || remainingCents === null || sales === null || notAfter === null) return null
  if (typeof k.signature !== 'string' || !SIG_RE.test(k.signature)) return null
  return {
    ticket: {
      listingId: lower(k.listingId),
      depositor: lower(k.depositor),
      replyKeyHash: lower(k.replyKeyHash),
      openBalanceCents,
      cardTag: lower(k.cardTag),
      remainingCents,
      sales,
      notAfter,
      signature: k.signature as Hex,
    },
    bondDeposit: BigInt(bondDeposit),
  }
}

/** The shopper's checkout setting, as the till's planner takes it (spec section 5.1). */
export interface QuotePreferenceV2 {
  mode: 'most_savings' | 'in_and_out'
  maxCards: 1 | 2 | 3 | 4 | 5
}

/**
 * Our own escrow routes, for V2. `fetchImpl` is the page's fetch; tests pass
 * one that answers the way the routes do. `pins` is what the config is held
 * to: this page's own build, unless a test runs a build pinned another way.
 */
export class EscrowApiV2 {
  readonly #fetch: FetchLike
  readonly #pins: PagePins | null
  readonly #v1Escrow: Hex | null

  constructor(fetchImpl: FetchLike, pins: PagePins | null = pagePinsV2(), v1Escrow: Hex | null = pinnedV1Escrow()) {
    this.#fetch = fetchImpl
    this.#pins = pins
    this.#v1Escrow = v1Escrow
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

  async config(): Promise<ConfigOutcomeV2> {
    const a = await this.#send('/api/escrow/config', { method: 'GET' })
    return a.status === 0 ? { state: 'error' } : parseEscrowConfigV2(a.status, a.body, this.#pins, this.#v1Escrow)
  }

  /**
   * The till's quote over V2 supply. The planner holds the cards it quotes,
   * so their tickets can be asked for, and leaves out `exclude`: cards the
   * shopper just reported.
   */
  quote(merchant: EscrowMerchantName, totalCents: number, depositor: Hex, preference: QuotePreferenceV2, exclude: readonly string[] = [], preview = false): Promise<Answer> {
    return this.#post('/api/escrow/quote', { version: 2, merchant, totalCents, depositor, preference, ...(exclude.length > 0 ? { exclude: [...exclude] } : {}), ...(preview ? { preview: true } : {}) })
  }

  ticket(intentId: string, depositor: Hex, replyKeyHash: Hex): Promise<Answer> {
    return this.#post('/api/escrow/ticket', { intentId, depositor, replyKeyHash })
  }

  /** A V2 release names its escrow: deposit ids run from 1 on each. */
  release(depositId: string, replyKey: Hex, escrow: Hex): Promise<Answer> {
    if (!DEPOSIT_RE.test(depositId)) throw new RangeError('a deposit id is a decimal string')
    return this.#post('/api/escrow/release', { depositId, replyKey, escrow })
  }

  /**
   * The till is done with a card it bought on V2: the proof its reply key
   * signed (done-proof-v2.ts), so its leftover goes on sale for the next
   * shopper now instead of resting two hours.
   */
  done(escrow: Hex, depositId: string, replyKey: Hex, signature: Hex): Promise<Answer> {
    if (!DEPOSIT_RE.test(depositId)) throw new RangeError('a deposit id is a decimal string')
    return this.#post('/api/escrow/done', { escrow, depositId, replyKey, signature })
  }

  /** A V2 listing carries the card's fingerprint (card-fingerprint.ts), never the card. */
  listing(manifest: string, envelope: LitEnvelope, txHash: Hex, cardFingerprint: Hex): Promise<Answer> {
    if (!FINGERPRINT_RE.test(cardFingerprint)) throw new RangeError('a card fingerprint is 32 bytes of lower-case hex')
    return this.#post('/api/escrow/listings', { manifest, envelope, txHash, cardFingerprint })
  }
}

/**
 * The page's V2 API client, on the browser's own fetch.
 */
export function escrowApiV2(fetchImpl: FetchLike = (input, init) => fetch(input, init)): EscrowApiV2 {
  return new EscrowApiV2(fetchImpl)
}
