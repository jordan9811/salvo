/**
 * One claim before every agent money move.
 *
 * A deposit return, a deposit sent back before the hand-over, and a whole
 * charge sent back each claim a unique row in `processed_events` BEFORE the
 * transfer. Two confirms, two retries or two instances racing each other: the
 * second insert fails on the primary key and moves nothing. A transfer that
 * fails after its claim stays claimed, and the operator is paged, so it is
 * never retried into a double payment.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../db'
import { refundTempo } from '../crypto-refund'
import { pushOperator, type PushOptions, type PushResult } from '../notify'
import { operatorPushConfigured } from '../env'
import { isTestnet } from '../mpp'

/**
 * Money moves, and the markers around them. None of the markers moves money.
 *   payment-use   the first (and only) purchase a payment's transaction makes
 *   use-ended     that use is over with nothing bought (a person returns it)
 *   refused-seen  money that arrived for a challenge the library refused
 *   return-sent   an automatic return that was claimed and then sent
 *   return-failed an automatic return that was claimed and then failed
 *   manual-return a person recorded returning it by hand
 *   *-page        a page sent, once
 */
export type MoneyMoveKind =
  | 'deposit-return'
  | 'deposit-back'
  | 'charge-back'
  | 'payment-use'
  | 'use-ended'
  | 'refused-seen'
  | 'return-sent'
  | 'return-failed'
  | 'manual-return'
  | 'unfinished-page'
  | 'refused-page'
  | 'stranded-page'
  | 'held-page'

export function moneyClaimId(kind: MoneyMoveKind, key: string): string {
  return `agent-${kind}:${key}`
}

/** True when this caller won the claim; false when someone already made (or is making) this move. */
export async function claimMoneyMove(kind: MoneyMoveKind, key: string, orderId: string | null = null): Promise<boolean> {
  try {
    await prisma.processedEvent.create({ data: { id: moneyClaimId(kind, key), rail: 'mpp', orderId } })
    return true
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false
    throw err
  }
}

/**
 * Claim a move AND write its record in one transaction, so there is never a
 * claim with no record of why (a crash in between would otherwise leave the
 * money marked decided with nothing to say so). False when already claimed.
 */
export async function claimMoneyMoveWith(kind: MoneyMoveKind, key: string, orderId: string | null, write: (tx: Prisma.TransactionClient) => Promise<void>): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.processedEvent.create({ data: { id: moneyClaimId(kind, key), rail: 'mpp', orderId } })
      await write(tx)
    })
    return true
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false
    throw err
  }
}

const claimed = async (kind: MoneyMoveKind, key: string): Promise<boolean> => (await prisma.processedEvent.findUnique({ where: { id: moneyClaimId(kind, key) } })) !== null

/** A page reached the operator, or there is nowhere to send one (so retrying is pointless). */
export function pageLanded(r: PushResult | null): boolean {
  if (r?.sent) return true
  try {
    return !operatorPushConfigured()
  } catch {
    return false
  }
}

/**
 * Page once per key. The claim is taken first, so concurrent runs page once,
 * and given back when the page was tried and failed, so the next sweep run
 * pages again: a failed page is never silent.
 */
export async function pageOnce(kind: MoneyMoveKind, key: string, opts: PushOptions): Promise<boolean> {
  if (!(await claimMoneyMove(kind, key))) return false
  const r = await pushOperator(opts).catch(() => null)
  if (pageLanded(r)) return true
  await prisma.processedEvent.delete({ where: { id: moneyClaimId(kind, key) } }).catch(() => undefined)
  return false
}

/**
 * When automatic returns began marking how they ended (return-sent or
 * return-failed). It sits after the deploy that added the markers, so a
 * return the older code made just before it is never taken for one that died
 * mid-send. A return claimed before this with no marker is taken as done, as
 * it always was; one claimed after with neither marker never finished and
 * may still be owed. AGENT_RETURN_MARKERS_SINCE (an ISO time) moves it.
 */
const RETURN_MARKERS_DEFAULT = '2026-11-16T14:00:00Z'
export function returnMarkersSince(): Date {
  const set = process.env.AGENT_RETURN_MARKERS_SINCE
  const at = new Date(set !== undefined && set !== '' ? set : RETURN_MARKERS_DEFAULT)
  return Number.isNaN(at.getTime()) ? new Date(RETURN_MARKERS_DEFAULT) : at
}

export type ManualReturn = 'recorded' | 'auto_failed' | 'already' | 'has_orders' | 'in_flight'

/**
 * Record that a person is returning an agent payment by hand
 * (`pnpm agent:settle --returned=<tx>`). Run it BEFORE sending: it takes the
 * payment's use, so no purchase can be made with it afterwards, and its
 * return, so nothing returns it again; the pages about it go quiet.
 *   recorded: send it now.
 *   auto_failed: an automatic return was started and failed or never
 *   finished. Check the chain for ANY transfer from our wallet to the payer
 *   since then (the error may name none), then send only if there is none.
 *   already: returned, or recorded before. Do not send it.
 *   has_orders: the payment bought something. Check those orders instead.
 *   in_flight: a purchase, or an automatic return, took it under 15 minutes
 *   ago and may still be running. Try again later.
 */
export async function recordManualReturn(transaction: string, now: Date = new Date()): Promise<ManualReturn> {
  const tx = transaction.toLowerCase()
  const orders = () => prisma.order.count({ where: { paymentRef: { equals: tx, mode: 'insensitive' } } })
  const quiet = async () => {
    await claimMoneyMove('stranded-page', tx)
    await claimMoneyMove('refused-page', tx)
  }
  if ((await orders()) > 0) return 'has_orders'
  const back = await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('charge-back', tx) } })
  if (back) {
    // Claimed by an automatic return (or recorded by hand). How it ended
    // decides first; only a return with no ending recorded falls back on
    // when it was claimed. Still owed only if it failed, or it was claimed
    // after the markers began and never finished. Once.
    if ((await claimed('return-sent', `charge-back:${tx}`)) || (await claimed('manual-return', tx))) return 'already'
    if (!(await claimed('return-failed', `charge-back:${tx}`))) {
      if (back.processedAt < returnMarkersSince()) return 'already'
      if (back.processedAt.getTime() > now.getTime() - 15 * 60_000) return 'in_flight'
    }
    if (!(await claimMoneyMove('manual-return', tx))) return 'already'
    await quiet()
    return 'auto_failed'
  }
  if (!(await claimMoneyMove('payment-use', tx))) {
    // A purchase took it. Running, or over with nothing bought?
    const use = await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('payment-use', tx) } })
    const recent = use !== null && use.processedAt.getTime() > now.getTime() - 15 * 60_000
    if (recent && !(await claimed('use-ended', tx))) return 'in_flight'
    if ((await orders()) > 0) return 'has_orders'
  }
  // The return and its by-hand marker together, so it never looks like an
  // automatic return that died mid-send.
  if (!(await claimMoneyMoveWith('charge-back', tx, null, async (db) => void (await db.processedEvent.create({ data: { id: moneyClaimId('manual-return', tx), rail: 'mpp' } }))))) return 'already'
  await quiet()
  return 'recorded'
}

export type SendBack = { status: 'sent'; txHash: string } | { status: 'already'; txHash: null } | { status: 'failed'; txHash: null }

/**
 * Claim, then send `cents` test pathUSD back to `payer`. Pages the operator
 * when the transfer fails after the claim (it is not retried automatically).
 */
export async function sendBackOnce(kind: MoneyMoveKind, key: string, payer: string, cents: number, why: string, orderId: string | null = null): Promise<SendBack> {
  if (cents <= 0) return { status: 'already', txHash: null }
  // Agent money is test money. On any other network a return is a person's
  // call: a deposit charged on testnet must never come back in real USDC.
  let testnet = false
  try {
    testnet = isTestnet()
  } catch {
    testnet = false
  }
  if (!testnet) {
    // Paged once per move, not on every sweep run.
    if (!(await claimMoneyMove('held-page', `${kind}:${key}`, orderId))) return { status: 'failed', txHash: null }
    await pushOperator({ title: '[ACTION NEEDED] agent money return held: not on testnet', message: [why, `kind: ${kind}`, `key: ${key}`, `payer: ${payer}`, `amount: ${cents}c`].join(String.fromCharCode(10)), priority: 5, tags: ['rotating_light'] }).catch(() => undefined)
    return { status: 'failed', txHash: null }
  }
  if (!(await claimMoneyMove(kind, key, orderId))) return { status: 'already', txHash: null }
  try {
    const r = await refundTempo(payer, cents)
    // Marked, so the sweep can tell a finished return from one that died
    // between its claim and the transfer's answer.
    await claimMoneyMove('return-sent', `${kind}:${key}`, orderId).catch(() => false)
    return { status: 'sent', txHash: r.txHash }
  } catch (err) {
    // Marked, so recording the manual return later says it is still owed
    // rather than "already returned".
    await claimMoneyMove('return-failed', `${kind}:${key}`, orderId).catch(() => false)
    const r = await pushOperator({
      title: '[ACTION NEEDED] agent money return FAILED',
      message: [why, `kind: ${kind}`, `key: ${key}`, `payer: ${payer}`, `amount: ${cents}c`, `error: ${String(err).slice(0, 300)}`, 'Claimed and not retried. It may have gone through even if the error names no transaction: check the chain for ANY transfer from our wallet to the payer since now, and send by hand only if there is none.', ...(kind === 'charge-back' ? [`Record it first: pnpm agent:settle --returned=${key}`] : [])].join('\n'),
      priority: 5,
      tags: ['rotating_light'],
    }).catch(() => null)
    // Landed: the sweep need not say it again. Did not: the sweep's
    // unfinished-return check pages it on its next run.
    if (pageLanded(r)) await claimMoneyMove('unfinished-page', `${kind}:${key}`, orderId).catch(() => false)
    return { status: 'failed', txHash: null }
  }
}
