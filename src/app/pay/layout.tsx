/**
 * Title only, as the other product screens have. /pay is the till's store
 * chooser; each store's till names itself (pay/[store]/page.tsx).
 */

import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Pay less at the register' }

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
