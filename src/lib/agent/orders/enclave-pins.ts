/**
 * The enclave runner's order escrow pins (enclave-spec section 6, "Added").
 * This file is compiled into the enclave image, so it is measured: changing a
 * value here changes the compose hash.
 *
 * FILLED 2026-11-19 (runbook step 7). The runners are the enclave's own keys,
 * read from a DCAP-valid TDX quote (deploy/enclave-inspect.json), and the two
 * contracts were deployed for them the same day. `codeHash` is
 * `ordersRuntimeKeccak` of each one's token, runner and payout; a test holds
 * every value here to the inspect file and to that hash. An empty pin (no
 * contract, zero runner) still refuses to run: `ordersNotReady`.
 *
 * Base payout (lead's answer to Q1): at deploy time it is Salvo's existing Base
 * wallet, the simulated Base runner's address in pins.ts. No new key.
 *
 * TESTNET ONLY, like pins.ts. Mainnet is not a network here at all.
 */

import type { Hex } from 'viem'
import type { OrdersPin } from './pins'
import { ORDER_CHAIN_IDS, type OrderNetwork } from './terms'

export const ENCLAVE_ORDERS_PINS: Readonly<Record<OrderNetwork, OrdersPin>> = Object.freeze({
  'tempo-moderato': {
    network: 'tempo-moderato',
    name: 'Tempo Moderato',
    chainId: ORDER_CHAIN_IDS['tempo-moderato'],
    orders: '0x6fda8e153681581b278ac680d2d60144fa121a3f',
    codeHash: '0xe74e8a32f5aad9001946a164ba9542a86c8e75a9145450b8527d80343ed15c03',
    // pathUSD, as in pins.ts: the same token, a different contract.
    token: '0x20c0000000000000000000000000000000000000',
    tokenDomain: null,
    // The enclave's own Tempo key (deploy/enclave-inspect.json). It fronts the card money, so it is paid back.
    runner: '0xf750a9a069aaa9c6c885ea51440f0a88dba0c35d',
    payout: '0xf750a9a069aaa9c6c885ea51440f0a88dba0c35d',
    pay: 'approve-open',
  },
  'base-sepolia': {
    network: 'base-sepolia',
    name: 'Base Sepolia',
    chainId: ORDER_CHAIN_IDS['base-sepolia'],
    orders: '0x5a02a2e56c82fb7dcccdeea42a6d35a83c474a58',
    codeHash: '0xb4ef0f8a96112f2599a97757587fe192da22797478fc3c227cd70e4ab217c6a9',
    // Circle's USDC on Base Sepolia, as in pins.ts.
    token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    tokenDomain: { name: 'USDC', version: '2' },
    // The enclave's own Base key (deploy/enclave-inspect.json); the payout is Salvo's existing Base wallet (Q1).
    runner: '0x0e2f50233772167f53221c86d215d62d53728b49',
    payout: '0x30201522adf8ffb29b3fea0f7927a628a48d4329',
    pay: 'authorization',
  },
})

/**
 * The Base Sepolia RPC the enclave reads and sends through. Compiled in, not
 * read from the environment, because the environment is not measured.
 */
export const ENCLAVE_BASE_RPC_URL = 'https://sepolia.base.org'

/**
 * The pins with no contract and a zero runner, payout and code hash: what they
 * were before the runbook. A runner outside the image (a simulator, fake keys)
 * runs on these, because fake keys can never match the real runners: it serves
 * health and identity and can run no order.
 */
export function emptyEnclaveOrdersPins(): Record<OrderNetwork, OrdersPin> {
  const zero: Hex = '0x0000000000000000000000000000000000000000'
  const zeroHash: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000'
  const empty = (p: OrdersPin): OrdersPin => ({ ...p, orders: null, codeHash: zeroHash, runner: zero, payout: zero })
  return { 'tempo-moderato': empty(ENCLAVE_ORDERS_PINS['tempo-moderato']), 'base-sepolia': empty(ENCLAVE_ORDERS_PINS['base-sepolia']) }
}

/** True when a pinned address is the zero address (an empty pin). */
export function isZeroAddress(a: Hex): boolean {
  return /^0x0{40}$/i.test(a)
}
