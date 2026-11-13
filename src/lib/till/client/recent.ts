/**
 * The till's purchases on this phone, for 48 hours (unified-account spec 4,
 * "Something went wrong?").
 *
 * ===========================================================================
 * WHY THE PHONE KEEPS THEM. A purchase is a handle the server signed and
 * nothing else groups (purchase.ts): no table, no migration. While it lived
 * only in the till page's memory, a reload or a closed tab lost the one way
 * to report a card, and Account had nothing to show. So each one is kept in
 * the device store as it changes, and Account lists the ones still inside
 * the 48 hours the handle acts for. Older ones are dropped when Account reads
 * them and whenever a till opens.
 *
 * NEVER A CODE. What is kept is the handle, the cards and what it came to.
 * The code a card showed is a gift card number, and the store drops it
 * before anything is written (card-store.ts saveTillPurchase).
 *
 * AND THE PAY STILL GOING THROUGH. Before Pay is sent, its key is kept, so a
 * page closed or reloaded before the answer came back can ask the server
 * what that tap did, with the same key, and never pay twice.
 * ===========================================================================
 *
 * Browser only by use; pure of React. Tests pass a fake IndexedDB.
 */

import type { Hex } from 'viem'
import type { CardStore, PendingTillPay, TillPurchaseRecord } from '@/lib/escrow/client/card-store'
import type { DeviceBookV2 } from '@/lib/escrow/client/records-v2'

/** As long as the purchase handle acts: "Tell us within 48 hours". */
const RECENT_PURCHASE_MS = 48 * 3600_000

/** Keep this purchase as it stands now. Never throws: a phone that keeps nothing still pays. */
export async function keepTillPurchase(store: CardStore | null, r: TillPurchaseRecord): Promise<void> {
  if (store === null) return
  try {
    await store.saveTillPurchase(r)
  } catch {
    // A private window, or a full disk: the till still works, only Account cannot reopen it.
  }
}

/** The purchases still inside their 48 hours, newest first. The rest are forgotten. */
export async function recentTillPurchases(store: CardStore, now: number = Date.now()): Promise<TillPurchaseRecord[]> {
  const all = await store.tillPurchases()
  const fresh: TillPurchaseRecord[] = []
  for (const r of all) {
    if (now - r.createdAt < RECENT_PURCHASE_MS) fresh.push(r)
    else await store.deleteTillPurchase(r.id).catch(() => undefined)
  }
  return fresh
}

/**
 * The purchases Account lists for whoever is signed in, inside their 48
 * hours. One kept across a sign-out (card-store.ts forgetAccount: a dollars
 * purchase, marked) is listed only for the account whose V2 purchase it is,
 * so a browser signed in as someone else never shows them the first
 * person's, and the first person, signed in again, can still report a card.
 */
export async function recentTillPurchasesOf(
  store: CardStore,
  book: Pick<DeviceBookV2, 'purchase'> | null,
  account: Hex | null,
  now: number = Date.now(),
): Promise<TillPurchaseRecord[]> {
  const out: TillPurchaseRecord[] = []
  for (const r of await recentTillPurchases(store, now)) {
    if (r.signedOut !== true) {
      out.push(r)
      continue
    }
    if (book === null || account === null) continue
    const p = await book.purchase(r.purchase.ref).catch(() => null)
    if (p !== null && p.depositor.toLowerCase() === account.toLowerCase()) out.push(r)
  }
  return out
}

/** Keep the Pay about to be sent. Never throws. */
export async function keepPendingPay(store: CardStore | null, r: PendingTillPay): Promise<void> {
  if (store === null) return
  try {
    await store.savePendingTillPay(r)
  } catch {
    // Kept nowhere: a closed page then cannot ask what this tap did, and that is all.
  }
}

/** The Pay at this store is answered, whatever the answer: nothing is left to ask about. Never throws. */
export async function endPendingPay(store: CardStore | null, storeId: string): Promise<void> {
  if (store === null) return
  await store.deletePendingTillPay(storeId).catch(() => undefined)
}

/**
 * Every Pay this phone sent and never heard back from, one per store, still
 * young enough for its purchase handle to act. Older ones are forgotten.
 */
export async function unfinishedPays(store: CardStore, now: number = Date.now()): Promise<PendingTillPay[]> {
  const fresh: PendingTillPay[] = []
  for (const p of await store.pendingTillPays()) {
    if (now - p.at < RECENT_PURCHASE_MS) fresh.push(p)
    else await endPendingPay(store, p.store)
  }
  return fresh
}

/** The Pay at this store this phone never heard back from, or null. */
export async function unfinishedPay(store: CardStore, storeId: string, now: number = Date.now()): Promise<PendingTillPay | null> {
  return (await unfinishedPays(store, now)).find((p) => p.store === storeId) ?? null
}
