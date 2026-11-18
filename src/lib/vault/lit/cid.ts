/**
 * The IPFS CID Lit derives a Lit Action's key from, computed locally.
 *
 * Lit keys a vault template by the CIDv0 of its exact bytes. Computing it here
 * means a template edit is caught at load (templates.ts) and before any paid
 * call (pnpm lit:setup compares it with Lit's own answer for free), instead of
 * surfacing as cards that silently stop opening.
 *
 * Only the single-chunk case is implemented: a UnixFS file node inside a dag-pb
 * node with no links. That is what IPFS produces for anything under its 256 KiB
 * chunk size, and no template comes near that. Larger input throws rather than
 * returning a CID that would not match.
 */

import { createHash } from 'node:crypto'

/** go-ipfs default chunk size. At or above it the file becomes multi-block. */
const MAX_SINGLE_CHUNK = 262_144

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return out
}

function base58btc(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) {
    out = BASE58.charAt(Number(n % 58n)) + out
    n /= 58n
  }
  return '1'.repeat(zeros) + out
}

export function litActionCid(source: string): string {
  const data = Buffer.from(source, 'utf8')
  if (data.length >= MAX_SINGLE_CHUNK) {
    throw new RangeError(
      `litActionCid handles single-chunk sources only (under ${MAX_SINGLE_CHUNK} bytes)`,
    )
  }

  // UnixFS Data: Type = File (field 1), Data (field 2, omitted when empty),
  // filesize (field 3).
  const unixfs = Buffer.from([
    0x08,
    0x02,
    ...(data.length > 0 ? [0x12, ...varint(data.length)] : []),
    ...(data.length > 0 ? data : []),
    0x18,
    ...varint(data.length),
  ])
  // dag-pb PBNode with only Data (field 1) and no links.
  const node = Buffer.concat([Buffer.from([0x0a, ...varint(unixfs.length)]), unixfs])

  const digest = createHash('sha256').update(node).digest()
  // Multihash: sha2-256 (0x12), 32 bytes (0x20).
  return base58btc(Buffer.concat([Buffer.from([0x12, 0x20]), digest]))
}
