/**
 * The client's check of the enclave's identity (enclave-spec section 5).
 *
 * The body is self-declared. What counts is a quote Intel's chain signs, whose
 * report data commits to the body and to the caller's fresh nonce, and whose
 * RTMR3 the event log replays to. The app id, compose hash and key provider
 * are read from that replayed log, never from the body.
 *
 * DCAP is @phala/dcap-qvl 0.7.3 (pure JS). Read from its source (src/verify.js,
 * 2026-11-18): it checks the root CA and PCK CRLs, the TCB info and QE
 * identity signatures and their chains to the Intel root compiled into it, the
 * QE report, the quote signature, and refuses a debug TD unless told
 * otherwise. So the collateral is checked end to end against Intel's root,
 * whichever server it came from. That is why Phala's copy is a safe fallback
 * when Intel's PCS cannot be reached (Q5).
 *
 * THE FAKE. The in-repo fake's quote starts with SALVO-FAKE-TDX-QUOTE/1. It is
 * refused unless the caller passes allowFakeEnclave, and then the answer says
 * "NOT A PROOF". Any other quote that fails DCAP is refused, flag or no flag,
 * so the official simulator's patched quotes are refused too.
 */

import { createHash } from 'node:crypto'
import { getCollateral, getCollateralFromPcs, PHALA_PCCS_URL, verify as dcapVerify, type Collateral, type TcbStatus } from '@phala/dcap-qvl'
import { recoverMessageAddress, type Hex } from 'viem'
import type { OrdersPin } from '@/lib/agent/orders/pins'
import { ENCLAVE_ORDERS_PINS } from '@/lib/agent/orders/enclave-pins'
import type { EnclaveIdentityPin } from '@/lib/agent/orders/enclave-client-pin'
import { ORDER_NETWORKS, type OrderNetwork } from '@/lib/agent/orders/terms'
import { FAKE_QUOTE_PREFIX, KMS_CAVEAT, identityBodyHash, identityPossessionHash, parseIdentityNonce, type IdentityBody, type IdentityDoc } from './identity'

/** What a DCAP check gives back. The checks after it are ours, so a stub cannot skip them. */
export interface TdQuoteFacts {
  tcbStatus: string
  tdAttributes: Uint8Array
  mrtd: Uint8Array
  rtmr0: Uint8Array
  rtmr1: Uint8Array
  rtmr2: Uint8Array
  rtmr3: Uint8Array
  reportData: Uint8Array
}

/** Verifies a quote's Intel signature chain and collateral, or throws. Tests inject a stub. */
export type VerifyQuote = (quote: Uint8Array) => Promise<TdQuoteFacts>

// Defined beside the identity so the image can say it too, without carrying the verifier.
export { KMS_CAVEAT }

export const FAKE_WARNING = 'FAKE ENCLAVE: NOT A PROOF. Anyone with the fake\'s seed can sign as this runner.'

export const FIRST_QUOTE_WARNING = 'OS IMAGE NOT INDEPENDENTLY CHECKED'

export type IdentityVerdict =
  | { ok: true; proof: 'tdx'; appId: Hex; composeHash: Hex; caveat: string; warnings: string[] }
  | { ok: true; proof: 'none'; warning: string; caveat: string }
  | { ok: false; problem: string }

/** What an inspect run prints and writes to deploy/enclave-inspect.json. */
export interface IdentityInspection {
  ok: true
  /** Tells an inspection apart from a verdict. */
  inspected: true
  proof: 'tdx'
  appId: Hex
  composeHash: Hex
  keyProvider: Hex
  tcbStatus: string
  os: { mrtd: Hex; rtmr0: Hex; rtmr1: Hex; rtmr2: Hex }
  runners: Record<OrderNetwork, Hex>
  contracts: Record<OrderNetwork, Hex | null>
  payout: Record<OrderNetwork, Hex>
}

export interface VerifyIdentityOptions {
  /** The nonce this caller sent, fresh and random. */
  nonce: string
  allowFakeEnclave?: boolean
  /** Runs steps 1 to 4 plus debug and TCB, and returns the measured values. Refuses the fake. */
  inspect?: boolean
  /** Also accept Intel's SWHardeningNeeded status (Q4). Off by default. */
  allowSwHardeningNeeded?: boolean
  verifyQuote?: VerifyQuote
  /** The order pins the body must match. Default ENCLAVE_ORDERS_PINS. */
  orderPins?: Readonly<Record<OrderNetwork, OrdersPin>>
  /** Step 8: the quote being paid must name this enclave's contract and runner. */
  paying?: { network: OrderNetwork; orders: string; runner: string }
}

const DSTACK_RUNTIME_EVENT_TYPE = 0x08000001

function hex(b: Uint8Array): Hex {
  return `0x${Buffer.from(b).toString('hex')}` as Hex
}

/**
 * A dstack v1 runtime event's digest: SHA384(type_le || ":" || name || ":" || payload).
 * Read from dstack's cc-eventlog/src/runtime_events.rs (2026-11-18). The log's
 * payloads are only worth anything because we recompute this: RTMR3 covers the
 * digests, not the payloads.
 */
export function dstackEventDigestV1(event: string, payload: Uint8Array): string {
  const type = Buffer.alloc(4)
  type.writeUInt32LE(DSTACK_RUNTIME_EVENT_TYPE)
  return createHash('sha384').update(Buffer.concat([type, Buffer.from(':'), Buffer.from(event, 'utf8'), Buffer.from(':'), Buffer.from(payload)])).digest('hex')
}

/**
 * Replays an RTMR from its digests: start at 48 zero bytes, then
 * RTMR = SHA384(RTMR || digest), a short digest padded to 48 bytes. Copied
 * from the SDK's replay_rtmr (0.5.8 dist/index.js), not imported.
 */
export function replayRtmr(digests: readonly string[]): string {
  let mr = Buffer.alloc(48)
  for (const d of digests) {
    let c = Buffer.from(d, 'hex')
    if (c.length < 48) c = Buffer.concat([c, Buffer.alloc(48 - c.length)])
    mr = createHash('sha384').update(Buffer.concat([mr, c])).digest()
  }
  return mr.toString('hex')
}

/**
 * The default DCAP check: Intel's PCS for collateral first, Phala's PCCS as a
 * fallback (Q5), then dcap-qvl's verify against Intel's root with debug TDs
 * refused.
 */
export async function dcapVerifyQuote(quote: Uint8Array): Promise<TdQuoteFacts> {
  let collateral: Collateral
  try {
    collateral = await getCollateralFromPcs(quote, { timeoutMs: 15_000 })
  } catch {
    collateral = await getCollateral(PHALA_PCCS_URL, quote, { timeoutMs: 15_000 })
  }
  const report = dcapVerify(quote, collateral, Math.floor(Date.now() / 1000))
  const td = report.report.asTd10()
  if (td === null) throw new Error('not a TDX quote')
  return {
    tcbStatus: report.status,
    tdAttributes: td.tdAttributes,
    mrtd: td.mrTd,
    rtmr0: td.rtMr0,
    rtmr1: td.rtMr1,
    rtmr2: td.rtMr2,
    rtmr3: td.rtMr3,
    reportData: td.reportData,
  }
}

interface LogEvent {
  imr: number
  event_type: number
  digest: string
  event: string
  event_payload: string
}

function parseEventLog(text: string): LogEvent[] | null {
  try {
    const v: unknown = JSON.parse(text)
    if (!Array.isArray(v)) return null
    const out: LogEvent[] = []
    for (const e of v as unknown[]) {
      if (typeof e !== 'object' || e === null) return null
      const r = e as Record<string, unknown>
      if (typeof r.imr !== 'number' || typeof r.event_type !== 'number' || typeof r.digest !== 'string') return null
      if (!/^([0-9a-fA-F]{2}){1,48}$/.test(r.digest)) return null
      const event = typeof r.event === 'string' ? r.event : ''
      const payload = typeof r.event_payload === 'string' ? r.event_payload : ''
      if (!/^([0-9a-fA-F]{2})*$/.test(payload)) return null
      out.push({ imr: r.imr, event_type: r.event_type, digest: r.digest.toLowerCase(), event, event_payload: payload.toLowerCase() })
    }
    return out
  } catch {
    return null
  }
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/

/** Step 1's shape check. Anything else in the document is refused, not guessed at. */
function bodyShapeProblem(b: unknown): string | null {
  if (typeof b !== 'object' || b === null) return 'the identity has no body'
  const r = b as Record<string, unknown>
  if (r.v !== 1 || r.kind !== 'salvo-orders-enclave-identity') return 'the identity is not a version 1 Salvo identity'
  for (const field of ['runners', 'contracts', 'payout', 'possession', 'keyPaths'] as const) {
    if (typeof r[field] !== 'object' || r[field] === null) return `the identity's ${field} is missing`
  }
  return null
}

function sameHex(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}

/** Step 7: the body's addresses equal the order pins, and each runner signed the body. */
async function addressProblem(body: IdentityBody, pins: Readonly<Record<OrderNetwork, OrdersPin>>): Promise<string | null> {
  for (const network of ORDER_NETWORKS) {
    const pin = pins[network]
    const runner = body.runners[network]
    if (typeof runner !== 'string' || !ADDRESS_RE.test(runner)) return `the identity's ${network} runner is not an address`
    if (!sameHex(runner, pin.runner)) return `the identity's ${network} runner is not the pinned runner`
    const contract = body.contracts[network]
    if (pin.orders === null ? contract !== null : !sameHex(contract, pin.orders)) return `the identity's ${network} contract is not the pinned contract`
    if (!sameHex(body.payout[network], pin.payout)) return `the identity's ${network} payout is not the pinned payout`
  }
  // Addresses first, signatures second, so a refusal names the real mismatch.
  return possessionProblem(body)
}

/** Each runner key signed this body: the addresses it names are keys the enclave holds, not just words. */
async function possessionProblem(body: IdentityBody): Promise<string | null> {
  const raw = identityPossessionHash(body)
  for (const network of ORDER_NETWORKS) {
    const runner = body.runners[network]
    if (typeof runner !== 'string' || !ADDRESS_RE.test(runner)) return `the identity's ${network} runner is not an address`
    const sig = body.possession[network]
    if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return `the identity's ${network} possession signature is malformed`
    let signer: string
    try {
      signer = await recoverMessageAddress({ message: { raw }, signature: sig as Hex })
    } catch {
      return `the identity's ${network} possession signature does not recover`
    }
    if (!sameHex(signer, runner)) return `the identity's ${network} possession signature is not the runner's`
  }
  return null
}

/** Step 8: the quote being paid names this enclave's contract and runner. */
function payingProblem(body: IdentityBody, paying: VerifyIdentityOptions['paying']): string | null {
  if (paying === undefined) return null
  const contract = body.contracts[paying.network]
  if (contract === null || !sameHex(paying.orders, contract)) return "the quote's contract is not the enclave's"
  if (!sameHex(paying.runner, body.runners[paying.network])) return "the quote's runner is not the enclave's"
  return null
}

function refuse(problem: string): { ok: false; problem: string } {
  return { ok: false, problem }
}

/**
 * Verifies an identity document against the client's pin.
 *
 * `pin` may be null only with `inspect`. A null field in the pin refuses: the
 * check fails closed until the owner's runbook fills it.
 */
export async function verifyIdentity(
  doc: unknown,
  pin: EnclaveIdentityPin | null,
  opts: VerifyIdentityOptions,
): Promise<IdentityVerdict | IdentityInspection> {
  // 1. Parse, then check the body hash and the nonce.
  const nonce = parseIdentityNonce(opts.nonce)
  if (nonce === null) return refuse('the nonce sent was not 32 bytes')
  if (typeof doc !== 'object' || doc === null) return refuse('the identity is not an object')
  const d = doc as Partial<Record<keyof IdentityDoc, unknown>>
  const shape = bodyShapeProblem(d.body)
  if (shape !== null) return refuse(shape)
  const body = d.body as IdentityBody
  let bodyHash: Hex
  try {
    bodyHash = identityBodyHash(body)
  } catch {
    return refuse('the identity body is not canonical JSON')
  }
  if (!sameHex(d.bodyHash, bodyHash)) return refuse("the identity's body hash does not match its body")
  if (!sameHex(d.nonce, nonce)) return refuse('the identity answers another nonce')
  if (typeof d.quote !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(d.quote)) return refuse('the identity has no quote')
  if (typeof d.eventLog !== 'string') return refuse('the identity has no event log')
  const quote = new Uint8Array(Buffer.from(d.quote, 'hex'))
  const expectedReport = Buffer.concat([Buffer.from(bodyHash.slice(2), 'hex'), Buffer.from(nonce.slice(2), 'hex')])
  const orderPins = opts.orderPins ?? ENCLAVE_ORDERS_PINS

  // 2. The fake, or DCAP.
  const prefix = Buffer.from(FAKE_QUOTE_PREFIX, 'utf8')
  if (quote.length >= prefix.length && Buffer.from(quote.subarray(0, prefix.length)).equals(prefix)) {
    if (opts.inspect === true) return refuse('the enclave is fake hardware: not a proof')
    if (opts.allowFakeEnclave !== true) return refuse('the enclave is fake hardware: not a proof')
    // Fake: steps 1, 3, 7 and 8 only.
    if (!Buffer.from(quote.subarray(prefix.length)).equals(expectedReport)) return refuse('the report data is not the body hash and nonce')
    const addr = await addressProblem(body, orderPins)
    if (addr !== null) return refuse(addr)
    const pay = payingProblem(body, opts.paying)
    if (pay !== null) return refuse(pay)
    return { ok: true, proof: 'none', warning: FAKE_WARNING, caveat: KMS_CAVEAT }
  }

  let facts: TdQuoteFacts
  try {
    facts = await (opts.verifyQuote ?? dcapVerifyQuote)(quote)
  } catch {
    return refuse("the quote failed Intel's check")
  }
  // Ours, after DCAP, so a stub or a lax verifier cannot let these through.
  if (facts.tdAttributes.length < 1 || (facts.tdAttributes[0]! & 0x01) !== 0) return refuse('the quote is from a debug TD')
  const allowed = new Set<string>(pin?.tcbStatuses ?? ['UpToDate'])
  if (opts.allowSwHardeningNeeded === true) allowed.add('SWHardeningNeeded' satisfies TcbStatus)
  if (!allowed.has(facts.tcbStatus)) return refuse(`the platform's TCB status ${facts.tcbStatus} is not accepted`)

  // 3. The report data commits to this body and this nonce.
  if (!Buffer.from(facts.reportData).equals(expectedReport)) return refuse('the report data is not the body hash and nonce')

  // 4. Replay RTMR3, and read the events whose payloads match their digests.
  const log = parseEventLog(d.eventLog)
  if (log === null) return refuse('the event log does not parse')
  const rtmr3 = replayRtmr(log.filter((e) => e.imr === 3).map((e) => e.digest))
  if (rtmr3 !== Buffer.from(facts.rtmr3).toString('hex')) return refuse('the event log does not replay to the quote\'s RTMR3')
  const measured = (name: string): Hex | null => {
    const found = log.filter((e) => e.imr === 3 && e.event === name)
    if (found.length !== 1) return null
    const e = found[0]!
    if (e.event_type !== DSTACK_RUNTIME_EVENT_TYPE) return null
    if (dstackEventDigestV1(e.event, Buffer.from(e.event_payload, 'hex')) !== e.digest) return null
    return `0x${e.event_payload}` as Hex
  }
  const appId = measured('app-id')
  const composeHash = measured('compose-hash')
  const keyProvider = measured('key-provider')
  if (appId === null || composeHash === null || keyProvider === null) return refuse('the event log does not measure one app id, compose hash and key provider')
  const os = { mrtd: hex(facts.mrtd), rtmr0: hex(facts.rtmr0), rtmr1: hex(facts.rtmr1), rtmr2: hex(facts.rtmr2) }

  if (opts.inspect === true) {
    // The runners an inspection reports go into orders:deploy: each must have signed this body.
    const pos = await possessionProblem(body)
    if (pos !== null) return refuse(pos)
    return {
      ok: true,
      inspected: true,
      proof: 'tdx',
      appId,
      composeHash,
      keyProvider,
      tcbStatus: facts.tcbStatus,
      os,
      runners: body.runners,
      contracts: body.contracts,
      payout: body.payout,
    }
  }

  // 5. The replayed log against the pin. Never the body's own app id or compose hash.
  if (pin === null || pin.appId === null || pin.composeHashes === null || pin.keyProvider === null || pin.os === null) {
    return refuse("the client's enclave pin is not filled yet")
  }
  if (!sameHex(appId, pin.appId)) return refuse('the app id is not the pinned app id')
  if (!pin.composeHashes.some((h) => sameHex(h, composeHash))) return refuse('the compose hash is not an allowed compose hash')
  if (!sameHex(keyProvider, pin.keyProvider)) return refuse('the key provider is not the pinned key provider')

  // 6. The OS measurements.
  for (const k of ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2'] as const) {
    if (!sameHex(os[k], pin.os[k])) return refuse(`the OS measurement ${k} is not the pinned value`)
  }

  // 7 and 8.
  const addr = await addressProblem(body, orderPins)
  if (addr !== null) return refuse(addr)
  const pay = payingProblem(body, opts.paying)
  if (pay !== null) return refuse(pay)

  // 9.
  const warnings = pin.osSource === 'first-quote' ? [FIRST_QUOTE_WARNING] : []
  return { ok: true, proof: 'tdx', appId, composeHash, caveat: KMS_CAVEAT, warnings }
}
