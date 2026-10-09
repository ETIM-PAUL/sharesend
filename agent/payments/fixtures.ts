// Test fixture: B402 payment assets as returned live by /supported on 2026-10-07.
import type { PayAsset } from "./b402.js";

const SIGNER = "0x34F7a661160780Ce1346e6D7B96D2bE244590899";
const SPENDER = "0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633";
const kind = (name: string, method: "eip3009" | "permit2-exact" | "permit2-upto") => ({
  x402Version: 2,
  scheme: (method === "permit2-upto" ? "upto" : "exact") as "exact" | "upto",
  network: "eip155:56",
  extra: { name, version: "1", assetTransferMethod: method, signerAddress: SIGNER, ...(method === "eip3009" ? {} : { spenderAddress: SPENDER }) },
});

export const ASSETS: PayAsset[] = [
  { name: "United Stables", symbol: "U", address: "0xcE24439F2D9C6a2289F741120FE202248B666666", decimals: 18, kinds: [kind("United Stables", "eip3009"), kind("United Stables", "permit2-exact"), kind("United Stables", "permit2-upto")] },
  { name: "Tether USD", symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, kinds: [kind("Tether USD", "permit2-exact"), kind("Tether USD", "permit2-upto")] },
];

