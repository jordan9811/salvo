/**
 * The escrow branch of /sell, in the seller's browser
 * (src/lib/escrow/client/sell.ts), end to end and offline: the real
 * listings route, the real escrow on the in-process EVM, the real template on
 * fake Lit, and a shopper's phone buying what the browser sealed.
 *
 * Pinned (spec section 8.2, review condition 5):
 *   - the card is sealed in the browser: no body sent to our server, no
 *     request to either host, and nothing our server stored holds the number;
 *     yet a shopper who buys it opens exactly that number;
 *   - the seller's access key sends `list`, with no Face ID;
 *   - on the testnet today's guard, asked about the operator, takes
 *     listings, and the config says so; while our server takes no listings
 *     at all (a custody refusal), the page knows it from the config and
 *     refuses before sealing, posting nothing;
 *   - our server is asked first: a seller it will not take (a set allowlist)
 *     hears it with nothing sent on chain;
 *   - only the Salvo test card or a Target card can be listed on the test
 *     chain;
 *   - a sold card's row follows its sale, and the seller can collect a sale
 *     that is due with Get paid; a payout the token would not send waits in
 *     the escrow as owed, is never said to have arrived, and Claim sends it;
 *   - a blind card over $25 from a new seller is refused before sealing,
 *     since the contract would refuse every buyer;
 *   - an unsold listing can be taken back; the chain says what each one is;
 *   - with no fee sponsor, listing and taking back pay their fee from the
 *     seller's test dollars, so a seller with none is told to get some first,
 *     with nothing sent, and a listing the node refused for its fee is not
 *     kept as one on its way;
 *   - a listing that never reached the chain can be removed from the device;
 *   - Send to Salvo again says our server's own words when trying again
 *     cannot help, and "try again in a minute" only when it can.
 * Shares the test database, so it runs serially with the rest.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/vault/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/vault/guard')>()
  return { ...actual, assertSealedRefAllowedForOwner: vi.fn(actual.assertSealedRefAllowedForOwner) }
})

const { prisma } = await import('@/lib/db')
const guard = await import('@/lib/vault/guard')
const realGuard = (await vi.importActual<typeof import('@/lib/vault/guard')>('@/lib/vault/guard')).assertSealedRefAllowedForOwner
const { __clearEscrowReservationsForTests } = await import('@/lib/escrow/quote')
const { __clearReleaseMemoryForTests } = await import('@/lib/escrow/lit-escrow')
const { __setEscrowRuntimeForTests } = await import('@/lib/escrow/runtime')
const { escrowIntentIdFor } = await import('@/lib/escrow/refs')
const sell = await import('@/lib/escrow/client/sell')
const load = await import('@/lib/escrow/client/load')
const world = await import('./support/escrow-server-world')
const { deviceFor } = await import('./support/escrow-phone')
const { installTempoWallet } = await import('./support/fake-tempo-wallet')
const { tokenCall } = await import('./support/escrow-chain')
const { PATH_USD } = await import('@/lib/escrow/manifest')
const { tokenBalanceAt } = await import('@/lib/escrow/runbook/reads')
const { agreedFinalizedBlock, EscrowRpcError } = await import('@/lib/escrow/runbook/rpc')
const { encodeFunctionData, erc20Abi } = await import('viem')
const { owedLine, saleLine } = await import('@/app/pay/escrow-copy')
const { resetDb } = await import('./helpers')

type ServerWorld = Awaited<ReturnType<typeof world.serverWorld>>
type Device = import('./support/escrow-phone').Device
type SellDeps = import('@/lib/escrow/client/sell').SellDeps

const SAVED = {
  ESCROW_RAIL: process.env.ESCROW_RAIL,
  LIT_VAULT_USAGE_KEY: process.env.LIT_VAULT_USAGE_KEY,
  ESCROW_SELLER_ALLOWLIST: process.env.ESCROW_SELLER_ALLOWLIST,
  LIT_CHIPOTLE_ACCOUNT_KEY: process.env.LIT_CHIPOTLE_ACCOUNT_KEY,
  LIT_CHIPOTLE_API_KEY: process.env.LIT_CHIPOTLE_API_KEY,
}

function setEnvVars(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

let testIndex = 0

interface Setup {
  w: ServerWorld
  seller: Device
  deps: SellDeps
  layer: ReturnType<typeof installTempoWallet>
}

/**
 * `guardAllows: false` leaves today's real guard in place; `guardRefuses`
 * makes it refuse every listing, as it would if the testnet owner were
 * ever refused.
 */
async function setup(opts: { allow?: boolean; guardAllows?: boolean; guardRefuses?: boolean } = {}): Promise<Setup> {
  const w = await world.serverWorld()
  testIndex += 1
  const clock = Number(w.node.chain.timestamp) * 1000 + testIndex * 180_000
  const rt = { ...w.rt, now: () => clock }
  __setEscrowRuntimeForTests(rt)
  const layer = installTempoWallet(w.node)
  const seller = await deviceFor(w, 'seller')
  setEnvVars({ ESCROW_SELLER_ALLOWLIST: opts.allow === false ? world.SELLER : seller.wallet.account })
  if (opts.guardRefuses === true) {
    vi.mocked(guard.assertSealedRefAllowedForOwner).mockImplementation(() => {
      throw new guard.CustodialVaultRefusedError('chipotle:escrow:v1', 'operator:0', 'refused for this test')
    })
  } else if (opts.guardAllows !== false) {
    vi.mocked(guard.assertSealedRefAllowedForOwner).mockImplementation(() => undefined)
  }
  // The page reads the config again once the server's settings are these.
  const cfg = await seller.api.config()
  if (cfg.state !== 'ready') throw new Error(`setup: config is ${cfg.state}`)
  seller.config = cfg.config
  return {
    w: { ...w, rt },
    seller,
    deps: { store: seller.store, api: seller.api, config: seller.config, access: seller.access, wallet: seller.wallet, sleep: async () => w.node.advance(1) },
    layer,
  }
}

const CARD = '9999424242424242'
const input = (over: Partial<import('@/lib/escrow/client/sell').SellInput> = {}) => ({
  merchant: 'salvotest' as const,
  cardNumber: CARD,
  pin: null,
  valueCents: 2_000,
  priceCents: 1_800,
  ...over,
})

/** Signed transactions this test's devices sent: the world's own deploy is not counted. */
const sentTxs = (s: Setup): number => s.w.node.sent('eth_sendRawTransaction').length - s.w.setupTxs

beforeEach(async () => {
  await resetDb()
  __clearEscrowReservationsForTests()
  __clearReleaseMemoryForTests()
  vi.clearAllMocks()
  vi.mocked(guard.assertSealedRefAllowedForOwner).mockImplementation(realGuard)
  setEnvVars({ ESCROW_RAIL: 'testnet', LIT_VAULT_USAGE_KEY: 'usage-key-for-tests', LIT_CHIPOTLE_ACCOUNT_KEY: undefined, LIT_CHIPOTLE_API_KEY: undefined })
})

afterEach(() => {
  world.closeServerWorld()
})

afterAll(async () => {
  setEnvVars(SAVED)
  await resetDb()
  await prisma.$disconnect()
})

describe('listing a card sealed in this browser', () => {
  it('lists on chain with the seller key, records it, and a shopper opens exactly that card', async () => {
    const s = await setup()
    const prompts = s.seller.auth.prompts
    const steps: string[] = []
    const r = await sell.listCard(s.deps, input(), (x) => steps.push(x))
    expect(steps).toEqual(['checking', 'sealing', 'listing', 'recording'])
    expect(r.posted).toBe(true)
    expect(s.seller.auth.prompts).toBe(prompts)
    expect(s.layer.landed).toHaveLength(1)
    expect(s.layer.landed[0]).toMatchObject({ account: s.seller.wallet.account, keyId: s.seller.wallet.accessKeyAddress, ok: true, carriedAuthorization: true })
    expect(s.layer.landed[0]?.calls[0]?.to).toBe(s.seller.config.escrow)

    // Our server holds the listing: ciphertext and terms, never the card.
    const row = await prisma.intent.findUnique({ where: { id: escrowIntentIdFor(r.listingId) } })
    expect(row?.state).toBe('offered')
    expect(JSON.stringify(row)).not.toContain(CARD)
    expect(s.seller.sent.join('\n')).not.toContain(CARD)
    expect(s.w.node.requests.map((q) => q.bodyText).join('\n')).not.toContain(CARD)
    expect(sell.listingFileText(r, s.seller.config)).not.toContain(CARD)
    expect(JSON.parse(sell.listingFileText(r, s.seller.config))).toMatchObject({ listingId: r.listingId, manifest: r.manifest, envelope: r.envelope })

    // The device keeps it, and the chain says it is listed.
    const [kept] = await s.seller.store.listings()
    expect(kept?.listingId).toBe(r.listingId)
    expect((await sell.listingStates(s.seller.access, s.seller.config, [r])).views.get(r.listingId)?.state).toBe('listed')

    // A shopper buys it, and the card Lit opens on their phone is the one typed here.
    const shopper = await deviceFor(s.w, 'shopper')
    const deps = { store: shopper.store, api: shopper.api, config: shopper.config, access: shopper.access, wallet: shopper.wallet, sleep: async () => s.w.node.advance(1) }
    const ask = { merchant: 'salvotest' as const, spendCents: 2_000, depositor: shopper.wallet.account }
    const cards = await load.executeLoad(deps, await load.prepareLoad(deps, ask, await load.quoteLoad(deps, ask)))
    expect(await shopper.store.cardSecret(cards[0]?.id ?? '')).toEqual({ cardNumber: CARD, pin: null })
    expect((await sell.listingStates(s.seller.access, s.seller.config, [r])).views.get(r.listingId)?.state).toBe('sold')
  })

  it('a sold row follows its sale, not its listing: held until a time, then the seller collects it with Face ID', async () => {
    const s = await setup()
    const r = await sell.listCard(s.deps, input())
    const shopper = await deviceFor(s.w, 'shopper')
    const deps = { store: shopper.store, api: shopper.api, config: shopper.config, access: shopper.access, wallet: shopper.wallet, sleep: async () => s.w.node.advance(1) }
    const ask = { merchant: 'salvotest' as const, spendCents: 2_000, depositor: shopper.wallet.account }
    await load.executeLoad(deps, await load.prepareLoad(deps, ask, await load.quoteLoad(deps, ask)))

    const read = await sell.listingStates(s.seller.access, s.seller.config, [r], s.seller.store)
    const sale = read.views.get(r.listingId)?.sale
    expect(sale).toMatchObject({ state: 'held', disputed: false, amountUnits: 18_000_000n })
    expect(sale?.releaseAt).toBeGreaterThan(read.chainTime)
    // Found once, kept on the listing.
    expect((await s.seller.store.listings())[0]?.depositId).toBe(sale?.depositId)
    // Not due yet: nothing is sent.
    await expect(sell.collectPayout(s.deps, s.seller.wallet, r)).rejects.toThrow(/not due yet/)

    s.w.node.advance(86_400 + 60)
    const prompts = s.seller.auth.prompts
    const before = await s.seller.wallet.balance(s.seller.access.hosts)
    const [kept] = await s.seller.store.listings()
    await sell.collectPayout(s.deps, s.seller.wallet, kept ?? r)
    expect(s.seller.auth.prompts).toBe(prompts + 1)
    expect(await s.seller.wallet.balance(s.seller.access.hosts)).toBe(before + 18_000_000n)
    const after = await sell.listingStates(s.seller.access, s.seller.config, [kept ?? r], s.seller.store)
    expect(after.views.get(r.listingId)).toMatchObject({ state: 'sold', sale: { state: 'paid' } })
    // Collecting again is a no-op, not a second payout.
    await sell.collectPayout(s.deps, s.seller.wallet, kept ?? r)
    expect(s.seller.auth.prompts).toBe(prompts + 1)
  })

  it("a payout the token would not send waits in the escrow: the row never says it reached the account, and Claim collects it", async () => {
    const s = await setup()
    const r = await sell.listCard(s.deps, input())
    const shopper = await deviceFor(s.w, 'shopper')
    const deps = { store: shopper.store, api: shopper.api, config: shopper.config, access: shopper.access, wallet: shopper.wallet, sleep: async () => s.w.node.advance(1) }
    const ask = { merchant: 'salvotest' as const, spendCents: 2_000, depositor: shopper.wallet.account }
    await load.executeLoad(deps, await load.prepareLoad(deps, ask, await load.quoteLoad(deps, ask)))

    // The token refuses to send to this seller when the sale is paid out.
    const seller = s.seller.wallet.account
    expect((await s.w.node.chain.send(world.SHOPPER_2, PATH_USD, tokenCall.setBlocked(seller, 1))).ok).toBe(true)
    s.w.node.advance(86_400 + 60)
    const before = await s.seller.wallet.balance(s.seller.access.hosts)
    await sell.collectPayout(s.deps, s.seller.wallet, (await s.seller.store.listings())[0] ?? r)
    expect(await s.seller.wallet.balance(s.seller.access.hosts)).toBe(before)
    const owed = await sell.owedTo(s.seller.access, s.seller.config, seller)
    expect(owed).toBe(18_000_000n)
    const read = await sell.listingStates(s.seller.access, s.seller.config, await s.seller.store.listings())
    const view = read.views.get(r.listingId)
    expect(view?.sale?.state).toBe('paid')
    expect(saleLine(view, r, read.chainTime, owed).line).not.toMatch(/to your account/)
    expect(owedLine(owed)).toMatch(/Tap Claim/)

    // Unblocked, Claim sends it: one Face ID, and nothing is owed after.
    expect((await s.w.node.chain.send(world.SHOPPER_2, PATH_USD, tokenCall.setBlocked(seller, 0))).ok).toBe(true)
    const prompts = s.seller.auth.prompts
    await sell.collectOwed(s.deps, s.seller.wallet)
    expect(s.seller.auth.prompts).toBe(prompts + 1)
    expect(await s.seller.wallet.balance(s.seller.access.hosts)).toBe(before + 18_000_000n)
    expect(await sell.owedTo(s.seller.access, s.seller.config, seller)).toBe(0n)
    // Nothing owed: nothing is sent.
    await sell.collectOwed(s.deps, s.seller.wallet)
    expect(s.seller.auth.prompts).toBe(prompts + 1)
  })

  it('can take an unsold listing back', async () => {
    const s = await setup()
    const r = await sell.listCard(s.deps, input())
    await sell.cancelListing(s.deps, r)
    expect((await sell.listingStates(s.seller.access, s.seller.config, [r])).views.get(r.listingId)?.state).toBe('cancelled')
  })
})

/** Send every test dollar this seller holds elsewhere, straight on the EVM. */
async function drain(s: Setup): Promise<void> {
  const who = s.seller.wallet.account
  const balance = await tokenBalanceAt(s.seller.access.hosts, await agreedFinalizedBlock(s.seller.access.hosts), PATH_USD, who)
  const r = await s.w.node.chain.send(who, PATH_USD, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [world.SHOPPER_2, balance] }))
  if (!r.ok) throw new Error('drain reverted')
}

describe('the fee, with no sponsor', () => {
  it('a seller with no test dollars is told to get some first, before anything is sealed or sent, for a listing and for taking one back', async () => {
    const s = await setup()
    const r = await sell.listCard(s.deps, input())
    const txs = sentTxs(s)
    await drain(s)
    const sentBefore = s.seller.sent.length
    await expect(sell.listCard(s.deps, input({ cardNumber: '9999434343434343' }))).rejects.toThrow(
      'Listing pays a small network fee from your test dollars, and this account has none. Tap Get test dollars first. Nothing was sent.',
    )
    // Refused before sealing: nothing posted, nothing signed or sent, nothing kept.
    expect(s.seller.sent.length).toBe(sentBefore)
    expect(sentTxs(s)).toBe(txs)
    expect(await s.seller.store.listings()).toHaveLength(1)
    await expect(sell.cancelListing(s.deps, r)).rejects.toThrow(
      'Taking a card back pays a small network fee from your test dollars, and this account has none. Tap Get test dollars first. Nothing was sent.',
    )
    expect(sentTxs(s)).toBe(txs)
    expect((await sell.listingStates(s.seller.access, s.seller.config, [r])).views.get(r.listingId)?.state).toBe('listed')
  })

  it('a node that refuses the listing for its fee: it is not kept as a listing waiting for the chain', async () => {
    const s = await setup()
    const real = s.seller.wallet
    const refusing = {
      account: real.account,
      signCalls: real.signCalls.bind(real),
      broadcast: async () => {
        throw new EscrowRpcError('rpc.moderato.tempo.xyz', 'rpc', 'eth_sendRawTransaction: insufficient funds for gas * price + value')
      },
    }
    await expect(sell.listCard({ ...s.deps, wallet: refusing }, input())).rejects.toThrow(
      'Listing pays a small network fee from your test dollars, and this account has none. Tap Get test dollars first. Nothing was listed.',
    )
    expect(await s.seller.store.listings()).toHaveLength(0)
  })
})

describe('a listing that did not make it', () => {
  it('never reached the chain: the row says so and offers Remove, which takes it off this device; one on the chain stays', async () => {
    const s = await setup()
    const real = s.seller.wallet
    const offline = {
      account: real.account,
      signCalls: real.signCalls.bind(real),
      broadcast: async () => {
        throw new EscrowRpcError('rpc.moderato.tempo.xyz', 'network', 'eth_sendRawTransaction: could not reach the host')
      },
    }
    await expect(sell.listCard({ ...s.deps, wallet: offline }, input())).rejects.toThrow(/We could not confirm the listing went through/)
    const [stuck] = await s.seller.store.listings()
    if (stuck === undefined) throw new Error('the listing was not kept')
    const read = await sell.listingStates(s.seller.access, s.seller.config, [stuck])
    const view = read.views.get(stuck.listingId)
    expect(view?.state).toBe('not_on_chain')
    expect(saleLine(view, stuck, read.chainTime)).toMatchObject({ pill: 'Not on chain', canRemove: true, canResend: false })
    await sell.forgetListing(s.deps, stuck)
    expect(await s.seller.store.listings()).toHaveLength(0)

    const listed = await sell.listCard(s.deps, input({ cardNumber: '9999454545454545' }))
    await expect(sell.forgetListing(s.deps, listed)).rejects.toThrow('This listing is on the chain, so it stays here.')
    expect(await s.seller.store.listings()).toHaveLength(1)
  })

  it("Send to Salvo again says our server's words when trying again cannot help, and only says try again when it can", async () => {
    const s = await setup()
    const r = await sell.listCard(s.deps, input())
    // As if the last post never reached our server.
    const unposted = { ...r, posted: false }
    const read = await sell.listingStates(s.seller.access, s.seller.config, [unposted])
    expect(saleLine(read.views.get(r.listingId), unposted, read.chainTime).canResend).toBe(true)
    // An ended listing is never offered again.
    expect(saleLine(read.views.get(r.listingId), unposted, r.listingExpiry).canResend).toBe(false)
    // Taken off the test list: no minute of waiting fixes that, so the route's own sentence.
    setEnvVars({ ESCROW_SELLER_ALLOWLIST: world.SELLER })
    expect(await sell.recordListing(s.deps, unposted)).toBe('This seller address is not on the test list yet. Nothing was listed.')
    expect(unposted.posted).toBe(false)
    // Back on the list: recorded, and nothing to say.
    setEnvVars({ ESCROW_SELLER_ALLOWLIST: s.seller.wallet.account })
    expect(await sell.recordListing(s.deps, unposted)).toBeNull()
    expect(unposted.posted).toBe(true)
  })
})

describe('asked first, so a refusal sends nothing', () => {
  it("today's guard, asked about the operator on the testnet: the config says listing is open", async () => {
    const s = await setup({ guardAllows: false })
    expect(s.seller.config.listingOpen).toBe(true)
  })

  it('a custody refusal: the config says listing is closed, so nothing is sealed, posted or sent', async () => {
    const s = await setup({ guardRefuses: true })
    expect(s.seller.config.listingOpen).toBe(false)
    const sentBefore = s.seller.sent.length
    await expect(sell.listCard(s.deps, input())).rejects.toThrow(sell.LISTING_CLOSED_SENTENCE)
    // Not even the envelope went to our server: the refusal came before sealing.
    expect(s.seller.sent.length).toBe(sentBefore)
    expect(sentTxs(s)).toBe(0)
    expect(s.layer.landed).toHaveLength(0)
    expect(await s.seller.store.listings()).toHaveLength(0)
  })

  it('a seller off the test list is refused with nothing sent', async () => {
    const s = await setup({ allow: false })
    await expect(sell.listCard(s.deps, input())).rejects.toThrow(/not on the test list/)
    expect(sentTxs(s)).toBe(0)
  })

  it('a blind card over $25 from a new seller is refused before sealing', async () => {
    const s = await setup()
    await expect(sell.listCard(s.deps, input({ valueCents: 2_501, priceCents: 2_000 }))).rejects.toThrow(/up to \$25/)
    expect(sentTxs(s)).toBe(0)
    expect(s.w.litCalls).toHaveLength(0)
  })

  it('a number in the wrong shape, or a price over the value, is refused on the page', () => {
    expect(sell.sellInputProblems(input({ cardNumber: '1234' }))).toEqual(['That number is not the shape this store uses.'])
    expect(sell.sellInputProblems(input({ priceCents: 2_001 }))).toEqual(['A buyer cannot pay more than what is on the card.'])
    expect(sell.sellInputProblems(input())).toEqual([])
  })

  it('only a Salvo test card or a Target card can be listed on the test chain: another store number is refused before sealing', async () => {
    const otherStore = 'That is a store not tested at a till yet'
    for (const [merchant, cardNumber, pin] of [
      ['walmart', '6006491234567890', '1234'],
      ['bestbuy', '6123456789012345', '1234'],
      ['nike', '6060123456789012345', '123456'],
    ] as const) {
      expect([otherStore, merchant, sell.sellInputProblems(input({ merchant, cardNumber, pin }))]).toEqual([
        otherStore,
        merchant,
        ['On the test chain only a Salvo test card or a Target card can be listed.'],
      ])
    }
    // Target is the store being tested at a real till: a number in its shape has no problem.
    expect(sell.sellInputProblems(input({ merchant: 'target', cardNumber: '98765432109876543210123456', pin: null }))).toEqual([])
    expect(sell.ESCROW_SELL_STORES).toEqual(['salvotest', 'target'])
    const s = await setup()
    await expect(sell.listCard(s.deps, input({ merchant: 'walmart', cardNumber: '6006491234567890', pin: '1234' }))).rejects.toThrow(
      /only a Salvo test card or a Target card/,
    )
    expect(s.seller.sent).toHaveLength(0)
    expect(sentTxs(s)).toBe(0)
  })
})
