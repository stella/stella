import { panic, Result } from "better-result";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import {
  learnTestRssFeedback,
  readTestRssFeedback,
  readTestRssObservations,
  serializeTestRssFeedback,
  TEST_RSS_OBSERVATIONS_SUFFIX,
  type TestRssFeedback,
} from "./test-rss-feedback";

type RefreshTestRssFeedbackOptions = {
  /** Whether a test file still exists; feedback for any other is dropped. */
  isLive: (file: string) => boolean;
  base: string | undefined;
  observationFiles: readonly string[];
};

/**
 * Fold one run's batch observations into the learned surcharges. An
 * unreadable base (for example an older cache schema) must not block every
 * later refresh; the next observations rebuild it.
 */
export const refreshedTestRssFeedback = ({
  isLive,
  base,
  observationFiles,
}: RefreshTestRssFeedbackOptions): TestRssFeedback => {
  const previous =
    base === undefined
      ? {}
      : Result.try(() => readTestRssFeedback(JSON.parse(base))).unwrapOr(
          undefined,
        );
  if (previous === undefined) {
    console.log(
      "::notice::Ignoring unreadable previous API test memory feedback",
    );
  }
  const observations = observationFiles.flatMap((contents) =>
    readTestRssObservations(contents),
  );
  const named = new Set([
    ...Object.keys(previous ?? {}),
    ...observations.flatMap(({ files }) => files.map(({ path: file }) => file)),
  ]);
  return learnTestRssFeedback({
    base: previous ?? {},
    observations,
    liveFiles: [...named].filter((file) => isLive(file)),
  });
};

if (import.meta.main) {
  const [mode, destination, baseFlag, basePath, ...inputs] =
    process.argv.slice(2);
  if (
    mode !== "--write" ||
    destination === undefined ||
    baseFlag !== "--base" ||
    basePath === undefined ||
    inputs.length === 0
  ) {
    panic(
      `Usage: bun apps/api/scripts/refresh-test-rss-feedback.ts --write <destination.json> --base <base.json|missing> <observations${TEST_RSS_OBSERVATIONS_SUFFIX}|directory>...`,
    );
  }
  const apiRoot = path.resolve(import.meta.dir, "..");
  const observationPaths = inputs
    .flatMap((input) =>
      input.endsWith(TEST_RSS_OBSERVATIONS_SUFFIX)
        ? [input]
        : readdirSync(input)
            .filter((file) => file.endsWith(TEST_RSS_OBSERVATIONS_SUFFIX))
            .map((file) => path.join(input, file)),
    )
    .toSorted(compareCodeUnit);
  const feedback = refreshedTestRssFeedback({
    isLive: (file) => existsSync(path.join(apiRoot, file)),
    base: basePath === "missing" ? undefined : readFileSync(basePath, "utf-8"),
    observationFiles: observationPaths.map((file) =>
      readFileSync(file, "utf-8"),
    ),
  });
  writeFileSync(destination, serializeTestRssFeedback(feedback));
  console.log(
    `Learned API test memory surcharges for ${Object.keys(feedback).length} files from ${observationPaths.length} observation files`,
  );
}
