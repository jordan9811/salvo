/**
 * Selling on SalvoEscrowV2, in the seller's browser (unified spec sections
 * 8 and 11): seal, list, take back.
 *
 * THE SAME CONTRACT WITH THE SELLER AS V1 (sell.ts, whose steps this follows):
 * the card never leaves this page in clear. The seller types the number and
 * PIN; this file writes the listing's 14-key V2 manifest, seals the card to
 * salvo-vault-escrow/2's pinned key with the manifest as additional data,
 * zeroes the plaintext, and from then on handles only ciphertext. The escrow
 * on chain is checked against this page's own V2 pins first, on both hosts.
 *
 * WHAT V2 ADDS:
 *   - A card fingerprint (card-fingerprint.ts), computed here from the card
 *     the seal carries, before sealing, and sent with the listing. It is a
 *     slow keyless hash of the store and the number, never the PIN, never the
 *     card: our server compares it across both escrows, so a card already
 *     listed, or sold to someone else, on V1 or V2 is refused before it is
 *     listed again. V2 cannot see V1's card tags; this is how the two meet.
 *   - The leftover terms: the most a sale may leave on the card is the
 *     store's cap and the contract's ($5 where nobody can read the balance,
 *     $10 where Lit reads it), and a leftover no deposit covers sells 25% off
 *     its price (decision 3; while a deposit covers it, no haircut).
 *   - Take it back is also "I used it myself": on a card with a leftover,
 *     `cancelListing` closes it and the deposit goes back to its shopper.
 *   - The seller's review of an unsold leftover (spec sections 4 and 7.1):
 *     from five days after a shopper's deposit started covering it, "Still
 *     there" or "It's gone" (closeRemainderV2). At seven days the deposit
 *     goes back by rule, so this is how a leftover found spent at a store
 *     nobody can read pays its seller when no next shopper reported it.
 *
 * EVERY LISTING IS "UNCHECKED" FOR NOW (mode 2), as on V1: nothing yet shows
 * the Best Buy and Nike readers work from Lit (sell.ts says why).
 *
 * TEST CARDS ONLY, as on V1 (ESCROW_SELL_STORES): this rail runs on a testnet.
 *
 * Browser only by use; imports nothing Node-only. Never logs a card.
 */

import { encodeFunctionData, keccak256, type Hex } from 'viem'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { ESCROW_V2_ABI } from '../artifact-v2'
import { cardFingerprint } from '../card-fingerprint'
import { envelopeHashOf, listingIdOf } from '../hashes'
import { commitmentV2, listingIdOfSealV2, termsOfManifestV2 } from '../hashes-v2'
import { PATH_USD, UNITS_PER_CENT } from '../manifest'
import { buildEscrowManifestV2, parseEscrowManifestV2, residualCapLimitV2 } from '../manifest-v2'
import { ESCROW_MERCHANTS, MODE_BLIND } from '../merchants'
import { tokenBalanceAt } from '../runbook/reads'
import { depositV2At, escrowEventsV2, gateV2At, listingV2At, owedV2At, sellerStatsV2At, V2_STATE } from '../runbook/reads-v2'
import { agreedFinalizedBlock, codeAt, EscrowRpcError, waitForReceiptFinal, type HostsConfig } from '../runbook/rpc'
import { sentenceOf } from './api'
import type { EscrowApiV2, EscrowPublicConfigV2 } from './api-v2'
import type { BatchSigner } from './load'
import { utf8 } from './primitives'
import type { DeviceBookV2, ListingRecordV2 } from './records-v2'
import { sealInBrowser } from './seal'
import { LISTING_CLOSED_SENTENCE, LISTING_DAYS, sellInputProblems, SellRefused, type PayoutSigner, type SellInput } from './sell'
import type { ChainAccess, DeviceWallet } from './wallet'

/** Off the price of a leftover no deposit covers: the documented 25% (src/lib/barcode/relist.ts), on the price only (decision 3). */
export const REMAINDER_HAIRCUT_BPS = 2_500
/** SalvoEscrowV2's NEW_SELLER_BLIND_CAP_CENTS: V2 keeps its own paidOut, so V1's sales do not lift it. */
const NEW_SELLER_BLIND_CAP_CENTS_V2 = 2_500
const LIST_FEE_SENTENCE = 'Listing pays a small network fee from your test dollars, and this account has none. Tap Get test dollars first.'
const CANCEL_FEE_SENTENCE = 'Taking a card back pays a small network fee from your test dollars, and this account has none. Tap Get test dollars first.'
const REVIEW_FEE_SENTENCE = 'Answering pays a small network fee from your test dollars, and this account has none. Tap Get test dollars first.'
/** SalvoEscrowV2's BOND_REVIEW_AFTER and BOND_MAX_AGE: the seller may answer from five days, until the deposit goes back at seven. */
const REVIEW_AFTER_S = 432_000
const REVIEW_UNTIL_S = 604_800
const RESEND_LATER = 'Salvo did not take it yet. Try again in a minute.'
const POST_TRIES = 6
const POST_PAUSE_MS = 1_500
const ZERO32: Hex = `0x${'0'.repeat(64)}`

const lower = (s: string): Hex => s.toLowerCase() as Hex
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface SellDepsV2 {
  book: DeviceBookV2
  api: EscrowApiV2
  config: EscrowPublicConfigV2
  access: ChainAccess
  /** The seller's V2 access key: `list` and `cancelListing` only. */
  wallet: BatchSigner
  sleep?: (ms: number) => Promise<void>
}

/** True when this account would pay its own fee and holds less than a cent of test dollars. */
async function cannotPayFee(d: { access: ChainAccess; wallet: { account: Hex } }): Promise<boolean> {
  if (d.access.sponsorUrl !== null) return false
  const block = await agreedFinalizedBlock(d.access.hosts)
  return (await tokenBalanceAt(d.access.hosts, block, PATH_USD, d.wallet.account)) < BigInt(UNITS_PER_CENT)
}

/** A node's refusal for want of funds: definite, so the batch is not on its way anywhere. */
function refusedForFee(err: unknown): boolean {
  return err instanceof EscrowRpcError && (err.kind === 'rpc' || err.kind === 'revert') && /insufficient|funds|balance|fee/i.test(err.message)
}

/** Why the escrow on chain is not the V2 this page trusts, on both hosts at one finalized block: its code, signer and token. */
async function escrowProblemsV2(hosts: HostsConfig, cfg: EscrowPublicConfigV2): Promise<{ problems: string[]; time: number }> {
  const block = await agreedFinalizedBlock(hosts)
  const problems: string[] = []
  const code = await codeAt(hosts, block, cfg.escrow)
  if (keccak256(code) !== cfg.escrowCodehash) problems.push('the escrow on chain is not the code this page trusts')
  else {
    const g = await gateV2At(hosts, block, cfg.escrow, ZERO32, 0n)
    if (g.signer !== cfg.identity) problems.push("the escrow's signer is not the card service this page trusts")
    if (g.token !== PATH_USD) problems.push("the escrow's token is not pathUSD")
  }
  return { problems, time: Number(block.timestamp) }
}

function randomSalt(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(32))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export interface SealedListingV2 {
  manifest: string
  envelope: LitEnvelope
  commitment: Hex
  listingId: Hex
  listingExpiry: number
  cardFingerprint: Hex
}

/**
 * Write the V2 manifest, fingerprint the card, and seal it, in this browser.
 * The plaintext bytes are zeroed before this returns.
 */
export async function sealListingV2(cfg: EscrowPublicConfigV2, seller: Hex, input: SellInput, chainTime: number): Promise<SealedListingV2> {
  const merchant = ESCROW_MERCHANTS[input.merchant]
  const listingExpiry = chainTime + LISTING_DAYS * 86_400
  const manifest = buildEscrowManifestV2({
    escrow: cfg.escrow,
    seller,
    merchant: merchant.id,
    mode: MODE_BLIND,
    valueCents: input.valueCents,
    price: input.priceCents * UNITS_PER_CENT,
    residualCapCents: residualCapLimitV2(merchant, MODE_BLIND),
    remainderHaircutBps: REMAINDER_HAIRCUT_BPS,
    listingExpiry,
    salt: randomSalt(),
  })
  const m = parseEscrowManifestV2(manifest, cfg.escrow)
  if (m === null) throw new SellRefused('Those listing terms are not ones the escrow accepts.')
  // From the number the seal carries, before sealing: the same card gives the same fingerprint on any device.
  const fingerprint = await cardFingerprint(merchant.id, input.cardNumber)
  const plain = utf8(JSON.stringify({ cardNumber: input.cardNumber, pin: input.pin }))
  let envelope: LitEnvelope
  try {
    envelope = await sealInBrowser(cfg.encPub, plain, manifest)
  } finally {
    plain.fill(0)
  }
  const c = commitmentV2(m.chainId, cfg.escrow, PATH_USD, termsOfManifestV2(m), envelopeHashOf(envelope))
  const listingId = listingIdOf(m.seller, c)
  if (listingId !== listingIdOfSealV2(m, envelope)) throw new Error('the listing id does not match its own seal')
  return { manifest, envelope, commitment: c, listingId: lower(listingId), listingExpiry, cardFingerprint: fingerprint }
}

/** Why our server would not take this listing: its sentence when it gave one, ours otherwise. */
const refusalOf = (a: { status: number; body: Record<string, unknown> }, fallback: string): string => sentenceOf(a, fallback)

/**
 * List one card on V2: check the escrow, fingerprint and seal in this
 * browser, sign `list`, ask our server first (it checks the fingerprint
 * against both escrows before anything is sent), send it, wait for it to be
 * final, and record it. Returns the stored listing. Throws SellRefused with a
 * sentence; `sentOnChain` says whether the listing reached the chain.
 */
export async function listCardV2(
  d: SellDepsV2,
  input: SellInput,
  onStep: (s: 'checking' | 'sealing' | 'listing' | 'recording') => void = () => {},
  opts: { fromCard?: string; fromOwn?: string } = {},
): Promise<ListingRecordV2> {
  const sleep = d.sleep ?? realSleep
  if (!d.config.listingOpen) throw new SellRefused(LISTING_CLOSED_SENTENCE)
  const problems = sellInputProblems(input)
  if (problems.length > 0) throw new SellRefused(problems.join(' '))

  onStep('checking')
  const { problems: chainProblems, time } = await escrowProblemsV2(d.access.hosts, d.config)
  if (chainProblems.length > 0) throw new SellRefused(`This page will not list: ${chainProblems.join('; ')}. Nothing was sent.`)
  if (input.valueCents > NEW_SELLER_BLIND_CAP_CENTS_V2) {
    const block = await agreedFinalizedBlock(d.access.hosts)
    const stats = await sellerStatsV2At(d.access.hosts, block, d.config.escrow, d.wallet.account)
    if (stats.paidOut < BigInt(input.valueCents) * BigInt(UNITS_PER_CENT)) {
      throw new SellRefused(
        'New sellers can list cards up to $25 here. Bigger cards open up once your finished sales on the new escrow have paid you at least the card value. Nothing was sent.',
      )
    }
  }
  if (await cannotPayFee(d)) throw new SellRefused(`${LIST_FEE_SENTENCE} Nothing was sent.`)

  onStep('sealing')
  const sealed = await sealListingV2(d.config, d.wallet.account, input, time)
  const signed = await d.wallet.signCalls(
    [{ to: d.config.escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'list', args: [sealed.commitment] }) }],
    d.access,
  )
  const record: ListingRecordV2 = {
    version: 2,
    listingId: sealed.listingId,
    seller: d.wallet.account,
    merchant: input.merchant,
    valueCents: input.valueCents,
    priceUnits: input.priceCents * UNITS_PER_CENT,
    listingExpiry: sealed.listingExpiry,
    manifest: sealed.manifest,
    envelope: sealed.envelope,
    cardFingerprint: sealed.cardFingerprint,
    txHash: signed.hash,
    posted: false,
    createdAt: Date.now(),
    ...(opts.fromCard === undefined ? {} : { fromCard: opts.fromCard }),
    ...(opts.fromOwn === undefined ? {} : { fromOwn: opts.fromOwn }),
  }

  // Asked first, with nothing sent: the fingerprint is checked against both
  // escrows before the chain is read, so "not on chain yet" means go on.
  const first = await d.api.listing(sealed.manifest, sealed.envelope, signed.hash, sealed.cardFingerprint)
  if (first.status === 0) throw new SellRefused('We could not reach Salvo. Nothing was sent.')
  if (!(first.status === 409 && first.body.error === 'not_on_chain_yet') && first.status !== 200 && first.status !== 201) {
    throw new SellRefused(refusalOf(first, 'Salvo will not take that listing. Nothing was listed.'))
  }
  await d.book.saveListing(record)

  onStep('listing')
  let final: Awaited<ReturnType<typeof waitForReceiptFinal>>
  try {
    await d.wallet.broadcast(signed, d.access)
    final = await waitForReceiptFinal(d.access.hosts, signed.hash)
  } catch (err) {
    if (refusedForFee(err)) {
      await d.book.deleteListing(record.listingId)
      throw new SellRefused(`${LIST_FEE_SENTENCE} Nothing was listed.`)
    }
    throw new SellRefused('We could not confirm the listing went through. It is saved on this device; its state shows below.', true)
  }
  const listed = escrowEventsV2(final.receipt, d.config.escrow, 'Listed').some((e) => lower(e.listingId) === sealed.listingId)
  if (final.receipt.status !== 'success' || !listed) {
    // Nothing was listed, so nothing is kept that says it was: a card sold from store credit stays credit.
    await d.book.deleteListing(record.listingId)
    throw new SellRefused('The chain did not take the listing. Nothing was listed.', false)
  }

  onStep('recording')
  for (let i = 0; i < POST_TRIES; i++) {
    const a = await d.api.listing(sealed.manifest, sealed.envelope, signed.hash, sealed.cardFingerprint)
    if (a.status === 200 || a.status === 201) {
      record.posted = true
      await d.book.saveListing(record)
      return record
    }
    if (!(a.status === 409 && a.body.error === 'not_on_chain_yet')) {
      throw new SellRefused(`${refusalOf(a, 'Salvo did not record the listing.')} It is listed on chain; you can take it back below.`, true)
    }
    await sleep(POST_PAUSE_MS)
  }
  throw new SellRefused('Salvo has not seen the listing yet. It is listed on chain; try again in a minute.', true)
}

/**
 * Send a V2 listing again to our server, for one that reached the chain but
 * not our book. Null once it is recorded; otherwise the sentence to show.
 */
export async function recordListingV2(d: Pick<SellDepsV2, 'api' | 'book'>, r: ListingRecordV2): Promise<string | null> {
  if (r.txHash === null) return 'This listing was never sent to the chain, so Salvo cannot record it.'
  const a = await d.api.listing(r.manifest, r.envelope, r.txHash, r.cardFingerprint)
  if (a.status === 200 || a.status === 201) {
    r.posted = true
    await d.book.saveListing(r)
    return null
  }
  const passing = a.status === 0 || a.status === 429 || a.status >= 500 || (a.status === 409 && a.body.error === 'not_on_chain_yet')
  return passing ? RESEND_LATER : sentenceOf(a, RESEND_LATER)
}

/**
 * What the chain says about a V2 listing: V1's four states, with V2's two
 * ends. A listing stays for sale after a sale that leaves cents on the card.
 *   listed: for sale, whole or what is left of it. drained: used up.
 *   cancelled: taken back (or marked used by the seller). spent: a leftover
 *   found empty, its deposit paid to the seller.
 */
export type ListingStateV2 = 'not_on_chain' | 'listed' | 'drained' | 'cancelled' | 'spent'

/** The latest sale of a V2 listing, from getDeposit on both hosts: its state, never an event's name. */
export interface SaleViewV2 {
  depositId: string
  state: 'held' | 'paid' | 'refunded' | 'contested'
  releaseAt: number
  disputed: boolean
  /** What the sale holds for the seller now, or what it paid. */
  amountUnits: bigint
  usedCents: number
  /** Until when the next shopper may say a leftover it used was empty (chain seconds), 0 if it used none: release waits for it too. */
  contestUntil: number
}

export interface ListingViewV2Seller {
  state: ListingStateV2
  /** What is left to sell: the card's value before the first sale. */
  remainingCents: number
  sales: number
  /** A shopper's deposit covers what is left (5 days on, the seller may say whether it was spent). */
  covered: boolean
  /**
   * When the seller may say whether the leftover is still there (chain
   * seconds): from five days after the deposit started covering it until it
   * goes back by rule at seven. Null when no deposit covers it. The page
   * shows "Still there / It's gone" while the chain's time is in it.
   */
  review: { from: number; until: number } | null
  lastSale: SaleViewV2 | null
}

const LISTING_STATE_NAMES: Readonly<Record<number, ListingStateV2>> = { 1: 'listed', 2: 'drained', 3: 'cancelled', 4: 'spent' }
const SALE_STATE_NAMES: Readonly<Record<number, SaleViewV2['state']>> = { 1: 'held', 2: 'paid', 3: 'refunded', 4: 'contested' }

/**
 * What the chain says about each of this seller's V2 listings, at one
 * finalized block on both hosts.
 */
export async function listingStatesV2(access: ChainAccess, cfg: EscrowPublicConfigV2, rs: readonly ListingRecordV2[]): Promise<{ views: Map<Hex, ListingViewV2Seller>; chainTime: number }> {
  const views = new Map<Hex, ListingViewV2Seller>()
  const block = await agreedFinalizedBlock(access.hosts)
  for (const r of rs) {
    const l = await listingV2At(access.hosts, block, cfg.escrow, r.listingId)
    const state = LISTING_STATE_NAMES[l.state] ?? 'not_on_chain'
    let lastSale: SaleViewV2 | null = null
    if (l.lastDeposit !== 0n) {
      const dep = await depositV2At(access.hosts, block, cfg.escrow, l.lastDeposit)
      const name = SALE_STATE_NAMES[dep.state]
      if (name !== undefined && dep.listingId === r.listingId && dep.seller === lower(r.seller)) {
        lastSale = {
          depositId: l.lastDeposit.toString(),
          state: name,
          releaseAt: dep.releaseAt,
          disputed: dep.disputed,
          amountUnits: dep.amount,
          usedCents: dep.usedCents,
          contestUntil: dep.contestUntil,
        }
      }
    }
    views.set(r.listingId, {
      state,
      remainingCents: l.sales === 0 ? r.valueCents : l.remainingCents,
      sales: l.sales,
      covered: l.bondDeposit !== 0n,
      review: l.bondDeposit === 0n || l.state !== V2_STATE.listing.ACTIVE ? null : { from: l.bondSince + REVIEW_AFTER_S, until: l.bondSince + REVIEW_UNTIL_S },
      lastSale,
    })
  }
  return { views, chainTime: Number(block.timestamp) }
}

/**
 * Take a V2 listing back, or mark its leftover "I used it myself":
 * `cancelListing` with the seller's access key, final on both hosts. Any
 * deposit on the leftover goes back to its shopper.
 */
export async function cancelListingV2(d: Pick<SellDepsV2, 'access' | 'config' | 'wallet'>, r: ListingRecordV2): Promise<void> {
  if (await cannotPayFee(d)) throw new SellRefused(`${CANCEL_FEE_SENTENCE} Nothing was sent.`)
  const signed = await d.wallet.signCalls(
    [{ to: d.config.escrow, data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'cancelListing', args: [r.listingId] }) }],
    d.access,
  )
  try {
    await d.wallet.broadcast(signed, d.access)
  } catch (err) {
    if (refusedForFee(err)) throw new SellRefused(`${CANCEL_FEE_SENTENCE} Nothing was sent.`)
    throw err
  }
  const { receipt } = await waitForReceiptFinal(d.access.hosts, signed.hash)
  if (receipt.status !== 'success') throw new SellRefused('The chain did not take that back. Another shopper may be using it right now.', true)
}

/**
 * The seller's answer about a leftover a shopper's deposit still covers,
 * five to seven days after it started (spec sections 4 and 7.1). "Still
 * there" (`spent` false): the deposit goes back to its shopper and the
 * leftover stays for sale, with no deposit and the haircut on its price.
 * "It's gone" (`spent` true): the deposit, at face, pays this seller, and
 * the listing closes as spent. Checked first on both hosts, so a call the
 * contract would refuse is refused here with words; signed by the passkey
 * (one Face ID); read back after.
 */
export async function closeRemainderV2(
  d: { access: ChainAccess; config: EscrowPublicConfigV2; wallet: Pick<DeviceWallet, 'account' | 'closeRemainderV2'> },
  r: ListingRecordV2,
  spent: boolean,
): Promise<void> {
  const block = await agreedFinalizedBlock(d.access.hosts)
  const l = await listingV2At(d.access.hosts, block, d.config.escrow, r.listingId)
  const now = Number(block.timestamp)
  if (l.seller !== lower(d.wallet.account)) throw new SellRefused('That listing is not yours to answer for. Nothing was sent.')
  if (l.state !== V2_STATE.listing.ACTIVE || l.bondDeposit === 0n) throw new SellRefused('No shopper is holding a deposit on what is left of that card now, so there is nothing to answer. Nothing was sent.')
  if (now < l.bondSince + REVIEW_AFTER_S) {
    throw new SellRefused('You can say what became of the rest of that card five days after its last sale. Nothing was sent.')
  }
  if (spent && now >= l.bondSince + REVIEW_UNTIL_S) {
    throw new SellRefused("The shopper's deposit on the rest of that card has gone back to them by rule, so it can no longer be claimed. Nothing was sent.")
  }
  if (await cannotPayFee({ access: d.access, wallet: d.wallet })) throw new SellRefused(`${REVIEW_FEE_SENTENCE} Nothing was sent.`)
  await d.wallet.closeRemainderV2(d.config.escrow, r.listingId, spent, d.access)
  const after = await listingV2At(d.access.hosts, await agreedFinalizedBlock(d.access.hosts), d.config.escrow, r.listingId)
  const done = spent ? after.state === V2_STATE.listing.SPENT : after.state === V2_STATE.listing.ACTIVE && after.bondDeposit === 0n
  if (!done) throw new SellRefused('The chain does not show your answer yet. Look again in a minute.', true)
}

/** When a V2 sale may be paid out: release() waits for its own time and for its contest window, whichever is later. */
export function saleDueAtV2(sale: Pick<SaleViewV2, 'releaseAt' | 'contestUntil'>): number {
  return Math.max(sale.releaseAt, sale.contestUntil)
}

/**
 * Get paid now for a V2 listing's latest sale that is due: the escrow's
 * release(id), from the seller's own account with Face ID (the seller's
 * access key may only list and cancel), final on both hosts. release pays
 * only the sale's seller, so this can only pay this seller. Salvo's keeper
 * sends it too; this does not wait on it. A sale an earlier shopper's
 * report holds, or one refunded, is refused here with words.
 */
export async function collectPayoutV2(d: Pick<SellDepsV2, 'access' | 'config'>, signer: PayoutSigner, r: ListingRecordV2): Promise<void> {
  const { views, chainTime } = await listingStatesV2(d.access, d.config, [r])
  const sale = views.get(r.listingId)?.lastSale ?? null
  if (sale === null) throw new SellRefused('We cannot find a sale of this card on the chain yet. Try again in a minute.')
  if (sale.state === 'paid') return
  if (sale.state !== 'held') throw new SellRefused('That sale was refunded, so there is nothing to collect.')
  if (chainTime < saleDueAtV2(sale)) throw new SellRefused('That sale is not due yet. Nothing was sent.')
  await signer.releasePayout(d.config.escrow, BigInt(sale.depositId), d.access)
}

/** What SalvoEscrowV2 holds for `seller` because the token would not send a payout when it was due. */
export async function owedToV2(access: ChainAccess, cfg: Pick<EscrowPublicConfigV2, 'escrow'>, seller: Hex): Promise<bigint> {
  return owedV2At(access.hosts, await agreedFinalizedBlock(access.hosts), cfg.escrow, lower(seller))
}

/** Collect what SalvoEscrowV2 owes this seller: claim(seller), with Face ID. Nothing owed sends nothing. */
export async function collectOwedV2(d: Pick<SellDepsV2, 'access' | 'config'> & { wallet: { account: Hex } }, signer: PayoutSigner): Promise<void> {
  if ((await owedToV2(d.access, d.config, d.wallet.account)) === 0n) return
  await signer.claimOwed(d.config.escrow, d.access)
}

/**
 * Remove a V2 listing this browser kept that never reached the chain. One
 * the chain has stays: its row is how the seller sees it and takes it back.
 */
export async function forgetListingV2(d: Pick<SellDepsV2, 'access' | 'config' | 'book'>, r: ListingRecordV2): Promise<void> {
  const { views } = await listingStatesV2(d.access, d.config, [r])
  if (views.get(r.listingId)?.state !== 'not_on_chain') throw new SellRefused('This listing is on the chain, so it stays here.')
  await d.book.deleteListing(r.listingId)
}

/**
 * The V2 listing file: the manifest and envelope, with the chain facts to
 * find the listing. Ciphertext and public terms only; the fingerprint stays
 * out, since a file passed around is not the place for it.
 */
export function listingFileTextV2(r: ListingRecordV2, cfg: EscrowPublicConfigV2): string {
  return JSON.stringify(
    { kind: 'salvo-escrow-listing/2', chainId: cfg.chainId, escrow: cfg.escrow, listingId: r.listingId, listTx: r.txHash, manifest: r.manifest, envelope: r.envelope },
    null,
    2,
  )
}

