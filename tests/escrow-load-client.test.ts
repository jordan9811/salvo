/**
 * The Load on the shopper's phone (src/lib/escrow/client/load.ts), end to end
 * and offline: the real quote, ticket and release routes, the real pinned
 * template on fake Lit, the real escrow on the in-process EVM behind the two
 * fake hosts, Tempo's account layer checking every signature and scope
 * (tests/support/fake-tempo-wallet.ts), a fake Face ID and a fake IndexedDB.
 *
 * Pinned (spec sections 8.3, 8.5, 8.9, 8.11, 14):
 *   - one tap is ONE batch: approve(escrow, sum of prices) and one
 *     depositAndOpen per card, signed by the access key with no prompt;
 *   - the card is opened on the phone with its reply key; our routes and the
 *     chain only ever see ciphertext, and no request this phone sends holds
 *     a card number;
 *   - the device refuses a quote whose manifest disagrees with it, and a
 *     ticket naming another reply key, another buyer or another listing,
 *     before anything is signed;
 *   - a card sold a moment earlier reverts the whole batch: no card bought,
 *     and only the network fee charged when this phone paid it (nothing when
 *     a sponsor did), and the words say which;
 *   - the cards the tickets name are checked on chain: never two listings of
 *     one card, never one the contract would refuse;
 *   - a page that stopped while signing with no sponsor sent nothing, so
 *     Finish it ends the purchase at once instead of ten minutes later;
 *   - a new quote for the same cards keeps the tickets in hand;
 *   - over the weekly limit, the chain refuses it, and the purchase is kept
 *     until the chain shows no copy can land, then failed;
 *   - a host that took the batch and dropped the line, then the other host
 *     refusing the copy it already has: the purchase is found on chain and
 *     opened, never failed with its keys gone;
 *   - a fee sponsor that was sent the signed batch and did not answer: no
 *     second, self-paid batch; the sponsor's copy is found and opened;
 *   - Lit down after paying, or a page that died after signing: the purchase
 *     is kept and resumePurchase finishes it, never paying twice, and the
 *     words never say a card that did not come back is safe on the phone;
 *   - a purchase finished late is still this phone's: paid out to its seller
 *     it still opens, refunded in full it says so and ends, one card of two
 *     refunded leaves the other to open, and however many sales came after
 *     it, it is found;
 *   - a page that stops between storing a card and forgetting its key leaves
 *     nothing Finish it cannot complete, with no second release asked for.
 * Shares the test database, so it runs serially with the rest.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAbiItem, toFunctionSelector, type AbiFunction, type Hex } from 'viem'

const { prisma } = await import('@/lib/db')
const { __clearEscrowReservationsForTests } = await import('@/lib/escrow/quote')
const { __clearReleaseMemoryForTests } = await import('@/lib/escrow/lit-escrow')
const { __setEscrowRuntimeForTests } = await import('@/lib/escrow/runtime')
const { ESCROW_ABI } = await import('@/lib/escrow/artifact')
const { requestTicket } = await import('@/lib/escrow/lit-escrow')
const { parseEscrowManifest } = await import('@/lib/escrow/manifest')
const { depositAt, tokenBalanceAt } = await import('@/lib/escrow/runbook/reads')
const { agreedFinalizedBlock, EscrowRpcError, rpcCall } = await import('@/lib/escrow/runbook/rpc')
const load = await import('@/lib/escrow/client/load')
const { createBrowserReplyKey } = await import('@/lib/escrow/client/reply')
const world = await import('./support/escrow-server-world')
const { deviceFor } = await import('./support/escrow-phone')
const { fakeSponsor, installTempoWallet } = await import('./support/fake-tempo-wallet')
const { TEMPO_RPC_HOSTS } = await import('./support/fake-tempo-rpc')
const { PATH_USD } = await import('@/lib/escrow/manifest')
const { envelopeHashOf, termsOfManifest } = await import('@/lib/escrow/hashes')
const { escrowCall, signTicket, tokenCall } = await import('./support/escrow-chain')
const { FAKE_LIT_ROOT, fakeActionKey } = await import('./support/fake-lit')
const { privateKeyToAccount } = await import('viem/accounts')
const { resetDb } = await import('./helpers')

type ServerWorld = Awaited<ReturnType<typeof world.serverWorld>>
type LoadDeps = import('@/lib/escrow/client/load').LoadDeps
type DeviceWallet = import('@/lib/escrow/client/wallet').DeviceWallet
type EscrowPublicConfig = import('@/lib/escrow/client/api').EscrowPublicConfig
type Device = import('./support/escrow-phone').Device

const SAVED = {
  ESCROW_RAIL: process.env.ESCROW_RAIL,
  LIT_VAULT_USAGE_KEY: process.env.LIT_VAULT_USAGE_KEY,
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

interface Phone {
  w: ServerWorld
  deps: LoadDeps
  wallet: DeviceWallet
  config: EscrowPublicConfig
  auth: Device['auth']
  layer: ReturnType<typeof installTempoWallet>
  /** Every body this phone sent to our server. */
  sent: string[]
}

let testIndex = 0

async function phone(opts: { weeklyLimitUnits?: bigint } = {}): Promise<Phone> {
  const w = await world.serverWorld()
  testIndex += 1
  const clock = Number(w.node.chain.timestamp) * 1000 + testIndex * 180_000
  const rt = { ...w.rt, now: () => clock }
  __setEscrowRuntimeForTests(rt)
  const layer = installTempoWallet(w.node)
  const d = await deviceFor(w, 'shopper', opts)
  return {
    w: { ...w, rt },
    deps: { store: d.store, api: d.api, config: d.config, access: d.access, wallet: d.wallet, sleep: async () => w.node.advance(1) },
    wallet: d.wallet,
    config: d.config,
    auth: d.auth,
    layer,
    sent: d.sent,
  }
}

const ask = (p: Phone, spendCents: number) => ({ merchant: 'salvotest' as const, spendCents, depositor: p.wallet.account })

beforeEach(async () => {
  await resetDb()
  __clearEscrowReservationsForTests()
  __clearReleaseMemoryForTests()
  setEnvVars({
    ESCROW_RAIL: 'testnet',
    LIT_VAULT_USAGE_KEY: 'usage-key-for-tests',
    TEMPO_SPONSOR_URL: undefined,
    LIT_CHIPOTLE_ACCOUNT_KEY: undefined,
    LIT_CHIPOTLE_API_KEY: undefined,
  })
})

afterEach(() => {
  world.closeServerWorld()
})

afterAll(async () => {
  setEnvVars(SAVED)
  await resetDb()
  await prisma.$disconnect()
})

describe('one tap, one batch, the card on the phone', () => {
  it('buys a card, opens it here, and no request this phone sends holds the number', async () => {
    const p = await phone()
    const listed = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const balanceBefore = await p.wallet.balance(p.deps.access.hosts)

    const q = await load.quoteLoad(p.deps, ask(p, 2_000))
    const prepared = await load.prepareLoad(p.deps, ask(p, 2_000), q)
    expect(prepared.legs.map((l) => l.manifest.price)).toEqual([18_000_000])
    const prompts = p.auth.prompts
    const steps: string[] = []
    const cards = await load.executeLoad(p.deps, prepared, (s) => steps.push(s))

    expect(steps).toEqual(['checking', 'paying', 'confirming', 'opening', 'done'])
    expect(p.auth.prompts).toBe(prompts)
    expect(cards).toHaveLength(1)
    expect(await p.deps.store.cardSecret(cards[0]?.id ?? '')).toEqual({ cardNumber: listed.cardNumber, pin: null })
    // Kept with its mode, so /account knows nobody could check this card's balance.
    expect(cards[0]).toMatchObject({ merchant: 'salvotest', valueCents: 2_000, scanOrder: 1, ofCards: 1, last4: listed.cardNumber.slice(-4), mode: 2 })

    // One batch: approve the escrow for the price, then depositAndOpen.
    expect(p.layer.landed).toHaveLength(1)
    const batch = p.layer.landed[0]
    expect(batch).toMatchObject({ account: p.wallet.account, keyId: p.wallet.accessKeyAddress, carriedAuthorization: true, ok: true })
    expect(batch?.calls.map((c) => c.data.slice(0, 10))).toEqual([
      '0x095ea7b3',
      toFunctionSelector(getAbiItem({ abi: ESCROW_ABI, name: 'depositAndOpen' }) as AbiFunction),
    ])
    expect(batch?.calls[0]?.to).toBe(p.config.token)
    expect(batch?.calls[1]?.to).toBe(p.config.escrow)

    // The chain: the deposit is this phone's, and the price left its account.
    const block = await agreedFinalizedBlock(p.deps.access.hosts)
    const dep = await depositAt(p.deps.access.hosts, block, p.config.escrow, BigInt(cards[0]?.depositId ?? '0'))
    expect(dep).toMatchObject({ state: 1, depositor: p.wallet.account, listingId: listed.listingId })
    expect(await tokenBalanceAt(p.deps.access.hosts, block, p.config.token, p.wallet.account)).toBe(balanceBefore - 18_000_000n)

    // Finished: the reply key is gone, the purchase is done.
    const [purchase] = await p.deps.store.purchases()
    expect(purchase?.state).toBe('done')
    expect(await p.deps.store.replyKey(purchase?.legs[0]?.replyKeyId ?? '')).toBeNull()
    expect(await load.unfinishedPurchases(p.deps.store)).toHaveLength(0)

    // Ciphertext only: no body this phone sent to our server, and no request to either host, held the card.
    expect(p.sent.join('\n')).not.toMatch(CARD_RE)
    expect(p.w.node.requests.map((r) => r.bodyText).join('\n')).not.toMatch(CARD_RE)
  })

  it('two cards are two deposits in the same batch, whole card first, both opened', async () => {
    const p = await phone()
    await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    await world.listedCard(p.w, { valueCents: 1_000, priceUnits: 9_000_000, seller: world.SELLER_2 })
    const q = await load.quoteLoad(p.deps, ask(p, 2_700))
    expect(q.legs).toHaveLength(2)
    const cards = await load.executeLoad(p.deps, await load.prepareLoad(p.deps, ask(p, 2_700), q))
    expect(p.layer.landed).toHaveLength(1)
    expect(p.layer.landed[0]?.calls).toHaveLength(3)
    const byOrder = [...cards].sort((a, b) => a.scanOrder - b.scanOrder)
    expect(byOrder.map((c) => [c.scanOrder, c.ofCards])).toEqual([
      [1, 2],
      [2, 2],
    ])
    expect(byOrder.map((c) => c.valueCents).sort()).toEqual([1_000, 2_000])
    // Scan 1 of 2 is used up at the till; the leftover stays on Scan 2 of 2.
    expect(byOrder[0]?.valueCents ?? 0).toBeLessThan(2_700)
    expect(q.legs.map((l) => l.scanOrder)).toEqual([1, 2])
  })
})

describe('the phone checks before it pays', () => {
  it('refuses a quote whose card disagrees with its own manifest, before asking for any ticket', async () => {
    const p = await phone()
    await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const q = await load.quoteLoad(p.deps, ask(p, 2_000))
    const litBefore = p.w.litCalls.length
    const leg = q.legs[0]
    if (leg === undefined) throw new Error('no leg')
    for (const bad of [
      { ...q, legs: [{ ...leg, valueCents: 2_500 }], loadCents: 2_500 },
      { ...q, legs: [{ ...leg, priceUnits: 1_000 }], priceUnits: 1_000, priceCents: 1 },
      { ...q, legs: [{ ...leg, seller: world.SELLER_2 }] },
      { ...q, legs: [{ ...leg, listingId: `0x${'12'.repeat(32)}` as Hex }] },
      { ...q, merchant: 'target' as const },
    ]) {
      await expect(load.prepareLoad(p.deps, ask(p, 2_000), bad)).rejects.toMatchObject({ code: 'quote_mismatch' })
    }
    expect(p.w.litCalls.length).toBe(litBefore)
    expect(p.layer.landed).toHaveLength(0)
  })

  it('refuses a card that leaves too much over, or one card more than needed', () => {
    const cfg = { escrow: `0x${'e5'.repeat(20)}` as Hex } as EscrowPublicConfig
    const leg = { intentId: '', listingId: '0x' as Hex, manifest: '', envelope: { ct: '', eph: '', iv: '', tag: '' }, priceUnits: 1, valueCents: 2_000, scanOrder: 1, seller: '0x' as Hex, mode: 2 as const }
    const quote = { merchant: 'salvotest' as const, spendCents: 1_000, loadCents: 2_000, priceUnits: 2, priceCents: 1, savingCents: 0, leftoverCents: 1_000, legs: [leg], expiresAt: '' }
    const askFor = { merchant: 'salvotest' as const, spendCents: 1_000, depositor: '0x' as Hex }
    expect(load.legProblems(quote, askFor, cfg)).toContain('the cards leave more over than the store allows')
    const two = { ...quote, spendCents: 1_500, loadCents: 3_000, legs: [leg, { ...leg, scanOrder: 2, valueCents: 1_000 }] }
    expect(load.legProblems(two, { ...askFor, spendCents: 1_500 }, cfg)).toContain('the quote adds a card you do not need')
  })

  it('refuses a quote whose leftover or saving, shown under the button, is not what its cards say', () => {
    const cfg = { escrow: `0x${'e5'.repeat(20)}` as Hex } as EscrowPublicConfig
    const leg = { intentId: '', listingId: '0x' as Hex, manifest: '', envelope: { ct: '', eph: '', iv: '', tag: '' }, priceUnits: 1, valueCents: 2_000, scanOrder: 1, seller: '0x' as Hex, mode: 2 as const }
    const honest = { merchant: 'salvotest' as const, spendCents: 1_700, loadCents: 2_000, priceUnits: 17_600_000, priceCents: 1_760, savingCents: 240, leftoverCents: 300, legs: [leg], expiresAt: '' }
    const askFor = { merchant: 'salvotest' as const, spendCents: 1_700, depositor: '0x' as Hex }
    const leftover = 'the amount left on your card is not what the cards leave'
    const saving = 'the saving is not what the cards save'
    expect(load.legProblems(honest, askFor, cfg)).not.toContain(leftover)
    expect(load.legProblems(honest, askFor, cfg)).not.toContain(saving)
    // "$40.00 stays on your card" under the button, when $3.00 does; or a leftover hidden as 0.
    expect(load.legProblems({ ...honest, leftoverCents: 4_000 }, askFor, cfg)).toContain(leftover)
    expect(load.legProblems({ ...honest, leftoverCents: 0 }, askFor, cfg)).toContain(leftover)
    expect(load.legProblems({ ...honest, savingCents: 900 }, askFor, cfg)).toContain(saving)
  })

  it('refuses a ticket naming another reply key, another buyer or another listing, or not signed by the identity', async () => {
    const p = await phone()
    const listed = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const other = await world.listedCard(p.w, { valueCents: 1_000, priceUnits: 9_000_000 })
    const key = createBrowserReplyKey()
    const out = await requestTicket(
      { manifest: listed.manifestText, envelope: listed.envelope, listingId: listed.listingId, depositor: p.wallet.account, replyKeyHash: key.replyKeyHash },
      p.w.rt,
    )
    if (!out.ok) throw new Error(out.refusal)
    const block = await agreedFinalizedBlock(p.deps.access.hosts)
    const manifest = parseEscrowManifest(listed.manifestText, p.config.escrow)
    if (manifest === null) throw new Error('manifest')
    const expect_ = {
      listingId: listed.listingId,
      depositor: p.wallet.account,
      replyKeyHash: key.replyKeyHash,
      identity: p.config.identity,
      escrow: p.config.escrow,
      manifest,
      chainTime: Number(block.timestamp),
      maxTtlSeconds: p.config.limits.maxTicketTtlSeconds,
    }
    expect(await load.ticketProblems(out.ticket, expect_)).toEqual([])
    expect(await load.ticketProblems(out.ticket, { ...expect_, replyKeyHash: createBrowserReplyKey().replyKeyHash })).toContain(
      "the ticket names another phone's key",
    )
    expect(await load.ticketProblems(out.ticket, { ...expect_, depositor: world.SHOPPER_2 })).toContain('the ticket names another buyer')
    expect(await load.ticketProblems(out.ticket, { ...expect_, listingId: other.listingId })).toContain('the ticket is for another card')
    expect(await load.ticketProblems(out.ticket, { ...expect_, identity: world.SHOPPER })).toContain(
      'the ticket is not signed by the card service this page trusts',
    )
    expect(await load.ticketProblems(out.ticket, { ...expect_, chainTime: out.ticket.notAfter + 1 })).toContain(
      'the ticket is expired or too long-lived',
    )
    expect(await load.ticketProblems({ ...out.ticket, openBalanceCents: 5 }, expect_)).toContain('an unchecked card came with a balance')
  })
})

describe('the cards the tickets name', () => {
  it('never two listings of one card, and never one the contract would refuse: the phone reads who may sell each', async () => {
    const p = await phone()
    const cardNumber = world.testCardNumber()
    const a = await world.listedCard(p.w, { cardNumber, valueCents: 2_000, priceUnits: 18_000_000 })
    const b = await world.listedCard(p.w, { cardNumber, valueCents: 2_000, priceUnits: 18_000_000 })
    const other = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000, seller: world.SELLER_2 })
    const legOf = async (l: typeof a) => {
      const out = await requestTicket(
        { manifest: l.manifestText, envelope: l.envelope, listingId: l.listingId, depositor: p.wallet.account, replyKeyHash: createBrowserReplyKey().replyKeyHash },
        p.w.rt,
      )
      if (!out.ok) throw new Error(out.refusal)
      const manifest = parseEscrowManifest(l.manifestText, p.config.escrow)
      if (manifest === null) throw new Error('manifest')
      return { manifest, ticket: out.ticket }
    }
    const [la, lb, lo] = [await legOf(a), await legOf(b), await legOf(other)]
    // Lit signs both: the template never asks which card is behind a listing.
    expect(la.ticket.cardTag).toBe(lb.ticket.cardTag)
    expect(await load.cardProblems(p.deps.access, p.config, [la, lo])).toEqual([])
    expect(await load.cardProblems(p.deps.access, p.config, [la, lb])).toEqual(['two of the cards are the same card'])
    // Once one listing of the card sells, the other is no longer its seller's to sell.
    await world.buyCard(p.w, a, world.SHOPPER_2)
    expect(await load.cardProblems(p.deps.access, p.config, [lb])).toEqual(["a card is no longer its seller's to sell"])
    // A blind card over $25 from a seller nobody has paid that much yet.
    const big = await world.listedCard(p.w, { valueCents: 3_000, priceUnits: 27_000_000, seller: world.SELLER_2 })
    expect(await load.cardProblems(p.deps.access, p.config, [await legOf(big)])).toEqual(['a card is over what its seller may sell yet'])
  })

  it("a new quote for the same cards keeps the tickets in hand; other cards, or another account, do not", async () => {
    const p = await phone()
    await world.listedCard(p.w, { valueCents: 2_500, priceUnits: 22_000_000 })
    const q1 = await load.quoteLoad(p.deps, ask(p, 2_200))
    const prepared = await load.prepareLoad(p.deps, ask(p, 2_200), q1)
    const litAfter = p.w.litCalls.length
    // The shopper changes the amount: the same card is quoted again.
    const q2 = await load.quoteLoad(p.deps, ask(p, 2_300))
    expect(q2.legs.map((l) => l.intentId)).toEqual(q1.legs.map((l) => l.intentId))
    expect(load.preparedFor(prepared, q2, p.wallet.account)).toBe(true)
    // And the tap pays with those very tickets: no new Lit run.
    const cards = await load.executeLoad(p.deps, prepared)
    expect(cards).toHaveLength(1)
    expect(p.w.litCalls.length - litAfter).toBe(1)
    // Other cards, another account, or nothing prepared: no.
    const other = { ...q2, legs: q2.legs.map((l) => ({ ...l, intentId: `esc_${'1'.repeat(64)}` })) }
    expect(load.preparedFor(prepared, other, p.wallet.account)).toBe(false)
    expect(load.preparedFor(prepared, q2, world.SHOPPER_2)).toBe(false)
    expect(load.preparedFor(null, q2, p.wallet.account)).toBe(false)
    expect(load.preparedFor(prepared, null, p.wallet.account)).toBe(false)
  })
})

describe('nothing is charged when it does not go through', () => {
  it('a card sold a moment earlier undoes the whole batch: no card bought, and only the fee this phone paid', async () => {
    const p = await phone()
    const listed = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const q = await load.quoteLoad(p.deps, ask(p, 2_000))
    const prepared = await load.prepareLoad(p.deps, ask(p, 2_000), q)
    await world.buyCard(p.w, listed, world.SHOPPER_2)
    const before = await p.wallet.balance(p.deps.access.hosts)
    // The phone's own check of the old quote says so plainly, with no loop back to the same card.
    await expect(load.checkQuote(p.deps, ask(p, 2_000), q)).rejects.toThrow(/^That card just sold\. Try again for another\. Nothing was charged\.$/)

    const err = await load.executeLoad(p.deps, prepared).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'not_charged' })
    // No sponsor: the batch reached the chain, reverted, and paid its own fee. "Nothing was charged" would not be true.
    expect(p.layer.landed.map((b) => [b.ok, b.sponsored])).toEqual([[false, false]])
    expect((err as Error).message).toBe('A card sold a moment earlier, so no card was bought. Only the network fee, under a cent, was charged. Try again.')
    expect((err as Error).message).not.toMatch(/nothing was charged/i)
    expect(await p.wallet.balance(p.deps.access.hosts)).toBe(before)
    const [purchase] = await p.deps.store.purchases()
    expect(purchase?.state).toBe('failed')
    expect(await p.deps.store.replyKey(purchase?.legs[0]?.replyKeyId ?? '')).toBeNull()
    expect(await p.deps.store.cards()).toHaveLength(0)
  })

  it('with a sponsor that paid the fee, a batch that reverted charged nothing, and says so', async () => {
    const p = await phone()
    const listed = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const sponsor = fakeSponsor(`0x${'5c'.repeat(32)}`, PATH_USD)
    p.layer.sponsor = sponsor.address
    const deps = { ...p.deps, access: { ...p.deps.access, sponsorUrl: sponsor.url, sponsorFetch: sponsor.fetch } }
    const q = await load.quoteLoad(deps, ask(p, 2_000))
    const prepared = await load.prepareLoad(deps, ask(p, 2_000), q)
    await world.buyCard(p.w, listed, world.SHOPPER_2)
    const err = await load.executeLoad(deps, prepared).catch((e: unknown) => e)
    expect(p.layer.landed.map((b) => [b.ok, b.sponsored])).toEqual([[false, true]])
    expect(err).toMatchObject({ code: 'not_charged', message: 'A card sold a moment earlier, so nothing was charged. Try again.' })
  })

  it("over this week's allowance, the chain refuses it; the purchase is kept until no copy can land, then failed", async () => {
    const p = await phone({ weeklyLimitUnits: 10_000_000n })
    await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const q = await load.quoteLoad(p.deps, ask(p, 2_000))
    const prepared = await load.prepareLoad(p.deps, ask(p, 2_000), q)
    const err = await load.executeLoad(p.deps, prepared).catch((e: unknown) => e)
    // A host's refusal is not proof: kept, with its keys, and said plainly.
    expect(err).toBeInstanceOf(load.LoadPending)
    expect((err as Error).message).toMatch(/more than this week's allowance on this phone/)
    // Nothing checks again on its own, so the words say when to tap, and never that the phone will.
    expect((err as Error).message).toMatch(/Tap Finish it in about ten minutes to check again\. Until then this phone will not load another card\./)
    expect((err as Error).message).not.toMatch(/checks once more|a few minutes at most/)
    expect(p.layer.landed).toHaveLength(0)
    expect(p.layer.refused).toContain('spending limit exceeded')
    const [kept] = await load.unfinishedPurchases(p.deps.store)
    expect(kept?.state).toBe('signed')
    expect(await p.deps.store.replyKey(kept?.legs[0]?.replyKeyId ?? '')).not.toBeNull()

    // Past every ticket, no copy can land: now it is failed, and its keys go.
    p.w.node.advance(p.config.limits.maxTicketTtlSeconds + 120)
    await expect(load.resumePurchase(p.deps, kept?.id ?? '')).rejects.toMatchObject({ code: 'not_charged' })
    expect((await p.deps.store.purchase(kept?.id ?? ''))?.state).toBe('failed')
    expect(await p.deps.store.replyKey(kept?.legs[0]?.replyKeyId ?? '')).toBeNull()
    expect(p.layer.landed).toHaveLength(0)
  })
})

describe('a send that looked refused, and a sponsor that kept the batch', () => {
  it('host 0 takes the batch and drops the line, host 1 refuses the copy it already has: found on chain and opened, never failed', async () => {
    const p = await phone()
    const listed = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const real = p.deps.access.hosts.fetchImpl as typeof fetch
    let dropped = 0
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : ''
      if (String(input).startsWith(TEMPO_RPC_HOSTS[0]) && body.includes('"eth_sendRawTransaction"') && dropped === 0) {
        dropped += 1
        // The host takes the batch and runs it; only its answer is lost.
        await real(input, init)
        throw new DOMException('no answer in time', 'TimeoutError')
      }
      return real(input, init)
    }) as typeof fetch
    const deps = { ...p.deps, access: { ...p.deps.access, hosts: { ...p.deps.access.hosts, fetchImpl: flaky } } }
    const q = await load.quoteLoad(deps, ask(p, 2_000))
    const cards = await load.executeLoad(deps, await load.prepareLoad(deps, ask(p, 2_000), q))
    expect(dropped).toBe(1)
    // Host 1's answer is a refusal (its key is already on chain), not "already known".
    expect(p.layer.refused).toHaveLength(1)
    expect(p.layer.refused[0]).not.toMatch(/already known/)
    expect(p.layer.landed).toHaveLength(1)
    expect(await p.deps.store.cardSecret(cards[0]?.id ?? '')).toEqual({ cardNumber: listed.cardNumber, pin: null })
    const [purchase] = await p.deps.store.purchases()
    expect(purchase?.state).toBe('done')
  })

  it('a sponsor sent the signed batch that does not answer: no second batch is signed, and its copy is found and opened', async () => {
    const p = await phone()
    const listed = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const sponsor = fakeSponsor(`0x${'5b'.repeat(32)}`, PATH_USD)
    sponsor.behaviour = 'keep'
    p.layer.sponsor = sponsor.address
    const deps = { ...p.deps, access: { ...p.deps.access, sponsorUrl: sponsor.url, sponsorFetch: sponsor.fetch } }
    const q = await load.quoteLoad(deps, ask(p, 2_000))
    const err = await load.executeLoad(deps, await load.prepareLoad(deps, ask(p, 2_000), q)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(load.LoadPending)
    // Nothing self-paid went out: the only batch anywhere is the one the sponsor holds.
    expect(p.layer.landed).toHaveLength(0)
    expect(p.w.node.sent('eth_sendRawTransaction').length).toBe(p.w.setupTxs)
    const [kept] = await load.unfinishedPurchases(p.deps.store)
    expect(kept).toMatchObject({ state: 'signed', txHash: null })
    expect(await p.deps.store.replyKey(kept?.legs[0]?.replyKeyId ?? '')).not.toBeNull()
    // Still unsettled: the listing is for sale and the tickets are good.
    await expect(load.resumePurchase(deps, kept?.id ?? '')).rejects.toBeInstanceOf(load.LoadPending)

    // The sponsor sends the copy it kept. The phone finds it on chain and opens the card.
    await rpcCall(p.deps.access.hosts, 0, 'eth_sendRawTransaction', [sponsor.kept])
    const cards = await load.resumePurchase(deps, kept?.id ?? '')
    expect(p.layer.landed).toHaveLength(1)
    expect(p.layer.landed[0]?.sponsored).toBe(true)
    expect(await p.deps.store.cardSecret(cards[0]?.id ?? '')).toEqual({ cardNumber: listed.cardNumber, pin: null })
    expect((await p.deps.store.purchase(kept?.id ?? ''))?.state).toBe('done')
  })
})

describe('retries are safe', () => {
  it('Lit down after paying: the purchase is kept, and resume opens the card without paying again', async () => {
    const p = await phone()
    const listed = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const litFetch = p.w.rt.lit.fetchImpl as typeof fetch
    __setEscrowRuntimeForTests({
      ...p.w.rt,
      lit: {
        ...p.w.rt.lit,
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          if (typeof init?.body === 'string' && init.body.includes('"op":"release"')) throw new TypeError('fetch failed')
          return litFetch(input, init)
        }) as typeof fetch,
      },
    })
    const q = await load.quoteLoad(p.deps, ask(p, 2_000))
    const err = await load.executeLoad(p.deps, await load.prepareLoad(p.deps, ask(p, 2_000), q)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(load.LoadPending)
    // Never "safe on this phone": it is not here yet. And the clock: the seller is paid a day after the Load.
    const said = (err as Error).message
    expect(said).toMatch(/^Your payment went through, but your card has not reached this phone yet\. The card service did not answer\. Tap Finish it to try again\./)
    // No page offers a way to ask for a refund, so it is not sent looking for one. What is true: Finish it keeps working after the payout.
    expect(said).toMatch(/It still works after the seller is paid\. Refunds are not on these pages yet\.$/)
    expect(said).not.toMatch(/ask for a refund/i)
    expect(said).not.toMatch(/safe/)
    const [kept] = await load.unfinishedPurchases(p.deps.store)
    expect(kept?.state).toBe('paid')
    expect(kept?.problem).toBe(said)
    expect(await p.deps.store.replyKey(kept?.legs[0]?.replyKeyId ?? '')).not.toBeNull()

    __setEscrowRuntimeForTests(p.w.rt)
    const cards = await load.resumePurchase(p.deps, kept?.id ?? '')
    expect(await p.deps.store.cardSecret(cards[0]?.id ?? '')).toEqual({ cardNumber: listed.cardNumber, pin: null })
    // Resumed again: nothing new is sent, nothing is paid twice.
    await load.resumePurchase(p.deps, kept?.id ?? '')
    expect(p.layer.landed).toHaveLength(1)
    expect(await p.deps.store.cards()).toHaveLength(1)
  })

  it('a page that died after signing: resume sends the very same bytes, once', async () => {
    const p = await phone()
    const listed = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const real = p.wallet
    const dropped = {
      account: real.account,
      signCalls: real.signCalls.bind(real),
      broadcast: async () => {
        throw new EscrowRpcError('rpc.moderato.tempo.xyz', 'network', 'eth_sendRawTransaction: could not reach the host')
      },
    }
    const q = await load.quoteLoad(p.deps, ask(p, 2_000))
    const prepared = await load.prepareLoad(p.deps, ask(p, 2_000), q)
    await expect(load.executeLoad({ ...p.deps, wallet: dropped }, prepared)).rejects.toBeInstanceOf(load.LoadPending)
    expect(p.layer.landed).toHaveLength(0)
    const [kept] = await load.unfinishedPurchases(p.deps.store)
    expect(kept?.state).toBe('signed')
    expect(kept?.raw).toMatch(/^0x76/)

    const cards = await load.resumePurchase(p.deps, kept?.id ?? '')
    expect(p.layer.landed).toHaveLength(1)
    expect(p.layer.landed[0]?.hash).toBe(kept?.txHash)
    expect(await p.deps.store.cardSecret(cards[0]?.id ?? '')).toEqual({ cardNumber: listed.cardNumber, pin: null })
  })

  it('a page that stopped while signing, with no sponsor: nothing signed left the phone, so Finish it ends the purchase at once', async () => {
    const p = await phone()
    await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    let reached: () => void = () => {}
    const atSign = new Promise<void>((r) => {
      reached = r
    })
    const dying: BatchSigner = { account: p.wallet.account, signCalls: () => stopHere(reached), broadcast: p.wallet.broadcast.bind(p.wallet) }
    const q = await load.quoteLoad(p.deps, ask(p, 2_000))
    const prepared = await load.prepareLoad(p.deps, ask(p, 2_000), q)
    void load.executeLoad({ ...p.deps, wallet: dying }, prepared).catch(() => undefined)
    await atSign
    const [kept] = await load.unfinishedPurchases(p.deps.store)
    expect(kept).toMatchObject({ state: 'signed', txHash: null, sponsorSet: false })

    // Not a sponsor that may hold it, and not ten minutes of "may have gone through": over now.
    const err = await load.resumePurchase(p.deps, kept?.id ?? '').catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'not_charged', message: 'This phone stopped before the payment was signed, so nothing was sent or charged. Try again.' })
    expect((err as Error).message).not.toMatch(/sponsor/)
    expect((await p.deps.store.purchase(kept?.id ?? ''))?.state).toBe('failed')
    expect(await p.deps.store.replyKey(kept?.legs[0]?.replyKeyId ?? '')).toBeNull()
    // Nothing left unfinished, so /pay quotes again.
    expect(await load.unfinishedPurchases(p.deps.store)).toHaveLength(0)
    expect(p.layer.landed).toHaveLength(0)
  })

  it('a batch that never reached a host is called failed only once the chain is past every ticket', async () => {
    const p = await phone()
    await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const lost = { account: p.wallet.account, signCalls: p.wallet.signCalls.bind(p.wallet), broadcast: async () => undefined }
    const q = await load.quoteLoad(p.deps, ask(p, 2_000))
    const prepared = await load.prepareLoad(p.deps, ask(p, 2_000), q)
    const fast = { ...p.deps, wallet: lost, access: { ...p.deps.access, hosts: { ...p.deps.access.hosts, timeoutMs: 1_000 } } }
    // Still inside the tickets' window: kept, not failed.
    const shortWait = { ...fast, access: { ...fast.access, hosts: { ...fast.access.hosts, now: (() => { let t = 0; return () => (t += 30_000) })() } } }
    await expect(load.executeLoad(shortWait, prepared)).rejects.toBeInstanceOf(load.LoadPending)
    const [kept] = await load.unfinishedPurchases(p.deps.store)
    expect(kept?.state).toBe('signed')

    // Past every ticket: the batch can only revert now, so it is failed, nothing charged.
    p.w.node.advance(p.config.limits.maxTicketTtlSeconds + 120)
    await expect(load.resumePurchase({ ...shortWait, wallet: lost }, kept?.id ?? '')).rejects.toMatchObject({ code: 'not_charged' })
    expect((await p.deps.store.purchase(kept?.id ?? ''))?.state).toBe('failed')
    expect(p.layer.landed).toHaveLength(0)
  })
})

type CardStore = import('@/lib/escrow/client/card-store').CardStore
type BatchSigner = import('@/lib/escrow/client/load').BatchSigner

/** The phone's store with some methods replaced, the rest its own. */
function storeWith(s: CardStore, over: Partial<Record<'saveCard' | 'deleteReplyKey', (...args: never[]) => Promise<void>>>): CardStore {
  return new Proxy(s, {
    get(target, prop) {
      const o = (over as Record<PropertyKey, unknown>)[prop]
      if (o !== undefined) return o
      const v: unknown = Reflect.get(target, prop, target)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
}

/** How many releases this phone has asked our server for. */
const releasesAsked = (p: Phone): number => p.sent.filter((b) => b.includes('"replyKey"')).length

/** A step that never comes back: the page stopped there. Calls `reached` first. */
function stopHere(reached: () => void): Promise<never> {
  reached()
  return new Promise<never>(() => {})
}

/**
 * `n` purchases by another shopper, straight on the EVM: each a fresh listing
 * and a ticket signed with fake Lit's key for this template, so no Lit run.
 */
async function otherSales(w: ServerWorld, n: number): Promise<void> {
  const signer = privateKeyToAccount(fakeActionKey(FAKE_LIT_ROOT, w.template.cid) as Hex)
  const buyer = world.SHOPPER_2
  for (let i = 0; i < n; i++) {
    const l = await world.sealCard(w, { valueCents: 100, priceUnits: 900_000 })
    await world.listOnChain(w, l)
    const k = await signTicket(signer, 42431n, w.escrow, {
      listingId: l.listingId,
      depositor: buyer,
      replyKeyHash: createBrowserReplyKey().replyKeyHash,
      openBalanceCents: 0,
      cardTag: createBrowserReplyKey().replyKeyHash,
      notAfter: Number(w.node.chain.timestamp) + 300,
    })
    await w.node.chain.send(buyer, PATH_USD, tokenCall.mint(buyer, 900_000n))
    const b = await w.node.chain.batch(buyer, [
      { to: PATH_USD, data: tokenCall.approve(w.escrow, 900_000n) },
      { to: w.escrow, data: escrowCall.depositAndOpen(termsOfManifest(l.manifest), envelopeHashOf(l.envelope), k) },
    ])
    if (!b.ok) throw new Error('another sale reverted')
  }
}

/** A Load that landed while the phone lost the line right after sending it: kept as signed, its card not opened. */
async function landedButLost(p: Phone): Promise<{ purchaseId: string; listed: Awaited<ReturnType<typeof world.listedCard>> }> {
  const listed = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
  const real = p.deps.access.hosts.fetchImpl as typeof fetch
  let offline = false
  const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
    if (offline) throw new TypeError('fetch failed')
    return real(input, init)
  }) as typeof fetch
  const deps = { ...p.deps, access: { ...p.deps.access, hosts: { ...p.deps.access.hosts, fetchImpl: flaky } } }
  const lossy: BatchSigner = {
    account: p.wallet.account,
    signCalls: p.wallet.signCalls.bind(p.wallet),
    broadcast: async (signed, access) => {
      await p.wallet.broadcast(signed, access)
      offline = true
    },
  }
  const q = await load.quoteLoad(deps, ask(p, 2_000))
  const prepared = await load.prepareLoad(deps, ask(p, 2_000), q)
  await expect(load.executeLoad({ ...deps, wallet: lossy }, prepared)).rejects.toBeInstanceOf(load.LoadPending)
  expect(p.layer.landed).toHaveLength(1)
  const [kept] = await load.unfinishedPurchases(p.deps.store)
  expect(kept?.state).toBe('signed')
  return { purchaseId: kept?.id ?? '', listed }
}

describe("a purchase finished late is still this phone's", () => {
  it('paid out to its seller before the phone came back: the card still opens, and the purchase is done', async () => {
    const p = await phone()
    const { purchaseId, listed } = await landedButLost(p)
    // Two days on, anyone has paid the seller.
    p.w.node.advance(2 * 86_400)
    expect((await p.w.node.chain.send(world.SHOPPER_2, p.config.escrow, escrowCall.release(1n))).ok).toBe(true)
    const block = await agreedFinalizedBlock(p.deps.access.hosts)
    expect((await depositAt(p.deps.access.hosts, block, p.config.escrow, 1n)).state).toBe(2)

    const cards = await load.resumePurchase(p.deps, purchaseId)
    expect(await p.deps.store.cardSecret(cards[0]?.id ?? '')).toEqual({ cardNumber: listed.cardNumber, pin: null })
    expect((await p.deps.store.purchase(purchaseId))?.state).toBe('done')
    // Nothing left unfinished, so /pay quotes again.
    expect(await load.unfinishedPurchases(p.deps.store)).toHaveLength(0)
  })

  it('refunded in full before the phone came back: said plainly, its key goes, and nothing is left unfinished', async () => {
    const p = await phone()
    const { purchaseId } = await landedButLost(p)
    const before = await p.wallet.balance(p.deps.access.hosts)
    expect((await p.w.node.chain.send(world.SELLER, p.config.escrow, escrowCall.sellerRefund(1n, 18_000_000n))).ok).toBe(true)

    await expect(load.resumePurchase(p.deps, purchaseId)).rejects.toMatchObject({ code: 'refunded' })
    const kept = await p.deps.store.purchase(purchaseId)
    expect(kept?.state).toBe('failed')
    expect(kept?.problem).toBe('The seller refunded this purchase in full. The money is back in your account.')
    expect(await p.deps.store.replyKey(kept?.legs[0]?.replyKeyId ?? '')).toBeNull()
    expect(await load.unfinishedPurchases(p.deps.store)).toHaveLength(0)
    expect(await p.wallet.balance(p.deps.access.hosts)).toBe(before + 18_000_000n)
  })

  it('two cards, one refunded in full before the phone settles: the other still opens, and only the refunded one is let go', async () => {
    const p = await phone()
    const big = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const small = await world.listedCard(p.w, { valueCents: 1_000, priceUnits: 9_000_000, seller: world.SELLER_2 })
    const sponsor = fakeSponsor(`0x${'5d'.repeat(32)}`, PATH_USD)
    sponsor.behaviour = 'keep'
    p.layer.sponsor = sponsor.address
    const deps = { ...p.deps, access: { ...p.deps.access, sponsorUrl: sponsor.url, sponsorFetch: sponsor.fetch } }
    const q = await load.quoteLoad(deps, ask(p, 2_700))
    expect(q.legs).toHaveLength(2)
    await expect(load.executeLoad(deps, await load.prepareLoad(deps, ask(p, 2_700), q))).rejects.toBeInstanceOf(load.LoadPending)
    const [kept] = await load.unfinishedPurchases(p.deps.store)
    expect(kept).toMatchObject({ state: 'signed', txHash: null })

    // The sponsor sends the batch it kept. Then the $20 card's seller refunds that sale in full.
    await rpcCall(p.deps.access.hosts, 0, 'eth_sendRawTransaction', [sponsor.kept])
    const block = await agreedFinalizedBlock(p.deps.access.hosts)
    const bigId = (await depositAt(p.deps.access.hosts, block, p.config.escrow, 1n)).listingId === big.listingId ? 1n : 2n
    const before = await p.wallet.balance(p.deps.access.hosts)
    expect((await p.w.node.chain.send(world.SELLER, p.config.escrow, escrowCall.sellerRefund(bigId, 18_000_000n))).ok).toBe(true)

    const cards = await load.resumePurchase(deps, kept?.id ?? '')
    expect(cards).toHaveLength(1)
    expect(await p.deps.store.cardSecret(cards[0]?.id ?? '')).toEqual({ cardNumber: small.cardNumber, pin: null })
    const after = await p.deps.store.purchase(kept?.id ?? '')
    expect(after?.state).toBe('done')
    const bigLeg = after?.legs.find((l) => l.listingId === big.listingId)
    expect(bigLeg).toMatchObject({ refunded: true, released: false, depositId: bigId.toString() })
    expect(after?.legs.find((l) => l.listingId === small.listingId)).toMatchObject({ released: true })
    expect(await p.deps.store.replyKey(bigLeg?.replyKeyId ?? '')).toBeNull()
    expect(await p.wallet.balance(p.deps.access.hosts)).toBe(before + 18_000_000n)
  })

  it('found however many sales came after it: a batch the sponsor kept lands, seventy more sales follow, and the card opens', async () => {
    const p = await phone()
    const listed = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const sponsor = fakeSponsor(`0x${'5e'.repeat(32)}`, PATH_USD)
    sponsor.behaviour = 'keep'
    p.layer.sponsor = sponsor.address
    const deps = { ...p.deps, access: { ...p.deps.access, sponsorUrl: sponsor.url, sponsorFetch: sponsor.fetch } }
    const q = await load.quoteLoad(deps, ask(p, 2_000))
    await expect(load.executeLoad(deps, await load.prepareLoad(deps, ask(p, 2_000), q))).rejects.toBeInstanceOf(load.LoadPending)
    const [kept] = await load.unfinishedPurchases(p.deps.store)
    await rpcCall(p.deps.access.hosts, 0, 'eth_sendRawTransaction', [sponsor.kept])
    await otherSales(p.w, 70)

    const cards = await load.resumePurchase(deps, kept?.id ?? '')
    expect(cards[0]?.depositId).toBe('1')
    expect(await p.deps.store.cardSecret(cards[0]?.id ?? '')).toEqual({ cardNumber: listed.cardNumber, pin: null })
    expect((await p.deps.store.purchase(kept?.id ?? ''))?.state).toBe('done')
  }, 120_000)
})

describe('a page that stops while it opens a card', () => {
  it('right after the reply key went: the purchase already says the card is here, and Finish it asks Lit for nothing', async () => {
    const p = await phone()
    const listed = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const q = await load.quoteLoad(p.deps, ask(p, 2_000))
    const prepared = await load.prepareLoad(p.deps, ask(p, 2_000), q)
    let reached: () => void = () => {}
    const atDelete = new Promise<void>((r) => {
      reached = r
    })
    const dying = storeWith(p.deps.store, {
      deleteReplyKey: async (id: string) => {
        await p.deps.store.deleteReplyKey(id)
        return stopHere(reached)
      },
    })
    void load.executeLoad({ ...p.deps, store: dying }, prepared).catch(() => undefined)
    await atDelete

    // What the page left behind.
    const [left] = await p.deps.store.purchases()
    expect(left?.legs[0]?.released).toBe(true)
    const litBefore = p.w.litCalls.length
    const asked = releasesAsked(p)
    const cards = await load.resumePurchase(p.deps, left?.id ?? '')
    expect(await p.deps.store.cardSecret(cards[0]?.id ?? '')).toEqual({ cardNumber: listed.cardNumber, pin: null })
    // Not even our release route was asked: the card was here.
    expect(releasesAsked(p)).toBe(asked)
    expect(p.w.litCalls.length).toBe(litBefore)
    expect((await p.deps.store.purchase(left?.id ?? ''))?.state).toBe('done')
    expect(await load.unfinishedPurchases(p.deps.store)).toHaveLength(0)
  })

  it('right after the card was stored, before the purchase said so: Finish it finds the card here and asks Lit for nothing', async () => {
    const p = await phone()
    const listed = await world.listedCard(p.w, { valueCents: 2_000, priceUnits: 18_000_000 })
    const q = await load.quoteLoad(p.deps, ask(p, 2_000))
    const prepared = await load.prepareLoad(p.deps, ask(p, 2_000), q)
    let reached: () => void = () => {}
    const atSave = new Promise<void>((r) => {
      reached = r
    })
    const dying = storeWith(p.deps.store, {
      saveCard: async (...args: Parameters<CardStore['saveCard']>) => {
        await p.deps.store.saveCard(...args)
        return stopHere(reached)
      },
    })
    void load.executeLoad({ ...p.deps, store: dying }, prepared).catch(() => undefined)
    await atSave

    const [left] = await p.deps.store.purchases()
    expect(left?.legs[0]?.released).toBe(false)
    expect(await p.deps.store.replyKey(left?.legs[0]?.replyKeyId ?? '')).not.toBeNull()
    const litBefore = p.w.litCalls.length
    const asked = releasesAsked(p)
    const cards = await load.resumePurchase(p.deps, left?.id ?? '')
    expect(await p.deps.store.cardSecret(cards[0]?.id ?? '')).toEqual({ cardNumber: listed.cardNumber, pin: null })
    // Not even our release route was asked: the card was here.
    expect(releasesAsked(p)).toBe(asked)
    expect(p.w.litCalls.length).toBe(litBefore)
    expect(await p.deps.store.replyKey(left?.legs[0]?.replyKeyId ?? '')).toBeNull()
    expect((await p.deps.store.purchase(left?.id ?? ''))?.state).toBe('done')
  })
})
