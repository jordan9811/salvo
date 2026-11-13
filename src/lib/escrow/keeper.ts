/**
 * The escrow keeper: our books follow the chain, and sellers get paid on time
 * (spec sections 8.6 and 12).
 *
 * ===========================================================================
 * ORDERS COME FROM THE CHAIN, AND ONLY FROM HERE. No route creates an escrow
 * order from what a phone says it did. The keeper reads the escrow on both
 * pinned hosts at one finalized block and writes what it finds:
 *
 *   new deposit         an Order (rail mpp, ref escrow:...:<id>, fulfilling),
 *                       and its listing's Intent offered -> executing
 *   deposit Released    Order fulfilled, Intent completed
 *   deposit Refunded    Order refunded, Intent refunded (only a refund of
 *                       everything left closes a deposit)
 *   part refund         the Order's amount drops; it stays fulfilling
 *   dispute             an event, and the seller's other listings leave quotes
 *   listing cancelled   Intent cancelled (the seller did it on chain)
 *   listing expired     Intent cancelled, expired
 *
 * Every state is taken from `getDeposit(id)` and `gate()`, never from an
 * event's name: a part refund emits Refunded and leaves the deposit Opened.
 *
 * HOW IT FINDS NEW PURCHASES without a cursor table (no migration): deposit
 * ids run 1..depositCount() with no gaps, and each one read is recorded in
 * ProcessedEvent as `escrow:42431:<escrow>:deposit:<id, zero-padded>`. The
 * highest such id is where the next run starts. That row is also what makes
 * a deposit create at most one order, however many keepers run.
 * ===========================================================================
 *
 * THE KEEPER KEY MOVES NO MONEY OF OURS. It pays the fee dust for the two
 * calls anyone may make: `release(id)` once a payout is due (it pays only
 * that deposit's seller) and `claim(to)` for a payout the token refused
 * earlier (it pays only `to`). It never sends a token transfer, never names
 * a payee, and never refunds anyone: only a seller can return a shopper's
 * money, from the escrow. Without a key the keeper still keeps the books and
 * reports what is due, and sends nothing.
 *
 * OFF unless ESCROW_RAIL=testnet. Runs from the 15-minute reconcile cron.
 *
 * TWO ESCROWS. Each run also runs SalvoEscrowV2's keeper (keeper-v2.ts) once
 * V2 is configured. This file keeps V1's books until V1 is empty: its sales
 * still settle and pay out after the freeze. What the freeze changes here is
 * the offered book: a V1 listing still for sale is kept out of quotes
 * (marked `v1_frozen`), since V1 takes no new sale once V2 is open
 * (config-v2.ts escrowV2Live). The mark follows the freeze both ways: if V2
 * is ever switched off again, the next run clears it and V1's cards sell.
 *
 * Server and scripts only. Never prints or returns a key.
 */

import { OrderState, Prisma } from '@prisma/client'
import { encodeFunctionData, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { prisma } from '@/lib/db'
import { ESCROW_ABI } from './artifact'
import { DEPOSIT_STATE, escrowReader, LISTING_STATE, type SalvoEscrowReader } from './chain'
import { ESCROW_CHAIN_KEY } from './config'
import { escrowV1Frozen } from './config-v2'
import { chainMove, describeError, keeperAccount, moveOrder } from './keeper-shared'
import { describeKeeperV2, runEscrowKeeperV2, type KeeperReportV2 } from './keeper-v2'
import { markListingSuspect, readEscrowSealedRef } from './listing'
import { ESCROW_V2_TEMPLATE_ID } from './manifest-v2'
import { ESCROW_CHAIN_ID, UNITS_PER_CENT } from './manifest'
import { DISPUTED_MARK } from './quote'
import { escrowRailOn } from './rail'
import { ESCROW_INTENT_FORM_FACTOR, escrowIntentIdFor, escrowPaymentRef, isEscrowIntent, parseEscrowPaymentRef } from './refs'
import type { DepositView } from './runbook/reads'
import { sendSigned, signTransaction, type AgreedBlock } from './runbook/rpc'
import { escrowRuntime, type EscrowRuntime } from './runtime'

/** New deposits read per run. More wait for the next run, 15 minutes later. */
const MAX_NEW_DEPOSITS = 50
const MAX_OPEN_ORDERS = 200
const MAX_OFFERED = 200
const MAX_CLAIM_CHECKS = 50
/** Transactions per run: a bound on fee dust if something loops. */
const MAX_TXS = 10
/** Parties of sales closed this long ago are still checked for a refused payout. */
const CLAIM_LOOKBACK_MS = 7 * 24 * 3_600_000
const ID_PAD = 15

export interface KeeperOptions {
  /** Write orders and intents, and (with a key) send payouts and claims. False: read and report only. */
  apply: boolean
  /** ESCROW_KEEPER_KEY. Null or malformed: nothing is ever sent. */
  keeperKey: string | null
  rt?: EscrowRuntime
}

export interface KeeperReport {
  ran: boolean
  /** Why it did not run: the rail is off, or no escrow is pinned. Null when it ran. */
  skipped: 'rail_off' | 'escrow_not_pinned' | null
  applied: boolean
  /** A usable keeper key is configured. Never the key itself. */
  keeperKey: boolean
  block: string | null
  depositCount: number
  /** Deposits read for the first time this run. */
  newDeposits: number
  ordersCreated: number
  /** Deposits of listings we never recorded (listed elsewhere): noted once, no order. */
  foreignDeposits: number
  released: number
  refunded: number
  partRefunds: number
  disputes: number
  listingsCancelled: number
  listingsExpired: number
  payoutsDue: number
  payoutsSent: number
  claimsDue: number
  claimsSent: number
  /** Fixed text: hosts, methods, revert reasons. Never a key, a card or a body. */
  errors: string[]
  /** SalvoEscrowV2's run (keeper-v2.ts), which reports its own skip until V2 is configured. */
  v2?: KeeperReportV2
}

const lower = (a: string): Hex => a.toLowerCase() as Hex
const cents = (units: bigint): number => Math.ceil(Number(units) / UNITS_PER_CENT)

function depositKey(escrow: Hex, id: bigint): string {
  return `escrow:${ESCROW_CHAIN_ID}:${lower(escrow)}:deposit:${id.toString().padStart(ID_PAD, '0')}`
}

/** The highest deposit id an earlier run recorded, or 0. */
async function lastSeenDeposit(escrow: Hex): Promise<bigint> {
  const prefix = depositKey(escrow, 0n).slice(0, -ID_PAD)
  const row = await prisma.processedEvent.findFirst({ where: { id: { startsWith: prefix } }, orderBy: { id: 'desc' } })
  if (row === null) return 0n
  const tail = row.id.slice(prefix.length)
  return /^[0-9]{15}$/.test(tail) ? BigInt(tail) : 0n
}

interface Run {
  rt: EscrowRuntime
  reader: SalvoEscrowReader
  block: AgreedBlock
  report: KeeperReport
  apply: boolean
  account: PrivateKeyAccount | null
  txs: number
  /** Addresses that may be owed a payout the token refused. */
  parties: Set<Hex>
}

/**
 * Send `release(id)` or `claim(to)` from the keeper key, if there is one and
 * the run's budget allows. The transaction hash when it was sent, else null.
 */
async function send(run: Run, data: Hex, what: string): Promise<Hex | null> {
  if (run.account === null || !run.apply || run.txs >= MAX_TXS) return null
  run.txs += 1
  try {
    // signTransaction's gas estimate is a dry run of the call: one that would
    // revert (not due yet, already paid) throws here and nothing is sent.
    const signed = await signTransaction(run.rt.hosts, run.account, { to: run.reader.escrow, data })
    return await sendSigned(run.rt.hosts, signed)
  } catch (err) {
    run.report.errors.push(describeError(err, what))
    return null
  }
}

// ---------------------------------------------------------------------------
// 1. New deposits: one order each, from the chain
// ---------------------------------------------------------------------------

async function recordDeposit(run: Run, id: bigint, d: DepositView): Promise<void> {
  const escrow = run.reader.escrow
  const key = depositKey(escrow, id)
  if (!run.apply) return
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      if (await tx.processedEvent.findUnique({ where: { id: key } })) return 'seen' as const
      const intentId = escrowIntentIdFor(d.listingId)
      const intent = await tx.intent.findUnique({ where: { id: intentId } })
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
          reason: `ESCROW|Opened|deposit:${id}|block:${run.block.number}`,
          actor: 'chain',
        },
      })
      await tx.processedEvent.create({ data: { id: key, rail: 'mpp', orderId: order.id } })
      if (intent.state === 'offered') {
        // offered -> matched -> executing, in one write: the purchase and the
        // open are one transaction on chain, so there is no matched moment.
        chainMove('offered', 'matched', intent.id)
        chainMove('matched', 'executing', intent.id)
        await tx.intent.updateMany({
          where: { id: intent.id, state: 'offered' },
          data: { state: 'executing', matchedOrderId: order.id, failureReason: null },
        })
      }
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

async function scanNewDeposits(run: Run): Promise<void> {
  const count = await run.reader.depositCount(run.block)
  run.report.depositCount = Number(count)
  const from = (await lastSeenDeposit(run.reader.escrow)) + 1n
  const to = count < from + BigInt(MAX_NEW_DEPOSITS) - 1n ? count : from + BigInt(MAX_NEW_DEPOSITS) - 1n
  for (let id = from; id <= to; id++) {
    const d = await run.reader.deposit(run.block, id)
    run.report.newDeposits += 1
    if (d.state === DEPOSIT_STATE.none) {
      run.report.errors.push(`deposit ${id}: below depositCount but empty on chain`)
      return
    }
    await recordDeposit(run, id, d)
  }
}

// ---------------------------------------------------------------------------
// 2. Open orders follow their deposits
// ---------------------------------------------------------------------------

async function followOrder(run: Run, order: { id: string; paymentRef: string; priceCents: number; deadlineAt: Date }): Promise<void> {
  const ref = parseEscrowPaymentRef(order.paymentRef)
  if (ref === null) return
  const d = await run.reader.deposit(run.block, ref.depositId)
  const intent = await prisma.intent.findFirst({ where: { matchedOrderId: order.id, formFactor: ESCROW_INTENT_FORM_FACTOR } })
  const at = `deposit:${ref.depositId}|block:${run.block.number}`

  if (d.state === DEPOSIT_STATE.released || d.state === DEPOSIT_STATE.refunded) {
    const released = d.state === DEPOSIT_STATE.released
    if (released) run.report.released += 1
    else run.report.refunded += 1
    run.parties.add(d.seller)
    if (!released) run.parties.add(d.depositor)
    if (!run.apply) return
    await prisma.$transaction(async (tx) => {
      if (released) {
        await moveOrder(tx, order.id, OrderState.fulfilling, OrderState.fulfilled, `ESCROW|Released|${at}`, { priceCents: cents(d.amount) })
      } else if (await moveOrder(tx, order.id, OrderState.fulfilling, OrderState.failed, `ESCROW|Refunded|${at}|the seller refunded the buyer in full`)) {
        // The seller returned the shopper's money from the escrow. Nothing of
        // ours moved, so there is no refund ref to record.
        await moveOrder(tx, order.id, OrderState.failed, OrderState.refunded, `ESCROW|Refunded|${at}`)
      }
      if (intent !== null && intent.state === 'executing') {
        if (released) {
          chainMove('executing', 'completed', intent.id)
          await tx.intent.updateMany({ where: { id: intent.id, state: 'executing' }, data: { state: 'completed', failureReason: null } })
        } else {
          chainMove('executing', 'execution_failed', intent.id)
          chainMove('execution_failed', 'refunded', intent.id)
          await tx.intent.updateMany({
            where: { id: intent.id, state: 'executing' },
            data: { state: 'refunded', failureReason: 'escrow: the seller refunded the buyer in full' },
          })
        }
      }
    })
    return
  }

  if (d.state !== DEPOSIT_STATE.opened) {
    run.report.errors.push(`deposit ${ref.depositId}: not on chain`)
    return
  }

  // Still Opened: a part refund, a dispute, a new payout time, or a payout due.
  const amountCents = cents(d.amount)
  const partRefund = amountCents < order.priceCents
  const newlyDisputed = d.disputed && intent !== null && intent.failureReason !== DISPUTED_MARK
  const deadline = new Date(d.releaseAt * 1000)
  if (partRefund) run.report.partRefunds += 1
  if (newlyDisputed) run.report.disputes += 1
  if (run.apply && (partRefund || newlyDisputed || deadline.getTime() !== order.deadlineAt.getTime())) {
    await prisma.$transaction(async (tx) => {
      await tx.order.updateMany({
        where: { id: order.id, state: OrderState.fulfilling },
        data: { priceCents: amountCents, deadlineAt: deadline },
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
      if (newlyDisputed && intent !== null) {
        await tx.orderEvent.create({
          data: { orderId: order.id, fromState: OrderState.fulfilling, toState: OrderState.fulfilling, reason: `ESCROW|Disputed|${at}`, actor: 'chain' },
        })
        // Read by the quote: a seller with an open dispute sells nothing new.
        await tx.intent.updateMany({ where: { id: intent.id, state: 'executing' }, data: { failureReason: DISPUTED_MARK } })
      }
    })
  }

  if (run.block.timestamp >= BigInt(d.releaseAt)) {
    run.report.payoutsDue += 1
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'release', args: [ref.depositId] })
    const hash = await send(run, data, `release(${ref.depositId})`)
    if (hash !== null) {
      run.report.payoutsSent += 1
      // The payout's transaction, for the operator. Not Order.refundRef: every
      // other reader takes that field to mean money went back to the buyer.
      await prisma.orderEvent.create({
        data: { orderId: order.id, fromState: OrderState.fulfilling, toState: OrderState.fulfilling, reason: `ESCROW|ReleaseSent|${at}|tx:${hash}`, actor: 'keeper' },
      })
    }
  }
}

async function followOpenOrders(run: Run): Promise<void> {
  const prefix = `escrow:${ESCROW_CHAIN_KEY}:${lower(run.reader.escrow)}:`
  const open = await prisma.order.findMany({
    where: { paymentRef: { startsWith: prefix }, state: OrderState.fulfilling },
    orderBy: { createdAt: 'asc' },
    take: MAX_OPEN_ORDERS,
    select: { id: true, paymentRef: true, priceCents: true, deadlineAt: true },
  })
  for (const o of open) {
    try {
      await followOrder(run, o)
    } catch (err) {
      // One deposit cannot stop the rest; it is read again next run.
      run.report.errors.push(describeError(err, `order ${o.id}`))
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Offered listings: cancelled or expired on chain
// ---------------------------------------------------------------------------

const V1_FROZEN_MARK = 'escrow_suspect|v1_frozen|'

/**
 * What the freeze asks of one offered V1 row's mark: put it on while V1 is
 * frozen, take it off once V1 is not (V2 switched off or its pins reverted),
 * else nothing. Only the freeze's own mark is ever taken off.
 */
export function v1FrozenMarkMove(frozen: boolean, failureReason: string | null): 'mark' | 'clear' | null {
  const marked = (failureReason ?? '').startsWith(V1_FROZEN_MARK)
  if (frozen) return marked ? null : 'mark'
  return marked ? 'clear' : null
}

async function followOfferedListings(run: Run): Promise<void> {
  const offered = await prisma.intent.findMany({
    // V2's listings are keeper-v2.ts's.
    where: { formFactor: ESCROW_INTENT_FORM_FACTOR, state: 'offered', NOT: { sealedRef: { path: ['lit', 'template'], equals: ESCROW_V2_TEMPLATE_ID } } },
    orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }],
    take: MAX_OFFERED,
  })
  const now = new Date()
  const frozen = escrowV1Frozen(run.rt)
  for (const row of offered) {
    try {
      // V1 sells nothing new once V2 is open: keep its offered cards out of
      // quotes and totals, and back in them if V2 is switched off again.
      const move = run.apply ? v1FrozenMarkMove(frozen, row.failureReason) : null
      if (move === 'mark') await markListingSuspect(row.id, 'v1_frozen', now)
      if (move === 'clear') {
        await prisma.intent.updateMany({ where: { id: row.id, state: 'offered', failureReason: row.failureReason }, data: { failureReason: null } })
      }
      const sealed = readEscrowSealedRef(row.sealedRef, run.rt.template)
      if (sealed === null) {
        run.report.errors.push(`listing ${row.id}: its sealed ref no longer reads back`)
        continue
      }
      const g = await run.reader.gate(run.block, sealed.listingId, 0n)
      const cancelled = g.listingState === LISTING_STATE.cancelled
      // The contract refuses a purchase at or after the expiry, by the chain's clock.
      const expired = g.listingState === LISTING_STATE.active && run.block.timestamp >= BigInt(sealed.manifest.listingExpiry)
      if (cancelled) run.report.listingsCancelled += 1
      if (expired) run.report.listingsExpired += 1
      if (!run.apply) continue
      if (cancelled || expired) {
        chainMove('offered', 'cancelled', row.id)
        await prisma.intent.updateMany({
          where: { id: row.id, state: 'offered' },
          data: { state: 'cancelled', cancellationReason: cancelled ? 'seller_reclaimed' : 'expired', lastCheckedAt: now },
        })
      } else {
        await prisma.intent.updateMany({ where: { id: row.id, state: 'offered' }, data: { lastCheckedAt: now } })
      }
    } catch (err) {
      run.report.errors.push(describeError(err, `listing ${row.id}`))
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Payouts the token refused earlier
// ---------------------------------------------------------------------------

async function followClaims(run: Run): Promise<void> {
  const prefix = `escrow:${ESCROW_CHAIN_KEY}:${lower(run.reader.escrow)}:`
  const recent = await prisma.order.findMany({
    where: {
      paymentRef: { startsWith: prefix },
      state: { in: [OrderState.fulfilled, OrderState.refunded] },
      updatedAt: { gte: new Date(Date.now() - CLAIM_LOOKBACK_MS) },
    },
    select: { id: true, payerAddress: true },
    take: MAX_CLAIM_CHECKS,
  })
  const sellers = await prisma.intent.findMany({
    where: { matchedOrderId: { in: recent.map((o) => o.id) }, formFactor: ESCROW_INTENT_FORM_FACTOR },
    select: { accountId: true },
  })
  for (const o of recent) if (o.payerAddress) run.parties.add(lower(o.payerAddress))
  for (const s of sellers) if (s.accountId.startsWith('seller:')) run.parties.add(lower(s.accountId.slice('seller:'.length)))

  for (const who of [...run.parties].slice(0, MAX_CLAIM_CHECKS)) {
    try {
      if ((await run.reader.owed(run.block, who)) === 0n) continue
      run.report.claimsDue += 1
      const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'claim', args: [who] })
      if ((await send(run, data, `claim(${who})`)) !== null) run.report.claimsSent += 1
    } catch (err) {
      run.report.errors.push(describeError(err, `owed(${who})`))
    }
  }
}

/** One keeper run over both escrows. Never throws for a chain or Lit fault; those are in `errors`. */
export async function runEscrowKeeper(opts: KeeperOptions): Promise<KeeperReport> {
  const v1 = await runEscrowKeeperV1(opts)
  return { ...v1, v2: await runEscrowKeeperV2(opts) }
}

/** SalvoEscrowV1's run. */
async function runEscrowKeeperV1(opts: KeeperOptions): Promise<KeeperReport> {
  const rt = opts.rt ?? escrowRuntime()
  const account = keeperAccount(opts.keeperKey)
  const report: KeeperReport = {
    ran: false,
    skipped: null,
    applied: opts.apply,
    keeperKey: account !== null,
    block: null,
    depositCount: 0,
    newDeposits: 0,
    ordersCreated: 0,
    foreignDeposits: 0,
    released: 0,
    refunded: 0,
    partRefunds: 0,
    disputes: 0,
    listingsCancelled: 0,
    listingsExpired: 0,
    payoutsDue: 0,
    payoutsSent: 0,
    claimsDue: 0,
    claimsSent: 0,
    errors: [],
  }
  if (!escrowRailOn()) return { ...report, skipped: 'rail_off' }
  const reader = escrowReader(rt)
  if (reader === null) return { ...report, skipped: 'escrow_not_pinned' }
  report.ran = true

  let block: AgreedBlock
  try {
    block = await reader.block()
  } catch (err) {
    report.errors.push(describeError(err, 'finalized block'))
    return report
  }
  report.block = block.number.toString()
  const run: Run = { rt, reader, block, report, apply: opts.apply, account, txs: 0, parties: new Set() }

  // New purchases first, so a deposit that closed while nobody looked is
  // recorded and then closed in the same run.
  try {
    await scanNewDeposits(run)
  } catch (err) {
    report.errors.push(describeError(err, 'new deposits'))
  }
  await followOpenOrders(run)
  await followOfferedListings(run)
  try {
    await followClaims(run)
  } catch (err) {
    report.errors.push(describeError(err, 'claims'))
  }
  return report
}

/**
 * Every error of one run over both escrows, V2's marked `v2:`: what the
 * scripts print, and what makes a run fail. Fixed text only.
 */
export function keeperErrors(r: KeeperReport): string[] {
  return [...r.errors, ...(r.v2?.errors ?? []).map((e) => `v2: ${e}`)]
}

/** Was anything due this run left unsent, on either escrow: a payout, a claim, or V2's deposits back and balance reads? */
export function keeperLeftUnsent(r: KeeperReport): boolean {
  const v2 = r.v2
  const v1Left = r.payoutsDue > r.payoutsSent || r.claimsDue > r.claimsSent
  const v2Left = v2 !== undefined && (v2.payoutsDue > v2.payoutsSent || v2.bondsDue > v2.bondsSent || v2.confirmsDue > v2.confirmsSent || v2.claimsDue > v2.claimsSent)
  return v1Left || v2Left
}

/** One line for the cron log, V2's after V1's once V2 runs. Safe to print: counts and a block number. */
export function describeKeeper(r: KeeperReport): string {
  const v2 = r.v2?.ran === true ? ` | ${describeKeeperV2(r.v2)}` : ''
  return describeKeeperV1(r) + v2
}

function describeKeeperV1(r: KeeperReport): string {
  if (!r.ran) return `escrow-keeper skipped (${r.skipped ?? 'not run'})`
  const parts = [
    `escrow-keeper block=${r.block ?? '?'}`,
    `deposits=${r.depositCount}`,
    `new=${r.newDeposits}`,
    `orders=${r.ordersCreated}`,
    `foreign=${r.foreignDeposits}`,
    `released=${r.released}`,
    `refunded=${r.refunded}`,
    `partRefunds=${r.partRefunds}`,
    `disputes=${r.disputes}`,
    `cancelled=${r.listingsCancelled}`,
    `expired=${r.listingsExpired}`,
    `payoutsDue=${r.payoutsDue}`,
    `payoutsSent=${r.payoutsSent}`,
    `claimsDue=${r.claimsDue}`,
    `claimsSent=${r.claimsSent}`,
    `applied=${r.applied}`,
    `keeperKey=${r.keeperKey ? 'set' : 'missing'}`,
  ]
  if (r.errors.length > 0) parts.push(`errors=${r.errors.length}`)
  return parts.join(' ')
}
