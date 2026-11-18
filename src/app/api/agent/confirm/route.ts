import { recordAgentConfirmation, type CardReport } from '@/lib/agent/checkout'
import { json, readBody, refuseOffTestnet, tokenSecret } from '@/lib/agent/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * What the store applied, and its order number: the evidence sellers are
 * settled on. Per card (`cards: [{ last4, appliedCents, remainingCents }]`),
 * it also settles leftovers: a part-used card reported intact goes back on
 * sale, and a card that was someone's leftover, applied in full, returns
 * their deposit.
 */
export async function POST(req: Request) {
  // Confirming can return deposits: test money only.
  const off = refuseOffTestnet()
  if (off) return off
  const secret = tokenSecret()
  if (secret === null) return json(503, { error: 'rail_unavailable', message: 'MPP is not configured.' })
  const body = await readBody(req)
  const token = typeof body?.token === 'string' ? body.token : ''
  const cards: CardReport[] = Array.isArray(body?.cards)
    ? (body.cards as unknown[]).flatMap((c): CardReport[] => {
        if (typeof c !== 'object' || c === null) return []
        const o = c as Record<string, unknown>
        if (typeof o.last4 !== 'string' || !/^\d{4}$/.test(o.last4)) return []
        return [
          {
            ...(typeof o.orderId === 'string' && /^[A-Za-z0-9_-]+$/.test(o.orderId) ? { orderId: o.orderId } : {}),
            last4: o.last4,
            ...(Number.isInteger(o.appliedCents) ? { appliedCents: o.appliedCents as number } : {}),
            ...(Number.isInteger(o.remainingCents) ? { remainingCents: o.remainingCents as number } : {}),
          },
        ]
      })
    : []
  const result = await recordAgentConfirmation(token, secret, {
    ...(typeof body?.appliedCents === 'number' ? { appliedCents: body.appliedCents } : {}),
    ...(typeof body?.storeOrderNumber === 'string' ? { storeOrderNumber: body.storeOrderNumber } : {}),
    cards,
  })
  return result === null ? json(404, { error: 'not_found', message: 'No paid purchase matches that token.' }) : json(200, { recorded: true, ...result })
}
