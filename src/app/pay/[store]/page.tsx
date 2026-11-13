/**
 * /pay/[store]: the till for one store (unified-account spec 4 and 5). The
 * keypad is the first thing on screen.
 *
 * BESIDE /pay, NOT IN PLACE OF IT. /pay is still Salvo Pay on the dollars
 * rail, exactly as it was, until the second escrow contract lets dollars pay
 * at this till too (spec phase 3). A store name that is not one of ours is a
 * 404, so this route never answers for a path /pay might need later.
 *
 * THE STORE'S HOME SCREEN ICON STARTS HERE (spec 10.2). The page links the
 * store's own manifest, so "Add to Home Screen" from this page makes
 * "Salvo · Target", opening on this keypad. `capable: false` on purpose:
 * Next otherwise writes the tag that makes iOS open the icon as a separate
 * app, and the icon is meant to open in Safari (stores.ts says why).
 *
 * Rendered on the server only to name the store. Everything else is the
 * phone's: its settings, its card, its codes, by fetch.
 */

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { storeIconName, tillPath, tillStoreName, tillStoreOf } from '../stores'
import { TillClient } from './till-client'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ store: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const store = tillStoreOf((await params).store)
  if (store === null) return { title: 'Salvo Pay', robots: { index: false, follow: false } }
  const name = tillStoreName(store)
  return {
    // The root layout adds " · Salvo".
    title: `Pay at ${name}`,
    robots: { index: false, follow: false },
    manifest: `${tillPath(store)}/manifest.webmanifest`,
    appleWebApp: { capable: false, title: storeIconName(name) },
  }
}

export default async function TillPage({ params }: Props) {
  const store = tillStoreOf((await params).store)
  if (store === null) notFound()
  return <TillClient store={store} storeName={tillStoreName(store)} />
}
