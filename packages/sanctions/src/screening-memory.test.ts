import { expect, test } from "bun:test";

// 40,628 generated entries, with 3 OFAC aliases and 5 EU/UK aliases each.
// Enforce an absolute retained-heap cap as well as a >50% reduction against
// the legacy index measured on the same populated fixture.
const INDEX_HEAP_CAP_BYTES = 200 * 1024 * 1024;
const FIXTURE_ENTRIES = 40_628;
const probePath = `${import.meta.dir}/test-fixtures/screening-memory-probe.ts`;

const measure = (mode: "compact" | "legacy") => {
  const result = Bun.spawnSync([process.execPath, probePath, mode], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  const output: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
  if (
    typeof output !== "object" ||
    output === null ||
    !("heap" in output) ||
    !("entries" in output) ||
    typeof output.heap !== "number" ||
    typeof output.entries !== "number"
  ) {
    throw new TypeError("Invalid screening memory probe result");
  }
  expect(output.entries).toBe(FIXTURE_ENTRIES);
  return output.heap;
};

test("full-size screening index stays within its retained heap budget", () => {
  // Separate processes include retained input data and avoid JIT/GC history
  // from one representation influencing the other's measurement.
  const compact = measure("compact");
  const legacy = measure("legacy");
  console.info(JSON.stringify({ compact, legacy, ratio: compact / legacy }));
  expect(compact).toBeGreaterThan(0);
  expect(compact).toBeLessThan(INDEX_HEAP_CAP_BYTES);
  expect(compact).toBeLessThan(legacy / 2);
}, 120_000);
