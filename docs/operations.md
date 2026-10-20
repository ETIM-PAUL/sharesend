# Running ShareSend

## The agent's identity (ERC-8004)

ShareSend registers itself with the BNB Agent SDK (`@bnbagent/sdk`) in the canonical ERC-8004 Identity Registry. MegaFuel sponsors the gas.

| Network | Registry | Agent |
|---|---|---|
| BSC testnet (rehearsal) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | #2584 ([token](https://testnet.bscscan.com/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/2584), [tx](https://testnet.bscscan.com/tx/0x66cb11ebd9d76c278c84d5d6618e9276c63afd92fd0db7a6478b77e302c20a01)) |
| BSC mainnet | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | **#370811** ([token](https://bscscan.com/nft/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/370811), [tx](https://bscscan.com/tx/0xa5d28e4f6935ea5ae4ad1f97df02be8553ba5af736d239dd1bb50b8bf9c0b7f5)), registered Oct 10 2026 |

- **Owner:** a dedicated identity key (`IDENTITY_ADDRESS`). It holds no funds and is not the vault key.
- **Payment address:** the profile's `payTo` metadata points at the gift vault, which is where B402 fees land.
- **Profile endpoints:** the web app, `/agent/status`, and the x402 gift endpoint.

```
npm run cli -- identity preview
npm run cli -- identity register --network bsc-mainnet --confirm
npm run cli -- identity show
```

## Autonomous jobs

The jobs run on the agent service. Each run is recorded in `job_runs` and shown on `/agent`.

| Job | Every | What it does |
|---|---|---|
| expire-unpaid | 1 min | Closes unpaid gifts once their price hold ends. A gift mid-settlement is never touched. |
| expiry-returns | 10 min | When a claim window ends, sends the stock back to the sender. |
| resume-payouts | 2 min | Finishes claims and refunds that were interrupted. |
| price-watch | 1 min | Checks the live price for orders waiting on a price drop; buys at the trigger, refunds at the deadline. Needs no `baw`. |
| buy-queue | 1 min | Buys stock for paid gifts, one at a time. Needs `baw`. |
| reconcile | 15 min | Checks vault holdings against what unclaimed gifts are owed. Alerts if short. |
| keepalive | `KEEPALIVE_MINUTES` | Checks the Agentic Wallet session. Alerts on sign-out and 12 hours before it ends. Records whether the check extended the inactivity timer. |

### Why not on BNB Agent Studio

The plan asked for one job on the Agent Studio runtime, if the runtime could support it. As of Oct 10 2026, the Studio docs (overview, CLI reference) describe request-driven seller agents only:
- They run on AWS AgentCore or Azure Foundry, and serve A2A, MCP or x402 requests.
- No schedule, cron or periodic-task feature is documented.
- The managed testnet trial is listed as "coming".

Our jobs also need the gift ledger (Postgres) and the vault key, and both stay on the agent service. So the jobs run there, and the on-chain identity points at their live output (`/agent/status`). This is the fallback the plan allows for.

## Agentic Wallet sessions

Sessions currently last 48 hours (`maxSigninDuration`), so signing in again needs the Binance Wallet app. On the hosted service:

```
npm run cli -- admin signin https://sharesend-agent-production.up.railway.app
```

The command prints a link and a pairing code. Open the link, check the code matches in the app, and confirm. Two settings keep the session across redeploys:
- A Railway volume mounted at `/root/.baw` (where the session file lives).
- `BINANCE_INSTANCE_ID` set to a constant (`openssl rand -hex 16`, kept private, never changed). The CLI encrypts its session with a key derived from the machine's MAC address, which changes on every container deploy; this variable replaces it. Sign in again after setting it.

Sign-in schedule through judging (48-hour sessions): **Oct 11** (before the submission lock), 13, 15, 17, 19, 21 and 23. If the app allows a longer `maxSigninDuration`, raising it means fewer sign-ins. While signed out, paid gifts wait as "queued" in the vault. Claims, returns, refunds and reconciliation keep working.

## Other admin commands

```
npm run cli -- admin status  <SERVER_URL>
npm run cli -- admin run-job <SERVER_URL> reconcile
```

`ADMIN_TOKEN` must be set both in `.env` and on the server.

## When a gift comes back: stock or USDT

Each gift has a `return_as` setting, chosen by the sender:
- **stock** (default): the stock goes back to the sender's wallet as the same token.
- **usdt**: the agent sells it and sends USDT to the sender.

**It happens automatically.** When a claim window ends, the `expiry-returns` job returns the gift using the saved choice. The sender can set it when creating the gift and change it any time before the return starts (one wallet signature on the gift page). When cancelling a ready gift, the sender picks stock or USDT for that cancel.

**USDT path:** vault → Agentic Wallet (stock) → `baw` sell → proceeds sent to the vault → vault pays the sender exactly what arrived. Every step is recorded before it happens and resumes where it stopped.

**It can never leave a gift stuck:**
- Before anything moves, if the wallet is signed out or no sell quote is available (market closed), it waits and retries. After 24 hours (`RETURN_WAIT_MS`) it returns the stock instead.
- If the sale is refused or fails after the stock reached the Agentic Wallet, the stock is sent back to the vault and returned to the sender.
- The two sell quotes (`baw` and the Trading API) must agree within `MAX_QUOTE_DRIFT_PCT`, as for buys.

## Chat and conditional orders

**Tell the agent** (on `/send`) turns plain English into a draft gift for the form: "Send Ada $5 of Nvidia, but only if it drops 0.5% by tomorrow 2PM". The model has a single tool, `propose_gift`, that only returns a draft. Code validates every field (the stock must exist, $1 to `MAX_GIFT_USD`, a deadline with a time zone, 10 minutes to 7 days ahead, a drop of 0–50%) and the sender still checks the form, signs in and pays. It can't buy, send or sign anything. Chat is switched off (and hidden) unless a model key is set: `OPENAI_API_KEY` (OpenAI Responses API, default model `gpt-6-luna`) or `ANTHROPIC_API_KEY` (default `claude-haiku-4-5-20251001`). With both set, OpenAI is used unless `CHAT_PROVIDER=anthropic`. `CHAT_MODEL` overrides the model, and `CHAT_DAILY_LIMIT` (default 400 a day; 8 a minute per IP) caps the cost. Message text is never logged.

**A conditional order** is a paid gift that waits in `PAID`:
- The sender pays up front, so the money is already in the vault.
- The `price-watch` job (every minute) compares the live price per share with the trigger (baseline price at order time × (1 − drop%)). When the price is at or below it, the order is marked triggered and bought like any other gift.
- If the deadline passes first, the gift moves to `REFUNDING` and the full payment (gift plus fee) goes back to the sender. Past the deadline it never buys, even if the price is low at that moment.
- Once triggered, a signed-out trading wallet only delays the buy; the deadline no longer applies.
- Waiting and refunding don't need the trading wallet, so deadlines hold while it's signed out.
- The sender can cancel any time before it buys; that is the existing paid-gift cancel, which refunds in full.

If chat shows "The assistant couldn't answer just now", run `npm run cli -- admin chat-test <SERVER_URL>`. It makes one tiny model call and prints the exact error (for example `HTTP 401` for a rejected key, or a billing message when the account has no credit). The server also logs the same line as `chat failed: …`.

## Recipient cash-out (claim as USDT)

On the claim page the recipient picks **the shares** or **dollars (USDT)**. USDT runs the same sell path as a USDT return, paid to the claim address instead of the sender: vault → Agentic Wallet (`to_wallet`) → `baw` sell → proceeds to the vault → vault → recipient (`cashout`). The gift stays `CLAIMING` until the USDT lands, then `CLAIMED` with the payout as its claim tx.

- It needs the trading wallet. If it's signed out, or there's no sell quote, the recipient gets the shares straight away (a return waits up to 24 hours; a claim doesn't, because the recipient is on the page). The claim page says so.
- If the sale is refused after the shares reached the Agentic Wallet, they go back to the vault and on to the recipient as shares.
- Once the shares have left the vault, the claim can't be released back to `READY`, even if a later simulation fails: it stays `CLAIMING` for the payout job to finish.
- A cashed-out gift isn't listed under "Your stock".

## Group gifts

From `/send`, "Friends chip in" starts a group: the stock, the recipient, a note and how long to collect (5 minutes for a quick demo, or 1, 3 or 7 days; the chat accepts anything from 5 minutes to 7 days). The organizer signs in (their wallet gets an unclaimed gift back) and shares the group page, `/g/<id>`.

- Each contribution is an ordinary gift row (`group_role = 'contribution'`), paid through B402 like any gift, with its own $0.10 fee. It is never bought on its own.
- A group takes up to `MAX_GIFT_USD` in total; unpaid contributions hold their share while their price hold runs.
- **Close**: at the closing time the `group-close` job (every minute) moves every paid contribution `PAID → POOLED` and inserts one pooled gift (`group_role = 'pool'`, fee 0) as `PAID`. `buy-queue` buys it like any gift. The organizer can close early from the group page (signed message) and gets the claim link once; after an automatic close they get one from the gift's page ("Get a new claim link").
- **Cancel**, or a close with nothing paid: paid contributions are refunded to whoever paid them, fee included.
- **If the pooled gift isn't bought** (buy fails, or the organizer cancels it before it's bought): it ends `REFUNDED` with no transfer of its own, and each contribution goes `POOLED → REFUNDING` and is refunded to its payer.
- **Unclaimed or cancelled after it's bought**: it goes back to the organizer, like any gift. The chip-in form says so.
- A payment that settles while its group is closing is refunded by the same job. The claim page lists everyone who chipped in, with their notes.
- If no price is available at closing time (e.g. no issuer quote), the job keeps trying for 24 hours, then cancels and refunds.

## Gifts from other agents (x402)

The ERC-8004 registration already lists `POST /gifts` as ShareSend's `x402` endpoint with `send_gift`. Any agent can use it as a standard x402 resource at one URL:

1. `POST /gifts` with `{ticker, usd, senderAddress, senderName, recipientName, message}` → `402` with `PAYMENT-REQUIRED`.
2. Sign one option (any x402 v2 client; with a Binance Agentic Wallet: `baw x402-payment preview` / `sign`).
3. The same `POST /gifts` again with `PAYMENT-SIGNATURE` → `200` with the claim link, once.

The replay is matched to the open gift it was signed for (same payer, stock, amount, recipient and exact accepted requirements); if that gift's price hold has run out, a fresh gift is opened for the same payment. The payer must be `senderAddress`, so refunds and returns go back to the paying agent. Gifts created without the web app's Origin are recorded with `channel = 'agent'` and counted on `/agent`.

For discovery: `GET /.well-known/agent-card.json` (skills, payment, identity) and `GET /skill.md` (step-by-step instructions). To send one from the Agentic Wallet as "another agent":

    npm run cli -- b402-pay <SERVER_URL> NVDA 1 --to Ada --from "Payroll bot" --message "Your first share" --confirm

That moves real funds when the server runs with `LIVE_TRADING=true`; add `--show-link` to print the claim link.
