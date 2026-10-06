import { describe, expect, it } from "vitest";
import { canAdvanceStep, canTransition, STATUSES, TERMINAL, TRANSITIONS } from "./states.js";

describe("state machine", () => {
  it("allows exactly the moves in the plan's lifecycle", () => {
    const legal = STATUSES.flatMap((from) => TRANSITIONS[from].map((to) => `${from}→${to}`)).sort();
    expect(legal).toEqual(
      [
        "AWAITING_PAYMENT→PAID",
        "AWAITING_PAYMENT→EXPIRED",
        "PAID→BUYING",
        "PAID→REFUNDING",
        "BUYING→READY",
        "BUYING→FAILED",
        "READY→CLAIMING",
        "READY→RETURNING",
        "CLAIMING→CLAIMED",
        "CLAIMING→READY",
        "FAILED→REFUNDING",
        "REFUNDING→REFUNDED",
        "RETURNING→RETURNED",
      ].sort(),
    );
  });

  it("rejects skipping steps, going backwards and leaving terminal states", () => {
    expect(canTransition("AWAITING_PAYMENT", "READY")).toBe(false);
    expect(canTransition("PAID", "CLAIMED")).toBe(false);
    expect(canTransition("READY", "BUYING")).toBe(false);
    expect(canTransition("CLAIMED", "READY")).toBe(false);
    expect(canTransition("RETURNED", "READY")).toBe(false);
    expect(canTransition("READY", "READY")).toBe(false);
  });

  it("terminal states are CLAIMED, EXPIRED, REFUNDED and RETURNED", () => {
    expect([...TERMINAL].sort()).toEqual(["CLAIMED", "EXPIRED", "REFUNDED", "RETURNED"]);
  });

  it("buy steps advance one at a time, in order", () => {
    expect(canAdvanceStep(null, "forwarded")).toBe(true);
    expect(canAdvanceStep("forwarded", "swapped")).toBe(true);
    expect(canAdvanceStep("swapped", "in_vault")).toBe(true);
    expect(canAdvanceStep(null, "swapped")).toBe(false);
    expect(canAdvanceStep("forwarded", "forwarded")).toBe(false);
    expect(canAdvanceStep("in_vault", "swapped")).toBe(false);
  });
});
