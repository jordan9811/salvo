/**
 * The till's phone side, without a server (unified-account spec 4 and 5.1;
 * src/app/pay/[store]/use-till.ts, src/lib/till/client/recent.ts,
 * src/lib/account/client/challenge.ts, and the account page's words).
 *
 * Pinned:
 *   - a new total with a code on screen keeps that code on screen: more
 *     owed waits under it until it has scanned, too low says it must not be
 *     scanned, and either way it shows what the card covers now;
 *   - a report that leaves money owed says so: the plan with whether the
 *     card's hold was kept, or, when nothing covers the rest, what the
 *     register still needs, never a receipt;
 *   - what was paid at the till stays on the phone for 48 hours, so Account
 *     can open "Something went wrong?" again, and is forgotten after;
 *   - the sign-in challenge is never refreshed while a sign-in uses it, and
 *     a fetch already on its way is waited for;
 *   - the account page puts the till's tick on the rail the till pays with
 *     (the shopper's choice, or the one set up, dollars first), and store
 *     credit is the till's, used first; the till's button says what it is
 *     doing;
 *   - a price Pay came back with stays on the button, so the next tap sends
 *     it (a drains-only plan is never swapped back for the deposit plan);
 *   - a card check that could not be read never locks Pay, and is asked
 *     again; a definite "no card" does;
 *   - nothing leads away from the paying beat, and the Pay going through is
 *     kept on the phone before it is sent;
 *   - a card that must not be scanned is not drawn;
 *   - the phone never keeps a card's code, and Account asks the server what
 *     a purchase came to;
 *   - Account can sign a browser out, and that forgets the account in it;
 *   - a Pay this phone never heard back from blocks Pay until it is checked,
 *     one per store, and a tap still going through keeps its key;
 *   - a purchase found again by its key for another total is changed to the
 *     total typed;
 *   - "The total changed" stays under a card too low for the new total;
 *   - every move goes to the rail it belongs to: a kept key goes back with
 *     the plan it went with, to that plan's rail, whatever the keypad priced
 *     since; "Check it" asks the rail its Pay was made on; Next, Done, a
 *     report and a new total go to the purchase's own rail; and the till
 *     takes up another rail only on an idle keypad;
 *   - the backend's own sentence for a card on screen replaces the till's
 *     when the till's would not be true;
 *   - Pay waits while the till is still finding which way it pays, and a
 *     plan paid wholly from store credit is never blocked by the dollars;
 *   - store credit is said to pay only in dollars wherever the till pays by
 *     card, and "nothing here" is never said beside the other way's price;
 *   - signing out keeps a dollars purchase only for its own account, and
 *     the till finds a dollars Pay still going through in the rail's own
 *     book once the kept key is gone;
 *   - what the dollars rail could not get onto the chain is asked again
 *     soon while the till is open, and said once it lands; what was paid
 *     beside the cards that worked is summed and said apart;
 *   - a dollars purchase whose page went with a card on screen is offered
 *     again as that, before another Pay, and kept under its own record;
 *   - a card the shopper was told not to scan, now their store credit and
 *     paying the rest, comes back at once with why, never behind "Pay $0.00
 *     more", and the button under it says what it does on each rail;
 *   - store credit that covers the total is offered while the till pays by
 *     card, and whatever the dollars balance says; the tap on it switches
 *     for that one purchase, never the visit, and a total typed past the
 *     credit goes back to the shopper's own way;
 *   - a till open in one tab asks who is signed in before every move, and
 *     opens again for whoever is; it remembers its store in its own slot,
 *     so a till opened before sign-in never keeps the account's settings
 *     from coming back; using another account here says it signs the kept
 *     one out first.
 *
 * No server, no database, no network.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { alsoPaidLine, caughtUpLine, otherRailLabel, payMoreLabel, scannedPayMoreLabel, thenLine, tooLowLabel } from '@/app/pay/till-copy'
import {
  ASK_AGAIN_MS,
  NO_SWITCH,
  creditMayPay,
  endOnce,
  keepsKey,
  onceOutgrown,
  otherWayPlan,
  owedStartsAtOnce,
  landPurchase,
  payBlockedBy,
  payDisabled,
  payToSend,
  phaseAfterChange,
  phaseAfterReport,
  phaseOnScreen,
  prepareDelayMs,
  quoteNeed,
  railMayChange,
  stillOffered,
  sumReceipts,
  switchTo,
  switchedRail,
} from '@/app/pay/[store]/use-till'
import { ChallengeKeeper, CHALLENGE_FRESH_MS } from '@/lib/account/client/challenge'
import { openCardStore } from '@/lib/escrow/client/card-store'
import type { PurchaseRecordV2 } from '@/lib/escrow/client/records-v2'
import { endPendingPay, keepPendingPay, keepTillPurchase, recentTillPurchases, recentTillPurchasesOf, unfinishedPay, unfinishedPays } from '@/lib/till/client/recent'
import { cardBackend, TillRefused } from '@/lib/till/client/card-backend'
import type { ChangeAnswer, LegCode, Purchase, RoutePlan, TillReceipt } from '@/lib/till/types'
import { FakeIndexedDB } from './support/fake-indexeddb'
import { tillAddPlan, tillCode, tillOwedPlan, tillPlan, tillReceipt } from '../scripts/till-fixtures'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code: LegCode = tillCode(1, null)
const purchase: Purchase = { rail: 'card', ref: 'tp2.fixture', plan: tillPlan(), code }
const receipt: TillReceipt = tillReceipt()

describe('a new total with a code on screen', () => {
  it('more owed: the code stays, the last of its purchase, with the rest waiting under it', () => {
    const add: RoutePlan = tillAddPlan()
    const next = phaseAfterChange(code, { purchase, owed: add, cover: { scanIndex: 1, coversCents: 2_100, leftoverCents: 0, depositCents: 0 }, tooLow: false, notNeeded: false })
    expect(next).toEqual({ kind: 'scan', purchase, code: { ...code, scanOf: 1 }, then: add, tooLow: false, notNeeded: false })
    // The barcode itself is the same code: nothing was settled, nothing re-opened.
    expect(next.code.barcode).toBe(code.barcode)
  })

  it('down: it shows what the card covers now, and what stays on it behind a new deposit', () => {
    const cover = { scanIndex: 1, coversCents: 1_900, leftoverCents: 200, depositCents: 200 }
    const next = phaseAfterChange(code, { purchase, owed: null, cover, tooLow: false, notNeeded: false })
    expect(next.code).toMatchObject({ coversCents: 1_900, leftoverCents: 200, depositCents: 200, scanOf: 1 })
    expect(next.then).toBeNull()
  })

  it('too low: the code stays, marked not to be scanned, and says when nothing more is needed', () => {
    const next = phaseAfterChange(code, { purchase, owed: { unavailable: 'Do not scan it.' }, cover: null, tooLow: true, notNeeded: false })
    expect(next).toMatchObject({ kind: 'scan', tooLow: true, notNeeded: false, then: null })
    const covered = phaseAfterChange(code, { purchase, owed: { unavailable: 'Do not scan it.' }, cover: null, tooLow: true, notNeeded: true })
    expect(covered).toMatchObject({ tooLow: true, notNeeded: true })
  })
})

describe('a report on the card on screen', () => {
  it('nothing more owed: the receipt', () => {
    expect(phaseAfterReport({ owed: null, owedCents: 0, receipt, kept: null, note: null }, purchase, [purchase], 'declined')).toEqual({
      kind: 'done',
      purchases: [purchase],
    })
  })

  it('more owed: the plan, with the kept hold said', () => {
    const kept = { cents: 1_890, until: 'next_shopper' as const }
    // One plan, used on both sides: each call stamps its own expiry, and two calls can land a millisecond apart.
    const owed = tillOwedPlan()
    expect(phaseAfterReport({ owed, owedCents: 5_213, receipt, kept, note: null }, purchase, [purchase], 'declined')).toEqual({
      kind: 'owed',
      purchase,
      owed,
      kept,
      why: 'failed',
      line: null,
      note: null,
    })
  })

  it("carries the backend's own sentence for the card, said in place of the till's, and anything more beside it", () => {
    // The finding: on dollars a declined card of the shopper's own credit read "Its seller's payment waits 48 hours".
    const line = 'That card did not work. Nothing was charged for it, and it is still in your store credit.'
    const note = 'A card the register did not need is not in your store credit yet.'
    const out = phaseAfterReport({ owed: tillOwedPlan(), owedCents: 5_213, receipt, kept: null, note, line }, purchase, [purchase], 'declined')
    expect(out).toMatchObject({ kind: 'owed', line, note })
    const none = phaseAfterReport({ owed: { unavailable: 'Nothing covers it.' }, owedCents: 100, receipt, kept: null, note: null, line }, purchase, [purchase], 'declined')
    expect(none).toMatchObject({ kind: 'uncovered', line, note: null })
    const tillPage = read('src/app/pay/[store]/till-client.tsx')
    expect(tillPage.match(/\{t\.phase\.line \?\? owedLine\(/g)?.length).toBe(2)
    expect(tillPage.match(/\{t\.phase\.note && <p className="hint">\{t\.phase\.note\}<\/p>\}/g)?.length).toBe(2)
  })

  it('a card the shopper was told not to scan is said as not used, never as failed', () => {
    const out = phaseAfterReport({ owed: tillOwedPlan(), owedCents: 5_213, receipt, kept: null, note: null }, purchase, [purchase], 'not_used')
    expect(out).toMatchObject({ kind: 'owed', why: 'not_used' })
  })

  it('a card not used that is store credit now, paying the rest, comes back at once with why, never behind "Pay $0.00 more"', () => {
    // The finding: "Do not scan this card", then "Pay $0.00 more for $3.00 · 1 card", then that same card's barcode.
    const credit: RoutePlan = {
      ...tillOwedPlan(),
      rail: 'stablecoin',
      totalCents: 300,
      costCents: 0,
      savingCents: 0,
      depositCents: 0,
      legs: [{ ref: 'own:kept-card-2', source: 'own_credit', firstInLine: false, faceCents: 2_000, appliedCents: 300, costCents: 0, leftoverCents: 1_700, depositCents: 0, scanIndex: 1, scanOf: 1 }],
    }
    const answer = { owed: credit, owedCents: 300, receipt, kept: null, note: null }
    expect(owedStartsAtOnce(answer, 'not_used')).toBe(true)
    // Not after a card that failed: that screen says what became of it first. Not when the rest is bought.
    expect(owedStartsAtOnce(answer, 'declined')).toBe(false)
    expect(owedStartsAtOnce({ ...answer, owed: tillOwedPlan() }, 'not_used')).toBe(false)
    expect(owedStartsAtOnce({ ...answer, owed: { unavailable: 'Nothing covers it.' } }, 'not_used')).toBe(false)
    expect(owedStartsAtOnce({ ...answer, owed: null }, 'not_used')).toBe(false)
    // Said as store credit wherever it shows, never as a payment of $0.00.
    expect(payMoreLabel(credit)).toBe('Use $3.00 of your store credit · 1 card')
    expect(scannedPayMoreLabel(credit)).toBe('Scanned · use $3.00 of your store credit')
    expect(thenLine(credit)).toBe('The total went up. Scan this card first, then your store credit pays the other $3.00.')
    // The button under a card not to scan says what it does: other cards by card; on dollars the card becomes store credit.
    expect(tooLowLabel('card')).toBe('Use other cards')
    expect(tooLowLabel('stablecoin')).toBe('Use it as your store credit')
    const hook = read('src/app/pay/[store]/use-till.ts')
    expect(hook).toMatch(/if \(after\.kind === 'owed' && owedStartsAtOnce\(out, o\)\) await payOwedOf\(after, CREDIT_PAYS_REST\)/)
    const tillPage = read('src/app/pay/[store]/till-client.tsx')
    expect(tillPage).toMatch(/\{note && !tooLow && <p className="notice">\{note\}<\/p>\}/)
    expect(tillPage).toMatch(/note=\{t\.phase\.note \?\? null\}/)
  })

  it('nothing covers the rest: what the register still needs, never a receipt', () => {
    const out = phaseAfterReport(
      { owed: { unavailable: 'We cannot cover $31.13 at this store right now.' }, owedCents: 3_113, receipt, kept: null, note: null },
      purchase,
      [purchase],
      'didnt_scan',
    )
    expect(out).toEqual({ kind: 'uncovered', purchases: [purchase], owedCents: 3_113, kept: null, why: 'failed', line: null, note: null })
  })
})

describe('what was paid at the till, on the phone', () => {
  it('is kept for 48 hours, so Account can open it again, and forgotten after', async () => {
    const store = await openCardStore(new FakeIndexedDB().asFactory())
    const now = Date.parse('2026-10-12T15:00:00Z')
    await keepTillPurchase(store, { id: 'old', store: 'target', purchase, receipt, createdAt: now - 49 * 3600_000 })
    await keepTillPurchase(store, { id: 'new', store: 'target', purchase, receipt, createdAt: now - 3600_000 })
    expect((await recentTillPurchases(store, now)).map((r) => r.id)).toEqual(['new'])
    expect((await store.tillPurchases()).map((r) => r.id)).toEqual(['new'])
    // A phone that keeps nothing still pays.
    await expect(keepTillPurchase(null, { id: 'x', store: 'target', purchase, receipt, createdAt: now })).resolves.toBeUndefined()
  })
})

describe('signing out of this browser, and the dollars rail', () => {
  const A = '0xaaaa000000000000000000000000000000000001' as Hex
  const B = '0xbbbb000000000000000000000000000000000002' as Hex

  it('keeps a dollars purchase for its own account only, so it can still report a card, and forgets a card one', async () => {
    const store = await openCardStore(new FakeIndexedDB().asFactory())
    const now = Date.now()
    const dollarsPurchase = { rail: 'stablecoin' as const, ref: 'v2-purchase-1', plan: { ...tillPlan(), rail: 'stablecoin' as const } }
    await keepTillPurchase(store, { id: 'card-1', store: 'target', purchase, receipt, createdAt: now })
    await keepTillPurchase(store, { id: 'dollars-1', store: 'target', purchase: dollarsPurchase, receipt, createdAt: now })
    // The finding: every till record went, and the account signed in again lost its 48 hours to report a card.
    await store.forgetAccount()
    expect((await store.tillPurchases()).map((r) => [r.id, r.signedOut])).toEqual([['dollars-1', true]])
    const book = { purchase: async (id: string) => (id === 'v2-purchase-1' ? ({ depositor: A } as PurchaseRecordV2) : null) }
    expect((await recentTillPurchasesOf(store, book, A, now)).map((r) => r.id)).toEqual(['dollars-1'])
    // Never someone else's, and nobody's while the dollars book is not open.
    expect(await recentTillPurchasesOf(store, book, B, now)).toEqual([])
    expect(await recentTillPurchasesOf(store, null, A, now)).toEqual([])
    // Kept again from Account, it stays marked.
    const [kept] = await store.tillPurchases()
    if (kept === undefined) throw new Error('nothing kept')
    await keepTillPurchase(store, { ...kept, receipt: { ...receipt, paidCents: 1 } })
    expect((await store.tillPurchases())[0]?.signedOut).toBe(true)
  })

  it('the till finds a dollars Pay still going through in the rail\'s own book once the kept key is gone, and asks again soon what the chain did not take', () => {
    const hook = read('src/app/pay/[store]/use-till.ts')
    expect(hook).toMatch(/\(await unfinishedPay\(s, store\)\.catch\(\(\) => null\)\) \?\? \(await dollarsUnfinished\(backends\.stablecoin, store\)\)/)
    // A note or a line on the dollars rail (a card not credit yet, a report not landed) is asked again on a timer, not only when the till opens again.
    expect(ASK_AGAIN_MS.length).toBeGreaterThan(0)
    expect(ASK_AGAIN_MS[0]).toBeLessThanOrEqual(10_000)
    expect(hook).toMatch(/sayingMore\(p\.rail, \[r\.note\]\)/)
    expect(hook).toMatch(/sayingMore\(phase\.purchase\.rail, \[out\.line, out\.note\]\)/)
    expect(hook).toMatch(/sayingMore\(purchase\.rail, \[out\.note\]\)/)
    // "Do not scan" then Done: what became of the card is said, as the screen for what is still owed says it.
    expect(hook).toMatch(/out\.line \?\? \(o === 'not_used' \? owedLine\('not_used', out\.kept, phase\.purchase\.rail\) : null\)/)
    const account = read('src/app/account/account-client.tsx')
    expect(account).toMatch(/dollarsTill\.unfinishedPays\?\.\(\)/)
    expect(account).toMatch(/recentTillPurchasesOf\(store, book, account\)/)
  })

  it('says what the chain took once it lands, and sums and says apart what was paid beside the cards that worked', () => {
    expect(caughtUpLine({ kept: 0, reported: 0, waiting: 1 })).toBeNull()
    expect(caughtUpLine({ kept: 1, reported: 0, waiting: 0 })).toBe('The card the register did not need is in your store credit now.')
    expect(caughtUpLine({ kept: 0, reported: 1, waiting: 0, said: ['At Target, something.'] })).toBe('Your report has reached the chain now. At Target, something.')
    const a: TillReceipt = { paidCents: 1_600, savedCents: 400, depositCents: 0, keptCents: 0, creditPaidCents: 1_440 }
    const b: TillReceipt = { paidCents: 900, savedCents: 100, depositCents: 0, keptCents: 0, disputedCents: 810 }
    const sum = sumReceipts([a, b])
    expect(sum).toEqual({ paidCents: 2_500, savedCents: 500, depositCents: 0, keptCents: 0, creditPaidCents: 1_440, disputedCents: 810 })
    expect(sumReceipts([receipt])).toEqual(receipt)
    expect(alsoPaidLine(sum)).toBe('You also paid $14.40 for store credit and $8.10 for a card that did not work.')
    expect(alsoPaidLine(receipt)).toBeNull()
    const tillPage = read('src/app/pay/[store]/till-client.tsx')
    expect(tillPage).toMatch(/<h1>\{doneLine\(receipt\)\}<\/h1>\s+\{alsoPaidLine\(receipt\) && <p className="sub">\{alsoPaidLine\(receipt\)\}<\/p>\}/)
    expect(tillPage).toMatch(/stillOwedLine\(t\.receipt[^\n]*\n\s+\{alsoPaidLine\(t\.receipt\) &&/)
  })
})

describe('a code is never kept on the phone', () => {
  it('a purchase kept with its code on it is written without it', async () => {
    const fake = new FakeIndexedDB()
    const store = await openCardStore(fake.asFactory())
    const now = Date.now()
    await keepTillPurchase(store, { id: 'p1', store: 'target', purchase, receipt, createdAt: now })
    const [kept] = await store.tillPurchases()
    expect(kept?.purchase).toEqual({ rail: 'card', ref: purchase.ref, plan: purchase.plan })
    // Nowhere in what the database holds: not the payload, not the drawing.
    expect(JSON.stringify([...fake.dump()])).not.toContain(code.barcode)
  })

  it('one an earlier build kept with a code is written again without it when read', async () => {
    const fake = new FakeIndexedDB()
    const store = await openCardStore(fake.asFactory())
    // As an earlier build wrote it: the whole purchase, code and all.
    fake.databases.get('salvo-pay')?.data.get('kv')?.set('till:old', { id: 'old', store: 'target', purchase, receipt, createdAt: Date.now() })
    expect(JSON.stringify([...fake.dump()])).toContain(code.barcode)
    const [read] = await store.tillPurchases()
    expect(read?.purchase).not.toHaveProperty('code')
    expect(JSON.stringify([...fake.dump()])).not.toContain(code.barcode)
  })
})

describe('a Pay whose page closed before it answered', () => {
  it('is kept with its key before it is sent, found by the till again, and forgotten once answered', async () => {
    const store = await openCardStore(new FakeIndexedDB().asFactory())
    const now = Date.now()
    await keepPendingPay(store, { key: 'k'.repeat(32), store: 'target', plan: tillPlan(), at: now })
    expect(await unfinishedPay(store, 'target', now + 60_000)).toMatchObject({ key: 'k'.repeat(32), store: 'target' })
    await endPendingPay(store, 'target')
    expect(await unfinishedPay(store, 'target', now + 60_000)).toBeNull()
  })

  it('blocks Pay until it is checked, so no new key is made over it', () => {
    // The finding: Pay stayed open after a reload, made a new key, bought a
    // second time, and wrote over the only record of the first.
    const base = { paying: false, busy: false, plan: tillPlan(), method: null, unfinished: false, railPending: false }
    expect(payDisabled(base)).toBe(false)
    expect(payDisabled({ ...base, unfinished: true })).toBe(true)
    // While "Check it" runs, too.
    expect(payDisabled({ ...base, busy: true })).toBe(true)
    expect(payDisabled({ ...base, plan: null })).toBe(true)
  })

  it('waits while the till is still finding which way it pays', () => {
    // The finding: the till started on the card, a Pay went on the card, and the rail switched to dollars under it.
    const base = { paying: false, busy: false, plan: tillPlan(), method: null, unfinished: false, railPending: false }
    expect(payDisabled({ ...base, railPending: true })).toBe(true)
    const tillPage = read('src/app/pay/[store]/till-client.tsx')
    expect(tillPage).toMatch(/const waiting = railPending && t\.keptPay === null/)
    expect(tillPage).toMatch(/plan && !waiting \? \(\s+payLabel\(plan\)/)
    expect(tillPage).toMatch(/const pending = chosen === null && found === null && \(!loaded \|\| defaultRail === null\)/)
  })

  it('a plan paid wholly from store credit is never blocked by dollars it does not use', () => {
    const noDollars = { ready: false, label: 'dollars', spendableCents: 0, problem: 'There are no dollars on this phone to spend.', checked: true }
    const credit: RoutePlan = {
      ...tillPlan(),
      rail: 'stablecoin',
      legs: [{ ref: 'own:typed-1', source: 'own_credit', firstInLine: false, faceCents: 4_000, appliedCents: 3_213, costCents: 0, leftoverCents: 787, depositCents: 0, scanIndex: 1, scanOf: 1 }],
      totalCents: 3_213,
      costCents: 0,
      savingCents: 0,
      depositCents: 0,
    }
    const base = { paying: false, busy: false, method: noDollars, unfinished: false, railPending: false }
    expect(payDisabled({ ...base, plan: credit })).toBe(false)
    expect(payDisabled({ ...base, plan: { ...tillPlan(), rail: 'stablecoin' } })).toBe(true)
  })

  it('a Pay at another store never writes over one this phone has not heard back from', async () => {
    const store = await openCardStore(new FakeIndexedDB().asFactory())
    const now = Date.now()
    await keepPendingPay(store, { key: 'k'.repeat(32), store: 'target', plan: tillPlan(), at: now })
    await keepPendingPay(store, { key: 'j'.repeat(32), store: 'bestbuy', plan: tillPlan(), at: now })
    expect(await unfinishedPay(store, 'target', now)).toMatchObject({ key: 'k'.repeat(32) })
    expect((await unfinishedPays(store, now)).map((p) => p.store).sort()).toEqual(['bestbuy', 'target'])
    await endPendingPay(store, 'bestbuy')
    expect(await unfinishedPay(store, 'target', now)).toMatchObject({ key: 'k'.repeat(32) })
  })

  it('an earlier build\'s one slot is still found, and ended', async () => {
    const fake = new FakeIndexedDB()
    const store = await openCardStore(fake.asFactory())
    fake.databases.get('salvo-pay')?.data.get('kv')?.set('till-pending', { key: 'o'.repeat(32), store: 'target', plan: tillPlan(), at: Date.now() })
    expect(await unfinishedPay(store, 'target')).toMatchObject({ key: 'o'.repeat(32) })
    await endPendingPay(store, 'target')
    expect(await unfinishedPay(store, 'target')).toBeNull()
  })

  it('a kept key goes back with the plan it went with, to that plan\'s rail, whatever the keypad priced since', () => {
    // The finding: after "still going" the keypad priced the total again, and
    // the next tap sent the old key with the new plan. On the dollars rail that
    // plan named other cards, the purchase was "not on this phone", the key
    // ended, and the tap after paid a second time. And on a rail switched
    // since, the key went to a rail that never heard of it.
    const dollarsPlan: RoutePlan = { ...tillPlan(), rail: 'stablecoin', quoteRef: 'plan_first' }
    const cardPlan: RoutePlan = { ...tillPlan(), rail: 'card', quoteRef: 'card:target:5213' }
    const sent = payToSend({ key: 'k'.repeat(32), plan: dollarsPlan }, cardPlan, () => 'new')
    expect(sent).toEqual({ key: 'k'.repeat(32), plan: dollarsPlan })
    expect(sent.plan.rail).toBe('stablecoin')
    expect(payToSend(null, cardPlan, () => 'n'.repeat(32))).toEqual({ key: 'n'.repeat(32), plan: cardPlan })
    // The hook sends it to that plan's rail, and the button shows that plan while the key is kept.
    const hook = read('src/app/pay/[store]/use-till.ts')
    expect(hook).toMatch(/const \{ key, plan: sending \} = payToSend\(payKey\.current, plan, newPayKey\)/)
    expect(hook).toMatch(/await backends\[sending\.rail\]\.pay\(sending, \{/)
    expect(hook).toMatch(/const buttonPlan: RoutePlan \| null = keptPay\?\.plan \?\?/)
    expect(quoteNeed({ phase: 'keypad', cents: 3_213, requotedFor: null, keyKept: true })).toBe('keep')
  })

  it('"Check it" asks the rail its Pay was made on, and every move goes to the purchase\'s own rail', () => {
    // The finding: a card Pay checked on the dollars backend (or the other way)
    // found no purchase, said nothing was charged, and dropped the record.
    const hook = read('src/app/pay/[store]/use-till.ts')
    expect(hook).toMatch(/holdKey\(\{ key: asking\.key, plan: asking\.plan \}\)\s+setNotice\(null\)\s+try \{\s+const out = await payWithKey\(asking\.plan, \{ resume: true \}\)/)
    for (const move of ['next', 'done', 'report', 'changeTotal']) {
      expect(hook).toMatch(new RegExp(`backends\\[phase\\.purchase\\.rail\\]\\.${move}\\(phase\\.purchase`))
    }
    expect(hook).toMatch(/backends\[purchase\.rail\]\.report\(purchase, scanIndex, o\)/)
    expect(hook).toMatch(/landPurchase\(backends\[out\.rail\], out, typed\)/)
    // Nothing on a purchase is asked of whatever rail the till is on now.
    expect(hook).not.toMatch(/await backend\.(next|done|report|pay)\(/)
    // The one changeTotal on a passed backend is landPurchase's, handed the purchase's own rail.
    expect(hook.match(/await backend\.changeTotal\(/g)?.length).toBe(1)
    // The pending Pay is read once per store, never again when the rail changes under a Pay going through; what the
    // catch-up gave back is said.
    expect(hook).toMatch(/void \(backends\.stablecoin\.catchUp\?\.\(\) \?\? Promise\.resolve\(null\)\)\.then\([\s\S]{0,200}caughtUpLine\(out\)[\s\S]{0,200}\}, \[store, backends, askAgainSoon\]\)/)
  })

  it('the till takes up another rail only on an idle keypad', () => {
    // The finding: the rail resolved to dollars with card 1 of 2 on screen, and Next asked the dollars backend.
    const idle = { phase: 'keypad' as const, busy: false, keyKept: false, unfinished: false }
    expect(railMayChange(idle)).toBe(true)
    for (const phase of ['paying', 'scan', 'owed', 'uncovered', 'done'] as const) expect(railMayChange({ ...idle, phase })).toBe(false)
    expect(railMayChange({ ...idle, busy: true })).toBe(false)
    expect(railMayChange({ ...idle, keyKept: true })).toBe(false)
    expect(railMayChange({ ...idle, unfinished: true })).toBe(false)
    const hook = read('src/app/pay/[store]/use-till.ts')
    expect(hook).toMatch(/const idle = railMayChange\(\{ phase: phase\.kind, busy, keyKept: keptPay !== null, unfinished: unfinished !== null \}\)/)
    expect(hook).toMatch(/if \(!idle \|\| rail === active\) return/)
  })

  it('a tap the server says is still going keeps its key; any other answer ends it', () => {
    expect(keepsKey(new TillRefused('still_going', 'Your last tap is still going through.', 409))).toBe(true)
    expect(keepsKey(new TillRefused('network', 'We could not tell.', 0))).toBe(true)
    expect(keepsKey(new TillRefused('try_again', 'We could not reach your bank.', 502))).toBe(false)
    expect(keepsKey(new TillRefused('closed', 'That Pay did not go through.', 409))).toBe(false)
  })

  it('a purchase that already ended comes back as its handle and receipt, never as a code to show', async () => {
    const plan = tillPlan()
    const backend = cardBackend(async () =>
      new Response(JSON.stringify({ ended: true, purchase: 'tp2.ended', plan, receipt, message: 'That Pay already went through. It is in Account, with what was charged.' }), { status: 200 }),
    )
    const out = await backend.pay(plan, { key: 'k'.repeat(32), resume: true })
    expect(out).toEqual({ ended: { rail: 'card', ref: 'tp2.ended', plan }, receipt, message: expect.stringContaining('It is in Account') })
    expect(out).not.toHaveProperty('code')
  })

  it('asks with the same key and only to find what that tap did', async () => {
    const sent: Array<Record<string, unknown>> = []
    const backend = cardBackend(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ purchase: 'tp2.x', plan: tillPlan(), code }), { status: 200 })
    })
    await backend.pay(tillPlan(), { key: 'k'.repeat(32), resume: true })
    expect(sent[0]).toMatchObject({ key: 'k'.repeat(32), resume: true })
    await backend.pay(tillPlan(), { key: 'j'.repeat(32) })
    expect(sent[1]).not.toHaveProperty('resume')
  })
})

describe('a tap asked again after the total changed', () => {
  /** A backend whose changeTotal answers as the server would, and says what it was asked. */
  function changing(answer: (p: Purchase, t: number) => Promise<ChangeAnswer>) {
    const asked: number[] = []
    return {
      asked,
      backend: {
        changeTotal: async (p: Purchase, t: number) => {
          asked.push(t)
          return answer(p, t)
        },
      },
    }
  }
  const resumed: Purchase = { ...purchase, plan: { ...tillPlan(), totalCents: 5_213 } }

  it('changes the purchase it found to the total typed, so the register gets what it now says', async () => {
    // The finding: the old $52.13 purchase came back for $55.13 typed, and
    // the register was still $3.00 short after Done.
    const add = tillAddPlan()
    const { asked, backend } = changing(async (p) => ({
      purchase: { ...p, ref: 'tp2.changed', plan: { ...p.plan, totalCents: 5_513 } },
      owed: add,
      cover: { scanIndex: 1, coversCents: 2_100, leftoverCents: 0, depositCents: 0 },
      tooLow: false,
      notNeeded: false,
    }))
    const landed = await landPurchase(backend, resumed, 5_513)
    expect(asked).toEqual([5_513])
    expect(landed.purchase.ref).toBe('tp2.changed')
    expect(landed.phase).toMatchObject({ kind: 'scan', then: add, code: { barcode: code.barcode } })
    expect(landed.error).toBeNull()
  })

  it('asks nothing when the purchase is for the total typed', async () => {
    const { asked, backend } = changing(async () => {
      throw new Error('not asked')
    })
    const landed = await landPurchase(backend, resumed, 5_213)
    expect(asked).toEqual([])
    expect(landed).toEqual({ purchase: resumed, phase: { kind: 'scan', purchase: resumed, code, then: null, tooLow: false, notNeeded: false }, error: null })
  })

  it('keeps the code on screen and says what to do when the change cannot be asked now', async () => {
    const { backend } = changing(async () => {
      throw new TillRefused('network', 'We could not tell if that went through. Try again.', 0)
    })
    const landed = await landPurchase(backend, resumed, 5_513)
    expect(landed.phase).toMatchObject({ kind: 'scan', code: { barcode: code.barcode } })
    expect(landed.error).toMatch(/This is the Pay you tapped before, for \$52\.13\. If the register says \$55\.13/)
  })
})

describe('what the tap needs, fetched while the shopper types', () => {
  it('0.4 s after the total stopped changing, at once for a price that lands after that, never for another total', () => {
    // Measured 2026-10-14: preparing 0.8 s after the total stopped left the tap waiting 0.93 s on the tickets.
    expect(prepareDelayMs({ planCents: 3_613, cents: 3_613, typedAt: 1_000, now: 1_100 })).toBe(300)
    expect(prepareDelayMs({ planCents: 3_613, cents: 3_613, typedAt: 1_000, now: 1_400 })).toBe(0)
    expect(prepareDelayMs({ planCents: 3_613, cents: 3_613, typedAt: 1_000, now: 1_750 })).toBe(0)
    // A price for a total the shopper has since changed: its tickets would only be dropped.
    expect(prepareDelayMs({ planCents: 361, cents: 3_613, typedAt: 1_000, now: 1_750 })).toBeNull()
  })

  it('the tap tells the backend it is the tap, so the dollars rail marks how long it waited', () => {
    const src = read('src/app/pay/[store]/use-till.ts')
    expect(src).toMatch(/if \(held === null\) await backends\[plan\.rail\]\.prepare\(plan, \{ tap: true \}\)/)
    expect(src).toMatch(/const PREPARE_AFTER_MS = 400(?!\d)/)
  })
})

describe('the price on the button after Pay came back with a new one', () => {
  it('is kept for that total rather than asked for again, and asked for again once the total changes', () => {
    // The finding: the quote ran again after the requote, put the deposit plan
    // back, and every tap held and released the same cards again.
    expect(quoteNeed({ phase: 'keypad', cents: 1_613, requotedFor: 1_613 })).toBe('keep')
    expect(quoteNeed({ phase: 'keypad', cents: 1_614, requotedFor: 1_613 })).toBe('ask')
    expect(quoteNeed({ phase: 'keypad', cents: 1_613, requotedFor: null })).toBe('ask')
    expect(quoteNeed({ phase: 'paying', cents: 1_613, requotedFor: null })).toBe('off')
    expect(quoteNeed({ phase: 'keypad', cents: 0, requotedFor: null })).toBe('idle')
  })

  it('so the next tap sends the drains-only plan it shows', async () => {
    const drains: RoutePlan = { ...tillPlan(), depositCents: 0, quoteRef: 'card:target:1613:drain' }
    let body: Record<string, unknown> = {}
    const backend = cardBackend(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ purchase: 'tp2.x', plan: drains, code }), { status: 200 })
    })
    await backend.pay(drains, { key: 'k'.repeat(32) })
    expect(String(body.quoteRef)).toMatch(/:drain$/)
  })
})

describe('the card check', () => {
  it('a check that could not be read never locks Pay; a definite no does', async () => {
    const lost = cardBackend(async () => {
      throw new Error('no signal')
    })
    const m = await lost.method()
    expect(m).toMatchObject({ ready: false, checked: false })
    expect(payBlockedBy(m)).toBe(false)
    const noCard = cardBackend(async () => new Response(JSON.stringify({ cardRail: true, card: null, cardKnown: true }), { status: 200 }))
    const n = await noCard.method()
    expect(n).toMatchObject({ ready: false, checked: true })
    expect(payBlockedBy(n)).toBe(true)
    expect(payBlockedBy(null)).toBe(false)
  })
})

describe('the till and the account page, as written', () => {

  it('the paying beat is live, so nothing leads away from it, and the audit says so', () => {
    const tillPage = read('src/app/pay/[store]/till-client.tsx')
    // Paying, or "Check it" asking what an unfinished Pay did: both can open a code.
    expect(tillPage).toMatch(/const live = paying \|\| t\.busy/)
    expect(tillPage).toMatch(/className="reveal" aria-label=\{`Pay at \$\{storeName\}`\} \{\.\.\.\(live \? \{ 'data-live': '' \} : \{\}\)\}/)
    expect(tillPage).toMatch(/<StoreHead store=\{store\} storeName=\{storeName\} disabled=\{live\} \/>/)
    expect(tillPage).toMatch(/aria-label="Still to pay" \{\.\.\.\(t\.busy \? \{ 'data-live': '' \} : \{\}\)\}/)
    expect(read('scripts/ui-states.ts')).toMatch(/name: 'till-paying',\s*route: '\/pay\/target',\s*expect: \{ navReachable: false \}/)
  })

  it('Pay is off while an unfinished Pay waits to be checked, and says why', () => {
    const tillPage = read('src/app/pay/[store]/till-client.tsx')
    expect(tillPage).toMatch(/disabled=\{payDisabled\(\{ paying, busy: t\.busy, plan, method: t\.method, unfinished: t\.unfinished !== null, railPending: waiting \}\)\}/)
    expect(tillPage).toMatch(/\{t\.unfinished && !paying && <p className="hint mt-2">\{t\.unfinished\.open \? FINISH_OPEN_FIRST : CHECK_LAST_PAY_FIRST\}<\/p>\}/)
  })

  it('a card that must not be scanned has no barcode and no countdown on screen', () => {
    const tillPage = read('src/app/pay/[store]/till-client.tsx')
    expect(tillPage).toMatch(/\{tooLow \? DO_NOT_SCAN : scanTitle\(/)
    expect(tillPage).toMatch(/\{!tooLow && \(\s*<>\s*<p className="sub">\{coversLine\(code\)\}<\/p>\s*<figure className="barcode"/)
    expect(tillPage).toMatch(/\{notNeeded \? DONE : tooLowLabel\(purchase\.rail\)\}/)
  })

  it('a total too low for the card on screen can still be put right: "The total changed" stays under it', () => {
    // The finding: only "Use other cards" or "Done" was left, so a mistyped
    // total could not be corrected, and the only way on reported the card.
    const tillPage = read('src/app/pay/[store]/till-client.tsx')
    const tooLowBranch = tillPage.slice(tillPage.indexOf("{sheet === 'none' && tooLow && ("), tillPage.indexOf("{sheet === 'none' && !tooLow && ("))
    expect(tooLowBranch).toMatch(/onReport\('not_used'\)/)
    expect(tooLowBranch).toMatch(/setSheet\('total'\)[\s\S]*\{SHEET\.totalChanged\}/)
  })

  it('Account asks the server what each purchase came to, and signing out forgets the account in this browser', () => {
    const account = read('src/app/account/account-client.tsx')
    expect(account).toMatch(/\.receipt\(record\.purchase\)/)
    expect(account).toMatch(/await signOutHere\(\{ store, api \}\)/)
    expect(account).toMatch(/Sign out of this browser/)
    // Offered whenever this browser keeps an account, signed in or not.
    expect(account).toMatch(/\n {6}<SignOut store=\{store\} api=\{api\} onSignedOut=\{onSignedOut\} \/>/)
  })
})

describe('a till open in one tab while another signs out, or signs in', () => {
  it('the dollars rail asks the phone who is signed in before every move, and opens again for whoever is', () => {
    const dollars = read('src/lib/till/client/dollars.ts')
    // The finding: the key, the account and its store credit were read once, as the page opened, and kept paying after a sign-out.
    expect(dollars).toMatch(/if \('problem' in o \|\| \(await stillFor\(o\)\)\) return o\r?\n {4}if \(opening === first\) opening = null\r?\n {4}return openOnce\(\)/)
    expect(dollars).toMatch(/return lower\(passkey\?\.address\) === o\.account && lower\(key\?\.accessKeyAddress\) === o\.key/)
    // Every move goes through that check: none reads the backend opened first on its own.
    expect(dollars.match(/openOnce\(\)/g)).toHaveLength(2)
    expect(dollars).not.toMatch(/await opening\b/)
    // And the backend and the key in memory each ask too.
    expect(read('src/lib/escrow/client/dollars-backend.ts')).toMatch(/async pay\([^)]*\)[^{]*\{\r?\n {4}await this\.#refuseSignedOut\(\)/)
    expect(read('src/lib/escrow/client/wallet.ts')).toMatch(/async signPrepared\(p: PreparedBatch\): Promise<SignedBatch> \{\r?\n {4}await this\.#stillKept\(\)/)
  })

  it("the till remembers its store in its own slot, never the settings', so sign-in still brings the account's own settings", () => {
    const tillPage = read('src/app/pay/[store]/till-client.tsx')
    // The finding: the till wrote the settings slot on every open, signed in or not, and sign-in then kept those defaults.
    expect(tillPage).toMatch(/await rememberTillStore\(cards, store\)/)
    expect(tillPage).not.toMatch(/saveDeviceSettings/)
  })

  it('"Use that account here" says it signs the kept account out of this browser first', () => {
    const account = read('src/app/account/account-client.tsx')
    expect(account).toMatch(/Using it here signs this one out of this browser first: its settings, store\s+credit and recent purchases go from here\./)
    expect(read('src/lib/account/client/passkey.ts')).toMatch(/if \(existing !== null && existing\.address\.toLowerCase\(\) !== record\.address\.toLowerCase\(\)\) await d\.store\.forgetAccount\(\)\r?\n {2}await d\.store\.savePasskey\(record\)/)
  })
})

describe('the sign-in challenge', () => {
  /** A fetch of challenges, each answered when the test says. */
  function challenges() {
    const pending: Array<(v: string) => void> = []
    let n = 0
    const fetchOne = () =>
      new Promise<string>((res) => {
        n += 1
        pending.push(res)
      })
    return { fetchOne, pending, count: () => n }
  }

  it('is never refreshed while a sign-in uses it, and refreshed once it is done', async () => {
    const c = challenges()
    let now = 0
    const keeper = new ChallengeKeeper(c.fetchOne, () => now)
    keeper.refresh()
    c.pending[0]?.('c1')
    expect(await keeper.take()).toBe('c1')
    // The four-minute tick while the Face ID sheet is up: no new cookie.
    keeper.refresh()
    expect(c.count()).toBe(1)
    keeper.done()
    expect(c.count()).toBe(2)
    c.pending[1]?.('c2')
    await new Promise((r) => setTimeout(r, 0))
    // Held too long to trust: the sign-in fetches its own.
    now = CHALLENGE_FRESH_MS
    expect(await keeper.take()).toBeNull()
  })

  it('waits for a fetch already on its way, so its cookie cannot land after the sign-in\'s', async () => {
    const c = challenges()
    const keeper = new ChallengeKeeper(c.fetchOne, () => 0)
    keeper.refresh()
    const taking = keeper.take()
    c.pending[0]?.('c1')
    expect(await taking).toBe('c1')
  })
})

describe('the words on the account page and the till', () => {
  const account = read('src/app/account/account-client.tsx')
  const tillPage = read('src/app/pay/[store]/till-client.tsx')

  it("the till's tick is on the rail the till pays with, by the till's own rule, and dollars count only with a key for its escrow", () => {
    // One place says "Pays at the till": the mark, which goes on the rail effectiveRail picks.
    expect(account.match(/Pays at the till/g)?.length).toBe(1)
    expect(account).toMatch(/function TillMark\(\)[\s\S]{0,200}Pays at the till/)
    expect(account).toMatch(/const payWith = effectiveRail\(settings, \{ card: cardReady, stablecoin: dollarsReady \}\)/)
    expect(account).toMatch(/till=\{payWith === 'stablecoin' \? 'this' : dollarsReady \? 'other' : 'none'\}/)
    expect(account).toMatch(/till=\{payWith === 'card' \? 'this' : cardReady \? 'other' : 'none'\}/)
    // Dollars are ready only with a key scoped to SalvoEscrowV2 and an allowance not ended.
    expect(account).toMatch(/const dollarsReady = wallet !== null && !ended && v2\.phase === 'open' && keyScopedForV2\(wallet, v2\.escrow\)/)
    expect(account).toMatch(/These pay at the till, for only what you use\./)
    // The default is the shopper's to set, and saved as the till reads it.
    expect(account).toMatch(/save\(withDefaultRail\(settings, rail\)\)/)
    // The till picks its rail from the account's setting, or whichever is set up, by the rule that reads an unread check as unknown.
    expect(tillPage).toMatch(/tillRail\(defaultRail, answers\)/)
  })

  it('/account ticks dollars only when the till would pay with them: something to spend, and this account\'s own key', () => {
    // The finding: a $0 balance ticked dollars on /account while the till held the card.
    expect(account).toMatch(/spendableUnits\(chain\.balance, chain\.allowance, ready\.access\.sponsorUrl !== null\)/)
    expect(account).toMatch(/keyScopedForV2\(wallet, v2\.escrow\) && !nothingToSpend/)
    expect(read('src/lib/escrow/client/dollars-backend.ts')).toMatch(/units: spendableUnits\(balance, allowance, this\.#d\.access\.sponsorUrl !== null\)/)
    // The finding: signed out and in as another account, the page kept the first one's key.
    expect(account).toMatch(/const wallet = keyOfAccount\(walletKept, passkey\.address\)/)
    expect(account).toMatch(/onSignedOut=\{onReload\}/)
    expect(account).toMatch(/await resumePurchase\(\{ store, api: ready\.api, config: ready\.config, access: ready\.access, wallet \}, id\)/)
    expect(account).not.toMatch(/ready\.wallet === null/)
  })

  it('/account lists only this account\'s store credit and deposits, keeps the V2 book open, and shows bought cards signed out', () => {
    expect(account).toMatch(/storeCreditList\(store, book, account\)/)
    expect(account).toMatch(/heldDepositsV2\(book, hosts, escrow, account\)/)
    expect(account).toMatch(/const book = useBookV2\(\)/)
    expect(account).not.toMatch(/useBookV2\(ready/)
    // Signed out, the first escrow's cards still show with their codes.
    expect(account).toMatch(/<SignIn store=\{store\} api=\{api\} ready=\{ready\} onDone=\{signedIn\} \/>\s+<BoughtHere store=\{store\} \/>/)
    expect(account).toMatch(/function BoughtHere[\s\S]{0,3000}<CardCodeFigure store=\{store\} card=\{c\} \/>/)
    // Counted from every record kept, and never a card sold back.
    expect(account).toMatch(/keepableCards\(bought, ownAll, soldBack\)/)
    expect(account).toMatch(/keepAsCredit\(store, card, toCents\(left\), book\)/)
  })

  it('store credit is used at the till, and its setting does what it says', () => {
    expect(account).toMatch(/The till uses them first, at no cost\./)
    expect(account).toMatch(/Use my store credit first/)
    expect(account).toMatch(/aria-pressed=\{settings\.ownCreditFirst\}/)
    expect(account).toMatch(/ownCreditFirst: !settings\.ownCreditFirst/)
    // The card rail plans on our server, which never sees these cards: said, and the setting is off there.
    expect(account).toMatch(/\{payWith === 'card' \? CREDIT_CARD_RAIL : 'The till uses them first, at no cost\.'\}/)
    expect(account).toMatch(/const CREDIT_CARD_RAIL = 'The till uses them only when it pays with your dollars\. Paying by card, it does not use them yet\.'/)
    expect(account).toMatch(/disabled=\{payWith === 'card'\}/)
    expect(tillPage).toMatch(/\{t\.rail === 'card' && hasCredit && <p className="hint mt-2">\{creditDollarsOnly\(storeName\)\}<\/p>\}/)
    // A card the register did not need that the chain has not kept yet is said, with a way to ask again.
    expect(account).toMatch(/keepsWaitingV2\(book, account\)/)
    expect(account).toMatch(/void dollarsTill\.catchUp\?\.\(\)/)
    // The dollars backend reads the same setting, and /account's list is its store credit.
    const dollars = read('src/lib/till/client/dollars.ts')
    expect(dollars).toMatch(/ownCreditFirst: settings\?\.ownCreditFirst !== false/)
    expect(dollars).toMatch(/ownCards: store/)
  })

  it('store credit that covers the total is never stranded: offered while the till pays by card, and whatever the dollars balance says', () => {
    // The finding: dollars "not ready" (no balance, the week's allowance used) dropped the store credit, and the card was charged.
    const noDollars = { ready: false, label: 'dollars', spendableCents: 0, problem: 'There are no dollars on this phone to spend.', checked: true }
    const credit: RoutePlan = {
      ...tillPlan(),
      rail: 'stablecoin',
      totalCents: 1_200,
      costCents: 0,
      savingCents: 0,
      depositCents: 0,
      legs: [{ ref: 'own:typed-1', source: 'own_credit', firstInLine: false, faceCents: 1_600, appliedCents: 1_200, costCents: 0, leftoverCents: 400, depositCents: 0, scanIndex: 1, scanOf: 1 }],
    }
    expect(otherWayPlan(noDollars, credit)).toBe(credit)
    expect(otherWayPlan(noDollars, { ...tillPlan(), rail: 'stablecoin' })).toBeNull()
    expect(otherWayPlan({ ...noDollars, ready: true, problem: null }, { ...tillPlan(), rail: 'stablecoin' })).not.toBeNull()
    expect(otherWayPlan({ ...noDollars, ready: true }, { unavailable: 'Nothing here.' })).toBeNull()
    expect(otherRailLabel('stablecoin', credit)).toBe('Use your store credit instead')
    // Asked only while paying by card, for a total the credit here could cover.
    expect(creditMayPay({ rail: 'card', cents: 1_200, creditCents: 1_600 })).toBe(true)
    expect(creditMayPay({ rail: 'card', cents: 1_700, creditCents: 1_600 })).toBe(false)
    expect(creditMayPay({ rail: 'card', cents: 0, creditCents: 1_600 })).toBe(false)
    expect(creditMayPay({ rail: 'stablecoin', cents: 1_200, creditCents: 1_600 })).toBe(false)
    expect(tillPage).toMatch(/const offered = otherWayPlan\(m, out\)\s+setPlan\(offered\)/)
    // A price the other way cannot take yet is kept too, with the one step in its way: never offered, always said.
    expect(tillPage).toMatch(/setPreview\(offered === null && !\('unavailable' in out\) && !m\.ready && m\.problem \? \{ plan: out, problem: m\.problem \} : null\)/)
    expect(tillPage).toMatch(/const creditCould = idleKeypad && !cannot && creditMayPay\(\{ rail: t\.rail, cents: t\.cents, creditCents \}\)/)
    expect(tillPage).toMatch(/ask: cannot \|\| creditCould/)
    expect(tillPage).toMatch(/const otherWay = otherPlan !== null && \(cannot \|\| \(creditCould && costsNothing\(otherPlan\)\)\)/)
  })

  it('"Use your store credit instead" switches for one purchase, never the visit; "Pay by card instead" holds for the visit', () => {
    // The finding: the credit button set the same per-visit switch as "Pay by card instead", nothing cleared it, and
    // "Pay again" for $40 was priced in dollars ("from your dollars"), or said there was not enough at the store.
    const credit: RoutePlan = {
      ...tillPlan(),
      rail: 'stablecoin',
      totalCents: 2_500,
      costCents: 0,
      savingCents: 0,
      depositCents: 0,
      legs: [{ ref: 'own:typed-1', source: 'own_credit', firstInLine: false, faceCents: 3_000, appliedCents: 2_500, costCents: 0, leftoverCents: 500, depositCents: 0, scanIndex: 1, scanOf: 1 }],
    }
    const dollarsPlan: RoutePlan = { ...tillPlan(), rail: 'stablecoin' }
    const cardPlan: RoutePlan = { ...tillPlan(), rail: 'card' }
    // Store credit: for this purchase; once it ends, the account's own way (null: nothing switched).
    const once = switchTo(NO_SWITCH, 'stablecoin', credit)
    expect(otherRailLabel('stablecoin', credit)).toBe('Use your store credit instead')
    expect(switchedRail(once)).toBe('stablecoin')
    expect(switchedRail(endOnce(once))).toBeNull()
    // "Pay by card instead", "Pay with dollars instead": for the visit, and the purchase's end leaves them.
    const byCard = switchTo(NO_SWITCH, 'card', cardPlan)
    expect(switchedRail(endOnce(byCard))).toBe('card')
    expect(switchedRail(endOnce(switchTo(NO_SWITCH, 'stablecoin', dollarsPlan)))).toBe('stablecoin')
    // Store credit after "Pay by card instead": back to the card after it. And the other way's button ends a switch for one purchase.
    expect(switchedRail(endOnce(switchTo(byCard, 'stablecoin', credit)))).toBe('card')
    expect(switchTo(once, 'card', cardPlan)).toEqual({ visit: 'card', once: null })
    expect(endOnce(NO_SWITCH)).toBe(NO_SWITCH)
    // On an idle keypad, a total past the credit here outgrows it; nothing typed yet, or a total it covers, does not.
    expect(onceOutgrown({ idle: true, cents: 4_000, creditCents: 3_000 })).toBe(true)
    expect(onceOutgrown({ idle: true, cents: 3_000, creditCents: 3_000 })).toBe(false)
    expect(onceOutgrown({ idle: true, cents: 0, creditCents: 3_000 })).toBe(false)
    expect(onceOutgrown({ idle: false, cents: 4_000, creditCents: 3_000 })).toBe(false)
    // Wired: the till's rail reads the switch, the button hands its plan, and "Pay again" and "Start again" end it.
    expect(tillPage).toMatch(/const chosen = switchedRail\(switched\)\r?\n\s+const rail: Rail = chosen \?\? found \?\? defaultRail \?\? 'card'/)
    expect(tillPage).toMatch(/const choose = useCallback\(\(to: Rail, plan: RoutePlan \| null\) => setSwitched\(\(s\) => switchTo\(s, to, plan\)\), \[\]\)/)
    expect(tillPage).toMatch(/const outgrown = onceOutgrown\(\{ idle: idleKeypad, cents: t\.cents, creditCents \}\)\r?\n\s+useEffect\(\(\) => \{\r?\n\s+if \(outgrown\) onOnceOver\(\)/)
    expect(tillPage).toMatch(/const startOver = \(\) => \{\r?\n\s+onOnceOver\(\)\r?\n\s+t\.startOver\(\)\r?\n\s+\}/)
    expect(tillPage).toMatch(/onClick=\{startOver\}>\s+\{START_AGAIN\}/)
    expect(tillPage).toMatch(/onAgain=\{startOver\}/)
    expect(tillPage).not.toMatch(/t\.startOver\}/)
    // The reason under the button is never the same sentence as the way's own problem said beside Account.
    expect(tillPage).toMatch(/\{!plan && otherPreview === null && t\.quote\.kind === 'unavailable' && \(nothing \|\| t\.quote\.message !== problem\) && \(/)
  })

  it('a dollars purchase whose page went with a card on screen is offered again as that, and kept under its own record', () => {
    expect(tillPage).toMatch(/t\.unfinished\.open \? openPurchaseLine\(storeName, t\.unfinished\.open\) : unfinishedPayLine\(storeName, t\.unfinished\.plan\)/)
    expect(tillPage).toMatch(/\{t\.unfinished\.open \? SHOW_OPEN : SHOW_LAST_PAY\}/)
    expect(account).toMatch(/p\.open \? openPurchaseLine\(tillStoreName\(p\.store\), p\.open\) : unfinishedPayLine\(tillStoreName\(p\.store\), p\.plan\)/)
    const hook = read('src/app/pay/[store]/use-till.ts')
    expect(hook).toMatch(/else if \(!isRequote\(out\)\) started\(out, await keptRecordOf\(device\.current, out\.ref\)\)/)
  })

  it('a purchase opened again comes back as its card stood: not to be scanned, or with the rest under it, never a plain code to scan', () => {
    const plan: RoutePlan = { ...tillPlan(), rail: 'stablecoin' }
    const back: Purchase = { rail: 'stablecoin', ref: 'v2-open', plan, code }
    // As drawn: a code to scan, with the note it came with.
    expect(phaseOnScreen(back, 'why')).toEqual({ phase: { kind: 'scan', purchase: back, code, then: null, tooLow: false, notNeeded: false, note: 'why' }, error: null })
    // The finding: a card the shopper was told not to scan came back with its barcode, its old "covers" and Done.
    const cover = { scanIndex: 1, coversCents: code.coversCents, leftoverCents: code.leftoverCents, depositCents: code.depositCents }
    const low = phaseOnScreen({ ...back, standing: { owed: null, cover, tooLow: true, notNeeded: false } })
    expect(low.phase).toMatchObject({ kind: 'scan', tooLow: true, notNeeded: false, then: null, code: { scanOf: 1 } })
    expect(low.phase.purchase).toEqual(back)
    expect(phaseOnScreen({ ...back, standing: { owed: null, cover, tooLow: true, notNeeded: true } }).phase).toMatchObject({ tooLow: true, notNeeded: true })
    // The rest still owed under it, or why it has no plan now.
    const add = tillAddPlan()
    expect(phaseOnScreen({ ...back, standing: { owed: add, cover, tooLow: false, notNeeded: false } })).toMatchObject({ phase: { tooLow: false, then: add }, error: null })
    expect(phaseOnScreen({ ...back, standing: { owed: { unavailable: 'Try the new total again.' }, cover, tooLow: false, notNeeded: false } })).toMatchObject({
      phase: { tooLow: false, then: null },
      error: 'Try the new total again.',
    })
    const hook = read('src/app/pay/[store]/use-till.ts')
    expect(hook).toMatch(/const on = phaseOnScreen\(p, note\)\r?\n\s+remember\(on\.phase\.purchase, null, kept\)\r?\n\s+setPhase\(on\.phase\)/)
  })

  it('"Show it" asks the phone again first, for whoever is signed in now, and never asks with another account\'s key', () => {
    const plan: RoutePlan = { ...tillPlan(), rail: 'stablecoin' }
    const asking = { key: 'tap-a', store: 'target', plan, at: 1, open: { shown: 1, scanOf: 2 } }
    expect(stillOffered(asking, asking)).toBe(true)
    // Signed out in another tab, and someone else signed in: the phone has no such Pay for them, or another of theirs.
    expect(stillOffered(asking, null)).toBe(false)
    expect(stillOffered(asking, { ...asking, key: 'tap-b' })).toBe(false)
    expect(stillOffered(asking, { ...asking, plan: { ...plan, rail: 'card' } })).toBe(false)
    const hook = read('src/app/pay/[store]/use-till.ts')
    const resume = hook.slice(hook.indexOf('const resumeUnfinished = useCallback('), hook.indexOf('/** The card on screen scanned: show the next one.'))
    expect(resume).toMatch(/if \(!stillOffered\(offered, now\)\) \{\r?\n\s+if \(payKey\.current\?\.key === offered\.key\) holdKey\(null\)\r?\n\s+setUnfinished\(now\)\r?\n\s+return\r?\n\s+\}/)
    // Asked before anything is sent with the key.
    expect(resume.indexOf('stillOffered(offered, now)')).toBeLessThan(resume.indexOf('payWithKey('))
  })

  it('never says "nothing here" beside the other way\'s price, which is then the way on', () => {
    // The finding: "Nothing at Target right now. Pay your usual way." over "Pay by card instead · $46.92".
    expect(tillPage).toMatch(/nothing \? \(otherWay \? nothingThisWay\(t\.rail, storeName\) : nothingListed\(storeName\)\) : t\.quote\.message/)
    expect(tillPage).toMatch(/\{!plan && nothing && !otherWay && otherPreview === null && \(\s+<Link className="textlink textlink--tap mt-2" href=\{demoHref\(store, t\.cents\)\} prefetch>/)
    // A phone that cannot pay with dollars yet still sees the price, and the one step in its way, in place of "nothing here".
    expect(tillPage).toMatch(/\{!plan && otherPreview !== null && \(\s+<>\s+<p className="hint mt-2">\{previewLine\(other, otherPreview\.plan\)\}<\/p>/)
    expect(tillPage).toMatch(/\{otherWay && \(\s+<button type="button" className="btn btn--primary btn--block mt-4" onClick=\{\(\) => onSwitch\(other, otherPlan\)\}>/)
  })

  it('the till\'s button says it is pricing, or that there is no price, and never asks for a total already typed', () => {
    expect(tillPage).toMatch(/pricingLabel\(t\.cents\)/)
    expect(tillPage).toMatch(/NO_PRICE/)
    // Nothing listed is a flag from the server, not a guess at its words.
    expect(tillPage).toMatch(/t\.quote\.nothingListed/)
    expect(tillPage).not.toMatch(/no live\|nothing is listed/)
  })
})
