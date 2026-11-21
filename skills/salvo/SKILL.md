---
name: salvo
description: Pay less at checkout by spending unused stored value through Salvo; discounted gift cards are the first kind. Use when a person asks an agent to buy something through Salvo or to try Salvo's agent checkout. Today this is a testnet preview with test money only, on Base Sepolia or Tempo Moderato. Only the test store salvotest checks out; no real store works yet.
---

# Salvo

Salvo lets an agent pay less at checkout by using unused stored value. Discounted gift cards are the first kind. The agent pays once into Salvo's order escrow. Salvo's checkout runs in a TEE (an Intel TDX enclave): it reserves gift cards that sellers listed and checks out with them. The escrow moves the money only on the checkout's signed result. With no result by the deadline and nothing committed, the buyer takes the money back with `reclaim`, with nothing needed from Salvo.

**State today:** testnet preview, test money only, on Tempo Moderato and Base Sepolia. Only the test store `salvotest` checks out. It is simulated and charges nobody. No real store works yet. Do not tell the person otherwise. Every order runs in Salvo's enclave, which is switched off between test runs: while it is off, `quote` and `order` answer `runner_off` and nothing is charged.

## Rules

- Run every command from this skill's folder (the folder holding this file): `node scripts/salvo.mjs <command> …`. Each command prints one JSON object. Read `ok`, `next`, and on failure `problem` and `message`.
- Every payment needs the person's approval in their wallet. Before asking, tell them the amount from `cost.pay` and what it buys. In key-file mode there is no approval step: the person approves by funding the key file, so agree the cart total with them before you run `order`, and never spend more than they said.
- If `ok` is false, stop and follow `next`. Never pay a quote whose `ok` is not true.
- Never print, paste or log a private key.

## Steps

1. Run `node scripts/salvo.mjs info`. Check that `storesThatCheckOut` lists the store, and that `ordersV3.usedOn` lists the network.
2. Get the buyer address from the wallet tool. It must be the address that will send or sign the payment.
3. Run `node scripts/salvo.mjs quote --merchant salvotest --cart <cents> --buyer <address>`. Add `--network tempo-moderato` for Tempo; Base Sepolia is the default. The answer says `"flow": "v3"`. From here on, pass `--quote <orderHash>` (printed as `orderHash`): a quote id may repeat, an order hash does not.
4. Read the output. If `ok` is false, stop. Otherwise read `verdict`, `cost` and `deadline`, and tell the person the amount.
5. Pay ONE of two ways, never both:
   - **A wallet tool that sends batched calls** (for example Base MCP `send_calls` with chain `base-sepolia`): send `pay.calls.calls` exactly as printed, in order, from the buyer address. When the wallet tool reports the confirmed transaction hash, run `node scripts/salvo.mjs opened --quote <orderHash> --tx <hash>`. Pass the transaction hash, not a request or batch id. Some wallet tools answer with a request id first (Base MCP does): the person approves in their wallet, then you poll the request's status (Base MCP `get_request_status`) until it is completed and read the transaction hash from it. Send the payment for a quote once. While it waits for approval, never send it again and never open a second order: tell the person it is waiting and keep polling until the quote's `deadline.payBy`. If it is still not approved by then, stop and say so. An order paid after `payBy` does not run: it is refunded, or the buyer reclaims it at the deadline.
   - **A wallet that signs EIP-712 typed data from a plain key** (Base only): sign `pay.typedData` exactly as printed (primaryType, types, domain, message). Then run `node scripts/salvo.mjs open --quote <orderHash> --signature <0x…>`. Salvo relays it and pays the gas.
   - A smart-contract wallet that has never sent a transaction on Base Sepolia must use `pay.calls`. The token cannot check a signature from a wallet that has no code on chain yet.
6. Run `node scripts/salvo.mjs start --quote <orderHash>`. It is safe to run again.
7. Tell the person the outcome in the words of `said`, as printed. If still running, run `status --quote <orderHash>` later.

## How the money moves

The agent pays once; the escrow holds the money until there is a signed result. What the agent pays is made of three parts, shown in the quote's `cost`: `toSellers` (the sellers' price for their cards, which cover `coveredByCards` at the store), `forRestOfCart`, and `salvoFee`. `forRestOfCart` is the part of the cart the cards do not cover: Salvo's own card pays the store for it at checkout, and the escrow repays Salvo after the hold. It is not a fee. When an order settles, `money` in the answer gives each amount on its own: `toSellers` (paid to the sellers for their cards, after the hold), `forRestOfCart` (paid to Salvo after the hold, to repay what its own card paid the store), `salvoFee`, and `refundedToYou`. Tell the person these separately; never add them up as what "Salvo kept".

Order confirmed: the sellers are paid after the store's return window. Checkout fails before the order is committed: all the money comes back (except in the own-checkout abandonment case below). Salvo's checkout fails after the order is committed and no card was used: the money comes back except Salvo's fee, which the escrow lets Salvo keep (at most `cost.salvoFee`). Your own checkout after a commit: Salvo keeps its fee only if a card was used (on Base, released); otherwise it keeps nothing. `said` says exactly how much came back and where the rest went. Whether the cards go back on sale is not something this script checks. No result by the deadline and the order was never committed: `reclaim` takes all the money back, with nothing needed from Salvo. If the order was committed, it cannot be reclaimed: Salvo has until the end of the commit grace (`deadline.rule` gives the time) to settle it, and after that `reclaim` settles it as the order planned (`lapse`): the sellers are paid for the cards used, and on Base an own-checkout card that was never released is refunded to you at lapse and its seller is not paid.

**The own-checkout rules, accepted before paying:** if an own-checkout order is abandoned after its sealed cards were handed over, with no receipt returned for any card, it is refunded less Salvo's margin, and this buyer address is refused quotes for 30 days. On Tempo a committed card is yours and is not refundable. `order` for an own-checkout store refuses (`rules_not_accepted`) and prints these rules until you pass `--accept-own-checkout-rules`; tell the person the rules and pass it only if they accept them.

What the script does:

- Each store's record decides how its orders run, and the script uses only store records it pins, whose own store name is the one you asked for. Where Salvo has a checkout (the test store), Salvo checks out and you get the store order. Where Salvo has none, the cards come to you, sealed to your own key, and you check out yourself (`kind: "cards"`, key-file mode only). The script never picks one because a machine is on or off.
- Before showing how to pay, the script checks the quote against the chain itself, through at least two independent hosts: the escrow's code and token, the signer (and that it has not moved to a new key: if it has, upgrade the skill), every card against the listing book, every amount recomputed, and the store record. `verdict` says so. If any check fails, `ok` is false and nothing can be paid.
- The commands: `quote`, then `open` (Base, after signing `pay.typedData`) or `opened` (after sending `pay.calls`), then `start` and `status`. Or `order --key-file` for everything in one go. From the quote on, use `--quote <orderHash>` (printed as `orderHash`): a quote id may repeat, an order hash does not.
- On Base, a signed authorization can still open its order until its `validBefore` time, whatever Salvo answered (a refusal included: Salvo still holds the signature). Until then `status` answers `not_yet_on_chain` rather than saying nothing opened; after it, the script reads the chain once more before saying so. A new `order` is refused while an earlier authorization from the same wallet is still live (`authorization_pending`); a new `quote` warns.
- Outcomes, in `outcome` and `said`: `confirmed` (order confirmed), `refunded` (checkout failed; `said` says what came back and any fee Salvo kept), `card_bad` (a card was bad: its seller is not paid for it and its part came back), `returned` (a return came back), `reclaimed`, and `lapsed` (Salvo gave no result in time after the commit, so it settled as planned). Every number is read from the chain, not from Salvo. If Salvo's result text did not match the chain, it is dropped and `said` says so. Tell the person `said` as printed.
- Your own checkout, before the order commits: Salvo hands over each reserved card still sealed; the script checks it against the listing book, keeps it with the order's state, and only then signs a receipt, which it also keeps. It sends the receipts again until Salvo confirms them, while the order is open, from `order` and `status`, or alone with `receipts --quote <orderHash>`. Receipts reach the enclave through Salvo's web server: if that server drops them all, no card is committed and the abandonment rule above applies. A card that is never handed over is left out and refunded; an order with none handed over is refunded in full, or you reclaim it at the deadline. An own-checkout quote whose commit grace is not exactly 6 hours is refused.
- Your own checkout: on Tempo a committed card is yours to open and is not refundable. On Base a committed card is yours once Salvo marks it released on chain; one it never releases is refunded to you at settlement or at lapse, and its seller is not paid. `order` keeps the cards in `cardsFile`, encrypted to a key derived from your key file and the order's salt: without that key file nobody can read the card numbers in it. `cards --quote <orderHash> --key-file <path>` opens every card that is yours (and adds any released since); a card not released yet is listed in `notReleasedYet`, so run it again later. Add `--reveal` to print the card numbers, only when you are about to use them.
- State and cards live in `~/.salvo-agent` (or `SALVO_AGENT_HOME`). The script refuses a folder inside OneDrive, Dropbox, Google Drive, iCloud or Box, and on Windows makes each file owner-only.
- `reclaim` works the same. If an order was committed and Salvo then gave no result within its commit grace, `reclaim` settles it as planned instead (`lapse`). Run it again and it reports the order's true state from the chain.

## Reclaim

If the order is not settled by `deadline.iso`, run `node scripts/salvo.mjs reclaim --quote <orderHash>`. It prints the call to send from the buyer address once `deadlinePassed` is true. It needs nothing from Salvo. Before the deadline, do not reclaim; run `status` instead. If the order was committed, `reclaim` settles it as planned instead (see above).

## No wallet tool: key-file mode

For an agent with no wallet tool, the script can hold a test key in a file.

- `node scripts/salvo.mjs wallet --key-file <path>` makes a new key if none is at that path and prints only its address and balance. Ask the person to fund that address with test money.
- `node scripts/salvo.mjs order --key-file <path> --merchant salvotest --cart <cents>` runs the whole order in one command: quote, every check, pay, start, and the check of the settlement. `checked` in the answer says the settlement was held to the chain.
- To see a decline and a full refund on the new escrow, use a cart whose total ends in 13 cents, for example `--cart 113` ($1.13): the test store declines every such cart (the answer says so in `testDecline`). `--fail` works only with `--old-flow`; on the new escrow it is refused.
- Test money alone is enough; the wallet needs no ETH. On Base the key signs one authorization and Salvo relays it and pays the gas. On Tempo the key sends two transactions and the fee is paid in the test money.
- The script checks the wallet holds the order's price before it signs. `not_enough_money` says what the wallet holds and what the order costs.
- `order` writes the same state file as `quote` (`stateFile`). If it stops after paying, run `status --quote <id>` later.
- `reclaim --quote <id> --key-file <path>` sends the reclaim itself after the deadline.
- Keep the key file outside any git repository; the script refuses one inside a repository. Use test keys only.

State files live in `~/.salvo-agent/orders/<quoteId>.json` (or `SALVO_AGENT_HOME`). They hold no key.

## The older escrow (`--old-flow`)

The escrow before the rebuild is still reachable with `--old-flow` on `quote` or `order`. A quote made either way keeps to its own escrow for `open`, `opened`, `start`, `status` and `reclaim`. On the older escrow Salvo buys the cards and runs the checkout; a failed order is refunded in full. It can run on Salvo's own server (the simulated runner) while the enclave is off.

### Its runner

Every quote says which runner runs the order (`runner`, `runnerWhy`, `runnerMeans`).

- `simulated`: Salvo's own web server runs the order. Acceptable for the test store only.
- `enclave`: the order runs in an Intel TDX enclave on Phala Cloud. The script checks the enclave's identity with its own fresh nonce before it shows how to pay. Pass on the `enclave.caveat` text to the person as printed. If `enclave.verdict` says NOT A PROOF, say so plainly.

`--runner auto` (the default) uses the enclave only where Salvo says it is on, this script pins its address, and the enclave answers; otherwise it uses `simulated` and says why in `runnerWhy`. The enclave is a machine that can be switched off between test runs, so `simulated` under auto is normal, not an error.


## Troubleshooting (by `problem`)

- `quote_does_not_hold`: a check failed. Do not pay. Tell the person what failed.
- `quote_refused`: Salvo gave no quote (for example the store has no checkout, or no card fits). Nothing was charged. "No whole card fits" means the store has no card that size listed right now: try another cart total (the test store usually has $1.00, $2.50 and $5.00), or try later.
- `runner_off`: the enclave is switched off or not answering (on the new escrow this is every quote while it is off; on the older escrow, only when you asked for `--runner enclave`). Nothing was charged. Try later; on the new escrow you can pass `--old-flow`, and on the older one leave `--runner` out.
- `enclave_unproven`: the enclave's identity did not check out. Do not pay.
- `not_testnet`: Salvo named a chain that is not a testnet. Stop.
- `not_deployed`: the order escrow is not on that network. Try the other network.
- `salvo_unreachable` or `chain_unreachable`: try again in a minute.
- `no_state` or `state_tampered`: get a fresh quote.
- `not_paid`: pay first, then `open` or `opened`.
- `not_opened`: the transaction did not open this order. Check the hash and the sender.
- `relay_refused` (older escrow): nothing was charged. Most often the buyer holds less than the amount, or the signature came from a different address than the quote's buyer. Check both, then get a fresh quote (key-file mode: run `order` again). With a wallet tool you can use `pay.calls` instead. On the new escrow a refused relay is not reported at once: the script watches the chain until the authorization expires, and only then says nothing was paid (`not_opened`).
- `relay_unclear`: do not sign again; run `status` in a minute.
- `settlement_mismatch`: Salvo and the chain disagree. Tell the person; keep the quote id.
- `too_early`: the deadline has not passed; run `status`.
- `not_enough_money`: key-file mode only. The wallet holds less than the order costs. Nothing was charged. Ask the person to fund the address.
- `key_file_refused` or `key_file_missing`: fix the key file path.
- `rules_not_accepted` (new escrow, own checkout): tell the person the printed rules; pass `--accept-own-checkout-rules` only if they accept them. Nothing was charged.
- `store_unavailable`, `authorization_pending`, `not_yet_on_chain`, `ambiguous_quote`, `synced_home`, `state_refused` (new escrow only): read `message` and follow `next`. Nothing was charged by the command that said it.
- `bad_args`: a flag or value is wrong, and the message says which. Run `node scripts/salvo.mjs --help`. A flag the script does not know is refused.
