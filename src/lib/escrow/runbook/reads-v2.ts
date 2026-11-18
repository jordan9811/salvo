/**
 * SalvoEscrowV2 reads for the runbook, at one block both pinned hosts agree
 * on (rpc.ts), typed against the committed V2 ABI (artifact-v2.ts), so a read
 * that drifts from the contract fails to compile instead of decoding the
 * wrong word.
 *
 * V1's reads (reads.ts) stay as they are: the escrow facts (code, litSigner,
 * token, depositCount) and token balances read the same on both escrows, and
 * the scripts use those for V2 too. What V2 adds is here: the gate's three
 * extra words (value left, sales, the deposit covering the remainder), a
 * deposit's use and bond, a listing's remainder, the seller's and buyer's
 * remainder counts, and V2's events.
 *
 * Reads only. Never a key, never a write. Server and scripts.
 */

import { decodeEventLog, decodeFunctionResult, encodeFunctionData, type DecodeEventLogReturnType, type Hex } from 'viem'
import { ESCROW_V2_ABI } from '../artifact-v2'
import { callAt, type AgreedBlock, type ChainReceipt, type HostsConfig } from './rpc'

const lower = (a: string): Hex => a.toLowerCase() as Hex

/** SalvoEscrowV2's listing and deposit states, and a deposit's bond states. */
export const V2_STATE = Object.freeze({
  listing: { ACTIVE: 1, DRAINED: 2, CANCELLED: 3, SPENT: 4 },
  deposit: { OPENED: 1, RELEASED: 2, REFUNDED: 3, CONTESTED: 4 },
  bond: { NONE: 0, HELD: 1, RETURNED: 2, FORFEITED: 3 },
})

export interface GateViewV2 {
  signer: Hex
  token: Hex
  listingSeller: Hex
  listingState: number
  depositState: number
  depositListingId: Hex
  replyKeyHash: Hex
  depositor: Hex
  /** The value left on the card: 0 before the first sale (the terms' valueCents then). */
  remainingCents: number
  sales: number
  /** The deposit whose bond covers what is left; 0 if none. */
  bondDeposit: bigint
}

/** The template's one read, `gate(listingId, depositId)`: V1's eight words and V2's three. */
export async function gateV2At(cfg: HostsConfig, block: AgreedBlock, escrow: Hex, listingId: Hex, depositId: bigint): Promise<GateViewV2> {
  const data = await callAt(cfg, block, { to: escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'gate', args: [listingId, depositId] }) })
  const g = decodeFunctionResult({ abi: ESCROW_V2_ABI, functionName: 'gate', data })
  return {
    signer: lower(g[0]),
    token: lower(g[1]),
    listingSeller: lower(g[2]),
    listingState: g[3],
    depositState: g[4],
    depositListingId: lower(g[5]),
    replyKeyHash: lower(g[6]),
    depositor: lower(g[7]),
    remainingCents: g[8],
    sales: g[9],
    bondDeposit: g[10],
  }
}

export interface DepositViewV2 {
  depositor: Hex
  openedAt: number
  releaseAt: number
  state: number
  disputed: boolean
  seller: Hex
  /** Token units the seller is paid for the cents used, while the sale is Opened. */
  amount: bigint
  listingId: Hex
  replyKeyHash: Hex
  cardTag: Hex
  usedCents: number
  leftAfterCents: number
  saleIndex: number
  /** Token units deposited at face for the cents left, while held. */
  bond: bigint
  bondState: number
  /** The deposit whose bond this sale covered; 0 if none. */
  covers: bigint
  /** Until when this sale may be contested; 0 for a sale that covered no one else's bond. */
  contestUntil: number
}

/** `getDeposit(id)`. The state comes from here, never from an event's name. */
export async function depositV2At(cfg: HostsConfig, block: AgreedBlock, escrow: Hex, id: bigint): Promise<DepositViewV2> {
  const data = await callAt(cfg, block, { to: escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'getDeposit', args: [id] }) })
  const d = decodeFunctionResult({ abi: ESCROW_V2_ABI, functionName: 'getDeposit', data })
  return {
    depositor: lower(d.depositor),
    openedAt: Number(d.openedAt),
    releaseAt: Number(d.releaseAt),
    state: d.state,
    disputed: d.disputed,
    seller: lower(d.seller),
    amount: d.amount,
    listingId: lower(d.listingId),
    replyKeyHash: lower(d.replyKeyHash),
    cardTag: lower(d.cardTag),
    usedCents: d.usedCents,
    leftAfterCents: d.leftAfterCents,
    saleIndex: d.saleIndex,
    bond: d.bond,
    bondState: d.bondState,
    covers: d.covers,
    contestUntil: Number(d.contestUntil),
  }
}

export interface ListingViewV2 {
  seller: Hex
  state: number
  createdAt: number
  remainingCents: number
  sales: number
  bondDeposit: bigint
  bondSince: number
  confirmedAt: number
  lastDeposit: bigint
  mode: number
}

/** `getListing(listingId)`. */
export async function listingV2At(cfg: HostsConfig, block: AgreedBlock, escrow: Hex, listingId: Hex): Promise<ListingViewV2> {
  const data = await callAt(cfg, block, { to: escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'getListing', args: [listingId] }) })
  const l = decodeFunctionResult({ abi: ESCROW_V2_ABI, functionName: 'getListing', data })
  return {
    seller: lower(l.seller),
    state: l.state,
    createdAt: Number(l.createdAt),
    remainingCents: l.remainingCents,
    sales: l.sales,
    bondDeposit: l.bondDeposit,
    bondSince: Number(l.bondSince),
    confirmedAt: Number(l.confirmedAt),
    lastDeposit: l.lastDeposit,
    mode: l.mode,
  }
}

export interface SellerStatsV2 {
  sold: number
  disputes: number
  refunds: number
  paidOut: bigint
  /** Remainders found short: contested, or a confirm read below what was left. */
  remaindersShort: number
  /** Deposits the seller took by saying the remainder was spent. */
  bondsClaimed: number
}

/** `sellerStats(seller)`, V2's six counters. */
export async function sellerStatsV2At(cfg: HostsConfig, block: AgreedBlock, escrow: Hex, seller: Hex): Promise<SellerStatsV2> {
  const data = await callAt(cfg, block, { to: escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'sellerStats', args: [seller] }) })
  const [sold, disputes, refunds, paidOut, remaindersShort, bondsClaimed] = decodeFunctionResult({
    abi: ESCROW_V2_ABI,
    functionName: 'sellerStats',
    data,
  })
  return { sold, disputes, refunds, paidOut, remaindersShort, bondsClaimed }
}

/** `buyerShortfalls(buyer)`: remainders this buyer left that were found short. */
export async function buyerShortfallsV2At(cfg: HostsConfig, block: AgreedBlock, escrow: Hex, buyer: Hex): Promise<number> {
  const data = await callAt(cfg, block, { to: escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'buyerShortfalls', args: [buyer] }) })
  return decodeFunctionResult({ abi: ESCROW_V2_ABI, functionName: 'buyerShortfalls', data })
}

/** SalvoEscrowV2's NEW_SELLER_BLIND_CAP_CENTS, the same $25 as V1's. */
const NEW_SELLER_BLIND_CAP_CENTS_V2 = 2_500
const UNITS_PER_CENT_V2 = 10_000n
const ZERO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000'
const ZERO32: Hex = `0x${'0'.repeat(64)}`

export type CardSaleRefusalV2 = 'card_not_sellers' | 'card_not_paid_out' | 'card_listed' | 'new_seller_cap'

/**
 * Why SalvoEscrowV2 would refuse to sell this card on this listing now, or
 * null when it would not: `_checkTicket`'s card rules and `_checkTerms`'s
 * new-seller cap, read for free at `block`.
 *   - `card_not_sellers`: the card's owner (`cardOwner`, by the V2 tag Lit
 *     put in the ticket) is someone else: a buyer drained it.
 *   - `card_not_paid_out`: the purchase that made the seller its owner is
 *     not paid out yet.
 *   - `card_listed`: one live listing per physical card. A first sale needs
 *     no other listing holding a leftover of the card; a leftover is sold
 *     only under the listing it began with.
 *   - `new_seller_cap`: a blind card over $25 from a seller V2 has not yet
 *     paid at least its value. V2 keeps its own paidOut, so V1's sales do not
 *     lift it.
 *
 * As for V1 (reads.ts cardSaleRefusalAt), the template's ticket reads only
 * gate(), so our ticket route and the shopper's phone ask this once the
 * ticket names the card's tag.
 *
 * ONE ROUND. Every read a rule can need is asked at once, then the rules are
 * judged in the order above; only a card bought through the escrow before
 * needs a second read, its last sale. The shopper's phone makes this check
 * after the tickets come back, while the tap may be waiting on it.
 */
export async function cardSaleRefusalV2At(
  cfg: HostsConfig,
  block: AgreedBlock,
  escrow: Hex,
  sale: { cardTag: Hex; seller: Hex; listingId: Hex; sales: number; mode: number; valueCents: number },
): Promise<CardSaleRefusalV2 | null> {
  const view = async (functionName: 'cardOwner' | 'cardDeposit' | 'cardListing'): Promise<Hex> =>
    callAt(cfg, block, { to: escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName, args: [sale.cardTag] }) })
  const capped = sale.mode === 2 && sale.valueCents > NEW_SELLER_BLIND_CAP_CENTS_V2
  const [ownerData, boughtData, liveData, stats] = await Promise.all([
    view('cardOwner'),
    view('cardDeposit'),
    view('cardListing'),
    capped ? sellerStatsV2At(cfg, block, escrow, lower(sale.seller)) : Promise.resolve(null),
  ])
  const owner = lower(decodeFunctionResult({ abi: ESCROW_V2_ABI, functionName: 'cardOwner', data: ownerData }))
  if (owner !== ZERO_ADDRESS && owner !== lower(sale.seller)) return 'card_not_sellers'
  const boughtIn = decodeFunctionResult({ abi: ESCROW_V2_ABI, functionName: 'cardDeposit', data: boughtData })
  if (boughtIn !== 0n && (await depositV2At(cfg, block, escrow, boughtIn)).state !== V2_STATE.deposit.RELEASED) return 'card_not_paid_out'
  const live = lower(decodeFunctionResult({ abi: ESCROW_V2_ABI, functionName: 'cardListing', data: liveData }))
  if (sale.sales === 0 ? live !== ZERO32 : live !== lower(sale.listingId)) return 'card_listed'
  if (stats !== null && stats.paidOut < BigInt(sale.valueCents) * UNITS_PER_CENT_V2) return 'new_seller_cap'
  return null
}

/** `owed(who)` on SalvoEscrowV2: payouts the token refused, which `claim(who)` sends again. */
export async function owedV2At(cfg: HostsConfig, block: AgreedBlock, escrow: Hex, who: Hex): Promise<bigint> {
  const data = await callAt(cfg, block, { to: escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'owed', args: [who] }) })
  return decodeFunctionResult({ abi: ESCROW_V2_ABI, functionName: 'owed', data })
}

/** `depositCount()` on SalvoEscrowV2. Ids run 1..depositCount with no gaps. */
export async function depositCountV2At(cfg: HostsConfig, block: AgreedBlock, escrow: Hex): Promise<bigint> {
  const data = await callAt(cfg, block, { to: escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'depositCount' }) })
  return decodeFunctionResult({ abi: ESCROW_V2_ABI, functionName: 'depositCount', data })
}

type EscrowEventNameV2 =
  | 'Listed'
  | 'ListingCancelled'
  | 'Opened'
  | 'Used'
  | 'Released'
  | 'Refunded'
  | 'Contested'
  | 'BondReturned'
  | 'BondForfeited'
export type EscrowEventArgsV2<N extends EscrowEventNameV2> = DecodeEventLogReturnType<typeof ESCROW_V2_ABI, N>['args']

/**
 * SalvoEscrowV2's events of one name in a receipt, decoded. Logs from any
 * other address are skipped, so a token's Transfer can never pass for one.
 * The decoded name is compared too: viem decodes a log by its own signature,
 * whatever `eventName` says, and one V2 purchase emits both Opened and Used.
 */
export function escrowEventsV2<N extends EscrowEventNameV2>(receipt: ChainReceipt, escrow: Hex, name: N): EscrowEventArgsV2<N>[] {
  const out: EscrowEventArgsV2<N>[] = []
  for (const log of receipt.logs) {
    if (log.address !== lower(escrow) || log.topics.length === 0) continue
    try {
      const ev = decodeEventLog({ abi: ESCROW_V2_ABI, eventName: name, topics: log.topics as [Hex, ...Hex[]], data: log.data })
      if (ev.eventName !== name) continue
      out.push(ev.args as EscrowEventArgsV2<N>)
    } catch {
      // Another of the escrow's events, or not one at all: skip it.
    }
  }
  return out
}
