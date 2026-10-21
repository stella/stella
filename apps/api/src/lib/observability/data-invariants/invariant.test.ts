import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import {
  installRecordingAnalytics,
  installRecordingLogger,
  type RecordingAnalytics,
  type RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

import {
  DATA_INVARIANT_ID,
  type DataInvariant,
  type DataInvariantFinding,
  judgeDataInvariant,
  MAX_LOGGED_FINDINGS,
  runDataInvariants,
} from "./invariant";

const NOW = new Date("2026-10-17T09:00:00.000Z");

let lines: Record<string, unknown>[];
let logs: RecordingLogger;
let analytics: RecordingAnalytics;

beforeEach(() => {
  lines = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(JSON.parse(line));
  });
  logs = installRecordingLogger();
  analytics = installRecordingAnalytics();
});

afterEach(() => {
  resetMetricLineSinkForTesting();
  logs.restore();
  analytics.restore();
});

const findings = (count: number): DataInvariantFinding<"empty">[] =>
  Array.from({ length: count }, (_, index) => ({
    target: `list-${index}`,
    reason: "empty",
    observed: 0,
    expected: ">= 1 entry",
  }));

const invariant = (
  overrides: Partial<DataInvariant> & Pick<DataInvariant, "check">,
): DataInvariant => ({
  id: DATA_INVARIANT_ID.sanctionsListsLoaded,
  owner: "sanctions",
  severity: "critical",
  ...overrides,
});

const run = async (invariants: readonly DataInvariant[]) =>
  await runDataInvariants(invariants, {
    now: NOW,
    signal: new AbortController().signal,
  });

describe("publishing a verdict", () => {
  test("a violated invariant emits an unhealthy gauge and one record per finding", async () => {
    const reports = await run([
      invariant({ check: async () => judgeDataInvariant(3, findings(2)) }),
    ]);

    expect(reports.map(({ outcome }) => outcome.status)).toEqual(["violated"]);
    expect(lines).toEqual([
      expect.objectContaining({
        invariant: DATA_INVARIANT_ID.sanctionsListsLoaded,
        severity: "critical",
        status: "violated",
        checked: 3,
        findings: 2,
        DataInvariantUnhealthy: 1,
        _aws: expect.objectContaining({
          CloudWatchMetrics: [
            expect.objectContaining({
              Dimensions: [["invariant", "severity"]],
              Metrics: [{ Name: "DataInvariantUnhealthy", Unit: "Count" }],
            }),
          ],
        }),
      }),
    ]);
    expect(
      logs.at("ERROR").map(({ attributes }) => attributes?.["finding.target"]),
    ).toEqual(["list-0", "list-1"]);
  });

  test("a warning invariant logs its findings at WARN", async () => {
    await run([
      invariant({
        severity: "warning",
        check: async () => judgeDataInvariant(1, findings(1)),
      }),
    ]);
    expect(logs.at("ERROR")).toEqual([]);
    expect(logs.at("WARN")).toHaveLength(1);
  });

  test("findings logged per run are bounded while the gauge counts them all", async () => {
    const total = MAX_LOGGED_FINDINGS + 5;
    await run([
      invariant({
        check: async () => judgeDataInvariant(total, findings(total)),
      }),
    ]);
    expect(logs.at("ERROR")).toHaveLength(MAX_LOGGED_FINDINGS);
    expect(lines.at(0)).toMatchObject({ findings: total });
  });

  test("a held invariant emits a healthy gauge", async () => {
    await run([invariant({ check: async () => judgeDataInvariant(7, []) })]);
    expect(lines).toEqual([
      expect.objectContaining({
        status: "held",
        checked: 7,
        DataInvariantUnhealthy: 0,
      }),
    ]);
    expect(logs.at("ERROR")).toEqual([]);
  });

  test("a skipped invariant is logged and leaves no datapoint", async () => {
    await run([
      invariant({
        check: async () => ({ status: "skipped", reason: "not-configured" }),
      }),
    ]);
    expect(lines).toEqual([]);
    expect(
      logs.records.find(({ message }) => message === "data_invariant.skipped")
        ?.attributes,
    ).toMatchObject({ "invariant.skip_reason": "not-configured" });
  });
});

describe("a check that cannot run", () => {
  test("is unhealthy rather than held, is captured, and does not stop the rest", async () => {
    const reports = await run([
      invariant({
        check: async () =>
          await Promise.reject(
            new SchedulerTaskFailure({
              message: "relation is unavailable",
              cause: undefined,
            }),
          ),
      }),
      invariant({
        id: DATA_INVARIANT_ID.caseLawSearchCanaries,
        check: async () => judgeDataInvariant(1, []),
      }),
    ]);

    expect(reports.map(({ outcome }) => outcome.status)).toEqual([
      "errored",
      "held",
    ]);
    expect(lines.at(0)).toMatchObject({
      invariant: DATA_INVARIANT_ID.sanctionsListsLoaded,
      status: "errored",
      DataInvariantUnhealthy: 1,
    });
    expect(analytics.exceptions()).toHaveLength(1);
  });

  test("an aborted run rejects instead of reporting the check as broken", async () => {
    const controller = new AbortController();
    const rejection = await rejectionOf(
      runDataInvariants(
        [
          invariant({
            check: async () => {
              controller.abort();
              controller.signal.throwIfAborted();
              return await Promise.resolve(judgeDataInvariant(0, []));
            },
          }),
        ],
        { now: NOW, signal: controller.signal },
      ),
    );
    expect(rejection).toBeInstanceOf(DOMException);
    expect(lines).toEqual([]);
  });
});

test("judging an invariant holds exactly when nothing broke", () => {
  expect(judgeDataInvariant(2, [])).toEqual({ status: "held", checked: 2 });
  expect(judgeDataInvariant(2, findings(1))).toMatchObject({
    status: "violated",
    findings: findings(1),
  });
});
