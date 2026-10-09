import { describe, expect, it } from "vitest";
import { rankTickers, type RwaToken } from "./rwa.js";

const tok = (o: Partial<RwaToken>): RwaToken => ({ underlyingTicker: "X", underlyingName: "X Corp", tokenName: "X token", tokenSymbol: "XB", platformId: "bstock", ...o }) as RwaToken;

describe("rankTickers", () => {
  const tokens = [
    tok({ underlyingTicker: "MSFT", underlyingName: "Microsoft Corp", tokenSymbol: "MSFTB", platformId: "bstock" }),
    tok({ underlyingTicker: "MSFT", underlyingName: "Microsoft Corp", tokenSymbol: "MSFTon", platformId: "ondo" }),
    tok({ underlyingTicker: "MSTR", underlyingName: "MicroStrategy", tokenSymbol: "MSTRon", platformId: "ondo" }),
    tok({ underlyingTicker: "AMD", underlyingName: "Advanced Micro Devices", tokenSymbol: "AMDon", platformId: "ondo" }),
    // Seen live: a few Ondo tokens have no underlyingName.
    tok({ underlyingTicker: "SECU", underlyingName: null, tokenName: "Securitize Ondo Tokenized", tokenSymbol: "SECUon", platformId: "ondo" }),
  ];

  it("matches names and merges issuers per ticker", () => {
    expect(rankTickers(tokens, "micro")).toEqual([
      { ticker: "AMD", name: "Advanced Micro Devices", issuers: ["ondo"] },
      { ticker: "MSFT", name: "Microsoft Corp", issuers: ["bstock", "ondo"] },
      { ticker: "MSTR", name: "MicroStrategy", issuers: ["ondo"] },
    ]);
  });

  it("an exact ticker ranks first", () => {
    expect(rankTickers(tokens, "msft")[0]!.ticker).toBe("MSFT");
  });

  it("survives tokens without a company name", () => {
    expect(rankTickers(tokens, "secu")).toEqual([{ ticker: "SECU", name: "Securitize Ondo Tokenized", issuers: ["ondo"] }]);
  });

  it("empty query → nothing", () => {
    expect(rankTickers(tokens, "  ")).toEqual([]);
  });
});
