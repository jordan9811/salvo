/**
 * The markers the agent endpoint writes on intents and order events. Kept in
 * their own module, with no heavy imports, so the shared listing and quote
 * code can recognise them without importing the agent checkout.
 *
 * On an intent (failureReason):
 *   AGENT_LEFTOVER|<orderId>|<leftoverCents>|<depositCents>|<payer>
 *       a part-used card handed to an agent, waiting for its report
 *   AGENT_REMAINDER|<orderId>|<depositCents>|<payer>
 *       that leftover back on sale; the deposit stands behind it
 *
 * On an order (OrderEvent.reason):
 *   AGENT_DEPOSIT|<cents>|<outcome>|...    charged, held, relisted, returned,
 *                                          taken, return_failed, needs_operator
 *   AGENT_REMAINDER_OF|<firstOrderId>|<depositCents>|<payer>|<valueCents>
 *       this order bought <firstOrderId>'s relisted leftover, worth <valueCents>
 */

export const LEFTOVER = 'AGENT_LEFTOVER'
export const REMAINDER = 'AGENT_REMAINDER'
export const REMAINDER_OF = 'AGENT_REMAINDER_OF'
export const DEPOSIT = 'AGENT_DEPOSIT'

/** Orders the agent endpoint made: its reserved buyer address, on the MPP rail, for gift cards. */
export const AGENT_ORDER = { buyerEmail: 'agent@agents.invalid', rail: 'mpp', kind: 'gift_card' } as const

const ID = /^[A-Za-z0-9_-]+$/
const ADDR = /^0x[0-9a-fA-F]{40}$/

export interface LeftoverMarker {
  orderId: string
  leftoverCents: number
  depositCents: number
  payer: string
}

export interface AgentRemainderMarker {
  orderId: string
  depositCents: number
  payer: string
}

export interface RemainderOf {
  firstOrderId: string
  depositCents: number
  payer: string
  valueCents: number
}

export function leftoverMarker(m: LeftoverMarker): string {
  return `${LEFTOVER}|${m.orderId}|${m.leftoverCents}|${m.depositCents}|${m.payer.toLowerCase()}`
}

export function remainderMarker(m: AgentRemainderMarker): string {
  return `${REMAINDER}|${m.orderId}|${m.depositCents}|${m.payer.toLowerCase()}`
}

export function remainderOfReason(m: RemainderOf): string {
  return `${REMAINDER_OF}|${m.firstOrderId}|${m.depositCents}|${m.payer.toLowerCase()}|${m.valueCents}`
}

export function decodeLeftover(reason: string | null | undefined): LeftoverMarker | null {
  const p = (reason ?? '').split('|')
  if (p.length !== 5 || p[0] !== LEFTOVER) return null
  const [, orderId = '', l = '', d = '', payer = ''] = p
  if (!ID.test(orderId) || !/^\d+$/.test(l) || !/^\d+$/.test(d) || !ADDR.test(payer)) return null
  return { orderId, leftoverCents: Number(l), depositCents: Number(d), payer }
}

export function decodeAgentRemainder(reason: string | null | undefined): AgentRemainderMarker | null {
  const p = (reason ?? '').split('|')
  if (p.length !== 4 || p[0] !== REMAINDER) return null
  const [, orderId = '', d = '', payer = ''] = p
  if (!ID.test(orderId) || !/^\d+$/.test(d) || !ADDR.test(payer)) return null
  return { orderId, depositCents: Number(d), payer }
}

export function decodeRemainderOf(reason: string | null | undefined): RemainderOf | null {
  const p = (reason ?? '').split('|')
  if (p.length !== 5 || p[0] !== REMAINDER_OF) return null
  const [, firstOrderId = '', d = '', payer = '', v = ''] = p
  if (!ID.test(firstOrderId) || !/^\d+$/.test(d) || !ADDR.test(payer) || !/^\d+$/.test(v)) return null
  return { firstOrderId, depositCents: Number(d), payer, valueCents: Number(v) }
}

/** An intent carrying any agent marker: shared code leaves these to the agent endpoint. */
export function isAgentHeld(reason: string | null | undefined): boolean {
  return (reason ?? '').startsWith('AGENT_')
}
