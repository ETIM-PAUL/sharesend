// What's in a wallet: BNB for fees, the dollar stablecoins ShareSend accepts, with USD values.
// Public chain data, so anyone can look up any address. Stock holdings come from /holdings/:address.
import { formatUnits, getAddress, isAddress } from "viem";
import { getQuote } from "../binance/trading.js";
import { USDT_BSC } from "../binance/constants.js";
import { nativeBalance, tokenBalance } from "../chain/bsc.js";

export const NATIVE_PLACEHOLDER = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** The stablecoins B402 accepts (see agent/payments), all 18 decimals on BSC and valued at $1. */
export const STABLES = [
  { symbol: "USDT", name: "Tether USD", address: USDT_BSC.address, decimals: 18 },
  { symbol: "USDC", name: "USD Coin", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
  { symbol: "U", name: "United Stables", address: "0xcE24439F2D9C6a2289F741120FE202248B666666", decimals: 18 },
  { symbol: "USD1", name: "World Liberty Financial USD", address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d", decimals: 18 },
] as const;

export interface WalletBalances {
  address: string;
  bnb: { raw: string; amount: string; usd: number | null };
  /** Price of 1 BNB in USD, or null when it couldn't be quoted. */
  bnbUsd: number | null;
  tokens: { symbol: string; name: string; address: string; decimals: number; raw: string; amount: string; usd: number }[];
  /** BNB below this can't pay for a transfer. */
  minGasWei: string;
  checkedAt: number;
}

/**
 * The fee reserve. A token transfer measured 35k gas (BNB: 21k) at a BSC gas price around 0.05 gwei; this assumes
 * 100k gas at 1 gwei = 0.0001 BNB (about $0.08), roughly ten times the real cost, so a price spike still can't strand a send.
 */
export const MIN_GAS_WEI = 100_000n * 1_000_000_000n;

export interface BalanceDeps {
  native(address: string): Promise<bigint>;
  erc20(token: string, holder: string): Promise<bigint>;
  bnbUsd(): Promise<number | null>;
}

let priceCache: { at: number; usd: number | null } | undefined;

export const liveDeps: BalanceDeps = {
  native: nativeBalance,
  erc20: tokenBalance,
  async bnbUsd() {
    if (priceCache && Date.now() - priceCache.at < 60_000) return priceCache.usd;
    let usd: number | null = null;
    try {
      const { quote } = await getQuote({ binanceChainId: "56", fromTokenAddress: NATIVE_PLACEHOLDER, toTokenAddress: USDT_BSC.address, amount: 10n ** 18n });
      usd = Number(formatUnits(BigInt(quote.toTokenAmount), USDT_BSC.decimals));
    } catch {
      // Keep the last good price if there is one; the page shows balances either way.
      usd = priceCache?.usd ?? null;
    }
    priceCache = { at: Date.now(), usd };
    return usd;
  },
};

const trim = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

export async function walletBalances(address: string, deps: BalanceDeps = liveDeps): Promise<WalletBalances> {
  if (!isAddress(address)) throw new Error("not an address");
  const [bnbRaw, price, ...stableRaw] = await Promise.all([deps.native(address), deps.bnbUsd(), ...STABLES.map((t) => deps.erc20(t.address, address))]);
  const bnbAmount = trim(formatUnits(bnbRaw, 18));
  return {
    address: getAddress(address),
    bnb: { raw: bnbRaw.toString(), amount: bnbAmount, usd: price === null ? null : Math.round(Number(bnbAmount) * price * 100) / 100 },
    bnbUsd: price,
    tokens: STABLES.map((t, i) => {
      const raw = stableRaw[i]!;
      const amount = trim(formatUnits(raw, t.decimals));
      return { symbol: t.symbol, name: t.name, address: t.address, decimals: t.decimals, raw: raw.toString(), amount, usd: Math.round(Number(amount) * 100) / 100 };
    }),
    minGasWei: MIN_GAS_WEI.toString(),
    checkedAt: Date.now(),
  };
}
