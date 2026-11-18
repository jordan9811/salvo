/**
 * Canonical JSON, the one text both sides of the Lit vault hash and sign.
 *
 * The vault template (templates/attested-v1.ts) has its own `canonical()`, and
 * the two must agree to the byte: the manifest is AES-GCM additional data and
 * the attestation is signed text, so a single differing character means a card
 * that never opens. tests/lit-canonical.test.ts runs the template's copy beside
 * this one to prove they agree.
 *
 * The rules are deliberately narrow, because every value we put through this is
 * small and ours: sorted keys of `[A-Za-z0-9_]{1,64}`, safe integers only (no
 * floats, so no float formatting to disagree about), no `undefined`, plain
 * objects only. Anything else throws rather than guessing.
 */

const KEY_RE = /^[A-Za-z0-9_]{1,64}$/

function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

export function canonicalJson(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TypeError('canonical JSON allows safe integers only')
    return String(v)
  }
  if (Array.isArray(v)) return '[' + v.map((x: unknown) => canonicalJson(x)).join(',') + ']'
  if (typeof v === 'object') {
    // Stricter than the template, on purpose: a Date or a class instance would
    // serialise as "{}" there. Refusing it here means we never seal one.
    if (!isPlainObject(v)) throw new TypeError('canonical JSON allows plain objects only')
    const o = v as Record<string, unknown>
    const out: string[] = []
    for (const k of Object.keys(o).sort()) {
      if (!KEY_RE.test(k) || o[k] === undefined) {
        throw new TypeError('canonical JSON keys must match [A-Za-z0-9_]{1,64} and hold a value')
      }
      out.push(JSON.stringify(k) + ':' + canonicalJson(o[k]))
    }
    return '{' + out.join(',') + '}'
  }
  throw new TypeError(`canonical JSON cannot hold a ${typeof v}`)
}

/**
 * Parse `text` only if it is already canonical, is an object, and has exactly
 * `keyCount` keys. Mirrors the template's `parseCanonical`: anything that would
 * re-serialise differently is refused, so two readers can never disagree about
 * what a signed or sealed text says.
 */
export function parseCanonicalJson(
  text: string,
  keyCount: number,
  maxLen: number,
): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > maxLen) return null
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    if (Object.keys(value).length !== keyCount || canonicalJson(value) !== text) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}
