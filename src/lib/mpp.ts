/**
 * MPP rail — Machine Payments Protocol on Tempo (TIP-20 stablecoins).
 *
 * MPP is a second, independent 402 protocol alongside x402. They are NOT
 * interchangeable: different headers, different credential format, different
 * chain. Both are served, and an agent picks whichever it speaks.
 *
 * Why MPP/Tempo is the better rail here:
 *   - ~500ms deterministic finality vs waiting on Base blocks
 *   - sub-cent fees, and fee sponsorship so the buyer needs no gas token
 *   - Tempo has NO native gas token; fees are paid in a TIP-20 stablecoin, so a
 *     buyer holding only USDC.e can transact with nothing else
 *
 * Constants below are from the operator's own verified migration notes
 * (video-stream/TEMPO_NOTES.md, checked against live docs on 2026-07-07) plus
 * viem's shipped chain definitions.
 */

import { createHash } from 'node:crypto'
import { Mppx, tempo } from 'mppx/server'
import { privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoMainnet, tempoModerato } from 'viem/chains'
import type { Chain } from 'viem'
import { env, mppConfigured } from './env'

/** TIP-20 tokens are ERC-20 compatible and all use 6 decimals. */
export const TIP20_DECIMALS = 6

export interface TempoNetwork {
  key: 'moderato' | 'mainnet'
  chain: Chain
  chainId: number
  rpcUrl: string
  explorerTx: string
  /** Default currency buyers pay in: bridged USDC. */
  usdc: `0x${string}`
  /** Docs' default example currency; also the preferred fee token. */
  pathUsd: `0x${string}`
  /** Public fee sponsor relay, testnet only. */
  sponsorUrl: string | null
}

export const TEMPO_NETWORKS: Record<'moderato' | 'mainnet', TempoNetwork> = {
  mainnet: {
    key: 'mainnet',
    chain: tempoMainnet,
    chainId: 4217,
    rpcUrl: 'https://rpc.tempo.xyz',
    explorerTx: 'https://explore.tempo.xyz/tx/',
    usdc: '0x20c000000000000000000000b9537d11c60e8b50',
    pathUsd: '0x20c0000000000000000000000000000000000000',
    // No public mainnet sponsor: fees come out of the sender's stablecoin.
    sponsorUrl: null,
  },
  moderato: {
    key: 'moderato',
    chain: tempoModerato,
    chainId: 42431,
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    explorerTx: 'https://explore.testnet.tempo.xyz/tx/',
    // Testnet token registry mirrors mainnet addressing for the TIP-20 range.
    usdc: '0x20c000000000000000000000b9537d11c60e8b50',
    pathUsd: '0x20c0000000000000000000000000000000000000',
    sponsorUrl: 'https://sponsor.moderato.tempo.xyz',
  },
}

export class MppNotConfiguredError extends Error {
  constructor() {
    super(
      'MPP is not configured. Set TEMPO_PRIVATE_KEY and MPP_SECRET_KEY (>=32 chars). ' +
        'The Stripe and x402 rails are unaffected.',
    )
    this.name = 'MppNotConfiguredError'
  }
}

export function tempoNetwork(): TempoNetwork {
  return TEMPO_NETWORKS[env().TEMPO_NETWORK]
}

export function isTestnet(): boolean {
  return env().TEMPO_NETWORK === 'moderato'
}

export function tempoAccount(): ReturnType<typeof privateKeyToAccount> {
  const key = env().TEMPO_PRIVATE_KEY
  if (!key) throw new MppNotConfiguredError()
  return privateKeyToAccount(key as `0x${string}`)
}

/** Address that receives buyer funds and sends refunds. */
export function tempoPayTo(): `0x${string}` {
  const override = env().TEMPO_PAY_TO
  if (override) return override as `0x${string}`
  return tempoAccount().address
}

/** TIP-20 token buyers pay in. */
export function tempoCurrency(): `0x${string}` {
  return (env().TEMPO_CURRENCY as `0x${string}` | undefined) ?? tempoNetwork().usdc
}

export function tempoExplorerUrl(txHash: string): string {
  return `${tempoNetwork().explorerTx}${txHash}`
}

/** MPP quotes amounts as a decimal STRING of major units, e.g. "9.00". */
export function centsToAmountString(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`centsToAmountString expects a non-negative integer, got ${cents}`)
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/** Receipt fields we care about. `reference` is the Tempo tx hash. */
export interface MppReceipt {
  method: string
  reference: string
  status: string
  timestamp: string
  payer: string | null
}

/**
 * The key one payment's receipt is stored under.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT THE URL. Every POST to /api/mpp/order has the same URL, so a
 * url-keyed Map means two concurrent buyers overwrite each other. The receipt
 * reference is also the idempotency key, so the loser does not merely get a bad
 * receipt — `createPaidOrder` short-circuits on the winner's reference and
 * hands the SECOND buyer the FIRST buyer's order.
 *
 * The credential is the right key: each one carries a distinct signed transfer,
 * so it is unique per payment by construction. Both sides can see it — mppx
 * gets the Request in its success callback, and the route still holds the
 * original.
 *
 * Digested rather than stored raw: a credential is a large base64url blob and
 * has no business being a Map key at full length.
 * ---------------------------------------------------------------------------
 */
export function receiptKeyFor(req: Request): string | null {
  const credential = req.headers.get('authorization')
  if (!credential) return null
  return createHash('sha256').update(credential).digest('hex')
}

/**
 * Cap the receipt store.
 *
 * A receipt is normally deleted the moment the route reads it, but a request
 * that dies between settlement and read would leak one forever. Map preserves
 * insertion order, so the oldest entry is the first key.
 */
const MAX_RECEIPTS = 500
function pruneReceipts(receipts: Map<string, MppReceipt>): void {
  while (receipts.size >= MAX_RECEIPTS) {
    const oldest = receipts.keys().next().value
    if (oldest === undefined) break
    receipts.delete(oldest)
  }
}

/**
 * Built by a factory rather than annotated, because Mppx.create returns a type
 * parameterised over the exact method tuple. Writing `ReturnType<typeof
 * Mppx.create>` erases that to the empty-methods base type and every call site
 * stops type-checking.
 *
 * `receipts` cannot be keyed on the Request object — mppx clones it internally,
 * so a WeakMap keyed on the instance misses. It also cannot be keyed on the URL:
 * every POST to this endpoint has an IDENTICAL url, so two concurrent buyers
 * overwrite each other, and because the receipt reference doubles as the
 * idempotency key the second buyer receives the FIRST buyer's order.
 *
 * It is keyed on a digest of the payment CREDENTIAL instead — see receiptKeyFor.
 */
function buildRuntime() {
  if (!mppConfigured()) throw new MppNotConfiguredError()

  const account = tempoAccount()
  const net = tempoNetwork()
  const receipts = new Map<string, MppReceipt>()

  const method = tempo.charge({
    account,
    chainId: net.chainId,
    currency: tempoCurrency(),
    decimals: TIP20_DECIMALS,
    recipient: tempoPayTo(),
    testnet: isTestnet(),
    ...(env().TEMPO_FEE_TOKEN ? { feeToken: env().TEMPO_FEE_TOKEN as `0x${string}` } : {}),
  })

  const mppx = Mppx.create({
    methods: [method],
    secretKey: env().MPP_SECRET_KEY,
  })

  mppx.onPaymentSuccess((ctx) => {
    const key = ctx.input instanceof Request ? receiptKeyFor(ctx.input) : null
    if (!key) return
    // Method packages add fields beyond the base Receipt type (the spec says
    // unknown fields survive round-trips), so read them through an index view.
    const r: Record<string, unknown> = ctx.receipt
    pruneReceipts(receipts)
    receipts.set(key, {
      method: String(r.method ?? 'tempo'),
      reference: String(r.reference ?? ''),
      status: String(r.status ?? 'success'),
      timestamp: String(r.timestamp ?? new Date().toISOString()),
      payer: typeof r.payer === 'string' ? r.payer : typeof r.from === 'string' ? r.from : null,
    })
  })

  mppx.onPaymentFailed((ctx) => {
    const err: unknown = ctx.error
    const message = err instanceof Error ? err.message : String(err ?? 'unknown')
    console.warn(`[mpp] payment failed: ${message}`)
  })

  return { mppx, receipts }
}

export type MppRuntime = ReturnType<typeof buildRuntime>

let runtime: MppRuntime | null = null

export function mppRuntime(): MppRuntime {
  const existing = runtime
  if (existing) return existing
  const built = buildRuntime()
  runtime = built
  return built
}

/**
 * Test seam.
 * @wiring-exempt: test seam. The runtime is built once per process; only tests change its settings under it.
 */
export function __resetMppRuntime(): void {
  runtime = null
}

export { tempo, Mppx }

// ===========================================================================
// Payer recovery (Phase 7, Gate 1)
// ===========================================================================

/** `Transfer(address,address,uint256)` — the standard ERC-20/TIP-20 topic. */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const

/** A 32-byte log topic carrying an address → the address. */
function topicToAddress(topic: string): `0x${string}` {
  return `0x${topic.slice(26)}` as `0x${string}`
}

/**
 * Who actually paid, recovered from the settlement transaction.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS. The MPP receipt has NO payer field. That is not us dropping
 * it — mppx's `Receipt` schema is exactly `{ method, reference, externalId?,
 * subscriptionId?, status, timestamp }` and the Tempo method adds no payer. So
 * `receipt.payer` was always null, and two separate refund paths were gated on
 * it:
 *
 *   1. the post-settlement failure handler (`if (receipt.payer)`)
 *   2. the reconcile daemon, which THROWS without `order.payerAddress`
 *
 * Both degraded to "page a human". On testnet with someone watching that looked
 * fine. On mainnet it is a manual refund every single time.
 *
 * The address is recoverable, because `receipt.reference` IS the transaction
 * hash. Verified against the first real settlement
 * (0x14931a77…41b3 on moderato): both the transaction sender and the TIP-20
 * Transfer log resolved to the buyer.
 *
 * PREFERENCE ORDER, and the order matters:
 *
 *   1. the Transfer log paying OUR pay-to address. This is the authoritative
 *      answer to "whose tokens moved", and it survives fee sponsorship — Tempo
 *      lets a fee payer co-sign, so the transaction sender is not guaranteed to
 *      be the buyer even though it was in the observed case.
 *   2. the transaction sender, as a fallback.
 *
 * Returns null rather than throwing: recovery failing must not turn a
 * successful payment into an error. The caller decides how loud to be.
 * ---------------------------------------------------------------------------
 */
export async function recoverTempoPayer(txHash: string): Promise<`0x${string}` | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null

  const net = tempoNetwork()
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetch(net.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    })
    const json = (await res.json()) as { result?: unknown }
    return json.result
  }

  try {
    const payTo = tempoPayTo().toLowerCase()
    const currency = tempoCurrency().toLowerCase()

    const receipt = (await rpc('eth_getTransactionReceipt', [txHash])) as {
      logs?: Array<{ address?: string; topics?: string[] }>
    } | null

    for (const log of receipt?.logs ?? []) {
      const topics = log.topics ?? []
      if ((topics[0] ?? '').toLowerCase() !== TRANSFER_TOPIC) continue
      if ((log.address ?? '').toLowerCase() !== currency) continue
      if (topics.length < 3) continue
      // Only the leg that credited US. A settlement also emits a fee transfer
      // to the protocol collector, and that one's recipient is not our address.
      if (topicToAddress(topics[2] ?? '').toLowerCase() !== payTo) continue
      return topicToAddress(topics[1] ?? '')
    }

    const tx = (await rpc('eth_getTransactionByHash', [txHash])) as { from?: string } | null
    if (tx?.from && /^0x[0-9a-fA-F]{40}$/.test(tx.from)) return tx.from as `0x${string}`
    return null
  } catch {
    return null
  }
}
