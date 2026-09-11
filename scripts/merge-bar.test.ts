import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateMergeBar,
  mergeBarRepositoryPolicy,
  readMergeHandoff,
  type MergeBarSnapshot,
} from "./merge-bar";

const HEAD_SHA = "1f0c3a7d9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a8d";
const OTHER_SHA = "9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a8d6f0e1b3c";

/** Any repository this one does not enumerate, which the bar treats alike. */
const PRIVATE_REPO = "stella/private";

describe("merge handoff state", () => {
  test("the merge gate reads with the workflow token and pins writes with the App token", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "merge-bar-credentials-"),
    );
    const executable = path.join(directory, "gh");
    const response = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 123,
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            headRefOid: HEAD_SHA,
            autoMergeRequest: null,
            mergeQueueEntry: null,
          },
        },
      },
    });
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1 $2" = 'pr merge' ]; then
  [ "$GH_TOKEN" = write-fixture ] || exit 91
  case "$*" in *'--match-head-commit ${HEAD_SHA}'*) exit 0;; *) exit 92;; esac
fi
[ "$GH_TOKEN" = read-fixture ] || exit 93
case "$*" in
  *reviewThreads*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false}}';;
  *check-runs*) printf 'Overlay check\\tcompleted\\tsuccess\\n';;
  *headRefOid*)
    if [ "$1" = api ]; then printf '%s\\n' '${response}';
    else printf '%s\\n' '{"headRefOid":"${HEAD_SHA}"}'; fi;;
  *mergeCommit*) printf '%s\\n' '{"mergeCommit":{"oid":"${HEAD_SHA}"}}';;
  *) exit 94;;
esac
`,
    );
    chmodSync(executable, 0o700);
    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          fileURLToPath(new URL("merge-bar.ts", import.meta.url)),
          "123",
          "--repo",
          PRIVATE_REPO,
        ],
        env: {
          ...process.env,
          PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
          GH_READ_TOKEN: "read-fixture",
          GH_TOKEN: "write-fixture",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("verdict: MERGE");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an already queued PR exits without another GitHub operation even when mergeability is unknown", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "merge-bar-queued-"));
    const executable = path.join(directory, "gh");
    const response = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 123,
            state: "OPEN",
            isDraft: false,
            mergeable: "UNKNOWN",
            headRefOid: HEAD_SHA,
            autoMergeRequest: null,
            mergeQueueEntry: { id: "entry" },
          },
        },
      },
    });
    writeFileSync(
      executable,
      `#!/bin/sh\nif [ "$1" != api ] || [ "$2" != graphql ]; then exit 99; fi\nprintf '%s\\n' '${response}'\n`,
    );
    chmodSync(executable, 0o700);
    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          fileURLToPath(new URL("merge-bar.ts", import.meta.url)),
          "123",
        ],
        env: {
          ...process.env,
          PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(
        "already in the merge queue; nothing changed",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([null, { enabledAt: "2026-09-08T07:00:00Z" }])(
    "recognizes queue membership independently of auto-merge: %j",
    (autoMergeRequest) => {
      expect(
        readMergeHandoff({
          autoMergeRequest,
          mergeQueueEntry: { id: "queue-entry" },
        }),
      ).toEqual({ status: "queued", entryId: "queue-entry" });
    },
  );

  test("distinguishes an armed PR from one awaiting handoff", () => {
    expect(
      readMergeHandoff({ autoMergeRequest: null, mergeQueueEntry: null }),
    ).toEqual({ status: "pending" });
    expect(
      readMergeHandoff({
        autoMergeRequest: { enabledAt: "2026-09-08T07:00:00Z" },
        mergeQueueEntry: null,
      }),
    ).toEqual({ status: "armed", enabledAt: "2026-09-08T07:00:00Z" });
  });

  test("missing queue state cannot be interpreted as permission to enqueue", () => {
    expect(() => readMergeHandoff({ autoMergeRequest: null })).toThrow(
      "Expected an object for mergeQueueEntry",
    );
  });
});

const passingSnapshot = (
  overrides: Partial<MergeBarSnapshot> = {},
): MergeBarSnapshot => ({
  pullRequest: {
    number: 2137,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    handoff: { status: "pending" },
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
    expect(mergeBarRepositoryPolicy("stella/stella-infra")).toEqual({
      requiredCheckRuns: [
        "Lint & Validate",
        "Plan (production)",
        "Plan (staging)",
      ],
      migrationDirectory: null,
      landing: "merge",
    });
    // A repository this one does not enumerate is private: the bar cannot
    // read its workflows, so it lands with a plain merge and still demands a
    // named check rather than merging on an empty check list.
    expect(mergeBarRepositoryPolicy(PRIVATE_REPO)).toEqual({
      requiredCheckRuns: ["Overlay check"],
      migrationDirectory: null,
      landing: "merge",
    });
    expect(mergeBarRepositoryPolicy("stella/unknown")).toEqual(
      mergeBarRepositoryPolicy(PRIVATE_REPO),
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
