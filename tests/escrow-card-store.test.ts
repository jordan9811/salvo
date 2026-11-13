/**
 * What the shopper's phone keeps (src/lib/escrow/client/card-store.ts), on a
 * fake IndexedDB with the browser's semantics (tests/support/fake-indexeddb.ts).
 *
 * Pinned:
 *   - every secret (reply key, card number and PIN) is stored only as an
 *     AES-GCM box, under one non-extractable key that is stored as a key
 *     handle and can never be exported;
 *   - a box is bound to its slot: moved to another slot it does not open;
 *   - two tabs opening the store at once end up with ONE wrapping key, so no
 *     box is ever sealed under a key that is then lost;
 *   - a reload (a new store on the same browser profile) opens what the
 *     last one sealed;
 *   - a browser that refuses storage is told apart, in a plain sentence.
 * No network, no database.
 */

import { describe, expect, it } from 'vitest'
import { CardStore, DeviceStorageError, openCardStore, type CardRecord, type PurchaseRecord } from '@/lib/escrow/client/card-store'
import { FakeIndexedDB } from './support/fake-indexeddb'

const CARD = '9999123456789012'
const ESCROW = '0x00000000000000000000000000000000000000e5' as const

function cardMeta(depositId: string, boughtAt: number, scanOrder = 1): Omit<CardRecord, 'box'> {
  return {
    id: `${ESCROW}:${depositId}`,
    escrow: ESCROW,
    depositId,
    listingId: `0x${'ab'.repeat(32)}`,
    merchant: 'salvotest',
    valueCents: 2_000,
    priceUnits: 18_000_000,
    scanOrder,
    ofCards: 1,
    last4: CARD.slice(-4),
    boughtAt,
  }
}

/** Every byte the fake browser holds, as text, so a test can look for card digits in it. */
function everythingStored(idb: FakeIndexedDB): string {
  const parts: string[] = []
  const walk = (v: unknown): void => {
    if (v instanceof Uint8Array) parts.push(Buffer.from(v).toString('latin1'), Buffer.from(v).toString('hex'))
    else if (typeof v === 'string') parts.push(v)
    else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) walk(x)
  }
  for (const [k, v] of idb.dump()) {
    parts.push(String(k))
    walk(v)
  }
  return parts.join('|')
}

describe('the device store', () => {
  it('seals reply keys and cards under one non-extractable key, and stores no secret in clear', async () => {
    const idb = new FakeIndexedDB()
    const store = await openCardStore(idb.asFactory())
    const reply = crypto.getRandomValues(new Uint8Array(32))
    await store.saveReplyKey('p1:0', reply)
    await store.saveCard(cardMeta('7', 1000), { cardNumber: CARD, pin: '4321' })

    const dump = idb.dump()
    const wrap = dump.get('wrap-key')
    expect(wrap).toBeInstanceOf(CryptoKey)
    expect((wrap as CryptoKey).extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', wrap as CryptoKey)).rejects.toThrow()

    const stored = everythingStored(idb)
    expect(stored).not.toContain(CARD)
    expect(stored).not.toContain('4321')
    expect(stored).not.toContain(Buffer.from(reply).toString('hex'))

    expect(await store.replyKey('p1:0')).toEqual(reply)
    expect(await store.cardSecret(`${ESCROW}:7`)).toEqual({ cardNumber: CARD, pin: '4321' })
  })

  it('opens after a reload, on the same browser profile', async () => {
    const idb = new FakeIndexedDB()
    const first = await openCardStore(idb.asFactory())
    await first.saveCard(cardMeta('3', 1000), { cardNumber: CARD, pin: null })
    await first.saveReplyKey('p2:1', new Uint8Array(32).fill(7))

    const reloaded = await CardStore.open(idb.asFactory())
    expect(await reloaded.cardSecret(`${ESCROW}:3`)).toEqual({ cardNumber: CARD, pin: null })
    expect(await reloaded.replyKey('p2:1')).toEqual(new Uint8Array(32).fill(7))
    expect((await reloaded.cards()).map((c) => c.depositId)).toEqual(['3'])
  })

  it('a box moved to another slot, or changed, does not open', async () => {
    const idb = new FakeIndexedDB()
    const store = await openCardStore(idb.asFactory())
    await store.saveCard(cardMeta('1', 1000), { cardNumber: CARD, pin: null })
    await store.saveCard(cardMeta('2', 2000), { cardNumber: '9999000000000002', pin: null })

    // Put card 1's box under card 2's slot, as someone editing the database would.
    const data = idb.databases.get('salvo-pay')?.data.get('kv') as Map<IDBValidKey, unknown>
    const one = data.get(`card:${ESCROW}:1`) as CardRecord
    const two = data.get(`card:${ESCROW}:2`) as CardRecord
    data.set(`card:${ESCROW}:2`, { ...two, box: one.box })
    expect(await store.cardSecret(`${ESCROW}:2`)).toBeNull()

    const flipped = new Uint8Array(one.box.ct)
    flipped[0] = (flipped[0] ?? 0) ^ 1
    data.set(`card:${ESCROW}:1`, { ...one, box: { iv: one.box.iv, ct: flipped } })
    expect(await store.cardSecret(`${ESCROW}:1`)).toBeNull()
  })

  it('two tabs at once keep one wrapping key, so neither seals under a key that is lost', async () => {
    const idb = new FakeIndexedDB()
    const [a, b] = await Promise.all([openCardStore(idb.asFactory()), openCardStore(idb.asFactory())])
    await Promise.all([a.saveReplyKey('a:0', new Uint8Array(32).fill(1)), b.saveReplyKey('b:0', new Uint8Array(32).fill(2))])
    const later = await openCardStore(idb.asFactory())
    expect(await later.replyKey('a:0')).toEqual(new Uint8Array(32).fill(1))
    expect(await later.replyKey('b:0')).toEqual(new Uint8Array(32).fill(2))
  })

  it('deletes a reply key for good, and saving a card twice keeps one card', async () => {
    const store = await openCardStore(new FakeIndexedDB().asFactory())
    await store.saveReplyKey('p:0', new Uint8Array(32).fill(9))
    await store.deleteReplyKey('p:0')
    expect(await store.replyKey('p:0')).toBeNull()
    await expect(store.saveReplyKey('p:1', new Uint8Array(31))).rejects.toThrow(RangeError)

    await store.saveCard(cardMeta('5', 1000), { cardNumber: CARD, pin: null })
    await store.saveCard(cardMeta('5', 1000), { cardNumber: CARD, pin: null })
    expect(await store.cards()).toHaveLength(1)
  })

  it('lists purchases and cards newest first', async () => {
    const store = await openCardStore(new FakeIndexedDB().asFactory())
    const purchase = (id: string, createdAt: number): PurchaseRecord => ({
      id,
      createdAt,
      merchant: 'salvotest',
      depositor: '0x00000000000000000000000000000000000000d1',
      escrow: ESCROW,
      txHash: null,
      raw: null,
      state: 'signed',
      legs: [],
      problem: null,
    })
    await store.savePurchase(purchase('old', 1))
    await store.savePurchase(purchase('new', 2))
    expect((await store.purchases()).map((p) => p.id)).toEqual(['new', 'old'])
    expect((await store.purchase('old'))?.createdAt).toBe(1)
    expect(await store.purchase('missing')).toBeNull()

    await store.saveCard(cardMeta('10', 100), { cardNumber: CARD, pin: null })
    await store.saveCard(cardMeta('11', 200, 2), { cardNumber: CARD, pin: null })
    expect((await store.cards()).map((c) => c.depositId)).toEqual(['11', '10'])
  })

  it('says plainly when the browser keeps nothing', async () => {
    const idb = new FakeIndexedDB()
    idb.blocked = true
    await expect(openCardStore(idb.asFactory())).rejects.toBeInstanceOf(DeviceStorageError)
    await expect(openCardStore(null)).rejects.toThrow(/would not let Salvo Pay keep anything/)
  })
})
