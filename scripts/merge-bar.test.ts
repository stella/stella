import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateMergeBar,
  evaluateQueuePlacement,
  formatQueuePlacementFailure,
  isReleasePullRequest,
  mergeBarRepositoryPolicy,
  mergeWhenReadyAction,
  readMergeHandoff,
  requiredChecksSucceeded,
  verifyFrontOfQueue,
  type MergeBarSnapshot,
} from "./merge-bar";

const HEAD_SHA = "1f0c3a7d9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a8d";
const OTHER_SHA = "9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a8d6f0e1b3c";
const BASE_MIGRATION = "apps/api/drizzle/20260801120000_original/migration.sql";
const ALIAS_INVENTORY = "apps/api/src/lib/db/migration-alias-inventory.json";

const runMigrationGateway = (
  files: readonly Record<string, string>[],
  changedFiles = files.length,
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "merge-bar-files-"));
  const executable = path.join(directory, "gh");
  const pullRequest = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          id: "PR_fixture",
          number: 123,
          title: "fix: something",
          isCrossRepository: false,
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: HEAD_SHA,
          baseRefName: "main",
          autoMergeRequest: null,
          mergeQueueEntry: null,
        },
      },
    },
  });
  writeFileSync(
    executable,
    `#!/bin/sh
case "$*" in
  *reviewThreads*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false}}';;
  *'api graphql'*) printf '%s\\n' "$FIXTURE_PULL_REQUEST";;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci-result"}]}}]';;
  *check-runs*) printf '1\\tci-result\\tcompleted\\tsuccess\\n';;
  *pulls/123/files*) printf '%s\\n' "$FIXTURE_FILES";;
  *pulls/123*) printf '%s\\n' "$FIXTURE_CHANGED_FILES";;
  *headRefOid*) printf '%s\\n' '{"headRefOid":"${HEAD_SHA}"}';;
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
        "--dry-run",
      ],
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
        FIXTURE_PULL_REQUEST: pullRequest,
        FIXTURE_FILES: files.map((file) => JSON.stringify(file)).join("\n"),
        FIXTURE_CHANGED_FILES: String(changedFiles),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const checkRun = (
  name: string,
  status: string,
  conclusion: string | null,
  { id = 1 } = {},
) => ({ id, name, status, conclusion });

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
            id: "PR_fixture",
            number: 123,
            title: "fix: something",
            isCrossRepository: false,
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            headRefOid: HEAD_SHA,
            baseRefName: "main",
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
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"Overlay check"}]}}]';;
  *check-runs*) printf '1\\tOverlay check\\tcompleted\\tsuccess\\n';;
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
            id: "PR_fixture",
            number: 123,
            title: "fix: something",
            isCrossRepository: false,
            state: "OPEN",
            isDraft: false,
            mergeable: "UNKNOWN",
            headRefOid: HEAD_SHA,
            baseRefName: "main",
            autoMergeRequest: null,
            mergeQueueEntry: { id: "entry" },
          },
        },
      },
    });
    writeFileSync(
      executable,
      `#!/bin/sh
case "$*" in
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci-result"}]}},{"type":"merge_queue","parameters":{}}]';;
  *'api graphql'*) printf '%s\\n' '${response}';;
  *) exit 99;;
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

  // The enqueue mutation reported a front position while the release pull
  // request actually sat behind other entries. Only the queue read after the
  // enqueue decides, and anything but first fails the run.
  test.each([
    { queuedAt: 3, exitCode: 1, output: "behind #4101, #4102" },
    { queuedAt: 1, exitCode: 0, output: "verified first in the queue" },
  ])(
    "a release jump is verified against the queue read after enqueueing: position $queuedAt",
    ({ queuedAt, exitCode, output }) => {
      const directory = mkdtempSync(path.join(tmpdir(), "merge-bar-jump-"));
      const executable = path.join(directory, "gh");
      const pullRequest = JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              id: "PR_fixture",
              number: 123,
              title: "chore: release v0.9.42",
              isCrossRepository: false,
              state: "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              headRefOid: HEAD_SHA,
              baseRefName: "main",
              autoMergeRequest: null,
              mergeQueueEntry: null,
            },
          },
        },
      });
      const others = [4101, 4102].map((number, index) => ({
        position: index < queuedAt - 1 ? index + 1 : index + 2,
        pullRequest: { number },
      }));
      const queue = JSON.stringify({
        data: {
          repository: {
            mergeQueue: {
              entries: {
                totalCount: 3,
                nodes: [
                  ...others,
                  { position: queuedAt, pullRequest: { number: 123 } },
                ],
              },
            },
          },
        },
      });
      writeFileSync(
        executable,
        `#!/bin/sh
case "$*" in
  *enqueuePullRequest*) printf '%s\\n' '{"data":{"enqueuePullRequest":{"mergeQueueEntry":{"position":1}}}}';;
  *'mergeQueue(branch'*) printf '%s\\n' '${queue}';;
  *reviewThreads*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false}}';;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci-result"}]}},{"type":"merge_queue","parameters":{}}]';;
  *check-runs*) printf '1\\tci-result\\tcompleted\\tsuccess\\n';;
  *headRefOid*)
    if [ "$1" = api ]; then printf '%s\\n' '${pullRequest}';
    else printf '%s\\n' '{"headRefOid":"${HEAD_SHA}"}'; fi;;
  *) exit 99;;
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
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode).toBe(exitCode);
        expect(
          `${result.stdout.toString()}${result.stderr.toString()}`,
        ).toContain(output);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  // A real run refuses to jump while checks are running; a dry run of the same
  // state must report the same failure instead of a merge verdict.
  test.each([[], ["--dry-run"]])(
    "a release jump with running checks exits non-zero without writing: %j",
    (...extraArguments) => {
      const directory = mkdtempSync(path.join(tmpdir(), "merge-bar-pending-"));
      const executable = path.join(directory, "gh");
      const pullRequest = JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              id: "PR_fixture",
              number: 123,
              title: "chore: release v0.9.42",
              isCrossRepository: false,
              state: "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              headRefOid: HEAD_SHA,
              baseRefName: "main",
              autoMergeRequest: null,
              mergeQueueEntry: null,
            },
          },
        },
      });
      writeFileSync(
        executable,
        `#!/bin/sh
case "$*" in
  *'pr merge'*|*enqueuePullRequest*) exit 98;;
  *reviewThreads*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false}}';;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci-result"}]}},{"type":"merge_queue","parameters":{}}]';;
  *check-runs*) printf '1\\tci-result\\tin_progress\\t\\n';;
  *headRefOid*)
    if [ "$1" = api ]; then printf '%s\\n' '${pullRequest}';
    else printf '%s\\n' '{"headRefOid":"${HEAD_SHA}"}'; fi;;
  *) exit 99;;
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
            ...extraArguments.flat(),
          ],
          env: {
            ...process.env,
            PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain("NOT JUMPED");
        expect(result.stdout.toString()).not.toContain("verdict: MERGE");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

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

describe("migration file gateway", () => {
  test("a modified base migration requires an inventory change", () => {
    const withoutInventory = runMigrationGateway([
      { status: "modified", filename: BASE_MIGRATION },
    ]);
    expect(withoutInventory.exitCode).toBe(1);
    expect(withoutInventory.stdout).toContain("MIGRATION_IDENTITY_VIOLATION");
    expect(withoutInventory.stdout).toContain("alias inventory update");

    const withInventory = runMigrationGateway([
      { status: "modified", filename: BASE_MIGRATION },
      { status: "modified", filename: ALIAS_INVENTORY },
    ]);
    expect(withInventory.exitCode).toBe(0);
    expect(withInventory.stdout).toContain("verdict: MERGE (dry run");
  });

  test("a renamed inventory file is recognized as an inventory change", () => {
    const result = runMigrationGateway([
      { status: "modified", filename: BASE_MIGRATION },
      {
        status: "renamed",
        filename: "apps/api/src/lib/db/renamed-inventory.json",
        previous_filename: ALIAS_INVENTORY,
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("verdict: MERGE (dry run");
  });

  test.each(["changed", "copied"])(
    "%s status for a base migration fails closed",
    (status) => {
      const result = runMigrationGateway([
        {
          status,
          filename:
            status === "copied"
              ? "apps/api/drizzle/20260803120000_copy/migration.sql"
              : BASE_MIGRATION,
          ...(status === "copied" ? { previous_filename: BASE_MIGRATION } : {}),
        },
        { status: "modified", filename: ALIAS_INVENTORY },
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("MIGRATION_IDENTITY_VIOLATION");
    },
  );

  test("an incomplete changed-files response aborts", () => {
    const result = runMigrationGateway([], 1);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("changed files");
  });
});

const passingSnapshot = (
  overrides: Partial<MergeBarSnapshot> = {},
): MergeBarSnapshot => ({
  pullRequest: {
    id: "PR_fixture",
    number: 2137,
    title: "fix: something",
    isCrossRepository: false,
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    handoff: { status: "pending" },
    headSha: HEAD_SHA,
  },
  landing: "merge",
  checkRunsHeadSha: HEAD_SHA,
  checkRuns: [
    checkRun("ci-result", "completed", "success"),
    checkRun("typecheck", "completed", "success", { id: 2 }),
  ],
  requiredCheckRuns: ["ci-result"],
  reviewThreads: [{ id: "PRRT_kwDOabcdef", isResolved: true }],
  migrations: {
    addedDirectories: ["apps/api/drizzle/20260816200000_new_column"],
    removedDirectories: [],
    modifiedDirectories: [],
    unsupportedChanges: [],
    inventoryChanged: false,
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
  test("uses the target branch's live required checks for public repositories", () => {
    expect(
      mergeBarRepositoryPolicy("stella/tooling", [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "checks" }] },
        },
      ]),
    ).toEqual({
      requiredCheckRuns: ["checks"],
      migrationDirectory: null,
      landing: "merge",
    });
  });

  test("derives required checks and merge-queue landing from active branch rules", () => {
    const stellaRules = [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "ci-result" },
            { context: "dependency-review" },
          ],
        },
      },
      { type: "merge_queue", parameters: {} },
    ];
    expect(mergeBarRepositoryPolicy("stella/stella", stellaRules)).toEqual({
      requiredCheckRuns: ["ci-result", "dependency-review"],
      migrationDirectory: "apps/api/drizzle",
      landing: "merge-when-ready",
    });
    expect(mergeBarRepositoryPolicy("Stella/Stella", stellaRules).landing).toBe(
      "merge-when-ready",
    );

    const infraRules = [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "Lint & Validate" },
            { context: "Plan (production)" },
            { context: "Plan (staging)" },
          ],
        },
      },
    ];
    expect(mergeBarRepositoryPolicy("stella/stella-infra", infraRules)).toEqual(
      {
        requiredCheckRuns: [
          "Lint & Validate",
          "Plan (production)",
          "Plan (staging)",
        ],
        migrationDirectory: null,
        landing: "merge",
      },
    );
  });

  test("refuses a repository with no live required checks", () => {
    expect(() => mergeBarRepositoryPolicy(PRIVATE_REPO, [])).toThrow(
      "No required status checks are active for stella/private",
    );
  });

  test("every configured required check must be present and green", () => {
    const { requiredCheckRuns } = mergeBarRepositoryPolicy(
      "stella/stella-infra",
      [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "Lint & Validate" },
              { context: "Plan (production)" },
              { context: "Plan (staging)" },
            ],
          },
        },
      ],
    );
    const checkRuns = requiredCheckRuns.map((name, index) =>
      checkRun(name, "completed", "success", { id: index + 1 }),
    );
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
            checkRun("typecheck", "completed", "success"),
            checkRun("lint", "completed", "success", { id: 2 }),
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
          checkRuns: [checkRun("ci-result", "in_progress", null)],
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
          checkRuns: [checkRun("ci-result", "in_progress", null)],
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
          checkRuns: [checkRun("ci-result", "completed", "failure")],
        }),
      ),
    ).toEqual({
      decision: "abort",
      reasons: ["REQUIRED_CHECK_NOT_SUCCESSFUL"],
    });
  });

  test("a skipped CI plan on a ready head is refused even when ci-result passed", () => {
    for (const landing of ["merge", "merge-when-ready"] as const) {
      expect(
        failedGate(
          passingSnapshot({
            landing,
            checkRuns: [
              checkRun("ci-plan", "completed", "skipped", { id: 3 }),
              checkRun("ci-result", "completed", "success"),
            ],
          }),
        ),
        landing,
      ).toEqual({ decision: "abort", reasons: ["CI_PLAN_SKIPPED"] });
    }
    // A plan that ran is not in the way.
    expect(
      evaluateMergeBar(
        passingSnapshot({
          checkRuns: [
            checkRun("ci-plan", "completed", "success", { id: 3 }),
            checkRun("ci-result", "completed", "success"),
          ],
        }),
      ).decision,
    ).toBe("merge");
  });

  test("a completed but unsuccessful ci-result is refused", () => {
    expect(
      failedGate(
        passingSnapshot({
          checkRuns: [checkRun("ci-result", "completed", "failure")],
        }),
      ),
    ).toEqual({
      decision: "abort",
      reasons: ["REQUIRED_CHECK_NOT_SUCCESSFUL"],
    });
  });

  test("uses the latest run when a required check name is repeated", () => {
    expect(
      evaluateMergeBar(
        passingSnapshot({
          checkRuns: [
            checkRun("ci-result", "completed", "success", {
              id: 2,
            }),
            checkRun("ci-result", "completed", "cancelled"),
          ],
        }),
      ).decision,
    ).toBe("merge");
  });

  test("a latest failed rerun cannot inherit an older success", () => {
    expect(
      failedGate(
        passingSnapshot({
          checkRuns: [
            checkRun("ci-result", "completed", "failure", {
              id: 2,
            }),
            checkRun("ci-result", "completed", "success"),
          ],
        }),
      ),
    ).toEqual({
      decision: "abort",
      reasons: ["REQUIRED_CHECK_NOT_SUCCESSFUL"],
    });
  });

  test("a latest queued rerun cannot inherit an older success", () => {
    expect(
      failedGate(
        passingSnapshot({
          checkRuns: [
            checkRun("ci-result", "queued", null, { id: 2 }),
            checkRun("ci-result", "completed", "success"),
          ],
        }),
      ),
    ).toEqual({
      decision: "abort",
      reasons: ["REQUIRED_CHECK_INCOMPLETE"],
    });
  });

  test("a skipped ci-result is refused", () => {
    expect(
      failedGate(
        passingSnapshot({
          checkRuns: [checkRun("ci-result", "completed", "skipped")],
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

  test("a migration below the base branch's maximum may merge", () => {
    expect(
      evaluateMergeBar(
        passingSnapshot({
          migrations: {
            addedDirectories: ["apps/api/drizzle/20260816140000_branch"],
            removedDirectories: [],
            modifiedDirectories: [],
            unsupportedChanges: [],
            inventoryChanged: false,
          },
        }),
      ).decision,
    ).toBe("merge");
  });

  test("a migration sharing a timestamp with another migration may merge", () => {
    expect(
      evaluateMergeBar(
        passingSnapshot({
          migrations: {
            addedDirectories: ["apps/api/drizzle/20260816200000_branch"],
            removedDirectories: [],
            modifiedDirectories: [],
            unsupportedChanges: [],
            inventoryChanged: false,
          },
        }),
      ).decision,
    ).toBe("merge");
  });

  test("removing a base migration aborts", () => {
    expect(
      failedGate(
        passingSnapshot({
          migrations: {
            addedDirectories: [],
            removedDirectories: ["apps/api/drizzle/20260801120000_original"],
            modifiedDirectories: [],
            unsupportedChanges: [],
            inventoryChanged: false,
          },
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["MIGRATION_IDENTITY_VIOLATION"] });
  });

  test("renaming a base migration aborts", () => {
    expect(
      failedGate(
        passingSnapshot({
          migrations: {
            addedDirectories: ["apps/api/drizzle/20260801130000_renamed"],
            removedDirectories: ["apps/api/drizzle/20260801120000_original"],
            modifiedDirectories: [],
            unsupportedChanges: [],
            inventoryChanged: false,
          },
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["MIGRATION_IDENTITY_VIOLATION"] });
  });

  test("a modified base migration without an inventory change aborts", () => {
    expect(
      failedGate(
        passingSnapshot({
          migrations: {
            ...passingSnapshot().migrations,
            modifiedDirectories: ["apps/api/drizzle/20260801120000_original"],
          },
        }),
      ),
    ).toEqual({ decision: "abort", reasons: ["MIGRATION_IDENTITY_VIOLATION"] });
  });

  test("a modified base migration with an inventory change defers to CI", () => {
    expect(
      evaluateMergeBar(
        passingSnapshot({
          migrations: {
            ...passingSnapshot().migrations,
            modifiedDirectories: ["apps/api/drizzle/20260801120000_original"],
            inventoryChanged: true,
          },
        }),
      ).decision,
    ).toBe("merge");
  });

  test("a pull request that changes no migrations passes the identity gate", () => {
    expect(
      evaluateMergeBar(
        passingSnapshot({
          migrations: {
            addedDirectories: [],
            removedDirectories: [],
            modifiedDirectories: [],
            unsupportedChanges: [],
            inventoryChanged: false,
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
      "migration-identity",
      "pull-request-state",
      "required-check",
      "review-threads",
    ]);
  });
});

describe("release pull requests jump the merge queue", () => {
  const release = {
    title: "chore: release v0.9.40",
    isDraft: false,
    isCrossRepository: false,
    baseRefName: "main",
  };

  test("recognizes a ready same-repository release pull request into main", () => {
    expect(isReleasePullRequest(release)).toBe(true);
    expect(isReleasePullRequest({ ...release, isDraft: true })).toBe(false);
    expect(isReleasePullRequest({ ...release, isCrossRepository: true })).toBe(
      false,
    );
    expect(isReleasePullRequest({ ...release, baseRefName: "release-1" })).toBe(
      false,
    );
    expect(
      isReleasePullRequest({ ...release, title: "chore: version packages" }),
    ).toBe(false);
    expect(
      isReleasePullRequest({ ...release, title: "fix: chore: release v1" }),
    ).toBe(false);
  });

  test("a jump enqueues at the front once checks have succeeded, even over an armed auto-merge", () => {
    expect(
      mergeWhenReadyAction({
        handoff: { status: "pending" },
        jump: true,
        checksSucceeded: true,
      }),
    ).toEqual({ kind: "enqueue-jump" });
    expect(
      mergeWhenReadyAction({
        handoff: { status: "armed", enabledAt: "2026-09-28T09:00:00Z" },
        jump: true,
        checksSucceeded: true,
      }),
    ).toEqual({ kind: "enqueue-jump" });
  });

  // Arming auto-merge would enqueue the pull request at the back once its
  // checks pass, the opposite of a jump, so nothing is armed.
  test("a jump waits for the checks without arming auto-merge", () => {
    expect(
      mergeWhenReadyAction({
        handoff: { status: "pending" },
        jump: true,
        checksSucceeded: false,
      }),
    ).toEqual({ kind: "jump-waits-for-checks", armedSince: null });
    expect(
      mergeWhenReadyAction({
        handoff: { status: "armed", enabledAt: "2026-09-28T09:00:00Z" },
        jump: true,
        checksSucceeded: false,
      }),
    ).toEqual({
      kind: "jump-waits-for-checks",
      armedSince: "2026-09-28T09:00:00Z",
    });
  });

  test("a queued pull request keeps its place, which a jump must verify", () => {
    expect(
      mergeWhenReadyAction({
        handoff: { status: "queued", entryId: "MQE_1" },
        jump: true,
        checksSucceeded: true,
      }),
    ).toEqual({ kind: "already-queued", entryId: "MQE_1", verifyFront: true });
    expect(
      mergeWhenReadyAction({
        handoff: { status: "queued", entryId: "MQE_1" },
        jump: false,
        checksSucceeded: true,
      }),
    ).toEqual({ kind: "already-queued", entryId: "MQE_1", verifyFront: false });
  });

  test("without a jump, arming is unchanged", () => {
    expect(
      mergeWhenReadyAction({
        handoff: { status: "pending" },
        jump: false,
        checksSucceeded: true,
      }),
    ).toEqual({ kind: "arm" });
    expect(
      mergeWhenReadyAction({
        handoff: { status: "armed", enabledAt: "2026-09-28T09:00:00Z" },
        jump: false,
        checksSucceeded: false,
      }),
    ).toEqual({ kind: "already-armed", enabledAt: "2026-09-28T09:00:00Z" });
  });

  test.each([
    { positions: [6, 1], exitCode: 0, sleeps: 1, seen: "6, 1" },
    {
      positions: [6, 6, 6, 6, 6],
      exitCode: 1,
      sleeps: 4,
      seen: "6, 6, 6, 6, 6",
    },
    { positions: [1], exitCode: 0, sleeps: 0, seen: "1" },
  ])(
    "queue placement settles with reads $positions",
    ({ positions, exitCode, sleeps, seen }) => {
      const delays: number[] = [];
      let reads = 0;
      const verdict = verifyFrontOfQueue({
        gateway: {
          readMergeQueue: (branch) => {
            expect(branch).toBe("main");
            const position = positions.at(reads);
            expect(position).toBeDefined();
            reads += 1;
            return position === undefined
              ? []
              : [{ pullNumber: 4112, position }];
          },
          sleep: (milliseconds) => {
            delays.push(milliseconds);
          },
        },
        pullNumber: 4112,
        branch: "main",
        context: "jump accepted",
        release: false,
      });
      expect(verdict.exitCode).toBe(exitCode);
      expect(verdict.message).toContain(
        exitCode === 0 ? "QUEUED AT THE FRONT" : "NOT AT THE FRONT",
      );
      expect(verdict.message).toContain(`positions seen: ${seen}`);
      expect(reads).toBe(positions.length);
      expect(delays).toHaveLength(sleeps);
      expect(
        delays.reduce((total, delay) => total + delay, 0),
      ).toBeLessThanOrEqual(20_000);
    },
  );

  test.each([
    { entries: [] },
    {
      entries: [
        { pullNumber: 4112, position: 1 },
        { pullNumber: 4101, position: 0 },
      ],
    },
  ])("incomplete or conflicting queue reads fail closed: %j", ({ entries }) => {
    const verdict = verifyFrontOfQueue({
      gateway: { readMergeQueue: () => entries, sleep: () => {} },
      pullNumber: 4112,
      branch: "main",
      context: "jump accepted",
      release: false,
    });
    expect(verdict.exitCode).toBe(1);
    expect(verdict.message).toContain("NOT AT THE FRONT");
  });

  test("a pull request first in the queue is at the front", () => {
    expect(
      evaluateQueuePlacement({
        entries: [
          { pullNumber: 4112, position: 1 },
          { pullNumber: 4100, position: 2 },
        ],
        pullNumber: 4112,
      }),
    ).toEqual({ status: "front", position: 1 });
  });

  // A jump the enqueue response reports as done can still leave the entry
  // behind others; only the queue read decides.
  test("a pull request behind other entries is not at the front", () => {
    expect(
      evaluateQueuePlacement({
        entries: [
          { pullNumber: 4101, position: 1 },
          { pullNumber: 4112, position: 3 },
          { pullNumber: 4102, position: 2 },
          { pullNumber: 4103, position: 4 },
        ],
        pullNumber: 4112,
      }),
    ).toEqual({ status: "behind", position: 3, ahead: [4101, 4102] });
    expect(
      formatQueuePlacementFailure({
        status: "behind",
        position: 3,
        ahead: [4101, 4102],
      }),
    ).toBe("it is at position 3, behind #4101, #4102");
  });

  // A transitional snapshot can list the entry alone at a later position.
  // Nothing is listed ahead of it, yet GitHub says it is not first.
  test("a gapped snapshot is not proof of the front", () => {
    expect(
      evaluateQueuePlacement({
        entries: [{ pullNumber: 4112, position: 2 }],
        pullNumber: 4112,
      }),
    ).toEqual({ status: "behind", position: 2, ahead: [] });
    expect(
      formatQueuePlacementFailure({ status: "behind", position: 2, ahead: [] }),
    ).toBe("it is at position 2, with no entry listed ahead of it");
  });

  test("a pull request missing from the queue is not at the front", () => {
    expect(
      evaluateQueuePlacement({
        entries: [{ pullNumber: 4101, position: 1 }],
        pullNumber: 4112,
      }),
    ).toEqual({ status: "absent", queueLength: 1 });
  });

  test("required checks succeed only when every one completed successfully", () => {
    const required = ["ci-result", "dependency-review"];
    expect(
      requiredChecksSucceeded({
        checkRuns: [
          checkRun("ci-result", "completed", "success"),
          checkRun("dependency-review", "completed", "success"),
        ],
        requiredCheckRuns: required,
      }),
    ).toBe(true);
    expect(
      requiredChecksSucceeded({
        checkRuns: [
          checkRun("ci-result", "in_progress", null),
          checkRun("dependency-review", "completed", "success"),
        ],
        requiredCheckRuns: required,
      }),
    ).toBe(false);
    expect(
      requiredChecksSucceeded({
        checkRuns: [checkRun("dependency-review", "completed", "success")],
        requiredCheckRuns: required,
      }),
    ).toBe(false);
  });
});
