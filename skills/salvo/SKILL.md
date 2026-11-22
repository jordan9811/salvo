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

## Session orders (the test store only)

Some stores take gift cards only inside the buyer's own signed-in store account. For those, Salvo checkout runs in the person's store account: the agent pays once into the escrow as usual, then hands Salvo's TEE the person's signed-in store session (the store's cookies) for this one order. The TEE enters the cards in that account and places the order. Salvo's server only relays the session sealed to the TEE and cannot read it.

**State today:** available at the simulated test store `salvotest` only, on the testnets, with test money. No real store has session orders: `session-quote` for any other store is refused (`no_session_path`) and nothing is charged. Never offer a session order at a real store.

A whole test run on Tempo Moderato with the skill's own key-file wallet, in order:

1. `node scripts/salvo.mjs session-test-account --merchant salvotest --network tempo-moderato` (prints `accountId` and `sessionFile`)
2. `node scripts/salvo.mjs session-quote --key-file <path> --merchant salvotest --cart 5000 --cart-json '{"items":[{"sku":"TEST-1","qty":50}]}' --network tempo-moderato` (prints `orderHash`, `cost`, `sessionNotice`; tell the person the amount and `sessionNotice` and get their approval)
3. `node scripts/salvo.mjs session-pay --quote <orderHash> --key-file <path>` (pays, then asks the TEE for the order’s hand-over key: `handoverKey`)
4. After the person's explicit yes: `node scripts/salvo.mjs session-handover --quote <orderHash> --session-file <sessionFile> --account-id <accountId> --accept-session-notice`
5. `node scripts/salvo.mjs status --quote <orderHash>` until it is settled; tell the person `said` as printed
6. `node scripts/salvo.mjs session-record --quote <orderHash>` (optional: the run record)

The steps below say what each one does.

**Tell the person before they pay, and again before the hand-over,** the lines `session-quote` prints in `sessionNotice`, word for word. In short: the TEE acts in their whole store account for the minutes of this one order; a handed-over session stays valid after the order, and many stores do not end a copied session on sign-out; they should use a separate browser profile that holds only this store's sign-in; cards entered in their store account count as used at the balance the store reports, and are charged even if the order is not placed; there are no returns through Salvo. Two lines always, in these words:

- Stores sometimes ask "is it you", or show a code or a bot check. The TEE never acts on one, never solves it and never works around it. Before the first card is entered, such a check ends the order and you are refunded in full; after a card is entered, it ends the order, and the cards entered are yours and paid for.
- Salvo's fee is charged only when the order is placed at the store. If no order is placed, you pay only for the cards entered into your account, at the balance the store reported for each, and the rest is refunded. A card the store said it did not take is not charged. If Salvo cannot tell whether the store took a card, it checks the card's balance at the store, and charges you for the part of its value that has left the card; where the store's balance cannot be read, the card counts as used. The one exception: if Salvo never settles the order at all, the escrow's own `lapse` pays it as planned, fee included, after the order's grace period.

**Keep the state folder private.** `session-quote` draws this order's one-time key (which signs the hand-over) and keeps it in the order's state file in `~/.salvo-agent` (or `SALVO_AGENT_HOME`), readable only by its owner, and it stays there after the hand-over; it is never printed. Tell the person to keep that folder as private as their browser's sign-ins. If the folder is lost before the hand-over, no hand-over can be signed and the order is refunded in full at its hand-over cutoff. If it is lost after the TEE accepted the session, nothing about the money changes: the order runs and settles from its marks on chain; only the order's run record can no longer be opened.

**Hand over a store session only after the person's explicit yes** to that notice. `session-handover` refuses without `--accept-session-notice` (`session_notice_not_accepted`). Never ask for, send or paste a store password or a one-time code: a session order needs neither.

**The test store's session.** The simulated test store `salvotest` has no real sign-in page, so for a test run the TEE makes a fresh test account there: `node scripts/salvo.mjs session-test-account --merchant salvotest --network tempo-moderato`. It writes that account's session to an owner-only file and prints only `sessionFile` (its path) and `accountId`; never paste the file anywhere. The account holds no money and opens nothing outside the TEE; it is forgotten after 2 hours or when the TEE restarts. Only the test store has this: there is no such command for a real store.

The commands, in order:

1. `node scripts/salvo.mjs session-quote --buyer <address> --merchant salvotest --cart <cents> --cart-json '{"items":[{"sku":"TEST-1","qty":<cents / 100>}]}' --network tempo-moderato` (the test store's TEST-1 costs $1.00, so the cart's items add up to `--cart`). `--buyer` is the wallet that will pay; in key-file mode pass `--key-file <path>` instead and the key file's wallet is the buyer. Read `verdict`, `cost`, `deadline`, `handoverCutoff`, `sessionNotice` and `stateFolder`. From here on pass `--quote <orderHash>`.
2. Tell the person the amount and `sessionNotice`, and get their approval. Pay once, at once: in key-file mode `session-pay --quote <orderHash> --key-file <path>` (the only command that needs a key file); with a wallet tool send `pay.calls` and run `opened`, or sign `pay.typedData` and run `open`, as for any quote. Each of the three, right after the chain shows the order paid, asks Salvo’s TEE for this order’s hand-over key (`handoverKey: "issued"`): from then on the TEE knows the order is paid and refunds it in full at its hand-over cutoff if no session is handed over. If `handoverKey` is `"not_issued"`, the payment still went through: tell the person `refundAtCutoff` as printed and follow `next` (run `session-handover` before the cutoff, which asks again, or run `session-pay` again). The TEE also reads payments from the chain on its own, so it normally still refunds the order at the cutoff; if that refund does not come, the money comes back by `reclaim` after the deadline.
3. After the person's explicit yes: `session-handover --quote <orderHash> --session-file <file> --account-id <id> --accept-session-notice`. No key file: the order's one-time key is in its state file. `--session-file` is the browser's storage state saved as a file (Playwright's `storageState` format), or for the test store the file `session-test-account` wrote. `--account-id` is the store account's identifier exactly as the store shows it on its account page (its own masking included), read from the page the person sees; for the test store, the `accountId` `session-test-account` printed. A wrong identifier fails the TEE's own check of the account: the order ends before anything is reserved and is refunded in full, and, except at the test store, it counts against the buyer's limit on session orders that could not run. The script fetches the TEE's identity for this order straight from the TEE and checks it, takes from the file only the cookies of the store's own domains that identity names, seals them to the TEE, and sends them through Salvo's relay. It waits while the TEE writes its acceptance on chain (up to `--wait` seconds, default 960), asks again with the same bytes, and seals again if the TEE's key for the order ran out. The file is never copied into state, output or logs.
4. `status --quote <orderHash>` until it is settled. A session order has no `start`: the TEE runs it once it accepts the session. Until it settles, `said` tells where it is: paid and waiting for the hand-over until `handoverCutoff` (refunded in full by the TEE then, or reclaimable after the deadline), handed over and running, or committed; tell it as printed. With no session accepted by `handoverCutoff`, the order is refunded in full; after the deadline `reclaim` works as for any order.
5. Offer the person a sign-out in the browser the session came from (`signOut` says why).
6. Once settled, `status` says in `runRecord` whether the order's run record is available. `session-record --quote <orderHash>` prints it: the pages the TEE opened in the store account (host and path only), each action by the element it used, what the store answered for each card, and the store's order number. The script accepts it only if it matches the settlement on chain, opens with the order's own record key from its state file, and is signed by the TEE signer the order names. A missing record changes nothing about the money.

Outcomes, in `outcome` and `said`: `confirmed` (the store order was placed), `refunded`, `card_bad`, `reclaimed`, `entered_not_placed` (cards were entered in the person's store account and count as used, but no order was placed at the store), and `placement_unknown` (cards were entered, and Salvo could not confirm whether the store placed an order: the person checks the orders in their store account). `lapsed` on a session order means Salvo never settled it and the escrow's own rule did: every committed card paid to its seller as planned and Salvo's planned share paid, placed or not; `said` gives the amounts. If `said` starts with WARNING (`salvoShareBreach`), Salvo's signed settlement took a share although its result does not say the order was placed: tell the person first, word for word, and keep the order id. Never tell `entered_not_placed` or `placement_unknown` as a purchase, and never tell `placement_unknown` as "no order was placed": tell `said` as printed, which says whether an order was placed, which cards are now in their store account and their balance there, what was charged, and what was refunded.

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
- `no_test_store`: that store has no test account; only `salvotest` does.
- `session_orders_not_available` (session orders): Salvo’s TEE takes no store sessions now. Nothing was charged and nothing was handed over.
- `no_session_order`: this machine keeps no session order for that order hash (no state file for it in this state folder). It says nothing about money: if that order was paid elsewhere, the TEE refunds it at its hand-over cutoff once it was asked for its key, or it can be reclaimed after its deadline. Check the hash and `SALVO_AGENT_HOME`.
- `session_notice_not_accepted`: tell the person `sessionNotice`; pass `--accept-session-notice` only after their explicit yes.
- `bad_session_file`: the session file is not a storage-state file. Nothing was handed over.
- `handover_refused`: a check of the TEE's identity or the session failed, or the TEE refused it. Nothing was handed over. Tell the person what failed.
- `session_failed`: the TEE could not finish taking the session in time; the order is refunded in full.
- `handover_cutoff`: the order passed its hand-over cutoff; it is refunded in full.
- `handover_not_answered`: the TEE did not answer within `--wait`; run `session-handover` again before the cutoff.
- `run_record_refused`: the run record Salvo's server sent did not match the settlement on chain, did not open with the order's key, or was not signed by its TEE signer. The money is as `status` says. Tell the person.
- `payment_failed`: the wallet stopped a pay step; `walletError` names why in one word (insufficient_funds, nonce, gas, rejected, would_revert, network, unknown) and `next` says whether an approval was left standing (it is harmless: only the buyer itself can use it, through open). Nothing was charged.
- `reservations_full`: nothing was charged. Salvo’s daily limit on new card reservations is reached; try again after the time `message` names.
- `bad_args`: a flag or value is wrong, and the message says which. Run `node scripts/salvo.mjs --help`. A flag the script does not know is refused.
