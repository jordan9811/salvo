'use client'

/**
 * The pieces /account and the escrow branch of /sell share: the device's
 * session (config, storage, wallet), the store names, and a bought card's
 * code drawn on the phone.
 *
 * NOTHING HERE DECIDES ANYTHING ABOUT MONEY. The checks live in
 * src/lib/escrow/client/ and are tested there; these are the screens' hands.
 *
 * Browser only. Imports no server module: the escrow client modules are
 * isomorphic, and tests/escrow-browser-bundle.test.ts holds every page to it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Hex } from 'viem'
import { escrowApi } from '@/lib/escrow/client/api'
import { cardBarcode, loadBarcodeRenderer, type CardCode } from '@/lib/escrow/client/barcode'
import { openCardStore, type CardRecord, type CardStore, type KeyRole } from '@/lib/escrow/client/card-store'
import { loadDeviceWallet, type DeviceWallet } from '@/lib/escrow/client/wallet'
import { openDeviceSession, type DeviceSession } from './device-session'
import { ESCROW_MERCHANTS, type EscrowMerchantName } from '@/lib/escrow/merchants'
import { UNITS_PER_CENT } from '@/lib/escrow/manifest'
import { BarcodeSkeleton } from '../barcode-card'
import { SUPPORTED_MERCHANTS, money } from '../ui'
import { useWakeLock } from '../use-wake-lock'

/** The store's own name. The test store is not a store, and says so. */
export function merchantLabel(name: EscrowMerchantName): string {
  if (name === 'salvotest') return 'Salvo test card'
  return SUPPORTED_MERCHANTS.find((m) => m.id === name)?.name ?? name
}

/** The stores Salvo Pay sells at, in the order the other screens list them, the test store last. */
export const ESCROW_STORES: ReadonlyArray<{ name: EscrowMerchantName; label: string }> = [
  ...SUPPORTED_MERCHANTS.map((m) => m.id).filter((id): id is EscrowMerchantName => Object.prototype.hasOwnProperty.call(ESCROW_MERCHANTS, id)),
  'salvotest' as const,
].map((name) => ({ name, label: merchantLabel(name) }))

/** pathUSD base units as dollars, rounded down to the cent: what is there, never more. */
export function unitsToMoney(units: bigint): string {
  return money(Number(units / BigInt(UNITS_PER_CENT)))
}

/** 0x1234…abcd, for a line that names an address without making anyone read it. */
export function shortAddress(a: Hex): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export type { DeviceSession } from './device-session'

/**
 * The page's storage, config and wallet for `role` (device-session.ts: the
 * store first, so a card on this phone shows with no answer from us).
 * `reload` asks again; `setWallet` is called after setup or after turning
 * the key off.
 */
export function useEscrowDevice(role: KeyRole): {
  session: DeviceSession
  reload: () => void
  setWallet: (w: DeviceWallet | null) => void
} {
  const [session, setSession] = useState<DeviceSession>({ phase: 'loading' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    setSession({ phase: 'loading' })
    void openDeviceSession(role, escrowApi(), { openStore: () => openCardStore(), loadWallet: loadDeviceWallet }).then((s) => {
      if (live) setSession(s)
    })
    return () => {
      live = false
    }
  }, [role, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  const setWallet = useCallback((w: DeviceWallet | null) => {
    setSession((s) => (s.phase === 'ready' ? { ...s, wallet: w } : s))
  }, [])
  return { session, reload, setWallet }
}

/** The plain states every escrow screen shares before it can do anything. */
export function SessionNotice({ session, onRetry }: { session: DeviceSession; onRetry: () => void }) {
  if (session.phase === 'loading') {
    return (
      <p className="hint hint--deferred" aria-busy="true">
        Checking this phone…
      </p>
    )
  }
  if (session.phase === 'off') return <p className="sub">Salvo Pay is not available here.</p>
  if (session.phase === 'not_ready') return <p className="sub">Salvo Pay is not set up yet. Nothing can be bought or sold here today.</p>
  if (session.phase === 'storage') {
    return (
      <div className="notice">
        <strong>This browser will not keep anything for Salvo Pay.</strong>{' '}
        <span className="notice--muted">
          A private window does this. Open this page in a normal window: your account and cards live on this phone.
        </span>
      </div>
    )
  }
  if (session.phase === 'error') {
    return (
      <>
        <p className="sub">We could not reach Salvo. Nothing new was charged, and anything this phone already bought is safe on it.</p>
        <button type="button" className="btn btn--secondary btn--block" onClick={onRetry}>
          Try again
        </button>
      </>
    )
  }
  return null
}

/** Start loading the barcode library as the page opens, so a card on this phone still draws without signal. */
export function usePreloadBarcodes(): void {
  useEffect(() => {
    void loadBarcodeRenderer().catch(() => undefined)
  }, [])
}

/**
 * One bought card's code, decrypted from this phone's store and drawn here.
 * The screen stays on while it shows. Nothing is sent anywhere.
 */
export function CardCodeFigure({ store, card }: { store: CardStore; card: CardRecord }) {
  const [code, setCode] = useState<CardCode | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setCode(null)
    setFailed(false)
    void (async () => {
      const secret = await store.cardSecret(card.id)
      if (secret === null) {
        if (live) setFailed(true)
        return
      }
      try {
        const drawn = await cardBarcode(card.merchant, secret)
        if (live) setCode(drawn)
      } catch {
        if (live) setFailed(true)
      }
    })()
    return () => {
      live = false
    }
  }, [store, card.id, card.merchant])
  useWakeLock(code !== null)
  const label = useMemo(() => (card.ofCards > 1 ? `Scan ${card.scanOrder} of ${card.ofCards}` : 'Scan this code'), [card.ofCards, card.scanOrder])
  // One object per drawn code, so a re-render above this never writes the SVG back under the scanner.
  const html = useMemo(() => (code === null ? null : { __html: code.svg }), [code])
  if (failed) {
    return <p className="err">This card could not be drawn on this phone.</p>
  }
  if (code === null) return <BarcodeSkeleton />
  return (
    <figure className="barcode">
      <div className="barcode__svg" dangerouslySetInnerHTML={html ?? { __html: '' }} />
      <figcaption>
        {label}
        <span className="barcode__sym">
          {code.symbology} · •••• {card.last4}
        </span>
      </figcaption>
    </figure>
  )
}
