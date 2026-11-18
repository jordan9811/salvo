/**
 * SalvoEscrowV1 reads for the runbook scripts, at one block both pinned hosts
 * agree on (rpc.ts). Typed against the committed ABI, so a read that drifts
 * from the contract fails to compile instead of decoding the wrong word.
 *
 * These are the reads the scripts gate on: what code sits at the escrow, who
 * its signer and token are, what a listing and a deposit hold, and what the
 * token says a balance is. Nothing here writes; nothing here holds a key.
 *
 * Server and scripts only (artifact.ts is large and Node-side by use).
 */

import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  type DecodeEventLogReturnType,
  type Hex,
} from 'viem'
import { ESCROW_ABI } from '../artifact'
import { UNITS_PER_CENT } from '../manifest'
import { MODE_BLIND } from '../merchants'
import { callAt, codeAt, type AgreedBlock, type ChainReceipt, type HostsConfig } from './rpc'

const lower = (a: string): Hex => a.toLowerCase() as Hex

export interface EscrowFacts {
  /** keccak256 of the runtime code at the escrow address. keccak256("0x") when nothing is there. */
  codehash: Hex
  codeBytes: number
  litSigner: Hex
  token: Hex
  depositCount: bigint
}

/**
 * The four facts a deploy and a check are judged on, read at `block` on both
 * hosts. With no code at `escrow` the views are not called (they would revert
 * or read zeros) and the signer and token come back as the zero address.
 */
export async function escrowFactsAt(cfg: HostsConfig, block: AgreedBlock, escrow: Hex): Promise<EscrowFacts> {
  const code = await codeAt(cfg, block, escrow)
  const zero: Hex = '0x0000000000000000000000000000000000000000'
  if (code === '0x') return { codehash: keccak256('0x'), codeBytes: 0, litSigner: zero, token: zero, depositCount: 0n }
  const view = async (functionName: 'litSigner' | 'token' | 'depositCount'): Promise<Hex> =>
    callAt(cfg, block, { to: escrow, data: encodeFunctionData({ abi: ESCROW_ABI, functionName }) })
  const litSigner = decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'litSigner', data: await view('litSigner') })
  const token = decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'token', data: await view('token') })
  const depositCount = decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'depositCount', data: await view('depositCount') })
  return {
    codehash: keccak256(code),
    codeBytes: (code.length - 2) / 2,
    litSigner: lower(litSigner),
    token: lower(token),
    depositCount,
  }
}

export interface GateView {
  signer: Hex
  token: Hex
  listingSeller: Hex
  listingState: number
  depositState: number
  depositListingId: Hex
  replyKeyHash: Hex
  depositor: Hex
}

/** The template's one read, `gate(listingId, depositId)`, as a phone or a script makes it. */
export async function gateAt(cfg: HostsConfig, block: AgreedBlock, escrow: Hex, listingId: Hex, depositId: bigint): Promise<GateView> {
  const data = await callAt(cfg, block, {
    to: escrow,
    data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'gate', args: [listingId, depositId] }),
  })
  const [signer, token, listingSeller, listingState, depositState, depositListingId, replyKeyHash, depositor] =
    decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'gate', data })
  return {
    signer: lower(signer),
    token: lower(token),
    listingSeller: lower(listingSeller),
    listingState,
    depositState,
    depositListingId: lower(depositListingId),
    replyKeyHash: lower(replyKeyHash),
    depositor: lower(depositor),
  }
}

export interface DepositView {
  depositor: Hex
  openedAt: number
  releaseAt: number
  state: number
  disputed: boolean
  seller: Hex
  amount: bigint
  listingId: Hex
  replyKeyHash: Hex
  cardTag: Hex
}

/** `getDeposit(id)`. The state comes from here, never from an event's name (spec section 12). */
export async function depositAt(cfg: HostsConfig, block: AgreedBlock, escrow: Hex, id: bigint): Promise<DepositView> {
  const data = await callAt(cfg, block, {
    to: escrow,
    data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'getDeposit', args: [id] }),
  })
  const d = decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'getDeposit', data })
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
  }
}

/**
 * The deposit that bought each of `listingIds`, read back from the newest
 * deposit, at most `limit` deep. A listing sells once, so its one deposit is
 * the one naming it. Stops as soon as all are found. A listing missing from
 * the answer was not bought in the deposits read: older, or not bought.
 *
 * There is no event index to ask (the hosts serve no logs to us), and deposit
 * ids run 1..depositCount with no gaps, so this is how a phone or a seller's
 * page finds a sale it did not see happen. Reads in steps of ten.
 */
export async function depositsForListings(
  cfg: HostsConfig,
  block: AgreedBlock,
  escrow: Hex,
  listingIds: ReadonlySet<Hex>,
  limit: number,
): Promise<Map<Hex, { id: bigint; deposit: DepositView }>> {
  const found = new Map<Hex, { id: bigint; deposit: DepositView }>()
  if (listingIds.size === 0) return found
  const count = await depositCountAt(cfg, block, escrow)
  const floor = count > BigInt(limit) ? count - BigInt(limit) : 0n
  for (let top = count; top > floor && found.size < listingIds.size; top -= 10n) {
    const ids: bigint[] = []
    for (let id = top; id > floor && id > top - 10n; id--) ids.push(id)
    const deposits = await Promise.all(ids.map((id) => depositAt(cfg, block, escrow, id)))
    for (const [i, deposit] of deposits.entries()) {
      if (listingIds.has(deposit.listingId) && !found.has(deposit.listingId)) found.set(deposit.listingId, { id: ids[i] as bigint, deposit })
    }
  }
  return found
}

async function depositCountAt(cfg: HostsConfig, block: AgreedBlock, escrow: Hex): Promise<bigint> {
  return decodeFunctionResult({
    abi: ESCROW_ABI,
    functionName: 'depositCount',
    data: await callAt(cfg, block, { to: escrow, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'depositCount' }) }),
  })
}

/**
 * The deposit that bought each of `listingIds`, among the deposits opened
 * from `from` to `to` (chain seconds, both included). However many deposits
 * came after, this finds them: no fixed depth.
 *
 * WHY A WINDOW. A phone that lost track of its own purchase still knows when
 * it can have landed: depositAndOpen takes a ticket only while
 * block.timestamp <= notAfter <= block.timestamp + the ticket's longest life,
 * so the deposit was opened in [notAfter - that life, notAfter]. A deposit's
 * openedAt is its block's time and ids run 1..depositCount with no gaps, so
 * openedAt never falls as the id rises. A binary search finds the first id
 * opened at `from` or later, and the walk stops past `to`: about
 * log2(depositCount) reads plus the deposits inside the window.
 */
export async function depositsOpenedBetween(
  cfg: HostsConfig,
  block: AgreedBlock,
  escrow: Hex,
  listingIds: ReadonlySet<Hex>,
  from: number,
  to: number,
): Promise<Map<Hex, { id: bigint; deposit: DepositView }>> {
  const found = new Map<Hex, { id: bigint; deposit: DepositView }>()
  if (listingIds.size === 0 || to < from) return found
  const count = await depositCountAt(cfg, block, escrow)
  // The first id opened at `from` or later; count + 1 when there is none.
  let lo = 1n
  let hi = count + 1n
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    if ((await depositAt(cfg, block, escrow, mid)).openedAt < from) lo = mid + 1n
    else hi = mid
  }
  for (let start = lo; start <= count && found.size < listingIds.size; start += 10n) {
    const ids: bigint[] = []
    for (let id = start; id <= count && id < start + 10n; id++) ids.push(id)
    const deposits = await Promise.all(ids.map((id) => depositAt(cfg, block, escrow, id)))
    let past = false
    for (const [i, deposit] of deposits.entries()) {
      if (deposit.openedAt > to) {
        past = true
        break
      }
      if (listingIds.has(deposit.listingId) && !found.has(deposit.listingId)) found.set(deposit.listingId, { id: ids[i] as bigint, deposit })
    }
    if (past) break
  }
  return found
}

/** `owed(who)`: payouts the token would not send to `who`, which `claim(who)` sends again. */
export async function owedAt(cfg: HostsConfig, block: AgreedBlock, escrow: Hex, who: Hex): Promise<bigint> {
  const data = await callAt(cfg, block, {
    to: escrow,
    data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'owed', args: [who] }),
  })
  return decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'owed', data })
}

/** `sellerStats(seller)`: sold, disputes, refunds, and the token units release() has paid this seller. */
export async function sellerStatsAt(
  cfg: HostsConfig,
  block: AgreedBlock,
  escrow: Hex,
  seller: Hex,
): Promise<{ sold: number; disputes: number; refunds: number; paidOut: bigint }> {
  const data = await callAt(cfg, block, {
    to: escrow,
    data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'sellerStats', args: [seller] }),
  })
  const [sold, disputes, refunds, paidOut] = decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'sellerStats', data })
  return { sold, disputes, refunds, paidOut }
}

/** SalvoEscrowV1's NEW_SELLER_BLIND_CAP_CENTS: a blind card above it needs that much already paid out to its seller. */
export const NEW_SELLER_BLIND_CAP_CENTS = 2_500
/** SalvoEscrowV1.DEPOSIT_RELEASED. */
const DEPOSIT_RELEASED = 2
const ZERO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000'

/**
 * Why the escrow would refuse to sell this card by this seller right now, or
 * null when it would not. The contract's own rules from `_checkTicket` and
 * `_checkTerms`, read for free at `block`:
 *   - `card_not_sellers`: the card's current owner (`cardOwner`, keyed by the
 *     card tag Lit put in the ticket) is someone else. The same card listed
 *     twice, once the other listing sold.
 *   - `card_not_paid_out`: the purchase that made the seller its owner is not
 *     paid out yet, so its own seller may still refund it.
 *   - `new_seller_cap`: a blind card over $25 from a seller whose finished
 *     sales have not yet paid them its value.
 *
 * WHY ANYONE OFF CHAIN ASKS. The template's ticket reads only `gate()`, which
 * holds none of these, so Lit signs a ticket for a card the contract will
 * refuse. Only the contract enforces them. A ticket for such a card buys a
 * batch that can only revert, and a listing nobody marks is quoted again and
 * again. So our ticket route and the shopper's phone both ask, after the
 * ticket names the card's tag.
 */
export async function cardSaleRefusalAt(
  cfg: HostsConfig,
  block: AgreedBlock,
  escrow: Hex,
  sale: { cardTag: Hex; seller: Hex; mode: number; valueCents: number },
): Promise<'card_not_sellers' | 'card_not_paid_out' | 'new_seller_cap' | null> {
  const view = async (functionName: 'cardOwner' | 'cardDeposit'): Promise<Hex> =>
    callAt(cfg, block, { to: escrow, data: encodeFunctionData({ abi: ESCROW_ABI, functionName, args: [sale.cardTag] }) })
  const owner = lower(decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'cardOwner', data: await view('cardOwner') }))
  if (owner !== ZERO_ADDRESS && owner !== lower(sale.seller)) return 'card_not_sellers'
  const boughtIn = decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'cardDeposit', data: await view('cardDeposit') })
  if (boughtIn !== 0n && (await depositAt(cfg, block, escrow, boughtIn)).state !== DEPOSIT_RELEASED) return 'card_not_paid_out'
  if (sale.mode === MODE_BLIND && sale.valueCents > NEW_SELLER_BLIND_CAP_CENTS) {
    const { paidOut } = await sellerStatsAt(cfg, block, escrow, lower(sale.seller))
    if (paidOut < BigInt(sale.valueCents) * BigInt(UNITS_PER_CENT)) return 'new_seller_cap'
  }
  return null
}

/** A TIP-20 balance in base units (6 decimals for pathUSD). */
export async function tokenBalanceAt(cfg: HostsConfig, block: AgreedBlock, token: Hex, who: Hex): Promise<bigint> {
  const data = await callAt(cfg, block, {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
  })
  return decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data })
}

/** A token's `decimals()`. The escrow's constructor refuses anything but 6. */
export async function tokenDecimalsAt(cfg: HostsConfig, block: AgreedBlock, token: Hex): Promise<number> {
  const data = await callAt(cfg, block, { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' }) })
  return decodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', data })
}

type EscrowEventName = 'Listed' | 'ListingCancelled' | 'Opened' | 'Disputed' | 'Released' | 'Refunded' | 'Owed' | 'Claimed' | 'Rekeyed'
export type EscrowEventArgs<N extends EscrowEventName> = DecodeEventLogReturnType<typeof ESCROW_ABI, N>['args']

/**
 * The escrow's events of one name in a receipt, decoded. Logs from any other
 * address are skipped, so a token's Transfer can never pass for an escrow event.
 */
export function escrowEvents<N extends EscrowEventName>(receipt: ChainReceipt, escrow: Hex, name: N): EscrowEventArgs<N>[] {
  const out: EscrowEventArgs<N>[] = []
  for (const log of receipt.logs) {
    if (log.address !== lower(escrow) || log.topics.length === 0) continue
    try {
      const ev = decodeEventLog({ abi: ESCROW_ABI, eventName: name, topics: log.topics as [Hex, ...Hex[]], data: log.data })
      out.push(ev.args as EscrowEventArgs<N>)
    } catch {
      // Another of the escrow's events, or not one at all: skip it.
    }
  }
  return out
}
