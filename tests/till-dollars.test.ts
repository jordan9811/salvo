/**
 * The dollars rail as a real backend of the till (unified-account spec 5.1,
 * 5.3, 5.4, 6 and 11), offline and database-free: the shopper's phone
 * against the real SalvoEscrowV2 on the in-process EVM behind the two fake
 * hosts, the real pinned salvo-vault-escrow/2 on fake Lit, Tempo's account
 * layer checking every signature and scope, a fake Face ID and a fake
 * IndexedDB (tests/support/escrow-till-world-v2.ts). The stand-in server
 * plans with the till route's own planner (till-quote-v2.ts planTillQuoteV2).
 *
 * Pinned:
 *   - tap, type, pay, scan: the route's planner picks the cards; the tap is
 *     ONE batch (approve exactly the value used plus the deposit, one
 *     depositAndOpen per card) with no prompt; the tickets, nonce, fees and
 *     gas were all fetched while the shopper typed, so the tap asks the hosts
 *     for none of them; one release per card; the codes come up "Scan 1 of 2",
 *     "Scan 2 of 2", card 2 only after Next;
 *   - the second host's agreement runs beside Lit's release, never before it,
 *     and the purchase is booked as paid only once both hosts agree;
 *   - Tempo's host without the send that waits: sent plainly, its receipt
 *     asked for, the same purchase;
 *   - a filled batch whose nonce another send used is signed again, never
 *     sent stale twice;
 *   - a Pay that may have gone through keeps the tap's key, and the next tap
 *     with it finishes that purchase, takes the shopper's own credit once,
 *     and never pays again; a key whose tap never signed says nothing was
 *     charged;
 *   - a card another shopper used between the quote and the tap: a new price,
 *     nothing charged;
 *   - the total came down past what the card on screen may keep: it must not
 *     be scanned, "not used" makes it the shopper's credit, and that credit
 *     pays the rest first;
 *   - after Done, from a fresh screen with only the purchase's handle (as
 *     Account opens it): "that card was empty" on a leftover inside two hours
 *     is a contest (the money back), after them a dispute, and anything else
 *     a dispute, each said in a sentence;
 *   - /account's store credit: a card the till bought on the second escrow is
 *     never offered as credit to count by hand, and [Sell it] lists a typed
 *     card, or a kept one once its purchase is paid out, on SalvoEscrowV2;
 *   - the quote route's V2 body is checked key by key, and answers 503 until
 *     V2 is open;
 *   - a retry with the tap's key after the keypad priced the total again is
 *     rebuilt from the purchase it made (its plan, kept on the record), never
 *     from the new plan: the same cards, the total it paid, never paid
 *     twice; and once a purchase is kept under a key, no refusal ends it;
 *   - a card the register did not need that the chain did not keep now is
 *     said, kept on its purchase, and made store credit when the till opens
 *     again (catchUp), once; "not used" says so too, never that it is credit;
 *   - a report that did not reach the chain is said, never as the seller's
 *     payment waiting, and sent when the till opens again;
 *   - the shopper's own card that did not work is said as theirs, still in
 *     their store credit, never as a seller's refund;
 *   - the receipt rounds what the chain pulled once, as the Pay button does;
 *   - a card limit filled by the shopper's own credit never refuses a total
 *     there are cards on sale for, and a refusal names the store as the till
 *     names it;
 *   - the total going up with a card on screen uses what is on that card
 *     first, as a register does: a leftover listed for the next shopper is
 *     bought out of its deposit before the register can take it (and what the
 *     register leaves is store credit), and the shopper's own card gives the
 *     extra before anything is bought;
 *   - a card to keep whose rest went to someone else meanwhile (another
 *     shopper, or the seller paid first) is kept at what was paid for, and
 *     said, never dropped;
 *   - a card sold from store credit whose answer never came back is off the
 *     till's list and /account's alike, typed or kept;
 *   - a dollars Pay still going through when the account signs out is found
 *     again in the V2 book by its tap's key, for that account only;
 *   - the receipt counts as covered and saved only what the register took: a
 *     card that did not work and a card kept as credit are said apart, and a
 *     card kept as credit is said;
 *   - another shopper's leftover rests two hours after the sale that left it
 *     before the till offers it: its first shopper may still have the card on
 *     screen, unscanned, well past the quote's two-minute hold;
 *   - unless that shopper taps Done on it: their phone says so with the proof
 *     the card's reply key signed when it was opened, and the next shopper is
 *     offered the leftover at once and buys it; a forged done (another key,
 *     another signer, another deposit, chain or escrow, a high s) changes
 *     nothing; a restart forgets every done and the rest runs its two hours;
 *     a card the register may not have taken is never said done;
 *   - a reload with a card on screen loses nothing paid for: the till offers
 *     the purchase again on the card that was showing; left long enough,
 *     every card it never drew is store credit (its leftover off sale); and a
 *     purchase paid from store credit alone is found by its key, its credit
 *     taken off once and given back for what it never showed;
 *   - "not used" after the total came down: what is owed comes from the
 *     shopper's store credit at once, said as that, and a card the next plan
 *     scans is never said to be store credit now;
 *   - store credit that covers the total is offered with no dollars to spend;
 *     credit that does not, on a phone with no dollars set up, says to set
 *     them up, never that there is not enough with cards on sale;
 *   - the dollars tap, toward 2 s, keeping every check: with dRPC a block
 *     behind (as measured 2026-10-14) every card is released on the first
 *     ask, the route waiting for that host; a tap before the prepare is done
 *     waits for it and marks how long (ticket_wait); a new total on other
 *     cards does not wait behind the last total's tickets, which are dropped,
 *     never used, while one on the same cards waits and uses them; the
 *     prepare asks Lit before reading the cards again, and after the
 *     tickets checks the cards they name in one round at a block read while
 *     Lit ran; a tap long after the prepare reads again only what aged, its
 *     chain read beside its fill, and no card;
 *   - no body the phone sends, and no request to either host, holds a card
 *     number.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, erc20Abi, getAbiItem, toFunctionSelector, type AbiFunction, type Hex } from 'viem'
import { POST as doneRoute } from '@/app/api/escrow/done/route'
import { POST as quoteRoute } from '@/app/api/escrow/quote/route'
import { alsoPaidLine, costsNothing, coversLine, depositBackLine, doneLine, NOT_USED_KEPT, owedLine, payLabel, payMoreLabel, saveLine, scanTitle, stillOwedLine } from '@/app/pay/till-copy'
import { landPurchase, otherWayPlan, owedStartsAtOnce, phaseAfterChange, phaseAfterReport, phaseOnScreen } from '@/app/pay/[store]/use-till'
import { storeCreditList } from '@/lib/account/client/credit'
import { keepableCards, keepAsCredit, CreditRefused } from '@/lib/account/client/credit'
import { sellOwnCredit, type SellCreditDeps } from '@/lib/account/client/sell-credit'
import { ESCROW_V2_ABI } from '@/lib/escrow/artifact-v2'
import { EscrowApiV2 } from '@/lib/escrow/client/api-v2'
import type { OwnCardRecord } from '@/lib/escrow/client/card-store'
import { tillCreditV2 } from '@/lib/escrow/client/credit-v2'
import { DollarsBackendV2, type DollarsBackendDeps } from '@/lib/escrow/client/dollars-backend'
import { doneSignedV2, signDoneV2 } from '@/lib/escrow/done-proof-v2'
import { __clearLeftoverDoneForTests } from '@/lib/escrow/leftover-done'
import { __clearReleaseMemoryForTests } from '@/lib/escrow/lit-escrow'
import { LoadRefused } from '@/lib/escrow/client/load'
import { executeLoadV2, prepareLoadV2, quoteTillV2, type LoadDepsV2 } from '@/lib/escrow/client/load-v2'
import { isCardV2 } from '@/lib/escrow/client/records-v2'
import { createBrowserReplyKey } from '@/lib/escrow/client/reply'
import { LEFTOVER_REST_MS } from '@/lib/escrow/quote-v2'
import { escrowIntentIdFor } from '@/lib/escrow/refs'
import { setUpDeviceWalletV2 } from '@/lib/escrow/client/wallet-v2'
import type { BatchSigner } from '@/lib/escrow/client/load'
import { SellRefused } from '@/lib/escrow/client/sell'
import { depositV2At, listingV2At, V2_STATE } from '@/lib/escrow/runbook/reads-v2'
import { agreedFinalizedBlock, EscrowRpcError } from '@/lib/escrow/runbook/rpc'
import { __setEscrowRuntimeForTests } from '@/lib/escrow/runtime'
import { STILL_GOING, TillRefused } from '@/lib/till/client/refused'
import type { TapStep } from '@/lib/till/timing'
import type { Purchase, RoutePlan, RoutePreference, TillBackend } from '@/lib/till/types'
import { escrowV2Call } from './support/escrow-v2-chain'
import { closeServerWorldV2, listV2, SHOPPER_C, testCardNumberV2, useCardV2 } from './support/escrow-server-world-v2'
import { hostBehind, loadDepsOf, phoneV2, tillWorldV2, type PhoneV2, type TillWorldV2 } from './support/escrow-till-world-v2'
import { FakeAuthenticator } from './support/fake-webauthn'
import { testAddress } from './support/evm'

const RAIL = process.env.ESCROW_RAIL
const USAGE_KEY = process.env.LIT_VAULT_USAGE_KEY
const CARD_RE = /9999[0-9]{12}/
const DAY = 86_400
/** Chain seconds past another shopper's leftover resting after its sale (quote-v2.ts LEFTOVER_REST_MS). */
const REST_S = LEFTOVER_REST_MS / 1000 + 1
const IN_AND_OUT: RoutePreference = { mode: 'in_and_out', maxCards: 2 }
const APPROVE = '0x095ea7b3'
const DEPOSIT_AND_OPEN = toFunctionSelector(getAbiItem({ abi: ESCROW_V2_ABI, name: 'depositAndOpen' }) as AbiFunction)
/** What viem asks the hosts to fill a batch. None of it may be asked at the tap. */
const FILL_METHODS = new Set(['eth_estimateGas', 'eth_getTransactionCount', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_fillTransaction'])

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

/** A salvotest card, at 10% off unless `pricePct` says otherwise, listed and in our server's book. */
async function card(t: TillWorldV2, valueCents: number, pricePct = 90) {
  const l = await listV2(t.w, { valueCents, price: valueCents * pricePct * 100, residualCapCents: 500 })
  t.server.add(l)
  return l
}

/** A world whose server plans with the till route's own planner. */
async function world(): Promise<TillWorldV2> {
  const t = await tillWorldV2()
  t.server.planner = 'till'
  return t
}

/** The phone's till backend. A wait moves the chain on a second, so a host a block behind catches up. */
function dollars(t: TillWorldV2, p: PhoneV2, more: Partial<DollarsBackendDeps> = {}): DollarsBackendV2 {
  return new DollarsBackendV2({
    store: p.store,
    book: p.book,
    api: p.api,
    config: p.config,
    access: p.access,
    wallet: p.wallet,
    sleep: async () => t.w.node.advance(1),
    ...more,
  })
}

async function quote(b: TillBackend, totalCents: number, preference: RoutePreference = IN_AND_OUT): Promise<RoutePlan> {
  const out = await b.quote({ merchant: 'salvotest', totalCents, preference })
  if ('unavailable' in out) throw new Error(`no plan: ${out.unavailable}`)
  return out
}

async function payNow(b: TillBackend, plan: RoutePlan, opts: { after?: Purchase; key?: string } = {}): Promise<Purchase> {
  const out = await b.pay(plan, opts)
  if ('requote' in out || 'ended' in out) throw new Error(`Pay answered ${'requote' in out ? 'a new price' : 'an ended purchase'}: ${out.message}`)
  return out
}

/**
 * The hosts' clock is the chain's, so a wait that moves the chain also runs
 * out a timeout; and a wait lets the phone's other work (its store, Lit) go
 * on meanwhile, as a real one does.
 */
function chainClock(t: TillWorldV2, p: PhoneV2): PhoneV2 {
  const sleep = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 1))
    t.w.node.advance(1)
  }
  return { ...p, access: { ...p.access, hosts: { ...p.access.hosts, now: () => Number(t.w.node.chain.timestamp) * 1000, sleep } } }
}

/**
 * The next `n` sends from this phone's key fail before they leave it, as on a
 * dropped connection. Only the sends after the till's Pay use this path
 * (keeping a card, a report); Pay itself sends the fast way.
 */
function dropSends(p: PhoneV2, n = 1): void {
  const real = p.wallet.broadcast.bind(p.wallet)
  let left = n
  p.wallet.broadcast = async (signed, access) => {
    if (left > 0) {
      left -= 1
      throw new EscrowRpcError('rpc.moderato.tempo.xyz', 'network', 'the connection dropped')
    }
    return real(signed, access)
  }
}

/** A typed card of the shopper's own, as /account seals one. */
async function ownCard(p: PhoneV2, id: string, balanceCents: number, addedAt: number): Promise<string> {
  const number = testCardNumberV2()
  await p.store.saveOwnCard({ id, merchant: 'salvotest', balanceCents, last4: number.slice(-4), addedAt }, { cardNumber: number, pin: null })
  return number
}

function noCardAnywhere(t: TillWorldV2): void {
  expect(t.server.sent.join('\n')).not.toMatch(CARD_RE)
  expect(t.w.node.requests.map((r) => r.bodyText).join('\n')).not.toMatch(CARD_RE)
}

describe('tap, type, pay, scan on the dollars rail', () => {
  it("the till's planner, one batch with the deposit and no prompt, nothing fetched at the tap, one release per card, Scan 1 of 2 then 2 of 2", async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    // 20% off the $20 card, 10% off the $16: using the $20 card whole is the cheaper of the two plans.
    const c20 = await card(t, 2_000, 80)
    const c16 = await card(t, 1_600)
    // Each step of the tap, as scripts/till-timing.ts prints them.
    const marks: string[] = []
    const backend = dollars(t, shopper, { onMark: (step) => marks.push(step) })
    const method = await backend.method()
    expect(method).toMatchObject({ ready: true, checked: true, problem: null, label: expect.stringMatching(/^dollars \(\$[0-9.,]+\)$/) })

    // Typing: the price, then (the total still) what the tap needs.
    const plan = await quote(backend, 3_213)
    expect(plan.legs.map((l) => [l.source, l.appliedCents, l.leftoverCents, l.depositCents, l.scanIndex, l.scanOf])).toEqual([
      ['fresh', 2_000, 0, 0, 1, 2],
      ['fresh', 1_213, 387, 387, 2, 2],
    ])
    expect(payLabel(plan)).toBe('Pay $26.92 for $32.13 · 2 cards')
    expect(saveLine(plan, method)).toMatch(/^You save \$[0-9.]+ · from your dollars \(\$[0-9.,]+\)$/)
    await backend.prepare(plan)
    expect(marks).toEqual(['prepare'])

    // The tap.
    const prompts = shopper.auth.prompts
    const asked = t.w.node.requests.length
    const tickets = t.server.calls.ticket
    const releases = t.server.calls.release
    const p = await payNow(backend, plan, { key: 'tap-1' })
    const atTheTap = t.w.node.requests.slice(asked).map((r) => r.method)
    expect(atTheTap.filter((m) => FILL_METHODS.has(m))).toEqual([])
    expect(atTheTap.filter((m) => m.startsWith('eth_sendRawTransaction'))).toEqual(['eth_sendRawTransactionSync'])
    expect(t.server.calls.ticket).toBe(tickets)
    expect(t.server.calls.release - releases).toBe(2)
    expect(shopper.auth.prompts).toBe(prompts)
    // The tap's own steps: no wait for a prepare that was done, no reads (nothing had aged), then sign, send, included.
    expect(marks.slice(1, 6)).toEqual(['ticket_wait', 'reads', 'sign', 'send', 'included'])
    expect([...marks.slice(6)].sort()).toEqual(['release', 'second_host'])

    // One batch: approve exactly what is pulled (the price of the cents used, and the 3.87 left at face), then each card.
    expect(t.layer.landed).toHaveLength(1)
    const batch = t.layer.landed[0]
    expect(batch?.calls.map((c) => c.data.slice(0, 10))).toEqual([APPROVE, DEPOSIT_AND_OPEN, DEPOSIT_AND_OPEN])
    const approved = decodeFunctionData({ abi: erc20Abi, data: batch?.calls[0]?.data as Hex }).args[1] as bigint
    const record = await shopper.book.purchase(p.ref)
    const pulled = (record?.legs ?? []).reduce((n, l) => n + BigInt(l.amountUnits) + BigInt(l.bondUnits), 0n)
    expect(approved).toBe(pulled)
    expect(record?.legs.map((l) => [l.usedCents, l.leftCents, l.bondUnits])).toEqual([
      [2_000, 0, '0'],
      [1_213, 387, '3870000'],
    ])
    expect(record?.state).toBe('done')
    expect(record?.till).toMatchObject({ key: 'tap-1', own: [], ownTaken: true })

    // Scan 1 of 2; card 2 exists on this phone only after Next.
    expect(scanTitle(p.code.scanIndex, p.code.scanOf)).toBe('Scan 1 of 2')
    expect(coversLine(p.code)).toBe('covers $20.00')
    expect(p.code.barcode).toBe(c20.cardNumber)
    const second = await backend.next(p, 1)
    expect(scanTitle(second.scanIndex, second.scanOf)).toBe('Scan 2 of 2')
    expect(coversLine(second)).toBe('covers $12.13 · $3.87 stays on it for the next shopper')
    expect(second.barcode).toBe(c16.cardNumber)
    const receipt = await backend.done(p, 2)
    expect(plan.costCents).toBe(2_692)
    expect(receipt).toEqual({ paidCents: 2_692, savedCents: 521, depositCents: 387, keptCents: 0 })
    expect(depositBackLine(receipt)).toBe('Your $3.87 deposit comes back when the next shopper uses the rest (at most 7 days).')
    noCardAnywhere(t)
  })

  it("the till's planner sends the next shopper to that leftover first, whole, at no haircut; and your own leftover is used in part, your deposit netted", async () => {
    const t = await world()
    const first = await phoneV2(t, 'shopper')
    const c20 = await card(t, 2_000)
    const a = dollars(t, first)
    const pa = await payNow(a, await quote(a, 1_600))
    await a.done(pa, 1)
    await card(t, 1_000)

    // The next shopper, once it has rested: the 4.00 leftover, covered by the first shopper's deposit, first and whole.
    t.w.node.advance(REST_S)
    const next = await phoneV2(t, 'shopper')
    const b = dollars(t, next)
    const plan = await quote(b, 1_100)
    expect(plan.legs.map((l) => [l.source, l.firstInLine, l.appliedCents, l.costCents, l.leftoverCents])).toEqual([
      ['remainder', true, 400, 360, 0],
      ['fresh', false, 700, 630, 300],
    ])
    const pb = await payNow(b, plan)
    expect(pb.code.barcode).toBe(c20.cardNumber)

    // The first shopper again, at the same store: their own 3.00 leftover on the $10 card is not theirs to buy (another
    // shopper's deposit covers it now), but their own covered leftover may be used in part. The $10 card's 3.00 is
    // the second shopper's deposit, so it is first in line and whole for anyone else, once it has rested.
    t.w.node.advance(REST_S)
    const again = await quote(a, 300)
    expect(again.legs).toMatchObject([{ source: 'remainder', appliedCents: 300, leftoverCents: 0 }])
    // The second shopper's own leftover: used in part, their deposit coming back in the same batch.
    const own = await quote(b, 200)
    expect(own.legs).toMatchObject([{ source: 'remainder', appliedCents: 200, leftoverCents: 100, depositCents: 100 }])
    const before = t.layer.landed.length
    const po = await payNow(b, own)
    expect(t.layer.landed).toHaveLength(before + 1)
    const sold = await next.book.purchase(po.ref)
    expect(sold?.legs[0]).toMatchObject({ usedCents: 200, leftCents: 100 })
    noCardAnywhere(t)
  })

  it("another shopper's leftover rests two hours after its sale before the till offers it: its first shopper may still have the card on screen", async () => {
    const t = await world()
    const first = await phoneV2(t, 'shopper')
    const c20 = await card(t, 2_000)
    const a = dollars(t, first)
    // The first shopper pays $16.00 of the $20 card, and has it on screen while the cashier is slow.
    const pa = await payNow(a, await quote(a, 1_600))
    expect(pa.code.barcode).toBe(c20.cardNumber)
    const c5 = await card(t, 500)
    // Ten minutes: well past the quote's two-minute hold on it.
    t.w.node.advance(600)
    const next = dollars(t, await phoneV2(t, 'shopper'))
    // The finding: the next shopper was planned the $4.00 rest first. Their register took up to what was due from a
    // card still holding $20.00, and the first shopper's own scan was then declined.
    const early = await quote(next, 400)
    expect(early.legs.map((l) => [l.source, l.ref])).toEqual([['fresh', escrowIntentIdFor(c5.listingId)]])
    // Rested, it is first in line again.
    t.w.node.advance(REST_S)
    const rested = await quote(next, 400)
    expect(rested.legs).toMatchObject([{ source: 'remainder', ref: escrowIntentIdFor(c20.listingId), appliedCents: 400 }])
  })
})

describe('a leftover goes on sale once its first shopper is done with the card', () => {
  beforeEach(() => {
    __clearReleaseMemoryForTests()
    __clearLeftoverDoneForTests()
  })

  /** Bodies the phones sent to the done route. */
  const doneBodies = (t: TillWorldV2): string[] => t.server.sent.filter((b) => b.includes('"signature"'))

  /** The first shopper pays $16.00 of a $20 card and has it on screen: $4.00 stays on it, behind their deposit. A $5 card is on sale too. */
  async function leftoverOnScreen(t: TillWorldV2) {
    const first = await phoneV2(t, 'shopper')
    const c20 = await card(t, 2_000)
    const a = dollars(t, first)
    const pa = await payNow(a, await quote(a, 1_600))
    expect(pa.code.barcode).toBe(c20.cardNumber)
    const c5 = await card(t, 500)
    const next = dollars(t, await phoneV2(t, 'shopper'))
    return { first, a, pa, c20, c5, next }
  }

  it('offered to the next shopper the moment the first taps Done, and never before; the next shopper pays it', async () => {
    const t = await world()
    const { first, a, pa, c20, c5, next } = await leftoverOnScreen(t)
    // Signed when the card was opened, while its reply key was on the phone; that key is gone now.
    const leg = (await first.book.purchase(pa.ref))?.legs[0]
    expect(leg?.doneProof).toEqual({ depositId: leg?.depositId, signature: expect.stringMatching(/^0x[0-9a-f]{128}$/) })
    expect(await first.store.replyKey(leg?.replyKeyId ?? '')).toBeNull()

    // The card on screen, unscanned, ten minutes on: the rest holds, and nothing has been said.
    t.w.node.advance(600)
    expect((await quote(next, 400)).legs.map((l) => [l.source, l.ref])).toEqual([['fresh', escrowIntentIdFor(c5.listingId)]])
    expect(doneBodies(t)).toEqual([])

    // Done: the receipt first, and the phone says done after it, once.
    const receipt = await a.done(pa, 1)
    expect(receipt.depositCents).toBe(400)
    await vi.waitFor(() => expect(t.server.dones).toEqual([{ status: 200, error: null }]))
    expect(doneBodies(t)).toHaveLength(1)
    // No chain time passed: the $4.00 is first in line now, whole.
    const now = await quote(next, 400)
    expect(now.legs).toMatchObject([{ source: 'remainder', firstInLine: true, ref: escrowIntentIdFor(c20.listingId), appliedCents: 400, leftoverCents: 0 }])
    // And it is bought: nothing on the chain or in Lit rests it.
    const pb = await payNow(next, now)
    expect(pb.code.barcode).toBe(c20.cardNumber)
    noCardAnywhere(t)
  })

  it('a forged done changes nothing: another key, the right key signed by another, or a real proof for another deposit', async () => {
    const t = await world()
    const { first, a, pa, c20, c5, next } = await leftoverOnScreen(t)
    const leg = (await first.book.purchase(pa.ref))?.legs[0]
    if (leg === undefined || leg.depositId === null || leg.doneProof === undefined) throw new Error('the card has no deposit or proof')
    const depositId = leg.depositId
    const proof = leg.doneProof.signature
    const thief = await phoneV2(t, 'shopper')
    const theirs = createBrowserReplyKey()
    const at = { chainId: thief.config.chainId, escrow: t.w.escrow, depositId }
    const send = async (replyKey: Hex, signature: Hex, id = depositId, escrow: Hex = t.w.escrow): Promise<unknown[]> => {
      const out = await thief.api.done(escrow, id, replyKey, signature)
      return [out.status, out.body.error]
    }
    // Their own key, signed for that deposit: the chain names the first shopper's key for it.
    expect(await send(theirs.publicKey, signDoneV2(theirs.secretKey, at))).toEqual([403, 'not_your_card'])
    // The first shopper's key named, the proof signed by another.
    expect(await send(leg.replyPublicKey, signDoneV2(theirs.secretKey, at))).toEqual([403, 'not_your_card'])
    // The first shopper's real proof, sent for another deposit: it names its own only.
    expect(await send(leg.replyPublicKey, proof, (BigInt(depositId) + 1n).toString())).toEqual([403, 'not_your_card'])
    // Named for another escrow.
    expect(await send(leg.replyPublicKey, proof, depositId, testAddress(77))).toEqual([400, 'bad_escrow'])
    // The real proof with its s flipped high: the same signature, in a form never taken.
    const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
    const high = `${proof.slice(0, 66)}${(n - BigInt(`0x${proof.slice(66)}`)).toString(16).padStart(64, '0')}` as Hex
    expect(await send(leg.replyPublicKey, high)).toEqual([403, 'not_your_card'])
    // None of it changed anything: the leftover still rests.
    expect((await quote(next, 400)).legs.map((l) => l.ref)).toEqual([escrowIntentIdFor(c5.listingId)])

    // The first shopper's own Done still frees it.
    await a.done(pa, 1)
    await vi.waitFor(() => expect(t.server.dones.at(-1)).toEqual({ status: 200, error: null }))
    expect((await quote(next, 400)).legs.map((l) => l.ref)).toEqual([escrowIntentIdFor(c20.listingId)])
  })

  it('a proof names one deposit, on one escrow and one chain, signed by one key, in one form', () => {
    const k = createBrowserReplyKey()
    const at = { chainId: 42431, escrow: testAddress(5), depositId: '7' }
    const sig = signDoneV2(k.secretKey, at)
    expect(doneSignedV2(k.publicKey, sig, at)).toBe(true)
    // The escrow in any case is the same escrow.
    expect(doneSignedV2(k.publicKey, sig, { ...at, escrow: at.escrow.toUpperCase().replace('0X', '0x') as Hex })).toBe(true)
    for (const other of [{ ...at, depositId: '8' }, { ...at, depositId: '70' }, { ...at, chainId: 1 }, { ...at, escrow: testAddress(6) }]) {
      expect(doneSignedV2(k.publicKey, sig, other)).toBe(false)
    }
    expect(doneSignedV2(createBrowserReplyKey().publicKey, sig, at)).toBe(false)
    expect(doneSignedV2(k.publicKey, `${sig}00` as Hex, at)).toBe(false)
    expect(doneSignedV2(k.publicKey, `0x${'0'.repeat(128)}`, at)).toBe(false)
    expect(doneSignedV2('0x02' + 'f'.repeat(64), sig, at)).toBe(false)
  })

  it('a restart forgets every done, and the leftover simply rests its two hours', async () => {
    const t = await world()
    const { a, pa, c20, c5, next } = await leftoverOnScreen(t)
    await a.done(pa, 1)
    await vi.waitFor(() => expect(t.server.dones).toEqual([{ status: 200, error: null }]))
    expect((await quote(next, 400)).legs.map((l) => l.ref)).toEqual([escrowIntentIdFor(c20.listingId)])
    // The marks lived in that server's memory only.
    __clearLeftoverDoneForTests()
    expect((await quote(next, 400)).legs.map((l) => l.ref)).toEqual([escrowIntentIdFor(c5.listingId)])
    t.w.node.advance(REST_S)
    expect((await quote(next, 400)).legs.map((l) => l.ref)).toEqual([escrowIntentIdFor(c20.listingId)])
  })

  it('only a card the register took is said done: Next past a used-up card says nothing, Done on the last once, "Register says paid" early nothing', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 2_000, 80)
    await card(t, 1_600)
    const backend = dollars(t, shopper)
    const p = await payNow(backend, await quote(backend, 3_213))
    // Card 1 is used up: nothing is left on it for anyone.
    await backend.next(p, 1)
    expect(doneBodies(t)).toEqual([])
    await backend.done(p, 2)
    expect(doneBodies(t)).toHaveLength(1)
    const last = (await shopper.book.purchase(p.ref))?.legs[1]
    expect(JSON.parse(doneBodies(t)[0] ?? '{}')).toEqual({ escrow: t.w.escrow, depositId: last?.depositId, replyKey: last?.replyPublicKey, signature: last?.doneProof?.signature })
    await vi.waitFor(() => expect(t.server.dones).toEqual([{ status: 200, error: null }]))

    // Another purchase, the register paid after card 1: card 2 was never drawn, so it is kept, never said done.
    const sent = doneBodies(t).length
    const other = await phoneV2(t, 'shopper')
    await card(t, 2_000, 80)
    await card(t, 1_600)
    const b2 = dollars(t, other, { ownCards: other.store })
    const p2 = await payNow(b2, await quote(b2, 3_213))
    expect((await b2.done(p2, 1)).note).toBe('Card 2 was not scanned. Its $16.00 is in your store credit now.')
    expect(doneBodies(t)).toHaveLength(sent)
  })

  it('the route takes only its own exact body, from our own pages, and only while the rail is open', async () => {
    const t = await world()
    const { first, pa } = await leftoverOnScreen(t)
    const leg = (await first.book.purchase(pa.ref))?.legs[0]
    if (leg === undefined || leg.doneProof === undefined) throw new Error('the card has no proof')
    const body = { escrow: t.w.escrow, depositId: leg.doneProof.depositId, replyKey: leg.replyPublicKey, signature: leg.doneProof.signature }
    const post = (b: unknown, headers: Record<string, string> = {}): Promise<Response> =>
      doneRoute(new Request('http://localhost:3000/api/escrow/done', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) }))
    expect((await post({ ...body, extra: 1 })).status).toBe(400)
    expect((await post({ ...body, depositId: '0' })).status).toBe(400)
    expect((await post({ ...body, signature: leg.doneProof.signature.toUpperCase() })).status).toBe(400)
    expect((await post(body, { origin: 'https://elsewhere.example' })).status).toBe(403)
    process.env.ESCROW_RAIL = 'off'
    expect((await post(body)).status).toBe(503)
    process.env.ESCROW_RAIL = 'testnet'
    const ok = await post(body)
    expect([ok.status, await ok.json()]).toEqual([200, { done: true }])
    // The same again answers the same.
    expect((await post(body)).status).toBe(200)
  })
})

describe('the fast path keeps every check', () => {
  it("asks Lit for the cards the moment one host has the receipt, and the second host's agreement runs beside it, never first", async () => {
    const t = await world()
    const shopper = chainClock(t, await phoneV2(t, 'shopper'))
    await card(t, 1_000)
    const backend = dollars(t, shopper)
    const plan = await quote(backend, 800)
    await backend.prepare(plan)
    // The second host shows no receipt until Lit has been asked for the card. A tap that waited for the
    // second host before asking Lit would wait out its timeout here; one that asks both at once goes through.
    t.w.node.setHost(1, {
      lie: (method, _params, result) => {
        if (method !== 'eth_getTransactionReceipt' || result === null) return result
        if (!t.server.events.includes('release')) return null
        t.server.events.push(`second host:${String((result as Record<string, unknown>).transactionHash)}`)
        return result
      },
    })
    const p = await payNow(backend, plan)
    const record = await shopper.book.purchase(p.ref)
    const firstRelease = t.server.events.indexOf('release')
    const agreed = t.server.events.indexOf(`second host:${record?.txHash ?? ''}`)
    expect(firstRelease).toBeGreaterThanOrEqual(0)
    expect(agreed).toBeGreaterThan(firstRelease)
    // Booked as paid only once both hosts agreed, and the card shown only once Lit released it.
    expect(record?.state).toBe('done')
    expect(record?.legs[0]?.released).toBe(true)
    expect(p.code.coversCents).toBe(800)
  })

  it('a second host that cannot be read: the card is not shown, the purchase is not booked as paid, and the same key finishes it later, paying once', async () => {
    const t = await world()
    const shopper = chainClock(t, await phoneV2(t, 'shopper'))
    const l = await card(t, 1_000)
    const backend = dollars(t, shopper)
    const plan = await quote(backend, 800)
    await backend.prepare(plan)
    t.w.node.setHost(1, { down: 'network' })
    const out = await backend.pay(plan, { key: 'tap-9' }).catch((e: unknown) => e)
    expect(out).toBeInstanceOf(TillRefused)
    expect(out).toMatchObject({ code: STILL_GOING })
    expect(t.layer.landed).toHaveLength(1)
    const [kept] = await shopper.book.purchases()
    expect(kept).toMatchObject({ state: 'signed', till: { key: 'tap-9' } })

    // The host is back: the same tap's key finds the purchase and finishes it.
    t.w.node.setHost(1, {})
    const p = await payNow(backend, plan, { key: 'tap-9' })
    expect(p.ref).toBe(kept?.id)
    expect(p.code.barcode).toBe(l.cardNumber)
    expect(t.layer.landed).toHaveLength(1)
    expect((await shopper.book.purchase(p.ref))?.state).toBe('done')
  })

  it("Tempo's host without the send that waits: sent plainly, its receipt asked for, the same purchase", async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    t.layer.syncSend = false
    const backend = dollars(t, shopper)
    const plan = await quote(backend, 600)
    await backend.prepare(plan)
    const asked = t.w.node.requests.length
    const p = await payNow(backend, plan)
    const sent = t.w.node.requests.slice(asked).filter((r) => r.method.startsWith('eth_sendRawTransaction'))
    expect(sent.map((r) => [r.method, r.host])).toEqual([
      ['eth_sendRawTransactionSync', 'https://rpc.moderato.tempo.xyz'],
      ['eth_sendRawTransaction', 'https://rpc.moderato.tempo.xyz'],
    ])
    expect(t.layer.landed).toHaveLength(1)
    expect(p.code.coversCents).toBe(600)
  })

  it('a filled batch whose nonce another send used is filled and signed again, and only the second is sent', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    const real = shopper.wallet
    let refused = 0
    const wallet: BatchSigner = {
      account: real.account,
      signCalls: (calls, access) => real.signCalls(calls, access),
      broadcast: (signed, access) => real.broadcast(signed, access),
      prepareCalls: (calls, access) => real.prepareCalls(calls, access),
      signPrepared: (b) => real.signPrepared(b),
      broadcastFast: async (signed, access) => {
        if (refused === 0) {
          refused += 1
          throw new EscrowRpcError('rpc.moderato.tempo.xyz', 'rpc', 'nonce too low: next nonce 1, tx nonce 0')
        }
        return real.broadcastFast(signed, access)
      },
    }
    const d: LoadDepsV2 = { ...loadDepsOf(t, shopper), wallet }
    const ask = { merchant: 'salvotest' as const, totalCents: 700, depositor: real.account, preference: IN_AND_OUT }
    const prepared = await prepareLoadV2(d, ask, await quoteTillV2(d, ask))
    expect(prepared.batch).not.toBeNull()
    const record = await executeLoadV2(d, prepared)
    expect(refused).toBe(1)
    expect(record.state).toBe('done')
    expect(t.layer.landed).toHaveLength(1)
    expect(t.layer.landed[0]?.hash).toBe(record.txHash)
  })
})

describe('the dollars tap, toward 2 s, keeping every check', () => {
  /** One host call or our server's answer, as it starts and as it ends, in order. */
  interface Seen {
    ev: 'start' | 'end'
    what: string
    host: string
    to: string
    data: string
    /** A block tag asked by name: 'finalized' for the agreed block's heads. */
    tag: string
  }

  /**
   * The phone's backend with every host call and every request to our server
   * kept in one list, in order. `slow`: a host call takes that long, real time.
   */
  async function traced(t: TillWorldV2, p: PhoneV2, more: Partial<DollarsBackendDeps> = {}): Promise<{ backend: DollarsBackendV2; log: Seen[]; slow: (ms: number) => void }> {
    const log: Seen[] = []
    let delay = 0
    const inner = p.access.hosts.fetchImpl as typeof fetch
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { method?: string; params?: unknown[] }
      const call = (body.params?.[0] ?? {}) as Record<string, unknown>
      const seen = {
        what: String(body.method),
        host: new URL(String(input)).host,
        to: typeof call.to === 'string' ? call.to.toLowerCase() : '',
        data: typeof call.data === 'string' ? call.data : '',
        tag: typeof body.params?.[0] === 'string' ? body.params[0] : '',
      }
      log.push({ ev: 'start', ...seen })
      try {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
        return await inner(input, init)
      } finally {
        log.push({ ev: 'end', ...seen })
      }
    }) as typeof fetch
    const api = new EscrowApiV2(
      async (path, init) => {
        log.push({ ev: 'start', what: path, host: 'salvo', to: '', data: '', tag: '' })
        try {
          return await t.server.fetch(path, init)
        } finally {
          log.push({ ev: 'end', what: path, host: 'salvo', to: '', data: '', tag: '' })
        }
      },
      t.pins,
      null,
    )
    const cfg = await api.config()
    if (cfg.state !== 'ready') throw new Error(`the V2 config is ${cfg.state}`)
    const backend = dollars(t, p, { api, config: cfg.config, access: { ...p.access, hosts: { ...p.access.hosts, fetchImpl } }, ...more })
    return { backend, log, slow: (ms) => (delay = ms) }
  }

  async function until(ok: () => boolean): Promise<void> {
    for (let i = 0; i < 1_000 && !ok(); i++) await new Promise((r) => setTimeout(r, 2))
    if (!ok()) throw new Error('until: it never happened')
  }

  /** A ticket our server holds until `open` is called: Lit still running. */
  function holdNextTicket(t: TillWorldV2): { open: () => void } {
    let open: () => void = () => undefined
    const held = new Promise<void>((r) => {
      open = r
    })
    t.server.beforeTicket = () => held
    return { open: () => open() }
  }

  const CARD_VIEWS = (['cardOwner', 'cardDeposit', 'cardListing'] as const).map((name) => toFunctionSelector(getAbiItem({ abi: ESCROW_V2_ABI, name }) as AbiFunction))
  const GATE = toFunctionSelector(getAbiItem({ abi: ESCROW_V2_ABI, name: 'gate' }) as AbiFunction)

  it('a host a block behind: every card is released on the first ask, the route waiting for that host rather than saying "not there yet"', async () => {
    __clearReleaseMemoryForTests()
    try {
      const t = await world()
      // The release asks the route's own check first, as the route does.
      t.server.routeChecks = true
      const shopper = await phoneV2(t, 'shopper')
      await card(t, 2_000, 80)
      await card(t, 1_600)
      const answers: number[] = []
      const api = new EscrowApiV2(
        async (path, init) => {
          const res = await t.server.fetch(path, init)
          if (path.endsWith('/release')) answers.push(res.status)
          return res
        },
        t.pins,
        null,
      )
      const cfg = await api.config()
      if (cfg.state !== 'ready') throw new Error(`the V2 config is ${cfg.state}`)
      // The phone's own waits (for the second host's receipt) take real time here and move nothing: only the
      // route's wait moves the chain on, so what the route saw is what this test is about.
      const hosts = { ...shopper.access.hosts, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20))) }
      const backend = dollars(t, shopper, { api, config: cfg.config, access: { ...shopper.access, hosts } })
      const plan = await quote(backend, 3_213)
      await backend.prepare(plan)
      // dRPC a block behind Tempo's own host, as measured on 2026-10-14.
      const lag = hostBehind(t)
      const p = await payNow(backend, plan, { key: 'tap-behind' })
      // The route's first read, at the block both hosts agreed on, did not show the purchase; it waited, and both cards came on the first ask.
      expect(lag.hidden()).toBeGreaterThan(0)
      expect(answers).toEqual([200, 200])
      expect(p.code.scanIndex).toBe(1)
      expect((await shopper.book.purchase(p.ref))?.state).toBe('done')
      const second = await backend.next(p, 1)
      expect(second.scanIndex).toBe(2)
      noCardAnywhere(t)
    } finally {
      __clearReleaseMemoryForTests()
    }
  })

  it('a tap before the prepare is done waits for it and says how long, and asks Lit for nothing more', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    const marks: Array<[TapStep, number]> = []
    const backend = dollars(t, shopper, { onMark: (step, ms) => marks.push([step, ms]) })
    const plan = await quote(backend, 800)
    t.server.beforeTicket = () => new Promise((r) => setTimeout(r, 80))
    // The keypad's prepare, still going at the tap.
    void backend.prepare(plan)
    await backend.prepare(plan, { tap: true })
    const p = await payNow(backend, plan)
    expect(p.code.coversCents).toBe(800)
    const waits = marks.filter(([step]) => step === 'ticket_wait')
    expect(waits).toHaveLength(1)
    expect(waits[0]?.[1]).toBeGreaterThanOrEqual(50)
    expect(marks.map(([step]) => step).slice(-6, -2)).toEqual(['reads', 'sign', 'send', 'included'])
    expect(t.server.calls.ticket).toBe(1)
  })

  it('a new total on other cards does not wait behind the tickets for the last one, which are dropped when they come, never used', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    const c10 = await card(t, 1_000)
    const c20 = await card(t, 2_000)
    const backend = dollars(t, shopper)
    const a = await quote(backend, 800)
    const held = holdNextTicket(t)
    const aPrepared = backend.prepare(a)
    await until(() => t.server.calls.ticket === 1)
    // The shopper went on typing: $19.00 needs the other card.
    const b = await quote(backend, 1_900)
    expect(b.legs.map((l) => l.ref)).toEqual([escrowIntentIdFor(c20.listingId)])
    await backend.prepare(b)
    expect(t.server.calls.ticket).toBe(2)
    held.open()
    await aPrepared
    const pb = await payNow(backend, b)
    expect(pb.code.barcode).toBe(c20.cardNumber)
    expect(t.server.calls.ticket).toBe(2)
    // What the first total fetched was dropped when it came: paying that plan asks Lit again, and pays with the new ticket.
    const pa = await payNow(backend, a)
    expect(t.server.calls.ticket).toBe(3)
    expect(pa.code.barcode).toBe(c10.cardNumber)
    expect(t.layer.landed).toHaveLength(2)
  })

  it('a new total on the same cards waits for the tickets being fetched and uses them: no second Lit run', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    const c10 = await card(t, 1_000)
    const backend = dollars(t, shopper)
    const a = await quote(backend, 800)
    const held = holdNextTicket(t)
    const aPrepared = backend.prepare(a)
    await until(() => t.server.calls.ticket === 1)
    const a2 = await quote(backend, 900)
    expect(a2.legs.map((l) => l.ref)).toEqual(a.legs.map((l) => l.ref))
    const a2Prepared = backend.prepare(a2)
    await new Promise((r) => setTimeout(r, 10))
    expect(t.server.calls.ticket).toBe(1)
    held.open()
    await Promise.all([aPrepared, a2Prepared])
    const p = await payNow(backend, a2)
    expect([p.code.barcode, p.code.coversCents]).toEqual([c10.cardNumber, 900])
    expect(t.server.calls.ticket).toBe(1)
  })

  it('the prepare asks Lit before reading the cards again, and after the tickets checks the cards they name in one round, at a block read while Lit ran', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 2_000, 80)
    await card(t, 1_600)
    const { backend, log } = await traced(t, shopper)
    const plan = await quote(backend, 3_213)
    log.length = 0
    await backend.prepare(plan)
    const starts = log.map((e, i) => ({ ...e, i })).filter((e) => e.ev === 'start')
    // Lit was asked at once: before the chain read the cards again (the quote's own check, a moment old, stood for them).
    const firstTicket = starts.find((e) => e.what === '/api/escrow/ticket')?.i ?? -1
    const firstGate = starts.find((e) => e.what === 'eth_call' && e.data.startsWith(GATE))?.i ?? -1
    expect(firstTicket).toBeGreaterThanOrEqual(0)
    expect(firstGate).toBeGreaterThan(firstTicket)
    // After the last ticket: no agreed block read (the fill asks Tempo's host for its latest block, for fees, and
    // that is all), and every card view on both hosts started before any answered.
    const lastTicket = log.map((e) => e.ev === 'end' && e.what === '/api/escrow/ticket').lastIndexOf(true)
    const tail = log.slice(lastTicket + 1)
    expect(tail.filter((e) => e.ev === 'start' && (e.what === 'eth_chainId' || e.tag === 'finalized'))).toEqual([])
    const isView = (e: Seen): boolean => e.what === 'eth_call' && CARD_VIEWS.some((s) => e.data.startsWith(s))
    const viewStarts = tail.map((e, i) => (e.ev === 'start' && isView(e) ? i : -1)).filter((i) => i >= 0)
    const firstViewEnd = tail.findIndex((e) => e.ev === 'end' && isView(e))
    expect(viewStarts).toHaveLength(12)
    expect(Math.max(...viewStarts)).toBeLessThan(firstViewEnd)
  })

  it('a tap long after the prepare reads again only what aged, the chain read and the fill at once, and no card', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    const marks: Array<[TapStep, number]> = []
    const { backend, log, slow } = await traced(t, shopper, { onMark: (step, ms) => marks.push([step, ms]) })
    const plan = await quote(backend, 800)
    await backend.prepare(plan)
    log.length = 0
    // Every host call takes 25 ms from here, and the tap comes 31 s after the prepare: its chain read and its fill have both aged.
    slow(25)
    const real = Date.now.bind(Date)
    const later = vi.spyOn(Date, 'now').mockImplementation(() => real() + 31_000)
    let p: Purchase
    try {
      p = await payNow(backend, plan)
    } finally {
      later.mockRestore()
      slow(0)
    }
    expect(p.code.coversCents).toBe(800)
    const sent = log.findIndex((e) => e.ev === 'start' && e.what.startsWith('eth_sendRawTransaction'))
    const before = log.slice(0, sent)
    // No card read again, and no ticket.
    expect(before.filter((e) => e.ev === 'start' && e.to === t.w.escrow)).toEqual([])
    expect(before.filter((e) => e.host === 'salvo')).toEqual([])
    // The chain read and the fill went out together: each had a call going before the first answer came back.
    const firstEnd = before.findIndex((e) => e.ev === 'end')
    const together = before.slice(0, firstEnd).map((e) => e.what)
    expect(together).toContain('eth_chainId')
    expect(together.some((m) => FILL_METHODS.has(m) || m === 'eth_call')).toBe(true)
    expect(marks.find(([step]) => step === 'reads')?.[1] ?? 0).toBeGreaterThanOrEqual(25)
  })
})

describe('a Pay is asked about again by its key, and never pays twice', () => {
  it("a Pay whose cards did not come back keeps its key; the next tap with it finishes the purchase and takes the shopper's own credit once", async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    const typed = testCardNumberV2()
    await shopper.store.saveOwnCard({ id: 'typed-1', merchant: 'salvotest', balanceCents: 300, last4: typed.slice(-4), addedAt: 1 }, { cardNumber: typed, pin: null })
    const c = await card(t, 1_000)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const plan = await quote(backend, 1_000)
    expect(plan.legs.map((l) => [l.source, l.appliedCents])).toEqual([
      ['own_credit', 300],
      ['fresh', 700],
    ])
    await backend.prepare(plan)
    t.server.releaseFails = 1
    const first = await backend.pay(plan, { key: 'tap-2' }).catch((e: unknown) => e)
    expect(first).toMatchObject({ code: STILL_GOING })
    // Nothing of the shopper's own credit is taken until the purchase is finished.
    expect((await shopper.store.ownCards())[0]?.balanceCents).toBe(300)
    expect((await shopper.book.purchases())[0]?.till).toMatchObject({ key: 'tap-2', own: [{ appliedCents: 300 }], ownTaken: false })

    const p = await payNow(backend, plan, { key: 'tap-2' })
    expect(p.code.barcode).toBe(typed)
    expect((await backend.next(p, 1)).barcode).toBe(c.cardNumber)
    expect((await shopper.store.ownCards())[0]?.balanceCents).toBe(0)
    // Asked again with the same key: the same purchase, nothing paid or taken again.
    const again = await payNow(backend, plan, { key: 'tap-2' })
    expect(again.ref).toBe(p.ref)
    expect(t.layer.landed).toHaveLength(1)
    expect((await shopper.store.ownCards())[0]?.balanceCents).toBe(0)

    // A key whose tap never signed anything: nothing was charged, said plainly.
    const never = await backend.pay(plan, { key: 'tap-never', resume: true }).catch((e: unknown) => e)
    expect(never).toBeInstanceOf(LoadRefused)
    expect(never).toMatchObject({ code: 'not_charged', message: expect.stringContaining('nothing was charged') })
  })

  it('a retry after the keypad priced the total again: the key finds the purchase as it was paid, never the new plan, and pays once', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    const c20 = await card(t, 2_000, 80)
    const c16 = await card(t, 1_600)
    const backend = dollars(t, shopper)
    const plan = await quote(backend, 3_213)
    await backend.prepare(plan)
    t.server.releaseFails = 1
    expect(await backend.pay(plan, { key: 'tap-r' }).catch((e: unknown) => e)).toMatchObject({ code: STILL_GOING })
    // Back on the keypad, the same total priced again: the $20 card is drained now, so the new plan names other cards.
    await card(t, 3_000)
    const again = await quote(backend, 3_213)
    expect(again.legs.map((l) => l.ref)).not.toEqual(plan.legs.map((l) => l.ref))
    // The finding: the purchase was rebuilt from this plan, "not on this phone", the key ended, and the next tap paid again.
    const p = await payNow(backend, again, { key: 'tap-r' })
    expect(p.plan.legs.map((l) => [l.ref, l.appliedCents])).toEqual(plan.legs.map((l) => [l.ref, l.appliedCents]))
    expect(p.plan.totalCents).toBe(3_213)
    expect(p.code.barcode).toBe(c20.cardNumber)
    expect((await backend.next(p, 1)).barcode).toBe(c16.cardNumber)
    expect(t.layer.landed).toHaveLength(1)
  })

  it('a retry for a lower total on the same card comes back for the total it paid, so the till changes it to the one typed', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    const backend = dollars(t, shopper)
    const plan = await quote(backend, 800)
    t.server.releaseFails = 1
    expect(await backend.pay(plan, { key: 'tap-low' }).catch((e: unknown) => e)).toMatchObject({ code: STILL_GOING })
    // The register said $1.00 after all: the same card, its own leftover, priced again.
    const lower = await quote(backend, 100)
    expect(lower.legs.map((l) => l.ref)).toEqual(plan.legs.map((l) => l.ref))
    // The finding: it came back "covers $1.00", so the till never changed the total, while the chain booked $8.00 used.
    const p = await payNow(backend, lower, { key: 'tap-low' })
    expect(p.plan.totalCents).toBe(800)
    expect(p.code.coversCents).toBe(800)
    expect((await shopper.book.purchase(p.ref))?.legs[0]?.usedCents).toBe(800)
    const landed = await landPurchase(backend, p, 100)
    // $9.00 would stay on it, past its $5.00 cap: not to be scanned; "not used" keeps it as the shopper's.
    expect(landed.phase).toMatchObject({ kind: 'scan', tooLow: true })
    expect(t.layer.landed).toHaveLength(1)
  })

  it('once this phone keeps a purchase under a key, a refusal on the way to its first code never ends the key', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    const backend = dollars(t, shopper)
    const plan = await quote(backend, 600)
    t.server.releaseFails = 1
    expect(await backend.pay(plan, { key: 'tap-keep' }).catch((e: unknown) => e)).toMatchObject({ code: STILL_GOING })
    // A purchase kept before its plan was (an earlier build), asked again with a plan for cards it never bought.
    const [kept] = await shopper.book.purchases()
    if (kept === undefined || kept.till === undefined) throw new Error('no purchase kept')
    delete kept.till.plan
    await shopper.book.savePurchase(kept)
    const other = { ...plan, legs: plan.legs.map((l) => ({ ...l, ref: 'somebody-else' })) }
    const out = await backend.pay(other, { key: 'tap-keep' }).catch((e: unknown) => e)
    expect(out).toBeInstanceOf(TillRefused)
    expect(out).toMatchObject({ code: STILL_GOING })
    // Asked again the right way, it is the one purchase, paid once.
    const p = await payNow(backend, plan, { key: 'tap-keep' })
    expect(p.ref).toBe(kept.id)
    expect(t.layer.landed).toHaveLength(1)
  })

  it('a card another shopper used after the quote: Pay answers a new price, and nothing is charged', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    const a = await card(t, 1_000)
    const b = await card(t, 1_000)
    const backend = dollars(t, shopper)
    const plan = await quote(backend, 800)
    const planned = [a, b].find((x) => escrowIntentIdFor(x.listingId) === plan.legs[0]?.ref)
    if (planned === undefined) throw new Error('the plan names neither card')
    await useCardV2(t.w, planned, SHOPPER_C, 1_000)
    const out = await backend.pay(plan, { key: 'tap-3' })
    expect(out).toMatchObject({ requote: { totalCents: 800 }, message: 'Another shopper just used one of those cards.' })
    expect(t.layer.landed).toHaveLength(0)
    if (!('requote' in out)) throw new Error('no new price')
    const p = await payNow(backend, out.requote)
    expect(p.code.coversCents).toBe(800)
  })
})

describe('the total changes, and a card is reported', () => {
  it('the total came down past what the card on screen may keep: it must not be scanned, "not used" makes it the shopper\'s credit, and it pays the rest', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    await card(t, 2_000)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const plan = await quote(backend, 2_600)
    expect(plan.legs.map((l) => l.leftoverCents)).toEqual([0, 400])
    const firstCovers = plan.legs[0]?.appliedCents ?? 0
    const face = plan.legs[1]?.faceCents ?? 0
    const p = await payNow(backend, plan)
    const code = await backend.next(p, 1)

    // Not needed at all: the card before it covers the new total.
    const notNeeded = await backend.changeTotal({ ...p, code }, firstCovers - 100)
    expect(notNeeded).toMatchObject({ owed: null, tooLow: true, notNeeded: true })

    // 3.00 more than card 1: card 2 would keep more than its cap for the next shopper.
    const change = await backend.changeTotal({ ...p, code }, firstCovers + 300)
    expect(change).toMatchObject({ owed: null, tooLow: true, notNeeded: false })
    const out = await backend.report(change.purchase, 2, 'not_used')
    expect(out.owedCents).toBe(300)
    expect(out.kept).toBeNull()
    expect((out.owed as RoutePlan).legs.map((l) => [l.source, l.appliedCents, l.costCents])).toEqual([['own_credit', 300, 0]])
    const phase = phaseAfterReport(out, change.purchase, [change.purchase], 'not_used')
    expect(phase.kind).toBe('owed')
    expect(owedLine('not_used', null, 'stablecoin')).toBe(NOT_USED_KEPT)
    // Card 2 itself, now the shopper's credit, pays the rest: the till starts it at once, saying so (the finding put a
    // "Pay $0.00 more" tap between "Do not scan this card" and that same card's code), and never labels it a payment.
    expect(costsNothing(out.owed as RoutePlan)).toBe(true)
    expect(owedStartsAtOnce(out, 'not_used')).toBe(true)
    expect(payMoreLabel(out.owed as RoutePlan)).toBe('Use $3.00 of your store credit · 1 card')
    const rest = await payNow(backend, out.owed as RoutePlan, { after: change.purchase })
    expect(rest.code.barcode).toBe(code.barcode)
    await backend.done(rest, 1)
    const credit = (await shopper.store.ownCards()).find((c) => c.keptCardId !== undefined)
    expect(credit?.balanceCents).toBe(face - 300)
  })

  it('after Done, from a fresh screen with only the handle: "empty" inside two hours is a contest, after them a dispute, and each is said', async () => {
    const t = await world()
    const first = await phoneV2(t, 'shopper')
    await card(t, 2_000)
    const a = dollars(t, first)
    await a.done(await payNow(a, await quote(a, 1_600)), 1)
    t.w.node.advance(REST_S)

    const next = await phoneV2(t, 'shopper')
    const b = dollars(t, next)
    const p = await payNow(b, await quote(b, 400))
    expect(p.plan.legs[0]).toMatchObject({ source: 'remainder', costCents: 360 })
    await b.done(p, 1)
    // Account, later: a new screen, the handle the phone kept, and nothing else.
    const handle = { rail: p.rail, ref: p.ref, plan: p.plan }
    const account = dollars(t, next)
    const before = await account.receipt(handle)
    expect(before).toEqual({ paidCents: 360, savedCents: 40, depositCents: 0, keptCents: 0 })
    const empty = await account.report(handle, 1, 'empty')
    expect(empty.note).toBe('Got it. Your $3.60 for that card is back in your dollars.')
    expect(empty.owed).toBeNull()
    expect(empty.receipt).toEqual({ paidCents: 0, savedCents: 0, depositCents: 0, keptCents: 0 })

    // A fresh card bought, its two hours long gone: anything wrong with it is a dispute the seller can refund.
    await card(t, 500)
    const p2 = await payNow(b, await quote(b, 500))
    await b.done(p2, 1)
    t.w.node.advance(7_201)
    const problem = await dollars(t, next).report({ rail: p2.rail, ref: p2.ref, plan: p2.plan }, 1, 'problem')
    expect(problem.note).toBe('Got it. The seller’s payment for that card waits 48 hours, so they can refund you.')
    const sale = await depositV2At(t.hosts, await agreedFinalizedBlock(t.hosts), t.w.escrow, BigInt((await next.book.purchase(p2.ref))?.legs[0]?.depositId ?? '0'))
    expect(sale).toMatchObject({ state: V2_STATE.deposit.OPENED, disputed: true })
  })

  it('"not used" after the total came down: a card the next plan scans first is never said to be store credit now', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    for (let i = 0; i < 3; i++) await card(t, 1_000)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const plan = await quote(backend, 2_800, { mode: 'most_savings', maxCards: 3 })
    expect(plan.legs.map((l) => [l.appliedCents, l.leftoverCents])).toEqual([
      [1_000, 0],
      [1_000, 0],
      [800, 200],
    ])
    const p = await payNow(backend, plan)
    const code = await backend.next(p, 1)
    // $14.00 now: card 3 is closed into store credit, and card 2 would keep $6.00, past its cap.
    const change = await backend.changeTotal({ ...p, code }, 1_400)
    expect(change).toMatchObject({ owed: null, tooLow: true, notNeeded: false })
    const out = await backend.report(change.purchase, 2, 'not_used')
    // What is still owed comes from that store credit, card 3 first.
    const owed = out.owed as RoutePlan
    expect(owed.legs.map((l) => [l.source, l.appliedCents])).toEqual([['own_credit', 400]])
    expect(owedStartsAtOnce(out, 'not_used')).toBe(true)
    // The finding: "Card 3 was not scanned. Its $10.00 is in your store credit now." over a plan that scans card 3 next.
    expect(out.note).toBeNull()
  })
})

describe('a reload with a card on screen loses nothing the shopper paid for', () => {
  const LEFT = 'At the Salvo test store, a card your last purchase did not show is in your store credit now.'

  it('the till offers the purchase again, on the card that was showing, and it pays once', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 2_000, 80)
    const c16 = await card(t, 1_600)
    const tab = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(tab, await quote(tab, 3_213), { key: 'tap-reload' })
    expect((await tab.next(p, 1)).barcode).toBe(c16.cardNumber)
    // The page goes with "Scan 2 of 2" showing. The till on the same phone, opened again:
    const again = dollars(t, shopper, { ownCards: shopper.store })
    const found = await again.unfinishedPays()
    // The finding: nothing was offered, and both cards were paid with nothing left to show them.
    expect(found).toMatchObject([{ key: 'tap-reload', store: 'salvotest', open: { shown: 2, scanOf: 2 } }])
    const first = found[0]
    if (first === undefined) throw new Error('nothing offered')
    const back = await again.pay(first.plan, { key: first.key, resume: true })
    if ('requote' in back || 'ended' in back) throw new Error('the purchase did not come back on screen')
    expect(back.ref).toBe(p.ref)
    expect(back.code).toMatchObject({ scanIndex: 2, scanOf: 2, barcode: c16.cardNumber })
    expect(t.layer.landed).toHaveLength(1)
    expect(await again.done(back, 2)).toEqual({ paidCents: 2_692, savedCents: 521, depositCents: 387, keptCents: 0 })
    // Done is kept too: nothing is offered again, and asked again by its key it has ended.
    const later = dollars(t, shopper, { ownCards: shopper.store })
    expect(await later.unfinishedPays()).toEqual([])
    expect(await later.pay(first.plan, { key: first.key, resume: true })).toMatchObject({ ended: { ref: p.ref }, message: 'That Pay already went through. It is in Account.' })
  })

  it('left on a screen nobody opens: every card it never drew is store credit, its leftover off sale, and the card that showed is offered again until it rests', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 2_000, 80)
    const c16 = await card(t, 1_600)
    const tab = dollars(t, shopper, { ownCards: shopper.store })
    await payNow(tab, await quote(tab, 3_213), { key: 'tap-left' })
    // "Scan 1 of 2" showing, and the page goes. Twenty minutes later the till opens again.
    let clock = Date.now() + 20 * 60_000
    const later = dollars(t, shopper, { ownCards: shopper.store, now: () => clock })
    // The finding: card 2, paid for and never drawn, was nobody's: no code anywhere, no store credit, its rest still on sale.
    expect(await later.catchUp()).toEqual({ kept: 0, reported: 0, waiting: 0, said: [LEFT] })
    expect((await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)).map((c) => c.balanceCents)).toEqual([1_600])
    expect((await listingV2At(t.hosts, await agreedFinalizedBlock(t.hosts), t.w.escrow, c16.listingId)).state).toBe(V2_STATE.listing.DRAINED)
    // Given back once.
    expect(await dollars(t, shopper, { ownCards: shopper.store, now: () => clock }).catchUp()).toEqual({ kept: 0, reported: 0, waiting: 0 })
    // The card that was showing is still offered, now the purchase's last.
    const found = await later.unfinishedPays()
    expect(found).toMatchObject([{ key: 'tap-left', open: { shown: 1, scanOf: 1 } }])
    const back = await later.pay(found[0]?.plan as RoutePlan, { key: 'tap-left', resume: true })
    expect(back).toMatchObject({ code: { scanIndex: 1, scanOf: 1 } })
    // Rested, it is no longer offered: by then the rest of a card may be another shopper's.
    clock += LEFTOVER_REST_MS
    expect(await dollars(t, shopper, { ownCards: shopper.store, now: () => clock }).unfinishedPays()).toEqual([])
    // The one Pay (a card opened each for both cards), and the keep that made card 2 theirs: never a second Pay.
    expect(t.layer.landed.flatMap((b) => b.calls.map((c) => c.data.slice(0, 10))).filter((s) => s === DEPOSIT_AND_OPEN)).toHaveLength(2)
  })

  it('a purchase paid from store credit alone: found by its key after the page dies, taken off once, and what it never showed goes back', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    const typedA = await ownCard(shopper, 'typed-a', 300, 1)
    await ownCard(shopper, 'typed-b', 500, 2)
    const balances = async () => Object.fromEntries((await shopper.store.ownCards()).map((c) => [c.id, c.balanceCents]))
    const tab = dollars(t, shopper, { ownCards: shopper.store })
    const plan = await quote(tab, 700)
    expect(plan.legs.map((l) => [l.source, l.appliedCents])).toEqual([
      ['own_credit', 300],
      ['own_credit', 400],
    ])
    const p = await payNow(tab, plan, { key: 'tap-own' })
    expect(p.code.barcode).toBe(typedA)
    expect(await balances()).toEqual({ 'typed-a': 0, 'typed-b': 100 })
    // The page dies before the till hears back, so its key is still kept. The finding: "Check it" said nothing was
    // charged, with the store credit already taken off.
    let clock = Date.now()
    const again = dollars(t, shopper, { ownCards: shopper.store, now: () => clock })
    const back = await again.pay(plan, { key: 'tap-own', resume: true })
    expect(back).toMatchObject({ ref: p.ref, code: { scanIndex: 1, barcode: typedA } })
    expect(await balances()).toEqual({ 'typed-a': 0, 'typed-b': 100 })
    // Left there: the card it never showed goes back on the store credit, whole, once.
    clock += 20 * 60_000
    expect((await dollars(t, shopper, { ownCards: shopper.store, now: () => clock }).catchUp()).said).toEqual([LEFT])
    expect(await balances()).toEqual({ 'typed-a': 0, 'typed-b': 500 })
    expect((await dollars(t, shopper, { ownCards: shopper.store, now: () => clock }).catchUp()).said).toBeUndefined()
    expect(await balances()).toEqual({ 'typed-a': 0, 'typed-b': 500 })
    expect(t.layer.landed).toHaveLength(0)
  })

  it('a card the shopper was told not to scan comes back as that after a reload, never as a code to scan, and "not used" still keeps it', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    const c20 = await card(t, 2_000)
    const tab = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(tab, await quote(tab, 1_600), { key: 'tap-low' })
    expect(p.code).toMatchObject({ coversCents: 1_600, leftoverCents: 400, depositCents: 400 })
    // $10.00 now: $10.00 would stay on the card, past its $5.00 cap. It must not be scanned.
    expect(await tab.changeTotal(p, 1_000)).toMatchObject({ owed: null, tooLow: true, notNeeded: false })
    // The page goes before the shopper taps "Use it as your store credit". The till on the same phone, opened again:
    const again = dollars(t, shopper, { ownCards: shopper.store })
    const found = await again.unfinishedPays()
    expect(found).toMatchObject([{ key: 'tap-low', open: { shown: 1, scanOf: 1 } }])
    const back = await again.pay(found[0]?.plan as RoutePlan, { key: 'tap-low', resume: true })
    if ('requote' in back || 'ended' in back) throw new Error('the purchase did not come back on screen')
    // The finding: "Show it" brought back a code to scan that said it covered $16.00, with Done under it; scanned, the
    // register took $10.00 of it and Done settled it as used at $16.00.
    expect(back.standing).toMatchObject({ owed: null, tooLow: true, notNeeded: false })
    const shown = phaseOnScreen(back)
    expect(shown.phase).toMatchObject({ kind: 'scan', tooLow: true, notNeeded: false, then: null })
    expect(shown.error).toBeNull()
    expect('standing' in shown.phase.purchase).toBe(false)
    // "Use it as your store credit": the card is theirs, and pays the $10.00 from their credit, as on the screen that went.
    const out = await again.report(shown.phase.purchase, 1, 'not_used')
    expect(out.owedCents).toBe(1_000)
    expect(owedStartsAtOnce(out, 'not_used')).toBe(true)
    const rest = await payNow(again, out.owed as RoutePlan, { after: shown.phase.purchase })
    expect(rest.code.barcode).toBe(c20.cardNumber)
    await again.done(rest, 1)
    expect((await shopper.store.ownCards()).find((c) => c.keptCardId !== undefined)?.balanceCents).toBe(1_000)
    expect(t.layer.landed.flatMap((b) => b.calls.map((c) => c.data.slice(0, 10))).filter((s) => s === DEPOSIT_AND_OPEN)).toHaveLength(1)
  })

  it('a card left on a screen nobody opens, marked not to be scanned, is store credit, never counted as used', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 2_000, 80)
    const c16 = await card(t, 1_600)
    const tab = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(tab, await quote(tab, 3_213), { key: 'tap-not-needed' })
    const code = await tab.next(p, 1)
    // $19.00 now: card 1 covers it, so card 2 is not needed at all.
    expect(await tab.changeTotal({ ...p, code }, 1_900)).toMatchObject({ owed: null, tooLow: true, notNeeded: true })
    // Opened again soon, it is shown as it stood: Done, not a code to scan.
    let clock = Date.now()
    const soon = await dollars(t, shopper, { ownCards: shopper.store, now: () => clock }).pay(p.plan, { key: 'tap-not-needed', resume: true })
    expect(soon).toMatchObject({ code: { scanIndex: 2, scanOf: 2 }, standing: { tooLow: true, notNeeded: true, owed: null } })
    // Then left. Twenty minutes later the till opens again.
    clock += 20 * 60_000
    const later = dollars(t, shopper, { ownCards: shopper.store, now: () => clock })
    // The finding: the card was the purchase's last shown, so it counted as used at $12.13 once its leftover rested,
    // and the $3.87 the chain still listed went to the next shopper's register.
    expect(await later.catchUp()).toEqual({ kept: 0, reported: 0, waiting: 0, said: ['At the Salvo test store, the card you were told not to scan is in your store credit now.'] })
    expect((await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)).map((c) => c.balanceCents)).toEqual([1_600])
    expect((await listingV2At(t.hosts, await agreedFinalizedBlock(t.hosts), t.w.escrow, c16.listingId)).state).toBe(V2_STATE.listing.DRAINED)
    // Once: the next catch-up gives nothing back again, and the purchase is no longer offered.
    expect(await dollars(t, shopper, { ownCards: shopper.store, now: () => clock }).catchUp()).toEqual({ kept: 0, reported: 0, waiting: 0 })
    expect(await later.unfinishedPays()).toEqual([])
    // What it came to: card 1, which the register took, as paid; card 2 as store credit, never as used.
    const ended = await later.pay(p.plan, { key: 'tap-not-needed', resume: true })
    expect(ended).toMatchObject({ ended: { ref: p.ref }, receipt: { paidCents: 1_600, savedCents: 400, depositCents: 0, keptCents: 0, creditPaidCents: 1_440 } })
  })

  it('the rest still owed under a card after the total went up is planned again after a reload, never dropped for Done', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    const tab = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(tab, await quote(tab, 800), { key: 'tap-up' })
    const c5 = await card(t, 500)
    const change = await tab.changeTotal(p, 1_150)
    expect((change.owed as RoutePlan).totalCents).toBe(150)
    // The page goes with "Scanned · pay $1.50 more" under the card. Opened again:
    const again = dollars(t, shopper, { ownCards: shopper.store })
    const back = await again.pay(p.plan, { key: 'tap-up', resume: true })
    if ('requote' in back || 'ended' in back) throw new Error('the purchase did not come back on screen')
    // The finding: it came back with Done alone, and Done ended on a receipt while the register still wanted $1.50.
    const shown = phaseOnScreen(back)
    expect(shown.phase).toMatchObject({ tooLow: false, code: { scanIndex: 1, scanOf: 1, coversCents: 1_000, leftoverCents: 0 } })
    const then = shown.phase.then
    if (then === null) throw new Error('the rest was not planned again')
    expect(then.legs.map((l) => [l.source, l.appliedCents])).toEqual([['fresh', 150]])
    // "Scanned · pay $1.50 more": the card is settled, and the rest is paid with the plan made here.
    await again.done(shown.phase.purchase, 1)
    const rest = await payNow(again, then, { after: shown.phase.purchase })
    expect(rest.code.barcode).toBe(c5.cardNumber)
  })

  it('store credit that covers the total is offered and pays with no dollars to spend on this phone', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    const typed = await ownCard(shopper, 'typed-c', 1_600, 1)
    await card(t, 2_000)
    // No dollars key here: the dollars check says it cannot pay.
    const backend = dollars(t, shopper, { ownCards: shopper.store, wallet: null, account: shopper.wallet.account })
    const method = await backend.method()
    expect(method).toMatchObject({ ready: false, checked: true })
    const plan = await quote(backend, 1_200)
    expect(costsNothing(plan)).toBe(true)
    // The finding: the till offered the other way only when it was ready, so the card was charged $12.00.
    expect(otherWayPlan(method, plan)).toBe(plan)
    const p = await payNow(backend, plan)
    expect(p.code.barcode).toBe(typed)
    expect(t.layer.landed).toHaveLength(0)
  })

  it('store credit that does not cover the total, on a phone with no dollars set up: said as that, never "not enough" with cards on sale', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await ownCard(shopper, 'typed-c', 3_000, 1)
    await card(t, 2_000)
    const notSetUp = 'Allow this phone to pay with dollars in Account: one Face ID.'
    // The finding: $30 of credit, $40 typed, a $20 card on sale, and the till said there was not enough at the store.
    const noKey = dollars(t, shopper, { ownCards: shopper.store, wallet: null, account: shopper.wallet.account })
    expect(await noKey.quote({ merchant: 'salvotest', totalCents: 4_000, preference: IN_AND_OUT })).toEqual({ unavailable: notSetUp })
    // A key for another escrow only: the new escrow is named, as the dollars check names it.
    const oldKey = dollars(t, shopper, { ownCards: shopper.store, config: { ...shopper.config, escrow: testAddress(9) } })
    const newEscrow = 'Salvo Pay has a new escrow. Allow this phone to spend on it in Account: one Face ID.'
    expect(await oldKey.method()).toMatchObject({ ready: false, problem: newEscrow })
    expect(await oldKey.quote({ merchant: 'salvotest', totalCents: 4_000, preference: IN_AND_OUT })).toEqual({ unavailable: newEscrow })
    // What the credit covers is still a plan, and nothing was asked of the server for the rest.
    expect(costsNothing(await quote(noKey, 2_500))).toBe(true)
    expect(t.server.calls.quote).toBe(0)
  })
})

describe('what the chain did not take is said, kept, and sent when the till opens again', () => {
  it('a card the register did not need: the receipt says it is not credit yet, and the till opening again makes it credit, once', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 500)
    await card(t, 600)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(backend, await quote(backend, 900))
    // "Register says paid" after card 1. Keeping card 2 (its rest bought out of the deposit) does not get through.
    dropSends(shopper)
    const receipt = await backend.done(p, 1)
    // The finding: swallowed, it was never drawn, never credit, and nothing asked again.
    expect(receipt.note).toBe('A card the register did not need is not in your store credit yet. Salvo asks again each time you open the till or Account.')
    expect(await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)).toEqual([])
    expect((await shopper.book.purchase(p.ref))?.pendingKeeps).toMatchObject([{ scanOrder: 2, takenCents: 0 }])
    // The till opens again, on a fresh screen.
    const again = dollars(t, shopper, { ownCards: shopper.store })
    expect(await again.catchUp()).toEqual({ kept: 1, reported: 0, waiting: 0 })
    const credit = await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)
    expect(credit.map((c) => c.balanceCents)).toEqual([600])
    expect((await shopper.book.purchase(p.ref))?.pendingKeeps).toEqual([])
    // Asked again: nothing left, and kept once.
    expect(await again.catchUp()).toEqual({ kept: 0, reported: 0, waiting: 0 })
    expect(await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)).toHaveLength(1)
  })

  it('"not used" on a card the chain did not keep now says so, never that it is store credit', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    await card(t, 2_000)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(backend, await quote(backend, 2_600))
    const code = await backend.next(p, 1)
    const change = await backend.changeTotal({ ...p, code }, 1_300)
    expect(change).toMatchObject({ tooLow: true })
    dropSends(shopper)
    const out = await backend.report(change.purchase, 2, 'not_used')
    expect(out.line).toBe('That card was not used. It goes into your store credit once the chain takes it: Salvo asks again each time you open the till or Account.')
    expect(phaseAfterReport(out, change.purchase, [change.purchase], 'not_used')).toMatchObject({ line: out.line })
    expect(await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)).toEqual([])
    expect(await dollars(t, shopper, { ownCards: shopper.store }).catchUp()).toMatchObject({ kept: 1 })
    expect((await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)).map((c) => c.balanceCents)).toEqual([2_000])
  })

  it("a report after Done that did not reach the chain: said as not sent, and sent when the till opens again; the money comes back then", async () => {
    const t = await world()
    const first = await phoneV2(t, 'shopper')
    await card(t, 2_000)
    const a = dollars(t, first)
    await a.done(await payNow(a, await quote(a, 1_600)), 1)
    t.w.node.advance(REST_S)
    const next = await phoneV2(t, 'shopper')
    const b = dollars(t, next)
    const p = await payNow(b, await quote(b, 400))
    await b.done(p, 1)
    const handle = { rail: p.rail, ref: p.ref, plan: p.plan }
    dropSends(next)
    const empty = await dollars(t, next).report(handle, 1, 'empty')
    // The finding: the note said to open the till to send it, and opening the till sent nothing.
    expect(empty.note).toBe('Got it. The report is saved on this phone and has not reached the chain yet. Salvo sends it again each time you open the till or Account.')
    expect((await next.book.purchase(p.ref))?.pendingReports).toHaveLength(1)
    expect(await dollars(t, next).catchUp()).toEqual({ kept: 0, reported: 1, waiting: 0 })
    expect((await next.book.purchase(p.ref))?.pendingReports).toEqual([])
    expect(await dollars(t, next).receipt(handle)).toEqual({ paidCents: 0, savedCents: 0, depositCents: 0, keptCents: 0 })
  })

  it("the card on screen did not work and its report did not land: said, never as the seller's payment waiting; sent when the till opens again", async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    await card(t, 500)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(backend, await quote(backend, 1_500))
    dropSends(shopper)
    const out = await backend.report(p, 1, 'declined')
    expect(out.line).toBe('That card did not work. Your report has not reached the chain yet. It is saved on this phone and sent again each time you open the till or Account.')
    const record = await shopper.book.purchase(p.ref)
    expect(record?.pendingReports).toHaveLength(1)
    expect(await dollars(t, shopper, { ownCards: shopper.store }).catchUp()).toMatchObject({ reported: 1 })
    const depositId = BigInt(record?.legs.find((l) => l.scanOrder === 1)?.depositId ?? '0')
    expect(await depositV2At(t.hosts, await agreedFinalizedBlock(t.hosts), t.w.escrow, depositId)).toMatchObject({ disputed: true })
  })

  it("the shopper's own card did not work: said as theirs, still in their store credit, never as a seller's refund", async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await ownCard(shopper, 'typed-own', 300, 1)
    await card(t, 1_000)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const plan = await quote(backend, 1_000)
    expect(plan.legs.map((l) => l.source)).toEqual(['own_credit', 'fresh'])
    const p = await payNow(backend, plan)
    const out = await backend.report(p, 1, 'declined')
    expect(out.line).toBe('That card did not work. Nothing was charged for it, and it is still in your store credit.')
    expect((await shopper.store.ownCards()).find((c) => c.id === 'typed-own')?.balanceCents).toBe(300)
  })
})

describe('the sums and the plan', () => {
  it('the receipt rounds what the chain pulled once, as the Pay button does', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    // Two $10 cards at $9.004 each: the chain pulls $18.008, the button says $18.01.
    for (let i = 0; i < 2; i++) t.server.add(await listV2(t.w, { valueCents: 1_000, price: 9_004_000, residualCapCents: 500 }))
    const backend = dollars(t, shopper)
    const plan = await quote(backend, 2_000)
    expect(plan.costCents).toBe(1_801)
    const p = await payNow(backend, plan)
    await backend.next(p, 1)
    // The finding: rounded card by card, the receipt said $18.02 paid, a cent more than the chain took.
    expect(await backend.done(p, 2)).toEqual({ paidCents: 1_801, savedCents: 199, depositCents: 0, keptCents: 0 })
  })

  it("a card limit filled by the shopper's own credit never refuses a total there are cards on sale for, and a refusal names the store", async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await ownCard(shopper, 'typed-a', 300, 1)
    await ownCard(shopper, 'typed-b', 500, 2)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    // Nothing on sale: said with the store's own name, never its id.
    expect(await backend.quote({ merchant: 'salvotest', totalCents: 3_213, preference: IN_AND_OUT })).toEqual({
      unavailable: 'There is not enough at the Salvo test store right now to cover $32.13.',
    })
    // The finding: two small credits filled the two-card limit, and $32.13 was refused with a $30 card on sale.
    await card(t, 3_000)
    const plan = await quote(backend, 3_213)
    expect(plan.legs.map((l) => [l.source, l.appliedCents])).toEqual([
      ['own_credit', 300],
      ['fresh', 2_913],
    ])
  })
})

describe("/account's store credit, one list for both rails", () => {
  it('a card the till bought on the second escrow is never offered to count as credit by hand', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    await backend.done(await payNow(backend, await quote(backend, 700)), 1)
    const cards = await shopper.store.cards()
    expect(cards).toHaveLength(1)
    expect(isCardV2(cards[0] as (typeof cards)[number])).toBe(true)
    expect(keepableCards(cards, await shopper.store.ownCards())).toEqual([])
    await expect(keepAsCredit(shopper.store, cards[0] as (typeof cards)[number], 300)).rejects.toBeInstanceOf(CreditRefused)
    expect(await shopper.store.ownCards()).toEqual([])
  })

  it('[Sell it] lists a typed card on SalvoEscrowV2, and a kept card once its purchase is paid out; listed, it is no longer credit', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    const seller = await setUpDeviceWalletV2(shopper.store, 'seller', {
      escrow: t.w.escrow,
      now: Number(t.w.node.chain.timestamp),
      passkey: { rpId: 'localhost', createFn: shopper.auth.createFn, getFn: shopper.auth.getFn },
    })
    const d: SellCreditDeps = { store: shopper.store, book: shopper.book, api: shopper.api, config: shopper.config, access: shopper.access, wallet: seller }
    const typed = testCardNumberV2()
    await shopper.store.saveOwnCard({ id: 'typed-2', merchant: 'salvotest', balanceCents: 1_500, last4: typed.slice(-4), addedAt: 1 }, { cardNumber: typed, pin: null })
    const own = (await shopper.store.ownCards())[0] as OwnCardRecord
    await expect(sellOwnCredit(d, own, 1_600)).rejects.toThrow('Ask between')
    const listed = await sellOwnCredit(d, own, 1_350)
    expect(listed).toMatchObject({ merchant: 'salvotest', valueCents: 1_500, priceUnits: 13_500_000 })
    expect((await listingV2At(t.hosts, await agreedFinalizedBlock(t.hosts), t.w.escrow, listed.listingId)).state).toBe(V2_STATE.listing.ACTIVE)
    expect(await shopper.store.ownCards()).toEqual([])

    // A card the register needed none of: kept as credit, and sold back only once its sale is paid out.
    await card(t, 500)
    await card(t, 600)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(backend, await quote(backend, 900))
    await backend.done(p, 1)
    const kept = (await shopper.store.ownCards())[0] as OwnCardRecord
    expect(kept.keptCardId).toBeDefined()
    await expect(sellOwnCredit(d, kept, kept.balanceCents)).rejects.toThrow('once your purchase of it is final')
    t.w.node.advance(DAY + 1)
    const record = await shopper.book.purchase(p.ref)
    const depositId = BigInt(record?.legs.find((l) => l.scanOrder === 2)?.depositId ?? '0')
    expect((await t.w.node.chain.send(testAddress(7), t.w.escrow, escrowV2Call.release(depositId))).ok).toBe(true)
    const resold = await sellOwnCredit(d, kept, kept.balanceCents)
    expect(resold.valueCents).toBe(kept.balanceCents)
    expect(await shopper.store.ownCards()).toEqual([])
    noCardAnywhere(t)
  })
})

describe('the total goes up with a card on screen that holds more than it covers', () => {
  it('a leftover listed for the next shopper is bought first, so the register never empties what the chain still sells; what it leaves is store credit', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    const c10 = await card(t, 1_000)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(backend, await quote(backend, 800))
    expect(p.code).toMatchObject({ coversCents: 800, leftoverCents: 200, depositCents: 200 })
    // Another card on sale: the finding planned the extra on it, and left the $2.00 listed behind this shopper's deposit.
    await card(t, 500)
    const change = await backend.changeTotal(p, 900)
    expect(change.owed).toBeNull()
    expect(change.cover).toEqual({ scanIndex: 1, coversCents: 900, leftoverCents: 100, depositCents: 0 })
    expect(coversLine(phaseAfterChange(p.code, change).code)).toBe('covers $9.00')
    // Nothing of it is listed for the next shopper now, and the deposit came back.
    const depositId = BigInt((await shopper.book.purchase(p.ref))?.legs[0]?.depositId ?? '0')
    const at = await agreedFinalizedBlock(t.hosts)
    expect((await listingV2At(t.hosts, at, t.w.escrow, c10.listingId)).state).toBe(V2_STATE.listing.DRAINED)
    expect(await depositV2At(t.hosts, at, t.w.escrow, depositId)).toMatchObject({ usedCents: 1_000, leftAfterCents: 0, bond: 0n })
    // What the register leaves on it is the shopper's, kept at once.
    expect((await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)).map((c) => c.balanceCents)).toEqual([100])
    const receipt = await backend.done(change.purchase, 1)
    expect(receipt.note).toBe('Card 1 has $1.00 left on it. It is in your store credit now.')
    // $9.00 for the whole card: $8.10 for what the register took, $0.90 for the credit it left.
    expect(receipt).toMatchObject({ paidCents: 810, savedCents: 90, depositCents: 0, creditPaidCents: 90 })
    // The next shopper is never planned that leftover.
    const next = await phoneV2(t, 'shopper')
    expect((await quote(dollars(t, next), 500)).legs.map((l) => l.source)).toEqual(['fresh'])
  })

  it('more than the leftover: the card on screen is used whole, and only the rest is planned', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 1_000)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(backend, await quote(backend, 800))
    await card(t, 500)
    const change = await backend.changeTotal(p, 1_150)
    expect(change.cover).toEqual({ scanIndex: 1, coversCents: 1_000, leftoverCents: 0, depositCents: 0 })
    // The finding: $3.50 planned as a new card, while the register took $2.00 of it from the card on screen.
    const owed = change.owed as RoutePlan
    expect(owed.totalCents).toBe(150)
    expect(owed.legs.map((l) => [l.source, l.appliedCents])).toEqual([['fresh', 150]])
    expect(await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)).toEqual([])
  })

  it("the shopper's own card on screen: the extra comes off its balance before anything is bought", async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    await ownCard(shopper, 'typed-up', 1_000, 1)
    await card(t, 500)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const plan = await quote(backend, 600)
    expect(plan.legs.map((l) => [l.source, l.appliedCents, l.leftoverCents])).toEqual([['own_credit', 600, 400]])
    const p = await payNow(backend, plan)
    const change = await backend.changeTotal(p, 800)
    // The finding: a $2.00 card bought beside it, while the register took the $2.00 from the shopper's own card.
    expect(change.owed).toBeNull()
    expect(change.cover).toMatchObject({ coversCents: 800, leftoverCents: 200 })
    expect((await shopper.store.ownCards()).find((c) => c.id === 'typed-up')?.balanceCents).toBe(200)
    expect(t.layer.landed).toHaveLength(0)
  })
})

describe('a card to keep whose rest went to someone else is kept at what was paid for, and said', () => {
  async function keptLater(t: TillWorldV2) {
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 500)
    const c6 = await card(t, 600)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(backend, await quote(backend, 900))
    expect(p.plan.legs.map((l) => [l.appliedCents, l.leftoverCents])).toEqual([
      [500, 0],
      [400, 200],
    ])
    // "Register says paid" after card 1, and keeping card 2 does not get through.
    dropSends(shopper)
    expect((await backend.done(p, 1)).note).toBe('A card the register did not need is not in your store credit yet. Salvo asks again each time you open the till or Account.')
    return { shopper, c6, p }
  }

  it('another shopper used its rest before the chain took the keep: the shopper still has what they paid for, and is told', async () => {
    const t = await world()
    const { shopper, c6, p } = await keptLater(t)
    await useCardV2(t.w, c6, SHOPPER_C, 200)
    const out = await dollars(t, shopper, { ownCards: shopper.store }).catchUp()
    // The finding: dropped without a word, and the $3.60 paid for its $4.00 was gone.
    expect(out).toEqual({
      kept: 1,
      reported: 0,
      waiting: 0,
      said: ['At the Salvo test store, a card the register did not need is in your store credit now, at the $4.00 you paid for. Its rest could not be kept.'],
    })
    expect((await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)).map((c) => c.balanceCents)).toEqual([400])
    expect((await shopper.book.purchase(p.ref))?.pendingKeeps).toEqual([])
  })

  it('the seller was paid before the chain took the keep: kept at what was paid for, and said', async () => {
    const t = await world()
    const { shopper, p } = await keptLater(t)
    t.w.node.advance(DAY + 1)
    const depositId = BigInt((await shopper.book.purchase(p.ref))?.legs.find((l) => l.scanOrder === 2)?.depositId ?? '0')
    expect((await t.w.node.chain.send(testAddress(7), t.w.escrow, escrowV2Call.release(depositId))).ok).toBe(true)
    const out = await dollars(t, shopper, { ownCards: shopper.store }).catchUp()
    expect(out).toMatchObject({ kept: 1, waiting: 0, said: [expect.stringContaining('at the $4.00 you paid for')] })
    expect((await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)).map((c) => c.balanceCents)).toEqual([400])
  })
})

describe('a card sold from store credit whose answer never came back', () => {
  it('is off the till and /account alike, typed or kept, from the moment its listing is saved', async () => {
    const t = await world()
    const shopper = await phoneV2(t, 'shopper')
    const seller = await setUpDeviceWalletV2(shopper.store, 'seller', {
      escrow: t.w.escrow,
      now: Number(t.w.node.chain.timestamp),
      passkey: { rpId: 'localhost', createFn: shopper.auth.createFn, getFn: shopper.auth.getFn },
    })
    // Our server never sees the listing: every answer says it is not on chain yet, as after a chain it is slow to read.
    const notSeen = async (path: string, init?: RequestInit): Promise<Response> =>
      path === '/api/escrow/listings'
        ? new Response(JSON.stringify({ error: 'not_on_chain_yet', message: 'Your listing is not final on the chain yet.' }), { status: 409, headers: { 'content-type': 'application/json' } })
        : t.server.fetch(path, init)
    const d: SellCreditDeps = {
      store: shopper.store,
      book: shopper.book,
      api: new EscrowApiV2(notSeen, t.pins, null),
      config: shopper.config,
      access: shopper.access,
      wallet: seller,
      sleep: async () => undefined,
    }
    const credit = () => tillCreditV2(shopper.book, 'salvotest', shopper.store, shopper.wallet.account)
    const listedOnChain = async (listingId: Hex) => (await listingV2At(t.hosts, await agreedFinalizedBlock(t.hosts), t.w.escrow, listingId)).state

    // A typed card.
    await ownCard(shopper, 'typed-sell', 1_500, 1)
    const typed = (await shopper.store.ownCards()).find((c) => c.id === 'typed-sell') as OwnCardRecord
    const refused = await sellOwnCredit(d, typed, 1_350).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(SellRefused)
    expect((refused as SellRefused).sentOnChain).toBe(true)
    const [listing] = await shopper.book.listings()
    expect(listing?.fromOwn).toBe('typed-sell')
    expect(await listedOnChain(listing?.listingId ?? '0x')).toBe(V2_STATE.listing.ACTIVE)
    // The finding: the dollars till still planned it at its full balance, and /account still listed it.
    expect(await credit()).toEqual([])
    expect(await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)).toEqual([])

    // A card bought here and kept, once its sale is paid out.
    await card(t, 500)
    await card(t, 600)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(backend, await quote(backend, 900))
    await backend.done(p, 1)
    t.w.node.advance(DAY + 1)
    const depositId = BigInt((await shopper.book.purchase(p.ref))?.legs.find((l) => l.scanOrder === 2)?.depositId ?? '0')
    expect((await t.w.node.chain.send(testAddress(7), t.w.escrow, escrowV2Call.release(depositId))).ok).toBe(true)
    const kept = (await shopper.store.ownCards()).find((c) => c.keptCardId !== undefined) as OwnCardRecord
    expect((await credit()).map((c) => c.balanceCents)).toEqual([600])
    const again = await sellOwnCredit(d, kept, 500).catch((e: unknown) => e)
    expect((again as SellRefused).sentOnChain).toBe(true)
    expect(await credit()).toEqual([])
    expect(await storeCreditList(shopper.store, shopper.book, shopper.wallet.account)).toEqual([])
    noCardAnywhere(t)
  })
})

describe('a dollars Pay still going through when the account signs out of this browser', () => {
  it('is found again in the V2 book for that account, signed in again, and finished paying once; never for anyone else', async () => {
    const t = await world()
    const shopper = chainClock(t, await phoneV2(t, 'shopper'))
    const l = await card(t, 1_000)
    const backend = dollars(t, shopper)
    const plan = await quote(backend, 800)
    await backend.prepare(plan)
    // As the till keeps it, before Pay is sent.
    await shopper.store.savePendingTillPay({ key: 'tap-out', store: 'salvotest', plan, at: Date.now() })
    t.w.node.setHost(1, { down: 'network' })
    expect(await backend.pay(plan, { key: 'tap-out' }).catch((e: unknown) => e)).toMatchObject({ code: STILL_GOING })
    // Signed out of this browser: the key the till kept goes with the account.
    await shopper.store.forgetAccount()
    expect(await shopper.store.pendingTillPays()).toEqual([])
    t.w.node.setHost(1, {})
    // Someone else signed in here: nothing of the first account's.
    expect(await dollars(t, shopper, { account: testAddress(77) }).unfinishedPays()).toEqual([])
    // A till still open from before the sign-out finds nothing either: that account is not signed in here now.
    expect(await backend.unfinishedPays()).toEqual([])
    // The same account signed in again, dollars allowed again (a new key): its Pay is found by the tap's own key, kept on the purchase.
    const wallet = await setUpDeviceWalletV2(shopper.store, 'shopper', {
      escrow: shopper.config.escrow,
      now: Number(t.w.node.chain.timestamp),
      passkey: { rpId: 'localhost', createFn: shopper.auth.createFn, getFn: shopper.auth.getFn },
    })
    expect(wallet.account).toBe(shopper.wallet.account)
    const again = dollars(t, { ...shopper, wallet }, { account: shopper.wallet.account })
    const found = await again.unfinishedPays()
    expect(found).toMatchObject([{ key: 'tap-out', store: 'salvotest', plan: { totalCents: 800 } }])
    const first = found[0]
    if (first === undefined) throw new Error('nothing found')
    // "Check it": the same key, only to find what that tap did. The finding: nothing led back to it, and its card was never drawn.
    const p = await again.pay(first.plan, { key: first.key, resume: true })
    if ('requote' in p || 'ended' in p) throw new Error('the Pay did not come back as a purchase')
    expect(p.code.barcode).toBe(l.cardNumber)
    expect(t.layer.landed).toHaveLength(1)
    expect(await again.unfinishedPays()).toEqual([])
  })

  it("a tab left open with the first account's key or \"Show it\" never opens that account's purchase for whoever signs in next", async () => {
    const t = await world()
    const a = await phoneV2(t, 'shopper')
    const c20 = await card(t, 2_000, 80)
    await card(t, 1_600)
    const aTill = dollars(t, a)
    const p = await payNow(aTill, await quote(aTill, 3_213), { key: 'tap-a' })
    expect(p.code.barcode).toBe(c20.cardNumber)
    // The tab reloads with card 1 on screen: the till offers it again, for A.
    const found = (await dollars(t, a).unfinishedPays())[0]
    expect(found).toMatchObject({ key: 'tap-a', open: { shown: 1, scanOf: 2 } })
    if (found === undefined) throw new Error('nothing offered')
    // A signs out in another tab, and B signs in on this browser and allows dollars. The till tab was never reloaded,
    // so it still offers A's purchase, and its rail opens a backend for B (src/lib/till/client/dollars.ts).
    await a.store.forgetAccount()
    const bAuth = new FakeAuthenticator()
    const b = await setUpDeviceWalletV2(a.store, 'shopper', {
      escrow: t.w.escrow,
      now: Number(t.w.node.chain.timestamp),
      passkey: { rpId: 'localhost', createFn: bAuth.createFn, getFn: bAuth.getFn },
    })
    expect(b.account).not.toBe(a.wallet.account)
    const bTill = dollars(t, { ...a, wallet: b })
    const released = t.server.calls.release
    // The finding: "Show it" opened A's purchase by its key and drew A's paid, unscanned card 1 onto B's screen.
    const shown = await bTill.pay(found.plan, { key: found.key, resume: true }).catch((e: unknown) => e)
    expect(shown).toBeInstanceOf(LoadRefused)
    expect(shown).toMatchObject({ message: 'That purchase was made by another account, not the one signed in here.' })
    // And a Pay tap still holding A's key is refused the same way, never kept as a tap still going through.
    const tapped = await bTill.pay(found.plan, { key: found.key }).catch((e: unknown) => e)
    expect(tapped).toBeInstanceOf(LoadRefused)
    expect(tapped).not.toBeInstanceOf(TillRefused)
    expect(await bTill.unfinishedPays()).toEqual([])
    expect(t.server.calls.release).toBe(released)
    // A, signed in here again with dollars allowed again, still has it, on the card that was showing.
    await a.store.forgetAccount()
    const aAgain = await setUpDeviceWalletV2(a.store, 'shopper', {
      escrow: t.w.escrow,
      now: Number(t.w.node.chain.timestamp),
      passkey: { rpId: 'localhost', createFn: a.auth.createFn, getFn: a.auth.getFn },
    })
    expect(aAgain.account).toBe(a.wallet.account)
    const back = await dollars(t, { ...a, wallet: aAgain }).pay(found.plan, { key: found.key, resume: true })
    expect(back).toMatchObject({ ref: p.ref, code: { scanIndex: 1, barcode: c20.cardNumber } })
    expect(t.layer.landed).toHaveLength(1)
  })
})

describe('what the receipt counts as covered and saved', () => {
  async function twoCards(t: TillWorldV2) {
    const shopper = await phoneV2(t, 'shopper')
    await card(t, 2_000, 80)
    await card(t, 1_600)
    const backend = dollars(t, shopper, { ownCards: shopper.store })
    const p = await payNow(backend, await quote(backend, 3_213))
    return { shopper, backend, p }
  }

  it('a card that did not work and a card kept as credit are said apart, never as covered or saved', async () => {
    const t = await world()
    const { backend, p } = await twoCards(t)
    const out = await backend.report(p, 1, 'declined')
    // Card 2 is the shopper's credit now, and nothing on sale covers the rest.
    expect(out.owed).toMatchObject({ unavailable: expect.any(String) })
    expect(out.owedCents).toBe(3_213)
    expect(out.receipt).toEqual({ paidCents: 0, savedCents: 0, depositCents: 0, keptCents: 0, creditPaidCents: 1_440, disputedCents: 1_600 })
    // The finding: "The cards that worked covered $36.00, for $30.40", when no card had worked.
    expect(stillOwedLine(out.receipt, 'stablecoin')).toBe('We have nothing more that covers it, so nothing more was paid.')
    expect(alsoPaidLine(out.receipt)).toBe('You also paid $14.40 for store credit and $16.00 for a card that did not work.')
    expect(out.note).toBe('Card 2 was not scanned. Its $16.00 is in your store credit now.')
  })

  it('"Register says paid" after card 1: card 2 is said to be store credit, and what it cost is said apart from what the register took', async () => {
    const t = await world()
    const { shopper, backend, p } = await twoCards(t)
    const receipt = await backend.done(p, 1)
    // The finding: "Paid $30.40 · saved $5.60." for a register that took one $20 card, and nothing said of card 2.
    expect(receipt).toEqual({
      paidCents: 1_600,
      savedCents: 400,
      depositCents: 0,
      keptCents: 0,
      creditPaidCents: 1_440,
      note: 'Card 2 was not scanned. Its $16.00 is in your store credit now.',
    })
    expect(doneLine(receipt)).toBe('Paid $16.00 · saved $4.00.')
    expect(alsoPaidLine(receipt)).toBe('You also paid $14.40 for store credit.')
    // Spent at the till later, it counts as used: the store credit left is what is said apart.
    const later = dollars(t, shopper, { ownCards: shopper.store })
    const own = await payNow(later, await quote(later, 1_000))
    await later.done(own, 1)
    expect(await later.receipt({ rail: p.rail, ref: p.ref, plan: p.plan })).toMatchObject({ paidCents: 2_500, savedCents: 500, creditPaidCents: 540 })
  })

  it('the total came down to what card 1 covers: card 2 is kept, and said at Done', async () => {
    const t = await world()
    const { backend, p } = await twoCards(t)
    const change = await backend.changeTotal(p, 2_000)
    expect(change).toMatchObject({ owed: null, tooLow: false })
    expect((await backend.done(change.purchase, 1)).note).toBe('Card 2 was not scanned. Its $16.00 is in your store credit now.')
  })
})

describe("the quote route's V2 body", () => {
  const post = (body: unknown): Request =>
    new Request('http://localhost:3000/api/escrow/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(body),
    })
  const depositor = testAddress(5)

  it('is checked key by key, and answers 503 until V2 is open', async () => {
    const t = await world()
    const v2 = { version: 2, merchant: 'salvotest', totalCents: 500, depositor, preference: IN_AND_OUT }
    expect((await quoteRoute(post({ ...v2, spendCents: 500 }))).status).toBe(400)
    expect((await quoteRoute(post({ merchant: 'salvotest', spendCents: 500, depositor, preference: IN_AND_OUT }))).status).toBe(400)
    expect((await quoteRoute(post({ ...v2, version: 3 }))).status).toBe(400)
    expect((await quoteRoute(post({ ...v2, exclude: ['nope'] }))).status).toBe(400)
    __setEscrowRuntimeForTests({ ...t.w.rt, v2Live: false })
    const shut = await quoteRoute(post(v2))
    expect(shut.status).toBe(503)
    expect(((await shut.json()) as Record<string, unknown>).error).toBe('not_ready')
  })
})
