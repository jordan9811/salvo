/**
 * The store's own barcode for a bought card, drawn on the phone (spec section
 * 8.3 step 7: the on-screen fallback until the Wallet pass ships).
 *
 * DRAWN HERE, NOT BY OUR SERVER. The server never sees an escrow card in
 * clear, so it cannot draw one: the phone that decrypted it draws it, with
 * bwip-js's browser build. The symbology is the store's (src/lib/barcode/
 * merchants.ts): PDF417 for Target, whose in-store code is a 2D symbol, and
 * Code 128 for the others. The PDF417 options are the server's own
 * (src/lib/barcode/pdf417.ts), so a card drawn here is the same symbol the
 * reveal draws; tests/escrow-card-code.test.ts holds the two equal.
 *
 * LOADED BEFORE IT IS NEEDED. The library is large, so it is its own chunk,
 * and the pages start loading it as they open (loadBarcodeRenderer). At a
 * till with no signal, a card already on the device still draws.
 *
 * Browser only by use; imports nothing Node-only. Never logs a card.
 */

import { MERCHANT_BARCODE_PROFILES, renderBarcodePayload } from '@/lib/barcode/merchants'
import { ESCROW_MERCHANTS, type EscrowMerchantName } from '../merchants'
import type { CardSecret } from './card-store'

// The browser build is an ES module with named exports; its types are an
// `export =` namespace, which is the same shape.
type Bwip = typeof import('bwip-js/browser')

/** src/lib/barcode/pdf417.ts's PDF417_OPTIONS, copied: that file loads the Node build. */
export const CARD_PDF417_OPTIONS = { columns: 3, rowmult: 5, eclevel: 2 } as const
/** Printable ASCII only, the same rule as the server's renderer. */
const PRINTABLE = /^[\x20-\x7e]+$/

let loading: Promise<Bwip> | null = null

/** Start loading the barcode library, once. Pages call it when they open. */
export function loadBarcodeRenderer(): Promise<Bwip> {
  if (loading === null) {
    loading = import('bwip-js/browser')
    // A failed load can be tried again next time.
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}

export interface CardCode {
  svg: string
  /** Shown small under the code, as the reveal does. */
  symbology: 'PDF417' | 'Code 128'
}

/** Fill the card's width, never past natural size: the same treatment as the server's PDF417. */
function responsive(raw: string, label: string): string {
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(raw)
  if (!box) throw new Error('the barcode renderer returned no viewBox')
  return raw.replace(
    '<svg ',
    `<svg width="100%" style="max-width:${box[1]}px;height:auto;display:block;margin:0 auto" role="img" aria-label="${label}" `,
  )
}

/**
 * What the store's barcode for this card encodes, in its own form (Target's
 * 26 digits, a number and PIN where the store's code carries both). The till
 * hands this to its screens, which draw the 1D codes themselves. Throws for a
 * number not in the store's format: nothing approximate is ever encoded.
 */
export function cardBarcodePayload(merchant: EscrowMerchantName, card: CardSecret): string {
  // Lit sold this card only because it matched its store's format; a number
  // that does not is not drawn, whatever it holds.
  if (!ESCROW_MERCHANTS[merchant].card.test(card.cardNumber)) throw new Error('this card cannot be drawn as a barcode')
  const profile = merchant === 'salvotest' ? null : MERCHANT_BARCODE_PROFILES[merchant]
  const payload = profile ? renderBarcodePayload(profile, card) : card.cardNumber
  if (!PRINTABLE.test(payload)) throw new Error('this card cannot be drawn as a barcode')
  return payload
}

/** Is this store's own code a PDF417, which only bwip-js draws (cardBarcode), rather than a 1D code a screen draws from the payload? */
export function storeUsesPdf417(merchant: EscrowMerchantName): boolean {
  return merchant !== 'salvotest' && MERCHANT_BARCODE_PROFILES[merchant]?.format === 'PKBarcodeFormatPDF417'
}

/**
 * The code a register scans for this card. Throws rather than drawing
 * something approximate: a symbol that does not scan is worse than none.
 */
export async function cardBarcode(merchant: EscrowMerchantName, card: CardSecret): Promise<CardCode> {
  const payload = cardBarcodePayload(merchant, card)
  const bwip = await loadBarcodeRenderer()
  if (storeUsesPdf417(merchant)) {
    const raw = bwip.toSVG({
      bcid: 'pdf417',
      text: payload,
      scale: 3,
      paddingwidth: 4,
      paddingheight: 4,
      backgroundcolor: 'ffffff',
      ...CARD_PDF417_OPTIONS,
    } as Parameters<Bwip['toSVG']>[0])
    return { svg: responsive(raw, 'PDF417 barcode'), symbology: 'PDF417' }
  }
  const raw = bwip.toSVG({
    bcid: 'code128',
    text: payload,
    scale: 2,
    height: 16,
    includetext: false,
    // Ten modules of quiet zone each side, as the reveal's own Code 128.
    paddingwidth: 10,
    paddingheight: 2,
    backgroundcolor: 'ffffff',
  })
  return { svg: responsive(raw, 'Code 128 barcode'), symbology: 'Code 128' }
}
