/**
 * /sell: list a gift card, and see what happened to it.
 *
 * The screen is sell-client.tsx. This file only reads, on the server and per
 * request, whether the escrow rail runs here (ESCROW_RAIL=testnet), so the
 * Salvo Pay choice is offered only where it works. Production does not set
 * the flag, and there the screen is exactly what it was.
 */

import { escrowRailOn } from '@/lib/escrow/rail'
import { SellClient } from './sell-client'

export const dynamic = 'force-dynamic'

export default function SellPage() {
  return <SellClient escrowRail={escrowRailOn()} />
}
