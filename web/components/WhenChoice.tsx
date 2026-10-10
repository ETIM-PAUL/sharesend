"use client";

import { Input } from "./ui";

export interface When {
  mode: "now" | "drop";
  /** Percent, as typed. */
  dropPct: string;
  /** datetime-local value (the browser's own time zone). Filled in when "drop" is first chosen. */
  deadline: string;
}

export const WHEN_NOW: When = { mode: "now", dropPct: "0.5", deadline: "" };

const pad = (n: number) => String(n).padStart(2, "0");

/** A Date as the value a datetime-local input wants, in the browser's time zone. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Tomorrow, 2PM local: a sensible starting deadline. Called from an event handler, never during render. */
export function defaultDeadline(): string {
  const d = new Date(Date.now() + 24 * 3_600_000);
  d.setHours(14, 0, 0, 0);
  return toLocalInput(d);
}

/**
 * The order for the server, or why the form's values can't be one. Pass `now` at submit time to also check the deadline's
 * range; without it only the shape is checked, so it's safe to call while rendering (no clock read).
 */
export function readWhen(w: When, now?: number): { ok: true; order: { dropPct: number; deadline: string } | null } | { ok: false; error: string } {
  if (w.mode === "now") return { ok: true, order: null };
  const drop = Number(w.dropPct);
  if (!(drop > 0 && drop <= 50)) return { ok: false, error: "Choose a price drop above 0% and up to 50%." };
  const t = new Date(w.deadline).getTime();
  if (!w.deadline || Number.isNaN(t)) return { ok: false, error: "Choose when to stop waiting." };
  if (now !== undefined) {
    if (t - now < 10 * 60_000) return { ok: false, error: "The deadline needs to be at least 10 minutes from now." };
    if (t - now > 7 * 86_400_000) return { ok: false, error: "I can wait at most 7 days for a price." };
  }
  return { ok: true, order: { dropPct: Math.round(drop * 1000) / 1000, deadline: new Date(t).toISOString() } };
}

/** Buy right away, or wait for the price to drop. */
export function WhenChoice({ value, onChange }: { value: When; onChange: (w: When) => void }) {
  const pick = (mode: When["mode"]) => onChange({ ...value, mode, deadline: mode === "drop" && !value.deadline ? defaultDeadline() : value.deadline });
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-ink">When to buy</legend>
      <div className="space-y-2">
        <label className={`flex cursor-pointer items-start gap-3 rounded-[10px] border px-3.5 py-3 ${value.mode === "now" ? "border-engrave bg-sheet" : "border-rule"}`}>
          <input type="radio" name="when" className="mt-1 accent-[var(--engrave)]" checked={value.mode === "now"} onChange={() => pick("now")} />
          <span>
            <span className="block text-[0.95rem] font-medium text-ink">Right away</span>
            <span className="block text-xs text-ink-soft">The agent buys as soon as you&apos;ve paid.</span>
          </span>
        </label>
        <div className={`rounded-[10px] border px-3.5 py-3 ${value.mode === "drop" ? "border-engrave bg-sheet" : "border-rule"}`}>
          <label className="flex cursor-pointer items-start gap-3">
            <input type="radio" name="when" className="mt-1 accent-[var(--engrave)]" checked={value.mode === "drop"} onChange={() => pick("drop")} />
            <span>
              <span className="block text-[0.95rem] font-medium text-ink">When the price drops</span>
              <span className="block text-xs text-ink-soft">You pay now. The agent buys if the price falls enough before your deadline, and refunds you in full if it doesn&apos;t.</span>
            </span>
          </label>
          {value.mode === "drop" ? (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs text-ink-soft">Drops by (%)</span>
                <Input inputMode="decimal" value={value.dropPct} onChange={(e) => onChange({ ...value, dropPct: e.target.value.replace(/[^0-9.]/g, "") })} className="numerals" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-ink-soft">Wait until</span>
                <Input type="datetime-local" value={value.deadline} onChange={(e) => onChange({ ...value, deadline: e.target.value })} />
              </label>
            </div>
          ) : null}
        </div>
      </div>
    </fieldset>
  );
}
