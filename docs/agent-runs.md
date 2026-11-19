# Agent endpoint runs (testnet)

Evidence that an agent can quote, pay and get an order run through Salvo's
endpoint on each supported testnet. Testnet money only. The runs dated
2026-11-18 and later check out at the simulated test store, which charges
nobody. Checkout at a real store is **not built** and is not part of any run
here.

## How network selection worked before this change

- **One network, chosen by the deployment.** The agent endpoint
  (`/api/agent`, `/quote`, `/buy`, `/confirm`, `/report`, `/purchase`) took
  payment on Tempo only, over MPP with `mppx`. No request could choose a
  network.
- **Tempo settings** live in `src/lib/mpp.ts`. `TEMPO_NETWORK` (`moderato` or
  `mainnet`) picks the chain id, RPC, explorer and fee sponsor.
  `TEMPO_CURRENCY` picks the token, `TEMPO_PRIVATE_KEY` or `TEMPO_PAY_TO` the
  payee, and `MPP_SECRET_KEY` signs the challenges. The agent routes refuse
  unless `TEMPO_NETWORK=moderato`. Agent orders carry rail `mpp`, and refunds
  go out with `refundTempo`.
- **x402 existed separately**, for the ticket shop only (`/api/x402/order`):
  USDC on Base, with `X402_NETWORK` set to `base-sepolia` (the default) or
  `base`. The facilitator verifies and then settles each payment, and refunds
  go out from `X402_PRIVATE_KEY`. It was switched off on the live deployment
  and locally (`X402_PAY_TO` empty).
- **The chain registry** (`src/lib/chains/`) lists Tempo only, and records an
  earlier decision that Base is "not something new gets built against". This
  change reverses that for the agent endpoint, as asked.

## What changed

The quote and buy calls take `network`: `tempo-moderato` (the default, so
existing callers are unchanged) or `base-sepolia`.

| Network | Rail | Chain id | Token | Settings |
|---|---|---|---|---|
| `tempo-moderato` | MPP via `mppx` | 42431 | pathUSD (`TEMPO_CURRENCY`) | `TEMPO_*`, `MPP_SECRET_KEY` |
| `base-sepolia` | x402, `exact` scheme | 84532 | USDC `0x036C…CF7e` | `X402_PAY_TO`, `X402_PRIVATE_KEY`, `X402_FACILITATOR_URL`, `BASE_SEPOLIA_RPC_URL` |

**Why x402 on Base Sepolia.** The rail already existed and worked. The payer
signs a USDC transfer authorization (EIP-3009), and the facilitator submits it
and pays the gas, so an agent needs only test USDC. The facilitator also
verifies the payment before it settles, so Salvo checks the quote still holds
before any money moves: a price change costs the agent nothing, where on
Tempo the payment settles first and is returned.

## Orders through Salvo's checkout, both chains, 2026-11-18

The agent sends its cart and pays once into the order escrow (`SalvoOrders`)
on its own chain. Salvo's runner buys whole cards on the card escrow from its
own float, checks out, and signs one result; the order escrow pays the runner
only on that result. The client is `src/lib/agent/orders/client.ts`
(`pnpm agent:order`). All runs below are against the live site
(salvoapp.xyz), with made-up cards listed under the Salvo test card store.
Test money on both chains.

| Chain | Order escrow | Deployed in |
|---|---|---|
| Tempo Moderato | `0x2c204a3f3bb26ea7214fd2ee0d91e2b82fec90ff` | [0x8368…8f10](https://explore.testnet.tempo.xyz/tx/0x83689955314d050140b6f4cc04c6d9ac95ec9f28435ab628d4f6e25f388b8f10) |
| Base Sepolia | `0x274535ee44ea2132a4fd41334756c5c6f0253ef4` | [0xce5a…61c5](https://sepolia.basescan.org/tx/0xce5acc43a24033490078f2997210ec5b015896f8d6d9c807b8f8b1d8a13361c5) |

On Tempo the agent sends approve and open itself. On Base it signs one
authorization and Salvo relays the open and pays the gas. "Run ms" is from
start to the settlement read back on chain.

**Tempo Moderato**

| Order | What | Paid in | Transactions | Quote ms | Pay ms | Run ms | Result |
|---|---|---|---|---|---|---|---|
| 1 | Checkout | $2.25 for a $2.50 cart | approve [0xa1b4…3b75](https://explore.testnet.tempo.xyz/tx/0xa1b4f7b1ca2b37a44076bd6c80ae401aae63ddc3b6513ba858bc1d5a623c3b75), open [0x28e2…5029](https://explore.testnet.tempo.xyz/tx/0x28e20ccae6de818a6b531b6006f408671faf7145f2bf9b3f84d9cf151abb5029), settle [0x0765…8f3a](https://explore.testnet.tempo.xyz/tx/0x076573fd008918c1cfe1cea75d4da97cfdc66eddd3086c3c269b91a70ebb8f3a) | 609 | 4,098 | 11,385 | Order placed at the simulated store (SIM-EE0F5E2ECB); the escrow paid the runner. |
| 2 | Checkout, store declines (test) | $1.35 for a $1.50 cart | approve [0x14ba…3da3](https://explore.testnet.tempo.xyz/tx/0x14bae21b6a66415e41a45d6c6c7d6edd143e50e89a9d92ca63be55c9a2cc3da3), open [0x191d…b06c](https://explore.testnet.tempo.xyz/tx/0x191d18ef8e3ea25efb8da2472cdf9f20ca5a8dd7bffe2e23cfcee857971bb06c), settle [0x8c6f…c75f](https://explore.testnet.tempo.xyz/tx/0x8c6fbd0dbbaad8cce926ddbd4acb876ab87caf33aa747b8f0a562824cb29c75f) | 672 | 4,322 | 3,694 | Refunded in full ($1.35). No card was bought. |
| 3 | Whole cards | $1.35 for a $1.50 cart | approve [0x5a2d…0bc4](https://explore.testnet.tempo.xyz/tx/0x5a2d6525a370fbfd7628d8843c9b8bc9f9ea3b9596c1bcb13781fb68f1c40bc4), open [0xc23b…7ee1](https://explore.testnet.tempo.xyz/tx/0xc23b49c8941f0c599d09d349ff8ca2563e8d1dc3b28a334ba6be38c68e5e7ee1), settle [0x1600…33bd](https://explore.testnet.tempo.xyz/tx/0x1600619d317d0d52d9c18e98f1dfaf34524d8e47b3637ae05f8b259e6ccf33bd) | 490 | 4,399 | 10,780 | 1 card opened with the agent's own key; the escrow paid the runner. |
| 4 | Paid, never started, short deadline | $0.90 for a $1.00 cart | approve [0x5e45…ba28](https://explore.testnet.tempo.xyz/tx/0x5e4596c5c08a6fc198c57223621cec4dfb390e5062a3b4edd11c4bb92590ba28), open [0x7832…2018](https://explore.testnet.tempo.xyz/tx/0x783273c4f925e7e376321e224964fca664138e3ab39e4080be63e63ddcdc2018), reclaim [0x50a1…8767](https://explore.testnet.tempo.xyz/tx/0x50a1a71872351138335c2caeacd5407668f38e7b0a39d72323858ef0fd088767) | 589 | 3,549 | 89,548 | The agent took its $0.90 back itself with `reclaim`. Salvo did nothing. |

**Base Sepolia**

| Order | What | Paid in | Transactions | Quote ms | Pay ms | Run ms | Result |
|---|---|---|---|---|---|---|---|
| 1 | Checkout | $2.70 for a $3.00 cart | open [0x07ac…f763](https://sepolia.basescan.org/tx/0x07acf461128858d275ceca28816d6d936052fd091ef29a8cdf9b00d6ccc1f763), settle [0xb859…8f13](https://sepolia.basescan.org/tx/0xb8598fd14442e74912f21434cce76aea19a103ecfa48bf229f2821e50f2b8f13) | 576 | 4,531 | 11,890 | Order placed at the simulated store (SIM-4DD0BEAAD3); the escrow paid the runner. |
| 2 | Checkout, store declines (test) | $1.35 for a $1.50 cart | open [0x6a7d…f909](https://sepolia.basescan.org/tx/0x6a7d58f8637c60b40b24fecaf85b4804cd6bfd67b8633b4657d772bd8e7ef909), settle [0x4d27…860a](https://sepolia.basescan.org/tx/0x4d272c4c5c0f8ef29b3149f94b2a4061481615044f84a76af352e31b3068860a) | 568 | 4,445 | 5,352 | Refunded in full ($1.35). No card was bought. |
| 3 | Whole cards | $0.90 for a $1.00 cart | open [0xa234…367b](https://sepolia.basescan.org/tx/0xa234dbfb6e2125c5c116893a21dceaaffc6f892194a07ca28089d81a3e2d367b), settle [0x7d13…b53f](https://sepolia.basescan.org/tx/0x7d13e4ac96e27c385de05167e6e8489611dab54629a8b470b4b96952bbb8b53f) | 592 | 4,637 | 12,628 | 1 card opened with the agent's own key; the escrow paid the runner. |
| 4 | Paid, never started, short deadline | $0.90 for a $1.00 cart | approve [0xa19c…fecd](https://sepolia.basescan.org/tx/0xa19cd267bb8d4428125d67ead690379efe72332fb4f134acaf1a82a25778fecd), open [0x121c…7023](https://sepolia.basescan.org/tx/0x121cd4b37603d6603a3acf01bdd1b126a4b71fcea9d4ece9459cc6f00d5a7023), reclaim [0x4040…3342](https://sepolia.basescan.org/tx/0x404095c8558367c9959b6a5639185b12c5b36060185af77184b8fa540f7e3342) | 592 | 4,359 | 87,681 | The agent took its $0.90 back itself with `reclaim`. Salvo did nothing. |

Every row was read back from the chain afterwards, apart from what the site
answered: each transaction succeeded, each order has its Opened event and one
Settled or Reclaimed event, and the token moved as the row says (agent to
escrow, then escrow to runner, or escrow back to the agent). Both order
escrows held $0.00 after the eight orders.

**Recovery by the cron alone (Base Sepolia, order 5).** An order was paid
([0xad24…38ea](https://sepolia.basescan.org/tx/0xad24292688bb66f5a9649be7a72592d7c11d8decc74f5fdc88653dd26b4838ea),
23:50 UTC) and then never started, with its normal 90-minute deadline. Nothing
touched it until too little time was left to run it (48 minutes). The next
15-minute cron run refunded the $0.90 in full
([0x3248…ab61](https://sepolia.basescan.org/tx/0x32485b00e0f40cc5cc971e9512206958dda7ec57f5d112b22969adf35fa3ab61),
00:46 UTC), 56 minutes after it was paid and 34 minutes before the agent
could have reclaimed it. One wart: that cron run's log line counted the order
as "still waiting", not "refunded", because the refund was sent but not yet
final when the line was written.

What these runs are not:

- **The checkout is the simulated test store's.** It charges nobody. No real
  store's checkout runs yet; Target's needs page captures Salvo does not have.
- **The runner is a simulated enclave**: Salvo's own server process. Every
  answer says `simulated: true`.
- **The declined checkout** is the test store's own switch. It refunds before
  any card is bought, so it does not show what happens to cards bought for a
  checkout that then fails: those stay with the runner, and nothing relists
  them yet.
- Redemption at a real store's checkout: **not yet reliable**.

## The enclave runner, 2026-11-19

The first orders run by the runner inside a real enclave: a Phala Cloud
machine (Intel TDX, dstack 0.6.4, `tdx.small`), app id
`0x57e1889572bf23e7198cd6814b62154981ef6036`, image
`sha256:d18de27101ac1c06c940da5d1847c7ad64d787b6f5190c2da714bdf618fec337`,
compose hash `0xb64557ce85f41d1694a29dd7e3d54d1c4a2434d8ce8f577cf57cc2b2e5676640`.
Site at commit `03b752f`. Before each payment the agent checked the enclave's
quote with its own nonce: DCAP-valid, not debug, TCB `UpToDate`. Test money
and the test store; each outcome is the agent's own check of the chain.

The enclave's own contracts and keys: Tempo Moderato `SalvoOrders`
`0x6fda8e153681581b278ac680d2d60144fa121a3f` (runner and payout
`0xf750a9a069aaa9c6c885ea51440f0a88dba0c35d`), Base Sepolia `SalvoOrders`
`0x5a02a2e56c82fb7dcccdeea42a6d35a83c474a58` (runner
`0x0e2f50233772167f53221c86d215d62d53728b49`, payout Salvo's existing Base
wallet).

| Network | Order | What | Result | Settle or reclaim transaction |
|---|---|---|---|---|
| Base Sepolia | 1 | checkout, $1.00 cart | fulfilled, `SIM-4DD0BEAAD3`, paid $0.90 | `0x4dad7ee4447a01ed982e0b8a077a8ca6f2f3b8e713268db7789c6ae9eefc7592` |
| Base Sepolia | 2 | cards, $1.00 | fulfilled, 1 card opened with the agent's own key | `0x483a13a3f25181b041231e6550692e91c930f5275f4eb43c765aeb782d16c39d` |
| Base Sepolia | 3 | checkout `--fail`, $2.50 cart | declined, $2.25 refunded in full | `0x36912c76734c5e0cdd6ce417d423758c176cfd542657da603bec22f8d4267942` |
| Base Sepolia | 4 | cards `--reclaim`, never started | the agent reclaimed $0.90 itself | `0xbe29afcce81819530d4089e71262bd3efdda9a1b51ebfe22db8f0ba40beb1637` |
| Base Sepolia | 5 | the skill, `order --key-file`, runner picked by `auto` | fulfilled, `SIM-B2F28B070D`, paid $0.90 | `0x140cecfb782c650a1315e5ebdcacb557e0012bddde101f1d7f6716da3d15d413` |
| Tempo Moderato | 1 | checkout, $1.00 cart | fulfilled, `SIM-EE0F5E2ECB`, paid $0.90 | `0xc83f8c26d899364ae534d9eb7c319caa5eb422d53ad7950c96e83e8f382448c7` |
| Tempo Moderato | 2 | cards, $1.00 | fulfilled, 1 card opened with the agent's own key | `0xb77ba1ba6644e6832274774129cf9ca884d265bdb5dada3a875decc295c1d51c` |
| Tempo Moderato | 3 | checkout `--fail`, $2.50 cart | declined, $2.25 refunded in full | `0x9286f7a7883d9d16ec1d8a043a5147f9c98ddf788ab305c29fa60b2f9025ed62` |
| Tempo Moderato | 4 | cards `--reclaim`, never started | the agent reclaimed $0.90 itself | `0x901f8f122b4e0b06a8d5ac58292a2a46c3aeee3401cd97c4b1e123260fa5a9e9` |

After those nine the machine was stopped and started again (`pnpm
enclave:power`). It came back with the same keys and proof, and ran a tenth:
Tempo Moderato order 5, checkout, fulfilled, settle
`0x6d4b8db8b98e7489d0ae9c4f168d119b7b8e7b798b788053c7794d4836553251`. While it
was off, the skill's default runner choice placed Base Sepolia order 11 on the
simulated runner instead (`SIM-C3E6389CE8`), and a quote that asked for the
enclave by name was refused with `runner_off`, nothing charged.

What these runs are not:

- Not a real store. The checkout inside the enclave is the simulated test
  store, which charges nobody. No real gift card and no real money moved.
- Not the full proof. Under Phala Cloud KMS the owner or Phala could run
  other code under the same app id and keys. The OS image values are the
  enclave's own first quote, not an independent verifier's.
- Not outside agents. The buyers were the repo's own test keys and the
  skill's key file.
- Not a crash test. No order was interrupted by a restart on hardware.

## The skill, 2026-11-19

Four live orders placed through the bundled skill script
(`skills/salvo/scripts/salvo.mjs`) against salvoapp.xyz at commit `72c2fdb`,
the first paid orders on the version that carries the enclave build. Test
money, the test store, the simulated runner. Each outcome is the script's own
check of the Settled event on chain.

| Network | Order | How it paid | Result | Settle transaction |
|---|---|---|---|---|
| Base Sepolia | 6 | one command, key file (`order --fail`) | declined, $4.50 refunded in full | `0xde096d82ebcd881474394249a13300038417acf68f87c2fe9ef35d0fde41e65d` |
| Base Sepolia | 7 | `quote`, signed `pay.typedData`, `open`, `start` | fulfilled, `SIM-37BF391E8C`, paid $4.50 for a $5.00 cart | `0x60041fa9e44e6b1c4cd92123c8bb0ecb3a2f23346d608ff07ceb80ea750dea5c` |
| Base Sepolia | 8 | `quote --fail`, sent `pay.calls` (approve, open), `opened`, `start` | declined, $0.90 refunded in full | `0xda2bca396f3621bd981ca31d9e8651d2a8e63e8d6a5b6921e816ec03c4ac5efb` |
| Tempo Moderato | 5 | one command, key file (`order`) | fulfilled, `SIM-BD969C30BE`, paid $0.90 for a $1.00 cart | `0x8189dc5a2b46f89658e2416f4f4c716479fc78e28ffd43f5c0199f91e04e03a1` |

What these runs are not:

- Not an outside agent. A small stand-in script signed and sent with the
  repo's own test key where a wallet tool would. No agent's wallet tool has
  driven the skill yet.
- Not a smart wallet. The calls were sent as two transactions from a plain
  key, not as one batch from a contract wallet.
- Not the enclave. Its pins are empty, so every order ran on the simulated
  runner and said so.

### A fresh agent with only the skill, 2026-11-19

A new agent that had read nothing but the installed `SKILL.md` ran the skill
against salvoapp.xyz. Same test money, test store and simulated runner.

| Network | Order | Who ran it, how it paid | Result | Settle transaction |
|---|---|---|---|---|
| Base Sepolia | 9 | the fresh agent, `order --key-file` (the skill's own wallet, `0x7286…dfef`) | fulfilled, `SIM-4CC9AD5936`, paid $0.90 for a $1.00 cart | `0x7748faa1803cae7b91b6a4674a7aa3d5418fa3ff2f30a3958e88c6260f5f03ad` |
| Base Sepolia | 10 | the repo's session, `order --key-file --fail`, after the fixes below | declined, $0.90 refunded in full | `0x0ea2b453c23eec1afad7dfd1ba2479b63d537f71766c04b9140eb4f94af9a679` |

What the fresh agent tripped on, each fixed the same day:

- The test store had no $1.00 card listed, so its first quote was refused.
  The store was restocked by hand. Nothing restocks it automatically.
- A flag the script did not know passed in silence. It is refused now.
- Nothing said how long a wallet approval may wait, and `status` told it to
  pay again while its first payment still waited. The quote now prints
  `deadline.payBy`, and the instructions say never to pay a quote twice.
- An order the wallet could not afford failed as `relay_refused` with no
  reason. The script now checks the balance first (`not_enough_money`).
- A key-file order wrote no state file and did not say its settlement was
  checked. It now writes one and says so.

Still not done: the wallet-tool route with a real wallet. The fresh agent got
a correct quote and sent the two `pay.calls` as one batch request from a
smart wallet through Base MCP (`send_calls`), but the request was never
approved, so no order was opened that way.

## The direct path since 2026-11-18: the card escrow

Agents now buy through SalvoEscrowV2, the same card escrow the till uses. The agent's
wallet pays the escrow contract, and each card comes back from the escrow
template sealed to a key the agent made a moment before. Salvo never sees
a card or holds the money. The client is `src/lib/agent/escrow-agent.ts`
(`pnpm agent:escrow buy`). The runs further down are the old path, where
cards sat in Salvo's database and agents paid Salvo's wallet; it is off
(`AGENT_CUSTODIAL_BUY`, default off).

### Escrow, live site (salvoapp.xyz), Tempo Moderato, 2026-11-18

Made-up $1.00 cards listed under the Salvo test card store by a test seller
wallet, each bought for $0.90. "Transactions" are the agent's own: approve,
then depositAndOpen, both to the escrow contract
`0xa30d1631bf644fa608dacc02b6d2aebbc1cd200b`. "Buy ms" runs from sending the
first transaction to the card open.

| Run | Quote | Transactions | Quote ms | Buy ms | Result |
|---|---|---|---|---|---|
| first | $0.90 for $1.00 | [0x4ff9…c1c3](https://explore.testnet.tempo.xyz/tx/0x4ff97f639b3d5ecba9a470495953d1109c81c85aba76a0b9e751767905f9c1c3), [0xda47…c00c](https://explore.testnet.tempo.xyz/tx/0xda47f3e1fcc52b7c2c06c38d2a97df70b171f094a3a428d8c1bcf18b503ac00c) | 537 | 4,368 | Paid the escrow ($0.90 from the agent to the contract, read back on chain); card opened with the agent's key |
| 1 | $0.90 for $1.00 | [0x34bd…c3e0](https://explore.testnet.tempo.xyz/tx/0x34bdee0c55bddefcf6cc83fadc314e8a9ef9abd745cc5b8716b9cd8f9cc1c3e0), [0x30e9…2b9](https://explore.testnet.tempo.xyz/tx/0x30e987b67c3d914eff3aa9dfcf95c489566f60e322fb66f4b429e8026d4cd2b9) | 341 | 5,218 | Paid the escrow; card opened with the agent's key |
| 2 | $0.90 for $1.00 | [0x6da4…a35d](https://explore.testnet.tempo.xyz/tx/0x6da4590c1ab4f4b87913e5213228e9a9200459fa9f934f1cafd4daec219ba35d), [0x39c3…85e7](https://explore.testnet.tempo.xyz/tx/0x39c315c6dfe32d537eccce864d2ca0503480c4f18e21b1c101a20612271785e7) | 370 | 5,527 | Paid the escrow; card opened with the agent's key |
| 3 | $0.90 for $1.00 | [0x5920…3141](https://explore.testnet.tempo.xyz/tx/0x592089d5425684971128af3c45b03c2e43a6dcb759184f14f3ff1c9f23c63141), [0x2aba…d6dc](https://explore.testnet.tempo.xyz/tx/0x2abab671f6aa630e63ca9bb6c373188533cafe846d3b1d13abdb1bd3a691d6dc) | 366 | 3,760 | Paid the escrow; card opened with the agent's key |

What is not there yet: Base Sepolia (the escrow contract is on Tempo
only), and stores beyond the five the escrow template was sealed with
(Target, Best Buy, Nike, Walmart, and the test store). Redemption at a
store's checkout: **not yet reliable**.

## Runs on the old path (off since 2026-11-18)

`scripts/agent-run.ts` plays the agent: it quotes, pays the 402 from its own
throwaway testnet wallet, then confirms. **Confirm** means the payment: the
transaction is read back from the chain (it succeeded, and moved the quoted
amount of the quoted token out of the agent's wallet), and the purchase is
fetched again with its token. The cards are not applied at a store. Checkout
redemption is **not yet reliable**.

Setup for every run: a local production build of the `multichain-endpoint`
branch on port 3100, with the web service's own settings and the database's
test schema. Made-up $2.00 Target cards are listed at $1.80. Each run buys one
for a $2.34 cart.

- **Quote ms:** the quote call, end to end.
- **Confirm ms:** from sending the payment until the receipt is readable on
  chain, including Salvo settling it and handing the card over.

### Tempo Moderato, 2026-11-17

| Run | Quote | Transaction | Quote ms | Confirm ms | Result |
|---|---|---|---|---|---|
| 1 | $1.80 for $2.00 | [0x710c…608b](https://explore.testnet.tempo.xyz/tx/0x710c44c9b219d26cbf182c343abe9c8f2225c943c079e29c111c8e5144c2608b) | 128 | 8,530 | Paid; payment confirmed on chain; 1 card delivered |
| 2 | $1.80 for $2.00 | [0x1dd6…f5c6](https://explore.testnet.tempo.xyz/tx/0x1dd6175479dc780e245ee082cdc1b9d164a28fadf93716ab0a87f890bf51f5c6) | 103 | 4,542 | Paid; payment confirmed on chain; 1 card delivered |
| 3 | $1.80 for $2.00 | [0x3fd7…7bd9](https://explore.testnet.tempo.xyz/tx/0x3fd7297a96b68248aa35f75995fc397dc77f2ab824840b5562ac3b14d7dc7bd9) | 95 | 3,808 | Paid; payment confirmed on chain; 1 card delivered |

Before these, one debugging payment of $1.80 went through the same path
(it is not counted above). Several earlier attempts failed or stalled before
paying anything: the local launcher had handed the server Railway's port for
its own links, so the agent was sent to the wrong address. Fixed in
`scripts/agent-run-env.mjs`.

### Base Sepolia, 2026-11-18

| Run | Quote | Transaction | Quote ms | Confirm ms | Result |
|---|---|---|---|---|---|
| 1 | $1.80 for $2.00 | [0x1f37…60de](https://sepolia.basescan.org/tx/0x1f378be247494fbfea3074012d3f2d58e4e96b2483bd10b2f5f63af6e3dd60de) | 133 | 7,600 | Paid; payment confirmed on chain; 1 card delivered |
| 2 | $1.80 for $2.00 | [0x53f9…08db](https://sepolia.basescan.org/tx/0x53f94693b1eb7cd84f1c3d9d6d6d1ecf89dd8d54634f2ca1e7d1548f01ef08db) | 116 | 4,581 | Paid; payment confirmed on chain; 1 card delivered |
| 3 | $1.80 for $2.00 | [0x8c58…1fb4](https://sepolia.basescan.org/tx/0x8c58337e1ee7ccc22119d7c3261ef69af16d80ca26f8f4d554de2fd08b6f1fb4) | 101 | 4,560 | Paid; payment confirmed on chain; 1 card delivered |

Each transaction was also read back by hand: it succeeded, and its one USDC
transfer moved $1.80 from the agent to Salvo's x402 wallet. The agent's
balance went from $20.00 to $14.60.

The day before, a probe was refused before any money moved: the x402.org
facilitator verified the signed authorization and answered
`invalid_exact_evm_insufficient_balance`, because the agent's wallet held no
test USDC yet.

### Live site (salvoapp.xyz), 2026-11-18

The same script against the deployed site, buying made-up cards listed under
the Salvo test card store (`salvotest`, which no real store is). Test money on
both chains.

**Base Sepolia**

| Run | Quote | Transaction | Quote ms | Confirm ms | Result |
|---|---|---|---|---|---|
| 1 | $1.80 for $2.00 | [0xb805…ded9](https://sepolia.basescan.org/tx/0xb805553c6752dc873947cfd8af43b605c0c5d6a7f736a00abcffb8688046ded9) | 339 | 2,356 | Paid; payment confirmed on chain; 1 card delivered |
| 2 | $1.80 for $2.00 | [0x35c0…3629](https://sepolia.basescan.org/tx/0x35c0e43a247f48fda5f70862e754c1369a7cf5663ef93ac1fff3a9fb56fb3629) | 104 | 1,061 | Paid; payment confirmed on chain; 1 card delivered |
| 3 | $1.80 for $2.00 | [0xcb92…8577](https://sepolia.basescan.org/tx/0xcb926d2db3535b919aa28e85e95932d75f3e4699a4483d6559e54d8c85ee8577) | 106 | 1,043 | Paid; payment confirmed on chain; 1 card delivered |

**Tempo Moderato, first try**

| Run | Quote | Transaction | Quote ms | Confirm ms | Result |
|---|---|---|---|---|---|
| 1 | $1.80 for $2.00 | [0x76f9…67ba](https://explore.testnet.tempo.xyz/tx/0x76f9b798763a7858a1dca41c132321aee3c6a2b01db9ee6868a6c735026667ba) | 209 | none | **Failed.** Paid, then refused: Salvo's check of the payment hit Tempo's public RPC while it answered with a bot-wall web page, and the payment library gave up after about a second. Recorded and returned by hand ([0x71a2…19c6](https://explore.testnet.tempo.xyz/tx/0x71a242c009d36e4c1ec58719f7ec9489cd60ae915833fe1c19fddd10c01c19c6)). |
| 2 | $1.80 for $2.00 | [0x2b69…94](https://explore.testnet.tempo.xyz/tx/0x2b6956b0a3ee6459841a668f4e7560755be541712028964aa0b38df2a4f19a94) | 105 | 1,625 | Paid; payment confirmed on chain; 1 card delivered |
| 3 | $1.80 for $2.00 | [0x54d7…6f](https://explore.testnet.tempo.xyz/tx/0x54d76feeb72d6a9d9adccf1d4f2e563da6eea7d1dcb0323416984a0bc30dc76f) | 100 | 1,397 | Paid; payment confirmed on chain; 1 card delivered |

The fix: the payment check now retries the RPC five times over about fifteen
seconds (`src/lib/mpp.ts`).

Redemption at a store's checkout: **not yet reliable**. Not part of these runs.
