/**
 * The V2 listing route's card check, end to end with no Postgres
 * (listing-v2.ts acceptSealedListingV2 and recordV1FingerprintByBuyer): the
 * real SalvoEscrowV2 on the in-process chain, fake Lit running the real
 * salvo-vault-escrow/2, and the few Intent and Order rows the check reads
 * held in memory (tests/support/fake-prisma-books.ts).
 *
 * Pinned:
 *   - the card's history is judged before the new listing's own chain
 *     read, so the seller's first post, sent before `list`, refuses a card
 *     already listed or sold before any fee is paid;
 *   - a listing our books still show offered, which the chain shows drained,
 *     blocks its seller; a listing past its expiry blocks nothing;
 *   - the newest sale decides who owns the card: a card sold on, twice, can
 *     be listed by its current owner and nobody else;
 *   - a seller with a V1 sale at a store that carries no fingerprint lists
 *     nothing at that store on V2, until that sale's buyer gives its
 *     fingerprint; then the card itself is refused as sold, and others pass;
 *   - the buyer's phone gives it from Account (client/match-v1.ts) through
 *     POST /api/escrow/fingerprint: the fingerprint alone, never the card,
 *     once per card, only for this account's cards, with the account
 *     session as the buyer and never an address the body names.
 * The same route against the real schema is tests/escrow-v2-books.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'

vi.mock('@/lib/db', async () => {
  const { fakePrisma } = await import('./support/fake-prisma-books')
  return { prisma: fakePrisma }
})

import { POST as fingerprintRoute } from '@/app/api/escrow/fingerprint/route'
import { cardsToMatchV1, matchV1Cards } from '@/lib/account/client/match-v1'
import { accountApi } from '@/lib/account/client/passkey'
import { ACCOUNT_COOKIE, mintAccountCookie } from '@/lib/account/session'
import { cardFingerprint } from '@/lib/escrow/card-fingerprint'
import { openCardStore, type CardStore, type PurchaseRecord } from '@/lib/escrow/client/card-store'
import { ESCROW_CHAIN_KEY } from '@/lib/escrow/config'
import { EscrowListingRefusedError, escrowIntentData, PROBE_ENVELOPE } from '@/lib/escrow/listing'
import { acceptSealedListingV2, escrowIntentDataV2, fingerprintChainV1, fingerprintChainV2, recordV1FingerprintByBuyer } from '@/lib/escrow/listing-v2'
import { buildEscrowManifest, parseEscrowManifest } from '@/lib/escrow/manifest'
import { escrowPaymentRef } from '@/lib/escrow/refs'
import { ESCROW_V1 } from '@/lib/vault/lit/templates'
import { fakeBooks } from './support/fake-prisma-books'
import { FakeIndexedDB } from './support/fake-indexeddb'
import { closeServerWorldV2, listV2, SELLER_V2, serverWorldV2, SHOPPER_A, SHOPPER_B, testCardNumberV2, useCardV2, type ListedV2, type ServerWorldV2 } from './support/escrow-server-world-v2'

const RAIL = process.env.ESCROW_RAIL
const USAGE_KEY = process.env.LIT_VAULT_USAGE_KEY
const ALLOW = process.env.ESCROW_SELLER_ALLOWLIST
const SECRET = process.env.OPERATOR_SECRET
const TX: Hex = `0x${'3'.repeat(64)}`

beforeEach(() => {
  process.env.ESCROW_RAIL = 'testnet'
  process.env.LIT_VAULT_USAGE_KEY = 'usage-key-for-tests'
  process.env.OPERATOR_SECRET = 'o'.repeat(32)
  delete process.env.ESCROW_SELLER_ALLOWLIST
  fakeBooks.reset()
})

afterEach(() => {
  closeServerWorldV2()
  for (const [k, v] of [['ESCROW_RAIL', RAIL], ['LIT_VAULT_USAGE_KEY', USAGE_KEY], ['ESCROW_SELLER_ALLOWLIST', ALLOW], ['OPERATOR_SECRET', SECRET]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

let orderCounter = 0

/** An order as the keeper writes one: paid by `payer`. */
function order(payer: Hex, paymentRef = `escrow:${ESCROW_CHAIN_KEY}:0x${'0'.repeat(40)}:${++orderCounter}`): string {
  const id = `ord_${++orderCounter}`
  fakeBooks.orders.push({ id, paymentRef, payerAddress: payer, state: 'fulfilled' })
  return id
}

/** A V2 listing row as the route records one, in `state`, listed at `at` ms. */
function rowV2(w: ServerWorldV2, l: ListedV2, fp: Hex, state: string, at: number, buyer: Hex | null = null): void {
  const data = escrowIntentDataV2(w.template, l.manifest, l.manifestText, l.envelope, new Date(at), fp)
  fakeBooks.intents.push({ ...data, state, matchedOrderId: buyer === null ? null : order(buyer), createdAt: new Date(at), updatedAt: new Date(at) })
}

/** A V1 sale by `seller` to `buyer`, recorded as the V1 keeper leaves it, with or without a fingerprint. */
function soldOnV1(seller: Hex, buyer: Hex, depositId: bigint, fp: Hex | null): void {
  const escrow = ESCROW_V1.escrowAddress as Hex
  const text = buildEscrowManifest({
    escrow,
    seller,
    merchant: 9,
    mode: 2,
    valueCents: 2_000,
    price: 18_000_000,
    residualCapCents: 0,
    listingExpiry: 2_000_000_000,
    salt: `${depositId.toString(16).padStart(2, '0')}${'e'.repeat(62)}`,
  })
  const m = parseEscrowManifest(text, escrow)
  if (m === null) throw new Error('the V1 manifest did not parse')
  const data = escrowIntentData(ESCROW_V1, m, text, PROBE_ENVELOPE, new Date(1_000), fp)
  const orderId = order(buyer, escrowPaymentRef(ESCROW_CHAIN_KEY, escrow, depositId))
  fakeBooks.intents.push({ ...data, state: 'completed', matchedOrderId: orderId, createdAt: new Date(1_000), updatedAt: new Date(1_000) })
}

async function post(w: ServerWorldV2, l: ListedV2, fp: Hex): Promise<unknown> {
  return acceptSealedListingV2({ manifest: l.manifestText, envelope: l.envelope, txHash: TX, cardFingerprint: fp }, w.rt).catch((e: unknown) => e)
}

describe('the V2 listing route judges the card before the listing', () => {
  it("refuses a card already listed or sold on the seller's first post, before `list` is sent or paid", async () => {
    const w = await serverWorldV2()
    const card = testCardNumberV2()
    const fp = await cardFingerprint(9, card)
    const live = await listV2(w, { cardNumber: card })
    rowV2(w, live, fp, 'offered', 2_000)
    // Not on chain yet: the post the seller's page makes before it sends `list`.
    const again = await listV2(w, { cardNumber: card, onChain: false })
    const first = await post(w, again, fp)
    expect(first).toBeInstanceOf(EscrowListingRefusedError)
    expect(first).toMatchObject({ code: 'card_listed', status: 409 })

    // Sold to someone else: refused just as early.
    fakeBooks.reset()
    rowV2(w, live, fp, 'completed', 2_000, SHOPPER_A)
    expect(await post(w, again, fp)).toMatchObject({ code: 'card_sold', status: 409 })
    // A card with no history goes on to the listing's own state: not on chain yet, so the page sends `list`.
    const fresh = await listV2(w, { onChain: false })
    expect(await post(w, fresh, await cardFingerprint(9, fresh.cardNumber))).toMatchObject({ code: 'not_on_chain_yet', status: 409 })
    expect(fakeBooks.intents).toHaveLength(1)
  })

  it('a listing our books still show offered, which the chain shows drained, blocks its seller; its buyer waits for the keeper', async () => {
    const w = await serverWorldV2()
    const card = testCardNumberV2()
    const fp = await cardFingerprint(9, card)
    const first = await listV2(w, { cardNumber: card, valueCents: 2_000 })
    rowV2(w, first, fp, 'offered', 2_000)
    // Drained on chain; the keeper has not run, so the row is still offered.
    await useCardV2(w, first, SHOPPER_A, 2_000)
    const relist = await listV2(w, { cardNumber: card })
    expect(await post(w, relist, fp)).toMatchObject({ code: 'card_sold' })
    const byBuyer = await listV2(w, { cardNumber: card, seller: SHOPPER_A })
    expect(await post(w, byBuyer, fp)).toMatchObject({ code: 'card_not_paid_out' })
    expect(fakeBooks.intents).toHaveLength(1)
  })

  it('a listing past its expiry, still Active on chain, blocks nothing', async () => {
    const w = await serverWorldV2()
    const card = testCardNumberV2()
    const fp = await cardFingerprint(9, card)
    const ending = await listV2(w, { cardNumber: card, listingExpiry: Number(w.node.chain.timestamp) + 300 })
    rowV2(w, ending, fp, 'offered', 2_000)
    const early = await listV2(w, { cardNumber: card })
    expect(await post(w, early, fp)).toMatchObject({ code: 'card_listed' })
    w.node.advance(600)
    const later = await listV2(w, { cardNumber: card })
    expect(await post(w, later, fp)).toMatchObject({ created: true, version: 2 })
  })

  it('the newest sale decides: a card sold on twice is listed by its current owner, and refused to the owners before', async () => {
    const w = await serverWorldV2()
    const card = testCardNumberV2()
    const fp = await cardFingerprint(9, card)
    // SELLER_V2 sold it to SHOPPER_A, who sold it back to SHOPPER_B.
    rowV2(w, await listV2(w, { cardNumber: card, onChain: false }), fp, 'completed', 2_000, SHOPPER_A)
    rowV2(w, await listV2(w, { cardNumber: card, seller: SHOPPER_A, onChain: false }), fp, 'completed', 3_000, SHOPPER_B)
    expect(await post(w, await listV2(w, { cardNumber: card, seller: SHOPPER_A }), fp)).toMatchObject({ code: 'card_sold' })
    expect(await post(w, await listV2(w, { cardNumber: card }), fp)).toMatchObject({ code: 'card_sold' })
    expect(await post(w, await listV2(w, { cardNumber: card, seller: SHOPPER_B }), fp)).toMatchObject({ created: true })
  })
})

describe('a V1 sale with no fingerprint', () => {
  it("holds back its seller's V2 listings at that store until its buyer gives the fingerprint; then the card itself is refused", async () => {
    const w = await serverWorldV2()
    const v1Card = testCardNumberV2()
    const v1Fp = await cardFingerprint(9, v1Card)
    soldOnV1(SELLER_V2, SHOPPER_B, 7n, null)

    // Any card of SELLER_V2's at salvotest: it could be the one sold on V1.
    const other = await listV2(w)
    const otherFp = await cardFingerprint(9, other.cardNumber)
    expect(await post(w, other, otherFp)).toMatchObject({ code: 'card_unmatched', status: 409 })
    const sameCard = await listV2(w, { cardNumber: v1Card })
    expect(await post(w, sameCard, v1Fp)).toMatchObject({ code: 'card_unmatched' })
    // Another seller is not held back.
    const theirs = await listV2(w, { seller: SHOPPER_A })
    expect(await post(w, theirs, await cardFingerprint(9, theirs.cardNumber))).toMatchObject({ created: true })

    // Only the sale's own buyer may give its fingerprint, and only once.
    await expect(recordV1FingerprintByBuyer({ buyer: SHOPPER_A, depositId: 7n, cardFingerprint: v1Fp }, w.rt)).resolves.toBe('not_yours')
    await expect(recordV1FingerprintByBuyer({ buyer: SHOPPER_B, depositId: 8n, cardFingerprint: v1Fp }, w.rt)).resolves.toBe('no_sale')
    await expect(recordV1FingerprintByBuyer({ buyer: SHOPPER_B, depositId: 7n, cardFingerprint: 'nope' }, w.rt)).rejects.toMatchObject({ code: 'bad_fingerprint' })
    await expect(recordV1FingerprintByBuyer({ buyer: SHOPPER_B, depositId: 7n, cardFingerprint: v1Fp }, w.rt)).resolves.toBe('recorded')
    await expect(recordV1FingerprintByBuyer({ buyer: SHOPPER_B, depositId: 7n, cardFingerprint: otherFp }, w.rt)).resolves.toBe('already')

    // Matched: the V1 card is refused as sold, and the seller's other card lists.
    expect(await post(w, sameCard, v1Fp)).toMatchObject({ code: 'card_sold' })
    expect(await post(w, other, otherFp)).toMatchObject({ created: true })
    // Its buyer may sell it on V2.
    expect(await post(w, await listV2(w, { cardNumber: v1Card, seller: SHOPPER_B }), v1Fp)).toMatchObject({ created: true })
  })

  it('a V1 listing still for sale with no fingerprint holds its seller back at that store until it is taken back', async () => {
    const w = await serverWorldV2()
    soldOnV1(SELLER_V2, SHOPPER_B, 11n, null)
    const row = fakeBooks.intents.at(-1) as Record<string, unknown>
    row.state = 'offered'
    row.matchedOrderId = null
    const l = await listV2(w)
    const fp = await cardFingerprint(9, l.cardNumber)
    const refused = await post(w, l, fp)
    expect(refused).toMatchObject({ code: 'card_unmatched', status: 409 })
    expect((refused as Error).message).toContain('Take those back first, then list here.')
    // Taken back: the keeper moves the row to cancelled, and the seller lists.
    row.state = 'cancelled'
    expect(await post(w, l, fp)).toMatchObject({ created: true })
  })

  it('a V1 sale that carries its fingerprint holds nothing back', async () => {
    const w = await serverWorldV2()
    soldOnV1(SELLER_V2, SHOPPER_B, 9n, await cardFingerprint(9, testCardNumberV2()))
    const l = await listV2(w)
    expect(await post(w, l, await cardFingerprint(9, l.cardNumber))).toMatchObject({ created: true })
  })
})

/** Our own page's origin, as the escrow routes read it. */
const APP = new URL(process.env.APP_URL ?? 'http://localhost:3000').origin
const DAY_MS = 86_400_000

/** A POST to the fingerprint route from our own page, signed in as `account` (or not at all). */
function fingerprintPost(body: unknown, account: Hex | null, headers: Record<string, string> = {}): Request {
  const cookie: Record<string, string> = account === null ? {} : { cookie: `${ACCOUNT_COOKIE}=${mintAccountCookie(account, null)}` }
  return new Request(`${APP}/api/escrow/fingerprint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP, 'sec-fetch-site': 'same-origin', ...cookie, ...headers },
    body: JSON.stringify(body),
  })
}

/** The account page's API, its fingerprint post answered by the route in-process, signed in as `account`. */
function apiSignedInAs(account: Hex, sent: unknown[]) {
  return accountApi(async (path, init) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null
    sent.push(body)
    if (path !== '/api/escrow/fingerprint') throw new Error(`no route ${path}`)
    return fingerprintRoute(fingerprintPost(body, account))
  })
}

/** A buyer's phone holding cards it bought whole on V1: sealed in its store, as the first escrow's Load kept them. */
async function v1Phone(cards: Array<{ depositId: string; cardNumber: string; buyer: Hex; boughtAt?: number }>): Promise<CardStore> {
  const store = await openCardStore(new FakeIndexedDB().asFactory())
  const escrow = ESCROW_V1.escrowAddress as Hex
  for (const c of cards) {
    await store.saveCard(
      {
        id: `${escrow}:${c.depositId}`,
        escrow,
        depositId: c.depositId,
        listingId: `0x${c.depositId.padStart(64, '0')}`,
        merchant: 'salvotest',
        valueCents: 2_000,
        priceUnits: 18_000_000,
        scanOrder: 1,
        ofCards: 1,
        last4: c.cardNumber.slice(-4),
        boughtAt: c.boughtAt ?? Date.now() - 3 * DAY_MS,
        mode: 2,
      },
      { cardNumber: c.cardNumber, pin: null },
    )
    const purchase = { id: `p-${c.depositId}`, createdAt: 1, merchant: 'salvotest', depositor: c.buyer, escrow, txHash: null, raw: null, state: 'done', legs: [{ depositId: c.depositId, refunded: false }], problem: null }
    await store.savePurchase(purchase as unknown as PurchaseRecord)
  }
  return store
}

describe("a V1 buyer's phone matches the card, so its seller lists on V2 again", () => {
  it('Account, signed in, gives each V1 card its fingerprint through the account session, never the card, once', async () => {
    const w = await serverWorldV2()
    const v1Card = testCardNumberV2()
    const v1Fp = await cardFingerprint(9, v1Card)
    soldOnV1(SELLER_V2, SHOPPER_B, 7n, null)
    const other = await listV2(w)
    const otherFp = await cardFingerprint(9, other.cardNumber)
    // The finding: V2 open, V1 frozen, and nothing ever called recordV1FingerprintByBuyer, so this seller could never sell here again.
    expect(await post(w, other, otherFp)).toMatchObject({ code: 'card_unmatched', status: 409 })

    // B's phone: the card it bought from SELLER_V2 on V1, and one another account bought on this browser.
    const theirs = testCardNumberV2()
    const store = await v1Phone([
      { depositId: '7', cardNumber: v1Card, buyer: SHOPPER_B },
      { depositId: '8', cardNumber: theirs, buyer: SHOPPER_A },
    ])
    const escrow = ESCROW_V1.escrowAddress as Hex
    expect((await cardsToMatchV1(store, escrow, SHOPPER_B)).map((c) => c.depositId)).toEqual(['7'])
    const sent: unknown[] = []
    expect(await matchV1Cards({ store, api: apiSignedInAs(SHOPPER_B, sent), v1Escrow: escrow, account: SHOPPER_B })).toEqual({ matched: 1, waiting: 0 })
    // Only the sale and the fingerprint went: never the number, and nothing of the other account's card.
    expect(sent).toEqual([{ depositId: '7', cardFingerprint: v1Fp }])
    expect(JSON.stringify(sent)).not.toContain(v1Card)
    expect(JSON.stringify(sent)).not.toContain(theirs)
    // Settled on the phone: the slow hash never runs for it again.
    expect(await cardsToMatchV1(store, escrow, SHOPPER_B)).toEqual([])
    expect(await matchV1Cards({ store, api: apiSignedInAs(SHOPPER_B, sent), v1Escrow: escrow, account: SHOPPER_B })).toEqual({ matched: 0, waiting: 0 })
    expect(sent).toHaveLength(1)

    // The seller lists at this store again; the V1 card itself is refused as sold, and its buyer may sell it on.
    expect(await post(w, other, otherFp)).toMatchObject({ created: true, version: 2 })
    expect(await post(w, await listV2(w, { cardNumber: v1Card }), v1Fp)).toMatchObject({ code: 'card_sold' })
    expect(await post(w, await listV2(w, { cardNumber: v1Card, seller: SHOPPER_B }), v1Fp)).toMatchObject({ created: true })
  }, 120_000)

  it('a server that does not answer, or no such sale yet, is asked again; an old "no such sale" is settled', async () => {
    await serverWorldV2()
    const escrow = ESCROW_V1.escrowAddress as Hex
    const store = await v1Phone([
      { depositId: '21', cardNumber: testCardNumberV2(), buyer: SHOPPER_B, boughtAt: Date.now() - 60_000 },
      { depositId: '22', cardNumber: testCardNumberV2(), buyer: SHOPPER_B, boughtAt: Date.now() - 3 * DAY_MS },
    ])
    // Our server out of reach: nothing is settled, and the second card is not even hashed.
    let asked = 0
    const down = accountApi(async () => {
      asked += 1
      return new Response('{}', { status: 503 })
    })
    expect(await matchV1Cards({ store, api: down, v1Escrow: escrow, account: SHOPPER_B })).toEqual({ matched: 0, waiting: 2 })
    expect(asked).toBe(1)
    // No sale for either in our books: the fresh one is asked again, the old one is settled.
    expect(await matchV1Cards({ store, api: apiSignedInAs(SHOPPER_B, []), v1Escrow: escrow, account: SHOPPER_B })).toEqual({ matched: 0, waiting: 1 })
    expect((await cardsToMatchV1(store, escrow, SHOPPER_B)).map((c) => c.depositId)).toEqual(['21'])
  }, 120_000)

  it('the route: signed in only, from our own page, with the sale and fingerprint alone, and the session is the buyer', async () => {
    const w = await serverWorldV2()
    const v1Fp = await cardFingerprint(9, testCardNumberV2())
    soldOnV1(SELLER_V2, SHOPPER_B, 7n, null)
    const answer = async (r: Request): Promise<[number, unknown]> => {
      const res = await fingerprintRoute(r)
      const b = (await res.json()) as Record<string, unknown>
      return [res.status, b.error ?? b.outcome]
    }
    const body = { depositId: '7', cardFingerprint: v1Fp }
    expect(await answer(fingerprintPost(body, null))).toEqual([401, 'not_signed_in'])
    expect(await answer(fingerprintPost(body, SHOPPER_B, { 'sec-fetch-site': 'cross-site' }))).toEqual([403, 'cross_site'])
    // The buyer is the session's account, never one the body names.
    expect(await answer(fingerprintPost({ ...body, buyer: SHOPPER_B }, SHOPPER_A))).toEqual([400, 'invalid_body'])
    expect(await answer(fingerprintPost({ ...body, cardNumber: '9999000000000001' }, SHOPPER_B))).toEqual([400, 'plaintext_refused'])
    expect(await answer(fingerprintPost({ ...body, depositId: 'seven' }, SHOPPER_B))).toEqual([400, 'invalid_body'])
    expect(await answer(fingerprintPost({ ...body, cardFingerprint: 'nope' }, SHOPPER_B))).toEqual([400, 'bad_fingerprint'])
    // Another account cannot give it: the seller stays held back.
    expect(await answer(fingerprintPost(body, SHOPPER_A))).toEqual([200, 'not_yours'])
    const l = await listV2(w)
    const fp = await cardFingerprint(9, l.cardNumber)
    expect(await post(w, l, fp)).toMatchObject({ code: 'card_unmatched' })
    // Its buyer can, once.
    expect(await answer(fingerprintPost(body, SHOPPER_B))).toEqual([200, 'recorded'])
    expect(await answer(fingerprintPost(body, SHOPPER_B))).toEqual([200, 'already'])
    expect(await post(w, l, fp)).toMatchObject({ created: true })
  }, 120_000)
})

describe('each escrow state as the verdict reads it', () => {
  it('V1: active for sale, sold whole, cancelled or past its expiry closed', () => {
    expect([1, 2, 3, 0].map((s) => fingerprintChainV1(s, false))).toEqual(['active', 'sold', 'closed', null])
    expect(fingerprintChainV1(1, true)).toBe('closed')
  })

  it('V2: active (a leftover too), drained is sold, cancelled or spent closed', () => {
    expect([1, 2, 3, 4, 0].map((s) => fingerprintChainV2(s, false))).toEqual(['active', 'sold', 'closed', 'closed', null])
    expect(fingerprintChainV2(1, true)).toBe('closed')
  })
})
