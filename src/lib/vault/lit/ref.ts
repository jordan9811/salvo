/**
 * The `lit` block of a sealed ref: what a Lit vault seal needs besides the
 * envelope fields every SecretRef already has.
 *
 * It is read back from the database, so it is untrusted. Editing the manifest,
 * the CID or our envelope makes decryption fail inside the template. Replacing
 * the envelope with a NEW one does not: the template's key and the attestor
 * address are public, so anyone who can write this row can seal a card of their
 * choosing under the same manifest, and it would decrypt. `sealSignature` is
 * what catches that. It is our attestor's signature over the manifest and the
 * envelope, made at seal time, and the vault checks it before it signs any open.
 *
 * This parser catches everything else (a wrong shape, an extra or missing key,
 * a version this build does not know) before anything is sent anywhere. A
 * future `v: 2` gets its own branch here rather than loosening this one.
 */

export interface LitSealRecord {
  v: 1
  /** The Lit API host the seal belongs to, e.g. api.chipotle.litprotocol.com. */
  network: string
  /** Template id, e.g. salvo-vault-attested/1. */
  template: string
  templateSha256: string
  /** IPFS CID of the template bytes. Lit derives the key from this. */
  cid: string
  /** The template's public encryption key the card was sealed to. */
  encPub: string
  /** Canonical JSON. The AES-GCM additional data; trusted only once that verifies. */
  manifest: string
  /**
   * Our attestor's EIP-191 signature over the seal receipt (the manifest's and
   * the envelope's hashes). Proves our server made this envelope. Required:
   * no seal without one was ever written.
   */
  sealSignature: `0x${string}`
}

const KEYS = ['cid', 'encPub', 'manifest', 'network', 'sealSignature', 'template', 'templateSha256', 'v'] as const

export function parseLitSealRecord(value: unknown): LitSealRecord {
  const malformed = (): Error => new Error('sealedRef.lit is malformed')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed()
  const o = value as Record<string, unknown>

  const keys = Object.keys(o).sort()
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i])) throw malformed()

  const { v, network, template, templateSha256, cid, encPub, manifest, sealSignature } = o
  if (v !== 1) throw malformed()
  if (typeof network !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(network)) throw malformed()
  if (typeof template !== 'string' || template.length === 0 || template.length > 64) throw malformed()
  if (typeof templateSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(templateSha256)) throw malformed()
  if (typeof cid !== 'string' || !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) throw malformed()
  if (typeof encPub !== 'string' || !/^0x0[23][0-9a-f]{64}$/.test(encPub)) throw malformed()
  if (typeof manifest !== 'string' || manifest.length === 0 || manifest.length > 2048) throw malformed()
  if (typeof sealSignature !== 'string' || !/^0x[0-9a-f]{130}$/.test(sealSignature)) throw malformed()

  return {
    v: 1,
    network,
    template,
    templateSha256,
    cid,
    encPub,
    manifest,
    sealSignature: sealSignature as `0x${string}`,
  }
}
