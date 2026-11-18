/**
 * PDF417, for stores whose own gift-card barcode is a 2D stacked symbol.
 *
 * ===========================================================================
 * WHY A LIBRARY HERE, WHEN symbology.ts WRITES ITS OWN. Code 128, Code 39 and
 * ITF are a hundred-odd bar patterns each: small enough to transcribe exactly
 * and validate structurally in tests. PDF417 is 2,787 bar patterns across
 * three clusters, plus Reed-Solomon error correction over GF(929). That is
 * past what can be hand-transcribed and trusted, and one wrong pattern draws a
 * symbol that looks perfect and never scans. bwip-js is the JavaScript port of
 * Barcode Writer in Pure PostScript, the reference implementation most barcode
 * tooling is checked against.
 *
 * SERVER-SIDE ONLY. The library is large, and the reveal page is opened on a
 * phone at a till on whatever signal the store has. So the reveal route draws
 * the symbol and sends the SVG in its response; the phone downloads nothing
 * extra, and the shop's wifi is still not a dependency.
 *
 * FIRST SEEN ON A TARGET eGIFT CARD: its in-store barcode is PDF417 carrying a
 * 26-digit number that begins with the 15-digit card number. See merchants.ts.
 * ===========================================================================
 */

// The Node build, by its explicit subpath: the package root resolves by
// platform conditions this project's TypeScript setup does not pass.
import bwipjs from 'bwip-js/node'
import { BarcodeEncodingError } from './symbology'

/**
 * The BWIPP options this symbol is drawn with, beyond bwip-js's typed ones.
 *
 * Three data columns keep the symbol close to the shape of the 1D codes beside
 * it (about four times as wide as tall) while leaving each module roughly
 * 2.4 CSS px on a 311px phone card. Rows five modules tall are more forgiving
 * of a tilted phone than the spec's minimum of three. Error-correction level 2
 * is the spec's recommended minimum for a payload this short.
 */
const PDF417_OPTIONS = { columns: 3, rowmult: 5, eclevel: 2 } as const

/** Printable ASCII only: what a gift-card barcode carries, and nothing that needs escaping. */
const PRINTABLE = /^[\x20-\x7e]+$/

/**
 * Draw `data` as a PDF417 SVG that fills its card the way the 1D codes do.
 *
 * Throws `BarcodeEncodingError` rather than drawing something approximate, the
 * same rule as the in-house encoders: a symbol that does not scan is worse
 * than none, because nobody can tell it apart from one that does.
 */
export function pdf417Svg(data: string): string {
  if (!PRINTABLE.test(data)) {
    throw new BarcodeEncodingError('PDF417 here encodes printable ASCII only')
  }
  const opts: bwipjs.RenderOptions & typeof PDF417_OPTIONS = {
    bcid: 'pdf417',
    text: data,
    scale: 3,
    // The spec's quiet zone is 2 modules; 4 each side costs nothing.
    paddingwidth: 4,
    paddingheight: 4,
    backgroundcolor: 'ffffff',
    ...PDF417_OPTIONS,
  }
  const raw = bwipjs.toSVG(opts)
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(raw)
  if (!box) throw new BarcodeEncodingError('PDF417 renderer returned no viewBox')
  // Responsive like barPatternToSvg: fill the card, never past natural size.
  return raw.replace(
    '<svg ',
    `<svg width="100%" style="max-width:${box[1]}px;height:auto;display:block;margin:0 auto" ` +
      `role="img" aria-label="PDF417 barcode" `,
  )
}
