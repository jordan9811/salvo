/**
 * Relaying salvo-vault-escrow/2's three runs to Lit: `ticket`, `release` and
 * `confirm` (unified spec sections 5.3 and 8.6).
 *
 * OUR SERVER ONLY RELAYS, as for V1 (lit-escrow.ts). It sends the template's
 * own source, the listing's manifest and envelope (ciphertext), and what the
 * shopper's device chose. Lit runs the template, which reads SalvoEscrowV2
 * itself from two pinned hosts and trusts nothing we say. A ticket moves no
 * money, a release answers the card encrypted to a key only the buyer's phone
 * holds, and a confirm is a balance Lit read, signed, which the contract lets
 * move a deposit to the card's seller only. So nothing passing through here
 * can open a card or move a cent to anyone it chooses.
 *
 * WHAT V2 CHANGES. A ticket binds the listing's value left and its sales
 * count, never the cents a buyer will use: the contract alone prices that.
 * So a V2 ticket is checked against the V2 escrow and identity with the OpenV2
 * digest, and it comes with the deposit covering the leftover, unsigned, as
 * the chain said it at the same block. A readable store's short read is
 * refused with a signed Confirm beside it, so the shortfall can post before
 * anyone pays (keeper-v2.ts posts it).
 *
 * Every answer is checked here against what was asked and the pinned
 * identity; anything else is a ChipotleRequestError and nothing Lit sent is
 * echoed. The shopper's device checks a ticket again before it pays.
 *
 * Server-only. Each call is one paid Lit run.
 */

import { recoverAddress, type Hex } from 'viem'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { ChipotleNotConfiguredError, ChipotleRequestError } from '@/lib/vault/lit/errors'
import type { EscrowTemplateV2 } from './config-v2'
import { replyPayload } from './hashes'
import { confirmDigestV2, openDigestV2, signatureFormOkV2 } from './hashes-v2'
import { refusalOf, runEscrowAction, type TicketRefusal } from './lit-escrow'
import { ESCROW_CHAIN_ID } from './manifest'
import { ticketOfV2, type TicketViewV2 } from './runbook/smoke-v2'
import { escrowRuntime, templateV2Of, type EscrowRuntime } from './runtime'

const PUB_RE = /^0x0[23][0-9a-f]{64}$/
const ID_RE = /^[1-9][0-9]{0,14}$/
const HEX32_RE = /^0x[0-9a-f]{64}$/
const SIG_RE = /^0x[0-9a-f]{130}$/

const TICKET_REFUSALS: ReadonlySet<string> = new Set([
  'access_denied',
  'open_failed',
  'card_invalid',
  'balance_unavailable',
  'balance_short',
  'balance_over',
])

/** A balance Lit read and signed for SalvoEscrowV2.confirmRemainder. */
export interface ConfirmViewV2 {
  listingId: Hex
  /** The deposit covering the leftover when Lit read it; 0 if none. */
  bondDeposit: bigint
  /** Cents on the card when Lit read it. */
  balance: number
  /** The agreed block's time the read came after. */
  readAt: number
  signature: Hex
}

export type TicketOutcomeV2 =
  | { ok: true; ticket: TicketViewV2; bondDeposit: bigint }
  /** `confirm` only with balance_short after a sale: the shortfall, signed, for the keeper to post. */
  | { ok: false; refusal: TicketRefusal; confirm: ConfirmViewV2 | null }
export type ReleaseOutcomeV2 = { ok: true; reply: string; payload: string } | { ok: false; refusal: 'access_denied' | 'open_failed' }
export type ConfirmOutcomeV2 =
  | { ok: true; confirm: ConfirmViewV2 }
  | { ok: false; refusal: 'access_denied' | 'open_failed' | 'card_invalid' | 'balance_unavailable' }

const lower = (s: string): Hex => s.toLowerCase() as Hex

/** The V2 template, refusing to run until its escrow and identity are pinned. */
function pinned(rt: EscrowRuntime): { t: EscrowTemplateV2; escrow: Hex; identity: Hex } {
  const t = templateV2Of(rt)
  if (t.identity === null || t.escrowAddress === null) throw new ChipotleNotConfiguredError(['V2 escrow template identity and address pins'])
  return { t, escrow: t.escrowAddress, identity: t.identity }
}

/** A Confirm in the template's answer, if it has exactly the right shape. */
function confirmOf(v: unknown): ConfirmViewV2 | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const c = v as Record<string, unknown>
  if (typeof c.listingId !== 'string' || !HEX32_RE.test(c.listingId)) return null
  if (!Number.isSafeInteger(c.bondDeposit) || (c.bondDeposit as number) < 0) return null
  if (!Number.isSafeInteger(c.balance) || (c.balance as number) < 0 || (c.balance as number) > 0xffffffff) return null
  if (!Number.isSafeInteger(c.readAt) || (c.readAt as number) < 1) return null
  if (typeof c.signature !== 'string' || !SIG_RE.test(c.signature)) return null
  return {
    listingId: c.listingId as Hex,
    bondDeposit: BigInt(c.bondDeposit as number),
    balance: c.balance as number,
    readAt: c.readAt as number,
    signature: c.signature as Hex,
  }
}

/** Throws unless `c` is for `listingId` and signed by the pinned identity under the V2 escrow's domain. */
async function checkConfirm(status: number, c: ConfirmViewV2, listingId: Hex, escrow: Hex, identity: Hex): Promise<void> {
  if (c.listingId !== lower(listingId)) throw new ChipotleRequestError(status, 'bad_response', 'the balance read names another listing')
  if (!signatureFormOkV2(c.signature)) throw new ChipotleRequestError(status, 'bad_response', 'the balance read signature is not one the contract takes')
  let signer: string
  try {
    signer = await recoverAddress({
      hash: confirmDigestV2(ESCROW_CHAIN_ID, escrow, { listingId: c.listingId, bondDeposit: c.bondDeposit, balance: c.balance, readAt: c.readAt }),
      signature: c.signature,
    })
  } catch {
    throw new ChipotleRequestError(status, 'bad_response', 'the balance read signature does not recover')
  }
  if (lower(signer) !== lower(identity)) throw new ChipotleRequestError(status, 'bad_response', 'the balance read is not signed by the pinned identity')
}

/**
 * Ask Lit for a V2 ticket: its signature that `depositor` may buy from this
 * listing, in the state the chain shows now, with this reply key. Before any
 * money moves. Checked here against what was asked, the V2 escrow and the
 * pinned identity.
 */
export async function requestTicketV2(
  input: { manifest: string; envelope: LitEnvelope; listingId: Hex; depositor: Hex; replyKeyHash: Hex },
  rt: EscrowRuntime = escrowRuntime(),
): Promise<TicketOutcomeV2> {
  const { t, escrow, identity } = pinned(rt)
  const result = await runEscrowAction(rt, t.source, {
    op: 'ticket',
    manifest: input.manifest,
    envelope: input.envelope,
    depositor: lower(input.depositor),
    replyKeyHash: lower(input.replyKeyHash),
  })
  const refusal = refusalOf(result.response)
  if (refusal !== null) {
    if (!TICKET_REFUSALS.has(refusal)) throw new ChipotleRequestError(result.status, 'bad_response', 'the template answered with an error it never sends')
    const raw = (result.response as Record<string, unknown>).confirm
    let confirm: ConfirmViewV2 | null = null
    if (refusal === 'balance_short' && raw !== undefined) {
      confirm = confirmOf(raw)
      if (confirm === null) throw new ChipotleRequestError(result.status, 'bad_response', 'the balance read was not in the expected shape')
      await checkConfirm(result.status, confirm, input.listingId, escrow, identity)
    }
    return { ok: false, refusal: refusal as TicketRefusal, confirm }
  }
  const got = ticketOfV2(result.response)
  if (got === null) throw new ChipotleRequestError(result.status, 'bad_response', 'the ticket was not in the expected shape')
  const k = got.ticket
  if (
    lower(k.listingId) !== lower(input.listingId) ||
    lower(k.depositor) !== lower(input.depositor) ||
    lower(k.replyKeyHash) !== lower(input.replyKeyHash)
  ) {
    throw new ChipotleRequestError(result.status, 'bad_response', 'the ticket names another listing, buyer or reply key')
  }
  // The contract's own form: v 27 or 28 and a low s. recoverAddress takes a high-s twin the contract refuses.
  if (!signatureFormOkV2(k.signature)) throw new ChipotleRequestError(result.status, 'bad_response', 'the ticket signature is not one the contract takes')
  let signer: string
  try {
    signer = await recoverAddress({
      hash: openDigestV2(ESCROW_CHAIN_ID, escrow, {
        listingId: k.listingId,
        depositor: k.depositor,
        replyKeyHash: k.replyKeyHash,
        openBalanceCents: k.openBalanceCents,
        cardTag: k.cardTag,
        remainingCents: k.remainingCents,
        sales: k.sales,
        notAfter: k.notAfter,
      }),
      signature: k.signature,
    })
  } catch {
    throw new ChipotleRequestError(result.status, 'bad_response', 'the ticket signature does not recover')
  }
  if (lower(signer) !== lower(identity)) {
    throw new ChipotleRequestError(result.status, 'bad_response', 'the ticket is not signed by the pinned identity')
  }
  return { ok: true, ticket: k, bondDeposit: got.bondDeposit }
}

/**
 * Ask Lit to release a card bought on V2 to `replyKey`. The template opens it
 * only for a sale that is Opened or Released, for this listing, recording
 * keccak256(replyKey). A contested or refunded sale is refused. The answer is
 * ciphertext only, keyed to this deposit, the V2 escrow and the manifest; the
 * same request always answers the same bytes, so a retry is safe.
 */
export async function requestReleaseV2(
  input: { manifest: string; envelope: LitEnvelope; depositId: string; replyKey: string },
  rt: EscrowRuntime = escrowRuntime(),
): Promise<ReleaseOutcomeV2> {
  const { t, escrow } = pinned(rt)
  if (!ID_RE.test(input.depositId) || !PUB_RE.test(input.replyKey)) {
    throw new RangeError('a release needs a deposit id and a compressed reply key')
  }
  const result = await runEscrowAction(rt, t.source, {
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
  if (r.payload !== replyPayload(ESCROW_CHAIN_ID, input.depositId, escrow, input.manifest)) {
    throw new ChipotleRequestError(result.status, 'bad_response', 'the release is keyed to another deposit, escrow or manifest')
  }
  if (r.reply.length > 4_096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.reply)) {
    throw new ChipotleRequestError(result.status, 'bad_response', 'the release reply is not base64')
  }
  return { ok: true, reply: r.reply, payload: r.payload }
}

/**
 * Ask Lit to read a readable listing's balance now and sign it for
 * confirmRemainder (mode 1, after a sale). Anyone may ask and anyone may post
 * it: the contract can only lower what is left, and a shortfall moves a
 * deposit to the card's seller only.
 */
export async function requestConfirmV2(
  input: { manifest: string; envelope: LitEnvelope; listingId: Hex },
  rt: EscrowRuntime = escrowRuntime(),
): Promise<ConfirmOutcomeV2> {
  const { t, escrow, identity } = pinned(rt)
  const result = await runEscrowAction(rt, t.source, { op: 'confirm', manifest: input.manifest, envelope: input.envelope })
  const refusal = refusalOf(result.response)
  if (refusal === 'access_denied' || refusal === 'open_failed' || refusal === 'card_invalid' || refusal === 'balance_unavailable') {
    return { ok: false, refusal }
  }
  if (refusal !== null) throw new ChipotleRequestError(result.status, 'bad_response', 'the template answered with an error it never sends')
  const r = result.response as Record<string, unknown> | null
  const confirm = typeof r === 'object' && r !== null && r.ok === true ? confirmOf(r.confirm) : null
  if (confirm === null) throw new ChipotleRequestError(result.status, 'bad_response', 'the balance read was not in the expected shape')
  await checkConfirm(result.status, confirm, input.listingId, escrow, identity)
  return { ok: true, confirm }
}
