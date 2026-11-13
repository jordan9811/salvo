/**
 * The till, on the card rail: type the total, tap Pay once, show each code
 * when the cashier is ready for it (unified-account spec 5.2 and 5.4).
 *
 * ===========================================================================
 * WHAT CHANGES FROM THE SHOP. The shop reserved each card at buy and held it
 * only at its own "Show my code", one tap per card, on a page per order. Here
 * Pay holds EVERY card of the plan at once, and the deposit for what the plan
 * leaves on its last card beside them, in parallel. So the register never
 * waits on a bank: each code after the first is a database read and a
 * balance check, not a card authorization.
 *
 *   Pay      plan again, buy (one order per card), hold every card and the
 *            deposit, open card 1's code. No code leaves before its hold.
 *   Next     the card on screen worked: settle it, open the next one. Its
 *            90-second window starts now.
 *   Done     the last card the register needed worked: settle it. Codes the
 *            register never needed are closed, never shown, and their cards
 *            go straight back on sale.
 *   Report   the card on screen did not work, or a card already settled had
 *            a problem: settle it so, close the rest, plan what is still owed.
 *   Change   the register total changed after Pay (spec 5.4's table).
 *
 * Every settle goes through the reveal path the shop uses (reveal-service.ts),
 * so the window, the exactly-once release, the deposit and the remainder
 * rules are the same whichever page showed the code.
 * ===========================================================================
 *
 * PAY IS SAFE TO TAP AGAIN. A store's signal drops answers, and Pay opens
 * card 1's code before it answers. So the phone sends a key with each tap,
 * and the same key again when no answer came back. The first Pay with a key
 * claims it (a ProcessedEvent row, no migration); a second one finds the
 * purchase the first made and sends card 1's code again, inside the same
 * window, instead of buying a second time. Next and Done are safe already:
 * a card already settled is left as it is, and a code already open is sent
 * again (reveal-service.ts resendOpenCode).
 *
 * THE PRICE ON THE BUTTON IS A CEILING. Pay plans again, and supply moves.
 * A plan that now costs more, scans more cards or holds a bigger deposit than
 * the button the shopper tapped is not bought: nothing is held, and the new
 * plan goes back as a new price for the next tap to agree to.
 *
 * THE DEPOSIT, AND ITS FALLBACK. A plan that leaves part of its last card
 * needs a deposit at face for the leftover. If the shopper's card will not
 * hold it, the purchase is unwound and planned once more with full drains
 * only, which need none: bought when it costs no more, offered as the new
 * price when it does. If nothing covers the total that way either, the
 * shopper is told the deposit could not be held, and nothing was charged.
 *
 * A PURCHASE IS ITS SIGNED HANDLE (purchase.ts): the orders and cards, in
 * scan order. Every step after Pay presents it, and the route checks that the
 * browser presenting it pays with the card customer it is bound to.
 *
 * Server only. The till's pages never import this: they reach it by fetch.
 */

import { Prisma, type Order } from '@prisma/client'
import { prisma } from '../db'
import { OrderState } from '../state'
import { pushOperator } from '../notify'
import { SpendUnavailableError, buySpend, quoteTillSpend, type SpendUnavailable } from '../demand/one-screen'
import { capForMerchant, type TillQuote } from '../demand/till-quote'
import { recordSpendLeg, spendLegFor, spendLegIn, type EventRow } from '../demand/spend-leg'
import { legCostCents, routePreference, type RoutePreference } from '../route/plan'
import { barcodeProfileFor } from '../barcode/merchants'
import { recordBuyerEvidence, recordRegisterAnswer } from '../barcode/buyer-evidence'
import { decodeRevealMarker, revealWindowClosed } from '../barcode/reveal-marker'
import { KEPT_HOLD_EVENT_PREFIX, keptHoldEventReason, type RegisterNo } from '../barcode/unscanned'
import {
  balanceReaderFor,
  closeUnshownCode,
  hasPublicBalanceLookup,
  openReveal,
  reportRemainderEmpty,
  resendOpenCode,
  settleReveal,
  type BalanceReader,
} from '../barcode/reveal-service'
import { LocalEnvelopeVault } from '../vault/envelope'
import type { SecretVault } from '../vault/types'
import { parseHoldRef } from '../hold/ref'
import {
  billedCents,
  billedIn,
  placeBondHold,
  placeHold,
  readTap,
  recordBill,
  releaseBondHold,
  type HoldFailCode,
  type PlaceHoldOutcome,
  type SharedHoldReads,
} from '../hold/stripe-hold'
import { returnDeposit } from '../hold/deposit'
import {
  depositHoldIn,
  depositTakenIn,
  liveDepositFor,
  liveDepositIn,
  recordDepositHold,
  remainderOfFor,
  remainderOfIn,
  type DepositHold,
} from '../supply/remainder'
import { REMAINDER_RELIST_MIN_CENTS } from '../barcode/relist'
import { mintPurchaseRef, PURCHASE_REF_TTL_SEC, type PurchaseLegRef, type PurchaseRef } from './purchase'
import type { KeptHold, Leg, LegCode, LegCover, Owed, ReportOutcome, RoutePlan, TillReceipt, Unavailable } from './types'

/**
 * The address a till order is filed under when the shopper gave none. The
 * account is a passkey, not an email, and the `.invalid` domain is never
 * mailed (src/lib/email.ts): the till's own screens say what happened.
 */
export const NO_RECEIPT_EMAIL = 'till@receipts.invalid'

/** Why the till could not do what was asked, as a code the screen keys on and a sentence it shows. */
export type TillFailure =
  | 'card_required'
  | 'over_allowance'
  | 'hold_closed'
  | 'declined'
  | 'needs_bank_check'
  | 'deposit_declined'
  | 'try_again'
  /** The tap with this key is still holding its cards: ask again with the same key. */
  | 'still_going'
  | 'unavailable'
  | 'closed'

export class TillError extends Error {
  readonly code: TillFailure

  constructor(code: TillFailure, message: string) {
    super(message)
    this.name = 'TillError'
    this.code = code
  }
}

/** What every step reads and settles with. Tests pass their own; production uses the real ones. */
export interface TillDeps {
  vault?: SecretVault
  readerFor?: (merchantId: string) => BalanceReader
  now?: Date
}

const vaultOf = (d: TillDeps): SecretVault => d.vault ?? new LocalEnvelopeVault()
const readerOf = (d: TillDeps, merchantId: string): BalanceReader => (d.readerFor ?? balanceReaderFor)(merchantId)
const nowOf = (d: TillDeps): Date => d.now ?? new Date()

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

// ===========================================================================
// A purchase's orders and their events, read once
// ===========================================================================

/**
 * Every event on a purchase's orders, in one read, newest first, and what
 * each step asks of them answered from it by the one-order readers' own
 * rules (spendLegIn beside spendLegFor, and so on).
 *
 * ONE READ, NOT ONE A QUESTION. The plan a Pay answers with asked five or
 * six questions of every card, each its own query, and the receipt as many
 * again: twenty event reads on a two-card Pay and twenty on its Done
 * (measured 2026-10-13). The answers are the same; only the reads are fewer.
 *
 * A SNAPSHOT. It answers as of its read, so a step reads it after its last
 * write, or reads it again after one.
 */
class PurchaseEvents {
  private constructor(private readonly byOrder: ReadonlyMap<string, readonly EventRow[]>) {}

  static async read(orderIds: readonly string[]): Promise<PurchaseEvents> {
    const ids = [...new Set(orderIds)]
    const rows =
      ids.length === 0
        ? []
        : await prisma.orderEvent.findMany({
            where: { orderId: { in: ids } },
            orderBy: { createdAt: 'desc' },
            select: { orderId: true, reason: true, actor: true, toState: true },
          })
    const byOrder = new Map<string, EventRow[]>()
    for (const r of rows) {
      const list = byOrder.get(r.orderId)
      if (list) list.push(r)
      else byOrder.set(r.orderId, [r])
    }
    return new PurchaseEvents(byOrder)
  }

  private of(orderId: string): readonly EventRow[] {
    return this.byOrder.get(orderId) ?? []
  }

  spendLeg(orderId: string): ReturnType<typeof spendLegIn> {
    return spendLegIn(this.of(orderId))
  }

  depositHold(orderId: string): DepositHold | null {
    return depositHoldIn(this.of(orderId))
  }

  liveDeposit(orderId: string): DepositHold | null {
    return liveDepositIn(this.of(orderId))
  }

  depositTaken(orderId: string): number {
    return depositTakenIn(this.of(orderId))
  }

  remainderOf(orderId: string): string | null {
    return remainderOfIn(this.of(orderId))
  }

  billed(order: Pick<Order, 'id' | 'priceCents'>): number {
    return billedIn(order, this.of(order.id))
  }

  /** keptState's answer: a hold kept behind a card that did not work, on an order still open. */
  kept(order: Pick<Order, 'id' | 'state'>): boolean {
    return order.state === OrderState.fulfilling && this.of(order.id).some((e) => (e.reason ?? '').startsWith(KEPT_HOLD_EVENT_PREFIX))
  }

  /** everShown's answer: did this order's code ever reach the screen? */
  everShown(orderId: string): boolean {
    return this.of(orderId).some((e) => e.toState === OrderState.fulfilling)
  }
}

/** A purchase's orders and their events, as they stand now: two reads, side by side. */
interface PurchaseRead {
  orders: ReadonlyMap<string, Order>
  events: PurchaseEvents
}

async function readPurchase(ref: Pick<PurchaseRef, 'legs'>): Promise<PurchaseRead> {
  const ids = ref.legs.map((l) => l.orderId)
  const [orders, events] = await Promise.all([
    prisma.order.findMany({ where: { id: { in: ids } } }),
    PurchaseEvents.read(ids),
  ])
  return { orders: new Map(orders.map((o) => [o.id, o])), events }
}

// ===========================================================================
// Quote
// ===========================================================================

/**
 * The quote's marker for a plan made with full drains only, after the
 * shopper's card would not hold a deposit. Opaque to the screens; a Pay that
 * presents it plans the same way, so the price the button showed is the
 * price planned.
 */
const DRAINS_ONLY = ':drain'

function publicLegs(q: TillQuote): Leg[] {
  return q.plan.legs.map((l) => ({
    ref: String(l.scanIndex),
    source: l.source,
    firstInLine: l.firstInLine,
    faceCents: l.faceCents,
    appliedCents: l.appliedCents,
    costCents: l.costCents,
    leftoverCents: l.leftoverCents,
    depositCents: l.depositCents,
    scanIndex: l.scanIndex,
    scanOf: l.scanOf,
  }))
}

/** The buyer-facing plan. Carries no listing or order ids. */
function publicPlan(q: TillQuote, drainsOnly = false): RoutePlan {
  return {
    rail: 'card',
    merchant: q.merchantId,
    totalCents: q.orderTotalCents,
    legs: publicLegs(q),
    costCents: q.priceCents,
    savingCents: q.savingCents,
    depositCents: q.depositCents,
    uncoveredCents: 0,
    preference: q.preference,
    quoteRef: `card:${q.merchantId}:${q.orderTotalCents}${drainsOnly ? DRAINS_ONLY : ''}`,
    expiresAt: q.expiresAt.toISOString(),
  }
}

/** Whether a quote the screen hands back was made with full drains only. */
export function quotedDrainsOnly(quoteRef: unknown): boolean {
  return typeof quoteRef === 'string' && quoteRef.endsWith(DRAINS_ONLY)
}

/**
 * The till's own words for a total nothing covers.
 *
 * NEVER "TRY ANOTHER AMOUNT". The shop's sentences ask for a smaller, larger
 * or rounder amount, which a shopper there can choose. At the till the total
 * is the register's: a smaller one leaves part of it to pay another way, and
 * a larger one pays for value the register never takes. So the till says what
 * is true and asks for nothing.
 */
const NOTHING_LISTED = 'Nothing is listed for this store right now.'

function tillUnavailable(q: SpendUnavailable | SpendUnavailableError, totalCents: number): Unavailable {
  const noSupply = q instanceof SpendUnavailableError ? q.noSupply : q.noSupply === true
  const cannotCover = q instanceof SpendUnavailableError ? q.cannotCover : q.cannotCover === true
  if (noSupply) return { unavailable: NOTHING_LISTED, nothingListed: true }
  if (cannotCover) return { unavailable: `We cannot cover ${money(totalCents)} at this store right now.` }
  return { unavailable: q instanceof SpendUnavailableError ? q.message : q.unavailable }
}

/**
 * Price a total at one store, card by card. Public pricing, not a hold: Pay
 * plans again. `buyer` keeps a shopper off the cards their own kept hold
 * waits behind, and away from remainders after repeated reports; the quote
 * route passes it only when it knows the customer without asking the card
 * processor.
 */
export async function quoteCardTill(input: {
  merchantId: string
  totalCents: number
  preference: RoutePreference | null
  buyer?: { customerId: string; fingerprint: string | null } | null
  excludeIntentIds?: readonly string[]
  now?: Date
}): Promise<RoutePlan | Unavailable> {
  const q = await quoteTillSpend({
    merchantId: input.merchantId,
    spendCents: input.totalCents,
    preference: input.preference,
    ...(input.buyer ? { buyer: input.buyer } : {}),
    ...(input.excludeIntentIds ? { excludeIntentIds: input.excludeIntentIds } : {}),
    ...(input.now ? { now: input.now } : {}),
  })
  return 'unavailable' in q ? tillUnavailable(q, input.totalCents) : publicPlan(q)
}

// ===========================================================================
// Pay
// ===========================================================================

/** The sentence for a hold that could not be placed. Nothing was charged in any of them. */
function holdFailure(code: HoldFailCode, depositCents: number): TillError {
  switch (code) {
    case 'declined':
      return new TillError('declined', 'Your card was declined, so nothing was charged. Try another card.')
    case 'needs_bank_check':
      return new TillError(
        'needs_bank_check',
        'Your bank wants to check this payment, and we cannot do that at the register. Nothing was charged.',
      )
    case 'no_card':
    case 'card_gone':
      return new TillError('card_required', 'We cannot find your saved card. Save it again in Account. Nothing was charged.')
    case 'over_allowance':
      return new TillError('over_allowance', 'This would take you over the most we hold for you at once. Nothing was charged.')
    case 'unavailable':
      return new TillError('hold_closed', 'We cannot hold payments right now. Nothing was charged.')
    case 'busy':
    case 'try_again':
      return new TillError(
        'try_again',
        depositCents > 0
          ? 'We could not reach your bank. Try again. Anything held is released.'
          : 'We could not reach your bank. Try again. Nothing was charged.',
      )
  }
}

/** A buy refusal, as the till says it. */
function buyFailure(err: SpendUnavailableError, totalCents: number): TillError {
  switch (err.code) {
    case 'card_required':
      return new TillError('card_required', 'Save a card in Account first. Nothing is charged until a code works.')
    case 'over_allowance': {
      // The numbers, and never "a smaller amount": the total is the register's.
      const d = err.detail
      const open = d ? d.heldCents + d.reservedCents : 0
      return new TillError(
        'over_allowance',
        d
          ? open > 0
            ? `You already have ${money(open)} held with us, and we hold up to ${money(d.allowanceCents)} for you at once. Nothing was charged.`
            : `This is over the ${money(d.allowanceCents)} we hold for you at once. Nothing was charged.`
          : 'This would take you over the most we hold for you at once. Nothing was charged.',
      )
    }
    case 'hold_closed':
      return new TillError('hold_closed', err.message)
    default: {
      const u = tillUnavailable(err, totalCents)
      return new TillError('unavailable', u.nothingListed || err.cannotCover ? `${u.unavailable} Nothing was charged.` : u.unavailable)
    }
  }
}

export interface PaidTill {
  ref: PurchaseRef
  plan: RoutePlan
  code: LegCode
}

/**
 * What Pay came to: the purchase, or a new price and nothing held, or, for a
 * tap asked again, that its purchase has already ended (`ended`): settled,
 * with no code left to show. Its handle still goes back, so the phone keeps
 * it for Account and its receipt.
 */
export type PayResult =
  | { kind: 'paid'; paid: PaidTill }
  | { kind: 'requote'; plan: RoutePlan; message: string }
  | { kind: 'ended'; ref: PurchaseRef; plan: RoutePlan; message: string }

/** A tap's purchase found again: its next code, or that it has ended. */
type Resumed = { kind: 'paid'; paid: PaidTill } | { kind: 'ended'; ref: PurchaseRef; plan: RoutePlan; message: string }

/** Said for a purchase a tap asked about again that has already ended. */
const ALREADY_ENDED = 'That Pay already went through. It is in Account, with what was charged.'

type Attempt =
  | { kind: 'paid'; paid: PaidTill }
  /** The shopper's card would not hold the deposit; everything was unwound. */
  | { kind: 'deposit_declined'; depositCents: number }
  /** The plan now costs more than the button said; nothing was bought. */
  | { kind: 'requote'; plan: RoutePlan }

export interface PayTillInput {
  merchantId: string
  totalCents: number
  preference: RoutePreference | null
  customerId: string
  /** Cards to leave out: the shown cards of a purchase this one finishes. */
  excludeIntentIds?: readonly string[]
  /** One per tap, the same again on a retry after no answer came back. */
  key?: string | null
  /** What the button said: a plan past any of these is not bought. */
  ceiling?: { costCents: number; cards: number; depositCents: number } | null
  /** The button's plan was full drains only (`quotedDrainsOnly`). */
  drainsOnly?: boolean
  /**
   * Only find what an earlier tap with this key did, and never pay afresh:
   * the phone lost that tap's answer when its page was closed or reloaded.
   */
  resumeOnly?: boolean
  /**
   * The other card customers this browser holds (http.ts otherCustomersOf).
   * A key one of them claimed is that tap's: it is carried on under that
   * customer, never claimed again under this one, which would buy twice.
   */
  otherCustomerIds?: readonly string[]
}

/** A key that made no purchase, asked for again with nothing to buy. */
const NOTHING_FROM_THAT_TAP = 'That Pay did not go through, so nothing was charged.'

/**
 * Pay for a total: every card held at once, the deposit beside them, and card
 * 1's code opened. Throws TillError for every refusal, with nothing left held.
 */
export async function payCardTill(input: PayTillInput, deps: TillDeps = {}): Promise<PayResult> {
  const now = nowOf(deps)
  if (input.resumeOnly) return await resumeOnly(input, deps)
  // The same tap, claimed under another card customer this browser holds (it
  // signed in, or saved its card to the account, since): carried on there.
  const elsewhere = input.key ? await claimedUnder(input.key, input.otherCustomerIds ?? []) : null
  if (elsewhere !== null) {
    if (elsewhere.orderId === null) {
      if (now.getTime() - elsewhere.at.getTime() < CLAIM_IN_FLIGHT_MS) throw new TillError('still_going', STILL_GOING)
    } else {
      const resumed = await resumePurchase(elsewhere.orderId, elsewhere.at, { ...input, customerId: elsewhere.customerId }, deps)
      if (resumed !== null) return resumed
    }
  }
  const claim = input.key ? await claimPay(input.customerId, input.key, now) : null
  if (claim?.kind === 'busy') throw new TillError('still_going', STILL_GOING)
  if (claim?.kind === 'resume') {
    const resumed = await resumePurchase(claim.orderId, claim.at, input, deps)
    if (resumed !== null) return resumed
    // That tap's purchase ended with nothing held: this one buys afresh.
    await claimAfresh(claim.id, now)
  }
  const claimId = claim?.id ?? null

  try {
    // The card and its holds, read once for the whole tap and shared by every hold in it.
    const reads = await readTap(input.customerId, now).catch(() => null)
    const identity = reads?.identity ?? null
    const first = await payOnce(input, identity, input.drainsOnly ? 0 : undefined, claimId, deps, reads?.shared ?? null)
    if (first.kind === 'paid') return first
    if (first.kind === 'requote') {
      await dropClaim(claimId)
      return { kind: 'requote', plan: first.plan, message: 'The price changed. Nothing was charged.' }
    }
    // Full drains need no deposit. One more try, and only one.
    const again = await payOnce(input, identity, 0, claimId, deps).catch((err: unknown) => {
      if (err instanceof TillError && err.code === 'unavailable') return null
      throw err
    })
    if (again?.kind === 'paid') return again
    if (again?.kind === 'requote') {
      await dropClaim(claimId)
      return {
        kind: 'requote',
        plan: again.plan,
        message: `Your card would not hold the ${money(first.depositCents)} deposit. This way needs none. Nothing was charged.`,
      }
    }
    throw new TillError(
      'deposit_declined',
      `We could not hold the ${money(first.depositCents)} deposit on your card. Nothing was charged.`,
    )
  } catch (err) {
    // Nothing is held now: a retry with the same key buys afresh.
    await dropClaim(claimId)
    throw err
  }
}

async function payOnce(
  input: PayTillInput,
  identity: { email: string | null; fingerprint: string | null } | null,
  maxLeftoverCents: number | undefined,
  claimId: string | null,
  deps: TillDeps,
  /** The tap's one read of the card and its holds. The second try (full drains) reads afresh: the first one's holds have moved since. */
  shared: SharedHoldReads | null = null,
): Promise<Attempt> {
  const now = nowOf(deps)
  const merchantId = input.merchantId.toLowerCase().trim()
  let bought: Awaited<ReturnType<typeof buySpend>>
  try {
    bought = await buySpend({
      merchantId,
      spendCents: input.totalCents,
      buyerEmail: identity?.email ?? NO_RECEIPT_EMAIL,
      payer: { customerId: input.customerId, read: shared },
      preference: input.preference,
      buyer: { customerId: input.customerId, fingerprint: identity?.fingerprint ?? null },
      ...(input.excludeIntentIds ? { excludeIntentIds: input.excludeIntentIds } : {}),
      ...(maxLeftoverCents !== undefined ? { maxLeftoverCents } : {}),
      ...(input.ceiling ? { ceiling: input.ceiling } : {}),
      till: true,
      now,
    })
  } catch (err) {
    if (err instanceof SpendUnavailableError && err.code === 'price_changed' && err.quote) {
      return { kind: 'requote', plan: publicPlan(err.quote, maxLeftoverCents === 0) }
    }
    if (err instanceof SpendUnavailableError) throw buyFailure(err, input.totalCents)
    throw err
  }

  const orders = await Promise.all(bought.legs.map((l) => prisma.order.findUniqueOrThrow({ where: { id: l.orderId } })))
  const legs: PurchaseLegRef[] = bought.legs.map((l) => ({ orderId: l.orderId, intentId: l.intentId }))
  // The purchase, on card 1's order, and the tap's key pointed at it, before
  // any money: a retry of this tap finds it from here on.
  await recordPurchase(orders[0], legs, bought.spendCents)
  if (claimId !== null && orders[0]) await pointClaim(claimId, orders[0].id)

  const ref: PurchaseRef = {
    legs,
    customerId: input.customerId,
    merchantId,
    totalCents: bought.spendCents,
    expiresAt: new Date(now.getTime() + PURCHASE_REF_TTL_SEC * 1000),
  }

  // Card 1 opens as soon as its own hold is in, while the other cards and the
  // deposit are still being held, and goes live only once every one of them
  // has held (holdEverything).
  const held = await holdEverything(
    ref,
    orders.map((order, i) => ({ order, legRef: legs[i] as PurchaseLegRef })),
    now,
    shared,
    (placed, goLive) => openLeg(ref, 1, deps, { placed, goLive }),
  )
  if (held.problem !== null) {
    if (held.problem.kind === 'deposit_declined') return { kind: 'deposit_declined', depositCents: bought.depositCents }
    throw holdFailure(held.problem.code, bought.depositCents)
  }

  const first = held.first
  if (first === null || !first.ok) {
    // Card 1 could not open: the open closed it, or gave its claim back after
    // a passing failure. Either way no code was shown, so every card still
    // waiting is closed, card 1 included.
    await closeLaterLegs(ref, 0, now)
    throw first === null ? holdFailure('try_again', bought.depositCents) : first.error
  }
  // Every write of this Pay is done: one read of the purchase answers the code and the plan.
  const read = await readPurchase(ref)
  const code = await legCode(ref, first.value, read.events)
  return { kind: 'paid', paid: { ref, plan: { ...(await planOf(ref, read)), preference: routePreference(input.preference) }, code } }
}

/** A promise's outcome, as a value: never thrown, so it can wait beside others. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

function settled<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  )
}

/** Why the holds of a Pay did not all hold. Everything was unwound. */
type HoldProblem = { kind: 'deposit_declined' } | { kind: 'failed'; code: HoldFailCode }

/** Card 1's open, as Pay starts it beside the other holds: given its own hold's answer, and when it may go live. */
type OpenFirst = (placed: Extract<PlaceHoldOutcome, { ok: true }> | null, goLive: Promise<boolean>) => Promise<OpenCode>

/**
 * EVERY HOLD AT ONCE, AND THE DEPOSIT BESIDE THEM. Each order is new and
 * named nowhere else yet, so nothing races these: no code can open on an
 * order this request has not returned. A hold already recorded (a retried
 * Pay that resumes) is left as it is; one placed and not recorded is adopted.
 * `problem` is null when everything is held; otherwise everything is
 * unwound, and it says why.
 *
 * CARD 1 OPENS BESIDE THEM (`openFirst`). Its claim, its unseal and its
 * balance read wait on its own hold only, which the custody rule needs
 * (openReveal: no unseal before the card's hold is verified), and not on the
 * other cards' or the deposit's. It goes live only once all of them have
 * held: openReveal waits on `goLive` before it writes anything a shown code
 * writes, and a no gives its claim back, so the unwind closes card 1 as a
 * card never shown, like the rest. `first` is how that open came out, once
 * everything held; null when card 1's own hold did not.
 */
async function holdEverything(
  ref: PurchaseRef,
  legs: ReadonlyArray<{ order: Order; legRef: PurchaseLegRef }>,
  now: Date,
  shared: SharedHoldReads | null = null,
  /** For legs[0], card 1: its open, started once its own hold is in. */
  openFirst?: OpenFirst,
): Promise<{ problem: HoldProblem | null; first: Settled<OpenCode> | null }> {
  const orders = legs.map((l) => l.order)
  // The part-used card: the one leg whose leftover is large enough to be
  // listed again, which is exactly the leftover the plan put a deposit on.
  // Every card's events in one read: nothing has written a spend leg or a
  // deposit since the buy.
  const events = await PurchaseEvents.read(orders.map((o) => o.id))
  const spends = orders.map((o) => events.spendLeg(o.id))
  const partial = spends.findIndex((l) => (l?.leftoverCents ?? 0) >= REMAINDER_RELIST_MIN_CENTS)
  const partialOrder = partial >= 0 ? orders[partial] : undefined
  const partialLeftover = partial >= 0 ? (spends[partial]?.leftoverCents ?? 0) : 0
  const partialIntent = partial >= 0 ? legs[partial]?.legRef.intentId : undefined
  const recorded = partialOrder ? events.depositHold(partialOrder.id) : null

  let say: (live: boolean) => void = () => undefined
  const goLive = new Promise<boolean>((resolve) => {
    say = resolve
  })
  const holdCalls = legs.map(({ order, legRef }): Promise<PlaceHoldOutcome | null> =>
    parseHoldRef(order.paymentRef)?.paymentIntentId != null
      ? Promise.resolve(null)
      : placeHold(order, { id: legRef.intentId, merchantId: ref.merchantId }, now, shared),
  )
  const bondCall =
    partialOrder && partialIntent && recorded === null
      ? placeBondHold(partialOrder, { customerId: ref.customerId, intentId: partialIntent, cents: partialLeftover }, now, shared)
      : Promise.resolve(null)
  const firstHold = holdCalls[0]
  // Never rejects: it is awaited only once the holds are in, on every path.
  const opening: Promise<Settled<OpenCode> | null> =
    openFirst === undefined || firstHold === undefined
      ? Promise.resolve(null)
      : firstHold.then(
          (h) => (h !== null && !h.ok ? null : settled(openFirst(h, goLive))),
          (error: unknown): Settled<OpenCode> => ({ ok: false, error }),
        )

  let problem: HoldProblem | null = null
  let bondPi: string | null = null
  try {
    const [holds, bond] = await Promise.all([Promise.all(holdCalls), bondCall])
    bondPi = bond?.ok ? bond.pi : null
    const failed = holds.find((h): h is Extract<PlaceHoldOutcome, { ok: false }> => h !== null && !h.ok)
    if (failed || (bond !== null && !bond.ok)) {
      if (!failed && bond && !bond.ok && (bond.code === 'declined' || bond.code === 'needs_bank_check' || bond.code === 'over_allowance')) {
        problem = { kind: 'deposit_declined' }
      } else {
        const why = failed ?? (bond && !bond.ok ? bond : null)
        problem = { kind: 'failed', code: why?.code ?? 'try_again' }
      }
    } else if (bond?.ok && partialOrder) {
      await recordDepositHold(partialOrder, { paymentIntentId: bond.pi, cents: partialLeftover })
    }
  } catch (err) {
    // Nothing goes live, and card 1's claim is back before this answers.
    say(false)
    await opening
    throw err
  }

  if (problem !== null) {
    // Card 1's claim goes back first, so the unwind closes it as never shown.
    say(false)
    await opening
    await unwind(orders, bondPi, now)
    return { problem, first: null }
  }
  say(true)
  return { problem: null, first: await opening }
}

/** A Pay that cannot go on: every hold it placed is released, and every card goes back on sale. */
async function unwind(orders: readonly Order[], bondPi: string | null, now: Date): Promise<void> {
  for (const o of orders) {
    const fresh = await prisma.order.findUnique({ where: { id: o.id } })
    if (fresh) {
      await closeUnshownCode(fresh, 'the purchase could not be completed, so nothing was charged', {
        now,
        source: 'inline',
      }).catch((err: unknown) => console.warn(`[till] ${o.id}: unwind left to the hold sweep: ${String(err).slice(0, 200)}`))
    }
  }
  if (bondPi !== null) {
    await releaseBondHold(bondPi, 'inline').catch((err: unknown) =>
      console.warn(`[till] deposit ${bondPi}: release left to the hold sweep: ${String(err).slice(0, 200)}`),
    )
  }
}

// ===========================================================================
// A tap's key, and the purchase it made
// ===========================================================================

/** The purchase, on card 1's order: its cards in scan order and its total, so a retried tap can find it. */
const PURCHASE_MARKER = 'TILL_PURCHASE'
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/
/** A claim with no purchase yet, younger than this, is a tap still running. */
const CLAIM_IN_FLIGHT_MS = 60_000

/** A key the phone sent, when it is one. */
export function payKeyOf(v: unknown): string | null {
  return typeof v === 'string' && KEY_RE.test(v) ? v : null
}

async function recordPurchase(order: Order | undefined, legs: readonly PurchaseLegRef[], totalCents: number): Promise<void> {
  if (!order) return
  await prisma.orderEvent.create({
    data: {
      orderId: order.id,
      fromState: order.state,
      toState: order.state,
      reason: `${PURCHASE_MARKER}|${legs.map((l) => `${l.orderId}:${l.intentId}`).join('~')}|${totalCents}`,
      actor: 'intake',
    },
  })
}

type Claim =
  | { kind: 'fresh'; id: string }
  /** `at`: when the tap that made the purchase claimed the key. */
  | { kind: 'resume'; id: string; orderId: string; at: Date }
  | { kind: 'busy'; id: string }

/** A second tap while the first is still holding its cards. */
const STILL_GOING = 'Your last tap is still going through. Wait a moment, then tap Pay again. You will not pay twice.'

/**
 * Claim this tap's key, in one insert: a second tap with the same key finds
 * the first one's purchase, or that it is still running. Keyed by the card
 * customer too, so one shopper's key is nobody else's.
 */
async function claimPay(customerId: string, key: string, now: Date): Promise<Claim> {
  const id = `till_pay:${customerId}:${key}`
  const existing = await prisma.processedEvent.findUnique({ where: { id } })
  if (existing) {
    if (existing.orderId) return { kind: 'resume', id, orderId: existing.orderId, at: existing.processedAt }
    if (now.getTime() - existing.processedAt.getTime() < CLAIM_IN_FLIGHT_MS) return { kind: 'busy', id }
    // A tap that died before it bought anything: this one starts afresh.
    await claimAfresh(id, now)
    return { kind: 'fresh', id }
  }
  try {
    await prisma.processedEvent.create({ data: { id, rail: 'stripe', processedAt: now } })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { kind: 'busy', id }
    throw err
  }
  return { kind: 'fresh', id }
}

/**
 * What an earlier tap with this key bought, carried on as a retry carries it
 * (resumePurchase), or a refusal: never a new purchase. Read only, so asking
 * twice claims nothing. Under whichever card customer this browser holds
 * claimed it: the page may have closed before a sign-in.
 */
async function resumeOnly(input: PayTillInput, deps: TillDeps): Promise<Resumed> {
  const now = nowOf(deps)
  if (!input.key) throw new TillError('closed', NOTHING_FROM_THAT_TAP)
  const existing = await claimedUnder(input.key, [input.customerId, ...(input.otherCustomerIds ?? [])])
  if (existing === null) throw new TillError('closed', NOTHING_FROM_THAT_TAP)
  if (existing.orderId === null) {
    if (now.getTime() - existing.at.getTime() < CLAIM_IN_FLIGHT_MS) throw new TillError('still_going', STILL_GOING)
    throw new TillError('closed', NOTHING_FROM_THAT_TAP)
  }
  const resumed = await resumePurchase(existing.orderId, existing.at, { ...input, customerId: existing.customerId }, deps)
  if (resumed === null) throw new TillError('closed', NOTHING_FROM_THAT_TAP)
  return resumed
}

/** The claim of this key under the first of these card customers that has one, or null. */
async function claimedUnder(
  key: string,
  customerIds: readonly string[],
): Promise<{ customerId: string; orderId: string | null; at: Date } | null> {
  for (const customerId of customerIds) {
    const row = await prisma.processedEvent.findUnique({ where: { id: `till_pay:${customerId}:${key}` } })
    if (row !== null) return { customerId, orderId: row.orderId, at: row.processedAt }
  }
  return null
}

async function claimAfresh(id: string, now: Date): Promise<void> {
  await prisma.processedEvent.update({ where: { id }, data: { orderId: null, processedAt: now } })
}

async function pointClaim(id: string, orderId: string): Promise<void> {
  await prisma.processedEvent.update({ where: { id }, data: { orderId } })
}

async function dropClaim(id: string | null): Promise<void> {
  if (id !== null) await prisma.processedEvent.deleteMany({ where: { id } })
}

/**
 * The purchase an earlier tap with this key made, carried on: its holds made
 * sure of, and the first code not yet settled sent again (card 1's, unless
 * the cards before it have gone through). `ended` when no code is left to
 * show, with its handle, so the phone can keep it: that tap's purchase went
 * through. Null when that purchase ended with nothing held, so this tap may
 * buy afresh.
 */
async function resumePurchase(orderId: string, claimedAt: Date, input: PayTillInput, deps: TillDeps): Promise<Resumed | null> {
  const now = nowOf(deps)
  const row = await prisma.orderEvent.findFirst({
    where: { orderId, reason: { startsWith: `${PURCHASE_MARKER}|` } },
    orderBy: { createdAt: 'desc' },
  })
  const [, legsRaw, totalRaw] = row?.reason?.split('|') ?? []
  const legs = (legsRaw ?? '')
    .split('~')
    .map((pair) => pair.split(':'))
    .filter((p): p is [string, string] => p.length === 2 && p[0] !== '' && p[1] !== '')
    .map(([o, i]) => ({ orderId: o, intentId: i }))
  const totalCents = Number(totalRaw)
  if (legs.length === 0 || !Number.isSafeInteger(totalCents) || totalCents <= 0) return null

  const orders = await Promise.all(legs.map((l) => prisma.order.findUnique({ where: { id: l.orderId } })))
  if (orders.some((o) => o === null || parseHoldRef(o.paymentRef)?.customerId !== input.customerId)) {
    throw new TillError('closed', 'That purchase is not this card\'s. Nothing was charged.')
  }
  const live = orders as Order[]
  const ref: PurchaseRef = {
    legs,
    customerId: input.customerId,
    merchantId: live[0]?.merchantId ?? input.merchantId,
    totalCents,
    expiresAt: new Date(now.getTime() + PURCHASE_REF_TTL_SEC * 1000),
  }
  const ended = async (): Promise<Resumed> => ({
    kind: 'ended',
    ref,
    plan: { ...(await planOf(ref)), preference: routePreference(input.preference) },
    message: ALREADY_ENDED,
  })
  // NEVER RACE THE TAP THAT IS STILL RUNNING. Until card 1 is open, the
  // first tap may be holding its cards right now, and two hold calls on one
  // order at once can cancel each other's hold. It may also be unwinding a
  // purchase whose deposit was declined, or buying its drains-only second
  // try, while the key still points at the purchase it is undoing: that
  // purchase reads as ended with nothing held, and a retry used to buy
  // afresh beside the second try, two purchases for one total. So whatever
  // its cards say, a young claim whose card 1 is not open is still going.
  // Once it has had time to finish or die, whatever it left unheld is held
  // here, and a purchase it left with nothing held may be bought afresh.
  const first = live[0]?.state
  if (
    first !== OrderState.fulfilling &&
    first !== OrderState.fulfilled &&
    now.getTime() - claimedAt.getTime() < CLAIM_IN_FLIGHT_MS
  ) {
    throw new TillError('still_going', STILL_GOING)
  }

  if (!live.some((o) => o.state === OrderState.paid || o.state === OrderState.fulfilling)) {
    return live.some((o) => o.state === OrderState.fulfilled) ? await ended() : null
  }

  const unheld = live.flatMap((order, i) => (order.state === OrderState.paid && legs[i] ? [{ order, legRef: legs[i] }] : []))
  if (unheld.length > 0) {
    const held = await holdEverything(ref, unheld, now)
    if (held.problem !== null) throw holdFailure(held.problem.kind === 'failed' ? held.problem.code : 'declined', 0)
  }
  const at = await firstOpenLeg(ref)
  if (at === null) return await ended()
  return {
    kind: 'paid',
    paid: { ref, plan: { ...(await planOf(ref)), preference: routePreference(input.preference) }, code: await showLeg(ref, at, deps) },
  }
}

/**
 * The first card of a purchase not yet settled: its code on screen, or never
 * shown. A card that went through, or whose hold is kept, or that is being
 * settled, is past. Null when every card is.
 */
async function firstOpenLeg(ref: PurchaseRef): Promise<number | null> {
  for (const [i, legRef] of ref.legs.entries()) {
    const order = await prisma.order.findUnique({ where: { id: legRef.orderId } })
    if (order?.state === OrderState.paid) return i + 1
    if (order?.state !== OrderState.fulfilling) continue
    const intent = await prisma.intent.findUnique({ where: { id: legRef.intentId } })
    if (intent?.state === 'executing' && intent.matchedOrderId === order.id && decodeRevealMarker(intent.failureReason) !== null) {
      return i + 1
    }
  }
  return null
}

// ===========================================================================
// One code at a time
// ===========================================================================

/** The store's own 2D code, drawn here, or null. Loaded only when needed and allowed to fail, as the reveal route does. */
async function pdf417For(merchantId: string, payload: string): Promise<string | null> {
  try {
    if (barcodeProfileFor(merchantId).format !== 'PKBarcodeFormatPDF417') return null
    const { pdf417Svg } = await import('../barcode/pdf417')
    return pdf417Svg(payload)
  } catch {
    return null
  }
}

/** A code just opened, or sent again: what the screen's LegCode is made from. */
interface OpenCode {
  scanIndex: number
  legRef: PurchaseLegRef
  payload: string
  expiresAt: Date
}

/** A leg's code, as the screen draws it. `events`: the purchase's, read after the open; read here when not given. */
async function legCode(ref: PurchaseRef, open: OpenCode, events?: PurchaseEvents): Promise<LegCode> {
  const ev = events ?? (await PurchaseEvents.read([open.legRef.orderId]))
  const leg = ev.spendLeg(open.legRef.orderId)
  return {
    scanIndex: open.scanIndex,
    scanOf: ref.legs.length,
    coversCents: leg?.appliedCents ?? 0,
    leftoverCents: leg?.leftoverCents ?? 0,
    depositCents: ev.liveDeposit(open.legRef.orderId)?.cents ?? 0,
    barcode: open.payload,
    pdf417: await pdf417For(ref.merchantId, open.payload),
    expiresAt: open.expiresAt.toISOString(),
    silenceIsSale: !hasPublicBalanceLookup(ref.merchantId),
  }
}

/**
 * Open card `scanIndex`'s code. Its hold was placed at Pay, so the open adopts
 * it. `placed`: that hold as its create answered, in this same request, so
 * the open checks the answer instead of reading the hold back. `goLive`: Pay's
 * other holds, which card 1 waits on before it goes live (holdEverything).
 */
async function openLeg(
  ref: PurchaseRef,
  scanIndex: number,
  deps: TillDeps,
  opts: { placed?: Extract<PlaceHoldOutcome, { ok: true }> | null; goLive?: Promise<boolean> } = {},
): Promise<OpenCode> {
  const legRef = ref.legs[scanIndex - 1]
  if (!legRef) throw new TillError('closed', 'There is no such card in this purchase.')
  const out = await openReveal({
    intentId: legRef.intentId,
    vault: vaultOf(deps),
    proof: { intentId: legRef.intentId, orderId: legRef.orderId, escrowFunded: true, matched: true },
    balanceReader: readerOf(deps, ref.merchantId),
    verifiedCustomerId: ref.customerId,
    ...(opts.placed ? { placedHold: opts.placed.intent } : {}),
    ...(opts.goLive ? { goLive: opts.goLive } : {}),
    now: nowOf(deps),
  })
  switch (out.result) {
    case 'revealed':
      return { scanIndex, legRef, payload: out.barcodePayload, expiresAt: out.expiresAt }
    case 'refused_refunded':
    case 'refused_refund_failed':
      throw new TillError('unavailable', 'That card could not be used, so nothing was charged for it.')
    case 'hold_failed':
      throw holdFailure(out.code, 0)
    case 'denied':
      throw new TillError('closed', out.reason)
  }
}

/**
 * Card `scanIndex`'s code, however it stands: opened now when it was never
 * shown, sent again while its window is live (an answer that never reached
 * the phone), or opened again once that window has closed. `known`: its
 * order as the caller read it a moment ago, so the same row is not read
 * twice in one request.
 */
async function showLeg(ref: PurchaseRef, scanIndex: number, deps: TillDeps, known?: Order | null): Promise<LegCode> {
  const legRef = ref.legs[scanIndex - 1]
  if (!legRef) throw new TillError('closed', 'There is no such card in this purchase.')
  const order = known !== undefined ? known : await prisma.order.findUnique({ where: { id: legRef.orderId } })
  if (order?.state === OrderState.fulfilled) {
    throw new TillError('closed', 'This card already went through. Check Account for what was charged.')
  }
  if (order && order.state !== OrderState.paid && order.state !== OrderState.fulfilling) {
    throw new TillError('closed', 'This card was released, so nothing was charged for it.')
  }
  if (order?.state === OrderState.fulfilling) {
    const again = await resendOpenCode({
      intentId: legRef.intentId,
      orderId: legRef.orderId,
      vault: vaultOf(deps),
      verifiedCustomerId: ref.customerId,
      now: nowOf(deps),
    })
    if (again.result === 'revealed') return legCode(ref, { scanIndex, legRef, payload: again.barcodePayload, expiresAt: again.expiresAt })
    const intent = await prisma.intent.findUnique({ where: { id: legRef.intentId } })
    const window = intent?.state === 'executing' ? decodeRevealMarker(intent.failureReason) : null
    if (window === null || !revealWindowClosed(window, nowOf(deps))) throw new TillError('closed', again.reason)
  }
  return legCode(ref, await openLeg(ref, scanIndex, deps))
}

/**
 * The card at this place worked: settle it as worked, through the same
 * settle the shop uses. A card already settled (a retried tap) is left as it
 * is. A settle that cannot decide yet (a balance read that failed) is the
 * stale sweep's; the next code still opens.
 */
async function settleWorked(ref: PurchaseRef, legRef: PurchaseLegRef, deps: TillDeps): Promise<void> {
  const intent = await prisma.intent.findUnique({ where: { id: legRef.intentId } })
  if (!intent || intent.state !== 'executing' || intent.matchedOrderId !== legRef.orderId) return
  const window = decodeRevealMarker(intent.failureReason)
  if (window === null) return
  // Written first, as the settle route writes it, so a retry decides on it.
  await recordRegisterAnswer(legRef.orderId, 'yes', window.opens)
  await settleReveal({
    intentId: legRef.intentId,
    vault: vaultOf(deps),
    proof: { intentId: legRef.intentId, orderId: legRef.orderId, escrowFunded: true, matched: true },
    balanceReader: readerOf(deps, ref.merchantId),
    buyerConfirmation: true,
    now: nowOf(deps),
  })
}

/** Close every code after `scanIndex` that was never shown, and release a deposit no used card stands behind. */
async function closeLaterLegs(ref: PurchaseRef, scanIndex: number, now: Date): Promise<void> {
  await closeUnshownLater(ref, scanIndex, now)
  await releaseUnusedDeposits(ref)
}

/** Every code after `scanIndex` that was never shown, closed with nothing charged. Their orders are read in one query. */
async function closeUnshownLater(ref: PurchaseRef, scanIndex: number, now: Date): Promise<void> {
  const later = ref.legs.slice(scanIndex)
  if (later.length === 0) return
  const orders = new Map((await prisma.order.findMany({ where: { id: { in: later.map((l) => l.orderId) } } })).map((o) => [o.id, o]))
  for (const legRef of later) {
    const order = orders.get(legRef.orderId)
    if (order?.state === OrderState.paid) {
      await closeUnshownCode(order, 'the register did not need this card, so it was never shown and nothing was charged for it', {
        now,
        source: 'inline',
      })
    }
  }
}

/**
 * A deposit on a card whose code ended without being used stands behind
 * nothing. The purchase's orders and events are read once (or taken as the
 * caller just read them), and a deposit is looked for only on one that
 * closed with nothing used. True when one was released, or tried: the read
 * no longer says what the deposits are.
 */
async function releaseUnusedDeposits(ref: PurchaseRef, read?: PurchaseRead): Promise<boolean> {
  const { orders, events } = read ?? (await readPurchase(ref))
  let moved = false
  for (const legRef of ref.legs) {
    const o = orders.get(legRef.orderId)
    if (!o || (o.state !== OrderState.refunded && o.state !== OrderState.failed)) continue
    if (events.liveDeposit(legRef.orderId) === null) continue
    moved = true
    await returnDeposit(legRef.orderId, { why: 'its card was never used', source: 'inline' }).catch((err: unknown) =>
      console.warn(`[till] ${legRef.orderId}: deposit left to the hold sweep: ${String(err).slice(0, 200)}`),
    )
  }
  return moved
}

function checkIndex(ref: PurchaseRef, scanIndex: number): PurchaseLegRef {
  const legRef = Number.isInteger(scanIndex) ? ref.legs[scanIndex - 1] : undefined
  if (!legRef) throw new TillError('closed', 'There is no such card in this purchase.')
  return legRef
}

/**
 * Next: the card on screen worked; settle it and open the next one.
 *
 * BOTH AT ONCE. The card that worked and the next card are different orders,
 * and the next card's hold was placed at Pay, so its code does not wait on
 * the first card's capture. The settle still runs to the end before this
 * answers; one that fails is the hold sweep's to finish (silence counts as
 * worked), and never keeps the next code off the screen. A Next whose answer
 * was lost finds the next code already open and sends it again.
 */
export async function nextCardTill(ref: PurchaseRef, scanIndex: number, deps: TillDeps = {}): Promise<LegCode> {
  const legRef = checkIndex(ref, scanIndex)
  if (scanIndex >= ref.legs.length) throw new TillError('closed', 'That was the last card. Tap Done.')
  const next = async (): Promise<LegCode> => {
    // Closed while the shopper waited (the hold sweep closes a code never shown
    // after half an hour): said as that, not as the card's state.
    const nextOrder = await prisma.order.findUnique({ where: { id: ref.legs[scanIndex]?.orderId ?? '' } })
    if (nextOrder && nextOrder.state !== OrderState.paid && nextOrder.state !== OrderState.fulfilling) {
      throw new TillError('closed', 'The next card was released because it was not used in time. Nothing was charged for it.')
    }
    // The row just read: showLeg does not read it again.
    return showLeg(ref, scanIndex + 1, deps, nextOrder)
  }
  const [settled, code] = await Promise.allSettled([settleWorked(ref, legRef, deps), next()])
  if (settled.status === 'rejected') {
    console.warn(`[till] ${legRef.orderId}: settle left to the hold sweep: ${String(settled.reason).slice(0, 200)}`)
  }
  if (code.status === 'rejected') throw code.reason
  return code.value
}

/**
 * Done: the card at `scanIndex` was the last one the register needed. It is
 * settled as worked, and any card after it ("Register says paid") is closed
 * without ever being shown.
 */
export async function doneCardTill(ref: PurchaseRef, scanIndex: number, deps: TillDeps = {}): Promise<TillReceipt> {
  const legRef = checkIndex(ref, scanIndex)
  const now = nowOf(deps)
  // The card that worked, and the cards after it the register never needed: different orders, settled at once.
  await Promise.all([settleWorked(ref, legRef, deps), closeUnshownLater(ref, scanIndex, now)])
  // Then the deposits, from every card as both left it: a settle that closed
  // its card with nothing used frees the deposit too. One read answers the
  // deposits and the receipt, unless a deposit moved in between.
  const read = await readPurchase(ref)
  const moved = await releaseUnusedDeposits(ref, read)
  return receiptFor(ref, moved ? undefined : read)
}

/** Is this order's hold kept behind a card that did not work, rather than taken? And until what. */
async function keptState(order: Order): Promise<KeptHold['until'] | null> {
  if (order.state !== OrderState.fulfilling) return null
  const kept = await prisma.orderEvent.count({
    where: { orderId: order.id, reason: { startsWith: KEPT_HOLD_EVENT_PREFIX } },
  })
  return kept > 0 ? 'next_shopper' : null
}

/**
 * What the purchase came to: what the cards that worked cost, the deposit
 * still held, and what is held for a card that did not work.
 *
 * A KEPT HOLD IS NOT A PAYMENT. At a store nobody can check, a card that did
 * not work keeps its hold while the next shopper, or a person, shows the
 * truth (barcode/unscanned.ts), and its order stays open. Counted as paid, a
 * failed $18.90 card read "Paid $65.82" for a $52.13 total. It is said on its
 * own line instead, with its deposit, if it had one.
 *
 * WHAT A DEPOSIT PAID IS A PAYMENT. A card that covered more than its hold
 * (a total that went up, a read that found more used) was paid partly from
 * the deposit at its release, and leaving that out called the extra free.
 */
export async function receiptFor(ref: PurchaseRef, read?: PurchaseRead): Promise<TillReceipt> {
  const { orders, events } = read ?? (await readPurchase(ref))
  let paid = 0
  let applied = 0
  let deposit = 0
  let kept = 0
  for (const legRef of ref.legs) {
    const order = orders.get(legRef.orderId)
    if (!order || (order.state !== OrderState.fulfilling && order.state !== OrderState.fulfilled)) continue
    const held = events.liveDeposit(order.id)
    if (events.kept(order)) {
      kept += order.priceCents + (held?.cents ?? 0)
      continue
    }
    paid += events.billed(order) + events.depositTaken(order.id)
    applied += events.spendLeg(order.id)?.appliedCents ?? 0
    deposit += held?.cents ?? 0
  }
  return { paidCents: paid, savedCents: Math.max(0, applied - paid), depositCents: deposit, keptCents: kept }
}

/**
 * The purchase's cards as the screens show them, as they stand now: what
 * each covers, costs and leaves, and the deposit behind it. A card closed
 * without being shown is left out: it is back on sale and was never part of
 * what the register took.
 */
async function planOf(ref: PurchaseRef, read?: PurchaseRead): Promise<RoutePlan> {
  const { orders, events } = read ?? (await readPurchase(ref))
  const legs: Leg[] = []
  for (const [i, legRef] of ref.legs.entries()) {
    const order = orders.get(legRef.orderId)
    const spend = events.spendLeg(legRef.orderId)
    if (!order || !spend || order.state === OrderState.refunded || order.state === OrderState.failed) continue
    const remainder = events.remainderOf(order.id) !== null
    legs.push({
      ref: String(i + 1),
      source: remainder ? 'remainder' : 'fresh',
      firstInLine: remainder,
      faceCents: spend.appliedCents + spend.leftoverCents,
      appliedCents: spend.appliedCents,
      // What this card is charged: its bill, and what its deposit paid when the total went up.
      costCents: events.billed(order) + events.depositTaken(order.id),
      leftoverCents: spend.leftoverCents,
      depositCents: events.liveDeposit(order.id)?.cents ?? 0,
      scanIndex: i + 1,
      scanOf: ref.legs.length,
    })
  }
  const costCents = legs.reduce((n, l) => n + l.costCents, 0)
  const applied = legs.reduce((n, l) => n + l.appliedCents, 0)
  return {
    rail: 'card',
    merchant: ref.merchantId,
    totalCents: ref.totalCents,
    legs,
    costCents,
    savingCents: Math.max(0, applied - costCents),
    depositCents: legs.reduce((n, l) => n + l.depositCents, 0),
    uncoveredCents: 0,
    preference: routePreference(null),
    quoteRef: `card:${ref.merchantId}:${ref.totalCents}`,
    expiresAt: ref.expiresAt.toISOString(),
  }
}

// ===========================================================================
// When a card does not work
// ===========================================================================

/** What is still owed after the cards before `scanIndex`, which worked. */
function owedAfter(ref: PurchaseRef, scanIndex: number, totalCents: number, read: PurchaseRead): number {
  let covered = 0
  for (const legRef of ref.legs.slice(0, scanIndex - 1)) {
    const order = read.orders.get(legRef.orderId)
    if (order?.state === OrderState.fulfilling || order?.state === OrderState.fulfilled) {
      covered += read.events.spendLeg(order.id)?.appliedCents ?? 0
    }
  }
  return totalCents - covered
}

/**
 * The cards of a purchase whose code was shown: the ones a plan for what is
 * still owed leaves out. A card closed without being shown went straight back
 * on sale as it was, so it is planned again like any other: leaving it out
 * refused a rest it could cover. A card whose hold is kept stays out twice
 * over: it is shown, and its own shopper is never routed to it. So does one
 * the shopper was told not to scan and that went back on sale: "Use other
 * cards" means other cards.
 */
export async function shownLegIntentIds(ref: Pick<PurchaseRef, 'legs'>, read?: PurchaseRead): Promise<string[]> {
  const { orders, events } = read ?? (await readPurchase(ref))
  const out: string[] = []
  for (const legRef of ref.legs) {
    const order = orders.get(legRef.orderId)
    if (order?.state === OrderState.fulfilling || order?.state === OrderState.fulfilled) out.push(legRef.intentId)
    // Was its code ever on screen: did it ever reach `fulfilling`?
    else if (order && events.everShown(legRef.orderId)) out.push(legRef.intentId)
  }
  return out
}

/** "Something went wrong?" after a card was settled: taken, and a person looks. */
const PROBLEM_NOTED =
  'Got it. A person will look at this card within a day. If we took too much, it goes back on your card.'

/** How long after a purchase "Something went wrong?" is open: as long as its handle lasts. */
const PROBLEM_WINDOW_MS = PURCHASE_REF_TTL_SEC * 1000

export interface TillReport {
  owed: Owed
  /** What the register still needs after the cards that worked. */
  owedCents: number
  /** The hold kept for the card reported, or null. */
  kept: KeptHold | null
  /** The sentence for a report on a card already settled, or null. */
  note: string | null
}

/**
 * Something went wrong with the card at `scanIndex` (spec 5.4).
 *
 *   on screen, it did not work   settled as a No: at Target and Walmart the
 *   (didnt_scan, declined)       hold is kept and the card goes to the next
 *                                shopper first (open decision 2); where the
 *                                balance can be read, the read decides.
 *   on screen, not to be used    a No for a code the shopper must not
 *   (not_used)                   scan: the total came down past what can stay
 *                                on the card. It tests nothing, so on a card
 *                                someone else stands behind (a remainder, a
 *                                kept hold) only this shopper's hold is
 *                                decided, and the card goes back on sale as it
 *                                was listed (unscanned.ts decideBlindNo).
 *   settled, a remainder empty   inside its two hours: the deposit rule, after
 *                                the fact. The register took it, so nothing
 *                                more is owed.
 *   settled, any other problem   recorded for a person, inside 48 hours.
 *
 * For a card on screen, every later code is then closed, never shown, and
 * what is still owed is planned again, leaving out only the cards that were
 * shown. Null owed when nothing is.
 */
export async function reportCardTill(
  ref: PurchaseRef,
  scanIndex: number,
  outcome: ReportOutcome,
  preference: RoutePreference | null,
  deps: TillDeps = {},
): Promise<TillReport> {
  const legRef = checkIndex(ref, scanIndex)
  const now = nowOf(deps)

  if (outcome === 'problem') return reportProblem(ref, scanIndex, legRef, now)
  if (outcome === 'empty') {
    // Settled already, so the register took it and the shopper paid there.
    // Only a remainder can be reported empty, inside its two hours, and
    // nothing more is owed: their hold for it is released, and the deposit
    // decides.
    if (await reportRemainderEmpty(legRef.orderId, { now })) {
      return {
        owed: null,
        owedCents: 0,
        kept: null,
        note: `Got it. Your hold for card ${scanIndex} is released, and nothing is charged for it.`,
      }
    }
    throw new TillError(
      'closed',
      'This card can no longer be reported empty. If something else went wrong, tell us from the receipt.',
    )
  }

  const intent = await prisma.intent.findUnique({ where: { id: legRef.intentId } })
  const window =
    intent?.state === 'executing' && intent.matchedOrderId === legRef.orderId ? decodeRevealMarker(intent.failureReason) : null
  let order = await prisma.order.findUnique({ where: { id: legRef.orderId } })
  if (!order) throw new TillError('closed', 'There is no such card in this purchase.')

  const kept0 = window === null ? await keptState(order) : null
  if (window !== null) {
    const failure: RegisterNo | null =
      outcome === 'didnt_scan' || outcome === 'declined' || outcome === 'not_used' ? outcome : null
    await recordRegisterAnswer(legRef.orderId, 'no', window.opens, failure)
    await settleReveal({
      intentId: legRef.intentId,
      vault: vaultOf(deps),
      proof: { intentId: legRef.intentId, orderId: legRef.orderId, escrowFunded: true, matched: true },
      balanceReader: readerOf(deps, ref.merchantId),
      buyerReportsFailure: true,
      ...(failure ? { failure } : {}),
      now,
    })
    order = (await prisma.order.findUnique({ where: { id: legRef.orderId } })) ?? order
  } else if (order.state === OrderState.fulfilled || (order.state === OrderState.fulfilling && kept0 === null)) {
    // Settled as worked, or being settled: the register took it.
    throw new TillError(
      'closed',
      'This card went through, so it cannot be reported here. If something went wrong, tell us from the receipt.',
    )
  }
  // Otherwise the card already ended as reported: a report whose answer was
  // lost. Nothing is settled again; what is owed is worked out again below.

  const until = await keptState(order)
  const kept: KeptHold | null =
    until === null ? null : { cents: order.priceCents + ((await liveDepositFor(order.id))?.cents ?? 0), until }

  await closeLaterLegs(ref, scanIndex, now)
  // What is owed, and the cards to leave out of planning it, from one read.
  const read = await readPurchase(ref)
  const owed = owedAfter(ref, scanIndex, ref.totalCents, read)
  if (owed <= 0) return { owed: null, owedCents: 0, kept, note: null }
  return {
    owedCents: owed,
    owed: await quoteCardTill({
      merchantId: ref.merchantId,
      totalCents: owed,
      preference,
      buyer: { customerId: ref.customerId, fingerprint: null },
      excludeIntentIds: await shownLegIntentIds(ref, read),
      now,
    }),
    kept,
    note: null,
  }
}

/**
 * "Something went wrong?" for a card already settled, inside 48 hours: the
 * register took less than we billed, or more, or anything else. Recorded on
 * the card's order as the shopper's account of it (a failure, tier 3), and a
 * person is told now with the purchase in hand. Settlement is not re-opened:
 * a person decides, as the reveal's own "tell us what happened" does.
 */
async function reportProblem(ref: PurchaseRef, scanIndex: number, legRef: PurchaseLegRef, now: Date): Promise<TillReport> {
  const order = await prisma.order.findUnique({ where: { id: legRef.orderId } })
  if (!order || (order.state !== OrderState.fulfilled && order.state !== OrderState.fulfilling)) {
    throw new TillError('closed', 'Nothing was charged for this card, so there is nothing to put right.')
  }
  if (now.getTime() - order.createdAt.getTime() > PROBLEM_WINDOW_MS) {
    throw new TillError('closed', 'This purchase is more than 48 hours old, so it can no longer be reported here.')
  }
  await recordBuyerEvidence({
    orderId: order.id,
    claim: 'failed',
    statement: `reported from the till receipt, card ${scanIndex} of ${ref.legs.length}`,
    now,
  })
  await pushOperator({
    title: '[ACTION NEEDED] till shopper reports a problem with a card',
    message: [
      `order ${order.id} (card ${scanIndex} of ${ref.legs.length} at ${ref.merchantId}), ${order.state}`,
      `charged: ${await billedCents(order)}c of ${order.priceCents}c`,
      `purchase total: ${ref.totalCents}c`,
      'The shopper says something went wrong after it was settled. Check the card and the charge, and refund by hand if we owe them.',
    ].join('\n'),
    priority: 4,
    tags: ['warning'],
  })
  return { owed: null, owedCents: 0, kept: null, note: PROBLEM_NOTED }
}

// ===========================================================================
// When the register total changes after Pay (spec 5.4)
// ===========================================================================

export interface TillChange {
  /** What is still owed, planned: "Add $X". Null when nothing more is owed. */
  plan: Owed
  /** The purchase as it stands now, with its new total. */
  ref: PurchaseRef
  /** The same, signed, for the phone to present next. */
  refText: string
  /** The purchase's cards as they stand now. */
  purchasePlan: RoutePlan
  /** The card on screen as it now covers, or null when none is on screen. */
  cover: LegCover | null
  /** The total came down past what can stay on the card on screen: it must not be scanned. */
  tooLow: boolean
  /** Too low, and the cards before it already cover the new total: the screen offers Done, not other cards. */
  notNeeded: boolean
}

interface LegNow {
  legRef: PurchaseLegRef
  scanIndex: number
  order: Order
  appliedCents: number
  leftoverCents: number
}

/** The legs whose code has been shown and not ended, in scan order. */
async function shownLegs(ref: PurchaseRef): Promise<LegNow[]> {
  const out: LegNow[] = []
  for (const [i, legRef] of ref.legs.entries()) {
    const order = await prisma.order.findUnique({ where: { id: legRef.orderId } })
    if (!order || (order.state !== OrderState.fulfilling && order.state !== OrderState.fulfilled)) continue
    const leg = await spendLegFor(order.id)
    out.push({ legRef, scanIndex: i + 1, order, appliedCents: leg?.appliedCents ?? 0, leftoverCents: leg?.leftoverCents ?? 0 })
  }
  return out
}

/** Is this leg's code on screen now: its window open on its own order? */
async function onScreen(leg: LegNow): Promise<boolean> {
  const intent = await prisma.intent.findUnique({ where: { id: leg.legRef.intentId } })
  return (
    intent !== null &&
    intent.state === 'executing' &&
    intent.matchedOrderId === leg.order.id &&
    leg.order.state === OrderState.fulfilling &&
    decodeRevealMarker(intent.failureReason) !== null
  )
}

/**
 * What the card on screen covers now, as the screen shows it. The deposit is
 * what will stand behind the leftover: after a total that went up, the one
 * held still holds the old, larger leftover until the release charges the
 * extra from it and holds one for what is left.
 */
async function coverOf(leg: LegNow): Promise<LegCover> {
  const spend = await spendLegFor(leg.order.id)
  const leftoverCents = spend?.leftoverCents ?? leg.leftoverCents
  return {
    scanIndex: leg.scanIndex,
    coversCents: spend?.appliedCents ?? leg.appliedCents,
    leftoverCents,
    // A leftover too small to list again has nothing behind it, as at Pay.
    depositCents:
      leftoverCents >= REMAINDER_RELIST_MIN_CENTS ? Math.min(leftoverCents, (await liveDepositFor(leg.order.id))?.cents ?? 0) : 0,
  }
}

/**
 * The register total is now `totalCents`.
 *
 *   codes not shown yet     closed: never shown, holds released, cards back on
 *                           sale. What the shown cards do not cover is
 *                           planned again ("Add $X").
 *   up, part-used card on   its leftover is used first, as far as the new
 *   screen                  total needs. Its price is charged from the
 *                           shopper's own deposit, which held it at face,
 *                           only once the card has worked (the release does
 *                           it). Any more is one more card.
 *   down, a card on screen  it covers less: it is billed less, and its
 *                           deposit is replaced by one for the larger
 *                           leftover, while that leftover fits the cap.
 *                           Beyond the cap the card must not be scanned:
 *                           `tooLow`, and the screen offers other cards.
 */
export async function changeCardTill(
  ref: PurchaseRef,
  totalCents: number,
  preference: RoutePreference | null,
  secret: string,
  deps: TillDeps = {},
): Promise<TillChange> {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new TillError('closed', 'Enter the new total.')
  const now = nowOf(deps)
  const anyUnshown = (
    await Promise.all(ref.legs.map((l) => prisma.order.findUnique({ where: { id: l.orderId }, select: { state: true } })))
  ).some((o) => o?.state === OrderState.paid)
  if (anyUnshown) await closeLaterLegs(ref, 0, now)

  const shown = await shownLegs(ref)
  const covered = shown.reduce((n, l) => n + l.appliedCents, 0)
  const last = shown[shown.length - 1]
  const live = last !== undefined && (await onScreen(last)) ? last : null
  let owed = totalCents - covered
  const moved: PurchaseRef = { ...ref, totalCents }
  const finish = async (plan: Owed, tooLow = false, notNeeded = false): Promise<TillChange> => ({
    plan,
    ref: moved,
    refText: mintPurchaseRef(moved, secret, now),
    purchasePlan: await planOf(moved),
    cover: live ? await coverOf(live) : null,
    tooLow,
    notNeeded: tooLow && notNeeded,
  })

  // Up, with the part-used card still on screen: use its rest first, as far
  // as the new total needs. Once it has gone through at the old total, the
  // rest is one more card instead.
  if (owed > 0 && live && live.leftoverCents > 0) {
    const used = Math.min(owed, live.leftoverCents)
    if ((await reviseLeg(ref, live, live.appliedCents + used, now)) === null) owed -= used
  }
  // Down: the card on screen covers less.
  if (owed < 0) {
    if (!live) throw new TillError('closed', 'No card is on screen. Start again with the new total.')
    const why = await reviseLeg(ref, live, live.appliedCents + owed, now)
    // The cards before this one already cover the new total: it is not
    // needed at all, and the screen says Done rather than "other cards".
    const notNeeded = live.appliedCents + owed <= 0
    if (why === TOO_LOW && notNeeded) return finish({ unavailable: TOO_LOW_NOT_NEEDED }, true, true)
    if (why !== null) return finish({ unavailable: why }, why === TOO_LOW || why === USED_WHOLE)
    owed = 0
  }

  if (owed <= 0) return finish(null)
  return finish(
    await quoteCardTill({
      merchantId: ref.merchantId,
      totalCents: owed,
      preference,
      buyer: { customerId: ref.customerId, fingerprint: null },
      excludeIntentIds: await shownLegIntentIds(ref),
      now,
    }),
  )
}

/** The total came down past what can stay on the card on screen. The screen offers other cards. */
const TOO_LOW =
  'The total came down by more than we can leave on this card. Do not scan it. Tap Use other cards.'

/**
 * The card on screen has someone else's money behind it (a remainder's
 * deposit, or a kept hold from a scan that did not go through), so it is
 * used in full or not at all.
 */
const USED_WHOLE = 'This card has to be used in full, so it cannot cover less. Do not scan it. Tap Use other cards.'

/** The total came down to what the cards before this one cover: it is not needed. */
const TOO_LOW_NOT_NEEDED = 'The cards before this one already cover the new total. Do not scan it. Tap Done.'

/** A hold kept on another shopper's order, from a scan that did not go through, stands behind this card. */
async function keptHoldBehind(leg: LegNow): Promise<boolean> {
  const row = await prisma.orderEvent.findFirst({
    where: {
      reason: keptHoldEventReason(leg.legRef.intentId),
      orderId: { not: leg.order.id },
      order: { state: OrderState.fulfilling },
    },
    select: { id: true },
  })
  return row !== null
}

/**
 * The card on screen now covers `appliedCents`. Null when done, or a sentence
 * for the shopper when it cannot be.
 *
 *   covers more   by using its leftover. NOTHING IS TAKEN NOW: the register
 *                 has not taken the card yet, and it may never (a card that
 *                 will not scan, a total lowered again). The shopper's own
 *                 deposit, which held the leftover at face, stays as it is;
 *                 the release charges the price of the extra from it once the
 *                 card has worked, holding a deposit for what is still left
 *                 first (reveal-service.ts releaseTillLeg). Taken here, it was
 *                 money nothing ever gave back.
 *   covers less   billed less, in one partial capture at its release, and a
 *                 deposit at face for the larger leftover held before the old
 *                 one is released. A deposit that already holds that much
 *                 (one kept from a total that went up first) stays.
 *
 * Only while the card's own window is undecided: once its release has
 * captured, nothing about it can change here.
 */
async function reviseLeg(ref: PurchaseRef, leg: LegNow, appliedCents: number, now: Date): Promise<string | null> {
  const intent = await prisma.intent.findUnique({ where: { id: leg.legRef.intentId } })
  const spend = await spendLegFor(leg.order.id)
  if (!(await onScreen(leg)) || spend === null || intent === null) {
    return 'That card has already gone through. If the total was different, tell us from the receipt.'
  }
  const card = spend.appliedCents + spend.leftoverCents
  const leftover = card - appliedCents
  if (appliedCents <= 0 || leftover < 0 || leftover > capForMerchant(ref.merchantId)) return TOO_LOW

  const priceThen = legCostCents(appliedCents, intent.priceCents, intent.faceValueCents)
  const deposit = await liveDepositFor(leg.order.id)

  if (appliedCents > spend.appliedCents) {
    // The extra is paid from the deposit at release, so there must be one.
    if (deposit === null) return 'We could not use the rest of this card. Add another card instead.'
  } else {
    // A card first in line is used whole, never split (route/plan.ts): the
    // money behind it is someone else's, and covering less would leave them
    // standing behind a leftover they never agreed to.
    if ((await remainderOfFor(leg.order.id)) !== null || (await keptHoldBehind(leg))) return USED_WHOLE
    // Covers less: a deposit for the larger leftover, held before the old goes.
    if (leftover >= REMAINDER_RELIST_MIN_CENTS && (deposit === null || deposit.cents < leftover)) {
      const placed = await placeBondHold(
        leg.order,
        {
          customerId: ref.customerId,
          intentId: intent.id,
          cents: leftover,
          ...(deposit ? { replaces: deposit.paymentIntentId } : {}),
        },
        now,
      )
      if (!placed.ok) return `We could not hold ${money(leftover)} on your card for the rest of this card. Tap Use other cards.`
      await recordDepositHold(leg.order, { paymentIntentId: placed.pi, cents: leftover })
      if (deposit) {
        await releaseBondHold(deposit.paymentIntentId, 'inline').catch((err: unknown) =>
          console.warn(`[till] ${leg.order.id}: old deposit left to the hold sweep: ${String(err).slice(0, 200)}`),
        )
      }
    }
    await recordBill(leg.order, priceThen)
  }
  await recordSpendLeg(leg.order, {
    appliedCents,
    index: spend.index,
    of: spend.of,
    leftoverCents: leftover,
  })
  return null
}
