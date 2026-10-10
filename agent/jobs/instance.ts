// The process-wide scheduler, started from index.ts and read by /agent/status.
import type { Scheduler } from "./runner.js";

let current: Scheduler | null = null;
export const setScheduler = (s: Scheduler | null) => void (current = s);
export const getScheduler = () => current;
