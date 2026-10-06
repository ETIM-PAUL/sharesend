import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(v)) throw new Error(`Env var ${name} is not a number`);
  return v;
}

// Secrets are read lazily via getters so importing config never throws or leaks them.
export const config = {
  get binanceApiKey() { return required("BINANCE_API_KEY"); },
  get binanceApiSecret() { return required("BINANCE_API_SECRET"); },
  binanceBaseUrl: process.env.BINANCE_BASE_URL ?? "https://web3.binance.com/build",
  b402Network: process.env.B402_NETWORK ?? "eip155:56",
  liveTrading: process.env.LIVE_TRADING === "true",
  maxGiftUsd: num("MAX_GIFT_USD", 20),
  dailyCapUsd: num("DAILY_CAP_USD", 50),
  // RWA quotes need a userWalletAddress; quotes are taken as the Agentic Wallet (the buyer).
  agenticWalletAddress: process.env.AGENTIC_WALLET_ADDRESS ?? "",
  serviceFeeUsd: num("SERVICE_FEE_USD", 0.1),
  giftExpiryDays: num("GIFT_EXPIRY_DAYS", 30),
  quoteTtlSeconds: num("QUOTE_TTL_SECONDS", 60),
  maxPriceImpactPct: num("MAX_PRICE_IMPACT_PCT", 1.5),
  weekendWarnPct: num("WEEKEND_WARN_PCT", 1.0),
};
