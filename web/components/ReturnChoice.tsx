"use client";

export type ReturnAs = "stock" | "usdt";

const OPTIONS: { value: ReturnAs; title: string; text: string }[] = [
  { value: "stock", title: "The stock", text: "It goes back to your wallet as the same token." },
  { value: "usdt", title: "USDT", text: "We sell it and send you the dollars. You get what it sells for, a little more or less than you paid." },
];

/** What happens if the gift isn't claimed in time, or you cancel it. */
export function ReturnChoice({ value, onChange, disabled, legend = "If it isn't claimed, I want back" }: { value: ReturnAs; onChange: (v: ReturnAs) => void; disabled?: boolean; legend?: string }) {
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium text-ink">{legend}</legend>
      <div className="space-y-2">
        {OPTIONS.map((o) => (
          <label key={o.value} className={`flex cursor-pointer items-start gap-3 rounded-[10px] border px-3.5 py-3 ${value === o.value ? "border-engrave bg-sheet" : "border-rule"} ${disabled ? "opacity-60" : ""}`}>
            <input type="radio" name="return-as" className="mt-1 accent-[var(--engrave)]" checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>
              <span className="block text-[0.95rem] font-medium text-ink">{o.title}</span>
              <span className="block text-xs text-ink-soft">{o.text}</span>
            </span>
          </label>
        ))}
      </div>
      {value === "usdt" ? <p className="mt-2 text-xs text-ink-soft">Selling needs the stock market to be open. If it can&apos;t be sold within a day, you get the stock back instead.</p> : null}
    </fieldset>
  );
}
