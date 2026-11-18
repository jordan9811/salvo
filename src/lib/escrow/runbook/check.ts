/**
 * escrow:check's logic: free reads on both pinned hosts that say whether the
 * pinned escrow is the honest deployment (spec section 15 step 9, custody
 * review condition 2).
 *
 * It checks what the template cannot. The template pins the escrow's address
 * and code hash and reads `litSigner` and `token` live, but a code hash covers
 * code, not storage, and storage can only be proven clean from the creation
 * transaction. So this reads, at one block both hosts agree on: the code hash
 * at the pinned address, `litSigner()` against the pinned identity, `token()`
 * against pathUSD and its 6 decimals, and then the pinned creation
 * transaction and its receipt from both hosts through verifyEscrowCreation.
 * Anyone can re-run it from public chain data.
 *
 * The same reads for either escrow: SalvoEscrowV2 keeps V1's litSigner(),
 * token() and depositCount() views and its two constructor arguments, so only
 * the compiled bytecode and code hash differ, and the template's release
 * names them (versions.ts).
 *
 * Reads only. Never a key, never a write.
 */

import type { Hex } from 'viem'
import { templateIntegrity } from '@/lib/vault/lit/templates'
import { escrowPinProblems, verifyEscrowCreation, type EscrowCreationProblem } from '../deployment'
import { PATH_USD } from '../manifest'
import { pinProblemWords } from './deploy'
import { escrowFactsAt, tokenDecimalsAt } from './reads'
import { EscrowRpcError, agreedFinalizedBlock, transactionOnBothHosts, type HostsConfig } from './rpc'
import { releaseOf, type AnyEscrowTemplate } from './versions'

export interface CheckReport {
  ok: boolean
  escrow: Hex | null
  block: string | null
  pins: {
    templateIntact: boolean
    /** The template pins the compiled escrow's code hash. */
    codehashIsCompiled: boolean
    escrow: boolean
    identity: boolean
    creationTx: boolean
  }
  code: { present: boolean; codehashMatches: boolean; bytes: number } | null
  litSignerMatches: boolean | null
  tokenIsPathUsd: boolean | null
  tokenDecimals: number | null
  /** Null until the creation is pinned. Empty means it is the plain compiled create. */
  creationProblems: EscrowCreationProblem[] | null
  /** Every reason `ok` is false, in words. */
  problems: string[]
}

/** Check the pinned escrow. Never throws for a chain answer: a host that fails or disagrees is a problem in the report. */
export async function checkPinnedEscrow(hosts: HostsConfig, t: AnyEscrowTemplate): Promise<CheckReport> {
  const release = releaseOf(t)
  const pinProblems = escrowPinProblems(t)
  const report: CheckReport = {
    ok: false,
    escrow: t.escrowAddress,
    block: null,
    pins: {
      templateIntact: templateIntegrity(t).intact,
      codehashIsCompiled: t.escrowCodehash === release.runtimeKeccak,
      escrow: pinProblems.length === 0,
      identity: t.identity !== null,
      creationTx: t.escrowCreationTx !== null,
    },
    code: null,
    litSignerMatches: null,
    tokenIsPathUsd: null,
    tokenDecimals: null,
    creationProblems: null,
    problems: [],
  }
  const problems = report.problems
  if (!report.pins.templateIntact) problems.push('the escrow template no longer matches its pinned sha256 and CID')
  if (!report.pins.codehashIsCompiled) problems.push("the template pins a code hash other than the compiled escrow's")
  for (const p of pinProblems) problems.push(pinProblemWords(p, t.id))
  if (!report.pins.identity) problems.push("the template's identity is not pinned, so the escrow's signer cannot be checked")
  if (!report.pins.creationTx) problems.push("the escrow's creation transaction is not pinned, so its starting storage cannot be checked")
  const escrow = t.escrowAddress
  if (!report.pins.escrow || escrow === null) {
    // Nothing usable is pinned, so there is nothing to read.
    return report
  }

  try {
    const block = await agreedFinalizedBlock(hosts)
    report.block = block.number.toString()
    const facts = await escrowFactsAt(hosts, block, escrow)
    report.code = { present: facts.codeBytes > 0, codehashMatches: facts.codehash === t.escrowCodehash, bytes: facts.codeBytes }
    if (!report.code.present) problems.push('there is no contract at the pinned escrow address')
    else if (!report.code.codehashMatches) problems.push("the code at the escrow address is not the compiled escrow's")
    if (report.code.present) {
      report.litSignerMatches = t.identity !== null && facts.litSigner === t.identity
      if (t.identity !== null && !report.litSignerMatches) problems.push("the escrow's litSigner is not the template's identity")
      report.tokenIsPathUsd = facts.token === PATH_USD
      if (!report.tokenIsPathUsd) problems.push("the escrow's token is not pathUSD")
    }
    report.tokenDecimals = await tokenDecimalsAt(hosts, block, PATH_USD)
    if (report.tokenDecimals !== 6) problems.push('pathUSD does not report 6 decimals')

    const creationTx = t.escrowCreationTx
    if (creationTx !== null && t.escrowDeployer !== null && t.identity !== null) {
      const both = await transactionOnBothHosts(hosts, creationTx)
      if (both === null) {
        report.creationProblems = ['creation_tx']
        problems.push('the pinned creation transaction is not on both hosts')
      } else {
        report.creationProblems = verifyEscrowCreation(both.tx, both.receipt, {
          escrow,
          deployer: t.escrowDeployer,
          litSigner: t.identity,
          token: PATH_USD,
          creationTx,
          bytecode: release.bytecode,
        })
        if (report.creationProblems.length > 0) {
          problems.push(`the creation transaction is not the plain compiled create: ${report.creationProblems.join(', ')}`)
        }
      }
    }
  } catch (err) {
    if (!(err instanceof EscrowRpcError)) throw err
    problems.push(`a read failed: ${err.message}`)
  }
  report.ok = problems.length === 0
  return report
}
