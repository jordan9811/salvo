/**
 * The Load, on the shopper's phone: from "Target, $52" to the card on this
 * device (spec section 8.3).
 *
 * ===========================================================================
 * THE PHONE TRUSTS NOTHING IT CAN CHECK. Our server picks the cards and
 * relays Lit, and every word of that is checked here before money moves:
 *   1. The quote (legProblems): each card's manifest parses for the pinned
 *      escrow, chain and token; recomputing the listing id from the manifest
 *      and envelope gives the leg's id; store, value, price, seller and mode
 *      are the manifest's own; the totals add up, and so do the leftover and
 *      the saving the page shows under the button; the cards cover what was
 *      asked, with no card more than needed, and leave at most the store's
 *      leftover cap.
 *   2. The chain (chainLegProblems), on both public hosts at one finalized
 *      block: each listing is Active for that seller, on an escrow whose
 *      signer is the pinned identity and whose token is pathUSD, and not about
 *      to expire.
 *   3. Each ticket (ticketProblems): it names this account, this card's reply
 *      key and this listing, its balance fits the mode, its time window is one
 *      the contract takes, and it recovers to the pinned identity.
 *   4. The cards the tickets name (cardProblems), on both hosts: no two are
 *      the same card, and the contract would sell each by its seller now
 *      (who owns it, whether its last sale is paid out, the new-seller cap).
 *      Lit's ticket does not check these; only the contract does, so a card
 *      that fails would only make the batch revert.
 * Only then does the access key sign ONE batch: pathUSD.approve(escrow,
 * sum of prices) and one depositAndOpen per card. Tempo runs it all or
 * nothing, so both cards are bought or neither is.
 *
 * THEN THE CHAIN SAYS WHAT HAPPENED. The batch's receipt must be the same on
 * both hosts in a block both call finalized; its Opened events name the
 * deposits, and getDeposit on both hosts must show each one Opened, for this
 * account, this listing and this reply key. Only then is Lit asked to release,
 * every card at once, and each reply is opened here with that card's reply key.
 *
 * RETRIES ARE SAFE AT EVERY STEP, AND A PAGE THAT DIES LOSES NOTHING:
 *   - The reply keys (sealed) and the purchase are written BEFORE the batch
 *     is signed, so before any signed byte leaves this phone, to a host or to
 *     a fee sponsor. Its hash is added once it is known. A reload finds it
 *     and carries on (resumePurchase).
 *   - Sending again cannot pay twice: a listing sells once, so a second batch
 *     for it reverts whole and charges nothing.
 *   - A purchase is called failed only when the chain proves no copy of it
 *     can ever land: one of its cards sold to someone else or taken back, or
 *     a finalized block past every ticket's last second, after which any
 *     copy can only revert. Never from what a host said when it was sent: a
 *     host that took it and then dropped the line, and the other host
 *     refusing the copy it already has, look like a refusal and are not. And
 *     before it is called failed, the chain is asked whether a copy landed
 *     for this phone after all (a sponsor that kept one), and if so the cards
 *     are opened. That lookup has no fixed depth: the tickets say when the
 *     batch can have landed, and the deposits opened then are found however
 *     many came after (reads.ts depositsOpenedBetween).
 *   - A purchase found late is still this phone's whatever has happened to
 *     it since: paid out to the seller (Released) opens just the same, and a
 *     card the seller refunded in full is marked refunded on its own, so its
 *     key goes and the other card of the purchase is still opened.
 *   - A release returns the same bytes every time. The card is saved, then
 *     the purchase records it, and only then is its reply key deleted, so a
 *     crash anywhere in between just finds the card already here.
 * ===========================================================================
 *
 * Browser only by use; imports nothing Node-only. Never logs a card or key.
 */

import { encodeFunctionData, erc20Abi, recoverAddress, type Hex } from 'viem'
import { ESCROW_ABI } from '../artifact'
import { envelopeHashOf, listingIdOfSeal, openDigest, replyPayload, termsOfManifest } from '../hashes'
import { parseEscrowManifest, PATH_USD, UNITS_PER_CENT, type EscrowManifest } from '../manifest'
import { escrowMerchantById, MODE_BLIND, MODE_READABLE, type EscrowMerchantName, type EscrowMode } from '../merchants'
import { escrowIntentIdFor } from '../refs'
import type { TicketView } from '../runbook/smoke'
import { cardSaleRefusalAt, depositAt, depositsOpenedBetween, escrowEvents, gateAt } from '../runbook/reads'
import { agreedFinalizedBlock, EscrowRpcError, receiptOnBothHosts, waitForReceiptFinal, type AgreedBlock, type SentRaw } from '../runbook/rpc'
import {
  parseQuote,
  parseTicket,
  sentenceOf,
  type Answer,
  type EscrowApi,
  type EscrowPublicConfig,
  type QuoteLegView,
  type QuoteView,
} from './api'
import type { CardRecord, CardSecret, CardStore, PurchaseLeg, PurchaseRecord } from './card-store'
import { createBrowserReplyKey, openReply, type BrowserReplyKey } from './reply'
import { SponsorMayHoldError, type BatchCall, type ChainAccess, type PreparedBatch, type SignedBatch } from './wallet'

/** The leftover a shopper may be left holding on the part-used card: the quote route's own caps. */
const LEFTOVER_CAP_CENTS: Readonly<Record<EscrowMode, number>> = { [MODE_READABLE]: 1_000, [MODE_BLIND]: 500 }
/** A ticket with less than this left (chain time) at the tap is asked for again, for free. */
const TICKET_MARGIN_S = 45
/** A listing this close to its expiry is not bought: the template refuses within a minute of it. */
const EXPIRY_MARGIN_S = 120
/** How long the phone waits for a batch to be final before it says "still confirming". */
const FINAL_WAIT_MS = 60_000
/**
 * Release tries per card while the chain catches up with the purchase, a
 * longer pause each time (1 s, 2 s, ... 5 s). Two cards make at most twelve
 * requests a tap, under the release route's twenty a minute per address.
 */
const RELEASE_TRIES = 6
const RELEASE_PAUSE_MS = 1_000
const ZERO32: Hex = `0x${'0'.repeat(64)}`
const LISTING_ACTIVE = 1
const LISTING_SOLD = 2
const LISTING_CANCELLED = 3
const DEPOSIT_OPENED = 1
const DEPOSIT_RELEASED = 2
const DEPOSIT_REFUNDED = 3
/** After every ticket's last second, plus this, no copy of a batch can land: depositAndOpen refuses a stale ticket. */
const PAST_TICKETS_S = 30
/**
 * SalvoEscrowV1.MAX_TICKET_TTL, frozen with the contract: a ticket's last
 * second is at most this long after the block that takes it. The contract's
 * own number, not the config's, since it bounds where this phone looks for
 * its purchase and a smaller one could hide it.
 */
const MAX_TICKET_TTL_S = 900

const lower = (s: string): Hex => s.toLowerCase() as Hex
const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`

export type LoadRefusal =
  /** Nothing to sell at this store and amount, or the quote route said no. */
  | 'unavailable'
  /** Nothing is listed at this store at all, whatever the amount (the till's V2 quote). */
  | 'nothing_listed'
  /** The quote does not match what was asked or what its own manifests say. */
  | 'quote_mismatch'
  /** The chain says a card is not for sale as quoted. */
  | 'not_for_sale'
  /** Lit refused a ticket: the card failed its check, or the store could not be read. */
  | 'ticket_refused'
  /** A ticket came back that this phone must not pay with. */
  | 'ticket_bad'
  /**
   * The batch reverted, or never landed: no card was bought and nothing was
   * paid for one. A batch this phone paid its own fee for still paid that fee
   * if it reached the chain and reverted, and the sentence says so.
   */
  | 'not_charged'
  /** It was paid, and the seller refunded every card of it in full: the money is back. */
  | 'refunded'
  /** Our server, Lit or the chain could not be reached. */
  | 'unreachable'

/** The Load stopped. `message` is a plain sentence for the shopper. */
export class LoadRefused extends Error {
  readonly code: LoadRefusal
  constructor(code: LoadRefusal, sentence: string) {
    super(sentence)
    this.name = 'LoadRefused'
    this.code = code
  }
}

/** The purchase is paid, or may be, and is not finished yet. It is kept; `resumePurchase` carries on. */
export class LoadPending extends Error {
  readonly purchaseId: string
  constructor(purchaseId: string, sentence: string) {
    super(sentence)
    this.name = 'LoadPending'
    this.purchaseId = purchaseId
  }
}

/** Signs and sends batches with the access key. DeviceWallet is one. */
export interface BatchSigner {
  readonly account: Hex
  signCalls(calls: readonly BatchCall[], access: ChainAccess): Promise<SignedBatch>
  broadcast(signed: SignedBatch, access: ChainAccess): Promise<void>
  /** Fill a batch now, to sign at the tap with no network call (wallet.ts). A signer without it fills at the tap. */
  prepareCalls?(calls: readonly BatchCall[], access: ChainAccess): Promise<PreparedBatch | null>
  signPrepared?(p: PreparedBatch): Promise<SignedBatch>
  /** Send, and on a host that can, wait for the receipt in the same call (rpc.ts sendRawFast). */
  broadcastFast?(signed: SignedBatch, access: ChainAccess): Promise<SentRaw>
}

export interface LoadDeps {
  store: CardStore
  api: EscrowApi
  config: EscrowPublicConfig
  access: ChainAccess
  wallet: BatchSigner
  /** Between release tries. Tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>
}

export type LoadStep = 'checking' | 'paying' | 'confirming' | 'opening' | 'done'

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export interface LoadAsk {
  merchant: EscrowMerchantName
  spendCents: number
  depositor: Hex
}

/**
 * Every reason the quote is not the one asked for, or not what its own
 * manifests say. Pure; empty means the quote is consistent.
 */
export function legProblems(q: QuoteView, ask: LoadAsk, cfg: EscrowPublicConfig): string[] {
  const out: string[] = []
  if (q.merchant !== ask.merchant) out.push('the quote is for another store')
  if (q.spendCents !== ask.spendCents) out.push('the quote is for another amount')
  const orders = q.legs.map((l) => l.scanOrder)
  if (orders.some((o, i) => o !== i + 1)) out.push('the cards are not in scan order')
  if (new Set(q.legs.map((l) => l.listingId)).size !== q.legs.length) out.push('the quote names one card twice')
  let value = 0
  let price = 0
  for (const leg of q.legs) {
    const m = parseEscrowManifest(leg.manifest, cfg.escrow)
    if (m === null) {
      out.push('a card is not listed on the escrow this page trusts')
      continue
    }
    if (escrowMerchantById(m.merchant)?.name !== ask.merchant) out.push('a card is for another store')
    if (m.valueCents !== leg.valueCents) out.push("a card's value is not its listing's")
    if (m.price !== leg.priceUnits) out.push("a card's price is not its listing's")
    if (m.seller !== leg.seller) out.push("a card's seller is not its listing's")
    if (m.mode !== leg.mode) out.push("a card's check is not its listing's")
    if (m.seller === lower(ask.depositor)) out.push('a card is your own listing')
    if (m.token !== cfg.token) out.push('a card is priced in another token')
    if (listingIdOfSeal(m, leg.envelope) !== leg.listingId) out.push("a card's terms do not hash to its listing")
    if (escrowIntentIdFor(leg.listingId) !== leg.intentId) out.push("a card's id is not its listing's")
    value += m.valueCents
    price += m.price
  }
  if (value !== q.loadCents) out.push('the card values do not add up to the load')
  if (price !== q.priceUnits) out.push('the prices do not add up to the total')
  if (q.priceCents !== Math.ceil(q.priceUnits / UNITS_PER_CENT)) out.push('the price in dollars is not the price')
  // Both are on screen under the button, so both must be what the cards say.
  if (q.leftoverCents !== q.loadCents - q.spendCents) out.push('the amount left on your card is not what the cards leave')
  if (q.savingCents !== q.loadCents - q.priceCents) out.push('the saving is not what the cards save')
  if (q.loadCents < q.spendCents) out.push('the cards do not cover what you asked for')
  const last = q.legs[q.legs.length - 1]
  if (last !== undefined) {
    if (q.loadCents - q.spendCents > LEFTOVER_CAP_CENTS[last.mode]) out.push('the cards leave more over than the store allows')
    // Every card but the last is used up at the till. If they already cover
    // the amount, the last card is one the shopper does not need.
    if (q.loadCents - last.valueCents >= q.spendCents && q.legs.length > 1) out.push('the quote adds a card you do not need')
  }
  return out
}

/**
 * Every reason the chain says a quoted card is not for sale as quoted, read on
 * both hosts at one finalized block.
 */
export async function chainLegProblems(
  access: ChainAccess,
  cfg: EscrowPublicConfig,
  legs: readonly QuoteLegView[],
): Promise<{ problems: string[]; block: AgreedBlock }> {
  const block = await agreedFinalizedBlock(access.hosts)
  const problems: string[] = []
  const gates = await Promise.all(legs.map((l) => gateAt(access.hosts, block, cfg.escrow, l.listingId, 0n)))
  for (const [i, g] of gates.entries()) {
    const leg = legs[i] as QuoteLegView
    const m = parseEscrowManifest(leg.manifest, cfg.escrow)
    if (g.signer !== cfg.identity) problems.push("the escrow's signer is not the pinned one")
    if (g.token !== PATH_USD) problems.push("the escrow's token is not pathUSD")
    if (g.listingState !== LISTING_ACTIVE) problems.push('a card is no longer for sale')
    else if (g.listingSeller !== leg.seller) problems.push('a card is listed by someone else')
    if (m !== null && Number(block.timestamp) + EXPIRY_MARGIN_S >= m.listingExpiry) problems.push('a card expires too soon to buy')
  }
  return { problems, block }
}

export interface TicketExpect {
  listingId: Hex
  depositor: Hex
  replyKeyHash: Hex
  identity: Hex
  escrow: Hex
  manifest: EscrowManifest
  /** The chain's time now, in seconds. */
  chainTime: number
  maxTtlSeconds: number
}

/** Every reason this phone must not pay with this ticket. Empty means pay. */
export async function ticketProblems(k: TicketView, e: TicketExpect): Promise<string[]> {
  const out: string[] = []
  if (k.listingId !== lower(e.listingId)) out.push('the ticket is for another card')
  if (k.depositor !== lower(e.depositor)) out.push('the ticket names another buyer')
  if (k.replyKeyHash !== lower(e.replyKeyHash)) out.push("the ticket names another phone's key")
  if (k.cardTag === ZERO32) out.push('the ticket has no card tag')
  const m = e.manifest
  if (m.mode === MODE_BLIND && k.openBalanceCents !== 0) out.push('an unchecked card came with a balance')
  if (m.mode === MODE_READABLE && (k.openBalanceCents < m.valueCents || k.openBalanceCents - m.valueCents > m.residualCapCents)) {
    out.push("the card's balance does not fit its listing")
  }
  if (k.notAfter < e.chainTime || k.notAfter > e.chainTime + e.maxTtlSeconds) out.push('the ticket is expired or too long-lived')
  const v = parseInt(k.signature.slice(130), 16)
  if (v !== 27 && v !== 28) out.push('the ticket signature is not one the contract takes')
  try {
    const digest = openDigest(m.chainId, e.escrow, {
      listingId: k.listingId,
      depositor: k.depositor,
      replyKeyHash: k.replyKeyHash,
      openBalanceCents: k.openBalanceCents,
      cardTag: k.cardTag,
      notAfter: k.notAfter,
    })
    if (lower(await recoverAddress({ hash: digest, signature: k.signature })) !== lower(e.identity)) {
      out.push('the ticket is not signed by the card service this page trusts')
    }
  } catch {
    out.push('the ticket signature does not recover')
  }
  return out
}

const CARD_REFUSAL_WORDS = {
  card_not_sellers: "a card is no longer its seller's to sell",
  card_not_paid_out: "a card's last sale is not paid out yet",
  new_seller_cap: 'a card is over what its seller may sell yet',
} as const

/**
 * Every reason the escrow would refuse the cards these tickets name, read on
 * both hosts at one finalized block. Empty means the contract would sell
 * them. The card tag in each ticket is Lit's, signed, so the server cannot
 * change which card a ticket names; it can only hand over one Lit signed for
 * a card the contract refuses, and that is what this catches.
 */
export async function cardProblems(
  access: ChainAccess,
  cfg: EscrowPublicConfig,
  legs: ReadonlyArray<{ manifest: EscrowManifest; ticket: TicketView }>,
): Promise<string[]> {
  const out: string[] = []
  if (new Set(legs.map((l) => lower(l.ticket.cardTag))).size !== legs.length) out.push('two of the cards are the same card')
  const block = await agreedFinalizedBlock(access.hosts)
  const refusals = await Promise.all(
    legs.map((l) =>
      cardSaleRefusalAt(access.hosts, block, cfg.escrow, {
        cardTag: l.ticket.cardTag,
        seller: l.manifest.seller,
        mode: l.manifest.mode,
        valueCents: l.manifest.valueCents,
      }),
    ),
  )
  for (const r of refusals) if (r !== null) out.push(CARD_REFUSAL_WORDS[r])
  return out
}

/** The one batch: approve the escrow for the sum of prices, then pay and open each card. */
export function loadCalls(cfg: EscrowPublicConfig, legs: ReadonlyArray<{ manifest: EscrowManifest; leg: QuoteLegView; ticket: TicketView }>): BatchCall[] {
  const total = legs.reduce((n, l) => n + BigInt(l.manifest.price), 0n)
  return [
    { to: cfg.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [cfg.escrow, total] }) },
    ...legs.map((l) => ({
      to: cfg.escrow,
      data: encodeFunctionData({
        abi: ESCROW_ABI,
        functionName: 'depositAndOpen',
        args: [
          termsOfManifest(l.manifest),
          envelopeHashOf(l.leg.envelope),
          {
            replyKeyHash: l.ticket.replyKeyHash,
            openBalanceCents: l.ticket.openBalanceCents,
            cardTag: l.ticket.cardTag,
            notAfter: l.ticket.notAfter,
            signature: l.ticket.signature,
          },
        ],
      }),
    })),
  ]
}

// ---------------------------------------------------------------------------
// Quote and tickets
// ---------------------------------------------------------------------------

/**
 * Ask our server for a quote. Throws LoadRefused with its sentence when there is none.
 *
 * @wiring-exempt: the first escrow sells nothing new since SalvoEscrowV2 opened (config-v2.ts ESCROW_V2_LIVE), and its Load screen went with it. Kept while V1 drains: it is how tests make the V1 purchase that resumePurchase (Account's Finish it) still finishes, and the V1 freeze tests prove our server refuses it. Delete with V1.
 */
export async function quoteLoad(d: LoadDeps, ask: LoadAsk): Promise<QuoteView> {
  const a = await d.api.quote(ask.merchant, ask.spendCents, ask.depositor)
  if (a.status === 0) throw new LoadRefused('unreachable', sentenceOf(a, 'We could not reach Salvo.'))
  if (a.status !== 200) throw new LoadRefused('unavailable', sentenceOf(a, `We cannot load ${dollars(ask.spendCents)} right now.`))
  const q = parseQuote(a.body.quote)
  if (q === null) throw new LoadRefused('quote_mismatch', 'That quote was not one this page can check. Nothing was charged.')
  return q
}

export interface PreparedLeg {
  leg: QuoteLegView
  manifest: EscrowManifest
  /** In memory only until the tap. Zeroed by discardPrepared. */
  replyKey: BrowserReplyKey
  ticket: TicketView
}

export interface PreparedLoad {
  quote: QuoteView
  depositor: Hex
  legs: PreparedLeg[]
}

async function ticketFor(d: LoadDeps, leg: QuoteLegView, m: EscrowManifest, key: BrowserReplyKey, chainTime: number): Promise<TicketView> {
  const a = await d.api.ticket(leg.intentId, d.wallet.account, key.replyKeyHash)
  if (a.status === 0) throw new LoadRefused('unreachable', sentenceOf(a, 'We could not reach Salvo.'))
  if (a.status !== 200) {
    throw new LoadRefused(a.status === 503 || a.status === 502 ? 'unreachable' : 'ticket_refused', sentenceOf(a, 'That card is not available. Get a new quote.'))
  }
  const k = parseTicket(a.body.ticket)
  const problems =
    k === null
      ? ['the ticket was not in the shape the template signs']
      : await ticketProblems(k, {
          listingId: leg.listingId,
          depositor: d.wallet.account,
          replyKeyHash: key.replyKeyHash,
          identity: d.config.identity,
          escrow: d.config.escrow,
          manifest: m,
          chainTime,
          maxTtlSeconds: d.config.limits.maxTicketTtlSeconds,
        })
  if (k === null || problems.length > 0) {
    throw new LoadRefused('ticket_bad', `This phone will not pay with that ticket: ${problems.join('; ')}. Nothing was charged.`)
  }
  return k
}

/**
 * Check a quote on the device and on the chain (steps 1 and 2 above). Free:
 * no Lit run. Returns the chain's agreed block. Throws LoadRefused.
 */
export async function checkQuote(d: LoadDeps, ask: LoadAsk, q: QuoteView): Promise<AgreedBlock> {
  const sync = legProblems(q, ask, d.config)
  if (sync.length > 0) throw new LoadRefused('quote_mismatch', `This phone will not pay for that quote: ${sync.join('; ')}. Nothing was charged.`)
  const { problems, block } = await chainLegProblems(d.access, d.config, q.legs)
  if (problems.length > 0) {
    // Our server reads the chain before it quotes and leaves out what it finds
    // sold, so asking again picks other cards. The phone says it plainly.
    if (problems.every((p) => p === 'a card is no longer for sale')) {
      throw new LoadRefused('not_for_sale', 'That card just sold. Try again for another. Nothing was charged.')
    }
    throw new LoadRefused('not_for_sale', `The chain says: ${problems.join('; ')}. Try again in a minute. Nothing was charged.`)
  }
  return block
}

/**
 * Check a quote on the device and on the chain, fetch a ticket for each card,
 * each naming a fresh reply key that stays in memory, and check the cards the
 * tickets name on the chain. Nothing is stored and nothing is charged. A
 * refusal throws LoadRefused; the page re-quotes.
 * Each ticket is a paid Lit run, so the page asks for them once the shopper
 * has stopped typing, not on every keystroke.
 *
 * @wiring-exempt: the first escrow sells nothing new since SalvoEscrowV2 opened (config-v2.ts ESCROW_V2_LIVE), and its Load screen went with it. Kept while V1 drains: it is how tests make the V1 purchase that resumePurchase (Account's Finish it) still finishes, and the V1 freeze tests prove our server refuses it. Delete with V1.
 */
export async function prepareLoad(d: LoadDeps, ask: LoadAsk, q: QuoteView): Promise<PreparedLoad> {
  const block = await checkQuote(d, ask, q)
  const keys = q.legs.map(() => createBrowserReplyKey())
  try {
    const legs = await Promise.all(
      q.legs.map(async (leg, i) => {
        const manifest = parseEscrowManifest(leg.manifest, d.config.escrow) as EscrowManifest
        const replyKey = keys[i] as BrowserReplyKey
        return { leg, manifest, replyKey, ticket: await ticketFor(d, leg, manifest, replyKey, Number(block.timestamp)) }
      }),
    )
    const problems = await cardProblems(d.access, d.config, legs)
    if (problems.length > 0) {
      throw new LoadRefused('ticket_refused', `This phone will not pay for that card: ${problems.join('; ')}. Get a new quote. Nothing was charged.`)
    }
    return { quote: q, depositor: d.wallet.account, legs }
  } catch (err) {
    for (const k of keys) k.secretKey.fill(0)
    throw err
  }
}

/**
 * Does this prepared Load buy exactly the cards `q` names, in the same order,
 * for `depositor`? Then its tickets serve `q` as they are. A shopper who
 * changes the amount often gets the same cards quoted again, and asking Lit
 * for new tickets each time would spend a paid run per card per change, and
 * use up the few tickets our server gives one shopper for one card. A
 * listing id commits to its manifest and envelope, and the phone has checked
 * each quote's ids against both, so the same id and manifest is the same card.
 *
 * @wiring-exempt: the first escrow sells nothing new since SalvoEscrowV2 opened (config-v2.ts ESCROW_V2_LIVE), and its Load screen went with it. Kept while V1 drains: it is how tests make the V1 purchase that resumePurchase (Account's Finish it) still finishes, and the V1 freeze tests prove our server refuses it. Delete with V1.
 */
export function preparedFor(p: PreparedLoad | null, q: QuoteView | null, depositor: Hex): p is PreparedLoad {
  if (p === null || q === null || p.depositor !== lower(depositor) || p.legs.length !== q.legs.length) return false
  return q.legs.every((l, i) => {
    const mine = p.legs[i]?.leg
    return mine !== undefined && mine.intentId === l.intentId && mine.listingId === l.listingId && mine.manifest === l.manifest
  })
}

/** Forget a prepared Load the shopper did not tap: its reply keys are zeroed. */
export function discardPrepared(p: PreparedLoad | null): void {
  for (const l of p?.legs ?? []) l.replyKey.secretKey.fill(0)
}

// ---------------------------------------------------------------------------
// The Load
// ---------------------------------------------------------------------------

function randomId(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * The tap. Renews any ticket close to its end, signs the one batch, keeps the
 * purchase and its sealed reply keys, sends it, waits until it is final on
 * both hosts, and opens every card. Returns the stored cards.
 *
 * Throws LoadRefused when nothing was charged, and LoadPending when the
 * purchase may be paid and is kept to finish later (resumePurchase).
 *
 * The prepared Load is spent either way: its in-memory reply keys are zeroed
 * once they are sealed in the store, or when nothing was sent.
 *
 * @wiring-exempt: the first escrow sells nothing new since SalvoEscrowV2 opened (config-v2.ts ESCROW_V2_LIVE), and its Load screen went with it. Kept while V1 drains: it is how tests make the V1 purchase that resumePurchase (Account's Finish it) still finishes, and the V1 freeze tests prove our server refuses it. Delete with V1.
 */
export async function executeLoad(d: LoadDeps, p: PreparedLoad, onStep: (s: LoadStep) => void = () => {}): Promise<CardRecord[]> {
  try {
    return await runLoad(d, p, onStep)
  } finally {
    discardPrepared(p)
  }
}

async function runLoad(d: LoadDeps, p: PreparedLoad, onStep: (s: LoadStep) => void): Promise<CardRecord[]> {
  onStep('checking')
  if (p.depositor !== d.wallet.account) throw new LoadRefused('ticket_bad', 'This Load was prepared for another account. Nothing was charged.')
  let block: AgreedBlock
  try {
    block = await agreedFinalizedBlock(d.access.hosts)
  } catch {
    throw new LoadRefused('unreachable', 'We cannot read the chain right now. Nothing was charged.')
  }
  const chainTime = Number(block.timestamp)
  for (const l of p.legs) {
    if (l.ticket.notAfter < chainTime + TICKET_MARGIN_S) l.ticket = await ticketFor(d, l.leg, l.manifest, l.replyKey, chainTime)
  }

  onStep('paying')
  const purchase: PurchaseRecord = {
    id: randomId(),
    createdAt: Date.now(),
    merchant: p.quote.merchant,
    depositor: d.wallet.account,
    escrow: d.config.escrow,
    // Known once the batch is signed. Until then, the chain is how this
    // purchase is found (settle).
    txHash: null,
    raw: null,
    // With no sponsor, nothing signed can leave this phone before the hash
    // below is kept, so a purchase that never got one was never sent.
    sponsorSet: d.access.sponsorUrl !== null,
    state: 'signed',
    legs: p.legs.map(
      (l, i): PurchaseLeg => ({
        intentId: l.leg.intentId,
        listingId: l.leg.listingId,
        manifest: l.leg.manifest,
        envelope: l.leg.envelope,
        valueCents: l.leg.valueCents,
        priceUnits: l.leg.priceUnits,
        scanOrder: i + 1,
        replyKeyId: '',
        replyPublicKey: l.replyKey.publicKey,
        replyKeyHash: l.replyKey.replyKeyHash,
        ticketNotAfter: l.ticket.notAfter,
        depositId: null,
        released: false,
      }),
    ),
    problem: null,
  }
  // Kept BEFORE anything is signed. Signing with a sponsor sends the signed
  // batch to the sponsor, which could send it on its own; from then on a
  // reload must always be able to find the purchase and open its cards.
  try {
    for (const [i, leg] of purchase.legs.entries()) {
      leg.replyKeyId = `${purchase.id}:${i}`
      await d.store.saveReplyKey(leg.replyKeyId, (p.legs[i] as PreparedLeg).replyKey.secretKey)
    }
    await d.store.savePurchase(purchase)
  } catch {
    throw new LoadRefused('unreachable', 'This phone could not keep the keys for your cards, so nothing was signed or charged.')
  }
  discardPrepared(p)

  let signed: SignedBatch
  try {
    signed = await d.wallet.signCalls(loadCalls(d.config, p.legs), d.access)
  } catch (err) {
    if (err instanceof SponsorMayHoldError) {
      purchase.problem = SPONSOR_HOLDS
      await d.store.savePurchase(purchase)
      throw new LoadPending(purchase.id, SPONSOR_HOLDS)
    }
    // No signed byte left this phone: the batch was never sent anywhere.
    await failPurchase(d, purchase, 'This phone could not sign the payment, so nothing was charged.')
    throw new LoadRefused(err instanceof EscrowRpcError ? 'unreachable' : 'not_charged', 'This phone could not sign the payment, so nothing was charged. Try again.')
  }
  purchase.txHash = signed.hash
  purchase.raw = signed.raw
  purchase.feeSponsored = signed.sponsored
  await d.store.savePurchase(purchase)

  try {
    await d.wallet.broadcast(signed, d.access)
  } catch (err) {
    // Never failed from here. A host may have taken it and then dropped the
    // line, and the other host then refuses the copy it already has ("nonce
    // too low"), which reads like a refusal and is not. The chain decides.
    await settle(d, purchase, sentAndUnsure(err))
  }
  return finishPurchase(d, purchase, onStep)
}

/** Said when signing with the sponsor went wrong after it was sent the signed batch. */
const SPONSOR_HOLDS =
  'The fee sponsor did not answer, so this phone cannot tell yet whether your payment went through. It is saved here, and nothing will be paid twice. Tap Finish it in a few minutes.'
const STILL_CONFIRMING = 'Your payment is still confirming. It is saved on this phone, and nothing will be paid twice. Tap Finish it in a moment.'
/*
  NOTHING CHECKS AGAIN ON ITS OWN. Neither page runs a timer: the phone looks
  again only when the shopper taps Finish it. The chain can call a batch that
  did not land final only once every ticket in it is past its last second
  (about ten minutes for an unchecked card), and until then the page will not
  quote anything new. So the words say what to do, and when.
*/
const TAP_LATER = 'Tap Finish it in about ten minutes to check again. Until then this phone will not load another card. Nothing will be paid twice.'
const UNDONE_RECHECK = `The payment did not go through, as far as the chain shows now. ${TAP_LATER}`
const REFUNDED_IN_FULL = 'The seller refunded this purchase in full. The money is back in your account.'
const NEVER_SENT = 'This phone stopped before the payment was signed, so nothing was sent or charged.'

/** What the shopper reads when a send failed and the chain cannot say yet what happened. */
function sentAndUnsure(err: unknown): string {
  const kept = `This phone keeps the purchase until the chain shows it cannot go through. ${TAP_LATER}`
  if (err instanceof EscrowRpcError && ['network', 'timeout', 'status'].includes(err.kind)) {
    return 'We could not confirm the payment was sent. It is saved on this phone, and nothing will be paid twice. Tap Finish it in a moment.'
  }
  const reason = err instanceof EscrowRpcError ? (err.reason ?? err.message) : ''
  if (/limit|spending/i.test(reason)) return `The chain refused the payment: that is more than this week's allowance on this phone. ${kept}`
  if (/insufficient|balance|funds/i.test(reason)) return `The chain refused the payment: there are not enough dollars in your account. ${kept}`
  if (/expired|revoked/i.test(reason)) return `The chain refused the payment: the allowance on this phone has ended. ${kept}`
  return `The chain refused the payment. ${kept}`
}

async function failPurchase(d: LoadDeps, p: PurchaseRecord, why: string): Promise<void> {
  for (const leg of p.legs) if (leg.replyKeyId !== '') await d.store.deleteReplyKey(leg.replyKeyId)
  p.state = 'failed'
  p.problem = why
  await d.store.savePurchase(p)
}

/** One card of a batch that landed: its deposit, and whether the seller has since refunded it in full. */
interface LandedLeg {
  id: bigint
  refunded: boolean
}

type Verdict =
  /** Every card is this phone's: a deposit for each, naming this account and this card's reply key. */
  | { kind: 'landed'; legs: LandedLeg[] }
  /** No copy of the batch can ever land. */
  | { kind: 'never'; why: 'sold' | 'expired' }
  /** Not settled yet: keep the purchase and its keys. */
  | { kind: 'unknown' }

/**
 * What the chain says about a purchase its own receipt does not settle: no
 * hash known, no receipt in time, a send that failed, or a copy that
 * reverted. Read at one finalized block on both hosts.
 *
 * WHERE TO LOOK. The batch can only have landed while its tickets were good:
 * from the earliest ticket's last second less the contract's longest ticket
 * life, to the latest ticket's last second. Every deposit opened in that
 * window is read (reads.ts depositsOpenedBetween), however long ago it was.
 *
 * WHAT IT MEANS. A batch lands whole, and a listing sells once. So a card
 * sold to a deposit in that window naming this account and this card's reply
 * key means the batch landed (a copy a sponsor kept, say), and every card is
 * this phone's, whatever has happened to each since: still held, paid out to
 * its seller, or refunded in full (each card on its own). A card sold any
 * other way (no deposit for it in the window, or one naming someone else), or
 * taken back, means it never can. Past every ticket's last second it never
 * can either: depositAndOpen refuses a stale ticket. Some cards this phone's
 * and some not cannot happen to one batch; if the chain seems to say so, the
 * purchase is kept, with its keys, rather than failed.
 */
async function chainVerdict(d: LoadDeps, p: PurchaseRecord): Promise<Verdict> {
  const hosts = d.access.hosts
  const block = await agreedFinalizedBlock(hosts)
  const gates = await Promise.all(p.legs.map((l) => gateAt(hosts, block, p.escrow, l.listingId, 0n)))
  const sold = new Set(p.legs.filter((_l, i) => gates[i]?.listingState === LISTING_SOLD).map((l) => l.listingId))
  const lastSeconds = p.legs.map((l) => l.ticketNotAfter)
  const found = await depositsOpenedBetween(hosts, block, p.escrow, sold, Math.min(...lastSeconds) - MAX_TICKET_TTL_S, Math.max(...lastSeconds))
  const legs: Array<LandedLeg | undefined> = p.legs.map(() => undefined)
  let elsewhere = false
  for (const [i, leg] of p.legs.entries()) {
    const g = gates[i]
    if (g === undefined) return { kind: 'unknown' }
    if (g.listingState === LISTING_CANCELLED) elsewhere = true
    if (g.listingState !== LISTING_SOLD) continue
    const f = found.get(leg.listingId)
    if (f === undefined || f.deposit.depositor !== p.depositor || f.deposit.replyKeyHash !== leg.replyKeyHash) {
      elsewhere = true
      continue
    }
    legs[i] = { id: f.id, refunded: f.deposit.state === DEPOSIT_REFUNDED }
  }
  const mine = legs.filter((x): x is LandedLeg => x !== undefined)
  if (mine.length === p.legs.length) return { kind: 'landed', legs: mine }
  if (mine.length > 0) return { kind: 'unknown' }
  if (elsewhere) return { kind: 'never', why: 'sold' }
  const lastValid = Math.max(...lastSeconds)
  if (Number(block.timestamp) > lastValid + PAST_TICKETS_S) return { kind: 'never', why: 'expired' }
  return { kind: 'unknown' }
}

/**
 * The batch landed: keep each card's deposit. A card the seller has since
 * refunded in full is not this phone's to open any more (the money went back,
 * and the card is the seller's again), so its reply key goes and it is marked
 * refunded, on its own: the other card of the purchase is still opened. When
 * every card was refunded the purchase is over, and throws LoadRefused
 * saying so.
 */
async function recordLanded(d: LoadDeps, p: PurchaseRecord, landed: readonly LandedLeg[]): Promise<void> {
  for (const [i, leg] of p.legs.entries()) {
    const l = landed[i] as LandedLeg
    leg.depositId = l.id.toString()
    if (l.refunded && !leg.released) {
      leg.refunded = true
      if (leg.replyKeyId !== '') await d.store.deleteReplyKey(leg.replyKeyId)
    }
  }
  if (p.legs.every((l) => l.refunded === true)) {
    p.state = 'failed'
    p.problem = REFUNDED_IN_FULL
    await d.store.savePurchase(p)
    throw new LoadRefused('refunded', REFUNDED_IN_FULL)
  }
  p.state = 'paid'
  p.problem = null
  await d.store.savePurchase(p)
}

/**
 * What a self-paid batch that reached the chain and reverted cost: its
 * network fee, which a sponsored one's sponsor paid instead. Measured at
 * under a tenth of a cent for a whole Load (spec section 5).
 */
const FEE_ONLY = 'Only the network fee, under a cent, was charged.'

/**
 * Settle a purchase from the chain (chainVerdict): paid, failed, or kept.
 * Returns once it is paid (the caller opens the cards); otherwise throws
 * LoadRefused when no card was bought or all of it came back, or
 * LoadPending with `pending`. `reverted` is true when this very batch is on
 * chain and reverted: then, if this phone paid its own fee, the fee was
 * charged, and the sentence says so instead of "nothing was charged".
 */
async function settle(d: LoadDeps, p: PurchaseRecord, pending: string, reverted = false): Promise<void> {
  let v: Verdict
  try {
    v = await chainVerdict(d, p)
  } catch (err) {
    if (!(err instanceof EscrowRpcError)) throw err
    v = { kind: 'unknown' }
  }
  if (v.kind === 'landed') {
    await recordLanded(d, p, v.legs)
    return
  }
  if (v.kind === 'never') {
    const feePaid = reverted && p.feeSponsored !== true
    const why =
      v.why === 'sold'
        ? feePaid
          ? `A card sold a moment earlier, so no card was bought. ${FEE_ONLY}`
          : 'A card sold a moment earlier, so nothing was charged.'
        : feePaid
          ? `The payment did not go through, so no card was bought. ${FEE_ONLY}`
          : 'The payment never went through, so nothing was charged.'
    await failPurchase(d, p, why)
    throw new LoadRefused('not_charged', `${why} Try again.`)
  }
  p.problem = pending
  await d.store.savePurchase(p)
  throw new LoadPending(p.id, pending)
}

/**
 * The Opened events of a successful receipt: each card's deposit, read back
 * on both hosts. Read at the agreed block now, which for a purchase finished
 * late can be days after it landed: by then a deposit may be paid out to its
 * seller (Released) or refunded in full (Refunded). It is still this phone's
 * purchase either way, as long as it names this account, this listing and
 * this card's reply key.
 */
async function recordOpened(d: LoadDeps, p: PurchaseRecord, final: Awaited<ReturnType<typeof waitForReceiptFinal>>): Promise<void> {
  const opened = escrowEvents(final.receipt, p.escrow, 'Opened')
  const landed: LandedLeg[] = []
  for (const leg of p.legs) {
    const ev = opened.find((o) => lower(o.listingId) === leg.listingId && lower(o.depositor) === p.depositor)
    if (ev === undefined) {
      p.problem = 'The payment landed but did not open one of the cards. Nothing more was charged.'
      await d.store.savePurchase(p)
      throw new LoadPending(p.id, p.problem)
    }
    const dep = await depositAt(d.access.hosts, final.block, p.escrow, ev.depositId)
    const known = dep.state === DEPOSIT_OPENED || dep.state === DEPOSIT_RELEASED || dep.state === DEPOSIT_REFUNDED
    if (!known || dep.depositor !== p.depositor || dep.listingId !== leg.listingId || dep.replyKeyHash !== leg.replyKeyHash) {
      p.problem = 'The chain does not show this purchase the way this phone made it.'
      await d.store.savePurchase(p)
      throw new LoadPending(p.id, p.problem)
    }
    landed.push({ id: ev.depositId, refunded: dep.state === DEPOSIT_REFUNDED })
  }
  await recordLanded(d, p, landed)
}

/**
 * Said when a purchase is paid and a card did not reach this phone. Never
 * that the card is safe here: it is not here yet. And never tells the
 * shopper to ask for their money back: no page offers a way to ask yet
 * (dispute and refund are a later phase). What is true is that Finish it
 * keeps working: the release route
 * and the template open a card whose sale is already paid out to its seller
 * (spec section 8.11), so the seller's payout a day later does not shut it.
 */
function notOpenedYet(p: PurchaseRecord, why: string): string {
  const which = p.legs.length > 1 ? 'one of your cards has' : 'your card has'
  return `Your payment went through, but ${which} not reached this phone yet. ${why} Tap Finish it to try again. It still works after the seller is paid. Refunds are not on these pages yet.`
}

/** From a signed batch to stored cards. Shared by the tap and by resume. */
async function finishPurchase(d: LoadDeps, p: PurchaseRecord, onStep: (s: LoadStep) => void): Promise<CardRecord[]> {
  if (p.state === 'signed') {
    onStep('confirming')
    if (p.txHash === null) {
      // No hash kept: the page stopped while the batch was being signed. With
      // no sponsor set then, no signed byte ever left this phone, so it can
      // never land: over now, not ten minutes from now. Only a sponsor that
      // was sent the signed batch can hold a copy. A purchase kept before
      // this was recorded is read as having had one.
      if (p.sponsorSet === false) {
        await failPurchase(d, p, NEVER_SENT)
        throw new LoadRefused('not_charged', `${NEVER_SENT} Try again.`)
      }
      await settle(d, p, p.problem ?? SPONSOR_HOLDS)
    } else {
      let final: Awaited<ReturnType<typeof waitForReceiptFinal>> | null = null
      try {
        final = await waitForReceiptFinal(d.access.hosts, p.txHash, { timeoutMs: FINAL_WAIT_MS })
      } catch (err) {
        if (!(err instanceof EscrowRpcError)) throw err
      }
      if (final === null) await settle(d, p, STILL_CONFIRMING)
      // This copy reverted. Another copy may still have landed, or may: ask.
      else if (final.receipt.status !== 'success') await settle(d, p, UNDONE_RECHECK, true)
      else await recordOpened(d, p, final)
    }
  }
  if (p.state === 'paid') {
    onStep('opening')
    const results = await Promise.allSettled(p.legs.filter((leg) => leg.refunded !== true).map((leg) => releaseLeg(d, p, leg)))
    await d.store.savePurchase(p)
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed !== undefined) {
      p.problem = notOpenedYet(p, failed.reason instanceof Error ? failed.reason.message : NO_ANSWER)
      await d.store.savePurchase(p)
      throw new LoadPending(p.id, p.problem)
    }
    p.state = 'done'
    p.problem = null
    await d.store.savePurchase(p)
  }
  onStep('done')
  const ids = new Set(p.legs.filter((l) => l.refunded !== true).map((l) => `${p.escrow}:${l.depositId ?? ''}`))
  return (await d.store.cards()).filter((c) => ids.has(c.id))
}

const CARD_KEYS = 'cardNumber,pin'

function parseCard(bytes: Uint8Array): CardSecret | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
    const o = v as Record<string, unknown>
    if (Object.keys(o).sort().join(',') !== CARD_KEYS) return null
    if (typeof o.cardNumber !== 'string' || o.cardNumber.length < 1 || o.cardNumber.length > 128) return null
    if (o.pin !== null && typeof o.pin !== 'string') return null
    return { cardNumber: o.cardNumber, pin: o.pin }
  } catch {
    return null
  }
}

const NO_ANSWER = 'The card service did not answer.'

/**
 * Why a release did not come back, in this phone's words. Never the route's
 * own sentence: the phone knows this purchase is paid and the card is not
 * here, which the route cannot say.
 */
function releaseTrouble(a: Answer): string {
  if (a.status === 429) return 'The card service is busy.'
  if (a.status === 409 || (a.status === 404 && a.body.error === 'no_purchase')) return 'The card service cannot see the purchase on the chain yet.'
  if (a.status === 404) return 'Salvo no longer holds this listing.'
  if (a.status === 403) return 'The card service says this phone did not buy this card.'
  return NO_ANSWER
}

/** A release still waiting on the chain: worth a pause and another try. Anything else is not. */
const chainCatchingUp = (a: Answer): boolean => a.status === 409 || (a.status === 404 && a.body.error === 'no_purchase')

/** Ask Lit, through our server, for one bought card, open it here, and store it. Idempotent. */
async function releaseLeg(d: LoadDeps, p: PurchaseRecord, leg: PurchaseLeg): Promise<void> {
  if (leg.released) return
  if (leg.depositId === null) throw new Error('This card has no purchase on chain yet.')
  const cardId = `${p.escrow}:${leg.depositId}`
  // Already here: the page stopped after the card was saved and before the
  // purchase recorded it. Nothing to ask for; finish the bookkeeping.
  if (await d.store.hasCard(cardId)) {
    leg.released = true
    await d.store.savePurchase(p)
    await d.store.deleteReplyKey(leg.replyKeyId)
    return
  }
  const sleep = d.sleep ?? realSleep
  let answer = await d.api.release(leg.depositId, leg.replyPublicKey)
  for (let i = 1; i < RELEASE_TRIES && chainCatchingUp(answer); i++) {
    // The release route reads the chain itself; give the hosts longer each time.
    await sleep(RELEASE_PAUSE_MS * i)
    answer = await d.api.release(leg.depositId, leg.replyPublicKey)
  }
  if (answer.status !== 200) throw new Error(releaseTrouble(answer))
  const { reply, payload } = answer.body
  const expected = replyPayload(d.config.chainId, leg.depositId, p.escrow, leg.manifest)
  if (typeof reply !== 'string' || payload !== expected) throw new Error('The card came back keyed to another purchase.')

  const secretKey = await d.store.replyKey(leg.replyKeyId)
  if (secretKey === null) throw new Error('This phone no longer has the key for this card.')
  let bytes: Uint8Array | null = null
  try {
    bytes = await openReply(secretKey, reply, expected, d.config.encPub)
    const card = parseCard(bytes)
    if (card === null) throw new Error('The card came back in a shape this phone does not read.')
    const m = parseEscrowManifest(leg.manifest, p.escrow)
    const merchant = m === null ? null : escrowMerchantById(m.merchant)
    if (m === null || merchant === null) throw new Error('The card is for a store this phone does not know.')
    await d.store.saveCard(
      {
        id: cardId,
        escrow: p.escrow,
        depositId: leg.depositId,
        listingId: leg.listingId,
        merchant: merchant.name,
        valueCents: leg.valueCents,
        priceUnits: leg.priceUnits,
        scanOrder: leg.scanOrder,
        ofCards: p.legs.length,
        last4: card.cardNumber.slice(-4),
        boughtAt: p.createdAt,
        mode: m.mode,
      },
      card,
    )
  } finally {
    secretKey.fill(0)
    bytes?.fill(0)
  }
  // The card is stored; the purchase says so before the key goes. A page that
  // stops between any two of these finds the card here next time.
  leg.released = true
  await d.store.savePurchase(p)
  await d.store.deleteReplyKey(leg.replyKeyId)
}

/**
 * Carry on a purchase this phone kept: look its batch up, or open the cards
 * it paid for. Safe to call any number of times.
 */
export async function resumePurchase(d: LoadDeps, purchaseId: string, onStep: (s: LoadStep) => void = () => {}): Promise<CardRecord[]> {
  const p = await d.store.purchase(purchaseId)
  if (p === null) throw new LoadRefused('unavailable', 'That purchase is not on this phone.')
  if (p.state === 'failed') {
    const refunded = p.legs.length > 0 && p.legs.every((l) => l.refunded === true)
    throw new LoadRefused(refunded ? 'refunded' : 'not_charged', p.problem ?? 'That purchase did not go through. Nothing was charged.')
  }
  if (p.state === 'signed' && p.raw !== null && p.txHash !== null) {
    const seen = await receiptOnBothHosts(d.access.hosts, p.txHash).catch(() => null)
    if (seen === null) {
      // Not seen yet, so it may never have left this phone. The same bytes
      // are the same transaction: sending them again can never pay twice, and
      // a host that already has them, or has run them, just says so. A host
      // that refuses them outright leaves the chain to say what happened,
      // with no wait for a receipt that is not coming.
      let refusal: unknown = null
      await d.wallet.broadcast({ raw: p.raw, hash: p.txHash, sponsored: false }, d.access).catch((err: unknown) => {
        if (!(err instanceof EscrowRpcError) || !['network', 'timeout', 'status'].includes(err.kind)) refusal = err
      })
      if (refusal !== null) {
        onStep('confirming')
        await settle(d, p, sentAndUnsure(refusal))
      }
    }
  }
  return finishPurchase(d, p, onStep)
}

/** Purchases on this phone that are paid, or may be, and not finished. */
export async function unfinishedPurchases(store: CardStore): Promise<PurchaseRecord[]> {
  return (await store.purchases()).filter((p) => p.state === 'signed' || p.state === 'paid')
}
