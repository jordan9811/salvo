/**
 * How each store's online checkout treats its own gift cards, as far as the
 * agent endpoint needs to know. Every value names where it came from.
 *
 *   locksToAccount   Adding a card online ties it to that store account for
 *                    good (Target: "This gift card is connected to someone
 *                    else's account"). A leftover then stays spendable by that
 *                    account, so part of a card can't be sold into a buyer's
 *                    own account: the buyer would keep the rest.
 *   amountControl    'exact': the checkout lets the payer set what each card
 *                    covers (Target's "Edit amount"). 'automatic': the store
 *                    applies each card's balance up to what is due, so the last
 *                    card is part used by arithmetic. 'unknown': not seen.
 *   maxCardsPerOrder How many gift cards one order takes.
 *
 * A store that is not listed gets the most careful answer: treated as locking,
 * one card, amounts unknown. So nothing partial is ever sold at a store whose
 * rules nobody has checked.
 */

export type AmountControl = 'exact' | 'automatic' | 'unknown'

export interface StoreCheckoutPolicy {
  merchantId: string
  locksToAccount: boolean
  amountControl: AmountControl
  maxCardsPerOrder: number
  /** Where the facts came from. */
  source: string
}

const POLICIES: Readonly<Record<string, Omit<StoreCheckoutPolicy, 'merchantId'>>> = {
  target: {
    locksToAccount: true,
    amountControl: 'exact',
    maxCardsPerOrder: 10,
    source: 'own spike 2026-11-04/05 (TARGET_ONLINE_STATUS.md); Target help article 000082207',
  },
  bestbuy: {
    locksToAccount: false,
    amountControl: 'automatic',
    maxCardsPerOrder: 10,
    source: 'store map 2026-11-05 (public pages): number and PIN at checkout, leftover stays on the card',
  },
  nike: {
    locksToAccount: false,
    amountControl: 'automatic',
    maxCardsPerOrder: 10,
    source: 'store map 2026-11-05 (public pages): entered at checkout on the web, balance applied to the total',
  },
}

const UNKNOWN: Omit<StoreCheckoutPolicy, 'merchantId'> = {
  locksToAccount: true,
  amountControl: 'unknown',
  maxCardsPerOrder: 1,
  source: 'not checked: treated as locking, one card',
}

export function storePolicy(merchantId: string): StoreCheckoutPolicy {
  const id = merchantId.toLowerCase().trim()
  return { merchantId: id, ...(POLICIES[id] ?? UNKNOWN) }
}

/**
 * Can part of a card be sold to an agent that checks out in the BUYER'S own
 * account? Only where the card does not lock to that account (the leftover
 * must stay sellable) and the store's amount rule is known.
 */
export function partialInBuyerAccount(p: StoreCheckoutPolicy): boolean {
  return !p.locksToAccount && p.amountControl !== 'unknown'
}

/**
 * Can part of a card be used when SALVO'S own account checks out? Only where
 * the checkout lets the payer set each card's amount: the leftover then stays
 * on a card held in Salvo's account.
 */
export function partialInSalvoAccount(p: StoreCheckoutPolicy): boolean {
  return p.amountControl === 'exact'
}
