/**
 * escrow:smoke's logic: one fake card bought on Moderato through the real
 * template on Lit, then every negative in spec section 15, with latency and
 * Lit spend recorded. `resumeEscrowSmoke` is the step after: once the payout
 * time has passed, anyone's `release(id)` pays the seller, and the balances
 * are checked.
 *
 * WHO IS WHO. Three throwaway secp256k1 accounts made for this run: seller S,
 * shopper B, and a third account C that only ever simulates (and, on resume,
 * pays the fee for `release`). Their keys go to the state file before anything
 * is spent, so a run that stops halfway can still be finished or inspected.
 * They are never printed. The card is the `salvotest` merchant's: 9999 and
 * twelve random digits, and only its last four are ever shown.
 *
 * THE ORDER, and why:
 *   0. Free first: escrow:check's reads must pass and Lit must compute our CID.
 *   1. S seals in Node to the pinned encPub and lists. The listing id the
 *      contract emits must equal ours, live.
 *   2. Lit signs a ticket for B. B checks it the way a phone will.
 *   3. While that listing is still for sale, C simulates depositAndOpen with
 *      B's ticket: "not lit", because the ticket names its buyer.
 *   4. B approves and buys (two plain transactions; the phone's one-batch
 *      Load is Phase 3's), final on both hosts.
 *   5. Lit releases to B's reply key; B decrypts; the card must match.
 *   6. Negatives: another reply key, a deposit that does not exist, a
 *      cancelled listing, S relisting the sold card (ticket fine, buy refused
 *      "card not seller's"), a manifest edited after sealing ("open_failed"),
 *      B's dispute (payout held 48 h more), and release still works after it.
 *
 * Because step 6 disputes the deposit, the seller's payout is due 72 h after
 * the purchase, not 24 h: resume says when.
 *
 * Never prints or returns a key, a card number, a signature or ciphertext.
 */

import { randomInt } from 'node:crypto'
import { encodeFunctionData, erc20Abi, keccak256, recoverAddress, stringToHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createReplyKey, sealToTemplate, type LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { ChipotleRequestError } from '@/lib/vault/lit/errors'
import { templateIntegrity, type EscrowTemplate } from '@/lib/vault/lit/templates'
import { litRequest, runLitAction, type LitCallConfig } from '@/lib/vault/lit/transport'
import { spentCents } from '@/lib/vault/lit/setup-plan'
import { ESCROW_ABI } from '../artifact'
import { ESCROW_LIMITS } from '../config'
import { escrowPinProblems } from '../deployment'
import { commitment, envelopeHashOf, listingIdOfSeal, openDigest, replyPayload, termsOfManifest } from '../hashes'
import { buildEscrowManifest, ESCROW_CHAIN_ID, parseEscrowManifest, PATH_USD, UNITS_PER_CENT, type EscrowManifest } from '../manifest'
import { ESCROW_MERCHANTS, MODE_BLIND } from '../merchants'
import { checkPinnedEscrow } from './check'
import { pinProblemWords } from './deploy'
import { depositAt, escrowEvents, escrowFactsAt, gateAt, sellerStatsAt, tokenBalanceAt } from './reads'
import {
  EscrowRpcError,
  agreedFinalizedBlock,
  hostSleep,
  requestFaucet,
  sendAndWait,
  simulateAt,
  type AgreedBlock,
  type HostsConfig,
} from './rpc'
import { releaseOf, type AnyEscrowTemplate } from './versions'

/** The card's value: $1.00, and the shopper pays all of it. Small, so a blind listing needs no seller record. */
const SMOKE_VALUE_CENTS = 100
const SMOKE_PRICE_UNITS = SMOKE_VALUE_CENTS * UNITS_PER_CENT
const LISTING_TTL_S = 86_400
const DEPOSIT_OPENED = 1
const DEPOSIT_RELEASED = 2
const LISTING_ACTIVE = 1
const HEX32_RE = /^0x[0-9a-f]{64}$/
const ZERO32 = `0x${'0'.repeat(64)}`
const SIG_RE = /^0x[0-9a-fA-F]{130}$/
const KEY_RE = /^0x[0-9a-f]{64}$/
const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const DISPUTE_REASON = keccak256(stringToHex('salvo escrow smoke: dispute test'))

/** What each negative must answer for the smoke to pass. */
export const SMOKE_EXPECTED = Object.freeze({
  ticketFromThirdAccount: 'not lit',
  otherReplyKey: 'access_denied',
  missingDeposit: 'access_denied',
  cancelledListing: 'access_denied',
  resoldCardTicket: 'ok',
  resoldCardDeposit: "card not seller's",
  editedManifest: 'open_failed',
})

const lower = (a: string): Hex => a.toLowerCase() as Hex

class SmokeStop extends Error {}

// ---------------------------------------------------------------------------
// The state file
// ---------------------------------------------------------------------------

export interface SmokeState {
  v: 1
  kind: 'salvo-escrow-smoke'
  createdAt: string
  chainId: typeof ESCROW_CHAIN_ID
  escrow: Hex
  template: { id: string; cid: string }
  /** Throwaway testnet keys. This file is the only place they are written. */
  keys: { seller: Hex; shopper: Hex; third: Hex }
  addresses: { seller: Hex; shopper: Hex; third: Hex }
  deposit: { id: string; amount: string; releaseAt: number; listingId: Hex } | null
}

export function smokeStateText(s: SmokeState): string {
  return `${JSON.stringify(s, null, 2)}\n`
}

/** The state, if `text` is one this smoke wrote. Keys must match their addresses. */
export function parseSmokeState(text: string): SmokeState | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const s = v as Record<string, unknown>
  if (s.v !== 1 || s.kind !== 'salvo-escrow-smoke' || s.chainId !== ESCROW_CHAIN_ID) return null
  if (typeof s.escrow !== 'string' || !ADDRESS_RE.test(s.escrow) || typeof s.createdAt !== 'string') return null
  const t = s.template as Record<string, unknown> | null
  if (typeof t !== 'object' || t === null || typeof t.id !== 'string' || typeof t.cid !== 'string') return null
  const keys = s.keys as Record<string, unknown> | null
  const addresses = s.addresses as Record<string, unknown> | null
  if (typeof keys !== 'object' || keys === null || typeof addresses !== 'object' || addresses === null) return null
  for (const who of ['seller', 'shopper', 'third'] as const) {
    const k = keys[who]
    const a = addresses[who]
    if (typeof k !== 'string' || !KEY_RE.test(k) || typeof a !== 'string' || !ADDRESS_RE.test(a)) return null
    if (privateKeyToAccount(k as Hex).address.toLowerCase() !== a) return null
  }
  const d = s.deposit as Record<string, unknown> | null
  if (d !== null) {
    if (typeof d !== 'object' || typeof d.id !== 'string' || !/^[1-9][0-9]{0,14}$/.test(d.id)) return null
    if (typeof d.amount !== 'string' || !/^[0-9]{1,30}$/.test(d.amount) || !Number.isSafeInteger(d.releaseAt)) return null
    if (typeof d.listingId !== 'string' || !HEX32_RE.test(d.listingId)) return null
  }
  return v as SmokeState
}

// ---------------------------------------------------------------------------
// The shopper's ticket check
// ---------------------------------------------------------------------------

export interface TicketView {
  listingId: Hex
  depositor: Hex
  replyKeyHash: Hex
  openBalanceCents: number
  cardTag: Hex
  notAfter: number
  signature: Hex
}

/** A ticket from a template answer `{ok: true, ticket}`, if it has exactly the right shape. */
export function ticketOf(response: unknown): TicketView | null {
  if (typeof response !== 'object' || response === null) return null
  const r = response as Record<string, unknown>
  if (r.ok !== true || typeof r.ticket !== 'object' || r.ticket === null) return null
  const k = r.ticket as Record<string, unknown>
  if (typeof k.listingId !== 'string' || !HEX32_RE.test(k.listingId)) return null
  if (typeof k.depositor !== 'string' || !ADDRESS_RE.test(k.depositor)) return null
  if (typeof k.replyKeyHash !== 'string' || !HEX32_RE.test(k.replyKeyHash)) return null
  if (typeof k.cardTag !== 'string' || !HEX32_RE.test(k.cardTag)) return null
  if (!Number.isSafeInteger(k.openBalanceCents) || !Number.isSafeInteger(k.notAfter)) return null
  if (typeof k.signature !== 'string' || !SIG_RE.test(k.signature)) return null
  return {
    listingId: k.listingId as Hex,
    depositor: k.depositor as Hex,
    replyKeyHash: k.replyKeyHash as Hex,
    openBalanceCents: k.openBalanceCents as number,
    cardTag: k.cardTag as Hex,
    notAfter: k.notAfter as number,
    signature: k.signature as Hex,
  }
}

/**
 * Every reason a shopper's device must refuse to pay with this ticket: it
 * names another buyer, reply key or listing, its balance does not fit the
 * mode, its time window is not one the contract accepts, or its signature is
 * not the pinned identity's. Empty means pay.
 */
export async function ticketProblems(
  k: TicketView,
  expect: { listingId: Hex; depositor: Hex; replyKeyHash: Hex; identity: Hex; escrow: Hex; mode: number; chainTime: number },
): Promise<string[]> {
  const out: string[] = []
  if (k.listingId !== lower(expect.listingId)) out.push('the ticket is for another listing')
  if (k.depositor !== lower(expect.depositor)) out.push('the ticket names another buyer')
  if (k.replyKeyHash !== lower(expect.replyKeyHash)) out.push('the ticket names another reply key')
  if (k.cardTag === ZERO32) out.push('the ticket has no card tag')
  if (expect.mode === MODE_BLIND && k.openBalanceCents !== 0) out.push('a blind ticket carries a balance')
  if (k.notAfter < expect.chainTime || k.notAfter > expect.chainTime + ESCROW_LIMITS.maxTicketTtlSeconds) {
    out.push('the ticket is expired or valid for longer than the contract accepts')
  }
  const v = parseInt(k.signature.slice(130), 16)
  if (v !== 27 && v !== 28) out.push('the ticket signature has a v the contract refuses')
  try {
    const digest = openDigest(ESCROW_CHAIN_ID, expect.escrow, {
      listingId: k.listingId,
      depositor: k.depositor,
      replyKeyHash: k.replyKeyHash,
      openBalanceCents: k.openBalanceCents,
      cardTag: k.cardTag,
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

/** Why the smoke must not start against this template, V1's or V2's. Offline. */
export function smokeRefusals(t: AnyEscrowTemplate): string[] {
  const r = releaseOf(t)
  const out: string[] = []
  if (!templateIntegrity(t).intact) out.push('the escrow template no longer matches its pinned sha256 and CID')
  for (const p of escrowPinProblems(t)) out.push(pinProblemWords(p, t.id))
  if (t.identity === null) out.push(`the template's identity is not pinned (pnpm lit:smoke --live --template ${r.litTemplate} --bind)`)
  if (t.encPub === null) out.push(`the template's encPub is not pinned (pnpm lit:smoke --live --template ${r.litTemplate} --bind)`)
  if (t.escrowCreationTx === null) out.push(`the escrow's creation transaction is not pinned (pnpm escrow:deploy${r.versionFlag} --live, then pin it)`)
  return out
}

export interface SmokeSummary {
  ok: boolean
  escrow: Hex | null
  cid: string
  cidMatchesServer: boolean | null
  check: { ok: boolean; problems: string[] } | null
  accounts: { seller: Hex; shopper: Hex; third: Hex } | null
  listingId: Hex | null
  depositId: string | null
  last4: string | null
  match: boolean | null
  negatives: {
    ticketFromThirdAccount: string | null
    otherReplyKey: string | null
    missingDeposit: string | null
    cancelledListing: string | null
    resoldCardTicket: string | null
    resoldCardDeposit: string | null
    /** The relisted card got the same tag as the sold one: one card, one tag, live. */
    sameCardTag: boolean | null
    editedManifest: string | null
    /** B's dispute moved the payout 48 h later. */
    disputeHeld: boolean | null
    releaseAfterDispute: boolean | null
  }
  /** Seconds since the epoch, chain time, when anyone may pay the seller. */
  releaseAt: number | null
  timings: Record<string, number>
  lit: { runs: number; ms: number }
  chain: { txs: number; ms: number }
  totalMs: number
  costCents: { estimated: number; measured: number | null }
  stopped?: string
}

export interface SmokeDeps {
  hosts: HostsConfig
  /** The usage key, and in tests the fake Lit. */
  lit: LitCallConfig
  template: EscrowTemplate
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

interface Listed {
  manifestText: string
  m: EscrowManifest
  envelope: LitEnvelope
  listingId: Hex
}

/** A salvotest card: 9999 and twelve random digits. Only its last four are ever shown. */
export function fakeCardNumber(): string {
  let n = '9999'
  for (let i = 0; i < 12; i++) n += String(randomInt(10))
  return n
}

/** The template's answer as one word. Never the answer itself. */
export function answerOf(response: unknown): string {
  if (typeof response !== 'object' || response === null) return 'unexpected shape'
  const r = response as Record<string, unknown>
  if (r.ok === true) return 'ok'
  return typeof r.error === 'string' && /^[a-z_]{1,40}$/.test(r.error) ? r.error : 'unexpected shape'
}

/** The usage key's Lit balance in cents (a free read), or null when Lit will not say. */
export async function readBalanceCents(cfg: LitCallConfig): Promise<number | null> {
  try {
    const r = await litRequest(cfg, 'GET', '/billing/balance?force=true')
    const j = r.json as Record<string, unknown> | null
    return j !== null && typeof j === 'object' && typeof j.balance_cents === 'number' ? j.balance_cents : null
  } catch (err) {
    if (err instanceof ChipotleRequestError) return null
    throw err
  }
}

export async function runEscrowSmoke(deps: SmokeDeps): Promise<SmokeSummary> {
  const t = deps.template
  const now = deps.hosts.now ?? Date.now
  const started = now()
  const say = deps.say
  const summary: SmokeSummary = {
    ok: false,
    escrow: t.escrowAddress,
    cid: t.cid,
    cidMatchesServer: null,
    check: null,
    accounts: null,
    listingId: null,
    depositId: null,
    last4: null,
    match: null,
    negatives: {
      ticketFromThirdAccount: null,
      otherReplyKey: null,
      missingDeposit: null,
      cancelledListing: null,
      resoldCardTicket: null,
      resoldCardDeposit: null,
      sameCardTag: null,
      editedManifest: null,
      disputeHeld: null,
      releaseAfterDispute: null,
    },
    releaseAt: null,
    timings: {},
    lit: { runs: 0, ms: 0 },
    chain: { txs: 0, ms: 0 },
    totalMs: 0,
    costCents: { estimated: 0, measured: null },
  }
  let balanceBefore: number | null = null

  try {
    const refusals = smokeRefusals(t)
    if (refusals.length > 0) throw new SmokeStop(`refused before any network call: ${refusals.join('; ')}`)
    const escrow = t.escrowAddress as Hex
    const identity = t.identity as Hex
    const encPub = t.encPub as string

    // ---- 0. Free: the deployment check, and Lit's CID ------------------------
    const check = await checkPinnedEscrow(deps.hosts, t)
    summary.check = { ok: check.ok, problems: check.problems }
    if (!check.ok) throw new SmokeStop(`escrow:check does not pass: ${check.problems.join('; ')}`)
    say('escrow:check    : passes on both hosts')
    const remote = await litRequest({ ...deps.lit, apiKey: null }, 'POST', '/get_lit_action_ipfs_id', t.source)
    summary.cidMatchesServer = remote.json === t.cid
    if (!summary.cidMatchesServer) throw new SmokeStop('Lit computes a different CID for the template; nothing spent')
    say(`CID             : ${t.cid} (Lit agrees)`)
    balanceBefore = await readBalanceCents(deps.lit)

    // ---- 1. Three throwaway accounts, saved before anything is spent ---------
    const newKey = deps.newKey ?? generatePrivateKey
    const keys = { seller: newKey(), shopper: newKey(), third: newKey() }
    const S = privateKeyToAccount(keys.seller)
    const B = privateKeyToAccount(keys.shopper)
    const C = privateKeyToAccount(keys.third)
    const addr = { seller: lower(S.address), shopper: lower(B.address), third: lower(C.address) }
    const state: SmokeState = {
      v: 1,
      kind: 'salvo-escrow-smoke',
      createdAt: new Date(now()).toISOString(),
      chainId: ESCROW_CHAIN_ID,
      escrow,
      template: { id: t.id, cid: t.cid },
      keys,
      addresses: addr,
      deposit: null,
    }
    deps.saveNewState(smokeStateText(state))
    summary.accounts = addr
    say(`accounts        : seller ${addr.seller}, shopper ${addr.shopper}, third ${addr.third} (keys in the state file only)`)

    // ---- Helpers ---------------------------------------------------------------
    const lit = async (params: Record<string, unknown>): Promise<unknown> => {
      const r = await runLitAction(deps.lit, t.source, params)
      summary.lit.runs++
      summary.lit.ms += r.elapsedMs
      summary.costCents.estimated += Math.max(1, Math.ceil(r.elapsedMs / 1000))
      return r.response
    }
    const send = async (who: PrivateKeyAccount, to: Hex, data: Hex, what: string): Promise<Awaited<ReturnType<typeof sendAndWait>>> => {
      const sent = await sendAndWait(
        deps.hosts,
        who,
        { to, data },
        deps.finalTimeoutMs === undefined ? {} : { timeoutMs: deps.finalTimeoutMs },
      )
      summary.chain.txs++
      summary.chain.ms += sent.ms
      if (sent.receipt.status !== 'success') throw new SmokeStop(`${what} reverted on chain (${sent.signed.hash})`)
      return sent
    }
    const block = (): Promise<AgreedBlock> => agreedFinalizedBlock(deps.hosts)
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
    const manifestFor = (expiry: number, salt: string): { text: string; m: EscrowManifest } => {
      const text = buildEscrowManifest({
        escrow,
        seller: addr.seller,
        merchant: ESCROW_MERCHANTS.salvotest.id,
        mode: MODE_BLIND,
        valueCents: SMOKE_VALUE_CENTS,
        price: SMOKE_PRICE_UNITS,
        residualCapCents: 0,
        listingExpiry: expiry,
        salt,
      })
      const m = parseEscrowManifest(text, escrow)
      if (!m) throw new SmokeStop('the smoke wrote a manifest its own parser refuses')
      return { text, m }
    }
    const freshSalt = (): string => generatePrivateKey().slice(2)
    /** S lists `listingManifest` committed to `env`, and the chain must agree on the listing id. */
    const list = async (listingManifest: { text: string; m: EscrowManifest }, env: LitEnvelope, what: string): Promise<Listed> => {
      const m = listingManifest.m
      const listingId = listingIdOfSeal(m, env)
      const commit = commitment(ESCROW_CHAIN_ID, escrow, PATH_USD, termsOfManifest(m), envelopeHashOf(env))
      const sent = await send(S, escrow, encodeFunctionData({ abi: ESCROW_ABI, functionName: 'list', args: [commit] }), what)
      const listed = escrowEvents(sent.receipt, escrow, 'Listed')
      if (listed.length !== 1 || lower(listed[0]?.listingId ?? '') !== listingId) {
        throw new SmokeStop(`${what}: the contract's listing id is not the one this code computes`)
      }
      const g = await gateAt(deps.hosts, await block(), escrow, listingId, 0n)
      if (g.listingState !== LISTING_ACTIVE || g.listingSeller !== addr.seller) throw new SmokeStop(`${what}: the listing is not active for the seller`)
      return { manifestText: listingManifest.text, m, envelope: env, listingId }
    }
    const ticketFor = async (l: Listed, depositor: Hex, replyKeyHash: Hex): Promise<unknown> =>
      lit({ op: 'ticket', manifest: l.manifestText, envelope: l.envelope, depositor, replyKeyHash })
    const depositCall = (l: Listed, k: TicketView): Hex =>
      encodeFunctionData({
        abi: ESCROW_ABI,
        functionName: 'depositAndOpen',
        args: [
          termsOfManifest(l.m),
          envelopeHashOf(l.envelope),
          { replyKeyHash: k.replyKeyHash, openBalanceCents: k.openBalanceCents, cardTag: k.cardTag, notAfter: k.notAfter, signature: k.signature },
        ],
      })
    const checkedTicket = async (response: unknown, l: Listed, depositor: Hex, replyKeyHash: Hex, what: string): Promise<TicketView> => {
      const k = ticketOf(response)
      if (!k) throw new SmokeStop(`${what}: the template answered ${answerOf(response)}, not a ticket`)
      const problems = await ticketProblems(k, {
        listingId: l.listingId,
        depositor,
        replyKeyHash,
        identity,
        escrow,
        mode: MODE_BLIND,
        chainTime: Number((await block()).timestamp),
      })
      if (problems.length > 0) throw new SmokeStop(`${what}: ${problems.join('; ')}`)
      return k
    }

    // ---- 2. Fund all three by the faucet ---------------------------------------
    const tf = now()
    for (const who of [addr.seller, addr.shopper, addr.third]) {
      if ((await tokenBalanceAt(deps.hosts, await block(), PATH_USD, who)) === 0n) await requestFaucet(deps.hosts, who)
    }
    const fundDeadline = now() + (deps.fundTimeoutMs ?? 90_000)
    for (;;) {
      const b = await block()
      const balances = await Promise.all([addr.seller, addr.shopper, addr.third].map((who) => tokenBalanceAt(deps.hosts, b, PATH_USD, who)))
      if (balances.every((x) => x >= BigInt(SMOKE_PRICE_UNITS) * 2n)) break
      if (now() > fundDeadline) throw new SmokeStop('the faucet funds did not arrive on both hosts in time')
      await hostSleep(deps.hosts, 1_000)
    }
    summary.timings.fundMs = now() - tf
    say('funded          : all three accounts hold pathUSD on both hosts')

    // ---- 3. S seals card X and lists it ----------------------------------------
    const expiry = Number((await block()).timestamp) + LISTING_TTL_S
    const cardX = fakeCardNumber()
    summary.last4 = cardX.slice(-4)
    const tl = now()
    const m1 = manifestFor(expiry, freshSalt())
    const l1 = await list(m1, seal(cardX, m1.text), 'list')
    summary.timings.listMs = now() - tl
    summary.listingId = l1.listingId
    say(`listed          : ${l1.listingId} in ${summary.timings.listMs} ms (id matches the contract's)`)

    // ---- 4. A ticket for B ------------------------------------------------------
    const replyB = createReplyKey()
    const replyHashB = keccak256(replyB.publicKey as Hex)
    const tt = now()
    const k1 = await checkedTicket(await ticketFor(l1, addr.shopper, replyHashB), l1, addr.shopper, replyHashB, 'ticket')
    summary.timings.ticketMs = now() - tt
    say(`ticket          : ok in ${summary.timings.ticketMs} ms, signed by the pinned identity`)

    // ---- 5. C tries B's ticket (free) ------------------------------------------
    const stolen = await simulateAt(deps.hosts, await block(), { from: addr.third, to: escrow, data: depositCall(l1, k1) })
    summary.negatives.ticketFromThirdAccount = stolen.ok ? 'accepted' : stolen.reason
    say(`B's ticket by C : ${summary.negatives.ticketFromThirdAccount}`)

    // ---- 6. B pays: approve, then depositAndOpen -------------------------------
    const tap = now()
    await send(B, PATH_USD, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [escrow, BigInt(SMOKE_PRICE_UNITS)] }), 'approve')
    const bought = await send(B, escrow, depositCall(l1, k1), 'depositAndOpen')
    const payMs = now() - tap
    summary.timings.payMs = payMs
    const opened = escrowEvents(bought.receipt, escrow, 'Opened')
    const ev = opened[0]
    if (opened.length !== 1 || ev === undefined || lower(ev.listingId) !== l1.listingId || lower(ev.depositor) !== addr.shopper) {
      throw new SmokeStop('the purchase did not emit one Opened event for this listing and buyer')
    }
    const depositId = ev.depositId
    summary.depositId = depositId.toString()
    const d1 = await depositAt(deps.hosts, await block(), escrow, depositId)
    if (d1.state !== DEPOSIT_OPENED || d1.amount !== BigInt(SMOKE_PRICE_UNITS) || d1.seller !== addr.seller || d1.replyKeyHash !== replyHashB) {
      throw new SmokeStop('the deposit on chain is not the purchase that was sent')
    }
    const deposit = { id: depositId.toString(), amount: d1.amount.toString(), releaseAt: d1.releaseAt, listingId: l1.listingId }
    state.deposit = deposit
    deps.updateState(smokeStateText(state))
    say(`bought          : deposit ${depositId} in ${payMs} ms, final on both hosts`)

    // ---- 7. Release to B, and B opens it ---------------------------------------
    const openRelease = async (response: unknown, what: string): Promise<boolean> => {
      if (typeof response !== 'object' || response === null) throw new SmokeStop(`${what}: unexpected shape`)
      const r = response as Record<string, unknown>
      if (r.ok !== true || typeof r.reply !== 'string' || typeof r.payload !== 'string') {
        throw new SmokeStop(`${what}: the template answered ${answerOf(response)}`)
      }
      if (r.payload !== replyPayload(ESCROW_CHAIN_ID, depositId.toString(), escrow, l1.manifestText)) {
        throw new SmokeStop(`${what}: the reply is keyed to another deposit, escrow or manifest`)
      }
      const plain = replyB.open(r.reply, r.payload, encPub)
      try {
        const card: unknown = JSON.parse(plain.toString('utf8'))
        return typeof card === 'object' && card !== null && (card as Record<string, unknown>).cardNumber === cardX && (card as Record<string, unknown>).pin === null
      } finally {
        plain.fill(0)
      }
    }
    const tr = now()
    const releaseParams = { op: 'release', manifest: l1.manifestText, envelope: l1.envelope, depositId: depositId.toString() }
    summary.match = await openRelease(await lit({ ...releaseParams, replyKey: replyB.publicKey }), 'release')
    const releaseMs = now() - tr
    summary.timings.releaseMs = releaseMs
    // What a shopper waits for after the tap: the purchase, then the release.
    summary.timings.tapToCardMs = payMs + releaseMs
    say(`release         : ${releaseMs} ms, match: ${summary.match ? 'yes' : 'NO'}, last4 ${summary.last4}`)
    if (!summary.match) throw new SmokeStop('the card came back different')

    // ---- 8. Negatives -----------------------------------------------------------
    summary.negatives.otherReplyKey = answerOf(await lit({ ...releaseParams, replyKey: createReplyKey().publicKey }))
    say(`other reply key : ${summary.negatives.otherReplyKey}`)

    const facts = await escrowFactsAt(deps.hosts, await block(), escrow)
    summary.negatives.missingDeposit = answerOf(
      await lit({ ...releaseParams, depositId: (facts.depositCount + 1000n).toString(), replyKey: replyB.publicKey }),
    )
    say(`missing deposit : ${summary.negatives.missingDeposit}`)

    const m2 = manifestFor(expiry, freshSalt())
    const l2 = await list(m2, seal(fakeCardNumber(), m2.text), 'list (to cancel)')
    await send(S, escrow, encodeFunctionData({ abi: ESCROW_ABI, functionName: 'cancelListing', args: [l2.listingId] }), 'cancelListing')
    summary.negatives.cancelledListing = answerOf(await ticketFor(l2, addr.shopper, replyHashB))
    say(`cancelled list  : ${summary.negatives.cancelledListing}`)

    // S relists the card it already sold, with a new salt. Lit's ticket is
    // fine (it does not read card owners); the contract refuses the purchase.
    const m3 = manifestFor(expiry, freshSalt())
    const l3 = await list(m3, seal(cardX, m3.text), 'relist the sold card')
    const replyC = createReplyKey()
    const replyHashC = keccak256(replyC.publicKey as Hex)
    const resold = await ticketFor(l3, addr.third, replyHashC)
    summary.negatives.resoldCardTicket = answerOf(resold)
    if (summary.negatives.resoldCardTicket === 'ok') {
      const k3 = await checkedTicket(resold, l3, addr.third, replyHashC, 'resold ticket')
      summary.negatives.sameCardTag = k3.cardTag === d1.cardTag
      const sim = await simulateAt(deps.hosts, await block(), { from: addr.third, to: escrow, data: depositCall(l3, k3) })
      summary.negatives.resoldCardDeposit = sim.ok ? 'accepted' : sim.reason
    }
    say(`resold card     : ticket ${summary.negatives.resoldCardTicket}, buy ${summary.negatives.resoldCardDeposit ?? 'not tried'}, same tag ${summary.negatives.sameCardTag ? 'yes' : 'no'}`)

    // A manifest edited after sealing: listed as edited, so the chain gate
    // passes and only the seal can refuse it.
    const salt4 = freshSalt()
    const sealed4 = manifestFor(expiry, salt4)
    const env4 = seal(fakeCardNumber(), sealed4.text)
    const l4 = await list(manifestFor(expiry + 1, salt4), env4, 'list an edited manifest')
    summary.negatives.editedManifest = answerOf(await ticketFor(l4, addr.shopper, replyHashB))
    say(`edited manifest : ${summary.negatives.editedManifest}`)

    // B disputes: no money moves, the payout waits 48 h more, release still works.
    await send(B, escrow, encodeFunctionData({ abi: ESCROW_ABI, functionName: 'dispute', args: [depositId, DISPUTE_REASON] }), 'dispute')
    const d2 = await depositAt(deps.hosts, await block(), escrow, depositId)
    summary.negatives.disputeHeld = d2.disputed && d2.releaseAt === d1.releaseAt + ESCROW_LIMITS.disputeHoldSeconds && d2.state === DEPOSIT_OPENED
    summary.releaseAt = d2.releaseAt
    deposit.releaseAt = d2.releaseAt
    deps.updateState(smokeStateText(state))
    say(`dispute         : payout ${summary.negatives.disputeHeld ? 'held 48 h more' : 'NOT HELD'}, due ${new Date(d2.releaseAt * 1000).toISOString()}`)
    summary.negatives.releaseAfterDispute = await openRelease(await lit({ ...releaseParams, replyKey: replyB.publicKey }), 'release after dispute')
    say(`after dispute   : release ${summary.negatives.releaseAfterDispute ? 'still opens the card' : 'FAILED'}`)

    const n = summary.negatives
    summary.ok =
      summary.match === true &&
      n.ticketFromThirdAccount === SMOKE_EXPECTED.ticketFromThirdAccount &&
      n.otherReplyKey === SMOKE_EXPECTED.otherReplyKey &&
      n.missingDeposit === SMOKE_EXPECTED.missingDeposit &&
      n.cancelledListing === SMOKE_EXPECTED.cancelledListing &&
      n.resoldCardTicket === SMOKE_EXPECTED.resoldCardTicket &&
      n.resoldCardDeposit === SMOKE_EXPECTED.resoldCardDeposit &&
      n.sameCardTag === true &&
      n.editedManifest === SMOKE_EXPECTED.editedManifest &&
      n.disputeHeld === true &&
      n.releaseAfterDispute === true
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
// Resume: pay the seller once the payout is due
// ---------------------------------------------------------------------------

export interface ResumeSummary {
  ok: boolean
  status: 'not_yet' | 'paid' | 'already_paid' | 'failed'
  depositId: string | null
  releaseAt: number | null
  /** Token units the seller received from this release. */
  sellerReceived: string | null
  checks: { depositReleased: boolean; sellerPaidExactly: boolean; escrowPaidOutExactly: boolean; paidOutCounted: boolean } | null
  txHash: Hex | null
  stopped?: string
}

/**
 * Pay the seller for the smoke's deposit, once `releaseAt` has passed by the
 * chain's clock. The third account sends `release(id)` (anyone may), so the
 * seller's balance moves by exactly the deposit's amount and no fee.
 */
export async function resumeEscrowSmoke(deps: {
  hosts: HostsConfig
  template: EscrowTemplate
  state: SmokeState
  say: (line: string) => void
  finalTimeoutMs?: number
  fundTimeoutMs?: number
}): Promise<ResumeSummary> {
  const s = deps.state
  const say = deps.say
  const now = deps.hosts.now ?? Date.now
  const out: ResumeSummary = {
    ok: false,
    status: 'failed',
    depositId: s.deposit?.id ?? null,
    releaseAt: s.deposit?.releaseAt ?? null,
    sellerReceived: null,
    checks: null,
    txHash: null,
  }
  try {
    if (s.deposit === null) throw new SmokeStop('the state file has no deposit: the smoke stopped before the purchase')
    if (deps.template.escrowAddress === null || s.escrow !== deps.template.escrowAddress) {
      throw new SmokeStop('the state file is for another escrow than the one pinned now')
    }
    const escrow = s.escrow
    const id = BigInt(s.deposit.id)
    const b0 = await agreedFinalizedBlock(deps.hosts)
    const d = await depositAt(deps.hosts, b0, escrow, id)
    if (d.seller !== s.addresses.seller || d.depositor !== s.addresses.shopper) {
      throw new SmokeStop('the deposit on chain is not the smoke\'s purchase')
    }
    out.releaseAt = d.releaseAt
    if (d.state === DEPOSIT_RELEASED) {
      const stats = await sellerStatsAt(deps.hosts, b0, escrow, s.addresses.seller)
      out.status = 'already_paid'
      out.ok = stats.paidOut >= d.amount
      say(`deposit ${id}    : already paid out to the seller (${out.ok ? 'counted' : 'NOT COUNTED'} in paidOut)`)
      return out
    }
    if (d.state !== DEPOSIT_OPENED) throw new SmokeStop(`deposit ${id} is in state ${d.state}, not Opened`)
    if (b0.timestamp < BigInt(d.releaseAt)) {
      out.status = 'not_yet'
      say(`not yet         : the payout is due ${new Date(d.releaseAt * 1000).toISOString()} by the chain's clock`)
      return out
    }

    // The third account pays the fee for release(), so the seller's balance
    // moves by the payout alone.
    const C = privateKeyToAccount(s.keys.third)
    if ((await tokenBalanceAt(deps.hosts, b0, PATH_USD, s.addresses.third)) === 0n) {
      await requestFaucet(deps.hosts, s.addresses.third)
      const deadline = now() + (deps.fundTimeoutMs ?? 90_000)
      while ((await tokenBalanceAt(deps.hosts, await agreedFinalizedBlock(deps.hosts), PATH_USD, s.addresses.third)) === 0n) {
        if (now() > deadline) throw new SmokeStop('the faucet funds did not arrive in time')
        await hostSleep(deps.hosts, 1_000)
      }
    }
    const b1 = await agreedFinalizedBlock(deps.hosts)
    const sellerBefore = await tokenBalanceAt(deps.hosts, b1, PATH_USD, s.addresses.seller)
    const escrowBefore = await tokenBalanceAt(deps.hosts, b1, PATH_USD, escrow)
    const statsBefore = await sellerStatsAt(deps.hosts, b1, escrow, s.addresses.seller)
    const sent = await sendAndWait(
      deps.hosts,
      C,
      { to: escrow, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'release', args: [id] }) },
      deps.finalTimeoutMs === undefined ? {} : { timeoutMs: deps.finalTimeoutMs },
    )
    out.txHash = sent.signed.hash
    if (sent.receipt.status !== 'success') throw new SmokeStop(`release(${id}) reverted on chain`)
    const released = escrowEvents(sent.receipt, escrow, 'Released')
    if (released.length !== 1 || released[0]?.depositId !== id || released[0]?.amount !== d.amount) {
      throw new SmokeStop('release() did not emit one Released event for the deposit\'s amount')
    }
    const b2 = await agreedFinalizedBlock(deps.hosts)
    const after = await depositAt(deps.hosts, b2, escrow, id)
    const sellerAfter = await tokenBalanceAt(deps.hosts, b2, PATH_USD, s.addresses.seller)
    const escrowAfter = await tokenBalanceAt(deps.hosts, b2, PATH_USD, escrow)
    const statsAfter = await sellerStatsAt(deps.hosts, b2, escrow, s.addresses.seller)
    out.sellerReceived = (sellerAfter - sellerBefore).toString()
    out.checks = {
      depositReleased: after.state === DEPOSIT_RELEASED,
      sellerPaidExactly: sellerAfter - sellerBefore === d.amount,
      escrowPaidOutExactly: escrowBefore - escrowAfter === d.amount,
      paidOutCounted: statsAfter.paidOut - statsBefore.paidOut === d.amount && statsAfter.sold === statsBefore.sold + 1,
    }
    out.ok = Object.values(out.checks).every((v) => v)
    out.status = out.ok ? 'paid' : 'failed'
    say(`released        : deposit ${id}, seller got ${out.sellerReceived} units (${out.ok ? 'every balance checks' : 'A BALANCE IS OFF'})`)
  } catch (err) {
    out.ok = false
    out.status = 'failed'
    if (err instanceof SmokeStop || err instanceof EscrowRpcError) out.stopped = err.message
    else throw err
  }
  return out
}
