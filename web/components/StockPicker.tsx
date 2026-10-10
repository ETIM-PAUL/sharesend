"use client";

import { useEffect, useRef, useState } from "react";
import { agent } from "@/lib/agent";
import { POPULAR } from "@/lib/format";
import { Input } from "./ui";

export interface Stock {
  ticker: string;
  name: string;
}

export function StockPicker({ value, onChange }: { value: Stock | null; onChange: (s: Stock) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Stock[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) return;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await agent.search(query);
        if (n === seq.current) {
          setResults(r.results.map((x) => ({ ticker: x.ticker, name: x.name })));
          setError(null);
        }
      } catch (e) {
        if (n === seq.current) setError((e as Error).message);
      } finally {
        if (n === seq.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const open = q.trim().length >= 2;
  const pick = (s: Stock) => {
    onChange(s);
    setQ("");
    setResults([]);
  };

  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-ink">Stock</span>
      <div className="flex flex-wrap gap-2" role="listbox" aria-label="Popular stocks">
        {POPULAR.map((s) => {
          const on = value?.ticker === s.ticker;
          return (
            <button
              key={s.ticker}
              type="button"
              role="option"
              aria-selected={on}
              onClick={() => pick(s)}
              className={`rounded-full border px-3 py-1.5 text-sm transition ${on ? "border-engrave bg-engrave text-on-engrave" : "border-rule bg-sheet text-ink hover:border-engrave"}`}
            >
              <span className="font-semibold">{s.ticker}</span> <span className={on ? "text-on-engrave/70" : "text-ink-soft"}>{s.name}</span>
            </button>
          );
        })}
      </div>
      <div className="relative mt-3">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={value && !POPULAR.some((p) => p.ticker === value.ticker) ? `${value.ticker}: ${value.name}` : "Or search: Microsoft, Coca-Cola, AMD…"}
          aria-label="Search stocks"
          autoComplete="off"
        />
        {open ? (
          <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-[10px] border border-rule bg-sheet shadow-lg">
            {searching && results.length === 0 ? <li className="px-3.5 py-3 text-sm text-ink-soft">Searching…</li> : null}
            {error ? <li className="px-3.5 py-3 text-sm text-error-ink">{error}</li> : null}
            {!searching && !error && results.length === 0 ? <li className="px-3.5 py-3 text-sm text-ink-soft">No stock by that name on ShareSend yet.</li> : null}
            {results.map((r) => (
              <li key={r.ticker}>
                <button type="button" onClick={() => pick(r)} className="flex w-full items-baseline gap-2 px-3.5 py-2.5 text-left hover:bg-paper">
                  <span className="font-semibold text-ink">{r.ticker}</span>
                  <span className="truncate text-sm text-ink-soft">{r.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
