'use client'

/**
 * /sell — list a gift card, and see what happened to it.
 *
 * The whole product promise for a seller is "scan it in, forget about it", so
 * this is four fields and a button. No account, no wallet connection, no
 * explanation of custody or settlement — a seller does not need to know what a
 * reveal window is to sell a card.
 *
 * Three things are deliberately visible because they change the seller's
 * decision, and each is placed where the decision is made rather than in terms:
 *
 *   - what they will be paid, updated as they move the discount;
 *   - that they can take the card back until someone buys it, which is the
 *     reason listing costs them nothing;
 *   - that a merchant whose balance we cannot check carries more risk.
 *
 * WHERE THE ESCROW RAIL RUNS (ESCROW_RAIL=testnet, read by page.tsx on the
 * server), a seller can choose Salvo Pay instead: the card is sealed in this
 * browser and sold for test dollars through the escrow (escrow-sell.tsx).
 * Everywhere else this screen is exactly what it was.
 */

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppBar } from '../app-bar'
import { useFits } from '../use-fits'
import { Sal } from '../sal'
import { DiscountSlider } from './discount-slider'
import { InfoTip } from '../info-tip'
import {
  SUPPORTED_MERCHANTS,
  blindMerchantNotice,
  merchantBalanceReadable,
  merchantName,
  money,
} from '../ui'

/*
  LOADED ONLY WHEN CHOSEN. The Salvo Pay branch carries the wallet, the seal
  and the chain client; a seller who never picks it, and every seller where
  the rail is off, downloads none of it.
*/
const EscrowSell = dynamic(() => import('./escrow-sell').then((m) => m.EscrowSell), {
  ssr: false,
  loading: () => <p className="hint hint--deferred">Opening Salvo Pay…</p>,
})

interface Estimate {
  basis: 'fitted' | 'illustrative'
  caveat: string | null
  daysToSell: number
  daysToSellRange: { low: number; high: number }
  proceedsCents: number
  takeNowCents: number
  onSaleCents: number
  upfrontBps: number
  pooled: boolean
  mutualisationNotice: string
}

interface Listing {
  intentId: string
  merchantId: string
  last4: string
  faceValueCents: number
  priceCents: number
  discountBps: number
  state: string
  label: string
  detail: string
  paidOut: boolean
  payoutRail: string | null
}

/*
 * Status colour per label, and almost all of them have none. These borrowed
 * the operator page's traffic-light colours — "In use" in the amber reserved
 * for money at risk, "Listed" in link blue. Only the two states a seller must
 * notice get colour: money arriving, and a failure. Everything else is muted.
 */
const PILL_CLASS: Record<string, string> = {
  'Paid out': 'pill--ok',
  Failed: 's-failed',
}

export function SellClient({ escrowRail }: { escrowRail: boolean }) {
  /** "usual" is fiat, the listing this screen always had; "escrow" is crypto, offered only where the rail runs, and first where it does. */
  const [mode, setMode] = useState<'usual' | 'escrow'>(escrowRail ? 'escrow' : 'usual')
  // No store pre-picked, as on /shop: a default answered "Where is it from?"
  // for anyone who did not look, and listed a Walmart card as Best Buy.
  const storesRef = useRef<HTMLDivElement>(null)
  useFits(storesRef)
  const [merchantId, setMerchantId] = useState<string>('')
  const numberField = SUPPORTED_MERCHANTS.find((m) => m.id === merchantId)
  const [cardNumber, setCardNumber] = useState('')
  const [pin, setPin] = useState('')
  const [value, setValue] = useState('')
  const [discount, setDiscount] = useState(10)
  const [errors, setErrors] = useState<string[]>([])
  /** From the server: whether a listing can be sealed at all. Null until known. */
  const [listingOpen, setListingOpen] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [listings, setListings] = useState<Listing[]>([])
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  /** True whenever the inputs have moved since the estimate on screen was fetched. */
  const [estimateStale, setEstimateStale] = useState(false)
  const seq = useRef(0)

  const faceCents = Math.round(Number(value.replace(/[^0-9.]/g, '')) * 100)
  const payout =
    Number.isFinite(faceCents) && faceCents > 0
      ? Math.round(faceCents * (1 - discount / 100))
      : 0

  // The slider is the decision, so the numbers have to move with it. Debounced
  // because a drag fires this on every pixel, and read-only because dragging a
  // slider must never create state.
  useEffect(() => {
    if (!(faceCents > 0) || merchantId === '') {
      setEstimate(null)
      setEstimateStale(false)
      return
    }
    /*
      THE NUMBERS ON SCREEN HAVE TO BELONG TO THE NUMBERS IN THE FORM.

      Two things were wrong here and they compounded. There was no sequence
      guard, so a slow early response could land on top of a fast later one —
      `/shop` has had one since it shipped and this never got the same
      treatment. And nothing marked the panel as pending, so the PREVIOUS
      card's figures stayed fully rendered while new ones were in flight:
      change a $100 card to a $75 one and the screen showed "You get $67.50 /
      take now $67.50 / rest when it sells $22.50" — three figures, two of them
      about a card that is no longer in the form, summing to a number that is
      not on the page. On a screen whose whole job is telling a seller what
      they will be paid, that is the worst possible failure.

      `estimateStale` is set synchronously on every input change, so the panel
      is marked the instant the form moves rather than 220ms later.
    */
    setEstimateStale(true)
    const mine = ++seq.current
    const t = setTimeout(() => {
      void fetch('/api/supply/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchantId, faceValueCents: faceCents, discountBps: discount * 100 }),
        cache: 'no-store',
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: Estimate | null) => {
          if (mine !== seq.current) return
          setEstimate(d)
          setEstimateStale(false)
        })
        .catch(() => {
          if (mine !== seq.current) return
          setEstimate(null)
          setEstimateStale(false)
        })
    }, 220)
    return () => clearTimeout(t)
  }, [merchantId, faceCents, discount])

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/supply/listings', { cache: 'no-store' })
      const body = (await res.json()) as { listings?: Listing[]; listingOpen?: boolean }
      setListings(body.listings ?? [])
      if (typeof body.listingOpen === 'boolean') setListingOpen(body.listingOpen)
    } catch {
      /* a failed refresh should not break the form */
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const submit = useCallback(async () => {
    /*
      NOTHING IS SENT WHILE LISTING IS OFF. The button stays live and answers
      (the file's rule against disabled primaries), but the card number and
      PIN never leave the page for a request that can only be refused.
    */
    if (listingOpen === false) {
      setErrors(['Listing is switched off during the preview. Nothing was sent or saved.'])
      return
    }
    if (merchantId === '') {
      setErrors(['Pick where the card is from.'])
      return
    }
    setBusy(true)
    setErrors([])
    try {
      const res = await fetch('/api/supply/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchantId,
          cardNumber,
          pin,
          faceValueCents: faceCents,
          discountBps: discount * 100,
        }),
      })
      const body = (await res.json()) as {
        listed?: boolean
        message?: string
        issues?: Array<{ message: string }>
      }

      if (!res.ok || !body.listed) {
        setErrors(body.issues?.map((i) => i.message) ?? [body.message ?? 'Could not list that.'])
        return
      }

      // The card is sealed and gone from this page the moment it is accepted.
      setCardNumber('')
      setPin('')
      setValue('')
      await load()
    } catch {
      setErrors(['Network problem. Nothing was saved.'])
    } finally {
      setBusy(false)
    }
  }, [merchantId, cardNumber, pin, faceCents, discount, load, listingOpen])

  const cancel = useCallback(
    async (intentId: string) => {
      await fetch('/api/supply/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentId }),
      })
      await load()
    },
    [load],
  )

  const blind = blindMerchantNotice(merchantId)

  return (
    <>
      <AppBar current="sell" />
      <main className="wrap" data-task id="content" tabIndex={-1}>
        <h1>Sell a card</h1>
        <p className="sub">
          Add a card and forget about it. If someone buys it you get paid, and if you want to
          spend it yourself first, take it back any time.
        </p>

        {/*
          TWO WAYS TO SELL, AND ONLY WHERE THE ESCROW RAIL RUNS. The choice is
          the first thing on the screen because it changes where the card goes:
          the usual way hands it to Salvo, Salvo Pay seals it in this browser.
          Without the rail this renders nothing and the screen is as it was.
        */}
        {escrowRail && (
          <fieldset className="fieldgroup">
            <legend className="label">
              Get paid in
              <InfoTip label="About fiat and crypto">
                <strong>Crypto:</strong> dollars on chain, paid to an account only you hold. Open now, on a test network with test dollars.
                <br />
                <strong>Fiat:</strong> a bank payout through a card processor. Preview only: nothing pays a seller yet.
              </InfoTip>
            </legend>
            <div className="cluster">
              <button type="button" className="choice" aria-pressed={mode === 'escrow'} onClick={() => setMode('escrow')}>
                Crypto
              </button>
              <button type="button" className="choice" aria-pressed={mode === 'usual'} onClick={() => setMode('usual')}>
                Fiat
              </button>
            </div>
          </fieldset>
        )}

        {mode === 'escrow' ? (
          <EscrowSell />
        ) : (
          <>

        {/*
          SAID BEFORE THE CARD NUMBER, NOT AFTER THE REFUSAL. Listing is off on
          this deployment, and the only place that said so was /how-it-works —
          so a stranger could type a real card and PIN into a payments site and
          find out from an error. The preview banner's "no money moves" does
          not cover handing over a card.
        */}
        {/*
          ONLY WHAT THE SERVER CONFIRMS. Whether listing is off is reported by
          /api/supply/listings, not assumed: the claim is made when the server
          says a card cannot be sealed, and otherwise the notice says only what
          is true everywhere — this is a preview, and a real card does not
          belong in it, because nothing pays a seller yet.
        */}
        {/*
          "HAND IT TO SAL", SAID HONESTLY. Sal's one line is the invitation, and
          the line under it is the preview's truth. It sits under the intro so
          it is read before any field, the card number most of all.
        */}
        <div className="sal-note mb-6">
          <p className="sal-note__title">Hand it to Sal</p>
          <div className="sal-intro sal-intro--sm">
            <Sal size={104} />
            <p className="sal-speech">
              Gift card sitting in a drawer? Hand it over. Somebody out there wants it.
            </p>
          </div>
          <div>
            <p className="notice--muted sal-note__small">
              <strong>Not open yet.</strong>{' '}
              {listingOpen === false
                ? 'Listing is switched off on this site. Do not enter a real card number or PIN.'
                : 'Nothing pays a seller yet. Do not enter a real card number or PIN.'}
            </p>
          </div>
        </div>

        {/* The same store picker as /shop and /buy: one control for one decision,
            not a native select hiding three of the four stores. */}
        <fieldset className="fieldgroup">
          <legend className="label">Where is it from?</legend>
          <div className="cluster cluster--scroll" ref={storesRef}>
            {SUPPORTED_MERCHANTS.map((m) => (
              <button
                key={m.id}
                type="button"
                className="choice"
                aria-pressed={merchantId === m.id}
                onClick={() => setMerchantId(m.id)}
              >
                {m.name}
              </button>
            ))}
          </div>
        </fieldset>

        {/*
          THE WEAKER GUARANTEE, SAID WHERE THE DECISION IS MADE.

          Most merchants publish no balance lookup, so we cannot check the card
          before or after it is used and settlement rests on what the buyer
          says. That is a real difference in risk to the seller and it belongs
          on the screen where they choose the merchant — not in a comment, and
          not in a term nobody reads. Shown only when it applies, so it stays
          information rather than boilerplate people learn to skip.
        */}
        {!merchantBalanceReadable(merchantId) && blind && (
          <div className="notice mb-6">
            <strong>We can’t check {merchantName(merchantId)} balances.</strong>{' '}
            <span className="notice--muted">{blind}</span>
          </div>
        )}


        {/* Card number takes the width, PIN takes 8rem: a 4-digit PIN in a
            half-width box left the 19-digit number clipped at 390px. */}
        <div className="row card-pin">
          <div>
            {/* Not always the card number: a Target card's barcode carries a
                longer one, so the store says which number to type. */}
            <label htmlFor="card">{numberField?.numberLabel ?? 'Card number'}</label>
            <input
              id="card"
              value={cardNumber}
              onChange={(e) => setCardNumber(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="6006 4900 0000 0000"
              aria-describedby={numberField?.numberHint ? 'card-hint' : undefined}
            />
            {numberField?.numberHint && (
              <p id="card-hint" className="hint">
                {numberField.numberHint}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="pin">PIN</label>
            <input
              id="pin"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="If it has one"
            />
          </div>
        </div>

        {/* Same money-entry treatment as /shop's amount: the currency sign is
            furniture, not something the seller types or we have to parse. */}
        <div className="field">
          <label htmlFor="value">What is on it?</label>
          <div className="affix">
            <span className="affix__mark" aria-hidden="true">
              $
            </span>
            <input
              id="value"
              className="num"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="decimal"
              placeholder="25.00"
            />
          </div>
        </div>

        <div className="field">
          {/* A readout, not a sentence: the value sits where a value goes. */}
          <label htmlFor="discount" className="split">
            <span>Discount</span>
            <span className="num text-2">{discount}% off</span>
          </label>
          <DiscountSlider id="discount" discount={discount} onChange={setDiscount} />
        </div>

        {/* The same answer shape as /shop, /buy and /demo: the rule above the
            label, then the figure. The rule used to run under the figure,
            cutting it off from its own estimate. */}
        <section className="group answer" aria-live="polite">
          <div className="eyebrow">You get</div>
          {/* An empty form reads as a muted dash, not a white 60px glyph. */}
          <div className={payout > 0 ? 'display mt-2' : 'display mt-2 muted'}>
            {payout > 0 ? money(payout) : '—'}
          </div>

          {/*
            THE DISCOUNT SLIDER IS THE ONLY REAL DECISION A SELLER MAKES, and
            until now it was a guess: move it and the only thing that changed
            was a number they already knew how to compute. This is the
            underwriting model surfaced as product — how fast it sells, and how
            much of the money they need not wait for.

            The ILLUSTRATIVE caveat sits ABOVE the numbers, because a caveat
            placed after a figure is read after the figure has already been
            believed. On a neutral rule, not amber: nothing here is money at
            risk, and amber is kept for what is (the blind-merchant notice).
          */}
          {/*
            THE FADE IS ON A WRAPPER THAT MOUNTS ONCE. It was on the same element
            as `is-stale`, so every settle swapped the class back to `fade-in`
            and replayed the entrance — the estimate blinked on every slider
            stop. Now it enters once and after that only dims and undims.
          */}
          {estimate && (
            <div className="fade-in">
              <div
                className={estimateStale ? 'mt-6 is-stale' : 'mt-6'}
                aria-busy={estimateStale}
              >
                {estimate.caveat !== null && (
                  <div className="notice notice--neutral notice--inset mb-4">{estimate.caveat}</div>
                )}

                <dl className="stack kv">
                  <div className="split">
                    <dt className="text-2">Likely to sell in</dt>
                    <dd className="num">
                      ~{estimate.daysToSell} days{' '}
                      <span className="muted">
                        ({estimate.daysToSellRange.low}–{estimate.daysToSellRange.high})
                      </span>
                    </dd>
                  </div>

                </dl>

                {/*
                  AN API FIELD IS NOT AN OFFER, AND IT IS BEHIND ONE QUIET LINE.
                  The advance has no endpoint, so its number is never rendered
                  as a live offer next to "List it". The advance row and its five-line pool
                  paragraph sat at the same size as the real estimate, so about
                  220px of qualification for a feature that does not exist
                  outweighed "You get". It stays on the page — the preview is
                  deliberate and /how-it-works points at it — but closed.
                */}
                {estimate.takeNowCents > 0 && (
                  <details className="quiet-disclosure mt-2">
                    <summary>Take money now: coming soon</summary>
                    <p className="hint mt-2">
                      We are building an option to pay you up to{' '}
                      <span className="num">{money(estimate.takeNowCents)}</span> straight away
                      instead of waiting for a buyer. It is not available yet: listing pays you
                      when the card sells. {estimate.mutualisationNotice}
                    </p>
                  </details>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Beside the button that caused it: a refusal rendered at the top of the
            form was about 700px from the thumb, so the button said "Listing…",
            went back to "List it", and nothing seemed to happen. */}
        {errors.length > 0 && (
          <div className="err" role="alert">
            {errors.map((e) => (
              <div key={e}>{e}</div>
            ))}
          </div>
        )}
        <button
          className={
            listingOpen === false
              ? 'btn btn--secondary btn--block'
              : busy
                ? 'btn btn--primary btn--block is-working'
                : 'btn btn--primary btn--block'
          }
          onClick={submit}
          disabled={busy}
        >
          {busy && <span className="spinner" aria-hidden="true" />}
          {listingOpen === false ? 'Listing opens after the preview' : busy ? 'Listing…' : 'List it'}
        </button>

        {listings.length > 0 && (
          <section>
            {/* A rule, not just a margin: the form ends here and the ledger of
                what you already listed begins. */}
            <hr className="divide" />
            <h2 className="mt-0">Your cards</h2>
            {listings.map((l) => (
              <article key={l.intentId} className="card">
                <div className="split">
                  <div>
                    <div className="strong">
                      {merchantName(l.merchantId)}{' '}
                      <span className="muted num">···· {l.last4}</span>
                    </div>
                    <p className="hint">{l.detail}</p>
                  </div>
                  <span className={`pill ${PILL_CLASS[l.label] ?? ''}`}>{l.label}</span>
                </div>

                <p className="hint">
                  <span className="num">{money(l.faceValueCents)}</span> card ·{' '}
                  {l.paidOut ? (
                    <>
                      <span className="num">{money(l.priceCents)}</span> paid to you
                      {l.payoutRail ? ` via ${l.payoutRail}` : ''}
                    </>
                  ) : (
                    <>
                      <span className="num">{money(l.priceCents)}</span> if it sells
                    </>
                  )}
                </p>

                {l.state === 'offered' && (
                  <button
                    className="btn btn--secondary mt-3"
                    onClick={() => void cancel(l.intentId)}
                  >
                    Take it back
                  </button>
                )}
              </article>
            ))}
          </section>
        )}
          </>
        )}
      </main>
    </>
  )
}
