/**
 * pnpm enclave:verify checks an enclave runner's identity from outside, with
 * a fresh nonce of our own (enclave-spec section 5).
 *
 *   pnpm enclave:verify <origin>                  the client's full check against ENCLAVE_IDENTITY_PIN.
 *   pnpm enclave:verify <origin> --allow-fake     also accept the in-repo fake, and say NOT A PROOF.
 *   pnpm enclave:verify <origin> --inspect --compose-hash <0x hex>
 *                                                 a DCAP-valid, non-debug TDX quote only, whose measured compose
 *                                                 hash is the one given (the owner's own sha256 of the exact
 *                                                 app-compose bytes): print what it measures and write
 *                                                 deploy/enclave-inspect.json (runbook step 5).
 *   [--allow-sw-hardening]                        also accept Intel's SWHardeningNeeded status (Q4).
 *
 * It prints the verdict, the app id, the compose hash and the addresses.
 * Never a key: the enclave never sends one.
 *
 * THE FAKE. Without --allow-fake a fake identity is refused. With it, the
 * verdict is "NOT A PROOF". While the enclave pins are still empty (before
 * runbook step 7) the fake's runners cannot match them, so with --allow-fake
 * only, runner and payout are taken from the identity itself, and the output
 * says they were not checked. A quote that fails Intel's check is refused
 * with or without the flag, and --inspect refuses the fake outright, so fake
 * keys can never reach deploy/enclave-inspect.json or orders:deploy.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hex } from 'viem'
import { FAKE_QUOTE_PREFIX } from '../src/lib/agent/enclave/identity'
import { verifyIdentity, type IdentityInspection, type IdentityVerdict } from '../src/lib/agent/enclave/verify'
import { ENCLAVE_IDENTITY_PIN } from '../src/lib/agent/orders/enclave-client-pin'
import { ENCLAVE_ORDERS_PINS, isZeroAddress } from '../src/lib/agent/orders/enclave-pins'
import type { OrdersPin } from '../src/lib/agent/orders/pins'
import { ORDER_NETWORKS, type OrderNetwork } from '../src/lib/agent/orders/terms'
import { parseRunbookArgs } from '../src/lib/escrow/runbook/args'

const argv = process.argv.slice(2)
const ORIGIN = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : undefined
const ARGS = parseRunbookArgs(ORIGIN === undefined ? argv : argv.slice(1), { flags: ['allow-fake', 'inspect', 'allow-sw-hardening'], values: ['compose-hash'] })
const INSPECT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'enclave-inspect.json')
const FETCH_TIMEOUT_MS = 30_000

class VerifyAbort extends Error {}

function say(line = ''): void {
  console.log(line === '' ? '' : `  ${line}`)
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' })
  } catch {
    throw new VerifyAbort(`no answer from ${new URL(url).origin}`)
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

/** A field of the identity body as printable text, or "?". Public data only. */
function field(body: unknown, ...path: string[]): string {
  let v: unknown = body
  for (const k of path) v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined
  return typeof v === 'string' ? v : v === null ? 'none' : '?'
}

function isFakeQuote(doc: unknown): boolean {
  const q = typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>).quote : undefined
  return typeof q === 'string' && Buffer.from(q, 'hex').subarray(0, FAKE_QUOTE_PREFIX.length).toString('utf8') === FAKE_QUOTE_PREFIX
}

/**
 * The order pins the fake is compared with. Pins the runbook has filled are
 * used as they are. An empty pin (zero runner) cannot match any key, so with
 * --allow-fake only, its runner and payout come from the identity itself.
 */
function pinsForFake(body: unknown): { pins: Record<OrderNetwork, OrdersPin>; unchecked: OrderNetwork[] } {
  const pins = { ...ENCLAVE_ORDERS_PINS }
  const unchecked: OrderNetwork[] = []
  for (const n of ORDER_NETWORKS) {
    if (!isZeroAddress(pins[n].runner)) continue
    unchecked.push(n)
    pins[n] = { ...pins[n], runner: field(body, 'runners', n) as Hex, payout: field(body, 'payout', n) as Hex }
  }
  return { pins, unchecked }
}

function printAddresses(body: unknown): void {
  for (const n of ORDER_NETWORKS) {
    say(`${n.padEnd(15)} : runner ${field(body, 'runners', n)}, contract ${field(body, 'contracts', n)}, payout ${field(body, 'payout', n)}`)
  }
}

async function main(): Promise<void> {
  if (ORIGIN === undefined) throw new VerifyAbort('give the enclave origin first: pnpm enclave:verify http://127.0.0.1:8080 [--allow-fake] [--inspect]')
  if (ARGS.unknown.length > 0) throw new VerifyAbort(`unknown argument(s): ${ARGS.unknown.join(', ')}. See the header of scripts/enclave-verify.ts.`)
  if (!/^https?:\/\/[^\s/]+\/?$/.test(ORIGIN)) throw new VerifyAbort('the origin is like https://<gateway host> or http://127.0.0.1:8080')
  const inspect = ARGS.flags.has('inspect')
  const allowFake = ARGS.flags.has('allow-fake')
  const allowSw = ARGS.flags.has('allow-sw-hardening')
  if (inspect && allowFake) throw new VerifyAbort('--inspect never accepts the fake; drop --allow-fake')
  // The inspect's runners go into orders:deploy, so it must be our code: a wrong gateway URL could be someone else's real TDX app.
  const wantCompose = ARGS.values.get('compose-hash')?.toLowerCase()
  if (inspect && (wantCompose === undefined || !/^0x[0-9a-f]{64}$/.test(wantCompose))) {
    throw new VerifyAbort('--inspect needs --compose-hash 0x<64 hex>: your own sha256 of the exact app-compose bytes')
  }
  if (!inspect && wantCompose !== undefined) throw new VerifyAbort('--compose-hash goes only with --inspect')
  const origin = ORIGIN.replace(/\/+$/, '')
  const nonce = `0x${randomBytes(32).toString('hex')}`

  say('─'.repeat(72))
  say(`ENCLAVE VERIFY  ${origin}  (${inspect ? 'inspect: measures only, writes deploy/enclave-inspect.json' : 'the client check'})`)
  say('─'.repeat(72))
  const health = await getJson(`${origin}/v1/health`)
  say(`health          : ${health.status}, self-declared hardware ${field(health.body, 'hardware')} (a hint only)`)
  const id = await getJson(`${origin}/v1/identity?nonce=${nonce}`)
  if (id.status !== 200) throw new VerifyAbort(`the identity route answered ${id.status} ${field(id.body, 'error')}`)
  const doc = id.body
  const body = typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>).body : undefined
  say(`app id          : ${field(body, 'appId')} (self-declared)`)
  say(`compose hash    : ${field(body, 'composeHash')} (self-declared)`)
  printAddresses(body)
  say('')

  if (inspect) {
    const r: IdentityVerdict | IdentityInspection = await verifyIdentity(doc, null, { nonce, inspect: true, allowSwHardeningNeeded: allowSw })
    if (!r.ok) throw new VerifyAbort(`refused: ${r.problem}`)
    if (!('inspected' in r)) throw new VerifyAbort('refused: the check did not return an inspection')
    if (r.composeHash.toLowerCase() !== wantCompose) throw new VerifyAbort(`refused: the measured compose hash ${r.composeHash} is not the one you gave. Nothing was written.`)
    say('MEASURED (from the replayed event log and a DCAP-valid quote):')
    say(`app id          : ${r.appId}`)
    say(`compose hash    : ${r.composeHash}  (the one you gave: it matches)`)
    say(`key provider    : ${r.keyProvider}`)
    say(`tcb status      : ${r.tcbStatus}`)
    say(`os              : mrtd ${r.os.mrtd}`)
    say(`                  rtmr0 ${r.os.rtmr0}`)
    say(`                  rtmr1 ${r.os.rtmr1}`)
    say(`                  rtmr2 ${r.os.rtmr2}`)
    mkdirSync(dirname(INSPECT_FILE), { recursive: true })
    writeFileSync(INSPECT_FILE, JSON.stringify({ ...r, composeHashGiven: wantCompose, origin, inspectedAt: new Date().toISOString() }, null, 2) + '\n')
    say('')
    say('Wrote deploy/enclave-inspect.json. The OS values are the first quote\'s own: osSource "first-quote" unless a dstack verifier agrees.')
    return
  }

  const fake = allowFake && isFakeQuote(doc)
  const { pins, unchecked } = fake ? pinsForFake(body) : { pins: ENCLAVE_ORDERS_PINS, unchecked: [] as OrderNetwork[] }
  const r: IdentityVerdict | IdentityInspection = await verifyIdentity(doc, ENCLAVE_IDENTITY_PIN, {
    nonce,
    allowFakeEnclave: allowFake,
    allowSwHardeningNeeded: allowSw,
    orderPins: pins,
  })
  if (!r.ok) throw new VerifyAbort(`refused: ${r.problem}`)
  if ('inspected' in r) throw new VerifyAbort('refused: the check returned an inspection, not a verdict')
  if (r.proof === 'none') {
    console.log('NOT A PROOF')
    console.log(r.warning)
    if (unchecked.length > 0) say(`The enclave pins are empty for ${unchecked.join(' and ')}: runner and payout were taken from the identity itself, not checked.`)
    say("Checked: the body hash, this nonce in the report data, and each runner's possession signature.")
    say(`caveat: ${r.caveat}`)
    return
  }
  say(`VERDICT         : proof tdx, app ${r.appId}, compose ${r.composeHash}`)
  for (const w of r.warnings) console.log(w)
  say(`caveat: ${r.caveat}`)
}

main().catch((err: unknown) => {
  // Fixed text from this file, or the verifier's own fixed refusal. Never a key.
  const message = err instanceof VerifyAbort ? err.message : 'the check stopped on an error'
  console.error(`\n  enclave:verify: ${message.slice(0, 400)}\n`)
  process.exitCode = 1
})
