/**
 * The enclave's identity document (enclave-spec section 5).
 *
 * The body says which runner keys, contracts and payout addresses this
 * instance uses, and the quote commits to the body and to the caller's fresh
 * nonce: reportData = sha256(body text) || nonce. dstack does not hash the
 * report data for us, and a string would be read as UTF-8, so we hash it
 * ourselves and pass 64 bytes.
 *
 * Each runner key also signs the body (without the signatures), so the
 * document shows the instance holds the keys it names, not just their
 * addresses.
 *
 * Everything the body says about hardware, app id and compose hash is
 * self-declared. verify.ts trusts only the quote and the replayed event log.
 * All hex is 0x-prefixed lower case, so noCardData never sees a bare digit run.
 *
 * PUBLIC EXCERPT. This copy is the half an agent's check needs: the document's
 * shape and its hashes. The half that builds the document inside the runner,
 * from the runner's own keys, is part of the runner's code, which stays
 * private for now, so it is left out here.
 */

import { createHash } from 'node:crypto'
import type { Hex } from 'viem'
import type { OrderNetwork } from '@/lib/agent/orders/terms'

/** The fake's quote is these bytes followed by the report data. Never valid DCAP. */
export const FAKE_QUOTE_PREFIX = 'SALVO-FAKE-TDX-QUOTE/1'

/** The fake guest agent's app id. A real app id is hex. */
export const FAKE_APP_ID = 'fake'

/** The limit of what any enclave answer proves under Phala Cloud KMS (Q6). Every enclave answer carries it. */
export const KMS_CAVEAT =
  'Under Phala Cloud KMS, this fresh quote proves that one instance with these keys runs this code now. ' +
  'It does not prove that the instance which signs your settlement runs it: the owner or Phala can start other code ' +
  'under the same app id and keys. That code could sign any result, and open or rekey any card the runner holds.'

const IDENTITY_DOMAIN = 'salvo-orders-identity/1\n'

export interface IdentityBody {
  v: 1
  kind: 'salvo-orders-enclave-identity'
  /** Self-declared: never trusted. */
  hardware: 'tdx' | 'fake'
  appId: string
  composeHash: string
  instanceId: string
  sdk: '@phala/dstack-sdk@0.5.8'
  keyApi: 'v0'
  keyPaths: { tempo: string; base: string; mac: string }
  /** From the derived keys, not the pins. */
  runners: Record<OrderNetwork, Hex>
  /** The compiled-in pins. */
  contracts: Record<OrderNetwork, Hex | null>
  payout: Record<OrderNetwork, Hex>
  checkout: 'simulated-store'
  possession: Record<OrderNetwork, Hex>
}

export interface IdentityDoc {
  body: IdentityBody
  bodyHash: Hex
  nonce: Hex
  /** Hex, as dstack returns it. */
  quote: string
  /** A JSON array, as text, as dstack returns it. */
  eventLog: string
}

/**
 * Canonical JSON for the identity: sorted keys, safe integers only, plain
 * objects only. The repo's canonicalJson allows only [A-Za-z0-9_] keys, and
 * the body is keyed by network names with a hyphen ("tempo-moderato"), so
 * this copy allows a hyphen too. Nothing else differs.
 */
export function identityCanonicalJson(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TypeError('identity JSON allows safe integers only')
    return String(v)
  }
  if (Array.isArray(v)) return '[' + v.map((x: unknown) => identityCanonicalJson(x)).join(',') + ']'
  if (typeof v === 'object') {
    const proto: unknown = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) throw new TypeError('identity JSON allows plain objects only')
    const o = v as Record<string, unknown>
    const out: string[] = []
    for (const k of Object.keys(o).sort()) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(k) || o[k] === undefined) throw new TypeError('identity JSON keys must match [A-Za-z0-9_-]{1,64} and hold a value')
      out.push(JSON.stringify(k) + ':' + identityCanonicalJson(o[k]))
    }
    return '{' + out.join(',') + '}'
  }
  throw new TypeError(`identity JSON cannot hold a ${typeof v}`)
}

function sha256Hex(text: string): Hex {
  return `0x${createHash('sha256').update(text, 'utf8').digest('hex')}` as Hex
}

/** sha256 of the domain line and the canonical body. The first half of the report data. */
export function identityBodyHash(body: IdentityBody): Hex {
  return sha256Hex(IDENTITY_DOMAIN + identityCanonicalJson(body))
}

/** What each runner key signs: the same hash over the body without `possession`. */
export function identityPossessionHash(body: Omit<IdentityBody, 'possession'> | IdentityBody): Hex {
  const rest: Record<string, unknown> = { ...body }
  delete rest.possession
  return sha256Hex(IDENTITY_DOMAIN + identityCanonicalJson(rest))
}

/** reportData = bodyHash (32 bytes) || nonce (32 bytes), as bytes. */
export function identityReportData(bodyHash: Hex, nonce: Hex): Uint8Array {
  const out = Buffer.concat([Buffer.from(bodyHash.slice(2), 'hex'), Buffer.from(nonce.slice(2), 'hex')])
  if (out.length !== 64) throw new Error('report data must be 64 bytes')
  return new Uint8Array(out)
}

/** A 32-byte nonce written as 0x and 64 hex digits, lower-cased; null otherwise. */
export function parseIdentityNonce(nonce: unknown): Hex | null {
  if (typeof nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null
  return nonce.toLowerCase() as Hex
}
