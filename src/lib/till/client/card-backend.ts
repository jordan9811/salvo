/**
 * The card rail's backend for the till (unified-account spec 5.1): fetches
 * to /api/card/till/* and nothing else.
 *
 * ===========================================================================
 * FETCH ONLY, BY RULE. Everything under src/app/pay must work with no card
 * processor in reach (tests/escrow-no-stripe.test.ts walks it), so the card
 * side of the till is our server's: it holds the shopper's card, opens each
 * code, and answers here in plain JSON. This module imports nothing under
 * src/lib/hold and names no processor setting.
 *
 * THE PHONE NEVER KNOWS WHO THE SHOPPER IS TO THE PROCESSOR. The card is
 * named by an HttpOnly cookie, and a purchase by a signed handle the server
 * made, which names the customer only as an HMAC (src/lib/till/purchase.ts).
 * Neither is read here; both are passed back.
 *
 * NO ANSWER IS NOT "NOTHING WAS CHARGED". A request can reach the server and
 * act, and its answer still be lost on store signal: Pay can have held every
 * card and opened card 1. So a dropped connection says we could not tell,
 * and the screen asks again the same way (Pay with the same key), which
 * finds what the first request did rather than doing it twice.
 * ===========================================================================
 *
 * Browser only by use; pure of React. Tests pass their own fetch.
 */

import type {
  ChangeAnswer,
  EndedPurchase,
  KeptHold,
  LegCode,
  LegCover,
  Owed,
  PaymentMethod,
  Purchase,
  PurchaseHandle,
  ReportAnswer,
  ReportOutcome,
  Requote,
  RoutePlan,
  RoutePreference,
  TillBackend,
  TillReceipt,
  Unavailable,
} from '../types'
import { NO_ANSWER, TillRefused } from './refused'

// The till's refusals are the same on both rails (refused.ts); named here too, as the card rail always has.
export { NO_ANSWER, STILL_GOING, TillRefused } from './refused'

type Fetch = (input: string, init?: RequestInit) => Promise<Response>
const NETWORK_PAY = 'We could not tell if that went through. Tap Pay again: you will not pay twice.'
const NETWORK = 'We could not tell if that went through. Try again.'
/** The account could not be read: the till asks again, and Pay stays open. */
const COULD_NOT_CHECK = 'We could not check your card just now.'

/**
 * The server errors our own till routes send only once nothing is left held,
 * or before anything was done: the tap is over, and the next one is new. Any
 * other server error, ours or a gateway's in front of us, says nothing about
 * what the request did.
 */
const ENDED_SERVER_ERRORS: ReadonlySet<string> = new Set(['hold_closed', 'try_again', 'card_rail_off', 'till_unavailable'])

function noAnswer(path: string, status: number): TillRefused {
  return new TillRefused(NO_ANSWER, path === 'pay' ? NETWORK_PAY : NETWORK, status)
}

/**
 * ===========================================================================
 * ONLY A REFUSAL THE TILL SENT ENDS A TAP. A body cut off on store signal, a
 * gateway's own page, or a server error with no till code of ours is no
 * answer, whatever its status: Pay can still have held every card and
 * opened card 1. Read as a refusal, it said "Nothing was charged", the phone
 * dropped the key, and the next tap bought a second time.
 * ===========================================================================
 */
async function post(fetcher: Fetch, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetcher(`/api/card/till/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
  } catch {
    throw noAnswer(path, 0)
  }
  const parsed: unknown = await res.json().catch(() => null)
  const json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  // A quote acts on nothing: it is said as before, and the screen asks again.
  if (json === null && path !== 'quote') throw noAnswer(path, res.status)
  if (!res.ok || json === null) {
    const code = typeof json?.error === 'string' ? json.error : null
    if (path !== 'quote' && (code === null || (res.status >= 500 && !ENDED_SERVER_ERRORS.has(code)))) {
      throw noAnswer(path, res.status)
    }
    const message = typeof json?.message === 'string' ? json.message : 'Something went wrong on our side. Nothing was charged.'
    throw new TillRefused(code ?? 'failed', message, res.status)
  }
  return json
}

const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null

function unavailableOf(json: Record<string, unknown>): Unavailable | null {
  if (typeof json.unavailable !== 'string') return null
  return json.nothingListed === true ? { unavailable: json.unavailable, nothingListed: true } : { unavailable: json.unavailable }
}

function owedOf(json: Record<string, unknown>): Owed {
  return unavailableOf(json) ?? (json.plan as RoutePlan | null | undefined) ?? null
}

const cents = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

function receiptOf(v: unknown): TillReceipt {
  const r = (typeof v === 'object' && v !== null ? v : {}) as Partial<TillReceipt>
  return { paidCents: cents(r.paidCents), savedCents: cents(r.savedCents), depositCents: cents(r.depositCents), keptCents: cents(r.keptCents) }
}

function keptOf(v: unknown): KeptHold | null {
  const k = (typeof v === 'object' && v !== null ? v : null) as Partial<KeptHold> | null
  if (k === null || k.until !== 'next_shopper') return null
  return { cents: cents(k.cents), until: k.until }
}

function coverOf(v: unknown): LegCover | null {
  const c = (typeof v === 'object' && v !== null ? v : null) as Partial<LegCover> | null
  if (c === null || typeof c.scanIndex !== 'number') return null
  return { scanIndex: c.scanIndex, coversCents: cents(c.coversCents), leftoverCents: cents(c.leftoverCents), depositCents: cents(c.depositCents) }
}

/** What GET /api/account says about paying by card. */
interface AccountCard {
  cardRail?: unknown
  card?: { brand?: unknown; last4?: unknown } | null
  cardKnown?: unknown
  heldCents?: unknown
  allowanceCents?: unknown
}

export function cardBackend(fetcher: Fetch = (input, init) => fetch(input, init)): TillBackend {
  return {
    rail: 'card',

    async method(): Promise<PaymentMethod> {
      let view: AccountCard
      try {
        const res = await fetcher('/api/account', { cache: 'no-store' })
        if (!res.ok) throw new Error(String(res.status))
        view = (await res.json()) as AccountCard
      } catch {
        return { ready: false, label: 'Card', spendableCents: 0, problem: COULD_NOT_CHECK, checked: false }
      }
      const last4 = typeof view.card?.last4 === 'string' ? view.card.last4 : null
      const label = last4 ? `card •••• ${last4}` : 'card'
      if (view.cardRail !== true) {
        return { ready: false, label, spendableCents: 0, problem: 'Card payments are off here right now.', checked: true, setUp: false }
      }
      if (view.cardKnown === false) {
        return { ready: false, label, spendableCents: 0, problem: COULD_NOT_CHECK, checked: false }
      }
      if (last4 === null) {
        return { ready: false, label, spendableCents: 0, problem: 'Save a card in Account to pay here.', checked: true, setUp: false }
      }
      const allowance = typeof view.allowanceCents === 'number' ? view.allowanceCents : 0
      const held = typeof view.heldCents === 'number' ? view.heldCents : 0
      return { ready: true, label, spendableCents: Math.max(0, allowance - held), problem: null, checked: true, setUp: true }
    },

    async quote(a: { merchant: string; totalCents: number; preference: RoutePreference }) {
      const json = await post(fetcher, 'quote', { store: a.merchant, totalCents: a.totalCents, preference: a.preference })
      return unavailableOf(json) ?? (json.plan as RoutePlan)
    },

    async prepare(): Promise<void> {
      // The card rail plans again at Pay; there is nothing to fetch ahead.
    },

    async pay(plan: RoutePlan, opts: { after?: Purchase; key?: string; resume?: boolean } = {}): Promise<Purchase | Requote | EndedPurchase> {
      const json = await post(fetcher, 'pay', {
        store: plan.merchant,
        totalCents: plan.totalCents,
        preference: plan.preference,
        // What the button said: the server buys nothing past it.
        quoted: { costCents: plan.costCents, cards: plan.legs.length, depositCents: plan.depositCents },
        quoteRef: plan.quoteRef,
        ...(opts.key ? { key: opts.key } : {}),
        ...(opts.key && opts.resume ? { resume: true } : {}),
        ...(opts.after ? { after: opts.after.ref } : {}),
      })
      if (typeof json.requote === 'object' && json.requote !== null) {
        return {
          requote: json.requote as RoutePlan,
          message: typeof json.message === 'string' ? json.message : 'The price changed. Nothing was charged.',
        }
      }
      // A Pay answer with no purchase in it is no answer: the tap may have bought one.
      if (typeof json.purchase !== 'string' || !isObject(json.plan) || (json.ended !== true && !isObject(json.code))) {
        throw noAnswer('pay', 200)
      }
      if (json.ended === true) {
        return {
          ended: { rail: 'card', ref: String(json.purchase), plan: json.plan as RoutePlan },
          receipt: receiptOf(json.receipt),
          message: typeof json.message === 'string' ? json.message : 'That Pay already went through. It is in Account.',
        }
      }
      return { rail: 'card', ref: String(json.purchase), plan: json.plan as RoutePlan, code: json.code as LegCode }
    },

    async next(p: Purchase, scanIndex: number): Promise<LegCode> {
      const json = await post(fetcher, 'next', { purchase: p.ref, scanIndex })
      return json.code as LegCode
    },

    async done(p: Purchase, scanIndex: number): Promise<TillReceipt> {
      const json = await post(fetcher, 'done', { purchase: p.ref, scanIndex })
      return receiptOf(json.receipt)
    },

    async report(p: PurchaseHandle, scanIndex: number, o: ReportOutcome): Promise<ReportAnswer> {
      const json = await post(fetcher, 'report', { purchase: p.ref, scanIndex, outcome: o, preference: p.plan.preference })
      return {
        owed: owedOf(json),
        owedCents: cents(json.owedCents),
        receipt: receiptOf(json.receipt),
        kept: keptOf(json.kept),
        note: typeof json.note === 'string' ? json.note : null,
      }
    },

    async changeTotal(p: Purchase, totalCents: number): Promise<ChangeAnswer> {
      const json = await post(fetcher, 'change', { purchase: p.ref, totalCents, preference: p.plan.preference })
      // The purchase's cards as they stand now, under the shopper's own setting.
      const plan: RoutePlan =
        typeof json.purchasePlan === 'object' && json.purchasePlan !== null
          ? { ...(json.purchasePlan as RoutePlan), preference: p.plan.preference }
          : { ...p.plan, totalCents }
      const purchase: Purchase = { ...p, ref: typeof json.purchase === 'string' ? json.purchase : p.ref, plan }
      return {
        purchase,
        owed: owedOf(json),
        cover: coverOf(json.cover),
        tooLow: json.tooLow === true,
        notNeeded: json.tooLow === true && json.notNeeded === true,
      }
    },

    async receipt(p: PurchaseHandle): Promise<TillReceipt> {
      const json = await post(fetcher, 'receipt', { purchase: p.ref })
      return receiptOf(json.receipt)
    },
  }
}
