'use client'

/**
 * /sell on SalvoEscrowV2: sell a card for test dollars, sealed in this
 * browser, to shoppers who pay at the till for only what they use (unified
 * spec sections 8 and 11). Shown once V2 is open here (config-v2.ts
 * ESCROW_V2_LIVE); escrow-sell.tsx picks it.
 *
 * THE SAME PROMISE AS THE FIRST ESCROW'S PAGE. The number and PIN typed here
 * are sealed on this device to salvo-vault-escrow/2's key, and only the
 * sealed copy goes anywhere (sell-v2.ts listCardV2): on chain as a hash, to
 * Salvo as ciphertext, with a slow keyless fingerprint so a card listed on
 * either escrow is never listed twice. The fields clear the moment it is
 * listed.
 *
 * WHAT IS NEW, SAID WHERE THE SELLER DECIDES:
 *   - A card sells in parts. A shopper pays only for what they use; the
 *     rest stays listed for the next shopper, and the shopper who left it
 *     puts down a deposit for it at face, so the seller is paid either way.
 *   - Take it back before any sale; after one, "I used it myself" closes the
 *     rest (the deposit goes back to its shopper).
 *   - Five to seven days after a deposit started covering the rest, the
 *     seller may say whether it is still there or gone (closeRemainderV2,
 *     one Face ID): gone, and the deposit pays them.
 *   - Get paid sends the escrow's release for a sale that is due (one Face
 *     ID); Salvo's keeper sends it too.
 *
 * STRANGERS LIST ON THE ESCROW ONLY. Nothing here lists on the card rail, so
 * the custody guard has nothing new to allow; our server still checks every
 * listing against it.
 *
 * Browser only. Never logs a card.
 */

import { CopyButton } from '../copy-button'
import { DiscountSlider } from './discount-slider'
import { InfoTip } from '../info-tip'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { MERCHANT_BARCODE_PROFILES } from '@/lib/barcode/merchants'
import type { EscrowApiV2, EscrowPublicConfigV2 } from '@/lib/escrow/client/api-v2'
import type { CardStore } from '@/lib/escrow/client/card-store'
import type { DeviceBookV2, ListingRecordV2 } from '@/lib/escrow/client/records-v2'
import { ESCROW_SELL_STORES, SellRefused } from '@/lib/escrow/client/sell'
import {
  cancelListingV2,
  closeRemainderV2,
  collectOwedV2,
  collectPayoutV2,
  forgetListingV2,
  listCardV2,
  listingFileTextV2,
  listingStatesV2,
  owedToV2,
  recordListingV2,
  type ListingViewV2Seller,
  type SellDepsV2,
} from '@/lib/escrow/client/sell-v2'
import { requestTestDollars, type ChainAccess, type DeviceWallet } from '@/lib/escrow/client/wallet'
import { ESCROW_MERCHANTS, type EscrowMerchantName } from '@/lib/escrow/merchants'
import { money } from '../ui'
import { useFits } from '../use-fits'
import { LISTING_FILE_LINE, owedLine, saleLineV2, TEST_LIST_LINE } from '../pay/escrow-copy'
import { ESCROW_STORES, merchantLabel, shortAddress, unitsToMoney } from '../pay/escrow-ui'

const STEP_WORDS = {
  checking: 'Checking the escrow…',
  sealing: 'Sealing on this device…',
  listing: 'Listing on chain…',
  recording: 'Telling Salvo…',
} as const

/** The stores a seller may pick while this rail runs on a testnet (sell.ts ESCROW_SELL_STORES). */
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

function download(r: ListingRecordV2, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `salvo-listing-${r.listingId.slice(2, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export interface SellV2Session {
  store: CardStore
  book: DeviceBookV2
  api: EscrowApiV2
  config: EscrowPublicConfigV2
  access: ChainAccess
}

/** The seller's form and their V2 listings, with a seller key set up for V2. */
export function SellFormV2({ session, wallet }: { session: SellV2Session; wallet: DeviceWallet }) {
  const deps: SellDepsV2 = useMemo(
    () => ({ book: session.book, api: session.api, config: session.config, access: session.access, wallet }),
    [session, wallet],
  )
  const storesRef = useRef<HTMLDivElement>(null)
  useFits(storesRef)
  const [merchant, setMerchant] = useState<EscrowMerchantName | ''>('')
  const [cardNumber, setCardNumber] = useState('')
  const [pin, setPin] = useState('')
  const [value, setValue] = useState('')
  const [discount, setDiscount] = useState(10)
  const [step, setStep] = useState<keyof typeof STEP_WORDS | null>(null)
  const [error, setError] = useState('')
  const [listed, setListed] = useState<ListingRecordV2 | null>(null)
  const [listings, setListings] = useState<ListingRecordV2[]>([])
  const [views, setViews] = useState<Map<Hex, ListingViewV2Seller>>(new Map())
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
    const mine = (await session.book.listings()).filter((r) => r.seller.toLowerCase() === wallet.account.toLowerCase())
    setListings(mine)
    try {
      const read = await listingStatesV2(session.access, session.config, mine)
      setViews(read.views)
      setChainTime(read.chainTime)
      const [b, o] = await Promise.all([wallet.balance(session.access.hosts), owedToV2(session.access, session.config, wallet.account)])
      setBalance(b)
      setOwed(o)
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
      const r = await listCardV2(deps, { merchant, cardNumber: cardNumber.trim(), pin: pin.trim() === '' ? null : pin.trim(), valueCents, priceCents }, setStep)
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

  /** One row action: busy while it runs, its refusal said in words, the rows read again after. */
  const act = useCallback(
    async (r: ListingRecordV2, run: () => Promise<unknown>, fallback: string) => {
      setRowBusy(r.listingId)
      setError('')
      try {
        const why = await run()
        if (typeof why === 'string') setError(why)
      } catch (err) {
        setError(err instanceof SellRefused ? err.message : cancelled(err) ? 'Cancelled. Nothing was sent.' : fallback)
      } finally {
        setRowBusy(null)
        await refresh()
      }
    },
    [refresh],
  )

  const claim = useCallback(async () => {
    setClaiming(true)
    setError('')
    try {
      await collectOwedV2(deps, wallet)
    } catch (err) {
      setError(cancelled(err) ? 'Cancelled. Nothing was sent.' : 'The claim did not go through. The money stays in the escrow; try again later.')
    } finally {
      setClaiming(false)
      await refresh()
    }
  }, [deps, wallet, refresh])

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

  const owedSaid = owedLine(owed)
  return (
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
            <div className={priceCents > 0 ? 'display mt-2 num' : 'display mt-2 muted'}>{money(priceCents)}</div>
            <p className="answer__sub">
              Shoppers pay at the till for only what they use, so a card can sell in parts. You are paid for each part a day after it is
              used, and for what is left either way: the shopper who leaves it puts down a deposit for it. Take the card back any time
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

      {listed !== null && (
        <div className="notice notice--neutral mt-6" role="status">
          <strong>Listed.</strong> {LISTING_FILE_LINE}
          {/* The action on a line of its own, a full tap target, not wrapped 2px under the sentence. */}
          <div className="mt-2">
            <button type="button" className="textlink textlink--tap" onClick={() => download(listed, listingFileTextV2(listed, session.config))}>
              Download your listing file
            </button>
          </div>
        </div>
      )}

      {owedSaid !== null && (
        <div className="notice mt-6" role="status">
          <strong>{owedSaid}</strong>{' '}
          <button type="button" className="textlink" onClick={() => void claim()} disabled={claiming || rowBusy !== null}>
            {claiming ? 'Waiting for Face ID…' : 'Claim'}
          </button>
        </div>
      )}

      {listings.length > 0 && (
        <section>
          <hr className="divide" />
          <h2 className="mt-0">Your cards for sale</h2>
          {listings.map((r) => {
            const view = views.get(r.listingId)
            const said = saleLineV2(view, r, chainTime)
            const busy = rowBusy === r.listingId
            return (
              <article key={r.listingId} className="card">
                <div className="split">
                  <div>
                    <div className="strong">{merchantLabel(r.merchant)}</div>
                    <p className="hint">
                      <span className="num">{money(r.valueCents)}</span> card · {unitsToMoney(BigInt(r.priceUnits))} if all of it sells
                    </p>
                    <p className="hint">{said.line}</p>
                  </div>
                  {said.pill !== '' && <span className={view?.lastSale?.state === 'paid' ? 'pill pill--ok' : 'pill'}>{said.pill}</span>}
                </div>
                <div className="cluster mt-3">
                  {said.canCollect && (
                    <button type="button" className="btn btn--primary" onClick={() => void act(r, () => collectPayoutV2(deps, wallet, r), 'That did not go through. Check you have test dollars for the fee, then try again.')} disabled={rowBusy !== null}>
                      {busy ? 'Waiting for Face ID…' : 'Get paid'}
                    </button>
                  )}
                  {said.canTakeBack && (
                    <button type="button" className="btn btn--secondary" onClick={() => void act(r, () => cancelListingV2(deps, r), 'That did not go through. Try again.')} disabled={rowBusy !== null}>
                      {busy ? 'Taking it back…' : 'Take it back'}
                    </button>
                  )}
                  {said.canMarkUsed && (
                    <button type="button" className="btn btn--secondary" onClick={() => void act(r, () => cancelListingV2(deps, r), 'That did not go through. Try again.')} disabled={rowBusy !== null}>
                      {busy ? 'Closing it…' : 'I used it myself'}
                    </button>
                  )}
                  {said.canReview && (
                    <>
                      <button type="button" className="btn btn--secondary" onClick={() => void act(r, () => closeRemainderV2({ access: session.access, config: session.config, wallet }, r, false), 'That did not go through. Try again.')} disabled={rowBusy !== null}>
                        Still there
                      </button>
                      <button type="button" className="btn btn--secondary" onClick={() => void act(r, () => closeRemainderV2({ access: session.access, config: session.config, wallet }, r, true), 'That did not go through. Try again.')} disabled={rowBusy !== null}>
                        It&rsquo;s gone
                      </button>
                    </>
                  )}
                  {said.canResend && (
                    <button type="button" className="btn btn--ghost" onClick={() => void act(r, () => recordListingV2(deps, r), 'Salvo did not take it yet. Try again in a minute.')} disabled={rowBusy !== null}>
                      Send to Salvo again
                    </button>
                  )}
                  {said.canRemove && (
                    <button type="button" className="btn btn--ghost" onClick={() => void act(r, () => forgetListingV2(deps, r), 'We cannot read the chain right now, so it stays for now. Try again in a minute.')} disabled={rowBusy !== null}>
                      {busy ? 'Checking the chain…' : 'Remove'}
                    </button>
                  )}
                  <button type="button" className="btn btn--ghost" onClick={() => download(r, listingFileTextV2(r, session.config))}>
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
