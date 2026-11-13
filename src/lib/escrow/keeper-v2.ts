/**
 * The SalvoEscrowV2 keeper: our books follow V2, sellers get paid on time, and
 * every leftover's deposit comes back or pays the seller by the contract's
 * own clock (unified spec sections 7.1, 8.3 and 17). It runs beside V1's
 * keeper (keeper.ts), which keeps paying out V1 until V1 is empty.
 *
 * ===========================================================================
 * ORDERS COME FROM THE CHAIN, AND ONLY FROM HERE, as for V1. One V2 listing
 * is sold in parts, so each SALE is an order:
 *
 *   new deposit         an Order (rail mpp, ref escrow:...:<V2>:<id>, fulfilling)
 *   sale Released       Order fulfilled
 *   sale Refunded       Order refunded (the seller refunded it in full)
 *   sale Contested      Order refunded: the next shopper said the leftover was
 *                       empty, within two hours, and was refunded from their
 *                       own payment (decision 1). The report is written on
 *                       their order, the shortfall on the order whose deposit
 *                       paid the seller (standing.ts reads both)
 *   part refund         the Order's amount drops; it stays fulfilling
 *   dispute             the Order names the seller (standing.ts)
 *
 * and the listing's Intent follows the listing (keeper-v2-rules.ts): offered
 * while it sells, with what is left in lastKnownBalanceCents, so the matcher
 * sees the leftover at its value and prices it per cent like any card;
 * executing once drained; completed or refunded when that last sale settles;
 * cancelled when the seller takes it back, it is found spent, or it expires.
 * ===========================================================================
 *
 * WHAT IT SENDS, all calls anyone may make, each paying only who the contract
 * names, with the keeper key's fee dust:
 *   - release(id) once a sale is due: pays that sale's seller, and gives back
 *     the deposit the sale used up, if still held;
 *   - releaseBond(id) once a deposit is due back: two hours after the next
 *     shopper's use of the leftover held (decision 1), at once on a cancelled
 *     listing, or at seven days (spec section 7.1). Pays only its depositor;
 *   - confirmRemainder for a readable store's leftover, from a balance Lit
 *     read and signed: fifteen minutes after the sale that left it, or at once
 *     when a ticket found it short. Moves money to the card's seller only;
 *   - claim(to) for a payout the token refused earlier. Pays only `to`.
 * It never sends a token transfer, never names a payee, never refunds anyone,
 * and never contests: only the next shopper can say a leftover was empty.
 * Without a key it keeps the books and reports what is due, and sends nothing.
 *
 * OFF unless ESCROW_RAIL=testnet, and does nothing until V2 is configured
 * (config-v2.ts). Runs from the 15-minute reconcile cron, through keeper.ts.
 *
 * Server and scripts only. Never prints or returns a key.
 */

import { OrderState, Prisma } from '@prisma/client'
import { encodeFunctionData, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { prisma } from '@/lib/db'
import type { IntentState } from '@/lib/intent/types'
import { ESCROW_V2_ABI } from './artifact-v2'
import { escrowReaderV2, type SalvoEscrowV2Reader } from './chain-v2'
import { ESCROW_CHAIN_KEY } from './config'
import { escrowV2Configured, type EscrowTemplateV2 } from './config-v2'
import type { KeeperOptions } from './keeper'
import { chainMove, describeError, keeperAccount, moveOrder } from './keeper-shared'
import {
  bondActionV2,
  confirmDueV2,
  intentPath,
  intentTargetV2,
  payoutDueV2,
  saleOutcomeV2,
  shortfallIsBuyersV2,
  V2_SECONDS,
  type BondActionV2,
} from './keeper-v2-rules'
import { readEscrowSealedRefV2, type EscrowSealedListingV2 } from './listing-v2'
import { requestConfirmV2, type ConfirmViewV2 } from './lit-escrow-v2'
import { ESCROW_CHAIN_ID, UNITS_PER_CENT } from './manifest'
import { ESCROW_V2_TEMPLATE_ID } from './manifest-v2'
import { escrowRailOn } from './rail'
import { ESCROW_INTENT_FORM_FACTOR, escrowIntentIdFor, escrowPaymentRef, isEscrowIntent, parseEscrowPaymentRef } from './refs'
import { V2_STATE, type DepositViewV2, type ListingViewV2 } from './runbook/reads-v2'
import { sendSigned, signTransaction, type AgreedBlock } from './runbook/rpc'
import { escrowRuntime, templateV2Of, type EscrowRuntime } from './runtime'
import { DISPUTE_ORDER_PREFIX, REPORT_EVENT_PREFIX, SHORTFALL_EVENT_PREFIX } from './standing'

/** New sales read per run. More wait for the next run, 15 minutes later. */
const MAX_NEW_DEPOSITS = 50
const MAX_OPEN_ORDERS = 200
const MAX_LISTINGS = 200
/** Listings whose row no longer moves, still read for a deposit that may be held: a batch per run, least recently read first. */
const MAX_SETTLED_LISTINGS = 100
const MAX_CLAIM_CHECKS = 50
/** Transactions per run: a bound on fee dust if something loops. */
const MAX_TXS = 10
/** Paid Lit balance reads per run. */
const MAX_LIT_RUNS = 3
/** Parties of sales closed this long ago are still checked for a refused payout. */
const CLAIM_LOOKBACK_MS = 7 * 24 * 3_600_000
/**
 * A deposit is held at most seven days from the last sale, and no sale comes
 * after the listing's expiry: a listing that expired longer ago than this
 * holds none. A day's margin for a run that was late.
 */
const BOND_LOOKBACK_MS = (V2_SECONDS.bondMaxAge + 86_400) * 1000
const ID_PAD = 15
/** The ticket route's mark when Lit found a readable leftover short (listing.ts markListingSuspect). */
const SHORT_MARK = 'escrow_suspect|balance_short|'

export interface KeeperReportV2 {
  ran: boolean
  /** Why it did not run: the rail is off, or V2 is not configured. Null when it ran. */
  skipped: 'rail_off' | 'v2_not_configured' | null
  applied: boolean
  keeperKey: boolean
  block: string | null
  depositCount: number
  newDeposits: number
  ordersCreated: number
  /** Sales of listings we never recorded: noted once, no order. */
  foreignDeposits: number
  released: number
  refunded: number
  /** Leftover sales the next shopper said were empty. */
  contested: number
  partRefunds: number
  disputes: number
  /** Listing rows moved to follow their listing. */
  listingsMoved: number
  /** Listing rows whose move the intent table does not have yet (a drained listing reopened). */
  listingsWaiting: number
  payoutsDue: number
  payoutsSent: number
  bondsDue: number
  bondsSent: number
  /** Leftovers whose seller may now say what became of them (5 to 7 days). */
  sellerReviews: number
  confirmsDue: number
  confirmsSent: number
  claimsDue: number
  claimsSent: number
  /** Fixed text: hosts, methods, revert reasons. Never a key, a card or a body. */
  errors: string[]
}

/** One V2 run: what it reads at, what it may send, and what it found. */
export interface RunV2 {
  rt: EscrowRuntime
  t: EscrowTemplateV2
  reader: SalvoEscrowV2Reader
  block: AgreedBlock
  report: KeeperReportV2
  apply: boolean
  account: PrivateKeyAccount | null
  txs: number
  litRuns: number
  /** Addresses that may be owed a payout the token refused. */
  parties: Set<Hex>
}

const lower = (a: string): Hex => a.toLowerCase() as Hex
const cents = (units: bigint): number => Math.ceil(Number(units) / UNITS_PER_CENT)
const TERMINAL: ReadonlySet<IntentState> = new Set(['completed', 'cancelled', 'refunded'])

function emptyReport(apply: boolean, keeperKey: boolean): KeeperReportV2 {
  return {
    ran: false,
    skipped: null,
    applied: apply,
    keeperKey,
    block: null,
    depositCount: 0,
    newDeposits: 0,
    ordersCreated: 0,
    foreignDeposits: 0,
    released: 0,
    refunded: 0,
    contested: 0,
    partRefunds: 0,
    disputes: 0,
    listingsMoved: 0,
    listingsWaiting: 0,
    payoutsDue: 0,
    payoutsSent: 0,
    bondsDue: 0,
    bondsSent: 0,
    sellerReviews: 0,
    confirmsDue: 0,
    confirmsSent: 0,
    claimsDue: 0,
    claimsSent: 0,
    errors: [],
  }
}

function depositKey(escrow: Hex, id: bigint): string {
  return `escrow:${ESCROW_CHAIN_ID}:${lower(escrow)}:deposit:${id.toString().padStart(ID_PAD, '0')}`
}

/** The payment ref prefix of every V2 order on this escrow. */
function refPrefix(escrow: Hex): string {
  return `escrow:${ESCROW_CHAIN_KEY}:${lower(escrow)}:`
}

/**
 * Send one call to the V2 escrow from the keeper key, if there is one and the
 * run's budget allows. The transaction hash when it was sent, else null.
 */
async function send(run: RunV2, data: Hex, what: string): Promise<Hex | null> {
  if (run.account === null || !run.apply || run.txs >= MAX_TXS) return null
  run.txs += 1
  try {
    // The gas estimate is a dry run of the call: one that would revert (not
    // due yet, already paid, already returned) throws here and nothing is sent.
    const signed = await signTransaction(run.rt.hosts, run.account, { to: run.reader.escrow, data })
    return await sendSigned(run.rt.hosts, signed)
  } catch (err) {
    run.report.errors.push(describeError(err, what))
    return null
  }
}

/**
 * A V2 run at the agreed finalized block, or the report saying why there is
 * none. No database: tests drive the chain sweeps (sweepListingV2,
 * payoutIfDueV2) with it directly.
 */
export async function startRunV2(opts: KeeperOptions): Promise<RunV2 | KeeperReportV2> {
  const rt = opts.rt ?? escrowRuntime()
  const account = keeperAccount(opts.keeperKey)
  const report = emptyReport(opts.apply, account !== null)
  if (!escrowRailOn()) return { ...report, skipped: 'rail_off' }
  const reader = escrowReaderV2(rt)
  if (!escrowV2Configured(rt) || reader === null) return { ...report, skipped: 'v2_not_configured' }
  report.ran = true
  let block: AgreedBlock
  try {
    block = await reader.block()
  } catch (err) {
    report.errors.push(describeError(err, 'finalized block'))
    return report
  }
  report.block = block.number.toString()
  return { rt, t: templateV2Of(rt), reader, block, report, apply: opts.apply, account, txs: 0, litRuns: 0, parties: new Set() }
}

// ---------------------------------------------------------------------------
// The chain's side: payouts, deposits and balance reads. No database.
// ---------------------------------------------------------------------------

/** Send release(id) if the sale is due. The transaction hash when sent. */
export async function payoutIfDueV2(run: RunV2, id: bigint, d: DepositViewV2): Promise<Hex | null> {
  if (!payoutDueV2(d, Number(run.block.timestamp))) return null
  run.report.payoutsDue += 1
  const hash = await send(run, encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'release', args: [id] }), `release(${id})`)
  if (hash !== null) run.report.payoutsSent += 1
  return hash
}

export interface ListingSweepV2 {
  listing: ListingViewV2
  /** The listing's last sale, or null before the first. */
  latest: DepositViewV2 | null
  /** The sale whose deposit covers the leftover, or null when none does. */
  bond: DepositViewV2 | null
  bondAction: BondActionV2
  bondSent: Hex | null
  /** A balance read posted this run, or null. */
  confirm: ConfirmViewV2 | null
  /** The posted read counts against the deposit's buyer (their window was open). */
  buyersShortfall: boolean
}

/**
 * One listing's chain work: post a readable leftover's balance read when one
 * is due, else give back its deposit when that is due. Both are never sent
 * in one run for one listing: a read can forfeit the deposit the return
 * would try to move.
 */
export async function sweepListingV2(run: RunV2, sealed: EscrowSealedListingV2, opts: { shortReported: boolean }): Promise<ListingSweepV2> {
  const ts = Number(run.block.timestamp)
  const l = await run.reader.listing(run.block, sealed.listingId)
  const latest = l.lastDeposit !== 0n ? await run.reader.deposit(run.block, l.lastDeposit) : null
  const bond = l.bondDeposit === 0n ? null : l.bondDeposit === l.lastDeposit ? latest : await run.reader.deposit(run.block, l.bondDeposit)
  const out: ListingSweepV2 = { listing: l, latest, bond, bondAction: { kind: 'none' }, bondSent: null, confirm: null, buyersShortfall: false }
  if (bond !== null) run.parties.add(bond.depositor)
  // A leftover found spent paid its seller from a deposit: the token may have refused that payout.
  if (l.state === V2_STATE.listing.SPENT) run.parties.add(lower(sealed.manifest.seller))

  if (confirmDueV2(l, bond ?? latest, ts, opts.shortReported)) {
    run.report.confirmsDue += 1
    if (run.apply && run.account !== null && run.litRuns < MAX_LIT_RUNS && run.txs < MAX_TXS) {
      run.litRuns += 1
      try {
        const got = await requestConfirmV2({ manifest: sealed.manifestText, envelope: sealed.envelope, listingId: sealed.listingId }, run.rt)
        if (!got.ok) {
          run.report.errors.push(`confirm(${sealed.listingId}): ${got.refusal}`)
        } else {
          const c = got.confirm
          const data = encodeFunctionData({
            abi: ESCROW_V2_ABI,
            functionName: 'confirmRemainder',
            args: [sealed.listingId, c.balance, c.readAt, c.signature],
          })
          if ((await send(run, data, `confirmRemainder(${sealed.listingId})`)) !== null) {
            run.report.confirmsSent += 1
            // A shortfall pays the seller from the deposit, and the token may refuse it.
            run.parties.add(lower(sealed.manifest.seller))
            out.confirm = c
            out.buyersShortfall = shortfallIsBuyersV2(l, bond, c.balance)
            return out
          }
        }
      } catch (err) {
        run.report.errors.push(describeError(err, `confirm(${sealed.listingId})`))
      }
    }
  }

  if (bond !== null) {
    out.bondAction = bondActionV2(bond, l.bondDeposit, l, latest, ts)
    if (out.bondAction.kind === 'wait' && out.bondAction.review) run.report.sellerReviews += 1
    if (out.bondAction.kind === 'return') {
      run.report.bondsDue += 1
      out.bondSent = await send(
        run,
        encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'releaseBond', args: [l.bondDeposit] }),
        `releaseBond(${l.bondDeposit})`,
      )
      if (out.bondSent !== null) run.report.bondsSent += 1
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. New sales: one order each, from the chain
// ---------------------------------------------------------------------------

/** The highest V2 sale id an earlier run recorded, or 0. */
async function lastSeenDeposit(escrow: Hex): Promise<bigint> {
  const prefix = depositKey(escrow, 0n).slice(0, -ID_PAD)
  const row = await prisma.processedEvent.findFirst({ where: { id: { startsWith: prefix } }, orderBy: { id: 'desc' } })
  if (row === null) return 0n
  const tail = row.id.slice(prefix.length)
  return /^[0-9]{15}$/.test(tail) ? BigInt(tail) : 0n
}

/**
 * The Opened event an order's history starts with. It names the sale's
 * seller, so the claims sweep can find who may be owed for a week after
 * (sellerOfOpenedV2): an order itself names only its buyer.
 */
export function openedReasonV2(id: bigint, block: bigint, d: Pick<DepositViewV2, 'usedCents' | 'leftAfterCents' | 'saleIndex' | 'seller'>): string {
  return `ESCROW|Opened|deposit:${id}|block:${block}|used:${d.usedCents}|left:${d.leftAfterCents}|sale:${d.saleIndex}|seller:${lower(d.seller)}`
}

/** The seller an order's Opened event names, or null when it names none. */
export function sellerOfOpenedV2(reason: string): Hex | null {
  if (!reason.startsWith('ESCROW|Opened|')) return null
  const m = /\|seller:(0x[0-9a-f]{40})(?:\||$)/.exec(reason)
  return m === null ? null : (m[1] as Hex)
}

/**
 * The settled rows this run reads for a deposit that may still be held: V2
 * rows that no longer move, whose listing expired at most BOND_LOOKBACK_MS
 * ago, least recently read first. Each one read is stamped (lastCheckedAt),
 * so the batch turns over and every such row is read within a few runs
 * however many others settle meanwhile. Bounded by the listing's expiry, not
 * by when the row last changed: the stamp moves that.
 */
export function settledSweepQueryV2(now: number) {
  return {
    where: {
      formFactor: ESCROW_INTENT_FORM_FACTOR,
      state: { in: ['completed', 'cancelled', 'refunded'] satisfies IntentState[] },
      expiresAt: { gte: new Date(now - BOND_LOOKBACK_MS) },
      sealedRef: { path: ['lit', 'template'], equals: ESCROW_V2_TEMPLATE_ID },
    },
    orderBy: [{ lastCheckedAt: { sort: 'asc' as const, nulls: 'first' as const } }],
    take: MAX_SETTLED_LISTINGS,
  }
}

async function recordDeposit(run: RunV2, id: bigint, d: DepositViewV2): Promise<void> {
  const escrow = run.reader.escrow
  const key = depositKey(escrow, id)
  if (!run.apply) return
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      if (await tx.processedEvent.findUnique({ where: { id: key } })) return 'seen' as const
      const intent = await tx.intent.findUnique({ where: { id: escrowIntentIdFor(d.listingId) } })
      const ours = intent !== null && isEscrowIntent(intent) && intent.accountId === `seller:${d.seller}`
      if (!ours) {
        await tx.processedEvent.create({ data: { id: key, rail: 'mpp', orderId: null } })
        return 'foreign' as const
      }
      const order = await tx.order.create({
        data: {
          // No email: nothing ever writes to an escrow shopper but their phone.
          buyerEmail: '',
          kind: 'gift_card',
          merchantId: intent.merchantId,
          deadlineAt: new Date(d.releaseAt * 1000),
          qty: 1,
          // The price of the cents used. The deposit on what is left is the
          // buyer's own money, held for them, never part of the sale.
          priceCents: cents(d.amount),
          rail: 'mpp',
          paymentRef: escrowPaymentRef(ESCROW_CHAIN_KEY, escrow, id),
          payerAddress: d.depositor,
          state: OrderState.fulfilling,
          nextAttemptAt: null,
        },
      })
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          fromState: null,
          toState: OrderState.fulfilling,
          reason: openedReasonV2(id, run.block.number, d),
          actor: 'chain',
        },
      })
      await tx.processedEvent.create({ data: { id: key, rail: 'mpp', orderId: order.id } })
      return 'created' as const
    })
    if (outcome === 'created') run.report.ordersCreated += 1
    if (outcome === 'foreign') run.report.foreignDeposits += 1
  } catch (err) {
    // Another keeper recorded it first: its row is the one that counts.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return
    throw err
  }
}

async function scanNewDeposits(run: RunV2): Promise<void> {
  const count = await run.reader.depositCount(run.block)
  run.report.depositCount = Number(count)
  const from = (await lastSeenDeposit(run.reader.escrow)) + 1n
  const to = count < from + BigInt(MAX_NEW_DEPOSITS) - 1n ? count : from + BigInt(MAX_NEW_DEPOSITS) - 1n
  for (let id = from; id <= to; id++) {
    const d = await run.reader.deposit(run.block, id)
    run.report.newDeposits += 1
    if (d.state === 0) {
      run.report.errors.push(`deposit ${id}: below depositCount but empty on chain`)
      return
    }
    await recordDeposit(run, id, d)
  }
}

// ---------------------------------------------------------------------------
// 2. Open orders follow their sales
// ---------------------------------------------------------------------------

async function followOrder(run: RunV2, order: { id: string; paymentRef: string; priceCents: number; deadlineAt: Date; failureReason: string | null }): Promise<void> {
  const ref = parseEscrowPaymentRef(order.paymentRef)
  if (ref === null) return
  const d = await run.reader.deposit(run.block, ref.depositId)
  const at = `deposit:${ref.depositId}|block:${run.block.number}`
  const outcome = saleOutcomeV2(d)

  if (outcome === 'released' || outcome === 'refunded' || outcome === 'contested') {
    run.report[outcome] += 1
    run.parties.add(d.seller)
    if (outcome !== 'released') run.parties.add(d.depositor)
    if (!run.apply) return
    await prisma.$transaction(async (tx) => {
      if (outcome === 'released') {
        await moveOrder(tx, order.id, OrderState.fulfilling, OrderState.fulfilled, `ESCROW|Released|${at}`, { priceCents: cents(d.amount), failureReason: null })
        return
      }
      const why =
        outcome === 'refunded'
          ? `ESCROW|Refunded|${at}|the seller refunded the buyer in full`
          : `${REPORT_EVENT_PREFIX}${at}|seller:${d.seller}|covers:deposit:${d.covers}|the next shopper said the leftover was empty and was refunded from their own payment`
      if (!(await moveOrder(tx, order.id, OrderState.fulfilling, OrderState.failed, why, { failureReason: null }))) return
      await moveOrder(tx, order.id, OrderState.failed, OrderState.refunded, `ESCROW|Refunded|${at}`)
      if (outcome === 'contested' && d.covers !== 0n) {
        // The first shopper's deposit paid the seller: the leftover they left was short.
        const first = await tx.order.findFirst({ where: { paymentRef: escrowPaymentRef(ESCROW_CHAIN_KEY, run.reader.escrow, d.covers) } })
        if (first !== null) {
          await tx.orderEvent.create({
            data: {
              orderId: first.id,
              fromState: first.state,
              toState: first.state,
              reason: `${SHORTFALL_EVENT_PREFIX}deposit:${d.covers}|block:${run.block.number}|reported by deposit:${ref.depositId}|seller:${d.seller}`,
              actor: 'chain',
            },
          })
        }
      }
    })
    return
  }

  if (outcome === 'missing') {
    run.report.errors.push(`deposit ${ref.depositId}: not on chain`)
    return
  }

  // Still Opened: a part refund or fewer cents used (reduceUse), the rest
  // kept (keepRest), a dispute, a new payout time, or a payout due.
  const amountCents = cents(d.amount)
  const partRefund = amountCents < order.priceCents
  const restKept = amountCents > order.priceCents
  const mark = `${DISPUTE_ORDER_PREFIX}${d.seller}`
  const newlyDisputed = d.disputed && order.failureReason !== mark
  const deadline = new Date(d.releaseAt * 1000)
  if (partRefund) run.report.partRefunds += 1
  if (newlyDisputed) run.report.disputes += 1
  if (run.apply && (partRefund || restKept || newlyDisputed || deadline.getTime() !== order.deadlineAt.getTime())) {
    await prisma.$transaction(async (tx) => {
      await tx.order.updateMany({
        where: { id: order.id, state: OrderState.fulfilling },
        // Read by the router: a seller with an open dispute sells nothing new (standing.ts).
        data: { priceCents: amountCents, deadlineAt: deadline, ...(d.disputed ? { failureReason: mark } : {}) },
      })
      if (partRefund) {
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            fromState: OrderState.fulfilling,
            toState: OrderState.fulfilling,
            reason: `ESCROW|Refunded|${at}|part refund, ${d.amount} units still held for the seller`,
            actor: 'chain',
          },
        })
      }
      if (restKept) {
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            fromState: OrderState.fulfilling,
            toState: OrderState.fulfilling,
            reason: `ESCROW|RestKept|${at}|the buyer kept the rest of the card, ${d.amount} units now held for the seller`,
            actor: 'chain',
          },
        })
      }
      if (newlyDisputed) {
        await tx.orderEvent.create({
          data: { orderId: order.id, fromState: OrderState.fulfilling, toState: OrderState.fulfilling, reason: `ESCROW|Disputed|${at}|seller:${d.seller}`, actor: 'chain' },
        })
      }
    })
  }

  const hash = await payoutIfDueV2(run, ref.depositId, d)
  if (hash !== null) {
    // The payout's transaction, for the operator. Not Order.refundRef: every
    // other reader takes that field to mean money went back to the buyer.
    await prisma.orderEvent.create({
      data: { orderId: order.id, fromState: OrderState.fulfilling, toState: OrderState.fulfilling, reason: `ESCROW|ReleaseSent|${at}|tx:${hash}`, actor: 'keeper' },
    })
  }
}

async function followOpenOrders(run: RunV2): Promise<void> {
  const open = await prisma.order.findMany({
    where: { paymentRef: { startsWith: refPrefix(run.reader.escrow) }, state: OrderState.fulfilling },
    orderBy: { createdAt: 'asc' },
    take: MAX_OPEN_ORDERS,
    select: { id: true, paymentRef: true, priceCents: true, deadlineAt: true, failureReason: true },
  })
  for (const o of open) {
    try {
      await followOrder(run, o)
    } catch (err) {
      // One sale cannot stop the rest; it is read again next run.
      run.report.errors.push(describeError(err, `order ${o.id}`))
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Listings: the row follows the listing, and the leftover's deposit settles
// ---------------------------------------------------------------------------

/** When the ticket route found this listing short, in ms, or null. */
function shortMarkAt(failureReason: string | null): number | null {
  if (failureReason === null || !failureReason.startsWith(SHORT_MARK)) return null
  const t = Date.parse(failureReason.slice(SHORT_MARK.length))
  return Number.isFinite(t) ? t : null
}

interface ListingRow {
  id: string
  state: IntentState
  sealedRef: Prisma.JsonValue
  failureReason: string | null
  lastKnownBalanceCents: number | null
}

/** Move one row to where its listing says it is, through the intent table's own moves. */
async function followRow(run: RunV2, row: ListingRow, sealed: EscrowSealedListingV2, s: ListingSweepV2): Promise<void> {
  const target = intentTargetV2(s.listing, s.latest, Number(run.block.timestamp), sealed.manifest.listingExpiry, row.state)
  if (target === null) {
    if (s.listing.state === 0) run.report.errors.push(`listing ${row.id}: not on chain`)
    return
  }
  const path = intentPath(row.state, target.state)
  if (path === null) {
    run.report.listingsWaiting += 1
    run.report.errors.push(`listing ${row.id}: waits for a move from ${row.state} to ${target.state} the intent table does not have yet`)
    return
  }
  let from = row.state
  for (const step of path) {
    chainMove(from, step, row.id)
    from = step
  }
  if (path.length > 0) run.report.listingsMoved += 1
  if (!run.apply) return

  const data: Prisma.IntentUpdateManyMutationInput = { lastCheckedAt: new Date(run.rt.now()) }
  if (target.state === 'offered') data.lastKnownBalanceCents = target.balanceCents
  // A short read the ticket route saw is on chain now: the leftover sells at what is really there.
  const marked = shortMarkAt(row.failureReason)
  if (marked !== null && s.listing.confirmedAt * 1000 > marked) data.failureReason = null
  if (path.length > 0) {
    data.state = target.state
    if (target.cancellation !== null) data.cancellationReason = target.cancellation
    if (target.state !== 'offered' && target.state !== 'cancelled' && s.listing.lastDeposit !== 0n) {
      const last = await prisma.order.findFirst({
        where: { paymentRef: escrowPaymentRef(ESCROW_CHAIN_KEY, run.reader.escrow, s.listing.lastDeposit) },
        select: { id: true },
      })
      if (last !== null) data.matchedOrderId = last.id
    }
  }
  await prisma.intent.updateMany({ where: { id: row.id, state: row.state }, data })
}

/** Write the shortfall a posted read found on the buyer whose deposit covered the leftover. */
async function recordConfirmShortfall(run: RunV2, s: ListingSweepV2, sealed: EscrowSealedListingV2): Promise<void> {
  if (!s.buyersShortfall || s.confirm === null || s.listing.bondDeposit === 0n || !run.apply) return
  const first = await prisma.order.findFirst({ where: { paymentRef: escrowPaymentRef(ESCROW_CHAIN_KEY, run.reader.escrow, s.listing.bondDeposit) } })
  if (first === null) return
  await prisma.orderEvent.create({
    data: {
      orderId: first.id,
      fromState: first.state,
      toState: first.state,
      reason: `${SHORTFALL_EVENT_PREFIX}deposit:${s.listing.bondDeposit}|block:${run.block.number}|read ${s.confirm.balance} of ${s.listing.remainingCents} cents|seller:${sealed.manifest.seller}`,
      actor: 'keeper',
    },
  })
}

async function followListings(run: RunV2): Promise<void> {
  const v2Rows = { sealedRef: { path: ['lit', 'template'], equals: ESCROW_V2_TEMPLATE_ID } }
  const select = { id: true, state: true, sealedRef: true, failureReason: true, lastKnownBalanceCents: true } as const
  const live = await prisma.intent.findMany({
    where: { formFactor: ESCROW_INTENT_FORM_FACTOR, state: { in: ['offered', 'matched', 'executing', 'execution_failed'] }, ...v2Rows },
    orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }],
    take: MAX_LISTINGS,
    select,
  })
  // Settled rows never move again, but a deposit on their leftover can still
  // be held: a sale refunded by its seller leaves the deposit it used to its
  // window, and an expired listing keeps its deposit to the seven-day rule.
  // This keeper is the only one who returns those, so every such row is read
  // in turn (settledSweepQueryV2), never only the newest.
  const settled = await prisma.intent.findMany({ ...settledSweepQueryV2(run.rt.now()), select })
  const settledIds = new Set(settled.map((r) => r.id))
  for (const row of [...live, ...settled]) {
    try {
      const sealed = readEscrowSealedRefV2(row.sealedRef, run.t)
      if (sealed === null) {
        run.report.errors.push(`listing ${row.id}: its sealed ref no longer reads back`)
        continue
      }
      const s = await sweepListingV2(run, sealed, { shortReported: shortMarkAt(row.failureReason) !== null })
      await recordConfirmShortfall(run, s, sealed)
      if (!TERMINAL.has(row.state)) await followRow(run, row, sealed, s)
      else if (settledIds.has(row.id) && run.apply) {
        // Read: to the back of the settled batch.
        await prisma.intent.updateMany({ where: { id: row.id, state: row.state }, data: { lastCheckedAt: new Date(run.rt.now()) } })
      }
    } catch (err) {
      run.report.errors.push(describeError(err, `listing ${row.id}`))
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Payouts the token refused earlier
// ---------------------------------------------------------------------------

async function followClaims(run: RunV2): Promise<void> {
  const recent = await prisma.order.findMany({
    where: {
      paymentRef: { startsWith: refPrefix(run.reader.escrow) },
      state: { in: [OrderState.fulfilled, OrderState.refunded] },
      updatedAt: { gte: new Date(run.rt.now() - CLAIM_LOOKBACK_MS) },
    },
    select: { id: true, payerAddress: true },
    take: MAX_CLAIM_CHECKS,
  })
  // Each sale's seller too, for the same week: a payout the token refused in
  // the run that settled the sale is claimed in a later one (V1 does the same).
  const opened = await prisma.orderEvent.findMany({
    where: { orderId: { in: recent.map((o) => o.id) }, reason: { startsWith: 'ESCROW|Opened|' } },
    select: { reason: true },
  })
  for (const o of recent) if (o.payerAddress) run.parties.add(lower(o.payerAddress))
  for (const e of opened) {
    const seller = sellerOfOpenedV2(e.reason ?? '')
    if (seller !== null) run.parties.add(seller)
  }
  for (const who of [...run.parties].slice(0, MAX_CLAIM_CHECKS)) {
    try {
      if ((await run.reader.owed(run.block, who)) === 0n) continue
      run.report.claimsDue += 1
      const data = encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'claim', args: [who] })
      if ((await send(run, data, `claim(${who})`)) !== null) run.report.claimsSent += 1
    } catch (err) {
      run.report.errors.push(describeError(err, `owed(${who})`))
    }
  }
}

/** One V2 keeper run. Never throws for a chain or Lit fault; those are in `errors`. */
export async function runEscrowKeeperV2(opts: KeeperOptions): Promise<KeeperReportV2> {
  const run = await startRunV2(opts)
  if (!('reader' in run)) return run
  // New sales first, so a sale that settled while nobody looked is recorded
  // and then settled in the same run; listings after orders, so a row moves
  // to completed only once the sale that drained it is recorded.
  try {
    await scanNewDeposits(run)
  } catch (err) {
    run.report.errors.push(describeError(err, 'new deposits'))
  }
  await followOpenOrders(run)
  await followListings(run)
  try {
    await followClaims(run)
  } catch (err) {
    run.report.errors.push(describeError(err, 'claims'))
  }
  return run.report
}

/** One line for the cron log. Safe to print: counts and a block number. */
export function describeKeeperV2(r: KeeperReportV2): string {
  if (!r.ran) return `escrow-keeper-v2 skipped (${r.skipped ?? 'not run'})`
  const parts = [
    `escrow-keeper-v2 block=${r.block ?? '?'}`,
    `deposits=${r.depositCount}`,
    `new=${r.newDeposits}`,
    `orders=${r.ordersCreated}`,
    `foreign=${r.foreignDeposits}`,
    `released=${r.released}`,
    `refunded=${r.refunded}`,
    `contested=${r.contested}`,
    `partRefunds=${r.partRefunds}`,
    `disputes=${r.disputes}`,
    `listingsMoved=${r.listingsMoved}`,
    `listingsWaiting=${r.listingsWaiting}`,
    `payoutsDue=${r.payoutsDue}`,
    `payoutsSent=${r.payoutsSent}`,
    `bondsDue=${r.bondsDue}`,
    `bondsSent=${r.bondsSent}`,
    `sellerReviews=${r.sellerReviews}`,
    `confirmsDue=${r.confirmsDue}`,
    `confirmsSent=${r.confirmsSent}`,
    `claimsDue=${r.claimsDue}`,
    `claimsSent=${r.claimsSent}`,
    `applied=${r.applied}`,
    `keeperKey=${r.keeperKey ? 'set' : 'missing'}`,
  ]
  if (r.errors.length > 0) parts.push(`errors=${r.errors.length}`)
  return parts.join(' ')
}
