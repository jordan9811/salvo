'use client'

/**
 * The till's number pad (unified-account spec 4): already up, no camera.
 *
 * TYPED LIKE A REGISTER, FROM THE CENTS UP. "5", "2", "1", "3" reads $52.13,
 * the way a cashier keys it and the way the total is printed, so there is no
 * decimal point to find. "00" adds two zeros. Delete takes the last digit off.
 * A hardware keyboard works too: digits and Backspace.
 */

import { useEffect } from 'react'
import { KEYPAD_KEYS, applyKey, type KeypadKey } from './keys'

export function Keypad({
  cents,
  onChange,
  disabled = false,
}: {
  cents: number
  onChange: (cents: number) => void
  disabled?: boolean
}) {
  // A keyboard, where there is one. Only while the pad is live.
  useEffect(() => {
    if (disabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (/^[0-9]$/.test(e.key)) onChange(applyKey(cents, e.key as KeypadKey))
      else if (e.key === 'Backspace') onChange(applyKey(cents, 'back'))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cents, onChange, disabled])

  return (
    <div className="keypad" role="group" aria-label="Number pad">
      {KEYPAD_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          className="keypad__key"
          disabled={disabled}
          aria-label={k === 'back' ? 'Delete' : k}
          onClick={() => onChange(applyKey(cents, k))}
        >
          {k === 'back' ? '⌫' : k}
        </button>
      ))}
    </div>
  )
}
