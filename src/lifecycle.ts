import type { ExecutionState } from "./task-store.js";

export function mapRemoteState(state: unknown, status: unknown, alive: unknown, settled: unknown): ExecutionState {
  const values = [state, status].filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
  if (values.includes("failed")) return "failed";
  if (values.includes("stopped")) return "cancelled";
  if (values.includes("done") || values.includes("succeeded") || (alive !== false && settled === true)) return "succeeded";
  if (alive === false && settled === true) return "cancelled";
  if (alive === false) return "unknown";
  if (values.includes("blocked") || values.includes("waiting")) return "waiting_input";
  return "running";
}
