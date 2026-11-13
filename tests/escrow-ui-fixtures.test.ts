/**
 * The UI audit's Salvo Pay fixtures are answers the real phone accepts.
 *
 * scripts/ui-states-escrow.ts stands in for our escrow routes and both chain
 * hosts while the audit drives /account and /sell, and it writes what a
 * finished purchase leaves on the phone. Nothing in the audit itself can tell
 * whether the client would have taken those answers: a quote the phone
 * refuses renders as a refusal, and the audit would quietly measure the wrong
 * screen. So this runs the real client modules against the very same
 * answers, offline, and opens what the seeding wrote with the real card store.
 *
 * No network, no database: the routes and hosts are the fixture's functions,
 * and IndexedDB is the in-memory fake.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { EscrowApi, pagePins, parseEscrowConfig, type EscrowPublicConfig } from '@/lib/escrow/client/api'
import { openCardStore, type CardStore, type PasskeyRecord } from '@/lib/escrow/client/card-store'
import {
  checkQuote,
  discardPrepared,
  LoadRefused,
  prepareLoad,
  quoteLoad,
  resumePurchase,
  unfinishedPurchases,
  type BatchSigner,
  type LoadDeps,
} from '@/lib/escrow/client/load'
import { listCard, listingStates, SellRefused } from '@/lib/escrow/client/sell'
import { DeviceWallet, shopperKeyRestrictions, type ChainAccess } from '@/lib/escrow/client/wallet'
import { ESCROW_RPC_URLS } from '@/lib/escrow/hosts'
import { PATH_USD } from '@/lib/escrow/manifest'
import { tokenBalanceAt } from '@/lib/escrow/runbook/reads'
import { agreedFinalizedBlock } from '@/lib/escrow/runbook/rpc'
import {
  boughtCardSeed,
  configBody,
  escrowRouteAnswer,
  FIXTURE_BALANCE_UNITS,
  FIXTURE_TEST_CARD,
  fixturePins,
  fixtureWorld,
  isChainHost,
  paidPurchaseSeed,
  RAIL_OFF_BODY,
  readDeviceAccount,
  rpcAnswer,
  sellerListingsSeed,
  writeDeviceSeed,
  type FixtureWorld,
} from '../scripts/ui-states-escrow'
import { ESCROW_V1_PINS, type EscrowPins } from '@/lib/vault/lit/escrow-pins'
import { FakeIndexedDB } from './support/fake-indexeddb'

const SHOPPER: Hex = '0x5a1f0000000000000000000000000000000000b2'
/** What the committed page trusts: the live escrow, signer and sealing key pinned on 2026-10-10. */
const LIVE_PINS = {
  escrow: '0x75c9aabe8254559f865e14d6e5fa70c738869bef',
  identity: '0x9109cd47811a9fc64c88316d64954b6b228d2cfe',
  encPub: '0x034580968471306568d23fc9e56127394b53a414e8b272f82d1f72a6e2adccda24',
}
/** escrow-pins.ts as it was before the pin steps. */
const UNPINNED: EscrowPins = {
  ...ESCROW_V1_PINS,
  encPub: null,
  identity: null,
  escrowAddress: null,
  escrowDeployer: null,
  escrowCreationTx: null,
}

/** The page's api module built with `pins` in place of escrow-pins.ts, for one import graph. */
async function apiWithPins(pins: EscrowPins): Promise<typeof import('@/lib/escrow/client/api')> {
  vi.resetModules()
  vi.doMock('@/lib/vault/lit/escrow-pins', () => ({ ESCROW_V1_PINS: Object.freeze({ ...pins }) }))
  return import('@/lib/escrow/client/api')
}

/** The fixture's escrow routes, as the page's fetch would reach them. Every body sent is kept. */
function fixtureApi(sent: string[], w: FixtureWorld): EscrowApi {
  return new EscrowApi(async (path, init) => {
    const body = typeof init?.body === 'string' ? init.body : null
    if (body !== null) sent.push(body)
    const got = await escrowRouteAnswer(path, body === null ? null : JSON.parse(body))
    if (got === null) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(got.body), { status: got.status })
  }, fixturePins(w))
}

/** Both fixture hosts, as the phone's JSON-RPC client reaches them. */
function fixtureHosts(): ChainAccess {
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) =>
    new Response(JSON.stringify(await rpcAnswer(String(init?.body ?? ''))), { status: 200 })) as typeof fetch
  return { hosts: { urls: ESCROW_RPC_URLS, fetchImpl, timeoutMs: 5_000 }, sponsorUrl: null }
}

/** A signer that must never be asked: no fixture state signs or sends anything. */
function neverSigns(account: Hex): BatchSigner & { asked: number } {
  const s = {
    account,
    asked: 0,
    async signCalls(): Promise<never> {
      s.asked += 1
      throw new Error('a fixture state signed a batch')
    },
    async broadcast(): Promise<never> {
      s.asked += 1
      throw new Error('a fixture state sent a batch')
    },
  }
  return s
}

async function world(): Promise<{ w: FixtureWorld; config: EscrowPublicConfig }> {
  const w = await fixtureWorld()
  const cfg = parseEscrowConfig(200, configBody(w), fixturePins(w))
  if (cfg.state !== 'ready') throw new Error(`the fixture config parses as ${cfg.state}`)
  return { w, config: cfg.config }
}

async function phone(account: Hex = SHOPPER): Promise<{ deps: LoadDeps; store: CardStore; idb: FakeIndexedDB; signer: ReturnType<typeof neverSigns>; sent: string[] }> {
  const { w, config } = await world()
  const idb = new FakeIndexedDB()
  // writeDeviceSeed and readDeviceAccount run in the page, on its global indexedDB.
  vi.stubGlobal('indexedDB', idb.asFactory())
  const store = await openCardStore(idb.asFactory())
  const sent: string[] = []
  const signer = neverSigns(account)
  return { deps: { store, api: fixtureApi(sent, w), config, access: fixtureHosts(), wallet: signer, sleep: async () => {} }, store, idb, signer, sent }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('@/lib/vault/lit/escrow-pins')
  vi.resetModules()
})

describe('the config and the hosts', () => {
  it('names the fixture identity and sealing key, and the off and not-ready answers read as the routes', async () => {
    const { w, config } = await world()
    expect(config.identity).toBe(w.identity)
    expect(config.encPub).toBe(w.encPub)
    expect(config.escrow).toBe(w.escrow)
    expect(config.sponsorUrl).toBeNull()
    expect(config.listingOpen).toBe(true)
    const pins = fixturePins(w)
    expect(parseEscrowConfig(503, RAIL_OFF_BODY, pins)).toEqual({ state: 'off' })
    expect(parseEscrowConfig(200, { ...configBody(w), ready: false, escrow: null }, pins)).toEqual({ state: 'not_ready' })
    expect(parseEscrowConfig(502, {}, pins)).toEqual({ state: 'error' })
  })

  it("holds the server to the page's own pins: another sealing key, signer, escrow or code is refused whole", async () => {
    const { w } = await world()
    const pins = fixturePins(w)
    const body = configBody(w)
    const tpl = body.template as Record<string, unknown>
    const other = `0x${'77'.repeat(20)}`
    for (const bad of [
      // A server naming its own sealing key would get every card a seller types.
      { ...body, template: { ...tpl, encPub: `0x02${'11'.repeat(32)}` } },
      // Or its own escrow and signer, and a shopper's allowance would be signed over to it.
      { ...body, escrow: other },
      { ...body, template: { ...tpl, identity: other } },
      { ...body, template: { ...tpl, escrowCodehash: `0x${'00'.repeat(32)}` } },
    ]) {
      expect(parseEscrowConfig(200, bad, pins)).toEqual({ state: 'error' })
    }
    // The values the page uses are its own, whatever the server sends.
    const ok = parseEscrowConfig(200, body, pins)
    expect(ok.state === 'ready' && ok.config.encPub === pins.encPub && ok.config.escrow === pins.escrow).toBe(true)
    // The committed build pins the live escrow, signer and sealing key, so a
    // server naming the fixture's is refused whole.
    expect(pagePins()).toEqual(LIVE_PINS)
    expect(parseEscrowConfig(200, body)).toEqual({ state: 'error' })
    // Before the pin step the page had no pins: no config could make it ready.
    const unpinned = await apiWithPins(UNPINNED)
    expect(unpinned.pagePins()).toBeNull()
    expect(unpinned.parseEscrowConfig(200, body)).toEqual({ state: 'not_ready' })
  })

  it("only a development build takes the audit's fixture pins from the page", async () => {
    const { w } = await world()
    const key = '__SALVO_ESCROW_FIXTURE_PINS__'
    const env = process.env as Record<string, string | undefined>
    const saved = env.NODE_ENV
    vi.stubGlobal(key, fixturePins(w))
    const unpinned = await apiWithPins(UNPINNED)
    try {
      env.NODE_ENV = 'development'
      expect(pagePins()).toEqual(fixturePins(w))
      expect(unpinned.pagePins()).toEqual(fixturePins(w))
      // A production build never reads the global: its own pins, or none.
      env.NODE_ENV = 'production'
      expect(pagePins()).toEqual(LIVE_PINS)
      expect(unpinned.pagePins()).toBeNull()
    } finally {
      env.NODE_ENV = saved
    }
  })

  it('serves reads only: a transaction is refused, and only the two pinned hosts are matched', async () => {
    const send = await rpcAnswer(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'eth_sendRawTransaction', params: ['0x76'] }))
    expect(send).toMatchObject({ id: 7, error: { code: -32000 } })
    expect(await rpcAnswer(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_fillTransaction', params: [] }))).toMatchObject({ error: { code: -32601 } })
    for (const u of ESCROW_RPC_URLS) expect(isChainHost(new URL(u))).toBe(true)
    expect(isChainHost(new URL('https://rpc.moderato.tempo.xyz.example.invalid/'))).toBe(false)
    expect(isChainHost(new URL('http://localhost:3000/api/escrow/config'))).toBe(false)
  })

  it('agrees on one finalized block on both hosts, with $250 for any account and the whole signed allowance', async () => {
    const { w } = await world()
    const { hosts } = fixtureHosts()
    const block = await agreedFinalizedBlock(hosts)
    expect(await tokenBalanceAt(hosts, block, PATH_USD, SHOPPER)).toBe(FIXTURE_BALANCE_UNITS)
    const { store } = await phone()
    const passkey: PasskeyRecord = { credentialId: 'c', publicKey: '0x00', address: SHOPPER, rpId: 'localhost', createdAt: 0 }
    const wallet = new DeviceWallet(
      store,
      {
        role: 'shopper',
        account: SHOPPER,
        accessKeyAddress: '0x00000000000000000000000000000000000ac0e5',
        keyPair: {} as never,
        restrictions: shopperKeyRestrictions(w.escrow, Number(block.timestamp)),
        createdAt: 0,
      },
      passkey,
    )
    expect(await wallet.balance(hosts)).toBe(FIXTURE_BALANCE_UNITS)
    expect(await wallet.allowance(hosts)).toEqual({ remainingUnits: 200_000_000n, periodEnd: null, onChain: false, ended: false })
  })
})

describe('the Load', () => {
  it('quotes $52 at Target as the $55 card, which the phone checks against the chain and gets a ticket for', async () => {
    const { deps, signer } = await phone()
    const ask = { merchant: 'target' as const, spendCents: 5_200, depositor: SHOPPER }
    const q = await quoteLoad(deps, ask)
    await checkQuote(deps, ask, q)
    expect(q).toMatchObject({ loadCents: 5_500, priceCents: 4_840, leftoverCents: 300 })
    expect(q.legs).toHaveLength(1)
    const p = await prepareLoad(deps, ask, q)
    expect(p.legs[0]?.ticket).toMatchObject({ depositor: SHOPPER, listingId: q.legs[0]?.listingId, openBalanceCents: 0 })
    discardPrepared(p)
    expect(signer.asked).toBe(0)
  })

  it('quotes $77.50 as both cards, the whole one scanned first, and tickets both', async () => {
    const { w } = await world()
    const { deps } = await phone()
    const ask = { merchant: 'target' as const, spendCents: 7_750, depositor: SHOPPER }
    const q = await quoteLoad(deps, ask)
    expect(q.legs.map((l) => l.valueCents)).toEqual([5_500, 2_500])
    expect(q.legs[0]?.listingId).toBe(w.cards.whole.listingId)
    const p = await prepareLoad(deps, ask, q)
    expect(p.legs).toHaveLength(2)
    discardPrepared(p)
  })

  it('refuses Walmart in the route words the refusal state waits for', async () => {
    const { deps } = await phone()
    const refused = await quoteLoad(deps, { merchant: 'walmart', spendCents: 3_000, depositor: SHOPPER }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(LoadRefused)
    expect((refused as LoadRefused).code).toBe('unavailable')
    expect((refused as LoadRefused).message).toBe('There are no Walmart cards for sale right now.')
  })

  it('a seeded paid purchase finishes through the release answer, and the card opens with the real store', async () => {
    const { w } = await world()
    const { deps, store, signer, sent } = await phone()
    await writeDeviceSeed(paidPurchaseSeed(w, SHOPPER))
    const pending = await unfinishedPurchases(store)
    expect(pending).toHaveLength(1)
    const cards = await resumePurchase(deps, pending[0]?.id ?? '')
    expect(cards).toHaveLength(1)
    const card = cards[0]
    expect(card).toMatchObject({ merchant: 'target', valueCents: 5_500, scanOrder: 1, ofCards: 1, last4: w.cards.whole.cardNumber.slice(-4) })
    expect((await store.cardSecret(card?.id ?? ''))?.cardNumber).toBe(w.cards.whole.cardNumber)
    expect(await unfinishedPurchases(store)).toEqual([])
    // Seeding again puts the same purchase back, so a state can run twice in one browser.
    await writeDeviceSeed(paidPurchaseSeed(w, SHOPPER))
    expect(await unfinishedPurchases(store)).toHaveLength(1)
    expect(await resumePurchase(deps, pending[0]?.id ?? '')).toHaveLength(1)
    expect(signer.asked).toBe(0)
    // The phone sent no card material, only the public reply key.
    for (const body of sent) expect(body).not.toContain(w.cards.whole.cardNumber)
  })
})

describe('the phone store', () => {
  it('a seeded bought card lists without opening, and opens to its number', async () => {
    const { w } = await world()
    const { store } = await phone()
    await writeDeviceSeed(boughtCardSeed(w))
    const cards = await store.cards()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ merchant: 'target', valueCents: 2_500, last4: w.cards.small.cardNumber.slice(-4) })
    expect(await store.cardSecret(cards[0]?.id ?? '')).toEqual({ cardNumber: w.cards.small.cardNumber, pin: null })
  })

  it('reads the passkey account the setup screen saved, and null before it', async () => {
    const { store } = await phone()
    expect(await readDeviceAccount()).toBeNull()
    await store.savePasskey({ credentialId: 'c', publicKey: '0x00', address: SHOPPER, rpId: 'localhost', createdAt: 0 })
    expect(await readDeviceAccount()).toBe(SHOPPER)
  })
})

describe('the seller', () => {
  it("shows the seeded rows as the chain says, the sold one by its sale, and refuses a new seller's $40 card before sealing", async () => {
    const { w } = await world()
    const { deps, store, signer } = await phone()
    await writeDeviceSeed(sellerListingsSeed(w, SHOPPER))
    const rows = await store.listings()
    const { views } = await listingStates(deps.access, deps.config, rows)
    expect(rows.map((r) => views.get(r.listingId)?.state).sort()).toEqual(['listed', 'sold'])
    const sold = rows.find((r) => views.get(r.listingId)?.state === 'sold')
    expect(views.get(sold?.listingId ?? '0x')?.sale).toMatchObject({ depositId: '1', state: 'held', disputed: false })
    const refused = await listCard(deps, { merchant: 'salvotest', cardNumber: FIXTURE_TEST_CARD, pin: null, valueCents: 4_000, priceCents: 3_600 }).catch(
      (e: unknown) => e,
    )
    expect(refused).toBeInstanceOf(SellRefused)
    expect((refused as SellRefused).message).toMatch(/^New sellers can list cards up to \$25 here\./)
    expect(signer.asked).toBe(0)
  })
})
