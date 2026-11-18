/**
 * Errors from the Lit vault, kept apart by what the caller should do next.
 *
 * OUTAGE AND DENIAL ARE DIFFERENT THINGS. A Lit run that was refused by the
 * template's gate is `UnsealDeniedError('lit_denied')` (in ../types). Everything
 * here is either configuration (`ChipotleNotConfiguredError`), the frozen
 * template no longer matching its pins (`LitTemplateDriftError`), or Lit not
 * answering the way its API says it will (`ChipotleRequestError`). All of them
 * fail closed, and none of them falls back to the local vault.
 *
 * NO MESSAGE HERE EVER CARRIES a response body, Lit's `logs`, `js_params`, a
 * key, a signature or card data. The only text from Lit that may appear is its
 * `error` token, and only when it looks like one (`^[a-z_]{1,40}$`).
 */

export type ChipotleFailureKind =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'credits'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'server'
  | 'bad_response'
  | 'action_error'
  | 'action_failed'

export class ChipotleNotConfiguredError extends Error {
  readonly missing: string[]

  constructor(missing: string[]) {
    super(
      `Lit vault is not configured. Missing: ${missing.join(', ')}. ` +
        `See .env.example (Lit section) and pnpm lit:setup.`,
    )
    this.name = 'ChipotleNotConfiguredError'
    this.missing = missing
  }
}

export class ChipotleRequestError extends Error {
  readonly status: number
  readonly kind: ChipotleFailureKind

  /** `detail` is fixed text from our own code, never anything Lit sent. */
  constructor(status: number, kind: ChipotleFailureKind, detail?: string) {
    super(`Lit request failed (${kind}, HTTP ${status})${detail ? `: ${detail}` : ''}`)
    this.name = 'ChipotleRequestError'
    this.status = status
    this.kind = kind
  }
}

export class LitTemplateDriftError extends Error {
  readonly template: string

  constructor(template: string) {
    super(
      `Lit vault template "${template}" no longer matches its pinned sha256 and CID. ` +
        `Lit derives the key from those exact bytes, so every card sealed under it ` +
        `opens only with the original text. Restore it; put any change in a new template version.`,
    )
    this.name = 'LitTemplateDriftError'
    this.template = template
  }
}
