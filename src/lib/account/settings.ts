/**
 * The account's settings: what it pays with, how the till picks cards, and
 * whether the shopper's own store credit goes first (unified-account spec,
 * sections 3.1 and 3.3).
 *
 * ===========================================================================
 * WHERE THEY LIVE, WITH NO MIGRATION. On the phone, in the one `settings`
 * slot of the device store (card-store.ts), so the dollars rail needs no
 * server at all. A shopper with a saved card also gets a copy on their card
 * customer, as `salvo_prefs` metadata, and a new Safari tab or Home Screen
 * icon restores it at sign-in. Full sync for dollars-only shoppers needs a
 * table, and waits for the deferred migration (spec phase 5).
 *
 * A SETTING NEVER REFUSES A PURCHASE. Anything unrecognised, from either
 * place, reads as that field's default (route/plan.ts routePreference takes
 * the same view): a stale or damaged setting costs a few cents at most, not
 * a "no" at a register.
 *
 * THE DEFAULTS (spec 3.3):
 *   - pay with: whichever rail is set up; dollars when both are;
 *   - In and out, at most 2 cards, which is what the shop did before the
 *     setting existed; Most savings starts at 4, and the slider goes 1 to 5;
 *   - the shopper's own store credit first.
 * ===========================================================================
 *
 * Isomorphic and pure: the account page, the device store and the account
 * route all read it.
 */

import type { TillRail } from '../demand/till-quote'
import { MAX_TILL_CARDS, routePreference, type RouteMode, type RoutePreference } from '../route/plan'

export interface AccountSettings {
  /** The rail the till pays from. Null: whichever is set up, and dollars when both are. */
  defaultRail: TillRail | null
  routing: RouteMode
  maxCards: RoutePreference['maxCards']
  /** Use the shopper's own cards first, at no cost. */
  ownCreditFirst: boolean
  /** The store the till opened on last, for a /pay with no store named. */
  lastStore: string | null
}

export const DEFAULT_ACCOUNT_SETTINGS: Readonly<AccountSettings> = Object.freeze({
  defaultRail: null,
  routing: 'in_and_out',
  maxCards: 2,
  ownCreditFirst: true,
  lastStore: null,
})

/** A store id as the barcode profiles name them. Which stores exist is the till's question. */
const STORE_RE = /^[a-z]{1,32}$/

/** Any value, as settings: each field it gets wrong is that field's default. */
export function accountSettings(raw: unknown): AccountSettings {
  const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const route = routePreference({ mode: o.routing, maxCards: o.maxCards })
  return {
    defaultRail: o.defaultRail === 'card' || o.defaultRail === 'stablecoin' ? o.defaultRail : null,
    routing: route.mode,
    maxCards: route.maxCards,
    ownCreditFirst: typeof o.ownCreditFirst === 'boolean' ? o.ownCreditFirst : DEFAULT_ACCOUNT_SETTINGS.ownCreditFirst,
    lastStore: typeof o.lastStore === 'string' && STORE_RE.test(o.lastStore) ? o.lastStore : null,
  }
}

/**
 * The till's preference, as the planner takes it: the setting the router
 * honours inside the residual cap. The till (/pay/[store]) sends it with
 * every quote and Pay; the account page only sets the fields.
 */
export function routeOf(s: AccountSettings): RoutePreference {
  return routePreference({ mode: s.routing, maxCards: s.maxCards })
}

/** Switch how the till picks cards. The card limit goes to that mode's own default: 2 for In and out, 4 for Most savings. */
export function withRouting(s: AccountSettings, mode: RouteMode): AccountSettings {
  if (mode === s.routing) return s
  return { ...s, routing: mode, maxCards: routePreference({ mode }).maxCards }
}

/** Set the most cards one purchase may use, 1 to 5. */
export function withMaxCards(s: AccountSettings, n: number): AccountSettings {
  const clamped = Math.min(MAX_TILL_CARDS, Math.max(1, Math.round(n)))
  return { ...s, maxCards: routePreference({ mode: s.routing, maxCards: clamped }).maxCards }
}

/** Pay with this rail at the till, while it is set up (effectiveRail). */
export function withDefaultRail(s: AccountSettings, rail: TillRail): AccountSettings {
  return s.defaultRail === rail ? s : { ...s, defaultRail: rail }
}

/**
 * The rail the till pays from, once both rails can pay at it. The shopper's
 * own choice while that rail is set up; otherwise whichever is, and dollars
 * when both are ("default to stablecoins"). Null when neither is set up.
 */
export function effectiveRail(s: AccountSettings, ready: Readonly<Record<TillRail, boolean>>): TillRail | null {
  if (s.defaultRail !== null && ready[s.defaultRail]) return s.defaultRail
  if (ready.stablecoin) return 'stablecoin'
  if (ready.card) return 'card'
  return null
}

/** What a rail said when the till asked if it can pay (src/lib/till/types.ts PaymentMethod, the part read here). */
export interface RailAnswer {
  ready: boolean
  /** False: the rail could not be asked, so `ready` says nothing either way. */
  checked: boolean
  /** Set up on the account, whether or not it can pay now. Left out: not known. */
  setUp?: boolean
}

/**
 * The rail the till pays from, by effectiveRail's rule, on answers that may
 * not all have been read.
 *
 * A CHECK THAT COULD NOT BE READ SAYS NOTHING EITHER WAY (use-till.ts
 * payBlockedBy says the same). One dropped read used to count as "cannot
 * pay": the shopper's own choice of dollars was dropped for the card for the
 * whole visit, and their card was held. So:
 *   - the shopper's own choice stands while it can pay, and while its answer
 *     is not known (the till asks again);
 *   - otherwise a rail that can pay, or that is set up and could not be
 *     checked, dollars first ("default to stablecoins");
 *   - when neither can, the shopper's choice, else the rail that is set up
 *     (dollars first), so the till says what is wrong with the way they set
 *     up, never "save a card" to a shopper who only uses dollars; else the
 *     card.
 */
export function tillRail(defaultRail: TillRail | null, answers: Readonly<Record<TillRail, RailAnswer>>): TillRail {
  if (defaultRail !== null && (answers[defaultRail].ready || !answers[defaultRail].checked)) return defaultRail
  const may = (a: RailAnswer): boolean => a.ready || (!a.checked && a.setUp === true)
  if (may(answers.stablecoin)) return 'stablecoin'
  if (may(answers.card)) return 'card'
  if (defaultRail !== null) return defaultRail
  if (answers.stablecoin.setUp === true) return 'stablecoin'
  return 'card'
}

/** Card processor metadata values are at most 500 characters. Ours is about 80. */
export const PREFS_MAX_CHARS = 500

/** The settings as `salvo_prefs` metadata: short keys, one line of JSON. */
export function prefsOf(s: AccountSettings): string {
  const n = accountSettings(s)
  return JSON.stringify({ v: 1, r: n.defaultRail, m: n.routing, n: n.maxCards, o: n.ownCreditFirst, s: n.lastStore })
}

/** `salvo_prefs` back as settings, or null when there are none, or they are not ours. */
export function settingsFromPrefs(text: string | null | undefined): AccountSettings | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > PREFS_MAX_CHARS) return null
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null || (o as Record<string, unknown>).v !== 1) return null
  const p = o as Record<string, unknown>
  return accountSettings({ defaultRail: p.r, routing: p.m, maxCards: p.n, ownCreditFirst: p.o, lastStore: p.s })
}
