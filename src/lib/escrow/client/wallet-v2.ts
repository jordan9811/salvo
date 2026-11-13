/**
 * The device's access keys for SalvoEscrowV2 (unified spec section 8.4): what
 * the shopper's and the seller's silent keys may do on the new escrow.
 *
 * THE SAME ACCOUNT, NEW SCOPES. The passkey account is the one wallet.ts made
 * (the same address, the same Face ID); only the access key is new, because
 * its scopes are signed into its authorization and V2 is another contract
 * with another depositAndOpen. Setting it up is one Face ID (the passkey
 * signs the new key's limits) and no transaction: its first batch carries it,
 * as for V1. It takes the role's slot, so the till and /sell load it the way
 * they load today's key, and the V1 key it replaces simply expires.
 *
 * WHAT EACH KEY MAY DO, and the chain enforces every word of it:
 *   - shopper: pathUSD `approve` with SalvoEscrowV2 as the only spender, and
 *     on V2 `depositAndOpen`, `dispute`, `contestRemainder` ("that card was
 *     empty"), `reduceUse` (the total went down) and `keepRest` (keep the rest
 *     as your credit). The same weekly limit as V1: Tempo counts approve
 *     increases, and every deposit is approved with the price, so the limit
 *     caps what this device can put into the escrow, deposits included.
 *   - seller: `list` and `cancelListing` on V2, the cancel that is also the
 *     "I used it myself" mark on a leftover. No token call at all.
 *   - V1, while its sales settle: the seller's `cancelListing` (so a card
 *     listed on V1 can be taken back and listed on V2) and the shopper's
 *     `dispute`. Neither moves a cent.
 * Never in scope: `rekey`, `sellerRefund`, `sellerCloseRemainder`. They
 * always need the passkey, so script on the page cannot redirect a card,
 * refund a buyer or take a deposit without Face ID (DeviceWallet's
 * closeRemainderV2 is the passkey's own call for the last).
 *
 * Browser only by use; imports nothing Node-only. Never logs a key.
 */

import { getAbiItem, toFunctionSelector, type AbiFunction, type Hex } from 'viem'
import { Account as TempoAccount, WebCryptoP256 } from 'viem/tempo'
import { ESCROW_ABI } from '../artifact'
import { ESCROW_V2_ABI } from '../artifact-v2'
import { ESCROW_CHAIN_ID, PATH_USD } from '../manifest'
import type { AccessKeyRecord, CallScope, CardStore, KeyRestrictions, KeyRole } from './card-store'
import { ensurePasskey } from '@/lib/account/client/passkey'
import {
  ACCESS_KEY_LIFETIME_SECONDS,
  DeviceWallet,
  LIMIT_PERIOD_SECONDS,
  rootAccountOf,
  SHOPPER_WEEKLY_LIMIT_UNITS,
  type PasskeyOptions,
} from './wallet'

/** pathUSD `approve(address,uint256)`. */
const APPROVE_SELECTOR: Hex = '0x095ea7b3'

const lower = (a: string): Hex => a.toLowerCase() as Hex
const nowSeconds = (): number => Math.floor(Date.now() / 1000)

type V2Function = 'depositAndOpen' | 'dispute' | 'contestRemainder' | 'reduceUse' | 'keepRest' | 'list' | 'cancelListing'
const v2Selector = (name: V2Function): Hex => toFunctionSelector(getAbiItem({ abi: ESCROW_V2_ABI, name }) as AbiFunction)
const v1Selector = (name: 'dispute' | 'cancelListing'): Hex => toFunctionSelector(getAbiItem({ abi: ESCROW_ABI, name }) as AbiFunction)

/**
 * What a shopper's V2 key may do: approve only SalvoEscrowV2, and pay, open,
 * dispute, contest, reduce and keep only through it; V1's dispute while V1's
 * sales settle. At most `weeklyLimitUnits` of approvals a week, for 90 days.
 */
export function shopperKeyRestrictionsV2(
  escrow: Hex,
  now: number,
  weeklyLimitUnits: bigint = SHOPPER_WEEKLY_LIMIT_UNITS,
  v1Escrow: Hex | null = null,
): KeyRestrictions {
  if (weeklyLimitUnits <= 0n || weeklyLimitUnits > SHOPPER_WEEKLY_LIMIT_UNITS) throw new RangeError('the weekly limit is between $0.01 and $200')
  const e = lower(escrow)
  return {
    expiry: now + ACCESS_KEY_LIFETIME_SECONDS,
    limits: [{ token: PATH_USD, limit: weeklyLimitUnits, period: LIMIT_PERIOD_SECONDS }],
    scopes: [
      // Tempo's recipient rule on approve constrains its first argument, the spender.
      { address: PATH_USD, selector: APPROVE_SELECTOR, recipients: [e] },
      ...(['depositAndOpen', 'dispute', 'contestRemainder', 'reduceUse', 'keepRest'] as const).map((f) => ({ address: e, selector: v2Selector(f) })),
      ...(v1Escrow === null ? [] : [{ address: lower(v1Escrow), selector: v1Selector('dispute') }]),
    ],
  }
}

/** What a seller's V2 key may do: list and cancel on SalvoEscrowV2, and cancel on V1. No token is in scope. */
export function sellerKeyRestrictionsV2(escrow: Hex, now: number, v1Escrow: Hex | null = null): KeyRestrictions {
  const e = lower(escrow)
  return {
    expiry: now + ACCESS_KEY_LIFETIME_SECONDS,
    limits: [],
    scopes: [
      { address: e, selector: v2Selector('list') },
      { address: e, selector: v2Selector('cancelListing') },
      ...(v1Escrow === null ? [] : [{ address: lower(v1Escrow), selector: v1Selector('cancelListing') }]),
    ],
  }
}

/**
 * Was this key set up for SalvoEscrowV2 at `escrow`, for its role? A V1 key
 * cannot call V2 (another depositAndOpen, another address), so a page that
 * finds one asks for one Face ID to set up the V2 key.
 */
export function keyScopedForV2(wallet: Pick<DeviceWallet, 'role' | 'restrictions'>, escrow: Hex): boolean {
  const e = lower(escrow)
  const want = wallet.role === 'shopper' ? v2Selector('depositAndOpen') : v2Selector('list')
  return wallet.restrictions.scopes.some((s) => lower(s.address) === e && lower(s.selector) === want)
}

/**
 * The name the pending authorization is kept under, as wallet.ts keeps it:
 * DeviceWallet finds it there and viem attaches it to the key's first batch.
 * tests/escrow-v2-client.test.ts proves a V2 key's first batch carries it.
 */
const pendingName = (account: Hex, accessKey: Hex): string => `${ESCROW_CHAIN_ID}:${lower(account)}:${lower(accessKey)}`

/**
 * Set up `role` on this device for SalvoEscrowV2: the passkey if there is
 * none yet (one Face ID), a fresh non-extractable access key, and the
 * passkey's signature on its V2 restrictions (one Face ID). Nothing is sent:
 * the first batch carries it. The role's V1 key, if any, is replaced; it
 * simply expires.
 */
export async function setUpDeviceWalletV2(
  store: CardStore,
  role: KeyRole,
  opts: { escrow: Hex; v1Escrow?: Hex | null; weeklyLimitUnits?: bigint; now?: number; passkey?: PasskeyOptions },
): Promise<DeviceWallet> {
  const o = opts.passkey ?? {}
  const passkey = await ensurePasskey(store, o)
  const now = opts.now ?? nowSeconds()
  const v1 = opts.v1Escrow ?? null
  const restrictions = role === 'shopper' ? shopperKeyRestrictionsV2(opts.escrow, now, opts.weeklyLimitUnits, v1) : sellerKeyRestrictionsV2(opts.escrow, now, v1)
  const keyPair = await WebCryptoP256.createKeyPair({ extractable: false })
  const access = TempoAccount.fromWebCryptoP256(keyPair, { access: passkey.address })
  const root = rootAccountOf(passkey, o)
  const authorization = await root.signKeyAuthorization(access, {
    chainId: BigInt(ESCROW_CHAIN_ID),
    expiry: restrictions.expiry,
    ...(restrictions.limits.length > 0 ? { limits: restrictions.limits.map((l) => ({ ...l })) } : {}),
    scopes: restrictions.scopes.map((s: CallScope) => ({ address: s.address, selector: s.selector, ...(s.recipients ? { recipients: [...s.recipients] } : {}) })),
  })
  const record: AccessKeyRecord = {
    role,
    account: passkey.address,
    accessKeyAddress: lower(access.accessKeyAddress),
    keyPair,
    restrictions,
    createdAt: Date.now(),
  }
  await store.savePendingAuthorization(pendingName(passkey.address, record.accessKeyAddress), authorization)
  await store.saveAccessKey(record)
  return new DeviceWallet(store, record, passkey, o)
}
