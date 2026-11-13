/**
 * Title only.
 *
 * `sell/page.tsx` is a client component, and a client component cannot export
 * `metadata` — so without this file the tab said "Ticket Fulfillment" on every
 * screen of the gift-card product. A wrong tab title is the kind of detail that
 * reads as a site assembled out of parts rather than shipped as a product.
 */

import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Sell a card' }

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
