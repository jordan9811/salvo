/**
 * The one way this codebase talks to Lit V3 ("Chipotle"): its REST API.
 *
 * Lit V3 has a single way to run code, `POST /core/v1/lit_action`, with the
 * source in `code` and the inputs in `js_params`. There is no encrypt or decrypt
 * endpoint; the vault template does that inside the run. Everything here follows
 * Lit's published OpenAPI document, and the parts it leaves open (whether
 * `response` arrives as a value or a JSON string, how a throw surfaces) are
 * accepted both ways rather than guessed.
 *
 * THE ORIGIN IS PINNED. No env var moves it: a configurable host is a way to
 * point a usage key, and the template's inputs, somewhere else.
 *
 * WHAT LEAVES THIS PROCESS: the template source, the inputs the caller built
 * (never a card in clear: the vault only ever sends ciphertext and a signed
 * attestation), the usage key in `X-Api-Key`, and `X-Privacy-Mode: true`, which
 * asks Lit to keep the inputs and the output out of its own server logs.
 *
 * WHAT NEVER COMES BACK OUT in an error: the response body, Lit's `logs`, the
 * inputs, the key. Errors carry a kind, a status and fixed text from this file,
 * plus Lit's `error` token when it looks like one. This module never logs.
 */

import { ChipotleRequestError, type ChipotleFailureKind } from './errors'

export const LIT_ORIGIN = 'https://api.chipotle.litprotocol.com'
export const LIT_NETWORK = 'api.chipotle.litprotocol.com'

const API_PREFIX = '/core/v1'
const DEFAULT_DEADLINE_MS = 15_000
/**
 * A call that may be resent gets at most this per attempt, so the resend still
 * fits in the deadline. A call that is never resent gets the whole deadline.
 */
const ATTEMPT_CAP_MS = 12_000
const MAX_BODY_CHARS = 65_536
/** 429 backoff, before jitter. Lit's OpenAPI allows up to five retries; two is plenty here. */
const RATE_LIMIT_BACKOFF_MS = [250, 1_000] as const
const RATE_LIMIT_JITTER_MS = 100
/** Retry-After is not documented by Lit. Honoured as a hint, never as a long wait. */
const RETRY_AFTER_CAP_MS = 2_000
const GATEWAY_RETRY_MS = 250
/**
 * Worth one more try for a call that may be repeated. None of them proves the
 * work behind it did not happen. A 502 or 504 comes from a gateway. Lit's 503
 * says "Nothing was charged", but a failed call is never charged, and Lit names
 * its chain RPC as one cause of a 503, so a write can land after one.
 */
const RETRYABLE_STATUSES = new Set([502, 503, 504])
const LIT_ERROR_TOKEN_RE = /^[a-z_]{1,40}$/

export interface LitCallConfig {
  apiKey: string | null
  /** Tests only. Production always uses LIT_ORIGIN. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Whole-call deadline across every retry. Default 15000 ms. */
  deadlineMs?: number
  /** Tests only: no real waits between retries. */
  sleep?: (ms: number) => Promise<void>
}

export interface LitActionResult {
  response: unknown
  /** How `response` arrived. Recorded because Lit does not document it. */
  responseType: 'object' | 'string' | 'other'
  /** Lit's `logs` are discarded unread; only their length is kept. */
  logsLength: number
  status: number
  attempts: number
  elapsedMs: number
}

interface RawReply {
  status: number
  text: string
  attempts: number
  elapsedMs: number
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const name = (err as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * Settle with `p`, or reject when `signal` aborts. The signal is also handed to
 * fetch; this covers a fetch (or a body read) that ignores it.
 */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/** Lit's `error` token from a structured error body, or null. Never anything longer. */
function litErrorToken(text: string): string | null {
  if (text.length > MAX_BODY_CHARS) return null
  try {
    const v: unknown = JSON.parse(text)
    if (isRecord(v) && typeof v.error === 'string' && LIT_ERROR_TOKEN_RE.test(v.error)) {
      return v.error
    }
  } catch {
    // A bare string or HTML: no token.
  }
  return null
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after')
  if (raw === null || raw.trim() === '') return null
  const seconds = Number(raw)
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(raw) - Date.now()
  if (!Number.isFinite(ms)) return null
  return Math.min(Math.max(ms, 0), RETRY_AFTER_CAP_MS)
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    // Nothing to do: the body is being thrown away.
  }
}

/**
 * Send one request, retrying only what is safe to retry, inside one deadline.
 *
 * `repeatable` says whether running the call twice does no harm. An open is:
 * the same attestation always yields the same reply. A management write is
 * not: Lit commits it on chain, and a dropped connection or a gateway 502/504
 * can arrive after it did. So can a 503: Lit reports a chain RPC outage that
 * way, and a write it already sent can still confirm. Sending
 * `add_usage_api_key` again would mint a second key whose value nobody ever
 * sees. So a call that is not repeatable is resent only after a 429, which is
 * load shed before the work starts, and its one attempt gets the whole
 * deadline: Lit's docs say a write can take several seconds while blocks
 * confirm.
 */
async function exchange(
  cfg: LitCallConfig,
  method: 'GET' | 'POST',
  path: string,
  bodyText: string | undefined,
  repeatable: boolean,
): Promise<RawReply> {
  const base = (cfg.baseUrl ?? LIT_ORIGIN).replace(/\/+$/, '')
  const url = `${base}${path}`
  const doFetch = cfg.fetchImpl ?? fetch
  const sleep = cfg.sleep ?? realSleep
  const deadlineMs = cfg.deadlineMs ?? DEFAULT_DEADLINE_MS
  const headers: Record<string, string> = { 'X-Privacy-Mode': 'true' }
  if (bodyText !== undefined) headers['Content-Type'] = 'application/json'
  if (cfg.apiKey) headers['X-Api-Key'] = cfg.apiKey

  const started = Date.now()
  const remaining = (): number => deadlineMs - (Date.now() - started)
  let attempts = 0
  let rateLimitRetries = 0
  let gatewayRetries = 0

  for (;;) {
    if (remaining() <= 0) {
      throw new ChipotleRequestError(0, 'timeout', 'no answer from Lit before the deadline')
    }
    attempts++
    const signal = AbortSignal.timeout(repeatable ? Math.min(remaining(), ATTEMPT_CAP_MS) : remaining())

    let res: Response
    try {
      res = await untilAborted(
        doFetch(url, {
          method,
          headers,
          ...(bodyText === undefined ? {} : { body: bodyText }),
          // A redirect would carry the key and the inputs to a host we did not pick.
          redirect: 'error',
          signal,
        }),
        signal,
      )
    } catch (err) {
      if (isTimeout(err)) {
        throw new ChipotleRequestError(0, 'timeout', 'no answer from Lit before the deadline')
      }
      // No answer arrived, but the request may still have reached Lit and run.
      // Only a repeatable call is sent again.
      if (repeatable && gatewayRetries < 1 && remaining() > GATEWAY_RETRY_MS) {
        gatewayRetries++
        await sleep(GATEWAY_RETRY_MS)
        continue
      }
      throw new ChipotleRequestError(0, 'network', 'could not reach Lit')
    }

    if (res.status === 429 && rateLimitRetries < RATE_LIMIT_BACKOFF_MS.length) {
      const wait =
        retryAfterMs(res) ??
        (RATE_LIMIT_BACKOFF_MS[rateLimitRetries] ?? 1_000) +
          Math.floor(Math.random() * RATE_LIMIT_JITTER_MS)
      if (remaining() > wait) {
        rateLimitRetries++
        await discardBody(res)
        await sleep(wait)
        continue
      }
    }
    if (repeatable && RETRYABLE_STATUSES.has(res.status) && gatewayRetries < 1 && remaining() > GATEWAY_RETRY_MS) {
      gatewayRetries++
      await discardBody(res)
      await sleep(GATEWAY_RETRY_MS)
      continue
    }

    let text: string
    try {
      text = await untilAborted(res.text(), signal)
    } catch (err) {
      if (isTimeout(err)) {
        throw new ChipotleRequestError(0, 'timeout', 'no answer from Lit before the deadline')
      }
      throw new ChipotleRequestError(res.status, 'network', 'the connection dropped mid-reply')
    }
    return { status: res.status, text, attempts, elapsedMs: Date.now() - started }
  }
}

/** Map a non-2xx status to its kind. `forbidden` says what a 403 means for this call. */
function statusError(status: number, text: string, forbidden: string): ChipotleRequestError {
  const token = litErrorToken(text)
  const say = (fixed: string): string => (token ? `${fixed} (Lit error: ${token})` : fixed)
  const make = (kind: ChipotleFailureKind, fixed: string): ChipotleRequestError =>
    new ChipotleRequestError(status, kind, say(fixed))

  if (status === 401) return make('auth', 'Lit refused the key')
  if (status === 402) return make('credits', 'Lit credit balance exhausted; top up')
  if (status === 403) return make('forbidden', forbidden)
  if (status === 404) return make('not_found', 'Lit has no such endpoint')
  if (status === 400 || status === 422) return make('bad_request', 'Lit rejected the request')
  if (status === 429) return make('rate_limited', 'Lit kept rate limiting after retries')
  return make('server', 'Lit answered with an error status')
}

function parseJsonBody(raw: RawReply): unknown {
  if (raw.text.length > MAX_BODY_CHARS) {
    throw new ChipotleRequestError(raw.status, 'bad_response', 'the reply was too large')
  }
  try {
    return JSON.parse(raw.text)
  } catch {
    throw new ChipotleRequestError(raw.status, 'bad_response', 'the reply was not JSON')
  }
}

/** Run `code` once on Lit with `jsParams` as its `params`. */
export async function runLitAction(
  cfg: LitCallConfig,
  code: string,
  jsParams: unknown,
): Promise<LitActionResult> {
  // Snake case and always `code`: `ipfs_id` only hits an in-memory cache on
  // Lit's side, and `jsParams` is silently ignored.
  const raw = await exchange(
    cfg,
    'POST',
    `${API_PREFIX}/lit_action`,
    JSON.stringify({ code, js_params: jsParams }),
    true,
  )
  if (raw.status < 200 || raw.status > 299) {
    throw statusError(raw.status, raw.text, "the key cannot execute this template's CID; run pnpm lit:setup")
  }

  const body = parseJsonBody(raw)
  // A bare JSON string on a 200 is Lit's `ErrMessage`, not a run.
  if (
    !isRecord(body) ||
    typeof body.has_error !== 'boolean' ||
    typeof body.logs !== 'string' ||
    !Object.hasOwn(body, 'response')
  ) {
    throw new ChipotleRequestError(raw.status, 'bad_response', 'the reply was not the documented shape')
  }
  const logsLength = body.logs.length
  if (body.has_error) {
    throw new ChipotleRequestError(raw.status, 'action_error', 'the action threw; its logs were discarded')
  }

  let response: unknown = body.response
  let responseType: LitActionResult['responseType']
  if (typeof response === 'string') {
    try {
      response = JSON.parse(response)
    } catch {
      throw new ChipotleRequestError(raw.status, 'bad_response', 'the action answered with text that is not JSON')
    }
    responseType = 'string'
  } else {
    responseType = isRecord(response) ? 'object' : 'other'
  }

  return {
    response,
    responseType,
    logsLength,
    status: raw.status,
    attempts: raw.attempts,
    elapsedMs: raw.elapsedMs,
  }
}

/**
 * Scripts only (setup, smoke). Same headers and error mapping.
 *
 * `path` is under `/core/v1` (for example `/version`); a path that already
 * starts with `/core/v1/` is used as given. The origin stays pinned either way.
 *
 * A GET is a read and is retried like an open. A POST may be a billed write
 * (`add_group`, `add_action_to_group`, `add_usage_api_key`), so it is sent
 * once, with the whole deadline, unless Lit answers 429.
 */
export async function litRequest(
  cfg: LitCallConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; elapsedMs: number }> {
  if (!/^\/[A-Za-z0-9_\-/?=&.]*$/.test(path) || path.startsWith('//') || path.includes('..')) {
    throw new RangeError('litRequest needs a plain API path such as /version')
  }
  const full = path.startsWith(`${API_PREFIX}/`) ? path : `${API_PREFIX}${path}`
  const raw = await exchange(
    cfg,
    method,
    full,
    body === undefined ? undefined : JSON.stringify(body),
    method === 'GET',
  )
  if (raw.status < 200 || raw.status > 299) {
    throw statusError(raw.status, raw.text, 'this key may not do that')
  }
  const json = raw.text === '' ? null : parseJsonBody(raw)
  return { status: raw.status, json, elapsedMs: raw.elapsedMs }
}
