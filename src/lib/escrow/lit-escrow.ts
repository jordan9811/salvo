/**
 * Relaying the escrow template's two runs, `ticket` and `release`, to Lit.
 *
 * OUR SERVER ONLY RELAYS. It sends the template's own source, the listing's
 * manifest and envelope (ciphertext), and what the shopper's device chose:
 * its address and reply-key hash for a ticket, the deposit id and reply key
 * for a release. Lit runs the template, which trusts none of that: it reads
 * the chain itself from two pinned hosts. A ticket moves no money; a release
 * returns the card encrypted to a key only the shopper's phone holds. So
 * nothing that passes through here can open a card or move a cent, and a
 * compromised server can at worst refuse to relay (spec invariant 7).
 *
 * The call carries the execute-only usage key (LIT_VAULT_USAGE_KEY) and
 * `X-Privacy-Mode: true` (transport.ts sets both), so Lit keeps the inputs and
 * the output out of its own logs. The account key, which can spend credit and
 * change the group, is refused if someone sets it here by mistake.
 *
 * Answers are mapped the way the Lit spec section 10 maps the attested
 * template's: a refusal the template sends on purpose is an outcome the route
 * can explain; anything else is a ChipotleRequestError, and nothing Lit sent
 * is ever echoed.
 *
 * Below them, what the release route keeps between requests: the replies it
 * already paid Lit for, and the chain reads it already made.
 *
 * Server-only. Each call is one paid Lit run (about 3 to 7 cents).
 */

import { keccak256, recoverAddress, type Hex } from 'viem'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { ChipotleNotConfiguredError, ChipotleRequestError } from '@/lib/vault/lit/errors'
import { runLitAction, type LitActionResult } from '@/lib/vault/lit/transport'
import { openDigest, replyPayload } from './hashes'
import { ESCROW_CHAIN_ID } from './manifest'
import type { DepositView } from './runbook/reads'
import { agreedFinalizedBlockAndHeads, blockTag, finalizedHeadOn, hostSleep, type AgreedBlock, type HostsConfig } from './runbook/rpc'
import { ticketOf, type TicketView } from './runbook/smoke'
import { escrowRuntime, type EscrowRuntime } from './runtime'

/** Lit's ticket runs read the chain twice and maybe a store; give them room. */
const LIT_DEADLINE_MS = 20_000
const PUB_RE = /^0x0[23][0-9a-f]{64}$/
const ID_RE = /^[1-9][0-9]{0,14}$/

/** The refusals the template sends on purpose. Each costs the shopper nothing. */
export type TicketRefusal =
  /** A key-free check failed: the listing is not Active, the hosts disagree or are down, the manifest is not one it takes. */
  | 'access_denied'
  /** The envelope did not open under this manifest: edited after sealing, or sealed to another key. */
  | 'open_failed'
  /** The card inside does not match the store's format. */
  | 'card_invalid'
  /** The store's balance page did not answer. */
  | 'balance_unavailable'
  /** The card holds less than its listed value. */
  | 'balance_short'
  /** The card holds more over its value than the listing allows. */
  | 'balance_over'

const TICKET_REFUSALS: ReadonlySet<string> = new Set([
  'access_denied',
  'open_failed',
  'card_invalid',
  'balance_unavailable',
  'balance_short',
  'balance_over',
])

export type TicketOutcome = { ok: true; ticket: TicketView } | { ok: false; refusal: TicketRefusal }
export type ReleaseOutcome = { ok: true; reply: string; payload: string } | { ok: false; refusal: 'access_denied' | 'open_failed' }

/**
 * The execute-only Lit usage key. Throws ChipotleNotConfiguredError when it is
 * unset, or when it is the account key: that key can delete the group and
 * spend the credit, and must never be the one a server holds.
 */
function usageKey(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const key = (env.LIT_VAULT_USAGE_KEY ?? '').trim()
  if (key === '') throw new ChipotleNotConfiguredError(['LIT_VAULT_USAGE_KEY'])
  const accountKeys = [env.LIT_CHIPOTLE_ACCOUNT_KEY, env.LIT_CHIPOTLE_API_KEY].map((k) => (k ?? '').trim())
  if (accountKeys.some((k) => k !== '' && k === key)) {
    throw new ChipotleNotConfiguredError(['LIT_VAULT_USAGE_KEY (equals the Lit account key; run pnpm lit:setup for an execute-only key)'])
  }
  return key
}

async function run(rt: EscrowRuntime, params: Record<string, unknown>): Promise<LitActionResult> {
  return runEscrowAction(rt, rt.template.source, params)
}

/**
 * One run of an escrow template's `source` on Lit, with the execute-only
 * usage key: V1's here, V2's from lit-escrow-v2.ts. The same deadline, key
 * rule and privacy mode for both.
 */
export async function runEscrowAction(rt: EscrowRuntime, source: string, params: Record<string, unknown>): Promise<LitActionResult> {
  return runLitAction({ deadlineMs: LIT_DEADLINE_MS, ...rt.lit, apiKey: usageKey() }, source, params)
}

/** The template's own refusal text in an answer `{ok: false, error}`, or null. */
export function refusalOf(response: unknown): string | null {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return null
  const r = response as Record<string, unknown>
  return r.ok === false && typeof r.error === 'string' ? r.error : null
}

const lower = (s: string): Hex => s.toLowerCase() as Hex

/**
 * Ask Lit for a ticket: its signature that `depositor` may buy this listing
 * with this reply key, valid for a few minutes. Before any money moves. The
 * ticket is checked here against what was asked and the pinned identity; the
 * shopper's device checks it again before it pays.
 */
export async function requestTicket(
  input: { manifest: string; envelope: LitEnvelope; listingId: Hex; depositor: Hex; replyKeyHash: Hex },
  rt: EscrowRuntime = escrowRuntime(),
): Promise<TicketOutcome> {
  const t = rt.template
  if (t.identity === null || t.escrowAddress === null) throw new ChipotleNotConfiguredError(['escrow template identity and address pins'])
  const result = await run(rt, {
    op: 'ticket',
    manifest: input.manifest,
    envelope: input.envelope,
    depositor: lower(input.depositor),
    replyKeyHash: lower(input.replyKeyHash),
  })
  const refusal = refusalOf(result.response)
  if (refusal !== null) {
    if (TICKET_REFUSALS.has(refusal)) return { ok: false, refusal: refusal as TicketRefusal }
    throw new ChipotleRequestError(result.status, 'bad_response', 'the template answered with an error it never sends')
  }
  const k = ticketOf(result.response)
  if (k === null) throw new ChipotleRequestError(result.status, 'bad_response', 'the ticket was not in the expected shape')
  if (
    lower(k.listingId) !== lower(input.listingId) ||
    lower(k.depositor) !== lower(input.depositor) ||
    lower(k.replyKeyHash) !== lower(input.replyKeyHash)
  ) {
    throw new ChipotleRequestError(result.status, 'bad_response', 'the ticket names another listing, buyer or reply key')
  }
  let signer: string
  try {
    signer = await recoverAddress({
      hash: openDigest(ESCROW_CHAIN_ID, t.escrowAddress, {
        listingId: k.listingId,
        depositor: k.depositor,
        replyKeyHash: k.replyKeyHash,
        openBalanceCents: k.openBalanceCents,
        cardTag: k.cardTag,
        notAfter: k.notAfter,
      }),
      signature: k.signature,
    })
  } catch {
    throw new ChipotleRequestError(result.status, 'bad_response', 'the ticket signature does not recover')
  }
  if (lower(signer) !== lower(t.identity)) {
    throw new ChipotleRequestError(result.status, 'bad_response', 'the ticket is not signed by the pinned identity')
  }
  return { ok: true, ticket: k }
}

/**
 * Ask Lit to release a bought card to `replyKey`. The template opens it only
 * if the deposit on chain is Opened or Released, is for this listing, and
 * records keccak256(replyKey). It answers ciphertext only, keyed to this
 * deposit, escrow and manifest; the same request always answers the same
 * bytes, so a retry is safe.
 */
export async function requestRelease(
  input: { manifest: string; envelope: LitEnvelope; depositId: string; replyKey: string },
  rt: EscrowRuntime = escrowRuntime(),
): Promise<ReleaseOutcome> {
  const t = rt.template
  if (t.escrowAddress === null) throw new ChipotleNotConfiguredError(['escrow template address pin'])
  if (!ID_RE.test(input.depositId) || !PUB_RE.test(input.replyKey)) {
    throw new RangeError('a release needs a deposit id and a compressed reply key')
  }
  const result = await run(rt, {
    op: 'release',
    manifest: input.manifest,
    envelope: input.envelope,
    depositId: input.depositId,
    replyKey: input.replyKey,
  })
  const refusal = refusalOf(result.response)
  if (refusal === 'access_denied' || refusal === 'open_failed') return { ok: false, refusal }
  if (refusal !== null) throw new ChipotleRequestError(result.status, 'bad_response', 'the template answered with an error it never sends')
  const r = result.response as Record<string, unknown> | null
  if (typeof r !== 'object' || r === null || r.ok !== true || typeof r.reply !== 'string' || typeof r.payload !== 'string') {
    throw new ChipotleRequestError(result.status, 'bad_response', 'the release was not in the expected shape')
  }
  // The reply must be keyed to what was asked, or the phone could not open it anyway.
  if (r.payload !== replyPayload(ESCROW_CHAIN_ID, input.depositId, t.escrowAddress, input.manifest)) {
    throw new ChipotleRequestError(result.status, 'bad_response', 'the release is keyed to another deposit, escrow or manifest')
  }
  if (r.reply.length > 4_096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.reply)) {
    throw new ChipotleRequestError(result.status, 'bad_response', 'the release reply is not base64')
  }
  return { ok: true, reply: r.reply, payload: r.payload }
}

/** keccak256 of a compressed reply key: what `depositAndOpen` records and `release` compares. */
export function replyKeyHashOf(replyKey: string): Hex {
  return lower(keccak256(replyKey as Hex))
}

/**
 * Reply keys one deposit may have a card released to while this process
 * lives. One is all a phone needs, since a repeat is answered from memory;
 * the rest covers a lost phone's new keys (each a rekey on chain, with the
 * root passkey).
 */
const RELEASE_KEYS_PER_DEPOSIT = 6
const MAX_REMEMBERED = 5_000

/**
 * What the release route has already paid Lit for. The template answers the
 * same bytes for the same deposit and key, so a repeat need not be a second
 * paid run, and a buyer cannot turn one purchase into a run a few seconds
 * forever. The replies are ciphertext only that buyer's phone can open.
 *
 * ONLY A RELEASE THAT CAME BACK IS COUNTED, once per reply key. A run the
 * budget refused, one Lit refused (a host down or lagging inside Lit reads as
 * access_denied), and one that never answered cost the buyer a card they have
 * paid for, not a share of anything: counted, a few seconds of host trouble
 * would use up the deposit for good, and the shopper who paid could never get
 * the card through us (spec section 8.11: a release works at any later time).
 * What bounds those failed runs is the per-address limit, the limit on all
 * checks, and the Lit budget, none of which lasts longer than a day.
 *
 * Keyed by escrow too, so a second escrow version never shares a count.
 * Bounded: past the bound the oldest entry goes. Per process, like every
 * escrow limit; the Lit budget (http.ts) caps the total either way.
 */
class ReleaseMemory {
  readonly #replies = new Map<string, { reply: string; payload: string }>()
  readonly #keys = new Map<string, number>()

  /** A reply already relayed for this deposit and this reply key's hash, or null. */
  reply(escrow: Hex, depositId: string, keyHash: Hex): { reply: string; payload: string } | null {
    return this.#replies.get(`${escrow}|${depositId}|${keyHash}`) ?? null
  }

  /** May this deposit have a paid run for a reply key it has not been released to yet? Counts nothing. */
  mayRun(escrow: Hex, depositId: string): boolean {
    return (this.#keys.get(`${escrow}|${depositId}`) ?? 0) < RELEASE_KEYS_PER_DEPOSIT
  }

  /** Keep a release that came back. The first one for a reply key counts against the deposit's keys. */
  keep(escrow: Hex, depositId: string, keyHash: Hex, value: { reply: string; payload: string }): void {
    const k = `${escrow}|${depositId}|${keyHash}`
    if (!this.#replies.has(k)) {
      const d = `${escrow}|${depositId}`
      remember(this.#keys, d, (this.#keys.get(d) ?? 0) + 1)
    }
    remember(this.#replies, k, value)
  }

  clear(): void {
    this.#replies.clear()
    this.#keys.clear()
  }
}

function remember<V>(m: Map<string, V>, k: string, v: V): void {
  if (m.size >= MAX_REMEMBERED && !m.has(k)) {
    const oldest = m.keys().next()
    if (!oldest.done) m.delete(oldest.value)
  }
  m.set(k, v)
}

export const releaseMemory = new ReleaseMemory()

/**
 * What ReleaseChecks needs of a reader: V1's (chain.ts) or V2's (chain-v2.ts).
 * Each escrow keeps its own count, so V1's and V2's deposit ids never mix.
 */
export interface DepositCounter {
  readonly escrow: Hex
  readonly hosts: HostsConfig
  block(): Promise<AgreedBlock>
  depositCount(at: AgreedBlock): Promise<bigint>
  /** The count as one host alone reports it at a block. Decides nothing on its own: it says only whether waiting could help. */
  depositCountOn(index: number, tag: Hex): Promise<bigint>
}

/**
 * The deposit count is read again at most this often, however many ids past
 * it are asked for. Short: a shopper who just paid asks for the deposit after
 * it, and the phone tries again a second later.
 */
const COUNT_REFRESH_MS = 1_000
/** A deposit read is used again for this long. */
const DEPOSIT_SEEN_MS = 60_000
/** Deposits this close to the newest are what paid shoppers are waiting on. */
const RECENT_DEPOSITS = 50n
/**
 * A release is held while the host that is behind catches up only for an id
 * this close past the agreed count: one batch opens at most five cards, and a
 * few shoppers may pay in one block.
 */
const WAIT_IDS_PAST = 32n
/** And only while that host is at most this many blocks behind (a block is 0.61 s): one further back does not catch up in a wait this short. */
const WAIT_BLOCKS_BEHIND = 4n
/** While a release waits, the host that is behind is asked for its head this often, for at most CATCH_UP_MS. */
const CATCH_UP_POLL_MS = 150
const CATCH_UP_MS = 2_000
/** And at most this many times whatever the clock says, since a test's sleep returns at once. */
const CATCH_UP_TICKS = 14

/** One read of the deposit count, at the block both hosts agree on. */
interface CountRead {
  /** Deposits at `block`. */
  value: bigint
  block: AgreedBlock
  /** When it was read, by the route's clock. */
  at: number
  /** Each host's own finalized head then, in host order. */
  heads: bigint[]
  /** A host was ahead of the agreed block: which, its head, and the count it showed there. Null when the hosts were level. */
  ahead: { host: number; head: bigint; count: bigint } | null
  /** A wait already ran on this read and the host behind did not catch up: not waited for again until the next read. */
  waited: boolean
}

/** Is there a deposit with this id, by the count last read; and the block that read was at, while it is under a second old. */
export interface DepositExists {
  exists: boolean
  count: bigint
  block: AgreedBlock | null
}

/**
 * What the release route has already read from the chain: how many deposits
 * there are, and what each deposit it read said, for a minute.
 *
 * WHY. Every chain read goes to two public hosts that throttle our address,
 * so the route limits them, and a limit taken before anything is known is one
 * a flood can use up for free: made-up deposit ids, or the same real one with
 * a made-up key, from many addresses, until a shopper who has just paid gets
 * "slow down" on their own card. So:
 *   - an id past the newest deposit is no purchase, said for free. The count
 *     is read again at most once a second, one read at a time, however many
 *     such ids arrive;
 *   - a deposit read is kept for a minute, so asking for it again, with any
 *     key, reads nothing, and the reply memory above is checked after it;
 *   - so each real deposit costs at most one read a minute however often it
 *     is asked for, and the newest fifty, what a shopper who just paid is
 *     waiting on, take no share of the route's overall limit. Only older ones
 *     do, and only when not read in the last minute.
 *
 * A PURCHASE ONE BLOCK OLD IS WAITED FOR, NEVER CALLED MISSING. The phone
 * asks for its cards the moment one host has its receipt, and the count is
 * read at the block both hosts agree on, the lower head: with dRPC a block
 * behind (measured 2026-10-14), a deposit one block old was "not there yet"
 * on the first ask, and the card came a second later, on the phone's
 * retry. So each read also asks the host that is ahead, alone, how many
 * deposits it shows at its own head. An id it shows and the agreed count
 * does not yet (just past the count, the host behind by a few blocks at
 * most) is a purchase the chain is about to show: the release waits, asking
 * only the host behind for its head every 150 ms, and reads the count again
 * once that head has moved, for at most two seconds. One wait at a time per
 * escrow, which every release that comes meanwhile joins. What the host
 * ahead says decides nothing on its own: a card is released only on the
 * count both hosts agree on, and Lit checks both again itself. A wait that
 * does not see the host catch up answers "not there yet", and the phone's
 * own retry is the fallback, as it always was.
 *
 * WHAT A FLOOD COSTS: NO MORE THAN BEFORE. A read is the same eight calls
 * as before when a host is behind (agreedFinalizedBlockAndHeads no longer
 * asks a host that is level for the same block twice, which pays for the
 * one call to the host ahead), and six when the hosts are level. A made-up
 * id past what the host ahead shows never waits. Only ids the host ahead
 * already shows can, so a wait is only ever for real purchases, one at a
 * time, and a wait that did not see the host catch up is not run again on
 * the same read.
 *
 * A KEPT READ CAN BE A MINUTE OLD. Opened and Released both release, so a
 * payout in that minute changes nothing. A full refund in that minute means
 * Lit is asked and refuses, as the template checks the chain itself. A key
 * changed on chain (rekey, not on any page yet) is seen within the minute.
 * A deposit that is not there yet is never kept.
 */
class ReleaseChecks {
  readonly #count = new Map<Hex, CountRead>()
  readonly #reading = new Map<Hex, Promise<CountRead>>()
  readonly #catching = new Map<Hex, Promise<CountRead>>()
  readonly #seen = new Map<string, { view: DepositView; at: number }>()

  /**
   * Is there a deposit `id` yet? Answered from the count last read when it
   * can be: ids run 1..depositCount with no gaps, and the count only grows.
   * A larger id reads the count again, at most once a second, and one the
   * host ahead already shows waits for the host behind (the class says how).
   * `block`: the block the count was read at, while that read is under a
   * second old, so the deposit is read at the same block.
   */
  async exists(reader: DepositCounter, id: bigint, now: number): Promise<DepositExists> {
    let c = this.#count.get(reader.escrow) ?? null
    if (c === null || (id > c.value && now - c.at >= COUNT_REFRESH_MS)) c = await this.#read(reader, now)
    if (id > c.value && this.#mayWait(c, id)) c = await this.#catchUp(reader, c, now)
    return { exists: id <= c.value, count: c.value, block: now - c.at < COUNT_REFRESH_MS ? c.block : null }
  }

  /** Could waiting for the host behind show deposit `id`? The host ahead shows it, it is just past the count, and the host behind is only a few blocks back. */
  #mayWait(c: CountRead, id: bigint): boolean {
    return c.ahead !== null && !c.waited && id <= c.ahead.count && id <= c.value + WAIT_IDS_PAST && c.ahead.head - c.block.number <= WAIT_BLOCKS_BEHIND
  }

  /** The count at the agreed block, and at the head of the host ahead when one is. One read at a time per escrow. */
  #read(reader: DepositCounter, now: number): Promise<CountRead> {
    const going = this.#reading.get(reader.escrow)
    if (going !== undefined) return going
    const run = (async (): Promise<CountRead> => {
      try {
        const { block, heads } = await agreedFinalizedBlockAndHeads(reader.hosts)
        let lead = 0
        for (const [i, h] of heads.entries()) if (h > (heads[lead] ?? 0n)) lead = i
        const leadHead = heads[lead] ?? block.number
        const [value, aheadCount] = await Promise.all([
          reader.depositCount(block),
          // The host ahead, alone: only ever a reason to wait, so a host that does not answer it just means no wait.
          leadHead > block.number ? reader.depositCountOn(lead, blockTag(leadHead)).catch(() => null) : Promise.resolve(null),
        ])
        const read: CountRead = {
          value,
          block,
          at: now,
          heads,
          ahead: aheadCount === null ? null : { host: lead, head: leadHead, count: aheadCount },
          waited: false,
        }
        const kept = this.#count.get(reader.escrow)
        if (kept === undefined || kept.block.number <= block.number) this.#count.set(reader.escrow, read)
        return read
      } finally {
        this.#reading.delete(reader.escrow)
      }
    })()
    this.#reading.set(reader.escrow, run)
    return run
  }

  /**
   * Wait for the host behind to reach the head the host ahead showed, asking
   * only it for its head, and read the count again each time that head
   * moves. At most CATCH_UP_MS. One wait at a time per escrow: a release
   * that comes while one runs joins it.
   */
  #catchUp(reader: DepositCounter, from: CountRead, now: number): Promise<CountRead> {
    const going = this.#catching.get(reader.escrow)
    if (going !== undefined) return going
    const run = (async (): Promise<CountRead> => {
      const ahead = from.ahead
      if (ahead === null) return from
      const hosts = reader.hosts
      const clock = hosts.now ?? Date.now
      const until = clock() + CATCH_UP_MS
      let read = from
      try {
        for (let tick = 0; tick < CATCH_UP_TICKS && read.value < ahead.count && clock() < until; tick++) {
          const behind = read.heads.flatMap((h, i) => (h < ahead.head ? [i] : []))
          if (behind.length === 0) break
          await hostSleep(hosts, CATCH_UP_POLL_MS)
          const heads = await Promise.all(behind.map((i) => finalizedHeadOn(hosts, i)))
          if (heads.every((h, j) => h <= (read.heads[behind[j] ?? 0] ?? 0n))) continue
          read = await this.#read(reader, now)
        }
      } catch {
        // A host that cannot be read now: "not there yet", and the phone asks again, as it always could.
      }
      if (read.value < ahead.count) read.waited = true
      return read
    })().finally(() => this.#catching.delete(reader.escrow))
    this.#catching.set(reader.escrow, run)
    return run
  }

  /** Among the newest deposits: a read of it takes no share of the route's overall limit. */
  recent(id: bigint, count: bigint): boolean {
    return id > count - RECENT_DEPOSITS
  }

  /** The deposit as read in the last minute, or null. */
  seen(escrow: Hex, depositId: string, now: number): DepositView | null {
    const s = this.#seen.get(`${escrow}|${depositId}`)
    return s !== undefined && now - s.at < DEPOSIT_SEEN_MS ? s.view : null
  }

  /** Keep a deposit just read. One that is not there yet is not kept. */
  keep(escrow: Hex, depositId: string, view: DepositView, now: number): void {
    if (view.state === 0) return
    remember(this.#seen, `${escrow}|${depositId}`, { view, at: now })
  }

  clear(): void {
    this.#count.clear()
    this.#reading.clear()
    this.#catching.clear()
    this.#seen.clear()
  }
}

export const releaseChecks = new ReleaseChecks()

/** Tests only: forget every relayed reply, run count and chain read the release route kept. */
export function __clearReleaseMemoryForTests(): void {
  releaseMemory.clear()
  releaseChecks.clear()
}
