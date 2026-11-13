/**
 * The shopper's and the seller's own Tempo account, on their device: a
 * passkey as the root key, and one scoped access key that signs without a
 * prompt (spec section 7). No seed phrase, and nothing on our server can sign
 * for it.
 *
 * ===========================================================================
 * THE PASSKEY IS THE ACCOUNT. `WebAuthnP256.createCredential` makes a P-256
 * credential in the platform authenticator (Face ID), and the Tempo account
 * is the address of its public key. Its private half never leaves the
 * authenticator. It is asked for only to set up an access key and to turn one
 * off, never at the till.
 *
 * THE ACCESS KEY IS WHAT SPENDS, AND ONLY THIS WAY. A WebCrypto P-256 key made
 * non-extractable, kept in IndexedDB as a key handle (card-store.ts). The
 * passkey signs a key authorization that limits it, and the chain enforces
 * every limit, not this file:
 *   - shopper: pathUSD `approve` with the escrow as the only spender, and the
 *     escrow's `depositAndOpen` and `dispute`. Nothing else. Up to $200 of
 *     approvals a week (Tempo counts approve increases against the limit;
 *     `depositAndOpen` pulls only from its caller, so this is a real cap on
 *     what this device can put into this escrow). 90 days, then it expires.
 *   - seller: the escrow's `list` and `cancelListing`. No token call at all,
 *     so it can never move money. `sellerRefund` always needs the passkey.
 * `rekey` and `sellerRefund` are in neither scope: whoever runs script on the
 * page cannot redirect a bought card or refund a buyer without Face ID.
 *
 * THE FIRST TRANSACTION CARRIES THE AUTHORIZATION. Setup costs two Face IDs
 * (make the passkey, sign the authorization) and no transaction. The signed
 * authorization waits in IndexedDB, and viem attaches it to the access key's
 * first batch, which the chain checks before running it (Tempo's
 * KeyAuthorizationManager). From then on the key is on chain and the
 * pending copy is dropped.
 *
 * FEES. With a sponsor named in GET /api/escrow/config, the batch asks it to
 * co-sign as fee payer; a fee payer signs over the finished transaction and
 * cannot change it. Without one, or when the sponsor will not fill the batch,
 * the device pays its own fee in pathUSD. Whether a self-paid fee counts
 * against the weekly limit is not documented, so the Load page leaves
 * FEE_HEADROOM_UNITS unspent.
 *
 * ONCE THE SPONSOR HOLDS OUR SIGNED BATCH, THERE IS NO SECOND ONE. To co-sign,
 * the sponsor is sent the batch the access key already signed, and that batch
 * is valid on its own: the sponsor can send it whenever it likes, whatever it
 * answers us. A sponsored batch uses an expiring nonce, so a second, self-paid
 * batch would not cancel it, and both could charge. So any failure from that
 * moment on is SponsorMayHoldError, never a quiet fallback, and the caller
 * keeps the purchase (and its keys) until the chain says what happened.
 *
 * SIGN, THEN SEND, AS TWO STEPS. The batch's hash is known once it is signed,
 * so the caller keeps it before anything is sent. A page that dies after
 * sending can always look the purchase up again, and a retry can never pay
 * twice: a listing sells once, so a second batch for it reverts whole.
 * ===========================================================================
 *
 * READS go to the two pinned hosts and must agree (runbook/rpc.ts). Signed
 * bytes go to the first host, and to the second only if the first cannot be
 * reached: the same bytes are the same transaction.
 *
 * Browser only by use; imports nothing Node-only. Tests pass a fake
 * authenticator (createFn, getFn) and fake hosts. Never logs a key.
 */

import {
  createClient,
  custom,
  decodeFunctionResult,
  encodeFunctionData,
  getAbiItem,
  keccak256,
  toFunctionSelector,
  type AbiFunction,
  type Hex,
} from 'viem'
import { prepareTransactionRequest } from 'viem/actions'
import { tempoModerato } from 'viem/chains'
import {
  Abis,
  Account as TempoAccount,
  Addresses,
  type KeyAuthorizationManager,
  Transaction as TempoTransaction,
  WebAuthnP256,
  WebCryptoP256,
} from 'viem/tempo'
import { ESCROW_ABI } from '../artifact'
import { ESCROW_V2_ABI } from '../artifact-v2'
import { ESCROW_CHAIN_ID, PATH_USD } from '../manifest'
import { tokenBalanceAt } from '../runbook/reads'
import {
  EscrowRpcError,
  agreedFinalizedBlock,
  callAt,
  requestFaucet,
  rpcCall,
  sendRawFast,
  waitForReceiptFinal,
  type HostsConfig,
  type SentRaw,
} from '../runbook/rpc'
import type { AccessKeyRecord, CallScope, CardStore, KeyRestrictions, KeyRole, PasskeyRecord } from './card-store'
import { ensurePasskey } from '@/lib/account/client/passkey'

/** $200 a week, in pathUSD base units. The shopper may lower it at setup. */
export const SHOPPER_WEEKLY_LIMIT_UNITS = 200_000_000n
export const LIMIT_PERIOD_SECONDS = 604_800
export const ACCESS_KEY_LIFETIME_SECONDS = 90 * 86_400
/**
 * Left unspent under the weekly limit when the device pays its own fee:
 * whether that fee counts against the limit is not documented (spec section
 * 7, item 5). Ten cents is far more than a Load's fee (about $0.001).
 */
export const FEE_HEADROOM_UNITS = 100_000n
/** pathUSD `approve(address,uint256)`. */
const APPROVE_SELECTOR: Hex = '0x095ea7b3'
const SPONSOR_TIMEOUT_MS = 15_000

const lower = (a: string): Hex => a.toLowerCase() as Hex
const nowSeconds = (): number => Math.floor(Date.now() / 1000)

type EscrowFunction = 'depositAndOpen' | 'dispute' | 'list' | 'cancelListing'
const selectorOf = (name: EscrowFunction): Hex => toFunctionSelector(getAbiItem({ abi: ESCROW_ABI, name }) as AbiFunction)

/**
 * What a shopper's access key may do: approve only the escrow, open and
 * dispute only through it, at most `weeklyLimitUnits` of approvals a week,
 * for 90 days.
 */
export function shopperKeyRestrictions(escrow: Hex, now: number, weeklyLimitUnits: bigint = SHOPPER_WEEKLY_LIMIT_UNITS): KeyRestrictions {
  if (weeklyLimitUnits <= 0n || weeklyLimitUnits > SHOPPER_WEEKLY_LIMIT_UNITS) {
    throw new RangeError('the weekly limit is between $0.01 and $200')
  }
  return {
    expiry: now + ACCESS_KEY_LIFETIME_SECONDS,
    limits: [{ token: PATH_USD, limit: weeklyLimitUnits, period: LIMIT_PERIOD_SECONDS }],
    scopes: [
      // Tempo's recipient rule on approve constrains its first argument, the spender.
      { address: PATH_USD, selector: APPROVE_SELECTOR, recipients: [lower(escrow)] },
      { address: lower(escrow), selector: selectorOf('depositAndOpen') },
      { address: lower(escrow), selector: selectorOf('dispute') },
    ],
  }
}

/**
 * What a seller's access key may do: list and cancel on the escrow. No token
 * is in scope, so no spending limit is set; a limit could only stop the
 * device paying its own fee, if fees count against one.
 */
export function sellerKeyRestrictions(escrow: Hex, now: number): KeyRestrictions {
  return {
    expiry: now + ACCESS_KEY_LIFETIME_SECONDS,
    limits: [],
    scopes: [
      { address: lower(escrow), selector: selectorOf('list') },
      { address: lower(escrow), selector: selectorOf('cancelListing') },
    ],
  }
}

// ---------------------------------------------------------------------------
// The passkey
// ---------------------------------------------------------------------------

type CreateFn = NonNullable<WebAuthnP256.createCredential.Parameters['createFn']>
type GetFn = NonNullable<TempoAccount.fromWebAuthnP256.Options['getFn']>

export interface PasskeyOptions {
  /** The relying party: the app's own domain on testnet. Default: this page's hostname. */
  rpId?: string
  /** Tests only: a fake authenticator. The browser's own is used otherwise. */
  createFn?: CreateFn
  getFn?: GetFn
}

type RootAccount = ReturnType<typeof TempoAccount.fromWebAuthnP256> | ReturnType<typeof TempoAccount.fromWebCryptoP256>
type SignedKeyAuthorization = Awaited<ReturnType<RootAccount['signKeyAuthorization']>>

export function rootAccountOf(p: PasskeyRecord, o: PasskeyOptions): RootAccount {
  // A tester account signs with its browser key, no Face ID (card-store.ts deviceKey).
  if (p.deviceKey !== undefined) return TempoAccount.fromWebCryptoP256(p.deviceKey)
  return TempoAccount.fromWebAuthnP256(
    { id: p.credentialId, publicKey: p.publicKey },
    { rpId: p.rpId, ...(o.getFn ? { getFn: o.getFn } : {}) },
  )
}

// The passkey itself is found or made in src/lib/account/client/passkey.ts
// (ensurePasskey): the account's code, so that no page, this one's included,
// makes a second account while the phone has one.

// ---------------------------------------------------------------------------
// Chain access: the two hosts, and the optional sponsor
// ---------------------------------------------------------------------------

export interface ChainAccess {
  hosts: HostsConfig
  /** The sponsor's origin from GET /api/escrow/config, or null. */
  sponsorUrl: string | null
  /** Tests only: the sponsor's fetch. */
  sponsorFetch?: typeof fetch
}

/** Thrown when a sponsor refuses or answers wrongly before it holds a signed batch. The caller may pay its own fee. */
class SponsorRefusedError extends Error {
  /** The sponsor said it has no such method (JSON-RPC -32601): it does not fill, and co-signs the signed batch instead. */
  readonly methodMissing: boolean
  constructor(detail: string, methodMissing = false) {
    super(`the fee sponsor ${detail}`)
    this.name = 'SponsorRefusedError'
    this.methodMissing = methodMissing
  }
}

/** JSON-RPC's "method not found". */
const METHOD_NOT_FOUND = -32601

/**
 * The sponsor was sent a batch the access key had signed, and did not give a
 * good co-signed one back. It may still send that batch, so it may still
 * charge: the caller must keep the purchase and ask the chain, and must not
 * sign another batch for the same cards.
 */
export class SponsorMayHoldError extends Error {
  constructor(detail: string) {
    super(`the fee sponsor ${detail}, and it holds a batch this phone signed`)
    this.name = 'SponsorMayHoldError'
  }
}

/** A key this page loaded that the browser no longer keeps (DeviceWallet's #stillKept): it signs nothing. */
class KeyForgottenError extends Error {
  constructor() {
    super('This browser no longer keeps that account, so this page cannot sign with it. Open the page again.')
    this.name = 'KeyForgottenError'
  }
}

async function sponsorCall(access: ChainAccess, method: string, params: readonly unknown[]): Promise<unknown> {
  if (access.sponsorUrl === null) throw new SponsorRefusedError('is not set')
  const doFetch = access.sponsorFetch ?? fetch
  let res: Response
  try {
    res = await doFetch(access.sponsorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(SPONSOR_TIMEOUT_MS),
    })
  } catch {
    throw new SponsorRefusedError('could not be reached')
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new SponsorRefusedError('did not answer JSON')
  }
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const error = typeof o.error === 'object' && o.error !== null ? (o.error as Record<string, unknown>) : null
  if (res.status === 200 && error?.code === METHOD_NOT_FOUND) throw new SponsorRefusedError(`does not answer ${method}`, true)
  if (res.status !== 200 || o.error !== undefined || !('result' in o)) throw new SponsorRefusedError('declined')
  return o.result
}

/** One call on the first host that answers. A node's own refusal is an answer; only an unreachable host is skipped. */
async function hostCall(hosts: HostsConfig, method: string, params: readonly unknown[]): Promise<unknown> {
  let last: unknown = null
  for (const i of [0, 1]) {
    try {
      return await rpcCall(hosts, i, method, params)
    } catch (err) {
      if (!(err instanceof EscrowRpcError) || !['network', 'timeout', 'status'].includes(err.kind)) throw err
      last = err
    }
  }
  throw last instanceof Error ? last : new Error('no host answered')
}

/** What became of a sponsored batch's fill, which viem asks for and never reports. */
interface FillOutcome {
  /** Why the sponsor would not fill it, or null. Set only by a sponsor that does fill. */
  refused: SponsorRefusedError | null
}

/**
 * viem's transport for this device: everything to the hosts, except that a
 * sponsored batch's fill goes to the sponsor, which is how a Tempo fee payer
 * fills and co-signs (viem's withRelay does the same). No retries here: the
 * hosts' own client already decides what is worth the second host.
 *
 * WHY THE FILL'S OUTCOME IS KEPT HERE. viem's prepareTransactionRequest
 * swallows a failed fill and hands back the batch unfilled, so a sponsor
 * that is down or says no at the fill looks, from outside, exactly like one
 * that co-signs later. Signing that batch and sending it to the sponsor
 * would give a sponsor that just refused a batch it can send on its own:
 * SponsorMayHoldError, with no way to pay our own fee. So the refusal is
 * kept here, and signBatch stops before signing anything. A refusal is an
 * error, no answer, or a fill with no fee payer signature (a fill for
 * self-payment). A sponsor that has no fill method at all is not refusing:
 * it co-signs the signed batch.
 */
function transportFor(access: ChainAccess, sponsored: boolean, fill: FillOutcome) {
  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        const p = Array.isArray(params) ? params : []
        if (sponsored && method === 'eth_fillTransaction') {
          let got: unknown
          try {
            got = await sponsorCall(access, method, p)
          } catch (err) {
            if (err instanceof SponsorRefusedError && !err.methodMissing) fill.refused = err
            throw err
          }
          // A sponsor that fills co-signs in the fill. One whose policy says
          // no answers a fill for self-payment instead (Tempo's relay does):
          // a filled batch with no fee payer signature. That is a refusal too,
          // and it would refuse the signed batch next.
          const tx = typeof got === 'object' && got !== null ? (got as Record<string, unknown>).tx : undefined
          const cosigned = typeof tx === 'object' && tx !== null && (tx as Record<string, unknown>).feePayerSignature != null
          if (!cosigned) fill.refused = new SponsorRefusedError('would not pay the fee for this batch')
          return got
        }
        return hostCall(access.hosts, method, p)
      },
    },
    { retryCount: 0 },
  )
}

const chain = tempoModerato.extend({ feeToken: PATH_USD })

export interface BatchCall {
  to: Hex
  data: Hex
}

export interface SignedBatch {
  raw: Hex
  hash: Hex
  sponsored: boolean
}

type AnyTempoAccount = RootAccount | ReturnType<typeof TempoAccount.fromWebCryptoP256>

/**
 * Prepare and sign one Tempo batch from `account`. Sends nothing. With a
 * sponsor, the sponsor co-signs first; its answer must be our own batch with
 * our own signature, or it is refused.
 */
async function signBatch(account: AnyTempoAccount, calls: readonly BatchCall[], access: ChainAccess, sponsored: boolean): Promise<SignedBatch> {
  const fill: FillOutcome = { refused: null }
  const client = createClient({ chain, transport: transportFor(access, sponsored, fill), account })
  const request = await prepareTransactionRequest(client, {
    account,
    calls: calls.map((c) => ({ to: c.to, data: c.data })),
    ...(sponsored ? { feePayer: true as const } : {}),
  } as never)
  // The sponsor would not fill it. Nothing is signed yet, so nothing signed
  // has gone to the sponsor: the caller may pay its own fee instead.
  if (fill.refused !== null) throw fill.refused
  let raw = (await account.signTransaction(request as never, { serializer: chain.serializers.transaction } as never)) as Hex
  if (sponsored) {
    const mine = TempoTransaction.deserialize(raw as `0x76${string}`)
    if (mine.feePayerSignature === null || mine.feePayerSignature === undefined || raw.startsWith('0x78')) {
      // From here the sponsor is sent bytes it can send on its own. Whatever
      // goes wrong now, it may hold a valid batch: no fallback.
      let got: unknown
      try {
        got = await sponsorCall(access, 'eth_signRawTransaction', [raw])
      } catch (err) {
        throw new SponsorMayHoldError(err instanceof Error ? err.message.replace(/^the fee sponsor /, '') : 'did not answer')
      }
      if (typeof got !== 'string' || !got.startsWith('0x76')) throw new SponsorMayHoldError('answered something that is not a Tempo transaction')
      let theirs: ReturnType<typeof TempoTransaction.deserialize>
      try {
        theirs = TempoTransaction.deserialize(got as `0x76${string}`)
      } catch {
        throw new SponsorMayHoldError('answered something that is not a Tempo transaction')
      }
      // The sponsor adds its own signature and nothing else.
      const same = (a: unknown, b: unknown): boolean =>
        JSON.stringify(a, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ===
        JSON.stringify(b, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
      if (!same(theirs.calls, mine.calls) || !same(theirs.signature, mine.signature) || theirs.chainId !== mine.chainId) {
        throw new SponsorMayHoldError('changed the transaction')
      }
      raw = got as Hex
    }
  }
  return { raw, hash: keccak256(raw), sponsored }
}

// ---------------------------------------------------------------------------
// Filled while the shopper types, signed at the tap
// ---------------------------------------------------------------------------

/**
 * A batch the hosts have filled (nonce, gas limit, fees, and the key's first
 * authorization when it has not reached the chain) and nobody has signed:
 * what the tap signs with no network call at all (spec 5.3: the tap only
 * signs and sends). Only ever self-paid: a sponsor's fill is its signature,
 * and a co-signed batch is never made before the tap.
 */
export interface PreparedBatch {
  /** The calls it was filled for. Signed only for exactly these. */
  readonly calls: readonly BatchCall[]
  /** When it was filled, ms. */
  readonly at: number
  /** This account's sends when it was filled: a send since may have used its nonce. */
  readonly generation: number
  /** An expiring nonce's last second (Tempo's validBefore), or null for a plain nonce. */
  readonly validBefore: number | null
  /** viem's filled request. Opaque here. */
  readonly request: unknown
}

/** A filled batch older than this is filled again at the tap: fees and the nonce may have moved on. */
export const PREPARED_MAX_AGE_MS = 30_000
/** An expiring nonce this close to its end is filled again: the batch must be in a block before it. */
const EXPIRING_MARGIN_S = 10

/** Sends per account, from this page: a filled batch from before the last send may carry a used nonce. */
const sendsByAccount = new Map<string, number>()
const sendsOf = (account: Hex): number => sendsByAccount.get(lower(account)) ?? 0
function noteSend(account: Hex): void {
  sendsByAccount.set(lower(account), sendsOf(account) + 1)
}

const sameCalls = (a: readonly BatchCall[], b: readonly BatchCall[]): boolean =>
  a.length === b.length && a.every((c, i) => lower(c.to) === lower(b[i]?.to ?? '') && lower(c.data) === lower(b[i]?.data ?? ''))

/** May this filled batch be signed now, for these calls? Pure apart from the clock. */
export function preparedFresh(p: PreparedBatch | null, account: Hex, calls: readonly BatchCall[], nowMs: number = Date.now()): p is PreparedBatch {
  if (p === null || !sameCalls(p.calls, calls) || p.generation !== sendsOf(account)) return false
  if (nowMs - p.at > PREPARED_MAX_AGE_MS) return false
  return p.validBefore === null || p.validBefore - Math.floor(nowMs / 1000) > EXPIRING_MARGIN_S
}

/** Fill one self-paid batch from the hosts. Signs nothing, sends nothing. */
async function fillBatch(account: AnyTempoAccount, calls: readonly BatchCall[], access: ChainAccess): Promise<PreparedBatch> {
  const generation = sendsOf(account.address as Hex)
  const fill: FillOutcome = { refused: null }
  const client = createClient({ chain, transport: transportFor(access, false, fill), account })
  const request = await prepareTransactionRequest(client, { account, calls: calls.map((c) => ({ to: c.to, data: c.data })) } as never)
  const vb = (request as { validBefore?: unknown }).validBefore
  return { calls: calls.map((c) => ({ to: c.to, data: c.data })), at: Date.now(), generation, validBefore: typeof vb === 'number' ? vb : null, request }
}

/** Sign a filled batch. No network call. */
async function signFilled(account: AnyTempoAccount, p: PreparedBatch): Promise<SignedBatch> {
  const raw = (await account.signTransaction(p.request as never, { serializer: chain.serializers.transaction } as never)) as Hex
  return { raw, hash: keccak256(raw), sponsored: false }
}

/** Send signed bytes: to the first host, to the second only if the first cannot be reached. */
async function broadcastSigned(hosts: HostsConfig, signed: SignedBatch): Promise<void> {
  let last: unknown = null
  for (const i of [0, 1]) {
    try {
      const got = await rpcCall(hosts, i, 'eth_sendRawTransaction', [signed.raw])
      if (typeof got === 'string' && got.toLowerCase() !== signed.hash) {
        throw new EscrowRpcError('rpc', 'bad_response', 'eth_sendRawTransaction answered with another hash')
      }
      return
    } catch (err) {
      if (err instanceof EscrowRpcError && err.kind === 'rpc' && /already known|known transaction/i.test(err.message)) return
      if (!(err instanceof EscrowRpcError) || !['network', 'timeout', 'status'].includes(err.kind)) throw err
      last = err
    }
  }
  throw last instanceof Error ? last : new Error('no host took the transaction')
}

// ---------------------------------------------------------------------------
// The access key
// ---------------------------------------------------------------------------

const pendingName = (k: KeyAuthorizationManager.Key): string => `${k.chainId}:${k.address.toLowerCase()}:${k.accessKey.toLowerCase()}`

/** Tempo's pending-authorization store, kept in IndexedDB so a reload before the first Load keeps it. */
function pendingAuthorizations(store: CardStore): KeyAuthorizationManager.KeyAuthorizationManager {
  return {
    get: async (k) => (await store.pendingAuthorization(pendingName(k))) as SignedKeyAuthorization | undefined,
    set: (k, a) => store.savePendingAuthorization(pendingName(k), a),
    remove: (k) => store.deletePendingAuthorization(pendingName(k)),
  }
}

export interface Allowance {
  /** What the key may still approve this period, in base units. Zero once the key has ended. */
  remainingUnits: bigint
  /** Unix seconds when the period rolls over, when the chain says. */
  periodEnd: number | null
  /** False until the first batch put the key on chain: the remaining is then the signed limit. */
  onChain: boolean
  /** The key expired or was turned off: nothing can be loaded with it, and setup must run again. */
  ended: boolean
}

/**
 * What a shopper key may still put into the escrow now, in token units: the
 * least of the balance and what the allowance has left, less the fee
 * headroom when nobody sponsors the fee. Nothing once the allowance has
 * ended. The till's dollars check (dollars-backend.ts method) and /account's
 * tick both read this, so the two pages name the same way to pay.
 */
export function spendableUnits(balance: bigint, allowance: Pick<Allowance, 'remainingUnits' | 'ended'>, sponsored: boolean): bigint {
  if (allowance.ended) return 0n
  const headroom = sponsored ? 0n : FEE_HEADROOM_UNITS
  const most = balance < allowance.remainingUnits ? balance : allowance.remainingUnits
  return most > headroom ? most - headroom : 0n
}

/**
 * Where an access key stands, by the chain's clock. `pending`: signed, not on
 * chain yet (its first batch carries it). `live`: on chain and usable.
 * `expired`: past the 90 days, on chain or not. `revoked`: turned off on
 * chain, from this device or another.
 */
export type KeyStatus = 'pending' | 'live' | 'expired' | 'revoked'

const ZERO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000'

/**
 * The device's account, as one role uses it: the passkey account's address,
 * and the access key that signs for it.
 */
export class DeviceWallet {
  readonly role: KeyRole
  readonly account: Hex
  readonly accessKeyAddress: Hex
  readonly restrictions: KeyRestrictions
  readonly #store: CardStore
  readonly #record: AccessKeyRecord
  readonly #passkey: PasskeyRecord
  readonly #passkeyOptions: PasskeyOptions

  constructor(store: CardStore, record: AccessKeyRecord, passkey: PasskeyRecord, passkeyOptions: PasskeyOptions = {}) {
    this.#store = store
    this.#record = record
    this.#passkey = passkey
    this.#passkeyOptions = passkeyOptions
    this.role = record.role
    this.account = record.account
    this.accessKeyAddress = record.accessKeyAddress
    this.restrictions = record.restrictions
  }

  #accessAccount() {
    return TempoAccount.fromWebCryptoP256(this.#record.keyPair, {
      access: this.account,
      keyAuthorizationManager: pendingAuthorizations(this.#store),
    })
  }

  /**
   * Is this key still this browser's, for this account? Signing out deletes
   * it from the store (card-store.ts forgetAccount), and so does using
   * another account here; but a page opened before keeps the key's handle in
   * memory, and a non-extractable key signs for as long as that handle lives.
   * A till left open in one tab went on paying from the account signed out
   * in another. So every signature asks the store first: a key forgotten
   * here, replaced by a newer one, or kept for an account no longer signed in
   * here signs nothing.
   */
  async #stillKept(): Promise<void> {
    const [passkey, kept] = await Promise.all([this.#store.passkey(), this.#store.accessKey(this.role)])
    if (passkey === null || lower(passkey.address) !== lower(this.account) || kept === null || lower(kept.accessKeyAddress) !== lower(this.accessKeyAddress)) {
      throw new KeyForgottenError()
    }
  }

  /**
   * Sign one batch with the access key: no prompt. Sponsored when a sponsor
   * is set and does not refuse to fill it; one that refuses at the fill, or
   * cannot be reached for it, was never sent a signed batch, so the device
   * pays its own fee. Throws SponsorMayHoldError when the sponsor was sent
   * the signed batch and did not co-sign it: then no second batch is signed.
   */
  async signCalls(calls: readonly BatchCall[], access: ChainAccess): Promise<SignedBatch> {
    if (calls.length === 0) throw new RangeError('a batch needs at least one call')
    await this.#stillKept()
    const account = this.#accessAccount()
    if (access.sponsorUrl !== null) {
      try {
        return await signBatch(account, calls, access, true)
      } catch (err) {
        // The sponsor would not fill it, and was never sent a signed batch:
        // the device pays its own fee instead.
        if (!(err instanceof SponsorRefusedError)) throw err
      }
    }
    return signBatch(account, calls, access, false)
  }

  async broadcast(signed: SignedBatch, access: ChainAccess): Promise<void> {
    noteSend(this.account)
    await broadcastSigned(access.hosts, signed)
  }

  /**
   * Fill a batch from the hosts now, to sign at the tap with no network call
   * (preparedFresh says when it still may be). Null with a sponsor set: a
   * sponsor co-signs as it fills, so its batch is made at the tap, as today.
   */
  async prepareCalls(calls: readonly BatchCall[], access: ChainAccess): Promise<PreparedBatch | null> {
    if (calls.length === 0) throw new RangeError('a batch needs at least one call')
    if (access.sponsorUrl !== null) return null
    return fillBatch(this.#accessAccount(), calls, access)
  }

  /** Sign a batch filled by prepareCalls, for exactly its calls. No prompt, no network call. */
  async signPrepared(p: PreparedBatch): Promise<SignedBatch> {
    await this.#stillKept()
    return signFilled(this.#accessAccount(), p)
  }

  /**
   * Send signed bytes the fast way (rpc.ts sendRawFast): on Tempo's own host
   * the send also waits for the receipt, in one round trip. The same rule as
   * broadcast: the second host only when the first cannot be reached.
   */
  async broadcastFast(signed: SignedBatch, access: ChainAccess): Promise<SentRaw> {
    noteSend(this.account)
    return sendRawFast(access.hosts, signed.raw, signed.hash)
  }

  /**
   * Where this access key stands on chain. A key never put on chain is still
   * "expired" once its signed expiry has passed: its authorization would be
   * refused, so it can never spend.
   */
  async status(hosts: HostsConfig): Promise<KeyStatus> {
    const block = await agreedFinalizedBlock(hosts)
    const data = await callAt(hosts, block, {
      to: Addresses.accountKeychain,
      data: encodeFunctionData({ abi: Abis.accountKeychain, functionName: 'getKey', args: [this.account, this.accessKeyAddress] }),
    })
    const k = decodeFunctionResult({ abi: Abis.accountKeychain, functionName: 'getKey', data })
    const now = Number(block.timestamp)
    if (lower(k.keyId) === ZERO_ADDRESS) return this.restrictions.expiry > now ? 'pending' : 'expired'
    if (lower(k.keyId) !== this.accessKeyAddress) return 'pending'
    if (k.isRevoked) return 'revoked'
    return Number(k.expiry) > now ? 'live' : 'expired'
  }

  /** Is this access key on chain yet, live and not revoked? */
  async onChain(hosts: HostsConfig): Promise<boolean> {
    return (await this.status(hosts)) === 'live'
  }

  /**
   * What is left of this week's limit. Before the first batch, the whole
   * signed limit; once the key has expired or been turned off, nothing, and
   * `ended` says so, so the page asks to set up again instead of offering a
   * Load the chain will refuse.
   */
  async allowance(hosts: HostsConfig): Promise<Allowance> {
    const limit = this.restrictions.limits.find((l) => lower(l.token) === PATH_USD)
    if (limit === undefined) return { remainingUnits: 0n, periodEnd: null, onChain: false, ended: false }
    const status = await this.status(hosts)
    if (status === 'expired' || status === 'revoked') return { remainingUnits: 0n, periodEnd: null, onChain: false, ended: true }
    if (status === 'pending') return { remainingUnits: limit.limit, periodEnd: null, onChain: false, ended: false }
    const block = await agreedFinalizedBlock(hosts)
    const data = await callAt(hosts, block, {
      to: Addresses.accountKeychain,
      data: encodeFunctionData({
        abi: Abis.accountKeychain,
        functionName: 'getRemainingLimitWithPeriod',
        args: [this.account, this.accessKeyAddress, PATH_USD],
      }),
    })
    const [remaining, periodEnd] = decodeFunctionResult({ abi: Abis.accountKeychain, functionName: 'getRemainingLimitWithPeriod', data })
    return { remainingUnits: remaining, periodEnd: Number(periodEnd), onChain: true, ended: false }
  }

  /**
   * Get paid for a sale that is due: the escrow's release(id), signed by the
   * passkey (one Face ID), since the seller's access key may only list and
   * cancel. Anyone may call release, and it pays only the sale's seller, so
   * this can only pay this account. The device pays the fee in pathUSD: a
   * second send of the same call just reverts, so nothing here needs the
   * care a purchase does. Final on both hosts before it returns.
   */
  async releasePayout(escrow: Hex, depositId: bigint, access: ChainAccess): Promise<void> {
    await this.#rootEscrowCall(escrow, encodeFunctionData({ abi: ESCROW_ABI, functionName: 'release', args: [depositId] }), access, 'the payout')
  }

  /**
   * Collect what the escrow owes this account: claim(account), for payouts
   * the token would not send when they were due (the escrow keeps them as
   * `owed` rather than strand them). Anyone may call claim, and it pays only
   * the address named, which is this account. One Face ID, as releasePayout.
   */
  async claimOwed(escrow: Hex, access: ChainAccess): Promise<void> {
    await this.#rootEscrowCall(escrow, encodeFunctionData({ abi: ESCROW_ABI, functionName: 'claim', args: [this.account] }), access, 'the claim')
  }

  /**
   * The seller's word on an unsold leftover on SalvoEscrowV2 (sell-v2.ts
   * closeRemainderV2 checks when it may be said): `sellerCloseRemainder`,
   * which only this listing's seller may call. It moves a shopper's deposit,
   * to them or to this account, so no access key is ever scoped for it: the
   * passkey signs it (one Face ID), self-paid, final on both hosts.
   */
  async closeRemainderV2(escrow: Hex, listingId: Hex, spent: boolean, access: ChainAccess): Promise<void> {
    const data = encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'sellerCloseRemainder', args: [listingId, spent] })
    await this.#rootEscrowCall(escrow, data, access, spent ? 'the leftover marked spent' : 'the leftover marked still there')
  }

  /** One escrow call from the passkey account, self-paid, final on both hosts before it returns. */
  async #rootEscrowCall(escrow: Hex, data: Hex, access: ChainAccess, what: string): Promise<void> {
    const root = rootAccountOf(this.#passkey, this.#passkeyOptions)
    const signed = await signBatch(root, [{ to: lower(escrow), data }], access, false)
    noteSend(this.account)
    await broadcastSigned(access.hosts, signed)
    const { receipt } = await waitForReceiptFinal(access.hosts, signed.hash)
    if (receipt.status !== 'success') throw new Error(`the chain did not take ${what}`)
  }

  /** The account's pathUSD, in base units, as both hosts agree. */
  async balance(hosts: HostsConfig): Promise<bigint> {
    return tokenBalanceAt(hosts, await agreedFinalizedBlock(hosts), PATH_USD, this.account)
  }

  /**
   * Turn this access key off for good. On chain, that is the passkey's own
   * `revokeKey` (one Face ID), final on both hosts. A key that never reached
   * the chain has nothing to revoke there, and is forgotten here either way.
   */
  async turnOff(access: ChainAccess): Promise<void> {
    if (await this.onChain(access.hosts)) {
      const root = rootAccountOf(this.#passkey, this.#passkeyOptions)
      const signed = await signBatch(
        root,
        [
          {
            to: Addresses.accountKeychain,
            data: encodeFunctionData({ abi: Abis.accountKeychain, functionName: 'revokeKey', args: [this.accessKeyAddress] }),
          },
        ],
        access,
        false,
      )
      noteSend(this.account)
      await broadcastSigned(access.hosts, signed)
      const { receipt } = await waitForReceiptFinal(access.hosts, signed.hash)
      if (receipt.status !== 'success') throw new Error('the chain did not take the revoke')
    }
    await this.#store.deletePendingAuthorization(
      pendingName({ chainId: ESCROW_CHAIN_ID, address: this.account, accessKey: this.accessKeyAddress }),
    )
    await this.#store.deleteAccessKey(this.role)
  }
}

/** The device's wallet for `role`, or null when this device has not set one up. */
export async function loadDeviceWallet(store: CardStore, role: KeyRole, o: PasskeyOptions = {}): Promise<DeviceWallet | null> {
  const [passkey, record] = await Promise.all([store.passkey(), store.accessKey(role)])
  if (passkey === null || record === null || record.account !== passkey.address) return null
  return new DeviceWallet(store, record, passkey, o)
}

/**
 * Set up `role` on this device: the passkey (this browser's own; else the one
 * the phone already has, found with one or two Face IDs; else a new one, one
 * Face ID), a fresh non-extractable access key, and the passkey's signature
 * on its restrictions (one Face ID). Nothing is sent: the first batch carries
 * it. An existing key for this role is replaced; the old one simply expires.
 */
export async function setUpDeviceWallet(
  store: CardStore,
  role: KeyRole,
  opts: { escrow: Hex; weeklyLimitUnits?: bigint; now?: number; passkey?: PasskeyOptions },
): Promise<DeviceWallet> {
  const o = opts.passkey ?? {}
  const passkey = await ensurePasskey(store, o)
  const now = opts.now ?? nowSeconds()
  const restrictions = role === 'shopper' ? shopperKeyRestrictions(opts.escrow, now, opts.weeklyLimitUnits) : sellerKeyRestrictions(opts.escrow, now)
  const keyPair = await WebCryptoP256.createKeyPair({ extractable: false })
  const access = TempoAccount.fromWebCryptoP256(keyPair, { access: passkey.address })
  const authorization = await rootAccountOf(passkey, o).signKeyAuthorization(access, {
    chainId: BigInt(ESCROW_CHAIN_ID),
    expiry: restrictions.expiry,
    ...(restrictions.limits.length > 0 ? { limits: restrictions.limits.map((l) => ({ ...l })) } : {}),
    scopes: restrictions.scopes.map((s: CallScope) => ({
      address: s.address,
      selector: s.selector,
      ...(s.recipients ? { recipients: [...s.recipients] } : {}),
    })),
  })
  const record: AccessKeyRecord = {
    role,
    account: passkey.address,
    accessKeyAddress: lower(access.accessKeyAddress),
    keyPair,
    restrictions,
    createdAt: Date.now(),
  }
  await store.savePendingAuthorization(
    pendingName({ chainId: ESCROW_CHAIN_ID, address: passkey.address, accessKey: record.accessKeyAddress }),
    authorization,
  )
  await store.saveAccessKey(record)
  return new DeviceWallet(store, record, passkey, o)
}

/**
 * Testnet only: ask the faucet for test dollars (`tempo_fundAddress`, first
 * host), then wait until every funding transfer is final on both hosts, so
 * the balance the page shows next is the new one.
 */
export async function requestTestDollars(hosts: HostsConfig, address: Hex): Promise<void> {
  const hashes = await requestFaucet(hosts, address)
  await Promise.all(hashes.map((h) => waitForReceiptFinal(hosts, h, { timeoutMs: 45_000 })))
}
