/**
 * The listing and ticket hashes, three ways: src/lib/escrow/hashes.ts, the
 * committed SalvoEscrowV1's own view functions on an in-process EVM, and the
 * frozen Lit template's functions read out of its source with node:vm.
 *
 * Why all three. The seller's browser commits to a listing id computed in
 * TypeScript; the template recomputes it before every ticket and release; the
 * contract recomputes it inside depositAndOpen. Likewise the ticket digest is
 * signed by the template, checked by the contract, and checked again by the
 * shopper's phone before paying. One differing byte anywhere is a listing
 * nobody can buy or a ticket nobody can use, so the three must agree exactly.
 *
 * The cases are generated from a fixed seed, so a failure reproduces.
 */

import { describe, expect, it } from 'vitest'
import { hexToBigInt, keccak256, toHex, type Hex, type PublicClient } from 'viem'
import { ESCROW_ABI } from '@/lib/escrow/artifact'
import {
  commitment,
  coreHash,
  envelopeHashOf,
  listingIdOf,
  listingIdOfSeal,
  openDigest,
  replyPayload,
  termsOfManifest,
  type EscrowTerms,
  type OpenFields,
} from '@/lib/escrow/hashes'
import { buildEscrowManifest, parseEscrowManifest, PATH_USD } from '@/lib/escrow/manifest'
import { envelopeSha256, sealToTemplate } from '@/lib/vault/lit/envelope-crypto'
import { ESCROW_V1 } from '@/lib/vault/lit/templates'
import { TestChain, testAddress } from './support/evm'
import { deployEscrow, deployMockToken, openDigest as typedDataDigest, readerFor } from './support/escrow-chain'
import { fakeEncPubFor, templateScope } from './support/fake-lit'
import { installPathUsd } from './support/fake-tempo-rpc'

const DEPLOYER = testAddress(1)
const SIGNER = testAddress(7)
const CASES = 200

/** 32 deterministic bytes per (case, field). */
const seeded = (i: number, field: string): Hex => keccak256(toHex(`escrow-hashes/${i}/${field}`))
/** A deterministic integer in [0, 2^bits). */
const bits = (i: number, field: string, n: number): bigint => hexToBigInt(seeded(i, field)) % (1n << BigInt(n))
const address = (i: number, field: string): Hex => `0x${seeded(i, field).slice(26)}`

interface Case {
  t: EscrowTerms
  envelopeHash: Hex
  open: OpenFields
}

function generate(i: number): Case {
  // Every field spans its whole width, plus the edges a few times over. Price
  // stops below 2^53 - 1: ethers v5 refuses a JS number at or past it. The
  // template never meets one (its manifest caps price at $500 x 10000).
  const edge = i % 10 === 0
  return {
    t: {
      seller: address(i, 'seller'),
      price: edge ? BigInt(Number.MAX_SAFE_INTEGER - 1) : bits(i, 'price', 53) % BigInt(Number.MAX_SAFE_INTEGER),
      valueCents: edge ? 0xffffffff : Number(bits(i, 'value', 32)),
      residualCapCents: edge ? 0xffff : Number(bits(i, 'cap', 16)),
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
      notAfter: edge ? 2 ** 40 - 1 : Number(bits(i, 'notAfter', 40)),
    },
  }
}

async function escrowOn(chainId: bigint): Promise<{ reader: PublicClient; escrow: Hex }> {
  const chain = await TestChain.create({ chainId })
  const token = chainId === 42431n ? await installPathUsd(chain, DEPLOYER) : await deployMockToken(chain, DEPLOYER)
  const escrow = await deployEscrow(chain, DEPLOYER, SIGNER, token)
  return { reader: readerFor(chain), escrow }
}

async function contractHashes(reader: PublicClient, escrow: Hex, c: Case): Promise<{ core: Hex; commitment: Hex; listingId: Hex; digest: Hex }> {
  const core = await reader.readContract({ address: escrow, abi: ESCROW_ABI, functionName: 'coreHashOf', args: [c.t] })
  const commit = await reader.readContract({ address: escrow, abi: ESCROW_ABI, functionName: 'commitmentOf', args: [c.t, c.envelopeHash] })
  const listingId = await reader.readContract({ address: escrow, abi: ESCROW_ABI, functionName: 'listingIdOf', args: [c.t.seller, commit] })
  const o = c.open
  const digest = await reader.readContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: 'openDigest',
    args: [o.listingId, o.depositor, o.replyKeyHash, o.openBalanceCents, o.cardTag, o.notAfter],
  })
  return { core, commitment: commit, listingId, digest }
}

describe('escrow hashes: TypeScript, contract and template agree', () => {
  it(`agree on ${CASES} generated listings and tickets`, async () => {
    const { reader, escrow } = await escrowOn(42431n)
    const tpl = templateScope(ESCROW_V1.source)
    const tplListingId = tpl('listingIdOf') as (m: Record<string, unknown>, envelopeSha: string) => string
    const tplOpenDigest = tpl('openDigest') as (...a: unknown[]) => string

    for (let i = 0; i < CASES; i++) {
      const c = generate(i)
      const on = await contractHashes(reader, escrow, c)

      const core = coreHash(42431, escrow, PATH_USD, c.t)
      const commit = commitment(42431, escrow, PATH_USD, c.t, c.envelopeHash)
      const listingId = listingIdOf(c.t.seller, commit)
      const digest = openDigest(42431, escrow, c.open)

      expect({ core, commit, listingId, digest }, `case ${i}`).toEqual({
        core: on.core,
        commit: on.commitment,
        listingId: on.listingId,
        digest: on.digest,
      })

      // The template takes a manifest-shaped object (numbers, salt without 0x)
      // and the envelope's sha256 as bare hex.
      const m = {
        escrow,
        seller: c.t.seller,
        price: Number(c.t.price),
        valueCents: c.t.valueCents,
        residualCapCents: c.t.residualCapCents,
        merchant: c.t.merchant,
        mode: c.t.mode,
        listingExpiry: c.t.listingExpiry,
        salt: c.t.salt.slice(2),
      }
      expect(tplListingId(m, c.envelopeHash.slice(2)), `case ${i}`).toBe(listingId)
      const o = c.open
      expect(
        tplOpenDigest(escrow, o.listingId, o.depositor, o.replyKeyHash, o.openBalanceCents, o.cardTag, o.notAfter),
        `case ${i}`,
      ).toBe(digest)
      // And the EIP-712 standard, through viem's typed-data hasher.
      expect(typedDataDigest(42431n, escrow, o), `case ${i}`).toBe(digest)
    }
  })

  it('bind the chain id and the escrow address', async () => {
    const moderato = await escrowOn(42431n)
    const other = await escrowOn(4217n)
    for (let i = 0; i < 5; i++) {
      const c = generate(1000 + i)
      const there = await contractHashes(other.reader, other.escrow, c)
      // Another chain, its own escrow: TypeScript follows both inputs.
      const token = (await other.reader.readContract({ address: other.escrow, abi: ESCROW_ABI, functionName: 'token' })) as Hex
      expect(coreHash(4217, other.escrow, token, c.t)).toBe(there.core)
      expect(openDigest(4217, other.escrow, c.open)).toBe(there.digest)
      // The same terms and ticket on Moderato hash differently, so neither
      // a listing nor a ticket carries over between chains or escrows.
      expect(coreHash(42431, other.escrow, token, c.t)).not.toBe(there.core)
      expect(openDigest(42431, other.escrow, c.open)).not.toBe(there.digest)
      expect(openDigest(42431, testAddress(42), c.open)).not.toBe(openDigest(42431, moderato.escrow, c.open))
    }
  })

  it('hash a real seal the way the template does', () => {
    const tpl = templateScope(ESCROW_V1.source)
    const canonical = tpl('canonical') as (v: unknown) => string
    const sha256Hex = tpl('sha256Hex') as (text: string) => string
    const readEnvelope = tpl('readEnvelope') as (e: unknown) => { sha: string } | null
    const tplListingId = tpl('listingIdOf') as (m: unknown, envelopeSha: string) => string
    const escrow = testAddress(9)

    const manifestText = buildEscrowManifest({
      escrow,
      seller: testAddress(2),
      merchant: 9,
      mode: 2,
      valueCents: 2500,
      price: 22_000_000,
      residualCapCents: 0,
      listingExpiry: 1_790_086_400,
      salt: seeded(0, 'real-salt').slice(2),
    })
    const envelope = sealToTemplate(
      fakeEncPubFor(ESCROW_V1),
      Buffer.from(JSON.stringify({ cardNumber: '9999314159265358', pin: null }), 'utf8'),
      manifestText,
    )
    const m = parseEscrowManifest(manifestText, escrow)
    if (!m) throw new Error('manifest did not parse')

    // The envelope hash is the vault's own envelopeSha256, as bytes32.
    expect(envelopeHashOf(envelope)).toBe(`0x${envelopeSha256(envelope)}`)
    expect(envelopeHashOf(envelope)).toBe(`0x${readEnvelope(envelope)?.sha ?? ''}`)
    // The listing id from TypeScript is the template's, from the same text.
    expect(listingIdOfSeal(m, envelope)).toBe(tplListingId(JSON.parse(manifestText), readEnvelope(envelope)?.sha ?? ''))
    expect(termsOfManifest(m).salt).toBe(`0x${m.salt}`)

    // The reply payload is the template's canonical text.
    expect(replyPayload(42431, '17', escrow, manifestText)).toBe(
      canonical({
        chainId: 42431,
        depositId: '17',
        domain: 'salvo/escrow/reply/v1',
        escrow,
        manifestSha256: sha256Hex(manifestText),
      }),
    )
    // A checksummed escrow address is lower-cased, as the template writes it.
    expect(replyPayload(42431, '17', escrow.toUpperCase().replace('0X', '0x') as Hex, manifestText)).toBe(
      replyPayload(42431, '17', escrow, manifestText),
    )
  })
})
