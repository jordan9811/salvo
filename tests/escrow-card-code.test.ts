/**
 * A bought card's code, drawn on the phone (src/lib/escrow/client/barcode.ts)
 * with bwip-js's browser build.
 *
 * Pinned: Target is the store's own PDF417 and the others Code 128, as the
 * barcode registry says; the PDF417 options are the server renderer's
 * (src/lib/barcode/pdf417.ts), so the phone draws the same symbol the reveal
 * would; a payload the scanner cannot read is refused, not approximated.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CARD_PDF417_OPTIONS, cardBarcode } from '@/lib/escrow/client/barcode'

describe('the card code on the phone', () => {
  it('draws Target as PDF417, with the server renderer’s own options', async () => {
    const code = await cardBarcode('target', { cardNumber: '12345678901234567890123456', pin: null })
    expect(code.symbology).toBe('PDF417')
    expect(code.svg).toMatch(/^<svg width="100%"/)
    expect(code.svg).toContain('aria-label="PDF417 barcode"')
    const server = readFileSync(resolve(process.cwd(), 'src/lib/barcode/pdf417.ts'), 'utf8')
    const literal = /const PDF417_OPTIONS = (\{[^}]+\})/.exec(server)?.[1]
    expect(literal).toBeDefined()
    expect(literal?.replace(/\s/g, '')).toBe(JSON.stringify(CARD_PDF417_OPTIONS).replace(/"/g, ''))
  })

  it('draws the other stores, and the test card, as Code 128', async () => {
    for (const merchant of ['bestbuy', 'nike', 'walmart', 'salvotest'] as const) {
      const code = await cardBarcode(merchant, { cardNumber: '9999123412341234', pin: '1234' })
      expect(code.symbology).toBe('Code 128')
      expect(code.svg).toContain('<path')
    }
  })

  it('refuses a number a scanner cannot read, or one not in its store’s format, rather than drawing something close', async () => {
    await expect(cardBarcode('bestbuy', { cardNumber: '1234é', pin: null })).rejects.toThrow(/cannot be drawn/)
    await expect(cardBarcode('target', { cardNumber: '9999123412341234', pin: null })).rejects.toThrow(/cannot be drawn/)
    await expect(cardBarcode('salvotest', { cardNumber: '<svg onload=x>', pin: null })).rejects.toThrow(/cannot be drawn/)
  })
})
