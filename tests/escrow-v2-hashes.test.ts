/**
 * The V2 listing, ticket and confirm hashes, three ways, and what a leg costs,
 * two ways: src/lib/escrow/{hashes-v2,terms-v2}.ts, the committed
 * SalvoEscrowV2's own views and depositAndOpen on an in-process EVM, and the
 * frozen salvo-vault-escrow/2 template's functions read out of its source
 * with node:vm. viem's EIP-712 hasher is a fourth, independent copy of the
 * two typed digests.
 *
 * Why all of them. The seller's browser commits to a listing id computed in
 * TypeScript; the template recomputes it before every ticket, release and
 * confirm; the contract recomputes it inside depositAndOpen. The ticket and
 * the confirm read are signed by the template and checked by the contract.
 * And the phone asks its wallet for one allowance, the sum of what each leg
 * costs; if ours differs from the contract's by a unit, the purchase fails or
 * over-approves. One differing byte anywhere is a listing nobody can buy.
 *
 * The cases are generated from a fixed seed, so a failure reproduces.
 */

import { describe, expect, it } from 'vitest'
import { encodeFunctionData, hexToBigInt, keccak256, maxUint256, toHex, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ESCROW_V2_ABI } from '@/lib/escrow/artifact-v2'
import { envelopeHashOf, listingIdOf, openDigest as openDigestV1, replyPayload } from '@/lib/escrow/hashes'
import {
  commitmentV2,
  confirmDigestV2,
  coreHashV2,
  listingIdOfSealV2,
  openDigestV2,
  termsOfManifestV2,
  type ConfirmFields,
  type EscrowTermsV2,
  type OpenV2Fields,
} from '@/lib/escrow/hashes-v2'
import { PATH_USD } from '@/lib/escrow/manifest'
import { buildEscrowManifestV2, parseEscrowManifestV2 } from '@/lib/escrow/manifest-v2'
import { priceForV2, quoteUseV2 } from '@/lib/escrow/terms-v2'
import { envelopeSha256, sealToTemplate } from '@/lib/vault/lit/envelope-crypto'
import { ESCROW_V2 } from '@/lib/vault/lit/templates'
import { TestChain, testAddress, type CallResult } from './support/evm'
import { deployMockToken, readerFor, tokenCall } from './support/escrow-chain'
import { deployEscrowV2, escrowV2Call, signTicketV2, typedConfirmDigest, typedOpenDigestV2, type TicketV2 } from './support/escrow-v2-chain'
import { fakeEncPubFor, templateScope } from './support/fake-lit'
import { installPathUsd } from './support/fake-tempo-rpc'

const DEPLOYER = testAddress(1)
const SIGNER = testAddress(7)
const LIT = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const CASES = 200

/** 32 deterministic bytes per (case, field). */
const seeded = (i: number, field: string): Hex => keccak256(toHex(`escrow-v2-hashes/${i}/${field}`))
/** A deterministic integer in [0, 2^bits). */
const bits = (i: number, field: string, n: number): bigint => hexToBigInt(seeded(i, field)) % (1n << BigInt(n))
const address = (i: number, field: string): Hex => `0x${seeded(i, field).slice(26)}`

interface Case {
  t: EscrowTermsV2
  envelopeHash: Hex
  open: OpenV2Fields
  confirm: ConfirmFields
}

function generate(i: number): Case {
  // Every field spans its whole width, plus the edges every tenth case. Price
  // stops below 2^53 - 1 (ethers v5 refuses to encode a JS number at or past
  // it), and so does bondDeposit, a uint64 the template holds as a JS number:
  // deposit ids count up from 1, so the chain never comes near it.
  const edge = i % 10 === 0
  return {
    t: {
      seller: address(i, 'seller'),
      price: edge ? BigInt(Number.MAX_SAFE_INTEGER - 1) : bits(i, 'price', 53) % BigInt(Number.MAX_SAFE_INTEGER),
      valueCents: edge ? 0xffffffff : Number(bits(i, 'value', 32)),
      residualCapCents: edge ? 0xffff : Number(bits(i, 'cap', 16)),
      remainderHaircutBps: edge ? 0xffff : Number(bits(i, 'haircut', 16)),
      merchant: Number(bits(i, 'merchant', 8)),
      mode: Number(bits(i, 'mode', 8)),
      listingExpiry: edge ? 2 ** 40 - 1 : Number(bits(i, 'expiry', 40)),
      salt: seeded(i, 'salt'),
    },
    envelopeHash: seeded(i, 'envelope'),
    open: {
      listingId: seeded(i, 'listing'),
      depositor: address(i, 'depositor'),
      replyKeyHash: seeded(i, 'reply'),
      openBalanceCents: edge ? 0 : Number(bits(i, 'balance', 32)),
      cardTag: seeded(i, 'tag'),
      remainingCents: edge ? 0xffffffff : Number(bits(i, 'remaining', 32)),
      sales: edge ? 0xffff : Number(bits(i, 'sales', 16)),
      notAfter: edge ? 2 ** 40 - 1 : Number(bits(i, 'notAfter', 40)),
    },
    confirm: {
      listingId: seeded(i, 'confirm-listing'),
      bondDeposit: edge ? BigInt(Number.MAX_SAFE_INTEGER - 1) : bits(i, 'bond', 53) % BigInt(Number.MAX_SAFE_INTEGER),
      balance: edge ? 0xffffffff : Number(bits(i, 'confirm-balance', 32)),
      readAt: edge ? 2 ** 40 - 1 : Number(bits(i, 'readAt', 40)),
    },
  }
}

interface Env {
  chain: TestChain
  reader: PublicClient
  escrow: Hex
  token: Hex
}

async function escrowOn(chainId: bigint, signer: Hex = SIGNER): Promise<Env> {
  const chain = await TestChain.create({ chainId })
  const token = chainId === 42431n ? await installPathUsd(chain, DEPLOYER) : await deployMockToken(chain, DEPLOYER)
  const escrow = await deployEscrowV2(chain, DEPLOYER, signer, token)
  return { chain, reader: readerFor(chain), escrow, token }
}

async function contractHashes(env: Env, c: Case): Promise<{ core: Hex; commitment: Hex; listingId: Hex; open: Hex; confirm: Hex }> {
  const at = { address: env.escrow, abi: ESCROW_V2_ABI } as const
  const core = await env.reader.readContract({ ...at, functionName: 'coreHashOf', args: [c.t] })
  const commit = await env.reader.readContract({ ...at, functionName: 'commitmentOf', args: [c.t, c.envelopeHash] })
  const listingId = await env.reader.readContract({ ...at, functionName: 'listingIdOf', args: [c.t.seller, commit] })
  const o = c.open
  const open = await env.reader.readContract({
    ...at,
    functionName: 'openDigest',
    // The ticket struct, as depositAndOpen hands it over; its signature is not part of the digest.
    args: [o.listingId, o.depositor, { ...o, signature: '0x' }],
  })
  const f = c.confirm
  const confirm = await env.reader.readContract({ ...at, functionName: 'confirmDigest', args: [f.listingId, f.bondDeposit, f.balance, f.readAt] })
  return { core, commitment: commit, listingId, open, confirm }
}

describe('escrow V2 hashes: TypeScript, contract and template agree', () => {
  it(`agree on ${CASES} generated listings, tickets and confirm reads`, async () => {
    const env = await escrowOn(42431n)
    const tpl = templateScope(ESCROW_V2.source)
    const tplListingId = tpl('listingIdOf') as (m: Record<string, unknown>, envelopeSha: string) => string
    const tplOpenDigest = tpl('openDigest') as (...a: unknown[]) => string
    const tplConfirmDigest = tpl('confirmDigest') as (...a: unknown[]) => string

    for (let i = 0; i < CASES; i++) {
      const c = generate(i)
      const on = await contractHashes(env, c)

      const core = coreHashV2(42431, env.escrow, PATH_USD, c.t)
      const commit = commitmentV2(42431, env.escrow, PATH_USD, c.t, c.envelopeHash)
      const listingId = listingIdOf(c.t.seller, commit)
      const open = openDigestV2(42431, env.escrow, c.open)
      const confirm = confirmDigestV2(42431, env.escrow, c.confirm)

      expect({ core, commit, listingId, open, confirm }, `case ${i}`).toEqual({
        core: on.core,
        commit: on.commitment,
        listingId: on.listingId,
        open: on.open,
        confirm: on.confirm,
      })

      // The template takes a manifest-shaped object (numbers, salt without 0x)
      // and the envelope's sha256 as bare hex.
      const m = {
        escrow: env.escrow,
        seller: c.t.seller,
        price: Number(c.t.price),
        valueCents: c.t.valueCents,
        residualCapCents: c.t.residualCapCents,
        remainderHaircutBps: c.t.remainderHaircutBps,
        merchant: c.t.merchant,
        mode: c.t.mode,
        listingExpiry: c.t.listingExpiry,
        salt: c.t.salt.slice(2),
      }
      expect(tplListingId(m, c.envelopeHash.slice(2)), `case ${i}`).toBe(listingId)
      const o = c.open
      expect(
        tplOpenDigest(env.escrow, o.listingId, o.depositor, o.replyKeyHash, o.openBalanceCents, o.cardTag, o.remainingCents, o.sales, o.notAfter),
        `case ${i}`,
      ).toBe(open)
      const f = c.confirm
      expect(tplConfirmDigest(env.escrow, f.listingId, Number(f.bondDeposit), f.balance, f.readAt), `case ${i}`).toBe(confirm)
      // And the EIP-712 standard, through viem's typed-data hasher.
      expect(typedOpenDigestV2(42431n, env.escrow, o), `case ${i}`).toBe(open)
      expect(typedConfirmDigest(42431n, env.escrow, f), `case ${i}`).toBe(confirm)
    }
  })

  it('bind the chain id, the escrow address and the version: nothing carries over from V1 or between escrows', async () => {
    const moderato = await escrowOn(42431n)
    const other = await escrowOn(4217n)
    for (let i = 0; i < 5; i++) {
      const c = generate(1000 + i)
      const there = await contractHashes(other, c)
      expect(coreHashV2(4217, other.escrow, other.token, c.t)).toBe(there.core)
      expect(openDigestV2(4217, other.escrow, c.open)).toBe(there.open)
      expect(confirmDigestV2(4217, other.escrow, c.confirm)).toBe(there.confirm)
      // The same terms, ticket and read on Moderato, or at another escrow, hash differently.
      expect(coreHashV2(42431, other.escrow, other.token, c.t)).not.toBe(there.core)
      expect(openDigestV2(42431, other.escrow, c.open)).not.toBe(there.open)
      expect(confirmDigestV2(42431, other.escrow, c.confirm)).not.toBe(there.confirm)
      expect(openDigestV2(42431, testAddress(42), c.open)).not.toBe(openDigestV2(42431, moderato.escrow, c.open))
      // A V1 ticket over the same shared fields is another digest: V2 signs under version "2" and type OpenV2.
      expect(openDigestV1(42431, moderato.escrow, c.open)).not.toBe(openDigestV2(42431, moderato.escrow, c.open))
      // The value left and the sales count are inside the digest: change either and it is another ticket.
      expect(openDigestV2(42431, moderato.escrow, { ...c.open, remainingCents: (c.open.remainingCents + 1) % 2 ** 32 })).not.toBe(
        openDigestV2(42431, moderato.escrow, c.open),
      )
      expect(openDigestV2(42431, moderato.escrow, { ...c.open, sales: (c.open.sales + 1) % 2 ** 16 })).not.toBe(
        openDigestV2(42431, moderato.escrow, c.open),
      )
      // So is the haircut in the terms.
      expect(coreHashV2(42431, moderato.escrow, PATH_USD, { ...c.t, remainderHaircutBps: (c.t.remainderHaircutBps + 1) % 2 ** 16 })).not.toBe(
        coreHashV2(42431, moderato.escrow, PATH_USD, c.t),
      )
    }
  })

  it('hash a real V2 seal the way the template does', () => {
    const tpl = templateScope(ESCROW_V2.source)
    const canonical = tpl('canonical') as (v: unknown) => string
    const sha256Hex = tpl('sha256Hex') as (text: string) => string
    const readEnvelope = tpl('readEnvelope') as (e: unknown) => { sha: string } | null
    const tplListingId = tpl('listingIdOf') as (m: unknown, envelopeSha: string) => string
    const escrow = testAddress(9)

    const manifestText = buildEscrowManifestV2({
      escrow,
      seller: testAddress(2),
      merchant: 9,
      mode: 2,
      valueCents: 2500,
      price: 22_500_000,
      residualCapCents: 500,
      remainderHaircutBps: 2500,
      listingExpiry: 1_790_086_400,
      salt: seeded(0, 'real-salt').slice(2),
    })
    const envelope = sealToTemplate(
      fakeEncPubFor(ESCROW_V2),
      Buffer.from(JSON.stringify({ cardNumber: '9999314159265358', pin: null }), 'utf8'),
      manifestText,
    )
    const m = parseEscrowManifestV2(manifestText, escrow)
    if (!m) throw new Error('manifest did not parse')

    expect(envelopeHashOf(envelope)).toBe(`0x${envelopeSha256(envelope)}`)
    expect(envelopeHashOf(envelope)).toBe(`0x${readEnvelope(envelope)?.sha ?? ''}`)
    expect(listingIdOfSealV2(m, envelope)).toBe(tplListingId(JSON.parse(manifestText), readEnvelope(envelope)?.sha ?? ''))
    expect(termsOfManifestV2(m)).toMatchObject({ salt: `0x${m.salt}`, remainderHaircutBps: 2500, price: 22_500_000n })

    // The reply payload is V1's function, unchanged: the template writes the same canonical text.
    expect(replyPayload(42431, '17', escrow, manifestText)).toBe(
      canonical({ chainId: 42431, depositId: '17', domain: 'salvo/escrow/reply/v1', escrow, manifestSha256: sha256Hex(manifestText) }),
    )
  })
})

// ---------------------------------------------------------------------------- what a leg costs

describe('escrow V2 terms: what a leg costs, TypeScript and contract agree', () => {
  it(`priceFor on ${CASES} generated cases, haircut or not`, async () => {
    const env = await escrowOn(42431n)
    for (let i = 0; i < CASES; i++) {
      const valueCents = 1 + Number(bits(i, 'pf-value', 16)) * 8 // up to about $5,000 of face, past the $500 a listing may hold
      const price = bits(i, 'pf-price', 40) % (BigInt(valueCents) * 10_000n + 1n)
      const used = Number(bits(i, 'pf-used', 32)) % (valueCents + 1)
      const haircut = i % 4 === 0 ? 0 : i % 4 === 1 ? 9_999 : Number(bits(i, 'pf-haircut', 16)) % 10_000
      const onChain = await env.reader.readContract({
        address: env.escrow,
        abi: ESCROW_V2_ABI,
        functionName: 'priceFor',
        args: [price, BigInt(valueCents), BigInt(used), BigInt(haircut)],
      })
      expect(priceForV2(price, valueCents, used, haircut), `case ${i}`).toBe(onChain)
    }
    // The contract refuses what we refuse.
    expect(() => priceForV2(1n, 0, 1, 0)).toThrow(RangeError)
    expect(() => priceForV2(1n, 1, 1, 10_000)).toThrow(RangeError)
    const r = await env.chain.call(
      DEPLOYER,
      env.escrow,
      encodeFunctionData({ abi: ESCROW_V2_ABI, functionName: 'priceFor', args: [1n, 1n, 1n, 10_000n] }),
    )
    expect(r.revert).toBe('price args')
  })

  it(`quoteUseV2 on ${CASES} generated legs: the same verdict and, on success, the same pull, deposit and refund`, async () => {
    // A real purchase per case: list, maybe a first sale, then the case's sale,
    // by the first buyer (their own remainder, netted) or another (used whole).
    const env = await escrowOn(42431n, LIT.address.toLowerCase() as Hex)
    const SELLER = testAddress(2)
    const A = testAddress(3)
    const B = testAddress(5)
    for (const who of [A, B]) {
      await env.chain.send(DEPLOYER, env.token, tokenCall.mint(who, 10n ** 15n))
      await env.chain.send(who, env.token, tokenCall.approve(env.escrow, maxUint256))
    }
    const balanceOf = async (who: Hex): Promise<bigint> =>
      env.reader.readContract({
        address: env.token,
        abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
        functionName: 'balanceOf',
        args: [who],
      })
    const gate = async (listingId: Hex) => {
      const g = await env.reader.readContract({ address: env.escrow, abi: ESCROW_V2_ABI, functionName: 'gate', args: [listingId, 0n] })
      return { remainingCents: g[8], sales: g[9], bondDeposit: g[10] }
    }
    const ticket = async (listingId: Hex, depositor: Hex, tag: Hex, mode: number, valueCents: number): Promise<TicketV2> => {
      const g = await gate(listingId)
      const have = g.sales === 0 ? valueCents : g.remainingCents
      return signTicketV2(LIT, 42431n, env.escrow, {
        listingId,
        depositor,
        replyKeyHash: keccak256(toHex(`reply-${listingId}-${depositor}`)),
        openBalanceCents: mode === 1 ? have : 0,
        cardTag: tag,
        remainingCents: have,
        sales: g.sales,
        notAfter: Number(env.chain.timestamp) + 600,
      })
    }
    const mustOk = (r: CallResult, what: string): void => {
      if (!r.ok) throw new Error(`${what}: ${r.revert ?? '?'}`)
    }

    let agreed = 0
    let refused = 0
    for (let i = 0; i < CASES; i++) {
      const mode = i % 3 === 0 ? 1 : 2
      const valueCents = 100 + Number(bits(i, 'q-value', 16)) % 2_400 // blind stays at or under the $25 new-seller cap
      const cap = Number(bits(i, 'q-cap', 16)) % ((mode === 1 ? 1000 : 500) + 1)
      const t: EscrowTermsV2 = {
        seller: SELLER,
        price: 1n + (bits(i, 'q-price', 40) % (BigInt(valueCents) * 10_000n)),
        valueCents,
        residualCapCents: cap,
        remainderHaircutBps: i % 5 === 0 ? 0 : Number(bits(i, 'q-haircut', 16)) % 10_000,
        merchant: mode === 1 ? 1 : 9,
        mode,
        listingExpiry: Number(env.chain.timestamp) + 86_400,
        salt: seeded(i, 'q-salt'),
      }
      const envelopeHash = seeded(i, 'q-envelope')
      const tag = seeded(i, 'q-tag')
      mustOk(await env.chain.send(SELLER, env.escrow, escrowV2Call.list(commitmentV2(42431, env.escrow, env.token, t, envelopeHash))), 'list')
      const listingId = listingIdOf(SELLER, commitmentV2(42431, env.escrow, env.token, t, envelopeHash))

      // A first sale that leaves something, for two cases in three.
      if (i % 3 !== 2 && cap > 0) {
        const left = 1 + (Number(bits(i, 'q-left1', 16)) % Math.min(cap, valueCents - 1))
        const k = await ticket(listingId, A, tag, mode, valueCents)
        mustOk(await env.chain.send(A, env.escrow, escrowV2Call.depositAndOpen(t, envelopeHash, valueCents - left, k)), 'first sale')
      }
      const g = await gate(listingId)
      const buyer = i % 2 === 0 ? A : B
      const have = g.sales === 0 ? valueCents : g.remainingCents
      // Mostly in range, sometimes past it either way, so every refusal is met.
      const roll = Number(bits(i, 'q-used', 16))
      const used = roll % 9 === 0 ? 0 : roll % 9 === 1 ? have + 1 : 1 + (roll % have)
      const own =
        g.bondDeposit !== 0n
          ? (await env.reader.readContract({ address: env.escrow, abi: ESCROW_V2_ABI, functionName: 'getDeposit', args: [g.bondDeposit] }))
          : null
      const ownBond = own !== null && own.depositor.toLowerCase() === buyer ? own.bond : null
      const quote = quoteUseV2(t, { remainingCents: g.remainingCents, sales: g.sales, bondDeposit: g.bondDeposit, ownBond }, used)

      const k = await ticket(listingId, buyer, tag, mode, valueCents)
      const before = { buyer: await balanceOf(buyer), escrow: await balanceOf(env.escrow) }
      const r = await env.chain.send(buyer, env.escrow, escrowV2Call.depositAndOpen(t, envelopeHash, used, k))
      if ('refused' in quote) {
        expect(r.revert, `case ${i}: ${JSON.stringify({ used, have, cap, g: String(g.bondDeposit) })}`).toBe(quote.refused)
        refused++
        continue
      }
      expect(r.revert, `case ${i}`).toBeNull()
      const after = { buyer: await balanceOf(buyer), escrow: await balanceOf(env.escrow) }
      expect(before.buyer - after.buyer + quote.refund, `case ${i}: pull`).toBe(quote.pull)
      const d = await env.reader.readContract({
        address: env.escrow,
        abi: ESCROW_V2_ABI,
        functionName: 'getDeposit',
        args: [await env.reader.readContract({ address: env.escrow, abi: ESCROW_V2_ABI, functionName: 'depositCount' })],
      })
      expect({ amount: d.amount, bond: d.bond, used: d.usedCents, left: d.leftAfterCents }, `case ${i}`).toEqual({
        amount: quote.amount,
        bond: quote.bond,
        used: quote.usedCents,
        left: quote.leftCents,
      })
      // The escrow keeps the pull, less any refund. Another buyer's covering deposit stays held for
      // the contest window, blind or readable, so nothing else leaves in the sale.
      expect(after.escrow - before.escrow, `case ${i}: escrow`).toBe(quote.pull - quote.refund)
      agreed++
    }
    // Every branch was met, not just the happy one.
    expect(agreed).toBeGreaterThan(60)
    expect(refused).toBeGreaterThan(30)
  })
})
