import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { BinanceError } from "./errors.js";

// Signing per https://web3.binance.com/en/dev-docs/authentication:
// X-OC-SIGN = base64(HMAC-SHA256(timestamp + METHOD + requestPath + body)).
// requestPath includes the /build prefix and excludes the query string (per the B402 integration guide).
export function sign(secret: string, timestamp: string, method: string, requestPath: string, body: string): string {
  return createHmac("sha256", secret).update(timestamp + method + requestPath + body).digest("base64");
}

// Envelope success codes seen in the docs: "000000" (data APIs) and "000000000" (B402).
const SUCCESS_CODES = new Set(["0", "000000", "000000000"]);

export interface RequestOpts {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
}

export interface ApiResult<T> {
  data: T;
  fetchedAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function request<T>(method: "GET" | "POST", path: string, opts: RequestOpts = {}): Promise<ApiResult<T>> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await once<T>(method, path, opts);
    } catch (e) {
      if (!(e instanceof BinanceError) || !e.retryable || attempt >= retries) throw e;
      await sleep(300 * 2 ** attempt);
    }
  }
}

async function once<T>(method: "GET" | "POST", path: string, opts: RequestOpts): Promise<ApiResult<T>> {
  const base = new URL(config.binanceBaseUrl);
  const requestPath = base.pathname.replace(/\/$/, "") + path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const url = base.origin + requestPath + (qs.size ? `?${qs}` : "");
  const body = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const timestamp = new Date().toISOString();
  // Built before the fetch so a missing key surfaces as a config error, not a network error.
  const headers = {
    "Content-Type": "application/json",
    "X-OC-APIKEY": config.binanceApiKey,
    "X-OC-TIMESTAMP": timestamp,
    "X-OC-SIGN": sign(config.binanceApiSecret, timestamp, method, requestPath, body),
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  let res: Response;
  try {
    res = await fetch(url, { method, body: body || undefined, signal: ctrl.signal, headers });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new BinanceError(`Timeout calling ${path}`, "timeout");
    throw new BinanceError(`Network error calling ${path}: ${(e as Error).message}`, "network");
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const code = json?.code === undefined ? undefined : String(json.code);
  const msg = json?.message ?? json?.msg ?? text.slice(0, 200);

  if (code === "40304") throw new BinanceError(`Compliance restriction (40304) on ${path}: ${msg}`, "compliance", res.status, code);
  if (!res.ok) throw new BinanceError(`HTTP ${res.status} on ${path}: ${msg}`, "http", res.status, code);
  if (code !== undefined && !SUCCESS_CODES.has(code)) throw new BinanceError(`API error ${code} on ${path}: ${msg}`, "api", res.status, code);

  return { data: (json?.data ?? json) as T, fetchedAt: Date.now() };
}
