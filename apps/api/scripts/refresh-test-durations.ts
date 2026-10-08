import { panic } from "better-result";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import type { readDurationWeights } from "./test-timings";
import { readTimingArtifact, TEST_DURATION_SOURCE } from "./test-timings";

/** Later artifacts replace earlier measurements; output order is canonical. */
export const refreshedTestDurations = (artifacts: readonly string[]) => {
  const refreshed = new Map<string, number>();
  for (const artifact of artifacts) {
    for (const [file, seconds] of Object.entries(
      readTimingArtifact(artifact),
    )) {
      refreshed.set(file, seconds);
    }
  }
  return Object.fromEntries(
    Array.from(refreshed, ([file, seconds]) => [
      file,
      { seconds, source: TEST_DURATION_SOURCE.measured },
    ]),
  );
};

export const serializeTestDurations = (
  weights: ReturnType<typeof readDurationWeights>,
) =>
  `${JSON.stringify(
    Object.fromEntries(
      Object.entries(weights)
        .toSorted(([a], [b]) => compareCodeUnit(a, b))
        .map(([file, { seconds, source }]) => [
          file,
          { seconds: Number(seconds.toFixed(6)), source },
        ]),
    ),
    null,
    2,
  )}\n`;

if (import.meta.main) {
  const [mode, destination, ...inputs] = process.argv.slice(2);
  if (mode !== "--write" || destination === undefined || inputs.length === 0) {
    panic(
      "Usage: bun apps/api/scripts/refresh-test-durations.ts --write <destination.json> <timings.json|directory>...",
    );
  }
  const artifacts = inputs.flatMap((input) =>
    input.endsWith(".json")
      ? [input]
      : readdirSync(input)
          .filter((file) => file.endsWith(".json"))
          .map((file) => path.join(input, file))
          .toSorted(
            (a, b) =>
              statSync(a).mtimeMs - statSync(b).mtimeMs ||
              compareCodeUnit(a, b),
          ),
  );
  const durations = refreshedTestDurations(
    artifacts.map((file) => readFileSync(file, "utf-8")),
  );
  writeFileSync(destination, serializeTestDurations(durations));
  console.log(
    `Aggregated API test durations from ${artifacts.length} artifacts`,
  );
}
