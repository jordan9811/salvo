/**
 * The order escrow's pins, per network (orders-spec section 3): which
 * SalvoOrders this build trusts, the code it must have, the token it holds,
 * whose signature settles it and where the runner's share goes.
 *
 * THE ADDRESSES ARE FILLED after `pnpm orders:deploy`, and checked with
 * `pnpm orders:check --live`. Until an address is set, every order route
 * answers 503 `orders_not_deployed` for that network (ordersNotReady).
 *
 * THE CODE HASH IS FIXED TEXT, not computed here. token, runner and payout are
 * immutables, written into the deployed code, so one hash pins the contract
 * and all three together (artifact.ts ordersRuntimeKeccak). Written out, a
 * recompile that changed the contract no longer matches the pin, and
 * tests/agent-orders-core.test.ts says so, instead of the pin quietly following
 * whatever was compiled last.
 *
 * TESTNET ONLY. Runner and payout are the server's two existing keys' accounts:
 * TEMPO_PRIVATE_KEY on Tempo Moderato, X402_PRIVATE_KEY on Base Sepolia. No new
 * secret. Mainnet is not a network here at all.
 */

import type { Hex } from 'viem'
import { ORDER_CHAIN_IDS, type OrderNetwork } from './terms'

export interface OrdersPin {
  network: OrderNetwork
  /** What a person reads: "Tempo Moderato". */
  name: string
  chainId: number
  /** The SalvoOrders address, lower case. Null until the lead deploys it. */
  orders: Hex | null
  /** keccak256 of its runtime code: ordersRuntimeKeccak({ token, runner, payout }). */
  codeHash: Hex
  /** The token orders are paid in, 6 decimals, taken 1:1 as US dollars. */
  token: Hex
  /** The token's own EIP-712 domain, for EIP-3009 authorizations. Null where the token has none we use. */
  tokenDomain: { name: string; version: string } | null
  /** Whose signature settles an order. */
  runner: Hex
  /** Where the runner's share of a settled order goes. */
  payout: Hex
  /** How an agent pays: two plain transactions, or one signed authorization Salvo relays. */
  pay: 'approve-open' | 'authorization'
}

const TEMPO_RUNNER: Hex = '0x69f3d4de1b16bdd76610d577592b45bd44bb502d'
const BASE_RUNNER: Hex = '0x30201522adf8ffb29b3fea0f7927a628a48d4329'

export const ORDERS_PINS: Readonly<Record<OrderNetwork, OrdersPin>> = Object.freeze({
  'tempo-moderato': {
    network: 'tempo-moderato',
    name: 'Tempo Moderato',
    chainId: ORDER_CHAIN_IDS['tempo-moderato'],
    orders: '0x2c204a3f3bb26ea7214fd2ee0d91e2b82fec90ff',
    codeHash: '0xc8c74ae80190100c3b46eeb8cbfb3528fe89744fbed34caac4fefe35bcfafa90',
    // pathUSD: fees on Tempo are paid in it too.
    token: '0x20c0000000000000000000000000000000000000',
    tokenDomain: null,
    runner: TEMPO_RUNNER,
    payout: TEMPO_RUNNER,
    pay: 'approve-open',
  },
  'base-sepolia': {
    network: 'base-sepolia',
    name: 'Base Sepolia',
    chainId: ORDER_CHAIN_IDS['base-sepolia'],
    orders: '0x274535ee44ea2132a4fd41334756c5c6f0253ef4',
    codeHash: '0x2f64e51e348729b44961d31f65959c4918a7f3525682dcad2046060a9aecf6c8',
    // Circle's USDC on Base Sepolia (x402.ts USDC['base-sepolia']).
    token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    tokenDomain: { name: 'USDC', version: '2' },
    runner: BASE_RUNNER,
    payout: BASE_RUNNER,
    pay: 'authorization',
  },
})

/** A network's pin, with its contract address in hand. */
export type DeployedOrdersPin = OrdersPin & { orders: Hex }

/**
 * Why orders cannot run on this network from these pins, in a sentence an
 * agent can read; null when they can. Only the pins: whether the server holds
 * the runner's key, and whether the rail is on testnet, are chain.ts's and
 * sign.ts's to say, since they read the environment.
 */
export function ordersNotReady(network: OrderNetwork, pins: Readonly<Record<OrderNetwork, OrdersPin>> = ORDERS_PINS): string | null {
  const p = pins[network]
  if (p.orders === null) return `The order escrow is not deployed on ${p.name} yet. Nothing was charged.`
  if (!/^0x[0-9a-f]{40}$/.test(p.orders)) return `The order escrow's address on ${p.name} is not pinned correctly. Nothing was charged.`
  return null
}

/** The pin for a network whose contract is deployed; throws the reason it is not. */
export function deployedPin(network: OrderNetwork, pins: Readonly<Record<OrderNetwork, OrdersPin>> = ORDERS_PINS): DeployedOrdersPin {
  const why = ordersNotReady(network, pins)
  if (why !== null) throw new OrdersNotDeployedError(why)
  return pins[network] as DeployedOrdersPin
}

/** The 503 `orders_not_deployed` every order route answers for a network whose pin is empty. */
export class OrdersNotDeployedError extends Error {
  readonly code = 'orders_not_deployed'
  constructor(sentence: string) {
    super(sentence)
    this.name = 'OrdersNotDeployedError'
  }
}
