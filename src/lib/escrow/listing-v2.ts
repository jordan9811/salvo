/**
 * SalvoEscrowV2 listings on our side: accept one a seller's browser sealed for
 * salvo-vault-escrow/2, and read one back (unified spec sections 8 and 11).
 *
 * THE SAME CONTRACT WITH THE SELLER AS V1 (listing.ts): we are sent the
 * manifest, the envelope and the `list` transaction's hash, never the card,
 * and we hold no key that can open it. The same free checks run first, the
 * same custody guard is asked about the same testnet owner, and the one paid
 * step, the chain read on both hosts, is limited by the route.
 *
 * WHAT V2 ADDS.
 *   - The 14-key V2 manifest (manifest-v2.ts) and its listing id
 *     (hashes-v2.ts), on the V2 escrow, signed by V2's identity.
 *   - A card fingerprint, required (card-fingerprint.ts). Every listing of
 *     either escrow carrying the same one is found, and the card is refused
 *     while another listing of it is for sale, or once its newest sale went
 *     to someone else. That buyer may sell it on, once that purchase is paid
 *     out (spec section 11: a kept card sold back). V2 cannot see V1's card
 *     tags, so this is the only thing that stops a card sold on V1 being sold
 *     on V2. It is judged before the new listing's own chain read, so the
 *     seller's first post, sent before `list`, is refused before they pay a
 *     fee for a listing we would never record.
 *   - A V1 listing recorded before listings carried a fingerprint matches
 *     nothing, so a seller with one at a store lists nothing at that store
 *     here: until each such sale has its fingerprint, from its buyer's phone
 *     (recordV1FingerprintByBuyer, which Account calls through
 *     POST /api/escrow/fingerprint), and until each one still listed there
 *     is taken back. What the fingerprint does not stop, and what does, is in
 *     card-fingerprint.ts.
 *   - V2's own new-seller cap: V2 keeps its own paidOut, so a seller's V1
 *     sales do not lift it.
 *
 * Rows are the same Intent rows as V1's, told apart by the template their
 * sealed ref names. A partly used card stays `offered` with what is left in
 * lastKnownBalanceCents; only the keeper (keeper-v2.ts) moves it.
 *
 * Server-only. The chain reads go to the network; nothing else does.
 */

import { Prisma } from '@prisma/client'
import type { Hex } from 'viem'
import { prisma } from '@/lib/db'
import { assertSealedRefAllowedForOwner, CustodialVaultRefusedError } from '@/lib/vault/guard'
import { CHIPOTLE_ESCROW_ALGORITHM } from '@/lib/vault/escrow-backend'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { LIT_NETWORK } from '@/lib/vault/lit/transport'
import type { IntentState } from '@/lib/intent/types'
import { fingerprintVerdict, parseCardFingerprint, type FingerprintMatch } from './card-fingerprint'
import { escrowReader, LISTING_STATE } from './chain'
import { escrowReaderV2 } from './chain-v2'
import { ESCROW_CHAIN_KEY } from './config'
import { escrowV2Live, templateV2NotReady, type EscrowTemplateV2 } from './config-v2'
import { listingIdOfSealV2 } from './hashes-v2'
import { parseEnvelope, PROBE_ENVELOPE, readEscrowSealedRef, refuseListing, sellerAllowlist, TESTNET_LISTING_OWNER, type AcceptedListing } from './listing'
import { PATH_USD, UNITS_PER_CENT } from './manifest'
import { buildEscrowManifestV2, ESCROW_V2_TEMPLATE_ID, parseEscrowManifestV2, type EscrowManifestV2 } from './manifest-v2'
import { ESCROW_MERCHANTS, escrowMerchantById, MODE_BLIND, type EscrowMerchantName } from './merchants'
import { ESCROW_INTENT_FORM_FACTOR, escrowIntentIdFor, escrowPaymentRef } from './refs'
import { V2_STATE } from './runbook/reads-v2'
import { escrowRuntime, templateV2Of, type EscrowRuntime } from './runtime'
import { parseEscrowSealRecord, type EscrowSealRecord } from './seal-record'

/** The template's ticket gate refuses a listing whose expiry is this close to the chain's time. */
const EXPIRY_MARGIN_S = 60
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
/** SalvoEscrowV2's NEW_SELLER_BLIND_CAP_CENTS. */
const NEW_SELLER_BLIND_CAP_CENTS_V2 = 2_500
/** Listings carrying one fingerprint read per check. One card has a handful at most. */
const MAX_FINGERPRINT_MATCHES = 50
/** A seller's V1 sales at one store read per check. Reaching it counts as "not all fingerprinted": the check fails closed. */
const MAX_V1_SALES_READ = 500
const V1_TEMPLATE_ID = 'salvo-vault-escrow/1'
/** Rows that are a sale: the card left its seller. */
const SALE_STATES: IntentState[] = ['matched', 'executing', 'completed']

/** Which escrow a stored sealed ref is for, by the template it names: 1, 2, or null when it names neither. */
export function escrowVersionOfRef(value: unknown): 1 | 2 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const lit = (value as Record<string, unknown>).lit
  if (typeof lit !== 'object' || lit === null || Array.isArray(lit)) return null
  const template = (lit as Record<string, unknown>).template
  if (template === V1_TEMPLATE_ID) return 1
  if (template === ESCROW_V2_TEMPLATE_ID) return 2
  return null
}

/** The fingerprint stored with a listing's sealed ref, or null when it has none. */
function fingerprintOfRef(value: unknown): Hex | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return parseCardFingerprint((value as Record<string, unknown>).cardFingerprint)
}

/** The sealed ref a V2 listing is stored as: V1's shape, naming salvo-vault-escrow/2, with the card's fingerprint. */
function sealedRefForV2(
  t: EscrowTemplateV2,
  m: EscrowManifestV2,
  manifestText: string,
  envelope: LitEnvelope,
  listingId: Hex,
  now: Date,
  cardFingerprint: Hex,
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
    // The seal itself is V1's scheme (salvo/vault/seal/v1); the template is what changed.
    algorithm: CHIPOTLE_ESCROW_ALGORITHM,
    ciphertext: envelope.ct,
    iv: envelope.iv,
    authTag: envelope.tag,
    wrappedKey: envelope.eph,
    wrappedKeyIv: '',
    wrappedKeyAuthTag: '',
    conditionDigest: `escrow:${listingId}`,
    boundOrderId: null,
    lit,
    expiresAt: new Date(m.listingExpiry * 1000).toISOString(),
    sealedAt: now.toISOString(),
    cardFingerprint,
  }
}

/** The Intent row of a V2 listing whose checks have passed. */
export function escrowIntentDataV2(
  t: EscrowTemplateV2,
  m: EscrowManifestV2,
  manifestText: string,
  envelope: LitEnvelope,
  now: Date,
  cardFingerprint: Hex,
): Prisma.IntentCreateInput {
  const listingId = listingIdOfSealV2(m, envelope)
  const merchant = escrowMerchantById(m.merchant)
  if (merchant === null) throw new RangeError('the manifest names no merchant the escrow knows')
  const priceCents = Math.ceil(m.price / UNITS_PER_CENT)
  return {
    id: escrowIntentIdFor(listingId),
    state: 'offered',
    merchantId: merchant.name,
    accountId: `seller:${m.seller}`,
    formFactor: ESCROW_INTENT_FORM_FACTOR,
    // The whole card's terms. A sale's price is its share of these for the
    // cents it uses (the contract's priceFor), which is how the matcher
    // prices a leg too (legCostCents); what is left is lastKnownBalanceCents.
    faceValueCents: m.valueCents,
    priceCents,
    discountBps: Math.max(0, Math.round(((m.valueCents - priceCents) * 10_000) / m.valueCents)),
    expiresAt: new Date(m.listingExpiry * 1000),
    last4: '',
    sealedRef: sealedRefForV2(t, m, manifestText, envelope, listingId, now, cardFingerprint) as unknown as Prisma.InputJsonValue,
  }
}

/** A stored V2 listing, read back and checked against the running V2 template. */
export interface EscrowSealedListingV2 {
  listingId: Hex
  manifestText: string
  manifest: EscrowManifestV2
  envelope: LitEnvelope
  cardFingerprint: Hex | null
}

/**
 * Read a V2 listing's sealed ref back from the database. Null unless it names
 * the running V2 template by id, sha256 and CID, its manifest is one that
 * template accepts, and the manifest and envelope still hash to the listing
 * id it was stored under. As V1's readEscrowSealedRef: an edited row is
 * refused here, for free, rather than by a paid Lit run.
 */
export function readEscrowSealedRefV2(value: Prisma.JsonValue, t: EscrowTemplateV2): EscrowSealedListingV2 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  if (o.algorithm !== CHIPOTLE_ESCROW_ALGORITHM) return null
  const record = parseEscrowSealRecord(o.lit)
  if (record === null || record.template !== t.id || record.templateSha256 !== t.sha256 || record.cid !== t.cid) return null
  const manifest = parseEscrowManifestV2(record.manifest, t.escrowAddress)
  if (manifest === null) return null
  const envelope = parseEnvelope({ ct: o.ciphertext, eph: o.wrappedKey, iv: o.iv, tag: o.authTag })
  if (envelope === null) return null
  const listingId = listingIdOfSealV2(manifest, envelope)
  if (o.conditionDigest !== `escrow:${listingId}` || o.id !== listingId) return null
  return { listingId, manifestText: record.manifest, manifest, envelope, cardFingerprint: fingerprintOfRef(o) }
}

/**
 * Would this server take a V2 listing today? V2 is open (escrowV2Live) and the
 * custody guard allows a V2 listing by the testnet owner: the same guard call
 * acceptSealedListingV2 makes, on a stand-in listing. Served by the config
 * route, so the seller's page says "not open" before any field.
 */
export function escrowListingOpenV2(rt: EscrowRuntime = escrowRuntime()): boolean {
  const t = templateV2Of(rt)
  if (!escrowV2Live(rt) || t.escrowAddress === null) return false
  const seller = ([...sellerAllowlist()][0] ?? '0x0000000000000000000000000000000000000001') as Hex
  const manifestText = buildEscrowManifestV2({
    escrow: t.escrowAddress,
    seller,
    merchant: ESCROW_MERCHANTS.salvotest.id,
    mode: MODE_BLIND,
    valueCents: 100,
    price: 100 * UNITS_PER_CENT,
    residualCapCents: 0,
    remainderHaircutBps: 0,
    listingExpiry: Math.floor(rt.now() / 1000) + 86_400,
    salt: '0'.repeat(64),
  })
  const m = parseEscrowManifestV2(manifestText, t.escrowAddress)
  if (m === null) return false
  const listingId = listingIdOfSealV2(m, PROBE_ENVELOPE)
  const ref = sealedRefForV2(t, m, manifestText, PROBE_ENVELOPE, listingId, new Date(rt.now()), `0x${'0'.repeat(64)}`)
  try {
    assertSealedRefAllowedForOwner(ref, TESTNET_LISTING_OWNER)
    return true
  } catch (err) {
    if (err instanceof CustodialVaultRefusedError) return false
    throw err
  }
}

/** A row of either escrow that carries the fingerprint, before its chain state is known. */
interface FingerprintRow {
  id: string
  state: IntentState
  accountId: string
  matchedOrderId: string | null
  sealedRef: Prisma.JsonValue
  createdAt: Date
}

/** Every other listing, of either escrow, that carries `fingerprint`, newest first. */
async function rowsWithFingerprint(fingerprint: Hex, except: string): Promise<FingerprintRow[]> {
  const rows = await prisma.intent.findMany({
    where: { formFactor: ESCROW_INTENT_FORM_FACTOR, sealedRef: { path: ['cardFingerprint'], equals: fingerprint } },
    select: { id: true, state: true, accountId: true, matchedOrderId: true, sealedRef: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_FINGERPRINT_MATCHES,
  })
  return rows.filter((r) => r.id !== except)
}

/**
 * Has `seller` a V1 listing at `merchant`, still listed or sold, that
 * carries no fingerprint? Such a card matches nothing here, so it could be
 * this one: still for sale on V1 (a ticket from before the freeze can still
 * buy it), or sold and no longer this seller's. 'sold' as well when there
 * are too many to read: the check fails closed.
 */
async function unfingerprintedV1(seller: Hex, merchant: EscrowMerchantName): Promise<'listed' | 'sold' | null> {
  const rows = await prisma.intent.findMany({
    where: {
      formFactor: ESCROW_INTENT_FORM_FACTOR,
      accountId: `seller:${seller}`,
      merchantId: merchant,
      state: { in: ['offered', ...SALE_STATES] },
      sealedRef: { path: ['lit', 'template'], equals: V1_TEMPLATE_ID },
    },
    select: { state: true, sealedRef: true },
    take: MAX_V1_SALES_READ,
  })
  if (rows.length >= MAX_V1_SALES_READ) return 'sold'
  const bare = rows.filter((r) => fingerprintOfRef(r.sealedRef) === null)
  if (bare.some((r) => r.state !== 'offered')) return 'sold'
  return bare.length > 0 ? 'listed' : null
}

/** A V1 listing's chain state as the verdict reads it: SalvoEscrowV1 sells a card whole. */
export function fingerprintChainV1(listingState: number, expired: boolean): FingerprintMatch['chain'] {
  if (listingState === LISTING_STATE.active) return expired ? 'closed' : 'active'
  if (listingState === LISTING_STATE.sold) return 'sold'
  if (listingState === LISTING_STATE.cancelled) return 'closed'
  return null
}

/** A V2 listing's chain state as the verdict reads it: drained is sold; a leftover still for sale is active. */
export function fingerprintChainV2(listingState: number, expired: boolean): FingerprintMatch['chain'] {
  if (listingState === V2_STATE.listing.ACTIVE) return expired ? 'closed' : 'active'
  if (listingState === V2_STATE.listing.DRAINED) return 'sold'
  if (listingState === V2_STATE.listing.CANCELLED || listingState === V2_STATE.listing.SPENT) return 'closed'
  return null
}

/**
 * The matches as the verdict reads them: who bought each sold one (its
 * order's payer), when each was listed, and, for each one still offered,
 * what its own escrow shows now: still for sale, sold before the keeper
 * recorded it, or closed (cancelled, past its expiry by the chain's clock,
 * found spent). A listing whose escrow cannot be read here counts as for
 * sale: the card stays listed until we can see it is not.
 */
async function matchesOf(rows: readonly FingerprintRow[], rt: EscrowRuntime): Promise<FingerprintMatch[]> {
  const orderIds = rows.map((r) => r.matchedOrderId).filter((id): id is string => id !== null)
  const orders = orderIds.length === 0 ? [] : await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, payerAddress: true } })
  const payer = new Map(orders.map((o) => [o.id, o.payerAddress]))
  const v1 = escrowReader(rt)
  const v2 = escrowReaderV2(rt)
  const t2 = templateV2Of(rt)
  const v1Block = v1 !== null && rows.some((r) => r.state === 'offered' && escrowVersionOfRef(r.sealedRef) === 1) ? await v1.block() : null
  const v2Block = v2 !== null && rows.some((r) => r.state === 'offered' && escrowVersionOfRef(r.sealedRef) === 2) ? await v2.block() : null
  const out: FingerprintMatch[] = []
  for (const r of rows) {
    const version = escrowVersionOfRef(r.sealedRef)
    if (version === null) continue
    let chain: FingerprintMatch['chain'] = null
    if (r.state === 'offered') {
      if (version === 1 && v1 !== null && v1Block !== null) {
        const sealed = readEscrowSealedRef(r.sealedRef, rt.template)
        if (sealed !== null) {
          const g = await v1.gate(v1Block, sealed.listingId, 0n)
          chain = fingerprintChainV1(g.listingState, Number(v1Block.timestamp) >= sealed.manifest.listingExpiry)
        }
      } else if (version === 2 && v2 !== null && v2Block !== null) {
        const sealed = readEscrowSealedRefV2(r.sealedRef, t2)
        if (sealed !== null) {
          const g = await v2.gate(v2Block, sealed.listingId, 0n)
          chain = fingerprintChainV2(g.listingState, Number(v2Block.timestamp) >= sealed.manifest.listingExpiry)
        }
      }
    }
    const bought = r.matchedOrderId === null ? null : (payer.get(r.matchedOrderId) ?? null)
    out.push({
      version,
      state: r.state,
      seller: r.accountId.replace(/^seller:/, '').toLowerCase() as Hex,
      buyer: bought === null ? null : (bought.toLowerCase() as Hex),
      chain,
      listedAt: r.createdAt.getTime(),
    })
  }
  return out
}

/**
 * Record a listing a seller's browser sealed for salvo-vault-escrow/2 and
 * listed on SalvoEscrowV2. Throws EscrowListingRefusedError with the status
 * and sentence to send back. `mayReadChain` as for V1 (listing.ts): asked
 * once, after every free check, right before the first chain read.
 *
 * The card's own history is judged first, the listing's own state last: the
 * seller's page posts once before it sends `list`, and a card we would refuse
 * must be refused then, while nothing has been sent or paid.
 */
export async function acceptSealedListingV2(
  input: { manifest: string; envelope: unknown; txHash: string; cardFingerprint: unknown },
  rt: EscrowRuntime = escrowRuntime(),
  mayReadChain: (seller: Hex) => boolean = () => true,
): Promise<AcceptedListing> {
  const t = templateV2Of(rt)
  if (templateV2NotReady(t) !== null || !escrowV2Live(rt)) throw refuseListing('not_ready', 503, 'Selling for dollars is not set up yet.')

  const m = typeof input.manifest === 'string' ? parseEscrowManifestV2(input.manifest, t.escrowAddress) : null
  if (m === null) throw refuseListing('bad_manifest', 400, 'The listing terms are not ones the escrow accepts.')
  const envelope = parseEnvelope(input.envelope)
  if (envelope === null) throw refuseListing('bad_envelope', 400, 'The sealed card is not in the shape the escrow expects.')
  if (typeof input.txHash !== 'string' || !TX_HASH_RE.test(input.txHash)) {
    throw refuseListing('bad_tx', 400, 'The listing transaction hash is missing or malformed.')
  }
  const fingerprint = parseCardFingerprint(input.cardFingerprint)
  if (fingerprint === null) throw refuseListing('bad_fingerprint', 400, "The card's fingerprint is missing or not in the form the escrow expects.")
  const merchant = escrowMerchantById(m.merchant)
  if (merchant === null) throw refuseListing('bad_manifest', 400, 'The listing terms are not ones the escrow accepts.')
  const testList = sellerAllowlist()
  if (testList.size > 0 && !testList.has(m.seller)) {
    throw refuseListing('seller_not_allowed', 403, 'This seller address is not on the test list yet.')
  }

  const now = new Date(rt.now())
  const listingId = listingIdOfSealV2(m, envelope)
  const intentId = escrowIntentIdFor(listingId)
  const data = escrowIntentDataV2(t, m, input.manifest, envelope, now, fingerprint)

  // The custody guard, before any read: it is free. On a testnet the test
  // list is the operator's own wallets (listing.ts, TESTNET_LISTING_OWNER).
  try {
    assertSealedRefAllowedForOwner(sealedRefForV2(t, m, input.manifest, envelope, listingId, now, fingerprint), TESTNET_LISTING_OWNER)
  } catch (err) {
    if (err instanceof CustodialVaultRefusedError) throw refuseListing('custody_refused', 403, 'Selling for dollars is not open yet.')
    throw err
  }

  // Our own books, free: a V1 listing of this seller's at this store that no
  // fingerprint can match, then every listing of this same card.
  const bare = await unfingerprintedV1(m.seller, merchant.name)
  if (bare === 'sold') {
    throw refuseListing(
      'card_unmatched',
      409,
      'You sold cards at this store on the old escrow before each card carried a fingerprint, so this card cannot be told apart from those yet. It can be listed once each buyer has matched their card, which their phone does when they open Account in Salvo.',
    )
  }
  if (bare === 'listed') {
    throw refuseListing(
      'card_unmatched',
      409,
      'You have cards listed at this store on the old escrow from before each card carried a fingerprint. Take those back first, then list here.',
    )
  }
  const rows = await rowsWithFingerprint(fingerprint, intentId)

  const reader = escrowReaderV2(rt)
  if (reader === null) throw refuseListing('not_ready', 503, 'Selling for dollars is not set up yet.')
  if (!mayReadChain(m.seller)) throw refuseListing('slow_down', 429, 'Too many tries. Wait a minute and try again.')

  // The card's history first: the other listings' states on chain, read now.
  const verdict = fingerprintVerdict(await matchesOf(rows, rt), m.seller)
  if (verdict === 'card_listed') {
    throw refuseListing('card_listed', 409, 'This card is already listed. Cancel that listing first, then list it here.')
  }
  if (verdict === 'card_sold') throw refuseListing('card_sold', 409, 'This card was sold through Salvo, so it cannot be listed again.')
  if (verdict === 'card_not_paid_out') {
    throw refuseListing('card_not_paid_out', 409, 'You can sell this card once your purchase of it is final, a day after you bought it.')
  }

  // Then this listing's own state on chain.
  const block = await reader.block()
  const g = await reader.gate(block, listingId, 0n)
  if (g.signer !== t.identity || g.token !== PATH_USD) {
    throw refuseListing('wrong_escrow', 503, 'The escrow on chain is not the one this build trusts.')
  }
  if (g.listingState === 0) {
    throw refuseListing('not_on_chain_yet', 409, 'Your listing is not final on the chain yet. Try again in a few seconds.')
  }
  if (g.listingState !== V2_STATE.listing.ACTIVE || g.listingSeller !== m.seller) {
    throw refuseListing('listing_closed', 409, 'That listing is already sold or cancelled on the chain.')
  }
  if (Number(block.timestamp) + EXPIRY_MARGIN_S >= m.listingExpiry) {
    throw refuseListing('expiring', 400, 'That listing expires too soon to sell.')
  }
  if (m.mode === MODE_BLIND && m.valueCents > NEW_SELLER_BLIND_CAP_CENTS_V2) {
    if ((await reader.sellerStats(block, m.seller)).paidOut < BigInt(m.valueCents) * BigInt(UNITS_PER_CENT)) {
      throw refuseListing(
        'new_seller_cap',
        403,
        'New sellers can list cards up to $25 here. Bigger cards open up once your finished sales have paid you at least the card value.',
      )
    }
  }

  try {
    // A listing that sold before we recorded it is offered for what is left.
    await prisma.intent.create({ data: g.sales > 0 ? { ...data, lastKnownBalanceCents: g.remainingCents } : data })
  } catch (err) {
    // The same listing posted twice: one listing, already recorded.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { intentId, listingId, merchant: merchant.name, version: 2, created: false }
    }
    throw err
  }
  return { intentId, listingId, merchant: merchant.name, version: 2, created: true }
}

export type V1FingerprintOutcome = 'recorded' | 'already' | 'not_yours' | 'no_sale'

/**
 * A V1 card's fingerprint, from the phone that bought it: the one way a V1
 * sale recorded before listings carried a fingerprint gets one. It is kept
 * on that sale's listing row, so the card is found from V2 like any other,
 * and its seller's V2 listings at that store are no longer held back by it
 * (unfingerprintedV1). Only the sale's own buyer may give it, and only
 * once: a row that has one keeps it.
 *
 * `buyer` MUST be the account the request proved it controls: the account
 * session (POST /api/escrow/fingerprint), never an address the request
 * names. Nothing here checks who is asking. The buyer's phone works the
 * fingerprint out from the card it holds and sends that alone, from Account
 * (src/lib/account/client/match-v1.ts).
 */
export async function recordV1FingerprintByBuyer(
  input: { buyer: Hex; depositId: bigint; cardFingerprint: unknown },
  rt: EscrowRuntime = escrowRuntime(),
): Promise<V1FingerprintOutcome> {
  const fingerprint = parseCardFingerprint(input.cardFingerprint)
  if (fingerprint === null) throw refuseListing('bad_fingerprint', 400, "The card's fingerprint is missing or not in the form the escrow expects.")
  const escrow = rt.template.escrowAddress
  if (escrow === null) return 'no_sale'
  const order = await prisma.order.findFirst({
    where: { paymentRef: escrowPaymentRef(ESCROW_CHAIN_KEY, escrow, input.depositId) },
    select: { id: true, payerAddress: true },
  })
  if (order === null) return 'no_sale'
  if (order.payerAddress === null || order.payerAddress.toLowerCase() !== input.buyer.toLowerCase()) return 'not_yours'
  const row = await prisma.intent.findFirst({
    where: { formFactor: ESCROW_INTENT_FORM_FACTOR, matchedOrderId: order.id, state: { in: SALE_STATES } },
    select: { id: true, sealedRef: true, updatedAt: true },
  })
  if (row === null || escrowVersionOfRef(row.sealedRef) !== 1) return 'no_sale'
  if (fingerprintOfRef(row.sealedRef) !== null) return 'already'
  const ref = row.sealedRef as Prisma.JsonObject
  // Only if the row is as read: a second post that raced this one keeps the first.
  const written = await prisma.intent.updateMany({
    where: { id: row.id, updatedAt: row.updatedAt },
    data: { sealedRef: { ...ref, cardFingerprint: fingerprint } },
  })
  return written.count === 1 ? 'recorded' : 'already'
}