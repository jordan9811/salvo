/**
 * The card till's handle on one purchase, held by the phone that paid
 * (unified-account spec 5.1, `Purchase.ref`).
 *
 * ===========================================================================
 * WHY A SIGNED HANDLE AND NOT A TABLE. A purchase is one order per card, and
 * nothing in the database groups them: adding that would be a migration. So
 * Pay hands back the orders and cards, in scan order, signed with our secret,
 * and every later step (Next, Done, a report, a new total) presents it. The
 * signature stops anyone naming orders that are not theirs; the card customer
 * it is bound to stops a handle copied to another browser from acting,
 * because the route also requires that browser's own card customer to match.
 *
 *   tp2.<orderId:intentId~...>.<customerTag>.<merchant>.<totalCents>.<expSec>.<sig>
 *
 * THE CUSTOMER IS IN IT AS A TAG, NEVER BY ID. The handle lives in the page's
 * own script, and the card customer id is what the HttpOnly card cookie keeps
 * out of a script's reach (GET /api/card says the same). So the handle
 * carries an HMAC of the customer, under its own key, and is bound back to
 * the customer only on the server, from the browser's own cookie: a handle
 * read off a screen names no processor customer at all.
 *
 * Its own keys, HMAC(OPERATOR_SECRET, 'salvo/till-purchase/v2') and
 * '.../customer', as every signed value here has, so no other format verifies
 * as this one. It lasts 48 hours: as long as "Something went wrong?" stays
 * open on the receipt.
 * ===========================================================================
 *
 * Server only (node:crypto). Pure apart from that: the secret is passed in.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

const VERSION = 'tp2'
/** How long the handle acts on the purchase. */
export const PURCHASE_REF_TTL_SEC = 48 * 3600
/** The most cards one till purchase uses (route/plan.ts MAX_TILL_CARDS). */
const MAX_LEGS = 5
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const CUSTOMER_RE = /^cus_[A-Za-z0-9]+$/
const TAG_RE = /^[A-Za-z0-9_-]{22}$/
const MERCHANT_RE = /^[a-z]{1,32}$/

export interface PurchaseLegRef {
  orderId: string
  intentId: string
}

export interface PurchaseRef {
  /** In scan order. */
  legs: PurchaseLegRef[]
  customerId: string
  merchantId: string
  totalCents: number
  expiresAt: Date
}

const keyFor = (secret: string, purpose: string): Buffer => createHmac('sha256', secret).update(`salvo/till-purchase/v2${purpose}`).digest()

function signed(secret: string, body: string): string {
  return createHmac('sha256', keyFor(secret, '')).update(`salvo-till-purchase|${body}`).digest('base64url')
}

/** The customer, as the handle names it: 128 bits of an HMAC, never the id. */
function customerTag(secret: string, customerId: string): string {
  return createHmac('sha256', keyFor(secret, '/customer')).update(customerId).digest('base64url').slice(0, 22)
}

/** Sign a purchase for the phone that paid. Throws on anything that is not a well-formed purchase. */
export function mintPurchaseRef(p: Omit<PurchaseRef, 'expiresAt'>, secret: string, now: Date = new Date()): string {
  if (p.legs.length === 0 || p.legs.length > MAX_LEGS) throw new Error('a purchase is 1 to 5 cards')
  for (const l of p.legs) {
    if (!ID_RE.test(l.orderId) || !ID_RE.test(l.intentId)) throw new Error('not an order or card id')
  }
  if (!CUSTOMER_RE.test(p.customerId) || !MERCHANT_RE.test(p.merchantId)) throw new Error('not a purchase')
  if (!Number.isSafeInteger(p.totalCents) || p.totalCents <= 0) throw new Error('not a total')
  const exp = Math.floor(now.getTime() / 1000) + PURCHASE_REF_TTL_SEC
  const legs = p.legs.map((l) => `${l.orderId}:${l.intentId}`).join('~')
  const body = [VERSION, legs, customerTag(secret, p.customerId), p.merchantId, String(p.totalCents), String(exp)].join('.')
  return `${body}.${signed(secret, body)}`
}

/** What a handle we signed says, before it is bound to a customer. */
export interface UnboundPurchaseRef {
  legs: PurchaseLegRef[]
  merchantId: string
  totalCents: number
  expiresAt: Date
  /** The customer, as an HMAC: compared, never read (`bindPurchaseRef`). */
  customerTag: string
}

/** The purchase a handle names, or null for anything we did not sign, or that has run out. */
export function verifyPurchaseRef(value: string, secret: string, now: Date = new Date()): UnboundPurchaseRef | null {
  if (typeof value !== 'string' || value.length > 1_000) return null
  const parts = value.split('.')
  if (parts.length !== 7) return null
  const [version, legsRaw, tag, merchantId, totalRaw, expRaw, sig] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  const expect = Buffer.from(signed(secret, parts.slice(0, 6).join('.')), 'utf8')
  const got = Buffer.from(sig, 'utf8')
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null
  if (version !== VERSION || !TAG_RE.test(tag) || !MERCHANT_RE.test(merchantId)) return null
  if (!/^\d{1,9}$/.test(totalRaw) || !/^\d{1,12}$/.test(expRaw)) return null
  const exp = Number(expRaw)
  const t = Math.floor(now.getTime() / 1000)
  if (exp <= t || exp > t + PURCHASE_REF_TTL_SEC + 60) return null
  const legs: PurchaseLegRef[] = []
  for (const pair of legsRaw.split('~')) {
    const [orderId, intentId, ...rest] = pair.split(':')
    if (!orderId || !intentId || rest.length > 0 || !ID_RE.test(orderId) || !ID_RE.test(intentId)) return null
    legs.push({ orderId, intentId })
  }
  if (legs.length === 0 || legs.length > MAX_LEGS) return null
  return { legs, merchantId, totalCents: Number(totalRaw), expiresAt: new Date(exp * 1000), customerTag: tag }
}

/**
 * The purchase, for the card customer this browser pays with, or null when
 * the handle was minted for another. The id comes from the browser's own
 * cookie, never from the handle.
 */
export function bindPurchaseRef(unbound: UnboundPurchaseRef, customerId: string, secret: string): PurchaseRef | null {
  if (!CUSTOMER_RE.test(customerId)) return null
  const expect = Buffer.from(customerTag(secret, customerId), 'utf8')
  const got = Buffer.from(unbound.customerTag, 'utf8')
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null
  return {
    legs: unbound.legs,
    customerId,
    merchantId: unbound.merchantId,
    totalCents: unbound.totalCents,
    expiresAt: unbound.expiresAt,
  }
}
