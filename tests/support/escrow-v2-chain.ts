/**
 * SalvoEscrowV2 fixtures over TestChain, for the V2 template and hash tests.
 * Test-only; never referenced from src/.
 *
 * Deploys the COMMITTED artifact (contracts/out/SalvoEscrowV2.json through
 * src/lib/escrow/artifact-v2.ts), never a fresh compile, so every test runs
 * the exact bytes salvo-vault-escrow/2 pins. tests/escrow-v2-contract.test.ts
 * proves that artifact equals a fresh compile.
 *
 * The ticket and confirm digests here go through viem's EIP-712 hasher, not
 * src/lib/escrow/hashes-v2.ts and not the contract's views, so a test that
 * holds the three equal proves something.
 *
 * SalvoEscrowV2 never reads SalvoEscrowV1: a V2 card tag is never a V1 one.
 * `deployEscrowV1AtPin` puts the real V1 at its pinned Moderato address,
 * created by its real deployer as that account's first contract (TestChain
 * runs calls from any address without a key), so a test can sell a card on V1
 * and show V2 does not see it.
 */

import { encodeDeployData, encodeFunctionData, hashTypedData, type Hex, type PrivateKeyAccount } from 'viem'
import { ESCROW_V2_ABI, ESCROW_V2_BYTECODE } from '@/lib/escrow/artifact-v2'
import type { ConfirmFields, EscrowTermsV2, OpenV2Fields } from '@/lib/escrow/hashes-v2'
import { ESCROW_V1_PINS } from '@/lib/vault/lit/escrow-pins'
import { escrowInitCode } from './escrow-chain'
import type { TestChain } from './evm'

export const LISTING_V2 = { ACTIVE: 1, DRAINED: 2, CANCELLED: 3, SPENT: 4 } as const
export const DEPOSIT_V2 = { OPENED: 1, RELEASED: 2, REFUNDED: 3, CONTESTED: 4 } as const
export const BOND_V2 = { NONE: 0, HELD: 1, RETURNED: 2, FORFEITED: 3 } as const
export const CONTEST_WINDOW = 7_200n

/** The contract's Ticket struct: the signed fields Lit returns, minus the listing and depositor. */
export interface TicketV2 {
  replyKeyHash: Hex
  openBalanceCents: number
  cardTag: Hex
  remainingCents: number
  sales: number
  notAfter: number
  signature: Hex
}

const domain = (chainId: bigint, escrow: Hex) => ({ name: 'SalvoEscrow', version: '2', chainId, verifyingContract: escrow }) as const

/** The V2 ticket digest by the EIP-712 standard (viem). */
export function typedOpenDigestV2(chainId: bigint, escrow: Hex, f: OpenV2Fields): Hex {
  return hashTypedData({
    domain: domain(chainId, escrow),
    types: {
      OpenV2: [
        { name: 'listingId', type: 'bytes32' },
        { name: 'depositor', type: 'address' },
        { name: 'replyKeyHash', type: 'bytes32' },
        { name: 'openBalanceCents', type: 'uint32' },
        { name: 'cardTag', type: 'bytes32' },
        { name: 'remainingCents', type: 'uint32' },
        { name: 'sales', type: 'uint16' },
        { name: 'notAfter', type: 'uint40' },
      ],
    },
    primaryType: 'OpenV2',
    message: f,
  })
}

/** The confirm digest by the EIP-712 standard (viem). */
export function typedConfirmDigest(chainId: bigint, escrow: Hex, f: ConfirmFields): Hex {
  return hashTypedData({
    domain: domain(chainId, escrow),
    types: {
      Confirm: [
        { name: 'listingId', type: 'bytes32' },
        { name: 'bondDeposit', type: 'uint64' },
        { name: 'balance', type: 'uint32' },
        { name: 'readAt', type: 'uint40' },
      ],
    },
    primaryType: 'Confirm',
    message: f,
  })
}

/** A V2 ticket signed by any key, the way the template signs: for a rogue signer's purchase. */
export async function signTicketV2(signer: PrivateKeyAccount, chainId: bigint, escrow: Hex, f: OpenV2Fields): Promise<TicketV2> {
  const signature = await signer.sign({ hash: typedOpenDigestV2(chainId, escrow, f) })
  return {
    replyKeyHash: f.replyKeyHash,
    openBalanceCents: f.openBalanceCents,
    cardTag: f.cardTag,
    remainingCents: f.remainingCents,
    sales: f.sales,
    notAfter: f.notAfter,
    signature,
  }
}

function escrowV2InitCode(litSigner: Hex, token: Hex): Hex {
  return encodeDeployData({ abi: ESCROW_V2_ABI, bytecode: ESCROW_V2_BYTECODE, args: [litSigner, token] })
}

export async function deployEscrowV2(chain: TestChain, from: Hex, litSigner: Hex, token: Hex): Promise<Hex> {
  return chain.deploy(from, escrowV2InitCode(litSigner, token))
}

/** SalvoEscrowV1 at its pinned address, from its pinned deployer at nonce 0. Throws if it lands anywhere else. */
export async function deployEscrowV1AtPin(chain: TestChain, litSigner: Hex, token: Hex): Promise<Hex> {
  const at = await chain.deploy(ESCROW_V1_PINS.escrowDeployer as Hex, escrowInitCode(litSigner, token))
  if (at !== ESCROW_V1_PINS.escrowAddress) throw new Error('SalvoEscrowV1 did not land at its pinned address')
  return at
}

/** Calldata builders, typed against the committed V2 ABI. */
export const escrowV2Call = {
  list: (commitment: Hex): Hex => encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'list', args: [commitment] }),
  cancelListing: (listingId: Hex): Hex => encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'cancelListing', args: [listingId] }),
  depositAndOpen: (t: EscrowTermsV2, envelopeHash: Hex, usedCents: number, k: TicketV2): Hex =>
    encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'depositAndOpen', args: [t, envelopeHash, usedCents, k] }),
  contestRemainder: (id: bigint, reasonHash: Hex): Hex =>
    encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'contestRemainder', args: [id, reasonHash] }),
  confirmRemainder: (listingId: Hex, balance: number, readAt: number, sig: Hex): Hex =>
    encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'confirmRemainder', args: [listingId, balance, readAt, sig] }),
  release: (id: bigint): Hex => encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'release', args: [id] }),
  releaseBond: (id: bigint): Hex => encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'releaseBond', args: [id] }),
  sellerRefund: (id: bigint, amount: bigint): Hex =>
    encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'sellerRefund', args: [id, amount] }),
}
