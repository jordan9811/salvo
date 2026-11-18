/**
 * The sign-in challenge the account page holds ready (unified-account spec
 * 3.2): fetched before the tap, so the Face ID sheet opens straight from it.
 *
 * ===========================================================================
 * ONE CHALLENGE COOKIE PER BROWSER, SO NO REFRESH DURING A SIGN-IN. Every
 * fetch of a challenge replaces this browser's one challenge cookie, and the
 * sign-in is refused unless the cookie still matches the challenge Face ID
 * signed. The page refreshes its challenge every four minutes, and a refresh
 * that landed while the sheet was up failed a good Face ID with "That took
 * too long". So a sign-in takes the challenge and holds refreshes until it is
 * done, and waits first for a fetch already on its way, whose cookie would
 * otherwise land after the one the sign-in's own challenge set.
 * ===========================================================================
 *
 * Browser only by use; pure of React. Tests pass their own fetch and clock.
 */

/** A challenge older than this is fetched again: it lasts five minutes. */
export const CHALLENGE_FRESH_MS = 4 * 60_000

export class ChallengeKeeper {
  readonly #fetch: () => Promise<string>
  readonly #now: () => number
  #held: { value: string; at: number } | null = null
  #inflight: Promise<void> | null = null
  #signingIn = false

  constructor(fetchOne: () => Promise<string>, now: () => number = () => Date.now()) {
    this.#fetch = fetchOne
    this.#now = now
  }

  /** Fetch a fresh one, unless a sign-in is using the one held. A failure leaves nothing held. */
  refresh(): void {
    if (this.#signingIn) return
    const p = this.#fetch()
      .then((value) => {
        this.#held = { value, at: this.#now() }
      })
      .catch(() => {
        this.#held = null
      })
      .finally(() => {
        if (this.#inflight === p) this.#inflight = null
      })
    this.#inflight = p
  }

  /**
   * For a sign-in: no refresh until `done`, a fetch already on its way waited
   * for, and the challenge held while it is fresh, or null for the sign-in
   * to fetch its own.
   */
  async take(): Promise<string | null> {
    this.#signingIn = true
    if (this.#inflight !== null) await this.#inflight
    const held = this.#held
    this.#held = null
    return held !== null && this.#now() - held.at < CHALLENGE_FRESH_MS ? held.value : null
  }

  /** The sign-in is over: refreshes go on, starting with one now. */
  /**
   * The held challenge, now, with no wait at all: for a tap that must reach
   * the Face ID sheet with nothing awaited first (Safari drops the tap's
   * permission across any wait, and the sheet then never opens). Null when
   * none is held yet; the caller then fetches one as before.
   */
  takeNow(): string | null {
    this.#signingIn = true
    const held = this.#held
    this.#held = null
    return held !== null && this.#now() - held.at < CHALLENGE_FRESH_MS ? held.value : null
  }

  done(): void {
    this.#signingIn = false
    this.refresh()
  }
}
