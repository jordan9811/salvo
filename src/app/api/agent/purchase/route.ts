import { recoverMessageAddress } from 'viem'
import { purchaseToken, redeliverAgentPurchase } from '@/lib/agent/checkout'
import { json, purchaseRecoveryMessage, readBody, tokenSecret } from '@/lib/agent/http'
import { AGENT_ORDER } from '@/lib/agent/markers'
import { prisma } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The cards of a paid purchase again. Either with its token, or, when the
 * buy response (and so the token) was lost, with the payment's transaction
 * and a signature over `salvo purchase <transaction>` from the wallet that
 * paid: only that wallet can make it.
 */
export async function POST(req: Request) {
  const secret = tokenSecret()
  if (secret === null) return json(503, { error: 'rail_unavailable', message: 'MPP is not configured.' })
  const body = await readBody(req)
  const notFound = json(404, { error: 'not_found', message: 'No paid purchase matches that.' })

  let token = typeof body?.token === 'string' ? body.token : ''
  const transaction = typeof body?.transaction === 'string' ? body.transaction : ''
  const signature = typeof body?.signature === 'string' ? body.signature : ''
  if (token === '' && /^0x[0-9a-fA-F]{64}$/.test(transaction) && /^0x[0-9a-fA-F]+$/.test(signature)) {
    let signer: string
    try {
      signer = (await recoverMessageAddress({ message: purchaseRecoveryMessage(transaction), signature: signature as `0x${string}` })).toLowerCase()
    } catch {
      return notFound
    }
    const orders = await prisma.order.findMany({ where: { paymentRef: { equals: transaction, mode: 'insensitive' }, state: 'fulfilled', ...AGENT_ORDER }, orderBy: { createdAt: 'asc' } })
    const mine = orders.filter((o) => o.payerAddress?.toLowerCase() === signer)
    if (mine.length === 0) return notFound
    token = purchaseToken(mine.map((o) => o.id), signer, secret)
  }
  const cards = token === '' ? null : await redeliverAgentPurchase(token, secret)
  if (cards === null) return notFound
  return json(200, { token, cards })
}
