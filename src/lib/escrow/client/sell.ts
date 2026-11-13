/**
 * The escrow branch of /sell, in the seller's browser (spec section 8.2).
 *
 * ===========================================================================
 * THE CARD NEVER LEAVES THIS PAGE IN CLEAR. The seller types the number and
 * PIN; this file writes the listing's 13-key manifest, seals `{cardNumber,
 * pin}` to the escrow template's key with the manifest as additional data
 * (seal.ts), zeroes the plaintext, and from then on handles only the
 * envelope: ciphertext that only a run of the frozen template inside Lit can
 * open, and only for a final purchase from this seller.
 *
 * WHAT IS CHECKED BEFORE SEALING, on both public hosts at one finalized block:
 * the code at the pinned escrow hashes to the pinned code hash, its
 * `litSigner` is the pinned identity, and its token is pathUSD. Every one of
 * those, and the sealing key itself, is this page's own pin
 * (src/lib/vault/lit/escrow-pins.ts), never a value our server sends: a
 * config that names another is refused before this file runs (api.ts). That
 * matters most for the sealing key. A card sealed to a key that is not the
 * template's is a card whoever holds that key can open, and the envelope is
 * posted to our server before anything goes on chain. The spec also asks for
 * a pinned bind signature over the key; none is recorded, so the key's pin is
 * the check, and the chain proves the identity half.
 *
 * NOTHING IS TYPED FOR A LISTING WE WOULD REFUSE. The config says whether our
 * server takes listings at all (the custody guard, a test list with someone
 * on it); while it does not, listCard refuses before sealing, and the page
 * shows no card field.
 *
 * TEST CARDS ONLY. This rail runs on the Moderato testnet, where any shopper
 * pays with free test dollars. A real card listed here would be bought for
 * nothing, so only the Salvo test card can be listed (ESCROW_SELL_STORES).
 *
 * THEN, IN THIS ORDER:
 *   1. The seller's access key signs `list(commitment)`. Its hash is now known.
 *   2. Our server is asked first, with that hash. It checks the allowlist and
 *      the custody guard before it reads the chain, so a seller it will not
 *      take hears it now, with nothing sent. "Not on chain yet" means go on.
 *   3. The listing is sent, and waited for until final on both hosts.
 *   4. Our server is told again, and records it (POST /api/escrow/listings).
 * The listing is kept on this device from step 1, with a listing file to
 * download: the manifest and envelope, a sealed copy of the listing. Nothing
 * reads that file yet; the fallback that sells from it without us is a later
 * phase (spec section 8.13), so the page never says it can be sold that way.
 *
 * THE FEES ARE THE SELLER'S WITHOUT A SPONSOR. With no fee sponsor set, `list`
 * and `cancelListing` pay their small network fee from the seller's own test
 * dollars, and a new seller has none. So both refuse first, with the reason
 * and the button that fixes it, instead of a generic failure, and a listing
 * the node refused for its fee is not kept as one waiting for the chain. A
 * listing that never reached the chain for any other reason can be removed
 * from this device (forgetListing).
 *
 * EVERY LISTING IS "UNCHECKED" FOR NOW (mode 2). Best Buy and Nike also allow
 * "checked", where Lit reads the balance before selling, but nothing yet says
 * whether those readers work from Lit (the probe, spec section 15 step 1, has
 * not run). A checked listing whose reader fails can never sell, and the
 * template allows unchecked at every store.
 * ===========================================================================
 *
 * Browser only by use; imports nothing Node-only. Never logs a card.
 */

import { encodeFunctionData, keccak256, type Hex } from 'viem'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { ESCROW_ABI } from '../artifact'
import { cardFingerprint, parseCardFingerprint } from '../card-fingerprint'
import { commitment, envelopeHashOf, listingIdOf, listingIdOfSeal, termsOfManifest } from '../hashes'
import { buildEscrowManifest, MAX_VALUE_CENTS, parseEscrowManifest, PATH_USD, UNITS_PER_CENT } from '../manifest'
import { ESCROW_MERCHANTS, escrowCardFormatOk, MODE_BLIND, type EscrowMerchantName } from '../merchants'
import { depositAt, depositsForListings, escrowEvents, gateAt, NEW_SELLER_BLIND_CAP_CENTS, owedAt, sellerStatsAt, tokenBalanceAt } from '../runbook/reads'
import { agreedFinalizedBlock, codeAt, EscrowRpcError, waitForReceiptFinal } from '../runbook/rpc'
import { sentenceOf, type EscrowApi, type EscrowPublicConfig } from './api'
import type { CardStore, ListingRecord } from './card-store'
import type { BatchSigner } from './load'
import { utf8 } from './primitives'
import { sealInBrowser } from './seal'
import type { ChainAccess } from './wallet'

/** How long a listing stays for sale. The seller can cancel it any time before it sells. */
export const LISTING_DAYS = 30
/**
 * The stores a seller may list for, while the rail runs on a testnet (and in
 * this build it runs nowhere else). Buyers there pay with free test dollars,
 * so a real card listed here can be bought by anyone for nothing. That is the
 * operator's call for their own card, for a till test (listing.ts,
 * TESTNET_LISTING_OWNER). Target is the store being tested at a real till;
 * the others stay off until each is tested the same way.
 */
export const ESCROW_SELL_STORES: readonly EscrowMerchantName[] = ['salvotest', 'target']
/** Said before any field, and by listCard, while our server takes no listings. */
export const LISTING_CLOSED_SENTENCE = 'Selling for test dollars is not open yet. Nothing you type here could be listed.'
/** Said when listing would pay its network fee from an account with no test dollars. */
const LIST_FEE_SENTENCE = 'Listing pays a small network fee from your test dollars, and this account has none. Tap Get test dollars first.'
/** The same, for taking a card back. */
const CANCEL_FEE_SENTENCE = 'Taking a card back pays a small network fee from your test dollars, and this account has none. Tap Get test dollars first.'
const POST_TRIES = 6
const POST_PAUSE_MS = 1_500
/** Deposits read back from the newest when a sold card's sale is not known yet. */
const SALE_SCAN = 200
const ZERO32: Hex = `0x${'0'.repeat(64)}`

const lower = (s: string): Hex => s.toLowerCase() as Hex
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The listing did not happen. `message` is a plain sentence; `sentOnChain` says whether `list` was sent. */
export class SellRefused extends Error {
  readonly sentOnChain: boolean
  constructor(sentence: string, sentOnChain = false) {
    super(sentence)
    this.name = 'SellRefused'
    this.sentOnChain = sentOnChain
  }
}

export interface SellInput {
  merchant: EscrowMerchantName
  cardNumber: string
  /** Null when the store has no PIN or the seller left it empty. */
  pin: string | null
  valueCents: number
  /** What the buyer pays, in cents. At most the value. */
  priceCents: number
}

export interface SellDeps {
  store: CardStore
  api: EscrowApi
  config: EscrowPublicConfig
  access: ChainAccess
  /** The seller's access key: `list` and `cancelListing` only. */
  wallet: BatchSigner
  sleep?: (ms: number) => Promise<void>
}

/** Every reason this card cannot be listed as typed. Pure; says nothing about the card beyond its shape. */
export function sellInputProblems(input: SellInput): string[] {
  const out: string[] = []
  const m = ESCROW_MERCHANTS[input.merchant]
  if (m === undefined) return ['Pick where the card is from.']
  if (!ESCROW_SELL_STORES.includes(input.merchant)) {
    return ['On the test chain only a Salvo test card or a Target card can be listed.']
  }
  if (!escrowCardFormatOk(m, { cardNumber: input.cardNumber, pin: input.pin })) {
    out.push(m.pin === null ? 'That number is not the shape this store uses.' : 'That number or PIN is not the shape this store uses.')
  }
  if (!Number.isSafeInteger(input.valueCents) || input.valueCents < 1 || input.valueCents > MAX_VALUE_CENTS) {
    out.push('Enter what is on the card, up to $500.')
  }
  if (!Number.isSafeInteger(input.priceCents) || input.priceCents < 1) out.push('Enter what a buyer pays.')
  else if (input.priceCents > input.valueCents) out.push('A buyer cannot pay more than what is on the card.')
  return out
}

/**
 * Why the escrow on chain is not the one this page trusts, read on both hosts
 * at one finalized block: its code, its signer and its token.
 */
/**
 * True when this account would pay its own fee and holds less than a cent of
 * test dollars: what the page shows as $0.00. With a sponsor set, the sponsor
 * pays, so nothing is read.
 */
async function cannotPayFee(d: SellDeps): Promise<boolean> {
  if (d.access.sponsorUrl !== null) return false
  const block = await agreedFinalizedBlock(d.access.hosts)
  return (await tokenBalanceAt(d.access.hosts, block, PATH_USD, d.wallet.account)) < BigInt(UNITS_PER_CENT)
}

/** A node's refusal for want of funds: definite, so the batch is not on its way anywhere. */
function refusedForFee(err: unknown): boolean {
  return err instanceof EscrowRpcError && (err.kind === 'rpc' || err.kind === 'revert') && /insufficient|funds|balance|fee/i.test(err.message)
}

async function escrowProblems(access: ChainAccess, cfg: EscrowPublicConfig): Promise<{ problems: string[]; time: number }> {
  const block = await agreedFinalizedBlock(access.hosts)
  const problems: string[] = []
  const code = await codeAt(access.hosts, block, cfg.escrow)
  if (keccak256(code) !== cfg.escrowCodehash) problems.push('the escrow on chain is not the code this page trusts')
  else {
    const g = await gateAt(access.hosts, block, cfg.escrow, ZERO32, 0n)
    if (g.signer !== cfg.identity) problems.push("the escrow's signer is not the card service this page trusts")
    if (g.token !== PATH_USD) problems.push("the escrow's token is not pathUSD")
  }
  return { problems, time: Number(block.timestamp) }
}

function randomSalt(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(32))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export interface SealedListing {
  manifest: string
  envelope: LitEnvelope
  commitment: Hex
  listingId: Hex
  listingExpiry: number
}

/**
 * Write the manifest and seal the card in this browser. The plaintext bytes
 * are zeroed before this returns; the strings the caller holds are its own to
 * drop (the page clears its fields).
 */
export async function sealListing(cfg: EscrowPublicConfig, seller: Hex, input: SellInput, chainTime: number): Promise<SealedListing> {
  const merchant = ESCROW_MERCHANTS[input.merchant]
  const listingExpiry = chainTime + LISTING_DAYS * 86_400
  const manifest = buildEscrowManifest({
    escrow: cfg.escrow,
    seller,
    merchant: merchant.id,
    mode: MODE_BLIND,
    valueCents: input.valueCents,
    price: input.priceCents * UNITS_PER_CENT,
    // Only read in "checked" mode; an unchecked listing carries none.
    residualCapCents: 0,
    listingExpiry,
    salt: randomSalt(),
  })
  const m = parseEscrowManifest(manifest, cfg.escrow)
  if (m === null) throw new SellRefused('Those listing terms are not ones the escrow accepts.')
  const plain = utf8(JSON.stringify({ cardNumber: input.cardNumber, pin: input.pin }))
  let envelope: LitEnvelope
  try {
    envelope = await sealInBrowser(cfg.encPub, plain, manifest)
  } finally {
    plain.fill(0)
  }
  const c = commitment(m.chainId, cfg.escrow, PATH_USD, termsOfManifest(m), envelopeHashOf(envelope))
  const listingId = listingIdOf(m.seller, c)
  if (listingId !== listingIdOfSeal(m, envelope)) throw new Error('the listing id does not match its own seal')
  return { manifest, envelope, commitment: c, listingId: lower(listingId), listingExpiry }
}

/**
 * List one card: check the escrow, seal in this browser, sign `list`, ask our
 * server first, send it, wait for it to be final, and record it. Returns the
 * stored listing. Throws SellRefused with a sentence; `sentOnChain` says
 * whether the listing reached the chain (then it can still be cancelled).
 */
export async function listCard(d: SellDeps, input: SellInput, onStep: (s: 'checking' | 'sealing' | 'listing' | 'recording') => void = () => {}): Promise<ListingRecord> {
  const sleep = d.sleep ?? realSleep
  if (!d.config.listingOpen) throw new SellRefused(LISTING_CLOSED_SENTENCE)
  const problems = sellInputProblems(input)
  if (problems.length > 0) throw new SellRefused(problems.join(' '))

  onStep('checking')
  const { problems: chainProblems, time } = await escrowProblems(d.access, d.config)
  if (chainProblems.length > 0) throw new SellRefused(`This page will not list: ${chainProblems.join('; ')}. Nothing was sent.`)
  if (input.valueCents > NEW_SELLER_BLIND_CAP_CENTS) {
    const block = await agreedFinalizedBlock(d.access.hosts)
    const stats = await sellerStatsAt(d.access.hosts, block, d.config.escrow, d.wallet.account)
    if (stats.paidOut < BigInt(input.valueCents) * BigInt(UNITS_PER_CENT)) {
      throw new SellRefused(
        'New sellers can list cards up to $25 here. Bigger cards open up once your finished sales have paid you at least the card value. Nothing was sent.',
      )
    }
  }

  if (await cannotPayFee(d)) throw new SellRefused(`${LIST_FEE_SENTENCE} Nothing was sent.`)

  onStep('sealing')
  // Sent with the listing and kept with it, so a card sold here cannot be
  // listed again on SalvoEscrowV2, which cannot see V1's card tags
  // (card-fingerprint.ts). Computed from the number before it is sealed.
  const fingerprint = await cardFingerprint(ESCROW_MERCHANTS[input.merchant].id, input.cardNumber)
  const sealed = await sealListing(d.config, d.wallet.account, input, time)
  const signed = await d.wallet.signCalls(
    [{ to: d.config.escrow, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'list', args: [sealed.commitment] }) }],
    d.access,
  )
  const record: ListingRecord & { cardFingerprint: Hex } = {
    listingId: sealed.listingId,
    seller: d.wallet.account,
    merchant: input.merchant,
    valueCents: input.valueCents,
    priceUnits: input.priceCents * UNITS_PER_CENT,
    listingExpiry: sealed.listingExpiry,
    manifest: sealed.manifest,
    envelope: sealed.envelope,
    txHash: signed.hash,
    posted: false,
    createdAt: Date.now(),
    cardFingerprint: fingerprint,
  }

  // Asked first, with nothing sent. Its checks come before its chain read, so
  // "not on chain yet" is the answer that means it will take this listing.
  const first = await d.api.listing(sealed.manifest, sealed.envelope, signed.hash, fingerprint)
  if (first.status === 0) throw new SellRefused('We could not reach Salvo. Nothing was sent.')
  if (!(first.status === 409 && first.body.error === 'not_on_chain_yet') && first.status !== 200 && first.status !== 201) {
    throw new SellRefused(sentenceOf(first, 'Salvo will not take that listing. Nothing was listed.'))
  }
  await d.store.saveListing(record)

  onStep('listing')
  let final: Awaited<ReturnType<typeof waitForReceiptFinal>>
  try {
    await d.wallet.broadcast(signed, d.access)
    final = await waitForReceiptFinal(d.access.hosts, signed.hash)
  } catch (err) {
    // Refused for its fee: never on its way, so it is not kept as one that is.
    if (refusedForFee(err)) {
      await d.store.deleteListing(record.listingId)
      throw new SellRefused(`${LIST_FEE_SENTENCE} Nothing was listed.`)
    }
    throw new SellRefused('We could not confirm the listing went through. It is saved on this device; its state shows below.', true)
  }
  const listed = escrowEvents(final.receipt, d.config.escrow, 'Listed').some((e) => lower(e.listingId) === sealed.listingId)
  if (final.receipt.status !== 'success' || !listed) {
    throw new SellRefused('The chain did not take the listing. Nothing was listed.', false)
  }

  onStep('recording')
  for (let i = 0; i < POST_TRIES; i++) {
    const a = await d.api.listing(sealed.manifest, sealed.envelope, signed.hash, fingerprint)
    if (a.status === 200 || a.status === 201) {
      record.posted = true
      await d.store.saveListing(record)
      return record
    }
    if (!(a.status === 409 && a.body.error === 'not_on_chain_yet')) {
      throw new SellRefused(`${sentenceOf(a, 'Salvo did not record the listing.')} It is listed on chain; you can cancel it below.`, true)
    }
    await sleep(POST_PAUSE_MS)
  }
  throw new SellRefused('Salvo has not seen the listing yet. It is listed on chain; try again in a minute.', true)
}

/** Said when sending a listing again may work in a minute. */
const RESEND_LATER = 'Salvo did not take it yet. Try again in a minute.'

/**
 * Send the listing again to our server, for one that reached the chain but
 * not our book. Null once it is recorded. Otherwise the sentence to show: "try
 * again in a minute" only when that can help (our server or the chain busy or
 * catching up), and our server's own sentence when it cannot (a listing too
 * close to its end, a seller off the test list, listing not open).
 */
export async function recordListing(d: SellDeps, r: ListingRecord): Promise<string | null> {
  if (r.txHash === null) return 'This listing was never sent to the chain, so Salvo cannot record it.'
  const fingerprint = parseCardFingerprint((r as ListingRecord & { cardFingerprint?: unknown }).cardFingerprint)
  // Salvo takes no V1 listing without one now (listing.ts), and this page cannot make one: the card is not kept here.
  if (fingerprint === null) return 'This listing was made before Salvo kept a fingerprint of each card, so Salvo cannot record it. Take it back below, then list the card again.'
  const a = await d.api.listing(r.manifest, r.envelope, r.txHash, fingerprint)
  if (a.status === 200 || a.status === 201) {
    r.posted = true
    await d.store.saveListing(r)
    return null
  }
  const passing = a.status === 0 || a.status === 429 || a.status >= 500 || (a.status === 409 && a.body.error === 'not_on_chain_yet')
  return passing ? RESEND_LATER : sentenceOf(a, RESEND_LATER)
}

/**
 * Remove a listing this browser kept that never reached the chain: a send
 * that was refused, or never confirmed. Read on both hosts first. One the
 * chain has (listed, sold, taken back) stays, since its row is how the
 * seller sees it, takes it back and gets paid.
 */
export async function forgetListing(d: Pick<SellDeps, 'access' | 'config' | 'store'>, r: ListingRecord): Promise<void> {
  const { views } = await listingStates(d.access, d.config, [r])
  if (views.get(r.listingId)?.state !== 'not_on_chain') throw new SellRefused('This listing is on the chain, so it stays here.')
  await d.store.deleteListing(r.listingId)
}

export type ListingState = 'not_on_chain' | 'listed' | 'sold' | 'cancelled'

/**
 * A sold card's sale, from getDeposit on both hosts. A listing stays "sold"
 * on chain forever, so what the seller needs to know (held, paid, refunded,
 * disputed) is the deposit's, never the listing's.
 */
export interface SaleView {
  depositId: string
  /** held: the escrow still holds it (Opened). paid: Released to the seller. refunded: back to the buyer in full. */
  state: 'held' | 'paid' | 'refunded'
  /** Unix seconds (chain time) from when anyone may pay it out. */
  releaseAt: number
  disputed: boolean
  /** What the sale holds for the seller now, or what it paid. */
  amountUnits: bigint
}

export interface ListingView {
  state: ListingState
  /** For a sold card, once its deposit is found on chain. */
  sale: SaleView | null
}

export interface ListingStates {
  views: Map<Hex, ListingView>
  /** The chain's time at the block read, in seconds. */
  chainTime: number
}

const DEPOSIT_STATE_NAMES: Readonly<Record<number, SaleView['state']>> = { 1: 'held', 2: 'paid', 3: 'refunded' }

/**
 * What the chain says about each of this seller's listings, at one finalized
 * block on both hosts, and for each sold one, its sale. A sale's deposit id is
 * kept on the listing once found, so it is looked for once.
 */
export async function listingStates(
  access: ChainAccess,
  cfg: EscrowPublicConfig,
  rs: readonly ListingRecord[],
  store: CardStore | null = null,
): Promise<ListingStates> {
  const views = new Map<Hex, ListingView>()
  const block = await agreedFinalizedBlock(access.hosts)
  if (rs.length === 0) return { views, chainTime: Number(block.timestamp) }
  const gates = await Promise.all(rs.map((r) => gateAt(access.hosts, block, cfg.escrow, r.listingId, 0n)))
  const states = gates.map((g): ListingState => (g.listingState === 1 ? 'listed' : g.listingState === 2 ? 'sold' : g.listingState === 3 ? 'cancelled' : 'not_on_chain'))
  const unknown = new Set(rs.filter((r, i) => states[i] === 'sold' && (r.depositId ?? null) === null).map((r) => r.listingId))
  const found = await depositsForListings(access.hosts, block, cfg.escrow, unknown, SALE_SCAN)
  for (const [i, r] of rs.entries()) {
    const state = states[i] as ListingState
    let sale: SaleView | null = null
    const known = r.depositId ?? null
    const hit = known !== null ? { id: BigInt(known), deposit: await depositAt(access.hosts, block, cfg.escrow, BigInt(known)) } : found.get(r.listingId)
    const name = hit === undefined ? undefined : DEPOSIT_STATE_NAMES[hit.deposit.state]
    if (state === 'sold' && hit !== undefined && name !== undefined && hit.deposit.listingId === r.listingId && hit.deposit.seller === lower(r.seller)) {
      const dep = hit.deposit
      sale = { depositId: hit.id.toString(), state: name, releaseAt: dep.releaseAt, disputed: dep.disputed, amountUnits: dep.amount }
      if (known === null && store !== null) await store.saveListing({ ...r, depositId: hit.id.toString() })
    }
    views.set(r.listingId, { state, sale })
  }
  return { views, chainTime: Number(block.timestamp) }
}

/** The passkey that can pay a sale out: anyone may call release() once it is due, the seller included. */
export interface PayoutSigner {
  releasePayout(escrow: Hex, depositId: bigint, access: ChainAccess): Promise<void>
  /** claim(this account): what the escrow owes it because the token would not send a payout. */
  claimOwed(escrow: Hex, access: ChainAccess): Promise<void>
}

/**
 * What the escrow holds for `seller` because the token would not send it a
 * payout when it was due (the contract's `owed`). A sale that paid out this
 * way reads Released like any other, so only this says the money did not
 * arrive. Read on both hosts at one finalized block.
 */
export async function owedTo(access: ChainAccess, cfg: EscrowPublicConfig, seller: Hex): Promise<bigint> {
  return owedAt(access.hosts, await agreedFinalizedBlock(access.hosts), cfg.escrow, lower(seller))
}

/**
 * Collect what the escrow owes this seller: claim(seller), with Face ID, final
 * on both hosts. claim pays only the address it names, so this can only pay
 * this seller. Nothing owed sends nothing. If the token still refuses, the
 * chain refuses the claim and the money stays owed.
 */
export async function collectOwed(d: SellDeps, signer: PayoutSigner): Promise<void> {
  if ((await owedTo(d.access, d.config, d.wallet.account)) === 0n) return
  await signer.claimOwed(d.config.escrow, d.access)
}

/**
 * Get paid now: send the escrow's release(id) for a sale that is due, from
 * the seller's own account with Face ID, and wait until it is final. The
 * escrow pays only the sale's seller, so this can only pay this seller.
 * Salvo's keeper may send it too, when one runs with a key; this does not
 * wait on it.
 */
export async function collectPayout(d: SellDeps, signer: PayoutSigner, r: ListingRecord): Promise<void> {
  const { views, chainTime } = await listingStates(d.access, d.config, [r], d.store)
  const sale = views.get(r.listingId)?.sale ?? null
  if (sale === null) throw new SellRefused('We cannot find this sale on the chain yet. Try again in a minute.')
  if (sale.state === 'paid') return
  if (sale.state !== 'held') throw new SellRefused('This sale was refunded, so there is nothing to collect.')
  if (chainTime < sale.releaseAt) throw new SellRefused('This sale is not due yet. Nothing was sent.')
  await signer.releasePayout(d.config.escrow, BigInt(sale.depositId), d.access)
}

/** Take an unsold listing back: `cancelListing` with the seller's access key, final on both hosts. */
export async function cancelListing(d: SellDeps, r: ListingRecord): Promise<void> {
  if (await cannotPayFee(d)) throw new SellRefused(`${CANCEL_FEE_SENTENCE} Nothing was sent.`)
  const signed = await d.wallet.signCalls(
    [{ to: d.config.escrow, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'cancelListing', args: [r.listingId] }) }],
    d.access,
  )
  try {
    await d.wallet.broadcast(signed, d.access)
  } catch (err) {
    if (refusedForFee(err)) throw new SellRefused(`${CANCEL_FEE_SENTENCE} Nothing was sent.`)
    throw err
  }
  const { receipt } = await waitForReceiptFinal(d.access.hosts, signed.hash)
  if (receipt.status !== 'success') throw new SellRefused('The chain did not take that back. It may have just sold.', true)
}

/**
 * The listing file (spec section 8.2 step 6): the manifest and envelope, with
 * the chain facts to find the listing. Ciphertext and public terms only. A
 * sealed copy to keep: nothing reads it yet (spec section 8.13, a later phase).
 */
export function listingFileText(r: ListingRecord, cfg: EscrowPublicConfig): string {
  return JSON.stringify(
    {
      kind: 'salvo-escrow-listing/1',
      chainId: cfg.chainId,
      escrow: cfg.escrow,
      listingId: r.listingId,
      listTx: r.txHash,
      manifest: r.manifest,
      envelope: r.envelope,
    },
    null,
    2,
  )
}
