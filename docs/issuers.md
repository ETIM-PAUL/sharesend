# Issuer findings (Phase 2)

Checked 2026-10-06 against BSC mainnet (read-only: RWA Data API, public RPC, `eth_call` simulations, `baw` quotes). **No funds spent.** The live steps (real buy, send to vault, vault payout) are still pending; see "Still to prove" at the bottom.

## Which issuers exist on BSC

`GET /api/v1/dex/market/rwa/platforms` lists only two issuers:

| Issuer | `platformId` | Tokens on BSC (chain 56) |
|---|---|---|
| Ondo Global Markets | `ondo` | 458 |
| bStocks | `bstock` | 87 |

**xStocks does not appear** in the Binance RWA API. 40 tickers are offered by both Ondo and bStocks on BSC.

## Shortlist (5 tickers, both issuers)

| Ticker | Issuer | Symbol | Contract (BSC) | Tokens per share |
|---|---|---|---|---|
| NVDA | bStocks | NVDAB | `0x02fca66c1d1afb4e2a7884261eb00f63598a7436` | 1.0008 |
| NVDA | Ondo | NVDAon | `0xa9ee28c80f960b889dfbd1902055218cba016f75` | 1.0017 |
| TSLA | bStocks | TSLAB | `0x5b1910eaad6450e50f816082aa078c41f10c292f` | 1.0000 |
| TSLA | Ondo | TSLAon | `0x2494b603319d4d9f9715c9f4496d9e0364b59d93` | 1.0000 |
| SPY | bStocks | SPYB | `0x7138b48df7d98d7e3cc221bfe7192d0a178182d8` | 1.0017 |
| SPY | Ondo | SPYon | `0x6a708ead771238919d85930b5a0f10454e1c331a` | 1.0095 |
| QQQ | bStocks | QQQB | `0x205812cdbed920aff76c6580abd681a46d11efc7` | 1.0007 |
| QQQ | Ondo | QQQon | `0x0cde6936d305d5b34667fc46425e852efd73559a` | 1.0041 |
| GOOGL | bStocks | GOOGLB | `0x3f53de71c126bdabae20f9cd64848d317f6c3238` | 1.0005 |
| GOOGL | Ondo | GOOGLon | `0x091fc7778e6932d4009b087b191d1ee3bac5729a` | 1.0025 |

AAPL is Ondo-only on BSC (`AAPLon` `0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4`).

## Transferability

| Check | bStocks | Ondo |
|---|---|---|
| Contract design | Beacon proxy; all tokens share beacon `0x156d6dce…93a3` → impl `0xCFEd6c46…4e46` | Beacon proxy; all tokens share beacon `0xc046b05a…3315` → impl `0x578f397C…50fd` |
| Recipient allowlist / KYC | **None found.** Compliance contract `0x53dBa7Aa…14F4` is a blocklist + sanctions list (`addToBlocklist`, `addToSanctionsList`, `checkIsCompliant(from,to)`) | **None found.** Compliance via `checkIsCompliant` on `0x76be569C…50D0` (delegates to a further compliance contract) |
| Simulated ~$1 transfer, ordinary wallet → brand-new address (`eth_call`) | **Passed** for all 5 | **Passed** for NVDAon, SPYon, QQQon. TSLAon, GOOGLon: no ordinary-wallet holder with ≥$1 found; passed with a contract holder (1 wei) and run the same implementation via the shared beacon |
| Pause | Pause manager `0x9fc74Be6…700a`: per-token and global pause. Currently **not paused** | Pause manager `0x6334924c…638F`: per-token and global pause. Currently **not paused** |
| Admin powers | Roles; compliance/pause managers settable; mint/burn (own balance) | Roles incl. `BURNER_ROLE` with `burn(address,uint256)`: the issuer can burn tokens from any holder |
| Our paths | `checkIsCompliant(agenticWallet → vault)` and `(vault → fresh address)` both pass | Not directly checkable (single-argument interface); covered by the transfer simulations |

Fresh recipient used for simulations (never funded): `0x5e78822d6326360c51d746E164d878210E0FEbff`.

**Conclusion so far:** both issuers' tokens move freely between ordinary wallets today, including to a never-used address. Risks to design for:
- The issuer can **pause** a token (e.g. corporate actions) → claims and returns must handle a paused token ("temporarily unavailable, will retry").
- The issuer can **upgrade** the beacon implementation at any time, which could add restrictions later.
- **Blocklisted or sanctioned addresses** will fail; surface that as a clear claim error.

## Buying through the Agentic Wallet (`baw market-order quote`, no trade)

| | $1 USDT quote | Minimum |
|---|---|---|
| bStocks (all 5) | **Works** (e.g. $1 → 0.004170 NVDAB, slippage 1%) | $1 works; true minimum not yet probed |
| Ondo (all 5) | **Refused:** `315008 SERVICE_ERROR "From token value greater than 5 USD"` | **$5** (a $5.00 quote works; error text says "greater than" but means "at least") |

Implications for ShareSend:
- **$1–4 gifts can only use bStocks.** Ondo is only an option from $5.
- Quotes are close to the reference price (NVDAon $5 → $240.14 per share vs reference $240.36).

## Pricing caveat

In `GET /api/v1/dex/market/rwa/tokens`, `tokenPrice ÷ tokenToShareRatio` equals `referencePrice` **exactly for all 488 tokens**, so `tokenPrice` is derived from the reference price, not a market price. The issuer picker must compare **swap quotes** (Trading API / `baw` quote), not RWA `tokenPrice`, to find the cheaper issuer.

bStocks also has a UI multiplier (`uiMultiplier`, `balanceOfUI`, `toUIAmount`): the displayed balance differs from the raw ERC-20 balance by the tokens-per-share ratio. Show recipients the UI amount (or shares), not the raw balance.

## Still to prove (needs ~$3 of mainnet funds)

1. Agentic Wallet buys $1 of a bStocks token (`baw market-order swap`), e.g. NVDAB.
2. Agentic Wallet sends it to the vault (`baw wallet send`), proving the address-book entry. Check `baw wallet tx-lock` for phone confirmations.
3. Vault transfers it to a brand-new address.
4. Record the three tx links here.
