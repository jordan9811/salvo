/**
 * Where the escrow lives, and how anyone can tell it is the honest deployment.
 *
 * The escrow template trusts one SalvoEscrowV1 by address (its `ESCROW`) and
 * by runtime code hash. Neither covers storage. Every field the contract keeps
 * is storage written by its constructor, so whoever runs the init code at that
 * address chooses the starting state. Init code can preset `owed[attacker]`
 * or a seller's `paidOut` and then return the exact runtime bytes: the code
 * hash, `litSigner()` and `token()` all read right, and the escrow later pays
 * the attacker out of shoppers' deposits. Mapping slots cannot be listed, so
 * no read of the deployed contract can find that. Only the creation
 * transaction shows it.
 *
 * So the address is trusted only together with its creation transaction, in
 * this order (spec section 15):
 *   1. Pin. The address is the deployer's nonce-0 CREATE address, written
 *      lower-case into the template before its CID exists, and recorded with
 *      the deployer in ESCROW_V1 (escrowPinProblems).
 *   2. Before the deploy, the deployer has sent nothing, and it is the pinned
 *      deployer (checkEscrowDeployPreflight). A deployer that has used nonce 0
 *      can never put a contract at the pinned address.
 *   3. After the deploy, the deployer's nonce-0 transaction is a plain create
 *      whose input is ESCROW_BYTECODE plus abi.encode(identity, pathUSD), byte
 *      for byte, and it succeeded at the pinned address (verifyEscrowCreation).
 *      Its hash is then pinned as ESCROW_V1.escrowCreationTx.
 *
 * Pure and offline. The live scripts fetch the transaction and receipt and
 * pass them in. Never a key, never a network call.
 */

import { concat, encodeAbiParameters, getContractAddress, type Hex } from 'viem'
import type { EscrowTemplate } from '@/lib/vault/lit/templates'
import { ESCROW_BYTECODE } from './artifact'

/** The committed source's unpinned ESCROW line, exactly. A template holding it refuses every manifest. */
export const ESCROW_PIN_PLACEHOLDER = `const ESCROW = "0x<the escrow deployer's CREATE address at nonce 0>";`

/** The template compares the manifest's escrow with its pin as text, so only this form can ever match. */
const LOWER_ADDRESS_RE = /^0x[0-9a-f]{40}$/
const PIN_LINE_RE = /^const ESCROW = "([^"\n]*)";$/
/**
 * Transaction types whose `input` is the init code and nothing else, and whose
 * CREATE address is keccak(rlp(sender, nonce)). A Tempo 0x76 batch is refused:
 * it can carry several calls, and its nonce keys may derive the address another
 * way (spec section 2 lists this as unmeasured).
 */
const PLAIN_CREATE_TYPES: readonly string[] = ['legacy', 'eip2930', 'eip1559', '0x0', '0x1', '0x2']

const lower = (s: string): string => s.toLowerCase()

/** Where `deployer`'s first contract lands: its CREATE address at nonce 0, lower-case. */
export function escrowCreateAddress(deployer: Hex): Hex {
  return lower(getContractAddress({ from: deployer, nonce: 0n })) as Hex
}

export type EscrowPinProblem =
  /** The source still holds the placeholder. Nothing is pinned yet. */
  | 'unpinned'
  /** The source has no ESCROW line, more than one, or one in another shape. */
  | 'pin_line'
  /** The pinned text is not 0x and 40 lower-case hex digits. A checksummed address counts: the template compares text. */
  | 'pin_not_lower_case'
  /** ESCROW_V1.escrowAddress is not the source's pin, byte for byte. */
  | 'record_mismatch'
  /** No deployer is recorded, so nobody can tell whose first address the pin is. */
  | 'deployer_missing'
  /** The pin is not the recorded deployer's nonce-0 CREATE address. */
  | 'not_deployer_first_address'

type PinFields = Pick<EscrowTemplate, 'source' | 'escrowAddress' | 'escrowDeployer'>

/**
 * Every reason the template's escrow pin is not a usable pin. Empty means the
 * source names one lower-case address, ESCROW_V1 records the same text, and
 * it is the recorded deployer's first CREATE address.
 *
 * The placeholder is reported as `unpinned` (plus `record_mismatch` if
 * ESCROW_V1 claims an address anyway). Readiness, the test build and the live
 * scripts all use this one rule, so they cannot disagree about a pin.
 */
export function escrowPinProblems(t: PinFields): EscrowPinProblem[] {
  const lines = t.source.split('\n').filter((l) => l.startsWith('const ESCROW = '))
  const line = lines.length === 1 ? lines[0] : undefined
  const match = line === undefined ? null : PIN_LINE_RE.exec(line)
  if (!match) return ['pin_line']
  if (line === ESCROW_PIN_PLACEHOLDER) return t.escrowAddress === null ? ['unpinned'] : ['unpinned', 'record_mismatch']

  const pin = match[1] ?? ''
  const problems: EscrowPinProblem[] = []
  if (!LOWER_ADDRESS_RE.test(pin)) problems.push('pin_not_lower_case')
  if (t.escrowAddress !== pin) problems.push('record_mismatch')
  if (t.escrowDeployer === null) problems.push('deployer_missing')
  else if (!LOWER_ADDRESS_RE.test(t.escrowDeployer) || escrowCreateAddress(t.escrowDeployer) !== pin) {
    problems.push('not_deployer_first_address')
  }
  return problems
}

/**
 * The one creation input the honest escrow can have: the committed bytecode,
 * then (litSigner, token). SalvoEscrowV1's bytecode unless another is given:
 * SalvoEscrowV2's constructor takes the same two arguments, so the runbook
 * passes ESCROW_V2_BYTECODE for it (runbook/versions.ts).
 */
export function escrowCreationInput(litSigner: Hex, token: Hex, bytecode: Hex = ESCROW_BYTECODE): Hex {
  const args = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [lower(litSigner) as Hex, lower(token) as Hex])
  return concat([bytecode, args])
}

export type EscrowDeployProblem =
  | EscrowPinProblem
  /** The key about to deploy is not the deployer the template's pin was made from. */
  | 'other_deployer'
  /** The deployer has already sent a transaction, so its nonce-0 address is gone for good. */
  | 'deployer_has_sent'

/**
 * Whether a deploy may be sent now. Run it immediately before the deploy,
 * with the deployer's `pending` transaction count, and refuse on any problem.
 * A deploy from any other key, or after any other transaction from this one,
 * lands somewhere the frozen template refuses, and the template, the Lit
 * group entry, the bind and the deploy would all have to be redone.
 * escrow:deploy calls it right before it signs (runbook/deploy.ts).
 */
export function checkEscrowDeployPreflight(input: {
  template: PinFields
  deployer: Hex
  pendingNonce: number | bigint
}): EscrowDeployProblem[] {
  const problems: EscrowDeployProblem[] = escrowPinProblems(input.template)
  if (input.template.escrowDeployer === null || lower(input.deployer) !== input.template.escrowDeployer) {
    problems.push('other_deployer')
  }
  if (BigInt(input.pendingNonce) !== 0n) problems.push('deployer_has_sent')
  return problems
}

/** The fields of a transaction the check reads. viem's getTransaction result fits. */
export interface EscrowCreationTx {
  hash: Hex
  from: Hex
  to: Hex | null
  nonce: number | bigint
  input: Hex
  type: string
}

/** The fields of a receipt the check reads. viem's getTransactionReceipt result fits. */
export interface EscrowCreationReceipt {
  transactionHash: Hex
  status: 'success' | 'reverted'
  contractAddress?: Hex | null
}

/** What the creation must match. Every value is a pin, never something the chain reported. */
export interface EscrowCreationPins {
  escrow: Hex
  deployer: Hex
  litSigner: Hex
  token: Hex
  /** ESCROW_V1.escrowCreationTx once pinned. Null or absent before then. */
  creationTx?: Hex | null
  /** The compiled init code the input must start with. Absent: SalvoEscrowV1's (ESCROW_BYTECODE). */
  bytecode?: Hex
}

export type EscrowCreationProblem =
  /** `to` is set: a call, not a create. */
  | 'not_a_create'
  /** Not a plain create type (a Tempo 0x76 batch, a blob or a set-code transaction). */
  | 'tx_type'
  | 'deployer'
  | 'nonce'
  /** The init code or constructor arguments differ from the compiled escrow's by any byte. */
  | 'input'
  | 'reverted'
  /** The receipt is for another transaction. */
  | 'receipt'
  /** The contract is not at the pinned escrow address, or the pin is not the deployer's first address. */
  | 'address'
  /** Not the creation transaction already pinned. */
  | 'creation_tx'

/**
 * Every way `tx` and `receipt` fail to be the honest creation of the pinned
 * escrow. Empty means the escrow at that address started with exactly the
 * storage SalvoEscrowV1's own constructor writes for (litSigner, token): no
 * owed balances, no sales, no listings, nothing else.
 *
 * The input is compared in full, not by prefix: extra bytes after the
 * constructor arguments are never read by the honest constructor, but a
 * different init code could put them to use, and the only safe answer for a
 * custody check is that any difference fails.
 *
 * escrow:deploy checks its own deploy with it, and escrow:check re-checks the
 * pinned one, each on the transaction as both hosts report it (runbook/).
 */
export function verifyEscrowCreation(
  tx: EscrowCreationTx,
  receipt: EscrowCreationReceipt,
  pins: EscrowCreationPins,
): EscrowCreationProblem[] {
  const problems: EscrowCreationProblem[] = []
  if (tx.to !== null) problems.push('not_a_create')
  if (!PLAIN_CREATE_TYPES.includes(tx.type)) problems.push('tx_type')
  if (lower(tx.from) !== lower(pins.deployer)) problems.push('deployer')
  if (BigInt(tx.nonce) !== 0n) problems.push('nonce')
  if (lower(tx.input) !== lower(escrowCreationInput(pins.litSigner, pins.token, pins.bytecode))) problems.push('input')
  if (lower(receipt.transactionHash) !== lower(tx.hash)) problems.push('receipt')
  if (receipt.status !== 'success') problems.push('reverted')
  const landed = receipt.contractAddress ?? ''
  if (lower(landed) !== lower(pins.escrow) || escrowCreateAddress(pins.deployer) !== lower(pins.escrow)) {
    problems.push('address')
  }
  if (pins.creationTx !== undefined && pins.creationTx !== null && lower(pins.creationTx) !== lower(tx.hash)) {
    problems.push('creation_tx')
  }
  return problems
}
