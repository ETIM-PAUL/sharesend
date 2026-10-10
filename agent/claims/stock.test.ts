import { describe, expect, it } from "vitest";
import { cleanSeries, sharesOf } from "./stock.js";

const c = (time: number, close: number) => ({ open: close, high: close, low: close, close, volume: 1, time, trades: 1 });

describe("cleanSeries", () => {
  it("drops bad prints like the live NVDAon $425 closes", () => {
    // Shapes from the live Market API: ratio 1.0017, reference ~$230.19, two closes at $425.
    const candles = [c(3, 230.41), c(1, 425.38), c(2, 425.55), c(4, 229.9)];
    const s = cleanSeries(candles, 1.0017152487959898, 230.19);
    expect(s.map((p) => p.t)).toEqual([3, 4]);
    expect(s[0]!.price).toBeCloseTo(230.41 / 1.0017152487959898);
  });

  it("without a reference price, filters against the median", () => {
    const s = cleanSeries([c(1, 100), c(2, 101), c(3, 99), c(4, 300)], 1);
    expect(s.map((p) => p.t)).toEqual([1, 2, 3]);
  });

  it("empty in, empty out", () => {
    expect(cleanSeries([], 1, 100)).toEqual([]);
  });
});

describe("sharesOf", () => {
  it("applies the token-to-share ratio", () => {
    expect(sharesOf(20_000_000_000_000_000n, 18, 1.0007782237528078)).toBeCloseTo(0.0200156, 6);
  });
});
