/**
 * A V2 ticket Lit signed is not yet one SalvoEscrowV2 takes (quote.ts says why
 * for V1; the same holds here). The template reads only gate(); who may sell
 * the card, one live listing per card, and the new-seller cap only the
 * contract checks. So once the ticket names the card's tag, the ticket route
 * asks the chain, and a listing the contract would refuse is marked and left
 * out of quotes instead of costing every shopper a reverted batch.
 *
 * V2 enforces one live listing per card on chain (cardListing), but only once
 * a sale leaves a leftover: two fresh listings of one card both look for sale
 * until one sells, and a Load that picks both reverts whole. So, as for V1,
 * the tag each ticket names is kept here, and a ticket for a card another
 * listing still offers is refused.
 *
 * Server-only.
 */

import type { Hex } from 'viem'
import { escrowReaderV2 } from './chain-v2'
import { V2_STATE, type CardSaleRefusalV2 } from './runbook/reads-v2'
import { escrowRuntime, type EscrowRuntime } from './runtime'

/** Card tags remembered per process, to find one card listed twice. */
const MAX_CARD_TAGS = 5_000

/** card tag -> the V2 listings Lit has named it in that may still be for sale. Never shown, never stored. */
const listingsOfCard = new Map<Hex, Array<{ intentId: string; listingId: Hex; expiry: number }>>()

export type TicketedCardRefusalV2 = CardSaleRefusalV2 | 'card_listed_twice'

/**
 * After Lit signed a V2 ticket for `intentId`: would SalvoEscrowV2 sell this
 * card on this listing, and is it the only listing of it still for sale? Read
 * on both hosts at one finalized block. Null when the ticket is good to send.
 */
export async function ticketedCardRefusalV2(
  intentId: string,
  sale: { cardTag: Hex; seller: Hex; mode: number; valueCents: number; listingId: Hex; listingExpiry: number; sales: number },
  rt: EscrowRuntime = escrowRuntime(),
): Promise<TicketedCardRefusalV2 | null> {
  const tag = sale.cardTag.toLowerCase() as Hex
  const others = (listingsOfCard.get(tag) ?? []).filter((l) => l.intentId !== intentId)
  const mine = { intentId, listingId: sale.listingId, expiry: sale.listingExpiry }
  if (!listingsOfCard.has(tag) && listingsOfCard.size >= MAX_CARD_TAGS) {
    const oldest = listingsOfCard.keys().next()
    if (!oldest.done) listingsOfCard.delete(oldest.value)
  }
  listingsOfCard.set(tag, [...others, mine])
  const reader = escrowReaderV2(rt)
  // The route answers not_ready before this whenever V2 is not configured.
  if (reader === null) throw new Error('there is no configured V2 escrow to read')
  const block = await reader.block()
  const onChain = await reader.cardSaleRefusal(block, {
    cardTag: tag,
    seller: sale.seller,
    listingId: sale.listingId,
    sales: sale.sales,
    mode: sale.mode,
    valueCents: sale.valueCents,
  })
  if (onChain === null && sale.sales > 0) {
    // The chain sells this card's leftover under this listing and no other
    // (cardListing): any other listing of it is the one the chain refuses.
    listingsOfCard.set(tag, [mine])
    return null
  }
  const gates = await Promise.all(others.map((l) => reader.gate(block, l.listingId, 0n)))
  const live = others.filter((l, i) => gates[i]?.listingState === V2_STATE.listing.ACTIVE && Number(block.timestamp) < l.expiry)
  if (onChain !== null || live.length > 0) {
    listingsOfCard.set(tag, live)
    return onChain ?? 'card_listed_twice'
  }
  listingsOfCard.set(tag, [mine])
  return null
}

/** Tests only: forget every card tag. */
export function __clearTicketedCardsV2ForTests(): void {
  listingsOfCard.clear()
}
