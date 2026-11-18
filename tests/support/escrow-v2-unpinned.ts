/**
 * salvo-vault-escrow/2 as it was before the pin step, for the tests that hold
 * the unpinned state. Test-only; never referenced from src/.
 *
 * WHY. The lead pinned V2 live on 2026-10-13: the source's ESCROW line names
 * the Moderato deploy, and escrow-pins.ts holds its deployer, creation
 * transaction, identity and sealing key. The committed build no longer
 * reaches the unpinned state on its own, yet what that state did (refuse
 * every manifest, name no escrow, count as not configured, read and relay
 * nothing) must stay under test, as it did for V1 (unpinnedTemplate in
 * tests/escrow-readiness.test.ts). So this rebuilds it: the ESCROW line set
 * back to the placeholder, the sha256 and CID of those bytes (so it is
 * intact), and every pin null but the code hash. Those bytes are exactly the
 * unpinned release, UNPINNED_V2_RELEASE (tests/lit-escrow-v2-template.test.ts
 * proves it), so nothing else moved with the pin.
 *
 * USE. Pass `unpinnedV2(ESCROW_V2)` wherever the code under test takes the
 * template. Where it reads the committed module itself, replace it for one
 * import graph:
 *   vi.resetModules()
 *   vi.doMock('@/lib/vault/lit/templates', async (importOriginal) =>
 *     (await import('./support/escrow-v2-unpinned')).templatesWithV2Unpinned(importOriginal))
 *   vi.doMock('@/lib/vault/lit/escrow-pins', async (importOriginal) =>
 *     (await import('./support/escrow-v2-unpinned')).pinsWithV2Unpinned(importOriginal))
 * It imports neither module at run time, so loading it cannot load a mocked one.
 */

import { createHash } from 'node:crypto'
import { ESCROW_PIN_PLACEHOLDER } from '@/lib/escrow/deployment'
import { litActionCid } from '@/lib/vault/lit/cid'
import type * as Pins from '@/lib/vault/lit/escrow-pins'
import type * as Templates from '@/lib/vault/lit/templates'

type TemplateV2 = Templates.EscrowTemplate<'salvo-vault-escrow/2'>

/** The committed V2 bytes before the pin step (commit a64deff): the placeholder in the ESCROW line. */
export const UNPINNED_V2_RELEASE = Object.freeze({
  bytes: 28217,
  sha256: '6f440c2f9773e8acb6d7e12f6f7f5e824961a564b66f8453401ab57d5d3a929f',
  cid: 'QmPu6a4Ryu3698YNrCbn7JchjsFHh4Lhj88ZzcJ1tsMKV4',
})

/** `source` with its one ESCROW line set back to the placeholder. Throws unless there is exactly one such line. */
export function unpinnedSourceV2(source: string): string {
  if (source.split('\nconst ESCROW = ').length !== 2) throw new Error('unpinnedSourceV2: the source does not hold exactly one ESCROW line')
  const out = source.replace(/\nconst ESCROW = "[^"\n]*";\n/, `\n${ESCROW_PIN_PLACEHOLDER}\n`)
  if (out.split(ESCROW_PIN_PLACEHOLDER).length !== 2) throw new Error('unpinnedSourceV2: the ESCROW line did not go back to the placeholder')
  return out
}

/** The pins as they were before the pin steps: all null but the code hash. */
export function unpinnedPinsV2(p: Pins.EscrowPins): Pins.EscrowPins {
  return { ...p, encPub: null, identity: null, escrowAddress: null, escrowDeployer: null, escrowCreationTx: null }
}

/** `t` before the pin step: the placeholder back, those bytes' own sha256 and CID, and every pin null but the code hash. */
export function unpinnedV2(t: TemplateV2): TemplateV2 {
  const source = unpinnedSourceV2(t.source)
  return {
    ...t,
    ...unpinnedPinsV2(t),
    source,
    sha256: createHash('sha256').update(source, 'utf8').digest('hex'),
    cid: litActionCid(source),
  }
}

/** templates.ts with ESCROW_V2 unpinned, for a vi.doMock factory. Everything else is the real module. */
export async function templatesWithV2Unpinned(importOriginal: () => Promise<typeof Templates>): Promise<typeof Templates> {
  const real = await importOriginal()
  return { ...real, ESCROW_V2: Object.freeze(unpinnedV2(real.ESCROW_V2)) }
}

/** escrow-pins.ts with ESCROW_V2_PINS unpinned, for a vi.doMock factory. V1's pins are the real ones. */
export async function pinsWithV2Unpinned(importOriginal: () => Promise<typeof Pins>): Promise<typeof Pins> {
  const real = await importOriginal()
  return { ...real, ESCROW_V2_PINS: Object.freeze(unpinnedPinsV2(real.ESCROW_V2_PINS)) }
}
