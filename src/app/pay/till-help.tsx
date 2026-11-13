'use client'

/**
 * "Something went wrong?" for a till purchase, card by card (unified-account
 * spec 4). On the till's last screen, and again from Account for 48 hours.
 *
 * EVERY CARD HAS A WAY TO SAY SO. The rest of someone else's card can be
 * reported empty inside its two hours, which releases the hold for it; any
 * card can be reported for anything else inside 48 hours, and a person looks.
 * A report taken says so, in place of its buttons, so a second tap never
 * meets "this card can no longer be reported".
 */

import { useState } from 'react'
import type { Leg, PurchaseHandle } from '@/lib/till/types'
import { SOMETHING_WRONG_HINT, emptyLabel, problemLabel } from './till-copy'

export function TillHelp({
  purchases,
  onReport,
}: {
  purchases: readonly PurchaseHandle[]
  /** Reports one card; resolves to the sentence that says it was taken. */
  onReport: (purchase: PurchaseHandle, scanIndex: number, o: 'empty' | 'problem') => Promise<string>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  const go = async (p: PurchaseHandle, leg: Leg, o: 'empty' | 'problem') => {
    const key = `${p.ref}:${leg.scanIndex}`
    setBusy(key)
    setError('')
    try {
      const note = await onReport(p, leg.scanIndex, o)
      setNotes((n) => ({ ...n, [key]: note }))
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That was not taken. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="till__sheet">
      <p className="hint">{SOMETHING_WRONG_HINT}</p>
      {purchases.flatMap((p) =>
        p.plan.legs.map((leg) => {
          const key = `${p.ref}:${leg.scanIndex}`
          const note = notes[key]
          if (note !== undefined) {
            return (
              <p key={key} className="notice notice--neutral mt-2" role="status">
                {note}
              </p>
            )
          }
          return (
            <div key={key} className="mt-2">
              {leg.source === 'remainder' && (
                <button className="btn btn--secondary btn--block" disabled={busy !== null} onClick={() => void go(p, leg, 'empty')}>
                  {emptyLabel(leg)}
                </button>
              )}
              <button className="btn btn--ghost btn--block mt-2" disabled={busy !== null} onClick={() => void go(p, leg, 'problem')}>
                {problemLabel(leg)}
              </button>
            </div>
          )
        }),
      )}
      {error !== '' && (
        <p className="err mt-2" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
