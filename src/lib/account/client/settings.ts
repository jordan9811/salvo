/**
 * The account's settings on this phone (unified-account spec 3.1): read
 * from the device store, written back to it, and copied to the card
 * customer when the shopper has one.
 *
 * THE PHONE IS THE COPY THAT COUNTS. A setting is saved here first and
 * always; the copy on the card customer is only how a second container (a
 * new Safari tab, a Home Screen icon) gets the same settings at sign-in. A
 * phone that already has its own never takes the server's over them: two
 * containers that disagree each keep what their shopper last chose there.
 *
 * "ITS OWN" MEANS CHOSEN HERE. The till used to write the settings slot as
 * it opened, to remember its store, signed in or not, so a new Home Screen
 * icon that opened its till before sign-in held "settings" nobody chose,
 * and sign-in kept them over the account's: the till paid the wrong way and
 * spent store credit the shopper had said not to. So the store the till
 * opened on has its own slot (rememberTillStore), every save of a choice
 * marks the slot as chosen, and a slot kept before that mark existed counts
 * as chosen only when it holds something other than the defaults.
 *
 * Browser only by use; imports nothing Node-only. Tests pass a fake
 * IndexedDB and a fake API.
 */

import type { CardStore } from '@/lib/escrow/client/card-store'
import { DEFAULT_ACCOUNT_SETTINGS, accountSettings, type AccountSettings } from '../settings'

/** Did the shopper choose these here, or bring them from the card customer? */
function chosen(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  if ((raw as Record<string, unknown>).chosen === true) return true
  // Kept before choices were marked: the till wrote this slot too, with every choice at its default.
  const s = accountSettings(raw)
  const d = DEFAULT_ACCOUNT_SETTINGS
  return s.defaultRail !== d.defaultRail || s.routing !== d.routing || s.maxCards !== d.maxCards || s.ownCreditFirst !== d.ownCreditFirst
}

/** The phone's settings, and whether the shopper chose any here (none: every field is its default). */
export async function deviceSettings(store: CardStore): Promise<{ settings: AccountSettings; kept: boolean }> {
  const [raw, last] = await Promise.all([store.accountSettings(), store.lastStore()])
  const settings = accountSettings(raw)
  const lastStore = accountSettings({ lastStore: last }).lastStore ?? settings.lastStore
  return { settings: { ...settings, lastStore }, kept: chosen(raw) }
}

/** Keep these settings on this phone, cleaned as the planner reads them: the shopper's own choice. */
export async function saveDeviceSettings(store: CardStore, s: AccountSettings): Promise<AccountSettings> {
  const clean = accountSettings(s)
  await store.saveAccountSettings({ ...clean, chosen: true })
  return clean
}

/**
 * The store this till opened on, for a /pay with none named. In its own
 * slot, so a till opened before sign-in never keeps the account's settings
 * from coming back (restoreSettings).
 */
export async function rememberTillStore(store: CardStore, id: string): Promise<void> {
  if ((await store.lastStore()) !== id) await store.saveLastStore(id)
}

/**
 * After a sign-in: the settings the card customer carried become this
 * phone's, but only when the shopper chose none here.
 */
export async function restoreSettings(store: CardStore, fromServer: AccountSettings | null): Promise<AccountSettings> {
  const mine = await deviceSettings(store)
  if (mine.kept || fromServer === null) return mine.settings
  // The store this container's till opened on stays this container's.
  return saveDeviceSettings(store, { ...fromServer, lastStore: mine.settings.lastStore ?? fromServer.lastStore })
}
