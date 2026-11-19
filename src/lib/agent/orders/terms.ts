/**
 * An order's terms (orders-spec section 4): the one text Salvo quotes, the
 * agent checks, and SalvoOrders binds by its hash.
 *
 * ONE TEXT, ONE HASH. The terms are canonical JSON (src/lib/vault/lit/canonical.ts)
 * and `termsHash = keccak256(utf8(text))` is the order's termsHash on chain. A
 * reader that would serialise the same terms differently is refused
 * (parseOrderTerms), so the server, the agent and the runner can never
 * disagree about what a hash says.
 *
 * ONE RULE BOOK, BOTH SIDES. termsProblems is every arithmetic rule of section
 * 4, as a list of plain sentences. The quote route runs it before it answers,
 * the agent's client runs it before it pays, and the runner runs it again
 * before it buys. Empty means the terms add up.
 *
 * WHOLE CARDS ONLY, NEVER MORE THAN THE CART, AT MOST FIVE. A card is bought
 * whole on V2 at its listing's own full price; nothing is part used and
 * nothing is left on deposit. What the cards do not cover is the remainder:
 * kind `checkout`, the runner pays it at the store and the agent pays the
 * runner for it in the order; kind `cards`, the agent pays it itself at the
 * store, so it is not in the order at all.
 *
 * Isomorphic: viem and the canonical text only, so the agent's side can load it.
 */

import { keccak256, stringToHex, type Hex } from 'viem'
import { canonicalJson, parseCanonicalJson } from '@/lib/vault/lit/canonical'

export const ORDER_TERMS_VERSION = 1
/** The most cards one order names: the till's own limit (quote-v2.ts MAX_QUOTE_LEGS_V2). */
export const MAX_ORDER_CARDS = 5
/** Token units (6 decimals) per cent: both tokens are taken 1:1 as US dollars. */
export const ORDER_UNITS_PER_CENT = 10_000
/** The largest card value V2 lists (manifest.ts MAX_VALUE_CENTS). */
const MAX_CARD_CENTS = 50_000
/** The most a cart may be: five of the largest cards, plus the same again paid at the store. */
const MAX_CART_CENTS = 2 * MAX_ORDER_CARDS * MAX_CARD_CENTS
/** uint40, the contract's deadline type. */
const MAX_DEADLINE = 2 ** 40 - 1
/** Long enough for every field at its largest; anything bigger is not a terms text. */
const MAX_TERMS_CHARS = 4_000

export const ORDER_KINDS = ['checkout', 'cards'] as const
export type OrderKind = (typeof ORDER_KINDS)[number]
export const ORDER_NETWORKS = ['tempo-moderato', 'base-sepolia'] as const
export type OrderNetwork = (typeof ORDER_NETWORKS)[number]
/** The stores V2 lists (merchants.ts ESCROW_MERCHANTS), the only ones an order can name. */
export const ORDER_MERCHANTS = ['bestbuy', 'nike', 'target', 'walmart', 'salvotest'] as const
export type OrderMerchant = (typeof ORDER_MERCHANTS)[number]

/** Each network's chain id. An order's terms name both, and they must agree. */
export const ORDER_CHAIN_IDS: Readonly<Record<OrderNetwork, number>> = { 'tempo-moderato': 42_431, 'base-sepolia': 84_532 }

/** One card of an order: a V2 listing, bought whole. */
export interface OrderCardTerms {
  listingId: Hex
  /** The card's full value. */
  valueCents: number
  /** The listing's own full price on V2, in token units. */
  priceUnits: number
}

export interface OrderTerms {
  v: 1
  kind: OrderKind
  network: OrderNetwork
  chainId: number
  /** The SalvoOrders contract the order is opened on. */
  orders: Hex
  /** The token the order is paid in on that network. */
  token: Hex
  /** The agent's address: the order's buyer on chain. */
  buyer: Hex
  /** The address whose signature settles the order. */
  runner: Hex
  merchant: OrderMerchant
  cartTotalCents: number
  /** The cards' full values together. Never more than the cart. */
  coveredCents: number
  /** cartTotalCents less coveredCents. */
  remainderCents: number
  cards: OrderCardTerms[]
  /** The cards' prices together. */
  cardsUnits: number
  /** Kind checkout: the remainder at face, which the runner pays at the store. Kind cards: 0. */
  remainderUnits: number
  feeUnits: 0
  /** What the order holds: cardsUnits + remainderUnits. */
  amountUnits: number
  /** Kind cards: keccak256 of the agent's compressed reply public key. Kind checkout: null. */
  replyKeyHash: Hex | null
  /** Kind checkout: sha256 of the cart the agent sent. Kind cards: null. */
  cartRef: Hex | null
  /** Unix seconds: the order's deadline on chain. */
  deadline: number
  quoteId: string
}

const TERMS_KEYS = [
  'v',
  'kind',
  'network',
  'chainId',
  'orders',
  'token',
  'buyer',
  'runner',
  'merchant',
  'cartTotalCents',
  'coveredCents',
  'remainderCents',
  'cards',
  'cardsUnits',
  'remainderUnits',
  'feeUnits',
  'amountUnits',
  'replyKeyHash',
  'cartRef',
  'deadline',
  'quoteId',
] as const satisfies ReadonlyArray<keyof OrderTerms>
const CARD_KEYS = ['listingId', 'valueCents', 'priceUnits'] as const satisfies ReadonlyArray<keyof OrderCardTerms>

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const HASH_RE = /^0x[0-9a-f]{64}$/
const QUOTE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
/** A compressed secp256k1 public key, as createReplyKey (envelope-crypto.ts) makes one. */
const COMPRESSED_KEY_RE = /^0x0[23][0-9a-fA-F]{64}$/

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const sum = (xs: readonly number[]): number => xs.reduce((n, x) => n + x, 0)

/**
 * Every reason these terms do not hold together, as plain sentences; empty
 * when they do. Pure and total: it never throws, whatever it is handed, so the
 * agent's client can run it on an answer it has not trusted yet.
 */
export function termsProblems(t: OrderTerms): string[] {
  const out: string[] = []
  if (t.v !== ORDER_TERMS_VERSION) out.push('the terms are not version 1')
  if (!(ORDER_KINDS as readonly string[]).includes(t.kind)) out.push('the kind is neither checkout nor cards')
  if (!(ORDER_NETWORKS as readonly string[]).includes(t.network)) out.push('the network is not one orders run on')
  else if (t.chainId !== ORDER_CHAIN_IDS[t.network]) out.push("the chain id is not the network's")
  for (const [name, v] of [['orders', t.orders], ['token', t.token], ['buyer', t.buyer], ['runner', t.runner]] as const) {
    if (typeof v !== 'string' || !ADDRESS_RE.test(v)) out.push(`the ${name} address is not a lower-case address`)
  }
  if (typeof t.buyer === 'string' && t.buyer === t.runner) out.push('the buyer is the runner')
  if (!(ORDER_MERCHANTS as readonly string[]).includes(t.merchant)) out.push('the store is not one Salvo lists')
  if (!isCount(t.cartTotalCents) || t.cartTotalCents < 1 || t.cartTotalCents > MAX_CART_CENTS) out.push('the cart total is not a number of cents Salvo takes')

  const cards = Array.isArray(t.cards) ? t.cards : []
  if (!Array.isArray(t.cards) || cards.length < 1) out.push('the order names no card')
  if (cards.length > MAX_ORDER_CARDS) out.push(`the order names more than ${MAX_ORDER_CARDS} cards`)
  const ids = new Set<string>()
  let cardsOk = true
  for (const c of cards) {
    const okId = typeof c?.listingId === 'string' && HASH_RE.test(c.listingId)
    if (!okId) out.push("a card's listing id is not a lower-case hash")
    else if (ids.has(c.listingId)) out.push('the order names one card twice')
    else ids.add(c.listingId)
    if (!isCount(c?.valueCents) || c.valueCents < 1 || c.valueCents > MAX_CARD_CENTS) {
      out.push("a card's value is not one V2 lists")
      cardsOk = false
    } else if (!isCount(c?.priceUnits) || c.priceUnits < 1 || c.priceUnits > c.valueCents * ORDER_UNITS_PER_CENT) {
      // V2's manifest refuses a price over face (manifest.ts), so a quote naming one is wrong.
      out.push("a card's price is not a price V2 lists it at")
      cardsOk = false
    }
  }

  // Whole cards, never more than the cart.
  if (cardsOk && t.coveredCents !== sum(cards.map((c) => c.valueCents))) out.push("what the cards cover is not their full values together: cards are used whole")
  if (isCount(t.coveredCents) && isCount(t.cartTotalCents) && t.coveredCents > t.cartTotalCents) out.push('the cards cover more than the cart')
  if (!isCount(t.remainderCents) || t.remainderCents !== t.cartTotalCents - t.coveredCents) out.push('the remainder is not the cart less what the cards cover')
  if (cardsOk && t.cardsUnits !== sum(cards.map((c) => c.priceUnits))) out.push("the cards' price is not their prices together")
  if (t.kind === 'checkout' && t.remainderUnits !== t.remainderCents * ORDER_UNITS_PER_CENT) out.push('a checkout order must carry the remainder at face for the runner to pay at the store')
  if (t.kind === 'cards' && t.remainderUnits !== 0) out.push('a cards order carries no remainder: the agent pays it at the store')
  if (t.feeUnits !== 0) out.push('the fee is not 0')
  if (!isCount(t.amountUnits) || t.amountUnits < 1 || t.amountUnits !== t.cardsUnits + t.remainderUnits) out.push("the amount is not the cards' price plus the remainder")

  // The reply key belongs to kind cards, the cart to kind checkout, never both.
  if (t.kind === 'cards') {
    if (typeof t.replyKeyHash !== 'string' || !HASH_RE.test(t.replyKeyHash)) out.push('a cards order must name the hash of the reply key the cards are sealed to')
    if (t.cartRef !== null) out.push('a cards order names no cart')
  }
  if (t.kind === 'checkout') {
    if (typeof t.cartRef !== 'string' || !HASH_RE.test(t.cartRef)) out.push('a checkout order must name the hash of its cart')
    if (t.replyKeyHash !== null) out.push('a checkout order names no reply key: the runner opens its cards')
  }
  if (!isCount(t.deadline) || t.deadline < 1 || t.deadline > MAX_DEADLINE) out.push('the deadline is not a time the contract takes')
  if (typeof t.quoteId !== 'string' || !QUOTE_ID_RE.test(t.quoteId)) out.push('the quote id is not one Salvo issues')
  return out
}

/** The canonical text of valid terms: what is hashed, stored and sent. Throws RangeError on terms that do not hold. */
export function orderTermsText(t: OrderTerms): string {
  const problems = termsProblems(t)
  if (problems.length > 0) throw new RangeError(`the order terms do not hold: ${problems.join('; ')}`)
  return canonicalJson({ ...t, cards: t.cards.map((c) => ({ listingId: c.listingId, valueCents: c.valueCents, priceUnits: c.priceUnits })) })
}

/** keccak256 of the terms' canonical text: the order's termsHash on chain. */
export function orderTermsHash(textOrTerms: string | OrderTerms): Hex {
  const text = typeof textOrTerms === 'string' ? textOrTerms : orderTermsText(textOrTerms)
  return keccak256(stringToHex(text))
}

/** What a quote decides before the terms are written: everything else is arithmetic. */
export interface OrderTermsInput {
  kind: OrderKind
  network: OrderNetwork
  orders: Hex
  token: Hex
  buyer: Hex
  runner: Hex
  merchant: OrderMerchant
  cartTotalCents: number
  cards: readonly OrderCardTerms[]
  replyKeyHash: Hex | null
  cartRef: Hex | null
  deadline: number
  quoteId: string
}

/**
 * Write the terms from what a quote decided, every sum by section 4's rules,
 * addresses and hashes in lower case. Throws RangeError, with every problem,
 * for terms that would not hold: the server never sends one.
 *
 * @wiring-exempt: the order quote route (spec section 5) calls it; this step builds the core it stands on
 */
export function buildOrderTerms(i: OrderTermsInput): { terms: OrderTerms; text: string; termsHash: Hex } {
  const lower = (h: Hex | null): Hex | null => (h === null ? null : (h.toLowerCase() as Hex))
  const cards = i.cards.map((c) => ({ listingId: c.listingId.toLowerCase() as Hex, valueCents: c.valueCents, priceUnits: c.priceUnits }))
  const coveredCents = sum(cards.map((c) => c.valueCents))
  const remainderCents = i.cartTotalCents - coveredCents
  const cardsUnits = sum(cards.map((c) => c.priceUnits))
  const remainderUnits = i.kind === 'checkout' ? remainderCents * ORDER_UNITS_PER_CENT : 0
  const terms: OrderTerms = {
    v: 1,
    kind: i.kind,
    network: i.network,
    chainId: ORDER_CHAIN_IDS[i.network],
    orders: i.orders.toLowerCase() as Hex,
    token: i.token.toLowerCase() as Hex,
    buyer: i.buyer.toLowerCase() as Hex,
    runner: i.runner.toLowerCase() as Hex,
    merchant: i.merchant,
    cartTotalCents: i.cartTotalCents,
    coveredCents,
    remainderCents,
    cards,
    cardsUnits,
    remainderUnits,
    feeUnits: 0,
    amountUnits: cardsUnits + remainderUnits,
    replyKeyHash: lower(i.replyKeyHash),
    cartRef: lower(i.cartRef),
    deadline: i.deadline,
    quoteId: i.quoteId,
  }
  const text = orderTermsText(terms)
  return { terms, text, termsHash: orderTermsHash(text) }
}

/**
 * Terms from their text, only if the text is already canonical, has exactly
 * the terms' keys and each card exactly a card's, every field is of its type,
 * and the terms hold (termsProblems). Null otherwise: never a guess.
 *
 * @wiring-exempt: the order runner and the agent client (spec sections 6 and 7) call it; this step builds the core they stand on
 */
export function parseOrderTerms(text: string): OrderTerms | null {
  const o = parseCanonicalJson(text, TERMS_KEYS.length, MAX_TERMS_CHARS)
  if (o === null || !TERMS_KEYS.every((k) => Object.prototype.hasOwnProperty.call(o, k))) return null
  if (!Array.isArray(o.cards)) return null
  const cards: OrderCardTerms[] = []
  for (const c of o.cards as unknown[]) {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return null
    const r = c as Record<string, unknown>
    if (Object.keys(r).length !== CARD_KEYS.length || !CARD_KEYS.every((k) => Object.prototype.hasOwnProperty.call(r, k))) return null
    if (typeof r.listingId !== 'string' || typeof r.valueCents !== 'number' || typeof r.priceUnits !== 'number') return null
    cards.push({ listingId: r.listingId as Hex, valueCents: r.valueCents, priceUnits: r.priceUnits })
  }
  const str = (v: unknown): v is string => typeof v === 'string'
  const num = (v: unknown): v is number => typeof v === 'number'
  const hexOrNull = (v: unknown): v is Hex | null => v === null || typeof v === 'string'
  if (!num(o.v) || !str(o.kind) || !str(o.network) || !num(o.chainId) || !str(o.orders) || !str(o.token) || !str(o.buyer) || !str(o.runner) || !str(o.merchant)) return null
  if (!num(o.cartTotalCents) || !num(o.coveredCents) || !num(o.remainderCents) || !num(o.cardsUnits) || !num(o.remainderUnits) || !num(o.feeUnits) || !num(o.amountUnits)) return null
  if (!hexOrNull(o.replyKeyHash) || !hexOrNull(o.cartRef) || !num(o.deadline) || !str(o.quoteId)) return null
  if (o.v !== 1 || o.feeUnits !== 0) return null
  const terms: OrderTerms = {
    v: 1,
    kind: o.kind as OrderKind,
    network: o.network as OrderNetwork,
    chainId: o.chainId,
    orders: o.orders as Hex,
    token: o.token as Hex,
    buyer: o.buyer as Hex,
    runner: o.runner as Hex,
    merchant: o.merchant as OrderMerchant,
    cartTotalCents: o.cartTotalCents,
    coveredCents: o.coveredCents,
    remainderCents: o.remainderCents,
    cards,
    cardsUnits: o.cardsUnits,
    remainderUnits: o.remainderUnits,
    feeUnits: 0,
    amountUnits: o.amountUnits,
    replyKeyHash: o.replyKeyHash,
    cartRef: o.cartRef,
    deadline: o.deadline,
    quoteId: o.quoteId,
  }
  if (termsProblems(terms).length > 0) return null
  // The key order inside each card is canonical too: what was parsed must write back byte for byte.
  return orderTermsText(terms) === text ? terms : null
}

/**
 * keccak256 of a compressed secp256k1 reply public key (33 bytes, 0x02 or
 * 0x03 first): what a cards order's terms name, and what each V2 ticket the
 * runner asks for names, so only the agent holding that key opens the card.
 * Null for anything that is not one.
 */
export function replyKeyHashOf(publicKey: string): Hex | null {
  if (!COMPRESSED_KEY_RE.test(publicKey)) return null
  return keccak256(publicKey.toLowerCase() as Hex)
}

