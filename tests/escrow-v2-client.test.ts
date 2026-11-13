/**
 * The V2 client, end to end and offline (unified spec sections 5.3, 5.4, 7,
 * 8 and 11): the shopper's phone and the seller's page against the real
 * SalvoEscrowV2 on the in-process EVM behind the two fake hosts, the real
 * pinned salvo-vault-escrow/2 on fake Lit, Tempo's account layer checking
 * every signature and scope, a fake Face ID and a fake IndexedDB. Our
 * server's routes are stood in for (tests/support/escrow-till-world-v2.ts),
 * so no database is touched.
 *
 * Pinned:
 *   - one tap is ONE batch: approve(V2, exactly what the contract pulls) and
 *     one depositAndOpen per card with the cents used; the shopper pays the
 *     price only for the value used, and the cents left on the last card at
 *     face as the deposit; no prompt;
 *   - the next shopper is sent to the leftover first, uses it whole, at no
 *     haircut while a deposit covers it, and the first shopper's deposit
 *     stays held through the contest window;
 *   - the shopper's own leftover may be used in part, their deposit netted
 *     in the same transaction;
 *   - "that card was empty" refunds the reporter and pays the seller from
 *     the first shopper's deposit; the till sends every report on its own at
 *     the tap, so a declined plan, Start over or a report after Done (none of
 *     which the backend hears of) loses nothing;
 *   - a leftover bought whole is scanned before the shopper's own credit, and
 *     a leftover kept as credit still names its sale: "empty" about it inside
 *     its two hours is a contest, after them a dispute;
 *   - a new total while an earlier card is on screen closes the cards after
 *     it and plans what the cards up to it leave, as the till assumes when it
 *     shows that card as the last;
 *   - the phone refuses, before any ticket or batch, a quote priced other
 *     than the contract prices it, a leftover on any card but the last, a
 *     card used since the quote, and a leftover someone else's deposit
 *     covers used in part; and a ticket naming another key;
 *   - a new total on the same cards keeps the tickets;
 *   - the total down: reduceUse within the cap, "keep the rest" past it;
 *     the register said paid: keepRest, and the card is store credit;
 *   - store credit sells back on V2 once its purchase is paid out;
 *   - selling: the card is sealed in the browser, its fingerprint goes with
 *     it, a card our server knows was sold elsewhere is refused before
 *     anything is sent, and the listing can be taken back;
 *   - a page that dies after signing finishes later, never paying twice;
 *   - the dollars backend implements the till's interface: own credit
 *     first, codes one at a time, a lower total, a report on chain before
 *     its replacement is paid;
 *   - the V2 keys are scoped as spec section 8.4 says;
 *   - no body the phone or page sends, and no request to either host, holds
 *     a card number.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAbiItem, toFunctionSelector, type AbiFunction, type Hex } from 'viem'
import { ESCROW_ABI } from '@/lib/escrow/artifact'
import { ESCROW_V2_ABI } from '@/lib/escrow/artifact-v2'
import { cardFingerprint } from '@/lib/escrow/card-fingerprint'
import { EscrowApi } from '@/lib/escrow/client/api'
import { parseEscrowConfigV2, parseQuoteV2 } from '@/lib/escrow/client/api-v2'
import type { CardSecret, CardStore } from '@/lib/escrow/client/card-store'
import { creditFromCardV2, sellBackV2, tillCreditV2, type OwnCardBook, type OwnCardLike } from '@/lib/escrow/client/credit-v2'
import { DollarsBackendV2 } from '@/lib/escrow/client/dollars-backend'
import type { LegCode, Purchase, RoutePlan, TillBackend } from '@/lib/till/types'
import { LoadPending, LoadRefused } from '@/lib/escrow/client/load'
import {
  cardIdV2,
  discardPreparedV2,
  executeLoadV2,
  loadCallsV2,
  prepareLoadV2,
  pullOf,
  quoteTillV2,
  resumePurchaseV2,
  reusePreparedV2,
  unfinishedPurchasesV2,
  type LoadDepsV2,
  type TillAskV2,
} from '@/lib/escrow/client/load-v2'
import { isCardV2, notePendingReport } from '@/lib/escrow/client/records-v2'
import { KEEP_REST_SENTENCE, keepCardV2, reduceUseV2, reportActionV2, SaleRefused, sendReportV2, type SaleDepsV2 } from '@/lib/escrow/client/sale-v2'
import { SellRefused } from '@/lib/escrow/client/sell'
import { cancelListingV2, closeRemainderV2, listCardV2, listingStatesV2, type SellDepsV2 } from '@/lib/escrow/client/sell-v2'
import { keyScopedForV2, setUpDeviceWalletV2 } from '@/lib/escrow/client/wallet-v2'
import { EscrowRpcError } from '@/lib/escrow/runbook/rpc'
import { PATH_USD } from '@/lib/escrow/manifest'
import { quoteV2Of } from '@/lib/escrow/quote-v2'
import { depositV2At, listingV2At, V2_STATE } from '@/lib/escrow/runbook/reads-v2'
import { agreedFinalizedBlock } from '@/lib/escrow/runbook/rpc'
import { tokenBalanceAt } from '@/lib/escrow/runbook/reads'
import { ESCROW_V1_PINS } from '@/lib/vault/lit/escrow-pins'
import { escrowV2Call } from './support/escrow-v2-chain'
import { closeServerWorldV2, listV2, SELLER_V2, SHOPPER_C, testCardNumberV2, useCardV2 } from './support/escrow-server-world-v2'
import { loadDepsOf, phoneV2, tillWorldV2, type PhoneV2, type TillWorldV2 } from './support/escrow-till-world-v2'
import { testAddress } from './support/evm'

const RAIL = process.env.ESCROW_RAIL
const USAGE_KEY = process.env.LIT_VAULT_USAGE_KEY
const CARD_RE = /9999[0-9]{12}/
const DAY = 86_400
const PREF = { mode: 'most_savings', maxCards: 3 } as const
const APPROVE = '0x095ea7b3'
const DEPOSIT_AND_OPEN = toFunctionSelector(getAbiItem({ abi: ESCROW_V2_ABI, name: 'depositAndOpen' }) as AbiFunction)
const DISPUTE = toFunctionSelector(getAbiItem({ abi: ESCROW_V2_ABI, name: 'dispute' }) as AbiFunction)
const CONTEST = toFunctionSelector(getAbiItem({ abi: ESCROW_V2_ABI, name: 'contestRemainder' }) as AbiFunction)

beforeEach(() => {
  process.env.ESCROW_RAIL = 'testnet'
  process.env.LIT_VAULT_USAGE_KEY = 'usage-key-for-tests'
})

afterEach(() => {
  closeServerWorldV2()
  for (const [k, v] of [['ESCROW_RAIL', RAIL], ['LIT_VAULT_USAGE_KEY', USAGE_KEY]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/** secp256k1's order: s and n - s both recover, with v flipped. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** The same signature with s replaced by n - s and v flipped: viem recovers the same signer from it; the contract refuses it. */
function highSTwin(sig: Hex): Hex {
  const s = BigInt(`0x${sig.slice(66, 130)}`)
  const v = parseInt(sig.slice(130), 16)
  return `${sig.slice(0, 66)}${(SECP256K1_N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as Hex
}

const ask = (p: PhoneV2, totalCents: number): TillAskV2 => ({ merchant: 'salvotest', totalCents, depositor: p.wallet.account, preference: { ...PREF } })

async function balance(t: TillWorldV2, who: Hex): Promise<bigint> {
  return tokenBalanceAt(t.hosts, await agreedFinalizedBlock(t.hosts), PATH_USD, who)
}

async function chainNow(t: TillWorldV2) {
  return agreedFinalizedBlock(t.hosts)
}

/** A $20 salvotest card at 10% off, listed by SELLER_V2 and in our server's book. */
async function card(t: TillWorldV2, valueCents = 2_000, opts: { seller?: Hex } = {}) {
  const l = await listV2(t.w, { valueCents, price: valueCents * 9_000, residualCapCents: 500, ...(opts.seller ? { seller: opts.seller } : {}) })
  t.server.add(l)
  return l
}

/** Quote, prepare and pay at the till. */
async function buy(t: TillWorldV2, p: PhoneV2, totalCents: number) {
  const d = loadDepsOf(t, p)
  const q = await quoteTillV2(d, ask(p, totalCents))
  const prepared = await prepareLoadV2(d, ask(p, totalCents), q)
  const steps: string[] = []
  const record = await executeLoadV2(d, prepared, (s) => steps.push(s))
  return { q, record, steps }
}

const saleDeps = (p: PhoneV2): SaleDepsV2 => ({ store: p.store, book: p.book, config: p.config, access: p.access, wallet: p.wallet })

/** What the batch's approve allowed, decoded from the call the phone signed. */
function approvedOf(calls: ReadonlyArray<{ to: Hex; data: Hex }>): bigint {
  const a = calls.find((c) => c.data.startsWith(APPROVE))
  if (a === undefined) throw new Error('no approve in the batch')
  return decodeFunctionData({ abi: erc20Abi, data: a.data }).args[1] as bigint
}

/**
 * /account's store credit as the till's merge keeps it (card-store.ts's
 * `own:` slots), in memory: a typed card holds its own number; a kept card
 * points at the bought card in this phone's store, and a typed card cannot be
 * saved without its number, as there.
 */
class FakeOwnCards implements OwnCardBook {
  readonly cards = new Map<string, { meta: OwnCardLike; secret: CardSecret | null }>()
  readonly #store: CardStore

  constructor(store: CardStore) {
    this.#store = store
  }

  async ownCards(): Promise<OwnCardLike[]> {
    return [...this.cards.values()].map((c) => ({ ...c.meta })).sort((a, b) => b.addedAt - a.addedAt)
  }

  async ownCardSecret(id: string): Promise<CardSecret | null> {
    const c = this.cards.get(id)
    if (c === undefined) return null
    return c.meta.keptCardId === undefined ? c.secret : this.#store.cardSecret(c.meta.keptCardId)
  }

  async saveOwnCard(meta: OwnCardLike, secret: CardSecret | null): Promise<void> {
    if (secret === null && meta.keptCardId === undefined) throw new RangeError('a typed card needs its number')
    this.cards.set(meta.id, { meta: { ...meta }, secret })
  }
}

/** Pay through the till's interface, answered with a purchase (never a new price, never one already ended). */
async function payNow(backend: Pick<TillBackend, 'pay'>, plan: RoutePlan, after?: Purchase): Promise<Purchase> {
  const out = await backend.pay(plan, after === undefined ? {} : { after })
  if ('requote' in out || 'ended' in out) throw new Error(`Pay answered ${'requote' in out ? 'a new price' : 'an ended purchase'}: ${out.message}`)
  return out
}

function noCardAnywhere(t: TillWorldV2): void {
  expect(t.server.sent.join('\n')).not.toMatch(CARD_RE)
  expect(t.w.node.requests.map((r) => r.bodyText).join('\n')).not.toMatch(CARD_RE)
}

describe('one tap pays for only the value used', () => {
  it('one card in part: one batch, the price of the cents used, the rest left at face, the card on the phone', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    const l = await card(t)
    const before = await balance(t, shopper.wallet.account)
    const prompts = shopper.auth.prompts

    const { q, record, steps } = await buy(t, shopper, 1_600)
    expect(q.legs).toHaveLength(1)
    expect(q.legs[0]).toMatchObject({ usedCents: 1_600, leftCents: 400, amountUnits: 14_400_000, bondUnits: 4_000_000, source: 'fresh' })
    expect(q).toMatchObject({ priceCents: 1_440, depositCents: 400, savingCents: 160, uncoveredCents: 0 })
    expect(steps).toEqual(['checking', 'paying', 'confirming', 'opening', 'done'])
    expect(shopper.auth.prompts).toBe(prompts)
    expect(record.state).toBe('done')

    // One batch, by the access key, carrying its authorization: approve exactly what is pulled, then depositAndOpen.
    expect(t.layer.landed).toHaveLength(1)
    const batch = t.layer.landed[0]
    expect(batch).toMatchObject({ account: shopper.wallet.account, keyId: shopper.wallet.accessKeyAddress, carriedAuthorization: true, ok: true })
    expect(batch?.calls.map((c) => c.data.slice(0, 10))).toEqual([APPROVE, DEPOSIT_AND_OPEN])
    expect(approvedOf(batch?.calls ?? [])).toBe(18_400_000n)
    expect(decodeFunctionData({ abi: ESCROW_V2_ABI, data: batch?.calls[1]?.data ?? '0x' }).args[2]).toBe(1_600)

    // The chain: the price for 1,600 cents to the escrow, 400 cents at face as the deposit, and the card still listed for what is left.
    const block = await chainNow(t)
    const id = BigInt(record.legs[0]?.depositId ?? '0')
    expect(await depositV2At(t.hosts, block, t.w.escrow, id)).toMatchObject({
      state: V2_STATE.deposit.OPENED,
      depositor: shopper.wallet.account,
      amount: 14_400_000n,
      usedCents: 1_600,
      leftAfterCents: 400,
      bond: 4_000_000n,
      bondState: V2_STATE.bond.HELD,
    })
    expect(await listingV2At(t.hosts, block, t.w.escrow, l.listingId)).toMatchObject({ state: V2_STATE.listing.ACTIVE, remainingCents: 400, sales: 1, bondDeposit: id })
    expect(await balance(t, shopper.wallet.account)).toBe(before - 18_400_000n)

    // The card on the phone: what it covers, what stays on it, and the number only here.
    const cards = await shopper.store.cards()
    expect(cards).toHaveLength(1)
    const c = cards[0]
    expect(c?.id).toBe(cardIdV2(t.w.escrow, id.toString()))
    expect(c !== undefined && isCardV2(c)).toBe(true)
    expect(c).toMatchObject({ valueCents: 1_600, usedCents: 1_600, leftCents: 400, remainingCents: 2_000, last4: l.cardNumber.slice(-4), mode: 2 })
    expect(await shopper.store.cardSecret(c?.id ?? '')).toEqual({ cardNumber: l.cardNumber, pin: null })
    expect(await shopper.store.replyKey(record.legs[0]?.replyKeyId ?? '')).toBeNull()
    // Kept out of V1's sight: V1's pages finish only V1's purchases.
    expect(await shopper.store.purchases()).toEqual([])
    expect(await unfinishedPurchasesV2(shopper.book)).toEqual([])
    noCardAnywhere(t)
  })

  it('two cards: the first used up, the last in part, in one batch, in scan order', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    const a = await card(t, 1_000)
    const b = await card(t, 2_000)
    const { q, record } = await buy(t, shopper, 2_700)
    expect(q.legs.map((l) => [l.listingId, l.usedCents, l.leftCents])).toEqual([
      [a.listingId, 1_000, 0],
      [b.listingId, 1_700, 300],
    ])
    const batch = t.layer.landed[0]
    expect(batch?.calls.map((c) => c.data.slice(0, 10))).toEqual([APPROVE, DEPOSIT_AND_OPEN, DEPOSIT_AND_OPEN])
    expect(approvedOf(batch?.calls ?? [])).toBe(9_000_000n + 15_300_000n + 3_000_000n)
    const block = await chainNow(t)
    expect((await listingV2At(t.hosts, block, t.w.escrow, a.listingId)).state).toBe(V2_STATE.listing.DRAINED)
    expect((await listingV2At(t.hosts, block, t.w.escrow, b.listingId)).remainingCents).toBe(300)
    const cards = (await shopper.store.cards()).sort((x, y) => x.scanOrder - y.scanOrder)
    expect(cards.map((c) => [c.scanOrder, c.ofCards, c.valueCents])).toEqual([
      [1, 2, 1_000],
      [2, 2, 1_700],
    ])
    expect(record.legs.map((l) => l.released)).toEqual([true, true])
    noCardAnywhere(t)
  })
})

describe('the leftover goes to the next shopper first', () => {
  it("is used whole at no haircut, and the first shopper's deposit stays held through the contest window", async () => {
    const t = await tillWorldV2()
    const first = await phoneV2(t, 'shopper')
    const next = await phoneV2(t, 'shopper')
    const l = await card(t)
    const fresh = await card(t)
    const { record: firstBuy } = await buy(t, first, 1_600)
    const firstDeposit = BigInt(firstBuy.legs[0]?.depositId ?? '0')

    const { q, record } = await buy(t, next, 2_100)
    // The leftover first, used whole, priced at the seller's discount with no haircut (a deposit covers it).
    expect(q.legs.map((x) => [x.listingId, x.source, x.usedCents, x.leftCents])).toEqual([
      [l.listingId, 'remainder', 400, 0],
      [fresh.listingId, 'fresh', 1_700, 300],
    ])
    expect(q.legs[0]?.amountUnits).toBe(3_600_000)
    const block = await chainNow(t)
    const used = await depositV2At(t.hosts, block, t.w.escrow, BigInt(record.legs[0]?.depositId ?? '0'))
    expect(used).toMatchObject({ covers: firstDeposit, bond: 0n, usedCents: 400, leftAfterCents: 0 })
    expect(used.contestUntil).toBe(used.openedAt + 7_200)
    // The first shopper's deposit is still held: it comes back two hours after this use, by the keeper (not here).
    expect((await depositV2At(t.hosts, block, t.w.escrow, firstDeposit)).bondState).toBe(V2_STATE.bond.HELD)
    expect((await listingV2At(t.hosts, block, t.w.escrow, l.listingId)).state).toBe(V2_STATE.listing.DRAINED)
    expect((await next.store.cards()).find((c) => c.listingId === l.listingId)?.valueCents).toBe(400)
  })

  it("\"that card was empty\": the reporter's payment comes back and the first shopper's deposit pays the seller", async () => {
    const t = await tillWorldV2()
    const first = await phoneV2(t, 'shopper')
    const next = await phoneV2(t, 'shopper')
    const l = await card(t)
    await buy(t, first, 1_600)
    const { record } = await buy(t, next, 400)
    const sellerBefore = await balance(t, SELLER_V2)
    const nextBefore = await balance(t, next.wallet.account)

    const action = await reportActionV2(saleDeps(next), record.id, 1, 'empty')
    expect(action).toMatchObject({ kind: 'contest', reason: 'empty', scanOrder: 1 })
    await sendReportV2(saleDeps(next), action)

    const block = await chainNow(t)
    expect((await depositV2At(t.hosts, block, t.w.escrow, BigInt(action.depositId))).state).toBe(V2_STATE.deposit.CONTESTED)
    expect((await listingV2At(t.hosts, block, t.w.escrow, l.listingId)).state).toBe(V2_STATE.listing.SPENT)
    expect(await balance(t, next.wallet.account)).toBe(nextBefore + 3_600_000n)
    expect(await balance(t, SELLER_V2)).toBe(sellerBefore + 4_000_000n)
    expect((await next.book.purchase(record.id))?.legs[0]).toMatchObject({ refunded: true, reported: 'contest' })
    // Once only: the chain refuses a second report, and so does the phone, with words.
    await expect(reportActionV2(saleDeps(next), record.id, 1, 'empty')).rejects.toBeInstanceOf(SaleRefused)
  })

  it('your own leftover may be used in part, and your deposit comes back in the same transaction', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    const l = await card(t)
    const { record: firstBuy } = await buy(t, shopper, 1_600)
    const before = await balance(t, shopper.wallet.account)

    const { q, record } = await buy(t, shopper, 100)
    expect(q.legs[0]).toMatchObject({ listingId: l.listingId, source: 'remainder', usedCents: 100, leftCents: 300, amountUnits: 900_000, bondUnits: 3_000_000 })
    // 0.90 for the cents used and 3.00 deposit, less the 4.00 deposit back: 0.10 comes back, and nothing is pulled.
    const batch = t.layer.landed[1]
    expect(approvedOf(batch?.calls ?? [])).toBe(0n)
    expect(await balance(t, shopper.wallet.account)).toBe(before + 100_000n)
    const block = await chainNow(t)
    expect((await depositV2At(t.hosts, block, t.w.escrow, BigInt(firstBuy.legs[0]?.depositId ?? '0'))).bondState).toBe(V2_STATE.bond.RETURNED)
    expect(await depositV2At(t.hosts, block, t.w.escrow, BigInt(record.legs[0]?.depositId ?? '0'))).toMatchObject({ bond: 3_000_000n, leftAfterCents: 300 })
  })
})

describe('the phone pays for nothing it can check is wrong', () => {
  it('a quote priced other than the escrow charges, or leaving cents on a card before the last, is refused before any ticket', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    await card(t, 2_000)
    const d = loadDepsOf(t, shopper)

    t.server.tamperQuote = (q) => {
      const legs = q.legs.map((l, i) => (i === 0 ? { ...l, amountUnits: l.amountUnits - 10_000 } : l))
      return { ...q, legs, amountUnits: q.amountUnits - 10_000, priceCents: q.priceCents - 1, savingCents: q.savingCents + 1 }
    }
    const cheap = await quoteTillV2(d, ask(shopper, 2_700))
    const refused = await prepareLoadV2(d, ask(shopper, 2_700), cheap).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(LoadRefused)
    expect(refused).toMatchObject({ code: 'quote_mismatch' })
    expect((refused as Error).message).toContain("a card's price is not what the escrow charges for the cents used")

    t.server.tamperQuote = (q) => ({ ...q, legs: [...q.legs].reverse().map((l, i) => ({ ...l, scanOrder: i + 1 })) })
    const swapped = await quoteTillV2(d, ask(shopper, 2_700))
    const second = await prepareLoadV2(d, ask(shopper, 2_700), swapped).catch((e: unknown) => e)
    expect((second as Error).message).toContain('a card before the last is not used up')

    expect(t.server.calls.ticket).toBe(0)
    expect(t.layer.landed).toHaveLength(0)
  })

  it('a card used by another shopper since the quote, and a leftover someone else covers used in part, are refused for free', async () => {
    const t = await tillWorldV2()
    const first = await phoneV2(t, 'shopper')
    const late = await phoneV2(t, 'shopper')
    const l = await card(t)
    const d = loadDepsOf(t, late)
    const stale = await quoteTillV2(d, ask(late, 1_500))
    await buy(t, first, 1_600)
    const tickets = t.server.calls.ticket
    await expect(prepareLoadV2(d, ask(late, 1_500), stale)).rejects.toMatchObject({
      code: 'not_for_sale',
      message: 'Another shopper just used that card. Try again for another. Nothing was charged.',
    })

    // A planner that tried to sell part of the leftover the first shopper's deposit covers: the contract would refuse it.
    const block = await chainNow(t)
    const g = await listingV2At(t.hosts, block, t.w.escrow, l.listingId)
    const entry = [...t.server.book.values()][0]
    if (entry === undefined) throw new Error('no book entry')
    const partial = quoteV2Of({
      quoteId: 'bad',
      merchant: 'salvotest',
      totalCents: 300,
      escrow: t.w.escrow,
      depositor: late.wallet.account,
      legs: [{ intentId: entry.intentId, manifestText: entry.manifestText, envelope: entry.envelope, remainingCents: g.remainingCents, sales: g.sales, bondDeposit: g.bondDeposit, usedCents: 300 }],
      expiresAt: new Date().toISOString(),
    })
    const whole = await prepareLoadV2(d, ask(late, 300), partial).catch((e: unknown) => e)
    expect((whole as Error).message).toContain('another shopper holds the deposit on must be used whole')
    expect(t.server.calls.ticket).toBe(tickets)
  })

  it('a ticket Lit signed after another shopper used the card names the new state, and is refused before paying', async () => {
    const t = await tillWorldV2()
    const first = await phoneV2(t, 'shopper')
    const late = await phoneV2(t, 'shopper')
    await card(t)
    const d = loadDepsOf(t, late)
    const q = await quoteTillV2(d, ask(late, 1_500))
    t.server.beforeTicket = async () => {
      await buy(t, first, 1_600)
    }
    await expect(prepareLoadV2(d, ask(late, 1_500), q)).rejects.toMatchObject({
      code: 'not_for_sale',
      message: 'Another shopper just used that card. Get a new quote. Nothing was charged.',
    })
    expect(t.layer.landed).toHaveLength(1)
  })

  it('a ticket naming another phone key is refused before anything is signed', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    await card(t)
    const d = loadDepsOf(t, shopper)
    t.server.tamperTicket = (b) => ({ ...b, ticket: { ...(b.ticket as Record<string, unknown>), replyKeyHash: `0x${'ab'.repeat(32)}` } })
    const q = await quoteTillV2(d, ask(shopper, 1_600))
    const refused = await prepareLoadV2(d, ask(shopper, 1_600), q).catch((e: unknown) => e)
    expect(refused).toMatchObject({ code: 'ticket_bad' })
    expect((refused as Error).message).toContain("the ticket names another phone's key")
    expect(t.layer.landed).toHaveLength(0)
  })

  it("a ticket whose signature is the high-s twin of Lit's own is refused before anything is signed: the contract would revert it", async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    await card(t)
    const d = loadDepsOf(t, shopper)
    t.server.tamperTicket = (b) => {
      const k = b.ticket as Record<string, unknown>
      return { ...b, ticket: { ...k, signature: highSTwin(k.signature as Hex) } }
    }
    const q = await quoteTillV2(d, ask(shopper, 1_600))
    const refused = await prepareLoadV2(d, ask(shopper, 1_600), q).catch((e: unknown) => e)
    expect(refused).toMatchObject({ code: 'ticket_bad' })
    expect((refused as Error).message).toContain('the ticket signature is not one the contract takes')
    expect(t.layer.landed).toHaveLength(0)
  })

  it('a new total on the same cards keeps the tickets: no new Lit run', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    await card(t)
    const d = loadDepsOf(t, shopper)
    const first = await prepareLoadV2(d, ask(shopper, 1_500), await quoteTillV2(d, ask(shopper, 1_500)))
    const tickets = t.server.calls.ticket
    const q = await quoteTillV2(d, ask(shopper, 1_700))
    const reused = reusePreparedV2(first, q, ask(shopper, 1_700), t.w.escrow)
    expect(reused).not.toBeNull()
    expect(t.server.calls.ticket).toBe(tickets)
    expect(pullOf(reused ?? first)).toBe(15_300_000n + 3_000_000n)
    const record = await executeLoadV2(d, reused ?? first)
    expect(record.legs[0]).toMatchObject({ usedCents: 1_700, leftCents: 300 })
    // A total that needs other cards is not the same purchase.
    await card(t)
    const bigger = await quoteTillV2(d, ask(shopper, 2_100))
    expect(reusePreparedV2(first, bigger, ask(shopper, 2_100), t.w.escrow)).toBeNull()
  })
})

describe('after the till', () => {
  it('the total went down: reduceUse within the cap, and past it the words that offer keeping the rest', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    const l = await card(t)
    const { record } = await buy(t, shopper, 1_600)
    const before = await balance(t, shopper.wallet.account)
    const after = await reduceUseV2(saleDeps(shopper), record.id, 1_500)
    expect(after.legs[0]).toMatchObject({ usedCents: 1_500, leftCents: 500 })
    // 0.90 of price back, 1.00 more deposit: 0.10 pulled.
    expect(await balance(t, shopper.wallet.account)).toBe(before - 100_000n)
    const block = await chainNow(t)
    expect(await depositV2At(t.hosts, block, t.w.escrow, BigInt(record.legs[0]?.depositId ?? '0'))).toMatchObject({ usedCents: 1_500, bond: 5_000_000n, amount: 13_500_000n })
    expect((await listingV2At(t.hosts, block, t.w.escrow, l.listingId)).remainingCents).toBe(500)
    expect((await shopper.store.cards())[0]?.valueCents).toBe(1_500)
    const sent = t.layer.landed.length
    await expect(reduceUseV2(saleDeps(shopper), record.id, 1_400)).rejects.toThrow(KEEP_REST_SENTENCE)
    expect(t.layer.landed).toHaveLength(sent)
  })

  it('the register said paid: the rest is kept, the card is store credit, and it sells back on V2 once paid out', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    const l = await card(t)
    const { record } = await buy(t, shopper, 1_600)
    const before = await balance(t, shopper.wallet.account)
    const credit = await keepCardV2(saleDeps(shopper), record.id, 1, 0)
    expect(credit).toMatchObject({ balanceCents: 2_000, source: 'kept', merchant: 'salvotest' })
    // The rest at its price (3.60) out of the 4.00 deposit: 0.40 back.
    expect(await balance(t, shopper.wallet.account)).toBe(before + 400_000n)
    let block = await chainNow(t)
    expect((await listingV2At(t.hosts, block, t.w.escrow, l.listingId)).state).toBe(V2_STATE.listing.DRAINED)
    expect(await tillCreditV2(shopper.book, 'salvotest', null, shopper.wallet.account)).toHaveLength(1)

    // Selling it back: one more key, the seller's, on the same passkey account.
    const seller = await setUpDeviceWalletV2(shopper.store, 'seller', {
      escrow: t.w.escrow,
      now: Number(t.w.node.chain.timestamp),
      passkey: { rpId: 'localhost', createFn: shopper.auth.createFn, getFn: shopper.auth.getFn },
    })
    expect(seller.account).toBe(shopper.wallet.account)
    const deps = { store: shopper.store, book: shopper.book, api: shopper.api, config: shopper.config, access: shopper.access, wallet: seller }
    await expect(sellBackV2(deps, credit.id, { valueCents: 2_000, priceCents: 1_800 })).rejects.toThrow('once your purchase of it is final')
    t.w.node.advance(DAY + 1)
    const paid = await t.w.node.chain.send(testAddress(7), t.w.escrow, escrowV2Call.release(BigInt(record.legs[0]?.depositId ?? '0')))
    expect(paid.ok).toBe(true)
    await expect(sellBackV2(deps, credit.id, { valueCents: 2_100, priceCents: 1_800 })).rejects.toThrow('no more than what is left')
    const listed = await sellBackV2(deps, credit.id, { valueCents: 2_000, priceCents: 1_800 })
    block = await chainNow(t)
    expect((await listingV2At(t.hosts, block, t.w.escrow, listed.listingId)).state).toBe(V2_STATE.listing.ACTIVE)
    expect((await shopper.book.credit(credit.id))?.listedAs).toBe(listed.listingId)
    expect(await tillCreditV2(shopper.book, 'salvotest', null, shopper.wallet.account)).toHaveLength(0)
    expect(listed.cardFingerprint).toBe(await cardFingerprint(9, l.cardNumber))

    // Another shopper can buy it: the chain sells it as its new owner's.
    const other = await phoneV2(t, 'shopper')
    const { record: resold } = await buy(t, other, 2_000)
    expect(resold.legs[0]?.listingId).toBe(listed.listingId)
    expect(await other.store.cardSecret((await other.store.cards())[0]?.id ?? '')).toEqual({ cardNumber: l.cardNumber, pin: null })
  })

  it('a page that dies after signing finishes later, and never pays twice', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    const l = await card(t)
    const d: LoadDepsV2 = {
      ...loadDepsOf(t, shopper),
      wallet: {
        account: shopper.wallet.account,
        signCalls: (calls, access) => shopper.wallet.signCalls(calls, access),
        broadcast: async () => {
          throw new EscrowRpcError('rpc hosts', 'network', 'the page went away')
        },
      },
    }
    const q = await quoteTillV2(d, ask(shopper, 1_600))
    const prepared = await prepareLoadV2(d, ask(shopper, 1_600), q)
    const pending = await executeLoadV2(d, prepared).catch((e: unknown) => e)
    expect(pending).toBeInstanceOf(LoadPending)
    expect(t.layer.landed).toHaveLength(0)
    const [kept] = await unfinishedPurchasesV2(shopper.book)
    expect(kept?.state).toBe('signed')

    const done = await resumePurchaseV2(loadDepsOf(t, shopper), kept?.id ?? '')
    expect(done.state).toBe('done')
    expect(await resumePurchaseV2(loadDepsOf(t, shopper), kept?.id ?? '')).toMatchObject({ state: 'done' })
    expect(t.layer.landed).toHaveLength(1)
    const block = await chainNow(t)
    expect((await listingV2At(t.hosts, block, t.w.escrow, l.listingId)).sales).toBe(1)
    expect(await shopper.store.cardSecret((await shopper.store.cards())[0]?.id ?? '')).toEqual({ cardNumber: l.cardNumber, pin: null })
  })
})

describe('selling on V2', () => {
  it('seals in the browser, sends the fingerprint with the listing, records it, and takes it back', async () => {
    const t = await tillWorldV2()
    const seller = await phoneV2(t, 'seller')
    const deps: SellDepsV2 = { book: seller.book, api: seller.api, config: seller.config, access: seller.access, wallet: seller.wallet, sleep: async () => t.w.node.advance(1) }
    const number = testCardNumberV2()
    const steps: string[] = []
    const r = await listCardV2(deps, { merchant: 'salvotest', cardNumber: number, pin: null, valueCents: 2_000, priceCents: 1_800 }, (s) => steps.push(s))
    expect(steps).toEqual(['checking', 'sealing', 'listing', 'recording'])
    expect(r).toMatchObject({ version: 2, posted: true, valueCents: 2_000, priceUnits: 18_000_000, cardFingerprint: await cardFingerprint(9, number) })
    expect(JSON.parse(r.manifest)).toMatchObject({ v: 2, residualCapCents: 500, remainderHaircutBps: 2_500, mode: 2 })
    expect(await seller.book.listings()).toHaveLength(1)
    expect(await seller.store.listings()).toEqual([])
    const entry = t.server.book.get([...t.server.book.keys()][0] ?? '')
    expect(entry?.fingerprint).toBe(r.cardFingerprint)
    const { views } = await listingStatesV2(seller.access, seller.config, [r])
    expect(views.get(r.listingId)).toMatchObject({ state: 'listed', remainingCents: 2_000, sales: 0, covered: false, lastSale: null })

    await cancelListingV2(deps, r)
    expect((await listingStatesV2(seller.access, seller.config, [r])).views.get(r.listingId)?.state).toBe('cancelled')
    expect(t.server.sent.join('\n')).not.toContain(number)
    expect(t.w.node.requests.map((x) => x.bodyText).join('\n')).not.toContain(number)
  })

  it("the seller's review of an unsold leftover: from day five, \"It's gone\" pays the shopper's deposit to the seller (one Face ID)", async () => {
    const t = await tillWorldV2()
    const seller = await phoneV2(t, 'seller')
    const shopper = await phoneV2(t, 'shopper')
    const deps: SellDepsV2 = { book: seller.book, api: seller.api, config: seller.config, access: seller.access, wallet: seller.wallet, sleep: async () => t.w.node.advance(1) }
    const r = await listCardV2(deps, { merchant: 'salvotest', cardNumber: testCardNumberV2(), pin: null, valueCents: 2_000, priceCents: 1_800 })
    // The shopper uses 16.00 of it; 4.00 is left, with their deposit on it, and nobody uses it.
    const { record } = await buy(t, shopper, 1_600)
    const depositId = BigInt(record.legs[0]?.depositId ?? '0')
    const first = await listingStatesV2(seller.access, seller.config, [r])
    const view = first.views.get(r.listingId)
    expect(view).toMatchObject({ state: 'listed', remainingCents: 400, covered: true })
    const review = view?.review
    if (review === undefined || review === null) throw new Error('no review window')
    expect(review.until - review.from).toBe(2 * DAY)
    expect(first.chainTime).toBeLessThan(review.from)
    const closeDeps = { access: seller.access, config: seller.config, wallet: seller.wallet }
    await expect(closeRemainderV2(closeDeps, r, true)).rejects.toThrow('five days after its last sale')
    // Only the seller may answer.
    await expect(closeRemainderV2({ ...closeDeps, wallet: shopper.wallet }, r, true)).rejects.toThrow('not yours to answer for')

    t.w.node.advance(5 * DAY)
    const prompts = seller.auth.prompts
    const before = await balance(t, seller.wallet.account)
    await closeRemainderV2(closeDeps, r, true)
    expect(seller.auth.prompts).toBe(prompts + 1)
    const after = await listingStatesV2(seller.access, seller.config, [r])
    expect(after.views.get(r.listingId)).toMatchObject({ state: 'spent', covered: false, review: null })
    expect(await depositV2At(t.hosts, await chainNow(t), t.w.escrow, depositId)).toMatchObject({ bondState: V2_STATE.bond.FORFEITED, bond: 0n })
    // The deposit, 4.00 at face, less the network fee this account paid for the call.
    const gained = (await balance(t, seller.wallet.account)) - before
    expect(gained).toBeGreaterThan(3_900_000n)
    expect(gained).toBeLessThanOrEqual(4_000_000n)
    await expect(closeRemainderV2(closeDeps, r, false)).rejects.toThrow('nothing to answer')
  })

  it("the seller's review: \"Still there\" gives the shopper's deposit back and leaves the rest for sale; past day seven it cannot be claimed", async () => {
    const t = await tillWorldV2()
    const seller = await phoneV2(t, 'seller')
    const shopper = await phoneV2(t, 'shopper')
    const deps: SellDepsV2 = { book: seller.book, api: seller.api, config: seller.config, access: seller.access, wallet: seller.wallet, sleep: async () => t.w.node.advance(1) }
    const r = await listCardV2(deps, { merchant: 'salvotest', cardNumber: testCardNumberV2(), pin: null, valueCents: 2_000, priceCents: 1_800 })
    const { record } = await buy(t, shopper, 1_600)
    const depositId = BigInt(record.legs[0]?.depositId ?? '0')
    const closeDeps = { access: seller.access, config: seller.config, wallet: seller.wallet }
    t.w.node.advance(7 * DAY)
    // At seven days the deposit goes back by rule: "It's gone" is too late.
    await expect(closeRemainderV2(closeDeps, r, true)).rejects.toThrow('can no longer be claimed')
    const back = await balance(t, shopper.wallet.account)
    await closeRemainderV2(closeDeps, r, false)
    expect((await balance(t, shopper.wallet.account)) - back).toBe(4_000_000n)
    expect(await depositV2At(t.hosts, await chainNow(t), t.w.escrow, depositId)).toMatchObject({ bondState: V2_STATE.bond.RETURNED })
    expect((await listingStatesV2(seller.access, seller.config, [r])).views.get(r.listingId)).toMatchObject({ state: 'listed', remainingCents: 400, covered: false, review: null })
  })

  it('a card our server knows was sold to someone else, on V1 or V2, is refused before anything is sent', async () => {
    const t = await tillWorldV2()
    const seller = await phoneV2(t, 'seller')
    const deps: SellDepsV2 = { book: seller.book, api: seller.api, config: seller.config, access: seller.access, wallet: seller.wallet }
    const number = testCardNumberV2()
    t.server.otherRows.push({ fingerprint: await cardFingerprint(9, number), version: 1, state: 'completed', seller: testAddress(41), buyer: testAddress(42), chain: null, listedAt: 1 })
    const landed = t.layer.landed.length
    const refused = await listCardV2(deps, { merchant: 'salvotest', cardNumber: number, pin: null, valueCents: 1_000, priceCents: 900 }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(SellRefused)
    expect((refused as SellRefused).message).toContain('This card was sold through Salvo, so it cannot be listed again.')
    expect((refused as SellRefused).sentOnChain).toBe(false)
    expect(t.layer.landed).toHaveLength(landed)
    expect(await seller.book.listings()).toEqual([])

    // Listed twice on V2: the second is refused the same way.
    const twice = testCardNumberV2()
    await listCardV2(deps, { merchant: 'salvotest', cardNumber: twice, pin: null, valueCents: 1_000, priceCents: 900 })
    await expect(listCardV2(deps, { merchant: 'salvotest', cardNumber: twice, pin: null, valueCents: 1_000, priceCents: 900 })).rejects.toThrow('This card is already listed.')
  })

  it("V1's sell client sends the same fingerprint, so a card sold on V1 is found on V2", async () => {
    const bodies: string[] = []
    const api = new EscrowApi(async (_path, init) => {
      bodies.push(String(init?.body))
      return new Response('{}', { status: 200 })
    }, null)
    const fp = await cardFingerprint(9, '9999000011112222')
    await api.listing('{}', { ct: 'AA==', eph: `0x02${'1'.repeat(64)}`, iv: 'AAAAAAAAAAAAAAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA==' }, `0x${'1'.repeat(64)}`, fp)
    await api.listing('{}', { ct: 'AA==', eph: `0x02${'1'.repeat(64)}`, iv: 'AAAAAAAAAAAAAAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA==' }, `0x${'1'.repeat(64)}`)
    expect(JSON.parse(bodies[0] ?? '{}').cardFingerprint).toBe(fp)
    expect(Object.keys(JSON.parse(bodies[1] ?? '{}')).sort()).toEqual(['envelope', 'manifest', 'txHash'])
  })
})

describe('the V2 keys and config', () => {
  it("the shopper's key may approve only V2 and pay, report, reduce and keep through it; the seller's may only list and cancel", async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    const seller = await phoneV2(t, 'seller')
    expect(keyScopedForV2(shopper.wallet, t.w.escrow)).toBe(true)
    expect(keyScopedForV2(seller.wallet, t.w.escrow)).toBe(true)
    expect(keyScopedForV2(shopper.wallet, testAddress(99))).toBe(false)
    const v2 = (name: 'depositAndOpen' | 'dispute' | 'contestRemainder' | 'reduceUse' | 'keepRest' | 'list' | 'cancelListing') =>
      toFunctionSelector(getAbiItem({ abi: ESCROW_V2_ABI, name }) as AbiFunction)
    expect(shopper.wallet.restrictions.scopes.map((s) => s.selector)).toEqual([APPROVE, v2('depositAndOpen'), v2('dispute'), v2('contestRemainder'), v2('reduceUse'), v2('keepRest')])
    expect(shopper.wallet.restrictions.scopes[0]?.recipients).toEqual([t.w.escrow])
    expect(seller.wallet.restrictions.scopes.map((s) => s.selector)).toEqual([v2('list'), v2('cancelListing')])
    expect(seller.wallet.restrictions.limits).toEqual([])
    // Out of scope: the chain refuses, and nothing changes.
    for (const [w, call] of [
      [shopper.wallet, { to: t.w.escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'list', args: [`0x${'1'.repeat(64)}`] }) }],
      [shopper.wallet, { to: t.w.escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'rekey', args: [1n, `0x${'1'.repeat(64)}`] }) }],
      [seller.wallet, { to: PATH_USD, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [t.w.escrow, 1n] }) }],
    ] as const) {
      const signed = await w.signCalls([call], shopper.access)
      await expect(w.broadcast(signed, shopper.access)).rejects.toThrow('outside the access key scope')
    }
  })

  it("V1's no-money calls ride along while V1's sales settle: the seller's cancel and the shopper's dispute, nothing else", async () => {
    const t = await tillWorldV2()
    const p = await phoneV2(t, 'seller', { funded: false })
    const v1 = ESCROW_V1_PINS.escrowAddress as Hex
    const v1Selector = (name: 'cancelListing' | 'dispute') => toFunctionSelector(getAbiItem({ abi: ESCROW_ABI, name }) as AbiFunction)
    const now = Number(t.w.node.chain.timestamp)
    const passkey = { rpId: 'localhost', createFn: p.auth.createFn, getFn: p.auth.getFn }
    const seller = await setUpDeviceWalletV2(p.store, 'seller', { escrow: t.w.escrow, v1Escrow: v1, now, passkey })
    expect(seller.restrictions.scopes.filter((s) => s.address === v1)).toEqual([{ address: v1, selector: v1Selector('cancelListing') }])
    const shopper = await setUpDeviceWalletV2(p.store, 'shopper', { escrow: t.w.escrow, v1Escrow: v1, now, passkey })
    expect(shopper.restrictions.scopes.filter((s) => s.address === v1)).toEqual([{ address: v1, selector: v1Selector('dispute') }])
    // The approve names V2 alone as spender.
    expect(shopper.restrictions.scopes[0]?.recipients).toEqual([t.w.escrow])
  })

  it("the config is held to this page's V2 pins and the contract's own numbers", async () => {
    const t = await tillWorldV2()
    const res = await t.server.fetch('/api/escrow/config', { method: 'GET' })
    const body = (await res.json()) as Record<string, unknown>
    const ready = parseEscrowConfigV2(200, body, t.pins, null)
    expect(ready).toMatchObject({ state: 'ready', config: { escrow: t.w.escrow, identity: t.pins.identity, v1Frozen: true, listingOpen: true } })
    expect(parseEscrowConfigV2(200, body, { ...t.pins, encPub: `0x02${'5'.repeat(64)}` }, null)).toEqual({ state: 'error' })
    expect(parseEscrowConfigV2(200, body, null, null)).toEqual({ state: 'not_ready' })
    expect(parseEscrowConfigV2(200, { ...body, v2: null }, t.pins, null)).toEqual({ state: 'not_ready' })
    const v2 = body.v2 as Record<string, unknown>
    const longer = { ...body, v2: { ...v2, limits: { ...(v2.limits as Record<string, unknown>), contestWindowSeconds: 86_400 } } }
    expect(parseEscrowConfigV2(200, longer, t.pins, null)).toEqual({ state: 'error' })
    expect(parseEscrowConfigV2(503, { error: 'escrow_rail_off' }, t.pins, null)).toEqual({ state: 'off' })
    expect(parseQuoteV2({ version: 1 })).toBeNull()
  })
})

describe('the dollars backend, as the till drives it', () => {
  it('own credit first, then V2 cards; codes one at a time; a lower total; a report on chain before its replacement is paid', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    // A card the shopper used up and never scanned is theirs: 5.00 of it is their credit.
    const own = await card(t, 500)
    const { record: ownBuy } = await buy(t, shopper, 500)
    const credit = await keepCardV2(saleDeps(shopper), ownBuy.id, 1, 0)
    expect(credit.balanceCents).toBe(500)
    const fresh = await card(t, 1_200)

    const backend = new DollarsBackendV2({ store: shopper.store, book: shopper.book, api: shopper.api, config: shopper.config, access: shopper.access, wallet: shopper.wallet })
    const method = await backend.method()
    expect(method).toMatchObject({ ready: true, problem: null })
    expect(method.spendableCents).toBeGreaterThan(0)

    const plan = (await backend.quote({ merchant: 'salvotest', totalCents: 1_500, preference: { ...PREF } })) as RoutePlan
    expect('unavailable' in plan).toBe(false)
    expect(plan.legs.map((l) => [l.source, l.appliedCents, l.costCents, l.leftoverCents, l.depositCents, l.scanIndex, l.scanOf])).toEqual([
      ['own_credit', 500, 0, 0, 0, 1, 2],
      ['fresh', 1_000, 900, 200, 200, 2, 2],
    ])
    expect(plan).toMatchObject({ rail: 'stablecoin', totalCents: 1_500, costCents: 900, depositCents: 200, uncoveredCents: 0, savingCents: 100 })
    await backend.prepare(plan)
    const tickets = t.server.calls.ticket
    await backend.prepare(plan)
    expect(t.server.calls.ticket).toBe(tickets)

    const purchase = await payNow(backend, plan)
    // The till's LegCode: the store's barcode payload (a test card's is its number), never the card itself.
    expect(purchase.code).toEqual({
      scanIndex: 1,
      scanOf: 2,
      coversCents: 500,
      leftoverCents: 0,
      depositCents: 0,
      barcode: own.cardNumber,
      pdf417: null,
      expiresAt: expect.any(String),
      silenceIsSale: true,
    })
    expect(Object.keys(purchase.code)).not.toContain('card')
    expect(purchase).toMatchObject({ rail: 'stablecoin', ref: expect.any(String), plan })
    // Card 1 scanned: card 2, drawn only now.
    const second = await backend.next(purchase, 1)
    expect(second).toMatchObject({ scanIndex: 2, coversCents: 1_000, leftoverCents: 200, depositCents: 200, barcode: fresh.cardNumber, silenceIsSale: true })
    await expect(backend.next(purchase, 2)).rejects.toMatchObject({ message: 'That was the last card. Tap Done.' })
    expect((await shopper.book.credit(credit.id))?.balanceCents).toBe(0)

    // The total went down by a dollar: the last card uses less and keeps it for the next shopper; nothing is owed.
    const lower = await backend.changeTotal(purchase, 1_400)
    expect(lower.owed).toBeNull()
    expect(lower.purchase.ref).toBe(purchase.ref)
    expect(lower.purchase.plan.legs[1]).toMatchObject({ appliedCents: 900, leftoverCents: 300 })
    const applied = lower.purchase
    expect(await backend.changeTotal(applied, 600)).toEqual({
      purchase: { ...applied, plan: { ...applied.plan, totalCents: 600 } },
      owed: null,
      cover: { scanIndex: 2, coversCents: 900, leftoverCents: 300, depositCents: 300 },
      tooLow: true,
      notNeeded: false,
    })
    // A total typed wrong: typed again, the card covers what it did, and nothing is owed.
    expect(await backend.changeTotal(applied, 1_400)).toMatchObject({ owed: null, tooLow: false, purchase: { plan: { totalCents: 1_400 } } })

    // "It didn't scan" on the second card: the dispute goes at once, on its own, and what card 1 did not cover is owed.
    const another = await card(t, 1_000)
    const landed = t.layer.landed.length
    const { owed, receipt } = await backend.report(applied, 2, 'didnt_scan')
    // The card that did not scan is paid, and its seller's to refund: never counted as covered or saved.
    expect(receipt).toEqual({ paidCents: 0, savedCents: 0, depositCents: 300, keptCents: 0, disputedCents: 810 })
    expect(t.layer.landed).toHaveLength(landed + 1)
    expect(t.layer.landed.at(-1)?.calls.map((c) => c.data.slice(0, 10))).toEqual([DISPUTE])
    const block = await chainNow(t)
    const disputed = await depositV2At(t.hosts, block, t.w.escrow, BigInt((await shopper.book.purchase(purchase.ref))?.legs[0]?.depositId ?? '0'))
    expect(disputed.disputed).toBe(true)
    const reported = await shopper.book.purchase(purchase.ref)
    expect(reported?.legs[0]?.reported).toBe('dispute')
    // On chain already: no longer pending, whatever the till does with the plan.
    expect(reported?.pendingReports).toEqual([])
    const replacement = owed as RoutePlan
    expect(replacement.legs.map((l) => [l.ref.startsWith('esc_'), l.appliedCents])).toEqual([[true, 900]])
    const repaid = await payNow(backend, replacement, applied)
    expect(repaid.code.barcode).toBe(another.cardNumber)
    // The replacement's batch carries no report: the chain has it.
    expect(t.layer.landed).toHaveLength(landed + 2)
    expect(t.layer.landed.at(-1)?.calls.map((c) => c.data.slice(0, 10))).toEqual([APPROVE, DEPOSIT_AND_OPEN])
    noCardAnywhere(t)
  })

  it('a phone with no V2 key says so, and is still shown the price, holding nothing', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    const backend = new DollarsBackendV2({ store: shopper.store, book: shopper.book, api: shopper.api, config: shopper.config, access: shopper.access, wallet: null })
    const notSetUp = 'Allow this phone to pay with dollars in Account: one Face ID.'
    expect(await backend.method()).toMatchObject({ ready: false, problem: notSetUp, checked: true })
    await card(t)
    // The price anyone may see (2178740): a preview under nobody's address, with no ticket asked for.
    const plan = (await backend.quote({ merchant: 'salvotest', totalCents: 1_600, preference: { ...PREF } })) as RoutePlan
    expect(plan.legs).toHaveLength(1)
    expect(plan.legs[0]).toMatchObject({ appliedCents: 1_600 })
    expect(t.server.calls.quote).toBe(1)
    expect(t.server.calls.ticket).toBe(0)
    // What no card at the store could cover is said in the server's words, not as "set up dollars".
    expect(await backend.quote({ merchant: 'salvotest', totalCents: 1_000, preference: { ...PREF } })).toMatchObject({ unavailable: expect.not.stringContaining('Face ID') })
  })

  it('a V1 card counts as credit at the balance the shopper gives, and the plan uses it first', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    const number = testCardNumberV2()
    const v1 = ESCROW_V1_PINS.escrowAddress as Hex
    await shopper.store.saveCard(
      { id: `${v1}:7`, escrow: v1, depositId: '7', listingId: `0x${'7'.repeat(64)}`, merchant: 'salvotest', valueCents: 2_500, priceUnits: 22_500_000, scanOrder: 1, ofCards: 1, last4: number.slice(-4), boughtAt: 1, mode: 2 },
      { cardNumber: number, pin: null },
    )
    const v1Card = (await shopper.store.cards())[0]
    if (v1Card === undefined) throw new Error('no card')
    await expect(creditFromCardV2(shopper.book, v1Card, 2_600, shopper.wallet.account)).rejects.toThrow('a balance between one cent and the card value')
    await creditFromCardV2(shopper.book, v1Card, 700, shopper.wallet.account)
    const backend = new DollarsBackendV2({ store: shopper.store, book: shopper.book, api: shopper.api, config: shopper.config, access: shopper.access, wallet: shopper.wallet })
    const plan = (await backend.quote({ merchant: 'salvotest', totalCents: 600, preference: { ...PREF } })) as RoutePlan
    expect(plan.legs).toHaveLength(1)
    expect(plan.legs[0]).toMatchObject({ source: 'own_credit', appliedCents: 600, leftoverCents: 100, costCents: 0 })
    expect(t.server.calls.quote).toBe(0)
    const paid = await payNow(backend, plan)
    expect(paid.code.barcode).toBe(number)
    expect((await tillCreditV2(shopper.book, 'salvotest', null, shopper.wallet.account))[0]?.balanceCents).toBe(100)
    // The register took 4.50, not 6.00: the 1.50 goes back on the credit, and nothing is sent.
    const lower = await backend.changeTotal(paid, 450)
    expect(lower.owed).toBeNull()
    expect(lower.purchase.plan.legs[0]).toMatchObject({ appliedCents: 450, leftoverCents: 250 })
    expect((await tillCreditV2(shopper.book, 'salvotest', null, shopper.wallet.account))[0]?.balanceCents).toBe(250)
    expect(t.layer.landed).toHaveLength(0)
    // A plan whose credit is gone by the time it is paid is refused before anything is paid.
    const again = (await backend.quote({ merchant: 'salvotest', totalCents: 200, preference: { ...PREF } })) as RoutePlan
    await creditFromCardV2(shopper.book, v1Card, 100, shopper.wallet.account)
    await expect(payNow(backend, again)).rejects.toMatchObject({ code: 'quote_mismatch' })
  })
})

describe('a report is sent at the tap, whatever the till does next', () => {
  /** A $20 card the first shopper used 16.00 of: its 4.00 leftover, covered by their deposit, is the next shopper's first card. */
  async function leftover(t: TillWorldV2) {
    const first = await phoneV2(t, 'shopper')
    await card(t)
    const { record } = await buy(t, first, 1_600)
    const next = await phoneV2(t, 'shopper')
    const backend = new DollarsBackendV2({ store: next.store, book: next.book, api: next.api, config: next.config, access: next.access, wallet: next.wallet })
    const plan = (await backend.quote({ merchant: 'salvotest', totalCents: 400, preference: { ...PREF } })) as RoutePlan
    expect(plan.legs).toMatchObject([{ source: 'remainder', firstInLine: true, appliedCents: 400, leftoverCents: 0 }])
    const p = await payNow(backend, plan)
    return { firstDeposit: BigInt(record.legs[0]?.depositId ?? '0'), next, backend, p }
  }

  it('"that card was empty" on the card on screen is on chain before report returns: a plan the shopper declines (the till calls nothing) loses nothing, and paid later it carries nothing', async () => {
    const t = await tillWorldV2()
    const { firstDeposit, next, backend, p } = await leftover(t)
    await card(t, 500)
    const landed = t.layer.landed.length
    const { owed } = await backend.report(p, 1, 'empty')
    expect(owed).toMatchObject({ legs: [{ source: 'fresh', appliedCents: 400 }] })
    // Sent on its own at the tap: the till may Start over now, and never tell this backend.
    expect(t.layer.landed.slice(landed).map((b) => b.calls.map((c) => c.data.slice(0, 10)))).toEqual([[CONTEST]])
    const kept = await next.book.purchase(p.ref)
    expect(kept?.pendingReports).toEqual([])
    expect(kept?.legs[0]).toMatchObject({ refunded: true, reported: 'contest' })
    const at = await chainNow(t)
    expect(await depositV2At(t.hosts, at, t.w.escrow, BigInt(kept?.legs[0]?.depositId ?? '0'))).toMatchObject({ state: V2_STATE.deposit.CONTESTED, amount: 0n })
    // Decision 1: the first shopper's deposit, at face, paid the seller.
    expect(await depositV2At(t.hosts, at, t.w.escrow, firstDeposit)).toMatchObject({ bondState: V2_STATE.bond.FORFEITED })
    expect(await backend.sendPendingReports(p)).toEqual({ sent: 0, landed: 0, waiting: 0, dropped: 0 })
    expect(await backend.unfinished()).toEqual([])

    // The plan paid after all: its batch carries no report, so it lands.
    const repaid = await payNow(backend, owed as RoutePlan, p)
    expect(repaid.code.coversCents).toBe(400)
    expect(t.layer.landed.at(-1)?.calls.map((c) => c.data.slice(0, 10))).toEqual([APPROVE, DEPOSIT_AND_OPEN])
  })

  it('after Done, "that card was empty" is sent at once and nothing more is owed: the till keeps only the receipt', async () => {
    const t = await tillWorldV2()
    const { firstDeposit, next, backend, p } = await leftover(t)
    // Another card is for sale, so a plan could be made: none is, since the register took this one.
    await card(t, 500)
    expect(await backend.done(p, 1)).toEqual({ paidCents: 360, savedCents: 40, depositCents: 0, keptCents: 0 })
    const quotes = t.server.calls.quote
    const sellerBefore = await balance(t, SELLER_V2)
    const nextBefore = await balance(t, next.wallet.account)
    // The till's reportEmpty: it keeps the receipt and drops whatever is owed.
    const { owed, receipt } = await backend.report(p, 1, 'empty')
    expect(owed).toBeNull()
    expect(t.server.calls.quote).toBe(quotes)
    expect(receipt).toEqual({ paidCents: 0, savedCents: 0, depositCents: 0, keptCents: 0 })
    const kept = await next.book.purchase(p.ref)
    expect(kept?.pendingReports).toEqual([])
    const at = await chainNow(t)
    expect(await depositV2At(t.hosts, at, t.w.escrow, BigInt(kept?.legs[0]?.depositId ?? '0'))).toMatchObject({ state: V2_STATE.deposit.CONTESTED })
    expect(await depositV2At(t.hosts, at, t.w.escrow, firstDeposit)).toMatchObject({ bondState: V2_STATE.bond.FORFEITED })
    expect(await balance(t, next.wallet.account)).toBe(nextBefore + 3_600_000n)
    expect(await balance(t, SELLER_V2)).toBe(sellerBefore + 4_000_000n)
  })

  it('a report the hosts dropped at the tap stays kept, and goes on its own before the replacement is paid', async () => {
    const t = await tillWorldV2()
    const { next, backend, p } = await leftover(t)
    await card(t, 500)
    const real = next.wallet.broadcast.bind(next.wallet)
    let drops = 1
    next.wallet.broadcast = async (signed, access) => {
      if (drops > 0) {
        drops -= 1
        throw new EscrowRpcError('rpc hosts', 'network', 'the hosts went away')
      }
      return real(signed, access)
    }
    const { owed } = await backend.report(p, 1, 'empty')
    expect((await next.book.purchase(p.ref))?.pendingReports).toMatchObject([{ kind: 'contest', reason: 'empty', scanOrder: 1 }])
    const landed = t.layer.landed.length
    await payNow(backend, owed as RoutePlan, p)
    expect(t.layer.landed.slice(landed).map((b) => b.calls.map((c) => c.data.slice(0, 10)))).toEqual([[CONTEST], [APPROVE, DEPOSIT_AND_OPEN]])
    const kept = await next.book.purchase(p.ref)
    expect(kept?.pendingReports).toEqual([])
    expect(await depositV2At(t.hosts, await chainNow(t), t.w.escrow, BigInt(kept?.legs[0]?.depositId ?? '0'))).toMatchObject({ state: V2_STATE.deposit.CONTESTED })
  })

  it('a replacement that cannot land (another shopper took its card first) takes nothing with it: the report went at the tap', async () => {
    const t = await tillWorldV2()
    const { next, backend, p } = await leftover(t)
    const spare = await card(t, 500)
    const { owed } = await backend.report(p, 1, 'empty')
    await backend.prepare(owed as RoutePlan)
    // Between the tickets and the tap, another shopper uses the replacement card: the batch can only revert.
    await useCardV2(t.w, spare, SHOPPER_C, 500)
    const refused = await payNow(backend, owed as RoutePlan, p).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(LoadRefused)
    expect(refused).toMatchObject({ code: 'not_charged' })
    // The contest is on chain all the same.
    const kept = await next.book.purchase(p.ref)
    expect(kept?.pendingReports).toEqual([])
    expect(await depositV2At(t.hosts, await chainNow(t), t.w.escrow, BigInt(kept?.legs[0]?.depositId ?? '0'))).toMatchObject({
      state: V2_STATE.deposit.CONTESTED,
    })
  })

  it('a kept report a batch still in flight carries waits for it; one the chain no longer takes is dropped', async () => {
    const t = await tillWorldV2()
    const { next, backend, p } = await leftover(t)
    // A report kept on its purchase that the chain does not have yet (the tap could not send it).
    await notePendingReport(next.book, await reportActionV2(saleDeps(next), p.ref, 1, 'didnt_scan'))
    const pending = (await next.book.purchase(p.ref))?.pendingReports ?? []
    expect(pending).toMatchObject([{ kind: 'dispute', reason: 'didnt_scan' }])
    // A carrying purchase signed but not settled: the report is left to it.
    const carrier = { ...((await next.book.purchase(p.ref)) as NonNullable<Awaited<ReturnType<typeof next.book.purchase>>>), id: 'carrier', state: 'signed' as const, before: pending, pendingReports: [] }
    await next.book.savePurchase(carrier)
    expect(await backend.sendPendingReports(p)).toEqual({ sent: 0, landed: 0, waiting: 1, dropped: 0 })
    // It failed after all: the report goes on its own; and past the payout it could not be sent, so it would be dropped.
    await next.book.savePurchase({ ...carrier, state: 'failed' })
    t.w.node.advance(3 * DAY)
    expect(await backend.sendPendingReports(p)).toEqual({ sent: 0, landed: 0, waiting: 0, dropped: 1 })
    expect((await next.book.purchase(p.ref))?.pendingReports).toEqual([])
  })
})

describe('the register needed fewer cards, and one list of store credit', () => {
  it('the register said paid after card 1: card 2 is paid, never drawn, and kept as store credit', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    await card(t, 500)
    const backend = new DollarsBackendV2({ store: shopper.store, book: shopper.book, api: shopper.api, config: shopper.config, access: shopper.access, wallet: shopper.wallet })
    const plan = (await backend.quote({ merchant: 'salvotest', totalCents: 1_300, preference: { ...PREF } })) as RoutePlan
    expect(plan.legs.map((l) => [l.appliedCents, l.leftoverCents])).toEqual([
      [1_000, 0],
      [300, 200],
    ])
    const p = await payNow(backend, plan)
    const receipt = await backend.done(p, 1)
    // Card 2's 2.00 left was bought from its own deposit: it is all the shopper's now, 5.00 of credit, said, and
    // what it cost said apart from what the register took.
    expect(receipt).toEqual({
      paidCents: 900,
      savedCents: 100,
      depositCents: 0,
      keptCents: 0,
      creditPaidCents: 450,
      note: 'Card 2 was not scanned. Its $5.00 is in your store credit now.',
    })
    expect((await tillCreditV2(shopper.book, 'salvotest', null, shopper.wallet.account)).map((c) => c.balanceCents)).toEqual([500])
    // Done twice keeps nothing twice, and says nothing twice.
    expect(await backend.done(p, 1)).toEqual({ ...receipt, note: undefined })
    expect((await tillCreditV2(shopper.book, 'salvotest', null, shopper.wallet.account)).map((c) => c.balanceCents)).toEqual([500])
  })

  it("a card typed in /account is the dollars rail's credit too, used first; and a card kept here goes on /account's list, once", async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    const own = new FakeOwnCards(shopper.store)
    const typed = testCardNumberV2()
    await own.saveOwnCard({ id: 'typed-1', merchant: 'salvotest', balanceCents: 1_300, last4: typed.slice(-4), addedAt: 1 }, { cardNumber: typed, pin: null })
    const backend = new DollarsBackendV2({
      store: shopper.store,
      book: shopper.book,
      api: shopper.api,
      config: shopper.config,
      access: shopper.access,
      wallet: shopper.wallet,
      ownCards: own,
    })
    const plan = (await backend.quote({ merchant: 'salvotest', totalCents: 1_000, preference: { ...PREF } })) as RoutePlan
    expect(plan.legs).toMatchObject([{ source: 'own_credit', appliedCents: 1_000, leftoverCents: 300, costCents: 0 }])
    expect(t.server.calls.quote).toBe(0)
    const p = await payNow(backend, plan)
    expect(p.code.barcode).toBe(typed)
    // What /account shows: 3.00 left on the typed card, sealed again with its number.
    expect((await own.ownCards()).find((c) => c.id === 'typed-1')?.balanceCents).toBe(300)
    expect(await own.ownCardSecret('typed-1')).toEqual({ cardNumber: typed, pin: null })

    // A V2 card the register took 3.00 of, the rest kept: on /account's list, pointing at the card bought here.
    await card(t, 500)
    const p2 = await payNow(backend, (await backend.quote({ merchant: 'salvotest', totalCents: 600, preference: { ...PREF } })) as RoutePlan)
    expect(p2.plan.legs.map((l) => [l.source, l.appliedCents])).toEqual([
      ['own_credit', 300],
      ['fresh', 300],
    ])
    const kept = await backend.keepRest(p2, 2, 300)
    const listed = (await own.ownCards()).find((c) => c.keptCardId === kept.cardId)
    expect(listed).toMatchObject({ id: `kept-${kept.cardId}`, merchant: 'salvotest', balanceCents: 200 })
    // One card, one entry, for both rails.
    const credit = await tillCreditV2(shopper.book, 'salvotest', own, shopper.wallet.account)
    expect(credit).toEqual([{ ref: `own:kept-${kept.cardId}`, balanceCents: 200, since: kept.since, ownId: `kept-${kept.cardId}`, creditId: kept.id, cardId: kept.cardId }])
    // Spent at the till: both records of it go down.
    const p3 = await payNow(backend, (await backend.quote({ merchant: 'salvotest', totalCents: 150, preference: { ...PREF } })) as RoutePlan)
    expect(p3.code.barcode).toBe((await shopper.store.cardSecret(kept.cardId))?.cardNumber)
    expect((await own.ownCards()).find((c) => c.id === `kept-${kept.cardId}`)?.balanceCents).toBe(50)
    expect((await shopper.book.credit(kept.id))?.balanceCents).toBe(50)
  })
})

describe('a leftover bought whole never loses its report', () => {
  /** A $20 card the first shopper used 16.00 of: 4.00 left, covered by their 4.00 deposit. */
  async function firstShopper(t: TillWorldV2) {
    const first = await phoneV2(t, 'shopper')
    const l = await card(t)
    const { record } = await buy(t, first, 1_600)
    return { l, firstDeposit: BigInt(record.legs[0]?.depositId ?? '0') }
  }

  it("is scanned before the shopper's own credit: \"register says paid\" after card 1 hands back credit, never an unscanned leftover", async () => {
    const t = await tillWorldV2()
    const { l } = await firstShopper(t)
    const next = await phoneV2(t, 'shopper')
    const own = new FakeOwnCards(next.store)
    const typed = testCardNumberV2()
    await own.saveOwnCard({ id: 'typed-1', merchant: 'salvotest', balanceCents: 500, last4: typed.slice(-4), addedAt: 1 }, { cardNumber: typed, pin: null })
    await card(t, 500)
    const backend = new DollarsBackendV2({ store: next.store, book: next.book, api: next.api, config: next.config, access: next.access, wallet: next.wallet, ownCards: own })
    const plan = (await backend.quote({ merchant: 'salvotest', totalCents: 1_300, preference: { ...PREF } })) as RoutePlan
    expect(plan.legs.map((x) => [x.source, x.appliedCents, x.leftoverCents, x.scanIndex, x.scanOf])).toEqual([
      ['remainder', 400, 0, 1, 3],
      ['own_credit', 500, 0, 2, 3],
      ['fresh', 400, 100, 3, 3],
    ])
    const p = await payNow(backend, plan)
    // The leftover is drawn first, so the register's scan is what proves it was there.
    expect(p.code.barcode).toBe(l.cardNumber)
    await backend.done(p, 1)
    // The typed card goes back whole; only the last card is kept. The leftover is not credit: it was scanned.
    const credit = await tillCreditV2(next.book, 'salvotest', own, next.wallet.account)
    expect(credit.map((c) => [c.ownId, c.balanceCents])).toEqual([
      ['typed-1', 500],
      [expect.stringMatching(/^kept-/), 500],
    ])
    const leftoverCard = cardIdV2(t.w.escrow, (await next.book.purchase(p.ref))?.legs[0]?.depositId ?? '')
    expect(credit.some((c) => c.cardId === leftoverCard)).toBe(false)
  })

  it('kept as credit, "that card was empty" about it inside its two hours is a contest on its sale: the money back, the first deposit to the seller', async () => {
    const t = await tillWorldV2()
    const { l, firstDeposit } = await firstShopper(t)
    const next = await phoneV2(t, 'shopper')
    // The next shopper bought the 4.00 leftover whole and it was never scanned: their credit, naming its sale.
    const { record } = await buy(t, next, 400)
    const kept = await keepCardV2(saleDeps(next), record.id, 1, 0)
    expect(kept).toMatchObject({ balanceCents: 400, purchaseId: record.id, scanOrder: 1 })
    const backend = new DollarsBackendV2({ store: next.store, book: next.book, api: next.api, config: next.config, access: next.access, wallet: next.wallet })
    const p = await payNow(backend, (await backend.quote({ merchant: 'salvotest', totalCents: 400, preference: { ...PREF } })) as RoutePlan)
    expect(p.plan.legs).toMatchObject([{ source: 'own_credit', appliedCents: 400, costCents: 0 }])
    expect(p.code.barcode).toBe(l.cardNumber)
    const sellerBefore = await balance(t, SELLER_V2)
    const nextBefore = await balance(t, next.wallet.account)
    const { owed } = await backend.report(p, 1, 'empty')
    expect(owed).toMatchObject({ unavailable: expect.any(String) })
    const at = await chainNow(t)
    expect(await depositV2At(t.hosts, at, t.w.escrow, BigInt(record.legs[0]?.depositId ?? '0'))).toMatchObject({ state: V2_STATE.deposit.CONTESTED, amount: 0n })
    expect(await depositV2At(t.hosts, at, t.w.escrow, firstDeposit)).toMatchObject({ bondState: V2_STATE.bond.FORFEITED })
    expect(await balance(t, next.wallet.account)).toBe(nextBefore + 3_600_000n)
    expect(await balance(t, SELLER_V2)).toBe(sellerBefore + 4_000_000n)
    expect((await next.book.credit(kept.id))?.balanceCents).toBe(0)
    expect((await next.book.purchase(record.id))?.legs[0]).toMatchObject({ refunded: true, reported: 'contest' })
  })

  it('past its two hours, "empty" about the kept leftover is a dispute: its payout waits for the seller to refund', async () => {
    const t = await tillWorldV2()
    await firstShopper(t)
    const next = await phoneV2(t, 'shopper')
    const { record } = await buy(t, next, 400)
    const kept = await keepCardV2(saleDeps(next), record.id, 1, 0)
    t.w.node.advance(7_201)
    const backend = new DollarsBackendV2({ store: next.store, book: next.book, api: next.api, config: next.config, access: next.access, wallet: next.wallet })
    const p = await payNow(backend, (await backend.quote({ merchant: 'salvotest', totalCents: 400, preference: { ...PREF } })) as RoutePlan)
    await backend.report(p, 1, 'empty')
    const sale = await depositV2At(t.hosts, await chainNow(t), t.w.escrow, BigInt(record.legs[0]?.depositId ?? '0'))
    expect(sale).toMatchObject({ state: V2_STATE.deposit.OPENED, disputed: true })
    expect(sale.releaseAt).toBe(sale.openedAt + DAY + 2 * DAY)
    expect((await next.book.credit(kept.id))?.balanceCents).toBe(0)
  })
})

/**
 * A new total while `code` is on screen, as the till's screens handle it
 * (the main checkout's use-till.ts): that code is the purchase's last from
 * then on; a plan owed is paid after Done on it, and its codes are scanned in
 * turn. What the register took, by what the backend says each card covered.
 */
async function newTotalAtRegister(backend: DollarsBackendV2, p: Purchase, code: LegCode, totalCents: number) {
  const out = await backend.changeTotal(p, totalCents)
  // What the till now shows: this code as the last of its purchase.
  expect(out.purchase.plan.legs).toHaveLength(code.scanIndex)
  let took = out.purchase.plan.legs.reduce((n, l) => n + l.appliedCents, 0)
  const barcodes: string[] = []
  if (out.owed !== null && !('unavailable' in out.owed)) {
    await backend.done(out.purchase, code.scanIndex)
    const rest = await payNow(backend, out.owed, out.purchase)
    let c = rest.code
    barcodes.push(c.barcode)
    while (c.scanIndex < c.scanOf) {
      c = await backend.next(rest, c.scanIndex)
      barcodes.push(c.barcode)
    }
    await backend.done(rest, c.scanIndex)
    took += rest.plan.legs.reduce((n, l) => n + l.appliedCents, 0)
  } else {
    await backend.done(out.purchase, code.scanIndex)
  }
  return { out, took, barcodes }
}

describe('the total changes while an earlier card is on screen', () => {
  /** 13.00 on a $10 card used up and a $5 card with 2.00 left, card 1 on screen. */
  async function twoCards(t: TillWorldV2) {
    const shopper = await phoneV2(t, 'shopper')
    const c1 = await card(t, 1_000)
    const c2 = await card(t, 500)
    const backend = new DollarsBackendV2({ store: shopper.store, book: shopper.book, api: shopper.api, config: shopper.config, access: shopper.access, wallet: shopper.wallet })
    const plan = (await backend.quote({ merchant: 'salvotest', totalCents: 1_300, preference: { ...PREF } })) as RoutePlan
    expect(plan.legs.map((l) => [l.appliedCents, l.leftoverCents])).toEqual([
      [1_000, 0],
      [300, 200],
    ])
    const p = await payNow(backend, plan)
    expect(p.code.barcode).toBe(c1.cardNumber)
    return { shopper, c1, c2, backend, p }
  }

  it('up: card 2, never drawn, is kept whole and pays the rest first, so the register gets the new total', async () => {
    const t = await tillWorldV2()
    const { shopper, c2, backend, p } = await twoCards(t)
    const { out, took, barcodes } = await newTotalAtRegister(backend, p, p.code, 1_400)
    expect((out.owed as RoutePlan).legs.map((l) => [l.source, l.appliedCents, l.costCents])).toEqual([['own_credit', 400, 0]])
    expect(took).toBe(1_400)
    expect(barcodes).toEqual([c2.cardNumber])
    // Card 2's 2.00 left was bought from its own deposit: 1.00 of it is still the shopper's.
    expect((await tillCreditV2(shopper.book, 'salvotest', null, shopper.wallet.account)).map((c) => c.balanceCents)).toEqual([100])
  })

  it('down, still past card 1: card 2 pays what card 1 leaves, so the register gets the new total', async () => {
    const t = await tillWorldV2()
    const { shopper, c2, backend, p } = await twoCards(t)
    const { took, barcodes } = await newTotalAtRegister(backend, p, p.code, 1_200)
    expect(took).toBe(1_200)
    expect(barcodes).toEqual([c2.cardNumber])
    expect((await tillCreditV2(shopper.book, 'salvotest', null, shopper.wallet.account)).map((c) => c.balanceCents)).toEqual([300])
  })

  it('down, below card 1: card 2 is kept, card 1 covers less with the rest left for the next shopper, and nothing is owed', async () => {
    const t = await tillWorldV2()
    const { shopper, c1, backend, p } = await twoCards(t)
    const { out, took } = await newTotalAtRegister(backend, p, p.code, 800)
    expect(out.owed).toBeNull()
    expect(out.purchase.plan.legs).toMatchObject([{ appliedCents: 800, leftoverCents: 200, scanOf: 1 }])
    expect(took).toBe(800)
    expect((await listingV2At(t.hosts, await chainNow(t), t.w.escrow, c1.listingId)).remainingCents).toBe(200)
    expect((await tillCreditV2(shopper.book, 'salvotest', null, shopper.wallet.account)).map((c) => c.balanceCents)).toEqual([500])
  })
})

describe('a purchase is paid once, with keys this phone still holds', () => {
  it('a prepared purchase already paid or put aside is refused, never paid with zeroed keys', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    await card(t)
    const d = loadDepsOf(t, shopper)
    const prepared = await prepareLoadV2(d, ask(shopper, 1_600), await quoteTillV2(d, ask(shopper, 1_600)))
    discardPreparedV2(prepared)
    await expect(executeLoadV2(d, prepared)).rejects.toMatchObject({ code: 'quote_mismatch' })
    expect(t.layer.landed).toHaveLength(0)
    expect(await shopper.book.purchases()).toEqual([])
  })

  it('the till: paying an older plan after preparing a newer one asks for new tickets, and the card opens', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    const l = await card(t)
    await card(t, 500)
    const backend = new DollarsBackendV2({ store: shopper.store, book: shopper.book, api: shopper.api, config: shopper.config, access: shopper.access, wallet: shopper.wallet })
    const older = (await backend.quote({ merchant: 'salvotest', totalCents: 1_600, preference: { ...PREF } })) as RoutePlan
    await backend.prepare(older)
    // Two cards this time: other tickets, and the older plan's keys are zeroed.
    const newer = (await backend.quote({ merchant: 'salvotest', totalCents: 2_100, preference: { ...PREF } })) as RoutePlan
    expect(newer.legs).toHaveLength(2)
    await backend.prepare(newer)
    const tickets = t.server.calls.ticket
    const paid = await payNow(backend, older)
    expect(t.server.calls.ticket).toBeGreaterThan(tickets)
    expect(paid.code.barcode).toBe(l.cardNumber)
    // A plan is paid once.
    await expect(payNow(backend, older)).rejects.toMatchObject({ code: 'quote_mismatch' })
    expect(await backend.unfinished()).toEqual([])
    expect((await backend.finish(paid.ref)).state).toBe('done')
  })

  it('"that card was empty" on a card nobody covers is a dispute: the payout waits for the seller', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    await card(t)
    const { record } = await buy(t, shopper, 2_000)
    const action = await reportActionV2(saleDeps(shopper), record.id, 1, 'empty')
    expect(action).toMatchObject({ kind: 'dispute', reason: 'empty' })
    await sendReportV2(saleDeps(shopper), action)
    const dep = await depositV2At(t.hosts, await chainNow(t), t.w.escrow, BigInt(action.depositId))
    expect(dep).toMatchObject({ state: V2_STATE.deposit.OPENED, disputed: true })
    expect(dep.releaseAt).toBe(dep.openedAt + DAY + 2 * DAY)
  })
})

describe('the batch, written out', () => {
  it('reports first, then one approve of exactly what is pulled, then each card', async () => {
    const t = await tillWorldV2()
    const shopper = await phoneV2(t, 'shopper')
    await card(t)
    const d = loadDepsOf(t, shopper)
    const prepared = await prepareLoadV2(d, ask(shopper, 1_600), await quoteTillV2(d, ask(shopper, 1_600)))
    const calls = loadCallsV2(shopper.config, prepared.legs, [{ kind: 'contest', reason: 'empty', purchaseId: 'x', scanOrder: 1, depositId: '5' }])
    expect(calls.map((c) => [c.to, c.data.slice(0, 10)])).toEqual([
      [t.w.escrow, toFunctionSelector(getAbiItem({ abi: ESCROW_V2_ABI, name: 'contestRemainder' }) as AbiFunction)],
      [PATH_USD, APPROVE],
      [t.w.escrow, DEPOSIT_AND_OPEN],
    ])
    expect(approvedOf(calls)).toBe(18_400_000n)
    const parsed = parseQuoteV2(JSON.parse(JSON.stringify(prepared.quote)))
    expect(parsed).toEqual(prepared.quote)
  })
})
