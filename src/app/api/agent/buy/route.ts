/**
 * Buy a quoted set of gift cards, paid over MPP on Tempo.
 *
 *   No payment yet: quote again from live supply (a quote is a price, not a
 *   reservation). No quote, or a charge above the agent's `maxPriceCents`, is
 *   refused with nothing charged; otherwise a 402 challenge for the charge.
 *
 *   A payment credential: in MPP's push mode the transfer is already on chain
 *   when this arrives, so it is SETTLED FIRST, at the amount its challenge
 *   was issued for (signed with our secret, so it cannot be altered). Then
 *   the quote is checked again. Still the same charge: the purchase goes
 *   ahead. Gone or changed: the payment goes straight back.
 *
 * Every return of a whole charge is claimed once (src/lib/agent/money.ts).
 * deliverAgentPurchase returns everything itself when it fails after making
 * orders, so an unexpected error here pages a person rather than refunding a
 * second time. Testnet only.
 */
import type { NextResponse } from 'next/server'
import { AgentPurchaseError, agentQuote, chargeCents, deliverAgentPurchase, publicAgentQuote, purchaseToken, redeliverAgentPurchase, type AgentQuote } from '@/lib/agent/checkout'
import { AGENT_ORDER } from '@/lib/agent/markers'
import { AGENT_CHARGE_META, credentialAmountCents, json, readBody, refusedPayment, refuseOffTestnet, tokenSecret } from '@/lib/agent/http'
import { paymentToUs } from '@/lib/agent/chain'
import { claimMoneyMove, moneyClaimId, pageLanded, sendBackOnce } from '@/lib/agent/money'
import { prisma } from '@/lib/db'
import { centsToAmountString, MppNotConfiguredError, mppRuntime, receiptKeyFor, recoverTempoPayer, tempoExplorerUrl, tempoNetwork } from '@/lib/mpp'
import { pushOperator } from '@/lib/notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<NextResponse> {
  const off = refuseOffTestnet()
  if (off) return off
  let rt: ReturnType<typeof mppRuntime>
  try {
    rt = mppRuntime()
  } catch (err) {
    if (err instanceof MppNotConfiguredError) return json(503, { error: 'rail_unavailable', message: err.message })
    throw err
  }
  const secret = tokenSecret()
  if (secret === null) return json(503, { error: 'rail_unavailable', message: 'MPP is not configured.' })

  const body = await readBody(req)
  const merchant = typeof body?.merchant === 'string' ? body.merchant : ''
  const cartTotalCents = Number(body?.cartTotalCents)
  const maxPriceCents = Number(body?.maxPriceCents)
  if (merchant === '' || !Number.isInteger(cartTotalCents) || !Number.isInteger(maxPriceCents)) {
    return json(400, { error: 'invalid_body', message: 'Send { merchant, cartTotalCents, maxPriceCents } in whole cents. Nothing was charged.' })
  }
  const allowPartial = body?.allowPartial === true
  const paidCents = credentialAmountCents(req)

  // NO PAYMENT YET: refuse before any money moves, or ask for it.
  if (paidCents === null) {
    const quote = await agentQuote({ merchantId: merchant, cartTotalCents, allowPartial })
    if (quote.kind === 'no_quote') return json(409, { error: 'no_quote', message: `${quote.reason}. Nothing was charged.` })
    const charge = chargeCents(quote)
    if (charge > maxPriceCents) {
      return json(409, { error: 'price_changed', message: 'The price went up since your quote. Nothing was charged.', quote: publicAgentQuote(quote) })
    }
    const challenge = await rt.mppx.compose(['tempo/charge', { amount: centsToAmountString(charge), meta: AGENT_CHARGE_META }] as const)(req)
    if (challenge.status === 402) return challenge.challenge as NextResponse
    // A request with no credential is always challenged; anything else is a library surprise.
    return json(500, { error: 'unexpected', message: 'The payment step answered unexpectedly. Nothing was charged.' })
  }

  // A PAYMENT: settle it at the amount it was made for, then decide.
  const result = await rt.mppx.compose(['tempo/charge', { amount: centsToAmountString(paidCents), meta: AGENT_CHARGE_META }] as const)(req)
  if (result.status === 402) {
    // Refused: usually a retry after the payment was already used; otherwise
    // expired, for another route, or not a valid payment at all. Only a
    // challenge we issued for this route is looked at (refusedPayment).
    const refused = refusedPayment(req, secret)
    if (refused !== null) {
      const tx = refused.transaction
      const used = await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('payment-use', tx) } })
      const orders = await prisma.order.count({ where: { paymentRef: { equals: tx, mode: 'insensitive' } } })
      if (used || orders > 0) {
        // Already handled here: no page that could invite a second refund.
        return json(409, {
          error: 'already_processed',
          message: 'That payment was already used. To get its cards again, POST /api/agent/purchase with { transaction, signature }, the signature being your paying wallet signing "salvo purchase <transaction>".',
        })
      }
      // Did money arrive FOR THIS CHALLENGE (chain.ts)? A pull payment the
      // library broadcast and then gave up waiting on can land a moment later.
      let seen = await paymentToUs(tx, refused.challengeId)
      for (let i = 0; seen.status === 'none' && refused.mode === 'pull' && i < 3; i += 1) {
        await new Promise((r) => setTimeout(r, 1500))
        seen = await paymentToUs(tx, refused.challengeId)
      }
      if (seen.status === 'none' && (await prisma.processedEvent.findUnique({ where: { id: moneyClaimId('refused-seen', `${tx}|${refused.challengeId}`) } }))) {
        // A resend of a payment already seen (paid, or unreadable) that the
        // chain does not show right now, e.g. still pending: answered the same
        // way, never with a fresh challenge the agent's client would pay again.
        seen = { status: 'unknown', error: 'not visible on chain yet' }
      }
      if (seen.status !== 'none') {
        // Paid, or the chain can't be read (the library may have refused for
        // that same reason). Recorded, not paged: a purchase using it may be
        // running on another instance. The agent sweep reads the chain again
        // once the challenge has expired, pages it if money arrived and
        // nothing used it, and drops it otherwise. No fresh challenge goes
        // back, so the agent's client does not pay a second time.
        let recorded = true
        try {
          await claimMoneyMove('refused-seen', `${tx}|${refused.challengeId}`)
        } catch {
          recorded = false
        }
        if (!recorded) {
          // The record failed: say it now rather than promise a return nobody
          // will see. Paid or unreadable alike: the sweep cannot follow it up.
          await pushOperator({
            title: '[ACTION NEEDED] agent payment refused, record failed',
            message: [
              `transaction: ${tx}`,
              seen.status === 'paid' ? `on chain: ${seen.cents}c from ${seen.payer}, for challenge ${refused.challengeId}` : `on chain: unreadable just now (${seen.error}), for challenge ${refused.challengeId}`,
              `Wait 15 minutes, check on chain that it paid us and that no order uses it, record it FIRST: pnpm agent:settle --returned=${tx}, then return it by hand.`,
            ].join(String.fromCharCode(10)),
            priority: 5,
            tags: ['rotating_light'],
          }).catch(() => undefined)
        }
        if (seen.status === 'unknown') {
          // Resending the same payment is safe: it is either used once or refused again.
          return json(503, {
            error: 'payment_unverified',
            message: `Your payment could not be checked on chain just now. Do NOT make a new payment. Resend this same request, with the same payment, in a minute. If it still cannot be used and it arrived, it is returned to the paying wallet by hand. Transaction: ${tx}`,
          })
        }
        return json(409, {
          error: 'payment_refused',
          message: `Your payment of ${seen.cents}c arrived but could not be used (its request expired, did not match, or was already in use). Do not pay again. If another request of yours used it, fetch the cards with POST /api/agent/purchase. Otherwise it is returned to the paying wallet by hand. Transaction: ${tx}`,
        })
      }
    }
    return result.challenge as NextResponse
  }

  const key = receiptKeyFor(req)
  const receipt = key ? (rt.receipts.get(key) ?? null) : null
  if (key) rt.receipts.delete(key)
  if (!receipt?.reference) {
    await pushOperator({ title: '[ACTION NEEDED] agent MPP payment without a receipt reference', message: `A Tempo charge of ${paidCents}c verified with no tx reference. Investigate before refunding.`, priority: 5, tags: ['rotating_light'] })
    return json(500, { error: 'receipt_missing', message: 'YOU WERE CHARGED, but the payment returned no transaction reference. The operator has been paged to return it by hand.' })
  }
  const payer = (await recoverTempoPayer(receipt.reference)) ?? receipt.payer ?? null
  if (!payer) {
    // Use the payment up first, so a resent credential (here or on another
    // instance) can neither buy with it nor page about it a second time, and
    // mark that use over, so recording the return by hand is not held back.
    // A database error pages anyway rather than leaving it silent.
    let claimed: boolean | null = null
    try {
      claimed = await claimMoneyMove('payment-use', receipt.reference)
    } catch {
      claimed = null
    }
    if (claimed === false) {
      return json(409, { error: 'already_processed', message: 'This payment was already used or returned. Nothing new was charged.' })
    }
    if (claimed) await claimMoneyMove('use-ended', receipt.reference).catch(() => false)
    const paged = await pushOperator({
      title: '[ACTION NEEDED] agent MPP payer could not be recovered',
      message: [`charge: ${receipt.reference}`, `amount: ${paidCents}c`, 'No cards were handed over. Find the payer on chain.', `Record it FIRST: pnpm agent:settle --returned=${receipt.reference}, then return it by hand.`].join('\n'),
      priority: 5,
      tags: ['rotating_light'],
    }).catch(() => null)
    // Landed: the sweep's backstop page for this claim is not needed. Not landed: it stays.
    if (claimed && pageLanded(paged)) await claimMoneyMove('stranded-page', receipt.reference).catch(() => false)
    return json(500, { error: 'payer_unknown', message: `YOU WERE CHARGED, but the paying address could not be read, so no cards were handed over. The operator has been paged to return it. Charge tx: ${receipt.reference}` })
  }

  // THE FIRST USE OF THIS PAYMENT, claimed before anything else. A replay
  // (the payment library's memory does not survive a restart) never reaches
  // a refund: it gets the purchase this payment already made, or nothing.
  if (!(await claimMoneyMove('payment-use', receipt.reference))) {
    return alreadyUsed(receipt.reference, payer, secret)
  }

  // From here the payment is claimed: anything that throws before an order or
  // a return exists would strand it, so a failed quote returns it (and the
  // agent sweep pages any claim left with neither).
  let quote: AgentQuote | { kind: 'no_quote'; reason: string }
  try {
    quote = await agentQuote({ merchantId: merchant, cartTotalCents, allowPartial })
  } catch (err) {
    return returnPayment(payer, paidCents, receipt.reference, `The quote failed after your payment settled (${err instanceof Error ? err.message.slice(0, 80) : 'error'})`)
  }
  if (quote.kind === 'no_quote') return returnPayment(payer, paidCents, receipt.reference, `${quote.reason}`)
  if (chargeCents(quote) !== paidCents) return returnPayment(payer, paidCents, receipt.reference, 'The price changed while you were paying')
  if (paidCents > maxPriceCents) return returnPayment(payer, paidCents, receipt.reference, 'The charge is above the maxPriceCents you sent')

  try {
    const purchase = await deliverAgentPurchase({ quote, paymentRef: receipt.reference, payer, tokenSecret: secret })
    return result.withReceipt(
      json(200, {
        token: purchase.token,
        priceCents: purchase.priceCents,
        depositCents: purchase.depositCents,
        coveredCents: purchase.coveredCents,
        remainderCents: purchase.remainderCents,
        cards: purchase.cards,
        instructions:
          'Apply each card for its applyCents in the store gift card field, in the order given (a part-used card last). Pay the remainder your usual way. Then POST /api/agent/confirm with cards: [{ orderId, last4, appliedCents, remainingCents }] (remainingCents gets a deposit back), or /api/agent/report if the store refused a card. Lost this response? POST /api/agent/purchase with { transaction, signature }, signing "salvo purchase <transaction>" with the paying wallet.',
        payment: { network: tempoNetwork().key, transaction: receipt.reference, explorer: tempoExplorerUrl(receipt.reference), payer },
      }),
    ) as NextResponse
  } catch (err) {
    if (err instanceof AgentPurchaseError) {
      // No order was made: the whole charge goes back here.
      if (err.code === 'price_changed' || err.code === 'not_created' || err.code === 'no_quote') return returnPayment(payer, paidCents, receipt.reference, err.message)
      // A replayed payment: its purchase already exists. Nothing moves.
      if (err.code === 'already_processed') return json(409, { error: err.code, message: err.message })
      // The purchase returned everything itself, or paged.
      return json(err.code === 'refund_failed' ? 500 : 409, { error: err.code, message: err.message })
    }
    console.error('[agent/buy] unexpected failure after settlement:', err)
    const orders = await prisma.order.count({ where: { paymentRef: receipt.reference } }).catch(() => null)
    // The use is over: recording the return by hand is not held back.
    await claimMoneyMove('use-ended', receipt.reference).catch(() => false)
    const paged = await pushOperator({
      title: '[ACTION NEEDED] agent purchase failed unexpectedly after payment',
      message: [
        `charge: ${receipt.reference}`,
        `payer: ${payer}`,
        `amount: ${paidCents}c`,
        `orders: ${orders ?? 'unknown (the count failed)'}`,
        `error: ${String(err).slice(0, 300)}`,
        `Check its orders and cards before refunding anything. With no orders, record it FIRST: pnpm agent:settle --returned=${receipt.reference}, then return it by hand.`,
      ].join('\n'),
      priority: 5,
      tags: ['rotating_light'],
    }).catch(() => null)
    // One page per payment: with no orders the agent sweep would page this
    // claim again in 15 minutes, so once this page went out its page is
    // taken. If this page failed, the sweep's stays as the backstop.
    if (pageLanded(paged) && orders === 0) await claimMoneyMove('stranded-page', receipt.reference).catch(() => false)
    return json(500, { error: 'check_by_hand', message: `Your payment settled and something unexpected went wrong. The operator has been paged to check it and return what is owed. Charge tx: ${receipt.reference}` })
  }
}

/** A settled payment with nothing to show for it goes straight back, once. */
async function returnPayment(payer: string, cents: number, charge: string, reason: string): Promise<NextResponse> {
  const sent = await sendBackOnce('charge-back', charge, payer, cents, reason)
  if (sent.status === 'sent') {
    await pushOperator({ title: '[REFUNDED] agent payment returned', message: [reason, `payer: ${payer}`, `charge: ${charge}`, `return: ${sent.txHash}`].join('\n'), priority: 3, tags: ['warning'] }).catch(() => undefined)
    return json(409, { error: 'refunded', message: `${reason}. Your payment has been returned: ${sent.txHash}` })
  }
  if (sent.status === 'already') return json(409, { error: 'refunded', message: `${reason}. This payment was already returned.` })
  return json(500, { error: 'refund_failed', message: `${reason}. YOU WERE CHARGED and the automatic refund failed. The operator has been paged. Charge tx: ${charge}` })
}

/**
 * This payment already made its purchase (or was already returned). The
 * holder of a payment the library accepted gets that purchase's cards and
 * token again; nothing else moves.
 */
async function alreadyUsed(transaction: string, payer: string, secret: string): Promise<NextResponse> {
  const orders = await prisma.order.findMany({ where: { paymentRef: { equals: transaction, mode: 'insensitive' }, ...AGENT_ORDER }, orderBy: { createdAt: 'asc' } })
  const mine = orders.filter((o) => o.state === 'fulfilled' && o.payerAddress?.toLowerCase() === payer.toLowerCase())
  if (mine.length > 0) {
    const token = purchaseToken(mine.map((o) => o.id), payer, secret)
    const cards = await redeliverAgentPurchase(token, secret)
    if (cards) return json(200, { alreadyBought: true, token, cards, message: 'This payment already bought these cards. Nothing new was charged.' })
  }
  // Claimed, with no fulfilled purchase to hand back. Not paged here: the
  // first use may still be running on another instance (two overlap during a
  // deploy). If it stays with no order and no return, the agent sweep pages
  // it after 15 minutes.
  return json(409, { error: 'already_processed', message: 'This payment was already used or returned. Nothing new was charged. If its purchase completes, fetch the cards with POST /api/agent/purchase.' })
}
