import { describe, expect, test } from "bun:test";

import { isSeededBaselineFile } from "./baseline-paths";
import {
  evaluateMergeBar,
  mergeBarMigrationDirectory,
  mergeBarRequiredCheckRuns,
  type MergeBarSnapshot,
} from "./merge-bar";

const HEAD_SHA = "1f0c3a7d9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a8d";
const OTHER_SHA = "9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a8d6f0e1b3c";
const BASE_SHA = "4c2a8d6f0e1b3c5a7d9e5b4c2a8d6f0e1b3c5a7d";
const OTHER_BASE_SHA = "0e1b3c5a7d9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a";

const passingSnapshot = (
  overrides: Partial<MergeBarSnapshot> = {},
): MergeBarSnapshot => ({
  pullRequest: {
    number: 2137,
    title: "feat(api): pre-flight budget resolution",
    body: "Resolves the budget before the request runs.",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headSha: HEAD_SHA,
  },
  changedFiles: ["apps/api/src/budget/resolve.ts"],
  baseAncestry: { baseSha: BASE_SHA, behindBy: 0 },
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
    baseSha: BASE_SHA,
  },
  baseShaBeforeMerge: BASE_SHA,
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
  test("applies stella's migration-order gate only to its owning repository", () => {
    expect(mergeBarMigrationDirectory("stella/stella")).toBe(
      "apps/api/drizzle",
    );
    expect(mergeBarMigrationDirectory("Stella/Stella")).toBe(
      "apps/api/drizzle",
    );
    expect(mergeBarMigrationDirectory("stella/stella-infra")).toBeNull();
    expect(mergeBarMigrationDirectory("stella/stella-plane")).toBeNull();
  });

  test("requires each repository's complete check policy", () => {
    expect(mergeBarRequiredCheckRuns("Stella/Stella")).toEqual(["ci-result"]);
    expect(mergeBarRequiredCheckRuns("stella/stella-plane")).toEqual([
      "Overlay check",
    ]);
    expect(mergeBarRequiredCheckRuns("stella/stella-infra")).toEqual([
      "Lint & Validate",
      "Plan (production)",
      "Plan (staging)",
    ]);
    expect(() => mergeBarRequiredCheckRuns("stella/unknown")).toThrow(
      "No merge-bar check policy is registered for stella/unknown",
    );
  });

  test("every configured required check must be present and green", () => {
    const requiredCheckRuns = mergeBarRequiredCheckRuns("stella/stella-infra");
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

  // Failure class (d): a budget measured on a head that is not above the base.
  test("a baseline seeded off the base aborts", () => {
    expect(
      failedGate(
        passingSnapshot({
          baseAncestry: { baseSha: BASE_SHA, behindBy: 1 },
          changedFiles: ["scripts/knip-exports-baseline.json"],
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["BASELINE_SEEDED_OFF_BASE"] });
  });

  test("a baseline on a head current with the base merges", () => {
    expect(
      evaluateMergeBar(
        passingSnapshot({
          changedFiles: [
            "scripts/react-compiler-bailouts.json",
            "apps/web/src/lib/copy-to-clipboard.ts",
          ],
        }),
      ).decision,
    ).toBe("merge");
  });

  // The ancestry describes the base commit it was read against; the gates
  // after it take seconds, and a merge landing in that window is exactly the
  // stale budget the ancestry check ruled out a moment earlier.
  test("a base that moves after the ancestry is read aborts a baseline", () => {
    expect(
      failedGate(
        passingSnapshot({
          changedFiles: ["scripts/typecheck-baseline.json"],
          migrations: {
            baseDirectories: ["20260816200000_landed_meanwhile"],
            addedDirectories: [],
            baseSha: OTHER_BASE_SHA,
          },
          baseShaBeforeMerge: OTHER_BASE_SHA,
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["BASE_MOVED_UNDER_BASELINE"] });
  });

  test("a base that moves under a pull request carrying no baseline is not this gate's business", () => {
    expect(
      evaluateMergeBar(
        passingSnapshot({
          migrations: {
            baseDirectories: ["20260816200000_landed_meanwhile"],
            addedDirectories: [],
            baseSha: OTHER_BASE_SHA,
          },
          baseShaBeforeMerge: OTHER_BASE_SHA,
        }),
      ).decision,
    ).toBe("merge");
  });

  // A rule proves something about the tree it ran on: a pull request that adds
  // one and a pull request that adds the shape it rejects are each green alone.
  test("a pull request that changes a lint guard is held to the base", () => {
    for (const guard of [
      ".oxlint-plugins/no-bare-error.ts",
      "oxlint.config.ts",
      "oxlint.result-boundary.config.ts",
      "scripts/lint-suppressions.ts",
    ]) {
      expect(
        failedGate(
          passingSnapshot({
            baseAncestry: { baseSha: BASE_SHA, behindBy: 1 },
            changedFiles: [guard],
          }),
        ),
      ).toEqual({ decision: "abort", reasons: ["BASELINE_SEEDED_OFF_BASE"] });
    }
  });

  test("a pull request carrying no baseline is not held to the base", () => {
    expect(
      evaluateMergeBar(
        passingSnapshot({
          baseAncestry: { baseSha: BASE_SHA, behindBy: 1 },
        }),
      ).decision,
    ).toBe("merge");
  });

  // The producer-owned baselines are not all under `scripts/`, which is why
  // the gate reads the enumerated list rather than a path shape.
  test("a baseline an app owns is gated like the ones under scripts/", () => {
    expect(
      failedGate(
        passingSnapshot({
          baseAncestry: { baseSha: BASE_SHA, behindBy: 1 },
          changedFiles: ["apps/api/mcp-coverage-baseline.json"],
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["BASELINE_SEEDED_OFF_BASE"] });
    expect(isSeededBaselineFile("apps/web/e2e/network-baseline.json")).toBe(
      true,
    );
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

  test("a still-running ci-result is not a success", () => {
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

  test("a push between the checks and the merge aborts", () => {
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

  // Failure class (b) across pull requests: the branch's own CI could not see
  // a migration that landed on the default branch after that run finished.
  test("a migration below the default branch's maximum aborts at merge time", () => {
    expect(
      failedGate(
        passingSnapshot({
          migrations: {
            baseDirectories: ["20260816200000_landed_meanwhile"],
            addedDirectories: ["apps/api/drizzle/20260816140000_branch"],
            baseSha: BASE_SHA,
          },
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["MIGRATION_ORDER_VIOLATION"] });
  });

  test("a migration equal to the default branch's maximum aborts", () => {
    expect(
      failedGate(
        passingSnapshot({
          migrations: {
            baseDirectories: ["20260816200000_landed_meanwhile"],
            addedDirectories: ["apps/api/drizzle/20260816200000_branch"],
            baseSha: BASE_SHA,
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
            baseSha: BASE_SHA,
          },
        }),
      ).decision,
    ).toBe("merge");
  });

  // The migration maximum was read from a commit that is no longer the tip, so
  // another migration-bearing merge may have landed a higher timestamp since.
  test("a base branch that moved under added migrations aborts", () => {
    expect(
      failedGate(passingSnapshot({ baseShaBeforeMerge: OTHER_BASE_SHA })),
    ).toEqual({
      decision: "abort",
      reasons: ["BASE_MOVED_UNDER_ADDED_MIGRATIONS"],
    });
  });

  test("base movement is irrelevant when the pull request adds no migrations", () => {
    expect(
      evaluateMergeBar(
        passingSnapshot({
          migrations: {
            baseDirectories: ["20260816200000_landed_meanwhile"],
            addedDirectories: [],
            baseSha: BASE_SHA,
          },
          baseShaBeforeMerge: OTHER_BASE_SHA,
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
        baseShaBeforeMerge: OTHER_BASE_SHA,
        headShaBeforeMerge: OTHER_SHA,
      }),
    );

    expect(verdict.gates.filter((gate) => gate.status === "fail")).toHaveLength(
      6,
    );
  });

  test("the verdict covers every declared gate exactly once", () => {
    const gates = evaluateMergeBar(passingSnapshot()).gates.map(
      (gate) => gate.gate,
    );

    expect(gates.toSorted()).toEqual([
      "base-stability",
      "baseline-freshness",
      "head-stability",
      "mergeable",
      "migration-order",
      "pull-request-state",
      "required-check",
      "review-threads",
    ]);
  });
});
