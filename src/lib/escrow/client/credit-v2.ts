/**
 * Store credit and selling it back, on the shopper's phone (unified spec
 * section 11).
 *
 * WHAT COUNTS AS THE SHOPPER'S CREDIT. Only cards that are theirs:
 *   - the rest of a card they kept (sale-v2.ts keepCardV2: the register said
 *     paid early, or the total fell past the cap);
 *   - a card a purchase left wholly theirs: a V2 card used up and never
 *     scanned, or a V1 card bought whole, with the balance the shopper says
 *     is on it (this phone cannot read a store's balance).
 * A leftover is never the shopper's: it stays the seller's, listed for the
 * next shopper, with this shopper's deposit on it.
 *
 * USED FIRST. The till takes credit at that store before buying anything
 * (spec section 6.2 step 1): cost nothing, scanned first, the oldest first.
 * The balance here is what this phone believes; the store decides.
 *
 * ONE LIST OF STORE CREDIT, /account'S. In the till's merge the account keeps
 * the shopper's credit in card-store.ts's `own:` slots: cards they typed in,
 * and cards bought here kept as credit (`kept-<card id>`). Given that book
 * (OwnCardBook), the till reads its credit from it, and every card V2 makes
 * the shopper's is written into it too, so /account and both rails show one
 * list with one balance per card. V2's own record (CreditRecordV2) stays
 * beside it for what only V2 needs: the escrow and sale a card came from,
 * whose credit it is, and whether it is listed again. Without the book
 * (before the merge, and in tests that do not give one) V2's records are the
 * list. The till uses this list only when it pays in dollars: the card rail
 * plans on our server, which never sees the shopper's own cards.
 *
 * EACH CREDIT IS ONE ACCOUNT'S. The V2 book is the browser's, and outlives a
 * sign-out (the cards stay, because they open nowhere else yet). So V2
 * credit names the account that bought it, and only that account, signed
 * in, sees it or pays with it: a browser signed out and signed in as someone
 * else never hands them the first person's gift card.
 *
 * SOLD BACK ON V2 ONLY. A card sold back is sealed again, here, under
 * salvo-vault-escrow/2 and listed by its owner (sell-v2.ts). The chain lets
 * its buyer list it once their purchase is paid out (SalvoEscrowV2's
 * cardOwner and cardDeposit, for a V2 card), and our server's fingerprint
 * check lets them too (card-fingerprint.ts: the card's newest sale decides,
 * and its buyer may list it once paid out, however many owners it had
 * before), which is also what covers a V1 card V2 cannot see.
 *
 * Browser only by use; imports nothing Node-only. Never logs a card.
 */

import type { Hex } from 'viem'
import type { EscrowMerchantName } from '../merchants'
import { depositAt } from '../runbook/reads'
import { depositV2At, V2_STATE } from '../runbook/reads-v2'
import { agreedFinalizedBlock } from '../runbook/rpc'
import type { CardRecord, CardSecret, CardStore } from './card-store'
import { creditsOfV2, type CreditRecordV2, type DeviceBookV2, type ListingRecordV2 } from './records-v2'
import { listCardV2, type SellDepsV2 } from './sell-v2'
import { SellRefused } from './sell'

/** V1's Released state: its sale is paid out to its seller. */
const V1_RELEASED = 2

const lower = (s: string): Hex => s.toLowerCase() as Hex

/**
 * One card of the shopper's own store credit as /account keeps it
 * (card-store.ts's `own:` slots in the till's merge): a card they typed in,
 * or a card bought on this phone (`keptCardId`) kept as credit.
 */
export interface OwnCardLike {
  id: string
  merchant: EscrowMerchantName
  balanceCents: number
  last4: string
  addedAt: number
  keptCardId?: string
}

/** The part of the till merge's CardStore this file reads and writes. Its CardStore is one as it is. */
export interface OwnCardBook {
  ownCards(): Promise<OwnCardLike[]>
  ownCardSecret(id: string): Promise<CardSecret | null>
  /** A typed card is sealed again from `secret`; a kept card needs none. */
  saveOwnCard(meta: OwnCardLike, secret: CardSecret | null): Promise<void>
}

/** /account's id for a card bought on this phone and kept as credit: the till merge's convention. */
export const keptOwnId = (cardId: string): string => `kept-${cardId}`

/** One card of store credit at one store, as the till uses it: /account's record, V2's, or both for one card. */
export interface TillCreditV2 {
  /** Stable for the card: what a plan names it by. */
  ref: string
  balanceCents: number
  since: number
  /** /account's record of it, when there is one. */
  ownId: string | null
  /** V2's record of it, when V2 made it the shopper's. */
  creditId: string | null
  /** card-store.ts's card it is, when bought on this phone. */
  cardId: string | null
}

/** What is listed for sale again from this phone, so is no longer anyone's credit here: by card, and by /account's own id. */
export interface ListedAgainV2 {
  /** card-store.ts cards: a V2 credit marked listed, or a listing made from the card. */
  cards: ReadonlySet<string>
  /** /account's ids of typed cards a listing was made from. */
  own: ReadonlySet<string>
}

/**
 * THE ONE RULE FOR "SOLD BACK", the till's and /account's alike: a card is
 * not store credit once a V2 credit of it says it is listed, or once a
 * listing in this phone's book was made from it. A listing is saved before
 * it is sent (sell-v2.ts listCardV2), so a sale whose answer never came back
 * (not confirmed, or our server not caught up) still takes the card off
 * both lists: the chain may be selling it.
 */
export function listedAgainV2(credits: readonly Pick<CreditRecordV2, 'cardId' | 'listedAs'>[], listings: readonly Pick<ListingRecordV2, 'fromCard' | 'fromOwn'>[]): ListedAgainV2 {
  return {
    cards: new Set([...credits.filter((c) => c.listedAs !== undefined).map((c) => c.cardId), ...listings.flatMap((l) => (l.fromCard === undefined ? [] : [l.fromCard]))]),
    own: new Set(listings.flatMap((l) => (l.fromOwn === undefined ? [] : [l.fromOwn]))),
  }
}

/** Is this card of /account's list listed again? */
export function ownListedAgain(o: Pick<OwnCardLike, 'id' | 'keptCardId'>, listed: ListedAgainV2): boolean {
  return listed.own.has(o.id) || (o.keptCardId !== undefined && listed.cards.has(o.keptCardId))
}

/**
 * The shopper's credit at one store, oldest first, used up or listed again
 * left out (listedAgainV2, /account's rule): /account's cards when `own` is
 * given (one entry per card, its balance /account's), then any V2 credit
 * /account does not have yet. Only `account`'s V2 credit: none at all when
 * nobody is signed in.
 */
export async function tillCreditV2(book: DeviceBookV2, merchant: EscrowMerchantName, own: OwnCardBook | null, account: Hex | null): Promise<TillCreditV2[]> {
  const [mineAll, credits, listings] = await Promise.all([creditsOfV2(book, account), book.credits(), book.listings()])
  const listed = listedAgainV2(credits, listings)
  const v2 = mineAll.filter((c) => c.merchant === merchant)
  const byCard = new Map(v2.map((c) => [c.cardId, c]))
  const out: TillCreditV2[] = []
  for (const o of own === null ? [] : await own.ownCards()) {
    if (o.merchant !== merchant) continue
    const mine = o.keptCardId === undefined ? undefined : byCard.get(o.keptCardId)
    if (mine !== undefined) byCard.delete(mine.cardId)
    if (o.balanceCents <= 0 || ownListedAgain(o, listed)) continue
    out.push({ ref: `own:${o.id}`, balanceCents: o.balanceCents, since: o.addedAt, ownId: o.id, creditId: mine?.id ?? null, cardId: o.keptCardId ?? null })
  }
  for (const c of byCard.values()) {
    if (c.balanceCents <= 0 || listed.cards.has(c.cardId)) continue
    out.push({ ref: `v2:${c.id}`, balanceCents: c.balanceCents, since: c.since, ownId: null, creditId: c.id, cardId: c.cardId })
  }
  return out.sort((a, b) => a.since - b.since)
}

/** Set what this phone believes is on a card of credit, in every record of it. */
export async function setTillCreditBalanceV2(book: DeviceBookV2, own: OwnCardBook | null, c: TillCreditV2, balanceCents: number): Promise<void> {
  if (!Number.isSafeInteger(balanceCents) || balanceCents < 0) throw new RangeError('a balance is whole cents, never below zero')
  if (c.ownId !== null && own !== null) {
    const rec = (await own.ownCards()).find((o) => o.id === c.ownId)
    if (rec !== undefined) {
      // A typed card's number is sealed in its own slot, so it is sealed again with the new balance.
      const secret = rec.keptCardId === undefined ? await own.ownCardSecret(rec.id) : null
      if (rec.keptCardId === undefined && secret === null) throw new RangeError('that card of credit no longer opens on this phone')
      await own.saveOwnCard({ ...rec, balanceCents }, secret)
    }
  }
  if (c.creditId !== null) {
    const v = await book.credit(c.creditId)
    if (v !== null) await book.saveCredit({ ...v, balanceCents })
  }
}

/** The card's number and PIN, for its code: /account's own box, or the bought card's. */
export async function openTillCreditV2(store: CardStore, own: OwnCardBook | null, c: TillCreditV2): Promise<CardSecret | null> {
  if (c.ownId !== null && own !== null) return own.ownCardSecret(c.ownId)
  return c.cardId === null ? null : store.cardSecret(c.cardId)
}

/** Put a card V2 made the shopper's into /account's list, pointing at the bought card: one list for both rails. */
export async function mirrorCreditToOwnV2(own: OwnCardBook | null, store: CardStore, c: CreditRecordV2): Promise<void> {
  if (own === null) return
  const card = (await store.cards()).find((x) => x.id === c.cardId)
  await own.saveOwnCard({ id: keptOwnId(c.cardId), merchant: c.merchant, balanceCents: c.balanceCents, last4: card?.last4 ?? '', addedAt: c.since, keptCardId: c.cardId }, null)
}

/**
 * Count a card this phone holds whole as store credit, with the balance the
 * shopper says is on it: a V1 card bought whole, whose leftover the till left
 * on it. Its purchase names its escrow and deposit, for the sale back, and
 * `account` is whose credit it is.
 */
export async function creditFromCardV2(book: DeviceBookV2, card: CardRecord, balanceCents: number, account: Hex): Promise<CreditRecordV2> {
  if (!Number.isSafeInteger(balanceCents) || balanceCents < 1 || balanceCents > card.valueCents) throw new RangeError('a balance between one cent and the card value')
  const credit: CreditRecordV2 = {
    id: card.id,
    merchant: card.merchant,
    cardId: card.id,
    balanceCents,
    source: 'bought_whole',
    escrow: lower(card.escrow),
    depositId: card.depositId,
    account: lower(account),
    since: Date.now(),
  }
  await book.saveCredit(credit)
  return credit
}

/**
 * Sell a credit card back on V2: once the purchase that made it the
 * shopper's is paid out, seal it again here and list it with the shopper as
 * its seller, for at most what this phone believes is on it.
 */
export async function sellBackV2(
  d: SellDepsV2 & { store: CardStore },
  creditId: string,
  input: { valueCents: number; priceCents: number },
): Promise<ListingRecordV2> {
  const c = await d.book.credit(creditId)
  if (c === null) throw new SellRefused('That card is not on this phone.')
  if (c.listedAs !== undefined) throw new SellRefused('That card is already listed.')
  if (input.valueCents > c.balanceCents) throw new SellRefused('List it for no more than what is left on it.')
  const block = await agreedFinalizedBlock(d.access.hosts)
  let paidOut: boolean
  if (lower(c.escrow) === d.config.escrow) {
    paidOut = (await depositV2At(d.access.hosts, block, d.config.escrow, BigInt(c.depositId))).state === V2_STATE.deposit.RELEASED
  } else if (d.config.v1Escrow !== null && lower(c.escrow) === d.config.v1Escrow) {
    paidOut = (await depositAt(d.access.hosts, block, d.config.v1Escrow, BigInt(c.depositId))).state === V1_RELEASED
  } else {
    throw new SellRefused('That card is from an escrow this page does not know.')
  }
  if (!paidOut) throw new SellRefused('You can sell this card once your purchase of it is final, a day after you bought it. Nothing was sent.')
  const secret = await d.store.cardSecret(c.cardId)
  if (secret === null) throw new SellRefused('This phone no longer has that card.')
  const listing = await listCardV2(
    d,
    { merchant: c.merchant, cardNumber: secret.cardNumber, pin: secret.pin, valueCents: input.valueCents, priceCents: input.priceCents },
    () => {},
    { fromCard: c.cardId },
  )
  c.listedAs = listing.listingId
  await d.book.saveCredit(c)
  return listing
}
