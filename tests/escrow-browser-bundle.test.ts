/**
 * The escrow pages' browser code loads in a browser, and the pages are behind
 * the rail switch.
 *
 * WHY A TEST AND NOT A BUILD. The shopper's phone and the seller's browser
 * run src/lib/escrow/client/, the till (/pay/[store], both rails), /account
 * and /sell. One
 * import of a server module there (the template registry hashes with
 * node:crypto; the database client; the escrow config) breaks the client
 * bundle, and nothing else in the suite would notice. So every module those
 * screens import for its value is walked, transitively, and none may import a
 * Node builtin or reach a server-only file. A type-only import is erased at
 * build and skipped. The positive control proves the walk finds a real one.
 *
 * And the switch: unless ESCROW_RAIL=testnet, /sell offers no Salvo Pay
 * choice, and the account's dollars row says it is not available here.
 */

import { builtinModules } from 'node:module'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const rel = (p: string): string => relative(ROOT, p).split('\\').join('/')

/** Files no browser module may reach: each pulls in Node, the database, or server-only secrets. */
const SERVER_ONLY = [
  'src/lib/db.ts',
  'src/lib/env.ts',
  'src/lib/vault/lit/templates.ts',
  'src/lib/vault/lit/envelope-crypto.ts',
  'src/lib/vault/lit/transport.ts',
  'src/lib/escrow/config.ts',
  'src/lib/escrow/http.ts',
  'src/lib/escrow/listing.ts',
  'src/lib/escrow/quote.ts',
  'src/lib/escrow/lit-escrow.ts',
  'src/lib/escrow/runtime.ts',
  'src/lib/escrow/runbook/smoke.ts',
  'src/lib/barcode/pdf417.ts',
  // The account's server half: its session signs with node:crypto, and the card side reaches the processor.
  'src/lib/account/session.ts',
  'src/lib/hold/account.ts',
]
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
const SERVER_PACKAGES = ['@prisma/client', 'next/server', 'bwip-js/node', 'ethers', 'stripe']

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

function valueImports(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    if (m[1] === undefined && m[2] !== undefined) out.push(m[2])
  }
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) if (m[1] !== undefined) out.push(m[1])
  return out
}

function resolveLocal(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = resolve(ROOT, 'src', spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else return null
  if (/\.(json|css|png|svg)$/.test(base)) return null
  for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  throw new Error(`cannot resolve ${spec} from ${rel(from)}`)
}

function walkBrowser(starts: string[]): { problems: string[]; visited: string[] } {
  const problems: string[] = []
  const seen = new Set<string>()
  const queue = [...starts]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)
    if (SERVER_ONLY.includes(rel(file))) problems.push(`${rel(file)} is server-only`)
    for (const spec of valueImports(stripComments(readFileSync(file, 'utf8')))) {
      if (NODE_BUILTINS.has(spec)) {
        problems.push(`${rel(file)}: imports ${spec}`)
        continue
      }
      if (SERVER_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) {
        problems.push(`${rel(file)}: imports ${spec}`)
        continue
      }
      const local = resolveLocal(file, spec)
      if (local !== null) queue.push(local)
    }
  }
  return { problems, visited: [...seen].map(rel).sort() }
}

const CLIENT_DIR = resolve(ROOT, 'src/lib/escrow/client')
const ACCOUNT_CLIENT_DIR = resolve(ROOT, 'src/lib/account/client')
const browserStarts = (): string[] => [
  ...readdirSync(CLIENT_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(CLIENT_DIR, f)),
  // The account page runs on the same phone: its sign-in, settings and store credit.
  ...readdirSync(ACCOUNT_CLIENT_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(ACCOUNT_CLIENT_DIR, f)),
  ...['src/lib/account/settings.ts', 'src/lib/account/webauthn.ts', 'src/app/account/account-client.tsx'].map((f) => resolve(ROOT, f)),
  ...['src/app/pay/escrow-ui.tsx', 'src/app/sell/escrow-sell.tsx', 'src/app/sell/escrow-sell-v2.tsx', 'src/app/sell/sell-client.tsx'].map((f) => resolve(ROOT, f)),
  // The till (/pay/[store]) runs on the same phone: its keypad, its screens, and both backends.
  ...['src/app/pay/[store]/till-client.tsx', 'src/lib/till/client/card-backend.ts', 'src/lib/till/client/backend.ts', 'src/lib/till/client/dollars.ts'].map((f) =>
    resolve(ROOT, f),
  ),
  // The till's front door (/pay) and the store list every till screen reads.
  ...['src/app/pay/store-chooser.tsx', 'src/app/pay/stores.ts'].map((f) => resolve(ROOT, f)),
]

describe('the escrow browser code reaches nothing Node-only', () => {
  it('every client module and escrow screen, and everything they import for its value', () => {
    const { problems, visited } = walkBrowser(browserStarts())
    expect(problems).toEqual([])
    // The walk went where the phone goes: the chain client, the hashes, the seal.
    for (const f of [
      'src/lib/escrow/runbook/rpc.ts',
      'src/lib/escrow/runbook/reads.ts',
      'src/lib/escrow/hashes.ts',
      'src/lib/escrow/client/seal.ts',
      'src/lib/escrow/hosts.ts',
      // The page's own pins, which the server's config is held to, load in the browser.
      'src/lib/vault/lit/escrow-pins.ts',
      'src/app/pay/escrow-copy.ts',
      // The dollars rail at the till: SalvoEscrowV2's client, on the phone.
      'src/lib/escrow/client/dollars-backend.ts',
      'src/lib/escrow/client/load-v2.ts',
    ]) {
      expect(visited).toContain(f)
    }
  })

  it('every client file says "use client" where React runs it', () => {
    for (const f of [
      'src/app/pay/escrow-ui.tsx',
      'src/app/sell/escrow-sell.tsx',
      'src/app/sell/escrow-sell-v2.tsx',
      'src/app/sell/sell-client.tsx',
      'src/app/account/account-client.tsx',
      'src/app/pay/[store]/till-client.tsx',
      'src/app/pay/[store]/keypad.tsx',
      'src/app/pay/[store]/use-till.ts',
      'src/app/pay/store-chooser.tsx',
    ]) {
      expect(readFileSync(resolve(ROOT, f), 'utf8').startsWith("'use client'")).toBe(true)
    }
  })

  it('positive control: the walk finds node:crypto behind the escrow config', () => {
    const { problems } = walkBrowser([resolve(ROOT, 'src/lib/escrow/config.ts')])
    expect(problems.some((p) => p.includes('node:crypto') || p.includes('is server-only'))).toBe(true)
  })
})

describe('the escrow screens are behind the rail switch', () => {
  /*
    Read as source: this suite's transform does not take JSX, so the pages
    cannot be imported here. Each gate is one line, on the same
    escrowRailOn() the routes use, which tests/escrow-routes.test.ts drives
    through every value.
  */
  it('/sell offers Salvo Pay only with the rail on, and the account says when dollars are not available', () => {
    const src = (f: string): string => readFileSync(resolve(ROOT, f), 'utf8')
    expect(src('src/app/sell/page.tsx')).toContain('<SellClient escrowRail={escrowRailOn()} />')
    // The choice, and the branch, render only with the flag.
    expect(src('src/app/sell/sell-client.tsx')).toMatch(/\{escrowRail && \(\s*<fieldset/)
    expect(src('src/app/account/page.tsx')).toContain('<AccountClient dollarsRail={escrowRailOn()} />')
    // No page of its own for either rail: /pay is the till's front door, and /cards redirects to the account.
    expect(existsSync(resolve(ROOT, 'src/app/cards'))).toBe(false)
    expect(existsSync(resolve(ROOT, 'src/app/pay/pay-client.tsx'))).toBe(false)
    expect(src('src/app/pay/page.tsx')).toContain('<StoreChooser />')
  })

  it('every page that reads the switch is rendered per request, so it is read at run time', () => {
    for (const f of ['src/app/account/page.tsx', 'src/app/sell/page.tsx']) {
      expect(readFileSync(resolve(ROOT, f), 'utf8')).toContain("export const dynamic = 'force-dynamic'")
    }
  })
})
