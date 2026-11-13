/**
 * What both escrow keepers share (keeper.ts for SalvoEscrowV1, keeper-v2.ts
 * for SalvoEscrowV2): the keeper key's account, an order move as a
 * compare-and-swap with its audit event, an intent move the chain made, and
 * error text that is safe to log.
 *
 * Server and scripts only. Never prints or returns a key.
 */

import { OrderState, type Prisma } from '@prisma/client'
import type { Hex } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Tx } from '@/lib/db'
import { canTransitionIntent, IllegalIntentTransitionError } from '@/lib/intent/state'
import type { IntentState } from '@/lib/intent/types'
import { assertTransition } from '@/lib/state'
import { EscrowRpcError } from './runbook/rpc'

const KEY_RE = /^0x[0-9a-fA-F]{64}$/

/** Fixed text for a fault: hosts, methods, revert reasons. Never a key, a card or a body. */
export function describeError(err: unknown, what: string): string {
  if (err instanceof EscrowRpcError) return `${what}: ${err.message}`
  return `${what}: failed`
}

/**
 * The intent table's own rule, for a move the chain made. Not
 * assertIntentTransition: that is the door every other path shares, and it
 * refuses every escrow listing by id, so that only a keeper can move one.
 */
export function chainMove(from: IntentState, to: IntentState, intentId: string): void {
  if (!canTransitionIntent(from, to)) throw new IllegalIntentTransitionError(from, to, intentId)
}

/** One order move, as a compare-and-swap on its state, with its audit event. */
export async function moveOrder(
  tx: Tx,
  orderId: string,
  from: OrderState,
  to: OrderState,
  reason: string,
  data: Prisma.OrderUpdateManyMutationInput = {},
): Promise<boolean> {
  assertTransition(from, to, orderId)
  const now = new Date()
  const res = await tx.order.updateMany({
    where: { id: orderId, state: from },
    data: {
      ...data,
      state: to,
      ...(to === OrderState.fulfilled ? { fulfilledAt: now } : {}),
      ...(to === OrderState.refunded ? { refundedAt: now } : {}),
    },
  })
  if (res.count === 0) return false
  await tx.orderEvent.create({ data: { orderId, fromState: from, toState: to, reason, actor: 'chain' } })
  return true
}

/** The keeper key's account, or null when there is none or it is not a key. The key is never echoed. */
export function keeperAccount(key: string | null): PrivateKeyAccount | null {
  const k = (key ?? '').trim()
  if (!KEY_RE.test(k)) return null
  try {
    return privateKeyToAccount(k as Hex)
  } catch {
    return null
  }
}
