import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { MIN_GAS_WEI, STABLES, walletBalances, type BalanceDeps } from "./balances.js";

const ADDR = "0x5e78822d6326360c51d746E164d878210E0FEbff";
const deps = (over: Partial<BalanceDeps> = {}): BalanceDeps => ({
  native: async () => parseUnits("0.0125", 18),
  erc20: async (token) => (token === STABLES[0].address ? parseUnits("12.5", 18) : token === STABLES[1].address ? 1n : 0n),
  bnbUsd: async () => 750,
  ...over,
});

describe("walletBalances", () => {
  it("returns BNB and every stablecoin, valued in USD", async () => {
    const b = await walletBalances(ADDR, deps());
    expect(b.bnb).toEqual({ raw: parseUnits("0.0125", 18).toString(), amount: "0.0125", usd: 9.38 });
    expect(b.tokens.map((t) => [t.symbol, t.amount, t.usd])).toEqual([["USDT", "12.5", 12.5], ["USDC", "0.000000000000000001", 0], ["U", "0", 0], ["USD1", "0", 0]]);
    expect(b.minGasWei).toBe(MIN_GAS_WEI.toString());
  });
  it("still answers when BNB can't be priced", async () => {
    const b = await walletBalances(ADDR, deps({ bnbUsd: async () => null }));
    expect(b.bnb.usd).toBeNull();
    expect(b.tokens[0]!.usd).toBe(12.5);
  });
  it("rejects anything that isn't an address", async () => {
    await expect(walletBalances("0x123", deps())).rejects.toThrow("not an address");
  });
  it("an empty wallet reads as zeros", async () => {
    const b = await walletBalances(ADDR, deps({ native: async () => 0n, erc20: async () => 0n }));
    expect([b.bnb.amount, b.bnb.usd, b.tokens.every((t) => t.amount === "0")]).toEqual(["0", 0, true]);
  });
});
