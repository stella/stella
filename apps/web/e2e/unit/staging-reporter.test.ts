import { describe, expect, test } from "bun:test";

import StagingReporter from "../helpers/staging-reporter";
import { parseStagingState } from "../helpers/staging-state";

const reportOnlyState = parseStagingState(
  '{"corpus_index":"off","rollout":"knowledge-web-pending"}',
);
const reportOnlyFailure = {
  tags: ["@staging-public-law-hydration"],
  title: "public law hydration",
  outcome: () => "unexpected" as const,
};
const gatingFailure = {
  tags: ["@unknown-check"],
  title: "undeclared check",
  outcome: () => "unexpected" as const,
};
const failed = { status: "failed" as const };

describe("staging reporter", () => {
  test("passes when the only unexpected failure is declared report-only", async () => {
    const reporter = new StagingReporter({ state: reportOnlyState });
    reporter.onTestEnd(reportOnlyFailure, failed);

    expect(await reporter.onEnd(failed)).toEqual({ status: "passed" });
  });

  test("keeps the run failed when a gating failure accompanies report-only failure", async () => {
    const reporter = new StagingReporter({ state: reportOnlyState });
    reporter.onTestEnd(reportOnlyFailure, failed);
    reporter.onTestEnd(gatingFailure, failed);

    expect(await reporter.onEnd(failed)).toEqual({ status: "failed" });
  });

  test("keeps absent and on preconditions gating", async () => {
    for (const state of [
      parseStagingState(undefined),
      parseStagingState('{"corpus_index":"on"}'),
    ]) {
      const reporter = new StagingReporter({ state });
      reporter.onTestEnd(reportOnlyFailure, failed);
      expect(await reporter.onEnd(failed)).toEqual({ status: "failed" });
    }
  });

  test("keeps fatal runner errors gating despite declared report-only failure", async () => {
    const reporter = new StagingReporter({ state: reportOnlyState });
    reporter.onTestEnd(reportOnlyFailure, failed);
    reporter.onError();

    expect(await reporter.onEnd(failed)).toEqual({ status: "failed" });
  });

  test("preserves interrupted and timed out runner statuses", async () => {
    const reporter = new StagingReporter({ state: reportOnlyState });
    reporter.onTestEnd(reportOnlyFailure, failed);

    expect(await reporter.onEnd({ status: "interrupted" })).toEqual({
      status: "interrupted",
    });
    expect(await reporter.onEnd({ status: "timedout" })).toEqual({
      status: "timedout",
    });
  });

  test("keeps unexplained failures failed and preserves passed results", async () => {
    const reporter = new StagingReporter({ state: reportOnlyState });
    expect(await reporter.onEnd(failed)).toEqual({ status: "failed" });
    expect(await reporter.onEnd({ status: "passed" })).toEqual({
      status: "passed",
    });
  });

  test("ignores passed and skipped tests when deciding whether to demote", async () => {
    const reporter = new StagingReporter({ state: reportOnlyState });
    reporter.onTestEnd(reportOnlyFailure, { status: "passed" });
    reporter.onTestEnd(reportOnlyFailure, { status: "skipped" });

    expect(await reporter.onEnd(failed)).toEqual({ status: "failed" });
  });
});
