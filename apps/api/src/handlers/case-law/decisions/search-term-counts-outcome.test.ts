import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { FACET_COUNT_TYPE } from "@stll/api-contract/search";

import { settledTermDecisionCounts } from "@/api/handlers/case-law/decisions/search";
import { rankedCountsOutcome } from "@/api/handlers/case-law/decisions/search-ranked";
import type { TermDecisionCounts } from "@/api/handlers/case-law/decisions/search-relaxed";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import type { RecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

const counts: TermDecisionCounts = {
  allTerms: 2,
  terms: [
    { term: "smlouva", count: 40 },
    { term: "loajalita", count: 3 },
  ],
  countType: FACET_COUNT_TYPE.ESTIMATE,
};

const budgetCut = new TimeoutError({
  message: "case-law-term-decision-counts exceeded its 4000ms latency budget",
  label: "case-law-term-decision-counts",
  timeoutMs: 4000, // timeout: an error fixture, nothing waits on it
});

describe("per-word decision counts that did not finish", () => {
  let recording: RecordingLogger;

  beforeEach(() => {
    recording = installRecordingLogger();
  });

  afterEach(() => {
    recording.restore();
  });

  const messages = () => recording.records.map(({ message }) => message);
  const incomplete = () =>
    recording.records
      .filter(({ message }) => message === "case_law.answer.incomplete")
      .map(({ attributes }) => attributes);

  test("a count its budget cut is an incomplete answer, never a failure", () => {
    expect(
      settledTermDecisionCounts({
        type: "degraded",
        reason: "budget_exhausted",
      }),
    ).toBeNull();
    expect(incomplete()).toEqual([
      { surface: "search", reason: "term_decision_counts_skipped", count: 1 },
    ]);
    // Nothing a release gate reads as an error: no warning, no failure.
    expect(recording.at("WARN")).toEqual([]);
    expect(recording.at("ERROR")).toEqual([]);
    expect(messages()).not.toContain(
      "case_law.search_term_decision_counts.skipped",
    );
  });

  test("a count that failed is still observed as a failure, and counted", () => {
    const failed = new Error("engine answered without aggregations");
    expect(
      settledTermDecisionCounts({ type: "skipped", error: failed }),
    ).toBeNull();
    expect(messages()).toContain(
      "case_law.search_term_decision_counts.skipped",
    );
    expect(incomplete()).toEqual([
      { surface: "search", reason: "term_decision_counts_skipped", count: 1 },
    ]);
  });

  test("counts that were read are returned and report nothing", () => {
    expect(settledTermDecisionCounts({ type: "read", value: counts })).toEqual(
      counts,
    );
    expect(recording.records).toEqual([]);
  });
});

describe("the ranked path's counts under their budget", () => {
  test("enough decisions holding every word needs no counts", () => {
    expect(
      rankedCountsOutcome({ status: "complete", value: Result.ok(null) }),
    ).toBeNull();
  });

  test("read counts are read", () => {
    expect(
      rankedCountsOutcome({ status: "complete", value: Result.ok(counts) }),
    ).toEqual({ type: "read", value: counts });
  });

  test("a budget cut is degraded, a failure is skipped", () => {
    expect(
      rankedCountsOutcome({
        status: "degraded",
        reason: "budget_exhausted",
        budgetMs: 4000,
        error: budgetCut,
      }),
    ).toEqual({ type: "degraded", reason: "budget_exhausted" });
    expect(
      rankedCountsOutcome({ status: "complete", value: Result.err(budgetCut) }),
    ).toEqual({ type: "skipped", error: budgetCut });
  });
});
