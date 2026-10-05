// First authenticated call: POST /api/v2/b402/supported (Phase 1 "Done when").
import { request } from "../binance/client.js";
import { BinanceError } from "../binance/errors.js";

const startedAt = new Date().toISOString();
try {
  const { data } = await request<any>("POST", "/api/v2/b402/supported", { body: { body: {} } });
  console.log(`[${startedAt}] OK POST /api/v2/b402/supported`);
  const byAsset = new Map<string, string[]>();
  for (const k of data?.kinds ?? []) {
    const name = `${k.extra?.name ?? "?"} (${k.network})`;
    byAsset.set(name, [...(byAsset.get(name) ?? []), `${k.scheme}/${k.extra?.assetTransferMethod}`]);
  }
  for (const [name, methods] of byAsset) console.log(`  ${name}: ${methods.join(", ")}`);
  console.log(`  response keys: ${Object.keys(data ?? {}).join(", ")}`);
} catch (e) {
  if (e instanceof BinanceError) {
    console.error(`[${startedAt}] FAIL kind=${e.kind} status=${e.status ?? "-"} code=${e.code ?? "-"}: ${e.message}`);
  } else {
    console.error(`[${startedAt}] FAIL ${(e as Error).message}`);
  }
  process.exit(1);
}
