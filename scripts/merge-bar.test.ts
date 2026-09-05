import { describe, expect, test } from "bun:test";

import {
  evaluateMergeBar,
  mergeBarRepositoryPolicy,
  type MergeBarSnapshot,
} from "./merge-bar";

const HEAD_SHA = "1f0c3a7d9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a8d";
const OTHER_SHA = "9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a8d6f0e1b3c";

const passingSnapshot = (
  overrides: Partial<MergeBarSnapshot> = {},
): MergeBarSnapshot => ({
  pullRequest: {
    number: 2137,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    autoMergeEnabledAt: null,
    headSha: HEAD_SHA,
  },
  landing: "merge",
  checkRunsHeadSha: HEAD_SHA,
  checkRuns: [
    { name: "ci-result", status: "completed", conclusion: "success" },
    { name: "typecheck", status: "completed", conclusion: "success" },
  ],
  requiredCheckRuns: ["ci-result"],
  reviewThreads: [{ id: "PRRT_kwDOabcdef", isResolved: true }],
  migrations: {
    baseDirectories: ["20260801120000_earlier", "20260812090000_latest"],
    addedDirectories: ["apps/api/drizzle/20260816200000_new_column"],
  },
  headShaBeforeMerge: HEAD_SHA,
  ...overrides,
});

const failedGate = (snapshot: MergeBarSnapshot) => {
  const verdict = evaluateMergeBar(snapshot);
  return {
    decision: verdict.decision,
    reasons: verdict.gates.flatMap((gate) =>
      gate.status === "fail" ? [gate.reason] : [],
    ),
  };
};

describe("merge bar", () => {
  test("lands through the queue only where one exists", () => {
    expect(mergeBarRepositoryPolicy("stella/stella")).toEqual({
      requiredCheckRuns: ["ci-result"],
      migrationDirectory: "apps/api/drizzle",
      landing: "merge-when-ready",
    });
    expect(mergeBarRepositoryPolicy("Stella/Stella").landing).toBe(
      "merge-when-ready",
    );
    expect(mergeBarRepositoryPolicy("stella/stella-plane")).toEqual({
      requiredCheckRuns: ["Overlay check"],
      migrationDirectory: null,
      landing: "merge",
    });
    expect(mergeBarRepositoryPolicy("stella/stella-infra")).toEqual({
      requiredCheckRuns: [
        "Lint & Validate",
        "Plan (production)",
        "Plan (staging)",
      ],
      migrationDirectory: null,
      landing: "merge",
    });
    expect(() => mergeBarRepositoryPolicy("stella/unknown")).toThrow(
      "No merge-bar policy is registered for stella/unknown",
    );
  });

  test("every configured required check must be present and green", () => {
    const { requiredCheckRuns } = mergeBarRepositoryPolicy(
      "stella/stella-infra",
    );
    const checkRuns = requiredCheckRuns.map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
    }));
    expect(
      evaluateMergeBar(passingSnapshot({ requiredCheckRuns, checkRuns }))
        .decision,
    ).toBe("merge");
    expect(
      failedGate(
        passingSnapshot({
          requiredCheckRuns,
          checkRuns: checkRuns.slice(1),
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["REQUIRED_CHECK_MISSING"] });
  });

  test("merges when every gate is positively satisfied", () => {
    const verdict = evaluateMergeBar(passingSnapshot());

    expect(verdict.decision).toBe("merge");
    expect(verdict.gates.every((gate) => gate.status === "pass")).toBe(true);
  });

  // Failure class (a): a negative predicate over an empty list reads as green.
  test("an empty check-run list fails rather than passing vacuously", () => {
    expect(failedGate(passingSnapshot({ checkRuns: [] }))).toEqual({
      decision: "abort",
      reasons: ["REQUIRED_CHECK_MISSING"],
    });
  });

  test("other checks succeeding does not substitute for ci-result", () => {
    expect(
      failedGate(
        passingSnapshot({
          checkRuns: [
            { name: "typecheck", status: "completed", conclusion: "success" },
            { name: "lint", status: "completed", conclusion: "success" },
          ],
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["REQUIRED_CHECK_MISSING"] });
  });

  test("a conflicting pull request fails on mergeability and on its empty check list", () => {
    expect(
      failedGate(
        passingSnapshot({
          pullRequest: {
            ...passingSnapshot().pullRequest,
            mergeable: "CONFLICTING",
          },
          checkRuns: [],
        }),
      ),
    ).toEqual({
      decision: "abort",
      reasons: ["MERGEABLE_CONFLICTING", "REQUIRED_CHECK_MISSING"],
    });
  });

  test("a draft fails before its empty check list can be misread", () => {
    expect(
      failedGate(
        passingSnapshot({
          pullRequest: { ...passingSnapshot().pullRequest, isDraft: true },
          checkRuns: [],
        }),
      ),
    ).toEqual({
      decision: "abort",
      reasons: ["PULL_REQUEST_IS_DRAFT", "REQUIRED_CHECK_MISSING"],
    });
  });

  test("UNKNOWN mergeability is a refusal, not a pass", () => {
    expect(
      failedGate(
        passingSnapshot({
          pullRequest: {
            ...passingSnapshot().pullRequest,
            mergeable: "UNKNOWN",
          },
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["MERGEABLE_UNKNOWN"] });
  });

  test("a closed pull request is refused", () => {
    expect(
      failedGate(
        passingSnapshot({
          pullRequest: { ...passingSnapshot().pullRequest, state: "MERGED" },
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["PULL_REQUEST_NOT_OPEN"] });
  });

  test("a still-running ci-result is not a success for a direct merge", () => {
    expect(
      failedGate(
        passingSnapshot({
          checkRuns: [
            { name: "ci-result", status: "in_progress", conclusion: null },
          ],
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["REQUIRED_CHECK_INCOMPLETE"] });
  });

  // "Merge when ready" is what GitHub waits on: a check that has not finished,
  // or has not been created for a fresh push, is exactly the state the arming
  // exists for. Only a check that has FAILED makes arming pointless.
  test("merge when ready accepts pending and absent checks but not failed ones", () => {
    expect(
      evaluateMergeBar(
        passingSnapshot({
          landing: "merge-when-ready",
          checkRuns: [
            { name: "ci-result", status: "in_progress", conclusion: null },
          ],
        }),
      ).decision,
    ).toBe("merge");
    expect(
      evaluateMergeBar(
        passingSnapshot({ landing: "merge-when-ready", checkRuns: [] }),
      ).decision,
    ).toBe("merge");
    expect(
      failedGate(
        passingSnapshot({
          landing: "merge-when-ready",
          checkRuns: [
            { name: "ci-result", status: "completed", conclusion: "failure" },
          ],
        }),
      ),
    ).toEqual({
      decision: "abort",
      reasons: ["REQUIRED_CHECK_NOT_SUCCESSFUL"],
    });
  });

  test("a completed but unsuccessful ci-result is refused", () => {
    expect(
      failedGate(
        passingSnapshot({
          checkRuns: [
            { name: "ci-result", status: "completed", conclusion: "failure" },
          ],
        }),
      ),
    ).toEqual({
      decision: "abort",
      reasons: ["REQUIRED_CHECK_NOT_SUCCESSFUL"],
    });
  });

  test("a skipped ci-result is refused", () => {
    expect(
      failedGate(
        passingSnapshot({
          checkRuns: [
            { name: "ci-result", status: "completed", conclusion: "skipped" },
          ],
        }),
      ),
    ).toEqual({
      decision: "abort",
      reasons: ["REQUIRED_CHECK_NOT_SUCCESSFUL"],
    });
  });

  // Failure class (b): check runs that describe a commit that is no longer head.
  test("check runs fetched for a different SHA cannot vouch for head", () => {
    expect(
      failedGate(passingSnapshot({ checkRunsHeadSha: OTHER_SHA })),
    ).toEqual({
      decision: "abort",
      reasons: ["CHECK_RUNS_READ_FOR_STALE_SHA"],
    });
  });

  test("a push between the checks and the write aborts", () => {
    expect(
      failedGate(passingSnapshot({ headShaBeforeMerge: OTHER_SHA })),
    ).toEqual({ decision: "abort", reasons: ["HEAD_MOVED_DURING_CHECKS"] });
  });

  test("an unresolved review thread aborts", () => {
    expect(
      failedGate(
        passingSnapshot({
          reviewThreads: [
            { id: "PRRT_resolved", isResolved: true },
            { id: "PRRT_open", isResolved: false },
          ],
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["UNRESOLVED_REVIEW_THREADS"] });
  });

  test("zero review threads is a pass, not a missing observation", () => {
    expect(
      evaluateMergeBar(passingSnapshot({ reviewThreads: [] })).decision,
    ).toBe("merge");
  });

  // The branch's own CI could not see a migration that landed on the base
  // branch after that run finished.
  test("a migration below the base branch's maximum aborts", () => {
    expect(
      failedGate(
        passingSnapshot({
          migrations: {
            baseDirectories: ["20260816200000_landed_meanwhile"],
            addedDirectories: ["apps/api/drizzle/20260816140000_branch"],
          },
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["MIGRATION_ORDER_VIOLATION"] });
  });

  test("a migration equal to the base branch's maximum aborts", () => {
    expect(
      failedGate(
        passingSnapshot({
          migrations: {
            baseDirectories: ["20260816200000_landed_meanwhile"],
            addedDirectories: ["apps/api/drizzle/20260816200000_branch"],
          },
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["MIGRATION_ORDER_VIOLATION"] });
  });

  test("a pull request that adds no migrations passes the ordering gate", () => {
    expect(
      evaluateMergeBar(
        passingSnapshot({
          migrations: {
            baseDirectories: ["20260816200000_landed_meanwhile"],
            addedDirectories: [],
          },
        }),
      ).decision,
    ).toBe("merge");
  });

  test("every failing gate is reported, not just the first", () => {
    const verdict = evaluateMergeBar(
      passingSnapshot({
        pullRequest: {
          ...passingSnapshot().pullRequest,
          state: "CLOSED",
          mergeable: "CONFLICTING",
        },
        checkRuns: [],
        reviewThreads: [{ id: "PRRT_open", isResolved: false }],
        headShaBeforeMerge: OTHER_SHA,
      }),
    );

    expect(verdict.gates.filter((gate) => gate.status === "fail")).toHaveLength(
      5,
    );
  });

  test("the verdict covers every declared gate exactly once", () => {
    const gates = evaluateMergeBar(passingSnapshot()).gates.map(
      (gate) => gate.gate,
    );

    expect(gates.toSorted()).toEqual([
      "head-stability",
      "mergeable",
      "migration-order",
      "pull-request-state",
      "required-check",
      "review-threads",
    ]);
  });
});
