// Small shared pieces. Buttons are pills (they act, like a message's send button); fields are softly squared.
import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Button({ variant = "primary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "quiet" | "whatsapp" }) {
  const look =
    variant === "primary"
      ? "bg-engrave text-sheet hover:brightness-110"
      : variant === "whatsapp"
        ? "bg-whatsapp text-white hover:brightness-110"
        : "border border-rule text-ink hover:bg-sheet";
  return (
    <button
      {...p}
      className={`w-full rounded-full px-5 py-3.5 text-[0.98rem] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${look} ${className}`}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-soft">{hint}</span> : null}
    </label>
  );
}

const fieldCls = "w-full rounded-[10px] border border-rule bg-sheet px-3.5 py-3 text-[1rem] text-ink placeholder:text-ink-soft/70 focus:border-engrave focus:outline-none";

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={`${fieldCls} ${p.className ?? ""}`} />;
}

export function TextArea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={`${fieldCls} min-h-20 resize-none ${p.className ?? ""}`} />;
}

export function Notice({ kind = "info", children }: { kind?: "info" | "error"; children: React.ReactNode }) {
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`rounded-[10px] px-3.5 py-3 text-sm ${kind === "error" ? "bg-error-bg text-error-ink" : "bg-notice-bg text-notice-ink"}`}>
      {children}
    </div>
  );
}
