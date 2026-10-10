#!/usr/bin/env bun
import { Result, TaggedError } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { printError } from "@stll/errors";

import { listApiTestPaths } from "./api-test-plan";
import {
  measuredTestRssTable,
  readTestRssEnvironment,
  readTestRssInstant,
  readTestRssSource,
  TEST_RSS_RECEIPT_VERSION,
  type TestRssEnvironment,
  type TestRssFile,
  type TestRssShard,
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
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

const parseShard = (value: unknown, receipt: string): TestRssShard => {
  if (
    !isRecord(value) ||
    !positiveInteger(value["index"]) ||
    !positiveInteger(value["count"]) ||
    value["index"] > value["count"]
  ) {
    return reject(`Invalid shard in ${receipt}`);
  }
  return { index: value["index"], count: value["count"] };
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
    payload["version"] !== TEST_RSS_RECEIPT_VERSION ||
    !Array.isArray(payload["measurements"]) ||
    payload["measurements"].length === 0
  ) {
    reject(`Invalid measurement receipt: ${receipt}`);
  }
  const environment = readTestRssEnvironment(payload["environment"]);
  const source = readTestRssSource(payload["source"]);
  const measuredAt = readTestRssInstant(
    payload["measuredAt"],
    `measurement time in ${receipt}`,
  );
  const shard = parseShard(payload["shard"], receipt);
  const plannedFiles = payload["plannedFiles"];
  if (!positiveInteger(plannedFiles)) {
    reject(`Invalid planned file count in ${receipt}`);
  }
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
  if (payload["measurements"].length !== plannedFiles) {
    reject(
      `Incomplete shard ${shard.index}/${shard.count} in ${receipt}: measured ${payload["measurements"].length} of ${plannedFiles} files`,
    );
  }
  return {
    environment,
    source,
    measuredAt,
    shard,
    baselineMb,
    measurements: payload["measurements"],
  };
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
  const unmeasuredFiles: string[] = [];
  let biggestRelativeChange:
    | {
        file: string;
        previousPeakMb: number;
        peakMb: number;
        relativeChange: number;
      }
    | undefined;
  for (const file of files) {
    const row = measured.get(file);
    if (row === undefined) {
      unmeasuredFiles.push(file);
      continue;
    }
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
  return { newFiles, unmeasuredFiles, biggestRelativeChange };
};

type RefreshTestPeakRssOptions = {
  artifactDirectory: string;
  apiRoot: string;
  previousPeaks?: Readonly<Record<string, number>>;
};

/**
 * Receipts replace the table only when they cover every shard of one run and
 * every file each shard owned. The current tree usually moved on since that
 * run: files deleted since are dropped, files added since stay unmeasured and
 * keep the planner's conservative weight until the next run.
 */
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
  const removedFiles: string[] = [];
  const seen = new Set<string>();
  const shardIndexes = new Set<number>();
  let shardCount: number | undefined;
  let environment: TestRssEnvironment | undefined;
  let runId: string | undefined;
  let baselineMb = 0;
  let measuredAt: string | undefined;
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
    runId ??= shard.source.runId;
    if (shard.source.runId !== runId) {
      reject(
        `Measurement receipts come from different runs: ${runId} and ${shard.source.runId}`,
      );
    }
    shardCount ??= shard.shard.count;
    if (shard.shard.count !== shardCount) {
      reject(
        `Measurement receipts disagree on the shard count: ${shardCount} and ${shard.shard.count}`,
      );
    }
    if (shardIndexes.has(shard.shard.index)) {
      reject(`Duplicate shard ${shard.shard.index}/${shardCount}`);
    }
    shardIndexes.add(shard.shard.index);
    baselineMb = Math.max(baselineMb, shard.baselineMb);
    if (
      measuredAt === undefined ||
      Date.parse(shard.measuredAt) > Date.parse(measuredAt)
    ) {
      measuredAt = shard.measuredAt;
    }
    for (const value of shard.measurements) {
      const { file, row } = parseMeasurement({
        value,
        receipt,
        baselineMb: shard.baselineMb,
        source: shard.source,
      });
      if (seen.has(file)) {
        reject(`Duplicate test measurement: ${file}`);
      }
      seen.add(file);
      if (current.has(file)) {
        measured.set(file, row);
      } else {
        removedFiles.push(file);
      }
    }
  }
  if (
    shardCount === undefined ||
    environment === undefined ||
    measuredAt === undefined
  ) {
    return reject("No validated measurement receipt");
  }
  const missingShards = Array.from(
    { length: shardCount },
    (_, index) => index + 1,
  ).filter((index) => !shardIndexes.has(index));
  if (missingShards.length > 0) {
    reject(
      `Incomplete measurement run: missing shard ${missingShards.map((index) => `${index}/${shardCount}`).join(", ")}`,
    );
  }
  const table = {
    environment,
    measuredAt,
    baselineMb,
    files: Object.fromEntries(
      files.flatMap((file) => {
        const row = measured.get(file);
        return row === undefined ? [] : [[file, row] as const];
      }),
    ),
  } as const satisfies TestRssTable;
  return {
    content: `${JSON.stringify(table, null, 2)}\n`,
    changes: {
      ...changeReport({ files, measured, previousPeaks }),
      removedFiles: removedFiles.toSorted(),
    },
  };
};

if (import.meta.main) {
  try {
    const [artifactDirectory, outputJson, ...extra] = Bun.argv.slice(2);
    if (!artifactDirectory || !outputJson || extra.length > 0) {
      reject("Usage: refresh-test-peak-rss.ts <artifact-dir> <output-json>");
    }
    const previousPeaks = Object.fromEntries(
      Object.entries(measuredTestRssTable().files).map(
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
    printError("Peak RSS refresh failed", error);
    process.exitCode = 1;
  }
}
