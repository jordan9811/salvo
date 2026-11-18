/**
 * The released Lit vault templates, with their pins.
 *
 * A template's bytes ARE its key: Lit derives the action key from the IPFS CID
 * of the exact source, so the sha256 and CID below are not metadata, they are
 * the identity of every card sealed under the template. They are recomputed
 * from the source at load and compared, so an edit (a reformat, a CRLF
 * checkout, a well-meant typo fix) fails loudly here instead of producing cards
 * that never open.
 *
 * Changing a template means adding a new one beside it with a new id. The old
 * one stays, byte for byte, for as long as any card is sealed under it.
 */

import { createHash } from 'node:crypto'
import { litActionCid } from './cid'
import { ESCROW_V1_PINS, ESCROW_V2_PINS } from './escrow-pins'
import { LitTemplateDriftError } from './errors'
import { ATTESTED_V1_SOURCE } from './templates/attested-v1'
import { ESCROW_V1_SOURCE } from './templates/escrow-v1'
import { ESCROW_V2_SOURCE } from './templates/escrow-v2'

export interface VaultTemplate {
  id: 'salvo-vault-attested/1'
  verifier: 'attested'
  /** What the template's unlock rule trusts. Attested means our own signature. */
  custody: 'custodial'
  source: string
  /** Pinned. Recomputed at load; a mismatch throws LitTemplateDriftError. */
  sha256: string
  cid: string
  /** Pinned after the live smoke prints them. null until then. */
  encPub: `0x0${'2' | '3'}${string}` | null
  identity: `0x${string}` | null
}

export const ATTESTED_V1: VaultTemplate = Object.freeze({
  id: 'salvo-vault-attested/1',
  verifier: 'attested',
  custody: 'custodial',
  source: ATTESTED_V1_SOURCE,
  sha256: '73f3dc106f95d78460d4d9639429183e58581206dcdab1f18418e321a971206b',
  cid: 'QmSJfHqFFQkbSxBkgcpJUsKGsY2r9cQ1p5DqPLpUXC6cv9',
  // From the live smoke on Lit, 2026-10-10 (server v1.1.16).
  encPub: '0x03823ffc7e35a7735d99e66419f553c8aa8515b9d5a930358eb093b4363986322d',
  identity: '0xe4002af0f6d5e360a36cadc93100b0ea063a6f3d',
})

export const VAULT_TEMPLATES: Readonly<Record<string, VaultTemplate>> = Object.freeze({
  [ATTESTED_V1.id]: ATTESTED_V1,
})

/**
 * The escrow template: it opens a card only for a final on-chain purchase.
 *
 * A separate shape, not a VaultTemplate, and deliberately not in
 * VAULT_TEMPLATES: it has no `open` op, so ChipotleVault must never pick it
 * for a ref. It carries no custody label either. Whether it counts as
 * non-custodial is the guard's call, made only after review (spec section 11).
 */
/** /1 opens a card for one whole purchase on SalvoEscrowV1; /2 for each part sold on SalvoEscrowV2. */
export type EscrowTemplateId = 'salvo-vault-escrow/1' | 'salvo-vault-escrow/2'

/**
 * `EscrowTemplate` alone is V1's, as every live V1 reader expects;
 * `EscrowTemplate<'salvo-vault-escrow/2'>` is V2's.
 */
export interface EscrowTemplate<Id extends EscrowTemplateId = 'salvo-vault-escrow/1'> {
  id: Id
  source: string
  /** Pinned. Recomputed at load; a mismatch throws LitTemplateDriftError. */
  sha256: string
  cid: string
  /** Pinned after the live bind prints them. null until then. */
  encPub: `0x0${'2' | '3'}${string}` | null
  identity: `0x${string}` | null
  /**
   * keccak256 of the escrow's runtime code (SalvoEscrowV1's for /1,
   * SalvoEscrowV2's for /2), as written inside the source. Kept here so
   * readers need not parse the template; a test holds the two equal, and
   * equal to the compiled artifact's RUNTIME_KECCAK (or RUNTIME_KECCAK_V2).
   */
  escrowCodehash: `0x${string}`
  /**
   * The one escrow deployment the source trusts, as written inside it
   * (`const ESCROW`), lower-case, byte for byte: the source compares the text.
   * A code hash cannot stand alone: it covers code, not storage, so a copy of
   * the same code can start with any state it likes. It is the escrow
   * deployer's first CREATE address, so it is known before the source is
   * frozen. null while the source still holds the placeholder: that source
   * refuses every manifest. src/lib/escrow/deployment.ts holds the rules.
   *
   * The address alone does not prove clean storage either: the deployer
   * chooses the init code that runs there, and init code can write any
   * storage and then return this exact runtime code. So the address is
   * trusted only together with `escrowCreationTx`, once that transaction is
   * checked to be the plain compiled init code (verifyEscrowCreation).
   */
  escrowAddress: `0x${string}` | null
  /** Whose first CREATE address `escrowAddress` is, lower-case. Pinned with it. */
  escrowDeployer: `0x${string}` | null
  /**
   * The deployer's nonce-0 transaction that created the escrow. Pinned after
   * the deploy, and only once verifyEscrowCreation finds it is a plain create
   * of ESCROW_BYTECODE with (identity, pathUSD) and nothing else.
   */
  escrowCreationTx: `0x${string}` | null
  /** Tempo Moderato. The source refuses every other chain. */
  chainId: 42431
}

/**
 * The address, deployer, creation transaction, identity, sealing key and code
 * hash are pinned in escrow-pins.ts, not here: the seller's page and the
 * shopper's phone hold our server to the same values, and this file cannot
 * be loaded in a browser.
 */
export const ESCROW_V1: EscrowTemplate = Object.freeze({
  id: 'salvo-vault-escrow/1',
  source: ESCROW_V1_SOURCE,
  sha256: 'f60a6ced7649023696d37410d1a1ae94a5ed244a05bf25862c33386e20008be9',
  cid: 'QmPy8rnTSD3DqQmMUwqA57SX3bHb1D2mNqfEpxz8zStDus',
  ...ESCROW_V1_PINS,
  chainId: 42431,
})

/**
 * salvo-vault-escrow/2: the same rule for SalvoEscrowV2, where one card is
 * sold in parts. A ticket binds the listing's value left and sales count, and
 * a readable store's short read comes back signed for confirmRemainder. Its
 * own CID, key and sealing key, so a V1 listing is sealed again to sell here.
 *
 * Pinned on 2026-10-13 by the lead's deploy and bind on the Tempo Moderato
 * testnet (spec section 8.7, the V1 runbook with --version 2). The pin step
 * changed the ESCROW line only, and then the sha256 and CID here; with the
 * placeholder put back the bytes are the unpinned release (tests hold that).
 * Frozen from now on: a change is salvo-vault-escrow/3.
 */
export const ESCROW_V2: EscrowTemplate<'salvo-vault-escrow/2'> = Object.freeze({
  id: 'salvo-vault-escrow/2',
  source: ESCROW_V2_SOURCE,
  sha256: '4ac17c67ac46aeaf958058030ca5ae6f4ac2c657db681823b1efb9c15156f309',
  cid: 'QmUuJw7GMaveNh95Fjym5uhaEXZhY4xpJHDZGo2exQZ3DE',
  ...ESCROW_V2_PINS,
  chainId: 42431,
})

/** What integrity needs from any template, attested or escrow. */
type PinnedSource = Pick<VaultTemplate | EscrowTemplate<EscrowTemplateId>, 'source' | 'sha256' | 'cid'>

/** Keyed by the source text itself, so a changed source is never served a stale answer. */
const integrityCache = new Map<string, { sha256: string; cid: string }>()

export function templateIntegrity(t: PinnedSource): {
  intact: boolean
  sha256: string
  cid: string
} {
  let measured = integrityCache.get(t.source)
  if (!measured) {
    measured = {
      sha256: createHash('sha256').update(t.source, 'utf8').digest('hex'),
      cid: litActionCid(t.source),
    }
    integrityCache.set(t.source, measured)
  }
  return {
    intact: measured.sha256 === t.sha256 && measured.cid === t.cid,
    sha256: measured.sha256,
    cid: measured.cid,
  }
}

export function assertTemplateIntact(t: PinnedSource & Pick<VaultTemplate | EscrowTemplate<EscrowTemplateId>, 'id'>): void {
  if (!templateIntegrity(t).intact) throw new LitTemplateDriftError(t.id)
}
