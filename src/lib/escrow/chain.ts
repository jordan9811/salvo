/**
 * SalvoEscrowV1 as our server reads it: `gate`, `getDeposit`, `depositCount`,
 * `owed`, and who may sell a card, at one finalized block both pinned hosts
 * agree on.
 *
 * WHY BOTH HOSTS, even for bookkeeping. The template opens a card only when
 * both hosts agree (spec invariant 5). A server that trusted one host could
 * record a sale the template will never honour, or miss one it will. So every
 * read here goes to both, at the lower finalized head, and a disagreement is
 * an error the caller retries next time, never a guess.
 *
 * READS ONLY. Nothing here signs, holds a key or sends a transaction. In
 * particular this never implements the chain registry's
 * `EscrowInstance.release(ref, to)` (src/lib/chains/types.ts): no caller of
 * ours may choose who an escrow pays. The contract pays only a deposit's
 * seller or depositor, and the keeper (keeper.ts) only ever asks it to.
 *
 * Built on the runbook's JSON-RPC client (runbook/rpc.ts, runbook/reads.ts),
 * so the scripts and the server read the chain the same way.
 *
 * Server-only. Makes a network call only when a method is called.
 */

import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'
import { ESCROW_ABI } from './artifact'
import { escrowPinProblems } from './deployment'
import { cardSaleRefusalAt, depositAt, gateAt, sellerStatsAt, type DepositView, type GateView } from './runbook/reads'
import { agreedFinalizedBlock, callAt, callOnHost, type AgreedBlock, type HostsConfig } from './runbook/rpc'
import { escrowRuntime, type EscrowRuntime } from './runtime'

/** The contract's listing states (SalvoEscrowV1 LISTING_*). 0 is "no such listing". */
export const LISTING_STATE = Object.freeze({ none: 0, active: 1, sold: 2, cancelled: 3 })
/** The contract's deposit states (SalvoEscrowV1 DEPOSIT_*). 0 is "no such deposit". */
export const DEPOSIT_STATE = Object.freeze({ none: 0, opened: 1, released: 2, refunded: 3 })

export class SalvoEscrowReader {
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

  /** The template's one read. Listing state and seller, deposit state, listing, reply key and depositor. */
  async gate(at: AgreedBlock, listingId: Hex, depositId: bigint): Promise<GateView> {
    return gateAt(this.hosts, at, this.escrow, listingId, depositId)
  }

  /** `getDeposit(id)`. Every bookkeeping decision takes the state from here, never from an event's name. */
  async deposit(at: AgreedBlock, id: bigint): Promise<DepositView> {
    return depositAt(this.hosts, at, this.escrow, id)
  }

  /** How many deposits exist. Ids run 1..depositCount with no gaps, so this is how new purchases are found. */
  async depositCount(at: AgreedBlock): Promise<bigint> {
    const data = await callAt(this.hosts, at, {
      to: this.escrow,
      data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'depositCount' }),
    })
    return decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'depositCount', data })
  }

  /** The count as host `index` alone reports it at block `tag`: decides nothing on its own (lit-escrow.ts ReleaseChecks). */
  async depositCountOn(index: number, tag: Hex): Promise<bigint> {
    const data = await callOnHost(this.hosts, index, tag, { to: this.escrow, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'depositCount' }) })
    return decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'depositCount', data })
  }

  /**
   * Why the contract would refuse to sell this card by this seller now
   * (reads.ts cardSaleRefusalAt): someone else owns it, its last purchase is
   * not paid out, or it is a blind card over the new-seller cap. Null when
   * it would sell. The template's ticket checks none of these.
   */
  async cardSaleRefusal(at: AgreedBlock, sale: { cardTag: Hex; seller: Hex; mode: number; valueCents: number }) {
    return cardSaleRefusalAt(this.hosts, at, this.escrow, sale)
  }

  /** Token units release() has paid `seller`, summed: what lifts the new-seller cap on blind cards. */
  async sellerPaidOut(at: AgreedBlock, seller: Hex): Promise<bigint> {
    return (await sellerStatsAt(this.hosts, at, this.escrow, seller)).paidOut
  }

  /** Token units a payout to `who` was refused and is waiting for `claim(who)`. */
  async owed(at: AgreedBlock, who: Hex): Promise<bigint> {
    const data = await callAt(this.hosts, at, {
      to: this.escrow,
      data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'owed', args: [who] }),
    })
    return decodeFunctionResult({ abi: ESCROW_ABI, functionName: 'owed', data })
  }
}

/**
 * The reader for the escrow the running template pins, or null while there is
 * none to read: no address pinned yet, or a pin the template would refuse
 * (escrowPinProblems). Reading an escrow the template does not trust would
 * only record sales that can never open.
 */
export function escrowReader(rt: EscrowRuntime = escrowRuntime()): SalvoEscrowReader | null {
  const t = rt.template
  if (t.escrowAddress === null || escrowPinProblems(t).length > 0) return null
  return new SalvoEscrowReader(t.escrowAddress, rt.hosts)
}
