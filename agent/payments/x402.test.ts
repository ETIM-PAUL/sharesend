import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, maxUint256, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildAccepts, checkPayload, decodePaymentHeader, draftAuthorization, eip3009TypedData, encodeHeader, paymentPayloadFrom, permit2ApproveTx, permit2ExactTypedData, sameRequirements, signingRequest } from "./x402.js";
import type { PaymentPayload } from "./b402.js";
import { ASSETS } from "./fixtures.js";

const VAULT = "0xF72ae96cB04c5A8036617474d13eED8610ff260C";
const NOW = 1_791_400_000;

async function signed(r: ReturnType<typeof buildAccepts>[number], key = generatePrivateKey()) {
  const acct = privateKeyToAccount(key);
  const d = draftAuthorization(r, acct.address, NOW, randomBytes(32));
  const payload =
    d.method === "eip3009"
      ? { signature: await acct.signTypedData(eip3009TypedData(r, d.authorization)), authorization: d.authorization }
      : { signature: await acct.signTypedData(permit2ExactTypedData(d.permit2Authorization)), permit2Authorization: d.permit2Authorization };
  return { acct, p: { x402Version: 2, accepted: r, payload } as PaymentPayload };
}

describe("buildAccepts", () => {
  const accepts = buildAccepts(ASSETS, 5.1, VAULT);
  it("offers one exact requirement per asset, USDT first, EIP-3009 where supported", () => {
    expect(accepts.map((a) => `${a.extra.name}:${a.extra.assetTransferMethod}`)).toEqual(["Tether USD:permit2-exact", "United Stables:eip3009"]);
    expect(accepts.every((a) => a.scheme === "exact" && a.network === "eip155:56" && a.payTo === VAULT)).toBe(true);
  });
  it("prices gift + fee in token units", () => {
    expect(accepts[0]!.amount).toBe("5100000000000000000");
  });
  it("never offers upto", () => {
    expect(accepts.some((a) => a.extra.assetTransferMethod === "permit2-upto")).toBe(false);
  });
});

describe("typed data", () => {
  const accepts = buildAccepts(ASSETS, 1.1, VAULT);
  it("Permit2-exact signatures recover to the payer", async () => {
    const { acct, p } = await signed(accepts[0]!);
    const a = (p.payload as any).permit2Authorization;
    expect(await recoverTypedDataAddress({ ...permit2ExactTypedData(a), signature: (p.payload as any).signature })).toBe(acct.address);
  });
  it("EIP-3009 signatures recover to the payer", async () => {
    const { acct, p } = await signed(accepts[1]!);
    const a = (p.payload as any).authorization;
    expect(await recoverTypedDataAddress({ ...eip3009TypedData(accepts[1]!, a), signature: (p.payload as any).signature })).toBe(acct.address);
  });
});

describe("checkPayload", () => {
  const accepts = buildAccepts(ASSETS, 1.1, VAULT);

  it("accepts a correct payload from the sender", async () => {
    for (const r of accepts) {
      const { acct, p } = await signed(r);
      expect(checkPayload(p, accepts, acct.address, NOW)).toMatchObject({ ok: true, payer: acct.address });
    }
  });

  it("requires accepted to match an offered requirement exactly (address case aside)", async () => {
    const { acct, p } = await signed(accepts[0]!);
    expect(sameRequirements({ ...accepts[0]!, payTo: VAULT.toLowerCase() }, accepts[0]!)).toBe(true);
    const tampered = { ...p, accepted: { ...p.accepted, amount: "1" } };
    expect(checkPayload(tampered, accepts, acct.address, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("does not match") });
  });

  it("rejects wrong amount, recipient, spender, payer and expired authorizations", async () => {
    const { acct, p } = await signed(accepts[0]!);
    const a = (p.payload as any).permit2Authorization;
    const mut = (f: (x: any) => void) => {
      const c = structuredClone(p) as any;
      f(c.payload.permit2Authorization);
      return checkPayload(c, accepts, acct.address, NOW);
    };
    expect(mut((x) => (x.permitted.amount = "1"))).toMatchObject({ ok: false, error: expect.stringContaining("amount") });
    expect(mut((x) => (x.witness.to = acct.address))).toMatchObject({ ok: false, error: expect.stringContaining("witness.to") });
    expect(mut((x) => (x.spender = acct.address))).toMatchObject({ ok: false, error: expect.stringContaining("spender") });
    expect(mut((x) => (x.deadline = String(NOW)))).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    expect(checkPayload(p, accepts, VAULT, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("sender") });
    expect(a.nonce).toMatch(/^\d+$/);

    const e = await signed(accepts[1]!);
    const c = structuredClone(e.p) as any;
    c.payload.authorization.to = e.acct.address;
    expect(checkPayload(c, accepts, e.acct.address, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("payTo") });
  });

  it("round-trips the PAYMENT-SIGNATURE header and rejects junk", async () => {
    const { p } = await signed(accepts[0]!);
    expect(decodePaymentHeader(encodeHeader(p))).toEqual(p);
    expect(decodePaymentHeader("not base64 json")).toBeNull();
    expect(decodePaymentHeader(encodeHeader({ hello: 1 }))).toBeNull();
    expect(decodePaymentHeader(undefined)).toBeNull();
  });
});

describe("browser signing requests", () => {
  const accepts = buildAccepts(ASSETS, 1.1, VAULT);

  it("JSON typed data (as a wallet gets it) signs to a payload the server accepts", async () => {
    for (const r of accepts) {
      const acct = privateKeyToAccount(generatePrivateKey());
      const req = signingRequest(r, acct.address, NOW, randomBytes(32));
      // Round-trip through JSON exactly like eth_signTypedData_v4 receives it.
      const wire = JSON.parse(JSON.stringify(req.typedData));
      expect(wire.types.EIP712Domain.map((f: any) => f.name)).toEqual(Object.keys(wire.domain));
      const signature = await acct.signTypedData(wire);
      const p = paymentPayloadFrom(r, req.draft, signature);
      expect(checkPayload(p, accepts, acct.address, NOW)).toMatchObject({ ok: true });
      // Recovers against the server's own (bigint) typed data.
      const td: any = req.method === "eip3009" ? eip3009TypedData(r, (req.draft as any).authorization) : permit2ExactTypedData((req.draft as any).permit2Authorization);
      expect(await recoverTypedDataAddress({ ...td, signature: signature as `0x${string}` })).toBe(acct.address);
    }
  });

  it("Permit2-exact domain has no version; EIP-3009 domain does", () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const p2 = signingRequest(accepts[0]!, acct.address, NOW, randomBytes(32));
    const e3 = signingRequest(accepts[1]!, acct.address, NOW, randomBytes(32));
    expect(p2.typedData.domain).toEqual({ name: "Permit2", chainId: 56, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" });
    expect(Object.keys(e3.typedData.domain)).toEqual(["name", "version", "chainId", "verifyingContract"]);
  });

  it("the one-time approve targets the canonical Permit2 contract", () => {
    const tx = permit2ApproveTx(accepts[0]!.asset);
    const d = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(tx.to).toBe(accepts[0]!.asset);
    expect(d.functionName).toBe("approve");
    expect(d.args).toEqual(["0x000000000022D473030F116dDEE9F6B43aC78BA3", maxUint256]);
  });
});
