import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { appendFileSync } from "node:fs";

import { getStagingReporterEnvironment } from "../staging/env";
import {
  parseStagingState,
  STAGING_CHECKS,
  stagingFailureDisposition,
  type StagingState,
} from "./staging-state";

const report = (message: string) => {
  console.log(message);
  const { summary } = getStagingReporterEnvironment();
  if (summary) {
    appendFileSync(summary, `${message}\n`);
  }
};

// Assertions still fail normally and retain their traces and HTML report.
// Only explicitly declared checks may change the process exit status.
export default class StagingReporter implements Reporter {
  private reportOnlyFailures = 0;
  private gatingFailures = 0;
  private fatalError = false;

  private state: StagingState;

  constructor({ state }: { state?: StagingState } = {}) {
    this.state =
      state ?? parseStagingState(getStagingReporterEnvironment().state);
  }

  onBegin() {
    report("Staging smoke check dispositions:");
    for (const [checkKey, check] of Object.entries(STAGING_CHECKS)) {
      const disposition = stagingFailureDisposition(this.state, [check.tag]);
      const reason =
        disposition.mode === "report-only"
          ? ` (${disposition.reason})`
          : " (precondition on or absent)";
      report(`- ${checkKey}: ${disposition.mode}${reason}`);
    }
    report("- All undeclared checks and runner errors: gating.");
  }

  onTestEnd(
    test: Pick<TestCase, "tags" | "title" | "outcome">,
    result: Pick<TestResult, "status">,
  ) {
    if (
      result.status === "passed" ||
      result.status === "skipped" ||
      test.outcome() !== "unexpected"
    ) {
      return;
    }
    const disposition = stagingFailureDisposition(this.state, test.tags);
    if (disposition.mode === "gating") {
      this.gatingFailures += 1;
      return;
    }
    this.reportOnlyFailures += 1;
    report(
      `- FAILED (report-only): ${test.title}; declared ${disposition.reason}. See the Playwright report.`,
    );
  }

  onError() {
    this.fatalError = true;
  }

  async onEnd(
    result: Pick<FullResult, "status">,
  ): Promise<Pick<FullResult, "status">> {
    if (
      result.status !== "failed" ||
      this.fatalError ||
      this.gatingFailures > 0 ||
      this.reportOnlyFailures === 0
    ) {
      return { status: result.status };
    }
    report(
      "Staging gating checks passed; declared report-only failures do not block verification.",
    );
    return { status: "passed" };
  }
}
