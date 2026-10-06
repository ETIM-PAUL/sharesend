// What we know about each issuer on BSC, from docs/issuers.md. Update here when the live
// Phase 2 transfers succeed (transferability "simulated" → "live").
import type { Issuer } from "../binance/rwa.js";

export interface IssuerInfo {
  label: string;
  /** "simulated": eth_call transfers to fresh addresses pass. "live": a real mainnet transfer succeeded. */
  transferability: "live" | "simulated" | "blocked";
  /** Smallest order accepted, found by live quotes. */
  minUsd: number;
  /** Ondo's Trading API rejects exactly $5 (40375); $5.01 works. */
  minExclusive: boolean;
}

export const ISSUERS: Record<Issuer, IssuerInfo> = {
  bstock: { label: "bStocks", transferability: "simulated", minUsd: 1, minExclusive: false },
  ondo: { label: "Ondo", transferability: "simulated", minUsd: 5, minExclusive: true },
};

export function issuerInfo(issuer: string): IssuerInfo | undefined {
  return (ISSUERS as Record<string, IssuerInfo>)[issuer];
}

export function isTransferable(issuer: string): boolean {
  const t = issuerInfo(issuer)?.transferability;
  return t === "live" || t === "simulated";
}

export function meetsIssuerMinimum(issuer: string, usd: number): boolean {
  const m = issuerInfo(issuer);
  if (!m) return false;
  return m.minExclusive ? usd > m.minUsd : usd >= m.minUsd;
}

export function minimumText(issuer: string): string {
  const m = issuerInfo(issuer);
  return m ? `${m.label} minimum is ${m.minExclusive ? "more than" : "at least"} $${m.minUsd}` : `unknown issuer ${issuer}`;
}
