/**
 * /pay: the till's front door (unified-account spec 10.1 and 12). The store
 * this phone's till opened on last, else the stores, one tap each.
 *
 * ONE TILL, BOTH RAILS. The till at /pay/<store> pays by card or in dollars,
 * for only the value used, the way the account says. The Load screen that
 * lived here (a whole card bought in dollars before the till, on the first
 * escrow) is gone with that escrow's new sales. Cards a phone bought that way
 * are under Account, with their codes: /cards redirects there.
 *
 * /shop and /buy redirect here (next.config.ts).
 */

import { StoreChooser } from './store-chooser'

export default function PayPage() {
  return <StoreChooser />
}
