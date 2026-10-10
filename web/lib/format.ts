export const usd = (n: number) => `$${n.toFixed(2)}`;

export function units(raw: string, decimals = 18, maxFrac = 4): string {
  const s = BigInt(raw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "").slice(0, maxFrac).padEnd(2, "0");
  return `${whole}.${frac}`;
}

export function shares(n: number): string {
  if (!(n > 0)) return "0";
  if (n >= 1) return n.toFixed(4);
  // Show enough digits to see the slice: 0.0208, 0.00412
  const digits = Math.max(4, 2 - Math.floor(Math.log10(n)) + 2);
  return n.toFixed(Math.min(digits, 8));
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const POPULAR = [
  { ticker: "NVDA", name: "Nvidia" },
  { ticker: "AAPL", name: "Apple" },
  { ticker: "TSLA", name: "Tesla" },
  { ticker: "SPY", name: "S&P 500 fund" },
  { ticker: "QQQ", name: "Nasdaq-100 fund" },
  { ticker: "GOOGL", name: "Alphabet" },
];

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
