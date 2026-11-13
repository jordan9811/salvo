'use client'

/**
 * The till (unified-account spec 4): type the total, tap Pay once, scan
 * "1 of 2", tap Next, scan "2 of 2", Done.
 *
 * ===========================================================================
 * WHAT IS NEVER ON THIS SCREEN: the card processor's name, a camera, and a
 * field to type a card number. A code that will not scan gets the other kind
 * of barcode, then a new plan; never a number to key in.
 *
 * CARD 2 IS DRAWN ONLY AFTER NEXT. The phone holds one code at a time, and
 * the server opens the next only when the shopper says the last one scanned.
 *
 * NOTHING LEADS AWAY WHILE PAY IS GOING THROUGH. Pay opens card 1 before it
 * answers, and at a store nobody can check, silence counts as used. So the
 * paying beat is marked live, as a code is (globals.css `data-live`): no
 * link off the page while a code may be opening that nobody would see. The
 * same while "Check it" asks what an unfinished Pay did: it can open a code
 * too. And Pay is off until that check has an answer.
 *
 * A CARD THAT MUST NOT BE SCANNED IS NOT DRAWN. When the total comes down
 * past what can stay on the card on screen, its barcode and countdown go,
 * and the heading says not to scan it. "The total changed" stays under it:
 * a mistyped total is put right there, rather than reporting the card.
 * ===========================================================================
 *
 * ONE TILL, BOTH RAILS. It pays the way the account says (spec 3.3): the
 * shopper's own choice while that way is set up; otherwise whichever is, and
 * dollars when both are ("default to stablecoins"). When that way cannot pay
 * this total and the other can, a second button says so with its price
 * ("Pay by card instead · $48.30"), and one tap switches for this visit.
 * Store credit is never stranded: only the dollars rail pays from it, so
 * while the till pays by card and the shopper's credit here covers the
 * total, that button offers it ("Use your store credit instead"), and a
 * plan it pays in full is offered whatever the dollars balance says. That
 * tap switches for one purchase, never the visit: "Pay again" is back on the
 * shopper's own way, and so is a total typed past what the credit covers.
 * The shopper's settings (how it picks cards, how many, store credit first)
 * come from this phone's store, as the account page keeps them; a phone that
 * keeps nothing uses the defaults.
 *
 * EVERY MOVE GOES TO THE RAIL IT BELONGS TO, AND THE RAIL CHANGES ONLY ON AN
 * IDLE KEYPAD (use-till.ts says why). A shopper who never chose waits to Pay
 * until both ways have answered once: the till used to start on the card and
 * switch to dollars under a purchase already on screen.
 */

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { candidatesFor } from '@/lib/barcode/symbology'
import { demoHref } from '@/lib/demo'
import { openCardStore } from '@/lib/escrow/client/card-store'
import { deviceSettings, rememberTillStore } from '@/lib/account/client/settings'
import { routeOf, tillRail } from '@/lib/account/settings'
import { DEFAULT_ROUTE_PREFERENCE, type RoutePreference } from '@/lib/route/plan'
import { backendFor } from '@/lib/till/client/backend'
import type { LegCode, PaymentMethod, Purchase, PurchaseHandle, Rail, RoutePlan, TillBackend, TillReceipt } from '@/lib/till/types'
import { AppBar } from '../../app-bar'
import { STEP_LABEL, SYMBOLOGY_NAME, barcodeSvg } from '../../barcode-card'
import { useWakeLock } from '../../use-wake-lock'
import {
  CHANGE_STORE,
  CHECK_AGAIN,
  CHECK_LAST_PAY_FIRST,
  DIDNT_SCAN,
  DO_NOT_SCAN,
  DONE,
  FINISH_OPEN_FIRST,
  NEXT,
  NO_PRICE,
  OTHER_STORES,
  PAYING,
  REGISTER_PAID,
  SAMPLE_PURCHASE,
  SHEET,
  SHOW_LAST_PAY,
  SHOW_OPEN,
  SILENCE_LINE,
  SOMETHING_WRONG,
  START_AGAIN,
  TOO_LOW_CREDIT,
  TYPE_TOTAL,
  alsoPaidLine,
  costsNothing,
  coversLine,
  creditDollarsOnly,
  depositBackLine,
  depositLine,
  dollars,
  doneLine,
  keptBackLine,
  nothingListed,
  previewLine,
  nothingThisWay,
  openPurchaseLine,
  otherRailLabel,
  owedLine,
  payLabel,
  payMoreLabel,
  pricingLabel,
  saveLine,
  scanTitle,
  scannedPayMoreLabel,
  stillOwedLine,
  stillOwedTitle,
  thenLine,
  tooLowLabel,
  unfinishedPayLine,
} from '../till-copy'
import { TillHelp } from '../till-help'
import { TILL_STORES, tillPath } from '../stores'
import { Keypad } from './keypad'
import {
  NO_SWITCH,
  creditMayPay,
  endOnce,
  onceOutgrown,
  otherWayPlan,
  payBlockedBy,
  payDisabled,
  switchTo,
  switchedRail,
  useTill,
  type RailSwitch,
} from './use-till'

/** The shopper's own settings on this phone: how the till picks cards, and the way they pay, if they chose one. */
function useDeviceRoute(store: string): { preference: RoutePreference; defaultRail: Rail | null; loaded: boolean } {
  const [state, setState] = useState<{ preference: RoutePreference; defaultRail: Rail | null; loaded: boolean }>({
    preference: DEFAULT_ROUTE_PREFERENCE,
    defaultRail: null,
    loaded: false,
  })
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const cards = await openCardStore()
        const { settings } = await deviceSettings(cards)
        if (live) setState({ preference: routeOf(settings), defaultRail: settings.defaultRail, loaded: true })
        // The store this till opened on, for a /pay with none named. Its own
        // slot: written into the settings, it was a choice nobody made, and
        // sign-in then kept it over the account's own settings.
        await rememberTillStore(cards, store)
      } catch {
        // A private window keeps nothing: the defaults stand.
        if (live) setState((s) => ({ ...s, loaded: true }))
      }
    })()
    return () => {
      live = false
    }
  }, [store])
  return state
}

/** How long a rail check that could not be read waits before it is asked again, and how many times. */
const RAIL_RETRY_MS = 5_000
const RAIL_RETRIES = 6

/** What a check that threw says: nothing either way. */
const UNREAD: PaymentMethod = { ready: false, label: '', spendableCents: 0, problem: null, checked: false }

/**
 * The way this till pays (spec 3.3), by the account page's rule
 * (settings.ts tillRail): the shopper's choice while that way can pay, or
 * while it could not be checked; otherwise whichever can, and dollars when
 * both can. A choice whose way definitely cannot pay now (an allowance
 * ended, a card removed) is not held to. A check that could not be read
 * says nothing either way: it is asked again, and the rail is decided again
 * once it answers (the till takes a new rail only on an idle keypad). Until
 * the first answers, the choice, else the card; `pending` while that guess
 * is all there is for a shopper who never chose, so Pay waits for it.
 * `choose` switches for this visit, or for one purchase when the button
 * offered store credit (switchTo); `endOnce` ends a switch for one purchase.
 */
function useTillRail(defaultRail: Rail | null, loaded: boolean, backends: Readonly<Record<Rail, TillBackend>>) {
  const [switched, setSwitched] = useState<RailSwitch>(NO_SWITCH)
  const [answers, setAnswers] = useState<Readonly<Record<Rail, PaymentMethod>> | null>(null)
  useEffect(() => {
    if (!loaded) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    const ask = (b: TillBackend): Promise<PaymentMethod> => b.method().catch(() => UNREAD)
    const round = async (last: Readonly<Record<Rail, PaymentMethod>> | null): Promise<void> => {
      // An answer read once stands; one that could not be read is asked again.
      const [card, stablecoin] = await Promise.all([
        last !== null && last.card.checked ? last.card : ask(backends.card),
        last !== null && last.stablecoin.checked ? last.stablecoin : ask(backends.stablecoin),
      ])
      if (!live) return
      const now = { card, stablecoin }
      setAnswers(now)
      if ((!card.checked || !stablecoin.checked) && tries < RAIL_RETRIES) {
        tries += 1
        timer = setTimeout(() => void round(now), RAIL_RETRY_MS)
      }
    }
    void round(null)
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [loaded, backends])
  const found = answers === null ? null : tillRail(defaultRail, answers)
  const chosen = switchedRail(switched)
  const rail: Rail = chosen ?? found ?? defaultRail ?? 'card'
  const pending = chosen === null && found === null && (!loaded || defaultRail === null)
  const choose = useCallback((to: Rail, plan: RoutePlan | null) => setSwitched((s) => switchTo(s, to, plan)), [])
  const endOnceNow = useCallback(() => setSwitched(endOnce), [])
  return { rail, pending, choose, endOnce: endOnceNow }
}

/**
 * How much store credit the shopper holds at this store on this phone, in
 * cents. The card rail does not pay from it, and says so; and while it could
 * cover the total typed, the till asks the dollars rail, which does.
 */
function useCreditCents(store: string): number {
  const [cents, setCents] = useState(0)
  useEffect(() => {
    let live = true
    void openCardStore()
      .then((s) => s.ownCards())
      .then((own) => {
        if (live) setCents(own.reduce((n, o) => n + (o.merchant === store && o.balanceCents > 0 ? o.balanceCents : 0), 0))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [store])
  return cents
}

export function TillClient({ store, storeName }: { store: string; storeName: string }) {
  const { preference, defaultRail, loaded } = useDeviceRoute(store)
  const backends = useMemo(() => ({ card: backendFor('card'), stablecoin: backendFor('stablecoin') }), [])
  const { rail, pending, choose, endOnce: onOnceOver } = useTillRail(defaultRail, loaded, backends)
  const creditCents = useCreditCents(store)
  return (
    <>
      <AppBar current="pay" />
      <main className="wrap till" data-task id="content" tabIndex={-1}>
        <Till
          store={store}
          storeName={storeName}
          backends={backends}
          rail={rail}
          railPending={pending}
          onSwitch={choose}
          onOnceOver={onOnceOver}
          preference={preference}
          creditCents={creditCents}
        />
      </main>
    </>
  )
}

/**
 * The other way's price for the total typed, asked only while this way
 * cannot pay it, or while the shopper's store credit could (creditMayPay).
 * Kept when that way can pay, or when the plan costs it nothing: store
 * credit that covers the total is never stranded by an empty dollars
 * balance (otherWayPlan). Null while there is none, or it is not asked.
 */
/** The other way's price while it cannot pay yet: shown with what it is waiting on, never offered. */
interface OtherPreview {
  plan: RoutePlan
  problem: string
}

function useOtherPrice(input: { backend: TillBackend; store: string; cents: number; preference: RoutePreference; ask: boolean }): { plan: RoutePlan | null; preview: OtherPreview | null } {
  const { backend, store, cents, preference, ask } = input
  const [plan, setPlan] = useState<RoutePlan | null>(null)
  const [preview, setPreview] = useState<OtherPreview | null>(null)
  const asked = useRef(0)
  useEffect(() => {
    setPlan(null)
    setPreview(null)
    if (!ask || cents <= 0) return
    const n = ++asked.current
    const t = setTimeout(() => {
      void Promise.all([backend.method(), backend.quote({ merchant: store, totalCents: cents, preference })])
        .then(([m, out]) => {
          if (n !== asked.current) return
          const offered = otherWayPlan(m, out)
          setPlan(offered)
          // A price this phone cannot take yet: said, with the one step in its way.
          setPreview(offered === null && !('unavailable' in out) && !m.ready && m.problem ? { plan: out, problem: m.problem } : null)
        })
        .catch(() => undefined)
    }, 300)
    return () => clearTimeout(t)
  }, [backend, store, cents, preference, ask])
  return { plan, preview }
}

function Till({
  store,
  storeName,
  backends,
  rail,
  railPending,
  onSwitch,
  onOnceOver,
  preference,
  creditCents,
}: {
  store: string
  storeName: string
  /** Both ways to pay: each move goes to the rail it belongs to. */
  backends: Readonly<Record<Rail, TillBackend>>
  /** The way the account says to pay now; the keypad takes it up when idle. */
  rail: Rail
  railPending: boolean
  /** Switch to the other way: for this visit, or for one purchase when the button offers store credit (switchTo). */
  onSwitch: (rail: Rail, plan: RoutePlan | null) => void
  /** A switch for one purchase is over: its purchase ended, or the total outgrew the credit. */
  onOnceOver: () => void
  preference: RoutePreference
  /** Store credit here, on this phone, in cents: the card rail says it does not use it, and offers the dollars rail when it covers the total. */
  creditCents: number
}) {
  const t = useTill({ store, backends, rail, railPending, preference })
  useWakeLock(t.phase.kind === 'scan')
  const free = costsNothing(t.plan)
  const hasCredit = creditCents > 0
  // Never while a key is kept: that Pay belongs to its own rail, and a tap on the other paid a second time.
  const idleKeypad = t.phase.kind === 'keypad' && t.unfinished === null && t.keptPay === null
  const cannot = idleKeypad && (t.quote.kind === 'unavailable' || (payBlockedBy(t.method) && !free))
  // Paying by card, with store credit here that could cover the total: only dollars pay from it, so their price is asked too.
  const creditCould = idleKeypad && !cannot && creditMayPay({ rail: t.rail, cents: t.cents, creditCents })
  const other: Rail = t.rail === 'card' ? 'stablecoin' : 'card'
  const { plan: otherPlan, preview: otherPreview } = useOtherPrice({ backend: backends[other], store, cents: t.cents, preference, ask: cannot || creditCould })
  /**
   * The other way is the way on: it has a price for this total while this way
   * has none, or the shopper's own store credit pays all of it at no cost
   * while the card would be charged.
   */
  const otherWay = otherPlan !== null && (cannot || (creditCould && costsNothing(otherPlan)))
  // "Use your store credit instead" was for a total the credit covers: typed past it, the till goes back to its own way.
  const outgrown = onceOutgrown({ idle: idleKeypad, cents: t.cents, creditCents })
  useEffect(() => {
    if (outgrown) onOnceOver()
  }, [outgrown, onOnceOver])
  /** "Pay again", "Start again": the purchase is over, and so is a switch made for it alone. */
  const startOver = () => {
    onOnceOver()
    t.startOver()
  }

  if (t.phase.kind === 'scan') {
    return (
      <ScanScreen
        purchase={t.phase.purchase}
        code={t.phase.code}
        then={t.phase.then}
        tooLow={t.phase.tooLow}
        notNeeded={t.phase.notNeeded}
        note={t.phase.note ?? null}
        busy={t.busy}
        error={t.error}
        onNext={t.next}
        onDone={t.done}
        onThen={t.scannedThenPay}
        onReport={t.report}
        onChangeTotal={t.changeTotal}
      />
    )
  }

  if (t.phase.kind === 'owed') {
    const owed = t.phase.owed
    return (
      // Live while its Pay goes through: that Pay opens a code too.
      <section className="reveal" aria-label="Still to pay" {...(t.busy ? { 'data-live': '' } : {})}>
        <h1>{storeName}</h1>
        <p className="sub">{t.phase.line ?? owedLine(t.phase.why, t.phase.kept, t.phase.purchase.rail)}</p>
        {t.phase.note && <p className="hint">{t.phase.note}</p>}
        {t.error && (
          <p className="err" role="alert">
            {t.error}
          </p>
        )}
        <button className="btn btn--primary btn--block" disabled={t.busy} onClick={() => void t.payOwed()}>
          {payMoreLabel(owed)}
        </button>
        {depositLine(owed) && <p className="hint mt-2">{depositLine(owed)}</p>}
      </section>
    )
  }

  if (t.phase.kind === 'uncovered') {
    // The register still needs money and nothing on sale covers it: said as
    // that, never under a receipt's "Paid", and never as a payment.
    return (
      <section aria-label="Still to pay">
        <h1>{stillOwedTitle(t.phase.owedCents)}</h1>
        <p className="sub">{t.phase.line ?? owedLine(t.phase.why, t.phase.kept, t.phase.purchases[0]?.rail ?? t.rail)}</p>
        {t.phase.note && <p className="hint">{t.phase.note}</p>}
        <p className="hint">{stillOwedLine(t.receipt, t.phase.purchases[0]?.rail ?? t.rail)}</p>
        {alsoPaidLine(t.receipt) && <p className="hint">{alsoPaidLine(t.receipt)}</p>}
        <button className="btn btn--primary btn--block mt-4" onClick={startOver}>
          {START_AGAIN}
        </button>
        <HelpToggle purchases={t.phase.purchases} onReport={t.reportAfter} />
      </section>
    )
  }

  if (t.phase.kind === 'done') {
    return <DoneScreen purchases={t.phase.purchases} receipt={t.receipt} notice={t.notice} error={t.error} onReport={t.reportAfter} onAgain={startOver} />
  }

  // The keypad: typing, and the one tap.
  const paying = t.phase.kind === 'paying'
  // Pay going through, or "Check it" asking what an unfinished one did: either can open a code.
  const live = paying || t.busy
  // A kept key's plan while one is kept: the next tap sends it again.
  const plan = t.plan
  // Still finding which way it pays: the price on screen may be the other way's, so it is not offered yet.
  const waiting = railPending && t.keptPay === null
  const nothing = t.quote.kind === 'unavailable' && t.quote.nothingListed
  // Said below with Account, so the reason under the button never says it twice ("Allow this phone to pay with dollars").
  const problem = !free && t.method?.ready === false && t.method.problem ? t.method.problem : null
  return (
    <section className="reveal" aria-label={`Pay at ${storeName}`} {...(live ? { 'data-live': '' } : {})}>
      <StoreHead store={store} storeName={storeName} disabled={live} />
      {t.unfinished && !paying && (
        <div className="notice" role="status">
          {t.unfinished.open ? openPurchaseLine(storeName, t.unfinished.open) : unfinishedPayLine(storeName, t.unfinished.plan)}{' '}
          <button type="button" className="textlink" disabled={t.busy} onClick={() => void t.resumeUnfinished()}>
            {t.unfinished.open ? SHOW_OPEN : SHOW_LAST_PAY}
          </button>
        </div>
      )}
      {t.notice && (
        <p className="notice" role="status">
          {t.notice}
        </p>
      )}
      <p className="till__total num" aria-live="polite">
        {dollars(t.cents)}
      </p>
      <Keypad cents={t.cents} onChange={t.setCents} disabled={paying} />
      {t.error && (
        <p className="err" role="alert">
          {t.error}
        </p>
      )}
      <button
        className={paying ? 'btn btn--primary btn--block is-working' : 'btn btn--primary btn--block'}
        disabled={payDisabled({ paying, busy: t.busy, plan, method: t.method, unfinished: t.unfinished !== null, railPending: waiting })}
        onClick={() => void t.pay()}
      >
        {paying ? (
          <>
            <span className="spinner" aria-hidden="true" />
            {PAYING}
          </>
        ) : plan && !waiting ? (
          payLabel(plan)
        ) : t.quote.kind === 'loading' || (waiting && t.cents > 0) ? (
          pricingLabel(t.cents)
        ) : t.quote.kind === 'unavailable' ? (
          NO_PRICE
        ) : (
          TYPE_TOTAL
        )}
      </button>
      {t.unfinished && !paying && <p className="hint mt-2">{t.unfinished.open ? FINISH_OPEN_FIRST : CHECK_LAST_PAY_FIRST}</p>}
      {plan && <p className="hint mt-2">{saveLine(plan, t.method)}</p>}
      {plan && depositLine(plan) && <p className="hint">{depositLine(plan)}</p>}
      {/* The card rail plans on our server, which never sees the shopper's own cards: said, so "store credit first" is never a promise it breaks. */}
      {t.rail === 'card' && hasCredit && <p className="hint mt-2">{creditDollarsOnly(storeName)}</p>}
      {/* The other way has a price this phone cannot take yet: the price, and the one step in its way, in place of "nothing here". */}
      {!plan && otherPreview !== null && (
        <>
          <p className="hint mt-2">{previewLine(other, otherPreview.plan)}</p>
          <p className="notice mt-4">
            {otherPreview.problem}{' '}
            <Link className="textlink" href="/account">
              Account
            </Link>
          </p>
        </>
      )}
      {!plan && otherPreview === null && t.quote.kind === 'unavailable' && (nothing || t.quote.message !== problem) && (
        <p className="hint mt-2">{nothing ? (otherWay ? nothingThisWay(t.rail, storeName) : nothingListed(storeName)) : t.quote.message}</p>
      )}
      {/* Production lists nothing yet: the sample purchase is how anyone sees the rest. Not while the other way has a price: that is the way on. */}
      {!plan && nothing && !otherWay && otherPreview === null && (
        <Link className="textlink textlink--tap mt-2" href={demoHref(store, t.cents)} prefetch>
          {SAMPLE_PURCHASE}
        </Link>
      )}
      {!free && t.method?.ready === false && t.method.problem && (
        <p className="notice mt-4">
          {t.method.problem}{' '}
          {t.method.checked ? (
            <Link className="textlink" href="/account">
              Account
            </Link>
          ) : (
            <button type="button" className="textlink" onClick={t.checkMethod}>
              {CHECK_AGAIN}
            </button>
          )}
        </p>
      )}
      {otherWay && (
        <button type="button" className="btn btn--primary btn--block mt-4" onClick={() => onSwitch(other, otherPlan)}>
          {otherRailLabel(other, otherPlan)}
        </button>
      )}
    </section>
  )
}

/**
 * The store's name, and Change: the other stores, one tap each (spec 0,
 * step 1). Never a search, and never a page of its own: the shopper is at a
 * register. Each is a link to that store's till, so the address bar and the
 * back button say where they are.
 */
function StoreHead({ store, storeName, disabled }: { store: string; storeName: string; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="till__head">
        <h1 className="till__store">{storeName}</h1>
        <button
          type="button"
          className="textlink textlink--tap"
          disabled={disabled}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {CHANGE_STORE}
        </button>
      </div>
      {open && (
        <nav className="cluster mt-3" aria-label={OTHER_STORES}>
          {TILL_STORES.filter((s) => s.id !== store).map((s) => (
            <Link key={s.id} className="choice" href={tillPath(s.id)}>
              {s.name}
            </Link>
          ))}
        </nav>
      )}
    </>
  )
}

/** A code window longer than this is not counted down on screen. */
const COUNTDOWN_MAX_S = 15 * 60

/** Seconds left on a code's window, ticking. */
function useSecondsLeft(expiresAt: string): number {
  const end = new Date(expiresAt).getTime()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [expiresAt])
  return Math.max(0, Math.round((end - now) / 1000))
}

function ScanScreen({
  purchase,
  code,
  then,
  tooLow,
  notNeeded,
  note,
  busy,
  error,
  onNext,
  onDone,
  onThen,
  onReport,
  onChangeTotal,
}: {
  purchase: Purchase
  code: LegCode
  /** The total went up: the plan for the rest, paid once this card has scanned. */
  then: RoutePlan | null
  /** The total came down past what can stay on this card: it must not be scanned. */
  tooLow: boolean
  /** Too low, and the cards before it cover the new total: Done, not other cards. */
  notNeeded: boolean
  /** Why this card is on screen, when that is not plain: a card not used, now store credit, paying the rest. */
  note: string | null
  busy: boolean
  error: string | null
  onNext: () => Promise<void>
  onDone: () => Promise<void>
  onThen: () => Promise<void>
  onReport: (o: 'didnt_scan' | 'declined' | 'not_used') => Promise<void>
  onChangeTotal: (cents: number) => Promise<void>
}) {
  const [sheet, setSheet] = useState<'none' | 'didnt_scan' | 'total'>('none')
  const [alt, setAlt] = useState(0)
  const [newTotal, setNewTotal] = useState(0)
  const seconds = useSecondsLeft(code.expiresAt)
  const last = code.scanIndex >= code.scanOf

  // A new code starts on its first format.
  useEffect(() => {
    setAlt(0)
    setSheet('none')
  }, [code.barcode, code.scanIndex])

  // The store's own 2D code first, where it has one; then the 1D formats.
  const formats = useMemo(() => {
    const lines = candidatesFor(code.barcode).map((sym) => ({
      key: sym as string,
      name: SYMBOLOGY_NAME[sym],
      draw: () => barcodeSvg(sym, code.barcode),
    }))
    return code.pdf417 === null ? lines : [{ key: 'pdf417', name: 'PDF417', draw: () => code.pdf417 ?? '' }, ...lines]
  }, [code.barcode, code.pdf417])
  const shown = formats[alt % Math.max(1, formats.length)]
  // BUILT ONCE PER FORMAT, NOT ONCE PER RENDER: a fresh `{ __html }` each
  // countdown tick had React write the same SVG back every second, a new
  // <svg> node under the scanner each time (the reveal page's rule, its
  // reveal-client.tsx "THE BARCODES ARE BUILT ONCE PER PAYLOAD").
  const html = useMemo(() => {
    try {
      return { __html: shown ? shown.draw() : '' }
    } catch {
      return { __html: '' }
    }
  }, [shown])

  return (
    <section className="reveal till__scan" aria-label={tooLow ? DO_NOT_SCAN : scanTitle(code.scanIndex, code.scanOf)} data-live="">
      <h1 className="till__scan-title">{tooLow ? DO_NOT_SCAN : scanTitle(code.scanIndex, code.scanOf)}</h1>
      {note && !tooLow && <p className="notice">{note}</p>}
      {tooLow && !notNeeded && purchase.rail === 'stablecoin' && <p className="sub">{TOO_LOW_CREDIT}</p>}
      {!tooLow && (
        <>
          <p className="sub">{coversLine(code)}</p>
          <figure className="barcode" key={shown?.key}>
            <div className="barcode__svg" dangerouslySetInnerHTML={html} />
            <figcaption>
              {STEP_LABEL[alt === 0 ? 0 : Math.min(alt, STEP_LABEL.length - 1)]}
              <span className="barcode__sym">{shown?.name}</span>
            </figcaption>
          </figure>
          {/* A short window (the card rail's 90 seconds) is counted down. A card paid for in dollars is on the phone for its 48 hours: no clock. */}
          {seconds <= COUNTDOWN_MAX_S && (
            <p className={seconds <= 10 ? 'countdown countdown--soon' : 'countdown'}>
              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
            </p>
          )}
          {code.silenceIsSale && <p className="countdown__note">{SILENCE_LINE}</p>}
        </>
      )}
      {then && !tooLow && <p className="hint">{thenLine(then)}</p>}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}

      {sheet === 'none' && tooLow && (
        // Not to be scanned. The way on is the rest of the new total, or Done
        // when the cards before it already cover it: either way the card is
        // reported not used, never settled as worked. By card, other cards
        // pay the rest. In dollars the card was paid for: it becomes the
        // shopper's store credit and pays the rest first, said as that, so
        // the button never promises other cards and shows this one. Or the
        // total was typed wrong: "The total changed" again, which revised
        // nothing on the card, so the right total is planned as if the wrong
        // one never was.
        <>
          <button className="btn btn--primary btn--block mt-3" disabled={busy} onClick={() => void onReport('not_used')}>
            {notNeeded ? DONE : tooLowLabel(purchase.rail)}
          </button>
          <div className="cluster mt-3">
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => {
                setNewTotal(purchase.plan.totalCents)
                setSheet('total')
              }}
            >
              {SHEET.totalChanged}
            </button>
          </div>
        </>
      )}

      {sheet === 'none' && !tooLow && (
        <>
          <button
            className="btn btn--primary btn--block mt-3"
            disabled={busy}
            onClick={() => void (then ? onThen() : last ? onDone() : onNext())}
          >
            {then ? scannedPayMoreLabel(then) : last ? DONE : NEXT}
          </button>
          <div className="cluster mt-3">
            <button className="btn btn--ghost" disabled={busy} onClick={() => setSheet('didnt_scan')}>
              {DIDNT_SCAN}
            </button>
            {(!last || then) && (
              <button className="btn btn--ghost" disabled={busy} onClick={() => void onDone()}>
                {REGISTER_PAID}
              </button>
            )}
          </div>
        </>
      )}

      {sheet === 'didnt_scan' && (
        <div className="till__sheet" role="group" aria-label={SHEET.title}>
          <p className="sub mb-2">{SHEET.title}</p>
          <button
            className="btn btn--secondary btn--block"
            disabled={busy}
            onClick={() => {
              setAlt((a) => a + 1)
              setSheet('none')
            }}
          >
            {SHEET.tryAgain}
          </button>
          <p className="hint">{SHEET.tryAgainHint}</p>
          <button className="btn btn--secondary btn--block mt-2" disabled={busy} onClick={() => void onReport('declined')}>
            {SHEET.declined}
          </button>
          {alt > 0 && (
            <button className="btn btn--secondary btn--block mt-2" disabled={busy} onClick={() => void onReport('didnt_scan')}>
              {SHEET.stillNot}
            </button>
          )}
          <button
            className="btn btn--secondary btn--block mt-2"
            disabled={busy}
            onClick={() => {
              setNewTotal(purchase.plan.totalCents)
              setSheet('total')
            }}
          >
            {SHEET.totalChanged}
          </button>
          <button className="btn btn--ghost btn--block mt-2" onClick={() => setSheet('none')}>
            {SHEET.close}
          </button>
        </div>
      )}

      {sheet === 'total' && (
        <div className="till__sheet" role="group" aria-label={SHEET.newTotal}>
          <p className="sub mb-2">{SHEET.newTotal}</p>
          <p className="till__total num">{dollars(newTotal)}</p>
          <Keypad cents={newTotal} onChange={setNewTotal} disabled={busy} />
          <button
            className="btn btn--primary btn--block"
            disabled={busy || newTotal <= 0}
            onClick={() => void onChangeTotal(newTotal).then(() => setSheet('none'))}
          >
            {SHEET.apply}
          </button>
          <button className="btn btn--ghost btn--block mt-2" onClick={() => setSheet('none')}>
            {SHEET.close}
          </button>
        </div>
      )}
    </section>
  )
}

function DoneScreen({
  purchases,
  receipt,
  notice,
  error,
  onReport,
  onAgain,
}: {
  purchases: PurchaseHandle[]
  receipt: TillReceipt
  /** What the receipt says beside its sums: a card not in store credit yet, say. */
  notice: string | null
  error: string | null
  onReport: (p: PurchaseHandle, scanIndex: number, o: 'empty' | 'problem') => Promise<string>
  onAgain: () => void
}) {
  return (
    <section aria-label="Paid">
      <h1>{doneLine(receipt)}</h1>
      {alsoPaidLine(receipt) && <p className="sub">{alsoPaidLine(receipt)}</p>}
      {depositBackLine(receipt) && <p className="sub">{depositBackLine(receipt)}</p>}
      {keptBackLine(receipt) && <p className="sub">{keptBackLine(receipt)}</p>}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn--primary btn--block mt-4" onClick={onAgain}>
        Pay again
      </button>
      <HelpToggle purchases={purchases} onReport={onReport} />
    </section>
  )
}

/** "Something went wrong?", opened on a tap. The same sheet Account opens for 48 hours. */
function HelpToggle({
  purchases,
  onReport,
}: {
  purchases: readonly PurchaseHandle[]
  onReport: (p: PurchaseHandle, scanIndex: number, o: 'empty' | 'problem') => Promise<string>
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="btn btn--ghost btn--block mt-2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {SOMETHING_WRONG}
      </button>
      {open && (
        <>
          <TillHelp purchases={purchases} onReport={onReport} />
          <Link className="textlink textlink--tap mt-2" href="/account">
            Account
          </Link>
        </>
      )}
    </>
  )
}
