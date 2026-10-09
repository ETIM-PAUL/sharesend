// Gifts sent from this browser. Kept on the sender's device only; claim links are never stored.
export interface SentGift {
  id: string;
  ticker: string;
  companyName: string;
  usd: number;
  recipientName: string;
  message: string;
  senderAddress: string;
  sentAt: string;
}

const KEY = "sharesend:sent";

export function listSent(): SentGift[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function getSent(id: string): SentGift | undefined {
  return listSent().find((g) => g.id === id);
}

export function saveSent(g: SentGift): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([g, ...listSent().filter((x) => x.id !== g.id)].slice(0, 50)));
  } catch {
    // Storage blocked (private mode): the gift still exists; only this device's list is missing it.
  }
}
