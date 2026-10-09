import { useSyncExternalStore } from "react";

const noop = () => () => {};

/** False during server render and hydration, true after: for reading browser-only storage without a mismatch. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}
