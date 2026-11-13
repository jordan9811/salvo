/**
 * Opening a Salvo Pay screen on this device: the phone's own store first,
 * then our server's config, then the wallet (spec sections 8.6 and 8.13).
 *
 * THE STORE DOES NOT WAIT FOR OUR SERVER. A bought card lives in this phone's
 * IndexedDB, sealed, and drawing its code asks nothing of anyone. At the till
 * on one bar of signal, or while our server is down, mid-deploy or not
 * ready, /account must still show it: the on-screen code is the only way to use
 * a card in this phase. So the store is opened before the config is asked
 * for, and every state but "the browser keeps nothing" carries it. Loading
 * and finishing a purchase still need the config, and only "ready" has one.
 *
 * Isomorphic and pure of React: the screens' hook (escrow-ui.tsx) runs this,
 * and tests run it with a fake store and a fake config answer.
 */

import type { EscrowApi, EscrowPublicConfig } from '@/lib/escrow/client/api'
import { DeviceStorageError, type CardStore, type KeyRole } from '@/lib/escrow/client/card-store'
import type { ChainAccess, DeviceWallet } from '@/lib/escrow/client/wallet'

export type DeviceSession =
  | { phase: 'loading' }
  /** The server says the rail is off: the page was served a moment before it was switched. */
  | { phase: 'off'; store: CardStore | null }
  | { phase: 'not_ready'; store: CardStore | null }
  /** Our server did not answer, or answered with pins this page does not trust. */
  | { phase: 'error'; store: CardStore | null }
  /** The browser will not keep anything: a private window, or blocked site data. */
  | { phase: 'storage' }
  | { phase: 'ready'; config: EscrowPublicConfig; store: CardStore; api: EscrowApi; access: ChainAccess; wallet: DeviceWallet | null }

export interface DeviceSessionDeps {
  openStore: () => Promise<CardStore>
  loadWallet: (store: CardStore, role: KeyRole) => Promise<DeviceWallet | null>
}

/**
 * The session for `role`. Never throws: every failure is a phase the screen
 * can say in words. `api` is the page's client, kept in a ready session.
 */
export async function openDeviceSession(role: KeyRole, api: EscrowApi, deps: DeviceSessionDeps): Promise<DeviceSession> {
  let store: CardStore | null = null
  let refused = false
  try {
    store = await deps.openStore()
  } catch (err) {
    refused = err instanceof DeviceStorageError
  }
  const cfg = await api.config()
  if (cfg.state !== 'ready') return { phase: cfg.state, store }
  if (store === null) return refused ? { phase: 'storage' } : { phase: 'error', store: null }
  const wallet = await deps.loadWallet(store, role).catch(() => null)
  return {
    phase: 'ready',
    config: cfg.config,
    store,
    api,
    access: { hosts: { urls: cfg.config.rpcUrls, timeoutMs: 10_000 }, sponsorUrl: cfg.config.sponsorUrl },
    wallet,
  }
}

/** The phone's store in any session that has one: every phase but loading and "the browser keeps nothing". */
export function sessionStore(session: DeviceSession): CardStore | null {
  return session.phase === 'loading' || session.phase === 'storage' ? null : session.store
}
