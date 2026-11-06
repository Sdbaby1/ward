# Ward

Counterparty check for AI agents that pay on NEAR.

An agent asks Ward before it sends funds or calls a contract. Ward answers **allow**, **warn**, or **block**, and it returns the reasons. **Block** never reaches the signer. **Warn** waits for a person. The agent signs with a function-call access key scoped to `pay` on one treasury. That key cannot move NEAR on its own.

Built for the [NEAR Hackathon](https://nearhackathon.com) track **AI Security & Defense** (`security`).

## Product

A full-access key lets a prompt-injected agent drain the account. A human click on every payment removes the reason to use an agent. Ward is the third mode.

- A receiver this agent has paid before, with a stable contract and no blocklist hits, is **allow**. The agent pays.
- A young account, a recent code change, a full-access key on a contract, or a single evidence-backed report is **warn**. A person decides.
- A missing account, a confirmed report, three independent reports, or an amount above the treasury cap is **block**. The wrapper does not sign.

The shared blocklist is the network effect. Any account can file a bonded report. The owner confirms or dismisses it. Three distinct reports block `pay` even before the owner acts. The HTTP API cannot confirm a report. Confirmation is an owner call on the contract, and the agent key cannot make that call.

The score is deterministic. Ward does not call a model to decide.

## Try it

Do this, then look for the lines below.

```powershell
cd C:\Users\user\ward
npm install
npm test
npm run demo
npm run build
npm start
```

Open http://localhost:8787 and press **Run the attack**.

You should see:

```text
result: PAYMENT STOPPED
signer.called: false
BLOCKLIST_CONFIRMED
Function-call key can only call treasury.ward.testnet, not known-bad.ward.testnet.
result: SIGNED AFTER HUMAN APPROVAL
result: SIGNED
```

`signer.called: false` means the injected payment never reached a signature. The merchant payment still signs. No NEAR account, API key, or database is required for this path. `DEMO_FIXTURES=true` is the default.

The known-bad account is a fixture. Its evidence string is synthetic. It is not a real victim transaction.

## What the demo does

The script in `src/demo/attack.ts` plays six scenes with one function-call key:

1. The injected prompt pays `known-bad.ward.testnet` through `treasury.pay`. The blocklist returns block. The signer is not called.
2. The same prompt tries to transfer NEAR directly to that address. The key can only call `treasury.ward.testnet`, so the wrapper throws before the check.
3. `young-shop.example.testnet` is two hours old. Ward warns. The human says no. Nothing is signed.
4. The same warning, and the human says yes. The wrapper signs.
5. `merchant.example.testnet` is old, active, and already paid by this agent. Ward allows. The wrapper signs.
6. `proxy.example.testnet` deployed code an hour ago. Ward warns. The human says no.

The attack amount is 1 NEAR. The treasury cap is 5 NEAR, so the stop reason is the blocklist, not the cap.

## Decisions

| Outcome | When |
| --- | --- |
| block | Confirmed report, missing account, first payment to an implicit account with no history, 3 or more distinct reports, or amount above the per-transaction max. Also any score of 70 or more. |
| warn | Account younger than 7 days, age unknown, code changed within 48 hours, zero transactions, a full-access key on a contract, an incomplete 100-key page, an attached deposit, one or two reports, or a score of 35 or more. |
| allow | None of the above. |

Weights live in `src/policy.ts`. A prior authorization subtracts 25. A first interaction adds 15 and does not warn by itself. Missing indexer data cannot produce an allow. If the RPC call fails, the wrapper does not sign.

## Data sources

| Signal | Source | How |
| --- | --- | --- |
| Account age | [NearBlocks](https://api.nearblocks.io) `GET /v1/account/{id}` | `account[0].created.block_timestamp`, nanoseconds since the Unix epoch. Verified live on `wrap.near`. |
| Activity | NearBlocks `GET /v1/account/{id}/txns/count` | `txns[0].count`. |
| Contract or not | NEAR RPC `query` `view_account` | `code_hash`. The empty hash is `11111111111111111111111111111111`. |
| Code changed | Two sources | Ward stores the last `code_hash` it saw. A difference is a change at the time of the check. NearBlocks `GET /v1/account/{id}/receipts` supplies `DEPLOY_CONTRACT` when that page contains one. RPC `EXPERIMENTAL_changes` is one block, so Ward does not use it as history. |
| Full-access keys | NEAR RPC `query` `view_access_key_list` | `limit` 100. A full page forces warn, because a later page could hide a full-access key. |
| Prior payments | Ward store | Rows in `interactions`, written only after a payment is authorized. A check alone does not count. |
| Shared blocklist | Ward contract `get_target`, plus the store | On-chain reports win on confirmation. The store is the cache and the demo source. |

NearBlocks has no API key on the public endpoint used here. If NearBlocks is down, age and activity become unknown and the decision warns or worse. It does not allow. If NEAR RPC is down, `getAccount` throws and the pay route returns stopped.

`NEAR_ARCHIVAL_RPC_URL` is reserved for a future block-pinned read. The running server does not call it.

## The agent key

The agent account holds one key. Create it with near-cli-rs. Do not give the agent a full-access key.

```text
near account add-key YOUR_AGENT.testnet grant-function-call-access --allowance '0.25 NEAR' --contract-account-id YOUR_TREASURY.testnet --function-names pay autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send
```

Replace `YOUR_AGENT.testnet` and `YOUR_TREASURY.testnet` with accounts you create. Ward does not invent an account id for you.

What that key can do:

- Call `pay` on `YOUR_TREASURY.testnet`.
- Spend the allowance on gas. `0.25 NEAR` is the recommended demo budget. The allowance is not the amount the merchant receives.

What that key cannot do:

- Attach NEAR. `pay` requires a deposit of 0. The treasury spends its own balance.
- Transfer NEAR, including a direct transfer to the injected address.
- Add, delete, or rotate keys.
- Deploy or change contract code.
- Delete the account.
- Call `withdraw`, `confirm`, `dismiss`, `block_receiver`, `report`, or `fund`.
- Call any other contract. `receiver_id` is one account.
- Call every method on the treasury. An empty `method_names` list means every method. Ward rejects that and requires exactly `["pay"]`.
- Keep working after the allowance hits zero. A function-call key's allowance cannot be raised. The owner adds a new key. Topping up the account balance does not refill the allowance. If this is the account's only key, a drained allowance locks the account.

The contract sees `predecessor_account_id`. It does not see which key signed. If the owner and the agent are the same account, a full-access key on that account can still call `withdraw`. Keep the owner key on a separate account. The method list is what keeps the agent key out of the owner methods.

`view_access_key_list` returns at most 100 keys per page (nearcore 2.14). Ward treats a full page as incomplete.

## Contract

One contract is the treasury and the blocklist. Source: `contracts/ward`.

| Method | Who | Effect |
| --- | --- | --- |
| `new` | deploy init | Sets owner, agent, max per transaction, daily limit, and minimum report bond. |
| `fund` | anyone, payable | Adds NEAR to the treasury balance. |
| `report` | anyone with a full-access key, payable | Bond at least 0.05 NEAR. Reason 8–280 characters. Evidence 32–500 characters starting with `tx:` or `https://`. |
| `confirm` | owner | Marks that report confirmed and blocks the receiver. |
| `block_receiver` | owner | Blocks a receiver without a report. |
| `dismiss` | owner | Refunds the bond and removes the report. It does not clear an owner block. |
| `pay` | agent only, deposit 0 | Sends NEAR from the treasury if the receiver is not blocked, the amount is within the per-transaction and daily limits, and the liquid balance covers it. |
| `withdraw` | owner | Sends liquid NEAR back to the owner. |
| `get_target` | view | Returns blocked, owner confirmation, and the reports. |
| `get_config` | view | Returns owner, agent, limits, and bonded total. |

Liquid balance is the account balance minus storage staking minus bonded report deposits. Bonds stay locked until dismiss. `pay` and the bonds share one account balance, and the bond reserve is not spendable.

A function-call key cannot attach the 0.05 NEAR bond, so reporters use a wallet or a full-access key. That is intentional. The agent must not be able to file or confirm reports about its own targets.

## Deploy

Install the CLI, then create two testnet accounts with the faucet. You choose the names.

```text
npm install -g near-cli-rs@latest
near account create-account sponsor-by-faucet-service YOUR_OWNER.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near account create-account sponsor-by-faucet-service YOUR_AGENT.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
```

The second command's exact faucet subcommand is `sponsor-by-faucet-service` followed by the new account id. If your installed CLI prompts instead of accepting this line, use the interactive `near` menu: Account, Create account, Sponsor by faucet service. Do not paste a private key into the repo or into Ward.

Build the wasm. This needs Rust and the `wasm32-unknown-unknown` target (`rust-toolchain.toml` requests both).

```text
cargo build --manifest-path contracts/ward/Cargo.toml --release --target wasm32-unknown-unknown
```

The artifact is `contracts/ward/target/wasm32-unknown-unknown/release/ward.wasm`. The copy built here on 6 Nov 2026 is `contracts/ward/ward.wasm` (345 KB). That copy is gitignored. On this machine, pass `contracts/ward/ward.wasm` to `use-file`.

On this Windows machine, `cargo` in PowerShell stops because `link.exe` is not installed. Ubuntu under WSL has gcc and cmake, and that is where the contract tests were run. Put the Cargo target directory on the Linux filesystem. A target directory on `/mnt/c` can fail with an I/O error while rustc writes dependency files.

```text
export CARGO_TARGET_DIR="$HOME/ward-target"
cargo test --manifest-path contracts/ward/Cargo.toml
cargo build --manifest-path contracts/ward/Cargo.toml --release --target wasm32-unknown-unknown
```

Deploy onto the owner account. The owner account is the contract account. Single quotes work in PowerShell and bash. Amounts are yoctoNEAR strings: 5 NEAR, 20 NEAR, and 0.05 NEAR.

```text
near contract deploy YOUR_OWNER.testnet use-file contracts/ward/target/wasm32-unknown-unknown/release/ward.wasm with-init-call new json-args '{"owner":"YOUR_OWNER.testnet","agent":"YOUR_AGENT.testnet","max_per_tx":"5000000000000000000000000","daily_limit":"20000000000000000000000000","min_bond":"50000000000000000000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

Add the agent key, fund the treasury from the owner, and read a target:

```text
near account add-key YOUR_AGENT.testnet grant-function-call-access --allowance '0.25 NEAR' --contract-account-id YOUR_OWNER.testnet --function-names pay autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send

near contract call-function as-transaction YOUR_OWNER.testnet fund json-args '{}' prepaid-gas '30 Tgas' attached-deposit '10 NEAR' sign-as YOUR_OWNER.testnet network-config testnet sign-with-keychain send

near contract call-function as-read-only YOUR_OWNER.testnet get_target json-args '{"target":"known-bad.ward.testnet"}' network-config testnet now
```

File a report from an account that can attach NEAR. Then confirm it as the owner.

```text
near contract call-function as-transaction YOUR_OWNER.testnet report json-args '{"target":"known-bad.ward.testnet","reason":"Prompt-injection payment stopped by Ward.","evidence":"tx:demo9f3c0a7b1e8d4c2a6b5f0e1d9c8a7b6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b"}' prepaid-gas '30 Tgas' attached-deposit '0.05 NEAR' sign-as YOUR_OWNER.testnet network-config testnet sign-with-keychain send

near contract call-function as-transaction YOUR_OWNER.testnet confirm json-args '{"reporter":"YOUR_OWNER.testnet","target":"known-bad.ward.testnet"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as YOUR_OWNER.testnet network-config testnet sign-with-keychain send
```

A guarded pay, signed by the agent, attaches 0 NEAR:

```text
near contract call-function as-transaction YOUR_OWNER.testnet pay json-args '{"receiver":"merchant.example.testnet","amount":"1000000000000000000000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as YOUR_AGENT.testnet network-config testnet sign-with-keychain send
```

Run that command only after Ward has returned allow, or warn plus a human approval. The HTTP `POST /api/v1/pay` route returns this command when it would sign. It does not hold a private key and it does not broadcast.

Point the server at the live contract by exporting variables yourself. Ward does not load a `.env` file.

```powershell
$env:DEMO_FIXTURES = "false"
$env:NEAR_RPC_URL = "https://rpc.testnet.near.org"
$env:NEAR_NETWORK = "testnet"
$env:WARD_CONTRACT_ID = "YOUR_OWNER.testnet"
$env:WARD_TREASURY_CONTRACT_ID = "YOUR_OWNER.testnet"
$env:WARD_AGENT_ACCOUNT_ID = "YOUR_AGENT.testnet"
$env:WARD_AGENT_PUBLIC_KEY = "ed25519:PASTE_THE_PUBLIC_KEY_ONLY"
npm start
```

Copy `.env.example` for the full list. Leave secrets out of git. `WARD_AGENT_PUBLIC_KEY` is a public key.

`WARD_DAILY_LIMIT_YOCTO` documents the value you pass to `new`. The contract enforces the daily limit. The HTTP server enforces the per-transaction max and the counterparty policy.

## Supabase

The default store is in memory. For a shared cache, paste `supabase/schema.sql` into the Supabase SQL editor and run it. The file enables row level security and revokes `anon` and `authenticated`. There are no policies for those roles. The server uses the service-role key, which bypasses row level security. Do not put that key in a `VITE_` or `NEXT_PUBLIC_` variable.

```powershell
$env:STORE = "supabase"
$env:SUPABASE_URL = "https://YOUR_PROJECT.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "YOUR_SERVICE_ROLE_KEY"
```

Tables: `observations`, `checks`, `interactions`, `reports`. The report primary key is `(reporter_account_id, target_account_id)`.

## HTTP

| Method | Path | Result |
| --- | --- | --- |
| GET | `/` | Dashboard. |
| GET | `/api/health` | Store kind, chain mode, network. |
| POST | `/api/v1/check` | `{ decision, score, reasons, signals }`. 503 when the chain is down. |
| GET | `/api/v1/checks?agent=` | Recent checks for that agent. |
| GET | `/api/v1/reports` | Recent cached reports. |
| POST | `/api/v1/reports` | Stores an unconfirmed report. `confirmed` is always false. Returns a near-cli line when a contract id is set. |
| POST | `/api/v1/pay` | Runs the wrapper. 200 signed, 409 human rejected, 403 stopped. |
| POST | `/api/v1/demo/attack` | Runs the six-scene demo on a fresh fixture world and returns the log. |

## Tests and CI

```text
npm test
npm run build
npm run demo
cargo test --manifest-path contracts/ward/Cargo.toml
cargo build --manifest-path contracts/ward/Cargo.toml --release --target wasm32-unknown-unknown
```

GitHub Actions (`.github/workflows/ci.yml`) runs the Node suite, the production build, the attack demo, the contract tests, and the wasm release build on Ubuntu.

## Hackathon notes

NEAR features used by name:

- Function-call access keys (`AddKey`, `FunctionCall` permission, finite allowance, one `receiver_id`, method name `pay`).
- JSON-RPC `query`: `view_account`, `view_access_key_list`, `call_function` on `get_target`.
- A NEAR contract for the treasury and the shared blocklist (`pay`, `report`, `confirm`, `dismiss`).

Judging can reproduce the local demo with the commands under [Try it](#try-it). A hosted demo is optional. The submission form, the public GitHub repo, the NEAR payout account, and the X post are done by a person. See the report that shipped with this project for the checklist. Deadline for the November 2026 round: 14 November 2026, 23:59 UTC.

Suggested tracks: `security`, `agents`, `business`.

## Layout

```text
src/policy.ts          score
src/guard.ts           function-call key gate and human prompt
src/chain.ts           NEAR RPC and NearBlocks
src/service.ts         one check
src/store.ts           memory and Supabase
src/app.ts             HTTP and dashboard
src/demo/attack.ts     prompt-injection demo
contracts/ward         treasury and blocklist
supabase/schema.sql    cache tables
web/                   dashboard
```

## License

MIT. Copyright 2026 Abdulrahman Adeosun.
