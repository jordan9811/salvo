/**
 * What a transaction actually paid Salvo FOR ONE CHALLENGE, read from the chain.
 *
 * Used before paging about a refused agent payment: a page that tells a
 * person to return money is sent only for money that arrived for that very
 * challenge. A transfer counts only through its TIP-20 TransferWithMemo whose
 * memo carries the challenge's nonce (bytes 25-31 = keccak256(id)[0..6], the
 * binding the payment library itself enforces). Any other money that reached
 * Salvo (a shop payment, one already returned some other way) cannot be
 * pointed at by a made-up credential.
 */
import { keccak256, stringToHex, toHex } from 'viem'
import { tempoCurrency, tempoNetwork, tempoPayTo } from '../mpp'

export type PaymentSeen =
  | { status: 'paid'; payer: `0x${string}`; cents: number }
  /** Not mined, failed, or nothing bound to this challenge reached us. */
  | { status: 'none' }
  /** The chain could not be read: say so, never treat it as "not paid". */
  | { status: 'unknown'; error: string }

/** TIP-20 amounts have 6 decimals: one cent is 10,000 base units. */
const UNITS_PER_CENT = 10_000n

/** TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo). */
const TRANSFER_WITH_MEMO_TOPIC = keccak256(toHex('TransferWithMemo(address,address,uint256,bytes32)'))

/** The 7-byte nonce a challenge-bound memo carries in bytes 25-31, as 14 hex chars. */
export function challengeNonceHex(challengeId: string): string {
  return keccak256(stringToHex(challengeId)).slice(2, 16).toLowerCase()
}

export async function paymentToUs(txHash: string, challengeId: string): Promise<PaymentSeen> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { status: 'none' }
  let receipt: { status?: string; logs?: Array<{ address?: string; topics?: string[]; data?: string }> } | null
  try {
    const res = await fetch(tempoNetwork().rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
      signal: AbortSignal.timeout(10_000),
    })
    const json = (await res.json()) as { result?: typeof receipt; error?: { message?: string } }
    if (json.error || !('result' in json)) return { status: 'unknown', error: json.error?.message ?? 'no result' }
    receipt = json.result ?? null
  } catch (err) {
    return { status: 'unknown', error: err instanceof Error ? err.message.slice(0, 120) : 'error' }
  }
  if (!receipt || receipt.status !== '0x1') return { status: 'none' }

  const payTo = tempoPayTo().toLowerCase()
  const currency = tempoCurrency().toLowerCase()
  const nonce = challengeNonceHex(challengeId)
  let units = 0n
  let payer: `0x${string}` | null = null
  for (const log of receipt.logs ?? []) {
    const topics = log.topics ?? []
    if ((topics[0] ?? '').toLowerCase() !== TRANSFER_WITH_MEMO_TOPIC) continue
    if ((log.address ?? '').toLowerCase() !== currency) continue
    if (topics.length < 4 || `0x${(topics[2] ?? '').slice(26)}`.toLowerCase() !== payTo) continue
    // bytes 25-31 of the 32-byte memo: hex chars 52..66 of the 0x-prefixed topic.
    if ((topics[3] ?? '').toLowerCase().slice(52, 66) !== nonce) continue
    if (!/^0x[0-9a-fA-F]+$/.test(log.data ?? '')) continue
    units += BigInt(log.data as string)
    payer ??= `0x${(topics[1] ?? '').slice(26)}` as `0x${string}`
  }
  if (payer === null || units === 0n) return { status: 'none' }
  return { status: 'paid', payer, cents: Number(units / UNITS_PER_CENT) }
}
