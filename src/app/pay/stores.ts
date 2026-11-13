/**
 * The till's stores, and each one's Home Screen icon (unified-account spec
 * 10.1 and 10.2).
 *
 * ===========================================================================
 * ONE ICON PER STORE, OPENING STRAIGHT ON ITS KEYPAD. "Salvo · Target" on the
 * Home Screen opens /pay/target: no store to pick, no search. Each store has
 * its own manifest (manifest.webmanifest beside the till page), because a
 * manifest has one start_url, and the icon is the one Salvo mark for every
 * store (src/app/apple-icon.ts). The store is in the name, never a store's
 * logo.
 *
 * HOW THE ICON OPENS IS THE PHASE 0 DEVICE CHECK'S CALL. "browser" (mode A,
 * the default): the icon opens a Safari tab, so it shares Safari's storage
 * with plain Safari and, later, the Wallet pass's link. One sign-in per
 * phone. If iOS does not honour that for an added icon, the answer is
 * "standalone" (mode B): app-like, but a Home Screen web app keeps its
 * storage apart from Safari's (bugs.webkit.org/show_bug.cgi?id=181849), so
 * each icon costs one Face ID the first time. That is one constant here and
 * nothing else: the account page already finds an existing passkey before
 * it makes one, so a second container is never a second account.
 * ===========================================================================
 *
 * Pure: the till page, its manifest route, the store chooser at /shop and
 * the account page all read it.
 */

import { MERCHANT_BARCODE_PROFILES } from '@/lib/barcode/merchants'

/** Mode A. See above: the Phase 0 device check is what may change it. */
export const HOME_SCREEN_DISPLAY: 'browser' | 'standalone' = 'browser'

/** --bg: the icon's splash and the page it opens are one surface. */
const BACKGROUND = '#0a0a0b'

/** Every store the till pays at, by name. The barcode profiles are the list: a store with none cannot be scanned. */
export const TILL_STORES: ReadonlyArray<{ id: string; name: string }> = Object.values(MERCHANT_BARCODE_PROFILES)
  .map((p) => ({ id: p.merchantId, name: p.displayName }))
  .sort((a, b) => a.name.localeCompare(b.name))

/** A store id from a URL, or null when it is not one of ours. Lower case only, as the profiles name them. */
export function tillStoreOf(raw: string): string | null {
  const id = raw.toLowerCase()
  return /^[a-z]{1,32}$/.test(id) && TILL_STORES.some((s) => s.id === id) ? id : null
}

/** "Target", for a store id the till knows. */
export function tillStoreName(store: string): string {
  return TILL_STORES.find((s) => s.id === store)?.name ?? store
}

/** Where a store's till is: what its icon opens. */
export function tillPath(store: string): string {
  return `/pay/${store}`
}

/** "Salvo · Target": the icon's name on the Home Screen. */
export function storeIconName(storeName: string): string {
  return `Salvo · ${storeName}`
}

/** The parts of a web app manifest the icon uses. */
export interface StoreManifest {
  id: string
  name: string
  short_name: string
  start_url: string
  scope: string
  display: 'browser' | 'standalone'
  background_color: string
  theme_color: string
  icons: ReadonlyArray<{ src: string; sizes: string; type: string; purpose: 'any' }>
}

/**
 * A store's manifest. `id` is the till's path, so two stores' icons are two
 * apps and never replace each other. The scope is the whole site, so a tap
 * on Account from the till stays in the same window in mode B too.
 */
export function storeManifest(store: string): StoreManifest {
  const name = storeIconName(tillStoreName(store))
  return {
    id: tillPath(store),
    name,
    short_name: name,
    start_url: tillPath(store),
    scope: '/',
    display: HOME_SCREEN_DISPLAY,
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    // Next serves src/app/apple-icon.ts here.
    icons: [{ src: '/apple-icon', sizes: '180x180', type: 'image/png', purpose: 'any' }],
  }
}
