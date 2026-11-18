/**
 * Which escrow a runbook run is about: SalvoEscrowV1 with salvo-vault-escrow/1
 * (live on Moderato since 2026-10-10), or SalvoEscrowV2 with
 * salvo-vault-escrow/2 (spec section 8.7: the V1 runbook with --version 2).
 *
 * Everything that differs between the two runs of the same steps is here, so
 * deploy, check, bind and the scripts read one table instead of comparing
 * template ids in each place:
 *   - the compiled bytecode the creation must carry, and the runtime keccak
 *     the template pins and the chain must return;
 *   - the files and records the lead edits at each pin step, as the scripts
 *     print them;
 *   - the flags the next step takes (`--template escrow-v2` for lit:setup and
 *     lit:smoke, `--version 2` for the escrow scripts).
 *
 * Also the pin step's arithmetic, done offline so the lead copies numbers
 * instead of computing them: the source with its ESCROW line set, and the
 * sha256 and CID of exactly those bytes (pinnedSourceFor).
 *
 * Server and scripts only: it loads both artifacts and node:crypto.
 */

import { createHash } from 'node:crypto'
import type { Hex } from 'viem'
import { litActionCid } from '@/lib/vault/lit/cid'
import { ESCROW_V1, ESCROW_V2, type EscrowTemplate, type EscrowTemplateId } from '@/lib/vault/lit/templates'
import { ESCROW_BYTECODE, RUNTIME_KECCAK } from '../artifact'
import { ESCROW_V2_BYTECODE, RUNTIME_KECCAK_V2 } from '../artifact-v2'
import { ESCROW_PIN_PLACEHOLDER, escrowCreateAddress } from '../deployment'

/** Either released escrow template, V1's or V2's. */
export type AnyEscrowTemplate = EscrowTemplate<EscrowTemplateId>

export type EscrowVersion = 1 | 2

export interface EscrowRelease {
  version: EscrowVersion
  /** The committed template. Tests pass pinned copies of it to the runbook code; the table is read by id. */
  template: AnyEscrowTemplate
  contract: 'SalvoEscrowV1' | 'SalvoEscrowV2'
  /** Init code, as committed: the creation input is this plus abi.encode(litSigner, pathUSD). */
  bytecode: Hex
  /** keccak256 of the runtime code the deploy must leave at the escrow address. */
  runtimeKeccak: Hex
  /** Where the source's `const ESCROW` line lives. */
  templateFile: string
  /** The record in templates.ts whose sha256 and CID change at the pin step. */
  record: 'ESCROW_V1' | 'ESCROW_V2'
  /** The pins in escrow-pins.ts the lead fills in at steps 3, 7 and 8. */
  pinsRecord: 'ESCROW_V1_PINS' | 'ESCROW_V2_PINS'
  /** `pnpm lit:setup` and `pnpm lit:smoke` take this as --template. */
  litTemplate: 'escrow' | 'escrow-v2'
  /** What the escrow scripts take to run this version: nothing for V1, ` --version 2` for V2. */
  versionFlag: '' | ' --version 2'
}

const V1: EscrowRelease = Object.freeze({
  version: 1,
  template: ESCROW_V1,
  contract: 'SalvoEscrowV1',
  bytecode: ESCROW_BYTECODE,
  runtimeKeccak: RUNTIME_KECCAK,
  templateFile: 'src/lib/vault/lit/templates/escrow-v1.ts',
  record: 'ESCROW_V1',
  pinsRecord: 'ESCROW_V1_PINS',
  litTemplate: 'escrow',
  versionFlag: '',
})

const V2: EscrowRelease = Object.freeze({
  version: 2,
  template: ESCROW_V2,
  contract: 'SalvoEscrowV2',
  bytecode: ESCROW_V2_BYTECODE,
  runtimeKeccak: RUNTIME_KECCAK_V2,
  templateFile: 'src/lib/vault/lit/templates/escrow-v2.ts',
  record: 'ESCROW_V2',
  pinsRecord: 'ESCROW_V2_PINS',
  litTemplate: 'escrow-v2',
  versionFlag: ' --version 2',
})

export function escrowRelease(version: EscrowVersion): EscrowRelease {
  return version === 2 ? V2 : V1
}

/** The release a template belongs to, by its id. A pinned copy of a template is still that template's release. */
export function releaseOf(t: Pick<AnyEscrowTemplate, 'id'>): EscrowRelease {
  return t.id === 'salvo-vault-escrow/2' ? V2 : V1
}

/**
 * The escrow scripts' `--version`: absent is 1, so every V1 command in the
 * runbook stays as it was. Null for anything but 1 or 2.
 */
export function escrowVersionFromFlag(value: string | undefined): EscrowVersion | null {
  if (value === undefined || value === '1') return 1
  if (value === '2') return 2
  return null
}

/** `pnpm lit:setup` and `pnpm lit:smoke`'s `--template` for an escrow template, or null when the name is not one. */
export function escrowReleaseForTemplateName(name: string): EscrowRelease | null {
  if (name === V1.litTemplate) return V1
  if (name === V2.litTemplate) return V2
  return null
}

/** The id of the template that would replace this one: what a bind that fails inside Lit's runtime asks for. */
export function nextTemplateId(t: Pick<AnyEscrowTemplate, 'id'>): string {
  return `salvo-vault-escrow/${releaseOf(t).version + 1}`
}

/**
 * The pin step, done offline for `--print-address`: the deployer's nonce-0
 * CREATE address written into the template's ESCROW line, and the sha256 and
 * CID of exactly the bytes that result, which the lead copies into the
 * template's record. Null when the source no longer holds the placeholder
 * exactly once (already pinned, or edited): there is nothing to compute then.
 */
export function pinnedSourceFor(t: Pick<AnyEscrowTemplate, 'source'>, deployer: Hex): { escrow: Hex; sha256: string; cid: string } | null {
  if (t.source.split(ESCROW_PIN_PLACEHOLDER).length !== 2) return null
  const escrow = escrowCreateAddress(deployer.toLowerCase() as Hex)
  const source = t.source.replace(ESCROW_PIN_PLACEHOLDER, `const ESCROW = "${escrow}";`)
  return { escrow, sha256: createHash('sha256').update(source, 'utf8').digest('hex'), cid: litActionCid(source) }
}
