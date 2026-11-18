/**
 * The Salvo Pay screens' fixtures for the UI audit and the screenshots
 * (scripts/ui-states.ts walks the states; this file is what they stand on).
 *
 * ===========================================================================
 * WHY A WORLD, NOT A FEW CANNED ANSWERS. The first escrow's screens (its
 * cards on /account, and the escrow branch of /sell while the new escrow is
 * not open) trust nothing our server says. Before a price shows, the phone
 * recomputes every card's listing id from its manifest and sealed envelope
 * and reads the listing on both chain hosts; before it would pay, it checks
 * the ticket recovers to the pinned identity; before a card shows, it opens
 * the release with its own reply key. A canned quote fails every one of those
 * checks, and the screen under audit would be the refusal, every time.
 *
 * So the answers here are made the way the real ones are: manifests with the
 * real builder, cards sealed with the real browser seal, tickets signed over
 * the real EIP-712 digest by a fixture identity, releases sealed to the
 * phone's reply key with the template's own recipe. The config names that
 * fixture identity and sealing key, so the REAL client code accepts them, and
 * tests/escrow-ui-fixtures.test.ts runs that client code against these exact
 * answers to prove it.
 *
 * THE PAGE'S OWN PINS ARE THE FIXTURE'S, IN THE AUDIT'S BROWSER ONLY. A page
 * holds the config to the escrow, identity and sealing key built into it
 * (src/lib/escrow/client/api.ts pagePins), and refuses any other. A dev build
 * alone reads replacement pins from a page global, which installEscrowFixtures
 * sets before any page script runs. A production build has no such branch.
 * The escrow's code is the real compiled runtime, so its hash is the one
 * every page is built with.
 * ===========================================================================
 *
 * NOTHING LEAVES THE AUDIT'S BROWSER. Our routes and both chain hosts are
 * Playwright interceptions: the hosts' names are matched whole, every method
 * is answered here, and eth_sendRawTransaction is refused, so no state can
 * send a transaction, reach the testnet, or write a row. What the phone keeps
 * (its passkey account, reply keys, bought cards, a seller's listings) is
 * written into the audit's own throwaway browser profile: through the real
 * setup screen with a CDP virtual authenticator for Face ID, and through
 * page.evaluate for what only a finished purchase would leave behind.
 *
 * Every key here is a fixture key made from a fixed label, so captures are
 * stable run to run. None is real, none is printed, and none can sign for
 * anything on any chain.
 *
 * NEEDS THE RAIL ON. The dev server must run with ESCROW_RAIL=testnet, or
 * /sell renders no Salvo Pay choice and /account no dollars, and no state
 * past "off" can be reached. The passkey needs a hostname for its relying
 * party, so AUDIT_BASE must be localhost (not 127.0.0.1) for setup to work.
 */

import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import type { CDPSession, Page, Route } from 'playwright'
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  keccak256,
  numberToHex,
  stringToHex,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Abis, Addresses } from 'viem/tempo'
import { ESCROW_ABI, ESCROW_RUNTIME_BYTECODE, RUNTIME_KECCAK } from '../src/lib/escrow/artifact'
import type { PagePins } from '../src/lib/escrow/client/api'
import { aesGcmEncrypt, hkdf32, pointBytes, sha256Hex, sharedX, toBase64, utf8 } from '../src/lib/escrow/client/primitives'
import { sealInBrowser } from '../src/lib/escrow/client/seal'
import { ESCROW_LIMITS } from '../src/lib/escrow/config'
import { listingIdOfSeal, openDigest, replyPayload } from '../src/lib/escrow/hashes'
import { ESCROW_RPC_URLS } from '../src/lib/escrow/hosts'
import { buildEscrowManifest, ESCROW_CHAIN_ID, ESCROW_TEMPLATE_ID, parseEscrowManifest, PATH_USD, UNITS_PER_CENT } from '../src/lib/escrow/manifest'
import { ESCROW_MERCHANTS, MODE_BLIND } from '../src/lib/escrow/merchants'
import { escrowIntentIdFor } from '../src/lib/escrow/refs'
import { ESCROW_V1 } from '../src/lib/vault/lit/templates'
import type { LitEnvelope } from '../src/lib/vault/lit/envelope-crypto'

const lower = (s: string): Hex => s.toLowerCase() as Hex
const fixtureKey = (label: string): Hex => keccak256(stringToHex(`salvo-ui-audit/${label}`))
const ZERO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000'
const ZERO32: Hex = `0x${'0'.repeat(64)}`

// ---------------------------------------------------------------------------
// The fixture world: one escrow, one card service, one seller, three cards
// ---------------------------------------------------------------------------

/** The card service's signing identity: the config's `identity`, the escrow's litSigner. */
const IDENTITY = privateKeyToAccount(fixtureKey('identity'))
/** The card service's sealing key. Its public half is the config's `encPub`. */
const ENC_SECRET = hexToBytes(fixtureKey('enc').slice(2))
const ENC_PUB = `0x${bytesToHex(secp256k1.getPublicKey(ENC_SECRET, true))}`
/** The escrow's address: twenty bytes of a fixed hash, lower-case as the pin must be. */
const ESCROW = lower(`0x${fixtureKey('escrow').slice(26)}`)
/** What eth_getCode answers at the escrow: the real compiled runtime, whose hash every page is built with. */
const ESCROW_CODE: Hex = ESCROW_RUNTIME_BYTECODE
const SELLER = lower(privateKeyToAccount(fixtureKey('seller')).address)
/** The seller the last listings seed was written for: the sold row's sale names it (sellerListingsSeed). */
let seededAccount: Hex | null = null

/** What every fixture account holds: $250 of test dollars. */
export const FIXTURE_BALANCE_UNITS = 250_000_000n
/** The deposit id a seeded purchase was paid in. */
export const FIXTURE_DEPOSIT_ID = '41'

/**
 * A Target-shaped number: 26 digits, like the store's own barcode. Not a real
 * card. The same digits the legacy reveal's PDF417 state draws.
 */
export const FIXTURE_TARGET_CARD = '98765432109876543210123456'
const FIXTURE_TARGET_CARD_2 = '98765432109876543210654321'
/** A Salvo test card number, the only kind the seller's page lists on the test chain: 9999 and twelve digits. */
export const FIXTURE_TEST_CARD = '9999000012345678'

export interface FixtureCard {
  cardNumber: string
  valueCents: number
  priceUnits: number
  manifest: string
  envelope: LitEnvelope
  listingId: Hex
  intentId: string
}

export interface FixtureWorld {
  escrow: Hex
  identity: Hex
  encPub: string
  seller: Hex
  /** $55 at 12% off, and $25 at 12% off: one card covers $50 to $55, both cover $75 to $80. */
  cards: { whole: FixtureCard; small: FixtureCard }
  /** Listing ids of a seller's own rows on /sell, and what the chain says of each. */
  sellerRows: Array<{ listingId: Hex; state: 1 | 2; valueCents: number; priceUnits: number }>
}

const CHAIN_START_S = Math.floor(Date.now() / 1000)
/** A block number of the size Moderato has, so nothing renders oddly for a small one. */
const BASE_BLOCK = 38_620_000n

async function fixtureCard(cardNumber: string, valueCents: number, salt: string): Promise<FixtureCard> {
  const priceUnits = Math.round(valueCents * 0.88) * UNITS_PER_CENT
  const manifest = buildEscrowManifest({
    escrow: ESCROW,
    seller: SELLER,
    merchant: ESCROW_MERCHANTS.target.id,
    mode: MODE_BLIND,
    valueCents,
    price: priceUnits,
    residualCapCents: 0,
    listingExpiry: CHAIN_START_S + 30 * 86_400,
    salt: fixtureKey(`salt/${salt}`).slice(2),
  })
  const envelope = await sealInBrowser(ENC_PUB, utf8(JSON.stringify({ cardNumber, pin: null })), manifest)
  const m = parseEscrowManifest(manifest, ESCROW)
  if (m === null) throw new Error('the fixture manifest does not parse')
  const listingId = lower(listingIdOfSeal(m, envelope))
  return { cardNumber, valueCents, priceUnits, manifest, envelope, listingId, intentId: escrowIntentIdFor(listingId) }
}

let worldOnce: Promise<FixtureWorld> | null = null

/** The world, made once per process. */
export function fixtureWorld(): Promise<FixtureWorld> {
  worldOnce ??= (async () => ({
    escrow: ESCROW,
    identity: lower(IDENTITY.address),
    encPub: ENC_PUB,
    seller: SELLER,
    cards: {
      whole: await fixtureCard(FIXTURE_TARGET_CARD, 5_500, 'whole'),
      small: await fixtureCard(FIXTURE_TARGET_CARD_2, 2_500, 'small'),
    },
    sellerRows: [
      { listingId: lower(fixtureKey('seller-row/listed')), state: 1, valueCents: 2_500, priceUnits: 22_500_000 },
      { listingId: lower(fixtureKey('seller-row/sold')), state: 2, valueCents: 2_000, priceUnits: 17_600_000 },
    ],
  }))()
  return worldOnce
}

// ---------------------------------------------------------------------------
// Our own routes
// ---------------------------------------------------------------------------

export interface FixtureAnswer {
  status: number
  body: unknown
}

/** The pins the audit's dev page is given in place of its own (see the header). */
export function fixturePins(w: FixtureWorld): PagePins {
  return { escrow: w.escrow, identity: w.identity, encPub: w.encPub }
}

/** GET /api/escrow/config as the route writes it, naming the fixture identity and sealing key. */
export function configBody(w: FixtureWorld): Record<string, unknown> {
  return {
    ready: true,
    // Listing open, so the seller's form shows; a state turns it off to see the closed sentence.
    listingOpen: true,
    chain: { key: 'tempo-moderato', chainId: ESCROW_CHAIN_ID, testnet: true, rpcUrls: [...ESCROW_RPC_URLS] },
    escrow: w.escrow,
    token: PATH_USD,
    template: {
      id: ESCROW_TEMPLATE_ID,
      sha256: ESCROW_V1.sha256,
      cid: ESCROW_V1.cid,
      intact: true,
      identity: w.identity,
      encPub: w.encPub,
      escrowCodehash: RUNTIME_KECCAK,
    },
    limits: ESCROW_LIMITS,
    // No sponsor: the phone pays its own fee, and the seller page shows its fee dollars.
    sponsorUrl: null,
  }
}

/** The route's answer while the rail is off. */
export const RAIL_OFF_BODY = { error: 'escrow_rail_off', message: 'Salvo Pay is not available here.' }

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`

function quoteOf(merchant: string, spendCents: number, legs: FixtureCard[]): Record<string, unknown> {
  const loadCents = legs.reduce((n, l) => n + l.valueCents, 0)
  const priceUnits = legs.reduce((n, l) => n + l.priceUnits, 0)
  const priceCents = Math.ceil(priceUnits / UNITS_PER_CENT)
  return {
    merchant,
    spendCents,
    loadCents,
    priceUnits,
    priceCents,
    savingCents: loadCents - priceCents,
    leftoverCents: loadCents - spendCents,
    legs: legs.map((l, i) => ({
      intentId: l.intentId,
      listingId: l.listingId,
      manifest: l.manifest,
      envelope: l.envelope,
      priceUnits: l.priceUnits,
      valueCents: l.valueCents,
      scanOrder: i + 1,
      seller: SELLER,
      mode: MODE_BLIND,
    })),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  }
}

/**
 * POST /api/escrow/quote. Target between $50 and $55 is the $55 card; between
 * $75 and $80 it is both, the whole one scanned first. Anything else is the
 * route's own refusal, in its words.
 */
function quoteAnswer(w: FixtureWorld, body: Record<string, unknown>): FixtureAnswer {
  const merchant = typeof body.merchant === 'string' ? body.merchant : ''
  const spend = typeof body.spendCents === 'number' ? body.spendCents : 0
  const store = merchant === 'target' ? 'Target' : merchant === 'walmart' ? 'Walmart' : merchant === 'bestbuy' ? 'Best Buy' : merchant === 'nike' ? 'Nike' : 'Salvo test'
  if (merchant === 'target' && spend >= 5_000 && spend <= 5_500) return { status: 200, body: { quote: quoteOf(merchant, spend, [w.cards.whole]) } }
  if (merchant === 'target' && spend >= 7_500 && spend <= 8_000) {
    return { status: 200, body: { quote: quoteOf(merchant, spend, [w.cards.whole, w.cards.small]) } }
  }
  if (merchant === 'target') {
    return { status: 409, body: { error: 'unavailable', message: `We cannot load exactly ${dollars(spend)} at Target right now. Try a different amount.` } }
  }
  return { status: 409, body: { error: 'unavailable', message: `There are no ${store} cards for sale right now.` } }
}

const cardByIntent = (w: FixtureWorld, intentId: unknown): FixtureCard | null =>
  [w.cards.whole, w.cards.small].find((c) => c.intentId === intentId) ?? null

/** POST /api/escrow/ticket: a blind card's ticket for this buyer and key, signed by the fixture identity. */
async function ticketAnswer(w: FixtureWorld, body: Record<string, unknown>): Promise<FixtureAnswer> {
  const card = cardByIntent(w, body.intentId)
  if (card === null || typeof body.depositor !== 'string' || typeof body.replyKeyHash !== 'string') {
    return { status: 404, body: { error: 'not_found', message: 'That card is not for sale. Get a new quote. Nothing was charged.' } }
  }
  const fields = {
    listingId: card.listingId,
    depositor: lower(body.depositor),
    replyKeyHash: lower(body.replyKeyHash),
    openBalanceCents: 0,
    cardTag: keccak256(stringToHex(`salvo-ui-audit/card-tag|${card.listingId}`)),
    notAfter: Number(blockTime(headNumber())) + ESCROW_LIMITS.ticketTtlBlindSeconds,
  }
  const signature = await IDENTITY.sign({ hash: openDigest(ESCROW_CHAIN_ID, w.escrow, fields) })
  return { status: 200, body: { ticket: { ...fields, signature }, listingId: card.listingId, ttlSeconds: ESCROW_LIMITS.ticketTtlBlindSeconds } }
}

/**
 * The template's release reply, made here: the card's JSON sealed to the
 * phone's reply key, keyed to the payload that names this deposit, escrow and
 * manifest (src/lib/escrow/client/reply.ts opens it, step for step).
 */
export async function sealReply(replyKey: string, payloadText: string, plain: Uint8Array): Promise<string> {
  const salt = pointBytes(replyKey)
  const shared = sharedX(ENC_SECRET, salt)
  const info = `salvo/vault/reply/v1|${sha256Hex(payloadText)}`
  try {
    const key = await hkdf32(shared, salt, `${info}|key`)
    const iv = await hkdf32(shared, salt, `${info}|iv`)
    return toBase64(await aesGcmEncrypt(key, iv.subarray(0, 12), utf8(info), plain))
  } finally {
    shared.fill(0)
  }
}

/** POST /api/escrow/release: the seeded purchase's card, encrypted to the key the phone sends. */
async function releaseAnswer(w: FixtureWorld, body: Record<string, unknown>): Promise<FixtureAnswer> {
  if (body.depositId !== FIXTURE_DEPOSIT_ID || typeof body.replyKey !== 'string') {
    return { status: 404, body: { error: 'no_purchase', message: 'We cannot find that purchase on the chain yet. Try again in a few seconds.' } }
  }
  const card = w.cards.whole
  const payload = replyPayload(ESCROW_CHAIN_ID, FIXTURE_DEPOSIT_ID, w.escrow, card.manifest)
  const reply = await sealReply(body.replyKey, payload, utf8(JSON.stringify({ cardNumber: card.cardNumber, pin: null })))
  return { status: 200, body: { depositId: FIXTURE_DEPOSIT_ID, reply, payload } }
}

/** Our escrow routes, answered from the world. Null for a path that is not one of them. */
export async function escrowRouteAnswer(path: string, body: unknown): Promise<FixtureAnswer | null> {
  const w = await fixtureWorld()
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  if (path === '/api/escrow/config') return { status: 200, body: configBody(w) }
  if (path === '/api/escrow/quote') return quoteAnswer(w, b)
  if (path === '/api/escrow/ticket') return ticketAnswer(w, b)
  if (path === '/api/escrow/release') return releaseAnswer(w, b)
  // No state lists a card all the way, and nothing may reach the real route's database.
  if (path === '/api/escrow/listings') return { status: 503, body: { error: 'not_ready', message: 'Salvo Pay is not set up yet.' } }
  return null
}

// ---------------------------------------------------------------------------
// The two chain hosts
// ---------------------------------------------------------------------------

/** Blocks advance one a second from when this process started, the same on both hosts. */
function headNumber(): bigint {
  return BASE_BLOCK + BigInt(Math.max(0, Math.floor(Date.now() / 1000) - CHAIN_START_S))
}

function blockTime(n: bigint): bigint {
  return BigInt(CHAIN_START_S) + (n - BASE_BLOCK)
}

function blockOf(n: bigint): Record<string, unknown> {
  return {
    number: numberToHex(n),
    hash: keccak256(numberToHex(n, { size: 32 })),
    parentHash: keccak256(numberToHex(n - 1n, { size: 32 })),
    timestamp: numberToHex(blockTime(n)),
    baseFeePerGas: '0x2',
    gasLimit: numberToHex(30_000_000n),
    transactions: [],
  }
}

class RevertError extends Error {}

function escrowCall(w: FixtureWorld, data: Hex): Hex {
  const call = decodeFunctionData({ abi: ESCROW_ABI, data })
  switch (call.functionName) {
    case 'gate': {
      const [listingId] = call.args as readonly [Hex, bigint]
      const id = lower(listingId)
      const listed = [w.cards.whole, w.cards.small].some((c) => c.listingId === id)
      const row = w.sellerRows.find((r) => r.listingId === id)
      const state = listed ? 1 : (row?.state ?? 0)
      return encodeFunctionResult({
        abi: ESCROW_ABI,
        functionName: 'gate',
        result: [w.identity, PATH_USD, state === 0 ? ZERO_ADDRESS : SELLER, state, 0, ZERO32, ZERO32, ZERO_ADDRESS],
      })
    }
    case 'sellerStats': {
      // The seller of the cards on offer has sold before: $500 paid out, so
      // the $55 Target card is one the escrow would sell. Anyone else, the
      // device's own seller account included, is new: nothing paid out yet,
      // so a blind card over $25 is refused.
      const [who] = call.args as readonly [Hex]
      const paidOut = lower(who) === SELLER ? 500_000_000n : 0n
      return encodeFunctionResult({ abi: ESCROW_ABI, functionName: 'sellerStats', result: [lower(who) === SELLER ? 20 : 0, 0, 0, paidOut] })
    }
    case 'cardOwner':
      // No card on offer has been bought before, so each is its seller's to sell.
      return encodeFunctionResult({ abi: ESCROW_ABI, functionName: 'cardOwner', result: ZERO_ADDRESS })
    case 'cardDeposit':
      return encodeFunctionResult({ abi: ESCROW_ABI, functionName: 'cardDeposit', result: 0n })
    case 'depositCount':
      // One sale: the seller's sold row, still held for its seller.
      return encodeFunctionResult({ abi: ESCROW_ABI, functionName: 'depositCount', result: 1n })
    case 'owed':
      // No payout the token refused: the seller's page shows no Claim.
      return encodeFunctionResult({ abi: ESCROW_ABI, functionName: 'owed', result: 0n })
    case 'getDeposit': {
      const [id] = call.args as readonly [bigint]
      const sold = w.sellerRows.find((r) => r.state === 2)
      const found = id === 1n && sold !== undefined
      return encodeFunctionResult({
        abi: ESCROW_ABI,
        functionName: 'getDeposit',
        result: {
          depositor: found ? lower(privateKeyToAccount(fixtureKey('buyer')).address) : ZERO_ADDRESS,
          openedAt: found ? CHAIN_START_S - 3_600 : 0,
          releaseAt: found ? CHAIN_START_S + 20 * 3_600 : 0,
          state: found ? 1 : 0,
          disputed: false,
          seller: found ? (seededAccount ?? SELLER) : ZERO_ADDRESS,
          amount: found ? BigInt(sold?.priceUnits ?? 0) : 0n,
          listingId: found ? (sold?.listingId ?? ZERO32) : ZERO32,
          replyKeyHash: found ? keccak256(stringToHex('salvo-ui-audit/sale-reply')) : ZERO32,
          cardTag: found ? keccak256(stringToHex('salvo-ui-audit/sale-tag')) : ZERO32,
        },
      })
    }
    case 'litSigner':
      return encodeFunctionResult({ abi: ESCROW_ABI, functionName: 'litSigner', result: w.identity })
    case 'token':
      return encodeFunctionResult({ abi: ESCROW_ABI, functionName: 'token', result: PATH_USD })
    default:
      throw new RevertError(`the audit fixture does not serve ${call.functionName}`)
  }
}

function keychainCall(data: Hex): Hex {
  const call = decodeFunctionData({ abi: Abis.accountKeychain, data })
  if (call.functionName === 'getKey') {
    // Not on chain yet: a key's first Load carries its authorization, so the allowance is the whole signed limit.
    return encodeFunctionResult({
      abi: Abis.accountKeychain,
      functionName: 'getKey',
      result: { signatureType: 0, keyId: ZERO_ADDRESS, expiry: 0n, enforceLimits: false, isRevoked: false },
    })
  }
  throw new RevertError(`the audit fixture does not serve ${call.functionName}`)
}

function ethCall(w: FixtureWorld, params: unknown[]): Hex {
  const tx = (typeof params[0] === 'object' && params[0] !== null ? params[0] : {}) as { to?: unknown; data?: unknown }
  const to = typeof tx.to === 'string' ? lower(tx.to) : ''
  const data = (typeof tx.data === 'string' ? tx.data : '0x') as Hex
  if (to === PATH_USD) {
    const call = decodeFunctionData({ abi: erc20Abi, data })
    if (call.functionName === 'balanceOf') return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: FIXTURE_BALANCE_UNITS })
    if (call.functionName === 'decimals') return encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: 6 })
    throw new RevertError('the audit fixture does not serve that token call')
  }
  if (to === lower(Addresses.accountKeychain)) return keychainCall(data)
  if (to === w.escrow) return escrowCall(w, data)
  throw new RevertError('nothing is deployed there in the audit fixture')
}

/**
 * One JSON-RPC request to either host, answered from the world. Reads only:
 * a transaction is refused, so nothing a state does can ever send one.
 */
export async function rpcAnswer(bodyText: string): Promise<Record<string, unknown>> {
  const w = await fixtureWorld()
  let req: { id?: unknown; method?: unknown; params?: unknown }
  try {
    req = JSON.parse(bodyText) as typeof req
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }
  }
  const id = req.id ?? null
  const params = Array.isArray(req.params) ? (req.params as unknown[]) : []
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
  try {
    switch (req.method) {
      case 'eth_chainId':
        return ok(numberToHex(ESCROW_CHAIN_ID))
      case 'eth_blockNumber':
        return ok(numberToHex(headNumber()))
      case 'eth_getBlockByNumber': {
        const tag = params[0]
        const head = headNumber()
        const n = typeof tag === 'string' && tag.startsWith('0x') ? BigInt(tag) : head
        return ok(n > head ? null : blockOf(n))
      }
      case 'eth_getCode':
        return ok(typeof params[0] === 'string' && lower(params[0]) === w.escrow ? ESCROW_CODE : '0x')
      case 'eth_call':
        return ok(ethCall(w, params))
      case 'eth_getTransactionReceipt':
      case 'eth_getTransactionByHash':
        return ok(null)
      case 'tempo_fundAddress':
        // The faucet button may be tapped; it funds nothing here.
        return ok([])
      case 'eth_sendRawTransaction':
        return fail(-32000, 'the UI audit sends no transactions')
      default:
        return fail(-32601, 'method not found')
    }
  } catch (err) {
    if (err instanceof RevertError) return fail(3, `execution reverted: ${err.message}`)
    return fail(3, 'execution reverted')
  }
}

// ---------------------------------------------------------------------------
// What a finished purchase, a bought card or a seller's listing leaves on the phone
// ---------------------------------------------------------------------------

/** One record for the phone's store: plain, or sealed under the store's own wrapping key. */
export interface SeedEntry {
  slot: string
  /** Kept as is (a purchase, a listing). */
  value?: unknown
  /** Sealed, as card-store.ts seals: a reply key's bytes, or a card's JSON. */
  sealed?: number[]
  /** For a card: the record the sealed box sits in, without `box`. */
  meta?: Record<string, unknown>
}

/**
 * Runs in the page (page.evaluate), so it imports nothing and names nothing
 * outside itself. It writes exactly what src/lib/escrow/client/card-store.ts
 * would: database `salvo-pay` version 1, store `kv`, one non-extractable
 * AES-GCM wrapping key under `wrap-key` (made with `add`, as the store does,
 * or the one already there), and every sealed value bound to its slot by the
 * additional data `salvo-pay|<slot>`. If card-store.ts changes its format,
 * tests/escrow-ui-fixtures.test.ts fails before any audit does.
 */
export async function writeDeviceSeed(entries: SeedEntry[]): Promise<void> {
  const req = indexedDB.open('salvo-pay', 1)
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(new Error('the audit could not open the phone store'))
  })
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode)
      const r = fn(tx.objectStore('kv'))
      let value: T
      r.onsuccess = () => {
        value = r.result
      }
      tx.oncomplete = () => resolve(value)
      tx.onerror = () => reject(new Error('the audit could not write the phone store'))
      tx.onabort = () => reject(new Error('the audit could not write the phone store'))
    })
  try {
    let key = await run('readonly', (s) => s.get('wrap-key'))
    if (!(key instanceof CryptoKey)) {
      const made = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      try {
        await run('readwrite', (s) => s.add(made, 'wrap-key'))
        key = made
      } catch {
        key = await run('readonly', (s) => s.get('wrap-key'))
      }
    }
    if (!(key instanceof CryptoKey)) throw new Error('the phone store has no wrapping key')
    const wrap = key
    for (const e of entries) {
      let value: unknown = e.value
      if (e.sealed !== undefined) {
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ct = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`salvo-pay|${e.slot}`) },
            wrap,
            new Uint8Array(e.sealed),
          ),
        )
        value = e.meta === undefined ? { iv, ct } : { ...e.meta, box: { iv, ct } }
      }
      await run('readwrite', (s) => s.put(value, e.slot))
    }
  } finally {
    db.close()
  }
}

/** Runs in the page: the passkey account this phone set up, or null. */
export async function readDeviceAccount(): Promise<string | null> {
  const req = indexedDB.open('salvo-pay', 1)
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(new Error('the audit could not open the phone store'))
  })
  try {
    const got = await new Promise<unknown>((resolve, reject) => {
      const r = db.transaction('kv', 'readonly').objectStore('kv').get('passkey')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(new Error('the audit could not read the phone store'))
    })
    const address = typeof got === 'object' && got !== null ? (got as { address?: unknown }).address : null
    return typeof address === 'string' ? address : null
  } finally {
    db.close()
  }
}

/** The seeded purchase's fixed id, so seeding twice replaces it rather than adding a second. */
const PURCHASE_ID = 'a0d17000000000000000000000000041'
/** One fixture reply key, so the release answer is sealed to what the seeded purchase holds. */
const REPLY_SECRET = hexToBytes(fixtureKey('reply').slice(2))

/**
 * A first-escrow Load that is paid and final but whose card has not come
 * back yet: what a phone keeps when Lit was down at the tap. "Finish it" (on
 * /account, with the cards) asks for the release, which the fixture answers.
 */
export function paidPurchaseSeed(w: FixtureWorld, depositor: string): SeedEntry[] {
  const card = w.cards.whole
  const pub = secp256k1.getPublicKey(REPLY_SECRET, true)
  const replyKeyId = `${PURCHASE_ID}:0`
  return [
    { slot: `reply:${replyKeyId}`, sealed: [...REPLY_SECRET] },
    {
      slot: `purchase:${PURCHASE_ID}`,
      value: {
        id: PURCHASE_ID,
        createdAt: Date.now(),
        merchant: 'target',
        depositor: lower(depositor),
        escrow: w.escrow,
        txHash: fixtureKey('load-tx'),
        raw: null,
        state: 'paid',
        legs: [
          {
            intentId: card.intentId,
            listingId: card.listingId,
            manifest: card.manifest,
            envelope: card.envelope,
            valueCents: card.valueCents,
            priceUnits: card.priceUnits,
            scanOrder: 1,
            replyKeyId,
            replyPublicKey: `0x${bytesToHex(pub)}`,
            replyKeyHash: keccak256(pub),
            ticketNotAfter: CHAIN_START_S + 600,
            depositId: FIXTURE_DEPOSIT_ID,
            released: false,
          },
        ],
        problem: null,
      },
    },
  ]
}

/** A card already bought on the first escrow and opened, in the store: what /account lists with its code. */
export function boughtCardSeed(w: FixtureWorld): SeedEntry[] {
  const card = w.cards.small
  const id = `${w.escrow}:7`
  return [
    {
      slot: `card:${id}`,
      sealed: [...utf8(JSON.stringify({ cardNumber: card.cardNumber, pin: null }))],
      meta: {
        id,
        escrow: w.escrow,
        depositId: '7',
        listingId: card.listingId,
        merchant: 'target',
        valueCents: card.valueCents,
        priceUnits: card.priceUnits,
        scanOrder: 1,
        ofCards: 1,
        last4: card.cardNumber.slice(-4),
        boughtAt: Date.now() - 3 * 86_400_000,
      },
    },
  ]
}

/**
 * Two listings a seller made on this device: one still listed, one sold. The
 * sold one's sale (getDeposit) names this seller from now on, so the page
 * finds it as theirs.
 */
export function sellerListingsSeed(w: FixtureWorld, seller: string): SeedEntry[] {
  seededAccount = lower(seller)
  return w.sellerRows.map((r, i) => ({
    slot: `listing:${r.listingId}`,
    value: {
      listingId: r.listingId,
      seller: lower(seller),
      merchant: 'salvotest',
      valueCents: r.valueCents,
      priceUnits: r.priceUnits,
      listingExpiry: CHAIN_START_S + 29 * 86_400,
      manifest: w.cards.small.manifest,
      envelope: w.cards.small.envelope,
      txHash: fixtureKey(`list-tx/${i}`),
      posted: true,
      createdAt: Date.now() - (i + 1) * 86_400_000,
    },
  }))
}

// ---------------------------------------------------------------------------
// Playwright
// ---------------------------------------------------------------------------

const RPC_HOSTS: ReadonlySet<string> = new Set(ESCROW_RPC_URLS.map((u) => new URL(u).host))

/** Both chain hosts, matched by name, whatever the path. Kept as one function so a state can unroute what it added. */
export const isChainHost = (url: URL): boolean => RPC_HOSTS.has(url.host)

const ESCROW_ROUTES = '**/api/escrow/**'

/** The hosts answer a page on another origin, so the fulfilled reply says it may be read. */
const CORS = { 'access-control-allow-origin': '*' }

async function answerRpc(route: Route): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(await rpcAnswer(route.request().postData() ?? '')) })
}

async function answerRoute(route: Route): Promise<void> {
  const req = route.request()
  const path = new URL(req.url()).pathname
  let body: unknown = null
  try {
    body = req.postDataJSON()
  } catch {
    body = null
  }
  const got = await escrowRouteAnswer(path, body)
  if (got === null) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  return route.fulfill({ status: got.status, contentType: 'application/json', body: JSON.stringify(got.body) })
}

/** Every Salvo Pay request the pages make: our routes and both chain hosts. Nothing reaches a server or the testnet. */
export async function installEscrowFixtures(page: Page): Promise<void> {
  const w = await fixtureWorld()
  // Before any page script: the dev build's pagePins reads it at its first config call.
  await page.addInitScript((pins: PagePins) => {
    ;(globalThis as Record<string, unknown>).__SALVO_ESCROW_FIXTURE_PINS__ = pins
  }, fixturePins(w))
  await page.route(ESCROW_ROUTES, answerRoute)
  await page.route(isChainHost, answerRpc)
}

/**
 * Requests a state holds unanswered, so its spinner stays up while it is
 * measured. Let go once the next state has loaded: the page they belonged to
 * is gone by then, so letting go logs nothing against the new one.
 */
const held: Route[] = []

/** Hold this request until the next state. */
export function holdRequest(route: Route): void {
  held.push(route)
}

export async function releaseHeldRequests(): Promise<void> {
  for (const r of held.splice(0)) await r.abort().catch(() => undefined)
}

/** One CDP session per page, for the virtual authenticator and the storage reset. */
const sessions = new WeakMap<Page, Promise<CDPSession>>()

function cdp(page: Page): Promise<CDPSession> {
  let s = sessions.get(page)
  if (s === undefined) {
    s = page.context().newCDPSession(page)
    sessions.set(page, s)
  }
  return s
}

const authenticators = new WeakSet<Page>()

/**
 * Face ID, for the audit: Chromium's virtual platform authenticator, which
 * says yes to every passkey request with user verification. Added once per page.
 */
export async function virtualFaceId(page: Page): Promise<void> {
  if (authenticators.has(page)) return
  const s = await cdp(page)
  await s.send('WebAuthn.enable', { enableUI: false })
  await s.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  authenticators.add(page)
}

/** Load the page again and wait until it can take a tap, as enter() does after its own goto. */
export async function reloadSettled(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('h1', { timeout: 15_000 })
  // A tap before hydration lands on server markup and is lost.
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(400)
}

/** A phone that has never set up Salvo Pay: this origin's IndexedDB cleared, and the page loaded again. */
export async function freshDevice(page: Page): Promise<void> {
  const s = await cdp(page)
  await s.send('Storage.clearDataForOrigin', { origin: new URL(page.url()).origin, storageTypes: 'indexeddb' })
  await reloadSettled(page)
}

/**
 * Stop with a reason a person can act on when the dev server runs without
 * the rail: then /sell has no Salvo Pay choice and /account no dollars, so
 * no state past "off" exists to measure. /sell draws its choice on the
 * server only when the rail runs, so its page says which, whatever page this
 * is on.
 */
export async function requireRail(page: Page): Promise<void> {
  const html = await page.evaluate(async () => (await fetch('/sell', { cache: 'no-store' })).text())
  if (!html.includes('Crypto')) {
    throw new Error('the dev server runs without ESCROW_RAIL=testnet, so Salvo Pay is off there; start it with ESCROW_RAIL=testnet')
  }
}

/** The screen's own error line, if setup failed, so an unreachable state says why. */
async function setupFailure(page: Page): Promise<string | null> {
  const err = page.locator('.err[role="alert"]')
  return (await err.count()) > 0 ? ((await err.first().textContent()) ?? 'setup failed') : null
}

/** /sell, in its Salvo Pay branch, with a seller account set up on this device. */
export async function ensureSeller(page: Page): Promise<void> {
  await requireRail(page)
  await virtualFaceId(page)
  await page.getByRole('button', { name: 'Crypto' }).click()
  const setUp = page.getByRole('heading', { name: 'Your seller account' })
  const ready = page.getByRole('button', { name: 'Seal it and list it' })
  await setUp.or(ready).first().waitFor({ timeout: 15_000 })
  if ((await ready.count()) === 0) {
    await page.getByRole('button', { name: 'Set up with Face ID' }).click()
    try {
      await ready.waitFor({ timeout: 15_000 })
    } catch (err) {
      throw new Error((await setupFailure(page)) ?? (err instanceof Error ? err.message.split('\n')[0] : 'setup did not finish'))
    }
  }
}

/** Write what a finished purchase, a bought card or a seller's listing would leave on this phone, then load the page again. */
export async function seedDevice(page: Page, make: (w: FixtureWorld, account: string) => SeedEntry[]): Promise<void> {
  const w = await fixtureWorld()
  const account = (await page.evaluate(readDeviceAccount)) ?? w.seller
  await page.evaluate(writeDeviceSeed, make(w, account))
  await reloadSettled(page)
}
