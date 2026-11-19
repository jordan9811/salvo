---
name: salvo
description: Pay less at checkout by spending unused stored value through Salvo; discounted gift cards are the first kind. Use when a person asks an agent to buy something through Salvo or to try Salvo's agent checkout. Today this is a testnet preview with test money only, on Base Sepolia or Tempo Moderato. Only the test store salvotest checks out; no real store works yet.
---

# Salvo

Salvo lets an agent pay less at checkout by using unused stored value. Discounted gift cards are the first kind. The agent pays once into an order escrow; Salvo buys the cards and runs the checkout. Money moves to Salvo only on a confirmed order. A failed order is refunded in full. With no result by the deadline, the buyer takes the money back with `reclaim`.

**State today:** testnet preview, test money only. Only the test store `salvotest` checks out. It is simulated and charges nobody. No real store works yet. Do not tell the person otherwise.

## Rules

- Run every command from this skill's folder (the folder holding this file): `node scripts/salvo.mjs <command> …`. Each command prints one JSON object. Read `ok`, `next`, and on failure `problem` and `message`.
- Every payment needs the person's approval in their wallet. Before asking, tell them the amount from `cost.pay` and what it buys. In key-file mode there is no approval step: the person approves by funding the key file, so agree the cart total with them before you run `order`, and never spend more than they said.
- If `ok` is false, stop and follow `next`. Never pay a quote whose `ok` is not true.
- Never print, paste or log a private key.

## Steps

1. Run `node scripts/salvo.mjs info`. Check that `storesThatCheckOut` lists the store.
2. Get the buyer address from the wallet tool. It must be the address that will send or sign the payment.
3. Run `node scripts/salvo.mjs quote --merchant salvotest --cart <cents> --buyer <address>`. Add `--network tempo-moderato` for Tempo; Base Sepolia is the default. A quote is always kind `checkout` (Salvo runs the checkout); there is no flag for it.
4. Read the output. If `ok` is false, stop. Otherwise read `verdict`, `cost`, `deadline` and `runnerMeans`, and tell the person the amount.
5. Pay ONE of two ways, never both:
   - **A wallet tool that sends batched calls** (for example Base MCP `send_calls` with chain `base-sepolia`): send `pay.calls.calls` exactly as printed, in order, from the buyer address. When the wallet tool reports the confirmed transaction hash, run `node scripts/salvo.mjs opened --quote <quoteId> --tx <hash>`. Pass the transaction hash, not a request or batch id. Some wallet tools answer with a request id first (Base MCP does): the person approves in their wallet, then you poll the request's status (Base MCP `get_request_status`) until it is completed and read the transaction hash from it. Send the payment for a quote once. While it waits for approval, never send it again and never open a second order: tell the person it is waiting and keep polling until the quote's `deadline.payBy`. If it is still not approved by then, stop and say so. An order paid after `payBy` does not run: it is refunded, or the buyer reclaims it at the deadline.
   - **A wallet that signs EIP-712 typed data from a plain key** (Base only): sign `pay.typedData` exactly as printed (primaryType, types, domain, message). Then run `node scripts/salvo.mjs open --quote <quoteId> --signature <0x…>`. Salvo relays it and pays the gas.
   - A smart-contract wallet that has never sent a transaction on Base Sepolia must use `pay.calls`. The token cannot check a signature from a wallet that has no code on chain yet.
6. Run `node scripts/salvo.mjs start --quote <quoteId>`. It waits up to 180 seconds (`--wait <seconds>`). It is safe to run again.
7. Tell the person the outcome in the words of `said`: fulfilled (with the store order number), refunded in full, or still running. If still running, run `status --quote <quoteId>` later.

## The runner

Every quote says which runner runs the order (`runner`, `runnerWhy`, `runnerMeans`).

- `simulated`: Salvo's own web server runs the order. Acceptable for the test store only.
- `enclave`: the order runs in an Intel TDX enclave on Phala Cloud. The script checks the enclave's identity with its own fresh nonce before it shows how to pay. Pass on the `enclave.caveat` text to the person as printed. If `enclave.verdict` says NOT A PROOF, say so plainly.

`--runner auto` (the default) uses the enclave only where Salvo says it is on, this script pins its address, and the enclave answers; otherwise it uses `simulated` and says why in `runnerWhy`. The enclave is a machine that can be switched off between test runs, so `simulated` under auto is normal, not an error.

## Reclaim

If the order is not settled by `deadline.iso`, run `node scripts/salvo.mjs reclaim --quote <quoteId>`. It prints the `reclaim(orderId)` call. Send it from the buyer address once `deadlinePassed` is true. It needs nothing from Salvo. Before the deadline, do not reclaim; run `status` instead.

## No wallet tool: key-file mode

For an agent with no wallet tool, the script can hold a test key in a file.

- `node scripts/salvo.mjs wallet --key-file <path>` makes a new key if none is at that path and prints only its address and balance. Ask the person to fund that address with test money.
- `node scripts/salvo.mjs order --key-file <path> --merchant salvotest --cart <cents>` runs the whole order in one command: quote, every check, pay, start, and the check of the settlement. `checked` in the answer says the settlement was held to the chain. Add `--fail` to make the test store decline, to see a full refund.
- Test money alone is enough; the wallet needs no ETH. On Base the key signs one authorization and Salvo relays it and pays the gas. On Tempo the key sends two transactions and the fee is paid in the test money.
- The script checks the wallet holds the order's price before it signs. `not_enough_money` says what the wallet holds and what the order costs.
- `order` writes the same state file as `quote` (`stateFile`). If it stops after paying, run `status --quote <id>` later.
- `reclaim --quote <id> --key-file <path>` sends the reclaim itself after the deadline.
- Keep the key file outside any git repository; the script refuses one inside a repository. Use test keys only.

State files live in `~/.salvo-agent/orders/<quoteId>.json` (or `SALVO_AGENT_HOME`). They hold no key.

## Troubleshooting (by `problem`)

- `quote_does_not_hold`: a check failed. Do not pay. Tell the person what failed.
- `quote_refused`: Salvo gave no quote (for example the store has no checkout, or no card fits). Nothing was charged. "No whole card fits" means the store has no card that size listed right now: try another cart total (the test store usually has $1.00, $2.50 and $5.00), or try later.
- `runner_off`: you asked for `--runner enclave` and the enclave is switched off or not answering. Nothing was charged. Leave `--runner` out, or try later.
- `enclave_unproven`: the enclave's identity did not check out. Do not pay.
- `not_testnet`: Salvo named a chain that is not a testnet. Stop.
- `not_deployed`: the order escrow is not on that network. Try the other network.
- `salvo_unreachable` or `chain_unreachable`: try again in a minute.
- `no_state` or `state_tampered`: get a fresh quote.
- `not_paid`: pay first, then `open` or `opened`.
- `not_opened`: the transaction did not open this order. Check the hash and the sender.
- `relay_refused`: nothing was charged. Most often the buyer holds less than the amount, or the signature came from a different address than the quote's buyer. Check both, then get a fresh quote (key-file mode: run `order` again). With a wallet tool you can use `pay.calls` instead.
- `relay_unclear`: do not sign again; run `status` in a minute.
- `settlement_mismatch`: Salvo and the chain disagree. Tell the person; keep the quote id.
- `too_early`: the deadline has not passed; run `status`.
- `not_enough_money`: key-file mode only. The wallet holds less than the order costs. Nothing was charged. Ask the person to fund the address.
- `key_file_refused` or `key_file_missing`: fix the key file path.
- `bad_args`: a flag or value is wrong, and the message says which. Run `node scripts/salvo.mjs --help`. A flag the script does not know is refused.
