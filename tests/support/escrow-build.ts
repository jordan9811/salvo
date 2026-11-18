/**
 * The escrow template the purchase tests run, and where they deploy its
 * escrow. Test-only; never referenced from src/.
 *
 * WHY TESTS NEED IT. The template trusts one escrow deployment, by address,
 * because a code hash covers code and not storage. That address is the escrow
 * deployer's first CREATE address (src/lib/escrow/deployment.ts), and every
 * test that buys a card must deploy its escrow exactly there. Two cases:
 *
 *   - PINNED (the lead's pin step has run). The build IS the committed source,
 *     byte for byte, and the test escrow is deployed from the pinned deployer
 *     at its nonce 0. So the shipped bytes stay under test after the pin.
 *     TestChain runs calls from any address without a key, so the real
 *     deployer's address is enough.
 *   - UNPINNED (the committed source still holds the placeholder, which
 *     refuses every manifest). The build is the committed source with only
 *     that one line set, to the first CREATE address of a test deployer. It
 *     differs from the committed bytes in that one line
 *     (tests/lit-escrow-template.test.ts proves it), so it has its own CID
 *     and, under fake Lit, its own key, identity and encPub.
 *
 * A pin in any other state (checksummed, not the deployer's first address,
 * recorded differently from the source) throws: tests must not paper over a
 * pin the template would refuse.
 *
 * Either way the order is the live runbook's (spec section 15): the deployer
 * and its nonce-0 address come first, the template's CID and identity from
 * them, and the deploy's constructor takes that identity. No loop.
 */

import type { Hex } from 'viem'
import { ESCROW_PIN_PLACEHOLDER, escrowCreateAddress, escrowPinProblems } from '@/lib/escrow/deployment'
import { litActionCid } from '@/lib/vault/lit/cid'
import { ESCROW_V1, ESCROW_V2, type EscrowTemplate, type EscrowTemplateId } from '@/lib/vault/lit/templates'
import { testAddress } from './evm'
import { fakeEncPubFor, fakeIdentityFor } from './fake-lit'

/** The deployer an unpinned build pins to. It never sends anything else, so the escrow is its contract at nonce 0. */
export const TEST_ESCROW_DEPLOYER: Hex = testAddress(10)

export interface EscrowBuild {
  id: EscrowTemplateId
  source: string
  cid: string
  /** Fake Lit's sealing key for this build. */
  encPub: string
  /** Fake Lit's identity for this build: the escrow's litSigner. */
  identity: Hex
  /** The address the build pins: where the test must deploy the escrow. */
  escrow: Hex
  /** Deploy the escrow from this address, as its first contract. */
  deployer: Hex
  /** True when the build is the committed source itself (the pin step has run). */
  committed: boolean
}

const builds = new Map<string, EscrowBuild>()

/** `source` with its ESCROW placeholder line set to `escrow`. Throws unless the placeholder is there exactly once. */
export function withEscrowPin(source: string, escrow: Hex): string {
  if (source.split(ESCROW_PIN_PLACEHOLDER).length !== 2) {
    throw new Error('withEscrowPin: the source does not hold the unpinned ESCROW line exactly once')
  }
  return source.replace(ESCROW_PIN_PLACEHOLDER, `const ESCROW = "${escrow}";`)
}

/** The build for `template` (the committed ESCROW_V1 by default; ESCROW_V2 works the same way). See the header for the two cases. */
export function escrowBuild(template: EscrowTemplate<EscrowTemplateId> = ESCROW_V1): EscrowBuild {
  const key = [template.source, template.escrowAddress, template.escrowDeployer].join('|')
  const cached = builds.get(key)
  if (cached) return cached
  const problems = escrowPinProblems(template)
  let source: string
  let escrow: Hex
  let deployer: Hex
  let committed: boolean
  if (problems.length === 0 && template.escrowAddress !== null && template.escrowDeployer !== null) {
    source = template.source
    escrow = template.escrowAddress
    deployer = template.escrowDeployer
    committed = true
  } else if (problems.length === 1 && problems[0] === 'unpinned') {
    deployer = TEST_ESCROW_DEPLOYER
    escrow = escrowCreateAddress(deployer)
    source = withEscrowPin(template.source, escrow)
    committed = false
  } else {
    throw new Error(`escrowBuild: the template's escrow pin is not usable: ${problems.join(', ')}`)
  }
  const pins = { id: template.id, cid: litActionCid(source) }
  const build: EscrowBuild = {
    id: template.id,
    source,
    cid: pins.cid,
    encPub: fakeEncPubFor(pins),
    identity: fakeIdentityFor(pins) as Hex,
    escrow,
    deployer,
    committed,
  }
  builds.set(key, build)
  return build
}

/** The committed template's build: what every purchase test runs. */
export const ESCROW_BUILD: EscrowBuild = escrowBuild()
/** Where ESCROW_BUILD's escrow must be deployed from, as the deployer's first contract. */
export const ESCROW_DEPLOYER: Hex = ESCROW_BUILD.deployer
/** The address ESCROW_BUILD pins: ESCROW_DEPLOYER's nonce-0 CREATE address. */
export const PINNED_ESCROW: Hex = ESCROW_BUILD.escrow

/**
 * The V2 template's build: what every salvo-vault-escrow/2 purchase test runs.
 * The lead pinned V2 live on 2026-10-13, so this is the PINNED case: the
 * committed bytes themselves, deployed in-process from the pinned deployer at
 * its nonce 0. (The unpinned case is held by escrowBuild(unpinnedV2(ESCROW_V2)),
 * tests/support/escrow-v2-unpinned.ts.)
 */
export const ESCROW_V2_BUILD: EscrowBuild = escrowBuild(ESCROW_V2)
