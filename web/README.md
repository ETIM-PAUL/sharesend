# ShareSend web

The sender app: pick a stock, see the price on a certificate, pay with a Privy wallet, share the claim link, follow the gift.

The browser only talks to the ShareSend agent service; it never calls Binance directly.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000 (Privy only allows the origins set in its dashboard)
```

`.env.local`:

| Key | Value |
|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy app ID |
| `NEXT_PUBLIC_AGENT_URL` | Agent service URL, e.g. `http://localhost:8080` or the Railway URL |

The agent must list this app's origin in `WEB_ORIGINS`.

## Deploy (Railway)

A second Railway service in the same project as the agent:
- Root directory: `web`
- Variables: `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_AGENT_URL=<the agent service URL>`
- Then add the web URL to Privy's allowed origins, and to the agent's `WEB_ORIGINS` and `CLAIM_BASE_URL`.

`NEXT_PUBLIC_` values are baked in at build time: redeploy after changing them.

## Pages

- `/` landing page with the agent's live ledger
- `/send` chat + form → price → pay → share
- `/sent`, `/sent/[id]` gifts sent from this device; progress, new claim link, cancel, how it returns (signed by the paying wallet)
- `/c/[id]` claim page (the code is in the link's `#`)
- `/you`, `/wallet` holdings, balances, send, sign out
- `/agent` identity, jobs, proof of holdings, fee ledger
- `/admin` operator page: sign the trading wallet in

`npm test` runs the wallet-send checks (address and amount rules, the exact transaction built).
