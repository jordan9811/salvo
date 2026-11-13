/**
 * The V2 escrow server, offline and database-free (unified spec sections 7,
 * 8 and 16, phase 3a): SalvoEscrowV2 deployed and pinned the way the runbook
 * does it, fake Lit running the real salvo-vault-escrow/2 against the same
 * chain, and fake Best Buy balances that fall as a register spends.
 *
 * What is held here:
 *   - V2 counts only once every pin is set; then V1 is frozen and takes no
 *     listing, and the config route's V2 block carries V2's pins.
 *   - The committed V2 is pinned live (2026-10-13) and switched on
 *     (ESCROW_V2_LIVE, phase 3b): configured, its config block and the
 *     page's pins are the live values, and V1 is frozen. As it was before the
 *     pin step (the committed template unpinned for one import graph,
 *     tests/support/escrow-v2-unpinned.ts) it counts for nothing, switch or
 *     no switch.
 *   - The custody guard is not weakened: a V2 seal classifies `unknown`, and
 *     only the testnet operator's own listing passes.
 *   - The V2 reader's gate is the template's eleven words; a sale's use and
 *     deposit read back exactly; the card rules refuse a second listing of a
 *     card and a card another buyer drained.
 *   - The Lit relay: a ticket bound to the listing's value left and sales
 *     count, checked against the V2 escrow and identity; a release only to
 *     the reply key on chain; a readable leftover's balance read, signed, and
 *     a short ticket carrying its signed read.
 *   - The keeper's chain work: the deposit back two hours after the next
 *     shopper's use held (decision 1), not before; forfeited on a contest;
 *     back by rule at seven days, with the seller asked from day five; the
 *     seller paid at releaseAt; a readable leftover read fifteen minutes
 *     after the sale, posting a shortfall to the seller only.
 * The keeper's database half and the routes need Postgres: see
 * tests/escrow-keeper.test.ts and tests/escrow-routes.test.ts.
 */

import type { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionResult, encodeFunctionData, erc20Abi, keccak256, parseTransaction, toFunctionSelector, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { ESCROW_V2_ABI } from '@/lib/escrow/artifact-v2'
import { escrowReaderV2 } from '@/lib/escrow/chain-v2'
import { pagePinsV2 } from '@/lib/escrow/client/api-v2'
import { escrowConfigV2, escrowV1Frozen, escrowV2Configured, escrowV2Live, ESCROW_V2_LIMITS, ESCROW_V2_LIVE, templateV2NotReady } from '@/lib/escrow/config-v2'
import { payoutIfDueV2, startRunV2, sweepListingV2, type RunV2 } from '@/lib/escrow/keeper-v2'
import { intentTargetV2 } from '@/lib/escrow/keeper-v2-rules'
import { acceptSealedListing, escrowListingOpen, EscrowListingRefusedError } from '@/lib/escrow/listing'
import { acceptSealedListingV2, escrowIntentDataV2, escrowListingOpenV2, escrowVersionOfRef, readEscrowSealedRefV2 } from '@/lib/escrow/listing-v2'
import { requestConfirmV2, requestReleaseV2, requestTicketV2 } from '@/lib/escrow/lit-escrow-v2'
import { PATH_USD } from '@/lib/escrow/manifest'
import { MODE_READABLE } from '@/lib/escrow/merchants'
import { V2_STATE } from '@/lib/escrow/runbook/reads-v2'
import { ticketProblemsV2 } from '@/lib/escrow/runbook/smoke-v2'
import { escrowRuntime, type EscrowRuntime } from '@/lib/escrow/runtime'
import { priceForV2 } from '@/lib/escrow/terms-v2'
import { __clearTicketedCardsV2ForTests, ticketedCardRefusalV2 } from '@/lib/escrow/ticket-v2'
import { assertSealedRefAllowedForOwner, backendOfSealedRef, classifyBackend, CustodialVaultRefusedError } from '@/lib/vault/guard'
import { CHIPOTLE_ESCROW_ALGORITHM } from '@/lib/vault/escrow-backend'
import { createReplyKey } from '@/lib/vault/lit/envelope-crypto'
import { ESCROW_V2_PINS } from '@/lib/vault/lit/escrow-pins'
import { ESCROW_V2, templateIntegrity } from '@/lib/vault/lit/templates'
import { escrowPinProblems } from '@/lib/escrow/deployment'
import { escrowV2Call } from './support/escrow-v2-chain'
import { pinsWithV2Unpinned, templatesWithV2Unpinned } from './support/escrow-v2-unpinned'
import { closeServerWorld, serverWorld, UNPINNED_V2 } from './support/escrow-server-world'
import {
  closeServerWorldV2,
  listV2,
  SELLER_V2,
  serverWorldV2,
  SHOPPER_A,
  SHOPPER_B,
  useCardV2,
  type ServerWorldV2,
} from './support/escrow-server-world-v2'
import { testAddress } from './support/evm'

const RAIL = process.env.ESCROW_RAIL
const USAGE_KEY = process.env.LIT_VAULT_USAGE_KEY
const HOUR = 3_600
const DAY = 86_400
const REASON: Hex = keccak256('0x656d707479')
const BESTBUY_CARD = '6123456789012345'
const BESTBUY_PIN = '4821'
const RELEASE_BOND = toFunctionSelector('releaseBond(uint256)')
const RELEASE = toFunctionSelector('release(uint256)')
const CONFIRM = toFunctionSelector('confirmRemainder(bytes32,uint32,uint40,bytes)')
/** What the live runs of 2026-10-12/13 pinned: SalvoEscrowV2 on Moderato, its deployer and creation, and the bind on Lit. */
const LIVE_V2 = {
  escrowAddress: '0xa30d1631bf644fa608dacc02b6d2aebbc1cd200b',
  escrowDeployer: '0xc65f0c60c34e645aa54e2114c59b8df7d7cf7c47',
  escrowCreationTx: '0xc38e6e06863b4f5e6a3dfc8390966d61d5b6e8cfdf92dbb2dd95f2301731c640',
  identity: '0x264a8ec05b8ac46d935495daee8670317c9420ba',
  encPub: '0x02e4b2970532998a2ddcedb15c952f95b22f60ef90c6875fe784fe6205e9e10992',
} as const

beforeEach(() => {
  process.env.ESCROW_RAIL = 'testnet'
  process.env.LIT_VAULT_USAGE_KEY = 'usage-key-for-tests'
  __clearTicketedCardsV2ForTests()
})

afterEach(() => {
  closeServerWorldV2()
  for (const [k, v] of [['ESCROW_RAIL', RAIL], ['LIT_VAULT_USAGE_KEY', USAGE_KEY]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

async function balanceOf(w: ServerWorldV2, who: Hex): Promise<bigint> {
  const r = await w.node.chain.call(testAddress(1), PATH_USD, encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [who] }))
  return decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: r.returnData })
}

/** Every transaction the code under test sent: to and selector. */
function sentTxs(w: ServerWorldV2): Array<{ to: string; selector: string }> {
  return w.node.sent('eth_sendRawTransaction').slice(w.setupTxs).map((r) => {
    const tx = parseTransaction(r.params[0] as Hex)
    return { to: (tx.to ?? '').toLowerCase(), selector: (tx.data ?? '0x').slice(0, 10) }
  })
}

async function run(w: ServerWorldV2, key: string | null = null): Promise<RunV2> {
  const r = await startRunV2({ apply: true, keeperKey: key, rt: w.rt })
  if (!('reader' in r)) throw new Error(`the V2 run did not start: ${r.skipped ?? r.errors.join('; ')}`)
  return r
}

function sealedOf(w: ServerWorldV2, l: Awaited<ReturnType<typeof listV2>>) {
  const data = escrowIntentDataV2(w.template, l.manifest, l.manifestText, l.envelope, new Date(), `0x${'ab'.repeat(32)}`)
  const sealed = readEscrowSealedRefV2(data.sealedRef as unknown as Prisma.JsonValue, w.template)
  if (sealed === null) throw new Error('the V2 sealed ref did not read back')
  return sealed
}

describe('the committed V2, pinned live on 2026-10-13', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/vault/lit/templates')
    vi.doUnmock('@/lib/vault/lit/escrow-pins')
    vi.resetModules()
  })

  it('ESCROW_V2 is intact and every pin is the live run\'s', () => {
    expect(templateIntegrity(ESCROW_V2).intact).toBe(true)
    expect(escrowPinProblems(ESCROW_V2)).toEqual([])
    expect({
      escrowAddress: ESCROW_V2.escrowAddress,
      escrowDeployer: ESCROW_V2.escrowDeployer,
      escrowCreationTx: ESCROW_V2.escrowCreationTx,
      identity: ESCROW_V2.identity,
      encPub: ESCROW_V2.encPub,
    }).toEqual(LIVE_V2)
    expect(ESCROW_V2.source.split('\n')).toContain(`const ESCROW = "${LIVE_V2.escrowAddress}";`)
    for (const k of Object.keys(ESCROW_V2_PINS) as Array<keyof typeof ESCROW_V2_PINS>) expect(ESCROW_V2[k], k).toBe(ESCROW_V2_PINS[k])
  })

  it('ready: configured here, its config block and the page pins are the live values, and ESCROW_V2_LIVE opens it and freezes V1', () => {
    const rt = escrowRuntime()
    expect(rt.templateV2).toBe(ESCROW_V2)
    expect(templateV2NotReady(ESCROW_V2)).toBeNull()
    expect(escrowV2Configured(rt)).toBe(true)
    // What V2 sold settles whatever the switch says: the keeper's reader is there, on the live escrow.
    expect(escrowReaderV2(rt)?.escrow).toBe(LIVE_V2.escrowAddress)
    expect(escrowConfigV2()).toEqual({
      escrow: LIVE_V2.escrowAddress,
      token: PATH_USD,
      template: {
        id: 'salvo-vault-escrow/2',
        sha256: ESCROW_V2.sha256,
        cid: ESCROW_V2.cid,
        intact: true,
        identity: LIVE_V2.identity,
        encPub: LIVE_V2.encPub,
        escrowCodehash: ESCROW_V2.escrowCodehash,
        escrowCreationTx: LIVE_V2.escrowCreationTx,
      },
      limits: ESCROW_V2_LIMITS,
    })
    // The pages hold our server to the same values.
    expect(pagePinsV2()).toEqual({ escrow: LIVE_V2.escrowAddress, identity: LIVE_V2.identity, encPub: LIVE_V2.encPub })
    // Open: the committed switch is on (phase 3b), so new sales go to V2 and V1 takes nothing new.
    expect(ESCROW_V2_LIVE).toBe(true)
    expect(escrowV2Live(rt)).toBe(true)
    expect(escrowV1Frozen(rt)).toBe(true)
    // A runtime switched off (V1's own test world) still runs V1 alone.
    expect(escrowV2Live({ ...rt, v2Live: false })).toBe(false)
    expect(escrowV1Frozen({ ...rt, v2Live: false })).toBe(false)
  })

  it('before the pin step (the committed V2 unpinned for one import graph): not configured, no reader, no config block, no page pins, nothing frozen', async () => {
    vi.resetModules()
    vi.doMock('@/lib/vault/lit/templates', (importOriginal) => templatesWithV2Unpinned(importOriginal))
    vi.doMock('@/lib/vault/lit/escrow-pins', (importOriginal) => pinsWithV2Unpinned(importOriginal))
    const templates = await import('@/lib/vault/lit/templates')
    const config = await import('@/lib/escrow/config-v2')
    const runtime = await import('@/lib/escrow/runtime')
    const chain = await import('@/lib/escrow/chain-v2')
    const api = await import('@/lib/escrow/client/api-v2')
    const t = templates.ESCROW_V2
    // The template as it was: the placeholder, intact under its own hashes, no pin but the code hash.
    expect(templates.templateIntegrity(t).intact).toBe(true)
    expect(escrowPinProblems(t)).toEqual(['unpinned'])
    expect([t.escrowAddress, t.escrowDeployer, t.escrowCreationTx, t.identity, t.encPub]).toEqual([null, null, null, null, null])
    expect(t.escrowCodehash).toBe(ESCROW_V2.escrowCodehash)
    // So nothing on our side counts it, even with the switch on.
    const rt = runtime.escrowRuntime()
    expect(runtime.templateV2Of(rt)).toBe(t)
    expect(config.templateV2NotReady(t)).toBe('the V2 escrow address is not pinned')
    expect(config.escrowV2Configured(rt)).toBe(false)
    expect(config.escrowV2Live({ ...rt, v2Live: true })).toBe(false)
    expect(config.escrowV1Frozen({ ...rt, v2Live: true })).toBe(false)
    expect(config.escrowConfigV2()).toBeNull()
    expect(chain.escrowReaderV2()).toBeNull()
    expect(api.pagePinsV2()).toBeNull()
    // V1 in the same graph is the live one, untouched.
    expect(escrowPinProblems(templates.ESCROW_V1)).toEqual([])
  })
})

describe('V2 counts only once every pin is set, and is open only once switched on; then V1 is frozen', () => {
  it('an unpinned V2 is not configured: no reader, no config block, V1 runs as before, whatever is committed', () => {
    const rt: EscrowRuntime = { ...escrowRuntime(), templateV2: UNPINNED_V2, v2Live: true }
    expect(templateV2NotReady(UNPINNED_V2)).toBe('the V2 escrow address is not pinned')
    expect(escrowV2Configured(rt)).toBe(false)
    expect(escrowV2Live(rt)).toBe(false)
    expect(escrowV1Frozen(rt)).toBe(false)
    expect(escrowConfigV2(UNPINNED_V2)).toBeNull()
    expect(escrowReaderV2(rt)).toBeNull()
    expect(escrowListingOpenV2(rt)).toBe(false)
    // The committed template is pinned (2026-10-13) and switched on (phase 3b): V1 is frozen as committed.
    expect(escrowV1Frozen(escrowRuntime())).toBe(ESCROW_V2_LIVE && escrowV2Configured(escrowRuntime()))
    expect(escrowV1Frozen(escrowRuntime())).toBe(true)
  })

  it("V2's pins alone freeze nothing: switched off, V1 lists and quotes as before and V2's routes refuse", async () => {
    const w = await serverWorldV2()
    // The committed switch is on (phase 3b); a runtime that turns it off is the pins alone.
    expect(ESCROW_V2_LIVE).toBe(true)
    const pinnedOnly: EscrowRuntime = { ...w.rt, v2Live: false }
    expect(escrowV2Configured(pinnedOnly)).toBe(true)
    expect(escrowV2Live(pinnedOnly)).toBe(false)
    expect(escrowV1Frozen(pinnedOnly)).toBe(false)
    expect(escrowListingOpen(pinnedOnly)).toBe(true)
    expect(escrowListingOpenV2(pinnedOnly)).toBe(false)
    // V1 takes the listing past its freeze check (and refuses this empty one for its terms instead).
    const v1 = await acceptSealedListing({ manifest: '{}', envelope: {}, txHash: `0x${'1'.repeat(64)}` }, pinnedOnly).catch((e: unknown) => e)
    expect(v1).toMatchObject({ code: 'bad_manifest' })
    const l = await listV2(w, { onChain: false })
    const v2 = await acceptSealedListingV2({ manifest: l.manifestText, envelope: l.envelope, txHash: `0x${'2'.repeat(64)}`, cardFingerprint: `0x${'ab'.repeat(32)}` }, pinnedOnly).catch(
      (e: unknown) => e,
    )
    expect(v2).toMatchObject({ code: 'not_ready', status: 503 })
    // The keeper still follows what V2 sold: it needs only the pins.
    expect(await startRunV2({ apply: false, keeperKey: null, rt: pinnedOnly })).toMatchObject({ report: { ran: true } })
  })

  it("V1's own test world runs V1 alone: an unpinned V2, switched off, so committing V2's pins never freezes it", async () => {
    const w = await serverWorld()
    try {
      expect(w.rt.templateV2).toBe(UNPINNED_V2)
      expect(w.rt.v2Live).toBe(false)
      expect(escrowV2Configured(w.rt)).toBe(false)
      expect(escrowV1Frozen(w.rt)).toBe(false)
      // Even with V2 fully pinned beside it, the world's switch keeps V1 open.
      const v2 = await serverWorldV2()
      expect(escrowV1Frozen({ ...w.rt, templateV2: v2.template })).toBe(false)
    } finally {
      closeServerWorld()
    }
  })

  it('pinned, bound and deployed: configured, its config block carries the pins, and V1 takes no listing', async () => {
    const w = await serverWorldV2()
    expect(escrowV2Configured(w.rt)).toBe(true)
    expect(escrowV1Frozen(w.rt)).toBe(true)
    expect(escrowConfigV2(w.template)).toEqual({
      escrow: w.escrow,
      token: PATH_USD,
      template: {
        id: 'salvo-vault-escrow/2',
        sha256: w.template.sha256,
        cid: w.template.cid,
        intact: true,
        identity: w.template.identity,
        encPub: w.template.encPub,
        escrowCodehash: w.template.escrowCodehash,
        escrowCreationTx: w.template.escrowCreationTx,
      },
      limits: ESCROW_V2_LIMITS,
    })
    expect(ESCROW_V2_LIMITS).toMatchObject({ contestWindowSeconds: 7_200, bondReviewAfterSeconds: 5 * DAY, bondMaxAgeSeconds: 7 * DAY, confirmDelaySeconds: 900 })
    // Every pin is needed: no creation transaction, or a drifted source, and V2 is not configured.
    expect(templateV2NotReady({ ...w.template, escrowCreationTx: null })).toBe("the V2 escrow's creation transaction is not pinned")
    expect(templateV2NotReady({ ...w.template, source: `${w.template.source} ` })).toBe('the V2 escrow template no longer matches its pins')
    expect(escrowV2Configured({ ...w.rt, templateV2: { ...w.template, identity: null } })).toBe(false)

    // V1's own template is ready (the live pins), yet it takes no listing once V2 is open.
    expect(escrowListingOpen({ ...w.rt, templateV2: UNPINNED_V2 })).toBe(true)
    expect(escrowListingOpen(w.rt)).toBe(false)
    expect(escrowListingOpenV2(w.rt)).toBe(true)
    const refused = await acceptSealedListing({ manifest: '{}', envelope: {}, txHash: `0x${'1'.repeat(64)}` }, w.rt).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(EscrowListingRefusedError)
    expect(refused).toMatchObject({ code: 'v1_frozen', status: 410 })
  })

  it('the custody guard is not weakened: a V2 seal classifies unknown, and only the operator may record one', async () => {
    const w = await serverWorldV2()
    const l = await listV2(w, { onChain: false })
    const ref = escrowIntentDataV2(w.template, l.manifest, l.manifestText, l.envelope, new Date(), `0x${'cd'.repeat(32)}`).sealedRef as unknown as {
      algorithm: string
      lit: unknown
    }
    expect(ref.algorithm).toBe(CHIPOTLE_ESCROW_ALGORITHM)
    expect(escrowVersionOfRef(ref)).toBe(2)
    expect(classifyBackend(backendOfSealedRef(ref))).toBe('unknown')
    expect(() => assertSealedRefAllowedForOwner(ref, { kind: 'seller', ownerId: `seller:${SELLER_V2}` })).toThrow(CustodialVaultRefusedError)
    expect(() => assertSealedRefAllowedForOwner(ref, { kind: 'operator', ownerId: 'operator:0' })).not.toThrow()
  })

  it('a V2 listing is refused for free, before any read, without its card fingerprint or with a V1 manifest', async () => {
    const w = await serverWorldV2()
    const l = await listV2(w, { onChain: false })
    const txHash = `0x${'2'.repeat(64)}`
    const without = await acceptSealedListingV2({ manifest: l.manifestText, envelope: l.envelope, txHash, cardFingerprint: undefined }, w.rt).catch((e: unknown) => e)
    expect(without).toMatchObject({ code: 'bad_fingerprint', status: 400 })
    const upper = await acceptSealedListingV2({ manifest: l.manifestText, envelope: l.envelope, txHash, cardFingerprint: `0x${'AB'.repeat(32)}` }, w.rt).catch(
      (e: unknown) => e,
    )
    expect(upper).toMatchObject({ code: 'bad_fingerprint' })
    const v1 = await acceptSealedListingV2({ manifest: '{"v":1}', envelope: l.envelope, txHash, cardFingerprint: `0x${'ab'.repeat(32)}` }, w.rt).catch((e: unknown) => e)
    expect(v1).toMatchObject({ code: 'bad_manifest' })
    // Not configured: nothing is taken for V2 at all.
    const unpinned = await acceptSealedListingV2(
      { manifest: l.manifestText, envelope: l.envelope, txHash, cardFingerprint: `0x${'ab'.repeat(32)}` },
      { ...w.rt, templateV2: UNPINNED_V2 },
    ).catch((e: unknown) => e)
    expect(unpinned).toMatchObject({ code: 'not_ready', status: 503 })
  })
})

describe('the V2 reader and the Lit relay', () => {
  it('a card in two parts: tickets bind what is left, the deposit reads back, and each buyer gets the card', async () => {
    const w = await serverWorldV2()
    const reader = escrowReaderV2(w.rt)
    if (reader === null) throw new Error('no V2 reader')
    const l = await listV2(w, { valueCents: 2_000, price: 18_000_000, residualCapCents: 500 })
    let at = await reader.block()
    expect(await reader.gate(at, l.listingId, 0n)).toMatchObject({
      signer: w.template.identity,
      token: PATH_USD,
      listingSeller: SELLER_V2,
      listingState: V2_STATE.listing.ACTIVE,
      remainingCents: 0,
      sales: 0,
      bondDeposit: 0n,
    })

    // Shopper A uses $16.00 of $20.00: pays its share, deposits $4.00 at face.
    const a = await useCardV2(w, l, SHOPPER_A, 1_600)
    expect(a.ticket).toMatchObject({ remainingCents: 2_000, sales: 0, openBalanceCents: 0 })
    expect(a.bondDeposit).toBe(0n)
    at = await reader.block()
    expect(
      await ticketProblemsV2(a.ticket, {
        listingId: l.listingId,
        depositor: SHOPPER_A,
        replyKeyHash: a.ticket.replyKeyHash,
        identity: w.template.identity as Hex,
        escrow: w.escrow,
        mode: l.manifest.mode,
        chainTime: Number(at.timestamp) - 1,
        remainingCents: 2_000,
        sales: 0,
      }),
    ).toEqual([])
    const d1 = await reader.deposit(at, a.depositId)
    expect(d1).toMatchObject({
      depositor: SHOPPER_A,
      seller: SELLER_V2,
      state: V2_STATE.deposit.OPENED,
      usedCents: 1_600,
      leftAfterCents: 400,
      saleIndex: 0,
      amount: priceForV2(18_000_000n, 2_000, 1_600, 0),
      bond: 4_000_000n,
      bondState: V2_STATE.bond.HELD,
      covers: 0n,
      contestUntil: 0,
    })
    expect(await reader.gate(at, l.listingId, 0n)).toMatchObject({ remainingCents: 400, sales: 1, bondDeposit: a.depositId })
    expect(await reader.listing(at, l.listingId)).toMatchObject({ state: V2_STATE.listing.ACTIVE, remainingCents: 400, lastDeposit: a.depositId, bondDeposit: a.depositId })

    // A gets the card, to their own key only.
    const r1 = await requestReleaseV2({ manifest: l.manifestText, envelope: l.envelope, depositId: a.depositId.toString(), replyKey: a.reply.publicKey }, w.rt)
    if (!r1.ok) throw new Error(`release refused: ${r1.refusal}`)
    const card = JSON.parse(a.reply.open(r1.reply, r1.payload, w.template.encPub as string).toString('utf8')) as { cardNumber: string }
    expect(card.cardNumber).toBe(l.cardNumber)
    const other = createReplyKey().publicKey
    expect(await requestReleaseV2({ manifest: l.manifestText, envelope: l.envelope, depositId: a.depositId.toString(), replyKey: other }, w.rt)).toEqual({
      ok: false,
      refusal: 'access_denied',
    })

    // The chain's card rules: the leftover sells only under this listing.
    const tag = a.ticket.cardTag
    const sale = { cardTag: tag, seller: SELLER_V2, mode: l.manifest.mode, valueCents: 2_000 }
    expect(await reader.cardSaleRefusal(at, { ...sale, listingId: l.listingId, sales: 1 })).toBeNull()
    const again = await listV2(w, { cardNumber: l.cardNumber })
    expect(await reader.cardSaleRefusal(at, { ...sale, listingId: again.listingId, sales: 0 })).toBe('card_listed')
    expect(await ticketedCardRefusalV2('esc_again', { ...sale, listingId: again.listingId, listingExpiry: again.manifest.listingExpiry, sales: 0 }, w.rt)).toBe(
      'card_listed',
    )
    // The leftover's own listing stays the one that sells, whatever else was ticketed.
    expect(
      await ticketedCardRefusalV2('esc_first', { ...sale, listingId: l.listingId, listingExpiry: l.manifest.listingExpiry, sales: 1 }, w.rt),
    ).toBeNull()

    // Shopper B uses the $4.00 left, whole: the leftover A's deposit covers.
    const b = await useCardV2(w, l, SHOPPER_B, 400)
    expect(b.ticket).toMatchObject({ remainingCents: 400, sales: 1 })
    expect(b.bondDeposit).toBe(a.depositId)
    at = await reader.block()
    const d2 = await reader.deposit(at, b.depositId)
    expect(d2).toMatchObject({ usedCents: 400, leftAfterCents: 0, saleIndex: 1, covers: a.depositId, contestUntil: d2.openedAt + 7_200, bondState: V2_STATE.bond.NONE })
    // No haircut while a deposit covers the leftover (decision 3).
    expect(d2.amount).toBe(priceForV2(18_000_000n, 2_000, 400, 0))
    expect(await reader.listing(at, l.listingId)).toMatchObject({ state: V2_STATE.listing.DRAINED, remainingCents: 0, lastDeposit: b.depositId })
    // B drained it: the card is B's, so no other listing of it sells.
    expect(await reader.cardSaleRefusal(at, { ...sale, listingId: again.listingId, sales: 0 })).toBe('card_not_sellers')
    const r2 = await requestReleaseV2({ manifest: l.manifestText, envelope: l.envelope, depositId: b.depositId.toString(), replyKey: b.reply.publicKey }, w.rt)
    expect(r2.ok).toBe(true)
  })

  it('a readable leftover: the ticket reads it against what is left, and a short read comes back signed', async () => {
    const w = await serverWorldV2()
    w.stores.setBalance('bestbuy', BESTBUY_CARD, 3_000)
    const l = await listV2(w, {
      merchantName: 'bestbuy',
      mode: MODE_READABLE,
      valueCents: 3_000,
      price: 27_000_000,
      residualCapCents: 1_000,
      cardNumber: BESTBUY_CARD,
      pin: BESTBUY_PIN,
    })
    const a = await useCardV2(w, l, SHOPPER_A, 2_500)
    expect(a.ticket).toMatchObject({ openBalanceCents: 3_000, remainingCents: 3_000 })
    w.stores.spend('bestbuy', BESTBUY_CARD, 2_500)
    // A comes back and spends $2.00 of the $5.00 they left.
    w.stores.spend('bestbuy', BESTBUY_CARD, 200)
    w.node.advance(60)

    const replyKeyHash = keccak256('0x02aa')
    const short = await requestTicketV2({ manifest: l.manifestText, envelope: l.envelope, listingId: l.listingId, depositor: SHOPPER_B, replyKeyHash }, w.rt)
    expect(short).toMatchObject({ ok: false, refusal: 'balance_short', confirm: { listingId: l.listingId, bondDeposit: a.depositId, balance: 300 } })

    const read = await requestConfirmV2({ manifest: l.manifestText, envelope: l.envelope, listingId: l.listingId }, w.rt)
    expect(read).toMatchObject({ ok: true, confirm: { listingId: l.listingId, bondDeposit: a.depositId, balance: 300 } })
    // A blind listing has nothing to read.
    const blind = await listV2(w)
    await useCardV2(w, blind, SHOPPER_A, 1_800)
    expect(await requestConfirmV2({ manifest: blind.manifestText, envelope: blind.envelope, listingId: blind.listingId }, w.rt)).toEqual({
      ok: false,
      refusal: 'access_denied',
    })
  })
})

describe("the keeper's chain work", () => {
  it('does not start while the rail is off or V2 is not configured', async () => {
    const w = await serverWorldV2()
    delete process.env.ESCROW_RAIL
    expect(await startRunV2({ apply: true, keeperKey: null, rt: w.rt })).toMatchObject({ ran: false, skipped: 'rail_off' })
    process.env.ESCROW_RAIL = 'testnet'
    expect(await startRunV2({ apply: true, keeperKey: null, rt: { ...w.rt, templateV2: UNPINNED_V2 } })).toMatchObject({ ran: false, skipped: 'v2_not_configured' })
    const started = await startRunV2({ apply: true, keeperKey: null, rt: w.rt })
    expect('reader' in started && started.report).toMatchObject({ ran: true, keeperKey: false, block: expect.stringMatching(/^[0-9]+$/) })
  })

  it("gives the first shopper's deposit back two hours after the next shopper's use of the leftover held, not before", async () => {
    const w = await serverWorldV2()
    const key = generatePrivateKey()
    const l = await listV2(w)
    const sealed = sealedOf(w, l)
    const a = await useCardV2(w, l, SHOPPER_A, 1_700)
    // Nobody has used the leftover: the deposit waits for the seven-day rule.
    let s = await sweepListingV2(await run(w, key), sealed, { shortReported: false })
    expect(s.bondAction).toMatchObject({ kind: 'wait', review: false })
    const b = await useCardV2(w, l, SHOPPER_B, 300)
    const r0 = await run(w)
    const d2 = await r0.reader.deposit(r0.block, b.depositId)

    w.node.advance(2 * HOUR - 10)
    s = await sweepListingV2(await run(w, key), sealed, { shortReported: false })
    expect(s.bondAction).toEqual({ kind: 'wait', until: d2.contestUntil, review: false })
    expect(sentTxs(w)).toEqual([])

    w.node.advance(10)
    const before = await balanceOf(w, SHOPPER_A)
    const r = await run(w, key)
    s = await sweepListingV2(r, sealed, { shortReported: false })
    expect(s.bondAction).toEqual({ kind: 'return', why: 'next_use_held' })
    expect(s.bondSent).not.toBeNull()
    expect(r.report).toMatchObject({ bondsDue: 1, bondsSent: 1, errors: [] })
    expect(sentTxs(w)).toEqual([{ to: w.escrow, selector: RELEASE_BOND }])
    expect((await balanceOf(w, SHOPPER_A)) - before).toBe(3_000_000n)
    const r2 = await run(w, key)
    expect(await r2.reader.deposit(r2.block, a.depositId)).toMatchObject({ bond: 0n, bondState: V2_STATE.bond.RETURNED })
    // Settled: nothing more is sent for it.
    await sweepListingV2(r2, sealed, { shortReported: false })
    expect(sentTxs(w)).toHaveLength(1)

    // The seller's payouts follow at releaseAt, each as release(id), never before.
    const rr = await run(w, key)
    expect(await payoutIfDueV2(rr, a.depositId, await rr.reader.deposit(rr.block, a.depositId))).toBeNull()
    w.node.advance(DAY)
    const seller = await balanceOf(w, SELLER_V2)
    const rp = await run(w, key)
    const d1 = await rp.reader.deposit(rp.block, a.depositId)
    expect(await payoutIfDueV2(rp, a.depositId, d1)).not.toBeNull()
    expect(await payoutIfDueV2(rp, b.depositId, await rp.reader.deposit(rp.block, b.depositId))).not.toBeNull()
    expect(rp.report).toMatchObject({ payoutsDue: 2, payoutsSent: 2 })
    expect(sentTxs(w).slice(1)).toEqual([
      { to: w.escrow, selector: RELEASE },
      { to: w.escrow, selector: RELEASE },
    ])
    expect((await balanceOf(w, SELLER_V2)) - seller).toBe(d1.amount + d2.amount)
  })

  it('without a key it reports the deposit due and sends nothing', async () => {
    const w = await serverWorldV2()
    const l = await listV2(w)
    await useCardV2(w, l, SHOPPER_A, 1_700)
    await useCardV2(w, l, SHOPPER_B, 300)
    w.node.advance(2 * HOUR)
    const r = await run(w, null)
    const s = await sweepListingV2(r, sealedOf(w, l), { shortReported: false })
    expect(s.bondAction).toEqual({ kind: 'return', why: 'next_use_held' })
    expect(r.report).toMatchObject({ bondsDue: 1, bondsSent: 0, keeperKey: false })
    expect(sentTxs(w)).toEqual([])
  })

  it('a contested leftover: the deposit already paid the seller, and the row follows to refunded', async () => {
    const w = await serverWorldV2()
    const key = generatePrivateKey()
    const l = await listV2(w)
    const a = await useCardV2(w, l, SHOPPER_A, 1_700)
    const b = await useCardV2(w, l, SHOPPER_B, 300)
    const seller = await balanceOf(w, SELLER_V2)
    expect((await w.node.chain.send(SHOPPER_B, w.escrow, escrowV2Call.contestRemainder(b.depositId, REASON))).ok).toBe(true)
    // The first shopper's deposit, at face, went to the seller.
    expect((await balanceOf(w, SELLER_V2)) - seller).toBe(3_000_000n)
    const r = await run(w, key)
    const s = await sweepListingV2(r, sealedOf(w, l), { shortReported: false })
    expect(s.listing.state).toBe(V2_STATE.listing.SPENT)
    expect(s.bondAction).toEqual({ kind: 'none' })
    // The seller was paid from a deposit: their claim is checked, in case the token refused it.
    expect(r.parties.has(SELLER_V2)).toBe(true)
    expect(await r.reader.deposit(r.block, a.depositId)).toMatchObject({ bondState: V2_STATE.bond.FORFEITED })
    expect(await r.reader.deposit(r.block, b.depositId)).toMatchObject({ state: V2_STATE.deposit.CONTESTED, amount: 0n })
    expect(await r.reader.buyerShortfalls(r.block, SHOPPER_A)).toBe(1)
    expect((await r.reader.sellerStats(r.block, SELLER_V2)).remaindersShort).toBe(1)
    expect(intentTargetV2(s.listing, s.latest, Number(r.block.timestamp), l.manifest.listingExpiry, 'executing')).toMatchObject({ state: 'refunded' })
    // A contested sale is never paid out, and its card is never released again.
    expect(await payoutIfDueV2(r, b.depositId, await r.reader.deposit(r.block, b.depositId))).toBeNull()
    expect(
      await requestReleaseV2({ manifest: l.manifestText, envelope: l.envelope, depositId: b.depositId.toString(), replyKey: b.reply.publicKey }, w.rt),
    ).toEqual({ ok: false, refusal: 'access_denied' })
    expect(sentTxs(w)).toEqual([])
  })

  it('an unsold leftover: the seller is asked from day five, and the deposit comes back by rule at day seven', async () => {
    const w = await serverWorldV2()
    const key = generatePrivateKey()
    const l = await listV2(w)
    const sealed = sealedOf(w, l)
    const a = await useCardV2(w, l, SHOPPER_A, 1_600)
    w.node.advance(5 * DAY)
    let r = await run(w, key)
    let s = await sweepListingV2(r, sealed, { shortReported: false })
    expect(s.bondAction).toMatchObject({ kind: 'wait', review: true })
    expect(r.report.sellerReviews).toBe(1)
    w.node.advance(2 * DAY)
    const before = await balanceOf(w, SHOPPER_A)
    r = await run(w, key)
    s = await sweepListingV2(r, sealed, { shortReported: false })
    expect(s.bondAction).toEqual({ kind: 'return', why: 'max_age' })
    expect((await balanceOf(w, SHOPPER_A)) - before).toBe(4_000_000n)
    r = await run(w, key)
    // The leftover stays first in line, with no deposit: the haircut is back on its price.
    expect(await r.reader.listing(r.block, l.listingId)).toMatchObject({ state: V2_STATE.listing.ACTIVE, remainingCents: 400, bondDeposit: 0n })
    expect(await r.reader.deposit(r.block, a.depositId)).toMatchObject({ bondState: V2_STATE.bond.RETURNED })
  })

  it("a readable leftover is read fifteen minutes after the sale, and a shortfall goes to the seller from the buyer's deposit", async () => {
    const w = await serverWorldV2()
    const key = generatePrivateKey()
    w.stores.setBalance('bestbuy', BESTBUY_CARD, 3_000)
    const l = await listV2(w, {
      merchantName: 'bestbuy',
      mode: MODE_READABLE,
      valueCents: 3_000,
      price: 27_000_000,
      residualCapCents: 1_000,
      cardNumber: BESTBUY_CARD,
      pin: BESTBUY_PIN,
    })
    const sealed = sealedOf(w, l)
    const a = await useCardV2(w, l, SHOPPER_A, 2_500)
    w.stores.spend('bestbuy', BESTBUY_CARD, 2_700)

    // Not yet: the read must come at least fifteen minutes after the sale.
    w.node.advance(600)
    let r = await run(w, key)
    let s = await sweepListingV2(r, sealed, { shortReported: false })
    expect(r.report.confirmsDue).toBe(0)
    expect(s.confirm).toBeNull()

    w.node.advance(300)
    const seller = await balanceOf(w, SELLER_V2)
    r = await run(w, key)
    s = await sweepListingV2(r, sealed, { shortReported: false })
    expect(r.report).toMatchObject({ confirmsDue: 1, confirmsSent: 1, errors: [] })
    expect(s.confirm).toMatchObject({ balance: 300, bondDeposit: a.depositId })
    expect(s.buyersShortfall).toBe(true)
    expect(sentTxs(w)).toEqual([{ to: w.escrow, selector: CONFIRM }])
    // The shortfall paid the seller: their claim is checked this run, in case the token refused it.
    expect(r.parties.has(SELLER_V2)).toBe(true)
    // $2.00 short at face, from A's deposit, to the seller only; what is left is now $3.00.
    expect((await balanceOf(w, SELLER_V2)) - seller).toBe(2_000_000n)
    r = await run(w, key)
    expect(await r.reader.listing(r.block, l.listingId)).toMatchObject({ remainingCents: 300, bondDeposit: a.depositId })
    expect(await r.reader.buyerShortfalls(r.block, SHOPPER_A)).toBe(1)
    // A read posts once: nothing is due again.
    s = await sweepListingV2(r, sealed, { shortReported: false })
    expect(r.report.confirmsDue).toBe(0)
    expect(sentTxs(w)).toHaveLength(1)
  })

  it('a leftover a ticket found short is read at once, and a read that finds it whole moves nothing', async () => {
    const w = await serverWorldV2()
    const key = generatePrivateKey()
    w.stores.setBalance('bestbuy', BESTBUY_CARD, 3_000)
    const l = await listV2(w, {
      merchantName: 'bestbuy',
      mode: MODE_READABLE,
      valueCents: 3_000,
      price: 27_000_000,
      residualCapCents: 1_000,
      cardNumber: BESTBUY_CARD,
      pin: BESTBUY_PIN,
    })
    const sealed = sealedOf(w, l)
    await useCardV2(w, l, SHOPPER_A, 2_500)
    w.stores.spend('bestbuy', BESTBUY_CARD, 2_500)
    w.node.advance(60)
    // A ticket found it short: the read is due now, not in fifteen minutes.
    let r = await run(w, key)
    expect(await sweepListingV2(r, sealed, { shortReported: false })).toMatchObject({ confirm: null })
    r = await run(w, key)
    const s = await sweepListingV2(r, sealed, { shortReported: true })
    // It read $5.00, all of it: nothing moves, and the buyer is not blamed.
    expect(s.confirm).toMatchObject({ balance: 500 })
    expect(s.buyersShortfall).toBe(false)
    expect(r.report.confirmsSent).toBe(1)
    r = await run(w, key)
    expect(await r.reader.listing(r.block, l.listingId)).toMatchObject({ remainingCents: 500, state: V2_STATE.listing.ACTIVE })
  })
})

describe('the runtime', () => {
  it('names the committed V2 template unless a test pins one', () => {
    const rt: EscrowRuntime = escrowRuntime()
    expect(rt.templateV2).toBe(ESCROW_V2)
  })
})
