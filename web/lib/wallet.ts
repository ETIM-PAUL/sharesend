// Sending tokens out of the user's wallet. Everything that decides whether a transfer is safe lives here as plain
// functions with tests; the page only collects input and asks the wallet to sign what buildTransfer returns.
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseUnits, toHex } from "viem";

export interface Asset {
  kind: "native" | "erc20";
  symbol: string;
  name: string;
  /** Contract address for tokens; undefined for BNB. */
  address?: string;
  decimals: number;
  raw: bigint;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** "12.5" → raw units. Rejects blanks, signs, exponents, more decimals than the token has, and zero. */
export function parseAmount(input: string, decimals: number): { ok: true; raw: bigint } | { ok: false; error: string } {
  const s = input.trim();
  if (!s) return { ok: false, error: "Enter an amount." };
  if (!/^\d*\.?\d*$/.test(s) || s === ".") return { ok: false, error: "Use numbers only, like 12.5." };
  const [, frac = ""] = s.split(".");
  if (frac.length > decimals) return { ok: false, error: `This token has at most ${decimals} decimal places.` };
  const raw = parseUnits(s.startsWith(".") ? `0${s}` : s, decimals);
  if (raw <= 0n) return { ok: false, error: "Enter an amount above zero." };
  return { ok: true, raw };
}

/** The most that can be sent: all of a token, but BNB less the fee reserve so the transfer can still pay for itself. */
export function maxSendable(asset: Asset, minGasWei: bigint): bigint {
  if (asset.kind !== "native") return asset.raw;
  return asset.raw > minGasWei ? asset.raw - minGasWei : 0n;
}

export interface SendCheck {
  asset: Asset;
  to: string;
  amount: string;
  /** The sending wallet's address. */
  from: string;
  /** Its BNB balance, for the network fee. */
  bnbRaw: bigint;
  minGasWei: bigint;
  /** Token contracts: sending tokens to one of these destroys them. */
  tokenContracts: string[];
}

export type SendPlan = { ok: true; to: string; amountRaw: bigint; amountText: string } | { ok: false; error: string };

export function planSend(c: SendCheck): SendPlan {
  const to = c.to.trim();
  if (!to) return { ok: false, error: "Enter the address to send to." };
  // viem's check also verifies the capitalization checksum when the address has mixed case, catching typos.
  if (!isAddress(to)) return { ok: false, error: "That isn't a valid BNB Chain address. Check it character by character, or paste it again." };
  const checksummed = getAddress(to);
  if (checksummed === ZERO) return { ok: false, error: "That's the burn address: anything sent there is lost." };
  if (checksummed.toLowerCase() === c.from.toLowerCase()) return { ok: false, error: "That's this wallet's own address." };
  if (c.tokenContracts.some((t) => t.toLowerCase() === checksummed.toLowerCase()) || (c.asset.address && c.asset.address.toLowerCase() === checksummed.toLowerCase()))
    return { ok: false, error: "That's a token's contract address, not a person's wallet. Tokens sent there are lost." };

  const amt = parseAmount(c.amount, c.asset.decimals);
  if (!amt.ok) return amt;
  if (amt.raw > c.asset.raw) return { ok: false, error: `You only have ${formatUnits(c.asset.raw, c.asset.decimals)} ${c.asset.symbol}.` };
  if (c.asset.kind === "native") {
    if (amt.raw > maxSendable(c.asset, c.minGasWei)) return { ok: false, error: "Leave a little BNB to pay the network fee. Use Max to send the most you can." };
  } else if (c.bnbRaw < c.minGasWei) {
    return { ok: false, error: `You need a little BNB (about ${formatUnits(c.minGasWei, 18)}) in this wallet for the network fee. Send some BNB to it first.` };
  }
  return { ok: true, to: checksummed, amountRaw: amt.raw, amountText: formatUnits(amt.raw, c.asset.decimals) };
}

/** The transaction to hand to the wallet: a plain BNB transfer, or an ERC-20 `transfer(to, amount)` on the token contract. */
export function buildTransfer(asset: Asset, from: string, to: string, amountRaw: bigint): { from: string; to: string; value: `0x${string}`; data?: `0x${string}` } {
  if (asset.kind === "native") return { from, to, value: toHex(amountRaw) };
  return { from, to: getAddress(asset.address!), value: "0x0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(to), amountRaw] }) };
}

/** "0.000000000000000001" → "<0.0001"; otherwise at most `max` decimals, trailing zeros trimmed. */
export function shortAmount(raw: bigint, decimals: number, max = 4): string {
  if (raw === 0n) return "0";
  const full = formatUnits(raw, decimals);
  const [whole, frac = ""] = full.split(".");
  const cut = frac.slice(0, max).replace(/0+$/, "");
  if (whole === "0" && !cut) return `<0.${"0".repeat(max - 1)}1`;
  return cut ? `${whole}.${cut}` : whole!;
}
