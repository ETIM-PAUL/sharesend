"use client";

import { useEffect, useRef, useState } from "react";
import { chatApi, type ChatMessage, type GiftDraft } from "@/lib/agent";
import { Button, Input, Notice } from "./ui";

const EXAMPLES = ["Send Ada $5 of Nvidia, but only if it drops 0.5% by tomorrow 2PM", "$10 of the S&P 500 for my brother Tunde, happy birthday"];

/**
 * "Tell the agent": plain English in, a draft gift out. The assistant can only fill in the form below; you check it,
 * add your name and pay. It never sends or buys anything itself.
 */
export function ChatPanel({ onDraft }: { onDraft: (d: GiftDraft, userText: string) => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<GiftDraft | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatApi.enabled().then(setEnabled);
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, busy]);

  // Chat is optional: with no assistant switched on, the form below is all there is.
  if (!enabled) return null;

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);
    setDraft(null);
    try {
      const r = await chatApi.send(next, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      setMessages([...next, { role: "assistant", content: r.reply }]);
      if (r.draft) setDraft(r.draft);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Tell the agent" className="rounded-[10px] border border-rule bg-sheet">
      <div className="border-b border-rule px-4 py-3">
        <p className="numerals text-[1.05rem] font-semibold text-ink">Tell the agent</p>
        <p className="text-sm text-ink-soft">Describe the gift in your own words. It fills in the form below; you check it and pay.</p>
      </div>

      <div className="space-y-3 px-4 py-3">
        {messages.length === 0 ? (
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((e) => (
              <button key={e} type="button" onClick={() => send(e)} className="rounded-full border border-rule px-3 py-1.5 text-left text-sm text-ink-soft transition hover:border-engrave hover:text-ink">
                {e}
              </button>
            ))}
          </div>
        ) : (
          <ol className="space-y-2" aria-live="polite">
            {messages.map((m, i) => (
              <li key={i} className={m.role === "user" ? "text-right" : ""}>
                <span className={`inline-block max-w-[92%] rounded-[10px] px-3 py-2 text-left text-[0.95rem] ${m.role === "user" ? "bg-raise text-ink" : "text-ink"}`}>{m.content}</span>
              </li>
            ))}
            {busy ? <li className="text-sm text-ink-soft">Thinking…</li> : null}
            <div ref={endRef} />
          </ol>
        )}

        {draft ? (
          <div className="rounded-[10px] border border-engrave/50 bg-raise p-3">
            <p className="text-sm text-ink-soft">The draft</p>
            <p className="numerals text-lg font-semibold text-ink">
              ${draft.usd} of {draft.companyName} <span className="font-normal text-ink-soft">for {draft.recipientName}</span>
            </p>
            {draft.order ? (
              <p className="mt-1 text-sm text-notice-ink">
                Only if the price falls {draft.order.dropPct}% by {new Date(draft.order.deadline).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}. Otherwise you&apos;re refunded.
              </p>
            ) : null}
            <Button className="mt-3" onClick={() => onDraft(draft, [...messages].reverse().find((m) => m.role === "user")?.content ?? "")}>
              Fill in the form
            </Button>
          </div>
        ) : null}

        {error ? <Notice kind="error">{error}</Notice> : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex gap-2"
        >
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder={messages.length ? "Reply…" : "Who is it for, which stock, how much?"} maxLength={600} aria-label="Message to the agent" disabled={busy} />
          <button type="submit" disabled={busy || !input.trim()} className="shrink-0 rounded-full bg-engrave px-5 text-sm font-semibold text-on-engrave transition hover:brightness-110 disabled:opacity-50">
            Send
          </button>
        </form>
      </div>
    </section>
  );
}
