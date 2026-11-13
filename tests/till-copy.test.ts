/**
 * What the shopper reads never names the card processor.
 *
 * The rule (unified-account spec, sections 4 and 15): "Stripe" is never on
 * screen. A shopper saves "a card" and pays "by card". The processor is our
 * business, and naming it on the one screen where someone is deciding whether
 * to trust us with a payment reads as a handoff to a third party they did not
 * choose. The old shop page said "Stripe keeps it" and "Use a Stripe test
 * card" until the copy scrub of 2026-10-12; the till that replaced it
 * (/pay/[store], with /pay its front door, on both rails) never named it.
 *
 * WHAT IS SCANNED. Every page and helper under `src/app` that renders text,
 * which is everything there except `src/app/api`. The routes' sentences reach
 * a screen only through a page that chooses what to show, and the webhook's
 * log lines name the processor on purpose. Comments are stripped first: the
 * WHY comments name it all the time, and should. Import lines are stripped
 * too, because a module path is not a sentence.
 *
 * This is a text check on purpose, the same as custody-claims.test.ts: the
 * failure it guards against is a sentence, so a sentence is what it reads.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const APP = resolve(ROOT, 'src/app')
const API = resolve(APP, 'api')

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (resolve(path) !== API) walk(path, out)
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(path)
    }
  }
}

/** The file with comments and import lines blanked, line numbers kept. */
function sentences(text: string): string[] {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ')
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)))
    .replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, blank)
    .split('\n')
}

function rel(path: string): string {
  return relative(ROOT, path).replace(/\\/g, '/')
}

describe('shopper-facing copy', () => {
  const files: string[] = []
  walk(APP, files)

  it('reaches the pages the till and the account live on', () => {
    // A scan that reads nothing passes. These are the screens the rule is for.
    const seen = files.map(rel)
    for (const path of [
      'src/app/page.tsx',
      'src/app/pay/page.tsx',
      'src/app/sell/sell-client.tsx',
      'src/app/sell/escrow-sell-v2.tsx',
      'src/app/hold-copy.ts',
      'src/app/reveal/[token]/reveal-client.tsx',
      'src/app/order/[id]/order-client.tsx',
      'src/app/account/account-client.tsx',
      'src/app/pay/[store]/till-client.tsx',
      'src/app/pay/till-copy.ts',
      'src/app/pay/store-chooser.tsx',
      'src/app/pay/stores.ts',
      'src/app/nav.ts',
    ]) {
      expect(seen, path).toContain(path)
    }
  })

  it('never names the card processor outside a comment', () => {
    const hits: string[] = []
    for (const file of files) {
      sentences(readFileSync(file, 'utf8')).forEach((line, i) => {
        if (/stripe/i.test(line)) hits.push(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    }
    expect(hits).toEqual([])
  })

  it('names no processor in the Home Screen icon or the reminder either', () => {
    // Both leave the page: one onto the Home Screen, one into a calendar.
    for (const path of ['src/app/pay/stores.ts', 'src/lib/account/client/reminder.ts']) {
      expect(sentences(readFileSync(resolve(ROOT, path), 'utf8')).join(' '), path).not.toMatch(/stripe/i)
    }
  })

  it('the stripping keeps a sentence that only looks like a comment', () => {
    // A URL inside a string has "//" in it, and must not hide the rest.
    const lines = sentences("const a = 'https://x.example/Stripe'\n// Stripe in a comment\n")
    expect(lines[0]).toMatch(/Stripe/)
    expect(lines[1]).not.toMatch(/Stripe/)
  })
})
