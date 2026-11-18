/**
 * Tempo's account layer on the fake node: 0x76 batches and the
 * AccountKeychain, as the shopper's phone and the seller's page use them.
 * Test-only; never referenced from src/.
 *
 * WHAT IT CHECKS, WITH ox's OWN CODE (viem/tempo's z_ exports), not ours:
 *   - the sender's signature over the batch: a keychain envelope, whose inner
 *     P-256 signature is the access key's over keccak(0x04 || payload ||
 *     account), or a root signature (P-256, WebAuthn) for the account itself;
 *   - a key authorization the batch carries: signed by the account's root
 *     key, for this chain, and then the key is on chain with its expiry,
 *     limits and scopes;
 *   - every call against the key's scopes (target, selector, and the
 *     recipient rule on approve and transfer), and every approve or transfer
 *     against the key's limit for its period;
 *   - the nonce: the account's next one, or an expiring nonce inside its
 *     window, once;
 *   - a fee payer's signature, when there is one, recovers to the sponsor.
 * Then the calls run on the EVM, all or nothing (FakeTempoNode.landBatch).
 * The root's `revokeKey` call is applied here, as the precompile would.
 *
 * NOT MODELED: fees, gas, and admin keys. eth_fillTransaction answers
 * "method not found", so viem fills a batch from the plain methods; a
 * batch's gas estimate is a fixed figure.
 */

import { concat, decodeFunctionData, encodeFunctionResult, keccak256, parseSignature, recoverAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Abis, Account as TempoAccount, Addresses } from 'viem/tempo'
import { EvmRpcError } from './evm'
import { NOT_SERVED, type FakeTempoNode } from './fake-tempo-node'
import { TEMPO_RPC_HOSTS } from './fake-tempo-rpc'

const { z_TxEnvelopeTempo: TxEnvelope, z_SignatureEnvelope: SignatureEnvelope, z_KeyAuthorization: KeyAuthorization } = TempoAccount

const KEYCHAIN = Addresses.accountKeychain.toLowerCase() as Hex
const MAX_U256 = (1n << 256n) - 1n
const APPROVE = '0x095ea7b3'
const TRANSFER = '0xa9059cbb'
const lower = (a: string): Hex => a.toLowerCase() as Hex

interface KeyState {
  keyId: Hex
  type: number
  expiry: bigint
  enforceLimits: boolean
  revoked: boolean
  /** token -> limit state */
  limits: Map<Hex, { remaining: bigint; max: bigint; period: bigint; periodEnd: bigint }>
  /** null: any call. */
  scopes: Array<{ address: Hex; selector: Hex | null; recipients: Hex[] }> | null
}

export interface LandedBatch {
  hash: Hex
  account: Hex
  /** The access key that signed, or null for the account's root key. */
  keyId: Hex | null
  calls: Array<{ to: Hex; data: Hex }>
  carriedAuthorization: boolean
  sponsored: boolean
  ok: boolean
}

export interface TempoWalletLayer {
  readonly landed: LandedBatch[]
  /** Why each refused batch was refused, in order. */
  readonly refused: string[]
  /** The access keys on chain: `<account>:<keyId>`. */
  readonly keys: ReadonlyMap<string, KeyState>
  /** The address whose fee-payer signature is accepted. Null: none. */
  sponsor: Hex | null
  /**
   * Whether Tempo's own host answers eth_sendRawTransactionSync (EIP-7966):
   * sends the batch and answers its receipt, in one call. On by default, as
   * rpc.moderato.tempo.xyz does; the second host (dRPC) never does.
   */
  syncSend: boolean
}

const refuse = (layer: { refused: string[] }, why: string): never => {
  layer.refused.push(why)
  throw new EvmRpcError(-32000, why)
}

/** Install the layer on `node`. One per node. */
export function installTempoWallet(node: FakeTempoNode): TempoWalletLayer {
  const keys = new Map<string, KeyState>()
  const nonces = new Map<Hex, bigint>()
  const expiringSeen = new Set<Hex>()
  const layer = { landed: [] as LandedBatch[], refused: [] as string[], keys, sponsor: null as Hex | null, syncSend: true }
  const chainTime = (): bigint => node.chain.timestamp

  function keyCall(data: Hex): Hex {
    const call = decodeFunctionData({ abi: Abis.accountKeychain, data })
    const now = chainTime()
    switch (call.functionName) {
      case 'getKey': {
        const [account, keyId] = call.args as readonly [Hex, Hex]
        const k = keys.get(`${lower(account)}:${lower(keyId)}`)
        return encodeFunctionResult({
          abi: Abis.accountKeychain,
          functionName: 'getKey',
          result: {
            signatureType: k?.type ?? 0,
            keyId: k?.keyId ?? '0x0000000000000000000000000000000000000000',
            expiry: k?.expiry ?? 0n,
            enforceLimits: k?.enforceLimits ?? false,
            isRevoked: k?.revoked ?? false,
          },
        })
      }
      case 'getRemainingLimitWithPeriod': {
        const [account, keyId, token] = call.args as readonly [Hex, Hex, Hex]
        const l = keys.get(`${lower(account)}:${lower(keyId)}`)?.limits.get(lower(token))
        if (l !== undefined && l.period > 0n && now >= l.periodEnd) {
          l.remaining = l.max
          l.periodEnd = now + l.period
        }
        return encodeFunctionResult({
          abi: Abis.accountKeychain,
          functionName: 'getRemainingLimitWithPeriod',
          result: [l?.remaining ?? 0n, l?.periodEnd ?? 0n],
        })
      }
      default:
        throw new EvmRpcError(3, `execution reverted: the fake keychain does not serve ${call.functionName}`)
    }
  }

  function inScope(k: KeyState, to: Hex, data: Hex): boolean {
    if (k.scopes === null) return true
    const selector = lower(data.slice(0, 10))
    return k.scopes.some((s) => {
      if (s.address !== to) return false
      if (s.selector !== null && s.selector !== selector) return false
      if (s.recipients.length === 0) return true
      const first = lower(`0x${data.slice(34, 74)}`)
      return s.recipients.includes(first)
    })
  }

  async function sendTempo(raw: Hex): Promise<Hex> {
    const hash = lower(keccak256(raw))
    const env = TxEnvelope.deserialize(raw as `0x76${string}`)
    if (env.chainId !== Number(node.chain.chainId)) refuse(layer, 'invalid chain id')
    if (env.feePayerSignature === null) refuse(layer, 'the fee payer has not signed')
    const sig = env.signature
    if (sig === undefined) return refuse(layer, 'unsigned')
    const payload = TxEnvelope.getSignPayload(env)

    let account: Hex
    let keyId: Hex | null = null
    if (sig.type === 'keychain') {
      account = lower(sig.userAddress)
      const inner = sig.version === 'v2' ? keccak256(concat(['0x04', payload, account])) : payload
      keyId = lower(SignatureEnvelope.extractAddress({ payload: inner, signature: sig.inner }))
      if (!SignatureEnvelope.verify(sig.inner, { payload: inner, address: keyId })) refuse(layer, 'the access key signature does not verify')
    } else {
      account = lower(SignatureEnvelope.extractAddress({ payload, signature: sig }))
      if (!SignatureEnvelope.verify(sig, { payload, address: account })) refuse(layer, 'the root signature does not verify')
    }

    if (env.feePayerSignature) {
      const sponsor = await recoverAddress({
        hash: TxEnvelope.getFeePayerSignPayload(env, { sender: account }),
        signature: {
          r: `0x${env.feePayerSignature.r.toString(16).padStart(64, '0')}`,
          s: `0x${env.feePayerSignature.s.toString(16).padStart(64, '0')}`,
          yParity: env.feePayerSignature.yParity,
        },
      })
      if (layer.sponsor === null || lower(sponsor) !== layer.sponsor) refuse(layer, 'the fee payer signature is not the sponsor')
    }

    // A key authorization is checked first, and applied only if the whole
    // batch is valid: a refused batch changes nothing, as on a real node.
    const ka = env.keyAuthorization
    let newKey: { id: string; state: KeyState } | null = null
    if (ka !== undefined) {
      if (ka.chainId !== 0n && ka.chainId !== node.chain.chainId) refuse(layer, 'the key authorization is for another chain')
      const kaPayload = KeyAuthorization.getSignPayload(ka)
      const kaSigner = lower(SignatureEnvelope.extractAddress({ payload: kaPayload, signature: ka.signature }))
      if (kaSigner !== account || !SignatureEnvelope.verify(ka.signature, { payload: kaPayload, address: account })) {
        refuse(layer, 'the key authorization is not signed by the account root key')
      }
      const id = `${account}:${lower(ka.address)}`
      if (keys.has(id)) refuse(layer, 'that key is already authorized')
      const now = chainTime()
      newKey = {
        id,
        state: {
          keyId: lower(ka.address),
          type: ka.type === 'p256' ? 1 : ka.type === 'webAuthn' ? 2 : 0,
          expiry: BigInt(ka.expiry ?? Number.MAX_SAFE_INTEGER),
          enforceLimits: ka.limits !== undefined,
          revoked: false,
          limits: new Map(
            (ka.limits ?? []).map((l) => [
              lower(l.token),
              { remaining: l.limit, max: l.limit, period: BigInt(l.period ?? 0), periodEnd: now + BigInt(l.period ?? 0) },
            ]),
          ),
          scopes:
            ka.scopes === undefined
              ? null
              : ka.scopes.map((sc) => ({
                  address: lower(sc.address),
                  selector: sc.selector === undefined ? null : lower(sc.selector),
                  recipients: (sc.recipients ?? []).map(lower),
                })),
        },
      }
    }

    const calls = env.calls.map((c) => ({ to: lower(c.to ?? '0x'), data: (c.data ?? '0x') as Hex }))
    const spends: Array<() => void> = []
    if (keyId !== null) {
      const id = `${account}:${keyId}`
      const k = keys.get(id) ?? (newKey !== null && newKey.id === id ? newKey.state : undefined)
      if (k === undefined) return refuse(layer, 'the access key is not authorized')
      if (k.revoked) refuse(layer, 'the access key is revoked')
      if (k.expiry <= chainTime()) refuse(layer, 'the access key has expired')
      for (const c of calls) {
        if (c.to === KEYCHAIN) refuse(layer, 'an access key cannot change keys')
        if (!inScope(k, c.to, c.data)) refuse(layer, 'a call is outside the access key scope')
      }
      if (k.enforceLimits) {
        const spend = new Map<Hex, bigint>()
        for (const c of calls) {
          const sel = lower(c.data.slice(0, 10))
          if (sel !== APPROVE && sel !== TRANSFER) continue
          spend.set(c.to, (spend.get(c.to) ?? 0n) + BigInt(`0x${c.data.slice(74, 138)}`))
        }
        const now = chainTime()
        for (const [token, amount] of spend) {
          const l = k.limits.get(token)
          if (l === undefined) return refuse(layer, 'no spending limit allows this token')
          const rolled = l.period > 0n && now >= l.periodEnd
          const remaining = rolled ? l.max : l.remaining
          if (amount > remaining) refuse(layer, 'spending limit exceeded')
          spends.push(() => {
            if (rolled) l.periodEnd = now + l.period
            l.remaining = remaining - amount
          })
        }
      }
    }

    // The nonce: an expiring one inside its window, once; or the account's next.
    const nonce = env.nonce ?? 0n
    if (env.nonceKey === MAX_U256) {
      if (env.validBefore === undefined || BigInt(env.validBefore) <= chainTime()) refuse(layer, 'the expiring nonce window has passed')
      if (expiringSeen.has(hash)) refuse(layer, 'already known')
    } else {
      const next = nonces.get(account) ?? 0n
      if (nonce < next) refuse(layer, `nonce too low: next nonce ${next}, tx nonce ${nonce}`)
      if (nonce > next) refuse(layer, `nonce too high: next nonce ${next}, tx nonce ${nonce}`)
    }

    // Valid: from here the batch is accepted, and its effects are kept.
    if (newKey !== null) keys.set(newKey.id, newKey.state)
    for (const apply of spends) apply()
    if (env.nonceKey === MAX_U256) {
      expiringSeen.add(hash)
      if (!nonces.has(account)) nonces.set(account, 0n)
    } else {
      nonces.set(account, nonce + 1n)
    }

    // The root's own key management is the precompile's; everything else runs on the EVM.
    const evmCalls = calls.filter((c) => c.to !== KEYCHAIN)
    for (const c of calls.filter((x) => x.to === KEYCHAIN)) {
      const d = decodeFunctionData({ abi: Abis.accountKeychain, data: c.data })
      if (d.functionName !== 'revokeKey') refuse(layer, `the fake keychain does not run ${d.functionName}`)
      const k = keys.get(`${account}:${lower((d.args as readonly [Hex])[0])}`)
      if (k !== undefined) k.revoked = true
    }
    const ok = evmCalls.length === 0 ? (await node.landBatch(hash, account, [], nonce), true) : await node.landBatch(hash, account, evmCalls, nonce)
    layer.landed.push({ hash, account, keyId, calls, carriedAuthorization: ka !== undefined, sponsored: env.feePayerSignature !== undefined, ok })
    return hash
  }

  node.extend(async (method, params, host) => {
    switch (method) {
      case 'eth_sendRawTransactionSync': {
        const raw = params[0]
        if (!layer.syncSend || host !== TEMPO_RPC_HOSTS[0] || typeof raw !== 'string' || !raw.startsWith('0x76')) return NOT_SERVED
        return node.receiptFor(await sendTempo(raw as Hex))
      }
      case 'eth_fillTransaction':
        throw new EvmRpcError(-32601, 'the method eth_fillTransaction does not exist/is not available')
      case 'eth_estimateGas': {
        const call = (params[0] ?? {}) as Record<string, unknown>
        return Array.isArray(call.calls) ? '0x2dc6c0' : NOT_SERVED
      }
      case 'eth_getTransactionCount': {
        const a = typeof params[0] === 'string' ? lower(params[0]) : null
        return a !== null && nonces.has(a) ? `0x${(nonces.get(a) ?? 0n).toString(16)}` : NOT_SERVED
      }
      case 'eth_call': {
        const call = (params[0] ?? {}) as Record<string, unknown>
        if (typeof call.to !== 'string' || lower(call.to) !== KEYCHAIN) return NOT_SERVED
        const data = (typeof call.data === 'string' ? call.data : typeof call.input === 'string' ? call.input : '0x') as Hex
        return keyCall(data)
      }
      case 'eth_sendRawTransaction': {
        const raw = params[0]
        return typeof raw === 'string' && raw.startsWith('0x76') ? sendTempo(raw as Hex) : NOT_SERVED
      }
      default:
        return NOT_SERVED
    }
  })
  return layer
}

/**
 * `keep`: co-sign the batch, keep the result (`kept`) and answer an error, as
 * a sponsor that times out or turns hostile after it has the signed batch.
 * `refuse-fill`: a sponsor that fills, and declines this batch at the fill
 * with an error, before anything signed reaches it. `fill-self-pay`: one
 * whose policy says no the way Tempo's relay does, by answering the fill for
 * self-payment (no fee payer signature), then refusing the signed batch.
 * `down`: no answer to anything.
 */
export type SponsorBehaviour = 'sign' | 'refuse' | 'tamper' | 'keep' | 'refuse-fill' | 'fill-self-pay' | 'down'

export interface FakeSponsor {
  readonly address: Hex
  readonly url: string
  /** Every method asked of it, in order. */
  readonly asked: string[]
  behaviour: SponsorBehaviour
  /** The co-signed batch a `keep` sponsor held back, ready for it to send whenever it likes. */
  kept: Hex | null
  readonly fetch: typeof fetch
}

/**
 * A fee sponsor: answers eth_signRawTransaction for a batch the sender signed
 * in fee-payer form by adding its own signature over the fee token and the
 * sender (ox's getFeePayerSignPayload). It does not fill transactions ("method
 * not available"), unless told to decline at the fill. It can refuse, answer
 * with a changed batch, keep the batch and answer an error, or not answer at
 * all, as a broken or hostile one might.
 */
export function fakeSponsor(privateKey: Hex, feeToken: Hex): FakeSponsor {
  const account = privateKeyToAccount(privateKey)
  const asked: string[] = []
  const self: FakeSponsor = {
    address: account.address.toLowerCase() as Hex,
    url: 'https://sponsor.invalid',
    asked,
    behaviour: 'sign',
    kept: null,
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { id?: unknown; method?: string; params?: unknown[] }
      const answer = (o: Record<string, unknown>): Response =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, ...o }), { status: 200, headers: { 'content-type': 'application/json' } })
      asked.push(String(body.method))
      if (self.behaviour === 'down') throw new TypeError('fetch failed')
      if (self.behaviour === 'refuse-fill' && body.method === 'eth_fillTransaction') {
        return answer({ error: { code: -32000, message: 'sponsorship declined by policy' } })
      }
      if (self.behaviour === 'fill-self-pay') {
        // The fill for self-payment: a filled batch with no fee payer signature. The signed batch is not approved.
        if (body.method === 'eth_fillTransaction') return answer({ result: { raw: '0x', tx: { type: '0x76', chainId: '0xa5bf' } } })
        return answer({ error: { code: -32000, message: 'transaction not approved for sponsorship' } })
      }
      if (body.method !== 'eth_signRawTransaction') return answer({ error: { code: -32601, message: 'method not available' } })
      if (self.behaviour === 'refuse') return answer({ error: { code: -32000, message: 'sponsorship declined' } })
      const raw = (body.params ?? [])[0] as `0x76${string}`
      const env = TxEnvelope.deserialize(raw)
      const sig = env.signature
      const sender = env.from ?? (sig?.type === 'keychain' ? sig.userAddress : undefined)
      if (sender === undefined) return answer({ error: { code: -32000, message: 'no sender' } })
      const calls = self.behaviour === 'tamper' ? [...env.calls, { to: feeToken, data: '0x' as Hex }] : env.calls
      const final = { ...env, calls, feeToken, from: undefined }
      const signature = parseSignature(await account.sign({ hash: TxEnvelope.getFeePayerSignPayload(final, { sender }) }))
      const out = TxEnvelope.serialize(final, {
        feePayerSignature: { r: BigInt(signature.r), s: BigInt(signature.s), yParity: signature.yParity ?? 0 },
      })
      if (self.behaviour === 'keep') {
        self.kept = out
        return answer({ error: { code: -32000, message: 'gateway timeout' } })
      }
      return answer({ result: out })
    }) as typeof fetch,
  }
  return self
}
