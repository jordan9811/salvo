/** Small helpers shared by the /api/agent routes. */
import { NextResponse } from 'next/server'
import { Challenge, Credential, PaymentRequest } from 'mppx'
import { keccak256 } from 'viem'
import { env } from '../env'
import { isTestnet } from '../mpp'
import { requestOrigin } from '../origins'

export const json = (status: number, body: Record<string, unknown>): NextResponse =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

/** The secret purchase tokens are signed with, or null when MPP is not set up. */
export function tokenSecret(): string | null {
  const s = env().MPP_SECRET_KEY
  return s && s.length >= 32 ? s : null
}

/** Gift card value for real money waits on review: the agent routes run on Tempo's testnet only. */
export function refuseOffTestnet(): NextResponse | null {
  try {
    if (isTestnet()) return null
  } catch {
    /* fall through to the refusal */
  }
  return json(503, { error: 'testnet_only', message: 'Agent purchases run on Tempo testnet only for now. Nothing was charged.' })
}

export async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = (await req.clone().json()) as unknown
    return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** TIP-20 amounts have 6 decimals: one cent is 10,000 base units. */
const UNITS_PER_CENT = 10_000n

/** The amount (in cents) the challenge behind this request's credential asked for, or null when there is no credential. */
export function credentialAmountCents(req: Request): number | null {
  try {
    const amount = (Credential.fromRequest(req).challenge.request as { amount?: unknown }).amount
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return null
    const units = BigInt(amount)
    if (units % UNITS_PER_CENT !== 0n) return null
    return Number(units / UNITS_PER_CENT)
  } catch {
    return null
  }
}

/**
 * Every agent charge is scoped with this metadata. The payment library signs
 * it into the challenge (its opaque field) and compares it exactly when the
 * payment comes back, so a payment made for an agent purchase is refused at
 * /api/mpp/order, and the reverse. A `description` would NOT do this: the
 * library strips it before building the signed challenge.
 */
export const AGENT_CHARGE_META = { route: 'agent-buy' } as const

/** A refused payment worth checking: the transaction it names (lower-case) and when its challenge expires. */
export interface RefusedPayment {
  transaction: string
  mode: 'push' | 'pull'
  /** The challenge it answers: only money bound to THIS id counts (chain.ts). */
  challengeId: string
  expires: string | null
}

/**
 * The transaction a refused credential points at, or null when it is not
 * ours to look at. Only a challenge WE issued, for THIS route, counts: its id
 * is our HMAC over every field, so a made-up credential is dropped before
 * anything is looked up or anyone is paged.
 *   push: the hash it carries (the transfer is already on chain).
 *   pull: the hash of the signed transaction it carries. The library
 *   broadcasts that itself, and no fee payer co-signs here, so that hash is
 *   the one that lands on chain.
 */
export function refusedPayment(req: Request, secretKey: string): RefusedPayment | null {
  try {
    const cred = Credential.fromRequest(req)
    if (!Challenge.verify(cred.challenge, { secretKey })) return null
    const opaque = (cred.challenge as { opaque?: unknown }).opaque
    if (opaque !== PaymentRequest.serialize(AGENT_CHARGE_META)) return null
    const expires = typeof cred.challenge.expires === 'string' ? cred.challenge.expires : null
    const challengeId = cred.challenge.id
    const p = cred.payload as { type?: unknown; hash?: unknown; signature?: unknown }
    if (p.type === 'hash' && typeof p.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(p.hash)) return { transaction: p.hash.toLowerCase(), mode: 'push', challengeId, expires }
    if (p.type === 'transaction' && typeof p.signature === 'string' && /^0x[0-9a-fA-F]+$/.test(p.signature)) {
      return { transaction: keccak256(p.signature as `0x${string}`).toLowerCase(), mode: 'pull', challengeId, expires }
    }
    return null
  } catch {
    return null
  }
}

/**
 * The origin for the URLs an agent is told to call next: the Salvo address
 * it called, so an agent keeps using the one it found. Only addresses of
 * ours are echoed back (src/lib/origins.ts); anything else gets APP_URL.
 */
export function agentBase(req: Request): string {
  return requestOrigin(req) ?? env().APP_URL.replace(/\/+$/, '')
}

/** What the paying wallet signs to fetch a purchase whose buy response was lost. */
export function purchaseRecoveryMessage(transaction: string): string {
  return `salvo purchase ${transaction.toLowerCase()}`
}
