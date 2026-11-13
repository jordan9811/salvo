'use client'

/**
 * The till with no store named (unified-account spec 10.1): the store this
 * phone's till opened on last, else the stores, one tap each.
 *
 * ===========================================================================
 * IT IS /pay. The till's front door, on both rails: /shop and /buy redirect
 * here (next.config.ts), and the till it opens pays the way the account says.
 *
 * NO SEARCH, AND NO LOCATION YET. "Nearest store" needs the store data that
 * comes with the Wallet pass (spec phase 4). Until then: the last store, or
 * four buttons.
 *
 * A STORE IN THE URL WINS. /shop?merchant=target never reaches this screen:
 * next.config.ts sends it to /pay/target, so an old link keeps its store.
 *
 * WHAT IS ON SALE, BEFORE ANY ACCOUNT. Under each store: how many cards, their
 * value, and the best discount, from the public listings (both rails), so
 * anyone sees the liquidity without signing in, allowing anything, or typing
 * a total. A store with nothing says so.
 * ===========================================================================
 *
 * Browser only. Reads this phone's own store and nothing else.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { deviceSettings } from '@/lib/account/client/settings'
import { openCardStore } from '@/lib/escrow/client/card-store'
import { AppBar } from '../app-bar'
import { TILL_STORES, tillPath, tillStoreOf } from './stores'
import { NOTHING_ON_SALE, OPENING_STORE, PICK_STORE, PICK_STORE_HINT, onSaleLine } from './till-copy'

/** Per store, what is listed across both rails. */
export interface OnSale {
  cards: number
  totalValueCents: number
  bestDiscountBps: number
}

/** Both rails' public listings, folded per store id. Either rail failing to answer leaves the other's count. */
export async function readOnSale(fetchFn: typeof fetch = fetch): Promise<Map<string, OnSale>> {
  const out = new Map<string, OnSale>()
  const add = (id: string, cards: number, totalValueCents: number, bestDiscountBps: number) => {
    const was = out.get(id) ?? { cards: 0, totalValueCents: 0, bestDiscountBps: 0 }
    out.set(id, { cards: was.cards + cards, totalValueCents: was.totalValueCents + totalValueCents, bestDiscountBps: Math.max(was.bestDiscountBps, bestDiscountBps) })
  }
  const [escrow, supply] = await Promise.all([
    fetchFn('/api/escrow/listings').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetchFn('/api/supply/listings').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ])
  for (const s of (escrow as { stores?: { merchant: string; cards: number; totalValueCents: number; bestDiscountBps: number }[] } | null)?.stores ?? []) {
    add(s.merchant.toLowerCase(), s.cards, s.totalValueCents, s.bestDiscountBps)
  }
  for (const l of (supply as { listings?: { merchantId: string; faceCents?: number; discountBps?: number }[] } | null)?.listings ?? []) {
    add(l.merchantId.toLowerCase(), 1, l.faceCents ?? 0, l.discountBps ?? 0)
  }
  return out
}

export function StoreChooser() {
  const router = useRouter()
  const [picking, setPicking] = useState(false)
  const [onSale, setOnSale] = useState<Map<string, OnSale> | null>(null)
  useEffect(() => {
    let live = true
    void readOnSale().then((m) => {
      if (live) setOnSale(m)
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const { settings } = await deviceSettings(await openCardStore())
        const last = settings.lastStore === null ? null : tillStoreOf(settings.lastStore)
        if (last !== null) {
          // replace, not push: Back from the till leaves Salvo, as it would have from here.
          if (live) router.replace(tillPath(last))
          return
        }
      } catch {
        // A private window keeps nothing: the stores are the answer.
      }
      if (live) setPicking(true)
    })()
    return () => {
      live = false
    }
  }, [router])

  return (
    <>
      <AppBar current="pay" />
      <main className="wrap" data-task id="content" tabIndex={-1}>
        <h1>{PICK_STORE}</h1>
        {picking ? (
          <>
            <nav className="stack" aria-label="Stores">
              {TILL_STORES.map((s) => {
                const sale = onSale?.get(s.id) ?? null
                return (
                  <Link key={s.id} className="choice choice--row" href={tillPath(s.id)}>
                    <span>{s.name}</span>
                    <span className="choice__meta">{onSale === null ? '…' : sale === null || sale.cards === 0 ? NOTHING_ON_SALE : onSaleLine(sale)}</span>
                  </Link>
                )
              })}
            </nav>
            <p className="hint mt-4">{PICK_STORE_HINT}</p>
          </>
        ) : (
          <p className="hint hint--deferred" aria-busy="true">
            {OPENING_STORE}
          </p>
        )}
      </main>
    </>
  )
}
