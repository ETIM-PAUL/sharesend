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

## Deploy (Vercel)

- Root directory: `web`
- Env: `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_AGENT_URL=https://sharesend-agent-production.up.railway.app`
- Then add the Vercel URL to Privy's allowed origins, and to the agent's `WEB_ORIGINS` and `CLAIM_BASE_URL`.

## Pages

- `/` send flow: details → price → pay → share
- `/sent` gifts sent from this device
- `/sent/[id]` progress, new claim link, cancel (both signed by the paying wallet)
