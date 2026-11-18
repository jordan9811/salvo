/**
 * The pure half of `pnpm lit:setup` and `pnpm lit:smoke`: the exact request
 * bodies, the rule for where a usage key may be written and where the account
 * key may be read from, the spend arithmetic, how to read Lit's version and a
 * lost write, and how the smoke waits for bind and reads the enclave clock.
 * Kept apart from the scripts so tests can pin them without a network, and so
 * the scripts stay a thin sequence of calls.
 *
 * WHAT THE RUNTIME KEY MAY DO. Exactly one thing: execute actions in the vault
 * group. It cannot create or delete groups, mint PKPs, or add or remove actions
 * or PKPs anywhere. It is a billing credential, not an authority: anyone who
 * steals it can run our template, and the template still refuses them unless
 * our attestor signed. Group id 0 is Lit's wildcard for "every group", so it is
 * refused here rather than ever sent.
 *
 * WHERE THE KEY MAY GO. Lit shows a new usage key once. It goes to a file the
 * lead names, never to stdout and never to .env. The file may not be inside the
 * repo (one `git add .` from a commit), may not look like an env file, may not
 * be under OneDrive (the repo lives there, and the file would sync to the
 * cloud), and may not already exist (a rerun must not overwrite a key that is
 * still in use). The account key gets the stricter version of the same rule:
 * it is read from the shell only, never from the repo .env.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { keccak256, toBytes } from 'viem'
import { ChipotleRequestError } from './errors'

export const VAULT_GROUP_NAME = 'salvo-vault-v1'
export const RUNTIME_KEY_NAME = 'salvo-vault-runtime'
/** Setup refuses to spend with less credit than this. Lit reports credit as a negative balance. */
export const MIN_CREDIT_CENTS = 25
/** Lit bills each management write at one cent. Reads and failed calls are free. */
export const WRITE_COST_CENTS = 1

/**
 * Known CIDs for known bytes, checked offline by the smoke before it trusts the
 * local CID enough to spend on it. Only vectors that came from go-ipfs
 * (`ipfs add --only-hash`): a CID our own code computed proves nothing about
 * our own code.
 */
export const CID_VECTORS: ReadonlyArray<{ source: string; cid: string; from: 'go-ipfs' }> = [
  { source: '', cid: 'QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH', from: 'go-ipfs' },
  { source: 'hello world\n', cid: 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o', from: 'go-ipfs' },
]

/**
 * The source Lit's docs use for `get_lit_action_ipfs_id`. The docs show the
 * call, not its answer, so this CID was computed here and is not a vector.
 * `pnpm lit:setup --check` asks Lit for it (free) and prints whether Lit
 * agrees. Not yet run live.
 */
export const LIT_DOCS_EXAMPLE = {
  source: 'async function main(){ return 1 }',
  cid: 'QmNvjVqV9HnPhHtqDmj6X4dYShnYk1SyW9C6ZGhd8M7qYE',
} as const

/** What `GET /version` may print. Anything else is reported as unknown, not echoed. */
const VERSION_RE = /^[A-Za-z0-9._+-]{1,40}$/

export interface VaultGroupRequest {
  group_name: string
  group_description: string
  pkp_ids_permitted: string[]
  cid_hashes_permitted: string[]
}

export interface UsageKeyRequest {
  name: string
  description: string
  can_create_groups: false
  can_delete_groups: false
  can_create_pkps: false
  manage_ipfs_ids_in_groups: number[]
  add_pkp_to_groups: number[]
  remove_pkp_from_groups: number[]
  execute_in_groups: number[]
}

/** The `add_group` body. No PKPs, and the template is added by its own call. */
export function vaultGroupRequest(): VaultGroupRequest {
  return {
    group_name: VAULT_GROUP_NAME,
    group_description: 'Salvo card vault templates. Must never contain PKPs.',
    pkp_ids_permitted: [],
    cid_hashes_permitted: [],
  }
}

/** The `add_usage_api_key` body: execute in this one group, nothing else. */
export function usageKeyRequest(groupId: number): UsageKeyRequest {
  // 0 means "all groups" to Lit. A runtime key must name exactly one.
  if (!Number.isSafeInteger(groupId) || groupId < 1) {
    throw new RangeError('usage key group id must be a positive integer (0 is Lit\'s wildcard)')
  }
  return {
    name: RUNTIME_KEY_NAME,
    description: `Salvo server: execute vault templates in group ${groupId} only`,
    can_create_groups: false,
    can_delete_groups: false,
    can_create_pkps: false,
    manage_ipfs_ids_in_groups: [],
    add_pkp_to_groups: [],
    remove_pkp_from_groups: [],
    execute_in_groups: [groupId],
  }
}

/**
 * Where an existing `list_api_keys` item differs from execute-only on
 * `[groupId]`. Field names only, never a value Lit did not already show.
 */
export function runtimeKeyDrift(item: unknown, groupId: number): string[] {
  if (typeof item !== 'object' || item === null) return ['not an API key item']
  const k = item as Record<string, unknown>
  const drift: string[] = []
  for (const flag of ['can_create_groups', 'can_delete_groups', 'can_create_pkps']) {
    if (k[flag] !== false) drift.push(`${flag} is not false`)
  }
  for (const list of ['can_manage_ipfs_ids_in_groups', 'can_add_pkp_to_groups', 'can_remove_pkp_from_groups']) {
    const v = k[list]
    if (!Array.isArray(v) || v.length !== 0) drift.push(`${list} is not empty`)
  }
  const exec = k['can_execute_in_groups']
  if (!Array.isArray(exec) || exec.length !== 1 || Number(exec[0]) !== groupId) {
    drift.push(`can_execute_in_groups is not exactly [${groupId}]`)
  }
  return drift
}

export type UsageKeyListing =
  /** The key sees only its own entry, and that entry is execute-only on one group. */
  | { executeOnly: true; groupId: number }
  /** It sees other keys, or holds a permission beyond executing. Field names and counts only. */
  | { executeOnly: false; problems: string[] }

/**
 * What a `list_api_keys` answer made WITH THE RUNTIME KEY says about that key.
 * lit:smoke asks before it spends anything.
 *
 * A 200 alone is not a warning. Lit lets an execute-only usage key list keys,
 * and it then sees one entry, its own (measured live on v1.1.16, 2026-10-10:
 * `salvo-vault-runtime` with can_execute_in_groups [1] and every other
 * permission false or empty). So the key passes only when the listing is
 * exactly one entry, named RUNTIME_KEY_NAME, executing in exactly one group
 * that is not 0 (Lit's wildcard), and every other `can_` field is false or
 * empty. More than one entry means it can see other keys: the account key or
 * an over-scoped one.
 *
 * The group cannot be checked against the vault group here: the key file
 * holds only the key. The smoke's bind settles it, since an action runs only
 * where the group holds its CID.
 *
 * What this cannot tell apart: the account key, on an account whose only
 * usage key is the runtime key, lists that one entry too. ChipotleVault
 * refuses a usage key equal to an account key set in env, and the account key
 * belongs in the shell for setup only, never in a key file.
 */
export function usageKeyListing(json: unknown): UsageKeyListing {
  if (!Array.isArray(json)) return { executeOnly: false, problems: ['Lit did not answer with a list'] }
  if (json.length !== 1) {
    return {
      executeOnly: false,
      problems: [json.length === 0 ? 'it lists no key, not even its own' : `it can see ${json.length} keys, not only its own`],
    }
  }
  const item: unknown = json[0]
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return { executeOnly: false, problems: ['not an API key item'] }
  }
  const k = item as Record<string, unknown>
  const problems: string[] = []
  if (k['name'] !== RUNTIME_KEY_NAME) problems.push(`the one key it sees is not named ${RUNTIME_KEY_NAME}`)
  const exec = k['can_execute_in_groups']
  const groupId = Array.isArray(exec) && exec.length === 1 ? litGroupIdOf(exec[0]) : null
  if (groupId === null) {
    problems.push('can_execute_in_groups is not exactly one group (0 is every group)')
  } else {
    problems.push(...runtimeKeyDrift(k, groupId))
  }
  // Any permission Lit adds later counts too: only executing is allowed.
  for (const [field, v] of Object.entries(k)) {
    if (!field.startsWith('can_') || field === 'can_execute_in_groups') continue
    const none = v === false || (Array.isArray(v) && v.length === 0)
    const reported = problems.some((p) => p.startsWith(`${field} `))
    if (!none && !reported) problems.push(`${field} is not false or empty`)
  }
  return problems.length === 0 && groupId !== null ? { executeOnly: true, groupId } : { executeOnly: false, problems }
}

/**
 * The id `list_actions` reports for a CID: keccak256 of the CID's UTF-8 text,
 * as lowercase hex without 0x. Lit's docs imply this ("hashed CID ... you get
 * back from list_actions") without stating it; setup prints what it saw if no
 * id matches.
 */
export function litActionIdForCid(cid: string): string {
  return keccak256(toBytes(cid)).slice(2).toLowerCase()
}

/** Compare an id from Lit with ours, ignoring case and a 0x prefix. */
export function sameActionId(fromLit: string, ours: string): boolean {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/^0x/, '')
  return norm(fromLit) === norm(ours)
}

/** Throws unless `path` is a safe place to write a usage key for the first time. */
export function assertSafeKeyOutPath(path: string, repoRoot: string): void {
  if (path.trim() === '') throw new Error('--key-out needs a file path')
  const abs = resolve(path)
  const rel = relative(resolve(repoRoot), abs)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error('refusing to write the usage key inside the repo; pick a path outside it')
  }
  if (basename(abs).toLowerCase().startsWith('.env')) {
    throw new Error('refusing to write the usage key to a .env file; it goes in a file of its own')
  }
  if (/onedrive/i.test(abs)) {
    throw new Error('refusing to write the usage key under OneDrive; it would sync to the cloud')
  }
  if (existsSync(abs)) {
    throw new Error('refusing to overwrite an existing file; a key in use there would be lost')
  }
}

/**
 * A Lit group id, as a positive safe integer, or null.
 *
 * Lit writes the same id two ways: add_group answers `group_id: "1"`, and
 * list_groups answers `id: "0x000...0001"`, a 32-byte hex word (measured live
 * on v1.1.16, 2026-10-10). Both name group 1. Anything else, or an id too big
 * to be a safe integer, is null, and the caller stops before any write.
 */
export function litGroupIdOf(raw: unknown): number | null {
  let n: bigint | null = null
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) n = BigInt(raw)
  else if (typeof raw === 'string' && /^[0-9]{1,15}$/.test(raw)) n = BigInt(raw)
  else if (typeof raw === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(raw)) n = BigInt(raw)
  if (n === null || n < 1n || n > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(n)
}

/** A short, one-way name for a key, so output can say which key without showing it. */
export function keyFingerprint(key: string): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8)}`
}

/** Cents spent between two balance readings. Credit is negative, so spend raises it. */
export function spentCents(beforeCents: number, afterCents: number): number {
  return afterCents - beforeCents
}

/**
 * Lit's release number from a `GET /version` reply. That reply carries two
 * versions: `version` is the server crate's ("0.1.0", the OpenAPI version)
 * and `commit_version` is the release ("v1.1.15"). The release is the one
 * that says when error bodies become JSON only (v1.2), so it is the one the
 * docs record. `version` is used only if `commit_version` is missing.
 */
export function litServerVersion(json: unknown): string {
  if (typeof json !== 'object' || json === null) return 'unknown'
  const v = json as Record<string, unknown>
  for (const field of ['commit_version', 'version']) {
    const value = v[field]
    if (typeof value === 'string' && VERSION_RE.test(value)) return value
  }
  return 'unknown'
}

/**
 * True when a failed write may still have happened on Lit. A management write
 * is committed on chain, so a lost answer (timeout, dropped connection, a
 * gateway or server error, or a 2xx we could not read) says nothing about
 * whether it finished. That includes 503. Lit's "Nothing was charged" holds
 * for every failed call, done or not, and Lit reports a chain RPC outage as a
 * 503, which can come after the write was sent. A 429 is load shed before the
 * work starts.
 */
export function writeOutcomeUnknown(err: unknown): boolean {
  if (!(err instanceof ChipotleRequestError)) return false
  if (err.kind === 'timeout' || err.kind === 'network' || err.kind === 'bad_response') return true
  return err.kind === 'server'
}

// ---------------------------------------------------------------------------
// The account key
// ---------------------------------------------------------------------------

/** Where the Lit account key may be set, preferred first. The second is legacy. */
const ACCOUNT_KEY_NAMES = ['LIT_CHIPOTLE_ACCOUNT_KEY', 'LIT_CHIPOTLE_API_KEY'] as const
type AccountKeyName = (typeof ACCOUNT_KEY_NAMES)[number]

export interface AccountKeyChoice {
  /** The key, or null when the shell sets neither name. Never printed. */
  key: string | null
  from: AccountKeyName | null
  /** Ready to print. Names only, never a value. */
  warnings: string[]
}

/**
 * The Lit account key, from the shell only.
 *
 * `shell` is the environment as the script started, before the repo .env was
 * loaded; `loaded` is after. A name set only in `loaded` came from the .env
 * file. That file is inside the repo, and the repo is in OneDrive, which syncs
 * it to the cloud. The account key can delete groups, mint keys and spend
 * credit, and Lit says it cannot be rotated. The usage key, which can do far
 * less, is already kept out of OneDrive (assertSafeKeyOutPath), so this key
 * is never taken from there either. A copy found there is flagged, not used.
 */
export function accountKeyFromShell(
  shell: Readonly<Record<string, string | undefined>>,
  loaded: Readonly<Record<string, string | undefined>>,
  dotEnvPath: string,
  /**
   * Names the .env file itself sets to a non-empty value (dotEnvNamesSet).
   * loadDotEnv never overwrites a name the shell already set, so when the
   * shell and the file both set one, `loaded` cannot show the file's copy.
   * Reading the file's names closes that gap; values are never read here.
   */
  fileNames: ReadonlySet<string> = new Set(),
): AccountKeyChoice {
  const value = (env: Readonly<Record<string, string | undefined>>, name: string): string =>
    (env[name] ?? '').trim()
  const where = /onedrive/i.test(dotEnvPath) ? 'the repo .env, which OneDrive syncs to the cloud' : 'the repo .env'

  const warnings: string[] = []
  for (const name of ACCOUNT_KEY_NAMES) {
    if (fileNames.has(name) || (value(shell, name) === '' && value(loaded, name) !== '')) {
      warnings.push(
        `WARNING: ${name} is set in ${where}. It is not read from there. ` +
          'Delete it from that file, and set the account key in your shell for this run only.',
      )
    }
  }

  const from = ACCOUNT_KEY_NAMES.find((name) => value(shell, name) !== '') ?? null
  if (from === 'LIT_CHIPOTLE_API_KEY') {
    warnings.push(
      'WARNING: using LIT_CHIPOTLE_API_KEY as the account key; move it to LIT_CHIPOTLE_ACCOUNT_KEY and out of Railway',
    )
  }
  return { key: from === null ? null : value(shell, from), from, warnings }
}

/**
 * The names a .env file sets to a non-empty value, parsed the way loadDotEnv
 * reads it. Only names leave this function, so a caller can say "the account
 * key is still in that file" without ever holding the value.
 */
export function dotEnvNamesSet(text: string): Set<string> {
  const names = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const raw = trimmed.slice(eq + 1).trim()
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")) ? raw.slice(1, -1) : raw
    if (unquoted.trim() !== '') names.add(trimmed.slice(0, eq).trim())
  }
  return names
}

// ---------------------------------------------------------------------------
// The smoke's bind run
// ---------------------------------------------------------------------------

export interface PolledAnswer<T> {
  value: T
  /** Free 403s before the answer. */
  polls: number
  /** The whole wait, polls and backoff included. */
  totalMs: number
  /** When the attempt that answered was sent, and when its answer came back. */
  sentAt: number
  answeredAt: number
}

/**
 * Run `attempt` until a fresh grant has reached Lit, backing off 500 ms x 1.5^n
 * inside `budgetMs`. Lit's docs say only that the first call after a new usage
 * key "can fail for a beat"; they do not name the status. A key that has not
 * reached the server answering looks like an unknown key (401), a grant not yet
 * visible looks like 403, and Lit asks callers to retry network errors and 5xx.
 * All of those are free and are polled. A timeout is not, because a run that
 * timed out may have been billed, and every other failure is a real answer.
 * Anything still failing once the budget is spent is thrown as it came.
 *
 * Only the attempt that answered is timed for `sentAt` and `answeredAt`. The
 * enclave stamps its clock during that run, so the polls before it are not
 * part of the round trip a clock reading is measured against.
 */
const POLL_KINDS: ReadonlySet<string> = new Set(['forbidden', 'auth', 'server', 'network'])

export async function pollWhileForbidden<T>(
  attempt: () => Promise<T>,
  opts: { budgetMs: number; sleep: (ms: number) => Promise<void>; now?: () => number },
): Promise<PolledAnswer<T>> {
  const now = opts.now ?? Date.now
  const started = now()
  let wait = 500
  let polls = 0
  for (;;) {
    const sentAt = now()
    try {
      const value = await attempt()
      const answeredAt = now()
      return { value, polls, totalMs: answeredAt - started, sentAt, answeredAt }
    } catch (err) {
      const propagating = err instanceof ChipotleRequestError && POLL_KINDS.has(err.kind)
      if (!propagating || now() - started + wait > opts.budgetMs) throw err
      polls++
      await opts.sleep(wait)
      wait = Math.round(wait * 1.5)
    }
  }
}

/** The enclave's clock minus ours, against the middle of the run that read it. */
export function clockSkewMs(enclaveNow: number, sentAt: number, answeredAt: number): number {
  return Math.round(enclaveNow - (sentAt + answeredAt) / 2)
}

/**
 * Why `bind` said no, in words that point at the right fix. The template
 * answers `access_denied` only when the CID it was given is not the one Lit
 * derived its key from. `open_failed` means bind threw inside Lit's runtime,
 * which is the question bind exists to settle: an ethers v5 or Lit.Actions API
 * the template uses is missing there.
 */
export function bindRefusal(error: string): string {
  if (error === 'access_denied') {
    return "bind refused (access_denied): the CID Lit derived this code's key from is not ours"
  }
  if (error === 'open_failed') {
    return (
      "bind failed inside Lit (open_failed): the template threw in Lit's runtime. The CID check passed, " +
      'so this is most likely an ethers v5 or Lit.Actions API the runtime does not have. ' +
      'Release salvo-vault-attested/2 with pinned dependencies before anything real is sealed.'
    )
  }
  return `bind answered ${error}, which the template never sends`
}
