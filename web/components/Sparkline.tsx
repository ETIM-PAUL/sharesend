import { usd } from "@/lib/format";

/** A small value-over-time line. Engraving green, no axes: the first and last values are written out. */
export function Sparkline({ points, label }: { points: { t: number; usd: number }[]; label: string }) {
  if (points.length < 2) return null;
  const w = 320,
    h = 64,
    pad = 4;
  const ys = points.map((p) => p.usd);
  const min = Math.min(...ys),
    max = Math.max(...ys);
  const span = max - min || 1;
  const t0 = points[0]!.t,
    t1 = points[points.length - 1]!.t;
  const x = (t: number) => pad + ((t - t0) / (t1 - t0 || 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.usd).toFixed(1)}`).join(" ");
  const first = points[0]!,
    last = points[points.length - 1]!;
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" role="img" aria-label={`${label}: from ${usd(first.usd)} to ${usd(last.usd)}`}>
        <path d={d} fill="none" stroke="var(--engrave)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <circle cx={x(last.t)} cy={y(last.usd)} r="3" fill="var(--engrave)" />
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-ink-soft">
        <span>{new Date(first.t).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
        <span>Now</span>
      </figcaption>
    </figure>
  );
}
