#!/usr/bin/env bun
import { Result, TaggedError } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { listApiTestPaths } from "./api-test-plan";
import {
  measuredTestRssTable,
  readTestRssEnvironment,
  readTestRssSource,
  type TestRssEnvironment,
  type TestRssFile,
  type TestRssTable,
  type TestRssSource,
} from "./test-batch-plan";

class PeakRssRefreshError extends TaggedError("PeakRssRefreshError")<{
  message: string;
}> {}

const reject: (message: string) => never = (message) => {
  throw new PeakRssRefreshError({ message });
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const safeTestPath = (file: string) =>
  file.length > 0 &&
  !file.includes("\\") &&
  !file.includes("\0") &&
  !path.posix.isAbsolute(file) &&
  !path.win32.isAbsolute(file) &&
  !/^[a-z]:/iu.test(file) &&
  file.split("/").every((part) => part !== "" && part !== "." && part !== "..");

type ParseMeasurementOptions = {
  value: unknown;
  receipt: string;
  baselineMb: number;
  source: TestRssSource;
};

const parseMeasurement = ({
  value,
  receipt,
  baselineMb,
  source,
}: ParseMeasurementOptions) => {
  if (!isRecord(value)) {
    reject(`Invalid measurement in ${receipt}`);
  }
  const file = value["file"];
  const peakMb = value["peakMb"];
  if (typeof file !== "string" || !safeTestPath(file)) {
    reject(`Unsafe test path in ${receipt}`);
  }
  if (!positiveFinite(peakMb)) {
    reject(`Invalid peak RSS for ${file}`);
  }
  if (value["exitCode"] !== 0) {
    reject(`Failed test measurement: ${file}`);
  }
  return { file, row: { peakMb, baselineMb, source } };
};

type ParseReceiptOptions = {
  artifactDirectory: string;
  receipt: string;
  expectedEnvironment: TestRssEnvironment | undefined;
};

const parseReceipt = ({
  artifactDirectory,
  receipt,
  expectedEnvironment,
}: ParseReceiptOptions) => {
  const parsed = Result.try((): unknown =>
    JSON.parse(readFileSync(path.join(artifactDirectory, receipt), "utf-8")),
  );
  if (parsed.isErr()) {
    reject(`Invalid JSON receipt: ${receipt}`);
  }
  const payload = parsed.value;
  if (
    !isRecord(payload) ||
    payload["version"] !== 1 ||
    !Array.isArray(payload["measurements"]) ||
    payload["measurements"].length === 0
  ) {
    reject(`Invalid measurement receipt: ${receipt}`);
  }
  const environment = readTestRssEnvironment(payload["environment"]);
  const source = readTestRssSource(payload["source"]);
  const baselineMb = payload["baselineMb"];
  if (!positiveFinite(baselineMb)) {
    reject(`Invalid baseline RSS in ${receipt}`);
  }
  if (
    expectedEnvironment !== undefined &&
    JSON.stringify(expectedEnvironment) !== JSON.stringify(environment)
  ) {
    reject(`Mixed measurement environments: ${receipt}`);
  }
  return {
    environment,
    source,
    baselineMb,
    measurements: payload["measurements"],
  };
};

const validatedRow = (
  file: string,
  measured: ReadonlyMap<string, TestRssFile>,
) => {
  const row = measured.get(file);
  if (row === undefined) {
    reject(`Missing validated measurement: ${file}`);
  }
  return row;
};

type ChangeReportOptions = {
  files: readonly string[];
  measured: ReadonlyMap<string, TestRssFile>;
  previousPeaks: Readonly<Record<string, number>>;
};

const changeReport = ({
  files,
  measured,
  previousPeaks,
}: ChangeReportOptions) => {
  const newFiles: string[] = [];
  let biggestRelativeChange:
    | {
        file: string;
        previousPeakMb: number;
        peakMb: number;
        relativeChange: number;
      }
    | undefined;
  for (const file of files) {
    const row = validatedRow(file, measured);
    const previousPeakMb = previousPeaks[file];
    if (previousPeakMb === undefined) {
      newFiles.push(file);
      continue;
    }
    if (!positiveFinite(previousPeakMb)) {
      reject(`Invalid previous peak RSS for ${file}`);
    }
    const relativeChange = (row.peakMb - previousPeakMb) / previousPeakMb;
    if (
      biggestRelativeChange === undefined ||
      Math.abs(relativeChange) > Math.abs(biggestRelativeChange.relativeChange)
    ) {
      biggestRelativeChange = {
        file,
        previousPeakMb,
        peakMb: row.peakMb,
        relativeChange,
      };
    }
  }
  return { newFiles, biggestRelativeChange };
};

type RefreshTestPeakRssOptions = {
  artifactDirectory: string;
  apiRoot: string;
  previousPeaks?: Readonly<Record<string, number>>;
};

/** Receipts replace the table only when their union covers the current runner census. */
export const refreshTestPeakRss = ({
  artifactDirectory,
  apiRoot,
  previousPeaks = {},
}: RefreshTestPeakRssOptions) => {
  const files = listApiTestPaths(apiRoot);
  if (files.length === 0) {
    reject("API test census is empty");
  }
  const current = new Set(files);
  const measured = new Map<string, TestRssFile>();
  let environment: TestRssEnvironment | undefined;
  let runId: string | undefined;
  let baselineMb = 0;
  const receipts = [
    ...new Bun.Glob("**/*.json").scanSync({
      cwd: artifactDirectory,
      onlyFiles: true,
    }),
  ].toSorted();
  if (receipts.length === 0) {
    reject("No JSON measurement receipts found");
  }
  for (const receipt of receipts) {
    const shard = parseReceipt({
      artifactDirectory,
      receipt,
      expectedEnvironment: environment,
    });
    environment = shard.environment;
    // Disjoint shards from different runs could still form a complete census.
    runId ??= shard.source.runId;
    if (shard.source.runId !== runId) {
      reject(
        `Measurement receipts come from different runs: ${runId} and ${shard.source.runId}`,
      );
    }
    baselineMb = Math.max(baselineMb, shard.baselineMb);
    for (const value of shard.measurements) {
      const { file, row } = parseMeasurement({
        value,
        receipt,
        baselineMb: shard.baselineMb,
        source: shard.source,
      });
      if (!current.has(file)) {
        reject(`Stale test measurement: ${file}`);
      }
      if (measured.has(file)) {
        reject(`Duplicate test measurement: ${file}`);
      }
      measured.set(file, row);
    }
  }
  const missing = files.filter((file) => !measured.has(file));
  if (missing.length > 0) {
    reject(`Incomplete test census: ${missing.join(", ")}`);
  }
  const changes = changeReport({ files, measured, previousPeaks });
  if (environment === undefined) {
    reject("No validated measurement environment");
  }
  const table = {
    type: "measured",
    environment,
    baselineMb,
    files: Object.fromEntries(
      files.map((file) => [file, validatedRow(file, measured)] as const),
    ),
  } as const satisfies TestRssTable;
  return {
    content: `${JSON.stringify(table, null, 2)}\n`,
    changes,
  };
};

if (import.meta.main) {
  try {
    const [artifactDirectory, outputJson, ...extra] = Bun.argv.slice(2);
    if (!artifactDirectory || !outputJson || extra.length > 0) {
      reject("Usage: refresh-test-peak-rss.ts <artifact-dir> <output-json>");
    }
    const previous = measuredTestRssTable();
    const previousPeaks =
      previous.type === "uncalibrated"
        ? previous.files
        : Object.fromEntries(
            Object.entries(previous.files).map(
              ([file, row]) => [file, row.peakMb] as const,
            ),
          );
    const refreshed = refreshTestPeakRss({
      artifactDirectory,
      apiRoot: path.resolve(import.meta.dir, ".."),
      previousPeaks,
    });
    writeFileSync(outputJson, refreshed.content);
    console.log(JSON.stringify(refreshed.changes, null, 2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Peak RSS refresh failed",
    );
    process.exitCode = 1;
  }
}
