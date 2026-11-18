/**
 * escrow:deploy's logic: put the escrow at the address the template pins, and
 * prove it is the honest deployment (spec section 5, section 15 steps 2, 3
 * and 8). SalvoEscrowV1 for salvo-vault-escrow/1, SalvoEscrowV2 for
 * salvo-vault-escrow/2: the same steps, with the bytecode and code hash the
 * template's release names (versions.ts).
 *
 * THE ONE MISTAKE THAT COSTS A RESTART. The template trusts one address: the
 * deployer's nonce-0 CREATE address. Any transaction from the deployer before
 * the deploy, a deploy from any other key, or a deploy that reverts or runs
 * out of gas, uses up nonce 0 for good, and then the template, its Lit group
 * entry, the bind and the deploy all start again. So every refusal that needs
 * no network runs first (deployRefusals), the deployer is funded only by an
 * incoming faucet transfer, its `pending` nonce is read on both hosts right
 * before signing, the node's own dry run of the deploy must pass before
 * anything is sent, and the gas limit is that estimate plus 30%.
 *
 * THE CHECK AFTER. A code hash covers code, not storage, so reading the
 * deployed contract cannot prove it started clean. The deployer's nonce-0
 * transaction can: verifyEscrowCreation (deployment.ts) requires it to be a
 * plain create of the compiled bytecode with (litSigner, pathUSD), byte for
 * byte, landed at the pinned address. It runs on the transaction and receipt
 * as BOTH hosts report them, then the code hash, signer and token are read
 * back at a block both agree on.
 *
 * Two modes:
 *   - 'address-check' (step 2): a throwaway key deploys an escrow whose signer
 *     is its own address, to prove on Moderato that a plain create lands at
 *     keccak(rlp(sender, 0)) and that faucet funding leaves the nonce at 0.
 *     That escrow is never pinned.
 *   - 'pinned' (step 8): the pinned deployer deploys the real escrow, with the
 *     template's pinned identity as its signer.
 *
 * Never prints or returns a key. Network only through `hosts`.
 */

import type { Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { templateIntegrity, type EscrowTemplateId } from '@/lib/vault/lit/templates'
import {
  checkEscrowDeployPreflight,
  escrowCreateAddress,
  escrowCreationInput,
  escrowPinProblems,
  verifyEscrowCreation,
  type EscrowCreationProblem,
  type EscrowDeployProblem,
} from '../deployment'
import { PATH_USD } from '../manifest'
import { escrowFactsAt, tokenBalanceAt } from './reads'
import {
  EscrowRpcError,
  agreedFinalizedBlock,
  hostSleep,
  pendingNonces,
  requestFaucet,
  sendSigned,
  signTransaction,
  waitForFinal,
  type HostsConfig,
} from './rpc'
import { escrowRelease, pinnedSourceFor, releaseOf, type AnyEscrowTemplate } from './versions'

export type DeployMode = 'address-check' | 'pinned'

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const lower = (a: string): Hex => a.toLowerCase() as Hex

/** Plain words for each pin problem, for the lead. `R` is the template's record: ESCROW_V1 or ESCROW_V2. */
const PIN_PROBLEM_WORDS: Record<EscrowDeployProblem, string> = {
  unpinned: "the template's ESCROW line still holds the placeholder (run --print-address and pin it first)",
  pin_line: "the template does not have exactly one ESCROW line in the expected form",
  pin_not_lower_case: "the template's ESCROW pin is not lower-case hex; the template compares it as text",
  record_mismatch: "R.escrowAddress is not the template's ESCROW pin, byte for byte",
  deployer_missing: 'R.escrowDeployer is not recorded',
  not_deployer_first_address: "the ESCROW pin is not the recorded deployer's nonce-0 CREATE address",
  other_deployer: 'this key is not the pinned deployer, so its contract would land somewhere the template refuses',
  deployer_has_sent: "the deployer has already sent a transaction, so its nonce-0 address is gone for good",
}

/** The pin problem in words, naming the record of the template it is about (V1's when none is given). */
export function pinProblemWords(p: EscrowDeployProblem, id: EscrowTemplateId = 'salvo-vault-escrow/1'): string {
  return PIN_PROBLEM_WORDS[p].replace(/^R\./, `${releaseOf({ id }).record}.`)
}

/**
 * What `--print-address` prints for the pin step: the deployer's address and
 * its nonce-0 CREATE address, lower-case, and the exact template line. Pure:
 * reads nothing, sends nothing.
 */
export function escrowPinFor(deployer: Hex): { deployer: Hex; escrow: Hex; templateLine: string } {
  const d = lower(deployer)
  const escrow = escrowCreateAddress(d)
  return { deployer: d, escrow, templateLine: `const ESCROW = "${escrow}";` }
}

/** `--print-address` would print pins for bytes nobody reviewed: the template is not the one its record names. */
export class PinStepRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PinStepRefused'
  }
}

/**
 * Everything `--print-address` prints for the pin step of `t`'s release, as
 * lines: the deployer, its nonce-0 address, and each edit the lead makes,
 * byte for byte. While the committed source still holds the placeholder it
 * also gives the sha256 and CID the pinned source will have, so the lead
 * copies them rather than computing them. Pure: reads nothing, sends nothing.
 *
 * Throws PinStepRefused when the source no longer matches its committed
 * sha256 and CID: the new pins would be computed over bytes nobody reviewed,
 * and pasting them would make those bytes the frozen release. The pin step
 * changes the ESCROW line and nothing else.
 */
export function pinStepLines(t: AnyEscrowTemplate, deployer: Hex): string[] {
  const r = releaseOf(t)
  if (!templateIntegrity(t).intact) {
    throw new PinStepRefused(
      `${r.templateFile} no longer matches ${r.record}'s sha256 and CID, so no pin is printed for it. Put the file back as committed (git diff shows what changed), run pnpm verify, then print the address again.`,
    )
  }
  const p = escrowPinFor(deployer)
  const next = pinnedSourceFor(t, p.deployer)
  return [
    `deployer        : ${p.deployer}`,
    `escrow address  : ${p.escrow}  (its CREATE address at nonce 0)`,
    '',
    'Pin it (spec section 5, step 1), lower-case, byte for byte:',
    `  ${r.templateFile} : ${p.templateLine}`,
    `  src/lib/vault/lit/escrow-pins.ts (${r.pinsRecord}): escrowAddress: '${p.escrow}', escrowDeployer: '${p.deployer}'`,
    ...(next === null
      ? [
          `  then update ${r.record}.sha256 and cid in src/lib/vault/lit/templates.ts, and run pnpm verify.`,
          '  (The committed template no longer holds the placeholder, so they are not computed here.)',
        ]
      : [
          `  src/lib/vault/lit/templates.ts (${r.record}): sha256: '${next.sha256}', cid: '${next.cid}'`,
          '  (the sha256 and CID of the template with exactly that ESCROW line), then run pnpm verify.',
        ]),
    'From now until step 8 this key must send nothing at all.',
    `Next: pnpm lit:setup --check --template ${r.litTemplate}, then --apply, then pnpm lit:smoke --live --template ${r.litTemplate} --bind.`,
  ]
}

/**
 * Every reason not to deploy, decided before any network call. Empty means
 * the run may go on to its live checks (nonce, funding, preflight, dry run).
 */
export function deployRefusals(input: {
  mode: DeployMode
  deployer: Hex
  litSigner: Hex | null
  template: AnyEscrowTemplate
  /** The templates whose pinned deployers an address check must not use: `template` and every committed release. Tests pass pinned copies. */
  releases?: readonly AnyEscrowTemplate[]
}): string[] {
  const t = input.template
  const release = releaseOf(t)
  const deployer = lower(input.deployer)
  const out: string[] = []
  if (input.mode === 'address-check') {
    if (input.litSigner !== null) out.push('--lit-signer is not used with --address-check: that escrow signs with its own deployer')
    // A real deployer must never send anything before its deploy: checked
    // against every release's pinned deployer, not only the --version chosen,
    // so a forgotten flag cannot spend V2's nonce 0 on a throwaway V1.
    for (const other of input.releases ?? [t, escrowRelease(1).template, escrowRelease(2).template]) {
      if (other.escrowDeployer !== null && deployer === other.escrowDeployer) {
        out.push(`this is ${releaseOf(other).record}'s pinned deployer key; the address check needs a throwaway key, or that real deploy can never land`)
        break
      }
    }
    return out
  }
  if (!templateIntegrity(t).intact) out.push('the escrow template no longer matches its pinned sha256 and CID')
  if (t.escrowCodehash !== release.runtimeKeccak) out.push("the template pins a code hash other than the compiled escrow's (run pnpm escrow:compile)")
  for (const p of escrowPinProblems(t)) out.push(pinProblemWords(p, t.id))
  if (t.escrowDeployer !== null && deployer !== t.escrowDeployer) out.push(pinProblemWords('other_deployer', t.id))
  if (t.identity === null) {
    out.push(`the template's identity is not pinned; run pnpm lit:smoke --live --template ${release.litTemplate} --bind and pin it first`)
  }
  const signer = input.litSigner === null ? null : lower(input.litSigner)
  if (signer === null) out.push('--lit-signer <identity> is required')
  else if (!ADDRESS_RE.test(signer)) out.push('--lit-signer is not an address')
  else if (t.identity !== null && signer !== t.identity) {
    out.push("--lit-signer is not the template's pinned identity; the escrow would trust a signer Lit never uses")
  }
  if (t.escrowCreationTx !== null) out.push('an escrow creation transaction is already pinned; there is nothing to deploy')
  return out
}

export interface DeployReport {
  ok: boolean
  mode: DeployMode
  deployer: Hex
  /** Where the escrow must land: the deployer's nonce-0 CREATE address. */
  escrow: Hex
  litSigner: Hex | null
  /** Each host's pending nonce before funding, and after. Both must be 0. */
  nonceBefore: number[] | null
  nonceAfterFunding: number[] | null
  faucetTxs: number
  gasEstimate: string | null
  gasLimit: string | null
  txHash: Hex | null
  receiptStatus: 'success' | 'reverted' | null
  /** Where the receipt says the contract landed. */
  landedAt: Hex | null
  creationProblems: EscrowCreationProblem[] | null
  readback: { codehash: boolean; litSigner: boolean; token: boolean } | null
  timings: Record<string, number>
  stopped?: string
}

export interface DeployDeps {
  hosts: HostsConfig
  account: PrivateKeyAccount
  mode: DeployMode
  /** The signer the escrow will trust. Ignored (the deployer's own address) for 'address-check'. */
  litSigner: Hex | null
  /** Its release picks the bytecode: SalvoEscrowV1's for salvo-vault-escrow/1, SalvoEscrowV2's for /2. */
  template: AnyEscrowTemplate
  say: (line: string) => void
  /** Called once the transaction is signed and before it is sent, so its hash is on screen even if the answer is lost. */
  onSigned?: (hash: Hex) => void
  fundTimeoutMs?: number
  finalTimeoutMs?: number
}

class DeployStop extends Error {}

/**
 * Run the deploy. Never throws for a chain answer: every stop is in the
 * report's `stopped`, in words that say what to do next.
 */
export async function deployEscrowLive(deps: DeployDeps): Promise<DeployReport> {
  const now = deps.hosts.now ?? Date.now
  const release = releaseOf(deps.template)
  const deployer = lower(deps.account.address)
  const escrow = escrowCreateAddress(deployer)
  const litSigner = deps.mode === 'address-check' ? deployer : deps.litSigner === null ? null : lower(deps.litSigner)
  const report: DeployReport = {
    ok: false,
    mode: deps.mode,
    deployer,
    escrow,
    litSigner,
    nonceBefore: null,
    nonceAfterFunding: null,
    faucetTxs: 0,
    gasEstimate: null,
    gasLimit: null,
    txHash: null,
    receiptStatus: null,
    landedAt: null,
    creationProblems: null,
    readback: null,
    timings: {},
  }
  const say = deps.say
  let sent = false
  try {
    const refusals = deployRefusals({ mode: deps.mode, deployer, litSigner: deps.litSigner, template: deps.template })
    if (refusals.length > 0) throw new DeployStop(`refused before any network call: ${refusals.join('; ')}`)
    if (litSigner === null) throw new DeployStop('no signer for the escrow')

    // ---- 1. The chain, and a deployer that has never sent anything ---------
    const block = await agreedFinalizedBlock(deps.hosts)
    say(`chain           : 42431 on both hosts, agreed block ${block.number}`)
    report.nonceBefore = await pendingNonces(deps.hosts, deployer)
    if (report.nonceBefore.some((n) => n !== 0)) {
      throw new DeployStop(
        deps.mode === 'pinned'
          ? 'the deployer has already sent a transaction, so its nonce-0 address is gone for good. Start the pin steps again with a fresh deployer (spec section 5).'
          : 'this throwaway key has sent before; use a fresh one so the check means something.',
      )
    }

    // ---- 2. Funding: an incoming faucet transfer only ----------------------
    const t0 = now()
    let balance = await tokenBalanceAt(deps.hosts, block, PATH_USD, deployer)
    if (balance === 0n) {
      const minted = await requestFaucet(deps.hosts, deployer)
      report.faucetTxs = minted.length
      say(`faucet          : asked; ${minted.length} mint transaction(s) to the deployer`)
      const deadline = now() + (deps.fundTimeoutMs ?? 90_000)
      while (balance === 0n) {
        if (now() > deadline) throw new DeployStop('the faucet funds did not arrive on both hosts in time; rerun later (nothing was sent from the deployer)')
        await hostSleep(deps.hosts, 1_000)
        balance = await tokenBalanceAt(deps.hosts, await agreedFinalizedBlock(deps.hosts), PATH_USD, deployer)
      }
    }
    report.timings.fundMs = now() - t0
    say(`funded          : pathUSD balance is non-zero on both hosts`)
    report.nonceAfterFunding = await pendingNonces(deps.hosts, deployer)
    say(`nonce after fund: ${report.nonceAfterFunding.join(', ')} (must be 0 on both hosts)`)
    if (report.nonceAfterFunding.some((n) => n !== 0)) {
      throw new DeployStop('funding moved the deployer\'s nonce, so a deploy cannot land at its nonce-0 address. Stop: the pin rule does not hold here as designed.')
    }
    if (deps.mode === 'pinned') {
      const preflight = checkEscrowDeployPreflight({ template: deps.template, deployer, pendingNonce: Math.max(...report.nonceAfterFunding) })
      if (preflight.length > 0) throw new DeployStop(`preflight refused: ${preflight.map((p) => pinProblemWords(p, deps.template.id)).join('; ')}`)
    }

    // ---- 3. Sign after a dry run, then send once ---------------------------
    const t1 = now()
    let signed
    try {
      signed = await signTransaction(deps.hosts, deps.account, {
        to: null,
        data: escrowCreationInput(litSigner, PATH_USD, release.bytecode),
        nonce: 0,
      })
    } catch (err) {
      if (err instanceof EscrowRpcError && err.kind === 'revert') {
        throw new DeployStop(`the node's dry run of the deploy reverted (${err.reason ?? 'revert'}); nothing was sent`)
      }
      throw err
    }
    report.gasEstimate = signed.gasEstimate.toString()
    report.gasLimit = signed.gas.toString()
    report.txHash = signed.hash
    deps.onSigned?.(signed.hash)
    say(`signed          : nonce 0, gas limit ${signed.gas} (estimate ${signed.gasEstimate} plus 30%)`)
    sent = true
    await sendSigned(deps.hosts, signed)
    say(`sent            : ${signed.hash}`)
    const final = await waitForFinal(deps.hosts, signed.hash, deps.finalTimeoutMs === undefined ? {} : { timeoutMs: deps.finalTimeoutMs })
    report.timings.deployMs = now() - t1
    report.receiptStatus = final.receipt.status
    report.landedAt = final.receipt.contractAddress
    say(`final           : ${final.receipt.status} in block ${final.receipt.blockNumber}, on both hosts`)

    // ---- 4. The creation, as both hosts report it --------------------------
    report.creationProblems = verifyEscrowCreation(final.tx, final.receipt, {
      escrow,
      deployer,
      litSigner,
      token: PATH_USD,
      bytecode: release.bytecode,
    })
    say(`creation check  : ${report.creationProblems.length === 0 ? 'clean' : report.creationProblems.join(', ')}`)
    if (final.receipt.status !== 'success') {
      throw new DeployStop(
        'the deploy reverted, and nonce 0 is used up for good. Start again with a fresh deployer, a new pin, a new CID and a new Lit group entry (spec section 5).',
      )
    }

    // ---- 5. Read back what landed -------------------------------------------
    const after = await agreedFinalizedBlock(deps.hosts)
    const facts = await escrowFactsAt(deps.hosts, after, escrow)
    report.readback = {
      codehash: facts.codehash === release.runtimeKeccak && (deps.mode === 'address-check' || facts.codehash === deps.template.escrowCodehash),
      litSigner: facts.litSigner === litSigner,
      token: facts.token === PATH_USD,
    }
    say(
      `read back       : code hash ${report.readback.codehash ? 'matches' : 'DIFFERS'}, signer ${report.readback.litSigner ? 'matches' : 'DIFFERS'}, token ${report.readback.token ? 'is pathUSD' : 'IS NOT pathUSD'}`,
    )
    report.ok =
      report.creationProblems.length === 0 && report.readback.codehash && report.readback.litSigner && report.readback.token
  } catch (err) {
    report.ok = false
    if (err instanceof DeployStop) report.stopped = err.message
    else if (err instanceof EscrowRpcError) {
      report.stopped = sent
        ? `${err.message}. The deploy may have been sent: look up ${report.txHash ?? 'the hash above'} on both hosts before doing anything else.`
        : `${err.message}. Nothing was sent from the deployer.`
    } else throw err
  }
  return report
}
