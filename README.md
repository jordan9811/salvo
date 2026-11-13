# Salvo

A just-in-time clearing exchange for value stuck where its owner can't use it,
starting with gift cards. Nothing is bought until a buyer is paying: the
routing engine picks cards at the moment of purchase, the buyer pays only for
the value used, and the seller is paid from an on-chain escrow once the card
has worked.

The current direction is **Salvo as an endpoint agents call**: an agent asks
for a quote, pays per verified order in USDC over MPP on Tempo, and Salvo runs
the store's checkout with discounted gift card value, returning a verified
order or failing loudly with a refund.

> **This is a public excerpt of a private codebase.** It shows the escrow
> contracts, the routing engine, the till and the seller flow, with their
> tests. Store integrations, operations tooling and internal notes are not
> included, so it does not build or run on its own. Everything here runs on
> test networks and test money only.

## What's here

| Path | What it is |
|---|---|
| `contracts/SalvoEscrowV1.sol`, `SalvoEscrowV2.sol` | The escrow. No owner or admin key. V2 sells one card in parts: the buyer pays the discounted price only for the value used, and the leftover goes back on sale backed by the buyer's deposit |
| `src/lib/escrow/` | Everything around the escrow: EIP-712 terms and hashes, listings, the card number sealed with Lit and opened only for the buyer who paid, chain reads that require two independent hosts to agree on the same finalized block, the keeper's settlement rules, and the till's quote |
| `src/lib/route/`, `src/lib/demand/` | The routing engine: drain cards in order so only the last is partly used, respect a per-card leftover cap, and order the scans |
| `src/lib/till/` | The till: one account, two ways to pay (stablecoins through the escrow, or a card hold charged only for value used), timing and purchase flow |
| `src/app/pay/`, `src/app/sell/` | The buyer's till and the seller's listing screens (Next.js, React) |
| `tests/` | The tests for all of the above (Vitest), including the contracts run on an in-process chain |

## How a purchase works

1. A seller lists a card. Its number is sealed in the browser at listing.
2. A buyer types the register total and taps Pay.
3. Routing picks the cards. The buyer's payment goes into the escrow.
4. Lit sees the payment and opens the card number for that buyer only.
5. The store takes the card. The escrow pays the seller once it has worked.

## Stack

TypeScript (strict), Next.js 15, Solidity, viem, Lit Protocol, Tempo (MPP),
Base (x402), Prisma and Postgres, Vitest, Playwright.

## Status

Built and tested; deployed on Tempo's test network. Not reviewed, not on
mainnet, no real money.

---

Copyright Jordan Yeakley. All rights reserved. Shared for review; no licence
is granted to use, copy or modify this code.
