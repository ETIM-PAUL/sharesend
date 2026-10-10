# Running ShareSend

## The agent's identity (ERC-8004)

ShareSend registers itself with the BNB Agent SDK (`@bnbagent/sdk`) in the canonical ERC-8004 Identity Registry. MegaFuel sponsors the gas.

| Network | Registry | Agent |
|---|---|---|
| BSC testnet (rehearsal) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | #2584 ([token](https://testnet.bscscan.com/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/2584), [tx](https://testnet.bscscan.com/tx/0x66cb11ebd9d76c278c84d5d6618e9276c63afd92fd0db7a6478b77e302c20a01)) |
| BSC mainnet | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | not yet: needs approval |

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

The command prints a link and a pairing code. Open the link, check the code matches in the app, and confirm. The session lives in `/root/.baw`, so mount a Railway volume there, or every redeploy signs it out.

Sign-in schedule through judging (48-hour sessions): **Oct 11** (before the submission lock), 13, 15, 17, 19, 21 and 23. If the app allows a longer `maxSigninDuration`, raising it means fewer sign-ins. While signed out, paid gifts wait as "queued" in the vault. Claims, returns, refunds and reconciliation keep working.

## Other admin commands

```
npm run cli -- admin status  <SERVER_URL>
npm run cli -- admin run-job <SERVER_URL> reconcile
```

`ADMIN_TOKEN` must be set both in `.env` and on the server.
