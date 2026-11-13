/**
 * Escrow listings on our side: accept one a seller's browser sealed, read one
 * back, and show the book as store totals (spec sections 8.2 and 12).
 *
 * WHAT WE HOLD, AND WHAT WE DO NOT. The seller's page seals the card to the
 * template's pinned key and lists its commitment on chain from the seller's
 * own account. We are sent the manifest, the envelope and the list
 * transaction's hash: ciphertext and public terms, never the card. We hold
 * no key that can open it. The row we write is a pointer the matcher can
 * quote and the ticket and release routes can relay to Lit.
 *
 * WHAT WE CHECK before writing, cheapest first, so a refusal costs nothing:
 *   1. The template is intact and fully pinned (escrow, identity, encPub).
 *   2. The manifest is one the template would accept, for the escrow it pins.
 *   3. The envelope has the template's exact shape.
 *   4. The seller is on the testnet allowlist, when one is set. Empty means
 *      anyone may list on the testnet.
 *   5. The custody guard lets this browser-sealed ref be recorded. On the
 *      testnet it is asked about the operator (TESTNET_LISTING_OWNER): the
 *      custody review refused the non-custodial flip while buyers pay with
 *      free test dollars, so a listing here is the operator's own card.
 *   6. The chain, read on both pinned hosts: the listing the manifest and
 *      envelope hash to is Active, for that seller, on an escrow whose signer
 *      is the pinned identity and whose token is pathUSD, and it is not about
 *      to expire. A blind card over $25 needs its seller already paid at
 *      least its value (the contract's new-seller cap): otherwise every buyer
 *      is refused, so the listing could only ever waste tickets. That figure
 *      only grows, so one check here is enough. This is the one step that
 *      costs anything, so the route limits it per address and per seller.
 *
 * The listing's state after that is the chain's, and only the keeper moves it.
 *
 * V1 FREEZES ONCE V2 IS OPEN (config-v2.ts escrowV2Live): from then this
 * refuses every V1 listing, and listing-v2.ts takes listings for
 * SalvoEscrowV2. Until then every V1 listing must carry the card fingerprint
 * the seller's page computed (card-fingerprint.ts), kept with it, so a card
 * sold here can be found, and refused, there.
 *
 * Server-only. The chain reads go to the network; nothing else does.
 */

import { Prisma } from '@prisma/client'
import type { Hex } from 'viem'
import { prisma } from '@/lib/db'
import type { AccountOwner } from '@/lib/supply/accounts'
import { assertSealedRefAllowedForOwner, CustodialVaultRefusedError } from '@/lib/vault/guard'
import { CHIPOTLE_ESCROW_ALGORITHM } from '@/lib/vault/escrow-backend'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { templateIntegrity, type EscrowTemplate, type EscrowTemplateId } from '@/lib/vault/lit/templates'
import { LIT_NETWORK } from '@/lib/vault/lit/transport'
import { parseCardFingerprint } from './card-fingerprint'
import { escrowReader, LISTING_STATE } from './chain'
import { B64_RE, pointBytes } from './client/primitives'
import { escrowV1Frozen } from './config-v2'
import { escrowPinProblems } from './deployment'
import { listingIdOfSeal } from './hashes'
import { NEW_SELLER_BLIND_CAP_CENTS } from './runbook/reads'
import { buildEscrowManifest, parseEscrowManifest, PATH_USD, UNITS_PER_CENT, type EscrowManifest } from './manifest'
import { ESCROW_MERCHANTS, escrowMerchantById, MODE_BLIND, type EscrowMerchantName } from './merchants'
import { ESCROW_INTENT_FORM_FACTOR, escrowIntentIdFor } from './refs'
import { escrowRuntime, type EscrowRuntime } from './runtime'
import { parseEscrowSealRecord, type EscrowSealRecord } from './seal-record'

/** The template's ticket gate refuses a listing whose expiry is this close to the chain's time. */
const EXPIRY_MARGIN_S = 60
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
/** The template's envelope byte bounds (readEnvelope): ciphertext 1..512, IV 12, tag 16. */
const CT_MAX_BYTES = 512
/**
 * A listing Lit refused a ticket for is "suspect": kept out of quotes. The
 * mark lives in the offered intent's failureReason (no new column), which no
 * other path reads for an escrow row.
 */
const SUSPECT_PREFIX = 'escrow_suspect|'
/**
 * Marks that pass, forgiven after an hour: a balance reader that could not
 * answer is not the seller's fault, and a card whose last purchase is not
 * paid out yet becomes the seller's to sell once it is (a day, or three
 * after a dispute). Every other mark stays.
 */
const PASSING_SUSPECT_MS = 60 * 60_000
const PASSING_SUSPECTS: ReadonlySet<string> = new Set(['balance_unavailable', 'card_not_paid_out'])

export type ListingRefusal =
  | 'not_ready'
  | 'bad_manifest'
  | 'bad_envelope'
  | 'bad_tx'
  | 'seller_not_allowed'
  | 'custody_refused'
  | 'not_on_chain_yet'
  | 'listing_closed'
  | 'wrong_escrow'
  | 'expiring'
  | 'new_seller_cap'
  | 'slow_down'
  /** V2 is open (config-v2.ts escrowV2Live): V1 takes no new listings. */
  | 'v1_frozen'
  /** The card fingerprint is missing or malformed. */
  | 'bad_fingerprint'
  /** Another listing of the same card is still for sale, on either escrow. */
  | 'card_listed'
  /** The card was sold through Salvo to someone else. */
  | 'card_sold'
  /** The seller bought this card and that purchase is not paid out yet. */
  | 'card_not_paid_out'
  /** The seller has a V1 sale at this store that carries no fingerprint, so no card of theirs there can be checked on V2 yet. */
  | 'card_unmatched'

/** Why a listing was not recorded, with the status and the sentence the route sends. */
export class EscrowListingRefusedError extends Error {
  readonly code: ListingRefusal
  readonly status: number

  constructor(code: ListingRefusal, status: number, sentence: string) {
    super(sentence)
    this.name = 'EscrowListingRefusedError'
    this.code = code
    this.status = status
  }
}

const NOTHING = 'Nothing was listed.'
const refuse = (code: ListingRefusal, status: number, sentence: string): EscrowListingRefusedError =>
  new EscrowListingRefusedError(code, status, `${sentence} ${NOTHING}`)
/** The same refusal, for listing-v2.ts: one error type and one sentence ending for both escrows. */
export const refuseListing = refuse

/** The envelope, if `value` has exactly the template's four fields in its exact formats. */
export function parseEnvelope(value: unknown): LitEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const e = value as Record<string, unknown>
  if (Object.keys(e).sort().join(',') !== 'ct,eph,iv,tag') return null
  const { ct, eph, iv, tag } = e
  if (typeof ct !== 'string' || typeof eph !== 'string' || typeof iv !== 'string' || typeof tag !== 'string') return null
  const bytes = (s: string): number | null => (s.length <= 1024 && B64_RE.test(s) ? Buffer.from(s, 'base64').length : null)
  const ctLen = bytes(ct)
  if (ctLen === null || ctLen < 1 || ctLen > CT_MAX_BYTES || bytes(iv) !== 12 || bytes(tag) !== 16) return null
  try {
    pointBytes(eph)
  } catch {
    return null
  }
  return { ct, eph, iv, tag }
}

/** Why this template cannot take or sell a listing yet, or null when it can. V1's or V2's. */
export function templateNotReady(t: EscrowTemplate<EscrowTemplateId>): string | null {
  if (!templateIntegrity(t).intact) return 'the escrow template no longer matches its pins'
  if (t.escrowAddress === null || escrowPinProblems(t).length > 0) return 'the escrow address is not pinned'
  if (t.identity === null) return "the escrow template's signer is not pinned"
  if (t.encPub === null) return "the escrow template's sealing key is not pinned"
  return null
}

/**
 * WHO A TESTNET LISTING BELONGS TO, FOR THE CUSTODY GUARD.
 *
 * On a testnet the only sellers are the addresses on the test list, and they
 * are the operator's own wallets: a real card listed there (the operator's own
 * Target card, for a till test) is the operator's card. Buyers pay with free
 * test dollars, so the escrow's "seller paid before the card opens" protects
 * nothing for a real card, and calling such a listing non-custodial would be
 * false. So the guard is asked about the operator, whose own cards it allows
 * under any backend, and NON_CUSTODIAL_BACKENDS stays empty: the custody
 * review (custody.md) blocked the flip for exactly this reason. Anyone with
 * test dollars can buy a listing; the operator accepts that for their own card.
 */
export const TESTNET_LISTING_OWNER: AccountOwner = { kind: 'operator', ownerId: 'operator:0' }

/** Seller addresses allowed to list on testnet, lower-case. */
export function sellerAllowlist(env: Readonly<Record<string, string | undefined>> = process.env): ReadonlySet<string> {
  return new Set(
    (env.ESCROW_SELLER_ALLOWLIST ?? '')
      .split(/[\s,]+/)
      .filter((p) => ADDRESS_RE.test(p))
      .map((p) => p.toLowerCase()),
  )
}

/** A stand-in envelope with the template's exact shape, for asking the guard a question. Opens nothing. */
export const PROBE_ENVELOPE: LitEnvelope = {
  ct: 'AA==',
  // The secp256k1 generator, compressed: a valid point, and nobody's key.
  eph: '0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  iv: 'AAAAAAAAAAAAAAAA',
  tag: 'AAAAAAAAAAAAAAAAAAAAAA==',
}

/**
 * Would this server take a listing today? The template is pinned and the
 * custody guard allows a listing of this template by the testnet owner: the
 * same guard call acceptSealedListing makes, on a stand-in listing.
 *
 * The seller's page reads it from GET /api/escrow/config and says "not open
 * yet" before any field, instead of after the card is typed and sealed.
 * Whether one particular seller is on the list cannot be known before their
 * account exists, so that refusal still comes from the listing itself.
 */
export function escrowListingOpen(rt: EscrowRuntime = escrowRuntime()): boolean {
  const t = rt.template
  if (templateNotReady(t) !== null || t.escrowAddress === null) return false
  // V1 takes nothing new once V2 is open (config-v2.ts escrowV2Live).
  if (escrowV1Frozen(rt)) return false
  // Any seller will do for the question: the guard is asked about the
  // operator (TESTNET_LISTING_OWNER), and an empty test list means anyone.
  const seller = ([...sellerAllowlist()][0] ?? '0x0000000000000000000000000000000000000001') as Hex
  const nowS = Math.floor(rt.now() / 1000)
  const manifestText = buildEscrowManifest({
    escrow: t.escrowAddress,
    seller,
    merchant: ESCROW_MERCHANTS.salvotest.id,
    mode: MODE_BLIND,
    valueCents: 100,
    price: 100 * UNITS_PER_CENT,
    residualCapCents: 0,
    listingExpiry: nowS + 86_400,
    salt: '0'.repeat(64),
  })
  const m = parseEscrowManifest(manifestText, t.escrowAddress)
  if (m === null) return false
  const ref = sealedRefFor(t, m, manifestText, PROBE_ENVELOPE, listingIdOfSeal(m, PROBE_ENVELOPE), new Date(rt.now()), null)
  try {
    assertSealedRefAllowedForOwner(ref, TESTNET_LISTING_OWNER)
    return true
  } catch (err) {
    if (err instanceof CustodialVaultRefusedError) return false
    throw err
  }
}

/**
 * The sealed ref an escrow listing is stored as (spec section 12, with
 * seal-record.ts's correction). `cardFingerprint`, when the seller's page
 * sent one, rides beside it: a keyless, slow hash of the card
 * (card-fingerprint.ts), never the card. The JSON column takes the extra key
 * with no migration.
 */
function sealedRefFor(
  t: EscrowTemplate,
  m: EscrowManifest,
  manifestText: string,
  envelope: LitEnvelope,
  listingId: Hex,
  now: Date,
  cardFingerprint: Hex | null,
) {
  const lit: EscrowSealRecord = {
    v: 1,
    network: LIT_NETWORK,
    template: t.id,
    templateSha256: t.sha256,
    cid: t.cid,
    encPub: t.encPub ?? '',
    manifest: manifestText,
  }
  return {
    id: listingId,
    algorithm: CHIPOTLE_ESCROW_ALGORITHM,
    ciphertext: envelope.ct,
    iv: envelope.iv,
    authTag: envelope.tag,
    // The ephemeral public key: what the template's ECDH needs. Nothing here is wrapped.
    wrappedKey: envelope.eph,
    wrappedKeyIv: '',
    wrappedKeyAuthTag: '',
    conditionDigest: `escrow:${listingId}`,
    boundOrderId: null,
    lit,
    expiresAt: new Date(m.listingExpiry * 1000).toISOString(),
    sealedAt: now.toISOString(),
    ...(cardFingerprint === null ? {} : { cardFingerprint }),
  }
}

/**
 * The Intent row of an escrow listing whose checks have passed. Written by
 * acceptSealedListing; tests seed listings with it so they hold the real shape.
 */
export function escrowIntentData(
  t: EscrowTemplate,
  m: EscrowManifest,
  manifestText: string,
  envelope: LitEnvelope,
  now: Date,
  cardFingerprint: Hex | null = null,
): Prisma.IntentCreateInput {
  const listingId = listingIdOfSeal(m, envelope)
  const merchant = escrowMerchantById(m.merchant)
  if (merchant === null) throw new RangeError('the manifest names no merchant the escrow knows')
  const priceCents = Math.ceil(m.price / UNITS_PER_CENT)
  return {
    id: escrowIntentIdFor(listingId),
    state: 'offered',
    merchantId: merchant.name,
    accountId: `seller:${m.seller}`,
    formFactor: ESCROW_INTENT_FORM_FACTOR,
    faceValueCents: m.valueCents,
    priceCents,
    discountBps: Math.max(0, Math.round(((m.valueCents - priceCents) * 10_000) / m.valueCents)),
    expiresAt: new Date(m.listingExpiry * 1000),
    // Not known here, and not asked for: even four digits are card material
    // the seller's page has no reason to send us.
    last4: '',
    sealedRef: sealedRefFor(t, m, manifestText, envelope, listingId, now, cardFingerprint) as unknown as Prisma.InputJsonValue,
  }
}

/** A stored escrow listing, read back and checked against the running template. */
export interface EscrowSealedListing {
  listingId: Hex
  manifestText: string
  manifest: EscrowManifest
  envelope: LitEnvelope
}

/**
 * Read an escrow listing's sealed ref back from the database. Null unless it
 * names the running template by id, sha256 and CID, its manifest is one that
 * template accepts, and the manifest and envelope still hash to the listing id
 * it was stored under. A row edited since it was written is refused here, for
 * free, rather than by a paid Lit run.
 */
export function readEscrowSealedRef(value: Prisma.JsonValue, t: EscrowTemplate): EscrowSealedListing | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  if (o.algorithm !== CHIPOTLE_ESCROW_ALGORITHM) return null
  const record = parseEscrowSealRecord(o.lit)
  if (record === null || record.template !== t.id || record.templateSha256 !== t.sha256 || record.cid !== t.cid) return null
  const manifest = parseEscrowManifest(record.manifest, t.escrowAddress)
  if (manifest === null) return null
  const envelope = parseEnvelope({ ct: o.ciphertext, eph: o.wrappedKey, iv: o.iv, tag: o.authTag })
  if (envelope === null) return null
  const listingId = listingIdOfSeal(manifest, envelope)
  if (o.conditionDigest !== `escrow:${listingId}` || o.id !== listingId) return null
  return { listingId, manifestText: record.manifest, manifest, envelope }
}

export interface SealedListingInput {
  manifest: string
  envelope: unknown
  txHash: string
  /** card-fingerprint.ts, from the seller's page. Required on both escrows; a V1 page too old to send it is refused. */
  cardFingerprint?: unknown
}

export interface AcceptedListing {
  intentId: string
  listingId: Hex
  merchant: EscrowMerchantName
  /** Which escrow the listing is on. */
  version: 1 | 2
  /** False when this listing was already recorded: posting twice is one listing. */
  created: boolean
}

/**
 * Record a listing a seller's browser sealed and listed on chain. Throws
 * EscrowListingRefusedError with the status and sentence to send back.
 *
 * `mayReadChain` is asked once, after every free check and right before the
 * chain read, with the seller the listing names, and a false answer refuses
 * with 429. That read is about eight calls from our server to two public
 * hosts that throttle our address, and a listing that passes every free check
 * costs nobody anything to post: the poster need not be the seller, and
 * allowlisted sellers' addresses are public on chain. So the route limits it
 * per address and per seller, or one script could get our address throttled
 * and stop every quote, release check and payout with it, and a flood naming
 * one seller would stop every other seller listing too.
 */
export async function acceptSealedListing(
  input: SealedListingInput,
  rt: EscrowRuntime = escrowRuntime(),
  mayReadChain: (seller: Hex) => boolean = () => true,
): Promise<AcceptedListing> {
  const t = rt.template
  if (templateNotReady(t) !== null) throw refuse('not_ready', 503, 'Selling for dollars is not set up yet.')
  if (escrowV1Frozen(rt)) throw refuse('v1_frozen', 410, 'Listing on the old escrow has closed. Reload the page to list on the new one.')
  const m = typeof input.manifest === 'string' ? parseEscrowManifest(input.manifest, t.escrowAddress) : null
  if (m === null) throw refuse('bad_manifest', 400, 'The listing terms are not ones the escrow accepts.')
  const envelope = parseEnvelope(input.envelope)
  if (envelope === null) throw refuse('bad_envelope', 400, 'The sealed card is not in the shape the escrow expects.')
  if (typeof input.txHash !== 'string' || !TX_HASH_RE.test(input.txHash)) {
    throw refuse('bad_tx', 400, 'The listing transaction hash is missing or malformed.')
  }
  const merchant = escrowMerchantById(m.merchant)
  if (merchant === null) throw refuse('bad_manifest', 400, 'The listing terms are not ones the escrow accepts.')
  // Required on V1 too, until the freeze: a V1 card with no fingerprint
  // could never be found from V2, which cannot see V1's card tags.
  const fingerprint = parseCardFingerprint(input.cardFingerprint)
  if (fingerprint === null) {
    throw refuse('bad_fingerprint', 400, "The card's fingerprint is missing or not in the form the escrow expects. Reload the page and list it again.")
  }
  // ESCROW_SELLER_ALLOWLIST is optional on a testnet: empty means anyone may
  // list (the operator's call: nobody knows the rail is there, and a buyer
  // pays only test dollars). Set, it is the only sellers allowed.
  const testList = sellerAllowlist()
  if (testList.size > 0 && !testList.has(m.seller)) {
    throw refuse('seller_not_allowed', 403, 'This seller address is not on the test list yet.')
  }

  const now = new Date(rt.now())
  const listingId = listingIdOfSeal(m, envelope)
  const ref = sealedRefFor(t, m, input.manifest, envelope, listingId, now, fingerprint)

  // The custody guard, before any chain read: it is free. On a testnet the
  // test list is the operator's own wallets (TESTNET_LISTING_OWNER).
  try {
    assertSealedRefAllowedForOwner(ref, TESTNET_LISTING_OWNER)
  } catch (err) {
    if (err instanceof CustodialVaultRefusedError) {
      throw refuse('custody_refused', 403, 'Selling for dollars is not open yet.')
    }
    throw err
  }

  const reader = escrowReader(rt)
  if (reader === null) throw refuse('not_ready', 503, 'Selling for dollars is not set up yet.')
  if (!mayReadChain(m.seller)) throw refuse('slow_down', 429, 'Too many tries. Wait a minute and try again.')
  const block = await reader.block()
  const g = await reader.gate(block, listingId, 0n)
  if (g.signer !== t.identity || g.token !== PATH_USD) {
    throw refuse('wrong_escrow', 503, 'The escrow on chain is not the one this build trusts.')
  }
  if (g.listingState === LISTING_STATE.none) {
    throw refuse('not_on_chain_yet', 409, 'Your listing is not final on the chain yet. Try again in a few seconds.')
  }
  if (g.listingState !== LISTING_STATE.active || g.listingSeller !== m.seller) {
    throw refuse('listing_closed', 409, 'That listing is already sold or cancelled on the chain.')
  }
  if (Number(block.timestamp) + EXPIRY_MARGIN_S >= m.listingExpiry) {
    throw refuse('expiring', 400, 'That listing expires too soon to sell.')
  }
  if (m.mode === MODE_BLIND && m.valueCents > NEW_SELLER_BLIND_CAP_CENTS) {
    if ((await reader.sellerPaidOut(block, m.seller)) < BigInt(m.valueCents) * BigInt(UNITS_PER_CENT)) {
      throw refuse(
        'new_seller_cap',
        403,
        'New sellers can list cards up to $25 here. Bigger cards open up once your finished sales have paid you at least the card value.',
      )
    }
  }

  const intentId = escrowIntentIdFor(listingId)
  try {
    await prisma.intent.create({ data: escrowIntentData(t, m, input.manifest, envelope, now, fingerprint) })
  } catch (err) {
    // The same listing posted twice: one listing, already recorded.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { intentId, listingId, merchant: merchant.name, version: 1, created: false }
    }
    throw err
  }
  return { intentId, listingId, merchant: merchant.name, version: 1, created: true }
}

// ---------------------------------------------------------------------------
// Suspect listings
// ---------------------------------------------------------------------------

/**
 * Keep a listing out of quotes after Lit refused it a ticket. Only while it
 * is still offered: a sold or closed listing is the chain's to describe.
 */
export async function markListingSuspect(intentId: string, why: string, now: Date): Promise<void> {
  await prisma.intent.updateMany({
    where: { id: intentId, state: 'offered', formFactor: ESCROW_INTENT_FORM_FACTOR },
    data: { failureReason: `${SUSPECT_PREFIX}${why}|${now.toISOString()}` },
  })
}

/** Is this offered listing kept out of quotes right now? */
export function isSuspect(failureReason: string | null, now: Date): boolean {
  if (failureReason === null || !failureReason.startsWith(SUSPECT_PREFIX)) return false
  const [why, at] = failureReason.slice(SUSPECT_PREFIX.length).split('|')
  if (why === undefined || !PASSING_SUSPECTS.has(why)) return true
  const t = Date.parse(at ?? '')
  return !Number.isFinite(t) || now.getTime() - t < PASSING_SUSPECT_MS
}

// ---------------------------------------------------------------------------
// The book, as store totals
// ---------------------------------------------------------------------------

export interface EscrowStoreTotal {
  merchant: string
  cards: number
  totalValueCents: number
  /** The best discount on offer at this store, in basis points. */
  bestDiscountBps: number
}

/**
 * What is for sale on the escrow rail, per store: how many cards, their total
 * value and the best discount. Never a single listing, its terms or its
 * seller: the book is hidden (commit-reveal), so the public sees totals and a
 * shopper sees only the cards a quote picks for them.
 */
export async function escrowStoreTotals(now: Date = new Date(escrowRuntime().now())): Promise<EscrowStoreTotal[]> {
  const rows = await prisma.intent.findMany({
    where: { formFactor: ESCROW_INTENT_FORM_FACTOR, state: 'offered', expiresAt: { gt: now } },
    select: { merchantId: true, faceValueCents: true, lastKnownBalanceCents: true, discountBps: true, failureReason: true },
    take: 2_000,
  })
  const by = new Map<string, EscrowStoreTotal>()
  for (const r of rows) {
    if (isSuspect(r.failureReason, now)) continue
    const t = by.get(r.merchantId) ?? { merchant: r.merchantId, cards: 0, totalValueCents: 0, bestDiscountBps: 0 }
    t.cards += 1
    // A V2 card partly used is offered for what is left on it (keeper-v2.ts).
    t.totalValueCents += r.lastKnownBalanceCents ?? r.faceValueCents
    t.bestDiscountBps = Math.max(t.bestDiscountBps, r.discountBps)
    by.set(r.merchantId, t)
  }
  return [...by.values()].sort((a, b) => a.merchant.localeCompare(b.merchant))
}
