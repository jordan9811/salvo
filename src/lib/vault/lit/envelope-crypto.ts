/**
 * Our server's half of the Lit vault cryptography, in Node crypto only.
 *
 * SEAL (no Lit call): ECDH between a fresh ephemeral key and the template's
 * public encryption key (`encPub`), HKDF-SHA256 to an AES-256-GCM key, and the
 * manifest as the GCM additional data. The manifest's hash is also in the HKDF
 * info, so a manifest we did not seal cannot even derive the key, let alone pass
 * the tag check. Only the template, inside Lit, holds the private half of
 * `encPub`, so only a run of the template can redo the ECDH.
 *
 * Sealing uses only public values, so a sealed envelope proves nothing about
 * who made it. ChipotleVault adds that: its attestor signs a seal receipt.
 *
 * REPLY: the template never returns a card in clear. It encrypts it to a
 * one-time key we generate per open and name in the signed attestation, so
 * Lit's response and logs only ever hold ciphertext. `createReplyKey` is that
 * one-time key; it lives in this process for one call and is never stored.
 *
 * Every label, salt and byte order here mirrors templates/attested-v1.ts. They
 * are not tunable: a change on either side is a card that never opens.
 */

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
import { canonicalJson } from './canonical'

/** b64 ciphertext, 0x02/03 compressed ephemeral key, b64 12-byte IV, b64 16-byte tag. */
export interface LitEnvelope {
  ct: string
  eph: string
  iv: string
  tag: string
}

const PUB_RE = /^0x0[23][0-9a-f]{64}$/
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const SEAL_INFO = 'salvo/vault/seal/v1|'
const REPLY_INFO = 'salvo/vault/reply/v1|'
/** The template refuses ciphertext outside 1..512 bytes. */
const MAX_PLAINTEXT_BYTES = 512
const TAG_BYTES = 16

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** RFC 5869 HKDF-SHA256, 32 bytes: the template's `hkdf32`. */
function hkdf32(ikm: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), 32))
}

function pointBytes(pub: string): Buffer {
  if (!PUB_RE.test(pub)) throw new RangeError('expected a compressed secp256k1 public key')
  return Buffer.from(pub.slice(2), 'hex')
}

export function sealToTemplate(encPub: string, plaintext: Buffer, manifestText: string): LitEnvelope {
  if (plaintext.length < 1 || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new RangeError('card secret exceeds the Lit vault template limits')
  }
  const ecdh = createECDH('secp256k1')
  ecdh.generateKeys()
  const eph = ecdh.getPublicKey(null, 'compressed')

  let shared: Buffer | null = null
  let key: Buffer | null = null
  try {
    shared = ecdh.computeSecret(pointBytes(encPub))
    key = hkdf32(shared, eph, SEAL_INFO + sha256Hex(manifestText))
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(manifestText, 'utf8'))
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return {
      ct: ct.toString('base64'),
      eph: `0x${eph.toString('hex')}`,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }
  } finally {
    shared?.fill(0)
    key?.fill(0)
  }
}

/** sha256 hex of the envelope's canonical JSON: what an attestation binds to. */
export function envelopeSha256(e: LitEnvelope): string {
  return sha256Hex(canonicalJson({ ct: e.ct, eph: e.eph, iv: e.iv, tag: e.tag }))
}

export function createReplyKey(): {
  publicKey: string
  open(replyB64: string, payloadText: string, encPub: string): Buffer
} {
  const ecdh = createECDH('secp256k1')
  ecdh.generateKeys()
  const pub = ecdh.getPublicKey(null, 'compressed')

  return {
    publicKey: `0x${pub.toString('hex')}`,
    /** Returns the plaintext. The caller zeroes it. */
    open(replyB64: string, payloadText: string, encPub: string): Buffer {
      if (!B64_RE.test(replyB64)) throw new RangeError('reply is not base64')
      const sealed = Buffer.from(replyB64, 'base64')
      if (sealed.length <= TAG_BYTES) throw new RangeError('reply is too short')

      let shared: Buffer | null = null
      let key: Buffer | null = null
      let ivBlock: Buffer | null = null
      try {
        shared = ecdh.computeSecret(pointBytes(encPub))
        // The IV is derived, not random: one attestation names one envelope, so
        // this key and IV never encrypt two different plaintexts.
        const info = REPLY_INFO + sha256Hex(payloadText)
        key = hkdf32(shared, pub, `${info}|key`)
        ivBlock = hkdf32(shared, pub, `${info}|iv`)
        const decipher = createDecipheriv('aes-256-gcm', key, ivBlock.subarray(0, 12))
        decipher.setAAD(Buffer.from(info, 'utf8'))
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
        const out = decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES))
        try {
          decipher.final()
        } catch (err) {
          // Unauthenticated bytes never leave this function.
          out.fill(0)
          throw err
        }
        return out
      } finally {
        shared?.fill(0)
        key?.fill(0)
        ivBlock?.fill(0)
      }
    },
  }
}
