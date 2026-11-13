/**
 * The escrow routes' shared HTTP pieces: the rail switch, the same-origin
 * check, strict JSON bodies, answers, and per-process rate limits.
 *
 * NOT src/lib/api.ts. That module maps Stripe's errors, so it imports the
 * Stripe client, and nothing on this rail may reach it (spec invariant 12).
 * The answer shape is the same: `{ error, message }` with a stable code and a
 * sentence a person can act on, and never an exception's own text.
 *
 * NO PLAINTEXT CARD FIELD, ANYWHERE. Every escrow POST names the exact keys it
 * takes and refuses any other, and refuses any key, at any depth, that is
 * named like card material. The seller's page seals the card in the browser
 * and the shopper's phone opens it; neither ever sends it here (spec
 * invariant 8, review condition 5).
 *
 * Server-only. Reads process.env directly, never src/lib/env.ts.
 */

import { NextResponse } from 'next/server'
import { ChipotleNotConfiguredError, ChipotleRequestError } from '@/lib/vault/lit/errors'
import { ESCROW_RAIL_OFF_SENTENCE, escrowRailOn } from './rail'
import { EscrowRpcError } from './runbook/rpc'

/** No escrow request body is anywhere near this. A manifest is at most 2 KB and an envelope well under 1 KB. */
const MAX_BODY_CHARS = 16_384

/**
 * Key names that could only be card material. Compared without case and
 * without `_` or `-`. A body carrying one is refused whole, so a page that
 * starts sending the card by mistake fails loudly instead of quietly.
 */
const PLAINTEXT_KEYS: ReadonlySet<string> = new Set([
  'card',
  'cardnumber',
  'number',
  'pan',
  'pin',
  'cvv',
  'cvc',
  'plaintext',
  'secret',
  'barcode',
  'accountnumber',
  'giftcard',
  'code',
])

export interface EscrowErrorBody {
  error: string
  message: string
}

/** A JSON answer that is never cached. */
export function escrowJson<T>(body: T, status = 200): NextResponse<T> {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

/** `message` is trimmed, so a sentence built with an empty "nothing was done" part ends cleanly. */
export function escrowError(status: number, error: string, message: string): NextResponse<EscrowErrorBody> {
  return escrowJson({ error, message: message.trim() }, status)
}

/**
 * The answer for a thrown error. Lit and the chain being unreachable are
 * named, because a person can wait them out; anything else is ours, said
 * plainly, and only its name is logged: never its text, which can carry a
 * query, a host's reply or a body.
 */
export function escrowFailure(err: unknown, route: string, nothingDone: string): NextResponse<EscrowErrorBody> {
  if (err instanceof ChipotleNotConfiguredError) {
    return escrowError(503, 'lit_unavailable', `The card service is not set up here. ${nothingDone}`)
  }
  if (err instanceof ChipotleRequestError) {
    return escrowError(502, 'lit_unavailable', `We cannot reach the card service right now. Try again in a minute. ${nothingDone}`)
  }
  if (err instanceof EscrowRpcError) {
    return escrowError(503, 'chain_unavailable', `We cannot read the chain right now. Try again in a minute. ${nothingDone}`)
  }
  console.error(`[escrow] ${route} failed: ${err instanceof Error ? err.name : 'unknown error'}`)
  return escrowError(500, 'internal_error', `Something went wrong on our side. ${nothingDone}`)
}

/**
 * The answer while the rail is off: 503 and one plain sentence, plus what the
 * request did not do. Null when the rail is on.
 */
export function escrowRailClosed(nothingDone: string): NextResponse<EscrowErrorBody> | null {
  if (escrowRailOn()) return null
  return escrowError(503, 'escrow_rail_off', `${ESCROW_RAIL_OFF_SENTENCE} ${nothingDone}`)
}

/**
 * Did one of our own pages start this request? The same rule as the card
 * routes (src/app/api/card/setup/route.ts): a browser says where a request
 * came from in Sec-Fetch-Site and Origin, and a page cannot set either. A
 * request with neither (a script, a test) is not a browser on another site.
 */
export function fromOurOwnPage(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin') return false
  const origin = req.headers.get('origin')
  if (origin === null) return true
  try {
    // The same default src/lib/env.ts gives APP_URL, so both rails agree on
    // what "our own page" is. An empty or malformed value refuses everything.
    return origin === new URL(process.env.APP_URL ?? 'http://localhost:3000').origin
  } catch {
    return false
  }
}

const normKey = (k: string): string => k.toLowerCase().replace(/[_-]/g, '')

/** The first key, at any depth, that is named like card material, or null. */
export function plaintextKeyIn(value: unknown, depth = 0): string | null {
  if (depth > 8 || typeof value !== 'object' || value === null) return null
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = plaintextKeyIn(v, depth + 1)
      if (hit !== null) return hit
    }
    return null
  }
  for (const [k, v] of Object.entries(value)) {
    if (PLAINTEXT_KEYS.has(normKey(k))) return k
    const hit = plaintextKeyIn(v, depth + 1)
    if (hit !== null) return hit
  }
  return null
}

export type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse<EscrowErrorBody> }

/**
 * The request's JSON object, if it came from our own page, is JSON, is small,
 * has exactly `required` plus any of `optional` as keys, and carries nothing
 * named like card material. Anything else is the refusal to send back.
 */
export async function readEscrowBody(
  req: Request,
  required: readonly string[],
  optional: readonly string[] = [],
  nothingDone = 'Nothing was charged.',
): Promise<BodyResult> {
  const refuse = (status: number, error: string, message: string): BodyResult => ({
    ok: false,
    response: escrowError(status, error, message),
  })
  if (!fromOurOwnPage(req)) return refuse(403, 'cross_site', `Use Salvo Pay from our own page. ${nothingDone}`)
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return refuse(415, 'invalid_content_type', 'Request body must be JSON')
  }
  // Refused before it is read, when the sender says how big it is.
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_CHARS * 4) {
    return refuse(413, 'too_large', 'That request is too large.')
  }
  let text: string
  try {
    text = await req.text()
  } catch {
    return refuse(400, 'invalid_json', 'Request body must be valid JSON')
  }
  if (text.length > MAX_BODY_CHARS) return refuse(413, 'too_large', 'That request is too large.')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return refuse(400, 'invalid_json', 'Request body must be valid JSON')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return refuse(400, 'invalid_body', 'Request body must be a JSON object')
  }
  // Card material first, so the refusal says the thing that matters most.
  const named = plaintextKeyIn(body)
  if (named !== null) {
    return refuse(
      400,
      'plaintext_refused',
      `This request carried a field named "${named.slice(0, 40)}". Card details never leave your device. ${nothingDone}`,
    )
  }
  const o = body as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  const extra = Object.keys(o).filter((k) => !allowed.has(k))
  const missing = required.filter((k) => !(k in o))
  if (extra.length > 0 || missing.length > 0) {
    return refuse(400, 'invalid_body', `This request must carry exactly: ${required.join(', ')}.`)
  }
  return { ok: true, body: o }
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/**
 * Who sent this request, as far as our proxy says: the key for a per-address
 * limit, never shown and never stored. An IPv6 address counts as its /64.
 *
 * Railway's edge sets X-Real-IP to the address it took the connection from;
 * without it, the first X-Forwarded-For entry. If the edge passes a client's
 * own header through, a script can pick its key here. That is why every paid
 * step also has a process-wide budget (LitRunBudget) that no header changes:
 * the per-address limit stops one noisy client early, and the budget is what
 * bounds what anyone can spend.
 */
export function clientAddress(req: Request): string {
  const real = (req.headers.get('x-real-ip') ?? '').trim()
  const first = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? ''
  const raw = real !== '' ? real : first
  return raw === '' ? 'direct' : addressKey(raw.slice(0, 64))
}

/**
 * The key one client's limits share. An IPv6 address is cut to its /64: one
 * home or phone line is given a whole /64, and picks any address in it, so
 * keying on the full address would give one client billions of limits. Any
 * other text (IPv4, or something the proxy wrote that is neither) is used as
 * it is.
 */
function addressKey(a: string): string {
  const s = (a.replace(/^\[|\]$/g, '').split('%')[0] ?? '').toLowerCase()
  if (!s.includes(':') || s.includes('.') || !/^[0-9a-f:]+$/.test(s)) return a
  const halves = s.split('::')
  if (halves.length > 2) return a
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':')
  const tail = halves.length === 2 && halves[1] !== '' && halves[1] !== undefined ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return a
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return a
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`
}

/**
 * A fixed-window counter per key, in this process. Keyed only on things the
 * caller cannot pick freely (its address as the proxy saw it, a deposit the
 * chain recorded, a quote this process gave), never on a value from the body.
 */
export class WindowLimiter {
  readonly #hits = new Map<string, { start: number; count: number }>()
  readonly #limit: number
  readonly #windowMs: number

  constructor(limit: number, windowMs: number) {
    this.#limit = limit
    this.#windowMs = windowMs
  }

  /** Count one use of `key` at `now`. False when the key is over its limit in this window. */
  take(key: string, now: number): boolean {
    const w = this.#hits.get(key)
    if (w === undefined || now - w.start >= this.#windowMs) {
      if (this.#hits.size > 10_000) this.#sweep(now)
      this.#hits.set(key, { start: now, count: 1 })
      return true
    }
    if (w.count >= this.#limit) return false
    w.count += 1
    return true
  }

  #sweep(now: number): void {
    for (const [k, w] of this.#hits) if (now - w.start >= this.#windowMs) this.#hits.delete(k)
  }
}

export type LitRunKind = 'ticket' | 'release'

interface BudgetWindow {
  ms: number
  total: number
  /** Most of `total` tickets may take, so a flood of tickets never starves a paid shopper's release. */
  tickets: number
  start: number
  usedTickets: number
  usedReleases: number
}

/**
 * Every paid Lit run this process makes, tickets and releases together, per
 * minute and per day. Each run costs about 3 to 7 cents of our Lit credit,
 * and a script can ask for runs as fast as it likes, so this is the hard cap
 * on what anyone can spend, whatever headers or addresses it sends.
 *
 * TICKETS NEVER TAKE THE WHOLE BUDGET. A release is what a shopper who has
 * already paid is waiting on (spec section 8.11), so part of each window is
 * kept for releases: a ticket flood can stop new Loads for a while, never a
 * paid card.
 */
export class LitRunBudget {
  readonly #windows: BudgetWindow[]

  constructor(windows: ReadonlyArray<{ ms: number; total: number; tickets: number }>) {
    this.#windows = windows.map((w) => ({ ...w, start: Number.NEGATIVE_INFINITY, usedTickets: 0, usedReleases: 0 }))
  }

  /** Spend one run of `kind` at `now`. False, and nothing spent, when any window is full for it. */
  take(kind: LitRunKind, now: number): boolean {
    for (const w of this.#windows) {
      if (now - w.start >= w.ms) {
        w.start = now
        w.usedTickets = 0
        w.usedReleases = 0
      }
      const used = w.usedTickets + w.usedReleases
      if (used >= w.total) return false
      if (kind === 'ticket' && w.usedTickets >= w.tickets) return false
    }
    for (const w of this.#windows) {
      if (kind === 'ticket') w.usedTickets += 1
      else w.usedReleases += 1
    }
    return true
  }
}

/**
 * The one budget both routes spend from. 30 runs a minute and 1,500 a day,
 * at most $105 a day at the top of Lit's price; a testnet with a few testers
 * uses a small part of it. Tickets may use 20 a minute and 1,200 a day.
 */
export const litRunBudget = new LitRunBudget([
  { ms: 60_000, total: 30, tickets: 20 },
  { ms: 86_400_000, total: 1_500, tickets: 1_200 },
])
