/**
 * What each key of the till's pad does (src/app/pay/[store]/keypad.tsx).
 *
 * TYPED LIKE A REGISTER, FROM THE CENTS UP: "5", "2", "1", "3" is $52.13.
 * "00" adds two zeros, Delete takes the last digit off, and the pad stops at
 * $9,999.99. Pure, so a test can press every key.
 */

export type KeypadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '00' | 'back'

/** In the order the pad lays them out, three to a row. */
export const KEYPAD_KEYS: readonly KeypadKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back']

/** The most the pad takes: $9,999.99. */
export const KEYPAD_MAX_CENTS = 999_999

/** What the total becomes when this key is pressed. */
export function applyKey(cents: number, key: KeypadKey): number {
  if (key === 'back') return Math.floor(cents / 10)
  const next = key === '00' ? cents * 100 : cents * 10 + Number(key)
  return next > KEYPAD_MAX_CENTS ? cents : next
}
