/**
 * The `lit` block of an escrow listing's sealed ref: what the listings route
 * stores next to the envelope (spec section 12, corrected here).
 *
 * NOT a LitSealRecord (src/lib/vault/lit/ref.ts). Spec section 12 says an
 * escrow ref reuses that record, "the existing 7-key LitSealRecord", so that
 * parseSecretRef needs no change. Since the Lit V3 rebuild that record has 8
 * keys: it requires `sealSignature`, our attestor's signature over the seal,
 * and refuses any record without one. An escrow card is sealed in the seller's
 * browser, so there is no attestor signature, and there must never be one: our
 * server signs nothing that opens a card (spec invariant 7). So escrow refs get
 * this record and this parser. Phase 3 has to branch on the ref's algorithm
 * (`chipotle:escrow:v1`) before parseSecretRef (src/lib/intent/service.ts)
 * reads the block, or every escrow listing fails to read back.
 * tests/escrow-guard.test.ts pins that the attested parser refuses this record.
 *
 * Read back from the database or a request body, so untrusted. This checks the
 * shape only. Whoever reads it checks the template, sha256, CID and manifest
 * against the pins (the guard now, the listings route in Phase 3).
 *
 * Isomorphic: no Node imports.
 */

export interface EscrowSealRecord {
  v: 1
  /** The Lit API host the seal belongs to, e.g. api.chipotle.litprotocol.com. */
  network: string
  /** Template id: salvo-vault-escrow/1 for a sellable listing. */
  template: string
  templateSha256: string
  /** IPFS CID of the template bytes. Lit derives the key from this. */
  cid: string
  /** The template's public encryption key the seller's browser sealed to. */
  encPub: string
  /** The 13-key canonical manifest: the AES-GCM additional data. */
  manifest: string
}

const KEYS = ['cid', 'encPub', 'manifest', 'network', 'template', 'templateSha256', 'v'] as const

/**
 * The record, if `value` has exactly its seven keys and each is well formed.
 * Anything else is null: a wrong shape, an extra key, and a `sealSignature`
 * above all, since no escrow seal has one.
 */
export function parseEscrowSealRecord(value: unknown): EscrowSealRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  const keys = Object.keys(o).sort()
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i])) return null

  const { v, network, template, templateSha256, cid, encPub, manifest } = o
  if (v !== 1) return null
  if (typeof network !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(network)) return null
  if (typeof template !== 'string' || template.length === 0 || template.length > 64) return null
  if (typeof templateSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(templateSha256)) return null
  if (typeof cid !== 'string' || !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) return null
  if (typeof encPub !== 'string' || !/^0x0[23][0-9a-f]{64}$/.test(encPub)) return null
  if (typeof manifest !== 'string' || manifest.length === 0 || manifest.length > 2048) return null
  return { v: 1, network, template, templateSha256, cid, encPub, manifest }
}
