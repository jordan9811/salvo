/**
 * No Stripe on the escrow rail (spec invariant 12).
 *
 * The crypto rail must work with no Stripe account, API or approval, so no
 * escrow file, route or page may import `stripe`, anything under
 * src/lib/hold/, or name a STRIPE_ setting. Checked TRANSITIVELY: every module
 * an escrow file imports for its value, and every module those import, inside
 * this repo. A type-only import is skipped, since it is erased at build.
 *
 * Why transitive: the obvious leak is not a direct `import 'stripe'`, it is a
 * helpful shared module. The chain registry, for one, imports src/lib/mpp.ts,
 * which reaches src/lib/env.ts, which names the Stripe keys. The positive
 * controls at the bottom prove the scan finds exactly that.
 *
 * The escrow set includes paths later phases add (routes, pages, the static
 * rescue page), so they are covered the day they land.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const rel = (p: string): string => relative(ROOT, p).split('\\').join('/')

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|mjs|html)$/.test(p)) out.push(p)
  }
  return out
}

/** Every escrow file, route and page: today's and the ones later phases add. */
function escrowFiles(): string[] {
  const files = [
    ...walk(resolve(ROOT, 'src/lib/escrow')),
    ...walk(resolve(ROOT, 'src/app/api/escrow')),
    ...walk(resolve(ROOT, 'src/app/api/wallet')),
    ...walk(resolve(ROOT, 'src/app/pay')),
    ...walk(resolve(ROOT, 'src/lib/wallet-pass')),
    // The one account both rails share (unified-account spec 3 and 15): its
    // page, the phone's sign-in and settings, and the server's session.
    ...walk(resolve(ROOT, 'src/app/account')),
    ...walk(resolve(ROOT, 'src/lib/account')),
    // The till's one interface and its phone side (spec 5.1): the card
    // backend is fetches only, and the pages under src/app/pay share them.
    ...walk(resolve(ROOT, 'src/lib/till/client')),
    resolve(ROOT, 'src/lib/till/types.ts'),
    ...readdirSync(resolve(ROOT, 'scripts'))
      .filter((f) => /^escrow-.*\.ts$/.test(f))
      .map((f) => resolve(ROOT, 'scripts', f)),
    ...[
      'src/lib/vault/escrow-backend.ts',
      'src/lib/vault/lit/escrow-pins.ts',
      'src/lib/vault/lit/templates/escrow-v1.ts',
      'src/lib/vault/lit/templates/escrow-v2.ts',
      'public/escrow-rescue.html',
      'public/wallet-sw.js',
      // The escrow branch of /sell, on both escrows, and the server page that offers it.
      'src/app/sell/escrow-sell.tsx',
      'src/app/sell/escrow-sell-v2.tsx',
      'src/app/sell/page.tsx',
      // The UI audit's stand-in for the escrow routes and chain hosts.
      'scripts/ui-states-escrow.ts',
    ]
      .map((f) => resolve(ROOT, f))
      .filter((f) => existsSync(f)),
  ]
  return [...new Set(files)]
}

/** The three string delimiters. */
const QUOTES = new Set(["'", '"', '`'])

/**
 * Drop comments, keep strings. Strings stay because `process.env['STRIPE_X']`
 * is a use; comments go because "no Stripe here" is not one.
 */
function stripComments(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      out += ' '
      continue
    }
    if (c !== undefined && QUOTES.has(c)) {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out
}

/** Value imports (static, re-export, dynamic, require). `import type` and `export type` are skipped. */
function valueImports(code: string): string[] {
  const specs: string[] = []
  for (const m of code.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    if (m[1] === undefined && m[2] !== undefined) specs.push(m[2])
  }
  for (const m of code.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (m[1] !== undefined) specs.push(m[1])
  }
  return specs
}

/** A repo file for an import, or null for a package. Throws for a local import it cannot find. */
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

const isStripePackage = (spec: string): boolean =>
  spec === 'stripe' || spec.startsWith('stripe/') || spec.startsWith('@stripe/')

const HOLD_DIR = resolve(ROOT, 'src/lib/hold')

/** Every Stripe touch reachable from `starts`, as "file: what" lines, plus the files visited. */
function stripeReach(starts: string[]): { problems: string[]; visited: string[] } {
  const problems: string[] = []
  const seen = new Set<string>()
  const queue = [...starts]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)
    if (rel(file).startsWith('src/lib/hold/')) {
      problems.push(`${rel(file)}: is under src/lib/hold`)
    }
    const code = stripComments(readFileSync(file, 'utf8'))
    if (/\bSTRIPE_[A-Z0-9_]*/.test(code)) problems.push(`${rel(file)}: names a STRIPE_ setting`)
    if (file.endsWith('.html')) {
      if (/stripe/i.test(code)) problems.push(`${rel(file)}: mentions Stripe`)
      continue
    }
    for (const spec of valueImports(code)) {
      if (isStripePackage(spec)) {
        problems.push(`${rel(file)}: imports ${spec}`)
        continue
      }
      const local = resolveLocal(file, spec)
      if (local !== null) queue.push(local)
    }
  }
  return { problems, visited: [...seen].map(rel).sort() }
}

describe('the escrow rail reaches no Stripe code', () => {
  it('finds the escrow files it is meant to check', () => {
    const files = escrowFiles().map(rel)
    for (const f of [
      'src/lib/escrow/config.ts',
      'src/lib/escrow/hashes.ts',
      'src/lib/escrow/manifest.ts',
      'src/lib/escrow/merchants.ts',
      // Phase 2 of the till spec: SalvoEscrowV2's twins.
      'src/lib/escrow/artifact-v2.ts',
      'src/lib/escrow/hashes-v2.ts',
      'src/lib/escrow/manifest-v2.ts',
      'src/lib/escrow/terms-v2.ts',
      'src/lib/escrow/readiness.ts',
      'src/lib/escrow/client/seal.ts',
      'src/lib/escrow/client/reply.ts',
      'src/lib/vault/escrow-backend.ts',
      'src/lib/vault/lit/templates/escrow-v1.ts',
      'src/lib/vault/lit/templates/escrow-v2.ts',
      'scripts/escrow-compile.ts',
      // Phase 2: the live runbook's scripts and the code they run.
      'scripts/escrow-deploy.ts',
      'scripts/escrow-check.ts',
      'scripts/escrow-smoke.ts',
      'scripts/escrow-probe-merchants.ts',
      'src/lib/escrow/runbook/args.ts',
      'src/lib/escrow/runbook/bind.ts',
      'src/lib/escrow/runbook/check.ts',
      'src/lib/escrow/runbook/deploy.ts',
      'src/lib/escrow/runbook/key-file.ts',
      'src/lib/escrow/runbook/probe.ts',
      'src/lib/escrow/runbook/reads.ts',
      'src/lib/escrow/runbook/rpc.ts',
      'src/lib/escrow/runbook/smoke.ts',
      // Phase 3 server: the routes, the code behind them, and the keeper.
      'src/app/api/escrow/config/route.ts',
      'src/app/api/escrow/quote/route.ts',
      'src/app/api/escrow/ticket/route.ts',
      'src/app/api/escrow/release/route.ts',
      'src/app/api/escrow/listings/route.ts',
      'src/app/api/escrow/done/route.ts',
      'src/lib/escrow/done-proof-v2.ts',
      'src/lib/escrow/leftover-done.ts',
      'src/lib/escrow/chain.ts',
      'src/lib/escrow/http.ts',
      'src/lib/escrow/keeper.ts',
      'src/lib/escrow/listing.ts',
      'src/lib/escrow/lit-escrow.ts',
      'src/lib/escrow/quote.ts',
      'src/lib/escrow/rail.ts',
      'src/lib/escrow/refs.ts',
      'src/lib/escrow/runtime.ts',
      'scripts/escrow-keeper.ts',
      // Phase 3 client: the phone's and the seller's browser code, and the screens.
      'src/lib/escrow/hosts.ts',
      'src/lib/escrow/client/api.ts',
      'src/lib/escrow/client/barcode.ts',
      'src/lib/escrow/client/card-store.ts',
      'src/lib/escrow/client/load.ts',
      'src/lib/escrow/client/sell.ts',
      'src/lib/escrow/client/wallet.ts',
      'src/app/pay/page.tsx',
      'src/app/pay/escrow-ui.tsx',
      'src/app/pay/escrow-copy.ts',
      'src/app/pay/device-session.ts',
      'src/lib/vault/lit/escrow-pins.ts',
      'src/app/sell/escrow-sell.tsx',
      'src/app/sell/escrow-sell-v2.tsx',
      // The dollars rail at the till, on the phone.
      'src/lib/till/client/dollars.ts',
      'src/lib/escrow/client/dollars-backend.ts',
      'src/lib/account/client/deposits.ts',
      'src/lib/account/client/sell-credit.ts',
      'src/app/sell/page.tsx',
      'scripts/ui-states-escrow.ts',
      'src/app/account/page.tsx',
      'src/app/account/account-client.tsx',
      'src/lib/account/session.ts',
      'src/lib/account/settings.ts',
      'src/lib/account/webauthn.ts',
      'src/lib/account/client/passkey.ts',
      'src/lib/account/client/settings.ts',
      'src/lib/account/client/credit.ts',
    ]) {
      expect(files).toContain(f)
    }
  })

  it('the Salvo Pay screens walk the wallet, the purchase, the seal and the chain client, and find nothing', () => {
    // The till on its dollars rail, and both escrows' /sell.
    const starts = ['src/lib/till/client/dollars.ts', 'src/app/sell/escrow-sell.tsx'].map((f) => resolve(ROOT, f))
    const { problems, visited } = stripeReach(starts)
    expect(problems).toEqual([])
    for (const f of [
      'src/lib/escrow/client/wallet.ts',
      'src/lib/escrow/client/load.ts',
      'src/lib/escrow/client/sell.ts',
      'src/lib/escrow/client/seal.ts',
      'src/lib/escrow/runbook/rpc.ts',
      'src/app/pay/escrow-copy.ts',
      'src/lib/vault/lit/escrow-pins.ts',
    ]) {
      expect(visited).toContain(f)
    }
    // Not the other rail's saved card or hold, which are Stripe's.
    for (const f of ['src/app/saved-card.ts', 'src/lib/env.ts', 'src/lib/mpp.ts']) expect(visited).not.toContain(f)
    // The account shows both rails: its card row is fetches to our own routes, and nothing it reaches is Stripe's.
    const account = stripeReach([resolve(ROOT, 'src/app/account/account-client.tsx')])
    expect(account.problems).toEqual([])
    for (const f of ['src/lib/escrow/client/load.ts', 'src/lib/account/client/deposits.ts', 'src/app/saved-card.ts']) expect(account.visited).toContain(f)
  })

  it('the routes and the keeper walk the database, the matcher, Lit and the chain client, and find nothing', () => {
    const starts = [
      ...['config', 'quote', 'ticket', 'release', 'listings'].map((r) => resolve(ROOT, 'src/app/api/escrow', r, 'route.ts')),
      resolve(ROOT, 'src/lib/escrow/keeper.ts'),
      resolve(ROOT, 'scripts/escrow-keeper.ts'),
    ]
    const { problems, visited } = stripeReach(starts)
    expect(problems).toEqual([])
    expect(visited).toContain('src/lib/db.ts')
    expect(visited).toContain('src/lib/demand/quote.ts')
    expect(visited).toContain('src/lib/vault/lit/transport.ts')
    expect(visited).toContain('src/lib/vault/guard.ts')
    expect(visited).toContain('src/lib/escrow/runbook/rpc.ts')
    // Not the shared HTTP helpers, the order or refund code, or the other
    // rail's one-screen buy: each of those reaches Stripe.
    for (const f of ['src/lib/api.ts', 'src/lib/orders.ts', 'src/lib/reconcile.ts', 'src/lib/demand/one-screen.ts', 'src/lib/env.ts', 'src/lib/mpp.ts']) {
      expect(visited).not.toContain(f)
    }
  })

  it('the runbook scripts walk through Lit, the templates and the chain client, and find nothing', () => {
    const scripts = ['escrow-deploy', 'escrow-check', 'escrow-smoke', 'escrow-probe-merchants'].map((f) => resolve(ROOT, 'scripts', `${f}.ts`))
    const { problems, visited } = stripeReach(scripts)
    expect(problems).toEqual([])
    // The walk went where the live runs go: Lit, the templates, the chain client.
    expect(visited).toContain('src/lib/vault/lit/transport.ts')
    expect(visited).toContain('src/lib/vault/lit/setup-plan.ts')
    expect(visited).toContain('src/lib/escrow/runbook/rpc.ts')
    expect(visited).not.toContain('src/lib/mpp.ts')
    expect(visited).not.toContain('src/lib/env.ts')
  })

  it('the till planner, its quote and the remainder markers reach no Stripe code either', () => {
    // Both tills share these (unified-account spec 5.1 and 6), so the dollars
    // till can use them, and the card till's pages can, under src/app/pay.
    const starts = [
      ...walk(resolve(ROOT, 'src/lib/route')),
      resolve(ROOT, 'src/lib/demand/till-quote.ts'),
      resolve(ROOT, 'src/lib/supply/remainder.ts'),
    ]
    expect(starts.map(rel)).toEqual(
      expect.arrayContaining(['src/lib/route/plan.ts', 'src/lib/route/scan-order.ts', 'src/lib/demand/till-quote.ts']),
    )
    const { problems, visited } = stripeReach(starts)
    expect(problems).toEqual([])
    // The walk went through the database, the matcher and the reveal's caps.
    expect(visited).toContain('src/lib/db.ts')
    expect(visited).toContain('src/lib/supply/matching.ts')
    expect(visited).toContain('src/lib/barcode/reveal.ts')
    // And never into the shop's buy, the refund code or the settings.
    for (const f of ['src/lib/demand/one-screen.ts', 'src/lib/reconcile.ts', 'src/lib/env.ts', 'src/lib/mpp.ts']) {
      expect(visited).not.toContain(f)
    }
  })

  it('the till’s keypad page and its card backend reach no Stripe code', () => {
    // The card side of the till is our server's: the phone only fetches
    // /api/card/till/*. Anything under src/lib/hold here would put the card
    // processor in the bundle of a page that must work without it.
    const starts = [
      ...walk(resolve(ROOT, 'src/app/pay/[store]')),
      ...walk(resolve(ROOT, 'src/lib/till/client')),
      resolve(ROOT, 'src/lib/till/types.ts'),
      resolve(ROOT, 'src/app/pay/till-copy.ts'),
    ]
    expect(starts.map(rel)).toEqual(
      expect.arrayContaining([
        'src/app/pay/[store]/page.tsx',
        'src/app/pay/[store]/till-client.tsx',
        'src/app/pay/[store]/keypad.tsx',
        'src/app/pay/[store]/use-till.ts',
        'src/lib/till/client/card-backend.ts',
      ]),
    )
    const { problems, visited } = stripeReach(starts)
    expect(problems).toEqual([])
    for (const f of ['src/lib/till/client/backend.ts', 'src/lib/escrow/client/card-store.ts', 'src/lib/account/client/settings.ts']) {
      expect(visited).toContain(f)
    }
    for (const f of [
      'src/lib/till/card-till.ts',
      'src/lib/hold/stripe-hold.ts',
      'src/lib/demand/one-screen.ts',
      'src/lib/env.ts',
      'src/lib/api.ts',
      'src/app/saved-card.ts',
    ]) {
      expect(visited).not.toContain(f)
    }
  })

  it('the account page, the phone’s sign-in and the server’s session reach no Stripe code', () => {
    // One account for both rails: a dollars-only shopper signs in, keeps
    // settings and store credit with none of the card rail's code. The card
    // side is the account routes' (src/lib/hold/account.ts), reached by fetch.
    const starts = [...walk(resolve(ROOT, 'src/app/account')), ...walk(resolve(ROOT, 'src/lib/account'))]
    const { problems, visited } = stripeReach(starts)
    expect(problems).toEqual([])
    for (const f of ['src/lib/account/client/passkey.ts', 'src/lib/account/webauthn.ts', 'src/lib/escrow/client/wallet.ts', 'src/lib/escrow/client/card-store.ts']) {
      expect(visited).toContain(f)
    }
    for (const f of ['src/lib/hold/account.ts', 'src/lib/hold/cookie.ts', 'src/lib/env.ts', 'src/lib/mpp.ts', 'src/lib/api.ts']) {
      expect(visited).not.toContain(f)
    }
  })

  it('no escrow file imports stripe, src/lib/hold or a STRIPE_ name, directly or through anything it imports', () => {
    const { problems, visited } = stripeReach(escrowFiles())
    expect(problems).toEqual([])
    // The walk really went through the shared modules, not just the escrow folder.
    expect(visited).toContain('src/lib/vault/guard.ts')
    expect(visited).toContain('src/lib/vault/lit/templates.ts')
    expect(visited).toContain('src/lib/vault/lit/canonical.ts')
    // And never into the chain registry or mpp, which do reach Stripe settings.
    expect(visited).not.toContain('src/lib/chains/registry.ts')
    expect(visited).not.toContain('src/lib/mpp.ts')
    expect(visited).not.toContain('src/lib/env.ts')
  })
})

describe('the scan itself (positive controls)', () => {
  it('finds the STRIPE_ names the chain registry reaches through mpp and env', () => {
    const { problems } = stripeReach([resolve(ROOT, 'src/lib/chains/registry.ts')])
    expect(problems.some((p) => p.startsWith('src/lib/env.ts: names a STRIPE_ setting'))).toBe(true)
  })

  it('finds a stripe import and src/lib/hold', () => {
    const holdFiles = walk(HOLD_DIR).filter((f) => f.endsWith('.ts'))
    expect(holdFiles.length).toBeGreaterThan(0)
    const { problems } = stripeReach(holdFiles)
    expect(problems.some((p) => p.includes('is under src/lib/hold'))).toBe(true)
    expect(problems.some((p) => / imports stripe$/.test(p))).toBe(true)
  })

  it('reads imports the way TypeScript does', () => {
    const code = stripComments(
      [
        "import type { A } from './type-only'",
        "import { b, type C } from './mixed'",
        "export * from './reexport'",
        "export type { D } from './type-reexport'",
        "import './side-effect'",
        "const lazy = await import('./lazy')",
        "// import { e } from './commented'",
        "/* import { f } from './block-commented' */",
        "const url = 'https://example.invalid/not-a-comment'",
        "import stripe from 'stripe'",
      ].join('\n'),
    )
    expect(valueImports(code).sort()).toEqual(['./lazy', './mixed', './reexport', './side-effect', 'stripe'])
    expect(code).toContain('https://example.invalid/not-a-comment')
  })
})
