/**
 * After the till, on SalvoEscrowV2: what the shopper's phone can still do
 * about a purchase it made (unified spec sections 5.4 and 11).
 *
 *   - The total went down: `reduceUse`. Fewer cents used on the last card,
 *     the price difference back and the deposit raised by the face of the
 *     cents given back, in one pull. Only while the new leftover fits the
 *     card's cap; beyond it, the shopper keeps the rest instead.
 *   - The register said paid early, or the total fell past the cap: keep the
 *     rest of the card as store credit (`keepRest`, or nothing at all when
 *     the card was used up and is already theirs). One whose rest went to
 *     someone else meanwhile still holds what this sale paid for, and that
 *     much is kept (`keepPaidV2`).
 *   - The total went up with a card on screen that has cents left on it for
 *     the next shopper: a register takes a gift card's balance up to what is
 *     due, so that rest is bought first (`buyRestV2`, keepRest again), and
 *     never stays listed on a card the register is about to empty.
 *   - "That card was empty", on a leftover someone else's deposit covers:
 *     `contestRemainder`. The payment comes back at once, from the shopper's
 *     own pending payment, and that deposit pays the seller (decision 1).
 *   - "It didn't scan" or "the register declined it": `dispute`. The payout
 *     waits 48 hours longer, so the seller can refund.
 * The till sends a report on its own at the tap (dollars-backend.ts): a
 * report is kept on its purchase from the tap (records-v2.ts pendingReports)
 * until the chain has it, and sendPendingReportsV2 sends again what is still
 * owed. A batch may still carry one (load-v2.ts `before`), and one it carried
 * is noted when it lands.
 *
 * EVERY CALL IS THE SHOPPER'S ACCESS KEY, in its V2 scope (wallet-v2.ts), and
 * each is one the contract refuses a second time: a repeat cannot cost twice.
 * Each is checked against getDeposit and getListing on both hosts first, so
 * a call the contract would refuse is refused here with words instead, and
 * read back from getDeposit after, never from an event's name.
 *
 * Browser only by use; imports nothing Node-only.
 */

import { encodeFunctionData, erc20Abi, type Hex } from 'viem'
import { ESCROW_V2_ABI } from '../artifact-v2'
import { envelopeHashOf } from '../hashes'
import { termsOfManifestV2 } from '../hashes-v2'
import { UNITS_PER_CENT } from '../manifest'
import { parseEscrowManifestV2, type EscrowManifestV2 } from '../manifest-v2'
import { depositV2At, listingV2At, V2_STATE, type DepositViewV2, type ListingViewV2 } from '../runbook/reads-v2'
import { agreedFinalizedBlock, waitForReceiptFinal } from '../runbook/rpc'
import { priceForV2 } from '../terms-v2'
import type { EscrowPublicConfigV2 } from './api-v2'
import type { CardStore } from './card-store'
import type { BatchSigner } from './load'
import { cardIdV2, contestCallV2, disputeCallV2, REPORT_REASON } from './load-v2'
import {
  dropPendingReport,
  isCardV2,
  markReported,
  type BatchedAction,
  type CardRecordV2,
  type CreditRecordV2,
  type DeviceBookV2,
  type PurchaseLegV2,
  type PurchaseRecordV2,
} from './records-v2'
import type { BatchCall, ChainAccess } from './wallet'

export interface SaleDepsV2 {
  store: CardStore
  book: DeviceBookV2
  config: EscrowPublicConfigV2
  access: ChainAccess
  wallet: BatchSigner
}

/**
 * The call was not made. `message` is a plain sentence; nothing was sent
 * unless it says so. `lasting`: asking again will not change the answer (the
 * card was refunded, another shopper used it). False when it is only for now
 * (the chain has not caught up, the purchase is still confirming): the same
 * call later may go through, so a card to keep or a report to send is kept
 * on its purchase and tried again (dollars-backend.ts catchUp).
 */
export class SaleRefused extends Error {
  readonly lasting: boolean
  /**
   * The rest of the card can no longer be bought (another shopper used it,
   * or the seller was paid first), while what this sale paid for is still on
   * the card: keepPaidV2 keeps that much as the shopper's credit.
   */
  readonly restGone: boolean
  constructor(sentence: string, opts: { lasting?: boolean; restGone?: boolean } = {}) {
    super(sentence)
    this.name = 'SaleRefused'
    this.lasting = opts.lasting !== false
    this.restGone = opts.restGone === true
  }
}

const REST_GONE = { restGone: true } as const

const FOR_NOW = { lasting: false } as const

/** Said when the total fell past what the card may keep: the till offers this. */
export const KEEP_REST_SENTENCE = 'That leaves more on the card than it may keep for the next shopper. Keep the rest of this card as your store credit instead.'

const lower = (s: string): Hex => s.toLowerCase() as Hex

interface LegOnChain {
  p: PurchaseRecordV2
  leg: PurchaseLegV2
  id: bigint
  manifest: EscrowManifestV2
  deposit: DepositViewV2
  listing: ListingViewV2
  chainTime: number
}

/** The purchase's card, its sale and its listing as both hosts read them now. Throws SaleRefused. */
async function legOnChain(d: SaleDepsV2, purchaseId: string, scanOrder: number): Promise<LegOnChain> {
  const p = await d.book.purchase(purchaseId)
  if (p === null) throw new SaleRefused('That purchase is not on this phone.')
  if (p.state !== 'paid' && p.state !== 'done') throw new SaleRefused('That purchase is not paid yet, so there is nothing to change.', FOR_NOW)
  if (lower(p.depositor) !== lower(d.wallet.account)) throw new SaleRefused('That purchase was made by another account.')
  const leg = p.legs.find((l) => l.scanOrder === scanOrder)
  if (leg === undefined || leg.depositId === null) throw new SaleRefused('That card is not part of this purchase.')
  const manifest = parseEscrowManifestV2(leg.manifest, p.escrow)
  if (manifest === null || lower(p.escrow) !== d.config.escrow) throw new SaleRefused('That card is not on the escrow this page trusts.')
  const block = await agreedFinalizedBlock(d.access.hosts)
  const id = BigInt(leg.depositId)
  const [deposit, listing] = await Promise.all([
    depositV2At(d.access.hosts, block, p.escrow, id),
    listingV2At(d.access.hosts, block, p.escrow, leg.listingId),
  ])
  if (deposit.depositor !== lower(p.depositor) || deposit.listingId !== leg.listingId) throw new SaleRefused('The chain does not show this card as yours.')
  return { p, leg, id, manifest, deposit, listing, chainTime: Number(block.timestamp) }
}

/** One batch from the access key, final on both hosts. Throws SaleRefused when the chain did not take it. */
async function send(d: SaleDepsV2, calls: BatchCall[], what: string): Promise<void> {
  const signed = await d.wallet.signCalls(calls, d.access)
  await d.wallet.broadcast(signed, d.access)
  const { receipt } = await waitForReceiptFinal(d.access.hosts, signed.hash)
  if (receipt.status !== 'success') throw new SaleRefused(`The chain did not take ${what}. Nothing changed.`, FOR_NOW)
}

/** The sale as both hosts show it now. */
async function depositNow(d: SaleDepsV2, escrow: Hex, id: bigint): Promise<DepositViewV2> {
  return depositV2At(d.access.hosts, await agreedFinalizedBlock(d.access.hosts), escrow, id)
}

/** Keep card-store.ts's copy of the card in step with what it now covers. Sealed again under the same key. */
async function refreshCard(d: SaleDepsV2, p: PurchaseRecordV2, leg: PurchaseLegV2): Promise<void> {
  if (leg.depositId === null) return
  const id = cardIdV2(p.escrow, leg.depositId)
  const card = (await d.store.cards()).find((c) => c.id === id)
  const secret = card === undefined ? null : await d.store.cardSecret(id)
  if (card === undefined || secret === null || !isCardV2(card)) return
  // saveCard seals the card again under a new box; the old one is replaced.
  const meta: CardRecordV2 = { ...card, valueCents: leg.usedCents, usedCents: leg.usedCents, leftCents: leg.leftCents, priceUnits: Number(leg.amountUnits) }
  await d.store.saveCard(meta, secret)
}

/**
 * The total went down after paying, below what the cards cover: they now
 * cover `newCoveredCents`. The cut comes off the last card, which leaves the
 * rest of it for the next shopper, the deposit raised by the face of the
 * cents given back; nothing is left to pay the usual way. Throws
 * SaleRefused with KEEP_REST_SENTENCE when that leaves more than the card's
 * cap, and with words for anything else the contract would refuse.
 * `scanOrder` names the card the cut comes off when it is not the last: the
 * till's card on screen, once the cards after it were kept as credit.
 */
export async function reduceUseV2(d: SaleDepsV2, purchaseId: string, newCoveredCents: number, scanOrder?: number): Promise<PurchaseRecordV2> {
  const stored = await d.book.purchase(purchaseId)
  if (stored === null) throw new SaleRefused('That purchase is not on this phone.')
  const last = scanOrder === undefined ? stored.legs.reduce((a, b) => (b.scanOrder > a.scanOrder ? b : a)) : stored.legs.find((l) => l.scanOrder === scanOrder)
  if (last === undefined) throw new SaleRefused('That card is not part of this purchase.')
  const cut = stored.legs.reduce((n, l) => n + l.usedCents, 0) - newCoveredCents
  if (!Number.isSafeInteger(newCoveredCents) || newCoveredCents < 0 || cut <= 0) throw new SaleRefused('The new total is not lower than what the cards cover.')
  const c = await legOnChain(d, purchaseId, last.scanOrder)
  const newUsed = c.leg.usedCents - cut
  if (newUsed <= 0) throw new SaleRefused(KEEP_REST_SENTENCE)
  if (c.deposit.state !== V2_STATE.deposit.OPENED || c.chainTime >= c.deposit.releaseAt) throw new SaleRefused('The seller has been paid for this card, so it can no longer change.')
  if (c.listing.lastDeposit !== c.id) throw new SaleRefused('Another shopper has used this card since, so it can no longer change.')
  const ownRemainder = c.deposit.covers !== 0n && (await depositNow(d, c.p.escrow, c.deposit.covers)).depositor === lower(c.p.depositor)
  if (c.deposit.saleIndex !== 0 && !ownRemainder) throw new SaleRefused(KEEP_REST_SENTENCE)
  const drained = c.listing.state === V2_STATE.listing.DRAINED
  if (!drained && !(c.listing.state === V2_STATE.listing.ACTIVE && c.listing.bondDeposit === c.id)) throw new SaleRefused('This card can no longer change.')
  const leftNow = drained ? 0 : c.listing.remainingCents
  if (leftNow + cut > c.manifest.residualCapCents) throw new SaleRefused(KEEP_REST_SENTENCE)
  const newAmount = priceForV2(BigInt(c.manifest.price), c.manifest.valueCents, newUsed, 0)
  const refund = c.deposit.amount - newAmount
  const raise = BigInt(cut) * BigInt(UNITS_PER_CENT)
  const pull = raise - refund
  await send(
    d,
    [
      { to: d.config.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.config.escrow, pull] }) },
      {
        to: d.config.escrow,
        data: encodeFunctionData({
          abi: ESCROW_V2_ABI,
          functionName: 'reduceUse',
          args: [termsOfManifestV2(c.manifest), envelopeHashOf(c.leg.envelope), c.id, newUsed],
        }),
      },
    ],
    'the new total',
  )
  const after = await depositNow(d, c.p.escrow, c.id)
  if (after.usedCents !== newUsed) throw new SaleRefused('The chain does not show the new total yet. Look again in a minute.', FOR_NOW)
  c.leg.usedCents = newUsed
  c.leg.leftCents = after.leftAfterCents
  c.leg.amountUnits = after.amount.toString()
  c.leg.bondUnits = after.bond.toString()
  c.p.totalCents = newCoveredCents
  c.p.uncoveredCents = 0
  await d.book.savePurchase(c.p)
  await refreshCard(d, c.p, c.leg)
  return c.p
}

/**
 * Keep this card as store credit (spec sections 5.4 and 11): the register
 * took `takenCents` of it, and the rest is the shopper's to use next time or
 * sell back. A card left with cents on it for the next shopper is bought
 * whole first (`keepRest`: the rest at this sale's price, out of the
 * deposit, the rest of the deposit back). A card used up is already theirs:
 * nothing is sent. The credit names this purchase and card, so while the
 * sale is open a report about the credit is still a report on it.
 */
export async function keepCardV2(d: SaleDepsV2, purchaseId: string, scanOrder: number, takenCents: number): Promise<CreditRecordV2> {
  const c = await legOnChain(d, purchaseId, scanOrder)
  const value = c.leg.remainingCents
  if (!Number.isSafeInteger(takenCents) || takenCents < 0 || takenCents >= value) throw new SaleRefused('Nothing would be left on this card to keep.')
  await wholeCard(d, c)
  return saveKept(d, c, value - takenCents, takenCents)
}

/**
 * The total went up with this card on screen, and a register takes a gift
 * card's balance up to what is due: so the rest left on it for the next
 * shopper is bought first, out of its own deposit (keepRest), before the
 * register can take it. The whole card is the shopper's then; no credit is
 * kept here, since the register is about to use it (the till keeps what it
 * leaves, keepCardV2 with what was taken). Throws SaleRefused, `restGone`
 * when the rest is someone else's now.
 */
export async function buyRestV2(d: SaleDepsV2, purchaseId: string, scanOrder: number): Promise<PurchaseRecordV2> {
  const c = await legOnChain(d, purchaseId, scanOrder)
  await wholeCard(d, c)
  return c.p
}

/**
 * A card the register did not need whose rest can no longer be bought (keepCardV2
 * refused with `restGone`: another shopper used it, or the seller was paid
 * first). What this sale paid for is still on the card and the shopper's:
 * kept as their credit, at the cents the sale used less what the register
 * took. Nothing is sent. Refused when the chain shows the sale refunded, or
 * nothing left of it.
 */
export async function keepPaidV2(d: SaleDepsV2, purchaseId: string, scanOrder: number, takenCents: number): Promise<CreditRecordV2> {
  const c = await legOnChain(d, purchaseId, scanOrder)
  if (c.deposit.state !== V2_STATE.deposit.OPENED && c.deposit.state !== V2_STATE.deposit.RELEASED) throw new SaleRefused('This card was refunded, so it is not yours to keep.')
  const paid = c.deposit.usedCents
  if (!Number.isSafeInteger(takenCents) || takenCents < 0 || takenCents >= paid) throw new SaleRefused('Nothing would be left on this card to keep.')
  return saveKept(d, c, paid - takenCents, takenCents)
}

/** The card as the shopper's store credit: `balanceCents` on it, `takenCents` of it used by the register. */
async function saveKept(d: SaleDepsV2, c: LegOnChain, balanceCents: number, takenCents: number): Promise<CreditRecordV2> {
  const cardId = cardIdV2(c.p.escrow, c.id.toString())
  const credit: CreditRecordV2 = {
    id: cardId,
    merchant: c.p.merchant,
    cardId,
    balanceCents,
    source: 'kept',
    escrow: lower(c.p.escrow),
    depositId: c.id.toString(),
    account: lower(c.p.depositor),
    purchaseId: c.p.id,
    scanOrder: c.leg.scanOrder,
    since: Date.now(),
    takenCents,
  }
  await d.book.saveCredit(credit)
  return credit
}

/**
 * Make the whole card the shopper's: buy the rest left on it for the next
 * shopper out of its own deposit (keepRest), or find it already theirs (used
 * up by this sale, or kept by an earlier send whose answer never came back).
 * Throws SaleRefused: `restGone` when the rest went to someone else.
 */
async function wholeCard(d: SaleDepsV2, c: LegOnChain): Promise<void> {
  const value = c.leg.remainingCents
  if (c.deposit.state !== V2_STATE.deposit.OPENED && c.deposit.state !== V2_STATE.deposit.RELEASED) throw new SaleRefused('This card was refunded, so it is not yours to keep.')
  const hasRest = c.listing.state === V2_STATE.listing.ACTIVE && c.listing.lastDeposit === c.id && c.listing.bondDeposit === c.id
  if (hasRest) {
    if (c.deposit.state !== V2_STATE.deposit.OPENED) throw new SaleRefused('The seller has been paid for this card, so its rest can no longer be kept.', REST_GONE)
    await send(
      d,
      [{ to: d.config.escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'keepRest', args: [termsOfManifestV2(c.manifest), envelopeHashOf(c.leg.envelope), c.id] }) }],
      'keeping the rest',
    )
    const after = await depositNow(d, c.p.escrow, c.id)
    if (after.leftAfterCents !== 0 || after.usedCents !== value) throw new SaleRefused('The chain does not show the card as yours yet. Look again in a minute.', FOR_NOW)
    c.leg.usedCents = after.usedCents
    c.leg.leftCents = 0
    c.leg.amountUnits = after.amount.toString()
    c.leg.bondUnits = '0'
    await d.book.savePurchase(c.p)
  } else if (
    c.leg.leftCents !== 0 &&
    c.listing.state === V2_STATE.listing.DRAINED &&
    c.listing.lastDeposit === c.id &&
    c.deposit.leftAfterCents === 0 &&
    c.deposit.usedCents === value
  ) {
    // Kept by an earlier send whose answer never came back: the chain shows it
    // as theirs, so it is recorded now, never refused as someone else's.
    c.leg.usedCents = c.deposit.usedCents
    c.leg.leftCents = 0
    c.leg.amountUnits = c.deposit.amount.toString()
    c.leg.bondUnits = '0'
    await d.book.savePurchase(c.p)
  } else if (c.leg.leftCents !== 0 || c.listing.state !== V2_STATE.listing.DRAINED || c.listing.lastDeposit !== c.id) {
    throw new SaleRefused('Another shopper has used the rest of this card, so it cannot be kept.', REST_GONE)
  }
}

/**
 * The report to batch with a replacement purchase, after checking the chain
 * would take it now. "That card was empty" on a leftover someone else's
 * deposit covers, inside its contest window, is a contest: the payment comes
 * back in the same transaction. Every other report is a dispute, which holds
 * the payout for the seller to refund. Throws SaleRefused when neither is
 * possible any more.
 */
export async function reportActionV2(d: SaleDepsV2, purchaseId: string, scanOrder: number, outcome: BatchedAction['reason']): Promise<BatchedAction> {
  const c = await legOnChain(d, purchaseId, scanOrder)
  const base = { purchaseId, scanOrder, depositId: c.id.toString() }
  if (c.deposit.state !== V2_STATE.deposit.OPENED) throw new SaleRefused('This card was already refunded or paid out, so it cannot be reported now.')
  if (outcome === 'empty' && c.deposit.contestUntil !== 0 && c.chainTime < c.deposit.contestUntil) return { kind: 'contest', reason: 'empty', ...base }
  if (c.deposit.disputed) throw new SaleRefused('This card is already reported.')
  if (c.chainTime >= c.deposit.releaseAt) throw new SaleRefused('The seller has been paid for this card, so it is too late to report it here.')
  return { kind: 'dispute', reason: outcome, ...base }
}

/**
 * Send a report on its own, with nothing bought after it. Read back from
 * getDeposit: a contest leaves the sale Contested (refunded), a dispute
 * leaves it disputed.
 */
export async function sendReportV2(d: SaleDepsV2, action: BatchedAction): Promise<void> {
  const id = BigInt(action.depositId)
  const call = action.kind === 'contest' ? contestCallV2(d.config.escrow, id) : disputeCallV2(d.config.escrow, id, REPORT_REASON[action.reason])
  await send(d, [call], action.kind === 'contest' ? 'the report' : 'the dispute')
  const after = await depositNow(d, d.config.escrow, id)
  const ok = action.kind === 'contest' ? after.state === V2_STATE.deposit.CONTESTED : after.disputed
  if (!ok) throw new SaleRefused('The chain does not show the report yet. Look again in a minute.', FOR_NOW)
  await markReported(d.book, [action])
}

/** What sendPendingReportsV2 did with a purchase's pending reports. */
export interface PendingReportsOutcome {
  /** Sent on their own now. */
  sent: number
  /** Already on chain: landed with a replacement purchase, or by an earlier send. */
  landed: number
  /** Still riding in a replacement purchase that may land: Finish it settles that one first. */
  waiting: number
  /** No longer possible (the sale was paid out or refunded meanwhile): forgotten. */
  dropped: number
}

/**
 * Send the reports this purchase still holds, each on its own: the
 * replacement purchase that was to carry one was declined, could not land,
 * or was never paid. One the chain already has (a carrying purchase landed,
 * or the deposit shows it) is only noted; one a carrying purchase that may
 * still land holds is left to that purchase. Each is checked again first, so
 * an "empty" past its two hours goes as a dispute, and one the chain can no
 * longer take is dropped. Safe to call any number of times.
 */
export async function sendPendingReportsV2(d: SaleDepsV2, purchaseId: string): Promise<PendingReportsOutcome> {
  const out: PendingReportsOutcome = { sent: 0, landed: 0, waiting: 0, dropped: 0 }
  const p = await d.book.purchase(purchaseId)
  if (p === null) return out
  const all = await d.book.purchases()
  for (const a of [...(p.pendingReports ?? [])]) {
    const carriers = all.filter((x) => x.id !== purchaseId && x.before.some((b) => b.depositId === a.depositId))
    if (carriers.some((x) => x.state === 'paid' || x.state === 'done')) {
      await markReported(d.book, [a])
      out.landed += 1
      continue
    }
    if (carriers.some((x) => x.state === 'signed')) {
      out.waiting += 1
      continue
    }
    const now = await depositNow(d, p.escrow, BigInt(a.depositId))
    if ((a.kind === 'contest' && now.state === V2_STATE.deposit.CONTESTED) || (a.kind === 'dispute' && now.disputed)) {
      await markReported(d.book, [a])
      out.landed += 1
      continue
    }
    let fresh: BatchedAction
    try {
      fresh = await reportActionV2(d, purchaseId, a.scanOrder, a.reason)
    } catch (err) {
      if (!(err instanceof SaleRefused)) throw err
      await dropPendingReport(d.book, a)
      out.dropped += 1
      continue
    }
    await sendReportV2(d, fresh)
    out.sent += 1
  }
  return out
}
