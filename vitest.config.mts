import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * `pnpm test` runs every test here that needs no database and no network:
 * the order escrow and the card escrows on an in-process EVM, sealing and
 * hashing, the routing rules, the till and the seller flow.
 *
 * The files below are in the repo to read. They run in the private codebase,
 * because they need its Postgres database, modules that are not published, or
 * the whole codebase to walk.
 */
const PRIVATE_ONLY = [
  // Checks that walk the whole private codebase (every page, route and script).
  'tests/escrow-browser-bundle.test.ts',
  'tests/escrow-no-stripe.test.ts',
  'tests/till-copy.test.ts',
  // Need modules kept private: the app's settings and the credit line.
  'tests/escrow-readiness.test.ts',
  'tests/till-timing.test.ts',
  // Escrow and till flows that read and write orders in Postgres.
  'tests/demand.test.ts',
  'tests/escrow-keeper-sweeps.test.ts',
  'tests/escrow-keeper.test.ts',
  'tests/escrow-load-client.test.ts',
  'tests/escrow-mpp-guards.test.ts',
  'tests/escrow-routes.test.ts',
  'tests/escrow-sell-client.test.ts',
  'tests/escrow-standing.test.ts',
  'tests/escrow-v2-books.test.ts',
  'tests/escrow-v2-client.test.ts',
  'tests/escrow-v2-listing-gate.test.ts',
  'tests/escrow-v2-server.test.ts',
  'tests/route-plan.test.ts',
  'tests/till-card.test.ts',
  'tests/till-dollars.test.ts',
  'tests/till-quote.test.ts',
  'tests/till-silence.test.ts',
]

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', ...PRIVATE_ONLY],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
