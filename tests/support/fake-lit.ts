/**
 * FakeLit: an in-process Lit V3 for the vault tests. Test-only; never
 * referenced from src/. Tests never touch the network.
 *
 * WHAT IT IS FAITHFUL TO, because the vault depends on each of these:
 *
 *   - The request contract Lit documents for `POST /core/v1/lit_action`:
 *     POST, `X-Api-Key`, `X-Privacy-Mode: true`, no `Authorization`, and a body
 *     of exactly `code` and `js_params`. Anything else is a 400, so a client
 *     that drifts from the contract fails here rather than live.
 *   - Execution permission is per CID: a CID not in `permitted` is a 403 with
 *     the bare string body "Permission denied".
 *   - The code really runs, in `node:vm`, as `async function main(params)`,
 *     with ethers v5 as a global, WebCrypto as `crypto`, and `Lit.Actions`.
 *   - The action key is derived from the CID of the code it is handed, so a
 *     template edited by one byte gets a different key, exactly as on Lit:
 *     `getLitActionPrivateKey() = HMAC-SHA256(root, CID(code))` and
 *     `getLitActionWalletAddress({ipfsId}) = address(HMAC-SHA256(root, ipfsId))`.
 *   - The reply is `{response, logs, has_error}` over JSON.
 *   - `GET /core/v1/version` answers in the live shape, with the release
 *     number in `commit_version` and the crate's "0.1.0" in `version`.
 *
 * WHAT IT IS NOT: Lit's enclave, billing, eventual consistency of grants, or
 * its real runtime's ethers minor and WebCrypto support. The live smoke settles
 * those.
 *
 * Every key operation is counted (`keyOps`), so a test can prove a gate
 * refused before any key material was touched.
 *
 * OUTBOUND FETCH (the escrow template reads the chain and store balances).
 * By default the sandbox has no `fetch`, `AbortController` or timers, exactly
 * as before, so the attested template stays proven network-free. Pass `fetch`
 * to `runInFakeLit` (or `actionFetch` to `makeFakeLit`) and the action gets
 * that fetch, `AbortController`, `setTimeout` and `clearTimeout`. Fetches are
 * counted, and the 51st throws, because Lit stops a run at 50 outbound
 * requests (`lit/lit-actions_limits.md:31`).
 *
 * STORE BALANCES (salvo-vault-escrow/2 reads a card more than once). In V2 one
 * card is sold in parts and its balance falls as each buyer uses it, so a
 * test needs a store whose balance moves. `FakeBalanceStores` answers the two
 * balance endpoints the escrow templates pin, Best Buy and Nike, in their
 * live shapes, from cards a test can spend down the way a register does. It
 * is a `fetch` for those two URLs only, combined with FakeTempoRpc's by the
 * test.
 */

import { createHmac, hkdfSync } from 'node:crypto'
import vm from 'node:vm'
import { ethers } from 'ethers'
import { litActionCid } from '@/lib/vault/lit/cid'
import { ATTESTED_V1 } from '@/lib/vault/lit/templates'

export const FAKE_LIT_ROOT = 'fake-lit-root-v1'
/** Planted in every error body and log the fake sends, so tests can prove none is echoed. */
export const FAKE_LIT_CANARY = 'canary-7d1f-lit-body'

export type FakeLitMode =
  | 'ok'
  | 'network'
  | 'hang'
  | 401
  | 402
  | 403
  | '429-then-ok'
  | '429-always'
  | 500
  | '503-then-ok'
  | 'has_error'
  | 'string-response'
  | 'errmessage-200'
  | 'html'

export interface FakeLitCall {
  method: string
  url: string
  path: string
  /** Lower-cased header names, as the Headers API reports them. */
  headers: Record<string, string>
  redirect: RequestRedirect | undefined
  bodyText: string
  status: number
  keyOps: number
}

export interface FakeLitOptions {
  root?: string
  /** The enclave's clock, in ms. Default Date.now. */
  now?: () => number
  permitted?: 'all' | string[]
  mode?: FakeLitMode
  /** The fetch every action run gets. Default: none, as before. */
  actionFetch?: typeof fetch
}

/** Timers an action sees. Tests pass quick ones so a stalled host costs milliseconds, not seconds. */
export interface FakeLitTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface FakeLitRunOptions {
  root?: string
  now?: () => number
  /** The action's outbound fetch. Absent: the sandbox has no fetch, AbortController or timers. */
  fetch?: typeof fetch
  /** Only with `fetch`. Default: Node's own timers. */
  timers?: FakeLitTimers
}

/** Lit stops a run at 50 outbound requests. */
export const FAKE_LIT_MAX_FETCHES = 50

/** The action private key Lit would derive for this CID under `root`. */
export function fakeActionKey(root: string, cid: string): string {
  return '0x' + createHmac('sha256', root).update(cid, 'utf8').digest('hex')
}

/** What the enc-key and identity helpers need from a template: its id (the HKDF info) and its CID. */
interface TemplatePins {
  id: string
  cid: string
}

/** A template's `enc` public key for its pinned CID, computed in Node. */
export function fakeEncPubFor(t: TemplatePins, root: string = FAKE_LIT_ROOT): string {
  const identity = Buffer.from(fakeActionKey(root, t.cid).slice(2), 'hex')
  const raw = Buffer.from(hkdfSync('sha256', identity, Buffer.from('salvo/vault/enc-key/v1'), Buffer.from(t.id), 32))
  return new ethers.utils.SigningKey(raw).compressedPublicKey.toLowerCase()
}

/** A template's identity address for its pinned CID. For the escrow template this is `litSigner`. */
export function fakeIdentityFor(t: TemplatePins, root: string = FAKE_LIT_ROOT): string {
  return ethers.utils.computeAddress(fakeActionKey(root, t.cid)).toLowerCase()
}

/** The attested template's `enc` public key for the pinned CID, computed in Node. */
export function fakeEncPub(root: string = FAKE_LIT_ROOT): string {
  return fakeEncPubFor(ATTESTED_V1, root)
}

/** The attested template's identity address for the pinned CID. */
export function fakeIdentity(root: string = FAKE_LIT_ROOT): string {
  return fakeIdentityFor(ATTESTED_V1, root)
}

/**
 * Run `code` the way Lit would, without HTTP. Returns the action's return
 * value, the key operations and fetches it made, and whether it threw.
 */
export async function runInFakeLit(
  code: string,
  params: unknown,
  opts: FakeLitRunOptions = {},
): Promise<{ response: unknown; keyOps: number; fetches: number; threw: boolean }> {
  const root = opts.root ?? FAKE_LIT_ROOT
  const now = opts.now ?? Date.now
  const cid = litActionCid(code)
  const counter = { n: 0 }
  const fetches = { n: 0 }

  const network: Record<string, unknown> = {}
  const outbound = opts.fetch
  if (outbound) {
    const timers = opts.timers ?? {
      setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
      clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    network.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetches.n++
      if (fetches.n > FAKE_LIT_MAX_FETCHES) throw new TypeError('fake Lit: more than 50 outbound requests in one run')
      return outbound(input, init)
    }
    network.AbortController = AbortController
    network.setTimeout = timers.setTimeout
    network.clearTimeout = timers.clearTimeout
  }

  const sandbox: Record<string, unknown> = {
    ...network,
    ethers,
    crypto: globalThis.crypto,
    Date: { now: () => now() },
    Lit: {
      Actions: {
        getLitActionPrivateKey: async (): Promise<string> => {
          counter.n++
          return fakeActionKey(root, cid)
        },
        getLitActionWalletAddress: async (args: { ipfsId: string }): Promise<string> => {
          counter.n++
          return ethers.utils.computeAddress(fakeActionKey(root, args.ipfsId))
        },
      },
    },
  }
  const context = vm.createContext(sandbox)
  try {
    vm.runInContext(code, context, { timeout: 5_000 })
    const main = sandbox.main
    if (typeof main !== 'function') throw new Error('no main')
    const response: unknown = await (main as (p: unknown) => Promise<unknown>)(params)
    return { response, keyOps: counter.n, fetches: fetches.n, threw: false }
  } catch (err) {
    return { response: err instanceof Error ? err.message : String(err), keyOps: counter.n, fetches: fetches.n, threw: true }
  }
}

/**
 * Load a template's source in a bare `node:vm` context (ethers only, no Lit,
 * no fetch) and return a reader for its top-level names, so a test can call
 * the template's own helpers or read its constants and tables. Top-level
 * `const`s are visible to later scripts in the same context, so `read("MERCHANTS")`
 * works without touching the source.
 */
export function templateScope(source: string): (expression: string) => unknown {
  const context = vm.createContext({ ethers })
  vm.runInContext(source, context, { timeout: 5_000 })
  return (expression: string): unknown => vm.runInContext(expression, context, { timeout: 5_000 })
}

function urlOf(input: string | URL | Request): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return input
  return new URL(input.url)
}

export function makeFakeLit(opts: FakeLitOptions = {}): {
  fetchImpl: typeof fetch
  calls: FakeLitCall[]
  keyOps: { count: number }
} {
  const root = opts.root ?? FAKE_LIT_ROOT
  const now = opts.now ?? Date.now
  const permitted = opts.permitted ?? 'all'
  const mode: FakeLitMode = opts.mode ?? 'ok'
  const calls: FakeLitCall[] = []
  const keyOps = { count: 0 }
  let actionCalls = 0

  const structured = (error: string): string =>
    JSON.stringify({ error, message: `fake ${FAKE_LIT_CANARY}`, fix: FAKE_LIT_CANARY, docs_url: 'https://x.invalid' })

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input)
    const headers = new Headers(init?.headers)
    const call: FakeLitCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: url.href,
      path: url.pathname,
      headers: Object.fromEntries(headers.entries()),
      redirect: init?.redirect,
      bodyText: typeof init?.body === 'string' ? init.body : '',
      status: 0,
      keyOps: 0,
    }
    calls.push(call)

    if (mode === 'network') throw new TypeError('fetch failed')
    if (mode === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }

    const reply = (status: number, body: string, type = 'application/json'): Response => {
      call.status = status
      return new Response(body, { status, headers: { 'Content-Type': type } })
    }

    if (call.path === '/core/v1/version' && call.method === 'GET') {
      // The live shape. `version` is the crate's and never changes; the
      // release number is `commit_version`, so a client reading the wrong
      // field gets "0.1.0" here too.
      return reply(
        200,
        JSON.stringify({
          name: 'lit-api-server',
          version: '0.1.0',
          commit_version: 'v1.1.15-fake',
          submodule_versions: [],
        }),
      )
    }
    if (call.path === '/core/v1/get_lit_action_ipfs_id' && call.method === 'POST') {
      const code: unknown = JSON.parse(call.bodyText || 'null')
      if (typeof code !== 'string') return reply(400, structured('bad_request'))
      return reply(200, JSON.stringify(litActionCid(code)))
    }
    if (call.path !== '/core/v1/lit_action') return reply(404, structured('not_found'))

    actionCalls++
    if (mode === 401) return reply(401, structured('invalid_api_key'))
    if (mode === 402) return reply(402, structured('insufficient_balance'))
    if (mode === 500) return reply(500, structured('internal_error'))
    if (mode === '429-always' || (mode === '429-then-ok' && actionCalls === 1)) {
      return reply(429, structured('rate_limited'))
    }
    if (mode === '503-then-ok' && actionCalls === 1) {
      return reply(503, `<html>${FAKE_LIT_CANARY}</html>`, 'text/html')
    }

    let body: unknown
    try {
      body = JSON.parse(call.bodyText)
    } catch {
      return reply(400, structured('bad_request'))
    }
    const contractHolds =
      call.method === 'POST' &&
      (headers.get('x-api-key') ?? '') !== '' &&
      headers.get('x-privacy-mode') === 'true' &&
      !headers.has('authorization') &&
      typeof body === 'object' &&
      body !== null &&
      Object.keys(body).sort().join(',') === 'code,js_params' &&
      typeof (body as { code: unknown }).code === 'string'
    if (!contractHolds) return reply(400, structured('bad_request'))

    if (mode === 403) return reply(403, JSON.stringify('Permission denied'))
    if (mode === 'errmessage-200') return reply(200, JSON.stringify(`something failed ${FAKE_LIT_CANARY}`))
    if (mode === 'html') return reply(200, `<!doctype html><p>${FAKE_LIT_CANARY}</p>`, 'text/html')

    const { code, js_params: params } = body as { code: string; js_params: unknown }
    if (permitted !== 'all' && !permitted.includes(litActionCid(code))) {
      return reply(403, JSON.stringify('Permission denied'))
    }
    if (mode === 'has_error') {
      return reply(200, JSON.stringify({ response: null, logs: `boom ${FAKE_LIT_CANARY}`, has_error: true }))
    }

    const run = await runInFakeLit(code, params, { root, now, ...(opts.actionFetch ? { fetch: opts.actionFetch } : {}) })
    call.keyOps = run.keyOps
    keyOps.count += run.keyOps
    if (run.threw) {
      return reply(200, JSON.stringify({ response: run.response, logs: `threw ${FAKE_LIT_CANARY}`, has_error: true }))
    }
    const response = mode === 'string-response' ? JSON.stringify(run.response) : run.response
    return reply(200, JSON.stringify({ response, logs: '', has_error: false }))
  }

  return { fetchImpl: impl as unknown as typeof fetch, calls, keyOps }
}

// ---------------------------------------------------------------------------- store balances

/** The two balance endpoints the escrow templates read in mode 1, exactly as the sources spell them. */
export const STORE_BALANCE_URLS = {
  bestbuy: 'https://www.bestbuy.com/payment/1.0/giftcard/balance',
  nike: 'https://api.nike.com/payment/giftcard_balance/v1/',
} as const
export type BalanceStore = keyof typeof STORE_BALANCE_URLS

export interface StoreRequest {
  store: BalanceStore
  url: string
  /** Lower-cased header names, as the Headers API reports them. */
  headers: Record<string, string>
  redirect: RequestRedirect | undefined
  body: string
}

/**
 * Best Buy's and Nike's balance endpoints over a few cards with live
 * balances. Best Buy answers `{"balance":"12.34"}` (dollars as text) and Nike
 * `{"balance":12.34}` (a number at the top of the body), as each store's own
 * page reads them. The card is the one the request names: Best Buy's
 * `cardNumber`, Nike's `accountNumber`. A card the store does not know is a 404.
 *
 * `reply` overrides a store's answer outright, for the refusal cases (a block
 * page, a body with no balance). Every request is logged, and one without
 * `redirect: "error"` throws, so a template that would follow a redirect fails here.
 */
export class FakeBalanceStores {
  readonly requests: StoreRequest[] = []
  readonly reply: Partial<Record<BalanceStore, { status: number; body: string }>> = {}
  private readonly cents = new Map<string, number>()

  /** Put `cents` on a card. */
  setBalance(store: BalanceStore, cardNumber: string, cents: number): void {
    if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('FakeBalanceStores: a balance is whole cents, not below 0')
    this.cents.set(`${store}|${cardNumber}`, cents)
  }

  /** A register taking `cents` off a card. Throws if the card has less. */
  spend(store: BalanceStore, cardNumber: string, cents: number): void {
    const have = this.balance(store, cardNumber)
    if (have === null || have < cents) throw new Error('FakeBalanceStores: the card does not have that much')
    this.cents.set(`${store}|${cardNumber}`, have - cents)
  }

  balance(store: BalanceStore, cardNumber: string): number | null {
    return this.cents.get(`${store}|${cardNumber}`) ?? null
  }

  /** The store a URL is, or null for any other URL (the caller routes it elsewhere). */
  storeOf(url: string): BalanceStore | null {
    return url === STORE_BALANCE_URLS.bestbuy ? 'bestbuy' : url === STORE_BALANCE_URLS.nike ? 'nike' : null
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const store = this.storeOf(url)
    if (store === null) throw new Error(`FakeBalanceStores: not a store balance URL: ${url}`)
    const body = typeof init?.body === 'string' ? init.body : ''
    this.requests.push({ store, url, headers: Object.fromEntries(new Headers(init?.headers).entries()), redirect: init?.redirect, body })
    if (init?.redirect !== 'error') throw new Error('FakeBalanceStores: a store fetch without redirect:"error"')
    const json = { 'Content-Type': 'application/json' }
    const fixed = this.reply[store]
    if (fixed) return new Response(fixed.body, { status: fixed.status, headers: json })
    let asked: unknown = null
    try {
      asked = JSON.parse(body)
    } catch {
      asked = null
    }
    const o = (typeof asked === 'object' && asked !== null ? asked : {}) as Record<string, unknown>
    const number = store === 'bestbuy' ? o.cardNumber : o.accountNumber
    const cents = typeof number === 'string' ? this.balance(store, number) : null
    if (cents === null) return new Response('{"error":"not found"}', { status: 404, headers: json })
    const dollars = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
    const balance = store === 'bestbuy' ? JSON.stringify({ balance: dollars }) : JSON.stringify({ balance: cents / 100 })
    return new Response(balance, { status: 200, headers: json })
  }
}
