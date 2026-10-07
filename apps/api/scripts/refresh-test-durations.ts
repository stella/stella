import { panic } from "better-result";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import { formattedLikeRepository } from "../../../scripts/generated-artifacts";
import { listApiTestPaths } from "./api-test-plan";
import durations from "./test-durations.json";
import {
  assertTestDurations,
  MISSING_TEST_DURATION,
  readDurationWeights,
  readTimingArtifact,
  TEST_DURATION_SOURCE,
} from "./test-timings";

// Bootstrap estimates allocate a batch's unreported setup equally across its
// files, added to each file's reported body time. New files reserve the median
// live setup-inclusive weight (at least one second) until CI measures them.
// Native timing artifacts replace estimates with measured whole-file seconds.
// Download api-test-timings-* artifacts from a successful merge-group/main run,
// then run --write <downloaded-artifact-directory>... and commit the result.
// CI reports measured drift as warnings; it never refreshes committed weights.

/** Later artifacts replace earlier measurements; output order is canonical. */
export const refreshedTestDurations = (
  previous: unknown,
  artifacts: readonly string[],
) => {
  const refreshed = readDurationWeights(previous);
  for (const artifact of artifacts) {
    for (const [file, seconds] of Object.entries(
      readTimingArtifact(artifact),
    )) {
      refreshed[file] = { seconds, source: TEST_DURATION_SOURCE.measured };
    }
  }
  return refreshed;
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

type EstimateMissingTestDurationsOptions = {
  files: readonly string[];
  previous: ReturnType<typeof readDurationWeights>;
};

export const estimateMissingTestDurations = ({
  files,
  previous,
}: EstimateMissingTestDurationsOptions) => {
  const weights = files
    .flatMap((file) =>
      previous[file] === undefined ? [] : [previous[file].seconds],
    )
    .toSorted((a, b) => a - b);
  const estimate = Math.max(1, weights.at(Math.floor(weights.length / 2)) ?? 1);
  return Object.fromEntries(
    files.map((file) => [
      file,
      previous[file] ?? {
        seconds: estimate,
        source: TEST_DURATION_SOURCE.estimated,
      },
    ]),
  );
};

/** Append estimates without reserializing, rounding or deleting existing entries. */
export const addMissingTestDurations = (
  text: string,
  files: readonly string[],
) => {
  const previous = readDurationWeights(JSON.parse(text));
  const missing = files.filter((file) => previous[file] === undefined);
  if (missing.length === 0) {
    return text;
  }
  const estimated = estimateMissingTestDurations({ files, previous });
  const additions = Object.fromEntries(
    missing.toSorted(compareCodeUnit).map((file) => [file, estimated[file]]),
  );
  const closing = text.lastIndexOf("}");
  const prefix = text.slice(0, closing).trimEnd();
  const entries = serializeTestDurations(additions).slice(2, -3);
  return `${prefix}${Object.keys(previous).length > 0 ? "," : ""}\n${entries}\n${text.slice(closing)}`;
};

/**
 * Without timings, --check is the pull-request gate; with a shard's timings it
 * runs after merge, where drift and gaps are advisory.
 */
export const missingTestDurationMode = (timingInputs: readonly string[]) =>
  timingInputs.length === 0
    ? MISSING_TEST_DURATION.fail
    : MISSING_TEST_DURATION.warn;

if (import.meta.main) {
  const [mode, ...inputs] = process.argv.slice(2);
  if (mode !== "--write" && mode !== "--check" && mode !== "--add-missing") {
    panic(
      "Usage: bun apps/api/scripts/refresh-test-durations.ts --write|--check [timings.json|directory]... | --add-missing",
    );
  }
  if (mode === "--add-missing") {
    if (inputs.length > 0) {
      panic("--add-missing does not accept timing artifacts");
    }
    const destination = new URL("test-durations.json", import.meta.url);
    const text = readFileSync(destination, "utf-8");
    const updated = addMissingTestDurations(
      text,
      listApiTestPaths(path.resolve(import.meta.dirname, "..")),
    );
    if (updated !== text) {
      writeFileSync(destination, updated);
    }
    process.exit(0);
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
  const measurements = refreshedTestDurations(
    {},
    artifacts.map((file) => readFileSync(file, "utf-8")),
  );
  const files = listApiTestPaths(path.resolve(import.meta.dirname, ".."));
  if (mode === "--check") {
    assertTestDurations({
      files,
      durations: readDurationWeights(durations),
      missing: missingTestDurationMode(inputs),
      measurements: Object.fromEntries(
        Object.entries(measurements).map(([file, entry]) => [
          file,
          entry.seconds,
        ]),
      ),
    });
    console.log(
      `API test durations cover ${files.length} files; reviewed available measurements`,
    );
  } else {
    const liveDurations = estimateMissingTestDurations({
      files,
      previous: { ...readDurationWeights(durations), ...measurements },
    });
    writeFileSync(
      new URL("test-durations.json", import.meta.url),
      await formattedLikeRepository(
        serializeTestDurations(liveDurations),
        "json",
      ),
    );
    console.log(
      `Refreshed API test durations from ${artifacts.length} artifacts`,
    );
  }
}
