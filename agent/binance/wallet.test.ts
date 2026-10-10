import { describe, expect, it } from "vitest";
import { flattenBalances } from "./wallet.js";

const asset = { binanceChainId: "56", tokenContractAddress: "0x55d398326f99059ff775485246999027b3197955", address: "0x88", symbol: "USDT", balance: "1.5", rawBalance: "1500000000000000000", tokenPrice: "1", isRiskToken: false };

describe("flattenBalances", () => {
  it("reads the live flat shape", () => {
    expect(flattenBalances([asset])).toEqual([asset]);
  });
  it("reads the documented wrapped shape", () => {
    expect(flattenBalances([{ tokenAssets: [asset, asset] }])).toEqual([asset, asset]);
  });
  it("empty or odd input → nothing", () => {
    expect(flattenBalances([])).toEqual([]);
    expect(flattenBalances(null)).toEqual([]);
  });
});
