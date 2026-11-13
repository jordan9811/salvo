/**
 * The custody guard and the escrow backend, before the custody review.
 *
 * Phase 1 builds the escrow contract and template, and the guard learns their
 * tag, but the tag must NOT count as non-custodial until the review in spec
 * section 11 (live bind and pins, deployed code hash, live smoke, a second
 * reviewer, testnet only). So everything here asserts the refusing direction:
 *   - the escrow tag classifies `unknown`, never `non_custodial`, and so does
 *     every lookalike and every drifted template
 *   - NON_CUSTODIAL_BACKENDS is still the empty set, as text, so adding to it
 *     fails this file until the review updates it on purpose
 *   - a ref names the escrow only with a well-formed escrow seal record (no
 *     attestor signature), the exact pins and an intact template; the attested
 *     LitSealRecord parser refuses that record, so Phase 3 must not use it
 *   - nobody, the operator included, seals an escrow listing from plaintext on
 *     our server
 *   - a sealed escrow ref is refused for every seller: someone else's listing
 *     by its seller address, their own by custody
 *
 * The committed template pins the live Moderato escrow (2026-10-10). The
 * template before that pin step, and one pinned to a test escrow, are made
 * for one import graph with vi.doMock (unpinnedGuard, pinnedGuard).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEscrowManifest } from '@/lib/escrow/manifest'
import { parseEscrowSealRecord } from '@/lib/escrow/seal-record'
import type { AccountOwner } from '@/lib/supply/accounts'
import { CHIPOTLE_ATTESTED_BACKEND } from '@/lib/vault/chipotle'
import { CHIPOTLE_ESCROW_ALGORITHM, CHIPOTLE_ESCROW_BACKEND } from '@/lib/vault/escrow-backend'
import {
  CustodialVaultRefusedError,
  assertSealedRefAllowedForOwner,
  assertVaultAllowedForOwner,
  backendOfSealedRef,
  classifyBackend,
  sealForOwner,
  type GuardedSealedRef,
} from '@/lib/vault/guard'
import { parseLitSealRecord } from '@/lib/vault/lit/ref'
import { ATTESTED_V1, ESCROW_V1, templateIntegrity, type EscrowTemplate } from '@/lib/vault/lit/templates'
import { CardSecret, type AccessCondition, type SecretRef, type SecretVault } from '@/lib/vault/types'
import { ESCROW_PIN_PLACEHOLDER } from '@/lib/escrow/deployment'

const SELLER_ADDRESS = '0x5a17000000000000000000000000000000000002'
/** The escrow these listings name. Tests that need it pinned pin it with pinnedGuard(). */
const ESCROW_ADDRESS = '0x5a17000000000000000000000000000000000009'
/** The escrow the committed template pins: the live Moderato deployment of 2026-10-10. */
const LIVE_ESCROW = '0x75c9aabe8254559f865e14d6e5fa70c738869bef'
const OTHER_ADDRESS = '0x5a17000000000000000000000000000000000007'
const OPERATOR: AccountOwner = { kind: 'operator', ownerId: 'operator:0' }
const SELLER: AccountOwner = { kind: 'seller', ownerId: `seller:${SELLER_ADDRESS}` }
const OTHER_SELLER: AccountOwner = { kind: 'seller', ownerId: `seller:${OTHER_ADDRESS}` }

function escrowManifest(seller: string = SELLER_ADDRESS, escrow: `0x${string}` = ESCROW_ADDRESS): string {
  return buildEscrowManifest({
    escrow,
    seller: seller as `0x${string}`,
    merchant: 9,
    mode: 2,
    valueCents: 2500,
    price: 22_000_000,
    residualCapCents: 0,
    listingExpiry: 1_790_086_400,
    salt: 'ab'.repeat(32),
  })
}

/** The `lit` block exactly as the escrow listings route will store it: seven keys, no sealSignature. */
function escrowRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    network: 'api.chipotle.litprotocol.com',
    template: ESCROW_V1.id,
    templateSha256: ESCROW_V1.sha256,
    cid: ESCROW_V1.cid,
    encPub: `0x02${'ab'.repeat(32)}`,
    manifest: escrowManifest(),
    ...over,
  }
}

function escrowRef(over: Record<string, unknown> = {}, algorithm = CHIPOTLE_ESCROW_ALGORITHM): GuardedSealedRef {
  return { algorithm, lit: escrowRecord(over) }
}

/** The guard in an import graph where the template pins ESCROW_ADDRESS, so a listing's manifest parses. */
async function pinnedGuard(): Promise<typeof import('@/lib/vault/guard')> {
  vi.resetModules()
  vi.doMock('@/lib/vault/lit/templates', async (importOriginal) => {
    const real = await importOriginal<typeof import('@/lib/vault/lit/templates')>()
    return { ...real, ESCROW_V1: Object.freeze({ ...real.ESCROW_V1, escrowAddress: ESCROW_ADDRESS }) }
  })
  return import('@/lib/vault/guard')
}

/**
 * ESCROW_V1 as it was before the pin step: the placeholder ESCROW line, those
 * bytes' own sha256 and CID (so it is intact), and nothing pinned.
 */
function unpinnedTemplate(t: EscrowTemplate): EscrowTemplate {
  const source = t.source.replace(/\nconst ESCROW = "[^"\n]*";\n/, `\n${ESCROW_PIN_PLACEHOLDER}\n`)
  if (source.split(ESCROW_PIN_PLACEHOLDER).length !== 2) throw new Error('unpinnedTemplate: no single ESCROW line')
  const { sha256, cid } = templateIntegrity({ source, sha256: '', cid: '' })
  return { ...t, source, sha256, cid, escrowAddress: null, escrowDeployer: null, escrowCreationTx: null, identity: null, encPub: null }
}

/** The guard and the escrow tag in an import graph where the template is unpinned. */
async function unpinnedGuard(): Promise<{
  guard: typeof import('@/lib/vault/guard')
  backend: string
  template: EscrowTemplate
}> {
  vi.resetModules()
  const template = Object.freeze(unpinnedTemplate(ESCROW_V1))
  vi.doMock('@/lib/vault/lit/templates', async (importOriginal) => {
    const real = await importOriginal<typeof import('@/lib/vault/lit/templates')>()
    return { ...real, ESCROW_V1: template }
  })
  const guard = await import('@/lib/vault/guard')
  const { CHIPOTLE_ESCROW_BACKEND: backend } = await import('@/lib/vault/escrow-backend')
  return { guard, backend, template }
}

/** A vault that records whether seal was ever reached. */
function vaultWithBackend(backend: string): SecretVault & { sealed: number } {
  const v = {
    backend,
    sealed: 0,
    async seal(_s: CardSecret, _c: AccessCondition): Promise<SecretRef> {
      v.sealed++
      throw new Error('seal must not be reached')
    },
    async unseal(): Promise<CardSecret> {
      throw new Error('unused')
    },
  }
  return v
}

const CONDITION: AccessCondition = {
  kind: 'escrow_funded_and_matched',
  intentId: 'int_escrow_guard',
  orderId: null,
  expiresAt: new Date('2030-01-01T00:00:00Z'),
}

function refusal(fn: () => void): CustodialVaultRefusedError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(CustodialVaultRefusedError)
    return err as CustodialVaultRefusedError
  }
  throw new Error('expected a refusal')
}

afterEach(() => {
  vi.doUnmock('@/lib/vault/lit/templates')
  vi.resetModules()
})

describe('the escrow backend tag', () => {
  it('carries the template sha256 the source actually hashes to', () => {
    expect(CHIPOTLE_ESCROW_ALGORITHM).toBe('chipotle:escrow:v1')
    expect(CHIPOTLE_ESCROW_BACKEND).toBe(`chipotle:escrow:v1@sha256:${templateIntegrity(ESCROW_V1).sha256}`)
    expect(CHIPOTLE_ESCROW_BACKEND).toBe(`chipotle:escrow:v1@sha256:${ESCROW_V1.sha256}`)
    expect(CHIPOTLE_ESCROW_BACKEND).not.toBe(CHIPOTLE_ATTESTED_BACKEND)
  })

  it('is not non-custodial before the review: it classifies unknown', () => {
    expect(classifyBackend(CHIPOTLE_ESCROW_BACKEND)).toBe('unknown')
    expect(classifyBackend(CHIPOTLE_ESCROW_BACKEND)).not.toBe('non_custodial')
  })

  it('no lookalike or drifted tag is non-custodial either', () => {
    const lookalikes = [
      CHIPOTLE_ESCROW_ALGORITHM,
      'chipotle:escrow',
      'chipotle:escrow:v1@sha256:',
      `chipotle:escrow:v1@sha256:${'0'.repeat(64)}`,
      `chipotle:escrow:v1@sha256:${ESCROW_V1.sha256.slice(0, 63)}`,
      `chipotle:escrow:v1@sha256:${ESCROW_V1.sha256.toUpperCase()}`,
      `chipotle:escrow:v2@sha256:${ESCROW_V1.sha256}`,
      `${CHIPOTLE_ESCROW_BACKEND} `,
      `${CHIPOTLE_ESCROW_BACKEND}:x`,
      `chipotle:escrow:v1@sha256:${ATTESTED_V1.sha256}`,
    ]
    for (const tag of lookalikes) expect(classifyBackend(tag), tag).toBe('unknown')
    // The attested template stays custodial, whatever the escrow does.
    expect(classifyBackend(CHIPOTLE_ATTESTED_BACKEND)).toBe('custodial')
  })

  it('NON_CUSTODIAL_BACKENDS is still empty: the flip is Phase 5, after review', () => {
    // A text check on purpose. The set is private, and the point is that adding
    // a literal to it is a deliberate, reviewed edit that also edits this test.
    const guard = readFileSync(resolve(process.cwd(), 'src/lib/vault/guard.ts'), 'utf8')
    const decl = guard.match(/^const NON_CUSTODIAL_BACKENDS\b.*$/m)
    expect(decl?.[0]).toBe('const NON_CUSTODIAL_BACKENDS: ReadonlySet<string> = new Set<string>()')
    expect(guard).not.toMatch(/NON_CUSTODIAL_BACKENDS\s*\.\s*add\b/)
  })
})

describe('backendOfSealedRef', () => {
  it('names the escrow only for the exact pins of an intact template', () => {
    expect(backendOfSealedRef(escrowRef())).toBe(CHIPOTLE_ESCROW_BACKEND)
  })

  it('falls back to the bare algorithm for anything less', () => {
    const { manifest: _m, ...noManifest } = escrowRecord()
    const cases: GuardedSealedRef[] = [
      escrowRef({ template: 'salvo-vault-escrow/2' }),
      // Not an escrow seal record: an attestor signature, a missing or extra
      // key, a malformed field, or no record at all.
      escrowRef({ sealSignature: `0x${'11'.repeat(65)}` }),
      { algorithm: CHIPOTLE_ESCROW_ALGORITHM, lit: noManifest },
      escrowRef({ extra: 1 }),
      escrowRef({ v: 2 }),
      escrowRef({ encPub: 'not-a-key' }),
      escrowRef({ manifest: '' }),
      { algorithm: CHIPOTLE_ESCROW_ALGORITHM, lit: 'salvo-vault-escrow/1' },
      escrowRef({ template: ATTESTED_V1.id }),
      escrowRef({ templateSha256: ATTESTED_V1.sha256 }),
      escrowRef({ templateSha256: ESCROW_V1.sha256.toUpperCase() }),
      escrowRef({ cid: ATTESTED_V1.cid }),
      { algorithm: CHIPOTLE_ESCROW_ALGORITHM },
    ]
    for (const ref of cases) {
      expect(backendOfSealedRef(ref)).toBe(CHIPOTLE_ESCROW_ALGORITHM)
      expect(classifyBackend(backendOfSealedRef(ref))).toBe('unknown')
    }
    // A ref that claims the full reviewed tag, or any other escrow-looking
    // algorithm, never names the backend: only the verified path can. Here
    // the record is sealed to the custodial attested template.
    for (const algorithm of [CHIPOTLE_ESCROW_BACKEND, `${CHIPOTLE_ESCROW_ALGORITHM}@sha256:${'0'.repeat(64)}`, 'chipotle:escrow:v2']) {
      const forged = escrowRef({ templateSha256: ATTESTED_V1.sha256, cid: ATTESTED_V1.cid }, algorithm)
      expect(backendOfSealedRef(forged)).toBe(CHIPOTLE_ESCROW_ALGORITHM)
      expect(backendOfSealedRef(escrowRef({}, algorithm))).toBe(CHIPOTLE_ESCROW_ALGORITHM)
      expect(classifyBackend(backendOfSealedRef(forged))).toBe('unknown')
    }
    // Another algorithm keeps its own name, even with perfect escrow pins.
    expect(backendOfSealedRef(escrowRef({}, 'chipotle:attested:v1'))).toBe('chipotle:attested:v1')
    expect(classifyBackend(backendOfSealedRef(escrowRef({}, 'chipotle:attested:v1')))).toBe('custodial')
    expect(backendOfSealedRef({ algorithm: 'aes-256-gcm+envelope' })).toBe('aes-256-gcm+envelope')
  })

  it('a drifted template computes another tag and no ref names it', async () => {
    vi.resetModules()
    vi.doMock('@/lib/vault/lit/templates', async (importOriginal) => {
      const real = await importOriginal<typeof import('@/lib/vault/lit/templates')>()
      return { ...real, ESCROW_V1: Object.freeze({ ...real.ESCROW_V1, source: `${real.ESCROW_V1.source} ` }) }
    })
    const backend = await import('@/lib/vault/escrow-backend')
    const guard = await import('@/lib/vault/guard')
    expect(backend.CHIPOTLE_ESCROW_BACKEND).not.toBe(CHIPOTLE_ESCROW_BACKEND)
    expect(guard.classifyBackend(backend.CHIPOTLE_ESCROW_BACKEND)).toBe('unknown')
    expect(guard.backendOfSealedRef(escrowRef())).toBe(CHIPOTLE_ESCROW_ALGORITHM)
  })
})

describe('the escrow seal record is its own record, not a LitSealRecord', () => {
  it('has no sealSignature, so the attested parser refuses it and the escrow parser takes it', () => {
    // Spec section 12 said the escrow ref reuses the "7-key LitSealRecord" so
    // parseSecretRef needs no change. That record has 8 keys and requires our
    // attestor's sealSignature, which a browser seal never has.
    const record = escrowRecord()
    expect(() => parseLitSealRecord(record)).toThrow(/malformed/)
    expect(parseEscrowSealRecord(record)).toEqual(record)
    // And an escrow record never carries one.
    expect(parseEscrowSealRecord({ ...record, sealSignature: `0x${'11'.repeat(65)}` })).toBeNull()
    for (const bad of [null, [], 'x', { ...record, network: 'Not A Host' }, { ...record, cid: 'Qm' }, { ...record, templateSha256: 'AB'.repeat(32) }]) {
      expect(parseEscrowSealRecord(bad)).toBeNull()
    }
  })
})

describe('no server-side plaintext seal under the escrow', () => {
  it('refuses any chipotle:escrow backend, for sellers and for the operator', async () => {
    for (const backend of [CHIPOTLE_ESCROW_BACKEND, CHIPOTLE_ESCROW_ALGORITHM, 'chipotle:escrow', 'chipotle:escrowX']) {
      for (const owner of [OPERATOR, SELLER]) {
        const vault = vaultWithBackend(backend)
        const err = refusal(() => assertVaultAllowedForOwner(vault, owner))
        expect(err.message).toMatch(/escrow seals are made in the seller's browser/)
        await expect(sealForOwner(vault, new CardSecret('9999000011112222'), CONDITION, owner)).rejects.toThrow(
          CustodialVaultRefusedError,
        )
        expect(vault.sealed).toBe(0)
      }
    }
  })

  it('leaves the operator carve-out alone for other backends', () => {
    expect(() => assertVaultAllowedForOwner(vaultWithBackend('local-envelope:aes-256-gcm'), OPERATOR)).not.toThrow()
    expect(() => assertVaultAllowedForOwner(vaultWithBackend('chipotle:attested:v1'), SELLER)).toThrow(
      CustodialVaultRefusedError,
    )
  })
})

describe('assertSealedRefAllowedForOwner', () => {
  it('refuses a seller their own escrow listing until the custody review', () => {
    const err = refusal(() => assertSealedRefAllowedForOwner(escrowRef(), SELLER))
    expect(err.backend).toBe(CHIPOTLE_ESCROW_BACKEND)
    expect(err.message).toMatch(/has not passed the custody review/)
  })

  it("refuses someone else's listing by its seller address", async () => {
    const guard = await pinnedGuard()
    const refused = (owner: AccountOwner): Error => {
      try {
        guard.assertSealedRefAllowedForOwner(escrowRef(), owner)
      } catch (err) {
        expect(err).toBeInstanceOf(guard.CustodialVaultRefusedError)
        return err as Error
      }
      throw new Error('expected a refusal')
    }
    expect(refused(OTHER_SELLER).message).toMatch(/seller address is not this account/)
    // The bare address, or another case, is not the owner id either.
    expect(refused({ kind: 'seller', ownerId: SELLER_ADDRESS }).message).toMatch(/seller address is not this account/)
    expect(refused({ kind: 'seller', ownerId: `seller:${SELLER_ADDRESS.toUpperCase()}` }).message).toMatch(
      /seller address is not this account/,
    )
    // The listing's own seller gets past that, to the custody refusal.
    expect(refused(SELLER).message).toMatch(/has not passed the custody review/)
  })

  it('reads the manifest as the template does: one naming another escrow, or any while none is pinned, names no seller', async () => {
    // Unpinned (the build before the pin step): no manifest parses, so even a
    // stranger's listing is refused by custody, not by seller. Still refused,
    // never let through. The ref carries the unpinned template's own pins, so
    // the verified path names the escrow backend: the refusal is custody's.
    const unpinned = await unpinnedGuard()
    expect(unpinned.template.escrowAddress).toBeNull()
    expect(templateIntegrity(unpinned.template).intact).toBe(true)
    for (const escrow of [ESCROW_ADDRESS, LIVE_ESCROW] as const) {
      const ref = escrowRef({
        templateSha256: unpinned.template.sha256,
        cid: unpinned.template.cid,
        manifest: escrowManifest(SELLER_ADDRESS, escrow),
      })
      expect(unpinned.guard.backendOfSealedRef(ref)).toBe(unpinned.backend)
      let err: unknown
      try {
        unpinned.guard.assertSealedRefAllowedForOwner(ref, OTHER_SELLER)
      } catch (e) {
        err = e
      }
      expect(err, escrow).toBeInstanceOf(unpinned.guard.CustodialVaultRefusedError)
      expect((err as Error).message, escrow).toMatch(/has not passed the custody review/)
    }
    // The committed build pins the live escrow, so a listing naming any other
    // escrow names no seller either: refused by custody.
    expect(ESCROW_V1.escrowAddress).toBe(LIVE_ESCROW)
    expect(refusal(() => assertSealedRefAllowedForOwner(escrowRef(), OTHER_SELLER)).message).toMatch(
      /has not passed the custody review/,
    )
    // Pinned to another escrow: the same.
    const guard = await pinnedGuard()
    const otherEscrow = escrowRef({
      manifest: buildEscrowManifest({
        escrow: '0x5a1700000000000000000000000000000000000a',
        seller: SELLER_ADDRESS,
        merchant: 9,
        mode: 2,
        valueCents: 2500,
        price: 22_000_000,
        residualCapCents: 0,
        listingExpiry: 1_790_086_400,
        salt: 'ab'.repeat(32),
      }),
    })
    expect(() => guard.assertSealedRefAllowedForOwner(otherEscrow, OTHER_SELLER)).toThrow(/has not passed the custody review/)
  })

  it('the committed build reads a listing naming the live escrow: a stranger by seller, its own seller by custody', () => {
    // No mock: the committed template pins the live Moderato escrow, so a
    // manifest naming it parses and names its seller. Still refused for
    // every seller until the custody review.
    const live = escrowRef({ manifest: escrowManifest(SELLER_ADDRESS, LIVE_ESCROW) })
    expect(backendOfSealedRef(live)).toBe(CHIPOTLE_ESCROW_BACKEND)
    const stranger = refusal(() => assertSealedRefAllowedForOwner(live, OTHER_SELLER))
    expect(stranger.message).toMatch(/seller address is not this account/)
    const own = refusal(() => assertSealedRefAllowedForOwner(live, SELLER))
    expect(own.backend).toBe(CHIPOTLE_ESCROW_BACKEND)
    expect(own.message).toMatch(/has not passed the custody review/)
    expect(() => assertSealedRefAllowedForOwner(live, OPERATOR)).not.toThrow()
  })

  it('refuses refs that are not escrow listings, by their own custody', () => {
    const attested = refusal(() => assertSealedRefAllowedForOwner({ algorithm: 'chipotle:attested:v1' }, SELLER))
    expect(attested.message).toMatch(/can decrypt it alone/)
    const local = refusal(() => assertSealedRefAllowedForOwner({ algorithm: 'aes-256-gcm+envelope' }, SELLER))
    expect(local.message).toMatch(/has not passed the custody review/)
    const loose = refusal(() => assertSealedRefAllowedForOwner(escrowRef({ cid: ATTESTED_V1.cid }), SELLER))
    expect(loose.backend).toBe(CHIPOTLE_ESCROW_ALGORITHM)
  })

  it('a manifest that does not parse names no seller and is still refused', () => {
    const err = refusal(() => assertSealedRefAllowedForOwner(escrowRef({ manifest: '{"v":1}' }), SELLER))
    expect(err).toBeInstanceOf(CustodialVaultRefusedError)
  })

  it('keeps the operator carve-out', () => {
    expect(() => assertSealedRefAllowedForOwner(escrowRef(), OPERATOR)).not.toThrow()
  })
})
