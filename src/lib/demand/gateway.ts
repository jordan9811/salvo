/**
 * Gate 4 (Phase 4) — turning an accepted quote into an escrow-funded order.
 *
 * ===========================================================================
 * PHASE 5: THE DECISION WAS MADE. This is now the native shape.
 *
 * Phase 4 surfaced that `Order` was TICKET-SHAPED — `theaterName`, `theaterZip`,
 * `film` and `showtimeUtc` all NOT NULL, with `showtimeUtc` read in ~25 places
 * including the refund daemon, every buyer email and the worker queue. Two
 * gateways were built and neither was picked: a ticket-shaped one that worked
 * immediately by stuffing the supply deadline into `showtimeUtc`, and a native
 * one that refused pending a migration.
 *
 * Phase 5 ran that migration. `kind`, `merchantId` and `deadlineAt` are real
 * columns; the ticket-domain columns are nullable; and a gift-card order now
 * carries NULL where it has nothing to say rather than a fabricated film title.
 *
 * `TicketShapedGateway` is GONE, deliberately, rather than kept as a fallback.
 * A fallback that writes a fake showtime into a column the refund daemon keys
 * on is exactly the kind of thing that survives for years because it "still
 * works", and there is no longer any reason to keep it around.
 * ===========================================================================
 */

import type { Order, PaymentRail } from '@prisma/client'
import { prisma } from '../db'
import { createPaidOrder, type OrderDraft } from '../orders'
import { matchIntent } from '../intent/service'
import type { DemandQuote } from './quote'
import type { ChainKey } from '../chains/types'

export interface BuyerOrderInput {
  quote: DemandQuote
  buyerEmail: string
  rail: PaymentRail
  /** Stripe session id, or the settlement tx hash on a crypto rail. */
  paymentRef: string
  /** Crypto rails: where a refund goes. */
  payerAddress?: string | null
  /** Which chain the buyer funded on. Decides the seller's payout chain. */
  chain?: ChainKey | null
  idempotencyKey: string
  now?: Date
}

export interface BuyerOrderResult {
  order: Order
  /** Intents moved offered → matched. */
  matchedIntentIds: string[]
  /** True when the order reused an existing row for this idempotency key. */
  idempotentReplay: boolean
}

/**
 * How a buyer-initiated order becomes a row.
 *
 * An interface with two implementations because the underlying question is
 * genuinely open — the same reason Gate 1 has two executors.
 */
export interface DemandOrderGateway {
  readonly shape: 'native'
  create(input: BuyerOrderInput): Promise<BuyerOrderResult>
}

/**
 * The native shape.
 *
 * Still reuses the intake path literally — it calls `createPaidOrder`, the same
 * function the Stripe and crypto rails call, with the same idempotency
 * semantics and the same state machine. What changed in Phase 5 is only WHAT IT
 * WRITES:
 *
 *   kind        ← 'gift_card'
 *   merchantId  ← the merchant
 *   deadlineAt  ← the quote's expiry, in its own column
 *   theater*/
/*   film, showtimeUtc ← NULL. There is no theater and no showtime, and saying
 *                       so is the entire point of the migration.
 *
 * The refund daemon still does the right thing, and now it does so on purpose
 * rather than by coincidence: it keys on `deadlineAt` and scopes itself to
 * atomic kinds.
 */
export class NativeOrderGateway implements DemandOrderGateway {
  readonly shape = 'native' as const

  async create(input: BuyerOrderInput): Promise<BuyerOrderResult> {
    const { quote } = input

    // ValidatedIntake is still the ticket-domain intake type. Passing nulls
    // through it is the honest expression of "this is not a ticket"; the
    // ticket-specific validators are not on this path at all.
    const intake: OrderDraft = {
      buyerEmail: input.buyerEmail,
      theaterName: null,
      theaterZip: null,
      theaterSlug: null,
      film: null,
      showtimeUtc: null,
      showtimeUrl: null,
      qty: 1,
      priceCents: quote.priceCents,
    }

    const { order, created } = await createPaidOrder({
      intake,
      kind: 'gift_card',
      merchantId: quote.merchantId,
      // Its own column now, rather than smuggled through showtimeUtc.
      deadlineAt: quote.expiresAt,
      rail: input.rail,
      paymentRef: input.paymentRef,
      payerAddress: input.payerAddress ?? null,
      idempotencyKey: input.idempotencyKey,
    })

    // A replay must not re-match supply: the intents are already bound to this
    // order, and matchIntent would fail the offered→matched CAS anyway.
    if (!created) {
      return { order, matchedIntentIds: [], idempotentReplay: true }
    }

    const matchedIntentIds = await claimSupply(quote, order.id)
    return { order, matchedIntentIds, idempotentReplay: false }
  }
}

/**
 * Move every intent in the quote offered → matched, bound to this order.
 *
 * ALL OR NOTHING. A partially-matched quote is an order the buyer paid for that
 * cannot be filled as sold, so anything already claimed is released if a later
 * leg loses its compare-and-swap. Losing that CAS is normal, not exceptional:
 * quotes are not reservations, so two buyers racing for the same card is the
 * expected case and the loser must be made whole rather than half-served.
 */
export async function claimSupply(quote: DemandQuote, orderId: string): Promise<string[]> {
  const claimed: string[] = []

  for (const leg of quote.legs) {
    try {
      await matchIntent(leg.intentId, orderId)
      claimed.push(leg.intentId)
    } catch (err) {
      // Roll back what we took, so the cards go back on the market rather than
      // being stranded in `matched` against an order that will be refunded.
      await releaseSupply(claimed)
      throw new SupplyRaceLostError(leg.intentId, claimed.length, quote.legs.length, err)
    }
  }

  return claimed
}

/** Put claimed intents back to `offered`. Best-effort by design — see below. */
async function releaseSupply(intentIds: readonly string[]): Promise<void> {
  for (const id of intentIds) {
    // matched → offered is not a legal transition (the state machine only allows
    // matched → executing | cancelled), so this is a direct conditional write
    // rather than transitionIntent. It is conditional on the intent still being
    // `matched` and still bound to nothing that has begun executing.
    await prisma.intent
      .updateMany({
        where: { id, state: 'matched' },
        data: { state: 'offered', matchedOrderId: null },
      })
      .catch(() => undefined)
  }
}

export class SupplyRaceLostError extends Error {
  readonly intentId: string

  constructor(intentId: string, claimed: number, total: number, cause: unknown) {
    super(
      `supply ${intentId} was taken by another buyer while claiming leg ${claimed + 1} of ${total}. ` +
        `Released the ${claimed} card(s) already claimed. Re-quote and try again — quotes are ` +
        `not reservations, so this race is expected rather than exceptional.`,
      { cause },
    )
    this.name = 'SupplyRaceLostError'
    this.intentId = intentId
  }
}

/**
 * The gateway in use.
 *
 * One implementation since Phase 5 ran the migration. The function survives
 * because the pipeline depends on it and a second shape may yet appear — the
 * credit line, for instance, needs its own — but there is no longer a choice to
 * make here and `DEMAND_ORDER_SHAPE` no longer selects anything.
 */
export function resolveDemandGateway(): DemandOrderGateway {
  return new NativeOrderGateway()
}
