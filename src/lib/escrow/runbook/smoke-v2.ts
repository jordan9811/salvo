/**
 * escrow:smoke --version 2's logic: SalvoEscrowV2 and salvo-vault-escrow/2 on
 * Moderato through the real template on Lit, paying for only the value used
 * (spec sections 5.3, 7 and 8). `resumeEscrowSmokeV2` is the step after: it
 * does whatever the chain's clock has made due (a deposit back, the seller's
 * payouts), and can be run again until everything is settled.
 *
 * WHO IS WHO. Three throwaway secp256k1 accounts made for this run: seller S,
 * shopper B (the first buyer of each card), and the next shopper N (who buys
 * what B left, and also tries B's ticket). Their keys go to the state file
 * before anything is spent, and are never printed. Every card is the
 * `salvotest` merchant's: 9999 and twelve random digits, $1.00 of value sold
 * at $0.90 (price units 900,000), a 50 cent cap on what a sale may leave, and
 * a 25% haircut that must NOT apply while a deposit covers the remainder.
 *
 * WHAT IT PROVES, in order:
 *   0. Free first: escrow:check passes for V2, Lit computes our CID.
 *   1. FULL DRAIN. B uses all $1.00 of card 1: pays $0.90, leaves nothing, no
 *      deposit; the listing is drained and B owns the card. Lit opens it to B.
 *      Negatives: N trying B's ticket ("not lit"), another reply key, a deposit
 *      that does not exist.
 *   2. PARTIAL USE WITH A DEPOSIT. B uses 70 cents of card 2: pays 70 cents'
 *      share of the price and deposits the 30 cents left at face. The listing
 *      stays for sale with 30 cents left, covered by B's deposit. Negatives:
 *      using 40 (60 left, over the cap: "left"); B's ticket from before the
 *      sale ("stale ticket"); S listing the same card again while its
 *      remainder is live ("card listed").
 *   3. THE NEXT BUYER TAKES THE REMAINDER. N is ticketed for exactly the 30
 *      cents and the 1 sale, told which deposit covers it, refused for using
 *      part of it ("remainder whole"), then uses it whole, priced with no
 *      haircut. B's deposit stays held through N's 2 hour contest window
 *      (releaseBond: "bond held"), and comes back on resume after it. Lit
 *      opens the same card to N. S's relisted card is now N's
 *      ("card not seller's").
 *   4. A REMAINDER REPORTED SPENT PAYS THE SELLER. B uses 60 cents of card 3
 *      and deposits 40; N buys the 40 and contests it ("that card was empty"):
 *      N gets exactly their own payment back, B's deposit goes to S at face,
 *      the listing is Spent, and the seller's and B's shortfall counts rise.
 *      Lit refuses to open the contested sale.
 *   5. SELF-USE. B uses 80 cents of card 4 and deposits 20; S marks the
 *      remainder used ("I used it myself", cancelListing): B's deposit comes
 *      back at once, and the cancelled listing gets no ticket.
 *   6. A manifest edited after sealing ("open_failed").
 * Every sale's amount and deposit must equal the TypeScript twin's quote
 * (terms-v2.ts), and the escrow's balance must move by exactly what each step
 * says.
 *
 * WHAT RESUME DOES. After N's contest window (2 h), releaseBond gives B back
 * the deposit on card 2, and N contesting that sale is now "too late". After
 * the payout time (24 h), release pays S for each sale, exactly; the
 * contested sale is never released ("state").
 *
 * Plain EIP-1559 transactions from plain keys, as V1's smoke: the phone's one
 * 0x76 batch is the till's (spec section 5.3), not the runbook's.
 *
 * Never prints or returns a key, a card number, a signature or ciphertext.
 */

import { encodeFunctionData, erc20Abi, keccak256, recoverAddress, stringToHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createReplyKey, sealToTemplate, type LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { ChipotleRequestError } from '@/lib/vault/lit/errors'
import { spentCents } from '@/lib/vault/lit/setup-plan'
import type { EscrowTemplate } from '@/lib/vault/lit/templates'
import { litRequest, runLitAction, type LitCallConfig } from '@/lib/vault/lit/transport'
import { ESCROW_V2_ABI } from '../artifact-v2'
import { ESCROW_LIMITS } from '../config'
import { envelopeHashOf, replyPayload } from '../hashes'
import { commitmentV2, listingIdOfSealV2, openDigestV2, signatureFormOkV2, termsOfManifestV2, type EscrowTermsV2 } from '../hashes-v2'
import { ESCROW_CHAIN_ID, PATH_USD } from '../manifest'
import { buildEscrowManifestV2, parseEscrowManifestV2, type EscrowManifestV2 } from '../manifest-v2'
import { ESCROW_MERCHANTS, MODE_BLIND } from '../merchants'
import { quoteUseV2, type UseQuoteV2 } from '../terms-v2'
import { checkPinnedEscrow } from './check'
import { escrowFactsAt, tokenBalanceAt } from './reads'
import {
  V2_STATE,
  buyerShortfallsV2At,
  depositV2At,
  escrowEventsV2,
  gateV2At,
  listingV2At,
  sellerStatsV2At,
  type DepositViewV2,
} from './reads-v2'
import {
  EscrowRpcError,
  agreedFinalizedBlock,
  hostSleep,
  requestFaucet,
  sendAndWait,
  simulateAt,
  type AgreedBlock,
  type ChainReceipt,
  type HostsConfig,
} from './rpc'
import { answerOf, fakeCardNumber, readBalanceCents, smokeRefusals } from './smoke'

type TemplateV2 = EscrowTemplate<'salvo-vault-escrow/2'>

/** Each card: $1.00 of value, sold at $0.90, at most 50 cents left by a sale, 25% off a remainder nobody's deposit covers. */
const VALUE_CENTS = 100
const PRICE_UNITS = 900_000
const CAP_CENTS = 50
const HAIRCUT_BPS = 2_500
/** The cents each sale uses. */
const USE = Object.freeze({ drain: 100, partial: 70, overCap: 40, shortFirst: 60, selfUse: 80, notWhole: 20 })
/** What each account needs beyond what it pays, for fees (Tempo charges them in pathUSD). */
const FEE_MARGIN_UNITS = 1_000_000n
const LISTING_TTL_S = 86_400
const HEX32_RE = /^0x[0-9a-f]{64}$/
const ZERO32 = `0x${'0'.repeat(64)}`
const SIG_RE = /^0x[0-9a-fA-F]{130}$/
const KEY_RE = /^0x[0-9a-f]{64}$/
const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const ID_RE = /^[1-9][0-9]{0,14}$/
const UNITS_RE = /^[0-9]{1,30}$/
const CONTEST_REASON = keccak256(stringToHex('salvo escrow smoke v2: the remainder was empty'))

/** What each negative must answer for the smoke to pass: the template's word, or the contract's revert reason. */
export const SMOKE_V2_EXPECTED = Object.freeze({
  ticketFromThirdAccount: 'not lit',
  otherReplyKey: 'access_denied',
  missingDeposit: 'access_denied',
  leftOverCap: 'left',
  staleTicket: 'stale ticket',
  relistWhileLive: 'card listed',
  remainderWhole: 'remainder whole',
  bondHeldEarly: 'bond held',
  relistAfterDrain: "card not seller's",
  contestedRelease: 'access_denied',
  cancelledListing: 'access_denied',
  editedManifest: 'open_failed',
  /** Resume: N contests card 2's remainder after the window. */
  contestTooLate: 'too late',
  /** Resume: release of the contested sale. */
  releaseContested: 'state',
})

const lower = (a: string): Hex => a.toLowerCase() as Hex

class SmokeStop extends Error {}

// ---------------------------------------------------------------------------
// The state file
// ---------------------------------------------------------------------------

/**
 * Each sale the smoke made, by what it is for:
 *   drain            B used all of card 1
 *   partial          B used 70 of card 2 and deposited 30
 *   remainder        N used card 2's 30 whole, covering B's deposit
 *   short_first      B used 60 of card 3 and deposited 40
 *   short_remainder  N bought card 3's 40 and contested it
 *   self_use         B used 80 of card 4, deposited 20, and S cancelled
 */
export type SmokeSaleRoleV2 = 'drain' | 'partial' | 'remainder' | 'short_first' | 'short_remainder' | 'self_use'
const ROLES: readonly SmokeSaleRoleV2[] = ['drain', 'partial', 'remainder', 'short_first', 'short_remainder', 'self_use']

export interface SmokeSaleV2 {
  role: SmokeSaleRoleV2
  id: string
  listingId: Hex
  buyer: 'shopper' | 'next'
  /** Token units the sale paid for the cents used. */
  amount: string
  /** Token units deposited at face for the cents left. */
  bond: string
}

export interface SmokeStateV2 {
  v: 1
  kind: 'salvo-escrow-smoke-v2'
  createdAt: string
  chainId: typeof ESCROW_CHAIN_ID
  escrow: Hex
  template: { id: string; cid: string }
  /** Throwaway testnet keys. This file is the only place they are written. */
  keys: { seller: Hex; shopper: Hex; next: Hex }
  addresses: { seller: Hex; shopper: Hex; next: Hex }
  /** Written as each sale lands, so a run that stops halfway can still be resumed. */
  sales: SmokeSaleV2[]
}

export function smokeStateV2Text(s: SmokeStateV2): string {
  return `${JSON.stringify(s, null, 2)}\n`
}

/** The state, if `text` is one this smoke wrote. Keys must match their addresses. */
export function parseSmokeStateV2(text: string): SmokeStateV2 | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const s = v as Record<string, unknown>
  if (s.v !== 1 || s.kind !== 'salvo-escrow-smoke-v2' || s.chainId !== ESCROW_CHAIN_ID) return null
  if (typeof s.escrow !== 'string' || !ADDRESS_RE.test(s.escrow) || typeof s.createdAt !== 'string') return null
  const t = s.template as Record<string, unknown> | null
  if (typeof t !== 'object' || t === null || typeof t.id !== 'string' || typeof t.cid !== 'string') return null
  const keys = s.keys as Record<string, unknown> | null
  const addresses = s.addresses as Record<string, unknown> | null
  if (typeof keys !== 'object' || keys === null || typeof addresses !== 'object' || addresses === null) return null
  for (const who of ['seller', 'shopper', 'next'] as const) {
    const k = keys[who]
    const a = addresses[who]
    if (typeof k !== 'string' || !KEY_RE.test(k) || typeof a !== 'string' || !ADDRESS_RE.test(a)) return null
    if (privateKeyToAccount(k as Hex).address.toLowerCase() !== a) return null
  }
  if (!Array.isArray(s.sales)) return null
  const seen = new Set<string>()
  for (const raw of s.sales) {
    if (typeof raw !== 'object' || raw === null) return null
    const x = raw as Record<string, unknown>
    if (typeof x.role !== 'string' || !(ROLES as readonly string[]).includes(x.role) || seen.has(x.role)) return null
    seen.add(x.role)
    if (typeof x.id !== 'string' || !ID_RE.test(x.id) || typeof x.listingId !== 'string' || !HEX32_RE.test(x.listingId)) return null
    if (x.buyer !== 'shopper' && x.buyer !== 'next') return null
    if (typeof x.amount !== 'string' || !UNITS_RE.test(x.amount) || typeof x.bond !== 'string' || !UNITS_RE.test(x.bond)) return null
  }
  return v as SmokeStateV2
}

// ---------------------------------------------------------------------------
// The shopper's V2 ticket check
// ---------------------------------------------------------------------------

export interface TicketViewV2 {
  listingId: Hex
  depositor: Hex
  replyKeyHash: Hex
  openBalanceCents: number
  cardTag: Hex
  /** The value left the template saw: valueCents before the first sale. */
  remainingCents: number
  /** The listing's sales the template saw. */
  sales: number
  notAfter: number
  signature: Hex
}

/**
 * A ticket from a V2 template answer `{ok: true, ticket, bondDeposit}`, if it
 * has exactly the right shape, with the deposit the template saw covering
 * what is left (0 if none). That deposit is not signed: it tells a buyer who
 * does not hold it to use the remainder whole, which the contract checks
 * itself.
 */
export function ticketOfV2(response: unknown): { ticket: TicketViewV2; bondDeposit: bigint } | null {
  if (typeof response !== 'object' || response === null) return null
  const r = response as Record<string, unknown>
  if (r.ok !== true || typeof r.ticket !== 'object' || r.ticket === null) return null
  if (!Number.isSafeInteger(r.bondDeposit) || (r.bondDeposit as number) < 0) return null
  const k = r.ticket as Record<string, unknown>
  if (typeof k.listingId !== 'string' || !HEX32_RE.test(k.listingId)) return null
  if (typeof k.depositor !== 'string' || !ADDRESS_RE.test(k.depositor)) return null
  if (typeof k.replyKeyHash !== 'string' || !HEX32_RE.test(k.replyKeyHash)) return null
  if (typeof k.cardTag !== 'string' || !HEX32_RE.test(k.cardTag)) return null
  for (const n of [k.openBalanceCents, k.remainingCents, k.sales, k.notAfter]) {
    if (!Number.isSafeInteger(n) || (n as number) < 0) return null
  }
  if (typeof k.signature !== 'string' || !SIG_RE.test(k.signature)) return null
  return {
    ticket: {
      listingId: k.listingId as Hex,
      depositor: k.depositor as Hex,
      replyKeyHash: k.replyKeyHash as Hex,
      openBalanceCents: k.openBalanceCents as number,
      cardTag: k.cardTag as Hex,
      remainingCents: k.remainingCents as number,
      sales: k.sales as number,
      notAfter: k.notAfter as number,
      signature: k.signature as Hex,
    },
    bondDeposit: BigInt(r.bondDeposit as number),
  }
}

/**
 * Every reason a shopper's device must refuse to pay with this V2 ticket:
 * V1's reasons, plus a value left or a sales count other than what the
 * device read from the chain. A ticket binds the listing's state, so one from
 * before another sale is refused here before the contract has to. Empty means pay.
 */
export async function ticketProblemsV2(
  k: TicketViewV2,
  expect: {
    listingId: Hex
    depositor: Hex
    replyKeyHash: Hex
    identity: Hex
    escrow: Hex
    mode: number
    chainTime: number
    remainingCents: number
    sales: number
  },
): Promise<string[]> {
  const out: string[] = []
  if (k.listingId !== lower(expect.listingId)) out.push('the ticket is for another listing')
  if (k.depositor !== lower(expect.depositor)) out.push('the ticket names another buyer')
  if (k.replyKeyHash !== lower(expect.replyKeyHash)) out.push('the ticket names another reply key')
  if (k.cardTag === ZERO32) out.push('the ticket has no card tag')
  if (k.remainingCents !== expect.remainingCents || k.sales !== expect.sales) out.push('the ticket is for another state of the listing')
  if (expect.mode === MODE_BLIND && k.openBalanceCents !== 0) out.push('a blind ticket carries a balance')
  if (k.notAfter < expect.chainTime || k.notAfter > expect.chainTime + ESCROW_LIMITS.maxTicketTtlSeconds) {
    out.push('the ticket is expired or valid for longer than the contract accepts')
  }
  if (!signatureFormOkV2(k.signature)) out.push('the ticket signature has a v or s the contract refuses')
  try {
    const digest = openDigestV2(ESCROW_CHAIN_ID, expect.escrow, {
      listingId: k.listingId,
      depositor: k.depositor,
      replyKeyHash: k.replyKeyHash,
      openBalanceCents: k.openBalanceCents,
      cardTag: k.cardTag,
      remainingCents: k.remainingCents,
      sales: k.sales,
      notAfter: k.notAfter,
    })
    if ((await recoverAddress({ hash: digest, signature: k.signature })).toLowerCase() !== lower(expect.identity)) {
      out.push('the ticket is not signed by the pinned identity')
    }
  } catch {
    out.push('the ticket signature does not recover')
  }
  return out
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Why the V2 smoke must not start against this template. Offline. */
export function smokeRefusalsV2(t: TemplateV2): string[] {
  if (t.id !== 'salvo-vault-escrow/2') return ['this is not the salvo-vault-escrow/2 template']
  return smokeRefusals(t)
}

/** The positive checks. Each is null until its step ran. */
export interface SmokeChecksV2 {
  /** Card 1 opened to B and equals what S sealed. */
  drainMatch: boolean | null
  /** Card 1: the whole price, no deposit, the listing drained. */
  drainPaidWhole: boolean | null
  /** Card 2 opened to B. */
  partialMatch: boolean | null
  /** Card 2: 70 cents' share of the price, 30 cents deposited at face and held, 30 cents left for sale under B's deposit. */
  partialDeposit: boolean | null
  /** N's ticket names 30 cents left, 1 sale, and B's deposit as covering it. */
  remainderTicket: boolean | null
  /** Card 2 opened to N: the same card B saw. */
  remainderMatch: boolean | null
  /** N paid 30 cents' share at the full discount: no haircut while B's deposit covers it. */
  remainderNoHaircut: boolean | null
  /** N's sale covers B's deposit, its contest window is 2 h, B's deposit is still held, the listing is drained. */
  remainderCovers: boolean | null
  /** N got back exactly their own payment for card 3's remainder. */
  spentRefund: boolean | null
  /** B's deposit on card 3 went to S, exactly, at face. */
  spentBondToSeller: boolean | null
  /** Card 3's listing is Spent; S's remaindersShort and B's shortfalls each rose by one. */
  spentCounted: boolean | null
  /** S's "I used it myself" gave B the deposit on card 4 back at once, exactly. */
  selfUseBondBack: boolean | null
  /** The TypeScript twin (quoteUseV2) priced every sale and refusal as the contract did. */
  twinsAgree: boolean | null
  /** The escrow's pathUSD balance moved by exactly what each step says. */
  escrowBalanced: boolean | null
}

export interface SmokeNegativesV2 {
  ticketFromThirdAccount: string | null
  otherReplyKey: string | null
  missingDeposit: string | null
  leftOverCap: string | null
  staleTicket: string | null
  relistWhileLive: string | null
  /** The relisted card got the same tag as the sold one: one card, one tag, live. */
  sameCardTag: boolean | null
  remainderWhole: string | null
  bondHeldEarly: string | null
  relistAfterDrain: string | null
  contestedRelease: string | null
  cancelledListing: string | null
  editedManifest: string | null
}

export interface SmokeSummaryV2 {
  ok: boolean
  escrow: Hex | null
  cid: string
  cidMatchesServer: boolean | null
  check: { ok: boolean; problems: string[] } | null
  accounts: { seller: Hex; shopper: Hex; next: Hex } | null
  /** Deposit ids by role. */
  sales: Partial<Record<SmokeSaleRoleV2, string>>
  /** Last four digits of the cards opened, never more. */
  last4: { drain: string | null; partial: string | null }
  checks: SmokeChecksV2
  negatives: SmokeNegativesV2
  /** Chain time, seconds: when B's deposit on card 2 may come back, and when the last payout is due. */
  due: { bondBack: number | null; payouts: number | null }
  timings: Record<string, number>
  lit: { runs: number; ms: number }
  chain: { txs: number; ms: number }
  totalMs: number
  costCents: { estimated: number; measured: number | null }
  stopped?: string
}

export interface SmokeDepsV2 {
  hosts: HostsConfig
  /** The usage key, and in tests the fake Lit. */
  lit: LitCallConfig
  template: TemplateV2
  say: (line: string) => void
  /** Write the new state file. Throwing stops the run before anything is spent. */
  saveNewState: (text: string) => void
  /** Rewrite it as the run moves on. */
  updateState: (text: string) => void
  /** Tests pass fixed keys. Default: fresh random ones. */
  newKey?: () => Hex
  fundTimeoutMs?: number
  finalTimeoutMs?: number
}

interface ListedV2 {
  manifestText: string
  m: EscrowManifestV2
  terms: EscrowTermsV2
  envelope: LitEnvelope
  listingId: Hex
}

interface Bought {
  id: bigint
  d: DepositViewV2
  q: UseQuoteV2
}

function emptySummaryV2(t: TemplateV2): SmokeSummaryV2 {
  return {
    ok: false,
    escrow: t.escrowAddress,
    cid: t.cid,
    cidMatchesServer: null,
    check: null,
    accounts: null,
    sales: {},
    last4: { drain: null, partial: null },
    checks: {
      drainMatch: null,
      drainPaidWhole: null,
      partialMatch: null,
      partialDeposit: null,
      remainderTicket: null,
      remainderMatch: null,
      remainderNoHaircut: null,
      remainderCovers: null,
      spentRefund: null,
      spentBondToSeller: null,
      spentCounted: null,
      selfUseBondBack: null,
      twinsAgree: null,
      escrowBalanced: null,
    },
    negatives: {
      ticketFromThirdAccount: null,
      otherReplyKey: null,
      missingDeposit: null,
      leftOverCap: null,
      staleTicket: null,
      relistWhileLive: null,
      sameCardTag: null,
      remainderWhole: null,
      bondHeldEarly: null,
      relistAfterDrain: null,
      contestedRelease: null,
      cancelledListing: null,
      editedManifest: null,
    },
    due: { bondBack: null, payouts: null },
    timings: {},
    lit: { runs: 0, ms: 0 },
    chain: { txs: 0, ms: 0 },
    totalMs: 0,
    costCents: { estimated: 0, measured: null },
  }
}

/** Whether the run passed: every check true, every negative as SMOKE_V2_EXPECTED says. */
function passedV2(s: SmokeSummaryV2): boolean {
  const n = s.negatives
  const e = SMOKE_V2_EXPECTED
  return (
    Object.values(s.checks).every((v) => v === true) &&
    n.sameCardTag === true &&
    n.ticketFromThirdAccount === e.ticketFromThirdAccount &&
    n.otherReplyKey === e.otherReplyKey &&
    n.missingDeposit === e.missingDeposit &&
    n.leftOverCap === e.leftOverCap &&
    n.staleTicket === e.staleTicket &&
    n.relistWhileLive === e.relistWhileLive &&
    n.remainderWhole === e.remainderWhole &&
    n.bondHeldEarly === e.bondHeldEarly &&
    n.relistAfterDrain === e.relistAfterDrain &&
    n.contestedRelease === e.contestedRelease &&
    n.cancelledListing === e.cancelledListing &&
    n.editedManifest === e.editedManifest
  )
}

/** The pull each planned sale makes, from the twin: what each buyer must hold, beyond fees. */
function plannedPull(terms: EscrowTermsV2, uses: ReadonlyArray<{ used: number; remaining: number; sales: number; covered: boolean }>): bigint {
  let total = 0n
  for (const u of uses) {
    const q = quoteUseV2(terms, { remainingCents: u.remaining, sales: u.sales, bondDeposit: u.covered ? 1n : 0n, ownBond: null }, u.used)
    if ('refused' in q) throw new SmokeStop(`the smoke plans a use the contract would refuse (${q.refused})`)
    total += q.pull
  }
  return total
}

export async function runEscrowSmokeV2(deps: SmokeDepsV2): Promise<SmokeSummaryV2> {
  const t = deps.template
  const now = deps.hosts.now ?? Date.now
  const started = now()
  const say = deps.say
  const summary = emptySummaryV2(t)
  const checks = summary.checks
  const neg = summary.negatives
  let balanceBefore: number | null = null

  try {
    const refusals = smokeRefusalsV2(t)
    if (refusals.length > 0) throw new SmokeStop(`refused before any network call: ${refusals.join('; ')}`)
    const escrow = t.escrowAddress as Hex
    const identity = t.identity as Hex
    const encPub = t.encPub as string

    // ---- 0. Free: the deployment check, and Lit's CID ------------------------
    const check = await checkPinnedEscrow(deps.hosts, t)
    summary.check = { ok: check.ok, problems: check.problems }
    if (!check.ok) throw new SmokeStop(`escrow:check --version 2 does not pass: ${check.problems.join('; ')}`)
    say('escrow:check    : passes on both hosts (V2)')
    const remote = await litRequest({ ...deps.lit, apiKey: null }, 'POST', '/get_lit_action_ipfs_id', t.source)
    summary.cidMatchesServer = remote.json === t.cid
    if (!summary.cidMatchesServer) throw new SmokeStop('Lit computes a different CID for the template; nothing spent')
    say(`CID             : ${t.cid} (Lit agrees)`)
    balanceBefore = await readBalanceCents(deps.lit)

    // ---- 1. Three throwaway accounts, saved before anything is spent ---------
    const newKey = deps.newKey ?? generatePrivateKey
    const keys = { seller: newKey(), shopper: newKey(), next: newKey() }
    const S = privateKeyToAccount(keys.seller)
    const B = privateKeyToAccount(keys.shopper)
    const N = privateKeyToAccount(keys.next)
    const addr = { seller: lower(S.address), shopper: lower(B.address), next: lower(N.address) }
    const state: SmokeStateV2 = {
      v: 1,
      kind: 'salvo-escrow-smoke-v2',
      createdAt: new Date(now()).toISOString(),
      chainId: ESCROW_CHAIN_ID,
      escrow,
      template: { id: t.id, cid: t.cid },
      keys,
      addresses: addr,
      sales: [],
    }
    deps.saveNewState(smokeStateV2Text(state))
    summary.accounts = addr
    say(`accounts        : seller ${addr.seller}, shopper ${addr.shopper}, next ${addr.next} (keys in the state file only)`)

    // ---- Helpers ---------------------------------------------------------------
    const lit = async (params: Record<string, unknown>): Promise<unknown> => {
      const r = await runLitAction(deps.lit, t.source, params)
      summary.lit.runs++
      summary.lit.ms += r.elapsedMs
      summary.costCents.estimated += Math.max(1, Math.ceil(r.elapsedMs / 1000))
      return r.response
    }
    const send = async (who: PrivateKeyAccount, to: Hex, data: Hex, what: string): Promise<Awaited<ReturnType<typeof sendAndWait>>> => {
      const sent = await sendAndWait(deps.hosts, who, { to, data }, deps.finalTimeoutMs === undefined ? {} : { timeoutMs: deps.finalTimeoutMs })
      summary.chain.txs++
      summary.chain.ms += sent.ms
      if (sent.receipt.status !== 'success') throw new SmokeStop(`${what} reverted on chain (${sent.signed.hash})`)
      return sent
    }
    const block = (): Promise<AgreedBlock> => agreedFinalizedBlock(deps.hosts)
    const escrowUnits = async (): Promise<bigint> => tokenBalanceAt(deps.hosts, await block(), PATH_USD, escrow)
    const unitsOf = async (who: Hex): Promise<bigint> => tokenBalanceAt(deps.hosts, await block(), PATH_USD, who)
    let twins = true
    let balanced = true
    const seal = (cardNumber: string, manifestText: string): LitEnvelope => {
      const plain = Buffer.from(JSON.stringify({ cardNumber, pin: null }), 'utf8')
      try {
        const env = sealToTemplate(encPub, plain, manifestText)
        if (JSON.stringify(env).includes(cardNumber)) throw new SmokeStop('the envelope holds the card number')
        return env
      } finally {
        plain.fill(0)
      }
    }
    const freshSalt = (): string => generatePrivateKey().slice(2)
    const expiry = Number((await block()).timestamp) + LISTING_TTL_S
    const manifestFor = (listingExpiry: number, salt: string): { text: string; m: EscrowManifestV2 } => {
      const text = buildEscrowManifestV2({
        escrow,
        seller: addr.seller,
        merchant: ESCROW_MERCHANTS.salvotest.id,
        mode: MODE_BLIND,
        valueCents: VALUE_CENTS,
        price: PRICE_UNITS,
        residualCapCents: CAP_CENTS,
        remainderHaircutBps: HAIRCUT_BPS,
        listingExpiry,
        salt,
      })
      const m = parseEscrowManifestV2(text, escrow)
      if (!m) throw new SmokeStop('the smoke wrote a manifest its own parser refuses')
      return { text, m }
    }
    /** S lists `mf` committed to `env`; the chain must agree on the listing id. */
    const list = async (mf: { text: string; m: EscrowManifestV2 }, env: LitEnvelope, what: string): Promise<ListedV2> => {
      const listingId = listingIdOfSealV2(mf.m, env)
      const terms = termsOfManifestV2(mf.m)
      const commit = commitmentV2(ESCROW_CHAIN_ID, escrow, PATH_USD, terms, envelopeHashOf(env))
      const sent = await send(S, escrow, encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'list', args: [commit] }), what)
      const listed = escrowEventsV2(sent.receipt, escrow, 'Listed')
      if (listed.length !== 1 || lower(listed[0]?.listingId ?? '') !== listingId) {
        throw new SmokeStop(`${what}: the contract's listing id is not the one this code computes`)
      }
      const g = await gateV2At(deps.hosts, await block(), escrow, listingId, 0n)
      if (g.listingState !== V2_STATE.listing.ACTIVE || g.listingSeller !== addr.seller || g.sales !== 0) {
        throw new SmokeStop(`${what}: the listing is not active for the seller`)
      }
      return { manifestText: mf.text, m: mf.m, terms, envelope: env, listingId }
    }
    const listCard = async (cardNumber: string, what: string): Promise<ListedV2> => {
      const mf = manifestFor(expiry, freshSalt())
      return list(mf, seal(cardNumber, mf.text), what)
    }
    const ticketFor = async (l: ListedV2, depositor: Hex, replyKeyHash: Hex): Promise<unknown> =>
      lit({ op: 'ticket', manifest: l.manifestText, envelope: l.envelope, depositor, replyKeyHash })
    /** The ticket, checked the way a phone checks it against the listing's state on chain. */
    const checkedTicket = async (
      response: unknown,
      l: ListedV2,
      depositor: Hex,
      replyKeyHash: Hex,
      what: string,
    ): Promise<{ ticket: TicketViewV2; bondDeposit: bigint }> => {
      const got = ticketOfV2(response)
      if (!got) throw new SmokeStop(`${what}: the template answered ${answerOf(response)}, not a ticket`)
      const b = await block()
      const g = await gateV2At(deps.hosts, b, escrow, l.listingId, 0n)
      const problems = await ticketProblemsV2(got.ticket, {
        listingId: l.listingId,
        depositor,
        replyKeyHash,
        identity,
        escrow,
        mode: MODE_BLIND,
        chainTime: Number(b.timestamp),
        remainingCents: g.sales === 0 ? l.m.valueCents : g.remainingCents,
        sales: g.sales,
      })
      if (got.bondDeposit !== g.bondDeposit) problems.push('the ticket names another covering deposit than the chain')
      if (problems.length > 0) throw new SmokeStop(`${what}: ${problems.join('; ')}`)
      return got
    }
    const depositCall = (l: ListedV2, k: TicketViewV2, usedCents: number): Hex =>
      encodeFunctionData({
        abi: ESCROW_V2_ABI,
        functionName: 'depositAndOpen',
        args: [
          l.terms,
          envelopeHashOf(l.envelope),
          usedCents,
          {
            replyKeyHash: k.replyKeyHash,
            openBalanceCents: k.openBalanceCents,
            cardTag: k.cardTag,
            remainingCents: k.remainingCents,
            sales: k.sales,
            notAfter: k.notAfter,
            signature: k.signature,
          },
        ],
      })
    /** The twin's quote for `who` using `used` of `l` now, from the chain's gate. */
    const quoteNow = async (l: ListedV2, who: Hex, used: number): Promise<UseQuoteV2 | { refused: string }> => {
      const b = await block()
      const g = await gateV2At(deps.hosts, b, escrow, l.listingId, 0n)
      let ownBond: bigint | null = null
      if (g.bondDeposit !== 0n) {
        const cov = await depositV2At(deps.hosts, b, escrow, g.bondDeposit)
        if (cov.depositor === who) ownBond = cov.bond
      }
      return quoteUseV2(l.terms, { remainingCents: g.remainingCents, sales: g.sales, bondDeposit: g.bondDeposit, ownBond }, used)
    }
    /** `who` simulating a purchase (free): the contract's revert reason, or 'accepted'. The twin must say the same. */
    const tryBuy = async (who: Hex, l: ListedV2, k: TicketViewV2, used: number, twinMustRefuse: boolean): Promise<string> => {
      const sim = await simulateAt(deps.hosts, await block(), { from: who, to: escrow, data: depositCall(l, k, used) })
      const reason = sim.ok ? 'accepted' : sim.reason
      if (twinMustRefuse) {
        const q = await quoteNow(l, who, used)
        if (!('refused' in q) || q.refused !== reason) twins = false
      }
      return reason
    }
    /** Write a sale to the state file, or rewrite it once the chain's own amounts are read. One sale per role. */
    const recordSale = (role: SmokeSaleRoleV2, buyer: 'shopper' | 'next', l: ListedV2, id: bigint, amount: bigint, bond: bigint): void => {
      const sale: SmokeSaleV2 = { role, id: id.toString(), listingId: l.listingId, buyer, amount: amount.toString(), bond: bond.toString() }
      const at = state.sales.findIndex((x) => x.role === role)
      if (at >= 0) state.sales[at] = sale
      else state.sales.push(sale)
      summary.sales[role] = id.toString()
      deps.updateState(smokeStateV2Text(state))
    }
    /** `who` pays for `used` cents of `l`: the twin's quote first, then one depositAndOpen; amount, bond and the escrow's balance must match it. */
    const buy = async (
      who: PrivateKeyAccount,
      buyer: 'shopper' | 'next',
      role: SmokeSaleRoleV2,
      l: ListedV2,
      k: TicketViewV2,
      used: number,
    ): Promise<Bought> => {
      const q = await quoteNow(l, lower(who.address), used)
      if ('refused' in q) throw new SmokeStop(`${role}: the contract would refuse this use (${q.refused})`)
      const before = await escrowUnits()
      const sent = await send(who, escrow, depositCall(l, k, used), `depositAndOpen (${role})`)
      // It landed: on the state file before any check of it or any other
      // read, so a run that stops on one can still be resumed and paid out.
      const opened = escrowEventsV2(sent.receipt, escrow, 'Opened')
      const mine = opened.filter((o) => lower(o.listingId) === l.listingId && lower(o.depositor) === lower(who.address))
      const ev = mine[0]
      if (ev === undefined) {
        throw new SmokeStop(`${role}: the purchase landed (${sent.signed.hash}) with no Opened event for this listing and buyer; find its deposit by hand before resuming`)
      }
      recordSale(role, buyer, l, ev.depositId, q.amount, q.bond)
      if (opened.length !== 1 || mine.length !== 1) throw new SmokeStop(`${role}: the purchase did not emit one Opened event for this listing and buyer`)
      const usedEv = escrowEventsV2(sent.receipt, escrow, 'Used')
      const u = usedEv[0]
      if (usedEv.length !== 1 || u === undefined || u.usedCents !== used) {
        throw new SmokeStop(`${role}: the purchase did not emit one Used event for the cents used`)
      }
      // The contract's own leftover and deposit against the twin's: a difference is what this smoke is for, reported, not a stop.
      if (u.leftCents !== q.leftCents || u.bond !== q.bond) twins = false
      const d = await depositV2At(deps.hosts, await block(), escrow, ev.depositId)
      if (d.state !== V2_STATE.deposit.OPENED || d.seller !== addr.seller || d.replyKeyHash !== k.replyKeyHash) {
        throw new SmokeStop(`${role}: the deposit on chain is not the purchase that was sent`)
      }
      if (d.amount !== q.amount || d.bond !== q.bond || d.usedCents !== used || d.leftAfterCents !== q.leftCents) {
        twins = false
        recordSale(role, buyer, l, ev.depositId, d.amount, d.bond)
      }
      if ((await escrowUnits()) - before !== q.pull - q.refund) balanced = false
      return { id: ev.depositId, d, q }
    }
    /** Lit releases deposit `id` to `reply`; the card must be `cardNumber`. */
    const openRelease = async (l: ListedV2, id: bigint, reply: ReturnType<typeof createReplyKey>, cardNumber: string, what: string): Promise<boolean> => {
      const response = await lit({ op: 'release', manifest: l.manifestText, envelope: l.envelope, depositId: id.toString(), replyKey: reply.publicKey })
      if (typeof response !== 'object' || response === null) throw new SmokeStop(`${what}: unexpected shape`)
      const r = response as Record<string, unknown>
      if (r.ok !== true || typeof r.reply !== 'string' || typeof r.payload !== 'string') {
        throw new SmokeStop(`${what}: the template answered ${answerOf(response)}`)
      }
      if (r.payload !== replyPayload(ESCROW_CHAIN_ID, id.toString(), escrow, l.manifestText)) {
        throw new SmokeStop(`${what}: the reply is keyed to another deposit, escrow or manifest`)
      }
      const plain = reply.open(r.reply, r.payload, encPub)
      try {
        const card: unknown = JSON.parse(plain.toString('utf8'))
        return typeof card === 'object' && card !== null && (card as Record<string, unknown>).cardNumber === cardNumber && (card as Record<string, unknown>).pin === null
      } finally {
        plain.fill(0)
      }
    }
    const newReply = (): { reply: ReturnType<typeof createReplyKey>; hash: Hex } => {
      const reply = createReplyKey()
      return { reply, hash: keccak256(reply.publicKey as Hex) }
    }

    // ---- 2. Fund all three by the faucet ---------------------------------------
    const tf = now()
    const plan = manifestFor(expiry, freshSalt())
    const needShopper = plannedPull(termsOfManifestV2(plan.m), [
      { used: USE.drain, remaining: 0, sales: 0, covered: false },
      { used: USE.partial, remaining: 0, sales: 0, covered: false },
      { used: USE.shortFirst, remaining: 0, sales: 0, covered: false },
      { used: USE.selfUse, remaining: 0, sales: 0, covered: false },
    ])
    const needNext = plannedPull(termsOfManifestV2(plan.m), [
      { used: VALUE_CENTS - USE.partial, remaining: VALUE_CENTS - USE.partial, sales: 1, covered: true },
      { used: VALUE_CENTS - USE.shortFirst, remaining: VALUE_CENTS - USE.shortFirst, sales: 1, covered: true },
    ])
    const needs: Array<[Hex, bigint]> = [
      [addr.seller, FEE_MARGIN_UNITS],
      [addr.shopper, needShopper + FEE_MARGIN_UNITS],
      [addr.next, needNext + FEE_MARGIN_UNITS],
    ]
    for (const [who] of needs) {
      if ((await tokenBalanceAt(deps.hosts, await block(), PATH_USD, who)) === 0n) await requestFaucet(deps.hosts, who)
    }
    const fundDeadline = now() + (deps.fundTimeoutMs ?? 90_000)
    for (;;) {
      const b = await block()
      const balances = await Promise.all(needs.map(([who]) => tokenBalanceAt(deps.hosts, b, PATH_USD, who)))
      if (balances.every((x, i) => x >= (needs[i]?.[1] ?? 0n))) break
      if (now() > fundDeadline) throw new SmokeStop('the faucet funds did not arrive on both hosts in time, or were less than the run needs')
      await hostSleep(deps.hosts, 1_000)
    }
    summary.timings.fundMs = now() - tf
    say('funded          : all three accounts hold pathUSD on both hosts')

    // ---- 3. S lists four cards ----------------------------------------------------
    const tl = now()
    const card1 = fakeCardNumber()
    const card2 = fakeCardNumber()
    const card3 = fakeCardNumber()
    const card4 = fakeCardNumber()
    summary.last4 = { drain: card1.slice(-4), partial: card2.slice(-4) }
    const l1 = await listCard(card1, 'list card 1')
    summary.timings.listMs = now() - tl
    const l2 = await listCard(card2, 'list card 2')
    const l3 = await listCard(card3, 'list card 3')
    const l4 = await listCard(card4, 'list card 4')
    say(`listed          : four $1.00 cards at $0.90, cap 50 cents (ids match the contract's)`)

    // B approves the escrow once for everything B will pay.
    await send(B, PATH_USD, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [escrow, needShopper] }), 'approve (shopper)')

    // ---- 4. Full drain: B uses all of card 1 -----------------------------------------
    const rb1 = newReply()
    const tt = now()
    const k1 = await checkedTicket(await ticketFor(l1, addr.shopper, rb1.hash), l1, addr.shopper, rb1.hash, 'ticket (card 1)')
    summary.timings.ticketMs = now() - tt
    neg.ticketFromThirdAccount = await tryBuy(addr.next, l1, k1.ticket, USE.drain, false)
    const tap = now()
    const drain = await buy(B, 'shopper', 'drain', l1, k1.ticket, USE.drain)
    summary.timings.payMs = now() - tap
    const g1 = await listingV2At(deps.hosts, await block(), escrow, l1.listingId)
    checks.drainPaidWhole =
      drain.d.amount === BigInt(PRICE_UNITS) && drain.d.bond === 0n && drain.d.bondState === V2_STATE.bond.NONE &&
      g1.state === V2_STATE.listing.DRAINED && g1.remainingCents === 0 && g1.bondDeposit === 0n
    const tr = now()
    checks.drainMatch = await openRelease(l1, drain.id, rb1.reply, card1, 'release (card 1)')
    summary.timings.releaseMs = now() - tr
    summary.timings.tapToCardMs = (summary.timings.payMs ?? 0) + summary.timings.releaseMs
    say(`full drain      : deposit ${drain.id}, paid ${drain.d.amount} units, no deposit; release ${checks.drainMatch ? 'opens card 1' : 'DID NOT MATCH'}, last4 ${summary.last4.drain}`)
    if (!checks.drainMatch) throw new SmokeStop('card 1 came back different')
    neg.otherReplyKey = answerOf(
      await lit({ op: 'release', manifest: l1.manifestText, envelope: l1.envelope, depositId: drain.id.toString(), replyKey: createReplyKey().publicKey }),
    )
    const facts = await escrowFactsAt(deps.hosts, await block(), escrow)
    neg.missingDeposit = answerOf(
      await lit({
        op: 'release',
        manifest: l1.manifestText,
        envelope: l1.envelope,
        depositId: (facts.depositCount + 1000n).toString(),
        replyKey: rb1.reply.publicKey,
      }),
    )
    say(`negatives       : B's ticket by N "${neg.ticketFromThirdAccount}"; other reply key ${neg.otherReplyKey}; missing deposit ${neg.missingDeposit}`)

    // ---- 5. Partial use with a deposit: B uses 70 cents of card 2 -------------------
    const rb2 = newReply()
    const k2 = await checkedTicket(await ticketFor(l2, addr.shopper, rb2.hash), l2, addr.shopper, rb2.hash, 'ticket (card 2)')
    neg.leftOverCap = await tryBuy(addr.shopper, l2, k2.ticket, USE.overCap, true)
    const partial = await buy(B, 'shopper', 'partial', l2, k2.ticket, USE.partial)
    const left2 = VALUE_CENTS - USE.partial
    const g2 = await listingV2At(deps.hosts, await block(), escrow, l2.listingId)
    checks.partialDeposit =
      partial.d.usedCents === USE.partial && partial.d.leftAfterCents === left2 &&
      partial.d.bond === BigInt(left2) * 10_000n && partial.d.bondState === V2_STATE.bond.HELD &&
      g2.state === V2_STATE.listing.ACTIVE && g2.remainingCents === left2 && g2.sales === 1 && g2.bondDeposit === partial.id
    checks.partialMatch = await openRelease(l2, partial.id, rb2.reply, card2, 'release (card 2, B)')
    neg.staleTicket = await tryBuy(addr.shopper, l2, k2.ticket, USE.partial, false)
    say(`partial use     : deposit ${partial.id}, paid ${partial.d.amount} units for ${USE.partial} cents, ${partial.d.bond} units held for the ${left2} left; release ${checks.partialMatch ? 'opens card 2' : 'DID NOT MATCH'}`)
    say(`negatives       : over the cap "${neg.leftOverCap}"; B's ticket after the sale "${neg.staleTicket}"`)

    // S lists card 2 again while its remainder is live: Lit tickets it (it does
    // not read card tags); the contract refuses ("card listed").
    const l2b = await listCard(card2, 'relist card 2')
    const rn2b = newReply()
    const k2b = await checkedTicket(await ticketFor(l2b, addr.next, rn2b.hash), l2b, addr.next, rn2b.hash, 'ticket (card 2 relisted)')
    neg.sameCardTag = k2b.ticket.cardTag === partial.d.cardTag
    neg.relistWhileLive = await tryBuy(addr.next, l2b, k2b.ticket, VALUE_CENTS, false)

    // ---- 6. The next buyer takes the remainder ----------------------------------------
    const rn2 = newReply()
    const kn2 = await checkedTicket(await ticketFor(l2, addr.next, rn2.hash), l2, addr.next, rn2.hash, 'ticket (card 2, remainder)')
    checks.remainderTicket = kn2.ticket.remainingCents === left2 && kn2.ticket.sales === 1 && kn2.bondDeposit === partial.id
    neg.remainderWhole = await tryBuy(addr.next, l2, kn2.ticket, USE.notWhole, true)
    await send(N, PATH_USD, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [escrow, needNext] }), 'approve (next)')
    const rest = await buy(N, 'next', 'remainder', l2, kn2.ticket, left2)
    const fullPrice = (BigInt(left2) * BigInt(PRICE_UNITS) + BigInt(VALUE_CENTS) - 1n) / BigInt(VALUE_CENTS)
    checks.remainderNoHaircut = rest.d.amount === fullPrice && rest.q.haircut === false
    const b6 = await block()
    const bondAfter = await depositV2At(deps.hosts, b6, escrow, partial.id)
    const g2r = await listingV2At(deps.hosts, b6, escrow, l2.listingId)
    checks.remainderCovers =
      rest.d.covers === partial.id && rest.d.contestUntil === rest.d.openedAt + 7_200 && rest.d.bond === 0n &&
      bondAfter.bondState === V2_STATE.bond.HELD && bondAfter.bond === partial.d.bond &&
      g2r.state === V2_STATE.listing.DRAINED && g2r.remainingCents === 0
    neg.bondHeldEarly = await (async () => {
      const sim = await simulateAt(deps.hosts, await block(), {
        from: addr.next,
        to: escrow,
        data: encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'releaseBond', args: [partial.id] }),
      })
      return sim.ok ? 'accepted' : sim.reason
    })()
    checks.remainderMatch = await openRelease(l2, rest.id, rn2.reply, card2, 'release (card 2, N)')
    neg.relistAfterDrain = await tryBuy(addr.next, l2b, k2b.ticket, VALUE_CENTS, false)
    summary.due.bondBack = rest.d.contestUntil
    say(`next buyer      : deposit ${rest.id}, ${left2} cents used whole for ${rest.d.amount} units (no haircut); B's deposit held until ${new Date(rest.d.contestUntil * 1000).toISOString()}`)
    say(
      `negatives       : card 2 relisted while live "${neg.relistWhileLive}", after the drain "${neg.relistAfterDrain}"; ` +
        `part of the remainder "${neg.remainderWhole}"; deposit back early "${neg.bondHeldEarly}"`,
    )

    // ---- 7. A remainder reported spent pays the seller ---------------------------------
    const rb3 = newReply()
    const k3 = await checkedTicket(await ticketFor(l3, addr.shopper, rb3.hash), l3, addr.shopper, rb3.hash, 'ticket (card 3)')
    const first3 = await buy(B, 'shopper', 'short_first', l3, k3.ticket, USE.shortFirst)
    const left3 = VALUE_CENTS - USE.shortFirst
    const rn3 = newReply()
    const kn3 = await checkedTicket(await ticketFor(l3, addr.next, rn3.hash), l3, addr.next, rn3.hash, 'ticket (card 3, remainder)')
    const short3 = await buy(N, 'next', 'short_remainder', l3, kn3.ticket, left3)
    const b7 = await block()
    const statsBefore = await sellerStatsV2At(deps.hosts, b7, escrow, addr.seller)
    const shortfallsBefore = await buyerShortfallsV2At(deps.hosts, b7, escrow, addr.shopper)
    const sellerBefore = await tokenBalanceAt(deps.hosts, b7, PATH_USD, addr.seller)
    const escrowBefore7 = await tokenBalanceAt(deps.hosts, b7, PATH_USD, escrow)
    const contested = await send(
      N,
      escrow,
      encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'contestRemainder', args: [short3.id, CONTEST_REASON] }),
      'contestRemainder',
    )
    const b7b = await block()
    const refunded = escrowEventsV2(contested.receipt, escrow, 'Refunded')
    const forfeited = escrowEventsV2(contested.receipt, escrow, 'BondForfeited')
    const d5 = await depositV2At(deps.hosts, b7b, escrow, short3.id)
    const d4 = await depositV2At(deps.hosts, b7b, escrow, first3.id)
    const l3After = await listingV2At(deps.hosts, b7b, escrow, l3.listingId)
    const statsAfter = await sellerStatsV2At(deps.hosts, b7b, escrow, addr.seller)
    const shortfallsAfter = await buyerShortfallsV2At(deps.hosts, b7b, escrow, addr.shopper)
    checks.spentRefund =
      d5.state === V2_STATE.deposit.CONTESTED && d5.amount === 0n &&
      refunded.length === 1 && refunded[0]?.depositId === short3.id && refunded[0]?.toDepositor === short3.d.amount
    checks.spentBondToSeller =
      d4.bondState === V2_STATE.bond.FORFEITED && d4.bond === 0n &&
      forfeited.length === 1 && forfeited[0]?.amount === first3.d.bond &&
      (await tokenBalanceAt(deps.hosts, b7b, PATH_USD, addr.seller)) - sellerBefore === first3.d.bond
    checks.spentCounted =
      l3After.state === V2_STATE.listing.SPENT &&
      statsAfter.remaindersShort === statsBefore.remaindersShort + 1 && shortfallsAfter === shortfallsBefore + 1
    if (escrowBefore7 - (await tokenBalanceAt(deps.hosts, b7b, PATH_USD, escrow)) !== short3.d.amount + first3.d.bond) balanced = false
    neg.contestedRelease = answerOf(
      await lit({ op: 'release', manifest: l3.manifestText, envelope: l3.envelope, depositId: short3.id.toString(), replyKey: rn3.reply.publicKey }),
    )
    say(`reported spent  : N refunded ${short3.d.amount} units, B's ${first3.d.bond} unit deposit to the seller, listing ${checks.spentCounted ? 'Spent and counted' : 'NOT SPENT OR NOT COUNTED'}; release ${neg.contestedRelease}`)

    // ---- 8. Self-use: S marks card 4's remainder used ------------------------------------
    const rb4 = newReply()
    const k4 = await checkedTicket(await ticketFor(l4, addr.shopper, rb4.hash), l4, addr.shopper, rb4.hash, 'ticket (card 4)')
    const self4 = await buy(B, 'shopper', 'self_use', l4, k4.ticket, USE.selfUse)
    const shopperBefore = await unitsOf(addr.shopper)
    const escrowBefore8 = await escrowUnits()
    await send(S, escrow, encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'cancelListing', args: [l4.listingId] }), 'cancelListing')
    const b8 = await block()
    const d6 = await depositV2At(deps.hosts, b8, escrow, self4.id)
    const l4After = await listingV2At(deps.hosts, b8, escrow, l4.listingId)
    checks.selfUseBondBack =
      d6.bondState === V2_STATE.bond.RETURNED && d6.state === V2_STATE.deposit.OPENED &&
      l4After.state === V2_STATE.listing.CANCELLED &&
      (await tokenBalanceAt(deps.hosts, b8, PATH_USD, addr.shopper)) - shopperBefore === self4.d.bond
    if (escrowBefore8 - (await tokenBalanceAt(deps.hosts, b8, PATH_USD, escrow)) !== self4.d.bond) balanced = false
    const rn4 = newReply()
    neg.cancelledListing = answerOf(await ticketFor(l4, addr.next, rn4.hash))
    say(`self-use        : B's ${self4.d.bond} unit deposit ${checks.selfUseBondBack ? 'back at once' : 'NOT BACK'}; ticket for the cancelled listing ${neg.cancelledListing}`)

    // ---- 9. A manifest edited after sealing --------------------------------------------
    const salt5 = freshSalt()
    const sealed5 = manifestFor(expiry, salt5)
    const env5 = seal(fakeCardNumber(), sealed5.text)
    const l5 = await list(manifestFor(expiry + 1, salt5), env5, 'list an edited manifest')
    neg.editedManifest = answerOf(await ticketFor(l5, addr.shopper, rb1.hash))
    say(`edited manifest : ${neg.editedManifest}`)

    checks.twinsAgree = twins
    checks.escrowBalanced = balanced
    const releaseTimes = [drain, partial, rest, first3, self4].map((x) => Math.max(x.d.releaseAt, x.d.contestUntil))
    summary.due.payouts = Math.max(...releaseTimes)
    summary.ok = passedV2(summary)
  } catch (err) {
    summary.ok = false
    if (err instanceof SmokeStop || err instanceof EscrowRpcError || err instanceof ChipotleRequestError) summary.stopped = err.message
    else throw err
  } finally {
    summary.totalMs = now() - started
    if (balanceBefore !== null) {
      const after = await readBalanceCents(deps.lit)
      summary.costCents.measured = after === null ? null : spentCents(balanceBefore, after)
    }
  }
  return summary
}

// ---------------------------------------------------------------------------
// Resume: whatever the chain's clock has made due
// ---------------------------------------------------------------------------

export interface ResumeStepV2 {
  what: 'bond_back' | 'payout'
  role: SmokeSaleRoleV2
  id: string
  /** Sent by this run, or found already done (by the live run, an earlier resume, the keeper, or anyone). */
  status: 'sent' | 'already'
  /** Token units the recipient received (sent only). */
  received: string | null
  ok: boolean
  txHash: Hex | null
}

export interface ResumeSummaryV2 {
  ok: boolean
  status: 'not_yet' | 'partial' | 'done' | 'failed'
  steps: ResumeStepV2[]
  /** What is not due yet, with when (chain time, seconds). */
  pending: Array<{ what: 'bond_back' | 'payout'; role: SmokeSaleRoleV2; id: string; dueAt: number }>
  nextDueAt: number | null
  negatives: { contestTooLate: string | null; releaseContested: string | null }
  stopped?: string
}

/** SalvoEscrowV2.BOND_MAX_AGE: a deposit no sale covers comes back by rule after this. */
const BOND_MAX_AGE_S = 604_800

/**
 * Do what is due now, by the chain's clock, and say what is not:
 *   - a held deposit comes back to its buyer (releaseBond), exactly, once the
 *     sale covering it is past its contest window (or, with no covering sale,
 *     once it is 7 days old);
 *   - N contesting card 2's remainder after its window is refused ("too late");
 *   - each sale past its payout time pays the seller exactly (release);
 *   - the contested sale is never released ("state").
 * N sends everything (anyone may), so the seller's and B's balances move by
 * the payouts alone. It reads the state of every sale from the chain, so it
 * also settles a run that stopped halfway, and counts what someone else (the
 * keeper) already did as done. Run it again until it says done.
 */
export async function resumeEscrowSmokeV2(deps: {
  hosts: HostsConfig
  template: TemplateV2
  state: SmokeStateV2
  say: (line: string) => void
  finalTimeoutMs?: number
  fundTimeoutMs?: number
}): Promise<ResumeSummaryV2> {
  const s = deps.state
  const say = deps.say
  const now = deps.hosts.now ?? Date.now
  const out: ResumeSummaryV2 = {
    ok: false,
    status: 'failed',
    steps: [],
    pending: [],
    nextDueAt: null,
    negatives: { contestTooLate: null, releaseContested: null },
  }
  try {
    if (s.sales.length === 0) throw new SmokeStop('the state file has no sale: the smoke stopped before the first purchase')
    if (deps.template.escrowAddress === null || s.escrow !== deps.template.escrowAddress) {
      throw new SmokeStop('the state file is for another escrow than the one pinned now')
    }
    const escrow = s.escrow
    const block = (): Promise<AgreedBlock> => agreedFinalizedBlock(deps.hosts)
    const who = (b: 'shopper' | 'next'): Hex => s.addresses[b]
    const N = privateKeyToAccount(s.keys.next)

    // Every sale must still be the smoke's own.
    const b0 = await block()
    const chainNow = Number(b0.timestamp)
    const deposits = new Map<SmokeSaleRoleV2, DepositViewV2>()
    for (const sale of s.sales) {
      const d = await depositV2At(deps.hosts, b0, escrow, BigInt(sale.id))
      if (d.depositor !== who(sale.buyer) || d.seller !== s.addresses.seller || d.listingId !== sale.listingId) {
        throw new SmokeStop(`deposit ${sale.id} on chain is not the smoke's ${sale.role} sale`)
      }
      deposits.set(sale.role, d)
    }
    const simulate = async (data: Hex): Promise<string> => {
      const sim = await simulateAt(deps.hosts, await block(), { from: who('next'), to: escrow, data })
      return sim.ok ? 'accepted' : sim.reason
    }
    let funded = false
    const ensureFunded = async (): Promise<void> => {
      if (funded) return
      funded = true
      if ((await tokenBalanceAt(deps.hosts, await block(), PATH_USD, who('next'))) > 0n) return
      await requestFaucet(deps.hosts, who('next'))
      const deadline = now() + (deps.fundTimeoutMs ?? 90_000)
      while ((await tokenBalanceAt(deps.hosts, await block(), PATH_USD, who('next'))) === 0n) {
        if (now() > deadline) throw new SmokeStop('the faucet funds did not arrive in time')
        await hostSleep(deps.hosts, 1_000)
      }
    }
    const send = async (data: Hex, what: string): Promise<{ hash: Hex; receipt: ChainReceipt }> => {
      await ensureFunded()
      const sent = await sendAndWait(deps.hosts, N, { to: escrow, data }, deps.finalTimeoutMs === undefined ? {} : { timeoutMs: deps.finalTimeoutMs })
      if (sent.receipt.status !== 'success') throw new SmokeStop(`${what} reverted on chain (${sent.signed.hash})`)
      return { hash: sent.signed.hash, receipt: sent.receipt }
    }
    let sent = 0

    // ---- Deposits back --------------------------------------------------------------
    for (const sale of s.sales) {
      const d = deposits.get(sale.role)
      if (d === undefined) continue
      if (d.bondState === V2_STATE.bond.RETURNED) {
        out.steps.push({ what: 'bond_back', role: sale.role, id: sale.id, status: 'already', received: null, ok: true, txHash: null })
        continue
      }
      if (d.bondState !== V2_STATE.bond.HELD) continue
      const data = encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'releaseBond', args: [BigInt(sale.id)] })
      const answer = await simulate(data)
      if (answer === 'bond held') {
        // Due when the sale covering it is past its window; with none, at BOND_MAX_AGE.
        const cover = [...deposits.values()].find((x) => x.covers === BigInt(sale.id) && x.contestUntil !== 0)
        const dueAt =
          cover !== undefined && cover.state !== V2_STATE.deposit.CONTESTED
            ? cover.contestUntil
            : (await listingV2At(deps.hosts, b0, escrow, sale.listingId)).bondSince + BOND_MAX_AGE_S
        out.pending.push({ what: 'bond_back', role: sale.role, id: sale.id, dueAt })
        continue
      }
      if (answer !== 'accepted') throw new SmokeStop(`releaseBond(${sale.id}) would revert (${answer})`)
      const b1 = await block()
      const holderBefore = await tokenBalanceAt(deps.hosts, b1, PATH_USD, who(sale.buyer))
      const escrowBefore = await tokenBalanceAt(deps.hosts, b1, PATH_USD, escrow)
      const tx = await send(data, `releaseBond(${sale.id})`)
      sent++
      const b2 = await block()
      const after = await depositV2At(deps.hosts, b2, escrow, BigInt(sale.id))
      const received = (await tokenBalanceAt(deps.hosts, b2, PATH_USD, who(sale.buyer))) - holderBefore
      const ok =
        after.bondState === V2_STATE.bond.RETURNED && received === d.bond &&
        escrowBefore - (await tokenBalanceAt(deps.hosts, b2, PATH_USD, escrow)) === d.bond
      out.steps.push({ what: 'bond_back', role: sale.role, id: sale.id, status: 'sent', received: received.toString(), ok, txHash: tx.hash })
      deposits.set(sale.role, after)
      say(`deposit back    : sale ${sale.id}, ${received} units to the shopper (${ok ? 'exactly the deposit' : 'A BALANCE IS OFF'})`)
    }

    // ---- N contesting card 2's remainder after its window: too late ------------------
    const rest = s.sales.find((x) => x.role === 'remainder')
    const restD = deposits.get('remainder')
    if (rest !== undefined && restD !== undefined && restD.state === V2_STATE.deposit.OPENED && chainNow >= restD.contestUntil) {
      out.negatives.contestTooLate = await simulate(
        encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'contestRemainder', args: [BigInt(rest.id), CONTEST_REASON] }),
      )
      say(`late contest    : "${out.negatives.contestTooLate}"`)
    }

    // ---- Payouts --------------------------------------------------------------------
    for (const sale of s.sales) {
      const d = deposits.get(sale.role)
      if (d === undefined) continue
      const data = encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'release', args: [BigInt(sale.id)] })
      if (d.state === V2_STATE.deposit.CONTESTED) {
        out.negatives.releaseContested = await simulate(data)
        continue
      }
      if (d.state === V2_STATE.deposit.RELEASED) {
        out.steps.push({ what: 'payout', role: sale.role, id: sale.id, status: 'already', received: null, ok: true, txHash: null })
        continue
      }
      // Refunded by the seller: nothing to pay out. The smoke never refunds, so only someone with S's key could have.
      if (d.state !== V2_STATE.deposit.OPENED) continue
      const answer = await simulate(data)
      if (answer === 'too early') {
        out.pending.push({ what: 'payout', role: sale.role, id: sale.id, dueAt: Math.max(d.releaseAt, d.contestUntil) })
        continue
      }
      if (answer !== 'accepted') throw new SmokeStop(`release(${sale.id}) would revert (${answer})`)
      const b1 = await block()
      const sellerBefore = await tokenBalanceAt(deps.hosts, b1, PATH_USD, s.addresses.seller)
      const escrowBefore = await tokenBalanceAt(deps.hosts, b1, PATH_USD, escrow)
      const statsBefore = await sellerStatsV2At(deps.hosts, b1, escrow, s.addresses.seller)
      const tx = await send(data, `release(${sale.id})`)
      sent++
      const released = escrowEventsV2(tx.receipt, escrow, 'Released')
      const back = escrowEventsV2(tx.receipt, escrow, 'BondReturned').reduce((n, e) => n + e.amount, 0n)
      const b2 = await block()
      const after = await depositV2At(deps.hosts, b2, escrow, BigInt(sale.id))
      const statsAfter = await sellerStatsV2At(deps.hosts, b2, escrow, s.addresses.seller)
      const received = (await tokenBalanceAt(deps.hosts, b2, PATH_USD, s.addresses.seller)) - sellerBefore
      const ok =
        after.state === V2_STATE.deposit.RELEASED &&
        released.length === 1 && released[0]?.amount === d.amount &&
        received === d.amount &&
        escrowBefore - (await tokenBalanceAt(deps.hosts, b2, PATH_USD, escrow)) === d.amount + back &&
        statsAfter.paidOut - statsBefore.paidOut === d.amount && statsAfter.sold === statsBefore.sold + 1
      out.steps.push({ what: 'payout', role: sale.role, id: sale.id, status: 'sent', received: received.toString(), ok, txHash: tx.hash })
      deposits.set(sale.role, after)
      say(`payout          : sale ${sale.id} (${sale.role}), ${received} units to the seller (${ok ? 'exactly the amount' : 'A BALANCE IS OFF'})`)
    }

    // ---- Where it stands --------------------------------------------------------------
    // Settled: no sale still Opened, no deposit still held.
    const bEnd = await block()
    let settled = true
    for (const sale of s.sales) {
      const d = await depositV2At(deps.hosts, bEnd, escrow, BigInt(sale.id))
      if (d.state === V2_STATE.deposit.OPENED || d.bondState === V2_STATE.bond.HELD) settled = false
    }
    out.nextDueAt = out.pending.length === 0 ? null : Math.min(...out.pending.map((p) => p.dueAt))
    const negativesOk =
      (out.negatives.contestTooLate === null || out.negatives.contestTooLate === SMOKE_V2_EXPECTED.contestTooLate) &&
      (out.negatives.releaseContested === null || out.negatives.releaseContested === SMOKE_V2_EXPECTED.releaseContested)
    const stepsOk = out.steps.every((x) => x.ok)
    if (!stepsOk || !negativesOk) out.status = 'failed'
    else if (settled && out.pending.length === 0) out.status = 'done'
    else if (sent === 0) out.status = 'not_yet'
    else out.status = 'partial'
    out.ok = stepsOk && negativesOk
    if (out.status === 'done') say('settled         : every payout made, every deposit where it belongs')
    else if (out.nextDueAt !== null) say(`next            : run --resume again after ${new Date(out.nextDueAt * 1000).toISOString()} (chain time)`)
  } catch (err) {
    out.ok = false
    out.status = 'failed'
    if (err instanceof SmokeStop || err instanceof EscrowRpcError) out.stopped = err.message
    else throw err
  }
  return out
}
