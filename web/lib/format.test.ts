import { describe, expect, it } from "vitest";
import { splitUsd } from "./format";

describe("splitUsd", () => {
  const cents = (a: number[]) => a.reduce((s, x) => s + Math.round(x * 100), 0);

  it("splits evenly when it can", () => {
    expect(splitUsd(10, 2)).toEqual([5, 5]);
    expect(splitUsd(9, 3)).toEqual([3, 3, 3]);
  });

  it("gives any leftover cents to the first stock and always adds back to the total", () => {
    expect(splitUsd(10, 3)).toEqual([3.34, 3.33, 3.33]);
    expect(splitUsd(20, 3)).toEqual([6.68, 6.66, 6.66]);
    for (const [total, n] of [[10, 3], [20, 7], [5.55, 4], [19.99, 5], [2, 2], [0.1 + 0.2, 3]] as const) {
      const parts = splitUsd(total, n);
      expect(parts).toHaveLength(n);
      expect(cents(parts)).toBe(Math.round(total * 100));
      expect(parts.every((p) => Number.isInteger(Math.round(p * 100)) && Math.abs(p * 100 - Math.round(p * 100)) < 1e-6)).toBe(true);
    }
  });
});
