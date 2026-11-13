/**
 * The device's own Tempo account (src/lib/escrow/client/wallet.ts), with a
 * fake Face ID authenticator, a fake IndexedDB, and Tempo's account layer on
 * the fake Moderato node (tests/support/fake-tempo-wallet.ts), which checks
 * every signature and scope with ox's own code.
 *
 * Pinned (spec section 7):
 *   - the shopper's key may approve only the escrow, open and dispute only
 *     through it, $200 of approvals a week, for 90 days; the seller's key may
 *     list and cancel only, and touch no token; neither can rekey or refund;
 *   - setup is two Face IDs and no transaction; each setup makes its own
 *     passkey, never one that replaces another account's;
 *   - the access key signs with no prompt, its first batch carries the
 *     passkey's authorization, and the next does not;
 *   - the chain refuses a call outside the scope and a spend over the limit;
 *   - a sponsor co-signs when one is set; once it has been sent the signed
 *     batch, a sponsor that refuses or changes it is not followed by a second,
 *     self-paid batch: it may still send the first; one that declines at the
 *     fill, or cannot be reached for it, was sent nothing signed, so the
 *     device pays its own fee;
 *   - an expired or revoked key says so, and leaves no allowance to spend;
 *   - turning the key off is the passkey's revoke, final on chain.
 * No network.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { encodeFunctionData, erc20Abi, getAbiItem, toFunctionSelector, type AbiFunction, type Hex } from 'viem'
import { Account as TempoAccount } from 'viem/tempo'
import { ESCROW_ABI } from '@/lib/escrow/artifact'
import { openCardStore, type CardStore } from '@/lib/escrow/client/card-store'
import {
  ACCESS_KEY_LIFETIME_SECONDS,
  LIMIT_PERIOD_SECONDS,
  SHOPPER_WEEKLY_LIMIT_UNITS,
  SponsorMayHoldError,
  loadDeviceWallet,
  requestTestDollars,
  sellerKeyRestrictions,
  setUpDeviceWallet,
  shopperKeyRestrictions,
  type ChainAccess,
  type DeviceWallet,
} from '@/lib/escrow/client/wallet'
import { PATH_USD } from '@/lib/escrow/manifest'
import { createAccount, ensurePasskey } from '@/lib/account/client/passkey'
import { rpcCall, waitForReceiptFinal, type HostsConfig } from '@/lib/escrow/runbook/rpc'
import { testAddress } from './support/evm'
import { FakeIndexedDB } from './support/fake-indexeddb'
import { FakeTempoNode } from './support/fake-tempo-node'
import { TEMPO_RPC_HOSTS } from './support/fake-tempo-rpc'
import { fakeSponsor, installTempoWallet, type TempoWalletLayer } from './support/fake-tempo-wallet'
import { FakeAuthenticator } from './support/fake-webauthn'

const { z_KeyAuthorization: KeyAuthorization, z_SignatureEnvelope: SignatureEnvelope } = TempoAccount

const ESCROW: Hex = '0x00000000000000000000000000000000000e5c20'
const OTHER: Hex = testAddress(77)
const NOW = 1_790_000_000
const selector = (name: 'depositAndOpen' | 'dispute' | 'list' | 'cancelListing' | 'rekey' | 'sellerRefund'): Hex =>
  toFunctionSelector(getAbiItem({ abi: ESCROW_ABI, name }) as AbiFunction)
const approve = (spender: Hex, amount: bigint) => ({
  to: PATH_USD,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
})

interface World {
  node: FakeTempoNode
  layer: TempoWalletLayer
  hosts: HostsConfig
  access: ChainAccess
  auth: FakeAuthenticator
  idb: FakeIndexedDB
  store: CardStore
}

async function world(): Promise<World> {
  const node = await FakeTempoNode.create({ timestamp: BigInt(NOW) })
  const layer = installTempoWallet(node)
  const hosts: HostsConfig = {
    urls: TEMPO_RPC_HOSTS,
    fetchImpl: node.fetch as unknown as typeof fetch,
    sleep: async () => {
      node.advance(1)
    },
    timeoutMs: 5_000,
  }
  const idb = new FakeIndexedDB()
  return { node, layer, hosts, access: { hosts, sponsorUrl: null }, auth: new FakeAuthenticator(), idb, store: await openCardStore(idb.asFactory()) }
}

const passkey = (w: World) => ({ rpId: 'localhost', createFn: w.auth.createFn, getFn: w.auth.getFn })

async function shopper(w: World): Promise<DeviceWallet> {
  return setUpDeviceWallet(w.store, 'shopper', { escrow: ESCROW, now: Number(w.node.chain.timestamp), passkey: passkey(w) })
}

async function send(w: World, wallet: DeviceWallet, calls: Array<{ to: Hex; data: Hex }>, access: ChainAccess = w.access) {
  const signed = await wallet.signCalls(calls, access)
  await wallet.broadcast(signed, access)
  const { receipt } = await waitForReceiptFinal(w.hosts, signed.hash)
  return { signed, receipt }
}

describe('what an access key may do', () => {
  it("the shopper's: approve only the escrow, open and dispute only through it, $200 a week, 90 days", () => {
    const r = shopperKeyRestrictions(ESCROW, NOW)
    expect(r.expiry).toBe(NOW + ACCESS_KEY_LIFETIME_SECONDS)
    expect(ACCESS_KEY_LIFETIME_SECONDS).toBe(90 * 86_400)
    expect(r.limits).toEqual([{ token: PATH_USD, limit: 200_000_000n, period: 604_800 }])
    expect(SHOPPER_WEEKLY_LIMIT_UNITS).toBe(200_000_000n)
    expect(LIMIT_PERIOD_SECONDS).toBe(7 * 86_400)
    expect(r.scopes).toEqual([
      { address: PATH_USD, selector: '0x095ea7b3', recipients: [ESCROW] },
      { address: ESCROW, selector: selector('depositAndOpen') },
      { address: ESCROW, selector: selector('dispute') },
    ])
    expect(shopperKeyRestrictions(ESCROW, NOW, 50_000_000n).limits[0]?.limit).toBe(50_000_000n)
    expect(() => shopperKeyRestrictions(ESCROW, NOW, 200_000_001n)).toThrow(RangeError)
    expect(() => shopperKeyRestrictions(ESCROW, NOW, 0n)).toThrow(RangeError)
  })

  it("the seller's: list and cancel only, no token at all; neither key can rekey or refund", () => {
    const r = sellerKeyRestrictions(ESCROW, NOW)
    expect(r.limits).toEqual([])
    expect(r.scopes).toEqual([
      { address: ESCROW, selector: selector('list') },
      { address: ESCROW, selector: selector('cancelListing') },
    ])
    for (const s of [...r.scopes, ...shopperKeyRestrictions(ESCROW, NOW).scopes]) {
      expect([selector('rekey'), selector('sellerRefund')]).not.toContain(s.selector)
    }
  })
})

describe('setting up a device', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })

  it('is two Face IDs and no transaction, and keeps a key nobody can export', async () => {
    const wallet = await shopper(w)
    // The phone is asked for a Salvo passkey first; with none, its sheet is
    // empty and closed, then one is made and signs: two Face IDs.
    expect(w.auth.prompts).toBe(3)
    expect(w.auth.creates).toBe(1)
    expect(w.node.sent('eth_sendRawTransaction')).toHaveLength(0)

    const pk = await w.store.passkey()
    expect(pk?.address).toBe(wallet.account)
    const rec = await w.store.accessKey('shopper')
    expect(rec?.keyPair.privateKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('pkcs8', rec?.keyPair.privateKey as CryptoKey)).rejects.toThrow()
    expect(rec?.accessKeyAddress).toBe(wallet.accessKeyAddress)

    // The pending authorization is the passkey's own signature over these exact restrictions.
    const name = `42431:${wallet.account}:${wallet.accessKeyAddress}`
    const ka = (await w.store.pendingAuthorization(name)) as Parameters<typeof KeyAuthorization.getSignPayload>[0] & {
      signature: Parameters<typeof SignatureEnvelope.verify>[0]
    }
    expect(ka.address.toLowerCase()).toBe(wallet.accessKeyAddress)
    expect(ka.chainId).toBe(42431n)
    expect(ka.expiry).toBe(NOW + ACCESS_KEY_LIFETIME_SECONDS)
    expect(ka.limits).toEqual([{ token: PATH_USD, limit: 200_000_000n, period: 604_800 }])
    expect(ka.scopes?.map((s) => [s.address.toLowerCase(), s.selector, s.recipients?.map((x) => x.toLowerCase())])).toEqual([
      [PATH_USD, '0x095ea7b3', [ESCROW]],
      [ESCROW, selector('depositAndOpen'), undefined],
      [ESCROW, selector('dispute'), undefined],
    ])
    expect(SignatureEnvelope.verify(ka.signature, { payload: KeyAuthorization.getSignPayload(ka), address: wallet.account })).toBe(true)

    // A reload finds the same wallet.
    const again = await loadDeviceWallet(await openCardStore(w.idb.asFactory()), 'shopper', passkey(w))
    expect(again?.account).toBe(wallet.account)
    expect(again?.accessKeyAddress).toBe(wallet.accessKeyAddress)
  })

  it('a second account gets its own passkey, never one that replaces the first', async () => {
    const first = await shopper(w)
    // "Make my account" on another browser: a new passkey, asked for, beside the first.
    const otherPhone = await openCardStore(new FakeIndexedDB().asFactory())
    await createAccount(otherPhone, passkey(w))
    const second = await setUpDeviceWallet(otherPhone, 'shopper', { escrow: ESCROW, passkey: passkey(w) })
    expect(second.account).not.toBe(first.account)
    expect(w.auth.credentials.size).toBe(2)
  })

  it('a cancelled Face ID keeps no half-made key', async () => {
    await ensurePasskey(w.store, passkey(w))
    w.auth.refuseNext = true
    await expect(shopper(w)).rejects.toThrow()
    expect(await w.store.accessKey('shopper')).toBeNull()
    expect(await loadDeviceWallet(w.store, 'shopper', passkey(w))).toBeNull()
  })
})

describe('sending with the access key', () => {
  let w: World
  let wallet: DeviceWallet
  beforeEach(async () => {
    w = await world()
    wallet = await shopper(w)
  })

  it('signs with no prompt; the first batch carries the authorization and the next does not', async () => {
    const before = w.auth.prompts
    const { receipt } = await send(w, wallet, [approve(ESCROW, 5_000_000n)])
    expect(receipt.status).toBe('success')
    expect(w.auth.prompts).toBe(before)
    expect(w.layer.landed[0]).toMatchObject({ account: wallet.account, keyId: wallet.accessKeyAddress, carriedAuthorization: true, ok: true })
    expect(await wallet.onChain(w.hosts)).toBe(true)
    expect(await wallet.allowance(w.hosts)).toMatchObject({ remainingUnits: 195_000_000n, onChain: true })

    await send(w, wallet, [approve(ESCROW, 1_000_000n)])
    expect(w.layer.landed[1]?.carriedAuthorization).toBe(false)
    expect(await w.store.pendingAuthorization(`42431:${wallet.account}:${wallet.accessKeyAddress}`)).toBeUndefined()
    expect((await wallet.allowance(w.hosts)).remainingUnits).toBe(194_000_000n)
  })

  it('before its first batch, the allowance shown is the signed limit', async () => {
    expect(await wallet.allowance(w.hosts)).toEqual({ remainingUnits: 200_000_000n, periodEnd: null, onChain: false, ended: false })
    expect(await wallet.status(w.hosts)).toBe('pending')
  })

  it('after 90 days, or turned off from anywhere, the key says it has ended and has nothing left to spend', async () => {
    await send(w, wallet, [approve(ESCROW, 1_000_000n)])
    expect(await wallet.status(w.hosts)).toBe('live')
    // Revoked from another device: this one still holds the key, and must not offer a Load.
    const k = w.layer.keys.get(`${wallet.account}:${wallet.accessKeyAddress}`)
    if (k === undefined) throw new Error('the key is not on chain')
    k.revoked = true
    expect(await wallet.status(w.hosts)).toBe('revoked')
    expect(await wallet.allowance(w.hosts)).toEqual({ remainingUnits: 0n, periodEnd: null, onChain: false, ended: true })
    k.revoked = false
    w.node.advance(ACCESS_KEY_LIFETIME_SECONDS + 60)
    expect(await wallet.status(w.hosts)).toBe('expired')
    expect((await wallet.allowance(w.hosts)).ended).toBe(true)
  })

  it('a key that never reached the chain has ended too once its signed expiry passes', async () => {
    w.node.advance(ACCESS_KEY_LIFETIME_SECONDS + 60)
    expect(await wallet.status(w.hosts)).toBe('expired')
    expect(await wallet.allowance(w.hosts)).toEqual({ remainingUnits: 0n, periodEnd: null, onChain: false, ended: true })
  })

  it('the chain refuses a call outside the scope, and a spend over the weekly limit', async () => {
    await expect(send(w, wallet, [approve(OTHER, 1n)])).rejects.toThrow(/outside the access key scope/)
    await expect(send(w, wallet, [approve(ESCROW, 200_000_001n)])).rejects.toThrow(/spending limit exceeded/)
    expect(w.layer.landed).toHaveLength(0)
    // Still unused: the next good batch carries the authorization.
    await send(w, wallet, [approve(ESCROW, 1n)])
    expect(w.layer.landed[0]?.carriedAuthorization).toBe(true)
  })

  it('uses the sponsor when one is set; once the sponsor has the signed batch, a refusal is never followed by a second one', async () => {
    const sponsor = fakeSponsor(`0x${'5a'.repeat(32)}`, PATH_USD)
    w.layer.sponsor = sponsor.address
    const sponsored: ChainAccess = { hosts: w.hosts, sponsorUrl: sponsor.url, sponsorFetch: sponsor.fetch }

    const a = await send(w, wallet, [approve(ESCROW, 1_000_000n)], sponsored)
    expect(a.signed.sponsored).toBe(true)
    expect(w.layer.landed.at(-1)?.sponsored).toBe(true)
    expect(sponsor.asked).toContain('eth_signRawTransaction')

    // Refused, changed, or kept: the sponsor holds a batch the access key
    // signed, which it could still send. So nothing else is signed.
    for (const behaviour of ['refuse', 'tamper', 'keep'] as const) {
      sponsor.behaviour = behaviour
      const landed = w.layer.landed.length
      await expect(wallet.signCalls([approve(ESCROW, 1_000_000n)], sponsored)).rejects.toBeInstanceOf(SponsorMayHoldError)
      expect(w.layer.landed).toHaveLength(landed)
    }
    // A kept copy is a real batch: it lands when the sponsor sends it.
    await rpcCall(w.hosts, 0, 'eth_sendRawTransaction', [sponsor.kept])
    expect(w.layer.landed.at(-1)).toMatchObject({ sponsored: true, ok: true })

    // With no sponsor set, the device pays its own fee, as before.
    const b = await send(w, wallet, [approve(ESCROW, 1_000_000n)])
    expect(b.signed.sponsored).toBe(false)
  })

  it('a sponsor that declines at the fill, answers it for self-payment, or cannot be reached for it, is never sent a signed batch: the device pays its own fee', async () => {
    const sponsor = fakeSponsor(`0x${'5c'.repeat(32)}`, PATH_USD)
    w.layer.sponsor = sponsor.address
    const sponsored: ChainAccess = { hosts: w.hosts, sponsorUrl: sponsor.url, sponsorFetch: sponsor.fetch }
    for (const behaviour of ['refuse-fill', 'fill-self-pay', 'down'] as const) {
      sponsor.behaviour = behaviour
      const asked = sponsor.asked.length
      const landed = w.layer.landed.length
      // Not SponsorMayHoldError: nothing signed went to the sponsor, so paying our own fee cannot pay twice.
      const { signed, receipt } = await send(w, wallet, [approve(ESCROW, 1_000_000n)], sponsored)
      expect([behaviour, signed.sponsored, receipt.status]).toEqual([behaviour, false, 'success'])
      expect(sponsor.asked.slice(asked)).toEqual(['eth_fillTransaction'])
      expect(w.layer.landed).toHaveLength(landed + 1)
      expect(w.layer.landed.at(-1)).toMatchObject({ sponsored: false, ok: true })
    }
    // A sponsor with no fill method still co-signs the signed batch, as before.
    sponsor.behaviour = 'sign'
    const c = await send(w, wallet, [approve(ESCROW, 1_000_000n)], sponsored)
    expect(c.signed.sponsored).toBe(true)
    expect(w.layer.landed.at(-1)?.sponsored).toBe(true)
  })

  it('gets test dollars from the faucet, final on both hosts', async () => {
    expect(await wallet.balance(w.hosts)).toBe(0n)
    await requestTestDollars(w.hosts, wallet.account)
    expect(await wallet.balance(w.hosts)).toBeGreaterThan(0n)
  })

  it('turning the key off is the passkey revoking it on chain; then the key is gone everywhere', async () => {
    await send(w, wallet, [approve(ESCROW, 1n)])
    const signedBefore = await wallet.signCalls([approve(ESCROW, 1n)], w.access)
    const prompts = w.auth.prompts
    await wallet.turnOff(w.access)
    expect(w.auth.prompts).toBe(prompts + 1)
    expect(w.layer.landed.at(-1)).toMatchObject({ account: wallet.account, keyId: null, ok: true })
    expect(await wallet.onChain(w.hosts)).toBe(false)
    expect(await loadDeviceWallet(w.store, 'shopper', passkey(w))).toBeNull()
    // A batch it signed before is refused now.
    await expect(wallet.broadcast(signedBefore, w.access)).rejects.toThrow(/revoked/)
  })

  it('a key that never reached the chain is turned off without a Face ID', async () => {
    const prompts = w.auth.prompts
    await wallet.turnOff(w.access)
    expect(w.auth.prompts).toBe(prompts)
    expect(await w.store.accessKey('shopper')).toBeNull()
  })
})
