export type BinanceErrorKind = "http" | "api" | "timeout" | "network" | "compliance";

export class BinanceError extends Error {
  constructor(
    message: string,
    readonly kind: BinanceErrorKind,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "BinanceError";
  }

  get retryable(): boolean {
    if (this.kind === "timeout" || this.kind === "network") return true;
    return this.kind === "http" && (this.status === 429 || (this.status ?? 0) >= 500);
  }
}
