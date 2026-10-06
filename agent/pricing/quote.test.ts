import { describe, expect, it } from "vitest";
import { meetsIssuerMinimum } from "./quote.js";

describe("issuer minimums", () => {
  it("Ondo needs strictly more than $5", () => {
    expect(meetsIssuerMinimum("ondo", 5)).toBe(false);
    expect(meetsIssuerMinimum("ondo", 5.01)).toBe(true);
  });
  it("bStocks accepts $1", () => {
    expect(meetsIssuerMinimum("bstock", 1)).toBe(true);
    expect(meetsIssuerMinimum("bstock", 0.5)).toBe(false);
  });
});
