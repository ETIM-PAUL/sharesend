/** A failed model call, described safely: status, type and message only. Never carries a key. */
export class LlmError extends Error {
  constructor(message: string, public readonly status?: number, public readonly type?: string) {
    super(message);
    this.name = "LlmError";
  }
}

export function describeLlmError(e: unknown): string {
  if (e instanceof LlmError) return [e.status ? `HTTP ${e.status}` : null, e.type ?? null, e.message].filter(Boolean).join(": ").slice(0, 300);
  const err = e as { status?: number; name?: string; message?: string; error?: { error?: { type?: string; message?: string } } };
  const type = err.error?.error?.type;
  const msg = err.error?.error?.message ?? err.message ?? String(e);
  return [err.status ? `HTTP ${err.status}` : null, type ?? err.name ?? null, msg].filter(Boolean).join(": ").slice(0, 300);
}
