/**
 * Crypto refunds for both machine-payment rails (the "return tx" half of node J).
 *
 * Neither x402 nor MPP has a protocol-level reversal — settlement is a one-way
 * token transfer. To refund we send the tokens back from a wallet we control:
 *
 *   x402 -> USDC on Base            (X402_PRIVATE_KEY)
 *   mpp  -> TIP-20 USDC.e on Tempo  (TEMPO_PRIVATE_KEY)
 *
 * Stripe refunds do NOT go through here — they use the Stripe Refunds API.
 *
 * Tempo note: there is no native gas token. Fees are taken from a TIP-20
 * stablecoin balance on the sending account, so the refund wallet needs enough
 * of the token to cover both the refund and its own fees. Per the operator's
 * verified migration notes, plain EIP-1559 writes are accepted on Tempo and the
 * fee is settled in the fee token — no special envelope needed for a transfer.
 */

import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import { env, mppRefundsConfigured, x402RefundsConfigured } from './env'
import { EscrowRailRefusedError, isEscrowPaymentRef } from './escrow/refs'
import { activeAsset, centsToAtomic, explorerUrl } from './x402'
import {
  MppNotConfiguredError,
  TIP20_DECIMALS,
  tempoCurrency,
  tempoExplorerUrl,
  tempoNetwork,
} from './mpp'

export class RefundNotConfiguredError extends Error {
  constructor(which: 'x402' | 'mpp', varName: string) {
    super(
      `${varName} is not set — ${which} refunds cannot be sent automatically. ` +
        `Refund by hand from the operator wallet and record the tx hash on the order.`,
    )
    this.name = 'RefundNotConfiguredError'
  }
}

export interface RefundResult {
  txHash: string
  explorer: string
  amountAtomic: string
  /** Address the refund was sent from, for the operator's records. */
  from: string
}

interface TransferParams {
  chain: Chain
  rpcUrl?: string
  privateKey: Hex
  token: Hex
  to: Hex
  amount: bigint
  explorerFor: (hash: string) => string
}

/**
 * One ERC-20/TIP-20 transfer, with a balance precheck so a shortfall produces a
 * clear operator-actionable message instead of an opaque revert.
 *
 * Clients are constructed per call rather than cached: refunds are rare, and a
 * cached client would pin a chain across a network switch.
 */
async function sendTokenTransfer(p: TransferParams): Promise<RefundResult> {
  const account = privateKeyToAccount(p.privateKey)
  const transport = p.rpcUrl ? http(p.rpcUrl) : http()

  const pub: PublicClient = createPublicClient({ chain: p.chain, transport }) as PublicClient
  const wallet: WalletClient = createWalletClient({ account, chain: p.chain, transport })

  const balance = await pub.readContract({
    address: p.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })

  if (balance < p.amount) {
    throw new Error(
      `Refund wallet ${account.address} holds ${balance} atomic units of ${p.token} on ` +
        `${p.chain.name} but the refund needs ${p.amount}. Fund the wallet and retry.`,
    )
  }

  const txHash = await wallet.writeContract({
    account,
    chain: p.chain,
    address: p.token,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [p.to, p.amount],
  })

  // Broadcast already: a failure from here on names the transaction, so
  // whoever is paged checks it on chain before sending anything again.
  let receipt: Awaited<ReturnType<typeof pub.waitForTransactionReceipt>>
  try {
    receipt = await pub.waitForTransactionReceipt({ hash: txHash, confirmations: 1 })
  } catch (err) {
    throw new Error(`Refund transaction ${txHash} was sent but its receipt could not be read (${err instanceof Error ? err.message.slice(0, 120) : 'error'}). Check it on chain before sending again.`)
  }
  if (receipt.status !== 'success') {
    throw new Error(`Refund transaction ${txHash} reverted on ${p.chain.name}`)
  }

  return {
    txHash,
    explorer: p.explorerFor(txHash),
    amountAtomic: p.amount.toString(),
    from: account.address,
  }
}

/** Refund an x402 order: USDC on Base / Base Sepolia. */
export async function refundX402(payer: string, priceCents: number): Promise<RefundResult> {
  const e = env()
  if (!x402RefundsConfigured(e)) throw new RefundNotConfiguredError('x402', 'X402_PRIVATE_KEY')

  const asset = activeAsset()
  return sendTokenTransfer({
    chain: e.X402_NETWORK === 'base' ? base : baseSepolia,
    privateKey: e.X402_PRIVATE_KEY as Hex,
    token: asset.address as Hex,
    to: payer as Hex,
    amount: BigInt(centsToAtomic(priceCents, asset.decimals)),
    explorerFor: explorerUrl,
  })
}

/** Refund an MPP order: TIP-20 stablecoin on Tempo. */
export async function refundTempo(payer: string, priceCents: number): Promise<RefundResult> {
  const e = env()
  if (!mppRefundsConfigured(e)) throw new MppNotConfiguredError()

  const net = tempoNetwork()
  return sendTokenTransfer({
    chain: net.chain,
    rpcUrl: net.rpcUrl,
    privateKey: e.TEMPO_PRIVATE_KEY as Hex,
    token: tempoCurrency(),
    to: payer as Hex,
    // TIP-20 is always 6 decimals, same as USDC, so the cents conversion matches.
    amount: BigInt(centsToAtomic(priceCents, TIP20_DECIMALS)),
    explorerFor: tempoExplorerUrl,
  })
}

/**
 * Dispatch by rail. Stripe is handled elsewhere and is rejected here loudly.
 *
 * `paymentRef` is the order's, and it is required so this can refuse an
 * escrow order before touching a key: those ride the mpp rail, but their
 * money is in SalvoEscrowV1, not our wallet, and only their seller can return
 * it. Sending from TEMPO_PRIVATE_KEY would pay that shopper twice.
 */
export async function refundCrypto(
  rail: 'x402' | 'mpp',
  payer: string,
  priceCents: number,
  paymentRef: string,
): Promise<RefundResult> {
  if (isEscrowPaymentRef(paymentRef)) throw new EscrowRailRefusedError('send a crypto refund for an escrow order')
  return rail === 'mpp' ? refundTempo(payer, priceCents) : refundX402(payer, priceCents)
}
