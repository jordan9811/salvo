/**
 * SalvoEscrowV2 as our server reads it, at one finalized block both pinned
 * hosts agree on: the gate's eleven words, a sale's use and deposit, a
 * listing's leftover, the card rules, and the counters routing reads.
 *
 * The same rules as V1's reader (chain.ts), for the same reasons: every read
 * goes to both hosts at the lower finalized head, a disagreement is an error
 * the caller retries, and nothing here signs, holds a key or chooses a payee.
 * The contract pays only a sale's seller or the address that paid in, and the
 * keeper only ever asks it to (keeper-v2.ts).
 *
 * Built on the runbook's V2 reads (runbook/reads-v2.ts), so the scripts, the
 * phone and the server read V2 the same way.
 *
 * Server-only. Makes a network call only when a method is called.
 */

import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'
import { ESCROW_V2_ABI } from './artifact-v2'
import { escrowV2Configured } from './config-v2'
import {
  buyerShortfallsV2At,
  cardSaleRefusalV2At,
  depositCountV2At,
  depositV2At,
  gateV2At,
  listingV2At,
  owedV2At,
  sellerStatsV2At,
  type CardSaleRefusalV2,
  type DepositViewV2,
  type GateViewV2,
  type ListingViewV2,
  type SellerStatsV2,
} from './runbook/reads-v2'
import { agreedFinalizedBlock, callOnHost, type AgreedBlock, type HostsConfig } from './runbook/rpc'
import { escrowRuntime, templateV2Of, type EscrowRuntime } from './runtime'

export class SalvoEscrowV2Reader {
  readonly escrow: Hex
  readonly hosts: HostsConfig

  constructor(escrow: Hex, hosts: HostsConfig) {
    this.escrow = escrow
    this.hosts = hosts
  }

  /** The block every read is made at: both hosts on chain 42431, the lower finalized head, same hash and time. */
  block(): Promise<AgreedBlock> {
    return agreedFinalizedBlock(this.hosts)
  }

  /** The template's one read: V1's eight words, then the value left, the sales count and the deposit covering the leftover. */
  gate(at: AgreedBlock, listingId: Hex, depositId: bigint): Promise<GateViewV2> {
    return gateV2At(this.hosts, at, this.escrow, listingId, depositId)
  }

  /** `getDeposit(id)`: one sale. Every bookkeeping decision takes its state from here, never from an event's name. */
  deposit(at: AgreedBlock, id: bigint): Promise<DepositViewV2> {
    return depositV2At(this.hosts, at, this.escrow, id)
  }

  /** `getListing(id)`: the value left, the deposit covering it, and the latest sale. */
  listing(at: AgreedBlock, listingId: Hex): Promise<ListingViewV2> {
    return listingV2At(this.hosts, at, this.escrow, listingId)
  }

  /** How many sales exist. Ids run 1..depositCount with no gaps, so this is how new ones are found. */
  depositCount(at: AgreedBlock): Promise<bigint> {
    return depositCountV2At(this.hosts, at, this.escrow)
  }

  /** The count as host `index` alone reports it at block `tag`: decides nothing on its own (lit-escrow.ts ReleaseChecks). */
  async depositCountOn(index: number, tag: Hex): Promise<bigint> {
    const data = await callOnHost(this.hosts, index, tag, { to: this.escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'depositCount' }) })
    return decodeFunctionResult({ abi: ESCROW_V2_ABI, functionName: 'depositCount', data })
  }

  /** Why the contract would refuse to sell this card on this listing now, or null (reads-v2.ts). */
  cardSaleRefusal(
    at: AgreedBlock,
    sale: { cardTag: Hex; seller: Hex; listingId: Hex; sales: number; mode: number; valueCents: number },
  ): Promise<CardSaleRefusalV2 | null> {
    return cardSaleRefusalV2At(this.hosts, at, this.escrow, sale)
  }

  /** The seller's six public counters: paid out, disputes, refunds, leftovers found short, deposits claimed. */
  sellerStats(at: AgreedBlock, seller: Hex): Promise<SellerStatsV2> {
    return sellerStatsV2At(this.hosts, at, this.escrow, seller)
  }

  /** Leftovers this buyer left that were found short, ever. The 30-day rule is ours (standing.ts). */
  buyerShortfalls(at: AgreedBlock, buyer: Hex): Promise<number> {
    return buyerShortfallsV2At(this.hosts, at, this.escrow, buyer)
  }

  /** Token units a payout to `who` was refused and is waiting for `claim(who)`. */
  owed(at: AgreedBlock, who: Hex): Promise<bigint> {
    return owedV2At(this.hosts, at, this.escrow, who)
  }
}

/**
 * The reader for the V2 escrow the runtime's template pins, or null until V2
 * is configured (config-v2.ts): reading an escrow the template does not yet
 * trust would only record sales that can never open.
 */
export function escrowReaderV2(rt: EscrowRuntime = escrowRuntime()): SalvoEscrowV2Reader | null {
  const t = templateV2Of(rt)
  if (!escrowV2Configured(rt) || t.escrowAddress === null) return null
  return new SalvoEscrowV2Reader(t.escrowAddress, rt.hosts)
}
