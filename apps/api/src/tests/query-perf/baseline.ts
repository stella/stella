import { panic } from "better-result";

type BaselineMetrics = { sharedBlocks: number; executionTimeMs: number };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseQueryPerfBaselineFile = (value: unknown) => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["seedId", "settingsDigest", "entries"].includes(key),
    ) ||
    typeof value["seedId"] !== "string" ||
    value["seedId"].trim().length === 0 ||
    typeof value["settingsDigest"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value["settingsDigest"]) ||
    !isRecord(value["entries"])
  ) {
    return panic("Malformed query perf baseline");
  }
  const entries: Record<string, BaselineMetrics> = {};
  for (const [id, metrics] of Object.entries(value["entries"])) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) ||
      !isRecord(metrics) ||
      Object.keys(metrics).some(
        (key) => !["sharedBlocks", "executionTimeMs"].includes(key),
      ) ||
      typeof metrics["sharedBlocks"] !== "number" ||
      !Number.isSafeInteger(metrics["sharedBlocks"]) ||
      metrics["sharedBlocks"] <= 0 ||
      typeof metrics["executionTimeMs"] !== "number" ||
      !Number.isFinite(metrics["executionTimeMs"]) ||
      metrics["executionTimeMs"] <= 0 ||
      !Number.isSafeInteger(Math.round(metrics["executionTimeMs"] * 1000))
    ) {
      return panic(`Malformed query perf baseline entry ${id}`);
    }
    entries[id] = {
      sharedBlocks: metrics["sharedBlocks"],
      executionTimeMs: metrics["executionTimeMs"],
    };
  }
  if (Object.keys(entries).length === 0) {
    return panic("Query perf baseline has no entries");
  }
  return {
    seedId: value["seedId"],
    settingsDigest: value["settingsDigest"],
    entries,
  };
};
