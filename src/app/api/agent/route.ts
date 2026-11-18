import { agentBase, json } from '@/lib/agent/http'
import { AGENT_MAX_CARDS, AGENT_QUOTE_TTL_MS } from '@/lib/agent/checkout'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** What an agent needs to use Salvo, in one read. */
export function GET(req: Request) {
  const base = agentBase(req)
  return json(200, {
    service: 'Salvo',
    summary:
      'Discounted gift cards for your cart at a store, paid per purchase in USDC over MPP on Tempo. Whole cards by default, or one part-used card with a refundable deposit where the store allows it; pay any remainder at the store your usual way.',
    network: 'Tempo testnet (moderato). Test money only.',
    steps: [
      { step: 'quote', method: 'POST', url: `${base}/api/agent/quote`, body: { merchant: 'target', cartTotalCents: 2340 }, note: `Free. A price holds ${AGENT_QUOTE_TTL_MS / 60_000} minutes and reserves nothing. Add "allowPartial": true to accept one part-used card with a refundable deposit for its leftover, where the store allows it (not at stores that lock a card to the account, like Target).` },
      { step: 'buy', method: 'POST', url: `${base}/api/agent/buy`, body: { merchant: 'target', cartTotalCents: 2340, maxPriceCents: 1990 }, note: 'Answers 402 with an MPP challenge. Pay it, for example: npx mppx <url> -J <body>. Returns the card numbers and a purchase token.' },
      { step: 'apply', note: `Enter each card number and access number in the store gift card field, at the full value. Up to ${AGENT_MAX_CARDS} cards. If the store applies less than expected, stop and report it.` },
      { step: 'confirm', method: 'POST', url: `${base}/api/agent/confirm`, body: { token: '<purchase token>', appliedCents: 2000, storeOrderNumber: '<order number>', cards: [{ last4: '2138', appliedCents: 2000, remainingCents: 0 }] }, note: 'Per card: what the store applied and what it says is left. Reporting a part-used card intact puts its leftover back on sale; your deposit comes back when the next buyer proves it.' },
      { step: 'report', method: 'POST', url: `${base}/api/agent/report`, body: { token: '<purchase token>', problem: 'what the store said' }, note: 'A person checks the cards. Anything empty or rejected before you used it is refunded.' },
      { step: 'cards again', method: 'POST', url: `${base}/api/agent/purchase`, body: { token: '<purchase token>' }, note: 'If the buy response was lost.' },
    ],
    salvoAccount: {
      what: 'Salvo places the order from its own store account, so an agent needs no store login. Quote only for now.',
      quote: { method: 'POST', url: `${base}/api/agent/account/quote`, body: { merchant: 'target', cartTotalCents: 2340 } },
    },
  })
}
