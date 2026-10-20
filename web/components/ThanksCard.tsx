import type { Thanks } from "@/lib/agent";

/** The recipient's one-time thank-you, shown read-only. */
export function ThanksCard({ from, thanks }: { from: string; thanks: Thanks }) {
  return (
    <section className="space-y-2 rounded-[10px] bg-sheet p-4" aria-label={`A thank-you from ${from}`}>
      <p className="text-sm font-medium text-ink-soft">{from} said thank you</p>
      <blockquote className="whitespace-pre-line border-l-2 border-engrave pl-3 text-[1.05rem] italic text-ink">{thanks.note}</blockquote>
    </section>
  );
}
