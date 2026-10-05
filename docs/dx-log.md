# DX log (raw notes — Paul writes the final DX report himself)

Format: time | page/endpoint | expected | happened | time lost

## Milestones
- Docs first opened: _TODO (fill in when you open them)_
- First successful authenticated API call: 2026-10-05 21:50 UTC — `POST /build/api/v2/b402/supported`, from Paul's machine. From the hosted agent service (Railway, Singapore, egress 208.77.246.55): 2026-10-05 23:09 UTC

## Friction (from builder chat, Sep 16 – Oct 5; peer reports, not verified by us)
- 2026-10-05 13:59 UTC | RWA underlying-market API | documented marketStatus enum | returns "offhours" with openState=true, reasonCode=TRADING; value not in docs | unverified
- 2026-10-05 13:59 UTC | /quote -> /swap for NVDAon | RFQ per API reference | LiquidMesh route, executionMode=SWAP reported | unverified
- 2026-10-05 13:59 UTC | any signed call from hosted server | works as from dev machine | 40304 "compliance restriction" from serverless/US datacenter IPs; dev machine OK | unverified, unanswered by organizers
- 2026-10-05 13:59 UTC | B402 credential form | open application | "you need permission" reported | unverified
- 2026-10-05 13:59 UTC | dev portal on mobile | create-key button | not visible; desktop only | unverified

## Our own log
- 2026-10-05 14:13 UTC | Binance B402 docs (basics/4.base-urls) | sandbox base URL | page says "Contact Binance for access"; no URL, no timeline for credentials | -
- 2026-10-05 14:13 UTC | Binance B402 apply form | credentials delivery info | form has no confirmation of method/timeline; docs say clientId + accessToken + webhook pubkey, RSA-signed, source-IP whitelisting | -
- 2026-10-05 14:13 UTC | docs.b402.ai facilitator health-check | GET /health returns {status:ok} | GET https://facilitatorv3.b402.ai/health returned 404 "Route not found" (host taken from authentication page) | ~5 min
- 2026-10-05 14:13 UTC | two B402 doc sets | one clear path | Binance developers.binance.com (clientId/RSA/whitelist) and docs.b402.ai (no keys needed) describe different auth models; unclear how they relate | -
- 2026-10-05 14:22 UTC | docs: three B402 doc sets (developers.binance.com/onchainpay-x402, docs.b402.ai, web3.binance.com/en/dev-docs/products/b402-api) | one canonical guide | contradictory: first says clientId+RSA+"contact Binance" for base URL, third says same API key w/ B402 permission, base https://web3.binance.com/build, HMAC signing. Third appears current | ~30 min
- 2026-10-05 15:10 UTC | Agentic Wallet sign-in | "type confirm in agent" per app | app message tells user to return to the agent and type confirm; actual flow is auth signin -> auth verify blocking; unclear to a human that the agent (not the user) must run verify | ~10 min
- 2026-10-05 ~20:00 UTC | Agentic Wallet `wallet send` (skill references/send.md) | send to any address | recipient must be in the address book, added by hand in the Binance App; agent can't pay out to addresses learned at runtime. Forced a two-wallet redesign (vault) | ~1 h incl. redesign
- 2026-10-05 ~20:00 UTC | Agentic Wallet sessions (`baw wallet settings`) | session lasts through a long-running service | 48 h inactivity sign-out, hard cutoff (signInMaxTime) ~7 days after sign-in; re-sign needs the phone. Judging window (Oct 12–23) is longer than one session | -
- 2026-10-05 ~20:30 UTC | Web3 API docs fetching | readable docs / llms.txt | dev-docs pages return HTTP 202 with empty body to curl (JS-rendered); REST API catalog page unreadable to tools; had to use the skills-hub GitHub repo for RWA endpoints | ~20 min
- 2026-10-05 21:30 UTC | prohibited-regions page | — | explains 40304: IP checks on API server side; US, UK, CA, NL, JP(conditional) blocked. Not mentioned on the error itself or in the auth page | -
- 2026-10-05 21:45 UTC | B402 `/supported` request format | plain JSON body | must wrap as `{"body": {}}` and sign that exact string; requestPath includes `/build`, excludes query string; B402 success code is `000000000` (9 zeros) vs `000000` on data APIs | -
- 2026-10-05 21:50 UTC | B402 `/supported` response | — | USDT and USDC on BSC: permit2 only (no eip3009); United Stables (U) and USD1: eip3009 + permit2. One-signature, no-approval payments only possible with U or USD1 | -
- 2026-10-05 23:07 UTC | `POST /build/api/v2/b402/supported` from Railway US West (egress 152.55.176.8, Santa Clara, US) | 40304 per prohibited-regions page (US blocked server-side) | call succeeded (HTTP 200). Geo check apparently not applied to this endpoint, or not consistently; other teams report 40304 from US hosts on RWA/quote endpoints | -
