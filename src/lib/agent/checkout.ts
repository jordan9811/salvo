/**
 * Salvo as an endpoint agents call: quote, then buy over MPP.
 *
 * An agent asks for a quote for its cart at a store. Salvo answers with whole
 * gift cards that cover as much of the cart as they can, at a discount, or
 * with nothing. The agent pays the quoted price in USDC over MPP on Tempo,
 * gets the card numbers, applies them at the store's checkout (in the user's
 * own account), and pays any remainder its usual way.
 *
 * THE RULES, each one load-bearing:
 *
 *  - WHOLE CARDS ONLY. A card handed to an agent is a bearer instrument with
 *    its full balance on it. Selling part of one would hand over value nobody
 *    paid for, and online the leftover then sits in the buyer's store account
 *    (Target locks a card to the first account that adds it). So every card
 *    is sold whole, and what the cards don't cover is the agent's remainder.
 *  - A REAL DISCOUNT OR NO QUOTE. A card is only offered if it costs less than
 *    it's worth, and a quote with no saving is refused. An endpoint that is
 *    only chosen when it wins cannot lose.
 *  - ONLY CARDS SALVO CAN OPEN. Local envelope seals bound to the listing, not
 *    to an order, so any matched order can open them. Lit seals and
 *    order-bound seals are left out.
 *  - BEFORE THE HAND-OVER, ANY FAILURE REFUNDS. A card taken by someone else,
 *    or a seal that will not open, returns the payment automatically.
 *  - AFTER THE HAND-OVER, A PERSON DECIDES. Once an agent holds the numbers,
 *    an automatic refund on its say-so would let it spend the cards and get
 *    its money back. A report pages the operator with everything needed.
 *
 * Testnet only: the route refuses on a live network (gift card resale with
 * real money waits on review).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Intent, Order } from '@prisma/client'
import { prisma } from '../db'
import type { Tx } from '../db'
import { env } from '../env'
import { createPaidOrders, transitionOrder, type CreatePaidOrderInput } from '../orders'
import { legCostCents } from '../route/plan'
import { discountBps } from '../intent/types'
import { matchIntentsTogether, parseSecretRef, transitionIntent } from '../intent/service'
import { refundOrder } from '../reconcile'
import { pushOperator } from '../notify'
import { LocalEnvelopeVault } from '../vault/envelope'
import type { SecretVault } from '../vault/types'
import { partialInBuyerAccount, storePolicy } from './stores'
import {
  AGENT_ORDER,
  DEPOSIT,
  LEFTOVER,
  REMAINDER,
  REMAINDER_OF,
  decodeAgentRemainder,
  decodeLeftover,
  decodeRemainderOf,
  leftoverMarker,
  remainderMarker,
  remainderOfReason,
} from './markers'
import { claimMoneyMove, claimMoneyMoveWith, moneyClaimId, pageOnce, returnMarkersSince, sendBackOnce } from './money'
import { paymentToUs } from './chain'

/** Target takes up to 10 gift cards per order. */
export const AGENT_MAX_CARDS = 10
/** Online cards: a number and an access number, entered at checkout. */
export const AGENT_FORM_FACTOR = 'bearer'
/** How long a quote's price holds. Supply is live, so short. */
export const AGENT_QUOTE_TTL_MS = 2 * 60_000
/** Carts above this are refused: an agent should not move this much in one call on a test rail. */
export const AGENT_MAX_CART_CENTS = 200_000
/** No real email on an agent order. A reserved domain, so nothing is ever sent to it. */
const AGENT_BUYER_EMAIL = AGENT_ORDER.buyerEmail

export interface AgentCard {
  intentId: string
  last4: string
  /** The card's balance. */
  valueCents: number
  /** What the agent pays Salvo for the part it uses. */
  costCents: number
  /** What this card covers at checkout: its whole balance, or less on the one part-used card. */
  applyCents: number
  /** What stays on the card afterwards. 0 on a whole card. */
  leftoverCents: number
  /** Refundable deposit for that leftover, at face. 0 on a whole card. */
  depositCents: number
}

export interface AgentQuote {
  kind: 'quote'
  merchantId: string
  cartTotalCents: number
  /** What the cards cover at checkout. */
  coveredCents: number
  /** What the agent pays Salvo for the value it uses. */
  priceCents: number
  /** Refundable deposits for leftovers on part-used cards. Charged with the price. */
  depositCents: number
  savingCents: number
  discountBps: number
  /** What the agent still pays the store its usual way. */
  remainderCents: number
  cards: AgentCard[]
  /** Why partial use was not offered, when the agent asked for it. */
  partialNote: string | null
  expiresAt: Date
}

/** Everything the agent is charged: the price plus any deposits. */
export function chargeCents(q: Pick<AgentQuote, 'priceCents' | 'depositCents'>): number {
  return q.priceCents + q.depositCents
}

/** The largest leftover Salvo takes a deposit for. Bigger ones are not sold in part. */
export const AGENT_MAX_LEFTOVER_CENTS = 5_000

export interface AgentNoQuote {
  kind: 'no_quote'
  reason: string
}

export class AgentPurchaseError extends Error {
  constructor(
    readonly code: 'no_quote' | 'price_changed' | 'not_created' | 'already_processed' | 'taken_refunded' | 'open_failed_refunded' | 'create_failed_refunded' | 'refund_failed',
    message: string,
  ) {
    super(message)
    this.name = 'AgentPurchaseError'
  }
}

/**
 * Whole cards whose balances sum as close to the cart total as possible
 * without going over, at most `maxCards`. Largest first, then any smaller card
 * that still fits. Pure, so the rule can be tested on its own.
 */
export function planWholeCards<T extends { balanceCents: number }>(cartTotalCents: number, cards: readonly T[], maxCards: number = AGENT_MAX_CARDS): T[] {
  const picked: T[] = []
  let sum = 0
  for (const c of [...cards].sort((a, b) => b.balanceCents - a.balanceCents)) {
    if (picked.length >= maxCards) break
    if (c.balanceCents <= 0) continue
    if (sum + c.balanceCents <= cartTotalCents) {
      picked.push(c)
      sum += c.balanceCents
    }
  }
  return picked
}

/** A seal Salvo itself can open for any matched order: local envelope, bound to the listing. */
export function openableByUs(intent: Pick<Intent, 'sealedRef'>): boolean {
  try {
    const ref = parseSecretRef(intent.sealedRef)
    return ref.lit === undefined && ref.boundOrderId === null
  } catch {
    return false
  }
}

/**
 * One card to cover what the whole cards left, used in part: the smallest
 * card bigger than the gap whose leftover stays under the deposit cap and
 * which is still a discount for the part used. Pure.
 */
export function planPartialCard<T extends { balanceCents: number; costFor: (cents: number) => number }>(
  gapCents: number,
  unpicked: readonly T[],
  maxLeftoverCents: number = AGENT_MAX_LEFTOVER_CENTS,
): { card: T; applyCents: number; leftoverCents: number; costCents: number } | null {
  if (gapCents <= 0) return null
  const fits = unpicked
    .filter((c) => c.balanceCents > gapCents && c.balanceCents - gapCents <= maxLeftoverCents && c.costFor(gapCents) < gapCents)
    .sort((a, b) => a.balanceCents - b.balanceCents)
  const card = fits[0]
  if (!card) return null
  return { card, applyCents: gapCents, leftoverCents: card.balanceCents - gapCents, costCents: card.costFor(gapCents) }
}

/**
 * Quote a cart at a store. A read: nothing is reserved, and the first to pay wins.
 *
 * `allowPartial`: the agent accepts one part-used card with a refundable
 * deposit for its leftover, so the cards can cover the whole cart. Offered
 * only where the store's rules let a leftover stay sellable when the agent
 * checks out in the buyer's own account (stores.ts partialInBuyerAccount).
 */
export async function agentQuote(req: { merchantId: string; cartTotalCents: number; allowPartial?: boolean; now?: Date }): Promise<AgentQuote | AgentNoQuote> {
  const now = req.now ?? new Date()
  const merchantId = req.merchantId.toLowerCase().trim()
  const policy = storePolicy(merchantId)
  const maxCards = Math.min(policy.maxCardsPerOrder, AGENT_MAX_CARDS)
  if (!Number.isInteger(req.cartTotalCents) || req.cartTotalCents <= 0) {
    return { kind: 'no_quote', reason: 'cartTotalCents must be a positive whole number of cents' }
  }
  if (req.cartTotalCents > AGENT_MAX_CART_CENTS) {
    return { kind: 'no_quote', reason: `carts over $${AGENT_MAX_CART_CENTS / 100} are not quoted` }
  }

  const live = await prisma.intent.findMany({
    where: {
      state: 'offered',
      merchantId,
      formFactor: AGENT_FORM_FACTOR,
      expiresAt: { gt: new Date(now.getTime() + agentMinSupplyLeftMs()) },
    },
    orderBy: [{ expiresAt: 'asc' }],
    take: 200,
  })

  const candidates = live
    .filter(openableByUs)
    .map((i) => {
      const balanceCents = i.lastKnownBalanceCents ?? i.faceValueCents
      const costFor = (cents: number): number => legCostCents(cents, i.priceCents, i.faceValueCents)
      return { intent: i, balanceCents, costCents: costFor(balanceCents), costFor }
    })
    // Only cards that are themselves a discount.
    .filter((c) => c.balanceCents > 0 && c.costCents < c.balanceCents)

  if (candidates.length === 0) return { kind: 'no_quote', reason: `no discounted online cards at ${merchantId} right now` }

  const picked = planWholeCards(req.cartTotalCents, candidates, maxCards)
  const cards: AgentCard[] = picked.map((c) => ({
    intentId: c.intent.id,
    last4: c.intent.last4,
    valueCents: c.balanceCents,
    costCents: c.costCents,
    applyCents: c.balanceCents,
    leftoverCents: 0,
    depositCents: 0,
  }))

  // One part-used card for the gap, when the agent asked and the store allows it.
  let partialNote: string | null = null
  const gap = req.cartTotalCents - cards.reduce((s, c) => s + c.applyCents, 0)
  if (req.allowPartial === true && gap > 0) {
    if (!partialInBuyerAccount(policy)) {
      partialNote = policy.locksToAccount
        ? `${merchantId} ties a card to the account that adds it, so the leftover would stay with the buyer: whole cards only here`
        : `${merchantId}'s gift card rules are unchecked: whole cards only here`
    } else if (cards.length >= maxCards) {
      partialNote = `${merchantId} takes at most ${maxCards} cards per order`
    } else {
      const taken = new Set(cards.map((c) => c.intentId))
      // A relisted leftover is sold whole only: its deposit is proved by its whole value.
      const part = planPartialCard(gap, candidates.filter((c) => !taken.has(c.intent.id) && decodeAgentRemainder(c.intent.failureReason) === null))
      if (part === null) {
        partialNote = 'no card fits the gap with a leftover under the deposit cap'
      } else {
        cards.push({
          intentId: part.card.intent.id,
          last4: part.card.intent.last4,
          valueCents: part.card.balanceCents,
          costCents: part.costCents,
          applyCents: part.applyCents,
          leftoverCents: part.leftoverCents,
          depositCents: part.leftoverCents,
        })
      }
    }
  }

  if (cards.length === 0) {
    return { kind: 'no_quote', reason: `every card at ${merchantId} is worth more than the cart; no whole card fits${partialNote ? ` (${partialNote})` : ''}` }
  }

  const coveredCents = cards.reduce((s, c) => s + c.applyCents, 0)
  const priceCents = cards.reduce((s, c) => s + c.costCents, 0)
  if (priceCents >= coveredCents) return { kind: 'no_quote', reason: 'no saving on the cards available' }

  return {
    kind: 'quote',
    merchantId,
    cartTotalCents: req.cartTotalCents,
    coveredCents,
    priceCents,
    depositCents: cards.reduce((s, c) => s + c.depositCents, 0),
    savingCents: coveredCents - priceCents,
    discountBps: discountBps(coveredCents, priceCents),
    remainderCents: req.cartTotalCents - coveredCents,
    cards,
    partialNote,
    expiresAt: new Date(now.getTime() + AGENT_QUOTE_TTL_MS),
  }
}

/** Safe to send to an agent: no seller identity. */
export function publicAgentQuote(q: AgentQuote): Record<string, unknown> {
  return {
    merchant: q.merchantId,
    cartTotalCents: q.cartTotalCents,
    coveredCents: q.coveredCents,
    priceCents: q.priceCents,
    depositCents: q.depositCents,
    chargeCents: chargeCents(q),
    savingCents: q.savingCents,
    discountBps: q.discountBps,
    remainderCents: q.remainderCents,
    cards: q.cards.map((c) => ({
      last4: c.last4,
      valueCents: c.valueCents,
      costCents: c.costCents,
      applyCents: c.applyCents,
      leftoverCents: c.leftoverCents,
      depositCents: c.depositCents,
    })),
    ...(q.partialNote === null ? {} : { partialNote: q.partialNote }),
    expiresAt: q.expiresAt.toISOString(),
  }
}

// --- the purchase token ------------------------------------------------------

/**
 * Proof that its holder paid for these orders: their ids and the paying
 * address, signed. Lets the agent fetch its cards again, confirm, or report,
 * with nothing stored on our side.
 */
export function purchaseToken(orderIds: readonly string[], payer: string, secret: string): string {
  const body = Buffer.from(JSON.stringify({ o: orderIds, p: payer.toLowerCase() })).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

export function readPurchaseToken(token: string, secret: string): { orderIds: string[]; payer: string } | null {
  const [body, mac] = token.split('.')
  if (!body || !mac) return null
  const want = createHmac('sha256', secret).update(body).digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(want)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { o?: unknown; p?: unknown }
    if (!Array.isArray(v.o) || !v.o.every((x) => typeof x === 'string') || typeof v.p !== 'string') return null
    return { orderIds: v.o as string[], payer: v.p }
  } catch {
    return null
  }
}

// --- the purchase ------------------------------------------------------------

export interface DeliveredCard {
  orderId: string
  last4: string
  cardNumber: string
  accessNumber: string | null
  /** What to apply from this card. Its whole balance, except on the one part-used card. */
  applyCents: number
  /** What must stay on the card. Report it at confirm to get the deposit back. */
  leftoverCents: number
}

export interface AgentPurchase {
  orderIds: string[]
  token: string
  priceCents: number
  depositCents: number
  coveredCents: number
  remainderCents: number
  cards: DeliveredCard[]
}

/**
 * How long an agent order may sit `paid` before the reconcile sweep refunds it.
 * The hand-over takes seconds, so this only matters after a crash between
 * payment and hand-over: the sweep returns the price within about this long.
 * Past the sweep's lead time, so no order is born already due.
 */
export function agentOrderDeadlineMs(): number {
  return (env().REFUND_LEAD_MINUTES + 30) * 60_000
}

/** A card must stay openable past the order deadline, with an hour to spare. */
export function agentMinSupplyLeftMs(): number {
  return agentOrderDeadlineMs() + 60 * 60_000
}

async function depositEvent(orderId: string, text: string, db: Tx = prisma): Promise<void> {
  await db.orderEvent.create({ data: { orderId, fromState: 'fulfilled', toState: 'fulfilled', actor: 'worker', reason: `${DEPOSIT}|${text}`.slice(0, 1000) } })
}

/** Open each card for its matched order. Throws on the first that will not open. */
async function openCards(
  orders: readonly Order[],
  intents: readonly Intent[],
  amounts: readonly { applyCents: number; leftoverCents: number }[],
  vault: SecretVault,
  now: Date,
): Promise<DeliveredCard[]> {
  const out: DeliveredCard[] = []
  for (const [i, intent] of intents.entries()) {
    const order = orders[i]
    const amount = amounts[i]
    if (!order || !amount) throw new Error('order missing for a card')
    const secret = await vault.unseal(parseSecretRef(intent.sealedRef), { intentId: intent.id, orderId: order.id, escrowFunded: true, matched: true, now })
    const { cardNumber, pin } = secret.reveal()
    out.push({ orderId: order.id, last4: intent.last4, cardNumber, accessNumber: pin ?? null, applyCents: amount.applyCents, leftoverCents: amount.leftoverCents })
  }
  return out
}

/**
 * NOTHING WAS HANDED OVER: put the cards back on sale and return the money.
 * Each card goes back to `offered` with the marker it had (a relisted
 * leftover keeps its deposit behind it). Each order is refunded through the
 * one refund path; deposits go back under a claim. Always throws.
 */
async function unwind(
  input: { orders: readonly Order[]; intents: readonly Intent[]; payer: string; paymentRef: string; depositCents: number; now: Date },
  code: 'taken_refunded' | 'open_failed_refunded' | 'create_failed_refunded',
  reason: string,
): Promise<never> {
  // If anything was handed over after all (the hand-over committed, then the
  // connection dropped), the agent may hold cards: change nothing, page.
  const states = await prisma.order.findMany({ where: { id: { in: input.orders.map((o) => o.id) } }, select: { id: true, state: true } })
  if (states.some((o) => o.state === 'fulfilled' || o.state === 'fulfilling')) {
    await pushOperator({
      title: '[ACTION NEEDED] agent purchase failed around its hand-over',
      message: [reason, `payment: ${input.paymentRef}`, `payer: ${input.payer}`, `orders: ${states.map((o) => `${o.id}=${o.state}`).join(', ')}`, 'Some orders are fulfilled: the agent may hold the cards. Check before moving any money.'].join(String.fromCharCode(10)),
      priority: 5,
      tags: ['rotating_light'],
    }).catch(() => undefined)
    throw new AgentPurchaseError('refund_failed', `${reason}. Part of the purchase may have gone through, so nothing was refunded automatically. The operator has been paged to check it.`)
  }
  for (const [k, i] of input.intents.entries()) {
    const order = input.orders[k]
    if (!order) continue
    await prisma.intent.updateMany({
      where: { id: i.id, matchedOrderId: order.id, state: { in: ['matched', 'executing'] }, formFactor: AGENT_FORM_FACTOR },
      data: { state: 'offered', matchedOrderId: null, failureReason: i.failureReason },
    })
  }
  let ok = true
  for (const o of input.orders) {
    const fresh = await prisma.order.findUnique({ where: { id: o.id } })
    if (!fresh || fresh.state === 'refunded') continue
    const out = await refundOrder(fresh, reason, input.now)
    if (!out.refunded) ok = false
  }
  const dep = await sendBackOnce('deposit-back', input.paymentRef, input.payer, input.depositCents, reason)
  if (dep.status === 'failed') ok = false
  if (!ok) {
    await pushOperator({
      title: '[ACTION NEEDED] agent purchase refund incomplete',
      message: [reason, `payment: ${input.paymentRef}`, `payer: ${input.payer}`, `deposit: ${input.depositCents}c`, 'Nothing was handed over. Return what is still owed by hand.'].join(String.fromCharCode(10)),
      priority: 5,
      tags: ['rotating_light'],
    }).catch(() => undefined)
    throw new AgentPurchaseError('refund_failed', `${reason}. Nothing was handed over, and the automatic refund failed. The operator has been paged to return your payment by hand.`)
  }
  throw new AgentPurchaseError(
    code,
    code === 'taken_refunded'
      ? 'Someone took one of those cards first. Your payment has been returned. Quote again.'
      : code === 'create_failed_refunded'
        ? 'The purchase could not be recorded, so nothing was handed over and your payment has been returned.'
        : 'A card could not be opened, so nothing was handed over and your payment has been returned.',
  )
}

/**
 * The agent has paid `chargeCents(quote)` (MPP receipt `paymentRef`, from
 * `payer`). Re-check the cards, make the orders, take and open the cards, and
 * hand them over in one transaction.
 *
 *   Before step 2 (AgentPurchaseError price_changed or not_created): no order
 *   exists; the route returns the whole charge.
 *   already_processed: this payment already made a purchase (a replayed
 *   credential); nothing moves.
 *   Steps 3 and 4 failing: unwind() returns everything, cards back on sale.
 *   After step 5: the cards are the agent's. Nothing refunds automatically.
 */
export async function deliverAgentPurchase(input: {
  quote: AgentQuote
  paymentRef: string
  payer: string
  tokenSecret: string
  vault?: SecretVault
  now?: Date
}): Promise<AgentPurchase> {
  const now = input.now ?? new Date()
  const vault = input.vault ?? new LocalEnvelopeVault()
  const { quote } = input
  const payer = input.payer.toLowerCase()

  // 1. Every card exactly as quoted, or no orders at all.
  const intents: Intent[] = []
  for (const c of quote.cards) {
    const i = await prisma.intent.findUnique({ where: { id: c.intentId } })
    const balance = i ? (i.lastKnownBalanceCents ?? i.faceValueCents) : -1
    if (!i || i.state !== 'offered' || i.merchantId !== quote.merchantId || i.formFactor !== AGENT_FORM_FACTOR || balance !== c.valueCents || !openableByUs(i)) {
      throw new AgentPurchaseError('price_changed', 'A card in the quote changed or is gone.')
    }
    intents.push(i)
  }

  // 2. One order per card, with what stands behind it written in the same transaction.
  const deadlineAt = new Date(now.getTime() + agentOrderDeadlineMs())
  const drafts = quote.cards.map((c, i): CreatePaidOrderInput => ({
    intake: { buyerEmail: AGENT_BUYER_EMAIL, theaterName: null, theaterZip: null, theaterSlug: null, film: null, showtimeUtc: null, showtimeUrl: null, qty: 1, priceCents: c.costCents },
    rail: 'mpp',
    paymentRef: input.paymentRef,
    payerAddress: payer,
    idempotencyKey: `${input.paymentRef}:agent:${i}`,
    kind: 'gift_card',
    merchantId: quote.merchantId,
    deadlineAt,
    eventReason: `agent purchase over MPP, card ${i + 1} of ${quote.cards.length}`,
  }))
  let made: Awaited<ReturnType<typeof createPaidOrders>>
  try {
    made = await createPaidOrders(drafts, async (tx, order, i) => {
      const card = quote.cards[i]
      const was = decodeAgentRemainder(intents[i]?.failureReason)
      if (was && card) {
        await tx.orderEvent.create({
          data: { orderId: order.id, fromState: order.state, toState: order.state, actor: 'worker', reason: remainderOfReason({ firstOrderId: was.orderId, depositCents: was.depositCents, payer: was.payer, valueCents: card.valueCents }) },
        })
      }
      if (card && card.depositCents > 0) {
        await tx.orderEvent.create({
          data: { orderId: order.id, fromState: order.state, toState: order.state, actor: 'worker', reason: `${DEPOSIT}|${card.depositCents}|charged|${payer}|${input.paymentRef}` },
        })
      }
    })
  } catch (err) {
    const why = `The orders could not be created (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`
    // The write may have committed and only its answer been lost. Orders that
    // exist would be refunded by the cron on top of a whole-charge return, so
    // they are unwound here instead, and the route returns nothing more.
    const existing = await prisma.order.findMany({ where: { paymentRef: input.paymentRef, buyerEmail: AGENT_BUYER_EMAIL, rail: 'mpp', kind: 'gift_card' }, orderBy: { createdAt: 'asc' } })
    if (existing.length > 0) {
      return unwind({ orders: existing, intents, payer, paymentRef: input.paymentRef, depositCents: quote.depositCents, now }, 'create_failed_refunded', why)
    }
    throw new AgentPurchaseError('not_created', why)
  }
  if (made.some((m) => !m.created)) {
    throw new AgentPurchaseError('already_processed', 'This payment was already used for a purchase. Fetch its cards with your purchase token.')
  }
  const orders = made.map((m) => m.order)
  const back = { orders, intents, payer, paymentRef: input.paymentRef, depositCents: quote.depositCents, now }

  // 3. Take the cards, all together or none.
  try {
    await matchIntentsTogether(orders.map((o, i) => ({ intentId: quote.cards[i]?.intentId ?? '', orderId: o.id })))
  } catch {
    return unwind(back, 'taken_refunded', 'a card was taken by someone else before this agent purchase matched')
  }

  // 4. Claim and open. Nothing has left this process yet.
  let cards: DeliveredCard[]
  try {
    const claimed: Intent[] = []
    for (const i of intents) claimed.push(await transitionIntent(i.id, 'executing', { expect: 'matched' }))
    cards = await openCards(orders, claimed, quote.cards, vault, now)
  } catch (err) {
    return unwind(back, 'open_failed_refunded', `agent purchase: a card could not be opened (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`)
  }

  // 5. THE HAND-OVER, in one transaction: every order fulfilled and every card
  // settled, or none. A whole card is done; a part-used card waits, marked.
  try {
    await prisma.$transaction(async (tx) => {
      for (const o of orders) {
        await transitionOrder(tx, o.id, 'fulfilling', { actor: 'worker', reason: 'agent purchase: opening the cards', expect: 'paid' })
        await transitionOrder(tx, o.id, 'fulfilled', { actor: 'worker', reason: 'agent purchase: card numbers handed to the paying agent', expect: 'fulfilling' })
      }
      for (const [k, i] of intents.entries()) {
        const card = quote.cards[k]
        const order = orders[k]
        if (!card || !order) throw new Error('card missing at the hand-over')
        const moved = await tx.intent.updateMany({
          where: { id: i.id, state: 'executing', matchedOrderId: order.id },
          data: card.leftoverCents > 0 ? { failureReason: leftoverMarker({ orderId: order.id, leftoverCents: card.leftoverCents, depositCents: card.depositCents, payer }) } : { state: 'completed' },
        })
        if (moved.count !== 1) throw new Error(`card ${i.id} moved during the hand-over`)
        if (card.leftoverCents > 0) await depositEvent(order.id, `${card.depositCents}|held|leftover=${card.leftoverCents}|${input.paymentRef}`, tx)
      }
    })
  } catch (err) {
    return unwind(back, 'open_failed_refunded', `agent purchase: the hand-over failed (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`)
  }

  const orderIds = orders.map((o) => o.id)
  return {
    orderIds,
    token: purchaseToken(orderIds, payer, input.tokenSecret),
    priceCents: quote.priceCents,
    depositCents: quote.depositCents,
    coveredCents: quote.coveredCents,
    remainderCents: quote.remainderCents,
    cards,
  }
}

/**
 * The cards of a paid purchase again, for an agent whose first response was
 * lost. A leftover already back on sale is no longer this agent's, so its
 * card is left out; the rest are returned. Null for a bad token, or when no
 * card of the purchase is still the agent's.
 */
export async function redeliverAgentPurchase(token: string, tokenSecret: string, vault: SecretVault = new LocalEnvelopeVault(), now: Date = new Date()): Promise<DeliveredCard[] | null> {
  const t = readPurchaseToken(token, tokenSecret)
  if (t === null) return null
  const orders: Order[] = []
  const intents: Intent[] = []
  const amounts: { applyCents: number; leftoverCents: number }[] = []
  for (const id of t.orderIds) {
    const order = await prisma.order.findUnique({ where: { id } })
    if (!order || order.state !== 'fulfilled' || order.payerAddress?.toLowerCase() !== t.payer) return null
    const intent = await prisma.intent.findFirst({ where: { matchedOrderId: id } })
    if (!intent) continue
    const leftover = decodeLeftover(intent.failureReason)
    const done = intent.state === 'completed'
    const waiting = intent.state === 'executing' && leftover !== null && leftover.orderId === id
    if (!done && !waiting) continue
    const value = intent.lastKnownBalanceCents ?? intent.faceValueCents
    amounts.push(waiting && leftover ? { applyCents: value - leftover.leftoverCents, leftoverCents: leftover.leftoverCents } : { applyCents: value, leftoverCents: 0 })
    orders.push(order)
    intents.push(intent)
  }
  if (orders.length === 0) return null
  return openCards(orders, intents, amounts, vault, now)
}

export interface CardReport {
  /** The order the card was sold under (from the buy response). Preferred over last4. */
  orderId?: string
  last4: string
  /** What the store applied from this card. */
  appliedCents?: number
  /** What the store says is left on it afterwards. */
  remainingCents?: number
}

export type LeftoverOutcome = 'relisted' | 'taken' | 'waiting' | 'held_listing_expiring'
export type DepositOutcome = 'returned' | 'taken' | 'return_failed' | 'held'

export interface ConfirmResult {
  /** This purchase's part-used cards, and what happened to each. */
  leftovers: { last4: string; outcome: LeftoverOutcome }[]
  /** Earlier agents' deposits this purchase settled, by proving their leftover. */
  deposits: { orderId: string; outcome: DepositOutcome }[]
}

/**
 * Record what the agent says the store applied (evidence for settling the
 * sellers), and settle leftovers both ways:
 *
 *  - THIS purchase's part-used card. Reported with at least the leftover still
 *    on it, it goes back on sale on the same row (or, if its listing is too
 *    close to its end to sell again, a person checks it and decides the
 *    deposit). Reported short, the deposit is taken. Not reported: it waits.
 *  - A card THIS purchase bought that was someone's relisted leftover. Applied
 *    in full (its whole value), that leftover was really there: their deposit
 *    goes back. Applied short: a person decides, never a stranger's report.
 *
 * Every deposit decision claims it first (money.ts), so concurrent confirms
 * decide it once. The weak spot, stated: these are agents' own reports; a
 * store whose balance Salvo can read should check it first.
 */
export async function recordAgentConfirmation(
  token: string,
  tokenSecret: string,
  body: { appliedCents?: number; storeOrderNumber?: string; cards?: readonly CardReport[] },
  now: Date = new Date(),
): Promise<ConfirmResult | null> {
  const t = readPurchaseToken(token, tokenSecret)
  if (t === null) return null
  const applied = Number.isInteger(body.appliedCents) ? String(body.appliedCents) : '?'
  const number = typeof body.storeOrderNumber === 'string' ? body.storeOrderNumber.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) : 'unseen'
  const byOrder = new Map((body.cards ?? []).filter((c) => typeof c.orderId === 'string').map((c) => [c.orderId as string, c]))
  const byLast4 = new Map((body.cards ?? []).filter((c) => typeof c.last4 === 'string').map((c) => [c.last4, c]))
  const result: ConfirmResult = { leftovers: [], deposits: [] }

  for (const orderId of t.orderIds) {
    await prisma.orderEvent.create({
      data: { orderId, fromState: 'fulfilled', toState: 'fulfilled', actor: 'worker', reason: `EVIDENCE|buyer_confirmation|applied=${applied}|order=${number}|agent` },
    })

    const intent = await prisma.intent.findFirst({ where: { matchedOrderId: orderId } })
    const report = byOrder.get(orderId) ?? (intent ? byLast4.get(intent.last4) : undefined)

    // This purchase's own part-used card.
    const leftover = intent ? decodeLeftover(intent.failureReason) : null
    if (intent && leftover && leftover.orderId === orderId && intent.state === 'executing') {
      const remaining = report?.remainingCents
      if (typeof remaining !== 'number' || !Number.isInteger(remaining)) {
        result.leftovers.push({ last4: intent.last4, outcome: 'waiting' })
      } else if (remaining >= leftover.leftoverCents) {
        if (intent.expiresAt.getTime() <= now.getTime() + agentMinSupplyLeftMs()) {
          // Too close to expiry to sell again, so no next buyer will prove the
          // leftover. The depositor's own word is not proof: a person checks
          // the balance and decides.
          const done = await prisma.intent.updateMany({ where: { id: intent.id, state: 'executing', failureReason: intent.failureReason }, data: { state: 'completed' } })
          if (done.count === 1) {
            await flagOnce(orderId, leftover.depositCents, 'leftover-expiring', `listing: ${intent.id} (•••• ${intent.last4}), reported ${remaining}c left, too close to expiry to sell again`, leftover.payer)
            result.leftovers.push({ last4: intent.last4, outcome: 'held_listing_expiring' })
          } else {
            result.leftovers.push({ last4: intent.last4, outcome: 'waiting' })
          }
        } else {
          const moved = await prisma.intent.updateMany({
            where: { id: intent.id, state: 'executing', failureReason: intent.failureReason },
            data: {
              state: 'offered',
              matchedOrderId: null,
              lastKnownBalanceCents: leftover.leftoverCents,
              lastCheckedAt: now,
              failureReason: remainderMarker({ orderId, depositCents: leftover.depositCents, payer: leftover.payer }),
            },
          })
          if (moved.count === 1) {
            await depositEvent(orderId, `${leftover.depositCents}|relisted|reported=${remaining}`)
            result.leftovers.push({ last4: intent.last4, outcome: 'relisted' })
          } else {
            result.leftovers.push({ last4: intent.last4, outcome: 'waiting' })
          }
        }
      } else {
        const done = await prisma.intent.updateMany({ where: { id: intent.id, state: 'executing', failureReason: intent.failureReason }, data: { state: 'completed' } })
        if (done.count === 1 && (await claimMoneyMove('deposit-return', orderId, orderId))) {
          await depositEvent(orderId, `${leftover.depositCents}|taken|reported=${remaining}|expected=${leftover.leftoverCents}`)
          result.leftovers.push({ last4: intent.last4, outcome: 'taken' })
        } else {
          result.leftovers.push({ last4: intent.last4, outcome: 'waiting' })
        }
      }
    }

    // A card this purchase bought that was an earlier agent's relisted leftover.
    const ofEvent = await prisma.orderEvent.findFirst({ where: { orderId, reason: { startsWith: `${REMAINDER_OF}|` } } })
    const of = decodeRemainderOf(ofEvent?.reason)
    if (of && report && typeof report.appliedCents === 'number' && Number.isInteger(report.appliedCents)) {
      // Proved against the deposit itself (= the leftover reported intact), so a
      // balance that changed while it was on sale cannot return more than was shown.
      if (report.appliedCents >= of.depositCents) {
        const sent = await sendBackOnce('deposit-return', of.firstOrderId, of.payer, of.depositCents, `agent leftover proved by ${orderId}`, of.firstOrderId)
        if (sent.status === 'sent') {
          await depositEvent(of.firstOrderId, `${of.depositCents}|returned|${sent.txHash}|proved-by=${orderId}`)
          result.deposits.push({ orderId: of.firstOrderId, outcome: 'returned' })
        } else if (sent.status === 'failed') {
          await depositEvent(of.firstOrderId, `${of.depositCents}|return_failed|proved-by=${orderId}`)
          result.deposits.push({ orderId: of.firstOrderId, outcome: 'return_failed' })
        }
      } else {
        // A short report from the NEXT buyer costs them nothing and would take
        // a stranger's deposit, so it is held for a person, never taken here.
        // Holding takes the deposit's claim: from then on only the person
        // decides, and no later report can return it automatically.
        const why = `${of.depositCents}|needs_operator|next-buyer-short|applied=${report.appliedCents}|expected=${of.depositCents}|by=${orderId}`
        if (await claimMoneyMoveWith('deposit-return', of.firstOrderId, of.firstOrderId, (tx) => depositEvent(of.firstOrderId, why, tx))) {
          await pushOperator({
            title: '[CHECK] agent leftover reported short by its next buyer',
            message: [`first order: ${of.firstOrderId} (deposit ${of.depositCents}c to ${of.payer})`, `next order: ${orderId} applied ${report.appliedCents}c`, 'Check the card balance, then return or keep the deposit by hand. Nothing will return it automatically.'].join(String.fromCharCode(10)),
            priority: 4,
            tags: ['warning'],
          }).catch(() => undefined)
          result.deposits.push({ orderId: of.firstOrderId, outcome: 'held' })
        }
      }
    }
  }
  return result
}

export interface SettleReport {
  /** Part-used cards never reported: deposit taken. */
  unreported: number
  /** Deposits on purchases that failed before the hand-over: sent back. */
  depositsReturned: number
  /** Relisted leftovers that can no longer sell, or sold and never proved: handed to a person. */
  needsOperator: number
  /** Cards left reserved by an agent purchase that was refunded before its hand-over: back on sale. */
  cardsReleased: number
}

/**
 * The agent sweep (`pnpm agent:settle`, and the reconcile cron). Every step
 * skips what it already handled, so it keeps working past any number of rows:
 *  1. A part-used card whose agent never reported what was left, after
 *     `maxAgeMs`: the deposit is taken (claimed), the card is done.
 *  2. A deposit charged on a purchase whose orders were refunded before any
 *     hand-over (a crash): sent back, under the same claim the unwind uses.
 *  3. Cards still reserved by such a refunded purchase: back on sale.
 *  4. A relisted leftover that can no longer sell, or one sold whole whose
 *     buyer never proved it within `maxAgeMs`: paged once.
 *  5. A payment claimed with no purchase and no return: paged once.
 *  6. Money that arrived for a refused challenge and was never used: paged
 *     once, after its challenge has expired.
 *  7. An automatic return claimed and never finished: paged once.
 */
export async function settleStaleAgentLeftovers(now: Date = new Date(), maxAgeMs: number = 7 * 24 * 3600_000): Promise<SettleReport> {
  const report: SettleReport = { unreported: 0, depositsReturned: 0, needsOperator: 0, cardsReleased: 0 }
  const cutoff = new Date(now.getTime() - maxAgeMs)

  // 1. Unreported part-used cards.
  const stale = await prisma.intent.findMany({
    where: { state: 'executing', failureReason: { startsWith: `${LEFTOVER}|` }, updatedAt: { lt: cutoff } },
    orderBy: { updatedAt: 'asc' },
    take: 200,
  })
  for (const intent of stale) {
    const m = decodeLeftover(intent.failureReason)
    if (!m) continue
    const moved = await prisma.intent.updateMany({ where: { id: intent.id, state: 'executing', failureReason: intent.failureReason }, data: { state: 'completed' } })
    if (moved.count === 1 && (await claimMoneyMove('deposit-return', m.orderId, m.orderId))) {
      await depositEvent(m.orderId, `${m.depositCents}|taken|never-reported`)
      report.unreported += 1
    }
  }

  // 2 and 3. Agent purchases refunded before their hand-over.
  const refunded = await prisma.order.findMany({
    where: { buyerEmail: AGENT_BUYER_EMAIL, rail: 'mpp', kind: 'gift_card', state: 'refunded', updatedAt: { gt: new Date(now.getTime() - 30 * 24 * 3600_000) } },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  for (const order of refunded) {
    const charged = await prisma.orderEvent.findFirst({ where: { orderId: order.id, reason: { startsWith: `${DEPOSIT}|`, contains: '|charged|' } } })
    if (charged?.reason) {
      const [, cents = '', , payer = '', paymentRef = ''] = charged.reason.split('|')
      const done = await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('deposit-back', paymentRef) } })
      if (!done && /^\d+$/.test(cents) && /^0x[0-9a-fA-F]{40}$/.test(payer) && paymentRef !== '') {
        const sent = await sendBackOnce('deposit-back', paymentRef, payer, Number(cents), `deposit on a purchase refunded before its hand-over (${order.id})`, order.id)
        if (sent.status === 'sent') {
          await depositEvent(order.id, `${cents}|returned|${sent.txHash}|purchase-refunded`)
          report.depositsReturned += 1
        }
      }
    }
    const stuck = await prisma.intent.findMany({ where: { matchedOrderId: order.id, state: { in: ['matched', 'executing'] }, formFactor: AGENT_FORM_FACTOR } })
    for (const i of stuck) {
      if (decodeLeftover(i.failureReason) !== null) continue
      const back = await prisma.intent.updateMany({ where: { id: i.id, state: i.state, matchedOrderId: order.id }, data: { state: 'offered', matchedOrderId: null } })
      report.cardsReleased += back.count
    }
  }

  // 4a. Relisted leftovers that can no longer sell.
  const unsellable = await prisma.intent.findMany({
    where: { failureReason: { startsWith: `${REMAINDER}|` }, OR: [{ state: 'cancelled' }, { state: 'offered', expiresAt: { lt: new Date(now.getTime() + agentMinSupplyLeftMs()) } }] },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  for (const intent of unsellable) {
    const m = decodeAgentRemainder(intent.failureReason)
    if (!m) continue
    if (await flagOnce(m.orderId, m.depositCents, 'leftover-unsold', `listing: ${intent.id} (•••• ${intent.last4}), ${intent.state}`, m.payer)) report.needsOperator += 1
  }

  // 4b. Leftovers sold whole (the sale went through) whose buyer never proved them.
  const sold = await prisma.orderEvent.findMany({ where: { reason: { startsWith: `${REMAINDER_OF}|` }, createdAt: { lt: cutoff } }, orderBy: { createdAt: 'desc' }, take: 200 })
  for (const e of sold) {
    const of = decodeRemainderOf(e.reason)
    if (!of) continue
    const selling = await prisma.order.findUnique({ where: { id: e.orderId }, select: { state: true } })
    if (selling?.state !== 'fulfilled') continue
    // Returned, taken, or already with a person: decided.
    const decided = await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('deposit-return', of.firstOrderId) } })
    if (decided) continue
    if (await flagOnce(of.firstOrderId, of.depositCents, `leftover-unproved-${e.orderId}`, `sold under order ${e.orderId}, never proved by its buyer`, of.payer)) report.needsOperator += 1
  }

  // 5. Payments claimed with no purchase and no return (a crash right after
  // the claim): paged once each. Never moved automatically.
  const claims = await prisma.processedEvent.findMany({
    where: { id: { startsWith: 'agent-payment-use:' }, processedAt: { lt: new Date(now.getTime() - 15 * 60_000), gt: new Date(now.getTime() - 30 * 24 * 3600_000) } },
    orderBy: { processedAt: 'desc' },
    take: 200,
  })
  for (const c of claims) {
    const tx = c.id.slice('agent-payment-use:'.length)
    const orders = await prisma.order.count({ where: { paymentRef: { equals: tx, mode: 'insensitive' } } })
    if (orders > 0) continue
    const returned = await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('charge-back', tx) } })
    if (returned) continue
    const paged = await pageOnce('stranded-page', tx, {
      title: '[ACTION NEEDED] agent payment claimed with no purchase and no return',
      message: [`transaction: ${tx}`, `Check on chain who paid. Record it FIRST: pnpm agent:settle --returned=${tx}, then return it by hand.`].join(String.fromCharCode(10)),
      priority: 5,
      tags: ['rotating_light'],
    })
    if (paged) report.needsOperator += 1
  }

  // 6. Money that arrived for a challenge the payment library refused, with
  // no purchase using it since. Paged here, never at the time: by now its
  // challenge has expired (minutes), so nothing can still spend it, and a
  // purchase that was running then has made its claim.
  const refused = await prisma.processedEvent.findMany({
    where: { id: { startsWith: 'agent-refused-seen:' }, processedAt: { lt: new Date(now.getTime() - 15 * 60_000), gt: new Date(now.getTime() - 30 * 24 * 3600_000) } },
    orderBy: { processedAt: 'desc' },
    take: 200,
  })
  for (const r of refused) {
    const [tx = '', challengeId = ''] = r.id.slice('agent-refused-seen:'.length).split('|')
    if (tx === '' || challengeId === '') continue
    if (await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('refused-page', tx) } })) continue
    if (await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('payment-use', tx) } })) continue
    if (await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('charge-back', tx) } })) continue
    if ((await prisma.order.count({ where: { paymentRef: { equals: tx, mode: 'insensitive' } } })) > 0) continue
    const seen = await paymentToUs(tx, challengeId)
    if (seen.status === 'unknown') continue // unreadable: tried again next run
    if (seen.status === 'none') {
      // Nothing bound to that challenge ever arrived, and it has expired: done.
      await prisma.processedEvent.delete({ where: { id: r.id } }).catch(() => undefined)
      continue
    }
    const paged = await pageOnce('refused-page', tx, {
      title: '[ACTION NEEDED] agent payment refused after it paid',
      message: [
        `transaction: ${tx}`,
        `on chain: ${seen.cents}c from ${seen.payer}, for challenge ${challengeId}, refused at ${r.processedAt.toISOString()}`,
        'No purchase has used it, and its challenge has expired.',
        `Record it FIRST: pnpm agent:settle --returned=${tx}, then return it by hand.`,
      ].join(String.fromCharCode(10)),
      priority: 5,
      tags: ['rotating_light'],
    })
    if (paged) report.needsOperator += 1
  }

  // 7. Automatic returns that did not finish and have not been said: the
  // process died between the claim and the transfer's answer (no marker), or
  // the transfer failed and its FAILED page did not get through (sendBackOnce
  // marks the page once it lands). The money may still be owed. Paged once;
  // never sent again automatically. A claim with no ending is judged only
  // after the markers began (before that a claim alone meant done); a
  // recorded failure counts whenever, and is read on its own so finished
  // returns never crowd it out.
  const settled = new Date(now.getTime() - 15 * 60_000)
  const monthAgo = new Date(now.getTime() - 30 * 24 * 3600_000)
  const startedAfter = new Date(Math.max(returnMarkersSince().getTime(), monthAgo.getTime()))
  const unended = await prisma.processedEvent.findMany({
    where: { OR: [{ id: { startsWith: 'agent-charge-back:' } }, { id: { startsWith: 'agent-deposit-back:' } }], processedAt: { lt: settled, gte: startedAfter } },
    orderBy: { processedAt: 'desc' },
    take: 200,
  })
  const failures = await prisma.processedEvent.findMany({
    where: { id: { startsWith: 'agent-return-failed:' }, processedAt: { lt: settled, gte: monthAgo } },
    orderBy: { processedAt: 'desc' },
    take: 200,
  })
  const kinds = ['charge-back', 'deposit-back', 'deposit-return'] as const
  const started = new Map<string, { kind: (typeof kinds)[number]; key: string; at: Date }>()
  for (const f of failures) {
    const rest = f.id.slice('agent-return-failed:'.length)
    const kind = kinds.find((k) => rest.startsWith(`${k}:`))
    if (kind) started.set(rest, { kind, key: rest.slice(kind.length + 1), at: f.processedAt })
  }
  for (const c of unended) {
    const kind = c.id.startsWith('agent-charge-back:') ? 'charge-back' : 'deposit-back'
    const key = c.id.slice(`agent-${kind}:`.length)
    if (!started.has(`${kind}:${key}`)) started.set(`${kind}:${key}`, { kind, key, at: c.processedAt })
  }
  for (const { kind, key, at } of started.values()) {
    if (await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('unfinished-page', `${kind}:${key}`) } })) continue
    if (await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('return-sent', `${kind}:${key}`) } })) continue
    if (kind === 'charge-back' && (await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('manual-return', key) } }))) continue
    const failed = kind === 'deposit-return' || (await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('return-failed', `${kind}:${key}`) } })) !== null
    // Who and how much, for a deposit: from its charge record.
    const charge =
      kind === 'charge-back'
        ? null
        : await prisma.orderEvent.findFirst({
            where: kind === 'deposit-back' ? { reason: { startsWith: `${DEPOSIT}|`, contains: '|charged|', endsWith: `|${key}` } } : { orderId: key, reason: { startsWith: `${DEPOSIT}|`, contains: '|charged|' } },
          })
    const [, cents = '?', , payer = '?'] = charge?.reason?.split('|') ?? []
    const what = kind === 'charge-back' ? `whole charge for payment ${key}` : kind === 'deposit-back' ? `deposit for payment ${key}` : `deposit for order ${key}`
    const paged = await pageOnce('unfinished-page', `${kind}:${key}`, {
      title: failed ? '[ACTION NEEDED] agent money return FAILED' : '[ACTION NEEDED] agent money return never finished',
      message: [
        `${what}, ${failed ? 'failed' : 'claimed'} ${at.toISOString()}`,
        ...(charge ? [`payer: ${payer}`, `amount: ${cents}c`] : []),
        failed ? 'The return failed and its page did not get through. It may have gone out even so.' : 'The return was started and its answer never came back (a restart mid-send). It may or may not have gone out.',
        `Check the chain for ANY transfer from our wallet to the payer since then. Only if there is none, ${kind === 'charge-back' ? `record it (pnpm agent:settle --returned=${key}) and send it by hand` : 'send the deposit by hand'}.`,
      ].join(String.fromCharCode(10)),
      priority: 5,
      tags: ['rotating_light'],
    })
    if (paged) report.needsOperator += 1
  }
  return report
}

/**
 * Hand a deposit to a person, and page, once. Takes the deposit's claim, so
 * from then on nothing returns it automatically: a later proof or report
 * cannot pay it on top of what the person decides. False when the deposit was
 * already decided (returned, taken, or already with a person).
 */
async function flagOnce(orderId: string, depositCents: number, why: string, detail: string, payer: string): Promise<boolean> {
  // The claim and its record together: never a decided deposit with no record.
  if (!(await claimMoneyMoveWith('deposit-return', orderId, orderId, (tx) => depositEvent(orderId, `${depositCents}|needs_operator|${why}`, tx)))) return false
  await pushOperator({
    title: '[ACTION NEEDED] agent deposit needs a decision',
    message: [`order: ${orderId}`, `deposit: ${depositCents}c to ${payer}`, `why: ${why}`, detail, 'Check the card balance; return the deposit by hand if the leftover is there. Nothing will return it automatically.'].join(String.fromCharCode(10)),
    priority: 4,
    tags: ['warning'],
  }).catch(() => undefined)
  return true
}
