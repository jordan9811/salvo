'use client'

/**
 * /account in the browser: one account, whatever it pays with
 * (unified-account spec, sections 3, 4 and 11).
 *
 * ===========================================================================
 * SIGN-IN FINDS THE ACCOUNT BEFORE IT MAKES ONE. Continue with Face ID asks
 * the phone for a Salvo passkey it already has (client/passkey.ts). Only a
 * shopper the phone has none for, and who says so, makes a new one: a
 * cancelled sheet and an empty one look the same, and guessing "new" there
 * is how a second account gets made.
 *
 * ONE PAGE, BOTH RAILS. Pay with shows the dollars in Salvo and the saved
 * card side by side, and the till pays with the one marked "Pays at the
 * till": the shopper's choice while it is set up, otherwise whichever is,
 * and dollars when both are (settings.ts effectiveRail, the till's own
 * rule). Dollars count as set up only with a key for the escrow the till
 * pays on (SalvoEscrowV2): a key from the first escrow cannot pay there, so
 * the row asks for the allowance again, one Face ID, rather than tick a rail
 * the till would then refuse. Each row sets itself up from here: the dollars
 * allowance is one Face ID, and a card is the card page, after one Face ID
 * signs this browser in, so the card lands on this account.
 *
 * SETTINGS SAVE AS THEY CHANGE. On this phone first, always; then, for a
 * shopper with a card, a copy on the card customer, so a new Safari tab or
 * Home Screen icon gets them at sign-in. Nothing on this page is a form
 * with a Save button, except store credit, which seals a card.
 *
 * STORE CREDIT STAYS ON THE PHONE, ONE LIST. A card the shopper owns is
 * typed here and sealed here (client/credit.ts); nothing is sent anywhere.
 * The fields clear the moment it is kept. A card the till bought and left
 * theirs is on the same list, once, and the till uses the list first, at no
 * cost, while "Use my store credit first" is on, when it pays with dollars:
 * the card rail plans on our server, which never sees these cards, and the
 * page says so rather than promise it. What is left on a card the till used
 * in part is never on it: that is the seller's, for the next shopper. A card
 * sold back is never on it, nor offered again. Whole cards a phone bought
 * with Salvo Pay on the first escrow are listed here with their codes
 * (/cards redirects here), signed in or not, and a purchase of one that did
 * not finish is finished here, never paid twice. A card the register did not
 * need that the chain has not made credit yet is said, and asked again.
 *
 * DEPOSITS ARE THE CHAIN'S WORD. A deposit the dollars put down on a card's
 * leftover is listed while the chain says it is still held
 * (client/deposits.ts), never from the phone's memory alone.
 *
 * WHAT WAS PAID AT THE TILL, FOR 48 HOURS. Each till purchase is kept on the
 * phone (src/lib/till/client/recent.ts), and listed here with the same
 * "Something went wrong?" the till's last screen has.
 *
 * ONE ACCOUNT ON SCREEN. A browser whose session names one account and whose
 * store keeps another passkey says so, and offers to sign in with the
 * session's, rather than quietly showing the stored one and hiding its card.
 * Taking it forgets the stored account in this browser first, as signing out
 * does: its store credit, settings and purchases never become the other's.
 *
 * THE FIRST ESCROW'S CARDS ARE MATCHED HERE. A card this phone bought on V1
 * before cards carried a fingerprint holds its seller back on V2 at that
 * store until this phone gives our server the card's fingerprint, never the
 * card (client/match-v1.ts). Signed in, that runs as the page opens; not
 * signed in to our server, the page says so and asks for the one Face ID.
 *
 * SIGNING OUT FORGETS THE ACCOUNT IN THIS BROWSER. Not only the session: the
 * passkey record, the dollars keys, the settings, the store credit and the
 * till's purchases go too (passkey.ts signOutHere). It used to clear the
 * cookies alone, on a page sold as the way off someone else's computer: the
 * dollars key went on signing purchases with no prompt, the page still showed
 * the account, and the next person could not sign in as themselves. So it is
 * offered whenever this browser keeps an account, signed in or not, and after
 * it the page loads this phone afresh and is the sign-in, which asks the
 * phone for whichever passkey it offers. The dollars book outlives it, so
 * what it holds is shown only for the account that made it: store credit and
 * deposits are the signed-in account's alone (credit.ts, deposits.ts), and a
 * key in the page's memory is used only while it is this account's.
 *
 * SO DO REMINDERS. "Remind me at…" makes a calendar file on the phone
 * (client/reminder.ts) and hands it to the phone's calendar; no request
 * carries it.
 * ===========================================================================
 *
 * Browser only. Imports no server module, and nothing that reaches the card
 * processor: the card side is fetch only, to our own routes.
 */

import { CopyButton } from '../copy-button'
import { InfoTip } from '../info-tip'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { MERCHANT_BARCODE_PROFILES } from '@/lib/barcode/merchants'
import type { Hex } from 'viem'
import { escrowApi } from '@/lib/escrow/client/api'
import { escrowApiV2 } from '@/lib/escrow/client/api-v2'
import { keyScopedForV2, setUpDeviceWalletV2 } from '@/lib/escrow/client/wallet-v2'
import { openCardStore, type CardRecord, type CardStore, type OwnCardRecord, type PasskeyRecord, type PurchaseRecord } from '@/lib/escrow/client/card-store'
import { LoadPending, LoadRefused, resumePurchase, unfinishedPurchases } from '@/lib/escrow/client/load'
import { openDeviceBookV2, type DeviceBookV2 } from '@/lib/escrow/client/records-v2'
import { SellRefused } from '@/lib/escrow/client/sell'
import { SHOPPER_WEEKLY_LIMIT_UNITS, loadDeviceWallet, requestTestDollars, spendableUnits, type Allowance, type DeviceWallet } from '@/lib/escrow/client/wallet'
import { UNITS_PER_CENT } from '@/lib/escrow/manifest'
import { ESCROW_MERCHANTS, type EscrowMerchantName } from '@/lib/escrow/merchants'
import {
  CREDIT_STORES,
  CreditRefused,
  addOwnCard,
  keepAsCredit,
  keepableCards,
  keepsWaitingV2,
  removeCredit,
  soldBackOf,
  storeCreditList,
  type SoldBackV2,
} from '@/lib/account/client/credit'
import { heldDepositsV2, type HeldDeposit } from '@/lib/account/client/deposits'
import { sellCreditSession, sellOwnCredit } from '@/lib/account/client/sell-credit'
import {
  AccountRefused,
  accountApi,
  continueWithFaceId,
  createAccount,
  dollarBalance,
  ensureSignedIn,
  faceIdCancelled,
  keyOfAccount,
  signOutHere,
  type AccountApi,
  type AccountView,
  type SignInStep,
} from '@/lib/account/client/passkey'
import { CHALLENGE_FRESH_MS, ChallengeKeeper } from '@/lib/account/client/challenge'
import { cardsToMatchV1, matchV1Cards } from '@/lib/account/client/match-v1'
import { reminderFileName, reminderIcs } from '@/lib/account/client/reminder'
import { deviceSettings, restoreSettings, saveDeviceSettings } from '@/lib/account/client/settings'
import { effectiveRail, withDefaultRail, withMaxCards, withRouting, type AccountSettings } from '@/lib/account/settings'
import { MAX_TILL_CARDS } from '@/lib/route/plan'
import { backendFor } from '@/lib/till/client/backend'
import { keepTillPurchase, recentTillPurchasesOf, unfinishedPays } from '@/lib/till/client/recent'
import type { TillPurchaseRecord } from '@/lib/escrow/client/card-store'
import type { PurchaseHandle, Rail, TillBackend, UnfinishedPay } from '@/lib/till/types'
import { AppBar } from '../app-bar'
import { openDeviceSession, sessionStore, type DeviceSession } from '../pay/device-session'
import { CardCodeFigure, merchantLabel, shortAddress, unitsToMoney, usePreloadBarcodes } from '../pay/escrow-ui'
import { cardsHelp, cardsOfflineLine, pendingHeadline, pendingLine } from '../pay/escrow-copy'
import { TILL_STORES, storeIconName, tillPath, tillStoreName, tillStoreOf } from '../pay/stores'
import { cardBrandName, startCardSetup, type CardNotice } from '../saved-card'
import { RECENT_PURCHASES, SOMETHING_WRONG, alsoPaidLine, doneLine, openPurchaseLine, recentLine, unfinishedPayLine } from '../pay/till-copy'
import { TillHelp } from '../pay/till-help'
import { money } from '../ui'

type Ready = Extract<DeviceSession, { phase: 'ready' }>

/** This phone's store, and the dollars rail's session on it: ready, or why not. */
type Device = { phase: 'loading' } | { phase: 'storage' } | { phase: 'open'; store: CardStore; dollars: DeviceSession }

const STEP_WORDS: Record<SignInStep | 'making', string> = {
  face_id: 'Waiting for Face ID…',
  checking: 'Finding your account…',
  face_id_again: 'Face ID once more…',
  making: 'Waiting for Face ID…',
}


function useAccountDevice(dollarsRail: boolean): { device: Device; reload: () => void } {
  const [device, setDevice] = useState<Device>({ phase: 'loading' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    setDevice({ phase: 'loading' })
    void (async () => {
      if (!dollarsRail) {
        try {
          const store = await openCardStore()
          if (live) setDevice({ phase: 'open', store, dollars: { phase: 'off', store } })
        } catch {
          if (live) setDevice({ phase: 'storage' })
        }
        return
      }
      const s = await openDeviceSession('shopper', escrowApi(), { openStore: () => openCardStore(), loadWallet: loadDeviceWallet })
      const store = sessionStore(s)
      if (!live) return
      setDevice(store === null ? { phase: 'storage' } : { phase: 'open', store, dollars: s })
    })()
    return () => {
      live = false
    }
  }, [dollarsRail, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { device, reload }
}

export function AccountClient({ dollarsRail }: { dollarsRail: boolean }) {
  const { device, reload } = useAccountDevice(dollarsRail)
  return (
    <>
      <AppBar current="account" />
      <main className="wrap" data-task id="content" tabIndex={-1}>
        <h1>Account</h1>
        {device.phase === 'loading' && (
          <p className="hint hint--deferred" aria-busy="true">
            Checking this phone…
          </p>
        )}
        {device.phase === 'storage' && (
          <div className="notice">
            <strong>This browser will not keep anything for Salvo.</strong>{' '}
            <span className="notice--muted">A private window does this. Open this page in a normal window: your account lives on this phone.</span>
          </div>
        )}
        {device.phase === 'open' && <AccountHome store={device.store} dollars={device.dollars} onReload={reload} />}
      </main>
    </>
  )
}

function AccountHome({ store, dollars, onReload }: { store: CardStore; dollars: DeviceSession; onReload: () => void }) {
  const api = useMemo(() => accountApi(), [])
  const [passkey, setPasskey] = useState<PasskeyRecord | null | undefined>(undefined)
  const [view, setView] = useState<AccountView | null>(null)
  const [settings, setSettings] = useState<AccountSettings | null>(null)

  const refresh = useCallback(async () => {
    const [p, v, s] = await Promise.all([store.passkey(), api.view(), deviceSettings(store)])
    setPasskey(p)
    setView(v)
    setSettings(s.settings)
  }, [store, api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signedIn = useCallback(
    async (p: PasskeyRecord, v: AccountView | null) => {
      setPasskey(p)
      if (v !== null) {
        setView(v)
        setSettings(await restoreSettings(store, v.settings))
      }
    },
    [store],
  )

  if (passkey === undefined || settings === null) {
    return (
      <p className="hint hint--deferred" aria-busy="true">
        Opening your account…
      </p>
    )
  }
  const ready = dollars.phase === 'ready' ? dollars : null
  if (passkey === null) {
    // Signed out, the cards this phone bought on the first escrow still show,
    // with their codes: they open nowhere else, and signing in needs our
    // server, which a register with one bar of signal may not reach.
    return (
      <>
        <SignIn store={store} api={api} ready={ready} onDone={signedIn} />
        <BoughtHere store={store} />
      </>
    )
  }
  return (
    <Account
      store={store}
      api={api}
      dollars={dollars}
      passkey={passkey}
      view={view}
      settings={settings}
      onView={setView}
      onSettings={setSettings}
      onSignedIn={async (p, v) => {
        await signedIn(p, v)
        // Another account here now: this phone's keys and session are read again for it.
        onReload()
      }}
      // Forgotten here: this phone is read afresh, so nothing of the account stays in the page's memory.
      onSignedOut={onReload}
      onReload={onReload}
    />
  )
}

/**
 * The first escrow's whole cards bought on this phone, with their codes, for
 * a browser that is signed out (they stay: they open nowhere else). A
 * purchase of one still finishing is said; Finish it is under Store credit,
 * once signed in, and never pays twice. A card sold back is not listed.
 */
function BoughtHere({ store }: { store: CardStore }) {
  usePreloadBarcodes()
  const book = useBookV2()
  const [cards, setCards] = useState<CardRecord[]>([])
  const [pending, setPending] = useState<PurchaseRecord[]>([])
  const [showing, setShowing] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void Promise.all([store.cards(), unfinishedPurchases(store), soldBackOf(book)])
      .then(([c, p, sold]) => {
        if (!live) return
        setCards(keepableCards(c, [], sold))
        setPending(p)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [store, book])
  if (cards.length === 0 && pending.length === 0) return null
  return (
    <section className="group" aria-labelledby="bought-here">
      <h2 id="bought-here">Gift cards bought on this phone</h2>
      {pending.map((p) => (
        <div key={p.id} className="notice" role="status">
          <strong>
            {merchantLabel(p.merchant)}: {pendingHeadline(p)}
          </strong>{' '}
          <span className="notice--muted">Continue with Face ID above, then tap Finish it under Store credit. Nothing will be paid twice.</span>
        </div>
      ))}
      <div className="rows">
        {cards.map((c) => (
          <article key={c.id} className="card">
            <div className="split">
              <div className="strong">
                {merchantLabel(c.merchant)} <span className="num muted">···· {c.last4}</span>
              </div>
              <button type="button" className="btn btn--secondary" onClick={() => setShowing(showing === c.id ? null : c.id)} aria-expanded={showing === c.id}>
                {showing === c.id ? 'Hide code' : 'Show code'}
              </button>
            </div>
            {showing === c.id && (
              <div className="reveal" data-live="">
                <CardCodeFigure store={store} card={c} />
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

// ===========================================================================
// Sign-in
// ===========================================================================

function SignIn({
  store,
  api,
  ready,
  onDone,
}: {
  store: CardStore
  api: AccountApi
  ready: Ready | null
  onDone: (p: PasskeyRecord, v: AccountView | null) => Promise<void>
}) {
  const [step, setStep] = useState<SignInStep | 'making' | null>(null)
  const [none, setNone] = useState(false)
  const [error, setError] = useState('')
  // Fetched before the tap, so the Face ID sheet opens straight from it, and
  // never refreshed while a sign-in uses it (client/challenge.ts says why).
  const challenges = useMemo(() => new ChallengeKeeper(() => api.challenge()), [api])
  useEffect(() => {
    challenges.refresh()
    const t = setInterval(() => challenges.refresh(), CHALLENGE_FRESH_MS)
    return () => clearInterval(t)
  }, [challenges])

  const go = useCallback(async () => {
    setError('')
    setNone(false)
    // Nothing awaited before the Face ID sheet: Safari opens it only straight from the tap.
    const held = challenges.takeNow()
    setStep('face_id')
    try {
      const hosts = ready?.access.hosts
      const out = await continueWithFaceId(
        {
          store,
          api,
          ...(hosts !== undefined ? { hasDollars: async (a) => (await dollarBalance(hosts, a)) > 0n } : {}),
          onStep: setStep,
        },
        held !== null ? { challenge: held, existing: null } : { existing: null },
      )
      if (!out.found) setNone(true)
      else await onDone(out.passkey, out.view)
    } catch (err) {
      setError(
        err instanceof AccountRefused
          ? err.message
          : faceIdCancelled(err)
            ? 'Face ID was cancelled. Nothing was changed.'
            : 'That did not work. Nothing was changed. Try again.',
      )
    } finally {
      setStep(null)
      challenges.done()
    }
  }, [store, api, ready, onDone, challenges])

  const make = useCallback(async () => {
    setError('')
    setStep('making')
    try {
      await onDone(await createAccount(store), null)
    } catch (err) {
      setError(faceIdCancelled(err) ? 'Cancelled. No account was made.' : 'That did not work. No account was made. Try again.')
    } finally {
      setStep(null)
    }
  }, [store, onDone])

  const busy = step !== null
  return (
    <section className="group">
      <p className="sub">One account to pay at the till and to sell. Face ID, no password, no seed phrase.</p>
      {none && (
        <div className="notice" role="status">
          <strong>We did not find a Salvo account on this phone.</strong>{' '}
          <span className="notice--muted">
            If you made one before, it is saved in iCloud Keychain. Check that Keychain is on, then try again.
          </span>
        </div>
      )}
      {error !== '' && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
      {none ? (
        <>
          <button type="button" className={busy ? 'btn btn--primary btn--block is-working' : 'btn btn--primary btn--block'} onClick={() => void make()} disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {step !== null ? STEP_WORDS[step] : 'Make my account'}
          </button>
          <button type="button" className="btn btn--secondary btn--block mt-3" onClick={() => void go()} disabled={busy}>
            Try again
          </button>
        </>
      ) : (
        <button type="button" className={busy ? 'btn btn--primary btn--block is-working' : 'btn btn--primary btn--block'} onClick={() => void go()} disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {step !== null ? STEP_WORDS[step] : 'Continue with Face ID'}
        </button>
      )}
      <p className="hint">
        Add Salvo to your Home Screen.
        <InfoTip label="Why add to Home Screen">Safari can clear a site&rsquo;s data after a week without a visit. An icon on the Home Screen keeps your account on this phone.</InfoTip>
      </p>
    </section>
  )
}

// ===========================================================================
// The account
// ===========================================================================

interface Dollars {
  balance: bigint | null
  allowance: Allowance | null
}

/**
 * SalvoEscrowV2, the escrow the till pays on in dollars, as this page's pins
 * hold our server to it: loading, not open here, not answered (or answered
 * with pins this page does not trust), or open.
 */
type V2Escrow = { phase: 'loading' } | { phase: 'off' } | { phase: 'error' } | { phase: 'open'; escrow: Hex; v1Escrow: Hex | null }

function Account({
  store,
  api,
  dollars,
  passkey,
  view,
  settings,
  onView,
  onSettings,
  onSignedIn,
  onSignedOut,
  onReload,
}: {
  store: CardStore
  api: AccountApi
  dollars: DeviceSession
  passkey: PasskeyRecord
  view: AccountView | null
  settings: AccountSettings
  onView: (v: AccountView | null) => void
  onSettings: (s: AccountSettings) => void
  onSignedIn: (p: PasskeyRecord, v: AccountView | null) => Promise<void>
  onSignedOut: () => void
  onReload: () => void
}) {
  const ready = dollars.phase === 'ready' ? dollars : null
  const [walletKept, setWallet] = useState<DeviceWallet | null>(ready?.wallet ?? null)
  // Only this account's key: one loaded for an account since signed out of here is nobody's on this page.
  const wallet = keyOfAccount(walletKept, passkey.address)
  const [chain, setChain] = useState<Dollars>({ balance: null, allowance: null })
  const [chainFailed, setChainFailed] = useState(false)
  const [notice, setNotice] = useState<CardNotice | null>(null)
  const v2 = useV2Escrow(ready !== null)
  // Opened whatever the first escrow's session says: it needs no server, and taking a card off store credit needs it.
  const book = useBookV2()
  // The dollars till's own book, for what it still owes the chain and a Pay it never finished here. One for the page.
  const dollarsTill = useMemo(() => backendFor('stablecoin'), [])

  // A view for another account (a cookie from someone else's sign-in here)
  // says nothing about this one: treat this browser as not signed in.
  const mine = view !== null && (!view.signedIn || view.address === passkey.address) ? view : view === null ? null : { ...view, signedIn: false, card: null, cardLinked: false }

  // Back from the card page. Said once; the URL that carried it is cleaned at once.
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get('card')
    if (c === 'saved' || c === 'not_saved') {
      setNotice(c)
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.hash}`)
    }
  }, [])

  const readChain = useCallback(async () => {
    if (ready === null) return
    try {
      const [balance, allowance] = await Promise.all([
        dollarBalance(ready.access.hosts, passkey.address),
        wallet === null ? Promise.resolve(null) : wallet.allowance(ready.access.hosts),
      ])
      setChain({ balance, allowance })
      setChainFailed(false)
    } catch {
      setChainFailed(true)
    }
  }, [ready, wallet, passkey.address])

  useEffect(() => {
    void readChain()
  }, [readChain])

  // What the till can pay with now, by its own rule (settings.ts effectiveRail):
  // dollars with a key for the escrow it pays on, an allowance not ended and
  // something to spend (wallet.ts spendableUnits, the till's own check), or
  // the saved card. Dollars not read yet count as able: the till does the same.
  const ended = wallet !== null && (chain.allowance?.ended === true || wallet.restrictions.expiry <= Math.floor(Date.now() / 1000))
  const spendable = ready !== null && chain.balance !== null && chain.allowance !== null ? spendableUnits(chain.balance, chain.allowance, ready.access.sponsorUrl !== null) : null
  const nothingToSpend = spendable !== null && spendable < BigInt(UNITS_PER_CENT)
  const dollarsReady = wallet !== null && !ended && v2.phase === 'open' && keyScopedForV2(wallet, v2.escrow) && !nothingToSpend
  const cardReady = mine?.card != null
  const payWith = effectiveRail(settings, { card: cardReady, stablecoin: dollarsReady })

  const save = useCallback(
    async (next: AccountSettings) => {
      onSettings(next)
      const kept = await saveDeviceSettings(store, next)
      if (mine?.signedIn === true && mine.card !== null) void api.savePrefs(kept)
    },
    [store, api, mine, onSettings],
  )
  const choose = useCallback((rail: Rail) => void save(withDefaultRail(settings, rail)), [save, settings])

  return (
    <>
      <p className="sub">
        Your account{' '}
        <span className="num muted" title={passkey.address}>
          {shortAddress(passkey.address)}
        </span>{' '}
        {/* The whole address, for test dollars sent from elsewhere while the testnet faucet is down. */}
        <CopyButton text={passkey.address} />
      </p>
      {notice === 'not_saved' ? (
        <div className="notice notice--neutral" role="status">
          No card was saved. Nothing was charged.
        </div>
      ) : notice === 'saved' && mine?.card != null ? (
        <div className="notice notice--neutral" role="status">
          Card saved. {cardBrandName(mine.card.brand) ?? 'Card'} ending <span className="num">{mine.card.last4}</span>.
        </div>
      ) : null}
      {view !== null && view.signedIn && view.address !== null && view.address !== passkey.address && (
        <OtherAccount store={store} api={api} address={view.address} onSignedIn={onSignedIn} />
      )}

      <section className="group" aria-labelledby="pay-with">
        <h2 id="pay-with" className="mt-0">
          Pay with
        </h2>
        <div className="rows">
          <DollarsRow
            store={store}
            dollars={dollars}
            v2={v2}
            wallet={wallet}
            chain={chain}
            chainFailed={chainFailed}
            ended={ended}
            nothingToSpend={nothingToSpend}
            till={payWith === 'stablecoin' ? 'this' : dollarsReady ? 'other' : 'none'}
            onChoose={() => choose('stablecoin')}
            onWallet={(w) => {
              setWallet(w)
            }}
            onReload={onReload}
          />
          <CardRow
            store={store}
            api={api}
            passkey={passkey}
            view={mine}
            till={payWith === 'card' ? 'this' : cardReady ? 'other' : 'none'}
            onChoose={() => choose('card')}
            onView={onView}
          />
        </div>
        <p className="hint">{payWithLine(payWith, dollarsReady && cardReady)}</p>
      </section>

      <section className="group" aria-labelledby="at-the-till">
        <h2 id="at-the-till">At the till</h2>
        <div className="cluster" role="group" aria-label="How the till picks cards">
          <button type="button" className="choice" aria-pressed={settings.routing === 'most_savings'} onClick={() => void save(withRouting(settings, 'most_savings'))}>
            Most savings
          </button>
          <button type="button" className="choice" aria-pressed={settings.routing === 'in_and_out'} onClick={() => void save(withRouting(settings, 'in_and_out'))}>
            In and out
          </button>
        </div>
        <p className="hint">
          {settings.routing === 'most_savings'
            ? 'Uses more cards when that costs you less.'
            : 'Uses the fewest cards, so there is less to scan.'}{' '}
          Either way, you pay only for what you use.
        </p>
        <div className="field">
          <label htmlFor="max-cards" className="split">
            <span>Most cards in one purchase</span>
            <span className="num text-2">{settings.maxCards}</span>
          </label>
          <input
            id="max-cards"
            type="range"
            min={1}
            max={MAX_TILL_CARDS}
            step={1}
            value={settings.maxCards}
            onChange={(e) => void save(withMaxCards(settings, Number(e.target.value)))}
            aria-valuetext={`${settings.maxCards} ${settings.maxCards === 1 ? 'card' : 'cards'}`}
          />
        </div>
      </section>

      <section className="group" aria-labelledby="balances">
        <h2 id="balances">Balances</h2>
        <dl className="stack kv">
          {ready !== null && (
            <div className="split">
              <dt className="text-2">Dollars</dt>
              <dd className="num">{chain.balance === null ? '…' : unitsToMoney(chain.balance)}</dd>
            </div>
          )}
          {ready !== null && v2.phase === 'open' && book !== null && <HeldDeposits book={book} hosts={ready.access.hosts} escrow={v2.escrow} account={passkey.address} />}
          {mine?.card != null && (
            <div className="split">
              <dt className="text-2">Card holds</dt>
              <dd className="num">{money(mine.heldCents)}</dd>
            </div>
          )}
        </dl>
        {ready === null && mine?.card == null && <p className="hint">Nothing to show yet.</p>}
        {chainFailed && <p className="hint">We cannot read the chain right now. The numbers above may be old.</p>}
        {ready !== null && wallet !== null && <TestDollars ready={ready} address={passkey.address} onDone={() => void readChain()} />}
      </section>

      <RecentTill store={store} book={book} account={passkey.address} dollarsTill={dollarsTill} />

      {v2.phase === 'open' && v2.v1Escrow !== null && <MatchOldCards store={store} api={api} passkey={passkey} view={mine} v1Escrow={v2.v1Escrow} onView={onView} />}

      <StoreCredit
        store={store}
        book={book}
        ready={ready}
        wallet={wallet}
        account={passkey.address}
        payWith={payWith}
        settings={settings}
        onSave={save}
        dollarsTill={dollarsTill}
      />

      <StoresAndAlerts lastStore={settings.lastStore} />

      <section className="group" aria-labelledby="selling">
        <h2 id="selling">Selling</h2>
        <p className="hint mt-0">Have a gift card you will not use? Sell it to the next shopper. Sell lists it, and shows each sale and payout.</p>
        <Link className="btn btn--secondary btn--block" href="/sell">
          Sell a gift card
        </Link>
      </section>

      <SignOut store={store} api={api} onSignedOut={onSignedOut} />
    </>
  )
}

/** Under Pay with: which way the till pays, in words, or how to set one up. */
function payWithLine(payWith: Rail | null, both: boolean): string {
  if (payWith === null) return 'Allow dollars or save a card to pay at the till.'
  const way = payWith === 'stablecoin' ? 'your dollars' : 'your card'
  return both ? `The till pays with ${way}. Tap Use at the till on the other to switch.` : `The till pays with ${way}.`
}

/**
 * The deposits the dollars hold on leftovers, as the chain says now
 * (client/deposits.ts): "$3.87 at Target · since 2:14 pm". Nothing shows
 * while there are none, or while the chain cannot be read.
 */
function HeldDeposits({ book, hosts, escrow, account }: { book: DeviceBookV2; hosts: Parameters<typeof heldDepositsV2>[1]; escrow: Hex; account: Hex }) {
  const [held, setHeld] = useState<HeldDeposit[] | null>(null)
  useEffect(() => {
    let live = true
    // This account's deposits only: the book is the browser's, and outlives a sign-out.
    void heldDepositsV2(book, hosts, escrow, account)
      .then((h) => {
        if (live) setHeld(h)
      })
      .catch(() => {
        if (live) setHeld([])
      })
    return () => {
      live = false
    }
  }, [book, hosts, escrow, account])
  if (held === null || held.length === 0) return null
  return (
    <div className="split">
      <dt className="text-2">Deposits held</dt>
      <dd className="stack">
        {held.map((d, i) => (
          <span key={i} className="num">
            {depositLine(d)}
          </span>
        ))}
      </dd>
    </div>
  )
}

/** One deposit, as the account says it: "$3.87 at Target · since 2:14 pm". */
function depositLine(d: HeldDeposit, now: Date = new Date()): string {
  const at = new Date(d.since)
  const when =
    at.toDateString() === now.toDateString()
      ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${money(d.cents)} at ${merchantLabel(d.merchant)} · since ${when}`
}

/**
 * Sign this browser out, and forget the account in it (passkey.ts
 * signOutHere). Offered whenever this browser keeps an account, signed in or
 * not: a dollars key works with no session at all. On someone else's laptop
 * this is how the account stops paying there, by card and in dollars, and
 * how the next person gets the sign-in to use their own.
 */
function SignOut({ store, api, onSignedOut }: { store: CardStore; api: AccountApi; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      await signOutHere({ store, api })
      onSignedOut()
    } catch (err) {
      setError(err instanceof AccountRefused ? err.message : 'That did not work. This browser may still keep your account. Try again.')
    } finally {
      setBusy(false)
    }
  }, [store, api, onSignedOut])
  return (
    <section className="group" aria-labelledby="this-browser">
      <h2 id="this-browser">This browser</h2>
      <p className="hint mt-0">
        Using someone else&rsquo;s phone or computer? Sign out when you are done. This browser then forgets your account: your card and
        your dollars stop paying here, and your settings, store credit and recent purchases go from it. Gift cards you bought here with
        dollars stay, because they open nowhere else yet.
      </p>
      {error !== '' && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn--secondary btn--block" onClick={() => void go()} disabled={busy}>
        {busy ? 'Signing out…' : 'Sign out of this browser'}
      </button>
    </section>
  )
}

/** On the row the till pays with: the shopper's choice, or the one set up, dollars first (settings.ts effectiveRail). */
function TillMark() {
  return (
    <span className="pill pill--ok">
      <span aria-hidden="true">✓&nbsp;</span>Pays at the till
    </span>
  )
}

/**
 * This browser's session names another account than the passkey it keeps:
 * a passkey was made here while the phone had one, or the shopper picked
 * another. Said, with the way to that account, rather than shown as if the
 * stored one were all there is. Signing in with it asks the phone, and keeps
 * the one it offers; another account than the one kept is a sign-out of the
 * first here (passkey.ts continueWithFaceId), so none of its store credit,
 * settings or purchases become the second's, and the words say so.
 */
function OtherAccount({
  store,
  api,
  address,
  onSignedIn,
}: {
  store: CardStore
  api: AccountApi
  address: PasskeyRecord['address']
  onSignedIn: (p: PasskeyRecord, v: AccountView | null) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const out = await continueWithFaceId({ store, api }, { discover: true })
      if (out.found) await onSignedIn(out.passkey, out.view)
      else setError('No other Salvo passkey was offered. Nothing was changed.')
    } catch (err) {
      setError(err instanceof AccountRefused ? err.message : faceIdCancelled(err) ? 'Face ID was cancelled. Nothing was changed.' : 'That did not work. Nothing was changed. Try again.')
    } finally {
      setBusy(false)
    }
  }, [store, api, onSignedIn])
  return (
    <div className="notice" role="status">
      <strong>This browser is signed in to another Salvo account,</strong>{' '}
      <span className="num">{shortAddress(address)}</span>.{' '}
      <span className="notice--muted">
        A card saved there is on that account, not this one. Using it here signs this one out of this browser first: its settings, store
        credit and recent purchases go from here.
      </span>
      {error !== '' && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn--secondary btn--block mt-3" onClick={() => void go()} disabled={busy}>
        {busy ? 'Waiting for Face ID…' : 'Use that account here'}
      </button>
    </div>
  )
}

/**
 * The first escrow's cards this phone bought, matched for their sellers
 * (client/match-v1.ts): until each is, its seller lists nothing at that
 * store on SalvoEscrowV2. Signed in to our server, it runs on its own as the
 * page opens and shows nothing. Not signed in there (dollars alone never
 * needed it), it says what is waiting, and the one Face ID that signs in.
 */
function MatchOldCards({
  store,
  api,
  passkey,
  view,
  v1Escrow,
  onView,
}: {
  store: CardStore
  api: AccountApi
  passkey: PasskeyRecord
  /** This account's view, or null. */
  view: AccountView | null
  v1Escrow: Hex
  onView: (v: AccountView | null) => void
}) {
  const signedIn = view?.signedIn === true && view.address === passkey.address
  const [waiting, setWaiting] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void (async () => {
      const cards = await cardsToMatchV1(store, v1Escrow, passkey.address)
      if (live) setWaiting(cards.length)
      if (cards.length === 0 || !signedIn) return
      const out = await matchV1Cards({ store, api, v1Escrow, account: passkey.address })
      if (live) setWaiting(out.waiting)
    })().catch(() => undefined)
    return () => {
      live = false
    }
  }, [store, api, v1Escrow, passkey.address, signedIn])
  const go = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      onView(await ensureSignedIn({ store, api }, passkey, view))
    } catch (err) {
      setError(err instanceof AccountRefused ? err.message : faceIdCancelled(err) ? 'Face ID was cancelled. Nothing was changed.' : 'That did not work. Nothing was changed. Try again.')
    } finally {
      setBusy(false)
    }
  }, [store, api, passkey, view, onView])
  if (signedIn || waiting === 0) return null
  const one = waiting === 1
  return (
    <div className="notice" role="status">
      <strong>{one ? 'A gift card you bought on this phone before is not matched yet.' : `${waiting} gift cards you bought on this phone before are not matched yet.`}</strong>{' '}
      <span className="notice--muted">
        Until {one ? 'it is, its seller' : 'they are, their sellers'} cannot sell at that store. Matching sends a one-way fingerprint of each
        card, never the card, and charges nothing.
      </span>
      {error !== '' && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn--secondary btn--block mt-3" onClick={() => void go()} disabled={busy}>
        {busy ? 'Waiting for Face ID…' : 'Match with Face ID'}
      </button>
    </div>
  )
}

/** SalvoEscrowV2 as this page's pins hold our server to it. Asked once the dollars rail answers here. */
function useV2Escrow(ask: boolean): V2Escrow {
  const [v2, setV2] = useState<V2Escrow>({ phase: 'loading' })
  useEffect(() => {
    if (!ask) return
    let live = true
    void escrowApiV2()
      .config()
      .then((c) => {
        if (live) setV2(c.state === 'ready' ? { phase: 'open', escrow: c.config.escrow, v1Escrow: c.config.v1Escrow } : { phase: c.state === 'error' ? 'error' : 'off' })
      })
      .catch(() => {
        if (live) setV2({ phase: 'error' })
      })
    return () => {
      live = false
    }
  }, [ask])
  return v2
}

/**
 * This phone's V2 book (records-v2.ts), or null while it is opening or this
 * browser keeps nothing. Opened whenever IndexedDB is there, whatever any
 * server says: it was opened only once the first escrow's session was
 * ready, so with our server out of reach "Remove it" took a card off this
 * list and left it in the book, and the till went on paying with it.
 */
function useBookV2(): DeviceBookV2 | null {
  const [book, setBook] = useState<DeviceBookV2 | null>(null)
  useEffect(() => {
    let live = true
    void openDeviceBookV2()
      .then((b) => {
        if (live) setBook(b)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return book
}

/**
 * Where a row stands at the till: the one it pays with (the tick), set up
 * but not the one (a tap makes it so), or not set up.
 */
type TillPlace = 'this' | 'other' | 'none'

/** The tick on the row the till pays with, or the tap that makes a set-up row the one. */
function TillChoice({ till, onChoose }: { till: TillPlace; onChoose: () => void }) {
  if (till === 'this') return <TillMark />
  if (till === 'other') {
    return (
      <button type="button" className="textlink textlink--tap" onClick={onChoose}>
        Use at the till
      </button>
    )
  }
  return null
}

function DollarsRow({
  store,
  dollars,
  v2,
  wallet,
  chain,
  chainFailed,
  ended,
  nothingToSpend,
  till,
  onChoose,
  onWallet,
  onReload,
}: {
  store: CardStore
  dollars: DeviceSession
  v2: V2Escrow
  wallet: DeviceWallet | null
  chain: Dollars
  chainFailed: boolean
  ended: boolean
  /** Set up, with nothing to spend now: the till does not pay with these, and the row says why. */
  nothingToSpend: boolean
  till: TillPlace
  onChoose: () => void
  onWallet: (w: DeviceWallet) => void
  onReload: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // A key set up for the first escrow cannot pay on the second, which the
  // till pays on: the allowance is asked for again there.
  const tillKey = wallet !== null && v2.phase === 'open' && keyScopedForV2(wallet, v2.escrow)
  const needsKey = wallet === null || ended || !tillKey

  const allow = useCallback(async () => {
    if (v2.phase !== 'open') return
    setBusy(true)
    setError('')
    try {
      onWallet(await setUpDeviceWalletV2(store, 'shopper', { escrow: v2.escrow, v1Escrow: v2.v1Escrow, weeklyLimitUnits: SHOPPER_WEEKLY_LIMIT_UNITS }))
    } catch (err) {
      setError(faceIdCancelled(err) ? 'Cancelled. Nothing was sent or charged.' : 'That did not finish. Nothing was sent or charged. Try again.')
    } finally {
      setBusy(false)
    }
  }, [v2, store, onWallet])

  let status: React.ReactNode
  if (dollars.phase === 'off') status = <p className="hint">Not available here.</p>
  else if (dollars.phase === 'not_ready') status = <p className="hint">Not set up here yet.</p>
  else if (dollars.phase !== 'ready') {
    status = (
      <p className="hint">
        We could not reach Salvo.{' '}
        <button type="button" className="textlink" onClick={onReload}>
          Try again
        </button>
      </p>
    )
  } else if (v2.phase === 'loading') {
    status = (
      <p className="hint hint--deferred" aria-busy="true">
        Checking…
      </p>
    )
  } else if (v2.phase === 'off') {
    status = <p className="hint">Dollars do not pay at the till here yet.</p>
  } else if (v2.phase === 'error') {
    status = (
      <p className="hint">
        We could not reach Salvo.{' '}
        <button type="button" className="textlink" onClick={onReload}>
          Try again
        </button>
      </p>
    )
  } else if (needsKey) {
    status = (
      <>
        <p className="hint">
          {ended ? 'Your weekly allowance has ended. ' : wallet !== null ? 'Salvo Pay has a new escrow, which pays at the till. ' : ''}One Face ID. It can only pay into
          Salvo&rsquo;s escrow, and it ends after 90 days.
        </p>
        {error !== '' && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <button type="button" className={busy ? 'btn btn--secondary btn--block is-working' : 'btn btn--secondary btn--block'} onClick={() => void allow()} disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? 'Waiting for Face ID…' : `Allow Salvo to spend up to ${unitsToMoney(SHOPPER_WEEKLY_LIMIT_UNITS)} a week`}
        </button>
      </>
    )
  } else {
    status = (
      <p className="hint">
        <span className="num">{chain.allowance === null ? '…' : unitsToMoney(chain.allowance.remainingUnits)}</span> left this week
        {chainFailed ? ' (may be old)' : ''}. These pay at the till, for only what you use.
        {nothingToSpend ? ' There is nothing to spend right now, so the till does not pay with these until you add some.' : ''}
      </p>
    )
  }

  return (
    <article className="card">
      <div className="split">
        <div className="strong">
          Dollars in Salvo <span className="muted">(stablecoins)</span>
        </div>
        <TillChoice till={till} onChoose={onChoose} />
      </div>
      {status}
    </article>
  )
}

function CardRow({
  store,
  api,
  passkey,
  view,
  till,
  onChoose,
  onView,
}: {
  store: CardStore
  api: AccountApi
  passkey: PasskeyRecord
  view: AccountView | null
  till: TillPlace
  onChoose: () => void
  onView: (v: AccountView) => void
}) {
  const [step, setStep] = useState<'face_id' | 'leaving' | null>(null)
  const [error, setError] = useState('')

  const add = useCallback(async () => {
    setError('')
    setStep('face_id')
    try {
      const v = await ensureSignedIn({ store, api }, passkey, view)
      onView(v)
      setStep('leaving')
      const out = await startCardSetup('/account')
      // On success the browser is already leaving for the card page.
      if (!out.ok) {
        setError(out.message)
        setStep(null)
      }
    } catch (err) {
      setError(
        err instanceof AccountRefused ? err.message : faceIdCancelled(err) ? 'Face ID was cancelled. No card was saved.' : 'That did not work. No card was saved. Try again.',
      )
      setStep(null)
    }
  }, [store, api, passkey, view, onView])

  let body: React.ReactNode
  if (view === null) body = <p className="hint">We could not reach Salvo. Your card is safe; try again in a minute.</p>
  else if (!view.cardRail) body = <p className="hint">Paying by card is not available here.</p>
  else if (!view.cardKnown) body = <p className="hint">We cannot read your card right now. Try again in a minute.</p>
  else if (view.card !== null && !view.cardLinked) {
    // A card this browser saved on its own: it pays here, and nowhere else.
    // It joins the account only when its holder saves it under the account,
    // on the card page: signing in never links a card (src/lib/hold/account.ts).
    body = (
      <>
        <p className="hint">
          Saved in this browser only. To use it on your other devices, save it to your account. You type the card once
          more on the secure card page.
        </p>
        {error !== '' && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="btn btn--secondary btn--block" onClick={() => void add()} disabled={step !== null}>
          {step === 'face_id' ? 'Waiting for Face ID…' : step === 'leaving' ? 'Opening the card page…' : 'Save it to my account'}
        </button>
      </>
    )
  } else if (view.card !== null) {
    // A new card saved here becomes the one the till pays with
    // (api/card/return makes it the default), so a declined card is replaced
    // the same way it was added.
    body = (
      <>
        <p className="hint">Held when you pay, and taken only for what you use.</p>
        {error !== '' && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="btn btn--secondary btn--block" onClick={() => void add()} disabled={step !== null}>
          {step === 'face_id' ? 'Waiting for Face ID…' : step === 'leaving' ? 'Opening the card page…' : 'Use a different card'}
        </button>
      </>
    )
  } else {
    body = (
      <>
        <p className="hint">You type the card on a secure card page. Salvo never sees the number.</p>
        {error !== '' && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <button type="button" className={step !== null ? 'btn btn--secondary btn--block is-working' : 'btn btn--secondary btn--block'} onClick={() => void add()} disabled={step !== null}>
          {step !== null && <span className="spinner" aria-hidden="true" />}
          {step === 'face_id' ? 'Waiting for Face ID…' : step === 'leaving' ? 'Opening the card page…' : 'Add a card'}
        </button>
      </>
    )
  }

  return (
    <article className="card">
      <div className="split">
        <div className="strong">
          {view?.card != null ? (
            <>
              Card · {cardBrandName(view.card.brand) ?? 'Card'} <span className="num muted">•••• {view.card.last4}</span>
            </>
          ) : (
            'A card'
          )}
        </div>
        <TillChoice till={till} onChoose={onChoose} />
      </div>
      {body}
    </article>
  )
}

function TestDollars({ ready, address, onDone }: { ready: Ready; address: PasskeyRecord['address']; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      await requestTestDollars(ready.access.hosts, address)
    } catch {
      setError('The faucet did not answer. Try again in a minute.')
    } finally {
      setBusy(false)
      onDone()
    }
  }, [ready, address, onDone])
  return (
    <>
      <button type="button" className={busy ? 'btn btn--secondary btn--block mt-4 is-working' : 'btn btn--secondary btn--block mt-4'} onClick={() => void go()} disabled={busy}>
        {busy && <span className="spinner" aria-hidden="true" />}
        {busy ? 'Asking the faucet…' : 'Get test dollars'}
      </button>
      {error !== '' && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

// ===========================================================================
// Recent purchases at the till
// ===========================================================================

/**
 * What this phone paid at the till in the last 48 hours, each with the
 * receipt's "Something went wrong?", this account's only. Nothing shows
 * when there is none. A Pay whose page closed before it answered is said
 * too, with the till to open to check it: only the till asks what it did.
 * A dollars one is found in the dollars rail's own book as well, so one
 * whose kept key went with a sign-out still leads back to it.
 */
function RecentTill({ store, book, account, dollarsTill }: { store: CardStore; book: DeviceBookV2 | null; account: Hex; dollarsTill: TillBackend }) {
  const [rows, setRows] = useState<TillPurchaseRecord[] | null>(null)
  const [pending, setPending] = useState<UnfinishedPay[]>([])
  useEffect(() => {
    let live = true
    void recentTillPurchasesOf(store, book, account)
      .then((r) => {
        if (live) setRows(r)
      })
      .catch(() => {
        if (live) setRows([])
      })
    void Promise.all([unfinishedPays(store).catch(() => []), (dollarsTill.unfinishedPays?.() ?? Promise.resolve([])).catch(() => [])]).then(([kept, found]) => {
      if (live) setPending([...kept, ...found.filter((f) => !kept.some((k) => k.store === f.store))])
    })
    return () => {
      live = false
    }
  }, [store, book, account, dollarsTill])
  if ((rows === null || rows.length === 0) && pending.length === 0) return null
  return (
    <section className="group" aria-labelledby="recent">
      <h2 id="recent">{RECENT_PURCHASES}</h2>
      {pending.map((p) => (
        <p className="notice" key={p.store}>
          {p.open ? openPurchaseLine(tillStoreName(p.store), p.open) : unfinishedPayLine(tillStoreName(p.store), p.plan)}{' '}
          <Link className="textlink" href={tillPath(p.store)}>
            Open {tillStoreName(p.store)} to check it
          </Link>
        </p>
      ))}
      <div className="rows">
        {(rows ?? []).map((r) => (
          <RecentRow key={r.id} store={store} record={r} />
        ))}
      </div>
    </section>
  )
}

function RecentRow({ store, record }: { store: CardStore; record: TillPurchaseRecord }) {
  const [open, setOpen] = useState(false)
  const [receipt, setReceipt] = useState(record.receipt)
  // The rail that paid it: a dollars purchase is reported on the phone itself, a card one to our server.
  const backend = useMemo(() => backendFor(record.purchase.rail), [record.purchase.rail])
  // THE SERVER'S FIGURE, NOT THE PHONE'S COPY. The phone hears what a
  // purchase came to only from Done or a report; a card settled by silence
  // after the shopper pocketed the phone read "Paid $0.00" here. Asked once
  // per row, kept on the phone after, and the copy stands if nobody answers.
  useEffect(() => {
    let live = true
    void backend
      .receipt(record.purchase)
      .then(async (r) => {
        if (!live) return
        setReceipt(r)
        await keepTillPurchase(store, { ...record, receipt: r })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [backend, store, record])
  const report = useCallback(
    async (p: PurchaseHandle, scanIndex: number, o: 'empty' | 'problem'): Promise<string> => {
      const out = await backend.report(p, scanIndex, o)
      setReceipt(out.receipt)
      await keepTillPurchase(store, { ...record, receipt: out.receipt })
      return out.note ?? 'Got it.'
    },
    [backend, store, record],
  )
  return (
    <article className="card">
      <div className="strong">{recentLine(tillStoreName(record.store), record.purchase.plan, record.createdAt)}</div>
      <p className="hint">{doneLine(receipt)}</p>
      {alsoPaidLine(receipt) && <p className="hint">{alsoPaidLine(receipt)}</p>}
      <button type="button" className="textlink" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {SOMETHING_WRONG}
      </button>
      {open && <TillHelp purchases={[record.purchase]} onReport={report} />}
    </article>
  )
}

// ===========================================================================
// Stores and alerts
// ===========================================================================

/**
 * Each store's Home Screen icon, and a calendar reminder (spec 10.2 and
 * 10.4). A web page cannot put an icon on the Home Screen itself, so this
 * opens the store's till, whose page names its own icon, and says the two
 * taps. The reminder is a file for the phone's own calendar: nothing about
 * it is sent anywhere.
 */
function StoresAndAlerts({ lastStore }: { lastStore: string | null }) {
  return (
    <section className="group" aria-labelledby="stores">
      <h2 id="stores">Stores and alerts</h2>
      <p className="hint mt-0">
        Each store has its own Home Screen icon that opens straight on its till. Open the store below, tap Share, then Add to
        Home Screen.
      </p>
      <nav className="cluster" aria-label="Store tills">
        {TILL_STORES.map((s) => (
          <Link key={s.id} className="choice" href={tillPath(s.id)}>
            {storeIconName(s.name)}
          </Link>
        ))}
      </nav>
      <Reminder lastStore={lastStore} />
    </section>
  )
}

function Reminder({ lastStore }: { lastStore: string | null }) {
  const [store, setStore] = useState<string>(() => (lastStore === null ? null : tillStoreOf(lastStore)) ?? TILL_STORES[0]?.id ?? 'target')
  const [at, setAt] = useState('')
  const [weekly, setWeekly] = useState(true)
  const [error, setError] = useState('')
  const [made, setMade] = useState('')

  const make = useCallback(() => {
    setError('')
    setMade('')
    let ics: string
    try {
      ics = reminderIcs({
        store,
        storeName: tillStoreName(store),
        at,
        weekly,
        origin: window.location.origin,
        now: new Date(),
        uid: crypto.randomUUID(),
      })
    } catch {
      setError('Pick a day and a time.')
      return
    }
    // Made here and handed to the phone: no request carries it.
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = reminderFileName(store)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    setMade(`Open the file to add it to your calendar. ${weekly ? 'It repeats every week.' : 'It reminds you once.'} Salvo keeps no copy.`)
  }, [store, at, weekly])

  return (
    <details className="quiet-disclosure mt-6">
      <summary>Remind me at…</summary>
      <p className="hint mt-2">A reminder in your own calendar to open Salvo before you pay. Salvo is not told about it.</p>
      <fieldset className="fieldgroup">
        <legend className="label">Which store?</legend>
        <div className="cluster">
          {TILL_STORES.map((s) => (
            <button key={s.id} type="button" className="choice" aria-pressed={store === s.id} onClick={() => setStore(s.id)}>
              {s.name}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="remind-at">When?</label>
        <input id="remind-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
      </div>
      <button type="button" className="choice" aria-pressed={weekly} onClick={() => setWeekly((w) => !w)}>
        Every week
      </button>
      {error !== '' && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {made !== '' && (
        <div className="notice notice--neutral" role="status">
          {made}
        </div>
      )}
      <button type="button" className="btn btn--secondary btn--block mt-4" onClick={make}>
        Add to my calendar
      </button>
    </details>
  )
}

// ===========================================================================
// Store credit
// ===========================================================================

function numberField(m: EscrowMerchantName | ''): { label: string; hint: string | null } {
  if (m === '') return { label: 'Card number', hint: null }
  const p = MERCHANT_BARCODE_PROFILES[m]
  return { label: p?.numberLabel ?? 'Card number', hint: p?.numberHint ?? null }
}

const toCents = (text: string): number => Math.round(Number(text.replace(/[^0-9.]/g, '')) * 100)

/** Store credit, while the till pays by card: it is not used there yet, so the page never says it is. */
const CREDIT_CARD_RAIL = 'The till uses them only when it pays with your dollars. Paying by card, it does not use them yet.'

/** A till purchase's card the register did not need, not store credit yet. */
function keepWaitingLine(merchant: EscrowMerchantName, cards: number): string {
  const which = cards === 1 ? 'A card' : `${cards} cards`
  return `${which} from your ${merchantLabel(merchant)} purchase the register did not need ${cards === 1 ? 'is' : 'are'} not in your store credit yet.`
}

/**
 * The shopper's store credit, one list (spec 11): cards they typed in, and
 * cards the till bought and left theirs, each once, this account's only
 * (credit.ts storeCreditList). The till uses it first, at no cost, while
 * "Use my store credit first" is on, when it pays with dollars; paying by
 * card it does not, and the words and the setting say so. [Sell it] lists a
 * card on the escrow, sealed again on this phone: a card bought with dollars
 * once its purchase is final, a day after. A card the register did not need
 * that the chain has not made credit yet is said, and asked again: as the
 * page opens (the dollars till's catchUp), and on Try again.
 *
 * WHOLE CARDS FROM THE FIRST ESCROW ARE HERE TOO, WITH THEIR CODES. /cards
 * redirects to this section: each card this phone bought with Salvo Pay
 * before the till paid in dollars shows its code here, and a purchase of
 * one whose card had not reached the phone is finished here (Finish it),
 * never paid twice. What is left on a card the till used in part is never
 * listed: it is the seller's.
 */
function StoreCredit({
  store,
  book,
  ready,
  wallet,
  account,
  payWith,
  settings,
  onSave,
  dollarsTill,
}: {
  store: CardStore
  book: DeviceBookV2 | null
  ready: Ready | null
  /** This account's dollars key, or null: what Finish it signs with. */
  wallet: DeviceWallet | null
  account: Hex
  /** The way the till pays: store credit pays only in dollars. */
  payWith: Rail | null
  settings: AccountSettings
  onSave: (s: AccountSettings) => Promise<void>
  /** The dollars till's own catch-up: a card to keep, a report to send. Asked as the page opens. */
  dollarsTill: TillBackend
}) {
  usePreloadBarcodes()
  const [own, setOwn] = useState<OwnCardRecord[] | null>(null)
  /** Every record kept, used up ones too: a card counted and used to nothing is still counted. */
  const [ownAll, setOwnAll] = useState<OwnCardRecord[]>([])
  const [soldBack, setSoldBack] = useState<SoldBackV2>({ credits: [], listings: [] })
  const [waiting, setWaiting] = useState<Awaited<ReturnType<typeof keepsWaitingV2>>>([])
  const [asking, setAsking] = useState(false)
  const [caught, setCaught] = useState(0)
  /** What asking the chain again came to that the list alone does not say: a card kept for less than it held, or one never kept. */
  const [caughtSaid, setCaughtSaid] = useState<string[]>([])
  const [selling, setSelling] = useState<string | null>(null)
  const [sold, setSold] = useState('')
  const [bought, setBought] = useState<CardRecord[]>([])
  const [pending, setPending] = useState<PurchaseRecord[]>([])
  const [removing, setRemoving] = useState<string | null>(null)
  const [counting, setCounting] = useState<string | null>(null)
  const [showing, setShowing] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [left, setLeft] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const [o, all, c, p, sold, w] = await Promise.all([
      storeCreditList(store, book, account),
      store.ownCards(),
      store.cards(),
      unfinishedPurchases(store),
      soldBackOf(book),
      keepsWaitingV2(book, account),
    ])
    setOwn(o)
    setOwnAll(all)
    setBought(c)
    setPending(p)
    setSoldBack(sold)
    setWaiting(w)
  }, [store, book, account])
  useEffect(() => {
    void refresh()
  }, [refresh, caught])
  useEffect(() => {
    let live = true
    void dollarsTill.catchUp?.().then(
      (out) => {
        if (!live) return
        setCaught((n) => n + 1)
        if ((out.said ?? []).length > 0) setCaughtSaid(out.said ?? [])
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [dollarsTill])
  const askAgain = useCallback(async () => {
    setAsking(true)
    try {
      const out = await dollarsTill.catchUp?.()
      if ((out?.said ?? []).length > 0) setCaughtSaid(out?.said ?? [])
    } catch {
      // Said by what is still waiting.
    } finally {
      setAsking(false)
      await refresh()
    }
  }, [dollarsTill, refresh])

  const keep = useCallback(
    async (card: CardRecord) => {
      setError('')
      try {
        await keepAsCredit(store, card, toCents(left), book)
        setCounting(null)
        setLeft('')
        await refresh()
      } catch (err) {
        setError(err instanceof CreditRefused ? err.message : 'That was not kept. Try again.')
      }
    },
    [store, left, refresh],
  )

  const remove = useCallback(
    async (r: OwnCardRecord) => {
      setError('')
      try {
        await removeCredit(store, book, r)
        setRemoving(null)
      } catch (err) {
        setError(err instanceof CreditRefused ? err.message : 'That was not taken off. Try again.')
      }
      await refresh()
    },
    [store, book, refresh],
  )

  // A first-escrow purchase whose payment went through, or may have, and whose card is not here yet.
  const finish = useCallback(
    async (id: string) => {
      setError('')
      if (ready === null) {
        setError(cardsOfflineLine(bought.length > 0))
        return
      }
      // This account's key as the page holds it now: one allowed a moment ago counts.
      if (wallet === null) {
        setError('Allow Salvo to spend with Face ID under Pay with first. Nothing will be paid twice.')
        return
      }
      setFinishing(true)
      try {
        const got = await resumePurchase({ store, api: ready.api, config: ready.config, access: ready.access, wallet }, id)
        setShowing(got[0]?.id ?? null)
      } catch (err) {
        setError(err instanceof LoadPending || err instanceof LoadRefused ? err.message : 'That did not finish. Nothing will be paid twice. Tap Finish it to try again.')
      } finally {
        setFinishing(false)
        await refresh()
      }
    },
    [store, ready, wallet, bought, refresh],
  )

  const cardOf = (id: string | undefined): CardRecord | null => (id === undefined ? null : (bought.find((c) => c.id === id) ?? null))
  const keepable = own === null ? [] : keepableCards(bought, ownAll, soldBack)
  // What /cards said under the cards, for the first escrow's cards only.
  const help = cardsHelp(keepable)
  return (
    <section className="group" aria-labelledby="credit">
      <h2 id="credit">Store credit</h2>
      <p className="hint mt-0">
        Gift cards that are yours. They stay on this phone, sealed.{' '}
        {payWith === 'card' ? CREDIT_CARD_RAIL : 'The till uses them first, at no cost.'}
      </p>
      {/* A toggle like "Most savings" and "Every week": the page's own control, never a raw checkbox. */}
      <div className="split mt-2 mb-3">
        <span id="credit-first">Use my store credit first</span>
        <button
          type="button"
          className="choice"
          aria-pressed={settings.ownCreditFirst}
          aria-labelledby="credit-first"
          disabled={payWith === 'card'}
          onClick={() => void onSave({ ...settings, ownCreditFirst: !settings.ownCreditFirst })}
        >
          {settings.ownCreditFirst ? 'On' : 'Off'}
        </button>
      </div>
      {caughtSaid.map((line) => (
        <p key={line} className="notice" role="status">
          {line}
        </p>
      ))}
      {waiting.map((w) => (
        <div key={w.purchaseId} className="notice" role="status">
          {keepWaitingLine(w.merchant, w.cards)}{' '}
          <button type="button" className="textlink" onClick={() => void askAgain()} disabled={asking}>
            {asking ? 'Asking…' : 'Try again'}
          </button>
        </div>
      ))}
      {pending.map((p) => (
        <div key={p.id} className="notice" role="status">
          <strong>
            {merchantLabel(p.merchant)}: {pendingHeadline(p)}
          </strong>{' '}
          <span className="notice--muted">{pendingLine(p)}</span>
          <div className="mt-2">
            <button type="button" className="textlink textlink--tap" onClick={() => void finish(p.id)} disabled={finishing}>
              {finishing ? 'Finishing…' : 'Finish it'}
            </button>
          </div>
        </div>
      ))}
      {sold !== '' && (
        <p className="notice notice--neutral" role="status">
          {sold}
        </p>
      )}
      {own === null ? (
        <p className="hint hint--deferred">Opening this phone&rsquo;s cards…</p>
      ) : (
        <div className="rows">
          {own.map((r) => {
            const card = cardOf(r.keptCardId)
            return (
              <article key={r.id} className="card">
                <div className="split">
                  <div>
                    <div className="strong">
                      {merchantLabel(r.merchant)} <span className="num">{money(r.balanceCents)}</span>{' '}
                      <span className="muted">{r.keptCardId === undefined ? '(your card)' : '(bought here)'}</span>
                    </div>
                    <p className="hint">
                      <span className="num">···· {r.last4}</span>
                    </p>
                  </div>
                  {selling !== r.id && (
                    <button type="button" className="textlink" onClick={() => setSelling(r.id)}>
                      Sell it
                    </button>
                  )}
                </div>
                {selling === r.id && (
                  <SellCredit
                    store={store}
                    card={r}
                    onClose={() => setSelling(null)}
                    onListed={(line) => {
                      setSelling(null)
                      setSold(line)
                      void refresh()
                    }}
                  />
                )}
                <div className="cluster">
                  {card !== null && (
                    <button type="button" className="textlink" onClick={() => setShowing(showing === card.id ? null : card.id)} aria-expanded={showing === card.id}>
                      {showing === card.id ? 'Hide code' : 'Show code'}
                    </button>
                  )}
                  {removing === r.id ? (
                    <p className="hint">
                      {r.keptCardId === undefined ? 'The number is deleted from this phone. ' : 'The till stops using it. '}
                      <button type="button" className="textlink" onClick={() => void remove(r)}>
                        Remove it
                      </button>{' '}
                      ·{' '}
                      <button type="button" className="textlink" onClick={() => setRemoving(null)}>
                        Keep it
                      </button>
                    </p>
                  ) : (
                    <button type="button" className="textlink" onClick={() => setRemoving(r.id)}>
                      Remove
                    </button>
                  )}
                </div>
                {card !== null && showing === card.id && (
                  // A live code: the bar's links step aside while it shows (globals.css data-live), as on the till.
                  <div className="reveal" data-live="">
                    <CardCodeFigure store={store} card={card} />
                  </div>
                )}
              </article>
            )
          })}
          {keepable.map((c) => (
            <article key={c.id} className="card">
              <div className="split">
                <div>
                  <div className="strong">
                    {merchantLabel(c.merchant)} card bought on this phone <span className="num muted">···· {c.last4}</span>
                  </div>
                  <p className="hint">
                    <span className="num">{money(c.valueCents)}</span> on it when you bought it
                    {c.ofCards > 1 ? ` · scan ${c.scanOrder} of ${c.ofCards}` : ''}
                  </p>
                </div>
                <button type="button" className="btn btn--secondary" onClick={() => setShowing(showing === c.id ? null : c.id)} aria-expanded={showing === c.id}>
                  {showing === c.id ? 'Hide code' : 'Show code'}
                </button>
              </div>
              {showing === c.id && (
                <div className="reveal" data-live="">
                  <CardCodeFigure store={store} card={c} />
                </div>
              )}
              {counting !== c.id ? (
                <button
                  type="button"
                  className="textlink textlink--tap mt-2"
                  onClick={() => {
                    setCounting(c.id)
                    setLeft('')
                    setError('')
                  }}
                >
                  Count what is left as store credit
                </button>
              ) : (
                <div className="field">
                  <label htmlFor={`left-${c.id}`}>What is left on it?</label>
                  <div className="affix">
                    <span className="affix__mark" aria-hidden="true">
                      $
                    </span>
                    <input id={`left-${c.id}`} className="num" value={left} onChange={(e) => setLeft(e.target.value)} inputMode="decimal" placeholder="0.00" />
                  </div>
                  <button type="button" className="btn btn--secondary mt-3" onClick={() => void keep(c)}>
                    Add to store credit
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {own !== null && own.length === 0 && keepable.length === 0 && pending.length === 0 && <p className="hint">No store credit yet.</p>}
      {help.map((line) => (
        <p key={line} className="hint">
          {line}
        </p>
      ))}
      {error !== '' && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <AddOwnCard store={store} onAdded={() => void refresh()} />
    </section>
  )
}

/**
 * [Sell it] on one card of store credit: the price asked, then the listing,
 * sealed again on this phone and listed on the escrow (sell-credit.ts). The
 * first sale sets up this phone's seller key: one Face ID.
 */
function SellCredit({
  store,
  card,
  onClose,
  onListed,
}: {
  store: CardStore
  card: OwnCardRecord
  onClose: () => void
  onListed: (line: string) => void
}) {
  const [ask, setAsk] = useState(((Math.floor(card.balanceCents * 0.9) || 1) / 100).toFixed(2))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const d = await sellCreditSession(store)
      const listed = await sellOwnCredit(d, card, toCents(ask))
      onListed(`Listed: ${merchantLabel(listed.merchant)} ${money(listed.valueCents)} for ${unitsToMoney(BigInt(listed.priceUnits))}. You are paid a day after it sells. It shows under Selling.`)
    } catch (err) {
      // It may be listed on chain: off the list now, and said as it is.
      if (err instanceof SellRefused && err.sentOnChain) onListed(err.message)
      else setError(faceIdCancelled(err) ? 'Face ID was cancelled, so nothing was listed.' : err instanceof Error && err.message ? err.message : 'That was not listed. Try again.')
    } finally {
      setBusy(false)
    }
  }, [store, card, ask, onListed])
  return (
    <div className="field">
      <label htmlFor={`ask-${card.id}`}>
        Sell {money(card.balanceCents)} for
      </label>
      <div className="affix">
        <span className="affix__mark" aria-hidden="true">
          $
        </span>
        <input id={`ask-${card.id}`} className="num" value={ask} onChange={(e) => setAsk(e.target.value)} inputMode="decimal" />
      </div>
      <p className="hint">Sold on the escrow to the next shopper at this store. You are paid once they have used it.</p>
      <div className="cluster mt-3">
        <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void go()}>
          {busy ? 'Listing…' : 'List it'}
        </button>
        <button type="button" className="textlink" disabled={busy} onClick={onClose}>
          Not now
        </button>
      </div>
      {error !== '' && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function AddOwnCard({ store, onAdded }: { store: CardStore; onAdded: () => void }) {
  const [merchant, setMerchant] = useState<EscrowMerchantName | ''>('')
  const [cardNumber, setCardNumber] = useState('')
  const [pin, setPin] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [added, setAdded] = useState('')
  const field = numberField(merchant)
  const hasPin = merchant !== '' && ESCROW_MERCHANTS[merchant].pin !== null

  const submit = useCallback(async () => {
    if (merchant === '') {
      setError('Pick the store the card is from.')
      return
    }
    setBusy(true)
    setError('')
    setAdded('')
    try {
      const r = await addOwnCard(store, { merchant, cardNumber, pin: pin === '' ? null : pin, balanceCents: toCents(value) })
      // Kept and sealed: the number leaves this page now.
      setCardNumber('')
      setPin('')
      setValue('')
      setAdded(`${merchantLabel(r.merchant)} ${money(r.balanceCents)} is in your store credit.`)
      onAdded()
    } catch (err) {
      setError(err instanceof CreditRefused ? err.message : 'That card was not kept. Try again.')
    } finally {
      setBusy(false)
    }
  }, [store, merchant, cardNumber, pin, value, onAdded])

  return (
    <details className="quiet-disclosure mt-6">
      <summary>Add a gift card you own</summary>
      <p className="hint mt-2">It is sealed on this phone and never sent to Salvo.</p>
      <fieldset className="fieldgroup">
        <legend className="label">Where is it from?</legend>
        <div className="cluster">
          {CREDIT_STORES.map((m) => (
            <button key={m} type="button" className="choice" aria-pressed={merchant === m} onClick={() => setMerchant(m)}>
              {merchantLabel(m)}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="row card-pin">
        <div>
          <label htmlFor="own-card">{field.label}</label>
          <input
            id="own-card"
            value={cardNumber}
            onChange={(e) => setCardNumber(e.target.value.replace(/\s+/g, ''))}
            inputMode="numeric"
            autoComplete="off"
            aria-describedby={field.hint ? 'own-card-hint' : undefined}
          />
          {field.hint && (
            <p id="own-card-hint" className="hint">
              {field.hint}
            </p>
          )}
        </div>
        {hasPin && (
          <div>
            <label htmlFor="own-pin">PIN</label>
            <input id="own-pin" value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" autoComplete="off" placeholder="If it has one" />
          </div>
        )}
      </div>
      <div className="field">
        <label htmlFor="own-value">What is on it?</label>
        <div className="affix">
          <span className="affix__mark" aria-hidden="true">
            $
          </span>
          <input id="own-value" className="num" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="25.00" />
        </div>
      </div>
      {error !== '' && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
      {added !== '' && (
        <div className="notice notice--neutral" role="status">
          {added}
        </div>
      )}
      <button type="button" className={busy ? 'btn btn--secondary btn--block is-working' : 'btn btn--secondary btn--block'} onClick={() => void submit()} disabled={busy}>
        {busy && <span className="spinner" aria-hidden="true" />}
        {busy ? 'Sealing it on this phone…' : 'Add to store credit'}
      </button>
    </details>
  )
}
