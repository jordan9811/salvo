/**
 * The browser twins of the Lit vault crypto (src/lib/escrow/client), against
 * Node's crypto and against the frozen escrow template itself.
 *
 * Three claims, each in the direction that loses a card if it is wrong:
 *   1. @noble's ECDH equals Node's: the x coordinate, 32 bytes. If it did not,
 *      a seller's browser would seal to a key nobody can derive.
 *   2. A card sealed in the browser opens inside the real template: directly
 *      through the template's own `openCard`, and end to end (list on an
 *      in-process chain, Lit ticket, depositAndOpen, Lit release).
 *   3. The phone's `openReply` decrypts what the template's `release` returns,
 *      and refuses it under any other key, payload or encPub.
 *
 * No network: an in-process EVM, two fake RPC hosts over it, and fake Lit.
 */

import { createECDH, hkdfSync, randomBytes } from 'node:crypto'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak256, type Hex } from 'viem'
import { ESCROW_ABI } from '@/lib/escrow/artifact'
import { createBrowserReplyKey, openReply } from '@/lib/escrow/client/reply'
import { hkdf32, sharedX } from '@/lib/escrow/client/primitives'
import { sealInBrowser } from '@/lib/escrow/client/seal'
import { commitment, envelopeHashOf, listingIdOfSeal, replyPayload, termsOfManifest } from '@/lib/escrow/hashes'
import { buildEscrowManifest, ESCROW_CHAIN_ID, parseEscrowManifest, PATH_USD, type EscrowManifest } from '@/lib/escrow/manifest'
import type { LitEnvelope } from '@/lib/vault/lit/envelope-crypto'
import { ESCROW_BUILD, ESCROW_DEPLOYER, PINNED_ESCROW } from './support/escrow-build'
import { TestChain, testAddress, type CallResult } from './support/evm'
import { deployEscrow, escrowCall, readerFor, tokenCall } from './support/escrow-chain'
import { FAKE_LIT_ROOT, fakeActionKey, runInFakeLit } from './support/fake-lit'
import { FakeTempoRpc, installPathUsd } from './support/fake-tempo-rpc'

const T0 = 1_790_000_000n
const NOW_MS = Number(T0) * 1000
/**
 * The template with its escrow address pinned to where this file deploys the
 * escrow (tests/support/escrow-build.ts): the committed bytes once the pin step
 * has run, and until then those bytes with only the ESCROW line set.
 */
const BUILD = ESCROW_BUILD
const ENC_PUB = BUILD.encPub
const IDENTITY = BUILD.identity
const ACTION_KEY = fakeActionKey(FAKE_LIT_ROOT, BUILD.cid)
const DEPLOYER = testAddress(1)
const SELLER = testAddress(2)
const BUYER = testAddress(3)
const TEST_CARD = '9999271828182845'
const PUB_RE = /^0x0[23][0-9a-f]{64}$/
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)
const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const cardBytes = (card: { cardNumber: string; pin: string | null }): Uint8Array => bytesOf(JSON.stringify(card))

function manifestFor(escrow: Hex, salt: string, listingExpiry = Number(T0) + 86_400): string {
  return buildEscrowManifest({
    escrow,
    seller: SELLER,
    merchant: 9,
    mode: 2,
    valueCents: 2500,
    price: 22_000_000,
    residualCapCents: 0,
    listingExpiry,
    salt,
  })
}

/**
 * The template's own helpers in a bare vm context with WebCrypto, so a test
 * can call `readEnvelope` and `openCard` exactly as a Lit run would, with the
 * key fake Lit derives for this CID.
 */
function templateOpener(): (env: LitEnvelope, manifestText: string) => Promise<unknown> {
  const context = vm.createContext({ ethers, crypto: globalThis.crypto })
  vm.runInContext(BUILD.source, context, { timeout: 5_000 })
  const readEnvelope = vm.runInContext('readEnvelope', context) as (e: unknown) => unknown
  const openCard = vm.runInContext('openCard', context) as (k: string, e: unknown, m: string) => Promise<unknown>
  return async (env, manifestText) => {
    const parsed = readEnvelope(JSON.parse(JSON.stringify(env)))
    if (parsed === null) return 'envelope refused'
    const opened = (await openCard(ACTION_KEY, parsed, manifestText)) as { card: unknown } | null
    return opened === null ? null : JSON.parse(JSON.stringify(opened.card))
  }
}

// ---------------------------------------------------------------------------- the primitives

describe('the browser primitives equal Node crypto', () => {
  it('noble ECDH gives the same 32 bytes as Node ECDH (the x coordinate)', () => {
    for (let i = 0; i < 25; i++) {
      const a = createECDH('secp256k1')
      a.generateKeys()
      const b = secp256k1.utils.randomPrivateKey()
      const bPub = secp256k1.getPublicKey(b, true)
      const node = a.computeSecret(Buffer.from(bPub))
      const noble = sharedX(b, a.getPublicKey(null, 'compressed'))
      expect(Buffer.from(noble).equals(node)).toBe(true)
      expect(noble.length).toBe(32)
      // And the full noble point, minus its prefix byte, is the same x.
      expect(Buffer.from(secp256k1.getSharedSecret(b, a.getPublicKey(null, 'compressed'), true).slice(1)).equals(node)).toBe(true)
    }
  })

  it('WebCrypto HKDF gives the same 32 bytes as Node hkdfSync', async () => {
    for (let i = 0; i < 10; i++) {
      const ikm = randomBytes(32)
      const salt = randomBytes(33)
      const info = `salvo/vault/seal/v1|${randomBytes(32).toString('hex')}`
      const node = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), 32))
      expect(Buffer.from(await hkdf32(ikm, salt, info)).equals(node)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------- the seal

describe('sealInBrowser', () => {
  it('writes an envelope the template accepts and opens, for every card shape', async () => {
    const open = templateOpener()
    const manifest = manifestFor(testAddress(9), 'ab'.repeat(32))
    const cards = [
      { cardNumber: TEST_CARD, pin: null },
      { cardNumber: '6123456789012345', pin: '4821' },
      { cardNumber: '1'.repeat(26), pin: null },
      { cardNumber: '7'.repeat(128), pin: '9'.repeat(64) },
    ]
    for (const card of cards) {
      const env = await sealInBrowser(ENC_PUB, cardBytes(card), manifest)
      expect(Object.keys(env).sort()).toEqual(['ct', 'eph', 'iv', 'tag'])
      expect(env.eph).toMatch(PUB_RE)
      for (const f of [env.ct, env.iv, env.tag]) expect(f).toMatch(B64_RE)
      expect(Buffer.from(env.iv, 'base64')).toHaveLength(12)
      expect(Buffer.from(env.tag, 'base64')).toHaveLength(16)
      expect(Buffer.from(env.ct, 'base64')).toHaveLength(cardBytes(card).length)
      expect(await open(env, manifest)).toEqual(card)
    }
  })

  it('binds the manifest: one changed byte and the template cannot open it', async () => {
    const open = templateOpener()
    const manifest = manifestFor(testAddress(9), 'cd'.repeat(32))
    const env = await sealInBrowser(ENC_PUB, cardBytes({ cardNumber: TEST_CARD, pin: null }), manifest)
    const edited = manifest.replace('"valueCents":2500', '"valueCents":2501')
    expect(edited).not.toBe(manifest)
    expect(await open(env, edited)).toBeNull()
  })

  it('is fresh every time: new ephemeral key and IV', async () => {
    const manifest = manifestFor(testAddress(9), 'ef'.repeat(32))
    const a = await sealInBrowser(ENC_PUB, cardBytes({ cardNumber: TEST_CARD, pin: null }), manifest)
    const b = await sealInBrowser(ENC_PUB, cardBytes({ cardNumber: TEST_CARD, pin: null }), manifest)
    expect(a.eph).not.toBe(b.eph)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('refuses sizes the template refuses, and keys that are not keys', async () => {
    const manifest = manifestFor(testAddress(9), '01'.repeat(32))
    await expect(sealInBrowser(ENC_PUB, new Uint8Array(0), manifest)).rejects.toThrow(RangeError)
    await expect(sealInBrowser(ENC_PUB, new Uint8Array(513), manifest)).rejects.toThrow(RangeError)
    const card = cardBytes({ cardNumber: TEST_CARD, pin: null })
    await expect(sealInBrowser(ENC_PUB.toUpperCase(), card, manifest)).rejects.toThrow()
    await expect(sealInBrowser(`0x04${ENC_PUB.slice(4)}`, card, manifest)).rejects.toThrow()
    // A well-formed string whose x has no point on the curve (x = 5).
    await expect(sealInBrowser(`0x02${'0'.repeat(63)}5`, card, manifest)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------- the reply key

describe('createBrowserReplyKey', () => {
  it('gives a compressed key and the keccak256 the chain stores', () => {
    const k = createBrowserReplyKey()
    expect(k.publicKey).toMatch(PUB_RE)
    expect(k.replyKeyHash).toBe(keccak256(k.publicKey))
    expect(k.secretKey).toHaveLength(32)
    expect(Buffer.from(secp256k1.getPublicKey(k.secretKey, true)).toString('hex')).toBe(k.publicKey.slice(2))
    expect(createBrowserReplyKey().publicKey).not.toBe(k.publicKey)
  })
})

// ---------------------------------------------------------------------------- end to end

async function mustSend(chain: TestChain, from: Hex, to: Hex, data: Hex): Promise<CallResult> {
  const r = await chain.send(from, to, data)
  if (!r.ok) throw new Error(`send failed: ${r.revert ?? '?'}`)
  return r
}

async function lit(fetchImpl: typeof fetch, params: unknown): Promise<{ response: unknown; keyOps: number }> {
  const r = await runInFakeLit(BUILD.source, params, { now: () => NOW_MS, fetch: fetchImpl })
  expect(r.threw, String(r.response)).toBe(false)
  return { response: JSON.parse(JSON.stringify(r.response)) as unknown, keyOps: r.keyOps }
}

describe('a browser-sealed card, bought and released through the real template', () => {
  it('seal in the browser, list, ticket, pay and open, release, open the reply on the phone', async () => {
    const chain = await TestChain.create({ timestamp: T0, blockNumber: 1000n })
    await installPathUsd(chain, DEPLOYER)
    const escrow = await deployEscrow(chain, ESCROW_DEPLOYER, IDENTITY, PATH_USD)
    expect(escrow).toBe(PINNED_ESCROW)
    await mustSend(chain, DEPLOYER, PATH_USD, tokenCall.mint(BUYER, 1_000_000_000n))
    const rpc = new FakeTempoRpc(chain)
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => rpc.fetch(input, init)) as typeof fetch
    const reader = readerFor(chain)

    // The seller's browser: manifest, seal, commitment on chain.
    const card = { cardNumber: TEST_CARD, pin: null }
    const manifestText = manifestFor(escrow, '5a'.repeat(32))
    const m = parseEscrowManifest(manifestText, escrow) as EscrowManifest
    expect(m).not.toBeNull()
    const envelope = await sealInBrowser(ENC_PUB, cardBytes(card), manifestText)
    const envelopeHash = envelopeHashOf(envelope)
    await mustSend(chain, SELLER, escrow, escrowCall.list(commitment(ESCROW_CHAIN_ID, escrow, PATH_USD, termsOfManifest(m), envelopeHash)))

    // The shopper's phone: a reply key, then a ticket naming it.
    const replyKey = createBrowserReplyKey()
    const t = await lit(fetchImpl, {
      op: 'ticket',
      manifest: manifestText,
      envelope,
      depositor: BUYER,
      replyKeyHash: replyKey.replyKeyHash,
    })
    expect(t.response).toMatchObject({ ok: true })
    expect(t.keyOps).toBe(1)
    const ticket = (t.response as { ticket: { listingId: Hex; replyKeyHash: Hex; openBalanceCents: number; cardTag: Hex; notAfter: number; signature: Hex } }).ticket
    expect(ticket.listingId).toBe(listingIdOfSeal(m, envelope))
    expect(ticket.replyKeyHash).toBe(replyKey.replyKeyHash)

    // One transaction: approve and depositAndOpen.
    const paid = await chain.batch(BUYER, [
      { to: PATH_USD, data: tokenCall.approve(escrow, BigInt(m.price)) },
      {
        to: escrow,
        data: escrowCall.depositAndOpen(termsOfManifest(m), envelopeHash, {
          replyKeyHash: ticket.replyKeyHash,
          openBalanceCents: ticket.openBalanceCents,
          cardTag: ticket.cardTag,
          notAfter: ticket.notAfter,
          signature: ticket.signature,
        }),
      },
    ])
    expect(paid.ok).toBe(true)
    const depositId = (await reader.readContract({ address: escrow, abi: ESCROW_ABI, functionName: 'depositCount' })) as bigint
    expect(depositId).toBe(1n)

    // Release to the phone's key. Lit returns ciphertext only.
    const r = await lit(fetchImpl, {
      op: 'release',
      manifest: manifestText,
      envelope,
      depositId: String(depositId),
      replyKey: replyKey.publicKey,
    })
    const rel = r.response as { ok: boolean; reply: string; payload: string }
    expect(rel.ok).toBe(true)
    expect(r.keyOps).toBe(1)
    expect(JSON.stringify(rel)).not.toContain(TEST_CARD.slice(4, 12))
    expect(rel.payload).toBe(replyPayload(ESCROW_CHAIN_ID, String(depositId), escrow, manifestText))

    // The phone opens it.
    const plain = await openReply(replyKey.secretKey, rel.reply, rel.payload, ENC_PUB)
    expect(JSON.parse(textOf(plain))).toEqual(card)

    // And nothing else opens it: another key, another payload, another encPub, a flipped bit.
    const other = createBrowserReplyKey()
    await expect(openReply(other.secretKey, rel.reply, rel.payload, ENC_PUB)).rejects.toThrow()
    const otherPayload = replyPayload(ESCROW_CHAIN_ID, '2', escrow, manifestText)
    await expect(openReply(replyKey.secretKey, rel.reply, otherPayload, ENC_PUB)).rejects.toThrow()
    await expect(openReply(replyKey.secretKey, rel.reply, rel.payload, other.publicKey)).rejects.toThrow()
    const flipped = Buffer.from(rel.reply, 'base64')
    flipped[0] = (flipped[0] ?? 0) ^ 1
    await expect(openReply(replyKey.secretKey, flipped.toString('base64'), rel.payload, ENC_PUB)).rejects.toThrow()
    await expect(openReply(replyKey.secretKey, 'not base64!', rel.payload, ENC_PUB)).rejects.toThrow(RangeError)
    await expect(openReply(replyKey.secretKey, Buffer.alloc(16).toString('base64'), rel.payload, ENC_PUB)).rejects.toThrow(RangeError)

    // Release is deterministic, so a retry opens to the same card.
    const again = await lit(fetchImpl, {
      op: 'release',
      manifest: manifestText,
      envelope,
      depositId: String(depositId),
      replyKey: replyKey.publicKey,
    })
    expect((again.response as { reply: string }).reply).toBe(rel.reply)
  })
})
