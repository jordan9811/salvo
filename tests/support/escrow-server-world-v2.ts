/**
 * The V2 escrow server, offline: salvo-vault-escrow/2 pinned and SalvoEscrowV2
 * deployed the way the runbook does it (escrow-runbook-world-v2.ts), fake Lit
 * running the real V2 template against the same chain and two fake store
 * balance endpoints, and the server's runtime pointed at all of it. No
 * database, no network. Test-only; never referenced from src/.
 *
 * Sellers and shoppers are plain addresses: TestChain runs a call from any
 * address without a key, so `list`, `approve` and `depositAndOpen` land the
 * way the phone's batch would, and the server's own code reads the result
 * from both hosts.
 */

import { randomBytes } from 'node:crypto'
import { decodeFunctionResult, keccak256, type Hex } from 'viem'
import { ESCROW_V2_ABI } from '@/lib/escrow/artifact-v2'
import { envelopeHashOf } from '@/lib/escrow/hashes'
import { commitmentV2, listingIdOfSealV2, termsOfManifestV2 } from '@/lib/escrow/hashes-v2'
import { requestTicketV2 } from '@/lib/escrow/lit-escrow-v2'
import { ESCROW_CHAIN_ID, PATH_USD } from '@/lib/escrow/manifest'
import { buildEscrowManifestV2, parseEscrowManifestV2, type EscrowManifestV2, type EscrowManifestV2Input } from '@/lib/escrow/manifest-v2'
import { ESCROW_MERCHANTS, MODE_BLIND, type EscrowMerchantName, type EscrowMode } from '@/lib/escrow/merchants'
import { __setEscrowRuntimeForTests, type EscrowRuntime } from '@/lib/escrow/runtime'
import type { TicketViewV2 } from '@/lib/escrow/runbook/smoke-v2'
import { createReplyKey, sealToTemplate, type LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { ESCROW_V1 } from '@/lib/vault/lit/templates'
import { tokenCall } from './escrow-chain'
import { deployedWorldV2, type RunbookWorldV2 } from './escrow-runbook-world-v2'
import { escrowV2Call } from './escrow-v2-chain'
import { testAddress } from './evm'
import { FakeBalanceStores, makeFakeLit, type FakeLitCall } from './fake-lit'

export interface ServerWorldV2 extends RunbookWorldV2 {
  escrow: Hex
  rt: EscrowRuntime
  stores: FakeBalanceStores
  litCalls: FakeLitCall[]
  /** Signed transactions the world sent itself (the deploy). Anything after these was sent by the code under test. */
  setupTxs: number
}

const urlOf = (input: string | URL | Request): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)

/**
 * SalvoEscrowV2 deployed and pinned, fake Lit and the stores, and the server
 * runtime set to use them: V1's committed template beside the pinned V2 one,
 * and V2 switched on (`v2Live`), as production will run once the till's merge
 * flips ESCROW_V2_LIVE. Call `closeServerWorldV2` after.
 */
export async function serverWorldV2(): Promise<ServerWorldV2> {
  const w = await deployedWorldV2()
  const stores = new FakeBalanceStores()
  const actionFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    stores.storeOf(urlOf(input)) !== null ? stores.fetch(input, init) : (w.node.rpc.fetch(input, init) as Promise<Response>)
  const fakeLit = makeFakeLit({ actionFetch: actionFetch as unknown as typeof fetch })
  const rt: EscrowRuntime = {
    template: ESCROW_V1,
    templateV2: w.template,
    v2Live: true,
    hosts: w.hosts,
    lit: { fetchImpl: fakeLit.fetchImpl, deadlineMs: 30_000 },
    now: () => Number(w.node.chain.timestamp) * 1000,
  }
  __setEscrowRuntimeForTests(rt)
  return {
    ...w,
    escrow: w.template.escrowAddress as Hex,
    rt,
    stores,
    litCalls: fakeLit.calls,
    setupTxs: w.node.sent('eth_sendRawTransaction').length,
  }
}

export function closeServerWorldV2(): void {
  __setEscrowRuntimeForTests(null)
}

export const SELLER_V2: Hex = testAddress(211)
export const SHOPPER_A: Hex = testAddress(311)
export const SHOPPER_B: Hex = testAddress(312)
export const SHOPPER_C: Hex = testAddress(313)

export interface ListedV2 {
  manifestText: string
  manifest: EscrowManifestV2
  envelope: LitEnvelope
  listingId: Hex
  cardNumber: string
  pin: string | null
}

let cardCounter = 0
/** A salvotest card: 9999 and twelve digits, different every call. */
export function testCardNumberV2(): string {
  cardCounter += 1
  return `9999${String(Date.now() % 1_000_000).padStart(6, '0')}${String(cardCounter).padStart(6, '0')}`
}

/** Seal a card to the V2 template's key, write its manifest, and (by default) list it on chain. */
export async function listV2(
  w: ServerWorldV2,
  opts: Partial<EscrowManifestV2Input> & { merchantName?: EscrowMerchantName; cardNumber?: string; pin?: string | null; onChain?: boolean } = {},
): Promise<ListedV2> {
  const now = Number(w.node.chain.timestamp)
  const valueCents = opts.valueCents ?? 2_000
  const mode: EscrowMode = opts.mode ?? MODE_BLIND
  const manifestText = buildEscrowManifestV2({
    escrow: w.escrow,
    seller: opts.seller ?? SELLER_V2,
    merchant: ESCROW_MERCHANTS[opts.merchantName ?? 'salvotest'].id,
    mode,
    valueCents,
    price: opts.price ?? valueCents * 9_000,
    residualCapCents: opts.residualCapCents ?? 500,
    remainderHaircutBps: opts.remainderHaircutBps ?? 2_500,
    listingExpiry: opts.listingExpiry ?? now + 30 * 86_400,
    salt: opts.salt ?? randomBytes(32).toString('hex'),
  })
  const manifest = parseEscrowManifestV2(manifestText, w.escrow)
  if (manifest === null) throw new Error('listV2: the manifest does not parse')
  const cardNumber = opts.cardNumber ?? testCardNumberV2()
  const pin = opts.pin ?? null
  const plain = Buffer.from(JSON.stringify({ cardNumber, pin }), 'utf8')
  const envelope = sealToTemplate(w.template.encPub as string, plain, manifestText)
  plain.fill(0)
  const listed = { manifestText, manifest, envelope, listingId: listingIdOfSealV2(manifest, envelope), cardNumber, pin }
  if (opts.onChain !== false) {
    const c = commitmentV2(ESCROW_CHAIN_ID, w.escrow, PATH_USD, termsOfManifestV2(manifest), envelopeHashOf(envelope))
    const r = await w.node.chain.send(manifest.seller, w.escrow, escrowV2Call.list(c))
    if (!r.ok) throw new Error(`list reverted: ${r.revert}`)
  }
  return listed
}

export interface BoughtV2 {
  depositId: bigint
  ticket: TicketViewV2
  bondDeposit: bigint
  reply: ReturnType<typeof createReplyKey>
}

/**
 * A shopper uses `usedCents` of a listed card: a ticket from fake Lit through
 * the server's relay, then approve and depositAndOpen in one batch, paying
 * exactly what the contract pulls (the price of the cents used plus the
 * deposit at face on what is left; the haircut only where no deposit covers
 * the leftover). `replyKeyHash`: the sale names this reply key instead, one
 * whose secret the caller holds (`reply` is then not the sale's key).
 */
export async function useCardV2(w: ServerWorldV2, l: ListedV2, shopper: Hex, usedCents: number, opts: { replyKeyHash?: Hex } = {}): Promise<BoughtV2> {
  const reply = createReplyKey()
  const replyKeyHash = opts.replyKeyHash ?? keccak256(reply.publicKey as Hex)
  const out = await requestTicketV2({ manifest: l.manifestText, envelope: l.envelope, listingId: l.listingId, depositor: shopper, replyKeyHash }, w.rt)
  if (!out.ok) throw new Error(`useCardV2: ticket refused (${out.refusal})`)
  const k = out.ticket
  const allowance = 1_000_000_000n
  await w.node.chain.send(shopper, PATH_USD, tokenCall.mint(shopper, allowance))
  const batch = await w.node.chain.batch(shopper, [
    { to: PATH_USD, data: tokenCall.approve(w.escrow, allowance) },
    {
      to: w.escrow,
      data: escrowV2Call.depositAndOpen(termsOfManifestV2(l.manifest), envelopeHashOf(l.envelope), usedCents, {
        replyKeyHash: k.replyKeyHash,
        openBalanceCents: k.openBalanceCents,
        cardTag: k.cardTag,
        remainingCents: k.remainingCents,
        sales: k.sales,
        notAfter: k.notAfter,
        signature: k.signature,
      }),
    },
    // Leave no allowance behind, as the phone's exact approve would not.
    { to: PATH_USD, data: tokenCall.approve(w.escrow, 0n) },
  ])
  if (!batch.ok) throw new Error(`useCardV2: the purchase reverted (${batch.results[batch.failedAt ?? 0]?.revert ?? '?'})`)
  const depositId = decodeFunctionResult({ abi: ESCROW_V2_ABI, functionName: 'depositAndOpen', data: batch.results[1]?.returnData ?? '0x' })
  return { depositId, ticket: k, bondDeposit: out.bondDeposit, reply }
}
