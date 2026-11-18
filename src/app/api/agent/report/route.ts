import { readPurchaseToken } from '@/lib/agent/checkout'
import { json, readBody, tokenSecret } from '@/lib/agent/http'
import { prisma } from '@/lib/db'
import { pushOperator } from '@/lib/notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * A problem after the hand-over. Never refunds by itself: the agent already
 * holds the card numbers, so a person checks the cards before any money moves.
 */
export async function POST(req: Request) {
  const secret = tokenSecret()
  if (secret === null) return json(503, { error: 'rail_unavailable', message: 'MPP is not configured.' })
  const body = await readBody(req)
  const t = readPurchaseToken(typeof body?.token === 'string' ? body.token : '', secret)
  if (t === null) return json(404, { error: 'not_found', message: 'No paid purchase matches that token.' })
  const problem = (typeof body?.problem === 'string' ? body.problem : 'no detail given').replace(/\s+/g, ' ').slice(0, 300)
  for (const orderId of t.orderIds) {
    await prisma.orderEvent.create({
      data: { orderId, fromState: 'fulfilled', toState: 'fulfilled', actor: 'worker', reason: `AGENT_REPORT|${problem}` },
    })
  }
  await pushOperator({
    title: '[ACTION NEEDED] agent reports a problem with its cards',
    message: [
      `orders: ${t.orderIds.join(', ')}`,
      `payer: ${t.payer}`,
      `problem: ${problem}`,
      'Check the cards. Refund only what was empty or rejected before the agent used it.',
    ].join('\n'),
    priority: 5,
    tags: ['rotating_light'],
  })
  return json(202, {
    received: true,
    message: 'A person will check the cards. Anything empty or rejected before you used it is refunded to the paying address.',
  })
}
