import { agentQuote, chargeCents, publicAgentQuote } from '@/lib/agent/checkout'
import { agentBase, json, readBody } from '@/lib/agent/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Free. A quote is a price, not a reservation. */
export async function POST(req: Request) {
  const body = await readBody(req)
  const merchant = typeof body?.merchant === 'string' ? body.merchant : ''
  const cartTotalCents = Number(body?.cartTotalCents)
  if (merchant === '' || !Number.isInteger(cartTotalCents)) {
    return json(400, { error: 'invalid_body', message: 'Send { merchant, cartTotalCents } with the cart total in whole cents.' })
  }
  const allowPartial = body?.allowPartial === true
  const q = await agentQuote({ merchantId: merchant, cartTotalCents, allowPartial })
  if (q.kind === 'no_quote') return json(200, { quote: null, reason: q.reason })
  return json(200, {
    quote: publicAgentQuote(q),
    buy: { method: 'POST', url: `${agentBase(req)}/api/agent/buy`, body: { merchant: q.merchantId, cartTotalCents: q.cartTotalCents, maxPriceCents: chargeCents(q), ...(allowPartial ? { allowPartial: true } : {}) } },
  })
}
