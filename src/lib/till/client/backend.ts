/**
 * Which backend pays at the till (unified-account spec 5.1).
 *
 * BOTH RAILS, ONE TILL. The card rail is fetches to our own till routes
 * (card-backend.ts); the dollars rail is the phone itself paying
 * SalvoEscrowV2 and drawing each card from Lit (dollars.ts). The screens
 * cannot tell them apart: the keypad, the "Scan 1 of 2" screens and every
 * sentence are written once, against src/lib/till/types.ts.
 *
 * One backend per screen: each opens what it needs on first use.
 *
 * Browser only by use. Neither reaches the card processor.
 */

import type { Rail, TillBackend } from '../types'
import { cardBackend } from './card-backend'
import { dollarsBackend } from './dollars'

export function backendFor(rail: Rail): TillBackend {
  return rail === 'card' ? cardBackend() : dollarsBackend()
}
