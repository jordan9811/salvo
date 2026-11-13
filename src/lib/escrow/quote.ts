/**
 * The escrow Load quote: "Target, $52" becomes one or two whole cards and a
 * price (spec section 8.3 step 1).
 *
 * THE SAME MATCHER AS THE OTHER RAIL. `quoteDemand` (src/lib/demand/quote.ts)
 * picks the cards: full drains first, at most one part-used card, whose
 * leftover is within the store's cap. Here it is told to read escrow listings
 * only, and to skip five kinds:
 *   - cards another shopper was quoted in the last two minutes (a soft
 *     reservation, per process; the chain decides the race anyway: the later
 *     batch reverts and buys nothing),
 *   - listings Lit refused a ticket for, or the chain shows sold or taken back
 *     (listing.ts, "suspect"),
 *   - every listing of a seller with an open dispute (spec section 8.8),
 *   - cards that have had every ticket they may have just now,
 *   - the shopper's own listings: one phone is one account for both roles,
 *     and the contract refuses a seller buying their own card.
 *
 * A HOLD IS NOT FREE TO TAKE. Holding a card hides it from everyone else, so
 * one address could hide the whole book by quoting with a new made-up
 * shopper each time, and read every listing's terms on the way. So a shopper
 * holds only its latest quote's cards, and one address (as the proxy saw it)
 * holds at most a few cards at once; the route also limits quotes per address
 * and overall. A quote is also the only way to a ticket: the ticket route
 * relays a paid Lit run only for a card this process quoted to that shopper
 * (`takeQuotedTicket`).
 *
 * A NEW QUOTE IS NOT A NEW ALLOWANCE. Quotes and made-up shoppers cost
 * nothing, so a count that a new quote set back to zero would limit nothing:
 * one script could quote and ask for three tickets, again and again, and use
 * the whole day's Lit budget in two hours. So the tickets one shopper has had
 * for one card are kept for fifteen minutes whatever it quotes, one card gets
 * only a few tickets in that time from everyone together (and is left out of
 * quotes once it has had them), and one address gets a few dozen a day.
 *
 * THE CHAIN IS ASKED BEFORE A CARD IS QUOTED. Only the keeper moves a
 * listing's row, every 15 minutes, so a card sold or taken back a minute ago
 * is still offered here. Each picked card's listing is read on both hosts
 * (cached for a few seconds); one that is no longer for sale is marked and
 * the quote is made again without it, so the phone's own check does not
 * refuse the same card on every try.
 *
 * WHAT IS DIFFERENT: each card is bought WHOLE. A card number that has been
 * shown cannot be taken back, so a shopper pays the listing's full price and
 * owns the whole card; the matcher's part-used card is one whose leftover the
 * shopper keeps. That leftover is capped like the other rail's: $5 at a store
 * nobody can read the balance of, $10 where Lit reads it first.
 *
 * A QUOTE IS NOT TRUSTED BY THE PHONE. Each leg carries the manifest and
 * envelope, and the device recomputes the listing id, checks the terms and
 * reads the chain itself before it asks for a ticket (spec section 8.3 step 2).
 *
 * THE CHAIN IS ASKED AGAIN ONCE LIT NAMES THE CARD (`ticketedCardRefusal`).
 * Only the contract checks who may sell a card (cardOwner, cardDeposit) and
 * the new-seller cap; Lit's ticket does not. A seller who lists one card
 * twice has two listings that both look for sale, and once one sells, every
 * batch with the other reverts. The card's tag is known only once Lit signs a
 * ticket, so the ticket route asks then, and a listing that fails is marked
 * and left out of quotes.
 *
 * Server-only.
 */

import type { Hex } from 'viem'
import { prisma } from '@/lib/db'
import { MERCHANT_BARCODE_PROFILES } from '@/lib/barcode/merchants'
import { isNoQuote, quoteDemand, QUOTE_TTL_MS } from '@/lib/demand/quote'
import { tillScanOrder } from '@/lib/route/scan-order'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { escrowReader, LISTING_STATE } from './chain'
import { isSuspect, markListingSuspect, readEscrowSealedRef } from './listing'
import { MAX_VALUE_CENTS, UNITS_PER_CENT } from './manifest'
import { ESCROW_MERCHANTS, MODE_BLIND, MODE_READABLE, type EscrowMerchantName, type EscrowMode } from './merchants'
import { ESCROW_INTENT_FORM_FACTOR } from './refs'
import { escrowRuntime, type EscrowRuntime } from './runtime'

/** At most two cards per Load, as on the other rail. */
const MAX_LOAD_CARDS = 2
/**
 * Cards one address may hold at once: two shoppers' two-card quotes, say a
 * household on one connection. Past this, a quote from there waits.
 */
const MAX_HELD_PER_ADDRESS = 4
/**
 * How long a quote lets its shopper ask for tickets, counted from the first
 * quote of that card to that shopper. A blind ticket lasts ten minutes and
 * the tap renews one about to end, so this covers a shopper who reads the
 * quote for a while; the contract refuses any ticket past fifteen.
 */
const TICKET_WINDOW_MS = 15 * 60_000
/**
 * Tickets one shopper may have for one card in that window, however many
 * times it quotes: the prefetch, a renewal at the tap, and one retry. The
 * phone keeps a ticket it already has when a new quote names the same cards.
 */
const TICKETS_PER_SHOPPER_CARD = 3
/** Tickets one card may have in that window, from every shopper together: two shoppers' worth. */
const TICKETS_PER_CARD = 6
/**
 * Paid ticket runs one address (as the proxy saw it) may ask for in a day:
 * a few Loads of two cards each, with renewals. Far under the day's ticket
 * budget (http.ts), so one address can never use it up.
 */
const TICKETS_PER_ADDRESS_DAY = 30
const DAY_MS = 86_400_000
/** Card tags remembered per process, to find one card listed twice. */
const MAX_CARD_TAGS = 5_000
/**
 * A listing the chain showed for sale is not read again for this long: a
 * shopper typing an amount quotes several times in a few seconds. Short, so
 * a card sold a moment ago is seen by the shopper's next try.
 */
const ACTIVE_SEEN_MS = 5_000
/** Quotes made again after the chain took cards out of one. */
const CHAIN_ROUNDS = 3
/** The leftover a shopper may be left holding on the part-used card. */
const LEFTOVER_CAP_CENTS: Readonly<Record<EscrowMode, number>> = { [MODE_READABLE]: 1_000, [MODE_BLIND]: 500 }
/**
 * A listing this close to its expiry is not quoted. The template refuses a
 * ticket within a minute of the expiry, and the shopper may take the quote's
 * whole two minutes before the tap, so a later quote could only fail.
 */
const EXPIRY_MARGIN_MS = QUOTE_TTL_MS + 60_000
/** The keeper marks a seller's open sale this way while its buyer's dispute stands (keeper.ts). */
export const DISPUTED_MARK = 'escrow_disputed'
const ADDRESS_RE = /^0x[0-9a-f]{40}$/

/** One card of a quote: everything the phone needs to check it and ask for a ticket. */
export interface EscrowQuoteLeg {
  intentId: string
  listingId: Hex
  /** The 13-key canonical manifest, exactly as sealed. */
  manifest: string
  envelope: LitEnvelope
  /** pathUSD base units the shopper pays for this card. */
  priceUnits: number
  valueCents: number
  /** 1 for the card scanned first. Whole cards first, the part-used one last. */
  scanOrder: number
  seller: Hex
  mode: EscrowMode
}

export interface EscrowQuote {
  merchant: EscrowMerchantName
  /** What the shopper asked to spend. */
  spendCents: number
  /** The value of the cards: what goes into Wallet. */
  loadCents: number
  /** What the shopper pays, in base units and in cents rounded up. */
  priceUnits: number
  priceCents: number
  /** Value bought minus price paid. */
  savingCents: number
  /** Value bought beyond what was asked: stays on the part-used card, the shopper's. */
  leftoverCents: number
  legs: EscrowQuoteLeg[]
  expiresAt: string
}

export interface EscrowQuoteUnavailable {
  unavailable: string
}

/** Too many cards are held from this address right now. The route answers 429. */
export interface EscrowQuoteLimited {
  limited: string
}

// ---------------------------------------------------------------------------
// Soft reservations, and the quotes that open the way to a ticket
// ---------------------------------------------------------------------------

/** intentId -> who it was quoted to, from which address, and until when (ms). */
const reservations = new Map<string, { holder: string; address: string; until: number }>()
/** `<holder>|<intentId>` -> when that card was first quoted to that shopper in this window, and the tickets asked since. */
const quoted = new Map<string, { at: number; tickets: number }>()
/** intentId -> until when (ms) the chain's word that it is for sale is taken. */
const activeSeen = new Map<string, number>()
/** A fixed window's count: tickets for one card (TICKET_WINDOW_MS), or from one address (a day). */
interface Window {
  start: number
  count: number
}
/** intentId -> the card's tickets, from every shopper, in this window. */
const cardTickets = new Map<string, Window>()
/** address -> the paid ticket runs asked from there today. */
const addressTickets = new Map<string, Window>()
/** card tag -> the listings Lit has named it in that may still be for sale. Never shown, never stored. */
const listingsOfCard = new Map<Hex, Array<{ intentId: string; listingId: Hex; expiry: number }>>()

function sweep(now: number): void {
  for (const [id, r] of reservations) if (r.until <= now) reservations.delete(id)
  if (quoted.size > 10_000) for (const [k, q] of quoted) if (now - q.at >= TICKET_WINDOW_MS) quoted.delete(k)
  if (activeSeen.size > 10_000) for (const [k, until] of activeSeen) if (until <= now) activeSeen.delete(k)
  if (cardTickets.size > 10_000) for (const [k, w] of cardTickets) if (now - w.start >= TICKET_WINDOW_MS) cardTickets.delete(k)
  if (addressTickets.size > 10_000) for (const [k, w] of addressTickets) if (now - w.start >= DAY_MS) addressTickets.delete(k)
}

/** The current window for `key`, a fresh one once the last has run out. Not counted here. */
function windowOf(m: Map<string, Window>, key: string, now: number, ms: number): Window {
  const w = m.get(key)
  if (w !== undefined && now - w.start < ms) return w
  const fresh = { start: now, count: 0 }
  m.set(key, fresh)
  return fresh
}

/** Cards that have had every ticket they may have in this window: left out of quotes until it ends. */
function cardsOutOfTickets(now: number): string[] {
  const out: string[] = []
  for (const [id, w] of cardTickets) if (now - w.start < TICKET_WINDOW_MS && w.count >= TICKETS_PER_CARD) out.push(id)
  return out
}

function reservedByOthers(holder: string): string[] {
  const out: string[] = []
  for (const [id, r] of reservations) if (r.holder !== holder) out.push(id)
  return out
}

/** A shopper holds only its latest quote: its earlier holds are let go. */
function releaseHolder(holder: string): void {
  for (const [id, r] of reservations) if (r.holder === holder) reservations.delete(id)
}

function heldFrom(address: string): number {
  let n = 0
  for (const r of reservations.values()) if (r.address === address) n += 1
  return n
}

function reserve(holder: string, address: string, ids: readonly string[], now: number): void {
  for (const id of ids) {
    reservations.set(id, { holder, address, until: now + QUOTE_TTL_MS })
    // A new quote of the same card to the same shopper keeps what it has
    // already asked for: only a window that has run out starts again.
    const k = `${holder}|${id}`
    const q = quoted.get(k)
    if (q === undefined || now - q.at >= TICKET_WINDOW_MS) quoted.set(k, { at: now, tickets: 0 })
  }
}

/**
 * Hold cards another quote picked, the way quoteEscrowSpend holds its own:
 * the shopper's earlier hold is let go, an address holds at most a few cards
 * at once, and only a held card opens the way to a ticket (takeQuotedTicket).
 * False, and nothing held, when the address holds too many already.
 */
export function holdQuotedCards(holder: Hex, address: string, intentIds: readonly string[], now: number): boolean {
  const who = holder.toLowerCase()
  sweep(now)
  releaseHolder(who)
  if (heldFrom(address) + intentIds.length > MAX_HELD_PER_ADDRESS) return false
  reserve(who, address, intentIds, now)
  return true
}

/**
 * The cards a quote for `holder` must leave out now: held for another
 * shopper, or out of tickets in this window.
 */
export function cardsNotQuotable(holder: Hex, now: number): string[] {
  sweep(now)
  return [...reservedByOthers(holder.toLowerCase()), ...cardsOutOfTickets(now)]
}

/**
 * Whether the ticket route may relay a paid Lit run for this card now:
 *   - `not_quoted`: this process did not quote the card to this shopper in
 *     the last fifteen minutes, or the shopper has had its tickets for it;
 *   - `card_busy`: the card has had every ticket it may have in that time,
 *     from every shopper together;
 *   - `address_spent`: this address has had its tickets for the day.
 */
export type TicketAllowance = 'ok' | 'not_quoted' | 'card_busy' | 'address_spent'

/**
 * May `holder`, asking from `address`, have a ticket for `intentId` now?
 * Counts the ticket against all three when it says yes. Every ticket is a
 * paid Lit run, so without this anyone could ask for runs for any listing,
 * with any made-up shopper, for as long as they liked.
 */
export function takeQuotedTicket(intentId: string, holder: Hex, address: string, now: number): TicketAllowance {
  const q = quoted.get(`${holder.toLowerCase()}|${intentId}`)
  if (q === undefined || now - q.at >= TICKET_WINDOW_MS || q.tickets >= TICKETS_PER_SHOPPER_CARD) return 'not_quoted'
  const card = windowOf(cardTickets, intentId, now, TICKET_WINDOW_MS)
  if (card.count >= TICKETS_PER_CARD) return 'card_busy'
  const day = windowOf(addressTickets, address, now, DAY_MS)
  if (day.count >= TICKETS_PER_ADDRESS_DAY) return 'address_spent'
  q.tickets += 1
  card.count += 1
  day.count += 1
  return 'ok'
}

/** Why the contract would refuse to sell a ticketed card, or that another listing of it is for sale. */
export type TicketedCardRefusal = 'card_not_sellers' | 'card_not_paid_out' | 'new_seller_cap' | 'card_listed_twice'

/**
 * After Lit signed a ticket for `intentId`: would the contract sell this
 * card by this seller, and is it the only listing of it still for sale? Read
 * on both hosts at one finalized block. Null when the ticket is good to send.
 *
 * ONE CARD, TWO LISTINGS. A seller may list the same card twice, with two
 * salts, and nothing before a ticket can tell: only Lit knows the card. Both
 * look for sale, and both can be quoted together in one Load, whose batch
 * then reverts on the second. So the tag each ticket names is kept here, and
 * a ticket for a card another listing still offers is refused: the later
 * one is marked and the other stays. A listing sold, taken back or ended no
 * longer counts, so a card listed again after that sells as usual.
 *
 * The tag is noted before the first read, so two tickets for one card that
 * come back at once still see each other.
 */
export async function ticketedCardRefusal(
  intentId: string,
  sale: { cardTag: Hex; seller: Hex; mode: number; valueCents: number; listingId: Hex; listingExpiry: number },
  rt: EscrowRuntime = escrowRuntime(),
): Promise<TicketedCardRefusal | null> {
  const tag = sale.cardTag.toLowerCase() as Hex
  const others = (listingsOfCard.get(tag) ?? []).filter((l) => l.intentId !== intentId)
  const mine = { intentId, listingId: sale.listingId, expiry: sale.listingExpiry }
  if (!listingsOfCard.has(tag) && listingsOfCard.size >= MAX_CARD_TAGS) {
    const oldest = listingsOfCard.keys().next()
    if (!oldest.done) listingsOfCard.delete(oldest.value)
  }
  listingsOfCard.set(tag, [...others, mine])
  const reader = escrowReader(rt)
  // The route answers not_ready before this whenever there is no escrow to read.
  if (reader === null) throw new Error('there is no pinned escrow to read')
  const block = await reader.block()
  const onChain = await reader.cardSaleRefusal(block, { cardTag: tag, seller: sale.seller, mode: sale.mode, valueCents: sale.valueCents })
  const gates = await Promise.all(others.map((l) => reader.gate(block, l.listingId, 0n)))
  const live = others.filter((l, i) => gates[i]?.listingState === LISTING_STATE.active && Number(block.timestamp) < l.expiry)
  if (onChain !== null || live.length > 0) {
    // This listing is the one that goes. Every other listing of the card that
    // is still for sale stays, and nothing else is remembered for it.
    listingsOfCard.set(tag, live)
    return onChain ?? 'card_listed_twice'
  }
  listingsOfCard.set(tag, [mine])
  return null
}

/**
 * A card its shopper has paid for is no longer held for that shopper's quote.
 * The hold kept other shoppers off it while this one decided, and paying ends
 * that: without this, the leftover of a part-used card stayed held for its
 * buyer for the rest of QUOTE_TTL_MS, so the next shopper at the store was
 * told there was nothing (measured live, 2026-10-14). Its leftover still rests
 * until its buyer says done (till-quote-v2.ts restingV2).
 */
export function releasePaidCard(intentId: string, holder: Hex): void {
  const r = reservations.get(intentId)
  if (r !== undefined && r.holder === holder.toLowerCase()) reservations.delete(intentId)
}

/** Tests only: forget every reservation, quote, ticket count, card tag and chain read. */
export function __clearEscrowReservationsForTests(): void {
  reservations.clear()
  quoted.clear()
  activeSeen.clear()
  cardTickets.clear()
  addressTickets.clear()
  listingsOfCard.clear()
}

/** Sellers who have a sale under an open dispute: the matcher skips all their listings. */
async function disputedSellers(): Promise<string[]> {
  const rows = await prisma.intent.findMany({
    where: { formFactor: ESCROW_INTENT_FORM_FACTOR, state: 'executing', failureReason: DISPUTED_MARK },
    select: { accountId: true },
    distinct: ['accountId'],
    take: 500,
  })
  return rows.map((r) => r.accountId)
}

async function suspectListings(now: Date): Promise<string[]> {
  const rows = await prisma.intent.findMany({
    where: { formFactor: ESCROW_INTENT_FORM_FACTOR, state: 'offered', failureReason: { startsWith: 'escrow_suspect|' } },
    select: { id: true, failureReason: true },
    take: 2_000,
  })
  return rows.filter((r) => isSuspect(r.failureReason, now)).map((r) => r.id)
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/** The store's own name for a sentence a shopper reads: "Target", never the id "target". */
const storeName = (m: EscrowMerchantName): string => (m === 'salvotest' ? 'Salvo test' : (MERCHANT_BARCODE_PROFILES[m]?.displayName ?? m))

type PickedLeg = Omit<EscrowQuoteLeg, 'scanOrder'> & { fullyDrained: boolean }

/**
 * The picked cards the chain says are no longer for sale, read on both hosts
 * at one finalized block. A sold or taken-back listing is marked so no quote
 * picks it again before the keeper moves its row; one the chain does not show
 * at all yet (a host a little behind) is only skipped this time.
 */
async function goneOnChain(legs: readonly PickedLeg[], rt: EscrowRuntime, nowMs: number): Promise<string[]> {
  const toRead = legs.filter((l) => (activeSeen.get(l.intentId) ?? 0) <= nowMs)
  if (toRead.length === 0) return []
  const reader = escrowReader(rt)
  // The route answers not_ready before this whenever there is no escrow to read.
  if (reader === null) throw new Error('there is no pinned escrow to read')
  const block = await reader.block()
  const gates = await Promise.all(toRead.map((l) => reader.gate(block, l.listingId, 0n)))
  const gone: string[] = []
  for (const [i, g] of gates.entries()) {
    const l = toRead[i] as PickedLeg
    if (g.listingState === LISTING_STATE.active && g.listingSeller === l.seller) {
      activeSeen.set(l.intentId, nowMs + ACTIVE_SEEN_MS)
      continue
    }
    gone.push(l.intentId)
    if (g.listingState === LISTING_STATE.sold || g.listingState === LISTING_STATE.cancelled) {
      await markListingSuspect(l.intentId, 'closed_on_chain', new Date(nowMs))
    }
  }
  return gone
}

/**
 * Price a Load for `depositor`, the shopper's own address. The cards quoted
 * are held for it for two minutes, and its earlier hold is let go. `address`
 * is where the request came from (http.ts clientAddress), only to cap how
 * many cards one place can hold.
 */
export async function quoteEscrowSpend(
  input: { merchant: string; spendCents: number; depositor: Hex; address: string },
  rt: EscrowRuntime = escrowRuntime(),
): Promise<EscrowQuote | EscrowQuoteUnavailable | EscrowQuoteLimited> {
  const name = input.merchant.toLowerCase().trim()
  const merchant = Object.prototype.hasOwnProperty.call(ESCROW_MERCHANTS, name)
    ? ESCROW_MERCHANTS[name as EscrowMerchantName]
    : null
  if (merchant === null) return { unavailable: `Salvo Pay is not at ${input.merchant.slice(0, 40)} yet.` }
  if (!Number.isSafeInteger(input.spendCents) || input.spendCents < 1 || input.spendCents > MAX_LOAD_CARDS * MAX_VALUE_CENTS) {
    return { unavailable: `Enter an amount between $0.01 and ${dollars(MAX_LOAD_CARDS * MAX_VALUE_CENTS)}.` }
  }
  const holder = input.depositor.toLowerCase()
  if (!ADDRESS_RE.test(holder)) return { unavailable: 'That is not a wallet address.' }
  const limited: EscrowQuoteLimited = { limited: 'Too many cards are held from here right now. Wait two minutes and try again.' }

  const nowMs = rt.now()
  const now = new Date(nowMs)
  sweep(nowMs)
  releaseHolder(holder)
  if (heldFrom(input.address) >= MAX_HELD_PER_ADDRESS) return limited
  const [suspects, disputed] = await Promise.all([suspectListings(now), disputedSellers()])
  const tryAnother = (): EscrowQuoteUnavailable => ({
    unavailable: `We cannot load exactly ${dollars(input.spendCents)} at ${storeName(merchant.name)} right now. Try a different amount.`,
  })

  const gone: string[] = []
  let legs: PickedLeg[] | null = null
  for (let round = 0; round < CHAIN_ROUNDS && legs === null; round++) {
    const quote = await quoteDemand({
      merchantId: merchant.name,
      orderTotalCents: input.spendCents,
      maxCards: MAX_LOAD_CARDS,
      residualCapCents: merchant.capCents,
      formFactor: ESCROW_INTENT_FORM_FACTOR,
      // Read as "live until at least then": quoteDemand keeps listings whose
      // expiry is after this.
      now: new Date(nowMs + EXPIRY_MARGIN_MS),
      excludeIntentIds: [...reservedByOthers(holder), ...cardsOutOfTickets(nowMs), ...suspects, ...gone],
      // The shopper's own listings too: the contract refuses a seller buying their own card.
      excludeAccountIds: [...disputed, `seller:${holder}`],
    })
    if (isNoQuote(quote)) {
      return quote.reason.includes('no live supply') ? { unavailable: `There are no ${storeName(merchant.name)} cards for sale right now.` } : tryAnother()
    }

    const rows = await prisma.intent.findMany({ where: { id: { in: quote.legs.map((l) => l.intentId) } } })
    const byId = new Map(rows.map((r) => [r.id, r]))
    const picked: PickedLeg[] = []
    for (const leg of quote.legs) {
      const row = byId.get(leg.intentId)
      const sealed = row ? readEscrowSealedRef(row.sealedRef, rt.template) : null
      if (!row || row.state !== 'offered' || sealed === null) {
        return { unavailable: 'That card just went. Try again.' }
      }
      const m = sealed.manifest
      // The leftover on the part-used card is the shopper's to keep, and is
      // bounded by what the store lets anyone check.
      if (!leg.fullyDrained && m.valueCents - leg.appliedCents > LEFTOVER_CAP_CENTS[m.mode]) return tryAnother()
      picked.push({
        intentId: row.id,
        listingId: sealed.listingId,
        manifest: sealed.manifestText,
        envelope: sealed.envelope,
        priceUnits: m.price,
        valueCents: m.valueCents,
        seller: m.seller,
        mode: m.mode,
        fullyDrained: leg.fullyDrained,
      })
    }
    const closed = await goneOnChain(picked, rt, nowMs)
    if (closed.length === 0) legs = picked
    else gone.push(...closed)
  }
  if (legs === null) return { unavailable: 'Those cards just went. Try again.' }

  // Whole cards first, the part-used one last: the one rule both tills share
  // (route/scan-order.ts), which is pure, so this rail may import it.
  const ordered: EscrowQuoteLeg[] = tillScanOrder(legs).map((l, i) => ({
    intentId: l.intentId,
    listingId: l.listingId,
    manifest: l.manifest,
    envelope: l.envelope,
    priceUnits: l.priceUnits,
    valueCents: l.valueCents,
    scanOrder: i + 1,
    seller: l.seller,
    mode: l.mode,
  }))
  const loadCents = ordered.reduce((n, l) => n + l.valueCents, 0)
  const priceUnits = ordered.reduce((n, l) => n + l.priceUnits, 0)
  const priceCents = Math.ceil(priceUnits / UNITS_PER_CENT)
  // Checked again with the cards picked: the terms and envelopes go only to a
  // shopper this address may hold them for.
  if (heldFrom(input.address) + ordered.length > MAX_HELD_PER_ADDRESS) return limited
  reserve(holder, input.address, ordered.map((l) => l.intentId), nowMs)

  return {
    merchant: merchant.name,
    spendCents: input.spendCents,
    loadCents,
    priceUnits,
    priceCents,
    savingCents: loadCents - priceCents,
    leftoverCents: loadCents - input.spendCents,
    legs: ordered,
    expiresAt: new Date(nowMs + QUOTE_TTL_MS).toISOString(),
  }
}
