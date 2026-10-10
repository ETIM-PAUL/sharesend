import Link from "next/link";

/** ShareSend, set like a ticker symbol: the slash is the send. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <Link href="/" aria-label="ShareSend home" className={`numerals inline-flex items-baseline gap-0.5 text-xl font-bold tracking-tight text-ink ${className}`}>
      Share<span className="text-engrave">/</span>Send
    </Link>
  );
}
