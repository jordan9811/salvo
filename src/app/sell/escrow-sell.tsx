'use client'

/**
 * /sell, the Salvo Pay branch: sell a card for test dollars, sealed in this
 * browser (spec section 8.2). Shown only when the server runs the escrow
 * rail (ESCROW_RAIL=testnet); the usual /sell is untouched otherwise.
 *
 * ON THE NEW ESCROW ONCE IT IS OPEN. With SalvoEscrowV2 open here
 * (config-v2.ts ESCROW_V2_LIVE), every new listing goes on V2
 * (escrow-sell-v2.tsx), where shoppers pay at the till for only what they
 * use; the first escrow takes no new listing. A seller's listings on the
 * first escrow stay here below the form, with Get paid, Claim and Take it
 * back, until each is settled: what it sold still releases and pays out.
 * The seller key is set up again for V2 (one Face ID), and it can still take
 * a first-escrow listing back. The rest of this header is the first
 * escrow's page, which is what shows while V2 is not open.
 *
 * THE CARD IS SEALED BEFORE IT LEAVES THE FIELD. The number and PIN typed
 * here are sealed on this device to the card service's key, and only the
 * sealed copy goes anywhere: on chain as a hash, to Salvo as ciphertext. The
 * fields are cleared the moment the listing is made. Nobody, Salvo included,
 * can open it without a buyer paying the seller first.
 *
 * WHAT A SELLER NEEDS TO KNOW, WHERE THEY DECIDE: what they get, that their
 * payout address is their own account, that they can take the card back
 * until it sells, and that a sold card must not be used.
 *
 * SAID BEFORE THE CARD NUMBER, NOT AFTER THE REFUSAL, as the usual /sell does:
 *   - first, that this is the test chain: buyers pay with free test dollars,
 *     so anyone could buy a real card listed here; the store picker offers
 *     the Salvo test card and Target;
 *   - while our server takes no listings (the custody guard, an empty test
 *     list), a plain sentence and no card field at all. The seller account
 *     is still offered: it takes no card, and its address is what the test
 *     list needs, so a first seller can always get on it. Nothing re-reads
 *     the config by itself, so the sentence says to reload;
 *   - next to the payout address, that a seller must be on the test list.
 *
 * A SOLD CARD SAYS WHAT ITS SALE SAYS. The listing stays "sold" on chain
 * forever, so each row reads its sale (getDeposit): held until a time,
 * disputed, paid, or refunded, and its money line is the sale's too. Once a
 * sale is due, disputed or not, the seller can collect it here with Get paid;
 * nothing waits on a keeper that may not be running. A payout the token
 * would not send waits in the escrow as `owed`, and Claim sends it again.
 */

import { CopyButton } from '../copy-button'
import { DiscountSlider } from './discount-slider'
import { InfoTip } from '../info-tip'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import type { ListingRecord } from '@/lib/escrow/client/card-store'
import {
  cancelListing,
  collectOwed,
  collectPayout,
  ESCROW_SELL_STORES,
  forgetListing,
  LISTING_CLOSED_SENTENCE,
  listCard,
  listingFileText,
  listingStates,
  owedTo,
  recordListing,
  SellRefused,
  type ListingView,
  type SellDeps,
} from '@/lib/escrow/client/sell'
import { requestTestDollars, setUpDeviceWallet, type DeviceWallet } from '@/lib/escrow/client/wallet'
import { escrowApiV2 } from '@/lib/escrow/client/api-v2'
import { openDeviceBookV2 } from '@/lib/escrow/client/records-v2'
import { keyScopedForV2, setUpDeviceWalletV2 } from '@/lib/escrow/client/wallet-v2'
import { createDeviceAccount } from '@/lib/account/client/passkey'
import { SellFormV2, type SellV2Session } from './escrow-sell-v2'
import { MERCHANT_BARCODE_PROFILES } from '@/lib/barcode/merchants'
import { ESCROW_MERCHANTS, type EscrowMerchantName } from '@/lib/escrow/merchants'
import { money } from '../ui'
import { useFits } from '../use-fits'
import {
  ESCROW_SELL_WARNING,
  ESCROW_SELL_WARNING_MORE,
  LISTING_CLOSED_NEXT,
  LISTING_FILE_LINE,
  owedLine,
  saleLine,
  SELLER_KEY_LINE,
  sellerMoneyLine,
  setupFaceIdLine,
  setupStoppedSentence,
  TEST_LIST_LINE,
} from '../pay/escrow-copy'
import { ESCROW_STORES, merchantLabel, SessionNotice, shortAddress, unitsToMoney, useEscrowDevice, type DeviceSession } from '../pay/escrow-ui'

type Ready = Extract<DeviceSession, { phase: 'ready' }>

const STEP_WORDS = {
  checking: 'Checking the escrow…',
  sealing: 'Sealing on this device…',
  listing: 'Listing on chain…',
  recording: 'Telling Salvo…',
} as const

/** The stores a seller may pick here while this rail runs on a testnet (sell.ts, ESCROW_SELL_STORES). */
const SELL_STORES = ESCROW_STORES.filter((m) => ESCROW_SELL_STORES.includes(m.name))

/** A Face ID the person cancelled, however deep the library wrapped it. */
function cancelled(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e instanceof Error && i < 6; e = (e as Error & { cause?: unknown }).cause, i++) {
    if (e.name === 'NotAllowedError') return true
  }
  return false
}

function numberField(m: EscrowMerchantName | ''): { label: string; hint: string | null } {
  if (m === '') return { label: 'Card number', hint: null }
  if (m === 'salvotest') return { label: 'Test card number', hint: 'A test card: 9999 and twelve more digits.' }
  const p = MERCHANT_BARCODE_PROFILES[m]
  return { label: p?.numberLabel ?? 'Card number', hint: p?.numberHint ?? null }
}

function download(r: ListingRecord, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `salvo-listing-${r.listingId.slice(2, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** SalvoEscrowV2 here: still asking, not open (the first escrow's page shows), or open with this phone's V2 book. */
type V2Seller = { phase: 'loading' } | { phase: 'off' } | { phase: 'open'; session: SellV2Session }

function useSellerV2(session: DeviceSession): V2Seller {
  const [v2, setV2] = useState<V2Seller>({ phase: 'loading' })
  const store = session.phase === 'ready' ? session.store : null
  useEffect(() => {
    if (store === null) return
    let live = true
    void (async () => {
      const api = escrowApiV2()
      const cfg = await api.config().catch(() => null)
      if (cfg === null || cfg.state !== 'ready') {
        if (live) setV2({ phase: 'off' })
        return
      }
      const book = await openDeviceBookV2().catch(() => null)
      if (!live) return
      if (book === null) {
        setV2({ phase: 'off' })
        return
      }
      const access = { hosts: { urls: cfg.config.rpcUrls, timeoutMs: 10_000 }, sponsorUrl: cfg.config.sponsorUrl }
      setV2({ phase: 'open', session: { store, book, api, config: cfg.config, access } })
    })()
    return () => {
      live = false
    }
  }, [store])
  return v2
}

export function EscrowSell() {
  const { session, reload, setWallet } = useEscrowDevice('seller')
  const v2 = useSellerV2(session)
  return (
    <>
      <p className="notice notice--neutral mb-6" role="note">
        <strong>{ESCROW_SELL_WARNING}</strong>
        <InfoTip label="About the test network">{ESCROW_SELL_WARNING_MORE}</InfoTip>
      </p>
      {session.phase !== 'ready' ? (
        <SessionNotice session={session} onRetry={reload} />
      ) : v2.phase === 'loading' ? (
        <p className="hint hint--deferred" aria-busy="true">
          Checking the escrow…
        </p>
      ) : v2.phase === 'open' ? (
        <SellOnV2 session={session} v2={v2.session} onWallet={setWallet} />
      ) : (
        <>
          {!session.config.listingOpen && (
            <div className="notice mb-6" role="status">
              <strong>{LISTING_CLOSED_SENTENCE}</strong> <span className="notice--muted">{LISTING_CLOSED_NEXT}</span>
            </div>
          )}
          {/* The account takes no card, so it is offered whether or not listing is open: its address is what the test list needs. */}
          {session.wallet !== null ? <SellForm session={session} wallet={session.wallet} /> : <SellerSetUp session={session} onDone={setWallet} />}
        </>
      )}
    </>
  )
}

/**
 * The new escrow's page: its form and listings, then any listings this
 * seller still has on the first escrow, which settle as they always did.
 */
function SellOnV2({ session, v2, onWallet }: { session: Ready; v2: SellV2Session; onWallet: (w: DeviceWallet) => void }) {
  const wallet = session.wallet
  const keyed = wallet !== null && keyScopedForV2(wallet, v2.config.escrow)
  return (
    <>
      {!v2.config.listingOpen && (
        <div className="notice mb-6" role="status">
          <strong>{LISTING_CLOSED_SENTENCE}</strong> <span className="notice--muted">{LISTING_CLOSED_NEXT}</span>
        </div>
      )}
      {keyed ? <SellFormV2 session={v2} wallet={wallet} /> : <SellerSetUp session={session} v2={v2} onDone={onWallet} />}
      {wallet !== null && <SellForm session={session} wallet={wallet} firstEscrowOnly />}
    </>
  )
}

function SellerSetUp({ session, v2 = null, onDone }: { session: Ready; v2?: SellV2Session | null; onDone: (w: DeviceWallet) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [passkeyKept, setPasskeyKept] = useState(false)
  useEffect(() => {
    void session.store
      .passkey()
      .then((p) => setPasskeyKept(p !== null))
      .catch(() => setPasskeyKept(false))
  }, [session])
  // TESTER PATH: a browser key as the account, then the seller key from it. To replace after the Target test.
  const goWithoutFaceId = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      if ((await session.store.passkey()) === null) await createDeviceAccount(session.store)
      onDone(
        v2 !== null
          ? await setUpDeviceWalletV2(session.store, 'seller', { escrow: v2.config.escrow, v1Escrow: v2.config.v1Escrow })
          : await setUpDeviceWallet(session.store, 'seller', { escrow: session.config.escrow }),
      )
    } catch (err) {
      setError(`That did not work: ${err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 160) : String(err).slice(0, 160)}`)
    } finally {
      setBusy(false)
    }
  }, [session, v2, onDone])
  const go = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      onDone(
        v2 !== null
          ? await setUpDeviceWalletV2(session.store, 'seller', { escrow: v2.config.escrow, v1Escrow: v2.config.v1Escrow })
          : await setUpDeviceWallet(session.store, 'seller', { escrow: session.config.escrow }),
      )
    } catch (err) {
      // The passkey is made at the first Face ID, before the second, so say what is true.
      const kept = (await session.store.passkey().catch(() => null)) !== null
      setPasskeyKept(kept)
      setError(setupStoppedSentence({ cancelled: cancelled(err), passkeyKept: kept }))
    } finally {
      setBusy(false)
    }
  }, [session, v2, onDone])
  return (
    <section className="group">
      <h2 className="mt-0">
        Your seller account
        <InfoTip label="About your seller account">
          {v2 !== null && session.wallet !== null ? 'Salvo Pay has a new escrow, where shoppers pay at the till for only what they use. One Face ID sets this device up to list on it. ' : ''}
          You are paid to your own account, a passkey on this device. Salvo holds no key to it. {setupFaceIdLine(passkeyKept)}
          <br />
          <strong>What this device can do:</strong> {SELLER_KEY_LINE}
        </InfoTip>
      </h2>
      <p className="sub">Paid to an account only you hold.</p>
      {error !== '' && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
      <button type="button" className={busy ? 'btn btn--primary btn--block is-working' : 'btn btn--primary btn--block'} onClick={() => void go()} disabled={busy}>
        {busy && <span className="spinner" aria-hidden="true" />}
        {busy ? 'Waiting for Face ID…' : 'Set up with Face ID'}
      </button>
      {/* TESTER PATH, no passkey: for a laptop with nothing to do Face ID. To replace after the Target test. */}
      <button type="button" className="btn btn--secondary btn--block mt-3" onClick={() => void goWithoutFaceId()} disabled={busy}>
        Set up without Face ID (tester)
      </button>
    </section>
  )
}

/**
 * The first escrow's form and listings. `firstEscrowOnly`: the new escrow is
 * open, so this lists nothing new and shows only the listings still on the
 * first escrow, with what is owed, and nothing at all when there are none.
 */
function SellForm({ session, wallet, firstEscrowOnly = false }: { session: Ready; wallet: DeviceWallet; firstEscrowOnly?: boolean }) {
  const deps: SellDeps = { store: session.store, api: session.api, config: session.config, access: session.access, wallet }
  const storesRef = useRef<HTMLDivElement>(null)
  useFits(storesRef)
  const [merchant, setMerchant] = useState<EscrowMerchantName | ''>('')
  const [cardNumber, setCardNumber] = useState('')
  const [pin, setPin] = useState('')
  const [value, setValue] = useState('')
  const [discount, setDiscount] = useState(10)
  const [step, setStep] = useState<keyof typeof STEP_WORDS | null>(null)
  const [error, setError] = useState('')
  const [listed, setListed] = useState<ListingRecord | null>(null)
  const [listings, setListings] = useState<ListingRecord[]>([])
  const [views, setViews] = useState<Map<Hex, ListingView>>(new Map())
  const [chainTime, setChainTime] = useState(0)
  const [balance, setBalance] = useState<bigint | null>(null)
  const [owed, setOwed] = useState(0n)
  const [funding, setFunding] = useState(false)
  const [rowBusy, setRowBusy] = useState<Hex | null>(null)
  const [claiming, setClaiming] = useState(false)

  const field = numberField(merchant)
  const hasPin = merchant !== '' && ESCROW_MERCHANTS[merchant].pin !== null
  const valueCents = Math.round(Number(value.replace(/[^0-9.]/g, '')) * 100)
  const priceCents = Number.isFinite(valueCents) && valueCents > 0 ? Math.max(1, Math.round(valueCents * (1 - discount / 100))) : 0

  const refresh = useCallback(async () => {
    const mine = await session.store.listings()
    setListings(mine)
    try {
      const read = await listingStates(session.access, session.config, mine, session.store)
      setViews(read.views)
      setChainTime(read.chainTime)
      setBalance(await wallet.balance(session.access.hosts))
      setOwed(await owedTo(session.access, session.config, wallet.account))
      // A sale found just now is kept on its listing; show the kept copy.
      setListings(await session.store.listings())
    } catch {
      // The chain could not be read; the rows say so by having no state.
    }
  }, [session, wallet])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const submit = useCallback(async () => {
    if (merchant === '') {
      setError('Pick where the card is from.')
      return
    }
    setError('')
    setListed(null)
    setStep('checking')
    try {
      const r = await listCard(deps, { merchant, cardNumber: cardNumber.trim(), pin: pin.trim() === '' ? null : pin.trim(), valueCents, priceCents }, setStep)
      // The card is sealed and gone from this page.
      setCardNumber('')
      setPin('')
      setValue('')
      setListed(r)
    } catch (err) {
      setError(err instanceof SellRefused ? err.message : 'Something went wrong on this device. Nothing was listed.')
    } finally {
      setStep(null)
      await refresh()
    }
  }, [deps, merchant, cardNumber, pin, valueCents, priceCents, refresh])

  const takeBack = useCallback(
    async (r: ListingRecord) => {
      setRowBusy(r.listingId)
      try {
        await cancelListing(deps, r)
      } catch (err) {
        setError(err instanceof SellRefused ? err.message : 'That did not go through. Try again.')
      } finally {
        setRowBusy(null)
        await refresh()
      }
    },
    [deps, refresh],
  )

  const getPaid = useCallback(
    async (r: ListingRecord) => {
      setRowBusy(r.listingId)
      setError('')
      try {
        await collectPayout(deps, wallet, r)
      } catch (err) {
        setError(
          err instanceof SellRefused
            ? err.message
            : cancelled(err)
              ? 'Cancelled. Nothing was sent.'
              : 'That did not go through. Check you have test dollars for the fee, then try again.',
        )
      } finally {
        setRowBusy(null)
        await refresh()
      }
    },
    [deps, wallet, refresh],
  )

  const claim = useCallback(async () => {
    setClaiming(true)
    setError('')
    try {
      await collectOwed(deps, wallet)
    } catch (err) {
      setError(cancelled(err) ? 'Cancelled. Nothing was sent.' : 'The claim did not go through. The money stays in the escrow; try again later.')
    } finally {
      setClaiming(false)
      await refresh()
    }
  }, [deps, wallet, refresh])

  const resend = useCallback(
    async (r: ListingRecord) => {
      setRowBusy(r.listingId)
      setError('')
      try {
        // The route's own sentence when trying again cannot help; "try again in a minute" when it can.
        const why = await recordListing(deps, r)
        if (why !== null) setError(why)
      } catch {
        setError('Salvo did not take it yet. Try again in a minute.')
      } finally {
        setRowBusy(null)
        await refresh()
      }
    },
    [deps, refresh],
  )

  const remove = useCallback(
    async (r: ListingRecord) => {
      setRowBusy(r.listingId)
      setError('')
      try {
        await forgetListing(deps, r)
      } catch (err) {
        setError(err instanceof SellRefused ? err.message : 'We cannot read the chain right now, so it stays for now. Try again in a minute.')
      } finally {
        setRowBusy(null)
        await refresh()
      }
    },
    [deps, refresh],
  )

  const getDollars = useCallback(async () => {
    setFunding(true)
    try {
      await requestTestDollars(session.access.hosts, wallet.account)
    } catch {
      setError('The faucet did not answer. Try again in a minute.')
    } finally {
      setFunding(false)
      await refresh()
    }
  }, [session, wallet, refresh])

  if (firstEscrowOnly && listings.length === 0 && owedLine(owed) === null) return null
  return (
    <>
      {firstEscrowOnly ? (
        error !== '' && (
          <div className="err" role="alert">
            {error}
          </div>
        )
      ) : (
        <>
      <dl className="stack kv mb-2">
        <div className="split">
          <dt className="text-2">
            Paid to
            <InfoTip label="About this address">{TEST_LIST_LINE}</InfoTip>
          </dt>
          <dd className="num muted" title={wallet.account}>
            {shortAddress(wallet.account)}{' '}
            <CopyButton text={wallet.account} />
          </dd>
        </div>
        {/* Shown with or without a sponsor: Get paid is sent from this account, and pays its own fee. */}
        <div className="split">
          <dt className="text-2">Test dollars</dt>
          <dd className="num">{balance === null ? '…' : unitsToMoney(balance)}</dd>
        </div>
      </dl>
      <button type="button" className="btn btn--secondary btn--block mt-4 mb-6" onClick={() => void getDollars()} disabled={funding}>
        {funding ? 'Asking the faucet…' : 'Get test dollars'}
      </button>

      {session.config.listingOpen && (
        <>
      <fieldset className="fieldgroup">
        <legend className="label">Where is it from?</legend>
        <div className="cluster cluster--scroll" ref={storesRef}>
          {SELL_STORES.map((m) => (
            <button key={m.name} type="button" className="choice" aria-pressed={merchant === m.name} onClick={() => setMerchant(m.name)}>
              {m.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="row card-pin">
        <div>
          <label htmlFor="escrow-card">{field.label}</label>
          <input
            id="escrow-card"
            value={cardNumber}
            onChange={(e) => setCardNumber(e.target.value.replace(/\s+/g, ''))}
            inputMode="numeric"
            autoComplete="off"
            aria-describedby={field.hint ? 'escrow-card-hint' : undefined}
          />
          {field.hint && (
            <p id="escrow-card-hint" className="hint">
              {field.hint}
            </p>
          )}
        </div>
        {hasPin && (
          <div>
            <label htmlFor="escrow-pin">PIN</label>
            <input id="escrow-pin" value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" autoComplete="off" placeholder="If it has one" />
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="escrow-value">What is on it?</label>
        <div className="affix">
          <span className="affix__mark" aria-hidden="true">
            $
          </span>
          <input id="escrow-value" className="num" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="25.00" />
        </div>
        <p className="hint">Up to $25 while you are new here. Bigger cards open up once your sales have paid you that much.</p>
      </div>

      <div className="field">
        <label htmlFor="escrow-discount" className="split">
          <span>Discount</span>
          <span className="num text-2">{discount}% off</span>
        </label>
        <DiscountSlider id="escrow-discount" discount={discount} onChange={setDiscount} />
      </div>

      <section className="group answer" aria-live="polite">
        <div className="eyebrow">You get</div>
        <div className={priceCents > 0 ? 'display mt-2' : 'display mt-2 muted'}>{priceCents > 0 ? money(priceCents) : '—'}</div>
        <p className="answer__sub">
          The escrow holds it for a day after a buyer loads your card. Then it is yours: tap Get paid here. Take the card back any time
          before it sells.
        </p>
      </section>

      {error !== '' && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
      <button
        type="button"
        className={step !== null ? 'btn btn--primary btn--block is-working' : 'btn btn--primary btn--block'}
        onClick={() => void submit()}
        disabled={step !== null}
      >
        {step !== null && <span className="spinner" aria-hidden="true" />}
        {step !== null ? STEP_WORDS[step] : 'Seal it and list it'}
      </button>
      <p className="hint">The card is sealed on this device, and Salvo stores only the sealed copy. Until the custody review, treat this page like any site you type a card into.</p>
        </>
      )}
      {!session.config.listingOpen && error !== '' && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
        </>
      )}

      {listed !== null && (
        <div className="notice notice--neutral mt-6" role="status">
          <strong>Listed.</strong> {LISTING_FILE_LINE}{' '}
          <button type="button" className="textlink" onClick={() => download(listed, listingFileText(listed, session.config))}>
            Download your listing file
          </button>
        </div>
      )}

      {owedLine(owed) !== null && (
        <div className="notice mt-6" role="status">
          <strong>{owedLine(owed)}</strong>{' '}
          <button type="button" className="textlink" onClick={() => void claim()} disabled={claiming || rowBusy !== null}>
            {claiming ? 'Waiting for Face ID…' : 'Claim'}
          </button>
        </div>
      )}

      {listings.length > 0 && (
        <section>
          <hr className="divide" />
          <h2 className="mt-0">{firstEscrowOnly ? 'Your cards on the first escrow' : 'Your cards for Salvo Pay'}</h2>
          {firstEscrowOnly && <p className="hint">Listed before the new escrow opened. They settle as they always did; nothing new is listed here.</p>}
          {listings.map((r) => {
            const view = views.get(r.listingId)
            const state = view?.state
            const said = saleLine(view, r, chainTime, owed)
            const moneyLine = sellerMoneyLine(view, r, chainTime)
            return (
              <article key={r.listingId} className="card">
                <div className="split">
                  <div>
                    <div className="strong">{merchantLabel(r.merchant)}</div>
                    <p className="hint">
                      <span className="num">{money(r.valueCents)}</span> card{moneyLine === null ? '' : ` · ${moneyLine}`}
                    </p>
                    <p className="hint">{said.line}</p>
                  </div>
                  {said.pill !== '' && <span className={view?.sale?.state === 'paid' ? 'pill pill--ok' : 'pill'}>{said.pill}</span>}
                </div>
                <div className="cluster mt-3">
                  {said.canCollect && (
                    <button type="button" className="btn btn--primary" onClick={() => void getPaid(r)} disabled={rowBusy !== null}>
                      {rowBusy === r.listingId ? 'Waiting for Face ID…' : 'Get paid'}
                    </button>
                  )}
                  {state === 'listed' && (
                    <button type="button" className="btn btn--secondary" onClick={() => void takeBack(r)} disabled={rowBusy !== null}>
                      {rowBusy === r.listingId ? 'Taking it back…' : 'Take it back'}
                    </button>
                  )}
                  {said.canResend && (
                    <button type="button" className="btn btn--ghost" onClick={() => void resend(r)} disabled={rowBusy !== null}>
                      Send to Salvo again
                    </button>
                  )}
                  {said.canRemove && (
                    <button type="button" className="btn btn--ghost" onClick={() => void remove(r)} disabled={rowBusy !== null}>
                      {rowBusy === r.listingId ? 'Checking the chain…' : 'Remove'}
                    </button>
                  )}
                  <button type="button" className="btn btn--ghost" onClick={() => download(r, listingFileText(r, session.config))}>
                    Listing file
                  </button>
                </div>
              </article>
            )
          })}
        </section>
      )}
    </>
  )
}
