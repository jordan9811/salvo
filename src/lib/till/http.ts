/**
 * What every /api/card/till/* route shares: the body, the payer, the
 * purchase handle, and one way to say no.
 *
 * ===========================================================================
 * EVERY STEP AFTER PAY IS THE SAME TWO CHECKS. The purchase handle must be
 * one we signed (purchase.ts), and this browser must hold the card customer
 * inside it: the one it pays with now (src/lib/hold/account.ts readPayer),
 * or another it still holds (browserCustomers): a purchase made before this
 * browser signed in, or before it saved its card to the account, is still
 * its own. A handle copied out of one phone can neither show a code nor
 * settle one on another.
 *
 * ONLY OUR OWN PAGE. A POST from another site is refused before anything is
 * read (fromOurOwnPage), as every escrow and account write is.
 * ===========================================================================
 *
 * Server only. The sentences here reach a shopper's screen, so none of them
 * names the card processor.
 */

import { NextResponse } from 'next/server'
import { apiError, errorToResponse } from '../api'
import { env } from '../env'
import { readAccountSession } from '../account/session'
import { fromOurOwnPage } from '../escrow/http'
import { hasBarcodeProfile } from '../barcode/merchants'
import { browserCustomers, cardRailHere, readPayer } from '../hold/account'
import { readCardCookie } from '../hold/cookie'
import { railLiveness } from '../fake-fulfilment-guard'
import { routePreference, type RoutePreference } from '../route/plan'
import { bindPurchaseRef, verifyPurchaseRef, type PurchaseRef } from './purchase'
import { TillError, type TillFailure } from './card-till'

const NO_STORE = { 'Cache-Control': 'no-store' }

/** A till answer, never cached. */
export function tillJson<T>(body: T, status = 200): NextResponse<T> {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

const STATUS: Readonly<Record<TillFailure, number>> = {
  card_required: 409,
  over_allowance: 409,
  hold_closed: 503,
  declined: 402,
  needs_bank_check: 402,
  deposit_declined: 402,
  try_again: 502,
  still_going: 409,
  unavailable: 409,
  closed: 409,
}

/** A refusal the screen keys on. Anything else is a fixed sentence, never an error's text. */
export function tillFailure(err: unknown): NextResponse {
  if (err instanceof TillError) return apiError(STATUS[err.code], err.code, err.message)
  console.warn(`[till] ${String(err).slice(0, 300)}`)
  return errorToResponse(err)
}

export type TillBody = { ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }

/** The JSON body of a till POST from our own page, or the refusal to send back. */
export async function readTillBody(req: Request): Promise<TillBody> {
  if (!fromOurOwnPage(req)) return { ok: false, response: apiError(403, 'cross_site', 'Pay from our own page.') }
  if (!cardRailHere()) {
    return {
      ok: false,
      response: apiError(503, 'card_rail_off', 'We cannot take card payments here right now. Nothing was charged.'),
    }
  }
  try {
    const body: unknown = await req.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, response: apiError(400, 'invalid_body', 'That request could not be read.') }
    }
    return { ok: true, body: body as Record<string, unknown> }
  } catch {
    return { ok: false, response: apiError(400, 'invalid_json', 'That request could not be read.') }
  }
}

/** The store a body names, when it is one we have barcodes for. */
export function storeOf(body: Record<string, unknown>): string | null {
  const s = typeof body.store === 'string' ? body.store.toLowerCase().trim() : ''
  return /^[a-z]{1,32}$/.test(s) && hasBarcodeProfile(s) ? s : null
}

/** A total in whole cents, $0.01 to $10,000. */
export function totalOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 1_000_000 ? v : null
}

/** The shopper's setting, as the planner takes it. A malformed one is the default, never a refusal. */
export function preferenceOf(body: Record<string, unknown>): RoutePreference {
  const p = body.preference
  return routePreference(typeof p === 'object' && p !== null ? (p as { mode?: unknown; maxCards?: unknown }) : null)
}

/**
 * The card customer behind this browser for a quote, without asking the card
 * processor: the session's when it names one on a test key, else the card
 * cookie's. Only steers routing, so a miss costs nothing.
 */
export function quoteBuyer(req: Request): { customerId: string; fingerprint: null } | null {
  const session = readAccountSession(req)
  const fromSession = session?.customerId && railLiveness('stripe') === 'test' ? session.customerId : null
  const customerId = fromSession ?? readCardCookie(req)
  return customerId ? { customerId, fingerprint: null } : null
}

/** The card customer that pays for this browser, or the refusal to send back. */
export async function payerOf(req: Request): Promise<{ ok: true; customerId: string } | { ok: false; response: NextResponse }> {
  const payer = await readPayer(req)
  if (payer.customerId === null) {
    return {
      ok: false,
      response: apiError(409, 'card_required', 'Save a card in Account first. Nothing is charged until a code works.'),
    }
  }
  return { ok: true, customerId: payer.customerId }
}

/**
 * The purchase this body names, paid for by this browser's own card
 * customer, or the refusal. `field` is where the handle is in the body.
 */
export async function purchaseOf(
  req: Request,
  body: Record<string, unknown>,
  field = 'purchase',
): Promise<{ ok: true; ref: PurchaseRef; secret: string } | { ok: false; response: NextResponse }> {
  const secret = env().OPERATOR_SECRET
  if (!secret) return { ok: false, response: apiError(503, 'till_unavailable', 'We cannot open codes right now. Nothing was charged.') }
  const raw = body[field]
  const unbound = typeof raw === 'string' ? verifyPurchaseRef(raw, secret) : null
  if (unbound === null) {
    return { ok: false, response: apiError(401, 'bad_purchase', 'This purchase has timed out. Check your account for what was charged.') }
  }
  const payer = await payerOf(req)
  if (!payer.ok) return payer
  // The handle names its customer only as a tag; the id is this browser's own:
  // the one it pays with now, else another it still holds.
  let ref = bindPurchaseRef(unbound, payer.customerId, secret)
  for (const other of ref === null ? await otherCustomersOf(req, payer.customerId) : []) {
    ref = bindPurchaseRef(unbound, other, secret)
    if (ref !== null) break
  }
  if (ref === null) {
    return { ok: false, response: apiError(403, 'card_not_here', 'Open this on the phone you paid with. Nothing was charged here.') }
  }
  return { ok: true, ref, secret }
}

/** The card customers this browser holds besides the one that pays now (browserCustomers). */
export async function otherCustomersOf(req: Request, payer: string): Promise<string[]> {
  return (await browserCustomers(req)).filter((c) => c !== payer)
}

/** The place of a card in the purchase, from 1. */
export function scanIndexOf(body: Record<string, unknown>): number | null {
  const v = body.scanIndex
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5 ? v : null
}
