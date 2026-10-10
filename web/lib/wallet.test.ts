import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, formatUnits, parseUnits } from "viem";
import { buildTransfer, maxSendable, parseAmount, planSend, shortAmount, type Asset, type SendCheck } from "./wallet";

const ME = "0x5e78822d6326360c51d746E164d878210E0FEbff";
const THEM = "0xF72ae96cB04c5A8036617474d13eED8610ff260C";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const asset = (over: Partial<Asset> = {}): Asset => ({ kind: "erc20", symbol: "USDT", name: "Tether USD", address: USDT, decimals: 18, raw: parseUnits("50", 18), ...over });
const bnb = (raw: bigint): Asset => ({ kind: "native", symbol: "BNB", name: "BNB", decimals: 18, raw });
const GAS = parseUnits("0.00045", 18);
const check = (over: Partial<SendCheck> = {}): SendCheck => ({ asset: asset(), to: THEM, amount: "10", from: ME, bnbRaw: parseUnits("0.01", 18), minGasWei: GAS, tokenContracts: [USDT], ...over });

describe("parseAmount", () => {
  it("reads plain decimals, with or without a leading zero", () => {
    expect(parseAmount("12.5", 18)).toEqual({ ok: true, raw: parseUnits("12.5", 18) });
    expect(parseAmount(".5", 18)).toEqual({ ok: true, raw: parseUnits("0.5", 18) });
    expect(parseAmount("7", 6)).toEqual({ ok: true, raw: 7_000_000n });
  });
  it("rejects blanks, signs, exponents, words, a bare dot, zero and too many decimals", () => {
    for (const bad of ["", "  ", "-1", "+1", "1e3", "abc", ".", "1.2.3", "0", "0.0"]) expect(parseAmount(bad, 18).ok).toBe(false);
    expect(parseAmount("1.1234567", 6)).toEqual({ ok: false, error: "This token has at most 6 decimal places." });
  });
});

describe("planSend", () => {
  it("accepts a normal transfer and returns the checksummed address", () => {
    expect(planSend(check({ to: THEM.toLowerCase() }))).toEqual({ ok: true, to: THEM, amountRaw: parseUnits("10", 18), amountText: "10" });
  });
  it("rejects addresses that are wrong, mistyped, burn, your own, or a token contract", () => {
    for (const to of ["", "0x123", "not an address", THEM.slice(0, -1)]) expect(planSend(check({ to })).ok).toBe(false);
    const typo = THEM.slice(0, 20) + (THEM[20] === "a" ? "b" : "a") + THEM.slice(21); // mixed case, so the checksum no longer matches
    expect(planSend(check({ to: typo })).ok).toBe(false);
    expect(planSend(check({ to: "0x0000000000000000000000000000000000000000" }))).toMatchObject({ ok: false, error: expect.stringContaining("burn") });
    expect(planSend(check({ to: ME }))).toMatchObject({ ok: false, error: expect.stringContaining("own address") });
    expect(planSend(check({ to: USDT }))).toMatchObject({ ok: false, error: expect.stringContaining("contract") });
  });
  it("won't send more than the balance, and says how much there is", () => {
    expect(planSend(check({ amount: "50.000000000000000001" }))).toMatchObject({ ok: false, error: expect.stringContaining("only have 50") });
    expect(planSend(check({ amount: "50" })).ok).toBe(true);
  });
  it("a token transfer needs BNB for the fee", () => {
    expect(planSend(check({ bnbRaw: 0n }))).toMatchObject({ ok: false, error: expect.stringContaining("need a little BNB") });
    expect(planSend(check({ bnbRaw: GAS - 1n })).ok).toBe(false);
    expect(planSend(check({ bnbRaw: GAS })).ok).toBe(true);
  });
  it("sending BNB always leaves the fee reserve", () => {
    const a = bnb(parseUnits("1", 18));
    expect(planSend(check({ asset: a, amount: "1", bnbRaw: a.raw })).ok).toBe(false);
    expect(planSend(check({ asset: a, amount: "0.9995", bnbRaw: a.raw })).ok).toBe(true);
    expect(planSend(check({ asset: a, amount: "0.9996", bnbRaw: a.raw })).ok).toBe(false);
    expect(maxSendable(a, GAS)).toBe(parseUnits("1", 18) - GAS);
    expect(planSend(check({ asset: a, amount: formatMax(a), bnbRaw: a.raw })).ok).toBe(true); // "Max" is always sendable
  });
  it("max of a token is the whole balance; max of tiny BNB is zero", () => {
    expect(maxSendable(asset(), GAS)).toBe(parseUnits("50", 18));
    expect(maxSendable(bnb(GAS - 1n), GAS)).toBe(0n);
  });
});
const formatMax = (a: Asset) => formatUnits(maxSendable(a, GAS), 18);

describe("buildTransfer", () => {
  it("BNB is a plain value transfer", () => {
    expect(buildTransfer(bnb(0n), ME, THEM, parseUnits("0.1", 18))).toEqual({ from: ME, to: THEM, value: "0x16345785d8a0000" });
  });
  it("a token is an ERC-20 transfer(to, amount) call on the token contract with no BNB attached", () => {
    const tx = buildTransfer(asset(), ME, THEM, parseUnits("10", 18));
    expect(tx).toMatchObject({ from: ME, to: USDT, value: "0x0" });
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect(call.functionName).toBe("transfer");
    expect(call.args).toEqual([THEM, parseUnits("10", 18)]);
  });
});

describe("shortAmount", () => {
  it("trims, keeps dust visible, and handles zero", () => {
    expect(shortAmount(parseUnits("12.5", 18), 18)).toBe("12.5");
    expect(shortAmount(parseUnits("12.345678", 18), 18)).toBe("12.3456");
    expect(shortAmount(parseUnits("3", 18), 18)).toBe("3");
    expect(shortAmount(1n, 18)).toBe("<0.0001");
    expect(shortAmount(0n, 18)).toBe("0");
  });
});
