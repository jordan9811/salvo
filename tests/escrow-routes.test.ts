/**
 * The escrow routes: config, listings, quote, ticket and release (spec
 * sections 8.2, 8.3 and 10.3, with the lead's overrides).
 *
 * Run against the real pinned template on fake Lit, reading the real escrow
 * on the in-process EVM through the two fake hosts. What is pinned:
 *   - OFF unless ESCROW_RAIL=testnet: every route answers 503 with a plain
 *     sentence, and reads nothing.
 *   - Every POST is same-origin, JSON only, exact keys, and refuses any field
 *     named like card material, before anything else happens.
 *   - A listing is recorded only after the custody guard and the chain agree.
 *     On the testnet the guard is asked about the operator, whose own cards
 *     it allows, so a listing is taken; the escrow is still not counted
 *     non-custodial, and the guard still refuses a seller-kind owner. A
 *     guard refusal or a drifted template refuses before any chain read. An
 *     empty test list lets anyone list; a set one refuses everyone else.
 *   - The quote picks whole cards in scan order, keeps reservations, and
 *     skips suspect listings, disputed sellers, the shopper's own listings
 *     and listings the chain shows sold; one address holds only a few cards.
 *   - A ticket and a release are one Lit run each, relayed with the usage key
 *     and X-Privacy-Mode, carrying ciphertext only; free checks refuse first.
 *   - Nobody chooses how many paid Lit runs there are: a ticket needs a quote
 *     for that shopper, a few per card in fifteen minutes however often it
 *     quotes, a few per card from everyone, and a few dozen per address a
 *     day; limits are per address (an IPv6 one as its /64) and per process,
 *     never on a value from the body; a repeated release is served from
 *     memory.
 *   - A ticket for a card the contract would refuse (someone else owns it,
 *     the new-seller cap), or for a second listing of one card, never goes
 *     back: the listing is marked and left out of quotes.
 *   - No flood of made-up or repeated deposit ids reads the chain or uses up
 *     a limit a shopper who just paid needs; a flood of listings naming one
 *     seller stops no other seller.
 *   - A purchase one block old on a host a block behind (measured
 *     2026-10-14) is released on the first ask: the route waits for that
 *     host rather than answering "not there yet".
 *   - No answer and no request this server sends ever holds a card number.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, encodeFunctionResult, keccak256, type Hex } from 'viem'

vi.mock('@/lib/vault/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/vault/guard')>()
  return { ...actual, assertSealedRefAllowedForOwner: vi.fn(actual.assertSealedRefAllowedForOwner) }
})

const { prisma } = await import('@/lib/db')
const guard = await import('@/lib/vault/guard')
const realGuard = (await vi.importActual<typeof import('@/lib/vault/guard')>('@/lib/vault/guard')).assertSealedRefAllowedForOwner
const { GET: configRoute } = await import('@/app/api/escrow/config/route')
const { GET: totalsRoute, POST: listingsRoute } = await import('@/app/api/escrow/listings/route')
const { POST: quoteRoute } = await import('@/app/api/escrow/quote/route')
const { POST: ticketRoute } = await import('@/app/api/escrow/ticket/route')
const { POST: releaseRoute } = await import('@/app/api/escrow/release/route')
const { escrowIntentData, readEscrowSealedRef } = await import('@/lib/escrow/listing')
const { __clearEscrowReservationsForTests, cardsNotQuotable, DISPUTED_MARK, holdQuotedCards, releasePaidCard } = await import('@/lib/escrow/quote')
const { __clearReleaseMemoryForTests, releaseMemory } = await import('@/lib/escrow/lit-escrow')
const { clientAddress, LitRunBudget, litRunBudget } = await import('@/lib/escrow/http')
const { ESCROW_V1_PINS } = await import('@/lib/vault/lit/escrow-pins')
const { ESCROW_ABI, RUNTIME_KECCAK } = await import('@/lib/escrow/artifact')
const { scanOrder } = await import('@/lib/demand/one-screen')
const { tillScanOrder } = await import('@/lib/route/scan-order')
const { escrowRailOn } = await import('@/lib/escrow/rail')
const { escrowRailReadiness } = await import('@/lib/escrow/readiness')
const { replyPayload } = await import('@/lib/escrow/hashes')
const { buildEscrowManifest, ESCROW_CHAIN_ID, PATH_USD, parseEscrowManifest } = await import('@/lib/escrow/manifest')
const { createReplyKey } = await import('@/lib/vault/lit/envelope-crypto')
const { ESCROW_V1 } = await import('@/lib/vault/lit/templates')
const { __setEscrowRuntimeForTests } = await import('@/lib/escrow/runtime')
const { escrowCall } = await import('./support/escrow-chain')
const { makeFakeLit } = await import('./support/fake-lit')
const world = await import('./support/escrow-server-world')
const { resetDb } = await import('./helpers')

const { SELLER, SELLER_2, SHOPPER, SHOPPER_2, buyCard, closeServerWorld, listOnChain, listedCard, sealCard, serverWorld } = world
type ServerWorld = Awaited<ReturnType<typeof serverWorld>>

const APP = 'http://localhost:3000'
const USAGE_KEY = 'usage-key-for-tests'
/** Who the guard is asked about for a testnet listing (listing.ts, TESTNET_LISTING_OWNER). */
const TESTNET_OWNER = { kind: 'operator', ownerId: 'operator:0' }
const SAVED = {
  ESCROW_RAIL: process.env.ESCROW_RAIL,
  LIT_VAULT_USAGE_KEY: process.env.LIT_VAULT_USAGE_KEY,
  ESCROW_SELLER_ALLOWLIST: process.env.ESCROW_SELLER_ALLOWLIST,
  TEMPO_SPONSOR_URL: process.env.TEMPO_SPONSOR_URL,
  LIT_CHIPOTLE_ACCOUNT_KEY: process.env.LIT_CHIPOTLE_ACCOUNT_KEY,
  LIT_CHIPOTLE_API_KEY: process.env.LIT_CHIPOTLE_API_KEY,
}
const CARD_RE = /9999[0-9]{12}/

function setEnvVars(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

/**
 * The server's clock, in ms: the fake chain's own time, which every world starts
 * at, plus a few minutes more per test, so the per-process rate limits (one
 * minute windows) never carry from one test to the next and no listing (one
 * day) expires early.
 */
let testIndex = 0
let clock = 0

beforeEach(async () => {
  await resetDb()
  __clearEscrowReservationsForTests()
  __clearReleaseMemoryForTests()
  testIndex += 1
  setEnvVars({
    ESCROW_RAIL: 'testnet',
    LIT_VAULT_USAGE_KEY: USAGE_KEY,
    ESCROW_SELLER_ALLOWLIST: `${SELLER},${SELLER_2}`,
    TEMPO_SPONSOR_URL: undefined,
    LIT_CHIPOTLE_ACCOUNT_KEY: undefined,
    LIT_CHIPOTLE_API_KEY: undefined,
  })
  vi.clearAllMocks()
  vi.mocked(guard.assertSealedRefAllowedForOwner).mockImplementation(realGuard)
})

afterEach(() => {
  closeServerWorld()
})

afterAll(async () => {
  setEnvVars(SAVED)
  await resetDb()
  await prisma.$disconnect()
})

async function world2(): Promise<ServerWorld> {
  const w = await serverWorld()
  // Never earlier than the last test's clock: a test that moves it on by many
  // minutes must not leave a later test inside a window that has not ended.
  clock = Math.max(clock + 180_000, Number(w.node.chain.timestamp) * 1000 + testIndex * 180_000)
  __setEscrowRuntimeForTests({ ...w.rt, now: () => clock })
  return { ...w, rt: { ...w.rt, now: () => clock } }
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${APP}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: APP, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

/** Every body that left this server for Lit or the chain, and every answer, as one text. */
function wire(w: ServerWorld, answers: string[]): string {
  return [...w.litCalls.map((c) => c.bodyText), ...w.node.requests.map((r) => r.bodyText), ...answers].join('\n')
}

describe('the rail switch', () => {
  it('every route answers 503 with one sentence and reads nothing unless ESCROW_RAIL=testnet', async () => {
    const w = await world2()
    const l = await listedCard(w)
    for (const value of [undefined, 'off', '', 'mainnet', 'TESTNET-ish']) {
      if (value === undefined) delete process.env.ESCROW_RAIL
      else process.env.ESCROW_RAIL = value
      const before = w.node.requests.length
      const answers = [
        await configRoute(),
        await totalsRoute(),
        await listingsRoute(post('/api/escrow/listings', { manifest: l.manifestText, envelope: l.envelope, txHash: `0x${'1'.repeat(64)}` })),
        await quoteRoute(post('/api/escrow/quote', { merchant: 'salvotest', spendCents: 2_000, depositor: SHOPPER })),
        await ticketRoute(post('/api/escrow/ticket', { intentId: l.intentId, depositor: SHOPPER, replyKeyHash: `0x${'2'.repeat(64)}` })),
        await releaseRoute(post('/api/escrow/release', { depositId: '1', replyKey: createReplyKey().publicKey })),
      ]
      for (const res of answers) {
        expect(res.status).toBe(503)
        const b = await json(res)
        expect(b.error).toBe('escrow_rail_off')
        expect(String(b.message)).toMatch(/^Salvo Pay is not available here\./)
        expect(String(b.message)).not.toMatch(/ESCROW_RAIL|testnet/)
      }
      expect(w.node.requests.length).toBe(before)
      expect(w.litCalls).toEqual([])
    }
  })

  it('with the rail on and the committed template, which pins no escrow yet, nothing can list, quote, ticket or release', async () => {
    const w = await world2()
    const l = await listedCard(w)
    // Today's production state. Once the lead pins the escrow this case no longer applies.
    if (ESCROW_V1.escrowAddress !== null) return
    __setEscrowRuntimeForTests({ ...w.rt, template: ESCROW_V1, now: () => clock })
    vi.mocked(guard.assertSealedRefAllowedForOwner).mockImplementation(() => undefined)
    const before = w.node.requests.length
    const cfg = await json(await configRoute())
    expect(cfg).toMatchObject({ ready: false, escrow: null })
    const answers = [
      await listingsRoute(post('/api/escrow/listings', { manifest: l.manifestText, envelope: l.envelope, txHash: `0x${'1'.repeat(64)}` })),
      await quoteRoute(post('/api/escrow/quote', { merchant: 'salvotest', spendCents: 2_000, depositor: SHOPPER })),
      await ticketRoute(post('/api/escrow/ticket', { intentId: l.intentId, depositor: SHOPPER, replyKeyHash: `0x${'2'.repeat(64)}` })),
      await releaseRoute(post('/api/escrow/release', { depositId: '1', replyKey: createReplyKey().publicKey })),
    ]
    for (const res of answers) {
      expect(res.status).toBe(503)
      expect((await json(res)).error).toBe('not_ready')
    }
    expect(w.node.requests.length).toBe(before)
    expect(w.litCalls).toEqual([])
  })

  it('agrees with readiness about what turns the rail on', () => {
    for (const v of ['testnet', ' TestNet ', 'off', '', 'mainnet', 'live', 'true', '1']) {
      const env = { ESCROW_RAIL: v }
      expect(escrowRailOn(env)).toBe(!escrowRailReadiness(env).blockers.some((b) => b === 'escrow_rail_off' || b === 'mainnet_refused'))
    }
  })
})

describe('every POST: same origin, JSON, exact keys, no card field', () => {
  it('refuses another site, a form post, an extra key and anything named like card material, before any work', async () => {
    const w = await world2()
    const l = await sealCard(w)
    const good = { manifest: l.manifestText, envelope: l.envelope, txHash: `0x${'1'.repeat(64)}` }
    const cases: Array<[Request, number, string]> = [
      [post('/api/escrow/listings', good, { 'sec-fetch-site': 'cross-site' }), 403, 'cross_site'],
      [post('/api/escrow/listings', good, { origin: 'https://evil.example' }), 403, 'cross_site'],
      [post('/api/escrow/listings', good, { 'content-type': 'application/x-www-form-urlencoded' }), 415, 'invalid_content_type'],
      [post('/api/escrow/listings', '{not json'), 400, 'invalid_json'],
      [post('/api/escrow/listings', { ...good, cardNumber: l.cardNumber }), 400, 'plaintext_refused'],
      [post('/api/escrow/listings', { ...good, envelope: { ...l.envelope, pin: '1234' } }), 400, 'plaintext_refused'],
      [post('/api/escrow/listings', { ...good, extra: 1 }), 400, 'invalid_body'],
      [post('/api/escrow/quote', { merchant: 'salvotest', spendCents: 100, depositor: SHOPPER, card_number: 'x' }), 400, 'plaintext_refused'],
      [post('/api/escrow/quote', { merchant: 'salvotest', spendCents: 100 }), 400, 'invalid_body'],
      [post('/api/escrow/ticket', { intentId: 'x', depositor: SHOPPER, replyKeyHash: '0x', PIN: '1' }), 400, 'plaintext_refused'],
      [post('/api/escrow/release', { depositId: '1', replyKey: '0x02', secret: 'x' }), 400, 'plaintext_refused'],
    ]
    const routeFor: Record<string, (r: Request) => Promise<Response>> = {
      '/api/escrow/listings': listingsRoute,
      '/api/escrow/quote': quoteRoute,
      '/api/escrow/ticket': ticketRoute,
      '/api/escrow/release': releaseRoute,
    }
    const before = w.node.requests.length
    for (const [req, status, error] of cases) {
      const res = await (routeFor[new URL(req.url).pathname] as (r: Request) => Promise<Response>)(req)
      expect([new URL(req.url).pathname, res.status]).toEqual([new URL(req.url).pathname, status])
      const b = await json(res)
      expect(b.error).toBe(error)
      expect(JSON.stringify(b)).not.toMatch(CARD_RE)
    }
    expect(w.node.requests.length).toBe(before)
    expect(w.litCalls).toEqual([])
    expect(await prisma.intent.count()).toBe(0)
  })
})

describe('GET /api/escrow/config', () => {
  it('serves the pins the phone checks against, and a sponsor only when one is set as https', async () => {
    const w = await world2()
    const b = await json(await configRoute())
    expect(b).toMatchObject({
      ready: true,
      escrow: w.escrow,
      token: PATH_USD,
      chain: { key: 'tempo-moderato', chainId: ESCROW_CHAIN_ID, testnet: true },
      template: { id: 'salvo-vault-escrow/1', cid: w.template.cid, identity: w.template.identity, encPub: w.template.encPub, intact: true },
      sponsorUrl: null,
    })
    process.env.TEMPO_SPONSOR_URL = 'https://sponsor.example.test/path?q=1'
    expect((await json(await configRoute())).sponsorUrl).toBe('https://sponsor.example.test')
    process.env.TEMPO_SPONSOR_URL = 'http://sponsor.example.test'
    expect((await json(await configRoute())).sponsorUrl).toBeNull()
  })

  it("says listing is open on the testnet, asking the guard about the operator, and closed when it refuses, so the seller's page says it first", async () => {
    const w = await world2()
    // Today's guard, asked about the operator: open, with sellers on the list.
    expect((await json(await configRoute())).listingOpen).toBe(true)
    const [, owner] = vi.mocked(guard.assertSealedRefAllowedForOwner).mock.calls.at(-1) ?? []
    expect(owner).toEqual(TESTNET_OWNER)
    // The test list is optional: empty, or nothing but junk, means anyone.
    for (const v of [undefined, '', 'not-an-address']) {
      setEnvVars({ ESCROW_SELLER_ALLOWLIST: v })
      expect((await json(await configRoute())).listingOpen, String(v)).toBe(true)
    }
    // The guard refusing closes it.
    vi.mocked(guard.assertSealedRefAllowedForOwner).mockImplementation(() => {
      throw new guard.CustodialVaultRefusedError('chipotle:escrow:v1', 'operator:0', 'refused for this test')
    })
    expect((await json(await configRoute())).listingOpen).toBe(false)
    // So does a template that no longer matches its pins, whatever the guard says.
    vi.mocked(guard.assertSealedRefAllowedForOwner).mockImplementation(realGuard)
    __setEscrowRuntimeForTests({ ...w.rt, template: { ...w.rt.template, source: `${w.rt.template.source} ` } })
    expect((await json(await configRoute())).listingOpen).toBe(false)
  })

  it("the page's built-in pins are the template's, and its code hash is the compiled escrow's", () => {
    expect(ESCROW_V1_PINS.escrowCodehash).toBe(RUNTIME_KECCAK)
    expect(ESCROW_V1.escrowCodehash).toBe(ESCROW_V1_PINS.escrowCodehash)
    expect(ESCROW_V1.escrowAddress).toBe(ESCROW_V1_PINS.escrowAddress)
    expect(ESCROW_V1.identity).toBe(ESCROW_V1_PINS.identity)
    expect(ESCROW_V1.encPub).toBe(ESCROW_V1_PINS.encPub)
    expect(ESCROW_V1.escrowDeployer).toBe(ESCROW_V1_PINS.escrowDeployer)
    expect(ESCROW_V1.escrowCreationTx).toBe(ESCROW_V1_PINS.escrowCreationTx)
  })
})

describe('POST /api/escrow/listings', () => {
  // Every V1 listing carries its card's fingerprint now (listing.ts); the V1 route keeps it and checks only its form.
  const body = (l: { manifestText: string; envelope: unknown }) => ({ manifest: l.manifestText, envelope: l.envelope, txHash: `0x${'a'.repeat(64)}`, cardFingerprint: `0x${'f1'.repeat(32)}` })

  it('a custody refusal, or a drifted template, refuses before any chain read, and nothing is listed', async () => {
    const w = await world2()
    const l = await sealCard(w)
    await listOnChain(w, l)
    const before = w.node.requests.length
    vi.mocked(guard.assertSealedRefAllowedForOwner).mockImplementation(() => {
      throw new guard.CustodialVaultRefusedError('chipotle:escrow:v1', 'operator:0', 'refused for this test')
    })
    const res = await listingsRoute(post('/api/escrow/listings', body(l)))
    expect(res.status).toBe(403)
    const b = await json(res)
    expect(b).toEqual({ error: 'custody_refused', message: 'Selling for dollars is not open yet. Nothing was listed.' })
    expect(guard.assertSealedRefAllowedForOwner).toHaveBeenCalledTimes(1)
    expect(w.node.requests.length).toBe(before)
    expect(await prisma.intent.count()).toBe(0)

    // A template that no longer matches its pins takes nothing, guard or not.
    vi.mocked(guard.assertSealedRefAllowedForOwner).mockImplementation(realGuard)
    __setEscrowRuntimeForTests({ ...w.rt, template: { ...w.rt.template, source: `${w.rt.template.source} ` } })
    const drifted = await listingsRoute(post('/api/escrow/listings', body(l)))
    expect([drifted.status, (await json(drifted)).error]).toEqual([503, 'not_ready'])
    expect(w.node.requests.length).toBe(before)
    expect(await prisma.intent.count()).toBe(0)
  })

  it("today's guard, asked about the operator, takes a testnet listing; a seller-kind owner is still refused", async () => {
    const w = await world2()
    const l = await sealCard(w)
    await listOnChain(w, l)
    const res = await listingsRoute(post('/api/escrow/listings', body(l)))
    expect(res.status).toBe(201)
    const [ref, owner] = vi.mocked(guard.assertSealedRefAllowedForOwner).mock.calls[0] ?? []
    expect(owner).toEqual(TESTNET_OWNER)
    // The same ref, asked about its seller: refused, because the escrow is
    // still not counted non-custodial (NON_CUSTODIAL_BACKENDS is empty).
    let refused: unknown
    try {
      realGuard(ref as Parameters<typeof realGuard>[0], { kind: 'seller', ownerId: `seller:${SELLER}` })
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(guard.CustodialVaultRefusedError)
    expect((refused as Error).message).toMatch(/has not passed the custody review/)
    expect(guard.classifyBackend(guard.backendOfSealedRef(ref as Parameters<typeof realGuard>[0]))).toBe('unknown')
    // The row is the seller's listing, by their address.
    expect(await prisma.intent.findMany()).toMatchObject([{ accountId: `seller:${SELLER}`, formFactor: 'escrow_sealed' }])
  })

  it('an empty test list lets any seller list on the testnet, as the operator', async () => {
    const w = await world2()
    const stranger = `0x${'77'.repeat(20)}` as Hex
    for (const v of [undefined, '']) {
      await resetDb()
      vi.clearAllMocks()
      setEnvVars({ ESCROW_SELLER_ALLOWLIST: v })
      const l = await sealCard(w, { seller: stranger })
      await listOnChain(w, l)
      const res = await listingsRoute(post('/api/escrow/listings', body(l)))
      expect([String(v), res.status]).toEqual([String(v), 201])
      const [, owner] = vi.mocked(guard.assertSealedRefAllowedForOwner).mock.calls[0] ?? []
      expect(owner).toEqual(TESTNET_OWNER)
      expect(await prisma.intent.findMany()).toMatchObject([{ accountId: `seller:${stranger}` }])
    }
    // A set list still refuses everyone else, before the guard is asked.
    vi.clearAllMocks()
    setEnvVars({ ESCROW_SELLER_ALLOWLIST: SELLER })
    const other = await sealCard(w, { seller: SELLER_2 })
    await listOnChain(w, other)
    const res = await listingsRoute(post('/api/escrow/listings', body(other)))
    expect([res.status, (await json(res)).error]).toEqual([403, 'seller_not_allowed'])
    expect(guard.assertSealedRefAllowedForOwner).not.toHaveBeenCalled()
  })

  it('once the guard allows it, records the listing from the chain, once, holding ciphertext only', async () => {
    const w = await world2()
    const l = await sealCard(w)
    await listOnChain(w, l)
    const first = await listingsRoute(post('/api/escrow/listings', body(l)))
    expect(first.status).toBe(201)
    const b = await json(first)
    expect(b).toMatchObject({ listed: true, created: true, listingId: l.listingId, merchant: 'salvotest' })
    const [ref, owner] = vi.mocked(guard.assertSealedRefAllowedForOwner).mock.calls[0] ?? []
    expect(owner).toEqual(TESTNET_OWNER)
    expect((ref as { algorithm: string }).algorithm).toBe('chipotle:escrow:v1')

    const again = await listingsRoute(post('/api/escrow/listings', body(l)))
    expect(again.status).toBe(200)
    expect(await json(again)).toMatchObject({ created: false, intentId: b.intentId })
    const rows = await prisma.intent.findMany()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({ state: 'offered', formFactor: 'escrow_sealed', accountId: `seller:${SELLER}`, last4: '', faceValueCents: 2_000 })
    expect(readEscrowSealedRef(row.sealedRef, w.template)?.listingId).toBe(l.listingId)
    expect(JSON.stringify(row)).not.toContain(l.cardNumber)
    expect(wire(w, [JSON.stringify(b)])).not.toContain(l.cardNumber)

    const totals = await json(await totalsRoute())
    expect(totals).toEqual({ stores: [{ merchant: 'salvotest', cards: 1, totalValueCents: 2_000, bestDiscountBps: 1_000 }] })
    expect(JSON.stringify(totals)).not.toContain(l.listingId.slice(2))
    expect(JSON.stringify(totals)).not.toContain(SELLER.slice(2))
  })

  it('refuses what the chain or the pins say is wrong', async () => {
    const w = await world2()
    vi.mocked(guard.assertSealedRefAllowedForOwner).mockImplementation(() => undefined)
    const notListed = await sealCard(w)
    const cancelled = await sealCard(w)
    await listOnChain(w, cancelled)
    await w.node.chain.send(SELLER, w.escrow, escrowCall.cancelListing(cancelled.listingId))
    const stranger = await sealCard(w, { seller: `0x${'77'.repeat(20)}` as Hex })
    const otherEscrow = buildEscrowManifest({ ...notListed.manifest, escrow: `0x${'99'.repeat(20)}` as Hex })
    const cases: Array<[unknown, number, string]> = [
      [body(notListed), 409, 'not_on_chain_yet'],
      [body(cancelled), 409, 'listing_closed'],
      [body(stranger), 403, 'seller_not_allowed'],
      [{ ...body(notListed), manifest: otherEscrow }, 400, 'bad_manifest'],
      [{ ...body(notListed), envelope: { ...notListed.envelope, iv: 'AAAA' } }, 400, 'bad_envelope'],
      [{ ...body(notListed), txHash: '0x12' }, 400, 'bad_tx'],
      // A page too old to send the card's fingerprint: refused, so no V1 card goes unmatched on V2.
      [{ ...body(notListed), cardFingerprint: undefined }, 400, 'bad_fingerprint'],
      [{ ...body(notListed), cardFingerprint: `0x${'F1'.repeat(32)}` }, 400, 'bad_fingerprint'],
    ]
    for (const [b, status, error] of cases) {
      const res = await listingsRoute(post('/api/escrow/listings', b))
      expect([error, res.status]).toEqual([error, status])
      const out = await json(res)
      expect(out.error).toBe(error)
      expect(String(out.message)).toMatch(/Nothing was listed\.$/)
    }
    expect(await prisma.intent.count()).toBe(0)
  })

  it('the chain read behind a listing is limited per address and per seller, so no script can get our address throttled or stop another seller', async () => {
    const w = await world2()
    vi.mocked(guard.assertSealedRefAllowedForOwner).mockImplementation(() => undefined)
    // Every free check passes, and the listing is not on chain: each post reads both hosts.
    const l = await sealCard(w)
    const send = (from: string) => listingsRoute(post('/api/escrow/listings', body(l), { 'x-real-ip': from }))
    for (let i = 0; i < 20; i++) expect((await json(await send('203.0.113.60'))).error).toBe('not_on_chain_yet')
    let reads = w.node.requests.length
    const over = await send('203.0.113.60')
    expect([over.status, (await json(over)).error]).toEqual([429, 'slow_down'])
    expect(w.node.requests.length).toBe(reads)
    // A request refused for free reads nothing, and does not count.
    const bad = await listingsRoute(post('/api/escrow/listings', { ...body(l), txHash: '0x12' }, { 'x-real-ip': '198.51.100.60' }))
    expect((await json(bad)).error).toBe('bad_tx')

    // From anywhere, naming the same seller: that seller's twenty reads a
    // minute are spent, and nothing more is read for it, whatever address
    // each post says it is.
    reads = w.node.requests.length
    for (let i = 0; i < 100; i++) expect((await json(await send(`198.51.100.${i}`))).error).toBe('slow_down')
    expect(w.node.requests.length).toBe(reads)
    // That flood stops no other seller: SELLER_2's listing is still read.
    const theirs = await sealCard(w, { seller: SELLER_2 })
    const other = await listingsRoute(post('/api/escrow/listings', body(theirs), { 'x-real-ip': '192.0.2.200' }))
    expect((await json(other)).error).toBe('not_on_chain_yet')
    expect(w.node.requests.length).toBeGreaterThan(reads)

    // A minute on, the seller is heard again.
    clock += 60_000
    expect((await json(await send('203.0.113.60'))).error).toBe('not_on_chain_yet')
  })
})

describe('POST /api/escrow/quote', () => {
  it('picks whole cards, whole first, and prices them whole', async () => {
    const w = await world2()
    const big = await world.listedCard(w, { valueCents: 2_000, priceUnits: 17_600_000 })
    const small = await world.listedCard(w, { valueCents: 1_000, priceUnits: 9_000_000, seller: SELLER_2 })
    const res = await quoteRoute(post('/api/escrow/quote', { merchant: 'salvotest', spendCents: 2_800, depositor: SHOPPER }))
    expect(res.status).toBe(200)
    const q = (await json(res)).quote as Record<string, unknown> & { legs: Array<Record<string, unknown>> }
    expect(q).toMatchObject({ merchant: 'salvotest', spendCents: 2_800, loadCents: 3_000, priceUnits: 26_600_000, priceCents: 2_660, savingCents: 340, leftoverCents: 200 })
    expect(q.legs.map((x) => [x.intentId, x.scanOrder])).toEqual([
      [small.intentId, 1],
      [big.intentId, 2],
    ])
    const leg = q.legs[1]!
    expect(leg).toMatchObject({ listingId: big.listingId, manifest: big.manifestText, envelope: big.envelope, priceUnits: 17_600_000, valueCents: 2_000, seller: SELLER })
    expect(JSON.stringify(q)).not.toMatch(CARD_RE)
  })

  it('holds the cards for two minutes for one shopper, and skips suspect listings and disputed sellers', async () => {
    const w = await world2()
    const a = await world.listedCard(w, { valueCents: 2_000 })
    const quote = async (depositor: string, spendCents = 2_000) => quoteRoute(post('/api/escrow/quote', { merchant: 'salvotest', spendCents, depositor }))
    expect((await quote(SHOPPER)).status).toBe(200)
    expect((await quote(SHOPPER_2)).status).toBe(409)
    expect((await quote(SHOPPER)).status).toBe(200)
    clock += 121_000
    expect((await quote(SHOPPER_2)).status).toBe(200)

    __clearEscrowReservationsForTests()
    await prisma.intent.update({ where: { id: a.intentId }, data: { failureReason: `escrow_suspect|balance_short|${new Date(clock).toISOString()}` } })
    expect((await quote(SHOPPER)).status).toBe(409)

    // A second listing by the same seller, while one of that seller's sales is disputed.
    const b = await world.listedCard(w, { valueCents: 2_000 })
    expect((await quote(SHOPPER)).status).toBe(200)
    __clearEscrowReservationsForTests()
    await prisma.intent.create({
      data: { ...escrowIntentData(w.template, b.manifest, b.manifestText, b.envelope, new Date()), id: 'esc_disputed_sale', state: 'executing', failureReason: DISPUTED_MARK },
    })
    expect((await quote(SHOPPER)).status).toBe(409)
  })

  it('keeps the leftover on the part-used card within the store cap ($5 where nobody reads the balance)', async () => {
    const w = await world2()
    await world.listedCard(w, { valueCents: 2_000 })
    const q = (spendCents: number) => quoteRoute(post('/api/escrow/quote', { merchant: 'salvotest', spendCents, depositor: SHOPPER }))
    const over = await q(1_400)
    expect(over.status).toBe(409)
    // The store by its own name in the sentence a shopper reads, never its id.
    expect((await json(over)).message).toBe('We cannot load exactly $14.00 at Salvo test right now. Try a different amount.')
    const none = await quoteRoute(post('/api/escrow/quote', { merchant: 'target', spendCents: 1_000, depositor: SHOPPER }))
    expect([none.status, (await json(none)).message]).toEqual([409, 'There are no Target cards for sale right now.'])
    const ok = await q(1_600)
    expect(ok.status).toBe(200)
    expect(((await json(ok)).quote as { leftoverCents: number }).leftoverCents).toBe(400)
    const unknown = await quoteRoute(post('/api/escrow/quote', { merchant: 'costco', spendCents: 1_000, depositor: SHOPPER }))
    expect(unknown.status).toBe(409)
  })

  it('does not quote a card too close to its expiry to be bought in time', async () => {
    const w = await world2()
    // How far this test's server clock runs ahead of the chain's.
    const ahead = Math.ceil(clock / 1000) - Number(w.node.chain.timestamp)
    const q = () => quoteRoute(post('/api/escrow/quote', { merchant: 'salvotest', spendCents: 2_000, depositor: SHOPPER }))
    await world.listedCard(w, { valueCents: 2_000, expiresIn: ahead + 150 })
    expect((await q()).status).toBe(409)
    const later = await world.listedCard(w, { valueCents: 2_000, expiresIn: ahead + 400 })
    const ok = await q()
    expect(ok.status).toBe(200)
    expect(((await json(ok)).quote as { legs: Array<{ intentId: string }> }).legs.map((l) => l.intentId)).toEqual([later.intentId])
  })

  it("never quotes a shopper their own listing: one phone is one account for both roles", async () => {
    const w = await world2()
    await world.listedCard(w, { valueCents: 2_000, seller: SHOPPER })
    const mine = await quoteRoute(post('/api/escrow/quote', { merchant: 'salvotest', spendCents: 2_000, depositor: SHOPPER }))
    expect([mine.status, (await json(mine)).message]).toEqual([409, 'There are no Salvo test cards for sale right now.'])
    expect((await quoteRoute(post('/api/escrow/quote', { merchant: 'salvotest', spendCents: 2_000, depositor: SHOPPER_2 }))).status).toBe(200)
  })

  it('asks the chain before quoting: a card sold a minute ago is left out, marked, and another is quoted', async () => {
    const w = await world2()
    // The sold one ends sooner, so the matcher would pick it first.
    const sold = await world.listedCard(w, { valueCents: 2_000, expiresIn: 80_000 })
    const other = await world.listedCard(w, { valueCents: 2_000 })
    await buyCard(w, sold, SHOPPER_2)
    // Our row still says offered: only the keeper moves it.
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: sold.intentId } })).state).toBe('offered')
    const res = await quoteRoute(post('/api/escrow/quote', { merchant: 'salvotest', spendCents: 2_000, depositor: SHOPPER }))
    expect(res.status).toBe(200)
    expect(((await json(res)).quote as { legs: Array<{ intentId: string }> }).legs.map((l) => l.intentId)).toEqual([other.intentId])
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: sold.intentId } })).failureReason).toMatch(/^escrow_suspect\|closed_on_chain\|/)
    // And a store total no longer counts it.
    expect(await json(await totalsRoute())).toEqual({ stores: [{ merchant: 'salvotest', cards: 1, totalValueCents: 2_000, bestDiscountBps: 1_000 }] })
  })

  it('one address holds at most four cards at once, a shopper only its latest quote, and quotes are limited per address', async () => {
    const w = await world2()
    for (let i = 0; i < 6; i++) await world.listedCard(w, { valueCents: 2_000 })
    const shopper = (i: number): string => `0x${(500 + i).toString(16).padStart(40, '0')}`
    const quote = (depositor: string, from: string) =>
      quoteRoute(post('/api/escrow/quote', { merchant: 'salvotest', spendCents: 2_000, depositor }, { 'x-real-ip': from }))
    // The same shopper again holds one card, not two.
    expect((await quote(shopper(0), '203.0.113.7')).status).toBe(200)
    expect((await quote(shopper(0), '203.0.113.7')).status).toBe(200)
    for (let i = 1; i < 4; i++) expect((await quote(shopper(i), '203.0.113.7')).status).toBe(200)
    // Four held from there: a fifth made-up shopper gets no cards, no terms and no envelopes.
    const fifth = await quote(shopper(4), '203.0.113.7')
    expect(fifth.status).toBe(429)
    const body = await json(fifth)
    expect(body.error).toBe('slow_down')
    expect(JSON.stringify(body)).not.toContain('manifest')
    // Elsewhere, the two cards still free are there to quote.
    expect((await quote(shopper(5), '198.51.100.2')).status).toBe(200)

    // Twenty quotes a minute from one address, then a wait.
    const statuses: number[] = []
    for (let i = 0; i < 21; i++) statuses.push((await quote(shopper(0), '192.0.2.44')).status)
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true)
    expect(statuses[20]).toBe(429)
  })

  it('orders cards for the till by the one rule both rails share', () => {
    // The escrow quote orders with route/scan-order.ts, and the card rail's
    // `scanOrder` is the same function. For legs with no source that rule is
    // the old one: whole cards first, the part-used one last, each kind in
    // the order it came.
    expect(scanOrder).toBe(tillScanOrder)
    for (let n = 0; n < 50; n++) {
      const legs = Array.from({ length: 1 + (n % 3) }, (_, i) => ({ id: i, fullyDrained: ((n >> i) & 1) === 1 }))
      const old = [...legs].sort((a, b) => Number(b.fullyDrained) - Number(a.fullyDrained))
      expect(tillScanOrder(legs)).toEqual(old)
    }
  })
})

/** Quote `spendCents` at the test store for `depositor`, as the phone does before it asks for a ticket. */
async function quoteFor(depositor: string, spendCents = 2_000, headers: Record<string, string> = {}): Promise<Response> {
  return quoteRoute(post('/api/escrow/quote', { merchant: 'salvotest', spendCents, depositor }, headers))
}

describe('POST /api/escrow/ticket', () => {
  it('relays one Lit run with the usage key and privacy mode, ciphertext only, and returns a ticket for this shopper', async () => {
    const w = await world2()
    const l = await listedCard(w)
    expect((await quoteFor(SHOPPER)).status).toBe(200)
    const replyKeyHash = keccak256(createReplyKey().publicKey as Hex)
    const res = await ticketRoute(post('/api/escrow/ticket', { intentId: l.intentId, depositor: SHOPPER, replyKeyHash }))
    expect(res.status).toBe(200)
    const b = await json(res)
    expect(b).toMatchObject({ listingId: l.listingId, ttlSeconds: 600, ticket: { listingId: l.listingId, depositor: SHOPPER, replyKeyHash, openBalanceCents: 0 } })
    expect(w.litCalls).toHaveLength(1)
    const call = w.litCalls[0]!
    expect(call.headers['x-api-key']).toBe(USAGE_KEY)
    expect(call.headers['x-privacy-mode']).toBe('true')
    expect(call.redirect).toBe('error')
    expect(wire(w, [JSON.stringify(b)])).not.toContain(l.cardNumber)
  })

  it('refuses for free what it can, and maps what Lit refuses', async () => {
    const w = await world2()
    const l = await listedCard(w)
    const hash = keccak256(createReplyKey().publicKey as Hex)
    const t = (intentId: string, depositor: string = SHOPPER) => ticketRoute(post('/api/escrow/ticket', { intentId, depositor, replyKeyHash: hash }))

    // Never quoted to them: the seller's own card, and an id that is no card. No database read, no Lit run.
    expect((await json(await t(l.intentId, SELLER))).error).toBe('not_quoted')
    expect((await json(await t(`esc_${'0'.repeat(64)}`))).error).toBe('not_quoted')
    expect(w.litCalls).toEqual([])

    // Quoted, then cancelled on chain, still offered here: Lit's gate says no, and that is not the card's fault.
    expect((await quoteFor(SHOPPER)).status).toBe(200)
    await w.node.chain.send(SELLER, w.escrow, escrowCall.cancelListing(l.listingId))
    const gone = await t(l.intentId)
    expect([gone.status, (await json(gone)).error]).toEqual([409, 'listing_unavailable'])
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: l.intentId } })).failureReason).toBeNull()

    // Listed under a manifest it was not sealed with: it never opens, and leaves quotes.
    const sealed = await sealCard(w)
    const editedText = buildEscrowManifest({ ...sealed.manifest, listingExpiry: sealed.manifest.listingExpiry + 1 })
    const edited = { ...sealed, manifestText: editedText, manifest: parseEscrowManifest(editedText, w.escrow)! }
    await listOnChain(w, edited)
    const data = escrowIntentData(w.template, edited.manifest, edited.manifestText, edited.envelope, new Date())
    await prisma.intent.create({ data })
    // A few seconds on, the quote reads the chain again, finds the cancelled card, and picks the edited one.
    clock += 6_000
    const q = (await json(await quoteFor(SHOPPER))).quote as { legs: Array<{ intentId: string }> }
    expect(q.legs.map((x) => x.intentId)).toEqual([data.id])
    const bad = await t(data.id as string)
    expect([bad.status, (await json(bad)).error]).toEqual([409, 'card_refused'])
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: data.id as string } })).failureReason).toMatch(/^escrow_suspect\|open_failed\|/)

    process.env.LIT_VAULT_USAGE_KEY = ''
    const fresh = await listedCard(w)
    expect((await quoteFor(SHOPPER)).status).toBe(200)
    const unset = await t(fresh.intentId)
    expect([unset.status, (await json(unset)).error]).toEqual([503, 'lit_unavailable'])
  })

  it('a ticket only for a card quoted to that shopper, three per card: made-up shoppers and public listing ids buy no Lit run', async () => {
    const w = await world2()
    const l = await listedCard(w)
    const ask = (depositor: string) => ticketRoute(post('/api/escrow/ticket', { intentId: l.intentId, depositor, replyKeyHash: keccak256(createReplyKey().publicKey as Hex) }))
    // The listing id is public on chain; a script that never quoted gets nothing, whoever it says it is.
    for (let i = 0; i < 5; i++) expect((await json(await ask(`0x${(i + 40).toString(16).padStart(40, '0')}`))).error).toBe('not_quoted')
    expect(w.litCalls).toHaveLength(0)
    expect((await quoteFor(SHOPPER)).status).toBe(200)
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await ask(SHOPPER)).status)
    expect(statuses).toEqual([200, 200, 200, 409])
    expect(w.litCalls).toHaveLength(3)
    // A real shopper's tries are not someone else's to use up: another quote, its own three.
    expect((await quoteFor(SHOPPER_2)).status).toBe(409)
    __clearEscrowReservationsForTests()
    expect((await quoteFor(SHOPPER_2)).status).toBe(200)
    expect((await ask(SHOPPER_2)).status).toBe(200)
  })

  it('limits tickets per address, and skips a suspect or ending listing for free', async () => {
    const w = await world2()
    const l = await listedCard(w)
    expect((await quoteFor(SHOPPER)).status).toBe(200)
    const ask = (from: string) =>
      ticketRoute(post('/api/escrow/ticket', { intentId: l.intentId, depositor: SHOPPER, replyKeyHash: keccak256(createReplyKey().publicKey as Hex) }, { 'x-real-ip': from }))
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await ask('203.0.113.9')).status)
    expect(statuses[10]).toBe(429)
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true)

    // Marked suspect after the quote: refused before any Lit run.
    const s2 = await listedCard(w)
    __clearEscrowReservationsForTests()
    const q = (await json(await quoteFor(SHOPPER_2, 2_000, { 'x-real-ip': '198.51.100.3' }))).quote as { legs: Array<{ intentId: string }> }
    const picked = q.legs[0]?.intentId ?? ''
    await prisma.intent.update({ where: { id: picked }, data: { failureReason: `escrow_suspect|card_invalid|${new Date(clock).toISOString()}` } })
    const before = w.litCalls.length
    const res = await ticketRoute(
      post('/api/escrow/ticket', { intentId: picked, depositor: SHOPPER_2, replyKeyHash: keccak256(createReplyKey().publicKey as Hex) }, { 'x-real-ip': '198.51.100.3' }),
    )
    expect([res.status, (await json(res)).error]).toEqual([409, 'listing_unavailable'])
    expect(w.litCalls.length).toBe(before)
    expect([l.intentId, s2.intentId]).toContain(picked)
  })

  it('every Lit run comes from one budget per process, and tickets can never take the share kept for releases', async () => {
    const w = await world2()
    const l = await listedCard(w)
    const b = await buyCard(w, await listedCard(w))
    expect((await quoteFor(SHOPPER)).status).toBe(200)
    // Use up this minute's ticket share.
    for (let i = 0; i < 20; i++) litRunBudget.take('ticket', clock)
    const before = w.litCalls.length
    const busy = await ticketRoute(post('/api/escrow/ticket', { intentId: l.intentId, depositor: SHOPPER, replyKeyHash: keccak256(createReplyKey().publicKey as Hex) }))
    expect([busy.status, (await json(busy)).error]).toEqual([429, 'busy'])
    expect(w.litCalls.length).toBe(before)
    // A shopper who already paid still gets their card.
    const rel = await releaseRoute(post('/api/escrow/release', { depositId: b.depositId.toString(), replyKey: b.reply.publicKey }))
    expect(rel.status).toBe(200)

    // The budget itself: per window, a total, and a ticket share under it.
    const budget = new LitRunBudget([{ ms: 60_000, total: 3, tickets: 2 }, { ms: 86_400_000, total: 4, tickets: 4 }])
    expect([budget.take('ticket', 0), budget.take('ticket', 0), budget.take('ticket', 0)]).toEqual([true, true, false])
    expect([budget.take('release', 0), budget.take('release', 0)]).toEqual([true, false])
    // A new minute, but the day is spent.
    expect(budget.take('release', 60_000)).toBe(true)
    expect(budget.take('release', 120_000)).toBe(false)
  })
})

describe('tickets nobody can farm', () => {
  const hashOf = (): Hex => keccak256(createReplyKey().publicKey as Hex)
  const ask = (intentId: string, depositor: string, headers: Record<string, string> = {}) =>
    ticketRoute(post('/api/escrow/ticket', { intentId, depositor, replyKeyHash: hashOf() }, headers))
  const shopper = (i: number): string => `0x${(700 + i).toString(16).padStart(40, '0')}`

  it('a new quote is not a new allowance: one shopper gets three tickets for one card in fifteen minutes, however often it quotes', async () => {
    const w = await world2()
    const l = await listedCard(w)
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      expect((await quoteFor(SHOPPER)).status).toBe(200)
      statuses.push((await ask(l.intentId, SHOPPER)).status)
    }
    expect(statuses).toEqual([200, 200, 200, 409])
    expect(w.litCalls).toHaveLength(3)
    // Fifteen minutes from the first quote, a quote starts again.
    clock += 15 * 60_000
    expect((await quoteFor(SHOPPER)).status).toBe(200)
    expect((await ask(l.intentId, SHOPPER)).status).toBe(200)
  })

  it('one card gets six tickets in fifteen minutes from every shopper together, then is left out of quotes until the window ends', async () => {
    const w = await world2()
    // This one ends sooner, so the matcher picks it first.
    const l = await listedCard(w, { expiresIn: 80_000 })
    const other = await listedCard(w, { seller: SELLER_2 })
    const quotedTo = async (depositor: string): Promise<string[]> => {
      const q = (await json(await quoteFor(depositor))).quote as { legs: Array<{ intentId: string }> }
      return q.legs.map((x) => x.intentId)
    }
    // Three shoppers in turn, each once the last one's hold has ended.
    expect(await quotedTo(shopper(0))).toEqual([l.intentId])
    for (let k = 0; k < 3; k++) expect((await ask(l.intentId, shopper(0))).status).toBe(200)
    clock += 121_000
    expect(await quotedTo(shopper(1))).toEqual([l.intentId])
    for (let k = 0; k < 2; k++) expect((await ask(l.intentId, shopper(1))).status).toBe(200)
    clock += 121_000
    expect(await quotedTo(shopper(2))).toEqual([l.intentId])
    expect((await ask(l.intentId, shopper(2))).status).toBe(200)
    // The card's sixth ticket is spent: the seventh is refused for free, though this shopper has had only one.
    const litBefore = w.litCalls.length
    const busy = await ask(l.intentId, shopper(2))
    expect([busy.status, (await json(busy)).error]).toEqual([409, 'listing_busy'])
    expect(w.litCalls.length).toBe(litBefore)
    // And the next shopper is quoted another card instead of one it could not get a ticket for.
    clock += 121_000
    expect(await quotedTo(shopper(3))).toEqual([other.intentId])
    // Once the fifteen minutes from the card's first ticket are up, it is quoted again.
    clock += 15 * 60_000
    expect(await quotedTo(shopper(4))).toEqual([l.intentId])
  })

  it('one address gets thirty paid ticket runs a day, whoever it says the shoppers are', async () => {
    const w = await world2()
    await listedCard(w)
    await listedCard(w, { seller: SELLER_2 })
    const from = { 'x-real-ip': '198.51.100.77' }
    let ok = 0
    let n = 0
    for (let round = 0; round < 5; round++) {
      for (let k = 0; k < 2; k++) {
        const depositor = shopper(100 + n++)
        const q = (await json(await quoteFor(depositor, 2_000, from))).quote as { legs: Array<{ intentId: string }> }
        for (const leg of q.legs) for (let t = 0; t < 3; t++) if ((await ask(leg.intentId, depositor, from)).status === 200) ok += 1
      }
      // Every hold, per-card window and per-minute limit ends; the day does not.
      clock += 16 * 60_000
    }
    expect(ok).toBe(30)
    const depositor = shopper(100 + n)
    const q = (await json(await quoteFor(depositor, 2_000, from))).quote as { legs: Array<{ intentId: string }> }
    const litBefore = w.litCalls.length
    const over = await ask(q.legs[0]?.intentId ?? '', depositor, from)
    expect([over.status, (await json(over)).error]).toEqual([429, 'daily_limit'])
    expect(String((await json(await ask(q.legs[0]?.intentId ?? '', depositor, from))).message)).toMatch(/^Too many tries from here today\./)
    expect(w.litCalls.length).toBe(litBefore)
    // Another address is not held up by this one.
    expect((await ask(q.legs[0]?.intentId ?? '', depositor, { 'x-real-ip': '198.51.100.78' })).status).toBe(200)
  }, 120_000)

  it('counts an IPv6 client as its /64, so one line cannot pick a fresh limit for every address it has', () => {
    const from = (ip: string) => new Request(APP, { headers: { 'x-real-ip': ip } })
    expect(clientAddress(from('2001:db8:1:2::1'))).toBe('2001:db8:1:2::/64')
    expect(clientAddress(from('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'))).toBe('2001:db8:1:2::/64')
    expect(clientAddress(from('[2001:db8:1:2:aaaa:bbbb:cccc:dddd]'))).toBe('2001:db8:1:2::/64')
    expect(clientAddress(from('2001:db8:1:3::1'))).not.toBe(clientAddress(from('2001:db8:1:2::1')))
    expect(clientAddress(from('::1'))).toBe('0:0:0:0::/64')
    // IPv4, and anything that is not an IPv6 address, as it came.
    expect(clientAddress(from('203.0.113.9'))).toBe('203.0.113.9')
    expect(clientAddress(from('::ffff:203.0.113.9'))).toBe('::ffff:203.0.113.9')
    expect(clientAddress(from('not:an:address:zz'))).toBe('not:an:address:zz')
    expect(clientAddress(new Request(APP, { headers: { 'x-forwarded-for': '2001:db8:9:9::5, 10.0.0.1' } }))).toBe('2001:db8:9:9::/64')
    expect(clientAddress(new Request(APP))).toBe('direct')
  })
})

describe('a card the contract would refuse gets no ticket that goes back', () => {
  const hashOf = (): Hex => keccak256(createReplyKey().publicKey as Hex)
  const ask = (intentId: string, depositor: string = SHOPPER) => ticketRoute(post('/api/escrow/ticket', { intentId, depositor, replyKeyHash: hashOf() }))
  const reasonOf = async (id: string): Promise<string | null> => (await prisma.intent.findUniqueOrThrow({ where: { id } })).failureReason

  it('one card listed twice: once one listing sells, the other is refused after its ticket, marked, and left out of quotes', async () => {
    const w = await world2()
    const cardNumber = world.testCardNumber()
    // The one that sells ends sooner, so the matcher would pick it first.
    const first = await listedCard(w, { cardNumber, expiresIn: 80_000 })
    const second = await listedCard(w, { cardNumber })
    await buyCard(w, first, SHOPPER_2)
    // The chain shows the first sold, so the quote leaves it out and picks the second, which still looks for sale.
    const q = (await json(await quoteFor(SHOPPER))).quote as { legs: Array<{ intentId: string }> }
    expect(q.legs.map((l) => l.intentId)).toEqual([second.intentId])
    const litBefore = w.litCalls.length
    const res = await ask(second.intentId)
    expect([res.status, (await json(res)).error]).toEqual([409, 'card_refused'])
    // Lit signed it (the template never asks who owns the card); the ticket did not go back.
    expect(w.litCalls.length - litBefore).toBe(1)
    expect(await reasonOf(second.intentId)).toMatch(/^escrow_suspect\|card_not_sellers\|/)
    // The next quote finds nothing to sell, not the same dead card again.
    __clearEscrowReservationsForTests()
    const again = await quoteFor(SHOPPER)
    expect([again.status, (await json(again)).message]).toEqual([409, 'There are no Salvo test cards for sale right now.'])
  })

  it('one card under two listings in one quote: the second ticket is refused and marked, and the next quote holds only the other', async () => {
    const w = await world2()
    const cardNumber = world.testCardNumber()
    const a = await listedCard(w, { cardNumber })
    const b = await listedCard(w, { cardNumber })
    const q = (await json(await quoteFor(SHOPPER, 4_000))).quote as { legs: Array<{ intentId: string }> }
    const ids = q.legs.map((l) => l.intentId)
    expect([...ids].sort()).toEqual([a.intentId, b.intentId].sort())
    const [kept, dropped] = ids as [string, string]
    expect((await ask(kept)).status).toBe(200)
    const res = await ask(dropped)
    expect([res.status, (await json(res)).error]).toEqual([409, 'card_refused'])
    expect(await reasonOf(dropped)).toMatch(/^escrow_suspect\|card_listed_twice\|/)
    expect(await reasonOf(kept)).toBeNull()
    // Asked again for the kept one: still its only listing for sale, so its ticket goes back.
    expect((await ask(kept)).status).toBe(200)
    const one = (await json(await quoteFor(SHOPPER, 2_000))).quote as { legs: Array<{ intentId: string }> }
    expect(one.legs.map((l) => l.intentId)).toEqual([kept])
  })

  it('a card taken back and listed again sells as usual: only a listing still for sale counts as a second one', async () => {
    const w = await world2()
    const cardNumber = world.testCardNumber()
    const before = await listedCard(w, { cardNumber, expiresIn: 80_000 })
    expect((await quoteFor(SHOPPER)).status).toBe(200)
    expect((await ask(before.intentId)).status).toBe(200)
    await w.node.chain.send(SELLER, w.escrow, escrowCall.cancelListing(before.listingId))
    const after = await listedCard(w, { cardNumber })
    // A few seconds on, the quote reads the chain again and leaves the cancelled one out.
    clock += 6_000
    const q = (await json(await quoteFor(SHOPPER))).quote as { legs: Array<{ intentId: string }> }
    expect(q.legs.map((l) => l.intentId)).toEqual([after.intentId])
    expect((await ask(after.intentId)).status).toBe(200)
    expect(await reasonOf(after.intentId)).toBeNull()
  })

  it('a blind card over $25 from a seller not yet paid that much: no ticket goes back, and the listings route refuses it before writing', async () => {
    const w = await world2()
    // Written straight to the book, as one recorded before this check was.
    const big = await listedCard(w, { valueCents: 3_000, priceUnits: 27_000_000 })
    expect((await quoteFor(SHOPPER, 3_000)).status).toBe(200)
    const res = await ask(big.intentId)
    expect([res.status, (await json(res)).error]).toEqual([409, 'card_refused'])
    expect(await reasonOf(big.intentId)).toMatch(/^escrow_suspect\|new_seller_cap\|/)

    vi.mocked(guard.assertSealedRefAllowedForOwner).mockImplementation(() => undefined)
    const l = await sealCard(w, { valueCents: 3_000, priceUnits: 27_000_000 })
    await listOnChain(w, l)
    const listed = await listingsRoute(
      post('/api/escrow/listings', { manifest: l.manifestText, envelope: l.envelope, txHash: `0x${'b'.repeat(64)}`, cardFingerprint: `0x${'f2'.repeat(32)}` }),
    )
    const out = await json(listed)
    expect([listed.status, out.error]).toEqual([403, 'new_seller_cap'])
    expect(String(out.message)).toMatch(/^New sellers can list cards up to \$25 here\./)
    expect(await prisma.intent.count()).toBe(1)
  })
})

describe('POST /api/escrow/release', () => {
  it('a flood of made-up or repeated deposit ids reads nothing and uses up nothing: the shopper who just paid still gets the card', async () => {
    const w = await world2()
    const b = await buyCard(w, await listedCard(w))
    const r = (depositId: string, replyKey: string, from: string) =>
      releaseRoute(post('/api/escrow/release', { depositId, replyKey }, { 'x-real-ip': from }))
    // Made-up ids past the newest deposit: one read of the count, then none, from as many addresses as you like.
    expect((await r('999999999999999', createReplyKey().publicKey, '192.0.2.1')).status).toBe(404)
    let reads = w.node.requests.length
    for (let i = 0; i < 150; i++) {
      const res = await r(String(2 + i * 7_919), createReplyKey().publicKey, `10.1.${i}.1`)
      expect([res.status, (await json(res)).error]).toEqual([404, 'no_purchase'])
    }
    expect(w.node.requests.length).toBe(reads)
    // The real deposit with keys that did not buy it: read once, then answered from that read.
    expect((await r(b.depositId.toString(), createReplyKey().publicKey, '192.0.2.2')).status).toBe(403)
    reads = w.node.requests.length
    for (let i = 0; i < 150; i++) expect((await r(b.depositId.toString(), createReplyKey().publicKey, `10.2.${i}.1`)).status).toBe(403)
    expect(w.node.requests.length).toBe(reads)
    // The shopper who paid, from their own address: not held up by any of it.
    const mine = await r(b.depositId.toString(), b.reply.publicKey, '203.0.113.200')
    expect(mine.status).toBe(200)
    const out = (await json(mine)) as { reply: string; payload: string }
    const plain = b.reply.open(out.reply, out.payload, w.template.encPub as string)
    expect(JSON.parse(plain.toString('utf8')).cardNumber).toMatch(CARD_RE)
    plain.fill(0)
  })

  it('a purchase one block old on the host behind is released on the first ask: the route waits for that host, never "not there yet"', async () => {
    const w = await world2()
    const l = await listedCard(w)
    const landedAt = w.node.chain.blockNumber
    const b = await buyCard(w, l)
    w.node.advance(1)
    // dRPC a block behind Tempo's own host. The fake keeps no history, so both hosts answer the count at a block
    // before the purchase without it: the read the route decides "not there yet" on.
    const count = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'depositCount' })
    const history = (m: string, p: unknown[], r: unknown): unknown =>
      m === 'eth_call' && (p[0] as { data?: unknown } | undefined)?.data === count && typeof p[1] === 'string' && BigInt(p[1]) < landedAt
        ? encodeFunctionResult({ abi: ESCROW_ABI, functionName: 'depositCount', result: b.depositId - 1n })
        : r
    w.node.setHost(0, { lie: history })
    w.node.setHost(1, { lag: 2, lie: history })
    const res = await releaseRoute(post('/api/escrow/release', { depositId: b.depositId.toString(), replyKey: b.reply.publicKey }))
    expect(res.status).toBe(200)
    const out = (await json(res)) as { reply: string; payload: string }
    const plain = b.reply.open(out.reply, out.payload, w.template.encPub as string)
    expect(JSON.parse(plain.toString('utf8'))).toEqual({ cardNumber: l.cardNumber, pin: null })
    plain.fill(0)
    // A made-up id just past it, with that host still behind: no wait, said at once.
    const made = await releaseRoute(post('/api/escrow/release', { depositId: (b.depositId + 1n).toString(), replyKey: b.reply.publicKey }))
    expect([made.status, (await json(made)).error]).toEqual([404, 'no_purchase'])
  })

  it("a paid card is no longer held for its buyer's quote: the next shopper is not told there is nothing", async () => {
    const w = await world2()
    const l = await listedCard(w)
    const id = l.intentId
    // The buyer's quote held the card (measured live: the next shopper, a minute later, was told there was nothing).
    expect(holdQuotedCards(SHOPPER, '203.0.113.9', [id], Date.now())).toBe(true)
    expect(cardsNotQuotable(SHOPPER_2, Date.now())).toContain(id)
    const b = await buyCard(w, l)
    // A key that did not buy it changes nothing.
    expect((await releaseRoute(post('/api/escrow/release', { depositId: b.depositId.toString(), replyKey: createReplyKey().publicKey }))).status).toBe(403)
    expect(cardsNotQuotable(SHOPPER_2, Date.now())).toContain(id)
    // The buyer's release ends the hold.
    expect((await releaseRoute(post('/api/escrow/release', { depositId: b.depositId.toString(), replyKey: b.reply.publicKey }))).status).toBe(200)
    expect(cardsNotQuotable(SHOPPER_2, Date.now())).not.toContain(id)
  })

  it('a hold is let go only by its own holder', () => {
    __clearEscrowReservationsForTests()
    const id = `esc_${'ab'.repeat(32)}`
    expect(holdQuotedCards(SHOPPER, '203.0.113.9', [id], Date.now())).toBe(true)
    releasePaidCard(id, SHOPPER_2)
    expect(cardsNotQuotable(SHOPPER_2, Date.now())).toContain(id)
    releasePaidCard(id, SHOPPER.toUpperCase() as typeof SHOPPER)
    expect(cardsNotQuotable(SHOPPER_2, Date.now())).not.toContain(id)
  })

  it('releases the card to the phone that bought it, as ciphertext only, the same bytes every time', async () => {
    const w = await world2()
    const l = await listedCard(w)
    const b = await buyCard(w, l)
    const litBefore = w.litCalls.length
    const req = () => releaseRoute(post('/api/escrow/release', { depositId: b.depositId.toString(), replyKey: b.reply.publicKey }))
    const first = await req()
    expect(first.status).toBe(200)
    const out = (await json(first)) as { depositId: string; reply: string; payload: string }
    expect(out.payload).toBe(replyPayload(ESCROW_CHAIN_ID, b.depositId.toString(), w.escrow, l.manifestText))
    const plain = b.reply.open(out.reply, out.payload, w.template.encPub as string)
    expect(JSON.parse(plain.toString('utf8'))).toEqual({ cardNumber: l.cardNumber, pin: null })
    plain.fill(0)
    // The second is the same bytes, from memory: one paid run for any number of retries.
    expect((await json(await req())).reply).toBe(out.reply)
    expect(w.litCalls.length - litBefore).toBe(1)
    expect(wire(w, [JSON.stringify(out)])).not.toContain(l.cardNumber)
  })

  it('one purchase is not a paid run every few seconds forever: repeats come from memory, and a deposit gets few runs', async () => {
    const w = await world2()
    const l = await listedCard(w)
    const b = await buyCard(w, l)
    const litBefore = w.litCalls.length
    const r = (replyKey: string) => releaseRoute(post('/api/escrow/release', { depositId: b.depositId.toString(), replyKey }))
    for (let i = 0; i < 8; i++) expect((await r(b.reply.publicKey)).status).toBe(200)
    expect(w.litCalls.length - litBefore).toBe(1)
    // Someone else's keys are refused for free.
    for (let i = 0; i < 4; i++) expect((await r(createReplyKey().publicKey)).status).toBe(403)
    expect(w.litCalls.length - litBefore).toBe(1)
    // The reply keys one deposit may be released to over the process's life.
    // A key kept twice is one key.
    const escrow = `0x${'ab'.repeat(20)}` as Hex
    const key = (i: number): Hex => `0x${i.toString(16).padStart(64, '0')}`
    const kept = { reply: 'AA==', payload: '{}' }
    const may: boolean[] = []
    for (const i of [0, 0, 1, 2, 3, 4, 5]) {
      may.push(releaseMemory.mayRun(escrow, '9'))
      releaseMemory.keep(escrow, '9', key(i), kept)
    }
    expect(may.every(Boolean)).toBe(true)
    expect(releaseMemory.mayRun(escrow, '9')).toBe(false)
  })

  it('a release that did not come back costs the deposit nothing: after Lit refuses, fails and is busy, the shopper who paid still gets the card', async () => {
    const w = await world2()
    const l = await listedCard(w)
    const b = await buyCard(w, l)
    // Lit reading the chain through its own hosts, which can fail while ours answer.
    let litHostsDown = true
    let litDown = false
    const nodeFetch = w.node.rpc.fetch as unknown as typeof fetch
    const lit = makeFakeLit({
      actionFetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (litHostsDown) throw new TypeError('fetch failed')
        return nodeFetch(input, init)
      }) as typeof fetch,
    })
    __setEscrowRuntimeForTests({
      ...w.rt,
      now: () => clock,
      lit: {
        ...w.rt.lit,
        sleep: async () => {},
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          if (litDown) throw new TypeError('fetch failed')
          return lit.fetchImpl(input, init)
        }) as typeof fetch,
      },
    })
    let n = 0
    // Each from an address of its own, so the per-address limit is not what stops them.
    const r = () => releaseRoute(post('/api/escrow/release', { depositId: b.depositId.toString(), replyKey: b.reply.publicKey }, { 'x-real-ip': `203.0.113.${++n}` }))
    const outcome = async (): Promise<[number, unknown]> => {
      const res = await r()
      return [res.status, (await json(res)).error]
    }

    // A host down inside Lit: the template denies, which reads as not final yet. Seven times.
    for (let i = 0; i < 7; i++) expect(await outcome()).toEqual([409, 'not_final'])
    // Lit itself not answering. Seven more.
    litHostsDown = false
    litDown = true
    for (let i = 0; i < 7; i++) expect(await outcome()).toEqual([502, 'lit_unavailable'])
    // The Lit budget full for this minute. Seven more.
    litDown = false
    while (litRunBudget.take('release', clock)) {
      // Spend what is left of this minute.
    }
    for (let i = 0; i < 7; i++) expect(await outcome()).toEqual([429, 'busy'])

    // A minute on, with Lit and its hosts back, the card comes back: none of that used the deposit up.
    clock += 60_000
    const ok = await r()
    expect(ok.status).toBe(200)
    const out = (await json(ok)) as { reply: string; payload: string }
    const plain = b.reply.open(out.reply, out.payload, w.template.encPub as string)
    expect(JSON.parse(plain.toString('utf8'))).toEqual({ cardNumber: l.cardNumber, pin: null })
    plain.fill(0)
  })

  it('limits releases per address before any chain read, keyed on nothing the caller picks', async () => {
    const w = await world2()
    const b = await buyCard(w, await listedCard(w))
    const r = (replyKey: string, from: string) => releaseRoute(post('/api/escrow/release', { depositId: b.depositId.toString(), replyKey }, { 'x-real-ip': from }))
    // A fresh made-up key each time still counts against the address.
    const statuses: number[] = []
    for (let i = 0; i < 20; i++) statuses.push((await r(createReplyKey().publicKey, '203.0.113.21')).status)
    expect(statuses.every((s) => s === 403)).toBe(true)
    const reads = w.node.requests.length
    const over = await r(createReplyKey().publicKey, '203.0.113.21')
    expect([over.status, (await json(over)).error]).toEqual([429, 'slow_down'])
    expect(w.node.requests.length).toBe(reads)
    // The buyer, from their own address, is not held up.
    expect((await r(b.reply.publicKey, '198.51.100.30')).status).toBe(200)
  })

  it('refuses for free a key that did not buy it, a deposit that is not there, and a listing we do not hold', async () => {
    const w = await world2()
    const l = await listedCard(w)
    const b = await buyCard(w, l)
    const litBefore = w.litCalls.length
    const r = (depositId: string, replyKey: string) => releaseRoute(post('/api/escrow/release', { depositId, replyKey }))

    const other = await r(b.depositId.toString(), createReplyKey().publicKey)
    expect([other.status, (await json(other)).error]).toEqual([403, 'not_your_card'])
    const missing = await r('99', b.reply.publicKey)
    expect([missing.status, (await json(missing)).error]).toEqual([404, 'no_purchase'])

    const foreign = await sealCard(w)
    await listOnChain(w, foreign)
    const fb = await buyCard(w, foreign)
    // A deposit made since the route last read the count is seen once it reads it again, at most once a second.
    clock += 1_000
    const unknown = await r(fb.depositId.toString(), fb.reply.publicKey)
    expect([unknown.status, (await json(unknown)).error]).toEqual([404, 'unknown_listing'])
    // buyCard's own ticket is the only Lit run since: none of the refusals cost one.
    expect(w.litCalls.length - litBefore).toBe(1)
  })
})
