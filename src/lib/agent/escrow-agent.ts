/**
 * An AI agent buying gift cards through SalvoEscrowV2: the standard way.
 *
 * ===========================================================================
 * SALVO NEVER HOLDS THE CARD OR THE MONEY. The card was sealed in the
 * seller's browser to the escrow template's key; only a run of that template
 * inside Lit can open it, and only for a purchase the chain shows. The agent
 * pays the escrow contract from its own wallet, not Salvo, and the card comes
 * back sealed to a key the agent made a moment before. Salvo's server only
 * plans which cards fit the cart and relays the template's answers. It cannot
 * read a card, and a breach of it yields ciphertext.
 *
 * It is the till's own flow (src/lib/escrow/client/load-v2.ts), run by a
 * plain key instead of a phone's access key, the way the escrow's runbook
 * smoke buys (runbook/smoke-v2.ts). Every check the phone makes before money
 * moves is made here too, with the phone's own functions:
 *   1. the quote (quoteProblemsV2): each card a V2 listing on the pinned
 *      escrow, at this store, priced as the contract prices it;
 *   2. the chain (chainQuoteProblemsV2): each listing for sale in exactly the
 *      state the quote priced, read on both hosts at one finalized block;
 *   3. each ticket (ticketProblemsPhoneV2): this buyer, this key, this card,
 *      signed by the pinned template identity;
 *   4. the cards (cardProblemsV2): the contract would sell each one now.
 * Then: approve the escrow for exactly what it will pull, one depositAndOpen
 * per card, and ask for each card back.
 * ===========================================================================
 *
 * Node. Never logs or returns a key. The card is returned to the caller,
 * which decides where it goes; nothing here prints it.
 */

import { encodeFunctionData, keccak256, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { createReplyKey, type ReplyKey } from '@/lib/vault/lit/envelope-crypto'
import { ESCROW_V2_ABI } from '@/lib/escrow/artifact-v2'
import { replyPayload } from '@/lib/escrow/hashes'
import { parseEscrowManifestV2, type EscrowManifestV2 } from '@/lib/escrow/manifest-v2'
import type { EscrowMerchantName } from '@/lib/escrow/merchants'
import { quoteProblemsV2, type QuoteLegV2, type QuoteV2 } from '@/lib/escrow/quote-v2'
import { escrowEventsV2 } from '@/lib/escrow/runbook/reads-v2'
import { agreedFinalizedBlock, sendSigned, signTransaction, waitForFinal, type HostsConfig } from '@/lib/escrow/runbook/rpc'
import type { TicketViewV2 } from '@/lib/escrow/runbook/smoke-v2'
import type { UseQuoteV2 } from '@/lib/escrow/terms-v2'
import { EscrowApiV2, parseQuoteV2, parseTicketV2, type EscrowPublicConfigV2 } from '@/lib/escrow/client/api-v2'
import { sentenceOf } from '@/lib/escrow/client/api'
import { cardProblemsV2, chainQuoteProblemsV2, loadCallsV2, ticketProblemsPhoneV2 } from '@/lib/escrow/client/load-v2'
import { sealListingV2 } from '@/lib/escrow/client/sell-v2'
import type { ChainAccess } from '@/lib/escrow/client/wallet'

const RELEASE_TRIES = 8
const lower = (s: string): Hex => s.toLowerCase() as Hex
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The purchase did not happen, or stopped. `paid` says whether money may have moved. */
export class EscrowBuyStopped extends Error {
  readonly paid: boolean
  constructor(sentence: string, paid = false) {
    super(sentence)
    this.name = 'EscrowBuyStopped'
    this.paid = paid
  }
}

export interface EscrowAgentDeps {
  /** Salvo's origin, e.g. https://salvoapp.xyz. */
  base: string
  account: PrivateKeyAccount
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Each step as it starts, for a log. */
  onStep?: (step: string) => void
}

/** Our escrow API, on `base`, with a plain fetch: no browser, no cookies. */
function apiOf(d: EscrowAgentDeps): EscrowApiV2 {
  const f = d.fetchImpl ?? fetch
  const base = d.base.replace(/\/$/, '')
  return new EscrowApiV2((input, init) => f(`${base}${String(input)}`, init))
}

/**
 * The escrow's public facts, held to this build's own pins (escrow-pins.ts):
 * a server that names another escrow, signer or sealing key is refused before
 * anything is asked of it.
 */
export async function escrowConfig(d: EscrowAgentDeps): Promise<{ api: EscrowApiV2; config: EscrowPublicConfigV2; access: ChainAccess }> {
  const api = apiOf(d)
  const c = await api.config()
  if (c.state !== 'ready') throw new EscrowBuyStopped(`The escrow is not open on ${d.base} (${c.state}). Nothing was charged.`)
  const hosts: HostsConfig = { urls: c.config.rpcUrls }
  return { api, config: c.config, access: { hosts, sponsorUrl: null } }
}

/** One plain transaction from the agent's key, waited for until final on both hosts. */
async function send(access: ChainAccess, account: PrivateKeyAccount, to: Hex, data: Hex): Promise<{ hash: Hex; receipt: Awaited<ReturnType<typeof waitForFinal>>['receipt'] }> {
  const signed = await signTransaction(access.hosts, account, { to, data })
  await sendSigned(access.hosts, signed)
  const final = await waitForFinal(access.hosts, signed.hash)
  return { hash: signed.hash, receipt: final.receipt }
}

export interface EscrowCard {
  depositId: string
  listingId: Hex
  /** The cents of this card the purchase uses. */
  usedCents: number
  /** What the seller is paid for it, in token units (6 decimals). */
  amountUnits: number
  cardNumber: string
  pin: string | null
}

export interface EscrowPurchase {
  quote: QuoteV2
  /** The approve, then one depositAndOpen per card. */
  transactions: Hex[]
  cards: EscrowCard[]
  /** Milliseconds: the quote, and from the first transaction sent to the last card open. */
  quoteMs: number
  buyMs: number
}

/**
 * Buy cards for `totalCents` at `merchant` through the escrow. The agent's
 * wallet pays the escrow contract directly. Returns the cards, opened with
 * the agent's own one-time keys.
 */
export async function buyThroughEscrow(
  d: EscrowAgentDeps,
  ask: { merchant: EscrowMerchantName; totalCents: number; maxCards?: 1 | 2 | 3 | 4 | 5 },
): Promise<EscrowPurchase> {
  const step = d.onStep ?? (() => {})
  const sleep = d.sleep ?? realSleep
  const depositor = lower(d.account.address)
  const { api, config, access } = await escrowConfig(d)

  // 1. The quote: the planner holds the cards for this wallet for two minutes.
  step('quote')
  const t0 = Date.now()
  const qa = await api.quote(ask.merchant, ask.totalCents, depositor, { mode: 'most_savings', maxCards: ask.maxCards ?? 5 })
  const quoteMs = Date.now() - t0
  if (qa.status !== 200) throw new EscrowBuyStopped(`${sentenceOf(qa, 'No quote.')} Nothing was charged.`)
  const quote = parseQuoteV2(qa.body.quote)
  if (quote === null) throw new EscrowBuyStopped('The quote came back in a shape this agent does not read. Nothing was charged.')
  const qp = quoteProblemsV2(quote, { merchant: ask.merchant, totalCents: ask.totalCents, depositor }, config.escrow)
  if (qp.length > 0) throw new EscrowBuyStopped(`The quote does not hold: ${qp.join('; ')}. Nothing was charged.`)

  // 2. The chain, at one finalized block on both hosts.
  step('chain')
  const chain = await chainQuoteProblemsV2(access, config, quote.legs, depositor)
  if (chain.problems.length > 0) throw new EscrowBuyStopped(`The chain does not match the quote: ${chain.problems.join('; ')}. Nothing was charged.`)

  // 3. A ticket per card, each for a reply key made here and kept only here.
  step('tickets')
  const legs: Array<{ manifest: EscrowManifestV2; leg: QuoteLegV2; ticket: TicketViewV2; use: UseQuoteV2; reply: ReturnType<typeof createReplyKey> }> = []
  for (const [i, leg] of quote.legs.entries()) {
    const manifest = parseEscrowManifestV2(leg.manifest, config.escrow)
    const use = chain.chain[i]?.use
    if (manifest === null || use === undefined) throw new EscrowBuyStopped('A card in the quote is not one this agent can check. Nothing was charged.')
    const reply = createReplyKey()
    const replyKeyHash = keccak256(reply.publicKey as Hex)
    const ta = await api.ticket(leg.intentId, depositor, replyKeyHash)
    if (ta.status !== 200) throw new EscrowBuyStopped(`${sentenceOf(ta, 'No ticket.')} Nothing was charged.`)
    const ticket = parseTicketV2(ta.body)
    if (ticket === null) throw new EscrowBuyStopped('A ticket came back in a shape this agent does not read. Nothing was charged.')
    const tp = await ticketProblemsPhoneV2(ticket, {
      listingId: leg.listingId,
      depositor,
      replyKeyHash,
      identity: config.identity,
      escrow: config.escrow,
      chainId: config.chainId,
      manifest,
      remainingCents: leg.remainingCents,
      sales: leg.sales,
      bondDeposit: BigInt(leg.bondDeposit),
      chainTime: Number(chain.block.timestamp),
      maxTtlSeconds: config.limits.maxTicketTtlSeconds,
    })
    if (tp.length > 0) throw new EscrowBuyStopped(`A ticket does not hold: ${tp.join('; ')}. Nothing was charged.`)
    legs.push({ manifest, leg, ticket: ticket.ticket, use, reply })
  }

  // 4. Would the contract sell each card now?
  const cp = await cardProblemsV2(access, config, legs)
  if (cp.length > 0) throw new EscrowBuyStopped(`The escrow would refuse: ${cp.join('; ')}. Nothing was charged.`)

  // 5. Pay the escrow: approve exactly what it pulls, then one depositAndOpen per card.
  step('pay')
  const t1 = Date.now()
  const calls = loadCallsV2(config, legs)
  const transactions: Hex[] = []
  const opened = new Map<string, bigint>()
  for (const [i, call] of calls.entries()) {
    let sent: Awaited<ReturnType<typeof send>>
    try {
      sent = await send(access, d.account, call.to, call.data)
    } catch (err) {
      throw new EscrowBuyStopped(`A transaction did not go through (${err instanceof Error ? err.message.slice(0, 120) : 'no answer'}).`, i > 0)
    }
    transactions.push(sent.hash)
    if (sent.receipt.status !== 'success') throw new EscrowBuyStopped(`A transaction reverted on chain: ${sent.hash}.`, i > 0)
    for (const ev of escrowEventsV2(sent.receipt, config.escrow, 'Opened')) {
      if (lower(ev.depositor) === depositor) opened.set(lower(ev.listingId), ev.depositId)
    }
  }

  // 6. Each card back from the template, sealed to its own reply key.
  step('open')
  const cards: EscrowCard[] = []
  for (const l of legs) {
    const depositId = opened.get(lower(l.leg.listingId))
    if (depositId === undefined) throw new EscrowBuyStopped(`Paid, but the chain shows no purchase of card ${l.leg.listingId}. Transactions: ${transactions.join(', ')}.`, true)
    const id = depositId.toString()
    const expected = replyPayload(config.chainId, id, config.escrow, l.leg.manifest)
    const card = await releaseCardV2(api, config, id, l.reply, (payload) => payload === expected, sleep)
    cards.push({ depositId: id, listingId: l.leg.listingId, usedCents: l.leg.usedCents, amountUnits: l.leg.amountUnits, ...card })
  }
  return { quote, transactions, cards, quoteMs, buyMs: Date.now() - t1 }
}

/**
 * Ask the template for one paid card, sealed to `reply`, and open it here.
 * The release is asked again while the template does not see the purchase
 * yet. `payloadOk` says whether the payload the reply is keyed to names this
 * purchase: a reply keyed to anything else is refused, never opened. Shared
 * by the direct buy above and the order client (orders/client.ts), which
 * knows the deposit but not the listing's manifest. Throws EscrowBuyStopped
 * (paid) on anything but a card.
 */
export async function releaseCardV2(
  api: EscrowApiV2,
  config: Pick<EscrowPublicConfigV2, 'escrow' | 'encPub'>,
  depositId: string,
  reply: ReplyKey,
  payloadOk: (payload: string) => boolean,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<{ cardNumber: string; pin: string | null }> {
  let answer = await api.release(depositId, reply.publicKey as Hex, config.escrow)
  for (let i = 1; i < RELEASE_TRIES && (answer.status === 409 || (answer.status === 404 && answer.body.error === 'no_purchase')); i++) {
    await sleep(Math.min(600 * i, 3_000))
    answer = await api.release(depositId, reply.publicKey as Hex, config.escrow)
  }
  if (answer.status !== 200) throw new EscrowBuyStopped(`Paid (deposit ${depositId}), but the card did not come back: ${sentenceOf(answer, 'no answer')}. Ask again with the same key.`, true)
  const { reply: sealed, payload } = answer.body
  if (typeof sealed !== 'string' || typeof payload !== 'string' || !payloadOk(payload)) throw new EscrowBuyStopped(`Paid (deposit ${depositId}), but the card came back keyed to another purchase.`, true)
  let plain: Buffer
  try {
    plain = reply.open(sealed, payload, config.encPub)
  } catch {
    throw new EscrowBuyStopped(`Paid (deposit ${depositId}), but the card did not open with this key.`, true)
  }
  try {
    const c = JSON.parse(plain.toString('utf8')) as Record<string, unknown>
    if (typeof c.cardNumber !== 'string' || (c.pin !== null && typeof c.pin !== 'string')) throw new Error('shape')
    return { cardNumber: c.cardNumber, pin: c.pin as string | null }
  } catch {
    throw new EscrowBuyStopped(`Paid (deposit ${depositId}), but the card came back in a shape this agent does not read.`, true)
  } finally {
    plain.fill(0)
  }
}

/**
 * List one card on SalvoEscrowV2 from a plain seller key, as the Sell page
 * does in a browser (sell-v2.ts): sealed here to the template's key, so the
 * card never reaches our server. For test cards; the seller must be on the
 * server's test list (ESCROW_SELLER_ALLOWLIST).
 */
export async function listOnEscrow(
  d: EscrowAgentDeps,
  card: { merchant: EscrowMerchantName; cardNumber: string; pin: string | null; valueCents: number; priceCents: number },
): Promise<{ listingId: Hex; txHash: Hex }> {
  const { api, config, access } = await escrowConfig(d)
  if (!config.listingOpen) throw new EscrowBuyStopped('The escrow is not taking listings. Nothing was listed.')
  const block = await agreedFinalizedBlock(access.hosts)
  const seller = lower(d.account.address)
  const sealed = await sealListingV2(config, seller, { merchant: card.merchant, cardNumber: card.cardNumber, pin: card.pin, valueCents: card.valueCents, priceCents: card.priceCents }, Number(block.timestamp))
  const data = encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'list', args: [sealed.commitment] })
  const signed = await signTransaction(access.hosts, d.account, { to: config.escrow, data })
  // Asked first, with nothing sent: a refusal costs the seller nothing.
  const first = await api.listing(sealed.manifest, sealed.envelope, signed.hash, sealed.cardFingerprint)
  if (!(first.status === 409 && first.body.error === 'not_on_chain_yet') && first.status !== 200 && first.status !== 201) {
    throw new EscrowBuyStopped(`${sentenceOf(first, 'Salvo will not take that listing.')} Nothing was listed.`)
  }
  await sendSigned(access.hosts, signed)
  const final = await waitForFinal(access.hosts, signed.hash)
  if (final.receipt.status !== 'success') throw new EscrowBuyStopped(`The listing reverted on chain: ${signed.hash}.`)
  for (let i = 0; i < 6; i++) {
    const a = await api.listing(sealed.manifest, sealed.envelope, signed.hash, sealed.cardFingerprint)
    if (a.status === 200 || a.status === 201) return { listingId: sealed.listingId, txHash: signed.hash }
    if (!(a.status === 409 && a.body.error === 'not_on_chain_yet')) throw new EscrowBuyStopped(`Listed on chain (${signed.hash}) but Salvo did not record it: ${sentenceOf(a, 'no answer')}.`)
    await (d.sleep ?? realSleep)(1_500)
  }
  throw new EscrowBuyStopped(`Listed on chain (${signed.hash}) but Salvo has not seen it yet. Post it again later.`)
}
