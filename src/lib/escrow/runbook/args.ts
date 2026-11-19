/**
 * Command-line flags for the escrow runbook scripts, read one way for all of
 * them. A value is never echoed back: an unknown positional argument is
 * reported as "(a positional argument)", because a key pasted in the wrong
 * place must not end up on screen.
 */

export interface ArgSpec {
  /** Flags that take no value, e.g. "live". */
  flags: readonly string[]
  /** Flags that take one value, e.g. "key-file". */
  values: readonly string[]
}

export interface ParsedArgs {
  flags: ReadonlySet<string>
  /** A value flag given with no value maps to ''. Callers refuse that. */
  values: ReadonlyMap<string, string>
  /** Names of anything not in the spec. Never a value. */
  unknown: string[]
}

export function parseRunbookArgs(argv: readonly string[], spec: ArgSpec): ParsedArgs {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const unknown: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--') continue
    if (!a.startsWith('--')) {
      unknown.push('(a positional argument)')
      continue
    }
    const eq = a.indexOf('=')
    const name = a.slice(2, eq === -1 ? undefined : eq)
    if (spec.flags.includes(name) && eq === -1) {
      flags.add(name)
      continue
    }
    if (spec.values.includes(name)) {
      if (eq !== -1) {
        values.set(name, a.slice(eq + 1))
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) values.set(name, '')
      else {
        values.set(name, next)
        i++
      }
      continue
    }
    unknown.push(`--${name}`)
  }
  return { flags, values, unknown }
}
