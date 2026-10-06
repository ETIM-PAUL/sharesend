// Market API: price history. Valid `bar` values come from the API's own error message.
import { request } from "./client.js";

export const CANDLE_BARS = ["1s", "5s", "30s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"] as const;
export type CandleBar = (typeof CANDLE_BARS)[number];

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number; // ms
  trades: number;
}

export async function getCandles(binanceChainId: string, tokenContractAddress: string, bar?: CandleBar, limit?: number): Promise<Candle[]> {
  const { data } = await request<number[][]>("GET", "/api/v1/dex/market/candles", {
    query: { binanceChainId, tokenContractAddress, bar, limit },
  });
  // Row layout observed live: [open, high, low, close, volume, timeMs, trades].
  return data.map(([open, high, low, close, volume, time, trades]) => ({
    open: open ?? 0,
    high: high ?? 0,
    low: low ?? 0,
    close: close ?? 0,
    volume: volume ?? 0,
    time: time ?? 0,
    trades: trades ?? 0,
  }));
}
