/**
 * The states this product can be in, defined once.
 *
 * ===========================================================================
 * WHY THIS IS SHARED. The audit measured six routes in their resting state and
 * the screenshots captured fourteen states including the interactive ones — so
 * the audit was blind to exactly the screens with the most going on. It passed
 * clean while the evidence form had a submit button sharing an edge with the
 * input above it, because reaching that form takes three clicks and the audit
 * never clicked anything.
 *
 * Both scripts now walk the same list. A state that is worth a screenshot is
 * worth measuring, and a new one is added in one place.
 * ===========================================================================
 *
 * THE DATA IS INTERCEPTED, NOT SEEDED. Half of what there is to judge only
 * exists when something is on the screen: the quote panel, the estimate, the
 * listing rows, and above all the live barcode with its countdown. The
 * alternative is writing rows to a real database in order to take a picture.
 * Every fixture here is a Playwright route interception, so the REAL components
 * render the REAL layout against a plausible response and nothing is written
 * anywhere. The one thing these cannot tell you is whether the API returns this
 * shape; `tests/` is where that is established.
 *
 * SALVO PAY IS THE ONE EXCEPTION TO "ONLY INTERCEPTIONS". Its pages keep the
 * shopper's account and cards on the phone, so reaching "set up" or "card
 * shown" means writing to the audit browser's own IndexedDB, through the real
 * setup screen and a virtual authenticator. Still nothing reaches a server or
 * the chain: scripts/ui-states-escrow.ts answers our escrow routes and both
 * chain hosts for the first escrow, and tests/escrow-ui-fixtures.test.ts
 * proves the real client accepts those answers; the dollars till's states
 * are answered by the tests' own V2 world instead
 * (scripts/ui-states-dollars.ts, tests/ui-dollars-fixtures.test.ts).
 */

import type { Page, Route } from 'playwright'
import { pdf417Svg } from '../src/lib/barcode/pdf417'
import {
  TILL_FIXTURE_TOTAL_CENTS,
  TILL_FIXTURE_TOTAL_DOWN_CENTS,
  TILL_FIXTURE_TOTAL_UP_CENTS,
  tillAccountView,
  tillRouteAnswer,
} from './till-fixtures'
import {
  boughtCardSeed,
  configBody,
  ensureSeller,
  FIXTURE_TEST_CARD,
  fixtureWorld,
  freshDevice,
  holdRequest,
  installEscrowFixtures,
  isChainHost,
  paidPurchaseSeed,
  releaseHeldRequests,
  reloadSettled,
  requireRail,
  seedDevice,
  sellerListingsSeed,
  virtualFaceId,
  writeDeviceSeed,
} from './ui-states-escrow'
import {
  DOLLARS_FIXTURE_TOTAL_CENTS,
  DOLLARS_PAY_LABEL,
  dollarsDeviceAccount,
  ensureDollarsPasskey,
  ensureDollarsShopper,
  freshTestCardNumber,
  installDollarsPins,
  restockDollars,
  withDollars,
} from './ui-states-dollars'

const json = (route: Route, body: unknown, status = 200): Promise<void> =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

/**
 * A card number shaped like a real one. It is not one, and it never leaves this
 * file. SIXTEEN DIGITS, like every real Best Buy card: the fixture was 19, which
 * has two candidate formats, so no capture ever showed the three that a real
 * flagship card gets — or the "Done" that three pushed off the screen.
 */
const FIXTURE_CARD = '6006491234567890'

/** The other real shape (19 digits, two formats), measured in its own state. */
const FIXTURE_CARD_19 = '6006491234567890123'
/**
 * A Target-eGift-shaped payload: 26 digits, the store's own code a PDF417 that
 * the server draws and sends with the reveal. Not a real card.
 */
const FIXTURE_TARGET_26 = '98765432109876543210123456'

/**
 * The outcome buttons ignore taps for 450ms after they appear, so a double tap
 * on "Done at the register" cannot land on "Yes". A state that answers them has
 * to wait like a person would.
 */
const ARM_MS = 500

/** The order id that must NOT resolve — it is how the not-found screen is reached. */
export const MISSING_ORDER = 'audit-no-such-order'

/*
  PAY ON SCAN ORDERS, ONE ID PER MONEY STATE. The default order below is a
  legacy one, so every screen it reaches looks as it did. These ids answer with
  a hold order instead, keyed by id rather than by a `times: 1` override,
  because the order page fetches its summary on mount and polls it while a
  code is open: an override would be spent before the screen it was for.
*/
const HOLD_ORDER_BASE = {
  merchantId: 'bestbuy',
  priceCents: 4365,
  refundRef: null,
  last4: FIXTURE_CARD.slice(-4),
  faceValueCents: 5000,
  holdMode: true,
  cardHere: true,
}

const HOLD_ORDERS: Readonly<Record<string, Record<string, unknown>>> = {
  // Reserved, nothing held yet: the code is one tap away.
  ord_hold: {
    ...HOLD_ORDER_BASE,
    orderId: 'ord_hold',
    state: 'paid',
    intentState: 'matched',
    revealToken: 'fixture-token',
    opensLeft: 3,
    money: 'not_held',
  },
  // The price is held and the code is open on another screen.
  ord_held: {
    ...HOLD_ORDER_BASE,
    orderId: 'ord_held',
    state: 'fulfilling',
    intentState: 'executing',
    revealToken: null,
    opensLeft: null,
    money: 'held',
  },
  // The hold went on and came off: nothing was taken.
  ord_released: {
    ...HOLD_ORDER_BASE,
    orderId: 'ord_released',
    state: 'refunded',
    intentState: 'refunded',
    revealToken: null,
    opensLeft: null,
    money: 'released',
  },
  // No hold was ever placed.
  ord_none: {
    ...HOLD_ORDER_BASE,
    orderId: 'ord_none',
    state: 'refunded',
    intentState: 'refunded',
    revealToken: null,
    opensLeft: null,
    money: 'none',
  },
}

/** A saved test card, as GET /api/card answers it for the order page. */
const SAVED_CARD = { saved: true, brand: 'visa', last4: '4242', allowanceCents: 20_000, heldCents: 0 }

export async function installFixtures(page: Page): Promise<void> {
  /*
    tsx compiles with esbuild's `keepNames`, which wraps every function in a
    `__name(...)` helper. `page.evaluate` ships function source to the browser,
    where that helper does not exist. Defining it as the identity restores the
    original semantics exactly — it only sets a `.name` for stack traces.
  */
  await page.addInitScript(() => {
    ;(window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f
  })

  /*
    A live code asks before the page is left (reveal-client's beforeunload), and
    Playwright's default is to dismiss dialogs — which for beforeunload means
    "stay", so the next state's goto would never happen. Leaving is what the
    harness means to do.
  */
  page.on('dialog', (d) => void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()))

  /*
    A COUNTING WAKE LOCK. Headless Chromium has no screen to keep on, so the
    real API rejects and the hook fails silently — which is also exactly what a
    hook with no caller looks like. The stub counts requests so the audit can
    tell "asked for the lock" from "never asked", which is the bug that shipped.
  */
  await page.addInitScript(() => {
    const w = window as unknown as { __wl: number }
    w.__wl = 0
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          w.__wl += 1
          return { released: false, release: async () => undefined, addEventListener: () => undefined }
        },
      },
    })
  })

  await page.route('**/api/supply/estimate*', (r) =>
    json(r, {
      basis: 'illustrative',
      caveat:
        'These numbers are illustrative. We have not sold enough cards at this merchant to fit a model yet.',
      daysToSell: 6,
      daysToSellRange: { low: 3, high: 14 },
      proceedsCents: 9000,
      takeNowCents: 6750,
      onSaleCents: 2250,
      upfrontBps: 7500,
      pooled: true,
      mutualisationNotice:
        'Taking money now means your card joins a pool with other sellers. If more cards than expected go unused, everyone in the pool shares the shortfall.',
    }),
  )

  await page.route('**/api/supply/listings*', (r) =>
    json(r, {
      // What production reports: no sealing key, so listing is off.
      listingOpen: false,
      listings: [
        {
          intentId: 'l1', merchantId: 'bestbuy', last4: '8123', faceValueCents: 5000,
          priceCents: 4400, discountBps: 1200, state: 'offered', label: 'Listed',
          detail: 'Listed 2 days ago · nobody has bought it yet',
          paidOut: false, payoutRail: null,
        },
        {
          intentId: 'l2', merchantId: 'nike', last4: '4471', faceValueCents: 2500,
          priceCents: 2250, discountBps: 1000, state: 'completed', label: 'Paid out',
          detail: 'Sold on 4 September · paid the same day',
          paidOut: true, payoutRail: 'ACH',
        },
      ],
    }),
  )

  /*
    THE MISSING-ORDER ROUTE MUST FALL THROUGH. This interception originally
    matched every order id, including the one used to reach the not-found
    screen — so that screenshot was byte-identical to the ready one and the
    failure screen had never once been looked at. A fixture that silently
    covers the state it was supposed to contrast is worse than no fixture.
  */
  /*
    THE CARD THE ORDER PAGE ASKS ABOUT, back from the card page. `card*`
    matches neither /api/card/setup nor /api/card/till/*: a glob star stops
    at a slash.
  */
  await page.route('**/api/card*', (r) => json(r, SAVED_CARD))

  /*
    THE ONE TILL AND THE ONE ACCOUNT. GET /api/account says a card is saved
    (the till's "from your card" line, and the account's Pay with), and every
    /api/card/till/* step answers for one $52.13 purchase at Target, two
    cards, the second left part used (scripts/till-fixtures.ts). Target's
    own 2D code is drawn here, as the server would send it.
  */
  await page.route('**/api/account', (r) => (r.request().method() === 'PUT' ? json(r, { saved: true }) : json(r, tillAccountView())))
  await page.route('**/api/account/challenge', (r) =>
    json(r, { challenge: 'fixture-challenge', expiresAt: new Date(Date.now() + 300_000).toISOString() }),
  )
  await page.route('**/api/card/till/*', (r) => {
    const step = new URL(r.request().url()).pathname.split('/').pop() ?? ''
    let body: Record<string, unknown> = {}
    try {
      body = (r.request().postDataJSON() as Record<string, unknown> | null) ?? {}
    } catch {
      body = {}
    }
    const got = tillRouteAnswer(step, body, (payload) => pdf417Svg(payload))
    return got === null ? json(r, {}, 404) : json(r, got.body, got.status)
  })

  await page.route('**/api/orders/*/summary*', (r) => {
    const url = r.request().url()
    if (url.includes(MISSING_ORDER)) {
      return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
    }
    const id = /\/api\/orders\/([^/?]+)\/summary/.exec(url)?.[1]
    const hold = id === undefined ? undefined : HOLD_ORDERS[id]
    if (hold !== undefined) return json(r, hold)
    return json(r, {
      orderId: 'ord_fixture',
      state: 'fulfilling',
      merchantId: 'bestbuy',
      priceCents: 4365,
      refundRef: null,
      // Derived, not typed: it said '8123' while the barcode encoded a card
      // ending 0123, so one order showed two different tails.
      last4: FIXTURE_CARD.slice(-4),
      faceValueCents: 5000,
      intentState: 'matched',
      revealToken: 'fixture-token',
    })
  })

  await page.route('**/api/barcode/reveal*', (r) =>
    json(r, {
      revealed: true,
      barcode: FIXTURE_CARD,
      exposureCents: 5000,
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
      settleToken: 'fixture-settle',
      opens: 1,
      opensRemaining: 2,
    }),
  )

  /*
    HELD, not released — deliberately. A hold is the outcome the settled screen
    is worst at: it is neither success nor failure, and it was the one being
    dressed in the success colour under the word "Recorded". The `settled-ok`
    state below overrides this to look at the green path.
  */
  await page.route('**/api/barcode/settle*', (r) => json(r, { held: true }))

  await page.route('**/api/inventory*', (r) =>
    json(r, {
      remaining: 42, open: true, closedReason: null,
      priceCents: 1800, minLeadHours: 4, maxLeadDays: 14,
    }),
  )

  // Salvo Pay: our escrow routes and both chain hosts, answered from one fixture world.
  await installEscrowFixtures(page)
  // The dollars till's V2 pins, for the states that answer from the dollars world (withDollars).
  await installDollarsPins(page)
}

/**
 * Answer `url` with `handler` while `fn` runs, then take the override out.
 * The page is reused across states, so an override left in place would answer
 * for every state after this one (the same trap as `times: 1` above).
 */
async function overriding(
  page: Page,
  url: string | ((u: URL) => boolean),
  handler: (r: Route) => Promise<void> | void,
  fn: () => Promise<void>,
): Promise<void> {
  await page.route(url, handler)
  try {
    await fn()
  } finally {
    await page.unroute(url, handler)
  }
}

/** Salvo Pay's store pill. `exact`, so a store's name never matches a longer button's. */
const pickStore = (page: Page, name: string): Promise<void> => page.getByRole('button', { name, exact: true }).click()

/** Fill the seller's escrow form on /sell with a Salvo test card: the only store it lists on the test chain. */
async function fillEscrowSale(page: Page, value: string, cardNumber: string = FIXTURE_TEST_CARD): Promise<void> {
  await pickStore(page, 'Salvo test card')
  await page.fill('#escrow-card', cardNumber)
  await page.fill('#escrow-value', value)
}

/**
 * A dollars phone at Target's till: set up on /account in the dollars world
 * (scripts/ui-states-dollars.ts), Target's $20 and $16 cards put on sale,
 * then the till, keypad first. `card`: GET /api/account also says this
 * account has a card saved, once it is set up.
 */
async function dollarsTill(page: Page, fn: () => Promise<void>, o: { card?: boolean } = {}): Promise<void> {
  await requireRail(page)
  await freshDevice(page)
  let account: string | null = null
  const view = (r: Route) =>
    json(r, account !== null && o.card === true ? tillAccountView({ address: account, card: true }) : tillAccountView({ address: dollarsDeviceAccount(), card: false }))
  await overriding(page, '**/api/account', view, async () => {
    await withDollars(page, async () => {
      account = await ensureDollarsShopper(page)
      await restockDollars()
      await page.goto(new URL('/pay/target', page.url()).toString(), { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('h1', { timeout: 15_000 })
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(400)
      await fn()
    })
  })
}

/** The dollars fixture's total typed, its price on the button, and what the tap needs fetched while the shopper types. */
async function quoteDollars(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Delete' }).waitFor({ timeout: 15_000 })
  const ticket = page.waitForResponse((r) => r.url().endsWith('/api/escrow/ticket'), { timeout: 20_000 })
  await typeTotal(page, DOLLARS_FIXTURE_TOTAL_CENTS)
  await page.waitForSelector(`text=${DOLLARS_PAY_LABEL}`, { timeout: 15_000 })
  await ticket
  await page.waitForTimeout(400)
}

/** Pay in dollars, and wait for card 1's code, released by Lit and opened on the phone. */
async function payDollars(page: Page): Promise<void> {
  await quoteDollars(page)
  await page.getByRole('button', { name: DOLLARS_PAY_LABEL }).click()
  await page.waitForSelector('text=Scan 1 of 2', { timeout: 30_000 })
  await page.waitForSelector('.barcode', { timeout: 10_000 })
  await page.waitForTimeout(400)
}

/** Card 1 on screen in dollars, then "The total changed" to `cents`, typed as the register shows it. */
async function changeDollarsTotalTo(page: Page, cents: number): Promise<void> {
  await payDollars(page)
  await page.getByRole('button', { name: DIDNT_SCAN_LABEL }).click()
  await page.getByRole('button', { name: 'The total changed' }).click()
  await page.waitForSelector('text=The new total', { timeout: 10_000 })
  // The sheet's pad starts on the old total: clear it, then type the new one.
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Delete' }).last().click()
  await typeTotal(page, cents)
  await page.getByRole('button', { name: 'Use this total' }).click()
}

/** /sell on the new escrow, with a seller key set up for it on this device. Call inside withDollars. */
async function ensureSellerV2(page: Page): Promise<void> {
  await virtualFaceId(page)
  await page.getByRole('button', { name: 'Crypto' }).click()
  const setUp = page.getByRole('heading', { name: 'Your seller account' })
  const ready = page.getByRole('button', { name: 'Seal it and list it' })
  await setUp.or(ready).first().waitFor({ timeout: 15_000 })
  if ((await ready.count()) === 0) {
    await page.getByRole('button', { name: 'Set up with Face ID' }).click()
    await ready.waitFor({ timeout: 15_000 })
  }
}

/** The till's Pay button for the fixture's total. */
const TILL_PAY_LABEL = 'Pay $46.92 for $52.13 · 2 cards'

/** The scan screen's "It didn't scan", with the till's own apostrophe. */
const DIDNT_SCAN_LABEL = 'It didn’t scan'

/** Type a total on the till's pad, key by key, as a cashier's total is read off. */
async function typeTotal(page: Page, cents: number): Promise<void> {
  for (const k of String(cents)) await page.getByRole('button', { name: k, exact: true }).click()
}

/** The fixture's total typed, and its price on the button. */
async function quoteTill(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Delete' }).waitFor({ timeout: 15_000 })
  await typeTotal(page, TILL_FIXTURE_TOTAL_CENTS)
  await page.waitForSelector(`text=${TILL_PAY_LABEL}`, { timeout: 10_000 })
  await page.waitForTimeout(300)
}

/** Pay, and wait for card 1's code. */
async function payTill(page: Page): Promise<void> {
  await quoteTill(page)
  await page.getByRole('button', { name: TILL_PAY_LABEL }).click()
  await page.waitForSelector('text=Scan 1 of 2', { timeout: 10_000 })
  await page.waitForSelector('.barcode', { timeout: 10_000 })
  await page.waitForTimeout(400)
}

/** Card 1 on screen, then "The total changed" to `cents`, typed as the register shows it. */
async function changeTotalTo(page: Page, cents: number): Promise<void> {
  await payTill(page)
  await page.getByRole('button', { name: DIDNT_SCAN_LABEL }).click()
  await page.getByRole('button', { name: 'The total changed' }).click()
  await page.waitForSelector('text=The new total', { timeout: 10_000 })
  // The sheet's pad starts on the old total: clear it, then type the new one.
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Delete' }).last().click()
  await typeTotal(page, cents)
  await page.getByRole('button', { name: 'Use this total' }).click()
}

/** Both cards scanned, and Done. */
async function finishTill(page: Page): Promise<void> {
  await payTill(page)
  await page.getByRole('button', { name: 'Scanned · next' }).click()
  await page.waitForSelector('text=Scan 2 of 2', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.waitForSelector('text=Paid $46.92 · saved $5.21.', { timeout: 10_000 })
  await page.waitForTimeout(300)
}

/**
 * This phone signed in as the fixture's account: a fresh store, then the
 * passkey record card-store.ts would keep, under the address GET
 * /api/account names. No passkey exists behind it; nothing here signs.
 */
async function signedInPhone(page: Page): Promise<void> {
  await freshDevice(page)
  const address = String(tillAccountView().address)
  const rpId = new URL(page.url()).hostname
  await page.evaluate(writeDeviceSeed, [
    { slot: 'passkey', value: { credentialId: 'fixture-credential', publicKey: `0x${'11'.repeat(64)}`, address, rpId, createdAt: Date.now() } },
  ])
  await reloadSettled(page)
}

export interface UiState {
  name: string
  route: string
  /** Drives the page into the state. Throwing here is reported, not fatal. */
  prepare?: (page: Page) => Promise<void>
  /**
   * The HTTP error status this state is reached through, such as the 402 of a
   * declined card. The browser logs the failed request to the console, and
   * here that line is the thing under test, not a defect.
   */
  httpError?: number
  /**
   * State-specific invariants, asserted by the audit.
   *
   * THESE ARE BEHAVIOUR, NOT APPEARANCE. `navReachable: false` says that while
   * a code is on screen there is no one-tap route away from it — the property
   * that makes the reveal screen safe to hold up at a register. It is enforced
   * by a `:has()` rule reacting to `data-live`, which is the kind of thing that
   * regresses silently the next time the markup moves. The measured version
   * costs one line per state.
   */
  expect?: {
    navReachable?: boolean
    /**
     * The barcode DOM must not change while a code is live.
     *
     * `encode` and `barPatternToSvg` were called inline in the render, and the
     * countdown set state every 250ms — so the <svg> a scanner is pointed at
     * was destroyed and rebuilt four times a second for ninety seconds.
     * Measured at sixteen mutations in four seconds, with the element coming
     * back as a different DOM node. Nothing about that is visible, and no unit
     * test can see it; it only exists as a count of mutations over time.
     */
    barcodeStable?: boolean
    /** A code on screen must have asked for the screen to stay on. */
    wakeLock?: boolean
    /**
     * On a phone, "Done at the register" must end at or above this y (CSS px).
     * 664 is a 390px iPhone's visible height in Safari with the toolbar
     * showing; the 844px capture viewport flattered every earlier measurement.
     */
    doneWithin?: number
    /**
     * Every code card on screen is the same height (within 1px). The encoder's
     * inline natural-width cap made a 16-digit Code 128 smaller than the ITF
     * fallback under it — the code labelled "Scan this code" was the lesser.
     */
    barcodesEven?: boolean
  }
}

export const STATES: readonly UiState[] = [
  /* The landing page is the first thing anyone sees; it is measured like the
     rest. `tickets` is the old root, moved so `/` could become the landing. */
  { name: 'landing', route: '/' },
  { name: 'tickets', route: '/tickets' },
  /* The page that describes the product is the one most likely to overclaim,
     so it is measured and photographed like every other screen. */
  { name: 'how-it-works', route: '/how-it-works' },
  /*
    THE TILL'S FRONT DOOR (/pay, on both rails). A phone that has opened no
    till yet gets the stores, one tap each; one that has goes straight to its
    last store, so this state starts from a fresh phone.
  */
  {
    name: 'till-stores',
    route: '/pay',
    prepare: async (page) => {
      // A phone that kept a store was sent on to its till before this ran: clear it, then come back.
      await freshDevice(page)
      await page.goto(new URL('/pay', page.url()).toString(), { waitUntil: 'domcontentloaded' })
      await page.locator('nav[aria-label="Stores"]').waitFor({ timeout: 15_000 })
      await page.waitForTimeout(300)
    },
  },
  /*
    THE TILL (/pay/target). The keypad is the screen; every state types the
    fixture's $52.13 the way a shopper does, key by key, and the routes
    answer from scripts/till-fixtures.ts.
  */
  { name: 'till-keypad', route: '/pay/target', expect: { navReachable: true } },
  { name: 'till-quoted', route: '/pay/target', expect: { navReachable: true }, prepare: quoteTill },
  {
    // Nothing on sale at this store: the sentence, and the sample purchase under it.
    name: 'till-nothing-listed',
    route: '/pay/target',
    prepare: async (page) => {
      await overriding(page, '**/api/card/till/quote', (r) => json(r, { unavailable: 'Nothing is listed for this store right now.', nothingListed: true }), async () => {
        await typeTotal(page, TILL_FIXTURE_TOTAL_CENTS)
        await page.waitForSelector('text=Nothing at Target right now.', { timeout: 10_000 })
        await page.waitForTimeout(300)
      })
    },
  },
  {
    // No card saved: the till says where to save one. GET /api/account is read on mount, so the page is loaded again under the override.
    name: 'till-no-card',
    route: '/pay/target',
    prepare: async (page) => {
      await overriding(page, '**/api/account', (r) => json(r, tillAccountView({ card: false })), async () => {
        await reloadSettled(page)
        await page.waitForSelector('text=Save a card in Account to pay here.', { timeout: 10_000 })
      })
    },
  },
  {
    // Change: the other stores, one tap each. Never a search.
    name: 'till-change-store',
    route: '/pay/target',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Change' }).click()
      await page.locator('nav[aria-label="Other stores"]').waitFor({ timeout: 10_000 })
    },
  },
  {
    // The beat between the tap and card 1. Pay is held, so "Paying…" stays up while it is measured.
    // Nothing leads away from it: Pay opens card 1 before it answers.
    name: 'till-paying',
    route: '/pay/target',
    expect: { navReachable: false },
    prepare: async (page) => {
      await quoteTill(page)
      await overriding(page, '**/api/card/till/pay', holdRequest, async () => {
        await page.getByRole('button', { name: TILL_PAY_LABEL }).click()
        await page.waitForSelector('text=Paying…', { timeout: 10_000 })
      })
    },
  },
  {
    /*
      CARD 1 OF 2, LIVE, HELD TO THE REVEAL'S RULES. While it shows nothing
      may lead away from it, the symbol must not be rebuilt by the ticking
      countdown, and the screen must stay on.
    */
    name: 'till-scan-1',
    route: '/pay/target',
    expect: { navReachable: false, barcodeStable: true, wakeLock: true },
    prepare: payTill,
  },
  {
    // "It didn't scan": try the other barcode, say why, or change the total. Never a number to type.
    name: 'till-didnt-scan',
    route: '/pay/target',
    expect: { navReachable: false },
    prepare: async (page) => {
      await payTill(page)
      await page.getByRole('button', { name: DIDNT_SCAN_LABEL }).click()
      await page.waitForSelector('text=What happened?', { timeout: 10_000 })
    },
  },
  {
    // The register's total changed with a code on screen: the pad again, in the sheet.
    name: 'till-total-changed',
    route: '/pay/target',
    expect: { navReachable: false },
    prepare: async (page) => {
      await payTill(page)
      await page.getByRole('button', { name: DIDNT_SCAN_LABEL }).click()
      await page.getByRole('button', { name: 'The total changed' }).click()
      await page.waitForSelector('text=The new total', { timeout: 10_000 })
    },
  },
  {
    // Card 2 of 2, drawn only after Next: what it covers, and what stays on it for the next shopper.
    name: 'till-scan-2',
    route: '/pay/target',
    expect: { navReachable: false, barcodeStable: true, wakeLock: true },
    prepare: async (page) => {
      await payTill(page)
      await page.getByRole('button', { name: 'Scanned · next' }).click()
      await page.waitForSelector('text=Scan 2 of 2', { timeout: 10_000 })
      await page.waitForTimeout(400)
    },
  },
  {
    // Card 1 was declined at Target: its hold is kept for the next shopper, said so, and one tap pays what is still owed.
    name: 'till-owed',
    route: '/pay/target',
    prepare: async (page) => {
      await payTill(page)
      await page.getByRole('button', { name: DIDNT_SCAN_LABEL }).click()
      await page.getByRole('button', { name: 'The register declined it' }).click()
      await page.waitForSelector('text=Pay $46.92 more for $52.13 · 1 card', { timeout: 10_000 })
      await page.waitForSelector('text=until the next shopper tries it', { timeout: 10_000 })
      await page.waitForTimeout(300)
    },
  },
  {
    /*
      THE TOTAL WENT UP WITH CARD 1 ON SCREEN. Card 1's code stays up, its
      screen kept on, with the rest planned under it: one tap says it
      scanned and pays the rest. Nothing settles the card before that.
    */
    name: 'till-total-up',
    route: '/pay/target',
    expect: { navReachable: false, barcodeStable: true, wakeLock: true },
    prepare: async (page) => {
      await changeTotalTo(page, TILL_FIXTURE_TOTAL_UP_CENTS)
      await page.waitForSelector('text=Scanned · pay $30.72 more', { timeout: 10_000 })
      await page.waitForTimeout(300)
    },
  },
  {
    // The total came down past what can stay on card 1: do not scan it, and the one way on.
    name: 'till-total-too-low',
    route: '/pay/target',
    expect: { navReachable: false },
    prepare: async (page) => {
      await changeTotalTo(page, TILL_FIXTURE_TOTAL_DOWN_CENTS)
      await page.waitForSelector('text=Use other cards', { timeout: 10_000 })
      await page.waitForTimeout(300)
    },
  },
  {
    // Card 1 did not work and nothing else covers the rest: what the register still needs, never a receipt.
    name: 'till-uncovered',
    route: '/pay/target',
    prepare: async (page) => {
      await payTill(page)
      await overriding(
        page,
        '**/api/card/till/report',
        (r) =>
          json(r, {
            unavailable: 'We cannot cover $52.13 at this store right now.',
            owedCents: TILL_FIXTURE_TOTAL_CENTS,
            receipt: { paidCents: 0, savedCents: 0, depositCents: 0, keptCents: 1_890 },
            kept: { cents: 1_890, until: 'next_shopper' },
            note: null,
          }),
        async () => {
          await page.getByRole('button', { name: DIDNT_SCAN_LABEL }).click()
          await page.getByRole('button', { name: 'The register declined it' }).click()
          await page.waitForSelector('text=The register still needs $52.13.', { timeout: 10_000 })
        },
      )
      await page.waitForTimeout(300)
    },
  },
  {
    // Done: what was paid and saved, and when the deposit comes back.
    name: 'till-done',
    route: '/pay/target',
    expect: { navReachable: true },
    prepare: finishTill,
  },
  {
    // "Something went wrong?" after Done: card 1 was the rest of another shopper's card, so it can be reported empty.
    name: 'till-done-help',
    route: '/pay/target',
    expect: { navReachable: true },
    prepare: async (page) => {
      await finishTill(page)
      await page.getByRole('button', { name: 'Something went wrong?' }).click()
      await page.waitForSelector('text=Card 1 was empty', { timeout: 10_000 })
    },
  },
  /*
    THE ONE ACCOUNT (/account). Signed out it is one button. Signed in it is
    what pays at the till, how the till picks cards, balances, store credit,
    the stores' Home Screen icons and the calendar reminder. Signed in means
    this phone keeps a passkey record under the address GET /api/account
    names, so these states write one the way card-store.ts does.
  */
  {
    name: 'account-sign-in',
    route: '/account',
    prepare: async (page) => {
      await overriding(page, '**/api/account', (r) => json(r, tillAccountView({ address: null, card: false })), async () => {
        await freshDevice(page)
        await page.getByRole('button', { name: 'Continue with Face ID' }).waitFor({ timeout: 15_000 })
        await page.waitForTimeout(300)
      })
    },
  },
  {
    name: 'account-ready',
    route: '/account',
    prepare: async (page) => {
      await signedInPhone(page)
      await page.getByRole('heading', { name: 'Stores and alerts' }).waitFor({ timeout: 15_000 })
      await page.waitForTimeout(300)
    },
  },
  {
    name: 'account-reminder',
    route: '/account',
    prepare: async (page) => {
      await signedInPhone(page)
      await page.locator('summary:has-text("Remind me at")').click()
      await page.waitForSelector('#remind-at', { timeout: 10_000 })
      await page.waitForTimeout(300)
    },
  },
  { name: 'sell-empty', route: '/sell' },
  {
    name: 'sell-estimate',
    route: '/sell',
    prepare: async (page) => {
      // No store is pre-picked on /sell either, so the estimate waits for one.
      await page.getByRole('button', { name: 'Best Buy' }).click()
      await page.fill('#value', '100')
      await page.fill('#card', '6006 4900 1234 5678')
      await page.waitForSelector('text=Likely to sell in', { timeout: 10_000 })
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'sell-blind-merchant',
    route: '/sell',
    prepare: async (page) => {
      // A store pill now, the same control as the account page's, not a native select.
      await page.getByRole('button', { name: 'Walmart' }).click()
      await page.fill('#value', '75')
      await page.waitForTimeout(900)
    },
  },
  { name: 'order-missing', route: `/order/${MISSING_ORDER}` },
  { name: 'order-ready', route: '/order/ord_fixture', expect: { navReachable: true } },
  /*
    PAY ON SCAN ON THE ORDER PAGE. "You pay" before the tap, not "You paid";
    the hold said while it is on; and a refund that never took anything says
    "Nothing was charged" with no refund reference to go looking for.
  */
  { name: 'order-hold-ready', route: '/order/ord_hold?spend=4850', expect: { navReachable: true } },
  {
    // Held, with the code open on another screen: the poll keeps answering
    // the same order, because the fixture is keyed by id.
    name: 'order-held',
    route: '/order/ord_held?spend=4850',
    expect: { navReachable: true },
    prepare: async (page) => {
      await page.waitForSelector('text=We are holding', { timeout: 10_000 })
    },
  },
  {
    name: 'order-refunded-released',
    route: '/order/ord_released?spend=4850',
    expect: { navReachable: true },
    prepare: async (page) => {
      await page.waitForSelector('text=we released the hold', { timeout: 10_000 })
    },
  },
  {
    name: 'order-refunded-none',
    route: '/order/ord_none?spend=4850',
    expect: { navReachable: true },
    prepare: async (page) => {
      await page.waitForSelector('text=We never held any money', { timeout: 10_000 })
    },
  },
  /*
    A DECLINED CARD AT THE TILL. The hold is refused before any code is shown,
    so the screen offers another card first and a retry second, and spends no
    opening. Reached through a 402, which the browser logs.
  */
  {
    name: 'order-reveal-declined',
    route: '/order/ord_hold?spend=4850',
    expect: { navReachable: true },
    httpError: 402,
    prepare: async (page) => {
      await page.route(
        '**/api/barcode/reveal*',
        (r) =>
          r.fulfill({
            status: 402,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'card_declined',
              message: 'Your card was declined, so nothing was charged. Use a different card, or pay another way.',
              money: 'none',
            }),
          }),
        { times: 1 },
      )
      await page.click('text=Show my code')
      await page.waitForSelector('text=Use a different card', { timeout: 10_000 })
      await page.waitForTimeout(300)
    },
  },
  /*
    THE HOLD NOTE IS LONGER THAN THE ONE IT REPLACES ("we release the hold"
    against "your money is safe"), so the live hold code is held to the same
    line for "Done at the register" as the legacy one.
  */
  {
    name: 'order-reveal-live-hold',
    route: '/order/ord_hold?spend=4850',
    expect: { navReachable: false, barcodeStable: true, wakeLock: true, doneWithin: 664, barcodesEven: true },
    prepare: async (page) => {
      await page.click('text=Show my code')
      await page.waitForSelector('.barcode', { timeout: 10_000 })
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'order-reveal-live',
    route: '/order/ord_fixture',
    expect: { navReachable: false, barcodeStable: true, wakeLock: true, doneWithin: 664, barcodesEven: true },
    prepare: async (page) => {
      await page.click('text=Show my code')
      await page.waitForSelector('.barcode', { timeout: 10_000 })
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'order-reveal-live-19',
    route: '/order/ord_fixture',
    expect: { navReachable: false, barcodeStable: true, doneWithin: 664 },
    prepare: async (page) => {
      await page.route(
        '**/api/barcode/reveal*',
        (r) =>
          r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              revealed: true,
              barcode: FIXTURE_CARD_19,
              exposureCents: 5000,
              expiresAt: new Date(Date.now() + 90_000).toISOString(),
              settleToken: 'fixture-settle',
              opens: 1,
              opensRemaining: 2,
            }),
          }),
        { times: 1 },
      )
      await page.click('text=Show my code')
      await page.waitForSelector('.barcode', { timeout: 10_000 })
      await page.waitForTimeout(400)
    },
  },
  /*
    A STORE WHOSE OWN CODE IS 2D. Target's eGift barcode is PDF417, drawn by
    the server and sent with the reveal; it takes the primary slot and the 1D
    codes follow as fallbacks. Not held to barcodesEven: the 2D card and the
    1D card are different shapes by nature, and the primary is the taller.
  */
  {
    name: 'order-reveal-live-pdf417',
    route: '/order/ord_fixture',
    expect: { navReachable: false, barcodeStable: true, doneWithin: 664 },
    prepare: async (page) => {
      await page.route(
        '**/api/barcode/reveal*',
        (r) =>
          r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              revealed: true,
              barcode: FIXTURE_TARGET_26,
              pdf417: pdf417Svg(FIXTURE_TARGET_26),
              exposureCents: 500,
              expiresAt: new Date(Date.now() + 90_000).toISOString(),
              settleToken: 'fixture-settle',
              opens: 1,
              opensRemaining: 2,
            }),
          }),
        { times: 1 },
      )
      await page.click('text=Show my code')
      await page.waitForSelector('.barcode', { timeout: 10_000 })
      await page.waitForTimeout(400)
    },
  },
  /*
    CARD 1 OF 2. A two-card purchase is two orders; the first says which card it
    is and offers the second under its code.
  */
  {
    name: 'order-two-cards-first',
    route: '/order/ord_fixture?cards=ord_fixture,ord_fixture_2&amounts=5000,1340',
    expect: { navReachable: true },
  },
  {
    name: 'order-two-cards-first-done',
    route: '/order/ord_fixture?cards=ord_fixture,ord_fixture_2&amounts=5000,1340',
    expect: { navReachable: true },
    prepare: async (page) => {
      await page.route(
        '**/api/orders/*/summary*',
        (r) =>
          r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              orderId: 'ord_fixture',
              state: 'fulfilled',
              merchantId: 'bestbuy',
              priceCents: 4800,
              refundRef: null,
              last4: '7890',
              faceValueCents: 5000,
              intentState: 'completed',
              revealToken: null,
            }),
          }),
        { times: 1 },
      )
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('text=Scan card 2 of 2', { timeout: 10_000 })
    },
  },
  {
    name: 'order-reveal-outcome',
    route: '/order/ord_fixture',
    expect: { navReachable: false },
    prepare: async (page) => {
      await page.click('text=Show my code')
      await page.waitForSelector('.barcode', { timeout: 10_000 })
      await page.click('text=Done at the register')
      await page.waitForSelector('text=Do you have your items?', { timeout: 10_000 })
      await page.waitForTimeout(300)
    },
  },
  {
    name: 'reveal-settled-released',
    route: '/order/ord_fixture',
    expect: { navReachable: true },
    prepare: async (page) => {
      /*
        The happy outcome, so the affirmative treatment is looked at too.

        `times: 1` IS LOAD-BEARING. The page is reused across every state in
        this list, so a route registered here without it would keep answering
        "released" for the rest of the run — and the very next state, which
        exists to show the HELD treatment, would silently have been screenshot
        and measured as a release. A fixture that leaks into the state it is
        meant to contrast is the same bug as the missing-order interception.
      */
      await page.route(
        '**/api/barcode/settle*',
        (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ released: true }) }),
        { times: 1 },
      )
      await page.click('text=Show my code')
      await page.waitForSelector('.barcode', { timeout: 10_000 })
      await page.click('text=Done at the register')
      await page.waitForTimeout(ARM_MS)
      await page.click('text=Yes, I have my items')
      await page.waitForSelector('text=Confirmed', { timeout: 10_000 })
      await page.waitForTimeout(300)
    },
  },
  {
    // The counterpart assertion: once nothing is at risk, the way out is back.
    name: 'reveal-settled',
    route: '/order/ord_fixture',
    expect: { navReachable: true },
    prepare: async (page) => {
      await page.click('text=Show my code')
      await page.waitForSelector('.barcode', { timeout: 10_000 })
      await page.click('text=Done at the register')
      await page.waitForTimeout(ARM_MS)
      await page.click('text=No, something went wrong')
      await page.waitForSelector('text=Tell us what happened', { timeout: 10_000 })
      await page.waitForTimeout(300)
    },
  },
  {
    name: 'reveal-evidence-form',
    route: '/order/ord_fixture',
    expect: { navReachable: true },
    prepare: async (page) => {
      await page.click('text=Show my code')
      await page.waitForSelector('.barcode', { timeout: 10_000 })
      await page.click('text=Done at the register')
      await page.waitForTimeout(ARM_MS)
      await page.click('text=No, something went wrong')
      await page.waitForSelector('text=Tell us what happened', { timeout: 10_000 })
      await page.click('text=Tell us what happened')
      await page.waitForSelector('#ev-email', { timeout: 10_000 })
      await page.waitForTimeout(300)
    },
  },
  {
    name: 'reveal-evidence-partial',
    route: '/order/ord_fixture',
    prepare: async (page) => {
      await page.click('text=Show my code')
      await page.waitForSelector('.barcode', { timeout: 10_000 })
      await page.click('text=Done at the register')
      await page.waitForTimeout(ARM_MS)
      await page.click('text=No, something went wrong')
      await page.waitForSelector('text=Tell us what happened', { timeout: 10_000 })
      await page.click('text=Tell us what happened')
      await page.waitForSelector('#ev-email', { timeout: 10_000 })
      await page.click('text=It covered part')
      await page.waitForSelector('#ev-applied', { timeout: 10_000 })
      await page.waitForTimeout(300)
    },
  },
  { name: 'reveal-idle', route: '/reveal/fixture-token' },
  /*
    THE DEMO GETS THE SAME INVARIANTS AS THE REAL THING. It renders a live
    barcode with a countdown, so while that is on screen nothing may navigate
    away and the barcode DOM must not be rebuilt — a demo that behaved worse
    than the product it demonstrates would be demonstrating the wrong product.
  */
  { name: 'demo', route: '/demo?m=bestbuy&s=4850', expect: { navReachable: true } },
  {
    name: 'demo-live',
    route: '/demo?m=bestbuy&s=4850',
    expect: { navReachable: false, barcodeStable: true, wakeLock: true },
    prepare: async (page) => {
      await page.click('text=Show the sample code')
      await page.waitForSelector('.barcode', { timeout: 10_000 })
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'demo-done',
    route: '/demo?m=bestbuy&s=4850',
    expect: { navReachable: true },
    prepare: async (page) => {
      await page.click('text=Show the sample code')
      await page.waitForSelector('.barcode', { timeout: 10_000 })
      await page.click('text=Done at the register')
      await page.waitForTimeout(ARM_MS)
      await page.click('text=Yes, I have my items')
      await page.waitForSelector('text=You are all set.', { timeout: 10_000 })
      await page.waitForTimeout(300)
    },
  },

  /*
    SALVO PAY ON THE FIRST ESCROW: what is left of it. Its Load screen and
    /cards are gone (/pay is the till's front door, /cards redirects to the
    account's store credit), so its states are the account's: the whole
    cards a phone bought there, with their codes, and a purchase of one that
    did not finish. Every state past "off" needs the dev server started with
    ESCROW_RAIL=testnet.

    THE CARD ON SCREEN IS A LIVE CODE, HELD TO THE REVEAL'S RULES. While it
    shows, nothing may lead away from it, the symbol must not be rebuilt, and
    the screen must stay on.
  */
  {
    name: 'account-first-escrow-cards',
    route: '/account',
    expect: { navReachable: true },
    prepare: async (page) => {
      await requireRail(page)
      await signedInPhone(page)
      await seedDevice(page, boughtCardSeed)
      await page.getByRole('button', { name: 'Show code' }).waitFor({ timeout: 15_000 })
    },
  },
  {
    name: 'account-first-escrow-code',
    route: '/account',
    expect: { navReachable: false, barcodeStable: true, wakeLock: true },
    prepare: async (page) => {
      await requireRail(page)
      await signedInPhone(page)
      await seedDevice(page, boughtCardSeed)
      await page.getByRole('button', { name: 'Show code' }).click()
      await page.waitForSelector('.barcode', { timeout: 10_000 })
      await page.waitForTimeout(400)
    },
  },
  {
    // Paid on the first escrow, its card not back yet (Lit was down at the tap): Finish it, above the cards.
    name: 'account-first-escrow-pending',
    route: '/account',
    prepare: async (page) => {
      await requireRail(page)
      await signedInPhone(page)
      await seedDevice(page, paidPurchaseSeed)
      await page.waitForSelector('text=your payment went through.', { timeout: 15_000 })
      await page.waitForTimeout(300)
    },
  },

  /*
    THE DOLLARS TILL (spec 5.3): tap, type, pay, scan on SalvoEscrowV2,
    through the real screens. Every request goes to the dollars world
    (scripts/ui-states-dollars.ts): the real escrow on an in-process chain,
    the real template on fake Lit. The phone is set up on /account with
    Face ID (Chromium's virtual authenticator), allows $200 a week, and is
    given $250 of test dollars; each paying state restocks the $20 and $16
    Target cards it buys.
  */
  {
    // Signed in, no allowance yet: the one Face ID that lets the till pay in dollars.
    name: 'account-dollars-allow',
    route: '/account',
    prepare: async (page) => {
      await requireRail(page)
      await freshDevice(page)
      await overriding(page, '**/api/account', (r) => json(r, tillAccountView({ address: dollarsDeviceAccount(), card: false })), async () => {
        await withDollars(page, async () => {
          await ensureDollarsPasskey(page)
          await page.goto(new URL('/account', page.url()).toString(), { waitUntil: 'domcontentloaded' })
          await page.getByRole('button', { name: /^Allow Salvo to spend up to/ }).waitFor({ timeout: 15_000 })
          await page.waitForTimeout(300)
        })
      })
    },
  },
  {
    // Both rails set up: the till's tick on dollars ("default to stablecoins"), and the card one tap away.
    name: 'account-both-rails',
    route: '/account',
    prepare: async (page) => {
      await requireRail(page)
      await freshDevice(page)
      let account: string | null = null
      // Not signed in while the phone is set up; then signed in as that same account, with its card.
      const view = (r: Route) =>
        json(r, account === null ? tillAccountView({ address: dollarsDeviceAccount(), card: false }) : tillAccountView({ address: account, card: true }))
      await overriding(page, '**/api/account', view, async () => {
        await withDollars(page, async () => {
          account = await ensureDollarsShopper(page)
          await reloadSettled(page)
          await page.getByRole('button', { name: 'Use at the till' }).waitFor({ timeout: 15_000 })
          await page.waitForSelector('text=The till pays with your dollars.', { timeout: 15_000 })
          await page.waitForTimeout(300)
        })
      })
    },
  },
  {
    name: 'till-dollars-quoted',
    route: '/account',
    expect: { navReachable: true },
    prepare: async (page) => {
      await dollarsTill(page, async () => {
        await quoteDollars(page)
      })
    },
  },
  {
    // Card 1 of 2, paid in dollars and released by Lit: no countdown, since it stays on the phone for its 48 hours.
    name: 'till-dollars-scan-1',
    route: '/account',
    expect: { navReachable: false, barcodeStable: true, wakeLock: true },
    prepare: async (page) => {
      await dollarsTill(page, async () => {
        await payDollars(page)
      })
    },
  },
  {
    name: 'till-dollars-scan-2',
    route: '/account',
    expect: { navReachable: false, barcodeStable: true, wakeLock: true },
    prepare: async (page) => {
      await dollarsTill(page, async () => {
        await payDollars(page)
        await page.getByRole('button', { name: 'Scanned · next' }).click()
        await page.waitForSelector('text=Scan 2 of 2', { timeout: 15_000 })
        await page.waitForSelector('.barcode', { timeout: 10_000 })
        await page.waitForTimeout(400)
      })
    },
  },
  {
    // Done: what it came to, and the $3.87 deposit that comes back when the next shopper uses the rest.
    name: 'till-dollars-done',
    route: '/account',
    prepare: async (page) => {
      await dollarsTill(page, async () => {
        await payDollars(page)
        await page.getByRole('button', { name: 'Scanned · next' }).click()
        await page.waitForSelector('text=Scan 2 of 2', { timeout: 15_000 })
        await page.getByRole('button', { name: 'Done', exact: true }).click()
        await page.waitForSelector('text=Paid $26.92', { timeout: 15_000 })
        await page.waitForTimeout(300)
      })
    },
  },
  {
    /*
      "REGISTER SAYS PAID" IN DOLLARS, after card 1. Card 2 was paid at the
      tap and never scanned, so it is the shopper's store credit now (its
      $3.87 rest bought out of its deposit): said on the receipt, and what it
      cost said apart from what the register took, never as paid for it.
    */
    name: 'till-dollars-register-paid',
    route: '/account',
    prepare: async (page) => {
      await dollarsTill(page, async () => {
        await payDollars(page)
        await page.getByRole('button', { name: 'Register says paid' }).click()
        await page.waitForSelector('text=Card 2 was not scanned. Its $16.00 is in your store credit now.', { timeout: 20_000 })
        await page.waitForSelector('text=You also paid $14.40 for store credit.', { timeout: 10_000 })
        await page.waitForTimeout(300)
      })
    },
  },
  {
    /*
      "IT DIDN'T SCAN" IN DOLLARS. The card was paid at the tap, so the
      report holds its seller's payment for them to refund, said in the
      till's words, and the rest is priced again at once.
    */
    name: 'till-dollars-declined',
    route: '/account',
    prepare: async (page) => {
      await dollarsTill(page, async () => {
        await payDollars(page)
        await restockDollars()
        await page.getByRole('button', { name: DIDNT_SCAN_LABEL }).click()
        await page.getByRole('button', { name: 'The register declined it' }).click()
        await page.waitForSelector('text=That card did not work. Its seller’s payment waits 48 hours, so they can refund you.', { timeout: 15_000 })
        await page.waitForTimeout(300)
      })
    },
  },
  {
    /*
      THE TOTAL CAME DOWN PAST WHAT THE CARD ON SCREEN MAY KEEP. Card 1, the
      $20 card, would be left with $10 on it, past Target's $5 cap: it must
      not be scanned, and the way on is other cards for the new total.
    */
    name: 'till-dollars-too-low',
    route: '/account',
    expect: { navReachable: false },
    prepare: async (page) => {
      await dollarsTill(page, async () => {
        await changeDollarsTotalTo(page, 1_000)
        await page.waitForSelector('text=Do not scan this card', { timeout: 15_000 })
        // On dollars the card is paid for, so the way on is the shopper's credit, not other cards (till-copy.ts tooLowLabel).
        await page.getByRole('button', { name: 'Use it as your store credit' }).waitFor({ timeout: 10_000 })
        await page.waitForTimeout(300)
      })
    },
  },
  {
    // And then not used: paid at the tap, so the card is the shopper's credit now, and pays first.
    name: 'till-dollars-not-used',
    route: '/account',
    prepare: async (page) => {
      await dollarsTill(page, async () => {
        await changeDollarsTotalTo(page, 1_000)
        await page.getByRole('button', { name: 'Use it as your store credit' }).click()
        // The $10.00 is covered by that credit at no cost, so it pays at once, said as that (till-copy.ts CREDIT_PAYS_REST).
        await page.waitForSelector('text=This card is your store credit now, and it pays what is left.', { timeout: 20_000 })
        await page.waitForTimeout(300)
      })
    },
  },
  {
    // The dollars cannot cover this total and the card can: the other way, with its price, one tap away.
    name: 'till-dollars-card-instead',
    route: '/account',
    // The dollars quote's "nothing at this total" is a 409 by design (api/escrow/quote): the answer under test.
    httpError: 409,
    prepare: async (page) => {
      await dollarsTill(page, async () => {
        await page.getByRole('button', { name: 'Delete' }).waitFor({ timeout: 15_000 })
        await typeTotal(page, TILL_FIXTURE_TOTAL_CENTS)
        await page.waitForSelector('text=Pay by card instead', { timeout: 15_000 })
        await page.waitForTimeout(300)
      }, { card: true })
    },
  },
  {
    // Selling on the new escrow: the seller account first, one Face ID, nothing sent.
    name: 'sell-v2-setup',
    route: '/sell',
    prepare: async (page) => {
      await requireRail(page)
      await freshDevice(page)
      await withDollars(page, async () => {
        await page.getByRole('button', { name: 'Crypto' }).click()
        await page.getByRole('heading', { name: 'Your seller account' }).waitFor({ timeout: 15_000 })
        await page.waitForTimeout(300)
      })
    },
  },
  {
    // The new escrow's form: a card sells in parts, and the seller is paid for each part and for what is left.
    name: 'sell-v2-form',
    route: '/sell',
    prepare: async (page) => {
      await requireRail(page)
      await withDollars(page, async () => {
        await ensureSellerV2(page)
        await page.waitForTimeout(300)
      })
    },
  },
  {
    // A card listed on the new escrow, through the real form: sealed here, listed on chain, recorded, and its row.
    name: 'sell-v2-listed',
    route: '/sell',
    // "Not final on the chain yet" is a 409 the page asks past (api/escrow/listings), part of listing.
    httpError: 409,
    prepare: async (page) => {
      await requireRail(page)
      await withDollars(page, async () => {
        await ensureSellerV2(page)
        await page.getByRole('button', { name: 'Get test dollars' }).click()
        await page.waitForSelector('text=Your test dollars', { timeout: 15_000 })
        // A new test card each time: a card listed once is never listed again, on either escrow.
        await fillEscrowSale(page, '20', freshTestCardNumber())
        await page.getByRole('button', { name: 'Seal it and list it' }).click()
        await page.waitForSelector('text=Your cards for sale', { timeout: 30_000 })
        await page.waitForSelector('text=Take it back any time before it sells.', { timeout: 15_000 })
        await page.waitForTimeout(300)
      })
    },
  },
  /*
    THE FIRST ESCROW'S /sell, as it shows while the new escrow is not open
    here (the first fixture world's config has no V2 block). Once V2 is open,
    the sell-v2 states above are what a seller sees, with these listings
    below them.
  */
  {
    name: 'sell-escrow-setup',
    route: '/sell',
    prepare: async (page) => {
      await requireRail(page)
      await freshDevice(page)
      await page.getByRole('button', { name: 'Crypto' }).click()
      await page.getByRole('heading', { name: 'Your seller account' }).waitFor({ timeout: 15_000 })
    },
  },
  {
    /*
      LISTING CLOSED, SAID BEFORE ANY FIELD. The config says our server takes
      no listings (today's custody guard), so the page says so and shows no
      card field at all.
    */
    name: 'sell-escrow-closed',
    route: '/sell',
    prepare: async (page) => {
      await requireRail(page)
      const closed = { ...configBody(await fixtureWorld()), listingOpen: false }
      await overriding(page, '**/api/escrow/config', (r) => json(r, closed), async () => {
        await reloadSettled(page)
        await page.getByRole('button', { name: 'Crypto' }).click()
        await page.waitForSelector('text=Selling for test dollars is not open yet.', { timeout: 15_000 })
        await page.waitForTimeout(300)
      })
    },
  },
  {
    name: 'sell-escrow-form',
    route: '/sell',
    prepare: async (page) => {
      await ensureSeller(page)
      // No sponsor in the fixture, so the page shows the dollars it pays fees from.
      await page.waitForSelector('text=$250.00', { timeout: 15_000 })
      await page.waitForTimeout(300)
    },
  },
  {
    /*
      SEALING, MID-FLIGHT. The escrow's code read is held, so "Checking the
      escrow" stays up. The phone's own read timeout is ten seconds, longer
      than a measure takes.
    */
    name: 'sell-escrow-checking',
    route: '/sell',
    prepare: async (page) => {
      await ensureSeller(page)
      await fillEscrowSale(page, '20')
      const holdCodeRead = (r: Route) => {
        const method = (JSON.parse(r.request().postData() ?? '{}') as { method?: unknown }).method
        if (method === 'eth_getCode') holdRequest(r)
        else return r.fallback()
      }
      await overriding(page, isChainHost, holdCodeRead, async () => {
        await page.getByRole('button', { name: 'Seal it and list it' }).click()
        await page.waitForSelector('text=Checking the escrow', { timeout: 10_000 })
      })
    },
  },
  {
    // A new seller's card over $25: refused before anything is sealed or sent.
    name: 'sell-escrow-refused',
    route: '/sell',
    prepare: async (page) => {
      await ensureSeller(page)
      await fillEscrowSale(page, '40')
      await page.getByRole('button', { name: 'Seal it and list it' }).click()
      await page.waitForSelector('text=New sellers can list cards up to $25 here.', { timeout: 15_000 })
      await page.waitForTimeout(300)
    },
  },
  {
    // The seller's own rows, one hidden and listed, one sold, each as the chain says.
    name: 'sell-escrow-listings',
    route: '/sell',
    prepare: async (page) => {
      await ensureSeller(page)
      await seedDevice(page, sellerListingsSeed)
      await ensureSeller(page)
      await page.waitForSelector('text=Your cards for Salvo Pay', { timeout: 15_000 })
      await page.waitForSelector('text=Please do not use this card now.', { timeout: 15_000 })
      await page.waitForTimeout(300)
    },
  },
]

/** Load a state and wait until the client has decided what to render. */
export async function enter(page: Page, base: string, state: UiState): Promise<string | null> {
  await page.goto(base + state.route, { waitUntil: 'domcontentloaded' })
  // A spinner state's held calls belonged to the page just left; let them go now.
  await releaseHeldRequests()
  await page.waitForSelector('h1', { timeout: 15_000 })
  await page.waitForTimeout(400)
  if (state.prepare === undefined) return null
  try {
    await state.prepare(page)
    return null
  } catch (err) {
    return err instanceof Error ? (err.message.split('\n')[0] ?? 'failed') : String(err)
  }
}
