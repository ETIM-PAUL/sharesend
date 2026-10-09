// Pays a gift from any EIP-1193 wallet (Privy external or email wallet). The agent builds the exact EIP-712
// data to sign; this file only relays it, so signing and checking share one tested implementation.
import { agent, type Draft } from "./agent";

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export async function waitForReceipt(provider: Eip1193, hash: string, timeoutMs = 120_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = (await provider.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: string } | null;
    if (r) return r.status === "0x1";
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  return false;
}

/** The one-time Permit2 approval for USDT/USDC. Returns once it's confirmed. */
export async function approveOnce(provider: Eip1193, from: string, draft: Draft): Promise<void> {
  if (!draft.approveTx) return;
  const hash = (await provider.request({ method: "eth_sendTransaction", params: [{ from, ...draft.approveTx }] })) as string;
  if (!(await waitForReceipt(provider, hash))) throw new Error("The approval didn't go through. Try again.");
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Signs the drafted payment and submits it. Returns the agent's answer, including the claim link. */
export async function signAndPay(provider: Eip1193, from: string, giftId: string, draft: Draft) {
  const signature = (await provider.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(draft.typedData)] })) as string;
  const inner =
    draft.method === "eip3009"
      ? { signature, authorization: draft.draft.authorization }
      : { signature, permit2Authorization: draft.draft.permit2Authorization };
  const payload = { x402Version: 2, resource: draft.resource, accepted: draft.requirement, payload: inner };
  return agent.pay(giftId, toBase64(JSON.stringify(payload)));
}
