// x402 v2 requirements, payload checks and EIP-712 typed data for B402 on BSC.
// Typed data per the B402 Permit2 Signing page: Permit2 witness transfer with
// Witness(address to,uint256 validAfter) for permit2-exact; EIP-3009 TransferWithAuthorization for eip3009.
import { createHash } from "node:crypto";
import { encodeFunctionData, erc20Abi, getAddress, isAddress, maxUint256, parseUnits, type Address, type Hex } from "viem";
import { BSC_NETWORK, PERMIT2_ADDRESS, X402_VERSION, type Eip3009Payload, type PayAsset, type PaymentPayload, type PaymentRequirements, type Permit2Payload } from "./b402.js";

export const PAYMENT_TIMEOUT_SECONDS = 300;

/**
 * One `exact` requirement per asset, for `totalUsd` to `payTo`. EIP-3009 where the token supports it
 * (one signature, no approval); otherwise Permit2-exact (needs a one-time approve of Permit2).
 */
export function buildAccepts(assets: PayAsset[], totalUsd: number, payTo: string): PaymentRequirements[] {
  const out: PaymentRequirements[] = [];
  for (const a of assets) {
    const kind = a.kinds.find((k) => k.scheme === "exact" && k.extra.assetTransferMethod === "eip3009") ?? a.kinds.find((k) => k.scheme === "exact" && k.extra.assetTransferMethod === "permit2-exact");
    if (!kind) continue;
    out.push({
      scheme: "exact",
      network: kind.network,
      amount: parseUnits(totalUsd.toFixed(2), a.decimals).toString(),
      asset: getAddress(a.address),
      payTo: getAddress(payTo),
      maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
      extra: { ...kind.extra },
    });
  }
  // USDT first: what most senders hold. Then one-signature assets.
  const rank = (r: PaymentRequirements) => (r.extra.name === "Tether USD" ? 0 : r.extra.assetTransferMethod === "eip3009" ? 1 : 2);
  return out.sort((x, y) => rank(x) - rank(y));
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: PaymentRequirements[];
}

export function paymentRequired(resourceUrl: string, description: string, accepts: PaymentRequirements[], error?: string): PaymentRequired {
  return { x402Version: X402_VERSION, ...(error ? { error } : {}), resource: { url: resourceUrl, description, mimeType: "application/json" }, accepts };
}

export const encodeHeader = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");

/** Decodes a PAYMENT-SIGNATURE header (base64 JSON). Returns null if it isn't one. */
export function decodePaymentHeader(value: string | undefined | null): PaymentPayload | null {
  if (!value || value.length > 20_000) return null;
  try {
    const p = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    return p && typeof p === "object" && p.accepted && p.payload ? (p as PaymentPayload) : null;
  } catch {
    return null;
  }
}

export function payloadHash(p: PaymentPayload): string {
  return createHash("sha256").update(JSON.stringify(p.payload)).digest("hex");
}

/** Canonical form for comparing requirements: addresses lower-cased, keys sorted. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
    );
  if (typeof v === "string" && isAddress(v)) return v.toLowerCase();
  return v;
}

export function sameRequirements(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

const eq = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const isDecimal = (s: unknown) => typeof s === "string" && /^\d+$/.test(s);

/**
 * Local checks before calling B402 verify: the payload must accept exactly one of the offered requirements,
 * and its authorization must pay exactly that amount of that asset to payTo, from `expectedPayer`, unexpired.
 * Returns the matched requirement and the payer, or an error.
 */
export function checkPayload(
  p: PaymentPayload,
  offered: PaymentRequirements[],
  expectedPayer: string,
  nowSec: number,
): { ok: true; requirement: PaymentRequirements; payer: string } | { ok: false; error: string } {
  if (p.x402Version !== X402_VERSION) return { ok: false, error: "x402Version must be 2" };
  const requirement = offered.find((r) => sameRequirements(r, p.accepted));
  if (!requirement) return { ok: false, error: "accepted does not match any offered payment requirement" };
  if (requirement.network !== BSC_NETWORK) return { ok: false, error: "unsupported network" };

  const method = requirement.extra.assetTransferMethod;
  if (method === "eip3009") {
    const a = (p.payload as Eip3009Payload).authorization;
    if (!a) return { ok: false, error: "missing authorization" };
    if (!eq(a.to, requirement.payTo)) return { ok: false, error: "authorization.to is not payTo" };
    if (!isDecimal(a.value) || a.value !== requirement.amount) return { ok: false, error: "authorization.value is not the required amount" };
    if (!isDecimal(a.validBefore) || Number(a.validBefore) <= nowSec + 10) return { ok: false, error: "authorization expired" };
    if (!isDecimal(a.validAfter) || Number(a.validAfter) > nowSec) return { ok: false, error: "authorization not valid yet" };
    if (!eq(a.from, expectedPayer)) return { ok: false, error: "payer is not the gift's sender address" };
    return { ok: true, requirement, payer: getAddress(a.from) };
  }
  if (method === "permit2-exact") {
    const a = (p.payload as Permit2Payload).permit2Authorization;
    if (!a) return { ok: false, error: "missing permit2Authorization" };
    if (!eq(a.permitted?.token, requirement.asset)) return { ok: false, error: "permitted.token is not the required asset" };
    if (!isDecimal(a.permitted?.amount) || a.permitted.amount !== requirement.amount) return { ok: false, error: "permitted.amount is not the required amount" };
    if (!eq(a.spender, requirement.extra.spenderAddress)) return { ok: false, error: "spender is not the B402 spender" };
    if (!eq(a.witness?.to, requirement.payTo)) return { ok: false, error: "witness.to is not payTo" };
    if (!isDecimal(a.deadline) || Number(a.deadline) <= nowSec + 10) return { ok: false, error: "permit expired" };
    if (!isDecimal(a.witness.validAfter) || Number(a.witness.validAfter) > nowSec) return { ok: false, error: "permit not valid yet" };
    if (!isDecimal(a.nonce)) return { ok: false, error: "nonce must be a decimal string" };
    if (!eq(a.from, expectedPayer)) return { ok: false, error: "payer is not the gift's sender address" };
    return { ok: true, requirement, payer: getAddress(a.from) };
  }
  return { ok: false, error: `unsupported transfer method ${method}` };
}

// ---- EIP-712 typed data (for the web app's signer, and tests) ----

export function eip3009TypedData(r: PaymentRequirements, a: Eip3009Payload["authorization"]) {
  return {
    domain: { name: r.extra.name, version: r.extra.version, chainId: 56, verifyingContract: r.asset as Address },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: a.from as Address,
      to: a.to as Address,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce as Hex,
    },
  };
}

export function permit2ExactTypedData(a: Permit2Payload["permit2Authorization"]) {
  return {
    domain: { name: "Permit2", chainId: 56, verifyingContract: PERMIT2_ADDRESS as Address },
    types: {
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "Witness" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      Witness: [
        { name: "to", type: "address" },
        { name: "validAfter", type: "uint256" },
      ],
    },
    primaryType: "PermitWitnessTransferFrom" as const,
    message: {
      permitted: { token: a.permitted.token as Address, amount: BigInt(a.permitted.amount) },
      spender: a.spender as Address,
      nonce: BigInt(a.nonce),
      deadline: BigInt(a.deadline),
      witness: { to: a.witness.to as Address, validAfter: BigInt(a.witness.validAfter) },
    },
  };
}

/** Builds an unsigned authorization for a requirement (what a wallet would sign). */
export function draftAuthorization(r: PaymentRequirements, from: string, nowSec: number, random: Buffer) {
  const deadline = String(nowSec + r.maxTimeoutSeconds);
  if (r.extra.assetTransferMethod === "eip3009")
    return { method: "eip3009" as const, authorization: { from, to: r.payTo, value: r.amount, validAfter: "0", validBefore: deadline, nonce: `0x${random.toString("hex").padEnd(64, "0").slice(0, 64)}` } };
  return {
    method: "permit2-exact" as const,
    permit2Authorization: {
      permitted: { token: r.asset, amount: r.amount },
      from,
      spender: r.extra.spenderAddress!,
      // Permit2 unordered nonces: any unused uint256. Random 128 bits avoids collisions.
      nonce: BigInt(`0x${random.subarray(0, 16).toString("hex")}`).toString(),
      deadline,
      witness: { to: r.payTo, validAfter: "0" },
    },
  };
}

// ---- Wallet signing requests (for browser wallets via eth_signTypedData_v4) ----

const DOMAIN_FIELD_TYPES: Record<string, string> = { name: "string", version: "string", chainId: "uint256", verifyingContract: "address" };

export type SigningDraft = ReturnType<typeof draftAuthorization>;

export interface SigningRequest {
  method: "eip3009" | "permit2-exact";
  draft: SigningDraft;
  /** JSON-safe: EIP712Domain included, uint256 values as decimal strings. Pass as-is to eth_signTypedData_v4. */
  typedData: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
}

/** The exact typed data a wallet must sign to pay requirement `r` from `from`. */
export function signingRequest(r: PaymentRequirements, from: string, nowSec: number, random: Buffer): SigningRequest {
  const draft = draftAuthorization(r, getAddress(from), nowSec, random);
  const td = draft.method === "eip3009" ? eip3009TypedData(r, draft.authorization) : permit2ExactTypedData(draft.permit2Authorization);
  const domainTypes = Object.keys(td.domain).map((name) => ({ name, type: DOMAIN_FIELD_TYPES[name]! }));
  const typedData = JSON.parse(
    JSON.stringify({ domain: td.domain, types: { EIP712Domain: domainTypes, ...td.types }, primaryType: td.primaryType, message: td.message }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
  return { method: draft.method, draft, typedData };
}

/** Assembles the x402 PaymentPayload from a signed draft. */
export function paymentPayloadFrom(r: PaymentRequirements, draft: SigningDraft, signature: string, resource?: PaymentPayload["resource"]): PaymentPayload {
  const payload =
    draft.method === "eip3009" ? { signature, authorization: draft.authorization } : { signature, permit2Authorization: draft.permit2Authorization };
  return { x402Version: X402_VERSION, ...(resource ? { resource } : {}), accepted: r, payload };
}

/** One-time setup for Permit2 assets: let the canonical Permit2 contract move this token. Each payment still needs a signature. */
export function permit2ApproveTx(asset: string): { to: string; data: Hex; value: "0x0" } {
  return { to: getAddress(asset), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS as Address, maxUint256] }), value: "0x0" };
}

/** Who signed a payment: the `from` of its authorization, or null if it has none. */
export function payerOf(p: PaymentPayload): string | null {
  const from = (p.payload as Eip3009Payload)?.authorization?.from ?? (p.payload as Permit2Payload)?.permit2Authorization?.from;
  return typeof from === "string" && isAddress(from) ? getAddress(from) : null;
}
