/**
 * Paying at the till on SalvoEscrowV2, on the shopper's phone: pay only for
 * the value used, the rest of the last card left for the next shopper with a
 * deposit at face, all in one batch (unified spec sections 5.3, 7.1 and 8.3).
 *
 * ===========================================================================
 * THE PHONE TRUSTS NOTHING IT CAN CHECK. The till's planner picks the cards
 * and our server relays Lit; every word is checked here before money moves:
 *   1. The quote (quote-v2.ts quoteProblemsV2): each card's manifest is a V2
 *      listing on the pinned escrow and hashes to its listing; every card but
 *      the last is used up, the last leaves at most its cap, the cents used
 *      are the total less the cards before, and each card's price and deposit
 *      are what SalvoEscrowV2 charges for those cents.
 *   2. The chain (chainQuoteProblemsV2), on both hosts at one finalized
 *      block: each listing is Active for its seller, in exactly the state the
 *      plan priced (value left, sales count, the deposit covering what is
 *      left), and SalvoEscrowV2's own rules, run here (terms-v2.ts), price it
 *      the same. A remainder someone else's deposit covers is used whole; the
 *      shopper's own may be used in part, and their deposit comes back in the
 *      same transaction, netted.
 *   3. Each ticket (ticketProblemsPhoneV2): this account, this card's reply
 *      key and this listing, the same value left and sales count as the chain
 *      read, the same covering deposit, a balance that fits the mode, a time
 *      window the contract takes, and the pinned V2 identity's signature.
 *   4. The cards the tickets name (cardProblemsV2): no two the same card, and
 *      SalvoEscrowV2 would sell each now (owner, payout, one live listing per
 *      card, the new-seller cap).
 * Only then does the access key sign ONE batch: pathUSD.approve(V2, what the
 * contract will pull for every card together, price plus deposit, less the
 * shopper's own deposit coming back) and one depositAndOpen(terms, envelope
 * hash, cents used, ticket) per card. All or nothing. The cents used are
 * never asked of the shopper: they are the total typed less the full cards.
 *
 * RETRIES ARE SAFE AT EVERY STEP, by V1's rules (load.ts says why for
 * each): the reply keys and the purchase are kept before
 * anything is signed; a purchase is failed only when the chain proves no copy
 * can land (a card's state moved on without it, or every ticket is past its
 * last second); before that the chain is asked whether a copy landed after
 * all. A V2 ticket names the listing's sales count, so a copy of this batch
 * after anyone else's sale of the same card can only revert.
 * ===========================================================================
 *
 * Browser only by use; imports nothing Node-only. Never logs a card or key.
 */

import { encodeFunctionData, erc20Abi, keccak256, recoverAddress, stringToHex, type Hex } from 'viem'
import { ESCROW_V2_ABI } from '../artifact-v2'
import { signDoneV2 } from '../done-proof-v2'
import { envelopeHashOf, replyPayload } from '../hashes'
import { openDigestV2, signatureFormOkV2, termsOfManifestV2 } from '../hashes-v2'
import { parseEscrowManifestV2, type EscrowManifestV2 } from '../manifest-v2'
import { escrowMerchantById, MODE_BLIND, MODE_READABLE, type EscrowMerchantName } from '../merchants'
import { quoteProblemsV2, type QuoteLegV2, type QuoteV2 } from '../quote-v2'
import {
  cardSaleRefusalV2At,
  depositCountV2At,
  depositV2At,
  escrowEventsV2,
  gateV2At,
  V2_STATE,
  type DepositViewV2,
} from '../runbook/reads-v2'
import {
  agreedFinalizedBlock,
  EscrowRpcError,
  receiptAgreed,
  receiptOnBothHosts,
  receiptOnHost,
  waitForReceiptFinal,
  type AgreedBlock,
  type ChainReceipt,
  type HostsConfig,
  type SentRaw,
} from '../runbook/rpc'
import type { TicketViewV2 } from '../runbook/smoke-v2'
import { quoteUseV2, type ListingNowV2, type UseQuoteV2 } from '../terms-v2'
import type { TapStep } from '@/lib/till/timing'
import { parseQuoteV2, parseTicketV2, type EscrowApiV2, type EscrowPublicConfigV2, type QuotePreferenceV2, type TicketAnswerV2 } from './api-v2'
import { sentenceOf, type Answer } from './api'
import type { CardSecret, CardStore } from './card-store'
import { LoadPending, LoadRefused, type BatchSigner, type LoadStep } from './load'
import { markReported, type BatchedAction, type CardRecordV2, type DeviceBookV2, type PurchaseLegV2, type PurchaseRecordV2, type TillTapV2 } from './records-v2'
import { createBrowserReplyKey, openReply, type BrowserReplyKey } from './reply'
import { preparedFresh, SponsorMayHoldError, type BatchCall, type ChainAccess, type PreparedBatch, type SignedBatch } from './wallet'

/** A ticket with less than this left (chain time) at the tap is asked for again. */
const TICKET_MARGIN_S = 45
/** A listing this close to its expiry is not bought: the template refuses within a minute of it. */
const EXPIRY_MARGIN_S = 120
const FINAL_WAIT_MS = 60_000
const RELEASE_TRIES = 6
const RELEASE_PAUSE_MS = 1_000
/**
 * The first pause before asking Lit again, when it said the purchase is not
 * on the chain yet: on the fast path the release is asked for the moment one
 * host has the receipt, and Lit's own hosts can be a block behind (0.61 s).
 */
const RELEASE_FIRST_PAUSE_MS = 600
/** A chain read younger than this, made while the shopper typed, stands for the tap's own (spec 5.3). */
const CHAIN_READ_FRESH_MS = 15_000
/** After every ticket's last second, plus this, no copy of a batch can land. */
const PAST_TICKETS_S = 30
/** SalvoEscrowV2.MAX_TICKET_TTL, frozen with the contract: where this phone looks for its purchase. */
const MAX_TICKET_TTL_S = 900
const ZERO32: Hex = `0x${'0'.repeat(64)}`

const lower = (s: string): Hex => s.toLowerCase() as Hex
const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface LoadDepsV2 {
  store: CardStore
  book: DeviceBookV2
  api: EscrowApiV2
  config: EscrowPublicConfigV2
  access: ChainAccess
  wallet: BatchSigner
  /** Between release tries. Tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>
  /** Each step of the tap as it ends, and how long it took, ms (scripts/till-timing.ts). */
  onMark?: (step: TapStep, ms: number) => void
}

/** Time `step` from now: call the result when it ends. */
function timer(d: Pick<LoadDepsV2, 'onMark'>, step: TapStep): () => void {
  const t0 = Date.now()
  return () => d.onMark?.(step, Date.now() - t0)
}

/** What the shopper asked for at the till. */
export interface TillAskV2 {
  merchant: EscrowMerchantName
  totalCents: number
  depositor: Hex
  preference: QuotePreferenceV2
  /** Cards to leave out: one just reported, so its leftover is not sold back to the shopper who reported it. */
  exclude?: readonly string[]
  /** A price with no hold, for a phone that cannot pay with dollars yet. Never followed by tickets. */
  preview?: boolean
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** The reason a report carries on chain: a fixed public tag, never the shopper's words. */
export const REPORT_REASON = {
  empty: keccak256(stringToHex('salvo/till/empty')),
  didnt_scan: keccak256(stringToHex('salvo/till/didnt_scan')),
  declined: keccak256(stringToHex('salvo/till/declined')),
  problem: keccak256(stringToHex('salvo/till/problem')),
} as const

/** "That card was empty": a remainder sale covered by another shopper's deposit, inside its contest window. */
export function contestCallV2(escrow: Hex, depositId: bigint): BatchCall {
  return { to: lower(escrow), data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'contestRemainder', args: [depositId, REPORT_REASON.empty] }) }
}

/** "It didn't scan" or "the register declined it": holds the payout 48 hours longer so the seller can refund. */
export function disputeCallV2(escrow: Hex, depositId: bigint, reason: Hex): BatchCall {
  return { to: lower(escrow), data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'dispute', args: [depositId, reason] }) }
}

/** The calls a batch makes before paying, for the reports it carries. */
function beforeCalls(escrow: Hex, before: readonly BatchedAction[]): BatchCall[] {
  return before.map((b) => (b.kind === 'contest' ? contestCallV2(escrow, BigInt(b.depositId)) : disputeCallV2(escrow, BigInt(b.depositId), REPORT_REASON[b.reason])))
}

/** The ticket as SalvoEscrowV2's Ticket struct takes it. */
function ticketStruct(k: TicketViewV2) {
  return {
    replyKeyHash: k.replyKeyHash,
    openBalanceCents: k.openBalanceCents,
    cardTag: k.cardTag,
    remainingCents: k.remainingCents,
    sales: k.sales,
    notAfter: k.notAfter,
    signature: k.signature,
  }
}

/**
 * The one batch: the reports it carries, approve V2 for exactly what it will
 * pull, then pay and open each card for the cents it uses.
 */
export function loadCallsV2(
  cfg: EscrowPublicConfigV2,
  legs: ReadonlyArray<{ manifest: EscrowManifestV2; leg: QuoteLegV2; ticket: TicketViewV2; use: UseQuoteV2 }>,
  before: readonly BatchedAction[] = [],
): BatchCall[] {
  const pull = legs.reduce((n, l) => n + l.use.pull, 0n)
  return [
    ...beforeCalls(cfg.escrow, before),
    { to: cfg.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [cfg.escrow, pull] }) },
    ...legs.map((l) => ({
      to: cfg.escrow,
      data: encodeFunctionData({
        abi: ESCROW_V2_ABI,
        functionName: 'depositAndOpen',
        args: [termsOfManifestV2(l.manifest), envelopeHashOf(l.leg.envelope), l.leg.usedCents, ticketStruct(l.ticket)],
      }),
    })),
  ]
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** One card's state on chain now, and what SalvoEscrowV2 would charge for the cents the quote uses. */
export interface ChainLegV2 {
  now: ListingNowV2
  use: UseQuoteV2
}

/** The use refusals, in the shopper's words. */
const USE_REFUSAL_WORDS = {
  used: 'a card is used for more than is on it',
  left: 'a card would leave more over than its listing allows',
  'remainder whole': "a partly used card another shopper holds the deposit on must be used whole",
} as const

/**
 * Every reason the chain says a quoted card is not for sale as quoted, read
 * on both hosts at one finalized block, and for each card the contract's own
 * price for it. `chain` is empty unless `problems` is.
 */
export async function chainQuoteProblemsV2(
  access: ChainAccess,
  cfg: EscrowPublicConfigV2,
  legs: readonly QuoteLegV2[],
  depositor: Hex,
): Promise<{ problems: string[]; block: AgreedBlock; chain: ChainLegV2[] }> {
  const block = await agreedFinalizedBlock(access.hosts)
  const problems: string[] = []
  const chain: ChainLegV2[] = []
  const gates = await Promise.all(legs.map((l) => gateV2At(access.hosts, block, cfg.escrow, l.listingId, 0n)))
  for (const [i, g] of gates.entries()) {
    const leg = legs[i] as QuoteLegV2
    const m = parseEscrowManifestV2(leg.manifest, cfg.escrow)
    if (g.signer !== cfg.identity) problems.push("the escrow's signer is not the pinned one")
    if (g.token !== cfg.token) problems.push("the escrow's token is not pathUSD")
    if (g.listingState !== V2_STATE.listing.ACTIVE) problems.push('a card is no longer for sale')
    else if (g.listingSeller !== leg.seller) problems.push('a card is listed by someone else')
    if (m === null) continue
    if (Number(block.timestamp) + EXPIRY_MARGIN_S >= m.listingExpiry) problems.push('a card expires too soon to buy')
    const valueLeft = g.sales === 0 ? m.valueCents : g.remainingCents
    if (g.sales !== leg.sales || valueLeft !== leg.remainingCents || g.bondDeposit !== BigInt(leg.bondDeposit)) {
      problems.push('a card was used by another shopper since the quote')
      continue
    }
    let ownBond: bigint | null = null
    if (g.bondDeposit !== 0n) {
      const b = await depositV2At(access.hosts, block, cfg.escrow, g.bondDeposit)
      if (b.depositor === lower(depositor) && b.bondState === V2_STATE.bond.HELD) ownBond = b.bond
    }
    const now: ListingNowV2 = { remainingCents: g.remainingCents, sales: g.sales, bondDeposit: g.bondDeposit, ownBond }
    const use = quoteUseV2(termsOfManifestV2(m), now, leg.usedCents)
    if ('refused' in use) {
      problems.push(USE_REFUSAL_WORDS[use.refused])
      continue
    }
    if (use.amount !== BigInt(leg.amountUnits) || use.bond !== BigInt(leg.bondUnits) || use.leftCents !== leg.leftCents) {
      problems.push('the escrow would charge another price for a card')
      continue
    }
    chain.push({ now, use })
  }
  return { problems, block, chain: problems.length === 0 ? chain : [] }
}

export interface TicketExpectV2 {
  listingId: Hex
  depositor: Hex
  replyKeyHash: Hex
  identity: Hex
  escrow: Hex
  chainId: number
  manifest: EscrowManifestV2
  /** The listing state the phone read: the ticket must name the same. */
  remainingCents: number
  sales: number
  bondDeposit: bigint
  /** The chain's time now, in seconds. */
  chainTime: number
  maxTtlSeconds: number
}

/** The ticket problems that mean only "the card moved on since": a new quote fixes them. */
const STATE_PROBLEMS = new Set(['the ticket is for another state of the card', 'the ticket names another deposit on the card'])

/** Every reason this phone must not pay with this V2 ticket. Empty means pay. */
export async function ticketProblemsPhoneV2(a: TicketAnswerV2, e: TicketExpectV2): Promise<string[]> {
  const out: string[] = []
  const k = a.ticket
  if (k.listingId !== lower(e.listingId)) out.push('the ticket is for another card')
  if (k.depositor !== lower(e.depositor)) out.push('the ticket names another buyer')
  if (k.replyKeyHash !== lower(e.replyKeyHash)) out.push("the ticket names another phone's key")
  if (k.cardTag === ZERO32) out.push('the ticket has no card tag')
  if (k.remainingCents !== e.remainingCents || k.sales !== e.sales) out.push('the ticket is for another state of the card')
  if (a.bondDeposit !== e.bondDeposit) out.push('the ticket names another deposit on the card')
  const m = e.manifest
  if (m.mode === MODE_BLIND && k.openBalanceCents !== 0) out.push('an unchecked card came with a balance')
  if (m.mode === MODE_READABLE && (k.openBalanceCents < e.remainingCents || k.openBalanceCents - e.remainingCents > m.residualCapCents)) {
    out.push("the card's balance does not fit what is left on it")
  }
  if (k.notAfter < e.chainTime || k.notAfter > e.chainTime + e.maxTtlSeconds) out.push('the ticket is expired or too long-lived')
  // v 27 or 28 and a low s: viem recovers a high-s twin too, which the contract refuses ("sig s").
  if (!signatureFormOkV2(k.signature)) out.push('the ticket signature is not one the contract takes')
  try {
    const digest = openDigestV2(e.chainId, e.escrow, {
      listingId: k.listingId,
      depositor: k.depositor,
      replyKeyHash: k.replyKeyHash,
      openBalanceCents: k.openBalanceCents,
      cardTag: k.cardTag,
      remainingCents: k.remainingCents,
      sales: k.sales,
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
  card_listed: 'a card is listed twice',
  new_seller_cap: 'a card is over what its seller may sell yet',
} as const

/**
 * Every reason SalvoEscrowV2 would refuse the cards these tickets name, read
 * on both hosts at one finalized block. Lit's ticket does not check these;
 * only the contract does, and a card that fails would only make the batch revert.
 */
export async function cardProblemsV2(
  access: ChainAccess,
  cfg: EscrowPublicConfigV2,
  legs: ReadonlyArray<{ manifest: EscrowManifestV2; leg: QuoteLegV2; ticket: TicketViewV2 }>,
  at: AgreedBlock | null = null,
): Promise<string[]> {
  const out: string[] = []
  if (new Set(legs.map((l) => l.ticket.cardTag)).size !== legs.length) out.push('two of the cards are the same card')
  const block = at ?? (await agreedFinalizedBlock(access.hosts))
  const refusals = await Promise.all(
    legs.map((l) =>
      cardSaleRefusalV2At(access.hosts, block, cfg.escrow, {
        cardTag: l.ticket.cardTag,
        seller: l.manifest.seller,
        listingId: l.leg.listingId,
        sales: l.ticket.sales,
        mode: l.manifest.mode,
        valueCents: l.manifest.valueCents,
      }),
    ),
  )
  for (const r of refusals) if (r !== null) out.push(CARD_REFUSAL_WORDS[r])
  return out
}

// ---------------------------------------------------------------------------
// Quote and tickets
// ---------------------------------------------------------------------------

/** Ask the till's planner for a V2 quote. Throws LoadRefused with its sentence when there is none. */
export async function quoteTillV2(d: Pick<LoadDepsV2, 'api'>, ask: TillAskV2): Promise<QuoteV2> {
  const a = await d.api.quote(ask.merchant, ask.totalCents, ask.depositor, ask.preference, ask.exclude ?? [], ask.preview === true)
  if (a.status === 0) throw new LoadRefused('unreachable', sentenceOf(a, 'We could not reach Salvo.'))
  if (a.status !== 200) {
    throw new LoadRefused(a.body.error === 'nothing_listed' ? 'nothing_listed' : 'unavailable', sentenceOf(a, `Nothing covers ${dollars(ask.totalCents)} right now.`))
  }
  const q = parseQuoteV2(a.body.quote)
  if (q === null) throw new LoadRefused('quote_mismatch', 'That quote was not one this page can check. Nothing was charged.')
  return q
}

export interface PreparedLegV2 {
  leg: QuoteLegV2
  manifest: EscrowManifestV2
  /** The listing state the phone read and the ticket names. */
  now: ListingNowV2
  use: UseQuoteV2
  /** In memory only until the tap. Zeroed by discardPreparedV2. */
  replyKey: BrowserReplyKey
  ticket: TicketViewV2
}

export interface PreparedLoadV2 {
  quote: QuoteV2
  depositor: Hex
  legs: PreparedLegV2[]
  /** The chain read the cards were checked at, and this phone's clock then: the tap reuses it while it is young. */
  read: { block: AgreedBlock; at: number }
  /**
   * The one batch, filled from the hosts while the shopper typed (nonce,
   * fees, gas: fillBatchV2), or null. The tap signs it with no network call
   * when it is still good for exactly these calls, and fills afresh if not.
   */
  batch: PreparedBatch | null
}

/** What the batch pulls from the shopper, in token units: every card's price and deposit, less their own deposit back. */
export function pullOf(p: Pick<PreparedLoadV2, 'legs'>): bigint {
  return p.legs.reduce((n, l) => n + l.use.pull, 0n)
}

async function ticketForV2(d: LoadDepsV2, leg: QuoteLegV2, m: EscrowManifestV2, now: ListingNowV2, key: BrowserReplyKey, chainTime: number): Promise<TicketViewV2> {
  const a = await d.api.ticket(leg.intentId, d.wallet.account, key.replyKeyHash)
  if (a.status === 0) throw new LoadRefused('unreachable', sentenceOf(a, 'We could not reach Salvo.'))
  if (a.status !== 200) {
    throw new LoadRefused(a.status === 503 || a.status === 502 ? 'unreachable' : 'ticket_refused', sentenceOf(a, 'That card is not available. Get a new quote.'))
  }
  const answer = parseTicketV2(a.body)
  const problems =
    answer === null
      ? ['the ticket was not in the shape the template signs']
      : await ticketProblemsPhoneV2(answer, {
          listingId: leg.listingId,
          depositor: d.wallet.account,
          replyKeyHash: key.replyKeyHash,
          identity: d.config.identity,
          escrow: d.config.escrow,
          chainId: d.config.chainId,
          manifest: m,
          remainingCents: leg.remainingCents,
          sales: now.sales,
          bondDeposit: now.bondDeposit,
          chainTime,
          maxTtlSeconds: d.config.limits.maxTicketTtlSeconds,
        })
  if (answer === null || problems.length > 0) {
    if (problems.every((p) => STATE_PROBLEMS.has(p))) {
      throw new LoadRefused('not_for_sale', 'Another shopper just used that card. Get a new quote. Nothing was charged.')
    }
    throw new LoadRefused('ticket_bad', `This phone will not pay with that ticket: ${problems.join('; ')}. Nothing was charged.`)
  }
  return answer.ticket
}

/**
 * A quote's chain check as checkQuoteV2 made it, and when (this phone's
 * clock, taken before the read): the prepare that follows it uses it while it
 * is young instead of reading the same cards again.
 */
export interface CheckedQuoteV2 {
  quote: QuoteV2
  block: AgreedBlock
  chain: ChainLegV2[]
  at: number
}

/** Check a quote on the device and on the chain. Free: no Lit run. Throws LoadRefused. */
export async function checkQuoteV2(d: LoadDepsV2, ask: TillAskV2, q: QuoteV2): Promise<CheckedQuoteV2> {
  const sync = quoteProblemsV2(q, ask, d.config.escrow)
  if (sync.length > 0) throw new LoadRefused('quote_mismatch', `This phone will not pay for that quote: ${sync.join('; ')}. Nothing was charged.`)
  const at = Date.now()
  const { problems, block, chain } = await chainQuoteProblemsV2(d.access, d.config, q.legs, ask.depositor)
  if (problems.length > 0) {
    if (problems.every((p) => p === 'a card is no longer for sale' || p === 'a card was used by another shopper since the quote')) {
      throw new LoadRefused('not_for_sale', 'Another shopper just used that card. Try again for another. Nothing was charged.')
    }
    throw new LoadRefused('not_for_sale', `The chain says: ${problems.join('; ')}. Try again in a minute. Nothing was charged.`)
  }
  return { quote: q, block, chain, at }
}

/** A chain read younger than CHAIN_READ_FRESH_MS, by this phone's clock. */
const young = (at: number, now: number = Date.now()): boolean => now - at >= 0 && now - at < CHAIN_READ_FRESH_MS

/**
 * Check a quote on the device and on the chain, fetch a ticket for each card
 * with a fresh reply key that stays in memory, and check the cards the
 * tickets name. Nothing is stored and nothing is charged. Each ticket is a
 * paid Lit run, so the till asks once the total has stopped changing.
 *
 * WHAT IS READ, AND WHEN (the tap may be waiting on the end of this):
 *   - `checked`, the check this phone made of this very quote as it priced
 *     it, stands for the cards' state the tickets are checked against while
 *     it is young (spec 5.3), so Lit is asked at once. The same check runs
 *     again on both hosts beside the tickets: a card another shopper used
 *     since the quote is refused as that (Pay prices again), whatever Lit
 *     answered for it. Without a young check, the check comes first, as
 *     before, and only the block is read beside the tickets;
 *   - that read, made while Lit runs, is the block the cards are checked at
 *     once the tickets name them, and the read the tap's own time margin
 *     starts from;
 *   - after the tickets, ONE round: the cards they name, on both hosts
 *     (cardSaleRefusalV2At asks all it needs at once), beside the batch
 *     filled from Tempo's host (its nonce, fees and gas: the gas needs the
 *     tickets). A card refused there throws the batch away unsigned.
 */
export async function prepareLoadV2(d: LoadDepsV2, ask: TillAskV2, q: QuoteV2, checked: CheckedQuoteV2 | null = null): Promise<PreparedLoadV2> {
  let check: CheckedQuoteV2
  let beside: Promise<{ block: AgreedBlock; at: number }>
  if (checked !== null && checked.quote === q && young(checked.at)) {
    // The pure checks again at once; the chain's, beside the tickets.
    const sync = quoteProblemsV2(q, ask, d.config.escrow)
    if (sync.length > 0) throw new LoadRefused('quote_mismatch', `This phone will not pay for that quote: ${sync.join('; ')}. Nothing was charged.`)
    check = checked
    beside = checkQuoteV2(d, ask, q).then((again) => ({ block: again.block, at: again.at }))
  } else {
    check = await checkQuoteV2(d, ask, q)
    beside = agreedFinalizedBlock(d.access.hosts).then((block) => ({ block, at: Date.now() }))
  }
  const { block, chain } = check
  const keys = q.legs.map(() => createBrowserReplyKey())
  try {
    const tickets = Promise.all(
      q.legs.map(async (leg, i): Promise<PreparedLegV2> => {
        const manifest = parseEscrowManifestV2(leg.manifest, d.config.escrow) as EscrowManifestV2
        const c = chain[i] as ChainLegV2
        const replyKey = keys[i] as BrowserReplyKey
        const ticket = await ticketForV2(d, leg, manifest, c.now, replyKey, Number(block.timestamp))
        return { leg, manifest, now: c.now, use: c.use, replyKey, ticket }
      }),
    )
    const [got, seen] = await Promise.allSettled([tickets, beside])
    // What the chain refused is said first: a card used since is a new price, never "that card did not pass".
    if (seen.status === 'rejected' && seen.reason instanceof LoadRefused) throw seen.reason
    if (got.status === 'rejected') throw got.reason
    if (seen.status === 'rejected') throw seen.reason
    const legs = got.value
    const prepared: PreparedLoadV2 = { quote: q, depositor: lower(ask.depositor), legs, read: seen.value, batch: null }
    const [problems] = await Promise.all([cardProblemsV2(d.access, d.config, legs, seen.value.block), fillBatchV2(d, prepared)])
    if (problems.length > 0) {
      throw new LoadRefused('ticket_refused', `This phone will not pay for that card: ${problems.join('; ')}. Get a new quote. Nothing was charged.`)
    }
    return prepared
  } catch (err) {
    for (const k of keys) k.secretKey.fill(0)
    throw err
  }
}

/**
 * Fill the one batch for these cards now, from the hosts (wallet.ts
 * prepareCalls), so the tap only signs and sends. Nothing is signed or sent.
 * Kept as it is while it still fits these calls (and `before`, the reports a
 * tap carries); a fill that fails is left to the tap, which fills it again
 * the usual way.
 */
export async function fillBatchV2(
  d: Pick<LoadDepsV2, 'wallet' | 'config' | 'access'>,
  p: PreparedLoadV2,
  before: readonly BatchedAction[] = [],
): Promise<void> {
  if (d.wallet.prepareCalls === undefined || spent(p)) return
  const calls = loadCallsV2(d.config, p.legs, before)
  if (preparedFresh(p.batch, d.wallet.account, calls)) return
  try {
    p.batch = await d.wallet.prepareCalls(calls, d.access)
  } catch {
    p.batch = null
  }
}

/**
 * What the tap reads again before it signs, in ONE round, and only what has
 * aged since the prepare: the agreed block (the tickets' time margin is
 * judged on the chain's clock) once that read is CHAIN_READ_FRESH_MS old, and
 * the batch once its fill is PREPARED_MAX_AGE_MS old (wallet.ts: the nonce
 * and fees may have moved). Both at once; nothing when neither has aged.
 * Throws only when the chain cannot be read; a fill that fails is left to
 * signing, which fills afresh.
 */
export async function freshenPreparedV2(
  d: Pick<LoadDepsV2, 'wallet' | 'config' | 'access'>,
  p: PreparedLoadV2,
  before: readonly BatchedAction[] = [],
): Promise<void> {
  const reread = young(p.read.at)
    ? Promise.resolve()
    : agreedFinalizedBlock(d.access.hosts).then((block) => {
        p.read = { block, at: Date.now() }
      })
  await Promise.all([reread, fillBatchV2(d, p, before)])
}

/** Two quotes on the same cards in the same state, in the same order: what a prepared purchase's tickets stand for. Pure. */
export function sameCardsV2(a: QuoteV2 | null, b: QuoteV2 | null): boolean {
  if (a === null || b === null || a.legs.length !== b.legs.length) return false
  return a.legs.every((l, i) => {
    const m = b.legs[i]
    return m !== undefined && sameStateV2(l, m)
  })
}

/** One card in the same state in two quotes: a ticket binds this, never the cents used. */
function sameStateV2(a: QuoteLegV2, b: QuoteLegV2): boolean {
  return (
    a.intentId === b.intentId &&
    a.listingId === b.listingId &&
    a.manifest === b.manifest &&
    a.sales === b.sales &&
    a.remainingCents === b.remainingCents &&
    a.bondDeposit === b.bondDeposit
  )
}

/**
 * The same prepared tickets, for a new quote that picks the same cards in the
 * same state: a V2 ticket binds the listing's state, never the cents used, so
 * a new total on the same cards needs no new Lit run (spec section 5.3). The
 * new cents used are priced again here from the state the phone read, and
 * must be what the quote says. Null when any card or its state differs; the
 * caller then prepares afresh. Pure.
 */
export function reusePreparedV2(p: PreparedLoadV2 | null, q: QuoteV2, ask: TillAskV2, escrow: Hex): PreparedLoadV2 | null {
  if (p === null || p.depositor !== lower(ask.depositor) || p.legs.length !== q.legs.length) return null
  if (quoteProblemsV2(q, ask, escrow).length > 0) return null
  const legs: PreparedLegV2[] = []
  for (const [i, l] of q.legs.entries()) {
    const mine = p.legs[i]
    if (mine === undefined || !sameStateV2(mine.leg, l)) return null
    const use = quoteUseV2(termsOfManifestV2(mine.manifest), mine.now, l.usedCents)
    if ('refused' in use || use.amount !== BigInt(l.amountUnits) || use.bond !== BigInt(l.bondUnits)) return null
    legs.push({ ...mine, leg: l, use })
  }
  // The batch was filled for the old cents used: fillBatchV2 fills it again, and the tap would anyway.
  return { quote: q, depositor: p.depositor, legs, read: p.read, batch: p.batch }
}

/** Forget a prepared purchase the shopper did not tap: its reply keys are zeroed. */
export function discardPreparedV2(p: PreparedLoadV2 | null): void {
  for (const l of p?.legs ?? []) l.replyKey.secretKey.fill(0)
}

// ---------------------------------------------------------------------------
// The tap
// ---------------------------------------------------------------------------

function randomId(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

const SPONSOR_HOLDS =
  'The fee sponsor did not answer, so this phone cannot tell yet whether your payment went through. It is saved here, and nothing will be paid twice. Tap Finish it in a few minutes.'
const STILL_CONFIRMING = 'Your payment is still confirming. It is saved on this phone, and nothing will be paid twice. Tap Finish it in a moment.'
const TAP_LATER = 'Tap Finish it in about ten minutes to check again. Until then this phone will not pay for another card. Nothing will be paid twice.'
const UNDONE_RECHECK = `The payment did not go through, as far as the chain shows now. ${TAP_LATER}`
const REFUNDED_IN_FULL = 'The seller refunded this purchase in full. The money is back in your account.'
const NEVER_SENT = 'This phone stopped before the payment was signed, so nothing was sent or charged.'
const FEE_ONLY = 'Only the network fee, under a cent, was charged.'
const NO_ANSWER = 'The card service did not answer.'

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

/**
 * The tap. Renews any ticket close to its end, keeps the purchase and its
 * sealed reply keys, signs the one batch (with the reports in `before`, if
 * any), sends it, and opens every card. Returns the purchase, done.
 *
 * ===========================================================================
 * THE TAP ONLY SIGNS AND SENDS, AND EVERY CHECK STILL RUNS (spec 5.3).
 *   - Everything that can be is read while the shopper types: the tickets,
 *     the chain read they were checked at, and the batch's nonce, fees and
 *     gas (prepareLoadV2, fillBatchV2). A read under 15 s old stands for the
 *     tap's own, and a fill under 30 s old is signed as it is; whichever is
 *     older is read again, both in one round (freshenPreparedV2).
 *   - The batch is sent through eth_sendRawTransactionSync on Tempo's own
 *     host, which answers with the receipt once it is in a block; elsewhere
 *     it is sent plainly and that host's receipt is asked for every 100 ms.
 *     On Tempo finalized equals latest, so a receipt in a block is final.
 *   - Then two things at once: Lit is asked to release every card, from the
 *     deposits that receipt names, and the second host is asked to agree.
 *     Never the agreement first: the template reads the chain itself before
 *     it unlocks a card, so it is the check that matters for the card. Both
 *     must finish before the first code is drawn, and the purchase is
 *     recorded as paid only once both hosts show the same receipt, in a
 *     block both call final, and every deposit as this phone made it.
 *   - A receipt this host says reverted, or that does not open every card,
 *     takes the old path: both hosts' receipt, then the chain's verdict.
 * ===========================================================================
 *
 * Throws LoadRefused when nothing was charged, and LoadPending when the
 * purchase may be paid and is kept to finish later (resumePurchaseV2). The
 * prepared purchase is spent either way. `tap`: the till's key for this tap
 * and the shopper's own credit the same plan used, kept on the purchase
 * before anything is signed.
 */
export async function executeLoadV2(
  d: LoadDepsV2,
  p: PreparedLoadV2,
  onStep: (s: LoadStep) => void = () => {},
  before: readonly BatchedAction[] = [],
  tap: TillTapV2 | null = null,
): Promise<PurchaseRecordV2> {
  try {
    return await runLoadV2(d, p, onStep, before, tap)
  } finally {
    discardPreparedV2(p)
  }
}

/** A node's word that the batch's nonce was used by another transaction: these bytes can never land. */
const nonceUsed = (err: unknown): boolean => err instanceof EscrowRpcError && err.kind === 'rpc' && /nonce too low/i.test(err.message)

/** True once a prepared purchase's keys are zeroed: paid or forgotten. Paying with one would put the card beyond this phone's reach. */
function spent(p: PreparedLoadV2): boolean {
  return p.legs.some((l) => l.replyKey.secretKey.every((b) => b === 0))
}

async function runLoadV2(
  d: LoadDepsV2,
  p: PreparedLoadV2,
  onStep: (s: LoadStep) => void,
  before: readonly BatchedAction[],
  tap: TillTapV2 | null,
): Promise<PurchaseRecordV2> {
  onStep('checking')
  if (p.depositor !== d.wallet.account) throw new LoadRefused('ticket_bad', 'This purchase was prepared for another account. Nothing was charged.')
  if (spent(p)) throw new LoadRefused('quote_mismatch', 'This purchase was already paid or put aside. Type the total again. Nothing was charged.')
  // What has aged since the prepare, read again in one round: nothing at all
  // when the shopper tapped within 15 s of it (freshenPreparedV2).
  const readsAt = timer(d, 'reads')
  try {
    await freshenPreparedV2(d, p, before)
  } catch {
    throw new LoadRefused('unreachable', 'We cannot read the chain right now. Nothing was charged.')
  }
  readsAt()
  // The chain's time, for the tickets' margin: that read, moved on by this phone's clock.
  const chainTime = Number(p.read.block.timestamp) + Math.ceil(Math.max(0, Date.now() - p.read.at) / 1000)
  for (const l of p.legs) {
    if (l.ticket.notAfter < chainTime + TICKET_MARGIN_S) l.ticket = await ticketForV2(d, l.leg, l.manifest, l.now, l.replyKey, chainTime)
  }

  onStep('paying')
  const purchase: PurchaseRecordV2 = {
    version: 2,
    id: randomId(),
    createdAt: Date.now(),
    merchant: p.quote.merchant,
    depositor: d.wallet.account,
    escrow: d.config.escrow,
    totalCents: p.quote.totalCents,
    uncoveredCents: p.quote.uncoveredCents,
    pullUnits: pullOf(p).toString(),
    txHash: null,
    raw: null,
    sponsorSet: d.access.sponsorUrl !== null,
    state: 'signed',
    legs: p.legs.map(
      (l, i): PurchaseLegV2 => ({
        intentId: l.leg.intentId,
        listingId: l.leg.listingId,
        manifest: l.leg.manifest,
        envelope: l.leg.envelope,
        mode: l.manifest.mode,
        source: l.leg.source,
        remainingCents: l.leg.remainingCents,
        sales: l.now.sales,
        bondDeposit: l.now.bondDeposit.toString(),
        usedCents: l.leg.usedCents,
        leftCents: l.use.leftCents,
        amountUnits: l.use.amount.toString(),
        bondUnits: l.use.bond.toString(),
        scanOrder: i + 1,
        replyKeyId: '',
        replyPublicKey: l.replyKey.publicKey,
        replyKeyHash: l.replyKey.replyKeyHash,
        ticketNotAfter: l.ticket.notAfter,
        depositId: null,
        released: false,
      }),
    ),
    before: [...before],
    ...(tap === null ? {} : { till: { key: tap.key, own: tap.own.map((o) => ({ ...o })), ownTaken: tap.ownTaken, ...(tap.plan === undefined ? {} : { plan: tap.plan }) } }),
    problem: null,
  }
  // Kept BEFORE anything is signed, as for V1: from the moment a sponsor holds
  // a signed batch, a reload must always be able to find this purchase.
  try {
    await Promise.all(
      purchase.legs.map((leg, i) => {
        leg.replyKeyId = `v2:${purchase.id}:${i}`
        return d.store.saveReplyKey(leg.replyKeyId, (p.legs[i] as PreparedLegV2).replyKey.secretKey)
      }),
    )
    await d.book.savePurchase(purchase)
  } catch {
    throw new LoadRefused('unreachable', 'This phone could not keep the keys for your cards, so nothing was signed or charged.')
  }
  const calls = loadCallsV2(d.config, p.legs, before)
  const filled = p.batch
  discardPreparedV2(p)

  const signedAt = timer(d, 'sign')
  let signed: SignedBatch
  try {
    signed =
      d.wallet.signPrepared !== undefined && preparedFresh(filled, d.wallet.account, calls) ? await d.wallet.signPrepared(filled) : await d.wallet.signCalls(calls, d.access)
  } catch (err) {
    if (err instanceof SponsorMayHoldError) {
      purchase.problem = SPONSOR_HOLDS
      await d.book.savePurchase(purchase)
      throw new LoadPending(purchase.id, SPONSOR_HOLDS)
    }
    await failPurchase(d, purchase, 'This phone could not sign the payment, so nothing was charged.')
    throw new LoadRefused(err instanceof EscrowRpcError ? 'unreachable' : 'not_charged', 'This phone could not sign the payment, so nothing was charged. Try again.')
  }
  signedAt()
  await keepSigned(d, purchase, signed)

  if (d.wallet.broadcastFast === undefined) {
    try {
      await d.wallet.broadcast(signed, d.access)
    } catch (err) {
      // Never failed from here: the chain decides (load.ts says why).
      await settle(d, purchase, sentAndUnsure(err))
    }
    return finishPurchase(d, purchase, onStep)
  }

  const sentAt = timer(d, 'send')
  let sent: SentRaw
  try {
    sent = await d.wallet.broadcastFast(signed, d.access)
  } catch (err) {
    // A filled batch whose nonce another send used since: those bytes can
    // never land, so it is filled and signed again. A copy that did land
    // after all is found by its receipt first; and every ticket names the
    // card's sales count, so a second batch after the first can only revert.
    if (!nonceUsed(err) || (await receiptOnHost(d.access.hosts, 0, signed.hash, { timeoutMs: 0 }).then(() => true, () => false))) {
      await settle(d, purchase, sentAndUnsure(err))
      return finishPurchase(d, purchase, onStep)
    }
    try {
      signed = await d.wallet.signCalls(calls, d.access)
    } catch (again) {
      if (again instanceof SponsorMayHoldError) {
        purchase.problem = SPONSOR_HOLDS
        await d.book.savePurchase(purchase)
        throw new LoadPending(purchase.id, SPONSOR_HOLDS)
      }
      await failPurchase(d, purchase, 'This phone could not sign the payment, so nothing was charged.')
      throw new LoadRefused('not_charged', 'This phone could not sign the payment, so nothing was charged. Try again.')
    }
    await keepSigned(d, purchase, signed)
    try {
      sent = await d.wallet.broadcastFast(signed, d.access)
    } catch (err2) {
      await settle(d, purchase, sentAndUnsure(err2))
      return finishPurchase(d, purchase, onStep)
    }
  }
  sentAt()
  return finishFast(d, purchase, sent, onStep)
}

/** The signed bytes and their hash, kept before they are sent: a reload finds the purchase by them. */
async function keepSigned(d: LoadDepsV2, purchase: PurchaseRecordV2, signed: SignedBatch): Promise<void> {
  purchase.txHash = signed.hash
  purchase.raw = signed.raw
  purchase.feeSponsored = signed.sponsored
  await d.book.savePurchase(purchase)
}

/**
 * The fast path after the send: one host's receipt, then Lit's release of
 * every card and the second host's agreement at once (executeLoadV2 says
 * why in that order). Anything this cannot settle goes the old way:
 * finishPurchase, which waits for both hosts and asks the chain.
 */
async function finishFast(d: LoadDepsV2, p: PurchaseRecordV2, sent: SentRaw, onStep: (s: LoadStep) => void): Promise<PurchaseRecordV2> {
  onStep('confirming')
  const hash = p.txHash as Hex
  const includedAt = timer(d, 'included')
  let first: ChainReceipt
  try {
    first = sent.receipt ?? (await receiptOnHost(d.access.hosts, sent.host, hash, { timeoutMs: FINAL_WAIT_MS }))
  } catch (err) {
    if (!(err instanceof EscrowRpcError)) throw err
    await settle(d, p, STILL_CONFIRMING)
    return finishPurchase(d, p, onStep)
  }
  includedAt()
  // The deposits this receipt opened, one per card. A receipt that reverted,
  // or that does not open every card, is not acted on from one host.
  const opened = first.status === 'success' ? escrowEventsV2(first, p.escrow, 'Opened') : []
  const ids = p.legs.map((leg) => opened.find((o) => lower(o.listingId) === leg.listingId && lower(o.depositor) === p.depositor)?.depositId)
  if (first.status !== 'success' || ids.some((id) => id === undefined)) return finishPurchase(d, p, onStep)

  onStep('opening')
  const agreedAt = timer(d, 'second_host')
  const releasedAt = timer(d, 'release')
  // Lit is asked first: never after the second host, whose word books the purchase but opens no card.
  const releases = Promise.allSettled(p.legs.map((leg, i) => releaseLeg(d, p, leg, (ids[i] as bigint).toString()))).then((r) => {
    releasedAt()
    return r
  })
  const agreement = receiptAgreed(d.access.hosts, first, { timeoutMs: FINAL_WAIT_MS }).then(async (final) => {
    await recordOpened(d, p, final)
    agreedAt()
  })
  const [agreed, released] = await Promise.allSettled([agreement, releases])
  if (agreed.status === 'rejected') {
    const err: unknown = agreed.reason
    if (!(err instanceof EscrowRpcError)) throw err
    // The second host did not agree in time: the chain decides, as on the old path.
    await settle(d, p, STILL_CONFIRMING)
    return finishPurchase(d, p, onStep)
  }
  const failed = released.status === 'fulfilled' ? released.value.find((r): r is PromiseRejectedResult => r.status === 'rejected') : undefined
  if (failed !== undefined) {
    p.problem = notOpenedYet(p, failed.reason instanceof Error ? failed.reason.message : NO_ANSWER)
    await d.book.savePurchase(p)
    throw new LoadPending(p.id, p.problem)
  }
  p.state = 'done'
  p.problem = null
  await d.book.savePurchase(p)
  onStep('done')
  return p
}

async function failPurchase(d: LoadDepsV2, p: PurchaseRecordV2, why: string): Promise<void> {
  for (const leg of p.legs) if (leg.replyKeyId !== '') await d.store.deleteReplyKey(leg.replyKeyId)
  p.state = 'failed'
  p.problem = why
  await d.book.savePurchase(p)
}

interface LandedLeg {
  id: bigint
  refunded: boolean
}

type Verdict = { kind: 'landed'; legs: LandedLeg[] } | { kind: 'never'; why: 'sold' | 'expired' } | { kind: 'unknown' }

/**
 * This account's deposits opened between `from` and `to` (chain seconds) on
 * these listings with these reply keys, read at one block. Ids run from 1
 * with no gaps and open in time order, so the first one at or after `from`
 * is found by halving, and the rest are read in order until `to`.
 */
async function depositsOpenedBetweenV2(
  hosts: HostsConfig,
  block: AgreedBlock,
  escrow: Hex,
  wanted: ReadonlyMap<Hex, Hex>,
  depositor: Hex,
  from: number,
  to: number,
): Promise<Map<Hex, { id: bigint; deposit: DepositViewV2 }>> {
  const found = new Map<Hex, { id: bigint; deposit: DepositViewV2 }>()
  if (wanted.size === 0 || to < from) return found
  const count = await depositCountV2At(hosts, block, escrow)
  let lo = 1n
  let hi = count + 1n
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    if ((await depositV2At(hosts, block, escrow, mid)).openedAt < from) lo = mid + 1n
    else hi = mid
  }
  for (let start = lo; start <= count && found.size < wanted.size; start += 10n) {
    const ids: bigint[] = []
    for (let id = start; id <= count && id < start + 10n; id++) ids.push(id)
    const deposits = await Promise.all(ids.map((id) => depositV2At(hosts, block, escrow, id)))
    let past = false
    for (const [i, deposit] of deposits.entries()) {
      if (deposit.openedAt > to) {
        past = true
        break
      }
      const key = wanted.get(deposit.listingId)
      if (key !== undefined && deposit.depositor === depositor && deposit.replyKeyHash === key && !found.has(deposit.listingId)) {
        found.set(deposit.listingId, { id: ids[i] as bigint, deposit })
      }
    }
    if (past) break
  }
  return found
}

const isRefunded = (state: number): boolean => state === V2_STATE.deposit.REFUNDED || state === V2_STATE.deposit.CONTESTED

/**
 * What the chain says about a purchase its own receipt does not settle, read
 * at one finalized block on both hosts. A card sold to a deposit naming this
 * account and this card's reply key, in the window the tickets allow, means
 * the batch landed. A card whose state moved on (another sale, or no longer
 * for sale) with no such deposit means no copy can ever land: every ticket
 * names the sales count it was signed for. Past every ticket's last second
 * no copy can land either.
 */
async function chainVerdict(d: LoadDepsV2, p: PurchaseRecordV2): Promise<Verdict> {
  const hosts = d.access.hosts
  const block = await agreedFinalizedBlock(hosts)
  const gates = await Promise.all(p.legs.map((l) => gateV2At(hosts, block, p.escrow, l.listingId, 0n)))
  const lastSeconds = p.legs.map((l) => l.ticketNotAfter)
  const wanted = new Map(p.legs.map((l) => [l.listingId, l.replyKeyHash]))
  const found = await depositsOpenedBetweenV2(hosts, block, p.escrow, wanted, p.depositor, Math.min(...lastSeconds) - MAX_TICKET_TTL_S, Math.max(...lastSeconds))
  const legs: Array<LandedLeg | undefined> = p.legs.map(() => undefined)
  let movedOn = false
  for (const [i, leg] of p.legs.entries()) {
    const g = gates[i]
    if (g === undefined) return { kind: 'unknown' }
    const f = found.get(leg.listingId)
    if (f !== undefined && f.deposit.saleIndex === leg.sales) {
      legs[i] = { id: f.id, refunded: isRefunded(f.deposit.state) }
      continue
    }
    if (g.listingState !== V2_STATE.listing.ACTIVE || g.sales !== leg.sales) movedOn = true
  }
  const mine = legs.filter((x): x is LandedLeg => x !== undefined)
  if (mine.length === p.legs.length) return { kind: 'landed', legs: mine }
  if (mine.length > 0) return { kind: 'unknown' }
  if (movedOn) return { kind: 'never', why: 'sold' }
  if (Number(block.timestamp) > Math.max(...lastSeconds) + PAST_TICKETS_S) return { kind: 'never', why: 'expired' }
  return { kind: 'unknown' }
}

async function recordLanded(d: LoadDepsV2, p: PurchaseRecordV2, landed: readonly LandedLeg[]): Promise<void> {
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
    await d.book.savePurchase(p)
    throw new LoadRefused('refunded', REFUNDED_IN_FULL)
  }
  p.state = 'paid'
  p.problem = null
  await d.book.savePurchase(p)
  // The batch landed whole, so the reports it carried landed with it.
  if (p.before.length > 0) await markReported(d.book, p.before)
}

async function settle(d: LoadDepsV2, p: PurchaseRecordV2, pending: string, reverted = false): Promise<void> {
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
          ? `Another shopper used a card a moment earlier, so no card was bought. ${FEE_ONLY}`
          : 'Another shopper used a card a moment earlier, so nothing was charged.'
        : feePaid
          ? `The payment did not go through, so no card was bought. ${FEE_ONLY}`
          : 'The payment never went through, so nothing was charged.'
    await failPurchase(d, p, why)
    throw new LoadRefused('not_charged', `${why} Try again.`)
  }
  p.problem = pending
  await d.book.savePurchase(p)
  throw new LoadPending(p.id, pending)
}

/**
 * The Opened events of a successful receipt, read back on both hosts: each
 * card's deposit names this account, this listing, this card's reply key and
 * the sale the ticket was for, and holds the value the purchase planned
 * (used plus left; the shopper's own later reduceUse or keepRest moves cents
 * between the two and keeps the sum).
 */
async function recordOpened(d: LoadDepsV2, p: PurchaseRecordV2, final: Awaited<ReturnType<typeof waitForReceiptFinal>>): Promise<void> {
  const opened = escrowEventsV2(final.receipt, p.escrow, 'Opened')
  const landed: LandedLeg[] = []
  for (const leg of p.legs) {
    const ev = opened.find((o) => lower(o.listingId) === leg.listingId && lower(o.depositor) === p.depositor)
    if (ev === undefined) {
      p.problem = 'The payment landed but did not open one of the cards. Nothing more was charged.'
      await d.book.savePurchase(p)
      throw new LoadPending(p.id, p.problem)
    }
    const dep = await depositV2At(d.access.hosts, final.block, p.escrow, ev.depositId)
    const known = dep.state >= V2_STATE.deposit.OPENED && dep.state <= V2_STATE.deposit.CONTESTED
    if (
      !known ||
      dep.depositor !== p.depositor ||
      dep.listingId !== leg.listingId ||
      dep.replyKeyHash !== leg.replyKeyHash ||
      dep.saleIndex !== leg.sales ||
      dep.usedCents + dep.leftAfterCents !== leg.remainingCents
    ) {
      p.problem = 'The chain does not show this purchase the way this phone made it.'
      await d.book.savePurchase(p)
      throw new LoadPending(p.id, p.problem)
    }
    landed.push({ id: ev.depositId, refunded: isRefunded(dep.state) })
  }
  await recordLanded(d, p, landed)
}

function notOpenedYet(p: PurchaseRecordV2, why: string): string {
  const which = p.legs.length > 1 ? 'one of your cards has' : 'your card has'
  return `Your payment went through, but ${which} not reached this phone yet. ${why} Tap Finish it to try again. It still works after the seller is paid.`
}

async function finishPurchase(d: LoadDepsV2, p: PurchaseRecordV2, onStep: (s: LoadStep) => void): Promise<PurchaseRecordV2> {
  if (p.state === 'signed') {
    onStep('confirming')
    if (p.txHash === null) {
      if (!p.sponsorSet) {
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
      else if (final.receipt.status !== 'success') await settle(d, p, UNDONE_RECHECK, true)
      else await recordOpened(d, p, final)
    }
  }
  if (p.state === 'paid') {
    onStep('opening')
    const results = await Promise.allSettled(p.legs.filter((leg) => leg.refunded !== true).map((leg) => releaseLeg(d, p, leg)))
    await d.book.savePurchase(p)
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed !== undefined) {
      p.problem = notOpenedYet(p, failed.reason instanceof Error ? failed.reason.message : NO_ANSWER)
      await d.book.savePurchase(p)
      throw new LoadPending(p.id, p.problem)
    }
    p.state = 'done'
    p.problem = null
    await d.book.savePurchase(p)
  }
  onStep('done')
  return p
}

const CARD_KEYS = 'cardNumber,pin'

/** The card JSON the template seals, `{cardNumber, pin}` exactly, as load.ts reads it. */
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

function releaseTrouble(a: Answer): string {
  if (a.status === 429) return 'The card service is busy.'
  if (a.status === 409 || (a.status === 404 && a.body.error === 'no_purchase')) return 'The card service cannot see the purchase on the chain yet.'
  if (a.status === 404) return 'Salvo no longer holds this listing.'
  if (a.status === 403) return 'The card service says this phone did not buy this card.'
  return NO_ANSWER
}

const chainCatchingUp = (a: Answer): boolean => a.status === 409 || (a.status === 404 && a.body.error === 'no_purchase')

/** The card-store.ts id of a V2 card: the escrow and its deposit, unique across both escrows. */
export const cardIdV2 = (escrow: Hex, depositId: string): string => `${lower(escrow)}:${depositId}`

/**
 * Ask Lit, through our server, for one bought card, open it here, and store
 * it. Idempotent. `depositId`: the deposit the purchase's receipt opened for
 * it, before the second host has agreed (finishFast); the template checks it
 * on the chain itself, and the reply is keyed to it.
 *
 * Before the card's reply key is deleted, it signs "done with this card" for
 * this deposit (done-proof-v2.ts), kept on the leg: the till sends it once
 * it is done with the card, so the leftover need not rest for the next
 * shopper. Signing takes about a millisecond, and nothing waits on sending.
 */
async function releaseLeg(d: LoadDepsV2, p: PurchaseRecordV2, leg: PurchaseLegV2, depositId: string | null = leg.depositId): Promise<void> {
  if (leg.released) return
  if (depositId === null) throw new Error('This card has no purchase on chain yet.')
  const cardId = cardIdV2(p.escrow, depositId)
  const proofOf = (secretKey: Uint8Array): void => {
    leg.doneProof = { depositId, signature: signDoneV2(secretKey, { chainId: d.config.chainId, escrow: p.escrow, depositId }) }
  }
  if (await d.store.hasCard(cardId)) {
    // Opened on a run cut short: its key may still be here to sign with.
    if (leg.doneProof?.depositId !== depositId) {
      const key = await d.store.replyKey(leg.replyKeyId).catch(() => null)
      if (key !== null) {
        proofOf(key)
        key.fill(0)
      }
    }
    leg.released = true
    await d.book.savePurchase(p)
    await d.store.deleteReplyKey(leg.replyKeyId)
    return
  }
  const sleep = d.sleep ?? realSleep
  let answer = await d.api.release(depositId, leg.replyPublicKey, p.escrow)
  for (let i = 1; i < RELEASE_TRIES && chainCatchingUp(answer); i++) {
    await sleep(i === 1 ? RELEASE_FIRST_PAUSE_MS : RELEASE_PAUSE_MS * (i - 1))
    answer = await d.api.release(depositId, leg.replyPublicKey, p.escrow)
  }
  if (answer.status !== 200) throw new Error(releaseTrouble(answer))
  const { reply, payload } = answer.body
  const expected = replyPayload(d.config.chainId, depositId, p.escrow, leg.manifest)
  if (typeof reply !== 'string' || payload !== expected) throw new Error('The card came back keyed to another purchase.')

  const secretKey = await d.store.replyKey(leg.replyKeyId)
  if (secretKey === null) throw new Error('This phone no longer has the key for this card.')
  let bytes: Uint8Array | null = null
  try {
    bytes = await openReply(secretKey, reply, expected, d.config.encPub)
    const card = parseCard(bytes)
    if (card === null) throw new Error('The card came back in a shape this phone does not read.')
    const m = parseEscrowManifestV2(leg.manifest, p.escrow)
    const merchant = m === null ? null : escrowMerchantById(m.merchant)
    if (m === null || merchant === null) throw new Error('The card is for a store this phone does not know.')
    const meta: Omit<CardRecordV2, 'box'> = {
      id: cardId,
      escrow: p.escrow,
      depositId,
      listingId: leg.listingId,
      merchant: merchant.name,
      // What this card covers at the till: the cents this purchase uses on it.
      valueCents: leg.usedCents,
      priceUnits: Number(leg.amountUnits),
      scanOrder: leg.scanOrder,
      ofCards: p.legs.length,
      last4: card.cardNumber.slice(-4),
      boughtAt: p.createdAt,
      mode: m.mode,
      escrowVersion: 2,
      usedCents: leg.usedCents,
      leftCents: leg.leftCents,
      remainingCents: leg.remainingCents,
    }
    await d.store.saveCard(meta, card)
    proofOf(secretKey)
  } finally {
    secretKey.fill(0)
    bytes?.fill(0)
  }
  leg.released = true
  await d.book.savePurchase(p)
  await d.store.deleteReplyKey(leg.replyKeyId)
}

/** Carry on a V2 purchase this phone kept. Safe to call any number of times. */
export async function resumePurchaseV2(d: LoadDepsV2, purchaseId: string, onStep: (s: LoadStep) => void = () => {}): Promise<PurchaseRecordV2> {
  const p = await d.book.purchase(purchaseId)
  if (p === null) throw new LoadRefused('unavailable', 'That purchase is not on this phone.')
  if (p.state === 'failed') {
    const refunded = p.legs.length > 0 && p.legs.every((l) => l.refunded === true)
    throw new LoadRefused(refunded ? 'refunded' : 'not_charged', p.problem ?? 'That purchase did not go through. Nothing was charged.')
  }
  if (p.state === 'signed' && p.raw !== null && p.txHash !== null) {
    const seen = await receiptOnBothHosts(d.access.hosts, p.txHash).catch(() => null)
    if (seen === null) {
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

/** V2 purchases on this phone that are paid, or may be, and not finished. The till offers Finish it for each. */
export async function unfinishedPurchasesV2(book: DeviceBookV2): Promise<PurchaseRecordV2[]> {
  return (await book.purchases()).filter((p) => p.state === 'signed' || p.state === 'paid')
}
