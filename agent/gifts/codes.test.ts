import { describe, expect, it } from "vitest";
import { claimLink, codeMatches, generateClaimCode, hashClaimCode, isWellFormedCode } from "./codes.js";

describe("claim codes", () => {
  it("are 128-bit base64url and unique", () => {
    const codes = new Set(Array.from({ length: 1000 }, generateClaimCode));
    expect(codes.size).toBe(1000);
    for (const c of codes) {
      expect(isWellFormedCode(c)).toBe(true);
      expect(Buffer.from(c, "base64url")).toHaveLength(16);
    }
  });

  it("match only their own hash", () => {
    const code = generateClaimCode();
    const hash = hashClaimCode(code);
    expect(hash).toHaveLength(32);
    expect(codeMatches(code, hash)).toBe(true);
    expect(codeMatches(generateClaimCode(), hash)).toBe(false);
    expect(codeMatches(code.slice(0, -1) + (code.endsWith("A") ? "B" : "A"), hash)).toBe(false);
  });

  it("reject malformed input without throwing", () => {
    const hash = hashClaimCode(generateClaimCode());
    for (const bad of ["", "short", "x".repeat(23), "has space in it 1234567", "../../etc/passwd!!!!!"]) expect(codeMatches(bad, hash)).toBe(false);
    expect(codeMatches(generateClaimCode(), Buffer.alloc(5))).toBe(false);
  });

  it("links put the code in the fragment only", () => {
    const code = generateClaimCode();
    const url = new URL(claimLink("https://sharesend.app/", "6f1c2d4e-0000-4000-8000-000000000000", code));
    expect(url.pathname).toBe("/c/6f1c2d4e-0000-4000-8000-000000000000");
    expect(url.hash).toBe(`#${code}`);
    expect(url.search).toBe("");
  });
});
