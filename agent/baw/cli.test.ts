import { describe, expect, it } from "vitest";
import { BawError } from "./cli.js";

describe("BawError.isSessionError", () => {
  it.each([
    ["baw market-order swap: Not logged in", "NOT_LOGGED_IN"],
    ["baw x402-payment preview: Please log in first.", undefined],
    ["baw wallet send: wallet is UNCONNECTED", undefined],
    ["baw market-order swap: session expired", undefined],
  ])("%s → session error", (message, name) => {
    expect(new BawError(message, "cli", 10003000, name).isSessionError).toBe(true);
  });

  it("does not treat other refusals as session errors", () => {
    expect(new BawError("baw market-order swap: refused for this token", "cli", 315008, "SERVICE_ERROR").isSessionError).toBe(false);
  });
});
