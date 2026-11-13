/**
 * The dollars rail at the till: SalvoEscrowV2 on this phone, behind the
 * till's one interface (unified-account spec 5.1 and 5.3).
 *
 * ===========================================================================
 * OPENED ONCE, ON FIRST USE, WITHOUT HOLDING UP THE KEYPAD. The backend
 * needs this phone's store, its V2 book, our server's V2 config (held to the
 * pins built into this page) and the shopper's access key. All of that is
 * read the first time the till asks anything, which is the payment check as
 * the page opens: so the store, both chain hosts and our server are already
 * warm when the shopper types, and the barcode library is loading.
 *
 * NOTHING HERE TRUSTS THE SERVER. The config is refused whole unless it is
 * this page's own V2 pins (api-v2.ts); every quote, ticket and receipt is
 * checked on the phone (load-v2.ts).
 *
 * A PHONE THAT CANNOT PAY IN DOLLARS SAYS SO, in the till's words: a
 * private window that keeps nothing, V2 not open here yet, or our server out
 * of reach (asked again on the next check).
 *
 * BUT NEVER FOR AN ACCOUNT SIGNED OUT SINCE. What was read once is the
 * account signed in as the page opened. Each move first asks the phone's
 * store who is signed in now, and with which key (stillFor); once that has
 * changed, the screen opens again for whoever it is, or for nobody.
 * ===========================================================================
 *
 * Browser only by use; pure of React. Imports nothing that reaches the card
 * processor.
 */

import { deviceSettings } from '@/lib/account/client/settings'
import { escrowApiV2 } from '@/lib/escrow/client/api-v2'
import { loadBarcodeRenderer } from '@/lib/escrow/client/barcode'
import { DeviceStorageError, openCardStore, type CardStore } from '@/lib/escrow/client/card-store'
import { DollarsBackendV2 } from '@/lib/escrow/client/dollars-backend'
import { openDeviceBookV2 } from '@/lib/escrow/client/records-v2'
import { loadDeviceWallet } from '@/lib/escrow/client/wallet'
import type { TillBackend } from '../types'
import { tapMarks } from './tap-marks'

/** Opened for whoever was signed in then: the passkey's address and the shopper key's, as the phone's store kept them. */
interface OpenedFor {
  backend: DollarsBackendV2
  store: CardStore
  account: string | null
  key: string | null
}

type Opened = OpenedFor | { problem: string; checked: boolean }

const lower = (s: string | null | undefined): string | null => (typeof s === 'string' ? s.toLowerCase() : null)

/**
 * Is the phone still signed in as it was when this backend opened, with the
 * same key? Asked before every move: a till left open in one tab while
 * another signs out, or signs in as someone else, must not go on as the
 * first account (dollars-backend.ts #stillSignedIn says what it did).
 */
async function stillFor(o: OpenedFor): Promise<boolean> {
  const [passkey, key] = await Promise.all([o.store.passkey().catch(() => null), o.store.accessKey('shopper').catch(() => null)])
  return lower(passkey?.address) === o.account && lower(key?.accessKeyAddress) === o.key
}

const KEEPS_NOTHING = 'This browser keeps nothing, so it cannot pay in dollars. Open Salvo in Safari, not a private window.'
const NOT_OPEN = 'Dollars are not open at the till here yet.'
const NO_SERVER = 'We could not reach Salvo just now.'

async function open(): Promise<Opened> {
  void loadBarcodeRenderer().catch(() => undefined)
  const api = escrowApiV2()
  const cfgAsked = api.config()
  let store: Awaited<ReturnType<typeof openCardStore>>
  let book: Awaited<ReturnType<typeof openDeviceBookV2>>
  try {
    ;[store, book] = await Promise.all([openCardStore(), openDeviceBookV2()])
  } catch (err) {
    if (err instanceof DeviceStorageError) return { problem: KEEPS_NOTHING, checked: true }
    throw err
  }
  const cfg = await cfgAsked
  if (cfg.state === 'error') return { problem: NO_SERVER, checked: false }
  if (cfg.state !== 'ready') return { problem: NOT_OPEN, checked: true }
  const [wallet, settings, passkey, key] = await Promise.all([
    loadDeviceWallet(store, 'shopper').catch(() => null),
    deviceSettings(store).then(
      (s) => s.settings,
      () => null,
    ),
    store.passkey().catch(() => null),
    store.accessKey('shopper').catch(() => null),
  ])
  const marks = tapMarks()
  return {
    store,
    account: lower(passkey?.address),
    key: lower(key?.accessKeyAddress),
    backend: new DollarsBackendV2({
      store,
      book,
      api,
      config: cfg.config,
      access: { hosts: { urls: cfg.config.rpcUrls, timeoutMs: 10_000 }, sponsorUrl: cfg.config.sponsorUrl },
      wallet,
      // Whoever is signed in here: only their V2 store credit and purchases are this till's.
      account: passkey?.address ?? null,
      // /account's store credit is the till's: the card store keeps it.
      ownCards: store,
      ownCreditFirst: settings?.ownCreditFirst !== false,
      // Each step of a tap in the console, when this browser asks for it (tap-marks.ts).
      ...(marks === undefined ? {} : { onMark: marks }),
    }),
  }
}

/**
 * The dollars backend for one screen. Opened on first use; a failure to
 * reach our server is asked again next time, anything else is kept, while
 * the phone is signed in as it was then. Once it is not (signed out in
 * another tab, or someone else signed in), the screen opens again for
 * whoever is signed in now: the first account's key, credit and purchases
 * go with the backend that held them.
 */
export function dollarsBackend(): TillBackend {
  let opening: Promise<Opened> | null = null
  const openOnce = (): Promise<Opened> => {
    if (opening === null) {
      const o = open()
      opening = o
      void o.then(
        (r) => {
          if ('problem' in r && !r.checked && opening === o) opening = null
        },
        () => {
          if (opening === o) opening = null
        },
      )
    }
    return opening
  }
  const opened = async (): Promise<Opened> => {
    const first = openOnce()
    const o = await first
    if ('problem' in o || (await stillFor(o))) return o
    if (opening === first) opening = null
    return openOnce()
  }
  const backend = async (): Promise<DollarsBackendV2> => {
    const o = await opened()
    if ('problem' in o) throw new Error(o.problem)
    return o.backend
  }
  return {
    rail: 'stablecoin',
    async method() {
      const o = await opened().catch(() => ({ problem: NO_SERVER, checked: false }) as const)
      if ('problem' in o) return { ready: false, label: 'dollars', spendableCents: 0, problem: o.problem, checked: o.checked }
      return o.backend.method()
    },
    async quote(a) {
      const o = await opened()
      if ('problem' in o) return { unavailable: o.problem }
      return o.backend.quote(a)
    },
    async prepare(plan, opts) {
      return (await backend()).prepare(plan, opts)
    },
    async pay(plan, opts) {
      return (await backend()).pay(plan, opts)
    },
    async next(p, scanIndex) {
      return (await backend()).next(p, scanIndex)
    },
    async done(p, scanIndex) {
      return (await backend()).done(p, scanIndex)
    },
    async report(p, scanIndex, o) {
      return (await backend()).report(p, scanIndex, o)
    },
    async changeTotal(p, totalCents) {
      return (await backend()).changeTotal(p, totalCents)
    },
    async receipt(p) {
      return (await backend()).receipt(p)
    },
    // Nothing to send on a phone that cannot pay in dollars: nothing was kept to send.
    async catchUp() {
      const o = await opened().catch(() => null)
      if (o === null || 'problem' in o) return { kept: 0, reported: 0, waiting: 0 }
      return o.backend.catchUp()
    },
    // Nothing paid in dollars on a phone that cannot pay in dollars.
    async unfinishedPays() {
      const o = await opened().catch(() => null)
      if (o === null || 'problem' in o) return []
      return o.backend.unfinishedPays()
    },
  }
}
