/**
 * Opening a Salvo Pay screen on the phone (src/app/pay/device-session.ts).
 *
 * Pinned (spec sections 8.6 and 8.13): the phone's own store opens before
 * our server is asked anything, so a card bought on this phone shows with no
 * answer from us. With no signal at the till, with our server answering
 * "not ready", or with pins this page does not trust, /account still has the
 * store, and lists and draws the cards in it (they were /cards). Only a ready answer can finish a
 * purchase. A browser that keeps nothing says so.
 *
 * No network, no database: the config answers are the fixture's, and
 * IndexedDB is the in-memory fake.
 */

import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { sessionStore, openDeviceSession } from '@/app/pay/device-session'
import { EscrowApi } from '@/lib/escrow/client/api'
import { DeviceStorageError, openCardStore, type CardStore } from '@/lib/escrow/client/card-store'
import { configBody, fixturePins, fixtureWorld, RAIL_OFF_BODY, type FixtureWorld } from '../scripts/ui-states-escrow'
import { FakeIndexedDB } from './support/fake-indexeddb'

const CARD = '9999000011112222'

/** A phone that bought one card earlier, and kept it. */
async function phoneWithACard(): Promise<{ idb: FakeIndexedDB; id: string }> {
  const idb = new FakeIndexedDB()
  const store = await openCardStore(idb.asFactory())
  const id = `0x${'e5'.repeat(20)}:7`
  await store.saveCard(
    {
      id,
      escrow: `0x${'e5'.repeat(20)}` as Hex,
      depositId: '7',
      listingId: `0x${'1a'.repeat(32)}` as Hex,
      merchant: 'salvotest',
      valueCents: 2_000,
      priceUnits: 18_000_000,
      scanOrder: 1,
      ofCards: 1,
      last4: CARD.slice(-4),
      boughtAt: 1,
      mode: 2,
    },
    { cardNumber: CARD, pin: null },
  )
  return { idb, id }
}

/** Our server, as the page's fetch reaches GET /api/escrow/config. `down`: no answer at all. Counts what it was asked. */
function server(w: FixtureWorld, answer: 'ready' | 'not_ready' | 'off' | 'down' | 'other_pins'): { api: EscrowApi; asked: () => number } {
  let asked = 0
  const api = new EscrowApi(async () => {
    asked += 1
    if (answer === 'down') throw new TypeError('fetch failed')
    if (answer === 'off') return new Response(JSON.stringify(RAIL_OFF_BODY), { status: 503 })
    const body = configBody(w)
    if (answer === 'not_ready') return new Response(JSON.stringify({ ...body, ready: false, escrow: null }), { status: 200 })
    if (answer === 'other_pins') return new Response(JSON.stringify({ ...body, escrow: `0x${'77'.repeat(20)}` }), { status: 200 })
    return new Response(JSON.stringify(body), { status: 200 })
  }, fixturePins(w))
  return { api, asked: () => asked }
}

describe('a card on this phone shows without our server', () => {
  it("no signal, not ready, rail switched off, or pins this page does not trust: the store is open, and the card opens from it", async () => {
    const w = await fixtureWorld()
    const { idb, id } = await phoneWithACard()
    for (const answer of ['down', 'not_ready', 'off', 'other_pins'] as const) {
      const { api, asked } = server(w, answer)
      let opened = 0
      const session = await openDeviceSession('shopper', api, {
        openStore: () => {
          opened += 1
          // The store first: our server has not been asked yet.
          expect(asked()).toBe(0)
          return openCardStore(idb.asFactory())
        },
        loadWallet: async () => null,
      })
      expect([answer, session.phase]).toEqual([answer, answer === 'down' || answer === 'other_pins' ? 'error' : answer])
      expect(opened).toBe(1)
      const store = sessionStore(session) as CardStore
      expect(store).not.toBeNull()
      expect((await store.cards()).map((c) => c.id)).toEqual([id])
      expect(await store.cardSecret(id)).toEqual({ cardNumber: CARD, pin: null })
    }
  })

  it('a ready answer is the one that can finish a purchase, with the same store', async () => {
    const w = await fixtureWorld()
    const { idb, id } = await phoneWithACard()
    const session = await openDeviceSession('shopper', server(w, 'ready').api, {
      openStore: () => openCardStore(idb.asFactory()),
      loadWallet: async () => null,
    })
    expect(session.phase).toBe('ready')
    if (session.phase !== 'ready') return
    expect(session.config.escrow).toBe(w.escrow)
    expect((await session.store.cards()).map((c) => c.id)).toEqual([id])
  })

  it('a browser that keeps nothing says so, even when our server is ready; one that cannot be read at all is an error', async () => {
    const w = await fixtureWorld()
    const refused = await openDeviceSession('shopper', server(w, 'ready').api, {
      openStore: () => Promise.reject(new DeviceStorageError('IndexedDB is blocked')),
      loadWallet: async () => null,
    })
    expect(refused).toEqual({ phase: 'storage' })
    expect(sessionStore(refused)).toBeNull()
    // Our server off as well: the rail's own words, and no store to show.
    const off = await openDeviceSession('shopper', server(w, 'off').api, {
      openStore: () => Promise.reject(new DeviceStorageError('IndexedDB is blocked')),
      loadWallet: async () => null,
    })
    expect(off).toEqual({ phase: 'off', store: null })
    const broken = await openDeviceSession('shopper', server(w, 'ready').api, {
      openStore: () => Promise.reject(new Error('something else')),
      loadWallet: async () => null,
    })
    expect(broken).toEqual({ phase: 'error', store: null })
  })
})
