import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

import {
  extractPlanSelector,
  PlanSelectorError,
  runPlanScopes,
  runPlanSelector,
} from "./ci-plan-selector";
import { pilotFastJobs } from "./ci-pr-pilot-plan";
import annotations0_0 from "./fixtures/merge-group-ejections/37727028977-113149115699-annotations.json" with { type: "json" };
import annotations0_1 from "./fixtures/merge-group-ejections/37727028977-113149903942-annotations.json" with { type: "json" };
import realJobs0 from "./fixtures/merge-group-ejections/37727028977-jobs.json" with { type: "json" };
import realRun0 from "./fixtures/merge-group-ejections/37727028977-run.json" with { type: "json" };
import annotations1_0 from "./fixtures/merge-group-ejections/37727864876-113150755188-annotations.json" with { type: "json" };
import annotations1_1 from "./fixtures/merge-group-ejections/37727864876-113152580573-annotations.json" with { type: "json" };
import realJobs1 from "./fixtures/merge-group-ejections/37727864876-jobs.json" with { type: "json" };
import realRun1 from "./fixtures/merge-group-ejections/37727864876-run.json" with { type: "json" };
import annotations2_0 from "./fixtures/merge-group-ejections/37728096499-113150751404-annotations.json" with { type: "json" };
import annotations2_1 from "./fixtures/merge-group-ejections/37728096499-113151718553-annotations.json" with { type: "json" };
import realJobs2 from "./fixtures/merge-group-ejections/37728096499-jobs.json" with { type: "json" };
import realRun2 from "./fixtures/merge-group-ejections/37728096499-run.json" with { type: "json" };
import rateLimitAnnotations from "./fixtures/merge-group-ejections/rate-limit-9001-annotations.json" with { type: "json" };
import rateLimitResultAnnotations from "./fixtures/merge-group-ejections/rate-limit-9002-annotations.json" with { type: "json" };
import rateLimitJobs from "./fixtures/merge-group-ejections/rate-limit-jobs.json" with { type: "json" };
import {
  armAndVerify,
  checkEjectedHead,
  classifyFailedStepEvidence,
  checkMergeHold,
  checkGreenResultFreshness,
  MergeHoldReadError,
  evaluateEjectedHead,
  evaluateMergeBar,
  evaluateQueuePlacement,
  formatEjection,
  formatQueuePlacementFailure,
  isReleasePullRequest,
  latestEjection,
  MERGE_BAR_REPOSITORIES,
  type MergeBarRepository,
  mergeBarRepositoryPolicy,
  mergeWhenReadyAction,
  parseMergeQueueRemovals,
  readMergeGroupRecord,
  parseMergeGroupAnnotations,
  pullRequestCheckRuns,
  type RatchetFreshness,
  ratchetFreshnessFor,
  RatchetRecheckError,
  readFastRequiredJobs,
  readMergeBarRepository,
  readMergeHandoff,
  requiredChecksSucceeded,
  unrunPlannedJobs,
  verifyFrontOfQueue,
  type Ejection,
  type MergeBarSnapshot,
  type MergeQueueRemoval,
  type RunJob,
} from "./merge-bar";
import {
  parseCiCoverageLog,
  type CiCoverageEvidence,
  type CiRunEvidence,
} from "./merge-bar-ci-coverage";
import { RATCHET_METRICS } from "./ratchet";
import ratchetDefinitionPaths from "./ratchet-definition-paths.json" with { type: "json" };

// The CLI runs below spawn the real script offline against a fake gh, as a
// local test run; its source freshness check is covered in
// merge-bar-freshness.test.ts.
const CLI_TEST_ENV = {
  NODE_ENV: "test",
  STELLA_LOCAL_DEV: "1",
  STELLA_MERGE_BAR_TEST_SKIP_FRESHNESS: "1",
};

const HEAD_SHA = "1f0c3a7d9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a8d";
const OTHER_SHA = "9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a8d6f0e1b3c";
const BASE_MIGRATION = "apps/api/drizzle/20260801120000_original/migration.sql";
const ALIAS_INVENTORY = "apps/api/src/lib/db/migration-alias-inventory.json";

type MigrationGatewayOptions = {
  changedFiles?: number;
  repo?: string;
  detailsUrl?: string;
  claTitle?: string;
  dispatchedCiConclusion?: string;
};

const runMigrationGateway = (
  files: readonly Record<string, string>[],
  {
    changedFiles = files.length,
    repo = "stella/stella",
    detailsUrl = "https://github.com/stella/stella/actions/runs/1",
    claTitle = "",
    dispatchedCiConclusion = "",
  }: MigrationGatewayOptions = {},
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
  'variable get STELLA_MERGE_HOLD --repo '*) printf '%s\\n' 'variable STELLA_MERGE_HOLD was not found' >&2; exit 1;;
  *reviewThreads*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false}}';;
  *'api graphql'*) printf '%s\\n' "$FIXTURE_PULL_REQUEST";;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci-result"}]}}]';;
  *'actions/runs?head_sha='*)
    printf '7\\t.github/workflows/ci.yml\\tpull_request\\n'
    if [ -n "$FIXTURE_DISPATCHED_CI" ]; then
      printf '8\\t.github/workflows/ci.yml\\tworkflow_dispatch\\n'
    fi;;
  *check-runs/1*) printf '%s\\n' "$FIXTURE_CHECK_RUN";;
  *actions/runs/1*) printf '%s\\n' '{"head_sha":"${HEAD_SHA}","pull_requests":[{"number":123,"head":{"sha":"${HEAD_SHA}"},"base":{"ref":"main","sha":"${OTHER_SHA}"}}]}';;
  *compare/*) printf '%s\\n' '{"status":"identical"}';;
  *check-runs*)
    printf '1\\tci-result\\tcompleted\\tsuccess\\t\\t7\\n'
    if [ -n "$FIXTURE_DISPATCHED_CI" ]; then
      printf '9\\tci-result\\tcompleted\\t%s\\t\\t8\\n' "$FIXTURE_DISPATCHED_CI"
    fi
    if [ -n "$FIXTURE_CLA_TITLE" ]; then
      case "$*" in
        *'.output.title'*) printf '2\\tcla\\tcompleted\\tfailure\\t%s\\n' "$FIXTURE_CLA_TITLE";;
        *) printf '2\\tcla\\tcompleted\\tfailure\\n';;
      esac
    fi;;
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
        "--repo",
        repo,
      ],
      env: {
        ...process.env,
        ...CLI_TEST_ENV,
        PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
        FIXTURE_PULL_REQUEST: pullRequest,
        FIXTURE_CHECK_RUN: JSON.stringify({ details_url: detailsUrl }),
        FIXTURE_CLA_TITLE: claTitle,
        FIXTURE_DISPATCHED_CI: dispatchedCiConclusion,
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
  {
    id = 1,
    outputTitle = "",
    checkSuiteId,
  }: { id?: number; outputTitle?: string; checkSuiteId?: number } = {},
) => ({
  id,
  name,
  status,
  conclusion,
  outputTitle,
  ...(checkSuiteId === undefined ? {} : { checkSuiteId }),
});

/** A declared repository without stella's migrations or ratchet. */
const PRIVATE_REPO = "stella/stella-infra";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  'variable get STELLA_MERGE_HOLD --repo '*) printf '%s\\n' 'variable STELLA_MERGE_HOLD was not found' >&2; exit 1;;
  *reviewThreads*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false}}';;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"Overlay check"}]}}]';;
  *'actions/runs?head_sha='*) ;;
  *check-runs/1*) printf '%s\\n' '{"details_url":"https://github.com/stella/stella/actions/runs/1"}';;
  *actions/runs/1*) printf '%s\\n' '{"head_sha":"${HEAD_SHA}","pull_requests":[{"number":123,"head":{"sha":"${HEAD_SHA}"},"base":{"ref":"main","sha":"${OTHER_SHA}"}}]}';;
  *compare/*) printf '%s\\n' '{"status":"identical"}';;
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
          ...CLI_TEST_ENV,
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

  test.each(["fix: something", "chore: release v0.9.42"])(
    "an already queued PR keeps its place without --jump: %s",
    (title) => {
      const directory = mkdtempSync(path.join(tmpdir(), "merge-bar-queued-"));
      const executable = path.join(directory, "gh");
      const response = JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              id: "PR_fixture",
              number: 123,
              title,
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
  'variable get STELLA_MERGE_HOLD --repo '*) printf '%s\\n' 'variable STELLA_MERGE_HOLD was not found' >&2; exit 1;;
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
            ...CLI_TEST_ENV,
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
    },
  );

  // The mutation can report first place before the fresh queue read agrees.
  test.each([
    {
      queuedAt: 3,
      jump: true,
      absent: true,
      mutationJump: true,
      exitCode: 2,
      output: "queue read did not list it yet",
    },
    {
      queuedAt: 3,
      jump: false,
      absent: true,
      mutationJump: false,
      exitCode: 1,
      output: "GitHub queued the PR without the jump (position 1)",
    },
    {
      queuedAt: 3,
      jump: true,
      mutationJump: false,
      exitCode: 2,
      output: "JUMP PENDING (position 3, state QUEUED)",
    },
    { queuedAt: 3, jump: false, exitCode: 1, output: "JUMP DROPPED" },
    { queuedAt: 3, jump: undefined, exitCode: 1, output: "JUMP DROPPED" },
    {
      queuedAt: 3,
      jump: true,
      exitCode: 2,
      output: "JUMP PENDING (position 3, state QUEUED)",
    },
    {
      queuedAt: 1,
      jump: true,
      exitCode: 0,
      output: "verified first in the queue",
    },
  ])(
    "an explicit release jump stays exempt from a hold and is verified after enqueueing: position $queuedAt, jump $jump, absent $absent, mutation jump $mutationJump",
    ({
      queuedAt,
      jump,
      absent = false,
      mutationJump = true,
      exitCode,
      output,
    }) => {
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
              updatedAt: "2026-10-02T09:00:00Z",
              baseRefName: "main",
              autoMergeRequest: null,
              mergeQueueEntry: null,
            },
          },
        },
      });
      const others = [4101, 4102].map((number, index) => ({
        position: index < queuedAt - 1 ? index + 1 : index + 2,
        jump: false,
        state: "QUEUED",
        pullRequest: { number },
      }));
      const queue = JSON.stringify({
        data: {
          repository: {
            mergeQueue: {
              entries: {
                totalCount: absent ? 2 : 3,
                nodes: absent
                  ? others
                  : [
                      ...others,
                      {
                        position: queuedAt,
                        jump,
                        state: "QUEUED",
                        pullRequest: { number: 123 },
                      },
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
  'variable get STELLA_MERGE_HOLD --repo '*) printf '%s\\n' 'release pending';;
  'pr list '*)
    case "$*" in
      *--jq*) printf '%s\\n' '123';;
      *) printf '%s\\n' '[{"number":123,"title":"chore: release v0.9.42","isDraft":false,"isCrossRepository":false}]';;
    esac;;
  *REMOVED_FROM_MERGE_QUEUE_EVENT*) printf '%s\\n' '[]';;
  *enqueuePullRequest*)
    case "$*" in *'mergeQueueEntry { id position jump state }'*) ;; *) exit 97;; esac
    printf '%s\\n' '{"data":{"enqueuePullRequest":{"mergeQueueEntry":{"id":"entry","position":1,"jump":${mutationJump},"state":"QUEUED","headCommit":{"oid":"${HEAD_SHA}"}}}}}';;
  *'mergeQueue(branch'*)
    case "$*" in *'position jump state pullRequest'*) ;; *) exit 98;; esac
    printf '%s\\n' '${queue}';;
  *reviewThreads*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false}}';;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci-result"}]}},{"type":"merge_queue","parameters":{}}]';;
  *'actions/runs?head_sha='*) ;;
  *check-runs/1*) printf '%s\\n' '{"details_url":"https://github.com/stella/stella/actions/runs/1"}';;
  *actions/runs/1*) printf '%s\\n' '{"head_sha":"${HEAD_SHA}","pull_requests":[{"number":123,"head":{"sha":"${HEAD_SHA}"},"base":{"ref":"main","sha":"${OTHER_SHA}"}}]}';;
  *compare/*) printf '%s\\n' '{"status":"identical"}';;
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
            "--jump",
          ],
          env: {
            ...process.env,
            ...CLI_TEST_ENV,
            PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode).toBe(exitCode);
        expect(
          `${result.stdout.toString()}${result.stderr.toString()}`,
        ).toContain(output);
        if (absent) {
          expect(result.stderr.toString()).toContain(
            exitCode === 2
              ? "JUMP PENDING (position 1, state QUEUED)"
              : "JUMP DROPPED",
          );
        }
        if (exitCode === 2) {
          expect(result.stderr.toString()).toContain(
            `next: wait once for ${PRIVATE_REPO}#123 to merge, close or fail checks; do not jump again.`,
          );
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  // A real run refuses to jump while checks are running; a dry run of the same
  // state must report the same failure instead of a merge verdict.
  test.each([[], ["--dry-run"]])(
    "an explicit release jump with running checks exits non-zero without writing: %j",
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
  'variable get STELLA_MERGE_HOLD --repo '*) printf '%s\\n' 'variable STELLA_MERGE_HOLD was not found' >&2; exit 1;;
  *'pr merge'*|*enqueuePullRequest*) exit 98;;
  *REMOVED_FROM_MERGE_QUEUE_EVENT*) printf '%s\\n' '[]';;
  *reviewThreads*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false}}';;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci-result"}]}},{"type":"merge_queue","parameters":{}}]';;
  *'actions/runs?head_sha='*) ;;
  *check-runs/1*) printf '%s\\n' '{"details_url":"https://github.com/stella/stella/actions/runs/1"}';;
  *actions/runs/1*) printf '%s\\n' '{"head_sha":"${HEAD_SHA}","pull_requests":[{"number":123,"head":{"sha":"${HEAD_SHA}"},"base":{"ref":"main","sha":"${OTHER_SHA}"}}]}';;
  *compare/*) printf '%s\\n' '{"status":"identical"}';;
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
            "--jump",
            ...extraArguments.flat(),
          ],
          env: {
            ...process.env,
            ...CLI_TEST_ENV,
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

  test("a dispatched CI run on the head does not override the pull request's CI", () => {
    const result = runMigrationGateway([], {
      changedFiles: 0,
      dispatchedCiConclusion: "failure",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("verdict: MERGE (dry run");
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
    const result = runMigrationGateway([], { changedFiles: 1 });
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
      mergeBarRepositoryPolicy("stella/folio", [
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
    expect(() => mergeBarRepositoryPolicy("stella/folio", [])).toThrow(
      "No required status checks are active for stella/folio",
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

describe("explicit merge queue jumps", () => {
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

  test("without a jump, existing auto-merge fields still require verified arming", () => {
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
    ).toEqual({ kind: "arm" });
  });

  test.each([
    { position: 6, jump: false, exitCode: 1, verdict: "JUMP DROPPED" },
    { position: 6, jump: true, exitCode: 2, verdict: "JUMP PENDING" },
    { position: 1, jump: true, exitCode: 0, verdict: "QUEUED AT THE FRONT" },
    { position: 1, jump: false, exitCode: 0, verdict: "QUEUED AT THE FRONT" },
  ])(
    "a single queue read distinguishes position $position with jump $jump",
    ({ position, jump, exitCode, verdict }) => {
      let reads = 0;
      const result = verifyFrontOfQueue({
        gateway: {
          readMergeQueue: (branch) => {
            expect(branch).toBe("main");
            reads += 1;
            return [{ pullNumber: 4112, position, jump, state: "QUEUED" }];
          },
        },
        pullNumber: 4112,
        repo: PRIVATE_REPO,
        branch: "main",
        context: "jump accepted",
        release: false,
      });
      expect(result.exitCode).toBe(exitCode);
      expect(result.message).toContain(verdict);
      expect(reads).toBe(1);
      if (exitCode === 2) {
        expect(result.message).toContain("position 6, state QUEUED");
        expect(result.message).toContain(
          `next: wait once for ${PRIVATE_REPO}#4112 to merge, close or fail checks; do not jump again.`,
        );
      }
    },
  );

  test.each([
    { entries: [] },
    {
      entries: [
        { pullNumber: 4112, position: 1, jump: true, state: "QUEUED" },
        { pullNumber: 4101, position: 0, jump: false, state: "QUEUED" },
      ],
    },
  ])("incomplete or conflicting queue reads fail closed: %j", ({ entries }) => {
    const verdict = verifyFrontOfQueue({
      gateway: { readMergeQueue: () => entries },
      pullNumber: 4112,
      repo: PRIVATE_REPO,
      branch: "main",
      context: "jump accepted",
      release: false,
    });
    expect(verdict.exitCode).toBe(1);
    expect(verdict.message).toContain("JUMP DROPPED");
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

describe("pull request check runs", () => {
  const ci = (checkSuiteId: number, event: string) => ({
    checkSuiteId,
    path: ".github/workflows/ci.yml",
    event,
  });

  test("a dispatched CI run on the same head neither blocks nor passes the pull request", () => {
    const required = ["ci-result"];
    const prGreen = checkRun("ci-result", "completed", "success", {
      id: 10,
      checkSuiteId: 1,
    });
    const dispatchedRed = checkRun("ci-result", "completed", "failure", {
      id: 20,
      checkSuiteId: 2,
    });
    const workflowRuns = [ci(1, "pull_request"), ci(2, "workflow_dispatch")];

    const judged = pullRequestCheckRuns({
      checkRuns: [prGreen, dispatchedRed],
      workflowRuns,
    });
    expect(judged).toEqual([prGreen]);
    expect(
      requiredChecksSucceeded({
        checkRuns: judged,
        requiredCheckRuns: required,
      }),
    ).toBe(true);

    const dispatchedGreen = { ...dispatchedRed, conclusion: "success" };
    const prRed = { ...prGreen, conclusion: "failure" };
    expect(
      requiredChecksSucceeded({
        checkRuns: pullRequestCheckRuns({
          checkRuns: [prRed, dispatchedGreen],
          workflowRuns,
        }),
        requiredCheckRuns: required,
      }),
    ).toBe(false);
  });

  test("merge-group CI runs and check runs from other workflows are kept", () => {
    const mergeGroup = checkRun("ci-result", "completed", "success", {
      id: 30,
      checkSuiteId: 3,
    });
    const cla = checkRun("cla", "completed", "success", {
      id: 40,
      checkSuiteId: 4,
    });
    const unknownSuite = checkRun("dependency-review", "completed", "success", {
      id: 50,
    });
    expect(
      pullRequestCheckRuns({
        checkRuns: [mergeGroup, cla, unknownSuite],
        workflowRuns: [
          ci(3, "merge_group"),
          {
            checkSuiteId: 4,
            path: ".github/workflows/cla.yml",
            event: "workflow_dispatch",
          },
        ],
      }),
    ).toEqual([mergeGroup, cla, unknownSuite]);
  });
});

describe("repository merge hold", () => {
  test.each([
    { checkedByWorkflow: "1", githubActions: "true", expectedReads: 0 },
    { checkedByWorkflow: "1", githubActions: undefined, expectedReads: 1 },
    { checkedByWorkflow: undefined, githubActions: "true", expectedReads: 1 },
    { checkedByWorkflow: "0", githubActions: "true", expectedReads: 1 },
    { checkedByWorkflow: "1", githubActions: "false", expectedReads: 1 },
  ])(
    "workflow hold checks require both flags: %j",
    ({ checkedByWorkflow, githubActions, expectedReads }) => {
      let variableReads = 0;
      let releaseReads = 0;
      const result = checkMergeHold({
        checkedByWorkflow,
        githubActions,
        readVariable: () => {
          variableReads += 1;
          return Result.ok("release pending");
        },
        readIsRelease: () => {
          releaseReads += 1;
          return Result.ok(false);
        },
      });
      expect(variableReads).toBe(expectedReads);
      expect(releaseReads).toBe(expectedReads);
      expect(result.isOk()).toBe(expectedReads === 0);
      if (result.isOk()) {
        expect(result.value).toEqual({ source: "workflow" });
      } else {
        expect(result.error.message).toBe("MERGE HOLD: release pending");
      }
    },
  );

  test.each([null, ""])(
    "an absent or empty hold allows ordinary pull requests: %j",
    (reason) => {
      let releaseReads = 0;
      const result = checkMergeHold({
        readVariable: () => Result.ok(reason),
        readIsRelease: () => {
          releaseReads += 1;
          return Result.ok(false);
        },
      });
      expect(result.isOk()).toBe(true);
      expect(releaseReads).toBe(0);
    },
  );

  test.each(["release pending", " "])(
    "a non-empty hold refuses ordinary pull requests: %j",
    (reason) => {
      const result = checkMergeHold({
        readVariable: () => Result.ok(reason),
        readIsRelease: () => Result.ok(false),
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toBe(`MERGE HOLD: ${reason}`);
      }
    },
  );

  test("a recognized release remains allowed during a hold", () => {
    const result = checkMergeHold({
      readVariable: () => Result.ok("release pending"),
      readIsRelease: () => Result.ok(true),
    });
    expect(result.isOk()).toBe(true);
  });

  test("a variable read error refuses even a release", () => {
    const error = new MergeHoldReadError({
      message: "variable read unavailable",
    });
    const result = checkMergeHold({
      readVariable: () => Result.err(error),
      readIsRelease: () => Result.ok(true),
    });
    expect(result.isErr() && result.error).toBe(error);
  });

  test("a release recognition error refuses while a hold is active", () => {
    const error = new MergeHoldReadError({ message: "listing unavailable" });
    const result = checkMergeHold({
      readVariable: () => Result.ok("release pending"),
      readIsRelease: () => Result.err(error),
    });
    expect(result.isErr() && result.error).toBe(error);
  });

  test.each([{ arguments: [] }, { arguments: ["--jump"] }])(
    "the CLI refuses a hold before merge writes: $arguments",
    ({ arguments: extraArguments }) => {
      const directory = mkdtempSync(path.join(tmpdir(), "merge-bar-hold-"));
      const executable = path.join(directory, "gh");
      writeFileSync(
        executable,
        `#!/bin/sh
case "$*" in
  'variable get STELLA_MERGE_HOLD --repo '*) printf '%s\\n' 'release pending';;
  'pr list '*)
    case "$*" in
      *--jq*) printf '\\n';;
      *) printf '%s\\n' '[]';;
    esac;;
  *) echo 'unexpected GitHub operation' >&2; exit 99;;
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
            ...extraArguments,
          ],
          env: {
            ...process.env,
            ...CLI_TEST_ENV,
            PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain(
          "MERGE HOLD: release pending",
        );
        expect(result.stderr.toString()).not.toContain(
          "unexpected GitHub operation",
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

// A production-shaped planner and gate: main's rule for the PR's file (and
// any line appended to the selector) is what varies between cases.
const planWorkflow = (rule: string, selectorTail = "") => `
jobs:
  ci-plan:
    outputs:
      e2e_production_required: \${{ steps.changed-files.outputs.e2e_production_required }}
      marketing_screenshots_required: \${{ steps.marketing-release.outputs.required }}
    steps:
      - id: changed-files
        run: |
          # Path scopes for the build/smoke jobs
          e2e_production_required=false
          for file in "\${changed_files[@]}"; do
            case "$file" in
              ${rule}) e2e_production_required=true ;;
            esac
          done
          ${selectorTail}
          printf 'Changed files:\\n'
  e2e-production-shard:
    strategy:
      matrix:
        shard: [1, 2]
  marketing-screenshots: {}
  parser-version-guard: {}
  ci-result:
    steps:
      - name: Evaluate CI outcome
        env:
          FAST_REQUIRED: '["e2e-production-shard", "marketing-screenshots", "parser-version-guard"]'
          JOB_SCOPES: '{"e2e-production-shard": "e2e_production_required", "marketing-screenshots": "marketing_screenshots_required", "parser-version-guard": null}'
          FAST_JOB_SCOPES: '{}'
`;
const PR_FILE = "apps/web/e2e/production/new.spec.ts";
const SELECTING_RULE = "apps/web/e2e/*";
const UNRELATED_RULE = "docs/never/*";
const guard = { name: "parser-version-guard", conclusion: "success" };
const shard = (leg: number, conclusion: string) => ({
  name: `e2e-production-shard (${leg})`,
  conclusion,
});
describe("green result freshness", () => {
  const run = {
    id: 77,
    head_sha: HEAD_SHA,
    pull_requests: [
      {
        number: 2137,
        head: { sha: HEAD_SHA },
        base: { ref: "main", sha: OTHER_SHA },
      },
    ],
  };
  const baseDefinitions = ({
    readDefinitionPaths = (branch: string) => {
      expect(branch).toBe("main");
      return ratchetDefinitionPaths;
    },
    recheck = () => {
      throw new Error("unexpected ratchet recheck");
    },
  }: Partial<
    Omit<Extract<RatchetFreshness, { type: "base-definitions" }>, "type">
  >): RatchetFreshness => ({
    type: "base-definitions",
    readDefinitionPaths,
    recheck,
  });
  const readers = (comparison: unknown) => ({
    pullRequest: passingSnapshot().pullRequest,
    jump: false,
    checkRuns: passingSnapshot().checkRuns,
    readWorkflowRun: () => run,
    readBaseComparison: (sha: string, branch: string) => {
      expect(sha).toBe(OTHER_SHA);
      expect(branch).toBe("main");
      return comparison;
    },
    readPullFiles: () => ["scripts/shared.ts"],
    readBaseWorkflow: () => null,
    readTestedBaseWorkflow: () => "jobs: {}",
    readHeadWorkflow: () => "jobs: {}",
    runSelector: () => {
      throw new Error("unexpected plan run");
    },
    readRunCoverage: () => Result.ok({ profile: "normal-v1" as const }),
    readRunJobs: () => {
      throw new Error("unexpected run jobs read");
    },
    ratchet: baseDefinitions({}),
    mergeGroupRetests: true,
  });

  test("a direct merge still refuses a green result once main has moved", () => {
    const direct = (comparison: unknown, pullFiles = ["scripts/shared.ts"]) =>
      checkGreenResultFreshness({
        ...readers(comparison),
        readPullFiles: () => pullFiles,
        mergeGroupRetests: false,
      });
    for (const [comparison, pullFiles, message] of [
      [
        { status: "ahead", ahead_by: 21, files: [] },
        undefined,
        "main advanced 21 commits since the green run (limit 20)",
      ],
      [
        {
          status: "ahead",
          ahead_by: 1,
          files: Array.from({ length: 300 }, () => ({
            filename: "unrelated.ts",
          })),
        },
        undefined,
        "cannot establish complete changed-file coverage for main",
      ],
      [
        {
          status: "ahead",
          ahead_by: 1,
          files: [{ filename: "scripts/shared.ts" }],
        },
        undefined,
        "main changed files also touched by this PR: scripts/shared.ts",
      ],
      [
        {
          status: "ahead",
          ahead_by: 1,
          files: [{ filename: "scripts/ownership.ts" }],
        },
        ["scripts/ratchet.ts"],
        "main changed the ratchet since the green run (scripts/ownership.ts) and this PR changes it too",
      ],
      [
        {
          status: "ahead",
          ahead_by: 1,
          files: [{ filename: "scripts/ownership/example.ts" }],
        },
        ["scripts/ownership/another.ts"],
        "main changed the ratchet since the green run (scripts/ownership/example.ts) and this PR changes it too",
      ],
    ] as const) {
      const result = direct(
        comparison,
        pullFiles === undefined ? undefined : [...pullFiles],
      );
      expect(result.isErr(), message).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain(message);
      }
    }
  });

  test("unchanged base and up to twenty unrelated commits retain green results", () => {
    expect(
      checkGreenResultFreshness(readers({ status: "identical" })).isOk(),
    ).toBe(true);
    for (const ahead_by of [1, 19, 20]) {
      expect(
        checkGreenResultFreshness(
          readers({
            status: "ahead",
            ahead_by,
            files: [{ filename: "unrelated.ts" }],
          }),
        ).isOk(),
      ).toBe(true);
    }
  });

  // The merge group re-runs full CI on the real merge commit, so main moving
  // under a green PR is never by itself a reason to run its CI again.
  test("overlapping edits and rename sources keep a green result queueable", () => {
    for (const file of [
      { filename: "scripts/shared.ts" },
      {
        filename: "scripts/renamed.ts",
        previous_filename: "scripts/shared.ts",
      },
    ]) {
      const result = checkGreenResultFreshness(
        readers({ status: "ahead", ahead_by: 1, files: [file] }),
      );
      expect(result.isOk()).toBe(true);
    }
  });

  const planReaders = ({
    rule,
    runJobs,
  }: {
    rule: string;
    runJobs: readonly RunJob[];
  }) => ({
    // Main changed only its CI workflow since the green run.
    ...readers({
      status: "ahead",
      ahead_by: 1,
      files: [{ filename: ".github/workflows/ci.yml" }],
    }),
    readPullFiles: () => [PR_FILE],
    readBaseWorkflow: () => planWorkflow(rule),
    readTestedBaseWorkflow: () => planWorkflow(rule),
    readHeadWorkflow: () => planWorkflow(rule),
    runSelector: (input: {
      selector: string;
      files: readonly string[];
      outputs: readonly string[];
      title: string;
    }) => runPlanScopes({ ...input, cwd: REPO_ROOT }),
    readRunJobs: (runId: number) => {
      expect(runId).toBe(77);
      return runJobs;
    },
  });

  test.each([
    {
      name: "a ci.yml change that selects nothing new for the PR's files passes",
      rule: UNRELATED_RULE,
      runJobs: [guard, { name: "e2e-production-shard", conclusion: "skipped" }],
      stale: [],
    },
    {
      name: "a new rule selecting a job the green run skipped refuses",
      rule: SELECTING_RULE,
      runJobs: [guard, { name: "e2e-production-shard", conclusion: "skipped" }],
      stale: ["e2e-production-shard"],
    },
    {
      name: "a new rule selecting a job absent from the green run refuses",
      rule: SELECTING_RULE,
      runJobs: [guard],
      stale: ["e2e-production-shard"],
    },
    {
      name: "the selected job succeeded on every leg in the green run: passes",
      rule: SELECTING_RULE,
      runJobs: [guard, shard(1, "success"), shard(2, "success")],
      stale: [],
    },
    {
      name: "a selected matrix leg that did not succeed refuses",
      rule: SELECTING_RULE,
      runJobs: [guard, shard(1, "success"), shard(2, "cancelled")],
      stale: ["e2e-production-shard"],
    },
    {
      name: "an always-planned required job the green run lacked refuses",
      rule: UNRELATED_RULE,
      runJobs: [],
      stale: ["parser-version-guard"],
    },
  ])("$name", ({ rule, runJobs, stale }) => {
    const options = planReaders({ rule, runJobs });
    // Only the plan rule can refuse: main and the PR touch disjoint files.
    expect(options.readPullFiles()).not.toContain(".github/workflows/ci.yml");
    const result = checkGreenResultFreshness(options);
    expect(result.isErr()).toBe(stale.length > 0);
    if (result.isErr()) {
      expect(result.error.message).toBe(
        `STALE_PLAN: main's CI plan now selects ${stale.join(", ")} for this PR's files, ` +
          "which its green run did not run; merge main and let CI re-run.",
      );
    }
  });

  const workflowWithJobs = (...jobs: string[]) =>
    Bun.YAML.stringify({
      jobs: Object.fromEntries(jobs.map((job) => [job, {}])),
    });

  test("a job the PR removed does not make its green result stale", () => {
    const result = checkGreenResultFreshness({
      ...planReaders({ rule: SELECTING_RULE, runJobs: [guard] }),
      readTestedBaseWorkflow: () => workflowWithJobs("e2e-production-shard"),
      readHeadWorkflow: () => workflowWithJobs("replacement-job"),
    });

    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(
      true,
    );
  });

  test.each([
    {
      name: "main added the unrun job after the tested base",
      testedBaseWorkflow: workflowWithJobs("existing-job"),
      headWorkflow: workflowWithJobs("replacement-job"),
      detail: "STALE_PLAN: main's CI plan now selects e2e-production-shard",
    },
    {
      name: "the PR head keeps the unrun job",
      testedBaseWorkflow: workflowWithJobs("e2e-production-shard"),
      headWorkflow: workflowWithJobs("e2e-production-shard"),
      detail: "STALE_PLAN: main's CI plan now selects e2e-production-shard",
    },
    {
      name: "the tested-base workflow is unreadable",
      testedBaseWorkflow: null,
      headWorkflow: workflowWithJobs("replacement-job"),
      detail: "cannot compare CI jobs at the tested base and PR head",
    },
    {
      name: "the head workflow is unreadable",
      testedBaseWorkflow: workflowWithJobs("e2e-production-shard"),
      headWorkflow: null,
      detail: "cannot compare CI jobs at the tested base and PR head",
    },
  ])(
    "$name refuses the green result",
    ({ testedBaseWorkflow, headWorkflow, detail }) => {
      const result = checkGreenResultFreshness({
        ...planReaders({ rule: SELECTING_RULE, runJobs: [guard] }),
        readTestedBaseWorkflow: (sha) => {
          expect(sha).toBe(OTHER_SHA);
          return testedBaseWorkflow;
        },
        readHeadWorkflow: () => headWorkflow,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain(detail);
      }
    },
  );

  test("a planner main cannot evaluate refuses rather than passes", () => {
    const result = checkGreenResultFreshness({
      ...planReaders({ rule: SELECTING_RULE, runJobs: [] }),
      runSelector: () =>
        Result.err(new PlanSelectorError({ message: "selector exited 1" })),
    });
    expect(result.isErr() && result.error.message).toContain(
      "cannot evaluate main's CI plan: selector exited 1",
    );
  });

  test.each([
    { tail: "exit 1", detail: "ci-plan selector exited 1" },
    {
      tail: "echo broken >&2; exit 3",
      detail: "ci-plan selector exited 3: broken",
    },
    {
      tail: "e2e_production_required=maybe",
      detail: 'ci-plan selector set e2e_production_required to "maybe"',
    },
    {
      tail: "unset e2e_production_required",
      detail: 'ci-plan selector set e2e_production_required to ""',
    },
  ])(
    "main's planner failing with `$tail` refuses through the real selector",
    ({ tail, detail }) => {
      const result = checkGreenResultFreshness({
        ...planReaders({
          rule: SELECTING_RULE,
          runJobs: [guard, shard(1, "success"), shard(2, "success")],
        }),
        readBaseWorkflow: () => planWorkflow(UNRELATED_RULE, tail),
      });
      expect(result.isErr() && result.error.message).toContain(
        `cannot evaluate main's CI plan: ${detail}`,
      );
    },
  );

  test("green pilot coverage defers only jobs guarded by the actual pilot predicate", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf-8",
    );
    const jobs = readFastRequiredJobs(source) ?? [];
    const fast = pilotFastJobs(Bun.YAML.parse(source));
    if (fast.status !== "valid") {
      panic(fast.message);
    }
    const deferred = jobs.filter(
      (job) =>
        job.pilotGate === "deferred-capable" && !fast.jobs.includes(job.id),
    );
    expect(deferred.map((job) => job.id)).toContain("dependency-malware");
    expect(deferred.map((job) => job.id)).toContain("parser-version-guard");
    const plan = new Map(
      jobs.flatMap(({ scope }) =>
        scope.type === "selector" ? [[scope.variable, true] as const] : [],
      ),
    );
    const completed = jobs
      .filter((job) => !deferred.includes(job))
      .map((job) => ({ name: job.id, conclusion: "success" }));
    const evaluateFreshness = (
      profile: "normal-v1" | "pilot-fast-v1",
      runs: readonly RunJob[],
    ) =>
      checkGreenResultFreshness({
        ...readers({ status: "ahead", ahead_by: 1, files: [] }),
        readBaseWorkflow: () => source,
        runSelector: () => Result.ok(plan),
        readRunJobs: () => runs,
        readRunCoverage: () =>
          Result.ok(
            profile === "normal-v1"
              ? { profile }
              : { profile, jobs: fast.jobs },
          ),
      });
    expect(evaluateFreshness("pilot-fast-v1", completed).isOk()).toBe(true);
    const missing = evaluateFreshness(
      "pilot-fast-v1",
      completed.filter((job) => job.name !== "ci-tests"),
    );
    expect(missing.isErr() && missing.error.message).toContain(
      "STALE_PLAN: main's CI plan now selects ci-tests",
    );
    const normal = evaluateFreshness("normal-v1", completed);
    expect(normal.isErr() && normal.error.message).toContain(
      "parser-version-guard",
    );
    expect(
      evaluateFreshness(
        "normal-v1",
        jobs.map((job) => ({ name: job.id, conclusion: "success" })),
      ).isOk(),
    ).toBe(true);
  });

  test("every fast-required predicate rejects a planted unmodeled gate", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf-8",
    );
    const original = readFastRequiredJobs(source) ?? [];
    expect(original.length).toBeGreaterThan(0);
    for (const job of original) {
      const workflow = v.parse(
        v.record(v.string(), v.unknown()),
        Bun.YAML.parse(source),
      );
      const jobs = v.parse(v.record(v.string(), v.unknown()), workflow["jobs"]);
      const body = v.parse(v.record(v.string(), v.unknown()), jobs[job.id]);
      jobs[job.id] = body;
      workflow["jobs"] = jobs;
      body["if"] =
        `(${v.parse(v.string(), body["if"])}) && vars.UNMODELED_GATE == 'on'`;
      expect(
        () => readFastRequiredJobs(JSON.stringify(workflow)),
        job.id,
      ).toThrow(`Unmodeled fast-required predicate: ${job.id}`);
      const condition = v.parse(v.string(), body["if"]);
      const contexts = [
        ...new Set(
          Array.from(
            condition.matchAll(
              /(?:needs\.ci-plan\.outputs\.\w+|inputs\.heavy_only|github\.event_name)/gu,
            ),
            (match) => match[0],
          ),
        ),
      ];
      expect(contexts.length, job.id).toBeGreaterThan(0);
      for (const gate of contexts) {
        body["if"] = condition
          .replaceAll(gate, "vars.UNMODELED_GATE")
          .replace(" && vars.UNMODELED_GATE == 'on'", "");
        expect(
          () => readFastRequiredJobs(JSON.stringify(workflow)),
          `${job.id}: ${gate}`,
        ).toThrow(`Unmodeled fast-required predicate: ${job.id}`);
      }
    }
  });

  test("coverage log parsing retains the zero super-linear-regex budget", () => {
    const metric = RATCHET_METRICS.find(
      (entry) => entry.id === "super-linear-regexes",
    );
    if (metric?.scope !== "file" || metric.measurement !== undefined) {
      panic("Missing super-linear regex file metric");
    }
    const file = "scripts/merge-bar-ci-coverage.ts";
    const legacy = String.raw`const entry = /^\s+([A-Z_]+):\s*(.*)$/u;`;
    expect(metric.count(legacy, { file })).toBe(1);
    expect(
      metric.count(readFileSync(path.join(REPO_ROOT, file), "utf-8"), { file }),
    ).toBe(0);
  });

  test("coverage evidence follows timestamped entries across raw multiline values", () => {
    const log = `2000-01-01T00:00:00.0000000Z ##[group]Run neutral command
2000-01-01T00:00:00.0000000Z env:
2000-01-01T00:00:00.0000000Z   NEEDS: {
  "neutral": {
    "result": "success"
  }
}
2000-01-01T00:00:00.0000000Z   MULTILINE: neutral
  COVERAGE_PROFILE: normal-v1
  PILOT_FAST_JOBS: []
##[endgroup]
env:
2000-01-01T00:00:00.0000000Z   COVERAGE_PROFILE: pilot-fast-v1
2000-01-01T00:00:00.0000000Z   PILOT_FAST_JOBS: ["ci-tests"]
2000-01-01T00:00:00.0000000Z ##[endgroup]
`;
    const result = parseCiCoverageLog(log);
    expect(result.isOk() && result.value).toEqual({
      profile: "pilot-fast-v1",
      jobs: ["ci-tests"],
    });
    const forged = log.replace(
      "2000-01-01T00:00:00.0000000Z   COVERAGE_PROFILE: pilot-fast-v1\n",
      "",
    );
    expect(parseCiCoverageLog(forged).isErr()).toBe(true);
    const continued = log.replace(
      "  COVERAGE_PROFILE: pilot-fast-v1\n",
      "  COVERAGE_PROFILE: pilot-fast-v1\ninvalid continuation\n",
    );
    expect(parseCiCoverageLog(continued).isErr()).toBe(true);
  });

  test("every saved real CI-result log yields its declared coverage evidence", () => {
    const pilot = {
      profile: "pilot-fast-v1",
      jobs: [
        "ci-checks-docs",
        "ci-checks-generated",
        "ci-checks-policy",
        "ci-checks-rest",
        "ci-generated-sources",
        "ci-plan",
        "ci-result",
        "ci-tests",
        "code-quality-api",
        "code-quality-rest",
        "code-quality-web",
        "typecheck-baseline",
      ],
    } satisfies CiCoverageEvidence;
    const expected = {
      "merge-bar-coverage-pilot-pr-37632840538.log": pilot,
      "merge-bar-coverage-pilot-pr-37636655670.log": pilot,
      "merge-bar-coverage-queue-validation-37635149518.log": {
        profile: "queue-validation",
      },
      "merge-bar-coverage-merge-group-37635202900.log": {
        profile: "normal-v1",
      },
      "merge-bar-coverage-merge-group-37635199875.log": {
        profile: "normal-v1",
      },
      "merge-bar-coverage-queue-validation-37646416358.log": {
        profile: "queue-validation",
      },
      // Retain the previously saved single-line env envelope too.
      "merge-bar-pilot-coverage.log": pilot,
    } satisfies Record<string, CiRunEvidence>;
    const directory = path.join(REPO_ROOT, "scripts/fixtures");
    expect(
      readdirSync(directory)
        .filter(
          (file) =>
            file.startsWith("merge-bar-coverage-") ||
            file === "merge-bar-pilot-coverage.log",
        )
        .toSorted(),
    ).toEqual(Object.keys(expected).toSorted());
    for (const [file, evidence] of Object.entries(expected)) {
      const result = parseCiCoverageLog(
        readFileSync(path.join(directory, file), "utf-8"),
      );
      expect(
        result.isOk(),
        `${file}: ${result.isErr() ? result.error.message : ""}`,
      ).toBe(true);
      expect(result.isOk() && result.value, file).toEqual(evidence);
    }
  });

  describe("an ejected head's queue validation", () => {
    // Real runs of one head: the pilot-fast coverage run, then the pull_request
    // `enqueued` validation that outlived its ejected merge-queue entry.
    const COVERAGE_RUN = 37_636_655_670;
    const VALIDATION_RUN = 37_646_416_358;
    const fixture = (file: string) =>
      parseCiCoverageLog(
        readFileSync(path.join(REPO_ROOT, "scripts/fixtures", file), "utf-8"),
      );
    const logs = new Map([
      [COVERAGE_RUN, fixture("merge-bar-coverage-pilot-pr-37636655670.log")],
      [
        VALIDATION_RUN,
        fixture("merge-bar-coverage-queue-validation-37646416358.log"),
      ],
    ]);
    const source = readFileSync(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf-8",
    );
    const jobs = readFastRequiredJobs(source) ?? [];
    const fast = pilotFastJobs(Bun.YAML.parse(source));
    if (fast.status !== "valid") {
      panic(fast.message);
    }
    const fastJobs = fast.jobs;
    const plan = new Map(
      jobs.flatMap(({ scope }) =>
        scope.type === "selector" ? [[scope.variable, true] as const] : [],
      ),
    );
    // The validation run plans and aggregates; every other job is skipped.
    const runJobs = new Map<number, RunJob[]>([
      [
        COVERAGE_RUN,
        jobs
          .filter(({ id }) => fastJobs.includes(id))
          .map(({ id }) => ({ name: id, conclusion: "success" })),
      ],
      [
        VALIDATION_RUN,
        jobs.map(({ id }) => ({
          name: id,
          conclusion: id === "ci-result" ? "success" : "skipped",
        })),
      ],
    ]);
    const ciResult = (id: number, conclusion = "success") => ({
      id,
      name: "ci-result",
      status: "completed",
      conclusion,
    });
    const evaluate = (
      ciResults: ReturnType<typeof ciResult>[],
      overrides: Partial<Parameters<typeof checkGreenResultFreshness>[0]> = {},
    ) => {
      const coverageReads: number[] = [];
      const snapshot = passingSnapshot();
      const result = checkGreenResultFreshness({
        ...readers({ status: "ahead", ahead_by: 1, files: [] }),
        checkRuns: [
          ...snapshot.checkRuns.filter(({ name }) => name !== "ci-result"),
          ...ciResults,
        ],
        // Check-run ids stand in for their workflow runs here.
        readWorkflowRun: (checkRunId: number) => ({ ...run, id: checkRunId }),
        readBaseComparison: () => ({ status: "ahead", ahead_by: 1, files: [] }),
        readBaseWorkflow: () => source,
        runSelector: () => Result.ok(plan),
        readRunCoverage: (runId: number) => {
          coverageReads.push(runId);
          return logs.get(runId) ?? panic(`unexpected run ${runId}`);
        },
        readRunJobs: (runId: number) =>
          runJobs.get(runId) ?? panic(`unexpected run ${runId}`),
        ...overrides,
      });
      return { result, coverageReads };
    };

    test("the real logs carry the evidence this relies on", () => {
      const evidence = (runId: number) => {
        const log = logs.get(runId);
        return log?.match({
          ok: (value): CiRunEvidence | string => value,
          err: (error) => error.message,
        });
      };
      expect(evidence(VALIDATION_RUN)).toEqual({ profile: "queue-validation" });
      expect(evidence(COVERAGE_RUN)).toEqual({
        profile: "pilot-fast-v1",
        jobs: [
          "ci-checks-docs",
          "ci-checks-generated",
          "ci-checks-policy",
          "ci-checks-rest",
          "ci-generated-sources",
          "ci-plan",
          "ci-result",
          "ci-tests",
          "code-quality-api",
          "code-quality-rest",
          "code-quality-web",
          "typecheck-baseline",
        ],
      });
    });

    test("is judged by the coverage run it re-checked", () => {
      const { result, coverageReads } = evaluate([
        ciResult(COVERAGE_RUN),
        ciResult(VALIDATION_RUN),
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(
        true,
      );
      expect(coverageReads).toEqual([VALIDATION_RUN, COVERAGE_RUN]);
    });

    test("without a green run below it, refuses instead of trusting skipped jobs", () => {
      const alone = evaluate([ciResult(VALIDATION_RUN)]).result;
      expect(alone.isErr() && alone.error.message).toContain(
        "no green ci-result run below the queue validation covers this head",
      );
      for (const conclusion of ["failure", "cancelled", "skipped"]) {
        const { result, coverageReads } = evaluate([
          ciResult(COVERAGE_RUN, conclusion),
          ciResult(VALIDATION_RUN),
        ]);
        expect(result.isErr(), conclusion).toBe(true);
        expect(coverageReads).toEqual([VALIDATION_RUN]);
      }
    });

    test("the coverage run below it still faces main's new plan", () => {
      const missing = new Map(runJobs);
      missing.set(
        COVERAGE_RUN,
        (runJobs.get(COVERAGE_RUN) ?? []).filter(
          ({ name }) => name !== "ci-tests",
        ),
      );
      const { result } = evaluate(
        [ciResult(COVERAGE_RUN), ciResult(VALIDATION_RUN)],
        {
          readRunJobs: (runId: number) =>
            missing.get(runId) ?? panic(`unexpected run ${runId}`),
        },
      );
      expect(result.isErr() && result.error.message).toContain(
        "STALE_PLAN: main's CI plan now selects ci-tests",
      );
    });
  });

  test("CI result coverage evidence reads producer-shaped environment logs", () => {
    const log = (
      profile: string,
      jobs: string,
    ) => `2000-01-01T00:00:00.0000000Z ##[group]Run if [[ "$QUEUE_DEPTH" == thin ]]; then
2000-01-01T00:00:00.0000000Z shell: /usr/bin/bash -e {0}
2000-01-01T00:00:00.0000000Z env:
2000-01-01T00:00:00.0000000Z   COVERAGE_PROFILE: ${profile}
2000-01-01T00:00:00.0000000Z   PILOT_FAST_JOBS: ${jobs}
2000-01-01T00:00:00.0000000Z ##[endgroup]
`;
    const pilot = parseCiCoverageLog(
      readFileSync(
        path.join(REPO_ROOT, "scripts/fixtures/merge-bar-pilot-coverage.log"),
        "utf-8",
      ),
    );
    expect(pilot.isOk(), pilot.isErr() ? pilot.error.message : "").toBe(true);
    expect(pilot.isOk() && pilot.value).toEqual({
      profile: "pilot-fast-v1",
      jobs: [
        "ci-checks-docs",
        "ci-checks-generated",
        "ci-checks-policy",
        "ci-checks-rest",
        "ci-generated-sources",
        "ci-plan",
        "ci-result",
        "ci-tests",
        "code-quality-api",
        "code-quality-rest",
        "code-quality-web",
        "typecheck-baseline",
      ],
    });
    expect(parseCiCoverageLog(log("normal-v1", "")).isOk()).toBe(true);
    for (const malformed of [
      "",
      log("unknown", "[]"),
      log("pilot-fast-v1", "[]"),
      log("pilot-fast-v1", '["ci-tests","ci-tests"]'),
      log("pilot-fast-v1", "invalid"),
      log("pilot-fast-v1", '["ci-tests"]') + log("normal-v1", "[]"),
    ]) {
      expect(parseCiCoverageLog(malformed).isErr()).toBe(true);
    }
  });

  test("main's real gate maps fast-required jobs to how they are planned", () => {
    const jobs =
      readFastRequiredJobs(
        readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf-8"),
      ) ?? [];
    const byId = new Map(jobs.map((job) => [job.id, job]));
    for (const job of ["ci-checks-generated", "parser-version-guard"]) {
      expect(byId.get(job)?.scope).toEqual({
        type: "selector",
        variable: "package_checks_required",
      });
    }
    expect(byId.get("ci-checks-docs")?.scope).toEqual({
      type: "selector",
      variable: "docs_checks_required",
    });
    for (const job of [
      "e2e-production-shard",
      "marketing-screenshots",
      "api-image-smoke",
    ]) {
      expect(byId.has(job), job).toBe(false);
    }
    const shardName = byId.get("ci-tests")?.runName;
    expect(shardName?.test("ci-tests (api-1)")).toBe(true);
    expect(shardName?.test("ci-tests-extra")).toBe(false);

    // Every variable the bar asks for is one the selector run actually sets.
    const outputs = [
      ...new Set(
        jobs.flatMap(({ scope }) =>
          scope.type === "selector" ? [scope.variable] : [],
        ),
      ),
    ];
    expect(outputs.length).toBeGreaterThan(0);
    const plan = runPlanScopes({
      selector: extractPlanSelector(
        readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf-8"),
      ),
      // This census checks output completeness. Markdown behavior has its
      // own scope tests and need not load the reader inventory here.
      files: ["scripts/merge-bar.ts"],
      outputs,
      cwd: REPO_ROOT,
    });
    expect(plan.isOk(), plan.isErr() ? plan.error.message : "").toBe(true);
    expect(plan.isOk() && [...plan.value.keys()]).toEqual(outputs);
  });

  // The ci-result gate shape of every repository merge-bar lands: its real
  // workflow, a fixture of its gate step, or null when it has no CI workflow.
  const FOLIO_GATE_WORKFLOW = `
jobs:
  ci-plan:
    outputs:
      code_required: \${{ steps.plan.outputs.code }}
  typecheck: {}
  ci-result:
    steps:
      - name: Evaluate CI outcome
        env:
          JOB_SCOPES: '{"typecheck": "code_required"}'
`;
  const GATE_WORKFLOWS = {
    "stella/stella": readFileSync(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf-8",
    ),
    "stella/folio": FOLIO_GATE_WORKFLOW,
    "stella/stella-infra": null,
  } as const satisfies Record<MergeBarRepository, string | null>;

  test.each(Object.keys(MERGE_BAR_REPOSITORIES).map((repo) => [repo]))(
    "%s's gate shape reads without panicking",
    (repo) => {
      const workflow = GATE_WORKFLOWS[readMergeBarRepository(repo)];
      if (workflow === null) {
        return;
      }
      expect(() => readFastRequiredJobs(workflow)).not.toThrow();
    },
  );

  test("a gate without a fast-required list has no fast jobs to recheck", () => {
    expect(readFastRequiredJobs(FOLIO_GATE_WORKFLOW)).toBeNull();
  });

  test("fast scopes override regular scopes, including null and absent scopes", () => {
    const workflow = planWorkflow(SELECTING_RULE).replace(
      "FAST_JOB_SCOPES: '{}'",
      `FAST_JOB_SCOPES: '{"e2e-production-shard": null, "parser-version-guard": "e2e_production_required"}'`,
    );
    const jobs = readFastRequiredJobs(workflow);
    expect(jobs).not.toBeNull();
    const byId = new Map(jobs?.map((job) => [job.id, job]));
    expect(byId.get("e2e-production-shard")?.scope).toEqual({ type: "always" });
    expect(byId.get("parser-version-guard")?.scope).toEqual({
      type: "selector",
      variable: "e2e_production_required",
    });
    expect(
      unrunPlannedJobs({
        jobs: jobs ?? [],
        plan: new Map([["e2e_production_required", false]]),
        runJobs: [],
      }),
    ).toEqual(["e2e-production-shard"]);
  });

  test.each(["failure", "cancelled", "skipped", "neutral", null])(
    "a similarly named successful job cannot satisfy a required job with conclusion %s",
    (conclusion) => {
      const jobs = readFastRequiredJobs(planWorkflow(SELECTING_RULE));
      expect(jobs).not.toBeNull();
      expect(
        unrunPlannedJobs({
          jobs: jobs ?? [],
          plan: new Map([["e2e_production_required", true]]),
          runJobs: [
            guard,
            { name: "e2e-production-shard-extra", conclusion: "success" },
            { name: "e2e-production-shard (1)", conclusion },
          ],
        }),
      ).toEqual(["e2e-production-shard"]);
    },
  );

  test("unrun planned jobs ignore jobs main plans from something other than files", () => {
    expect(
      unrunPlannedJobs({
        jobs: [
          {
            id: "marketing-screenshots",
            scope: {
              type: "not-file-derived",
              output: "marketing_screenshots_required",
            },
            runName: /^marketing-screenshots$/u,
          },
        ],
        plan: new Map(),
        runJobs: [],
      }),
    ).toEqual([]);
  });

  test("a ratchet change on main re-measures the ratchet on main merged with the head", () => {
    for (const filename of ratchetDefinitionPaths) {
      const rechecks: unknown[] = [];
      const base = readers({
        status: "ahead",
        ahead_by: 1,
        files: [{ filename }],
      });
      const passing = checkGreenResultFreshness({
        ...base,
        ratchet: baseDefinitions({
          recheck: (input) => {
            rechecks.push(input);
            return Result.ok();
          },
        }),
      });
      expect(passing.isOk(), filename).toBe(true);
      expect(rechecks).toEqual([{ headSha: HEAD_SHA, baseRefName: "main" }]);

      const failing = checkGreenResultFreshness({
        ...base,
        ratchet: baseDefinitions({
          recheck: () =>
            Result.err(
              new RatchetRecheckError({
                message: "ratchet --check failed: +1",
              }),
            ),
        }),
      });
      expect(failing.isErr(), filename).toBe(true);
      if (failing.isErr()) {
        expect(failing.error.message).toContain(
          `main changed the ratchet since the green run (${filename})`,
        );
        expect(failing.error.message).toContain("ratchet --check failed: +1");
      }
    }
  });

  test("a PR that edits the ratchet itself queues without a recheck", () => {
    const rechecks: unknown[] = [];
    const result = checkGreenResultFreshness({
      ...readers({
        status: "ahead",
        ahead_by: 1,
        files: [{ filename: "scripts/ownership.ts" }],
      }),
      readPullFiles: () => ["scripts/ratchet.ts"],
      ratchet: baseDefinitions({
        recheck: (input) => {
          rechecks.push(input);
          return Result.ok();
        },
      }),
    });
    // The base's checker cannot judge an edited checker; the merge group runs
    // the merged one.
    expect(result.isOk()).toBe(true);
    expect(rechecks).toEqual([]);
  });

  test("a passing ratchet recheck with overlapping edits stays queueable", () => {
    const result = checkGreenResultFreshness({
      ...readers({
        status: "ahead",
        ahead_by: 1,
        files: [
          { filename: "scripts/ownership.ts" },
          { filename: "scripts/shared.ts" },
        ],
      }),
      ratchet: baseDefinitions({ recheck: () => Result.ok() }),
    });
    expect(result.isOk()).toBe(true);
  });

  test("an unreadable ratchet definition list refuses green results", () => {
    for (const definitions of [undefined, {}, [], [1], ["ok", null]]) {
      const result = checkGreenResultFreshness({
        ...readers({
          status: "ahead",
          ahead_by: 1,
          files: [{ filename: "unrelated.ts" }],
        }),
        ratchet: baseDefinitions({ readDefinitionPaths: () => definitions }),
      });
      expect(result.isErr(), JSON.stringify(definitions)).toBe(true);
    }
  });

  describe("per-repository ratchet capability", () => {
    // A ratchet change on main, so a declared check must read the definitions.
    const ratchetChangedOnMain = readers({
      status: "ahead",
      ahead_by: 1,
      files: [{ filename: "scripts/ratchet.ts" }],
    });
    const missingDefinitionsFile = () => {
      throw new Error("gh api: Not Found (HTTP 404)");
    };
    const unexpectedRecheck = () => {
      throw new Error("unexpected ratchet recheck");
    };

    test("folio declares no ratchet, so a missing definitions file is never read", () => {
      const ratchet = ratchetFreshnessFor({
        repo: "stella/folio",
        readDefinitionPaths: missingDefinitionsFile,
        recheck: unexpectedRecheck,
      });
      expect(ratchet).toEqual({ type: "none" });
      expect(
        checkGreenResultFreshness({ ...ratchetChangedOnMain, ratchet }).isOk(),
      ).toBe(true);
    });

    test("stella declares the ratchet, so a missing definitions file still panics", () => {
      const ratchet = ratchetFreshnessFor({
        repo: "stella/stella",
        readDefinitionPaths: missingDefinitionsFile,
        recheck: unexpectedRecheck,
      });
      expect(ratchet.type).toBe("base-definitions");
      expect(() =>
        checkGreenResultFreshness({ ...ratchetChangedOnMain, ratchet }),
      ).toThrow("Not Found (HTTP 404)");
    });

    test("--repo accepts only repositories with declared capabilities", () => {
      expect(readMergeBarRepository("Stella/Folio")).toBe("stella/folio");
      expect(readMergeBarRepository("stella/stella")).toBe("stella/stella");
      expect(() => readMergeBarRepository("stella/tooling")).toThrow(
        "merge-bar does not know stella/tooling",
      );
    });
  });

  test("the ratchet definition list is the ratchet's local import closure", () => {
    const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
    const closure = new Set<string>();
    const pending = ["scripts/ratchet.ts"];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (closure.has(file)) {
        continue;
      }
      closure.add(file);
      const source = readFileSync(path.join(repositoryRoot, file), "utf-8");
      for (const [, directory] of source.matchAll(
        /loadOwnershipDeclarations\(\s*new URL\("([^"]+)"/gu,
      )) {
        if (directory === undefined) {
          continue;
        }
        const relative = path.posix.join(path.posix.dirname(file), directory);
        pending.push(
          ...readdirSync(path.join(repositoryRoot, relative))
            .filter((name) => name.endsWith(".ts"))
            .map((name) => path.posix.join(relative, name)),
        );
      }
      for (const [, specifier] of source.matchAll(
        /^(?:import|export)\b[^;]*?\bfrom "(\.{1,2}\/[^"]+)"/gmu,
      )) {
        if (specifier === undefined) {
          continue;
        }
        const resolved = path.posix.join(path.posix.dirname(file), specifier);
        const candidate = /\.(?:ts|json)$/u.test(resolved)
          ? resolved
          : `${resolved}.ts`;
        if (existsSync(path.join(repositoryRoot, candidate))) {
          pending.push(candidate);
        }
      }
    }
    expect(
      [...closure].filter((file) => file.endsWith(".ts")).toSorted(),
    ).toEqual(
      ratchetDefinitionPaths
        .flatMap((pattern) => [
          ...new Bun.Glob(pattern).scanSync({
            cwd: repositoryRoot,
            onlyFiles: true,
          }),
        ])
        .toSorted(),
    );
  });

  test("rewritten history refuses a stale green result", () => {
    for (const comparison of [{ status: "diverged" }, { status: "behind" }]) {
      expect(checkGreenResultFreshness(readers(comparison)).isErr()).toBe(true);
    }
  });

  test("a long or unreadable drift on main keeps a green result queueable", () => {
    const rechecks: unknown[] = [];
    for (const comparison of [
      { status: "ahead", ahead_by: 21, files: [] },
      {
        status: "ahead",
        ahead_by: 1,
        files: Array.from({ length: 300 }, () => ({
          filename: "scripts/ownership.ts",
        })),
      },
    ]) {
      const result = checkGreenResultFreshness({
        ...readers(comparison),
        ratchet: baseDefinitions({
          recheck: (input) => {
            rechecks.push(input);
            return Result.err(
              new RatchetRecheckError({ message: "would refuse" }),
            );
          },
        }),
      });
      // The comparison is skipped rather than guessed from; the merge group
      // re-runs the ratchet on the real merge commit.
      expect(result.isOk()).toBe(true);
    }
    expect(rechecks).toEqual([]);
  });

  test("missing or mismatched workflow snapshots cannot establish freshness", () => {
    for (const workflow of [
      { ...run, head_sha: OTHER_SHA },
      { ...run, pull_requests: [] },
      {
        ...run,
        pull_requests: [
          {
            number: 2137,
            head: { sha: OTHER_SHA },
            base: run.pull_requests.at(0)?.base,
          },
        ],
      },
      {
        ...run,
        pull_requests: [
          {
            number: 2137,
            head: { sha: HEAD_SHA },
            base: { ref: "other", sha: OTHER_SHA },
          },
        ],
      },
    ]) {
      expect(
        checkGreenResultFreshness({
          ...readers({ status: "identical" }),
          readWorkflowRun: () => workflow,
        }).isErr(),
      ).toBe(true);
    }
  });

  test("release, jump and pending verdicts preserve existing behavior without freshness reads", () => {
    const noRead = () => {
      throw new MergeHoldReadError({ message: "unexpected freshness read" });
    };
    const options = {
      ...readers(null),
      readWorkflowRun: noRead,
      readBaseComparison: noRead,
      readPullFiles: noRead,
      ratchet: baseDefinitions({
        readDefinitionPaths: noRead,
        recheck: noRead,
      }),
      readBaseWorkflow: noRead,
      runSelector: noRead,
      readRunJobs: noRead,
    };
    expect(checkGreenResultFreshness({ ...options, jump: true }).isOk()).toBe(
      true,
    );
    expect(
      checkGreenResultFreshness({
        ...options,
        pullRequest: { ...options.pullRequest, title: "chore: release v1.0.0" },
      }).isOk(),
    ).toBe(true);
    for (const checkRuns of [
      [],
      [checkRun("ci-result", "in_progress", null)],
      [checkRun("ci-result", "completed", "failure")],
      [
        checkRun("ci-result", "completed", "success"),
        checkRun("ci-result", "queued", null, { id: 2 }),
      ],
    ]) {
      expect(checkGreenResultFreshness({ ...options, checkRuns }).isOk()).toBe(
        true,
      );
    }
  });
});

describe("workflow run URL repository identity", () => {
  test.each(["stella/stella", "Stella/Stella", "STELLA/stella"])(
    "accepts canonical run URLs for repository %s",
    (repo) => {
      const result = runMigrationGateway([], { repo });
      expect(result.exitCode, result.stderr).toBe(0);
    },
  );

  test.each([
    "https://github.com/STELLA/Stella/actions/runs/1/job/2",
    "https://github.com/stella/stella/actions/runs/1",
  ])("accepts matching repository casing in %s", (detailsUrl) => {
    const result = runMigrationGateway([], { detailsUrl });
    expect(result.exitCode, result.stderr).toBe(0);
  });

  test.each([
    "not a URL",
    "https://github.com/other/stella/actions/runs/1",
    "https://github.com/stella/other/actions/runs/1",
    "https://github.com.evil.test/stella/stella/actions/runs/1",
    "http://github.com/stella/stella/actions/runs/1",
    "https://github.com/stella/stella/pulls/1",
    "https://github.com/stella/stella/actions/runs/not-a-number",
  ])("refuses a workflow link outside the repository: %s", (detailsUrl) => {
    const result = runMigrationGateway([], { detailsUrl });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "ci-result check does not link to a workflow run in this repository",
    );
  });
});

const GROUP_SHA = "2a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c";
const BASE_SHA = "3b8d0f2c4e6a8b0d2f4c6e8a0b2d4f6c8e0a2b4d";
const MAIN_SHA = "4c9e1a3d5f7b9c1e3a5d7f9b1c3e5a7d9f1b3c5e";
const RUN_URL = "https://github.com/stella/stella/actions/runs/36997271485";
const REMOVED_AT = "2026-10-02T11:11:06Z";

const commitNode = (oid: string) => ({
  __typename: "PullRequestCommit",
  commit: { oid },
});
const forcePushNode = (oid: string | null) => ({
  __typename: "HeadRefForcePushedEvent",
  afterCommit: oid === null ? null : { oid },
});
const removalNode = ({
  reason,
  groupSha = GROUP_SHA,
}: {
  reason: string;
  groupSha?: string | null;
}) => ({
  __typename: "RemovedFromMergeQueueEvent",
  createdAt: REMOVED_AT,
  reason,
  beforeCommit: groupSha === null ? null : { oid: groupSha },
});

const failedRemoval = (
  overrides: Partial<MergeQueueRemoval> = {},
): MergeQueueRemoval => ({
  removedAt: REMOVED_AT,
  reason: { type: "known", value: "failed_checks" },
  headSha: HEAD_SHA,
  groupSha: GROUP_SHA,
  ...overrides,
});

const foundGroup = {
  type: "found",
  baseSha: BASE_SHA,
  runUrl: RUN_URL,
  cause: { type: "unknown" },
} as const satisfies Ejection["group"];

describe("merge queue ejections", () => {
  test("each removal carries the head the pull request had then", () => {
    const removals = parseMergeQueueRemovals([
      removalNode({ reason: "merge_conflict", groupSha: null }),
      commitNode(OTHER_SHA),
      removalNode({ reason: "failed_checks" }),
      forcePushNode(HEAD_SHA),
      removalNode({ reason: "manual" }),
      forcePushNode(null),
      removalNode({ reason: "failed_checks" }),
    ]);
    expect(removals.map(({ headSha }) => headSha)).toEqual([
      null,
      OTHER_SHA,
      HEAD_SHA,
      null,
    ]);
    expect(removals.at(0)?.groupSha).toBeNull();
    expect(removals.at(1)?.groupSha).toBe(GROUP_SHA);
  });

  test("an unexpected timeline item fails loudly", () => {
    expect(() =>
      parseMergeQueueRemovals([{ __typename: "AddedToMergeQueueEvent" }]),
    ).toThrow("Unexpected timeline item from gh: AddedToMergeQueueEvent");
  });

  test.each([
    { name: "never removed", reasons: [], ejected: undefined },
    { name: "manual dequeue", reasons: ["manual"], ejected: undefined },
    { name: "conflict", reasons: ["merge_conflict"], ejected: undefined },
    { name: "merged", reasons: ["merged"], ejected: undefined },
    { name: "failed checks", reasons: ["failed_checks"], ejected: 0 },
    // Unknown reasons fail closed: counted, printed verbatim.
    { name: "unknown reason", reasons: ["ci_timeout"], ejected: 0 },
    {
      name: "a later dequeue does not clear a failure",
      reasons: ["failed_checks", "manual", "merge_conflict"],
      ejected: 0,
    },
    {
      name: "several ejections: latest wins",
      reasons: ["failed_checks", "manual", "failed_checks", "manual"],
      ejected: 2,
    },
  ])("$name", ({ reasons, ejected }) => {
    const removals = parseMergeQueueRemovals(
      reasons.flatMap((reason, index) => [
        commitNode(`${index}`.padStart(40, "a")),
        removalNode({ reason }),
      ]),
    );
    expect(latestEjection(removals)).toBe(
      ejected === undefined ? undefined : removals.at(ejected),
    );
  });

  test("an unknown reason is printed verbatim", () => {
    const removal = parseMergeQueueRemovals([
      commitNode(HEAD_SHA),
      removalNode({ reason: "ci_timeout" }),
    ]).at(0);
    expect(removal?.reason).toEqual({ type: "unknown", value: "ci_timeout" });
    expect(
      formatEjection({ removal: failedRemoval(removal), group: foundGroup }),
    ).toContain("reason ci_timeout (unrecognized, counted as a failed group)");
  });

  test.each([
    {
      name: "ejected at another head: allowed",
      removal: failedRemoval({ headSha: OTHER_SHA }),
      group: foundGroup,
      mainTip: { sha: BASE_SHA, committedAt: "2026-10-02T09:00:00Z" },
      verdict: { type: "retry-allowed", changed: "head" },
    },
    {
      name: "ejected at this head, main still at the group's base: refused",
      removal: failedRemoval(),
      group: foundGroup,
      mainTip: { sha: BASE_SHA, committedAt: "2026-10-02T09:00:00Z" },
      verdict: { type: "unchanged-retry" },
    },
    {
      name: "ejected at this head, main moved past the group's base: allowed",
      removal: failedRemoval(),
      group: foundGroup,
      // Committed before the removal: the recorded base decides, not dates.
      mainTip: { sha: MAIN_SHA, committedAt: "2026-10-02T09:00:00Z" },
      verdict: { type: "retry-allowed", changed: "main" },
    },
    {
      name: "no recorded group, main tip committed before the removal: refused",
      removal: failedRemoval(),
      group: { type: "not-found" },
      mainTip: { sha: MAIN_SHA, committedAt: "2026-10-02T11:11:05Z" },
      verdict: { type: "unchanged-retry" },
    },
    {
      name: "no recorded group, main tip committed after the removal: allowed",
      removal: failedRemoval(),
      group: { type: "not-found" },
      mainTip: { sha: MAIN_SHA, committedAt: "2026-10-02T11:11:07Z" },
      verdict: { type: "retry-allowed", changed: "main" },
    },
    {
      name: "unknown head at removal fails closed",
      removal: failedRemoval({ headSha: null }),
      group: foundGroup,
      mainTip: { sha: BASE_SHA, committedAt: "2026-10-02T09:00:00Z" },
      verdict: { type: "unchanged-retry" },
    },
  ] as const)("$name", ({ removal, group, mainTip, verdict }) => {
    expect(
      evaluateEjectedHead({
        headSha: HEAD_SHA,
        ejection: { removal, group },
        mainTip,
      }),
    ).toEqual(verdict);
  });

  const gateway = ({
    removals,
    mainTipSha,
  }: {
    removals: readonly MergeQueueRemoval[];
    mainTipSha: string;
  }) => ({
    readMergeQueueRemovals: () => removals,
    readMergeGroup: (groupSha: string) => {
      expect(groupSha).toBe(GROUP_SHA);
      return foundGroup;
    },
    readBranchTip: (branch: string) => {
      expect(branch).toBe("main");
      return { sha: mainTipSha, committedAt: "2026-10-02T09:00:00Z" };
    },
  });
  const pullRequest = { headSha: HEAD_SHA, baseRefName: "main" };

  test("a never-ejected head reads nothing further", () => {
    const unexpected = () => {
      throw new Error("unexpected ejection read");
    };
    const result = checkEjectedHead({
      gateway: {
        readMergeQueueRemovals: () => [
          failedRemoval({ reason: { type: "known", value: "manual" } }),
        ],
        readMergeGroup: unexpected,
        readBranchTip: unexpected,
      },
      pullRequest,
    });
    expect(result.isOk() && result.value).toBeNull();
  });

  test("an unchanged retry is refused with the ejection in Prague time", () => {
    const result = checkEjectedHead({
      gateway: gateway({ removals: [failedRemoval()], mainTipSha: BASE_SHA }),
      pullRequest,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain(
        `previous merge queue ejection: 2026-10-02 13:11:06 CEST, head ${HEAD_SHA}, reason failed_checks, failing run ${RUN_URL}`,
      );
      expect(result.error.message).toContain("EJECTED_HEAD_UNCHANGED");
    }
  });

  test("a retry after main moved is allowed and still prints the ejection", () => {
    const result = checkEjectedHead({
      gateway: gateway({ removals: [failedRemoval()], mainTipSha: MAIN_SHA }),
      pullRequest,
    });
    expect(result.isOk() && result.value).toContain(
      `previous merge queue ejection: 2026-10-02 13:11:06 CEST, head ${HEAD_SHA}, reason failed_checks, failing run ${RUN_URL}; main moved since (now ${MAIN_SHA})`,
    );
  });

  test.each([
    { title: "fix: something", extraArguments: [] },
    { title: "chore: release v0.9.42", extraArguments: ["--jump"] },
  ])(
    "the CLI applies the same gate to $title $extraArguments",
    ({ title, extraArguments }) => {
      for (const { mainTipSha, refused } of [
        { mainTipSha: BASE_SHA, refused: true },
        { mainTipSha: MAIN_SHA, refused: false },
      ]) {
        const directory = mkdtempSync(path.join(tmpdir(), "merge-bar-eject-"));
        const executable = path.join(directory, "gh");
        writeFileSync(
          executable,
          `#!/bin/sh
case "$*" in
  'variable get STELLA_MERGE_HOLD --repo '*) printf '%s\\n' 'variable STELLA_MERGE_HOLD was not found' >&2; exit 1;;
  *'pr merge'*|*enqueuePullRequest*) exit 98;;
  *REMOVED_FROM_MERGE_QUEUE_EVENT*) printf '%s\\n' "$FIXTURE_TIMELINE";;
  *'actions/runs?event=merge_group&head_sha=${GROUP_SHA}'*) printf '%s\\n' "$FIXTURE_GROUP_RUNS";;
  *'actions/runs/42/jobs?'*) printf '%s\\n' '[{"jobs":[]}]';;
  *commits/main*) printf '%s\\n' "$FIXTURE_MAIN_TIP";;
  *reviewThreads*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false}}';;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci-result"}]}},{"type":"merge_queue","parameters":{}}]';;
  *'actions/runs?head_sha='*) ;;
  *check-runs/1*) printf '%s\\n' '{"details_url":"https://github.com/stella/stella-infra/actions/runs/1"}';;
  *actions/runs/1*) printf '%s\\n' '{"head_sha":"${HEAD_SHA}","pull_requests":[{"number":123,"head":{"sha":"${HEAD_SHA}"},"base":{"ref":"main","sha":"${OTHER_SHA}"}}]}';;
  *compare/*) printf '%s\\n' '{"status":"identical"}';;
  *check-runs*) printf '1\\tci-result\\tcompleted\\tsuccess\\n';;
  *headRefOid*)
    if [ "$1" = api ]; then printf '%s\\n' "$FIXTURE_PULL_REQUEST";
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
              "--dry-run",
              ...extraArguments,
            ],
            env: {
              ...process.env,
              ...CLI_TEST_ENV,
              PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
              FIXTURE_PULL_REQUEST: JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      id: "PR_fixture",
                      number: 123,
                      title,
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
              }),
              FIXTURE_TIMELINE: JSON.stringify([
                commitNode(HEAD_SHA),
                removalNode({ reason: "failed_checks" }),
              ]),
              FIXTURE_GROUP_RUNS: JSON.stringify({
                workflow_runs: [
                  {
                    name: "CI Checks",
                    id: 42,
                    conclusion: "failure",
                    head_branch: `gh-readonly-queue/main/pr-123-${BASE_SHA}`,
                    html_url: RUN_URL,
                  },
                ],
              }),
              FIXTURE_MAIN_TIP: JSON.stringify({
                sha: mainTipSha,
                committedAt: "2026-10-02T09:00:00Z",
              }),
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const output = `${result.stdout.toString()}${result.stderr.toString()}`;
          expect(output).toContain(
            `previous merge queue ejection: 2026-10-02 13:11:06 CEST, head ${HEAD_SHA}`,
          );
          expect(result.exitCode, output).toBe(refused ? 1 : 0);
          if (refused) {
            expect(result.stderr.toString()).toContain(
              "EJECTED_HEAD_UNCHANGED",
            );
            expect(result.stdout.toString()).not.toContain("verdict: MERGE");
          } else {
            expect(result.stdout.toString()).toContain(
              "verdict: MERGE (dry run",
            );
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
    15_000,
  );
});

describe("ejection retry timestamps", () => {
  test("a main tip committed at the removal's own second does not prove main moved", () => {
    const removal = failedRemoval({ groupSha: null });
    const mainTip = { sha: MAIN_SHA, committedAt: REMOVED_AT };
    expect(
      evaluateEjectedHead({
        headSha: HEAD_SHA,
        ejection: { removal, group: { type: "not-found" } },
        mainTip,
      }),
    ).toEqual({ type: "unchanged-retry" });
    const result = checkEjectedHead({
      gateway: {
        readMergeQueueRemovals: () => [removal],
        readMergeGroup: () => {
          throw new Error("a removal without a group has no run to read");
        },
        readBranchTip: () => mainTip,
      },
      pullRequest: { headSha: HEAD_SHA, baseRefName: "main" },
    });
    expect(result.isErr() && result.error.message).toContain(
      "EJECTED_HEAD_UNCHANGED",
    );
  });
});

describe("ci-plan selector failures", () => {
  const run = (selector: string, outputs: readonly string[] = ["scope"]) =>
    runPlanSelector({
      selector,
      files: ["docs/example.md"],
      outputs,
      cwd: REPO_ROOT,
    });

  test.each([
    { selector: "exit 1", exit: 1, stderr: "" },
    { selector: "exit 2", exit: 2, stderr: "" },
    {
      selector: "echo selector broke >&2; exit 1",
      exit: 1,
      stderr: "selector broke",
    },
    { selector: "false", exit: 1, stderr: "" },
  ])("`$selector` is an error, never a plan", ({ selector, exit, stderr }) => {
    const result = run(`scope=true\n${selector}`);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(PlanSelectorError);
      expect(result.error.message).toStartWith(
        `ci-plan selector exited ${exit}: `,
      );
      expect(result.error.message).toContain(stderr);
    }
  });

  test("a detector that cannot run fails the selector", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ci-plan-selector-"));
    try {
      const result = runPlanSelector({
        selector: "scope=true",
        files: ["docs/example.md"],
        outputs: ["scope"],
        cwd: directory,
      });
      expect(result.isErr() && result.error.message).toContain(
        "scripts/detect-e2e-changes.sh",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("output the selector prints itself does not shift the values", () => {
    const result = run("echo 'scope=false'\nscope=true\nother=false", [
      "scope",
      "other",
    ]);
    expect(result.isOk() && [...result.value]).toEqual([
      ["scope", "true"],
      ["other", "false"],
    ]);
  });

  test("a value spanning lines cannot pass for the requested outputs", () => {
    const result = run("scope=$'true\\nfalse'");
    expect(result.isErr() && result.error.message).toBe(
      "ci-plan selector printed 2 value(s) for 1 output(s)",
    );
  });

  test.each([
    { selector: "scope=maybe", value: '"maybe"' },
    { selector: "scope=", value: '""' },
    { selector: "unset scope", value: '""' },
    { selector: "scope=TRUE", value: '"TRUE"' },
  ])("scope `$selector` is not a boolean and fails", ({ selector, value }) => {
    const result = runPlanScopes({
      selector,
      files: ["docs/example.md"],
      outputs: ["scope"],
      cwd: REPO_ROOT,
    });
    expect(result.isErr() && result.error.message).toBe(
      `ci-plan selector set scope to ${value}, not true or false`,
    );
  });

  test("boolean scopes read as booleans", () => {
    const result = runPlanScopes({
      selector: "scope=true\nother=false",
      files: ["docs/example.md"],
      outputs: ["scope", "other"],
      cwd: REPO_ROOT,
    });
    expect(result.isOk() && [...result.value]).toEqual([
      ["scope", true],
      ["other", false],
    ]);
  });
});

type LiveBarOptions = {
  title: string;
  extraArguments: readonly string[];
  timeline: readonly unknown[];
  mainTipSha?: string;
  comparison: unknown;
  workflow?: string;
  runJobs?: readonly { name: string; conclusion: string }[];
  groupEvidence?: { jobs: unknown; annotations: unknown };
};

/**
 * The CLI without --dry-run against a fake gh that records every merge
 * write (auto-merge or enqueue) instead of refusing it, so a test can assert
 * exactly what the bar armed.
 */
const runLiveBar = ({
  title,
  extraArguments,
  timeline,
  mainTipSha = MAIN_SHA,
  comparison,
  workflow = "",
  runJobs = [],
  groupEvidence = { jobs: { jobs: [] }, annotations: [] },
}: LiveBarOptions) => {
  const directory = mkdtempSync(path.join(tmpdir(), "merge-bar-live-"));
  const executable = path.join(directory, "gh");
  const writes = path.join(directory, "writes.log");
  writeFileSync(writes, "");
  writeFileSync(
    executable,
    `#!/bin/sh
case "$*" in
  'variable get STELLA_MERGE_HOLD --repo '*) printf '%s\\n' 'variable STELLA_MERGE_HOLD was not found' >&2; exit 1;;
  *'pr merge'*|*enqueuePullRequest*|*enablePullRequestAutoMerge*)
    printf '%s' "$*" | tr '\\n' ' ' >> "$FIXTURE_WRITES"; printf '\\n' >> "$FIXTURE_WRITES"
    case "$*" in
      *enqueuePullRequest*)
        : > "$FIXTURE_WRITES.queued"
        printf '%s\\n' '{"data":{"enqueuePullRequest":{"mergeQueueEntry":{"id":"entry","position":1,"jump":true,"state":"QUEUED","headCommit":{"oid":"${HEAD_SHA}"}}}}}';;
      *) exit 97;;
    esac;;
  *updatedAt*)
    if [ -e "$FIXTURE_WRITES.queued" ]; then printf '%s\\n' "$FIXTURE_QUEUED_PULL_REQUEST";
    else printf '%s\\n' "$FIXTURE_PULL_REQUEST"; fi;;
  *REMOVED_FROM_MERGE_QUEUE_EVENT*) printf '%s\\n' "$FIXTURE_TIMELINE";;
  *'mergeQueue(branch'*) printf '%s\\n' '{"data":{"repository":{"mergeQueue":{"entries":{"totalCount":1,"nodes":[{"position":1,"jump":true,"state":"QUEUED","pullRequest":{"number":123}}]}}}}}';;
  *'actions/runs?event=merge_group&head_sha=${GROUP_SHA}'*) printf '%s\\n' "$FIXTURE_GROUP_RUNS";;
  *'actions/runs/42/jobs?'*) printf '%s\\n' "$FIXTURE_GROUP_JOBS";;
  *'check-runs/'*'/annotations?'*) printf '%s\\n' "$FIXTURE_GROUP_ANNOTATIONS";;
  *commits/main*) printf '%s\\n' "$FIXTURE_MAIN_TIP";;
  *contents/scripts/ratchet-definition-paths.json*) printf '%s\\n' "$FIXTURE_RATCHET_DEFINITIONS";;
  *contents/.github/workflows/ci.yml*) printf '%s\\n' "$FIXTURE_WORKFLOW";;
  *'actions/runs/1/jobs'*'select(.name == "ci-result") | .id'*) printf '%s\\n' '2';;
  *actions/runs/1/jobs*) printf '%s\\n' "$FIXTURE_RUN_JOBS";;
  *actions/jobs/2/logs*) printf '%s\\n' "$FIXTURE_COVERAGE_LOG";;
  *reviewThreads*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false}}';;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci-result"}]}},{"type":"merge_queue","parameters":{}}]';;
  *'actions/runs?head_sha='*) ;;
  *check-runs/1*) printf '%s\\n' '{"details_url":"https://github.com/stella/stella-infra/actions/runs/1"}';;
  *actions/runs/1*) printf '%s\\n' '{"id":1,"head_sha":"${HEAD_SHA}","pull_requests":[{"number":123,"head":{"sha":"${HEAD_SHA}"},"base":{"ref":"main","sha":"${OTHER_SHA}"}}]}';;
  *compare/*) printf '%s\\n' "$FIXTURE_COMPARISON";;
  *check-runs*) printf '1\\tci-result\\tcompleted\\tsuccess\\n';;
  *pulls/123/files*) printf '%s\\n' '{"status":"added","filename":"${PR_FILE}"}';;
  *pulls/123*) printf '%s\\n' '1';;
  *headRefOid*)
    if [ "$1" = api ]; then printf '%s\\n' "$FIXTURE_PULL_REQUEST";
    else printf '%s\\n' '{"headRefOid":"${HEAD_SHA}"}'; fi;;
  *) exit 99;;
esac
`,
  );
  chmodSync(executable, 0o700);
  const pullRequest = {
    id: "PR_fixture",
    number: 123,
    title,
    isCrossRepository: false,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefOid: HEAD_SHA,
    baseRefName: "main",
    updatedAt: "2026-10-02T09:00:00Z",
    autoMergeRequest: null,
    mergeQueueEntry: null,
  };
  try {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("merge-bar.ts", import.meta.url)),
        "123",
        "--repo",
        PRIVATE_REPO,
        ...extraArguments,
      ],
      env: {
        ...process.env,
        ...CLI_TEST_ENV,
        PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
        FIXTURE_WRITES: writes,
        FIXTURE_PULL_REQUEST: JSON.stringify({
          data: { repository: { pullRequest } },
        }),
        // What the verification read sees once the enqueue landed.
        FIXTURE_QUEUED_PULL_REQUEST: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                ...pullRequest,
                mergeQueueEntry: {
                  id: "entry",
                  position: 1,
                  jump: true,
                  state: "QUEUED",
                  headCommit: { oid: HEAD_SHA },
                },
              },
            },
          },
        }),
        FIXTURE_GROUP_JOBS: JSON.stringify([groupEvidence.jobs]),
        FIXTURE_GROUP_ANNOTATIONS: JSON.stringify([groupEvidence.annotations]),
        FIXTURE_TIMELINE: JSON.stringify(timeline),
        FIXTURE_GROUP_RUNS: JSON.stringify({
          workflow_runs: [
            {
              name: "CI Checks",
              id: 42,
              conclusion: "failure",
              head_branch: `gh-readonly-queue/main/pr-123-${BASE_SHA}`,
              html_url: RUN_URL,
            },
          ],
        }),
        FIXTURE_MAIN_TIP: JSON.stringify({
          sha: mainTipSha,
          committedAt: "2026-10-02T09:00:00Z",
        }),
        FIXTURE_COMPARISON: JSON.stringify(comparison),
        FIXTURE_RATCHET_DEFINITIONS: JSON.stringify(ratchetDefinitionPaths),
        FIXTURE_WORKFLOW: workflow,
        FIXTURE_RUN_JOBS: runJobs
          .map(({ name, conclusion }) => `${name}\t${conclusion}`)
          .join("\n"),
        FIXTURE_COVERAGE_LOG: readFileSync(
          path.join(
            REPO_ROOT,
            "scripts/fixtures/merge-bar-coverage-merge-group-37635202900.log",
          ),
          "utf-8",
        ),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      writes: readFileSync(writes, "utf-8").split("\n").filter(Boolean),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("live arming", () => {
  const ejectedAtHead = [
    commitNode(HEAD_SHA),
    removalNode({ reason: "failed_checks" }),
  ];

  test.each([
    // Green checks hand an ordinary pull request straight to the queue.
    {
      title: "fix: something",
      extraArguments: [],
      write: "expectedHeadOid:$sha,jump:false",
    },
    {
      title: "chore: release v0.9.42",
      extraArguments: ["--jump"],
      write: "expectedHeadOid:$sha,jump:true",
    },
  ])(
    "an unchanged ejected head cannot arm: $title $extraArguments",
    ({ title, extraArguments, write }) => {
      const refused = runLiveBar({
        title,
        extraArguments,
        timeline: ejectedAtHead,
        mainTipSha: BASE_SHA,
        comparison: { status: "identical" },
      });
      expect(refused.exitCode, refused.stderr).toBe(1);
      expect(refused.stderr).toContain("EJECTED_HEAD_UNCHANGED");
      expect(refused.writes).toEqual([]);

      // Control: the same run with main moved arms exactly once.
      const armed = runLiveBar({
        title,
        extraArguments,
        timeline: ejectedAtHead,
        mainTipSha: MAIN_SHA,
        comparison: { status: "identical" },
      });
      expect(armed.exitCode, armed.stderr).toBe(0);
      expect(armed.writes).toHaveLength(1);
      expect(armed.writes.at(0)).toContain(write);
      expect(armed.writes.at(0)).toContain(HEAD_SHA);
    },
    30_000,
  );

  // Releases and --jump skip green-result freshness, so this gate is
  // exercised on an ordinary pull request.
  test.each([
    {
      name: "a job the green run skipped blocks arming",
      runJobs: [guard, { name: "e2e-production-shard", conclusion: "skipped" }],
      armed: false,
    },
    {
      name: "the same job having succeeded arms exactly once",
      runJobs: [guard, shard(1, "success"), shard(2, "success")],
      armed: true,
    },
  ])(
    "main's new plan in a live run: $name",
    ({ runJobs, armed }) => {
      const result = runLiveBar({
        title: "fix: something",
        extraArguments: [],
        timeline: [],
        // Main moved one commit and touched only its workflow; the PR touched
        // only its spec, so no file overlap can refuse.
        comparison: {
          status: "ahead",
          ahead_by: 1,
          files: [{ filename: ".github/workflows/ci.yml" }],
        },
        workflow: planWorkflow(SELECTING_RULE),
        runJobs,
      });
      if (armed) {
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.writes).toHaveLength(1);
        expect(result.writes.at(0)).toContain(
          "expectedHeadOid:$sha,jump:false",
        );
        expect(result.writes.at(0)).toContain(`sha=${HEAD_SHA}`);
        return;
      }
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "STALE_PLAN: main's CI plan now selects e2e-production-shard for this PR's files",
      );
      expect(result.writes).toEqual([]);
    },
    30_000,
  );
});

describe("contributor signature check", () => {
  test("unsigned outsiders are refused in both landing modes before generic check handling", () => {
    for (const landing of ["merge", "merge-when-ready"] as const) {
      const snapshot = passingSnapshot({
        landing,
        checkRuns: [
          checkRun("ci-result", "completed", "success"),
          checkRun("cla", "completed", "failure", {
            id: 2,
            outputTitle: "CLA_UNSIGNED",
          }),
        ],
      });
      expect(failedGate(snapshot)).toEqual({
        decision: "abort",
        reasons: ["CLA_UNSIGNED"],
      });
      expect(
        evaluateMergeBar(snapshot).gates.find(
          ({ gate }) => gate === "required-check",
        )?.detail,
      ).toContain("I have read the CLA Document and I hereby sign the CLA");
    }
  });

  test("unlinked commit authors are refused in both landing modes", () => {
    for (const landing of ["merge", "merge-when-ready"] as const) {
      const snapshot = passingSnapshot({
        landing,
        checkRuns: [
          checkRun("ci-result", "completed", "success"),
          checkRun("cla", "completed", "failure", {
            id: 2,
            outputTitle: "CLA_UNLINKED_AUTHOR",
          }),
        ],
      });
      expect(failedGate(snapshot)).toEqual({
        decision: "abort",
        reasons: ["CLA_UNLINKED_AUTHOR"],
      });
    }
  });

  test("CLA verification errors fail closed before required-check configuration", () => {
    for (const landing of ["merge", "merge-when-ready"] as const) {
      const snapshot = passingSnapshot({
        landing,
        checkRuns: [
          checkRun("ci-result", "completed", "success"),
          checkRun("cla", "completed", "failure", {
            id: 2,
            outputTitle: "CLA_ERROR",
          }),
        ],
      });
      expect(failedGate(snapshot)).toEqual({
        decision: "abort",
        reasons: ["REQUIRED_CHECK_NOT_SUCCESSFUL"],
      });
    }
  });

  test("verified authors and newest signed verdicts are accepted", () => {
    for (const landing of ["merge", "merge-when-ready"] as const) {
      const snapshot = passingSnapshot({
        landing,
        requiredCheckRuns: ["ci-result", "cla"],
        checkRuns: [
          checkRun("ci-result", "completed", "success"),
          checkRun("cla", "completed", "failure", {
            id: 2,
            outputTitle: "CLA_UNSIGNED",
          }),
          checkRun("cla", "completed", "success", {
            id: 3,
            outputTitle: "CLA_VERIFIED",
          }),
          checkRun(
            `cla/pr-${passingSnapshot().pullRequest.number}`,
            "completed",
            "success",
            {
              id: 4,
              outputTitle: "CLA_VERIFIED",
            },
          ),
        ],
      });
      expect(evaluateMergeBar(snapshot).decision).toBe("merge");
      expect(
        failedGate({ ...snapshot, checkRunsHeadSha: OTHER_SHA }).reasons,
      ).toContain("CHECK_RUNS_READ_FOR_STALE_SHA");
    }
  });

  test("shared heads enforce only the exact PR opener in both landing modes", () => {
    for (const landing of ["merge", "merge-when-ready"] as const) {
      const common = checkRun("cla", "completed", "success", {
        id: 2,
        outputTitle: "CLA_VERIFIED",
      });
      const own = checkRun(
        `cla/pr-${passingSnapshot().pullRequest.number}`,
        "completed",
        "success",
        {
          id: 3,
          outputTitle: "CLA_VERIFIED",
        },
      );
      const other = checkRun("cla/pr-999", "completed", "failure", {
        id: 4,
        outputTitle: "CLA_UNSIGNED",
      });
      const snapshot = passingSnapshot({
        landing,
        checkRuns: [
          checkRun("ci-result", "completed", "success"),
          common,
          own,
          other,
        ],
      });
      expect(evaluateMergeBar(snapshot).decision).toBe("merge");
      expect(
        failedGate({
          ...snapshot,
          checkRuns: [
            common,
            checkRun(
              `cla/pr-${passingSnapshot().pullRequest.number}`,
              "completed",
              "failure",
              {
                id: 3,
                outputTitle: "CLA_UNSIGNED",
              },
            ),
          ],
        }).reasons,
      ).toContain("CLA_UNSIGNED");
      for (const pending of [
        undefined,
        checkRun(
          `cla/pr-${passingSnapshot().pullRequest.number}`,
          "in_progress",
          null,
          { id: 3 },
        ),
      ]) {
        expect(
          evaluateMergeBar({
            ...snapshot,
            checkRuns: pending ? [common, pending, other] : [common, other],
          }).decision,
        ).toBe("abort");
      }
    }
  });

  test("missing and in-progress signature checks retain the existing landing behavior", () => {
    for (const checkRuns of [
      [checkRun("ci-result", "completed", "success")],
      [
        checkRun("ci-result", "completed", "success"),
        checkRun("cla", "in_progress", null, {
          id: 2,
          outputTitle: "CLA_CHECKING",
        }),
      ],
    ]) {
      const snapshot = passingSnapshot({
        requiredCheckRuns: ["ci-result", "cla"],
        checkRuns,
      });
      expect(failedGate(snapshot).reasons).not.toContain("CLA_UNSIGNED");
      expect(evaluateMergeBar(snapshot).decision).toBe("abort");
      expect(
        evaluateMergeBar({ ...snapshot, landing: "merge-when-ready" }).decision,
      ).toBe("merge");
    }
  });

  test("the real CLI reads the structured check title and refuses unsigned authors", () => {
    const result = runMigrationGateway([], { claTitle: "CLA_UNSIGNED" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("CLA_UNSIGNED");
  });
});

type ArmFixtureOptions = {
  initialEnabledAt?: string | null;
  removalAt?: string;
  enabledAt?: string;
  afterHead?: string;
  afterEnabledAt?: string | null;
  // Which reads see a queue entry: every read, or only the verification read
  // (auto-merge enqueued the PR in between).
  queued?: "every-read" | "verification-read";
  // The entry as GitHub reports it; defaults to an unbuilt entry.
  queueEntry?: Record<string, unknown>;
  jump?: boolean;
  checksSucceeded?: boolean;
};
const runArmFixture = (options: ArmFixtureOptions = {}) => {
  const enabledAt = options.enabledAt ?? "2026-10-02T10:00:00Z";
  const entry = {
    id: "MQ_fixture",
    position: 2,
    jump: options.jump ?? false,
    state: "QUEUED",
    headCommit: { oid: HEAD_SHA },
  };
  const queueEntry = options.queueEntry ?? entry;
  const state = (
    timestamp: string | null,
    head = HEAD_SHA,
    read: "first" | "later" = "later",
  ) => ({
    id: "PR_fixture",
    headRefOid: head,
    updatedAt: "2026-10-02T09:00:00Z",
    autoMergeRequest: timestamp === null ? null : { enabledAt: timestamp },
    mergeQueueEntry:
      options.queued === "every-read" ||
      (options.queued === "verification-read" && read === "later")
        ? queueEntry
        : null,
  });
  const writes: { query: string; variables: { id: string; sha: string } }[] =
    [];
  let reads = 0;
  const result = armAndVerify({
    pullRequestId: "PR_fixture",
    expectedHeadSha: HEAD_SHA,
    jump: options.jump ?? false,
    checksSucceeded: options.checksSucceeded ?? false,
    readState: () => {
      reads += 1;
      return reads === 1
        ? state(options.initialEnabledAt ?? null, HEAD_SHA, "first")
        : state(
            options.afterEnabledAt === undefined
              ? enabledAt
              : options.afterEnabledAt,
            options.afterHead ?? HEAD_SHA,
          );
    },
    readRemovals: () =>
      options.removalAt === undefined
        ? []
        : [
            {
              removedAt: options.removalAt,
              reason: { type: "known", value: "manual" },
              headSha: HEAD_SHA,
              groupSha: null,
            },
          ],
    mutate: (query, variables) => {
      writes.push({ query, variables });
      if (query.includes("disablePullRequestAutoMerge")) {
        return {
          data: { disablePullRequestAutoMerge: { pullRequest: state(null) } },
        };
      }
      if (query.includes("enqueuePullRequest")) {
        return { data: { enqueuePullRequest: { mergeQueueEntry: entry } } };
      }
      return {
        data: { enablePullRequestAutoMerge: { pullRequest: state(enabledAt) } },
      };
    },
  });
  return { result, writes, reads };
};

describe("verified merge handoff", () => {
  test("GitHub refuses a head moved between verification and enable", () => {
    const result = armAndVerify({
      pullRequestId: "PR_fixture",
      expectedHeadSha: HEAD_SHA,
      jump: false,
      checksSucceeded: false,
      readState: () => ({
        id: "PR_fixture",
        headRefOid: HEAD_SHA,
        updatedAt: "2026-10-02T09:00:00Z",
        autoMergeRequest: null,
        mergeQueueEntry: null,
      }),
      readRemovals: () => [],
      mutate: (query, variables) => {
        // The server head changed after the read. Omitting the pin would
        // accept that unverified head, so this fake models both outcomes.
        if (
          query.includes("expectedHeadOid:$sha") &&
          variables.sha !== OTHER_SHA
        ) {
          throw new Error("expectedHeadOid does not match current head");
        }
        return {
          data: {
            enablePullRequestAutoMerge: {
              pullRequest: {
                id: "PR_fixture",
                headRefOid: HEAD_SHA,
                updatedAt: "2026-10-02T09:00:00Z",
                autoMergeRequest: { enabledAt: "2026-10-02T10:00:00Z" },
                mergeQueueEntry: null,
              },
            },
          },
        };
      },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain(
        "expectedHeadOid does not match current head",
      );
    }
  });
  test.each([
    { initialEnabledAt: "2026-10-02T08:41:00Z" },
    {
      initialEnabledAt: "2026-10-02T09:15:00Z",
      removalAt: "2026-10-02T09:30:00Z",
    },
  ])(
    "a stale field is refreshed for the exact head before reporting armed: %j",
    (options) => {
      const { result, writes, reads } = runArmFixture(options);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({
          kind: "armed",
          enabledAt: "2026-10-02T10:00:00Z",
        });
      }
      expect(reads).toBe(2);
      expect(writes).toHaveLength(2);
      expect(writes.at(0)?.query).toContain("disablePullRequestAutoMerge");
      expect(writes.at(1)?.query).toContain(
        "enablePullRequestAutoMerge(input:{pullRequestId:$id,expectedHeadOid:$sha",
      );
      expect(writes.at(1)?.variables).toEqual({
        id: "PR_fixture",
        sha: HEAD_SHA,
      });
    },
  );
  test("a fresh read with no auto-merge is NOT ARMED", () => {
    const { result } = runArmFixture({ afterEnabledAt: null });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe(
        "NOT ARMED: AUTO_MERGE_ABSENT_AFTER_ENABLE",
      );
    }
  });
  test("a new request is armed only after a matching fresh read", () => {
    const { result, writes, reads } = runArmFixture();
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("armed");
    }
    expect(writes).toHaveLength(1);
    expect(reads).toBe(2);
  });
  test.each([
    { enabledAt: "2026-10-02T08:59:59Z" },
    { enabledAt: "2026-10-02T09:00:00Z", removalAt: "2026-10-02T09:30:00Z" },
    { afterEnabledAt: "2026-10-02T10:01:00Z" },
  ])(
    "a stale or conflicting verification receipt is NOT ARMED: %j",
    (options) => {
      const { result } = runArmFixture(options);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toBe(
          "NOT ARMED: AUTO_MERGE_STALE_AFTER_ENABLE",
        );
      }
    },
  );
  test("a head change after enabling is NOT ARMED", () => {
    const { result } = runArmFixture({ afterHead: OTHER_SHA });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("NOT ARMED: HEAD_MOVED_DURING_ARMING");
    }
  });
  test("an existing queue entry for this head needs no write", () => {
    const { result, writes } = runArmFixture({
      queued: "every-read",
      initialEnabledAt: "2026-10-02T08:41:00Z",
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("already-queued");
    }
    expect(writes).toHaveLength(0);
  });
  // Recorded from the stella/stella queue (2026-10-03): once the merge group
  // is built, `headCommit` is the group commit, never the pull request head.
  const builtGroupEntry = {
    id: "MQE_recorded",
    position: 2,
    jump: false,
    state: "AWAITING_CHECKS",
    headCommit: { oid: "307e6cc2807f4c12fec4622174c422ce3fb6101a" },
  };
  test("an entry whose merge group is built is already queued, not a head mismatch", () => {
    const { result, writes } = runArmFixture({
      queued: "every-read",
      queueEntry: builtGroupEntry,
      initialEnabledAt: "2026-10-02T08:41:00Z",
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        kind: "already-queued",
        entry: { position: 2, jump: false, state: "AWAITING_CHECKS" },
      });
    }
    expect(writes).toHaveLength(0);
  });
  test("auto-merge enqueuing into a built group during verification is queued", () => {
    const { result, writes } = runArmFixture({
      initialEnabledAt: "2026-10-02T10:00:00Z",
      queued: "verification-read",
      queueEntry: builtGroupEntry,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("queued");
    }
    expect(writes).toHaveLength(0);
  });
  test("a queue entry read with a moved head is still refused", () => {
    const { result } = runArmFixture({
      initialEnabledAt: "2026-10-02T10:00:00Z",
      queued: "verification-read",
      queueEntry: builtGroupEntry,
      afterHead: OTHER_SHA,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("NOT ARMED: HEAD_MOVED_DURING_ARMING");
    }
  });
  test("a trustworthy existing request is verified without writes", () => {
    const { result, writes, reads } = runArmFixture({
      initialEnabledAt: "2026-10-02T10:00:00Z",
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("armed");
    }
    expect(reads).toBe(2);
    expect(writes).toHaveLength(0);
  });
  test("a trustworthy request that disappears on verification is NOT ARMED", () => {
    const { result, writes } = runArmFixture({
      initialEnabledAt: "2026-10-02T10:00:00Z",
      afterEnabledAt: null,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe(
        "NOT ARMED: AUTO_MERGE_STALE_DURING_VERIFICATION",
      );
    }
    expect(writes).toHaveLength(0);
  });
  test("release jump still enqueues when an existing request is trustworthy", () => {
    const { result, writes } = runArmFixture({
      initialEnabledAt: "2026-10-02T10:00:00Z",
      jump: true,
      checksSucceeded: true,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("queued");
    }
    expect(writes).toHaveLength(1);
    expect(writes.at(0)?.query).toContain("enqueuePullRequest");
    expect(writes.at(0)?.query).toContain("jump:true");
  });
  test("release jump retains its head-pinned enqueue receipt for front verification", () => {
    const { result, writes, reads } = runArmFixture({
      jump: true,
      checksSucceeded: true,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        kind: "queued",
        entry: { position: 2, jump: true, state: "QUEUED" },
      });
    }
    expect(reads).toBe(2);
    expect(writes).toHaveLength(1);
    expect(writes.at(0)?.query).toContain("expectedHeadOid:$sha,jump:true");
    expect(writes.at(0)?.variables.sha).toBe(HEAD_SHA);
  });
});

test("the real CLI exits NOT ARMED when the fresh auto-merge read remains absent", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "merge-bar-arm-absent-"));
  const executable = path.join(directory, "gh");
  const calls = path.join(directory, "calls");
  const state = {
    id: "PR_fixture",
    number: 123,
    title: "fix: verify merge handoff",
    isCrossRepository: false,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefOid: HEAD_SHA,
    baseRefName: "main",
    updatedAt: "2026-10-02T09:00:00Z",
    autoMergeRequest: null,
    mergeQueueEntry: null,
  };
  writeFileSync(
    executable,
    `#!/bin/sh
case "$*" in
  *enablePullRequestAutoMerge*)
    [ "$GH_TOKEN" = write-fixture ] || exit 91
    printf '%s\\n' enable >> "$FIXTURE_CALLS"
    printf '%s\\n' "$FIXTURE_ENABLE_RESPONSE"
    exit 0;;
esac
[ "$GH_TOKEN" = read-fixture ] || exit 92
case "$*" in
  'variable get STELLA_MERGE_HOLD --repo '*) printf '%s\\n' 'variable STELLA_MERGE_HOLD was not found' >&2; exit 1;;
  *timelineItems*) printf '%s\\n' '[]';;
  *reviewThreads*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false}}';;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci-result"}]}},{"type":"merge_queue","parameters":{}}]';;
  *'actions/runs?head_sha='*) ;;
  *check-runs*) printf '1\\tci-result\\tin_progress\\t\\n';;
  *updatedAt*)
    printf '%s\\n' arm-read >> "$FIXTURE_CALLS"
    printf '%s\\n' "$FIXTURE_PULL_RESPONSE";;
  *'api graphql'*) printf '%s\\n' "$FIXTURE_PULL_RESPONSE";;
  *headRefOid*) printf '%s\\n' "$FIXTURE_HEAD_RESPONSE";;
  *) printf '%s\\n' "Unexpected fixture command: $*" >&2; exit 93;;
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
        ...CLI_TEST_ENV,
        PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
        GH_READ_TOKEN: "read-fixture",
        GH_TOKEN: "write-fixture",
        STELLA_MERGE_HOLD_CHECKED_BY_WORKFLOW: "",
        FIXTURE_CALLS: calls,
        FIXTURE_PULL_RESPONSE: JSON.stringify({
          data: { repository: { pullRequest: state } },
        }),
        FIXTURE_HEAD_RESPONSE: JSON.stringify({ headRefOid: HEAD_SHA }),
        FIXTURE_ENABLE_RESPONSE: JSON.stringify({
          data: {
            enablePullRequestAutoMerge: {
              pullRequest: {
                ...state,
                autoMergeRequest: { enabledAt: "2026-10-02T10:00:00Z" },
              },
            },
          },
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stderr.toString()).toContain(
      "NOT ARMED: AUTO_MERGE_ABSENT_AFTER_ENABLE",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).not.toContain("verdict: ARMED");
    expect(readFileSync(calls, "utf-8").trim().split("\n")).toEqual([
      "arm-read",
      "enable",
      "arm-read",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the real CLI reports ALREADY QUEUED when an earlier arm's entry has a built merge group", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "merge-bar-queued-"));
  const executable = path.join(directory, "gh");
  const pull = {
    id: "PR_fixture",
    number: 123,
    title: "fix: verify merge handoff",
    isCrossRepository: false,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefOid: HEAD_SHA,
    baseRefName: "main",
    updatedAt: "2026-10-02T09:00:00Z",
    autoMergeRequest: null,
    mergeQueueEntry: null,
  };
  // The gate read sees no entry; by the arm read the earlier auto-merge has
  // enqueued the PR and GitHub has built its group (recorded entry shape).
  const armed = {
    ...pull,
    autoMergeRequest: { enabledAt: "2026-10-02T08:41:00Z" },
    mergeQueueEntry: {
      id: "MQE_recorded",
      position: 2,
      jump: false,
      state: "AWAITING_CHECKS",
      headCommit: { oid: "307e6cc2807f4c12fec4622174c422ce3fb6101a" },
    },
  };
  writeFileSync(
    executable,
    `#!/bin/sh
case "$*" in
  *PullRequestAutoMerge*|*enqueuePullRequest*) exit 94;;
esac
case "$*" in
  'variable get STELLA_MERGE_HOLD --repo '*) printf '%s\\n' 'variable STELLA_MERGE_HOLD was not found' >&2; exit 1;;
  *timelineItems*) printf '%s\\n' '[]';;
  *reviewThreads*) printf '%s\\n' '{"nodes":[],"pageInfo":{"hasNextPage":false}}';;
  *rules/branches/main*) printf '%s\\n' '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci-result"}]}},{"type":"merge_queue","parameters":{}}]';;
  *'actions/runs?head_sha='*) ;;
  *check-runs*) printf '1\\tci-result\\tin_progress\\t\\n';;
  *updatedAt*) printf '%s\\n' "$FIXTURE_ARM_RESPONSE";;
  *'api graphql'*) printf '%s\\n' "$FIXTURE_PULL_RESPONSE";;
  *headRefOid*) printf '%s\\n' "$FIXTURE_HEAD_RESPONSE";;
  *) printf '%s\\n' "Unexpected fixture command: $*" >&2; exit 93;;
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
        ...CLI_TEST_ENV,
        PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
        GH_READ_TOKEN: "read-fixture",
        GH_TOKEN: "write-fixture",
        STELLA_MERGE_HOLD_CHECKED_BY_WORKFLOW: "",
        FIXTURE_PULL_RESPONSE: JSON.stringify({
          data: { repository: { pullRequest: pull } },
        }),
        FIXTURE_ARM_RESPONSE: JSON.stringify({
          data: { repository: { pullRequest: armed } },
        }),
        FIXTURE_HEAD_RESPONSE: JSON.stringify({ headRefOid: HEAD_SHA }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stderr.toString()).not.toContain("QUEUE_HEAD_MISMATCH");
    expect(result.stdout.toString()).toContain(
      `verdict: ALREADY QUEUED at ${HEAD_SHA} (position 2, AWAITING_CHECKS)`,
    );
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const realEjections = [
  {
    run: realRun0,
    jobs: realJobs0,
    annotations: {
      "https://example.invalid/repos/stella/stella/check-runs/113149115699":
        annotations0_0,
      "https://example.invalid/repos/stella/stella/check-runs/113149903942":
        annotations0_1,
    },
    expected: "failed-steps",
  },
  {
    run: realRun1,
    jobs: realJobs1,
    annotations: {
      "https://example.invalid/repos/stella/stella/check-runs/113150755188":
        annotations1_0,
      "https://example.invalid/repos/stella/stella/check-runs/113152580573":
        annotations1_1,
    },
    expected: "failed-steps",
  },
  {
    run: realRun2,
    jobs: realJobs2,
    annotations: {
      "https://example.invalid/repos/stella/stella/check-runs/113150751404":
        annotations2_0,
      "https://example.invalid/repos/stella/stella/check-runs/113151718553":
        annotations2_1,
    },
    expected: "stale-cancel",
  },
] as const;

describe("failed merge group evidence", () => {
  for (const fixture of realEjections) {
    test(`cancelled CI Checks run ${fixture.run.id} supplies the cause despite a green preview`, () => {
      const pullNumber = Number(
        /pr-(\d+)-/u.exec(fixture.run.head_branch)?.[1],
      );
      const annotations = new Map(Object.entries(fixture.annotations));
      const group = readMergeGroupRecord({
        runs: {
          workflow_runs: [
            { name: "Visual preview", conclusion: "success" },
            fixture.run,
          ],
        },
        pullNumber,
        readJobs: (id) => {
          expect(id).toBe(fixture.run.id);
          return fixture.jobs;
        },
        readAnnotations: (url) => {
          expect(annotations.has(url)).toBe(true);
          return annotations.get(url);
        },
      });
      expect(group.type).toBe("found");
      if (group.type !== "found") {
        return;
      }
      expect(group.runUrl).toBe(fixture.run.html_url);
      expect(group.cause.type).toBe(fixture.expected);
      if (group.cause.type === "failed-steps") {
        expect(group.cause.steps.at(0)).toContain(
          fixture.run.id === 37_727_028_977
            ? "typecheck-baseline / 13:"
            : "e2e-production-shard (1) / 9:",
        );
        expect(formatEjection({ removal: failedRemoval(), group })).toContain(
          group.cause.steps.join("; "),
        );
      }
      for (const headChanged of [false, true]) {
        const verdict = evaluateEjectedHead({
          headSha: headChanged ? OTHER_SHA : HEAD_SHA,
          ejection: { removal: failedRemoval(), group },
          mainTip: { sha: MAIN_SHA, committedAt: REMOVED_AT },
        });
        expect(verdict.type).toBe(
          headChanged || fixture.expected === "stale-cancel"
            ? "retry-allowed"
            : "failed-step",
        );
      }
    });
  }

  test("missing ci-result diagnostic falls back to the cancelling job", () => {
    const group = readMergeGroupRecord({
      runs: { workflow_runs: [realRun0] },
      pullNumber: 5275,
      readJobs: () => realJobs0,
      readAnnotations: (url) =>
        url.endsWith("113149903942") ? [] : annotations0_0,
    });
    expect(group.type === "found" && group.cause.type).toBe("failed-steps");
  });

  test("ordinary cancellations and absent diagnostics remain unknown", () => {
    expect(
      parseMergeGroupAnnotations([
        { message: "The run was canceled by @github-actions[bot]." },
      ]),
    ).toEqual({ type: "unknown" });
    expect(
      parseMergeGroupAnnotations([
        {
          message:
            "ci-result: cancelling failed merge group; failed steps: not yet available from the jobs API",
        },
      ]),
    ).toEqual({ type: "unknown" });
  });

  test.each(["read failure", "malformed diagnostic"])(
    "annotation %s refuses even with main moved and jump reset",
    (failure) => {
      const group = readMergeGroupRecord({
        runs: { workflow_runs: [realRun0] },
        pullNumber: 5275,
        readJobs: () => realJobs0,
        readAnnotations: () => {
          if (failure === "read failure") {
            throw new Error("annotations unavailable");
          }
          return [
            {
              message:
                "ci-result: cancelling failed merge group; failed steps: malformed",
            },
          ];
        },
      });
      const result = checkEjectedHead({
        gateway: {
          readMergeQueueRemovals: () => [failedRemoval()],
          readMergeGroup: () => group,
          readBranchTip: () => ({ sha: MAIN_SHA, committedAt: REMOVED_AT }),
        },
        pullRequest: { headSha: HEAD_SHA, baseRefName: "main" },
        readReset: () => {
          throw new Error("must not seek a reset override");
        },
      });
      expect(result.isErr() && result.error.message).toContain(
        "EJECTED_STEP_EVIDENCE_UNAVAILABLE",
      );
      expect(result.isErr() && result.error.message).toContain(
        failure === "read failure"
          ? "annotations unavailable"
          : "Invalid failed merge group step diagnostic",
      );
      expect(
        evaluateEjectedHead({
          headSha: OTHER_SHA,
          ejection: { removal: failedRemoval(), group },
          mainTip: { sha: MAIN_SHA, committedAt: REMOVED_AT },
        }),
      ).toEqual({ type: "retry-allowed", changed: "head" });
    },
  );

  test("named failure refuses main movement and never consults jump reset", () => {
    const cause = parseMergeGroupAnnotations(annotations0_1);
    expect(cause.type).toBe("failed-steps");
    const result = checkEjectedHead({
      gateway: {
        readMergeQueueRemovals: () => [failedRemoval()],
        readMergeGroup: () => ({ ...foundGroup, cause }),
        readBranchTip: () => ({ sha: MAIN_SHA, committedAt: REMOVED_AT }),
      },
      pullRequest: { headSha: HEAD_SHA, baseRefName: "main" },
      readReset: () => {
        throw new Error("must not seek a reset override");
      },
    });
    expect(result.isErr() && result.error.message).toContain(
      "EJECTED_FAILED_STEP",
    );
    expect(result.isErr() && result.error.message).toContain(
      "Push a fix, or merge main",
    );
  });
});

describe("infrastructure merge group ejections", () => {
  const infraGroup = (
    cause: "rate-limit" | "runner-lost" | "network",
    evidence: string,
    resetAt: string | null = null,
  ): Ejection["group"] => ({
    type: "found",
    baseSha: BASE_SHA,
    runUrl: RUN_URL,
    cause: {
      type: "failed-steps",
      steps: [`api-check / 7: Query GitHub (${RUN_URL}/job/9001)`],
      failure: { type: "infra", cause, evidence, resetAt },
    },
  });

  const checkInfra = ({
    group,
    removals = [failedRemoval()],
    now = new Date("2026-10-02T13:00:00Z"),
  }: {
    group: Ejection["group"];
    removals?: readonly MergeQueueRemoval[];
    now?: Date;
  }) =>
    checkEjectedHead({
      gateway: {
        readMergeQueueRemovals: () => removals,
        readMergeGroup: () => group,
        readBranchTip: () => ({ sha: BASE_SHA, committedAt: REMOVED_AT }),
      },
      pullRequest: { headSha: HEAD_SHA, baseRefName: "main" },
      now,
    });

  test("rate-limit fixture reads documented REST and GraphQL evidence", () => {
    const annotations = new Map([
      [
        "https://example.invalid/repos/stella/stella/check-runs/9001",
        rateLimitAnnotations,
      ],
      [
        "https://example.invalid/repos/stella/stella/check-runs/9002",
        rateLimitResultAnnotations,
      ],
    ]);
    const group = readMergeGroupRecord({
      runs: { workflow_runs: [realRun0] },
      pullNumber: 5275,
      readJobs: () => rateLimitJobs,
      readAnnotations: (url) => annotations.get(url) ?? [],
    });
    expect(group.type === "found" && group.cause.type).toBe("failed-steps");
    if (group.type !== "found" || group.cause.type !== "failed-steps") {
      return;
    }
    expect(group.cause.failure).toEqual({
      type: "infra",
      cause: "rate-limit",
      evidence:
        "API rate limit exceeded for installation. Rate limit resets at 2000-01-01T01:00:00Z",
      resetAt: "2000-01-01T01:00:00Z",
    });
  });

  test.each([
    ["API rate limit exceeded", "rate-limit"],
    ["You hit a secondary rate limit", "rate-limit"],
    ['GraphQL type "RATE_LIMITED"', "rate-limit"],
    ["HTTP 429: rate-limit reached", "rate-limit"],
    ["lost communication with the server", "runner-lost"],
    ["runner has received a shutdown signal", "runner-lost"],
    ["connection reset by peer", "network"],
    ["connection refused", "network"],
    ["could not resolve host github.com", "network"],
    ["github.com returned HTTP 502", "network"],
  ] as const)("classifies %s as %s", (evidence, cause) => {
    expect(classifyFailedStepEvidence([evidence])).toMatchObject({
      type: "infra",
      cause,
      evidence,
    });
  });

  test("an unmatched failure and a cancellation without a lost runner fail closed", () => {
    expect(classifyFailedStepEvidence(["assertion failed"])).toEqual({
      type: "code",
      evidence: "assertion failed",
    });
    expect(classifyFailedStepEvidence(["operation was canceled"])).toEqual({
      type: "code",
      evidence: "operation was canceled",
    });
    expect(
      classifyFailedStepEvidence([
        "operation was canceled",
        "lost communication with the server",
      ]),
    ).toMatchObject({
      type: "infra",
      cause: "runner-lost",
      evidence: "operation was canceled",
    });
  });

  test("one unexplained failure line makes a step a code failure", () => {
    expect(
      classifyFailedStepEvidence([
        "API rate limit exceeded",
        "(fail) parses calendar dates",
      ]),
    ).toEqual({ type: "code", evidence: "(fail) parses calendar dates" });
    expect(
      classifyFailedStepEvidence(["Process completed with exit code 1."]),
    ).toEqual({ type: "code", evidence: "no failure evidence" });
  });

  const groupFor = (
    annotations: unknown,
    readJobLog: (jobId: number) => string = () => "",
  ) =>
    readMergeGroupRecord({
      runs: { workflow_runs: [realRun0] },
      pullNumber: 5275,
      readJobs: () => rateLimitJobs,
      readAnnotations: (url) =>
        url.endsWith("/9001") ? annotations : rateLimitResultAnnotations,
      readJobLog,
    });
  const failureOf = (group: ReturnType<typeof groupFor>) =>
    group.type === "found" && group.cause.type === "failed-steps"
      ? group.cause.failure
      : undefined;

  test("each line of a multiline annotation is its own evidence", () => {
    expect(
      classifyFailedStepEvidence(["API rate limit exceeded\nassertion failed"]),
    ).toEqual({ type: "code", evidence: "assertion failed" });
    expect(
      classifyFailedStepEvidence([
        "API rate limit exceeded\r\nsecondary rate limit",
      ]),
    ).toMatchObject({ type: "infra", cause: "rate-limit" });
  });

  test("a rate limit anywhere in a step wins and waits for its latest reset", () => {
    expect(
      classifyFailedStepEvidence([
        "connection reset by peer",
        "API rate limit exceeded. Rate limit resets at 2026-10-02T12:00:00Z",
        "API rate limit exceeded. Rate limit resets at 2026-10-02T12:30:00Z",
      ]),
    ).toMatchObject({
      type: "infra",
      cause: "rate-limit",
      resetAt: "2026-10-02T12:30:00Z",
    });
  });

  test("a rate limit in a later job is not skipped by an earlier network failure", () => {
    const [failedJob, resultJob] = rateLimitJobs.jobs;
    const networkJob = {
      ...failedJob,
      id: 9000,
      name: "web-check",
      check_run_url:
        "https://example.invalid/repos/stella/stella/check-runs/9000",
    };
    const annotations = new Map<string, unknown>([
      [
        networkJob.check_run_url,
        [{ annotation_level: "failure", message: "connection reset by peer" }],
      ],
      [
        failedJob?.check_run_url ?? "",
        [
          {
            annotation_level: "failure",
            message:
              "API rate limit exceeded. Rate limit resets at 2026-10-02T12:30:00Z",
          },
        ],
      ],
    ]);
    const group = readMergeGroupRecord({
      runs: { workflow_runs: [realRun0] },
      pullNumber: 5275,
      readJobs: () => ({
        ...rateLimitJobs,
        jobs: [networkJob, failedJob, resultJob],
      }),
      readAnnotations: (url) =>
        annotations.get(url) ?? rateLimitResultAnnotations,
      readJobLog: () => "",
    });
    expect(
      group.type === "found" && group.cause.type === "failed-steps"
        ? group.cause.failure
        : undefined,
    ).toMatchObject({
      type: "infra",
      cause: "rate-limit",
      resetAt: "2026-10-02T12:30:00Z",
    });
  });

  test("a recovered rate-limit warning never excuses a real failure", () => {
    const failure = failureOf(
      groupFor([
        { annotation_level: "warning", message: "API rate limit exceeded" },
        {
          annotation_level: "failure",
          message: "(fail) parses calendar dates",
        },
      ]),
    );
    expect(failure).toEqual({
      type: "code",
      evidence: "(fail) parses calendar dates",
    });
  });

  test("a step that names no cause is classified from its log error lines", () => {
    const logs: number[] = [];
    const failure = failureOf(
      groupFor(
        [
          {
            annotation_level: "failure",
            message: "Process completed with exit code 1.",
          },
        ],
        (jobId) => {
          logs.push(jobId);
          return "2026-10-09T15:00:00Z some output\n2026-10-09T15:00:01Z ##[error]API rate limit exceeded";
        },
      ),
    );
    expect(failure).toMatchObject({ type: "infra", cause: "rate-limit" });
    expect(logs).toHaveLength(1);
  });

  test("rate limiting refuses before reset and permits one retry after reset", () => {
    const group = infraGroup(
      "rate-limit",
      "API rate limit exceeded",
      "2026-10-02T12:00:00Z",
    );
    const early = checkInfra({
      group,
      now: new Date("2026-10-02T11:59:59Z"),
    });
    expect(early.isErr() && early.error.message).toContain(
      "EJECTED_INFRA_RATE_LIMIT_ACTIVE: rate-limit: API rate limit exceeded",
    );
    expect(early.isErr() && early.error.message).toContain(
      "Earliest re-arm: 2026-10-02 14:00:00 CEST",
    );
    const cleared = checkInfra({ group });
    expect(cleared.isOk() && cleared.value).toContain(
      "infrastructure failure rate-limit: API rate limit exceeded; one recovery attempt permitted",
    );
  });

  test.each([
    ["runner-lost", "lost communication with the server"],
    ["network", "connection reset by peer"],
  ] as const)(
    "permits one %s retry and prints its evidence",
    (cause, evidence) => {
      const result = checkInfra({ group: infraGroup(cause, evidence) });
      expect(result.isOk() && result.value).toContain(`${cause}: ${evidence}`);
    },
  );

  test("a second infrastructure ejection of the same head is refused", () => {
    const group = infraGroup("network", "connection refused");
    const result = checkInfra({
      group,
      removals: [
        failedRemoval({
          removedAt: "2026-10-02T10:00:00Z",
          groupSha: OTHER_SHA,
        }),
        failedRemoval(),
      ],
    });
    expect(result.isErr() && result.error.message).toContain(
      "EJECTED_INFRA_RETRY_USED: network: connection refused",
    );
    expect(result.isErr() && result.error.message).toContain(
      "already re-armed after an infrastructure ejection",
    );
  });

  test("a mixed infrastructure and code group is a code failure", () => {
    const jobs = {
      jobs: [
        ...rateLimitJobs.jobs,
        {
          id: 9003,
          name: "unit-test",
          check_run_url:
            "https://example.invalid/repos/stella/stella/check-runs/9003",
          steps: [{ number: 4, name: "Test", conclusion: "failure" }],
        },
      ],
    };
    const group = readMergeGroupRecord({
      runs: { workflow_runs: [realRun0] },
      pullNumber: 5275,
      readJobs: () => jobs,
      readAnnotations: (url) => {
        if (url.endsWith("9001")) {
          return rateLimitAnnotations;
        }
        if (url.endsWith("9002")) {
          return rateLimitResultAnnotations;
        }
        return [{ message: "assertion failed" }];
      },
    });
    const result = checkInfra({ group });
    expect(result.isErr() && result.error.message).toContain(
      "EJECTED_FAILED_STEP",
    );
  });

  test("reads at most one job log when annotations have no evidence", () => {
    let logReads = 0;
    const jobs = {
      jobs: [
        ...rateLimitJobs.jobs,
        {
          id: 9003,
          name: "second-failure",
          check_run_url:
            "https://example.invalid/repos/stella/stella/check-runs/9003",
          steps: [{ number: 4, name: "Test", conclusion: "failure" }],
        },
      ],
    };
    const group = readMergeGroupRecord({
      runs: { workflow_runs: [realRun0] },
      pullNumber: 5275,
      readJobs: () => jobs,
      readAnnotations: (url) =>
        url.endsWith("9002") ? rateLimitResultAnnotations : [],
      readJobLog: () => {
        logReads += 1;
        return "connection refused";
      },
    });
    expect(logReads).toBe(1);
    expect(
      group.type === "found" &&
        group.cause.type === "failed-steps" &&
        group.cause.failure.type,
    ).toBe("code");
  });
});

test.each([{ extraArguments: [] }, { extraArguments: ["--jump"] }])(
  "named failed-step CLI evidence blocks every write with main moved: %j",
  ({ extraArguments }) => {
    const result = runLiveBar({
      title: "fix: something",
      extraArguments,
      timeline: [
        commitNode(HEAD_SHA),
        removalNode({ reason: "failed_checks" }),
      ],
      mainTipSha: MAIN_SHA,
      comparison: { status: "identical" },
      groupEvidence: {
        jobs: {
          jobs: realJobs0.jobs.filter((job) => job.name === "ci-result"),
        },
        annotations: annotations0_1,
      },
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain("EJECTED_FAILED_STEP");
    expect(result.stderr).toContain(
      "typecheck-baseline / 13: Typecheck-cost baseline guard",
    );
    expect(result.writes).toEqual([]);
  },
);

test("public merge-group fixtures contain only synthetic metadata", () => {
  const directory = new URL("fixtures/merge-group-ejections/", import.meta.url);
  const files = readdirSync(directory).filter((file) => file.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const text = readFileSync(new URL(file, directory), "utf-8");
    for (const [timestamp] of text.matchAll(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/gu,
    )) {
      expect(timestamp.startsWith("2000-01-01T"), file).toBe(true);
    }
    for (const [, host] of text.matchAll(/https?:\/\/([^/\s")]+)/gu)) {
      expect(host, file).toBe("example.invalid");
    }
    for (const [email] of text.matchAll(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/giu)) {
      expect(email.endsWith("@example.invalid"), file).toBe(true);
    }
  }
});
