/**
 * SalvoEscrowV2 in our books (DATABASE-BACKED: needs the Postgres test
 * schema, like escrow-routes.test.ts and escrow-keeper.test.ts). The halves
 * of phase 3a that write rows, run against the real V2 contract on the
 * in-process EVM and fake Lit running the real salvo-vault-escrow/2:
 *   - POST /api/escrow/listings takes a V2 listing with its card fingerprint,
 *     and refuses the same card while another listing of it is for sale, or
 *     once it was sold on V1 to someone else; the V1 buyer may sell it on.
 *   - The V2 keeper writes one order per sale, keeps the listing offered with
 *     what is left, moves it to executing once drained, gives the first
 *     shopper's deposit back two hours after the next shopper's use held, and
 *     books a contested leftover: the report on the reporter's order, the
 *     shortfall on the order whose deposit paid the seller, which the
 *     standing readers then count.
 *   - POST /api/escrow/quote plans another shopper's leftover only once it
 *     has rested two hours, or at once after POST /api/escrow/done from the
 *     key the chain names for that sale; another key's done is refused.
 * The pure rules behind these are in escrow-v2-keeper-rules.test.ts,
 * escrow-card-fingerprint.test.ts and escrow-standing.test.ts, and the chain
 * work in escrow-v2-server.test.ts.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keccak256, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'

const { prisma } = await import('@/lib/db')
const { POST: listingsRoute } = await import('@/app/api/escrow/listings/route')
const { cardFingerprint } = await import('@/lib/escrow/card-fingerprint')
const { runEscrowKeeperV2 } = await import('@/lib/escrow/keeper-v2')
const { escrowIntentData, PROBE_ENVELOPE } = await import('@/lib/escrow/listing')
const { buildEscrowManifest, parseEscrowManifest } = await import('@/lib/escrow/manifest')
const { escrowIntentIdFor } = await import('@/lib/escrow/refs')
const { __setEscrowRuntimeForTests } = await import('@/lib/escrow/runtime')
const { escrowBuyerStanding, escrowWholeCardSellers } = await import('@/lib/escrow/standing')
const { __clearTicketedCardsV2ForTests } = await import('@/lib/escrow/ticket-v2')
const { ESCROW_V1 } = await import('@/lib/vault/lit/templates')
const { escrowV2Call } = await import('./support/escrow-v2-chain')
const worldV2 = await import('./support/escrow-server-world-v2')
const { testAddress } = await import('./support/evm')
const { resetDb } = await import('./helpers')
const { POST: quoteRoute } = await import('@/app/api/escrow/quote/route')
const { parseQuoteV2 } = await import('@/lib/escrow/client/api-v2')
const { LEFTOVER_REST_MS } = await import('@/lib/escrow/quote-v2')
const { quoteProblemsV2 } = await import('@/lib/escrow/quote-v2')
const { __clearTillQuoteV2ForTests } = await import('@/lib/escrow/till-quote-v2')
const { __clearEscrowReservationsForTests } = await import('@/lib/escrow/quote')
const { POST: doneRoute } = await import('@/app/api/escrow/done/route')
const { createBrowserReplyKey } = await import('@/lib/escrow/client/reply')
const { signDoneV2 } = await import('@/lib/escrow/done-proof-v2')
const { __clearLeftoverDoneForTests } = await import('@/lib/escrow/leftover-done')
const { __clearReleaseMemoryForTests } = await import('@/lib/escrow/lit-escrow')
const { ESCROW_CHAIN_ID } = await import('@/lib/escrow/manifest')

const { SELLER_V2, SHOPPER_A, SHOPPER_B, closeServerWorldV2, listV2, serverWorldV2, useCardV2 } = worldV2
type ServerWorldV2 = Awaited<ReturnType<typeof serverWorldV2>>

const APP = 'http://localhost:3000'
const HOUR = 3_600
const REASON: Hex = keccak256('0x656d707479')
const SAVED = {
  ESCROW_RAIL: process.env.ESCROW_RAIL,
  LIT_VAULT_USAGE_KEY: process.env.LIT_VAULT_USAGE_KEY,
  ESCROW_SELLER_ALLOWLIST: process.env.ESCROW_SELLER_ALLOWLIST,
}

function setEnvVars(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

let testIndex = 0

beforeEach(async () => {
  await resetDb()
  __clearTicketedCardsV2ForTests()
  testIndex += 1
  setEnvVars({ ESCROW_RAIL: 'testnet', LIT_VAULT_USAGE_KEY: 'usage-key-for-tests', ESCROW_SELLER_ALLOWLIST: undefined })
})

afterEach(() => {
  closeServerWorldV2()
})

afterAll(async () => {
  setEnvVars(SAVED)
  await resetDb()
  await prisma.$disconnect()
})

/** The V2 world, with a server clock a few minutes on per test so the per-process limits never carry over. */
async function world(): Promise<ServerWorldV2> {
  const w = await serverWorldV2()
  const at = Number(w.node.chain.timestamp) * 1000 + testIndex * 180_000
  const rt = { ...w.rt, now: () => at }
  __setEscrowRuntimeForTests(rt)
  return { ...w, rt }
}

function post(path: string, body: unknown): Request {
  return new Request(`${APP}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: APP },
    body: JSON.stringify(body),
  })
}

async function postListing(l: Awaited<ReturnType<typeof listV2>>, fingerprint: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await listingsRoute(post('/api/escrow/listings', { manifest: l.manifestText, envelope: l.envelope, txHash: `0x${'3'.repeat(64)}`, cardFingerprint: fingerprint }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** A V1 sale of `cardNumber`, as the V1 keeper leaves it: the listing completed, its order paid by `buyer`. */
async function soldOnV1(cardNumber: string, seller: Hex, buyer: Hex): Promise<void> {
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
    salt: 'e'.repeat(64),
  })
  const m = parseEscrowManifest(text, escrow)
  if (m === null) throw new Error('the V1 manifest did not parse')
  const order = await prisma.order.create({
    data: {
      buyerEmail: '',
      kind: 'gift_card',
      merchantId: 'salvotest',
      deadlineAt: new Date(),
      qty: 1,
      priceCents: 1_800,
      rail: 'mpp',
      paymentRef: `escrow:tempo-moderato:${escrow}:1`,
      payerAddress: buyer,
      state: 'fulfilled',
    },
  })
  const data = escrowIntentData(ESCROW_V1, m, text, PROBE_ENVELOPE, new Date(), await cardFingerprint(9, cardNumber))
  await prisma.intent.create({ data: { ...data, state: 'completed', matchedOrderId: order.id } })
}

describe('POST /api/escrow/listings, V2', () => {
  it('takes a V2 listing with its fingerprint, and refuses a second listing of the same card while the first is for sale', async () => {
    const w = await world()
    const l = await listV2(w)
    const fp = await cardFingerprint(9, l.cardNumber)
    const first = await postListing(l, fp)
    expect(first).toMatchObject({ status: 201, body: { listed: true, created: true, version: 2, listingId: l.listingId } })
    const row = await prisma.intent.findUniqueOrThrow({ where: { id: escrowIntentIdFor(l.listingId) } })
    expect(row).toMatchObject({ state: 'offered', accountId: `seller:${SELLER_V2}`, formFactor: 'escrow_sealed', faceValueCents: 2_000, last4: '' })
    expect(row.sealedRef).toMatchObject({ cardFingerprint: fp, lit: { template: 'salvo-vault-escrow/2' } })
    // Posting the same listing again is one listing.
    expect(await postListing(l, fp)).toMatchObject({ status: 200, body: { created: false } })

    const again = await listV2(w, { cardNumber: l.cardNumber })
    expect(await postListing(again, fp)).toMatchObject({ status: 409, body: { error: 'card_listed' } })
    // Cancelled on chain, the card may be listed again.
    expect((await w.node.chain.send(SELLER_V2, w.escrow, escrowV2Call.cancelListing(l.listingId))).ok).toBe(true)
    expect(await postListing(again, fp)).toMatchObject({ status: 201, body: { version: 2 } })
  })

  it('a card sold on V1 is refused on V2 for its seller and anyone else, and taken from its V1 buyer', async () => {
    const w = await world()
    const card = '9999000011112222'
    const v1Buyer = testAddress(321)
    await soldOnV1(card, SELLER_V2, v1Buyer)
    const fp = await cardFingerprint(9, card)
    const bySeller = await listV2(w, { cardNumber: card, seller: SELLER_V2 })
    expect(await postListing(bySeller, fp)).toMatchObject({ status: 409, body: { error: 'card_sold' } })
    const byBuyer = await listV2(w, { cardNumber: card, seller: v1Buyer })
    expect(await postListing(byBuyer, fp)).toMatchObject({ status: 201, body: { version: 2 } })
  })

  it('refuses a V2 listing with no fingerprint, and a V1 listing once V2 is configured', async () => {
    const w = await world()
    const l = await listV2(w)
    const res = await listingsRoute(post('/api/escrow/listings', { manifest: l.manifestText, envelope: l.envelope, txHash: `0x${'3'.repeat(64)}` }))
    expect([res.status, ((await res.json()) as Record<string, unknown>).error]).toEqual([400, 'bad_fingerprint'])
    const v1 = await listingsRoute(post('/api/escrow/listings', { manifest: '{"v":1}', envelope: l.envelope, txHash: `0x${'3'.repeat(64)}` }))
    expect([v1.status, ((await v1.json()) as Record<string, unknown>).error]).toEqual([410, 'v1_frozen'])
    expect(await prisma.intent.count()).toBe(0)
  })
})

describe('the V2 keeper in our books', () => {
  async function listed(w: ServerWorldV2) {
    const l = await listV2(w)
    expect((await postListing(l, await cardFingerprint(9, l.cardNumber))).status).toBe(201)
    return l
  }

  it('one order per sale; the listing offered with what is left, then executing once drained; the deposit back after two hours', async () => {
    const w = await world()
    const key = generatePrivateKey()
    const l = await listed(w)
    const id = escrowIntentIdFor(l.listingId)
    const a = await useCardV2(w, l, SHOPPER_A, 1_700)
    let r = await runEscrowKeeperV2({ apply: true, keeperKey: key, rt: w.rt })
    expect(r).toMatchObject({ ran: true, ordersCreated: 1, errors: [] })
    const orderA = await prisma.order.findFirstOrThrow({ where: { payerAddress: SHOPPER_A } })
    expect(orderA).toMatchObject({ state: 'fulfilling', priceCents: 1_530, paymentRef: `escrow:tempo-moderato:${w.escrow}:${a.depositId}` })
    expect(await prisma.intent.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'offered', lastKnownBalanceCents: 300 })

    const b = await useCardV2(w, l, SHOPPER_B, 300)
    r = await runEscrowKeeperV2({ apply: true, keeperKey: key, rt: w.rt })
    expect(r).toMatchObject({ ordersCreated: 1, listingsMoved: 1, bondsDue: 0, errors: [] })
    const orderB = await prisma.order.findFirstOrThrow({ where: { payerAddress: SHOPPER_B } })
    expect(await prisma.intent.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'executing', matchedOrderId: orderB.id })

    w.node.advance(2 * HOUR)
    r = await runEscrowKeeperV2({ apply: true, keeperKey: key, rt: w.rt })
    expect(r).toMatchObject({ bondsDue: 1, bondsSent: 1, errors: [] })
    expect(b.depositId).toBe(a.depositId + 1n)
  })

  it('a contested leftover: the report on the reporter, the shortfall on the first shopper, and the standing readers count them', async () => {
    const w = await world()
    const l = await listed(w)
    const id = escrowIntentIdFor(l.listingId)
    await useCardV2(w, l, SHOPPER_A, 1_700)
    const b = await useCardV2(w, l, SHOPPER_B, 300)
    await runEscrowKeeperV2({ apply: true, keeperKey: null, rt: w.rt })
    expect((await w.node.chain.send(SHOPPER_B, w.escrow, escrowV2Call.contestRemainder(b.depositId, REASON))).ok).toBe(true)
    const r = await runEscrowKeeperV2({ apply: true, keeperKey: null, rt: w.rt })
    expect(r).toMatchObject({ contested: 1, errors: [] })

    const orderB = await prisma.order.findFirstOrThrow({ where: { payerAddress: SHOPPER_B } })
    expect(orderB.state).toBe('refunded')
    const reasonsB = (await prisma.orderEvent.findMany({ where: { orderId: orderB.id } })).map((e) => e.reason ?? '')
    expect(reasonsB.some((x) => x.startsWith(`ESCROW|Contested|deposit:${b.depositId}|`) && x.includes(`|seller:${SELLER_V2}|`))).toBe(true)
    const orderA = await prisma.order.findFirstOrThrow({ where: { payerAddress: SHOPPER_A } })
    const reasonsA = (await prisma.orderEvent.findMany({ where: { orderId: orderA.id } })).map((e) => e.reason ?? '')
    expect(reasonsA.some((x) => x.startsWith('ESCROW|Shortfall|'))).toBe(true)
    expect(await prisma.intent.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'refunded' })

    // The events carry the database's own clock, so standing is read at the wall clock's now.
    expect(await escrowBuyerStanding(SHOPPER_B)).toMatchObject({ reports: 1, shortfalls: 0, remaindersAllowed: true })
    expect(await escrowBuyerStanding(SHOPPER_A)).toMatchObject({ reports: 0, shortfalls: 1, remaindersAllowed: true })
    // One buyer found this seller short: not yet whole cards only.
    expect(await escrowWholeCardSellers()).toEqual([])
  })
})

describe("POST /api/escrow/quote, V2: the till's planner over live V2 supply", () => {
  const ask = (depositor: Hex, totalCents: number, merchant = 'salvotest') =>
    quoteRoute(post('/api/escrow/quote', { version: 2, merchant, totalCents, depositor, preference: { mode: 'in_and_out', maxCards: 2 } }))

  it('plans from the chain, not the row: a leftover first and whole, the cards held for that shopper, and a store with nothing says so', async () => {
    __clearTillQuoteV2ForTests()
    __clearEscrowReservationsForTests()
    const w = await world()
    const big = await listV2(w, { valueCents: 2_000 })
    const small = await listV2(w, { valueCents: 1_000 })
    for (const l of [big, small]) expect((await postListing(l, await cardFingerprint(9, l.cardNumber))).status).toBe(201)
    // Another shopper used 16.00 of the $20 card: the chain says 4.00 is left, behind their deposit; the row still says 20.00.
    await useCardV2(w, big, SHOPPER_A, 1_600)
    expect(await prisma.intent.findUniqueOrThrow({ where: { id: escrowIntentIdFor(big.listingId) } })).toMatchObject({ faceValueCents: 2_000, lastKnownBalanceCents: null })
    // That shopper may still have the card on screen, unscanned: its leftover rests two hours before anyone else is
    // offered it (the finding: offered once the quote's two-minute hold ended, the next register took what they paid for).
    w.node.advance(600)
    const early = await ask(SHOPPER_B, 1_100)
    expect([early.status, ((await early.json()) as Record<string, unknown>).error]).toEqual([409, 'unavailable'])
    w.node.advance(LEFTOVER_REST_MS / 1000)

    const res = await ask(SHOPPER_B, 1_100)
    expect(res.status).toBe(200)
    const q = parseQuoteV2(((await res.json()) as Record<string, unknown>).quote)
    if (q === null) throw new Error('not a V2 quote')
    expect(q.legs.map((l) => [l.intentId, l.source, l.usedCents, l.leftCents])).toEqual([
      [escrowIntentIdFor(big.listingId), 'remainder', 400, 0],
      [escrowIntentIdFor(small.listingId), 'fresh', 700, 300],
    ])
    // The phone's own check passes it.
    expect(quoteProblemsV2(q, { merchant: 'salvotest', totalCents: 1_100, depositor: SHOPPER_B }, w.escrow)).toEqual([])
    // Held for that shopper: nobody else is offered them for two minutes.
    const other = await ask(testAddress(314), 500)
    expect([other.status, ((await other.json()) as Record<string, unknown>).error]).toEqual([409, 'nothing_listed'])
    // A store with nothing listed at all.
    const none = await ask(SHOPPER_B, 1_000, 'target')
    expect([none.status, ((await none.json()) as Record<string, unknown>).error]).toEqual([409, 'nothing_listed'])
    // The seller is never sold their own card.
    const own = await ask(SELLER_V2, 500)
    expect(own.status).toBe(409)
  })

  it("a leftover whose first shopper said done is planned at once, by the key the chain names for that sale; another key's done is refused", async () => {
    __clearTillQuoteV2ForTests()
    __clearEscrowReservationsForTests()
    __clearReleaseMemoryForTests()
    __clearLeftoverDoneForTests()
    const w = await world()
    const big = await listV2(w, { valueCents: 2_000 })
    const small = await listV2(w, { valueCents: 1_000 })
    for (const l of [big, small]) expect((await postListing(l, await cardFingerprint(9, l.cardNumber))).status).toBe(201)
    // The first shopper's phone holds this card's reply key: the sale names it.
    const key = createBrowserReplyKey()
    const sale = await useCardV2(w, big, SHOPPER_A, 1_600, { replyKeyHash: key.replyKeyHash })
    const at = { chainId: ESCROW_CHAIN_ID, escrow: w.escrow, depositId: sale.depositId.toString() }
    const done = (replyKey: Hex, signature: Hex) => doneRoute(post('/api/escrow/done', { escrow: w.escrow, depositId: at.depositId, replyKey, signature }))
    // Their card on screen: the $4.00 rests, and the $10 card alone cannot cover $11.00.
    const early = await ask(SHOPPER_B, 1_100)
    expect([early.status, ((await early.json()) as Record<string, unknown>).error]).toEqual([409, 'unavailable'])

    // Another key's done for that sale is refused, and the leftover still rests.
    const other = createBrowserReplyKey()
    expect((await done(other.publicKey, signDoneV2(other.secretKey, at))).status).toBe(403)
    expect((await ask(SHOPPER_B, 1_100)).status).toBe(409)

    // The first shopper taps Done: the same second on the chain, it is planned first and whole.
    const res = await done(key.publicKey, signDoneV2(key.secretKey, at))
    expect([res.status, await res.json()]).toEqual([200, { done: true }])
    const now = await ask(SHOPPER_B, 1_100)
    expect(now.status).toBe(200)
    const q = parseQuoteV2(((await now.json()) as Record<string, unknown>).quote)
    expect(q?.legs.map((l) => [l.intentId, l.source, l.usedCents, l.leftCents])).toEqual([
      [escrowIntentIdFor(big.listingId), 'remainder', 400, 0],
      [escrowIntentIdFor(small.listingId), 'fresh', 700, 300],
    ])
  })
})
