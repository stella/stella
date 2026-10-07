#!/usr/bin/env bun
//
// Merge bar: the sanctioned way to land a pull request.
//
// `gh pr merge` is a single write with no state assertions, so the operator
// supplies the safety argument from whatever they happened to read earlier.
// This tool re-reads every input inside one invocation and asserts each gate
// POSITIVELY before it writes. Two failure classes motivate it:
//
// (a) Negative-check misreads. "No failing checks" is not "checks passed".
//     A CONFLICTING pull request produces ZERO check runs, a draft produces
//     ZERO check runs, and a rollup filtered for failures over an empty list
//     is empty — all three read as green to a negative predicate. Every gate
//     here therefore demands a positive observation, and an empty check-run
//     list is an absent verdict rather than a passing one.
//
// (b) Time-of-check to time-of-use. Review threads, reviews, and pushes land
//     between a state read and the write. Gate inputs read minutes ago
//     describe a pull request that no longer exists. Everything below is
//     fetched in THIS invocation, the head SHA is re-read immediately before
//     the write, and that SHA is pinned into the write itself so GitHub
//     rejects it server-side if head moved in the remaining gap.
//
// What the write is depends on the repository's landing policy. Where the
// default branch has a merge queue, the bar arms "merge when ready": GitHub
// enqueues the pull request once its required checks and thread resolution
// hold, builds the base branch plus the pull request, runs CI on that commit,
// and merges only if it passes. Nothing needs a rebase to land, a baseline or
// lint rule measured on the branch is re-measured on the tree that lands, and
// migration identity is checked against the base as it stands at merge time.
// Where there is no queue, the bar merges directly, and only once the
// required checks have succeeded on the exact head.
//
// A head the queue ejected for failed checks is not handed back while main
// still stands where the failed group was built: the queue would rerun the
// same group. Changing the head, or main moving, lifts the refusal.
//
// The squash commit message is the pull request title and body, which each
// repository's squash settings select; nothing here composes a message.
//
// What this tool deliberately does NOT gate: review depth. Automated review
// requests are budgeted at two per pull request, because a third round buys
// re-litigation of the same diff rather than new findings. Spend both, address
// what they surface, resolve the threads, and let the gates below decide. A
// green bar is the merge argument; another review request is not.
//
// Usage:
//   bun scripts/merge-bar.ts <pr-number> [--repo owner/name] [--dry-run]
//   bun scripts/merge-bar.ts --disarm <pr-number> [--repo owner/name] [--dry-run]
//   bun scripts/merge-bar.ts --update-branch owner/name#<pr-number> --expected-head-sha <sha> [--dry-run]
//
// A non-empty STELLA_MERGE_HOLD repository variable holds ordinary pull requests;
// recognized release pull requests remain exempt, including --jump.
// Set: gh variable set STELLA_MERGE_HOLD --repo stella/stella --body "<reason>"
// Lift: gh variable delete STELLA_MERGE_HOLD --repo stella/stella

import { panic, Result, TaggedError } from "better-result";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readRuntimeMode } from "@stll/runtime-mode";

import { findMigrationIdentityViolation } from "./check-migration-order";
import {
  extractPlanSelector,
  type PlanSelectorError,
  runPlanScopes,
} from "./ci-plan-selector";
import { pilotFastJobs, pilotQueueJobs } from "./ci-pr-pilot-plan";
import { evaluate } from "./github-expression";
import {
  parseCiCoverageLog,
  type CiCoverageEvidence,
  type CiRunEvidence,
  type CiCoverageLogError,
} from "./merge-bar-ci-coverage";
import { decideBarFreshness, readBarFreshness } from "./merge-bar-freshness";
import {
  branchUpdateResponse,
  createBranchUpdateStore,
  updatePullRequestBranch,
} from "./merge-bar-update-branch";

const DEFAULT_REPO = "stella/stella" satisfies MergeBarRepository;
const MERGEABLE_POLL_ATTEMPTS = 8;
const MERGEABLE_POLL_INTERVAL_MS = 2000;
const MERGE_COMMIT_POLL_ATTEMPTS = 5;
const PULL_NUMBER_PATTERN = /^\d+$/u;
const MIGRATION_ALIAS_INVENTORY =
  "apps/api/src/lib/db/migration-alias-inventory.json";

export class MergeHoldReadError extends TaggedError("MergeHoldReadError")<{
  message: string;
}> {}

class MergeHoldError extends TaggedError("MergeHoldError")<{
  message: string;
}> {}

type CheckMergeHoldOptions = {
  readVariable: () => Result<string | null, MergeHoldReadError>;
  readIsRelease: () => Result<boolean, MergeHoldReadError>;
  checkedByWorkflow?: string | undefined;
  githubActions?: string | undefined;
};

export const checkMergeHold = ({
  readVariable,
  readIsRelease,
  checkedByWorkflow,
  githubActions,
}: CheckMergeHoldOptions) => {
  if (checkedByWorkflow === "1" && githubActions === "true") {
    return Result.ok({ source: "workflow" } as const);
  }
  return readVariable().andThen((reason) => {
    if (reason === null || reason === "") {
      return Result.ok({ source: "repository-variable" } as const);
    }
    return readIsRelease().andThen((isRelease) =>
      isRelease
        ? Result.ok({ source: "repository-variable" } as const)
        : Result.err(new MergeHoldError({ message: `MERGE HOLD: ${reason}` })),
    );
  });
};

// --- Repository policy --------------------------------------------------------

const LANDINGS = ["merge-when-ready", "merge"] as const;
type Landing = (typeof LANDINGS)[number];

export type RepositoryPolicy = {
  requiredCheckRuns: readonly string[];
  // Where committed migrations live, for repositories that carry any.
  migrationDirectory: string | null;
  landing: Landing;
};

type RepositoryCapabilities = {
  // Where committed migrations live, for repositories that carry any.
  migrationDirectory: string | null;
  // How a green ci-result is judged against ratchet changes on the base since
  // it ran: `base-definitions` reads scripts/ratchet-definition-paths.json
  // from the base branch and rechecks; `none` for repositories without the
  // ratchet.
  ratchetFreshness: "base-definitions" | "none";
};

/** The repositories merge-bar lands, each with what its checks rely on. */
export const MERGE_BAR_REPOSITORIES = {
  "stella/stella": {
    migrationDirectory: "apps/api/drizzle",
    ratchetFreshness: "base-definitions",
  },
  "stella/folio": { migrationDirectory: null, ratchetFreshness: "none" },
  "stella/stella-infra": { migrationDirectory: null, ratchetFreshness: "none" },
} as const satisfies Record<string, RepositoryCapabilities>;

export type MergeBarRepository = keyof typeof MERGE_BAR_REPOSITORIES;

const isMergeBarRepository = (repo: string): repo is MergeBarRepository =>
  Object.hasOwn(MERGE_BAR_REPOSITORIES, repo);

/** GitHub names are case-insensitive; the map is keyed in lower case. */
export const readMergeBarRepository = (raw: string): MergeBarRepository => {
  const repo = raw.toLowerCase();
  if (!isMergeBarRepository(repo)) {
    return panic(
      `merge-bar does not know ${raw}; add it to MERGE_BAR_REPOSITORIES with its capabilities`,
    );
  }
  return repo;
};

/**
 * Derive the landing contract from GitHub's active rules for the target
 * branch. Required checks and merge-queue state change independently of this
 * repository, so a local mirror silently drifts and eventually blocks a valid
 * merge or admits one under the wrong policy.
 */
export const mergeBarRepositoryPolicy = (
  repo: MergeBarRepository,
  rawRules: unknown,
): RepositoryPolicy => {
  if (!Array.isArray(rawRules)) {
    panic("Expected an array of active branch rules from gh");
  }

  const requiredCheckRuns: string[] = [];
  let landing: Landing = "merge";

  for (const rawRule of rawRules) {
    const rule = readRecord(rawRule, "branch rule");
    const type = readString(rule, "type");
    if (type === "merge_queue") {
      landing = "merge-when-ready";
      continue;
    }
    if (type !== "required_status_checks") {
      continue;
    }

    const parameters = readRecord(
      rule["parameters"],
      "required_status_checks parameters",
    );
    const checks = parameters["required_status_checks"];
    if (!Array.isArray(checks)) {
      panic("Expected an array for required_status_checks");
    }
    for (const rawCheck of checks) {
      const context = readString(
        readRecord(rawCheck, "required status check"),
        "context",
      );
      if (!requiredCheckRuns.includes(context)) {
        requiredCheckRuns.push(context);
      }
    }
  }

  if (requiredCheckRuns.length === 0) {
    panic(`No required status checks are active for ${repo}`);
  }

  return {
    requiredCheckRuns,
    migrationDirectory: MERGE_BAR_REPOSITORIES[repo].migrationDirectory,
    landing,
  };
};

// --- Gate model -------------------------------------------------------------

const GATE_IDS = [
  "pull-request-state",
  "mergeable",
  "required-check",
  "review-threads",
  "migration-identity",
  "head-stability",
] as const;
type GateId = (typeof GATE_IDS)[number];

// Named reasons: a refusal must say which invariant failed, never just "no".
const MERGE_BAR_REASONS = {
  notOpen: "PULL_REQUEST_NOT_OPEN",
  draft: "PULL_REQUEST_IS_DRAFT",
  conflicting: "MERGEABLE_CONFLICTING",
  mergeableUnknown: "MERGEABLE_UNKNOWN",
  checkRunsStale: "CHECK_RUNS_READ_FOR_STALE_SHA",
  requiredCheckMissing: "REQUIRED_CHECK_MISSING",
  requiredCheckIncomplete: "REQUIRED_CHECK_INCOMPLETE",
  requiredCheckNotSuccessful: "REQUIRED_CHECK_NOT_SUCCESSFUL",
  ciPlanSkipped: "CI_PLAN_SKIPPED",
  claUnsigned: "CLA_UNSIGNED",
  claUnlinkedAuthor: "CLA_UNLINKED_AUTHOR",
  unresolvedReviewThreads: "UNRESOLVED_REVIEW_THREADS",
  migrationIdentity: "MIGRATION_IDENTITY_VIOLATION",
  headMoved: "HEAD_MOVED_DURING_CHECKS",
} as const;
type MergeBarReason =
  (typeof MERGE_BAR_REASONS)[keyof typeof MERGE_BAR_REASONS];

const PULL_REQUEST_STATES = ["OPEN", "CLOSED", "MERGED"] as const;
const MERGEABLE_STATES = ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const;

type PullRequestSnapshot = {
  id: string;
  number: number;
  title: string;
  isCrossRepository: boolean;
  baseRefName: string;
  state: (typeof PULL_REQUEST_STATES)[number];
  isDraft: boolean;
  mergeable: (typeof MERGEABLE_STATES)[number];
  handoff: MergeHandoff;
  headSha: string;
};

type CheckRunSnapshot = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  outputTitle?: string;
  checkSuiteId?: number;
};

type WorkflowRunSnapshot = {
  checkSuiteId: number;
  path: string;
  event: string;
};

type ReviewThreadSnapshot = { id: string; isResolved: boolean };

type MigrationSnapshot = {
  addedDirectories: readonly string[];
  removedDirectories: readonly string[];
  modifiedDirectories: readonly string[];
  unsupportedChanges: readonly string[];
  inventoryChanged: boolean;
};

export type MergeBarSnapshot = {
  pullRequest: PullRequestSnapshot;
  landing: Landing;
  requiredCheckRuns: readonly string[];
  // The SHA the check runs were actually fetched for. Kept separate from
  // `pullRequest.headSha` so a read against a stale commit cannot masquerade
  // as a read against the current one.
  checkRunsHeadSha: string;
  checkRuns: readonly CheckRunSnapshot[];
  reviewThreads: readonly ReviewThreadSnapshot[];
  migrations: MigrationSnapshot;
  // Re-read immediately before the write.
  headShaBeforeMerge: string;
};

type GateVerdict =
  | { gate: GateId; status: "pass"; detail: string }
  | { gate: GateId; status: "fail"; reason: MergeBarReason; detail: string };

export type MergeBarVerdict = {
  decision: "merge" | "abort";
  gates: readonly GateVerdict[];
};

// --- Gates ------------------------------------------------------------------

const evaluatePullRequestState = (
  pullRequest: PullRequestSnapshot,
): GateVerdict => {
  if (pullRequest.state !== "OPEN") {
    return {
      gate: "pull-request-state",
      status: "fail",
      reason: MERGE_BAR_REASONS.notOpen,
      detail: `state is ${pullRequest.state}`,
    };
  }
  // A draft runs zero required workflows, so its check-run list is empty for
  // reasons that have nothing to do with the code being correct.
  if (pullRequest.isDraft) {
    return {
      gate: "pull-request-state",
      status: "fail",
      reason: MERGE_BAR_REASONS.draft,
      detail: "draft pull requests do not run the required workflows",
    };
  }
  return { gate: "pull-request-state", status: "pass", detail: "OPEN" };
};

const evaluateMergeable = (pullRequest: PullRequestSnapshot): GateVerdict => {
  if (pullRequest.mergeable === "CONFLICTING") {
    return {
      gate: "mergeable",
      status: "fail",
      reason: MERGE_BAR_REASONS.conflicting,
      detail: "rebase onto the default branch; a conflicting PR runs no CI",
    };
  }
  if (pullRequest.mergeable === "UNKNOWN") {
    return {
      gate: "mergeable",
      status: "fail",
      reason: MERGE_BAR_REASONS.mergeableUnknown,
      detail: "GitHub has not finished computing mergeability",
    };
  }
  return { gate: "mergeable", status: "pass", detail: "MERGEABLE" };
};

const CI_PLAN_CHECK_RUN = "ci-plan";

// The events whose CI runs judge a pull request. A dispatched run on the same
// head (a manual full-depth validation, for one) reports its own ci-result and
// ci-checks, which must neither block nor pass the PR.
const PULL_REQUEST_CI_EVENTS: ReadonlySet<string> = new Set([
  "pull_request",
  "merge_group",
]);

/**
 * Drops the check runs that a CI workflow run outside the pull request events
 * produced on the head. Check runs from any other workflow or app are kept.
 */
export const pullRequestCheckRuns = ({
  checkRuns,
  workflowRuns,
}: {
  checkRuns: readonly CheckRunSnapshot[];
  workflowRuns: readonly WorkflowRunSnapshot[];
}): readonly CheckRunSnapshot[] => {
  const offEventSuites = new Set(
    workflowRuns
      .filter(
        (run) =>
          run.path.split("@")[0] === CI_WORKFLOW &&
          !PULL_REQUEST_CI_EVENTS.has(run.event),
      )
      .map((run) => run.checkSuiteId),
  );
  return checkRuns.filter(
    (run) =>
      run.checkSuiteId === undefined || !offEventSuites.has(run.checkSuiteId),
  );
};

const latestRunByName = (
  checkRuns: readonly CheckRunSnapshot[],
): Map<string, CheckRunSnapshot> => {
  const latestByName = new Map<string, CheckRunSnapshot>();
  for (const run of checkRuns) {
    const current = latestByName.get(run.name);
    if (current === undefined || run.id > current.id) {
      latestByName.set(run.name, run);
    }
  }
  return latestByName;
};

/**
 * Every required check has succeeded on the head. The queue accepts a direct
 * enqueue only then; before it, "merge when ready" arms auto-merge instead.
 */
export const requiredChecksSucceeded = ({
  checkRuns,
  requiredCheckRuns,
}: {
  checkRuns: readonly CheckRunSnapshot[];
  requiredCheckRuns: readonly string[];
}): boolean => {
  const latestByName = latestRunByName(checkRuns);
  return requiredCheckRuns.every((name) => {
    const run = latestByName.get(name);
    return run?.status === "completed" && run.conclusion === "success";
  });
};

const evaluateContributorSignatureCheck = (
  latestByName: ReadonlyMap<string, CheckRunSnapshot>,
  pullNumber: number,
): GateVerdict | undefined => {
  const contributorCheck = latestByName.get("cla");
  const openerCheck = latestByName.get(`cla/pr-${pullNumber}`);
  const cla = [contributorCheck, openerCheck].find(
    (check) => check?.status === "completed" && check.conclusion === "failure",
  );
  if (
    (cla?.outputTitle === "CLA_UNSIGNED" ||
      cla?.outputTitle === "CLA_UNLINKED_AUTHOR") &&
    !(cla.status === "completed" && cla.conclusion === "success")
  ) {
    return {
      gate: "required-check",
      status: "fail",
      reason:
        cla.outputTitle === "CLA_UNLINKED_AUTHOR"
          ? MERGE_BAR_REASONS.claUnlinkedAuthor
          : MERGE_BAR_REASONS.claUnsigned,
      detail:
        cla.outputTitle === "CLA_UNLINKED_AUTHOR"
          ? "Link every commit author to a GitHub account and rerun the cla check."
          : "Read https://github.com/stella/cla/blob/main/CLA.md and post exactly: I have read the CLA Document and I hereby sign the CLA",
    };
  }
  if (cla?.status === "completed" && cla.conclusion === "failure") {
    return {
      gate: "required-check",
      status: "fail",
      reason: MERGE_BAR_REASONS.requiredCheckNotSuccessful,
      detail:
        "cla verification failed; inspect the check output and rerun after fixing it.",
    };
  }
  if (
    contributorCheck?.status === "completed" &&
    contributorCheck.conclusion === "success" &&
    !(
      openerCheck?.status === "completed" &&
      openerCheck.conclusion === "success"
    )
  ) {
    return {
      gate: "required-check",
      status: "fail",
      reason: MERGE_BAR_REASONS.requiredCheckNotSuccessful,
      detail: `The exact pull request check cla/pr-${pullNumber} must succeed before landing.`,
    };
  }
  return undefined;
};

// A direct merge needs every required check to have SUCCEEDED on the head:
// the write is final. "Merge when ready" needs only that none has FAILED: a
// check still running, or not yet created for a fresh push, is what GitHub
// waits on before it enqueues, so refusing it would only add a manual wait.
const evaluateRequiredCheck = ({
  checkRuns,
  checkRunsHeadSha,
  headSha,
  landing,
  requiredCheckRuns,
  pullNumber,
}: {
  pullNumber: number;
  checkRuns: readonly CheckRunSnapshot[];
  checkRunsHeadSha: string;
  headSha: string;
  landing: Landing;
  requiredCheckRuns: readonly string[];
}): GateVerdict => {
  if (checkRunsHeadSha !== headSha) {
    return {
      gate: "required-check",
      status: "fail",
      reason: MERGE_BAR_REASONS.checkRunsStale,
      detail: `check runs read for ${checkRunsHeadSha}, head is ${headSha}`,
    };
  }

  const latestByName = latestRunByName(checkRuns);
  const claVerdict = evaluateContributorSignatureCheck(
    latestByName,
    pullNumber,
  );
  if (claVerdict) {
    return claVerdict;
  }
  const required = requiredCheckRuns.flatMap((name) => {
    const run = latestByName.get(name);
    return run === undefined ? [] : [run];
  });
  const observedNames = new Set(required.map(({ name }) => name));
  const missingNames = requiredCheckRuns.filter(
    (name) => !observedNames.has(name),
  );
  const incomplete = required.filter((run) => run.status !== "completed");
  const unsuccessful = required.filter(
    (run) => run.status === "completed" && run.conclusion !== "success",
  );
  const quote = (names: readonly string[]): string =>
    names.map((name) => `\`${name}\``).join(", ");

  // CI Checks skips its plan, and every job after it, for a draft. A run
  // queued while the pull request was still a draft can supersede the run for
  // the ready one, so a skipped plan on a ready head checked nothing.
  if (latestByName.get(CI_PLAN_CHECK_RUN)?.conclusion === "skipped") {
    return {
      gate: "required-check",
      status: "fail",
      reason: MERGE_BAR_REASONS.ciPlanSkipped,
      detail: `\`${CI_PLAN_CHECK_RUN}\` was skipped on ${headSha}; re-run CI Checks`,
    };
  }

  if (unsuccessful.length > 0) {
    return {
      gate: "required-check",
      status: "fail",
      reason: MERGE_BAR_REASONS.requiredCheckNotSuccessful,
      detail: `\`${unsuccessful.at(0)?.name ?? "required check"}\` concluded ${unsuccessful.at(0)?.conclusion ?? "null"}`,
    };
  }

  if (landing === "merge-when-ready") {
    const pending = [...missingNames, ...incomplete.map(({ name }) => name)];
    return {
      gate: "required-check",
      status: "pass",
      detail:
        pending.length === 0
          ? `${quote(requiredCheckRuns)} success on ${headSha}`
          : `${quote(pending)} pending on ${headSha}; GitHub merges once they succeed`,
    };
  }

  // The load-bearing case: an empty list is an ABSENT verdict, not a passing
  // one. Filtering a rollup for failures would report "none" here and merge.
  if (missingNames.length > 0) {
    return {
      gate: "required-check",
      status: "fail",
      reason: MERGE_BAR_REASONS.requiredCheckMissing,
      detail:
        `missing required check run(s) ${quote(missingNames)} on ${headSha} ` +
        `(${checkRuns.length} check run(s) present)`,
    };
  }
  if (incomplete.length > 0) {
    return {
      gate: "required-check",
      status: "fail",
      reason: MERGE_BAR_REASONS.requiredCheckIncomplete,
      detail: `\`${incomplete.at(0)?.name ?? "required check"}\` is ${incomplete.at(0)?.status ?? "pending"}`,
    };
  }
  return {
    gate: "required-check",
    status: "pass",
    detail: `${quote(requiredCheckRuns)} success on ${headSha}`,
  };
};

const evaluateReviewThreads = (
  reviewThreads: readonly ReviewThreadSnapshot[],
): GateVerdict => {
  const unresolved = reviewThreads.filter((thread) => !thread.isResolved);
  if (unresolved.length > 0) {
    return {
      gate: "review-threads",
      status: "fail",
      reason: MERGE_BAR_REASONS.unresolvedReviewThreads,
      detail: `${unresolved.length} unresolved thread(s): ${unresolved
        .map((thread) => thread.id)
        .join(", ")}`,
    };
  }
  return {
    gate: "review-threads",
    status: "pass",
    detail: `${reviewThreads.length} thread(s), all resolved`,
  };
};

// Checked here for fast feedback and again by CI on the merge-group commit,
// where the base is what the pull request actually lands on.
const evaluateMigrationIdentity = (
  migrations: MigrationSnapshot,
): GateVerdict => {
  if (migrations.unsupportedChanges.length > 0) {
    return {
      gate: "migration-identity",
      status: "fail",
      reason: MERGE_BAR_REASONS.migrationIdentity,
      detail: `unsupported migration changes: ${migrations.unsupportedChanges.join(", ")}`,
    };
  }
  const violation = findMigrationIdentityViolation(migrations);
  if (violation?.type === "invalid-name") {
    return {
      gate: "migration-identity",
      status: "fail",
      reason: MERGE_BAR_REASONS.migrationIdentity,
      detail: `${violation.directory} does not start with a 14-digit timestamp`,
    };
  }
  if (violation?.type === "removed-base-migration") {
    return {
      gate: "migration-identity",
      status: "fail",
      reason: MERGE_BAR_REASONS.migrationIdentity,
      detail:
        `${violation.directory} was removed; its folder name is the migration's ` +
        `identity in the deployed ledger. Renaming a merged migration makes ` +
        `deployed databases re-run it under the new name; deleting it removes ` +
        `it from fresh databases. Add a new migration instead.`,
    };
  }
  if (
    migrations.modifiedDirectories.length > 0 &&
    !migrations.inventoryChanged
  ) {
    return {
      gate: "migration-identity",
      status: "fail",
      reason: MERGE_BAR_REASONS.migrationIdentity,
      detail:
        `${migrations.modifiedDirectories.join(", ")} changed without a migration ` +
        `alias inventory update`,
    };
  }
  return {
    gate: "migration-identity",
    status: "pass",
    detail: `${migrations.addedDirectories.length} added and ${migrations.removedDirectories.length} removed migration(s)`,
  };
};

const evaluateHeadStability = ({
  headSha,
  headShaBeforeMerge,
}: {
  headSha: string;
  headShaBeforeMerge: string;
}): GateVerdict => {
  if (headSha !== headShaBeforeMerge) {
    return {
      gate: "head-stability",
      status: "fail",
      reason: MERGE_BAR_REASONS.headMoved,
      detail: `head moved ${headSha} -> ${headShaBeforeMerge}; nothing verified that commit`,
    };
  }
  return { gate: "head-stability", status: "pass", detail: headSha };
};

/**
 * The whole merge bar as a pure function of one snapshot: every gate is
 * evaluated so the operator sees the full picture, and any single failure
 * aborts. Callers must build the snapshot from reads taken in one invocation.
 */
export const evaluateMergeBar = (
  snapshot: MergeBarSnapshot,
): MergeBarVerdict => {
  const gates = [
    evaluatePullRequestState(snapshot.pullRequest),
    evaluateMergeable(snapshot.pullRequest),
    evaluateRequiredCheck({
      pullNumber: snapshot.pullRequest.number,
      checkRuns: snapshot.checkRuns,
      checkRunsHeadSha: snapshot.checkRunsHeadSha,
      headSha: snapshot.pullRequest.headSha,
      landing: snapshot.landing,
      requiredCheckRuns: snapshot.requiredCheckRuns,
    }),
    evaluateReviewThreads(snapshot.reviewThreads),
    evaluateMigrationIdentity(snapshot.migrations),
    evaluateHeadStability({
      headSha: snapshot.pullRequest.headSha,
      headShaBeforeMerge: snapshot.headShaBeforeMerge,
    }),
  ] as const;

  return {
    decision: gates.some((gate) => gate.status === "fail") ? "abort" : "merge",
    gates,
  };
};

// How far main may have moved for the changed-file comparison to stay
// readable. Beyond it the comparison is skipped, not refused: the merge group
// re-runs the ratchet and full CI on the real merge commit, so main moving is
// never by itself a reason to make a green PR run CI again.
const MAX_GREEN_BASE_DRIFT = 20;
const COMPARE_FILE_LIMIT = 300;

class StaleGreenResultError extends TaggedError("StaleGreenResultError")<{
  message: string;
}> {}

// --- Current CI plan --------------------------------------------------------

const CI_WORKFLOW = ".github/workflows/ci.yml";
const CI_PLAN_JOB = "ci-plan";
const CI_RESULT_JOB = "ci-result";
const CI_RESULT_STEP = "Evaluate CI outcome";
const CHANGED_FILES_OUTPUT =
  /^\$\{\{ steps\.changed-files\.outputs\.([a-z0-9_]+) \}\}$/u;

type JobScope =
  | { type: "always" }
  | { type: "selector"; variable: string }
  // Planned from something other than the changed files, such as release
  // recognition or an expression over several outputs.
  | { type: "not-file-derived"; output: string };

type FastRequiredJob = {
  id: string;
  scope: JobScope;
  pilotGate?: "deferred-capable";
  // Matches the job's names in a workflow run, matrix legs included.
  runName: RegExp;
};

const readJsonEnv = (env: Record<string, unknown>, key: string): unknown =>
  JSON.parse(readString(env, key));

const runNamePattern = (id: string, template: unknown): RegExp => {
  const name = typeof template === "string" ? template : id;
  const escaped = name
    .split(/\$\{\{.*?\}\}/u)
    .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".+");
  return new RegExp(`^${escaped}(?: \\(.+\\))?$`, "u");
};

type CheckFastJobPredicateOptions = {
  id: string;
  condition: string;
  output: string | null;
  workflow: unknown;
};

const checkFastJobPredicate = ({
  id,
  condition,
  output,
  workflow,
}: CheckFastJobPredicateOptions) => {
  // Every atom the freshness model pins must remain a declared workflow gate.
  // Unsupported atoms fail even when another false gate would short-circuit them.
  const atoms = [
    "needs.ci-plan.outputs.run_required != 'false'",
    "inputs.heavy_only != true",
    "needs.ci-plan.outputs.trusted == 'true'",
    "github.event_name == 'workflow_dispatch'",
    "github.event_name != 'merge_group'",
    "needs.ci-plan.outputs.queue_depth != 'thin'",
    "needs.ci-plan.outputs.coverage_profile != 'pilot-fast-v1'",
    `contains(fromJSON(needs.ci-plan.outputs.pilot_fast_jobs || '[]'), '${id}')`,
    `contains(fromJSON(needs.ci-plan.outputs.queue_required_jobs || '[]'), '${id}')`,
    ...(output === null ? [] : [`needs.ci-plan.outputs.${output} == 'true'`]),
  ];
  let remainder = condition.replaceAll(/\s+/gu, " ").trim();
  for (const atom of atoms) {
    remainder = remainder.replaceAll(atom, "");
  }
  if (!/^[\s()&|]*$/u.test(remainder)) {
    panic(`Unmodeled fast-required predicate: ${id}`);
  }
  const gated = condition.includes("needs.ci-plan.outputs.coverage_profile");
  const fallback = pilotQueueJobs(workflow);
  if (fallback.status === "invalid") {
    panic(fallback.message);
  }
  const fast = pilotFastJobs(workflow);
  if (fast.status === "invalid") {
    panic(fast.message);
  }
  const deferred = gated && !fast.jobs.includes(id);
  const fallbackJob = fallback.jobs.find((job) => job === id);
  if (deferred && fallbackJob === undefined) {
    panic(`No mandatory queue fallback for pilot-deferred ${id}`);
  }
  for (const selected of [false, true]) {
    for (const profile of ["normal-v1", "pilot-fast-v1"]) {
      for (const included of [false, true]) {
        const values: Record<string, string | boolean> = {
          "github.event_name": "pull_request",
          "inputs.heavy_only": false,
          "needs.ci-plan.outputs.run_required": "true",
          "needs.ci-plan.outputs.trusted": "true",
          "needs.ci-plan.outputs.queue_depth": "full",
          "needs.ci-plan.outputs.coverage_profile": profile,
          "needs.ci-plan.outputs.pilot_fast_jobs": JSON.stringify(
            included ? [id] : [],
          ),
          ...Object.fromEntries(
            output === null
              ? []
              : [[`needs.ci-plan.outputs.${output}`, String(selected)]],
          ),
        };
        const planned = output === null || selected;
        const expected =
          planned && (!gated || profile === "normal-v1" || included);
        if (
          evaluate(condition, {
            values,
            status: { success: true, failure: false, cancelled: false },
          }) !== expected
        ) {
          panic(`Unmodeled fast-required predicate: ${id}`);
        }
        if (deferred && planned) {
          const queue = {
            ...values,
            "github.event_name": "merge_group",
            "needs.ci-plan.outputs.suite_depth": "full",
            "needs.ci-plan.outputs.queue_depth": "thin",
            "needs.ci-plan.outputs.coverage_profile": "normal-v1",
            "needs.ci-plan.outputs.normal_completion": "required",
            "needs.ci-plan.outputs.queue_required_jobs": JSON.stringify(
              fallback.jobs,
            ),
          };
          if (
            evaluate(condition, {
              values: queue,
              status: { success: true, failure: false, cancelled: false },
            }) !== true
          ) {
            panic(`Pilot queue fallback cannot run ${id}`);
          }
        }
      }
    }
  }
  return deferred ? ({ pilotGate: "deferred-capable" } as const) : {};
};

/**
 * The jobs ci-result requires at fast depth, each with the ci-plan output
 * that plans it, read from a workflow's own ci-result step so the bar cannot
 * drift from the gate. Null when the workflow has no such planner and gate.
 */
export const readFastRequiredJobs = (
  workflowSource: string,
): FastRequiredJob[] | null => {
  const workflow = readRecord(Bun.YAML.parse(workflowSource), "CI workflow");
  const jobs = readRecord(workflow["jobs"], "CI workflow jobs");
  const planJob = jobs[CI_PLAN_JOB];
  const resultJob = jobs[CI_RESULT_JOB];
  if (planJob === undefined || resultJob === undefined) {
    return null;
  }
  const planOutputs = readRecord(
    readRecord(planJob, `${CI_PLAN_JOB} job`)["outputs"],
    `${CI_PLAN_JOB} outputs`,
  );
  const steps = readRecord(resultJob, `${CI_RESULT_JOB} job`)["steps"];
  if (!Array.isArray(steps)) {
    return panic(`Expected \`steps\` in the ${CI_RESULT_JOB} job`);
  }
  const step = steps
    .map((candidate: unknown) => readRecord(candidate, `${CI_RESULT_JOB} step`))
    .find((candidate) => candidate["name"] === CI_RESULT_STEP);
  if (step === undefined) {
    return panic(`Expected a "${CI_RESULT_STEP}" step in ${CI_RESULT_JOB}`);
  }
  const env = readRecord(step["env"], `${CI_RESULT_STEP} env`);
  // A gate without a fast-required list has no fast depth to recheck.
  if (!Object.hasOwn(env, "FAST_REQUIRED")) {
    return null;
  }
  const required = readJsonEnv(env, "FAST_REQUIRED");
  if (
    !Array.isArray(required) ||
    !required.every((id) => typeof id === "string")
  ) {
    return panic("Expected FAST_REQUIRED to list job ids");
  }
  // ci-result looks fast scopes up in JOB_SCOPES + FAST_JOB_SCOPES, the
  // latter winning; an absent or null scope means always planned.
  const pilotEnabled =
    Object.hasOwn(env, "COVERAGE_PROFILE") &&
    Object.hasOwn(env, "PILOT_FAST_JOBS");
  const scopes = {
    ...readRecord(readJsonEnv(env, "JOB_SCOPES"), "JOB_SCOPES"),
    ...readRecord(readJsonEnv(env, "FAST_JOB_SCOPES"), "FAST_JOB_SCOPES"),
  };
  return required.map((id) => {
    const output = scopes[id];
    const body = readRecord(jobs[id], `job ${id}`);
    const runName = runNamePattern(id, body["name"]);
    const pilot = pilotEnabled
      ? checkFastJobPredicate({
          id,
          condition: readString(body, "if"),
          output: typeof output === "string" ? output : null,
          workflow,
        })
      : {};
    if (output === null || output === undefined) {
      return { id, scope: { type: "always" }, runName, ...pilot };
    }
    if (typeof output !== "string") {
      return panic(`Expected a ci-plan output name as the scope of ${id}`);
    }
    const expression = readString(planOutputs, output);
    const variable = CHANGED_FILES_OUTPUT.exec(expression)?.[1];
    return {
      id,
      scope:
        variable === undefined
          ? { type: "not-file-derived", output }
          : { type: "selector", variable },
      runName,
      ...pilot,
    };
  });
};

export type RunJob = { name: string; conclusion: string | null };

type UnrunPlannedJobsOptions = {
  jobs: readonly FastRequiredJob[];
  plan: ReadonlyMap<string, boolean>;
  runJobs: readonly RunJob[];
  coverage?: CiCoverageEvidence;
};

/**
 * Fast-required jobs the current plan selects that the green run did not
 * run to success. Every leg of a matrix job must have succeeded; a job its
 * own plan skipped did not run.
 */
export const unrunPlannedJobs = ({
  jobs,
  plan,
  runJobs,
  coverage = { profile: "normal-v1" },
}: UnrunPlannedJobsOptions): string[] =>
  jobs
    .filter(
      ({ id, pilotGate }) =>
        coverage.profile !== "pilot-fast-v1" ||
        pilotGate !== "deferred-capable" ||
        coverage.jobs.includes(id),
    )
    .filter(({ scope }) => {
      switch (scope.type) {
        case "always":
          return true;
        case "selector":
          return (
            plan.get(scope.variable) ??
            panic(`The plan has no value for ${scope.variable}`)
          );
        case "not-file-derived":
          return false;
        default:
          scope satisfies never;
          return panic("Unhandled job scope");
      }
    })
    .filter(({ runName }) => {
      const runs = runJobs.filter(({ name }) => runName.test(name));
      return (
        runs.length === 0 ||
        runs.some(({ conclusion }) => conclusion !== "success")
      );
    })
    .map(({ id }) => id);

/** The selector variables a set of jobs is planned by. */
const selectorVariables = (jobs: readonly FastRequiredJob[]): string[] => [
  ...new Set(
    jobs.flatMap(({ scope }) =>
      scope.type === "selector" ? [scope.variable] : [],
    ),
  ),
];

export class RatchetRecheckError extends TaggedError("RatchetRecheckError")<{
  message: string;
}> {}

/**
 * The ratchet-freshness capability of the target repository, from
 * `MERGE_BAR_REPOSITORIES`.
 */
export type RatchetFreshness =
  | { type: "none" }
  | {
      type: "base-definitions";
      // The ratchet judges a PR with these sources, so a green run from
      // before main changed one applied different rules than the merge queue
      // will. Read from the base branch: an older checkout's copy may miss a
      // newer helper.
      readDefinitionPaths: (baseRefName: string) => unknown;
      // Measures the ratchet on the base branch tip merged with this head, as
      // the merge queue will, with the base's checker: a definition change on
      // main costs one local ratchet run instead of a full CI re-run.
      recheck: (input: {
        headSha: string;
        baseRefName: string;
      }) => Result<void, RatchetRecheckError>;
    };

type RatchetFreshnessFailureOptions = {
  ratchet: RatchetFreshness;
  mergeGroupRetests: boolean;
  changedPaths: ReadonlySet<string>;
  pullFiles: readonly string[];
  pullRequest: PullRequestSnapshot;
};

const ratchetFreshnessFailure = ({
  ratchet,
  mergeGroupRetests,
  changedPaths,
  pullFiles,
  pullRequest: { headSha, baseRefName },
}: RatchetFreshnessFailureOptions): string | null => {
  switch (ratchet.type) {
    case "none":
      return null;
    case "base-definitions":
      break;
    default:
      ratchet satisfies never;
      return panic("Unknown ratchet freshness capability");
  }
  const definitions = ratchet.readDefinitionPaths(baseRefName);
  if (
    !Array.isArray(definitions) ||
    definitions.length === 0 ||
    !definitions.every((entry) => typeof entry === "string")
  ) {
    return "cannot read the ratchet definition paths from the base";
  }
  const ratchetChanges = definitions.filter((filename) =>
    changedPaths.has(filename),
  );
  if (ratchetChanges.length === 0) {
    return null;
  }
  // The recheck runs the base's checker, which cannot judge a PR that edits
  // the checker itself; the merge group runs the merged checker instead, and
  // a direct merge has none, so it needs CI on the merged tree.
  if (pullFiles.some((filename) => definitions.includes(filename))) {
    return mergeGroupRetests
      ? null
      : `main changed the ratchet since the green run (${ratchetChanges.join(", ")}) and this PR changes it too`;
  }
  const recheck = ratchet.recheck({ headSha, baseRefName });
  if (recheck.isOk()) {
    return null;
  }
  return (
    `main changed the ratchet since the green run (${ratchetChanges.join(", ")}) ` +
    `and the ratchet does not pass on ${baseRefName} merged with this head: ${
      recheck.error.message
    }`
  );
};

/** Every path main's comparison names, renamed files under both names. */
const changedPathsOf = (files: readonly unknown[]) => {
  const changedPaths = new Set<string>();
  for (const rawFile of files) {
    const file = readRecord(rawFile, "base changed file");
    changedPaths.add(readString(file, "filename"));
    if (typeof file["previous_filename"] === "string") {
      changedPaths.add(file["previous_filename"]);
    }
  }
  return changedPaths;
};

type MainMovedFailureOptions = {
  commits: number;
  files: unknown;
  pullFiles: readonly string[];
  pullRequest: PullRequestSnapshot;
  ratchet: RatchetFreshness;
  mergeGroupRetests: boolean;
};

/**
 * Why main moving since the green run makes it stale, or null. Where a merge
 * group re-tests the real merge commit, only a ratchet that fails on main
 * merged with this head still counts.
 */
const mainMovedFailure = ({
  commits,
  files,
  pullFiles,
  pullRequest,
  ratchet,
  mergeGroupRetests,
}: MainMovedFailureOptions): string | null => {
  if (commits > MAX_GREEN_BASE_DRIFT) {
    return mergeGroupRetests
      ? null
      : `main advanced ${commits} commits since the green run (limit ${MAX_GREEN_BASE_DRIFT})`;
  }
  if (!Array.isArray(files) || files.length >= COMPARE_FILE_LIMIT) {
    return mergeGroupRetests
      ? null
      : "cannot establish complete changed-file coverage for main";
  }
  const changedPaths = changedPathsOf(files);
  const ratchetFailure = ratchetFreshnessFailure({
    ratchet,
    mergeGroupRetests,
    changedPaths,
    pullFiles,
    pullRequest,
  });
  if (ratchetFailure !== null || mergeGroupRetests) {
    return ratchetFailure;
  }
  const overlap = pullFiles.filter((filename) => changedPaths.has(filename));
  return overlap.length > 0
    ? `main changed files also touched by this PR: ${overlap.join(", ")}`
    : null;
};

type CheckGreenResultFreshnessOptions = {
  pullRequest: PullRequestSnapshot;
  jump: boolean;
  checkRuns: readonly CheckRunSnapshot[];
  readWorkflowRun: (checkRunId: number) => unknown;
  readBaseComparison: (testedBaseSha: string, baseRefName: string) => unknown;
  readPullFiles: () => readonly string[];
  // The base branch's ci.yml as it stands now; null when it has none.
  readBaseWorkflow: () => string | null;
  runSelector: (input: {
    selector: string;
    files: readonly string[];
    outputs: readonly string[];
    title: string;
  }) => Result<ReadonlyMap<string, boolean>, PlanSelectorError>;
  readRunJobs: (runId: number) => readonly RunJob[];
  readRunCoverage: (runId: number) => Result<CiRunEvidence, CiCoverageLogError>;
  ratchet: RatchetFreshness;
  // True where landing hands the PR to a merge queue, whose merge group re-runs
  // the ratchet and full CI on the real merge commit. A direct merge has no such
  // run, so main moving still refuses a green result there.
  mergeGroupRetests: boolean;
};

export const checkGreenResultFreshness = (
  options: CheckGreenResultFreshnessOptions,
): Result<void, StaleGreenResultError> => {
  const {
    pullRequest,
    jump,
    checkRuns,
    readWorkflowRun,
    readBaseComparison,
    readPullFiles,
    readBaseWorkflow,
    runSelector,
    readRunJobs,
    readRunCoverage,
    ratchet,
    mergeGroupRetests,
  } = options;
  if (jump || isReleasePullRequest(pullRequest)) {
    return Result.ok();
  }
  const green = latestRunByName(checkRuns).get("ci-result");
  if (green?.status !== "completed" || green.conclusion !== "success") {
    return Result.ok();
  }
  const refuse = (detail: string) =>
    Result.err(
      new StaleGreenResultError({
        message: `STALE_GREEN_RESULT: ${detail}; merge main and let CI re-run.`,
      }),
    );
  // Use the workflow's triggering PR snapshot, never today's PR merge ref:
  // GitHub regenerates that ref whenever the base branch moves.
  const run = readRecord(readWorkflowRun(green.id), "ci-result workflow run");
  if (readString(run, "head_sha") !== pullRequest.headSha) {
    return refuse("ci-result workflow does not match the current PR head");
  }
  const pulls = run["pull_requests"];
  if (!Array.isArray(pulls)) {
    return refuse("ci-result workflow has no recorded PR base");
  }
  const rawPull = pulls.find(
    (value) =>
      readRecord(value, "workflow pull request")["number"] ===
      pullRequest.number,
  );
  if (rawPull === undefined) {
    return refuse("ci-result workflow has no recorded base for this PR");
  }
  const pull = readRecord(rawPull, "workflow pull request");
  if (
    readString(readRecord(pull["head"], "workflow PR head"), "sha") !==
    pullRequest.headSha
  ) {
    return refuse(
      "ci-result workflow PR snapshot does not match the current head",
    );
  }
  const base = readRecord(pull["base"], "workflow PR base");
  if (readString(base, "ref") !== pullRequest.baseRefName) {
    return refuse("ci-result was computed for another base branch");
  }
  const testedBaseSha = readString(base, "sha");
  const comparison = readRecord(
    readBaseComparison(testedBaseSha, pullRequest.baseRefName),
    "base comparison",
  );
  const status = readString(comparison, "status");
  if (status === "identical") {
    return Result.ok();
  }
  if (status !== "ahead") {
    return refuse(
      "the tested base is no longer an ancestor of the current base",
    );
  }
  const commits = comparison["ahead_by"];
  if (
    typeof commits !== "number" ||
    !Number.isSafeInteger(commits) ||
    commits < 0
  ) {
    panic("Expected a non-negative commit count in base comparison");
  }
  const pullFiles = readPullFiles();
  const moved = mainMovedFailure({
    commits,
    files: comparison["files"],
    pullFiles,
    pullRequest,
    ratchet,
    mergeGroupRetests,
  });
  if (moved !== null) {
    return refuse(moved);
  }

  // The green run planned its jobs with the planner of its own base. Re-plan
  // this PR's files with main's planner now: a rule main gained since can
  // require a job that run never had. A planner change that selects nothing
  // new for these files leaves the green result standing.
  const workflowSource = readBaseWorkflow();
  const jobs =
    workflowSource === null ? null : readFastRequiredJobs(workflowSource);
  if (workflowSource === null || jobs === null) {
    return Result.ok();
  }
  const plan = runSelector({
    selector: extractPlanSelector(workflowSource),
    files: pullFiles,
    outputs: selectorVariables(jobs),
    title: pullRequest.title,
  });
  if (plan.isErr()) {
    return refuse(`cannot evaluate main's CI plan: ${plan.error.message}`);
  }
  const runId = run["id"];
  if (typeof runId !== "number") {
    return panic("Expected a numeric workflow run id");
  }
  const evidence = readRunCoverage(runId);
  if (evidence.isErr()) {
    return refuse(`cannot read green CI coverage: ${evidence.error.message}`);
  }
  const coverage = evidence.value;
  switch (coverage.profile) {
    case "queue-validation": {
      // The pull_request `enqueued` run re-checks earlier coverage and runs
      // no jobs itself; it outlives the queue entry when the PR is ejected.
      // Judge the run below it, from its own base: older evidence can only
      // refuse more, never less.
      const below = checkRuns.filter(({ id }) => id !== green.id);
      const previous = latestRunByName(below).get("ci-result");
      if (
        previous?.status !== "completed" ||
        previous.conclusion !== "success"
      ) {
        return refuse(
          "no green ci-result run below the queue validation covers this head",
        );
      }
      return checkGreenResultFreshness({ ...options, checkRuns: below });
    }
    case "pilot-fast-v1":
      if (!mergeGroupRetests) {
        return refuse(
          "Pilot deferral requires mandatory merge-group validation",
        );
      }
      break;
    case "normal-v1":
      break;
    default:
      coverage satisfies never;
      return panic("Unhandled CI run evidence");
  }
  const unrun = unrunPlannedJobs({
    jobs,
    plan: plan.value,
    runJobs: readRunJobs(runId),
    coverage,
  });
  if (unrun.length > 0) {
    return Result.err(
      new StaleGreenResultError({
        message:
          `STALE_PLAN: main's CI plan now selects ${unrun.join(", ")} for this PR's files, ` +
          "which its green run did not run; merge main and let CI re-run.",
      }),
    );
  }
  return Result.ok();
};

// --- Merge queue ejections --------------------------------------------------

// Reasons GitHub reports on RemovedFromMergeQueueEvent. Only a group whose
// checks failed is an ejection: a manual dequeue or a merge says nothing about
// the result, and a conflict depends on the entries queued ahead (a conflict
// with the base itself already fails the mergeable gate).
const MERGE_QUEUE_REMOVAL_DISPOSITIONS = {
  failed_checks: "ejected",
  merge_conflict: "not-ejected",
  manual: "not-ejected",
  merged: "not-ejected",
} as const satisfies Record<string, "ejected" | "not-ejected">;
type MergeQueueRemovalReason = keyof typeof MERGE_QUEUE_REMOVAL_DISPOSITIONS;

// An unrecognized reason counts as an ejection, so a new failure kind cannot
// slip past the gate; it is printed verbatim.
type RemovalReason =
  | { type: "known"; value: MergeQueueRemovalReason }
  | { type: "unknown"; value: string };

const isKnownRemovalReason = (
  value: string,
): value is MergeQueueRemovalReason =>
  Object.hasOwn(MERGE_QUEUE_REMOVAL_DISPOSITIONS, value);

const readRemovalReason = (value: string): RemovalReason =>
  isKnownRemovalReason(value)
    ? { type: "known", value }
    : { type: "unknown", value };

const removalDisposition = (reason: RemovalReason) => {
  switch (reason.type) {
    case "known":
      return MERGE_QUEUE_REMOVAL_DISPOSITIONS[reason.value];
    case "unknown":
      return "ejected";
    default:
      reason satisfies never;
      return panic("Unhandled merge queue removal reason");
  }
};

export type MergeQueueRemoval = {
  removedAt: string;
  reason: RemovalReason;
  // The pull request head when it was removed; null when the timeline window
  // holds no head update before the removal.
  headSha: string | null;
  // The merge-group commit the queue tested; null when no group was built.
  groupSha: string | null;
};

const readTimestamp = (record: Record<string, unknown>, key: string) => {
  const value = readString(record, key);
  if (Number.isNaN(Date.parse(value))) {
    panic(`Expected a timestamp in \`${key}\`, got: ${value}`);
  }
  return value;
};

const readOptionalOid = (value: unknown, label: string): string | null =>
  value === null || value === undefined
    ? null
    : readString(readRecord(value, label), "oid");

/**
 * Removals in timeline order, each with the head the pull request had then.
 * A removal event names only the merge-group commit, so the head is the last
 * commit or force push before it. A commit dated before a removal but pushed
 * after it reads as the removed head, which refuses rather than admits.
 */
export const parseMergeQueueRemovals = (
  nodes: unknown,
): MergeQueueRemoval[] => {
  if (!Array.isArray(nodes)) {
    return panic("Expected an array of pull request timeline items");
  }
  const removals: MergeQueueRemoval[] = [];
  let headSha: string | null = null;
  for (const rawNode of nodes) {
    const node = readRecord(rawNode, "timeline item");
    const type = readString(node, "__typename");
    switch (type) {
      case "PullRequestCommit":
        headSha = readString(readRecord(node["commit"], "commit"), "oid");
        break;
      case "HeadRefForcePushedEvent":
        headSha = readOptionalOid(node["afterCommit"], "afterCommit");
        break;
      case "RemovedFromMergeQueueEvent":
        removals.push({
          removedAt: readTimestamp(node, "createdAt"),
          reason: readRemovalReason(readString(node, "reason")),
          headSha,
          groupSha: readOptionalOid(node["beforeCommit"], "beforeCommit"),
        });
        break;
      default:
        return panic(`Unexpected timeline item from gh: ${type}`);
    }
  }
  return removals;
};

/** The latest removal for a failed group; later dequeues do not clear it. */
export const latestEjection = (
  removals: readonly MergeQueueRemoval[],
): MergeQueueRemoval | undefined =>
  removals.findLast(
    (removal) => removalDisposition(removal.reason) === "ejected",
  );

type MergeGroupRecord =
  | { type: "found"; baseSha: string; runUrl: string }
  | { type: "not-found" };

type BranchTip = { sha: string; committedAt: string };

export type Ejection = {
  removal: MergeQueueRemoval;
  group: MergeGroupRecord;
};

type EjectedHeadVerdict =
  | { type: "retry-allowed"; changed: "head" | "main" }
  | { type: "unchanged-retry" };

type EvaluateEjectedHeadOptions = {
  headSha: string;
  ejection: Ejection;
  mainTip: BranchTip;
};

/**
 * Re-queueing a head the queue ejected for failed checks, onto the same main,
 * rebuilds the group that failed. Main counts as moved when its tip differs
 * from the base the failed group was built on: the queue fast-forwards main to
 * group commits, so that comparison is exact even when the group sat behind
 * another entry. Without a recorded group, a main tip committed after the
 * removal is the evidence instead.
 */
export const evaluateEjectedHead = ({
  headSha,
  ejection: { removal, group },
  mainTip,
}: EvaluateEjectedHeadOptions): EjectedHeadVerdict => {
  // An unknown head fails closed: it is treated as this one.
  if (removal.headSha !== null && removal.headSha !== headSha) {
    return { type: "retry-allowed", changed: "head" };
  }
  switch (group.type) {
    case "found":
      return group.baseSha === mainTip.sha
        ? { type: "unchanged-retry" }
        : { type: "retry-allowed", changed: "main" };
    case "not-found":
      return Date.parse(mainTip.committedAt) > Date.parse(removal.removedAt)
        ? { type: "retry-allowed", changed: "main" }
        : { type: "unchanged-retry" };
    default:
      group satisfies never;
      return panic("Unhandled merge group record");
  }
};

const EJECTION_TIME_ZONE = "Europe/Prague";
// The sv-SE locale renders an ISO-like "YYYY-MM-DD HH:MM:SS" timestamp.
const ejectionTimeFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: EJECTION_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

export const formatEjection = ({ removal, group }: Ejection): string => {
  const reason =
    removal.reason.type === "known"
      ? removal.reason.value
      : `${removal.reason.value} (unrecognized, counted as a failed group)`;
  const run =
    group.type === "found"
      ? `failing run ${group.runUrl}`
      : "no merge_group run found for it";
  return (
    `previous merge queue ejection: ${ejectionTimeFormat.format(new Date(removal.removedAt))}, ` +
    `head ${removal.headSha ?? "unknown"}, reason ${reason}, ${run}`
  );
};

class UnchangedEjectedHeadError extends TaggedError(
  "UnchangedEjectedHeadError",
)<{ message: string }> {}

type CheckEjectedHeadOptions = {
  gateway: Pick<
    GitHubGateway,
    "readMergeQueueRemovals" | "readMergeGroup" | "readBranchTip"
  >;
  pullRequest: Pick<PullRequestSnapshot, "headSha" | "baseRefName">;
};

/**
 * Refuse to hand the queue a head it already ejected for failed checks while
 * main still stands where that group was built: the result would repeat.
 * Ok carries the ejection to print, or null when the head was never ejected.
 * Neither --jump nor a release pull request is exempt.
 */
export const checkEjectedHead = ({
  gateway,
  pullRequest,
}: CheckEjectedHeadOptions) => {
  const removal = latestEjection(gateway.readMergeQueueRemovals());
  if (removal === undefined) {
    return Result.ok(null);
  }
  const ejection: Ejection = {
    removal,
    group:
      removal.groupSha === null
        ? { type: "not-found" }
        : gateway.readMergeGroup(removal.groupSha),
  };
  const mainTip = gateway.readBranchTip(pullRequest.baseRefName);
  const verdict = evaluateEjectedHead({
    headSha: pullRequest.headSha,
    ejection,
    mainTip,
  });
  const printed = formatEjection(ejection);
  switch (verdict.type) {
    case "retry-allowed":
      return Result.ok(
        verdict.changed === "head"
          ? `${printed}; the head changed since`
          : `${printed}; ${pullRequest.baseRefName} moved since (now ${mainTip.sha})`,
      );
    case "unchanged-retry":
      return Result.err(
        new UnchangedEjectedHeadError({
          message:
            `${printed}\nverdict: NOT ARMED — EJECTED_HEAD_UNCHANGED: ${pullRequest.headSha} ` +
            `failed in the merge queue and ${pullRequest.baseRefName} is still at ${mainTip.sha}, ` +
            "so the queue would rerun the same group. Push a fix, or wait for " +
            `${pullRequest.baseRefName} to move.`,
        }),
      );
    default:
      verdict satisfies never;
      return panic("Unhandled ejected head verdict");
  }
};

// --- gh seam ----------------------------------------------------------------

type GitHubGateway = {
  readPullRequest: () => PullRequestSnapshot;
  // Deliberately separate from `readPullRequest`: the pre-write re-read only
  // needs the SHA, and a narrow read makes the TOCTOU window smaller.
  readHeadSha: () => string;
  readCheckRuns: (headSha: string) => readonly CheckRunSnapshot[];
  readHeadWorkflowRuns: (headSha: string) => readonly WorkflowRunSnapshot[];
  readWorkflowRun: (checkRunId: number) => unknown;
  readBaseComparison: (testedBaseSha: string, baseRefName: string) => unknown;
  readPullFiles: () => readonly string[];
  readBaseWorkflow: (ref: string) => string | null;
  readRunJobs: (runId: number) => readonly RunJob[];
  readRunCoverage: (runId: number) => Result<CiRunEvidence, CiCoverageLogError>;
  readRatchetDefinitionPaths: (baseRefName: string) => unknown;
  readReviewThreads: () => readonly ReviewThreadSnapshot[];
  readMigrationDirectories: () => MigrationSnapshot;
  // Writes pin the head every gate was evaluated against, so GitHub
  // rejects them server-side if it moved since: the head-stability assertion
  // is enforced by the write itself, not by the gap between the last read and
  // it. Queue handoffs share one mutation-and-verification boundary.
  merge: (input: { expectedHeadSha: string }) => string;
  readArmState: () => unknown;
  mutateHandoff: (
    query: string,
    variables: { id: string; sha: string },
  ) => unknown;
  readMergeQueue: (branch: string) => readonly MergeQueueEntrySnapshot[];
  readMergeQueueRemovals: () => readonly MergeQueueRemoval[];
  readMergeGroup: (groupSha: string) => MergeGroupRecord;
  readBranchTip: (branch: string) => BranchTip;
  sleep: (milliseconds: number) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    panic(`Expected an object for ${label}`);
  }
  return value;
};

const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string") {
    panic(`Expected string field \`${key}\` in gh response`);
  }
  return value;
};

// Queue membership and auto-merge are independent API fields: a queued PR
// commonly has no autoMergeRequest. Queue membership takes precedence.
export const readMergeHandoff = (raw: Record<string, unknown>) => {
  const queue = raw["mergeQueueEntry"];
  const autoMerge = raw["autoMergeRequest"];
  if (queue !== null) {
    return {
      status: "queued",
      entryId: readString(readRecord(queue, "mergeQueueEntry"), "id"),
    } as const;
  }
  if (autoMerge !== null) {
    return {
      status: "armed",
      enabledAt: readString(
        readRecord(autoMerge, "autoMergeRequest"),
        "enabledAt",
      ),
    } as const;
  }
  return { status: "pending" } as const;
};

type MergeHandoff = ReturnType<typeof readMergeHandoff>;

export class DisarmError extends TaggedError("DisarmError")<{
  message: string;
}> {}

class DisarmChangedError extends TaggedError("DisarmChangedError")<{
  message: string;
}> {}

const DISARM_CHANGED_MESSAGE =
  "disarmed, but the PR changed during the disarm; review and re-arm manually";

type DisarmPullRequestOptions = {
  gateway: Pick<GitHubGateway, "readArmState" | "mutateHandoff">;
  dryRun: boolean;
  expectedHeadSha?: string;
};

const checkDisarmHead = (raw: unknown, expectedHeadSha: string) => {
  const pull = readRecord(raw, "disarm pull request");
  if (pull["state"] !== "OPEN" || pull["headRefOid"] !== expectedHeadSha) {
    return Result.err(
      new DisarmError({
        message:
          "NOT DISARMED: expected head changed or its rollup is no longer red",
      }),
    );
  }
  const commits = readRecord(pull["commits"], "disarm commits")["nodes"];
  if (!Array.isArray(commits) || commits.length !== 1) {
    return Result.err(
      new DisarmError({ message: "NOT DISARMED: head rollup unavailable" }),
    );
  }
  const commit = readRecord(
    readRecord(commits[0], "disarm commit node")["commit"],
    "disarm commit",
  );
  const rawRollup = commit["statusCheckRollup"];
  if (rawRollup === null || rawRollup === undefined) {
    return Result.err(
      new DisarmError({ message: "NOT DISARMED: head rollup unavailable" }),
    );
  }
  const rollup = readRecord(rawRollup, "disarm head rollup");
  if (commit["oid"] !== expectedHeadSha || rollup["state"] !== "FAILURE") {
    return Result.err(
      new DisarmError({
        message:
          "NOT DISARMED: expected head changed or its rollup is no longer red",
      }),
    );
  }
  return Result.ok();
};

export const disarmPullRequest = ({
  gateway,
  dryRun,
  expectedHeadSha,
}: DisarmPullRequestOptions) =>
  Result.try(() => {
    const beforeRaw = gateway.readArmState();
    const before = armState(beforeRaw);
    if (expectedHeadSha !== undefined) {
      const pinned = checkDisarmHead(beforeRaw, expectedHeadSha);
      if (pinned.isErr()) {
        return pinned;
      }
    }
    if (dryRun) {
      return Result.ok({ status: "dry-run", id: before.id } as const);
    }
    const variables = { id: before.id, sha: before.headSha };
    if (before.autoMerge !== null) {
      gateway.mutateHandoff(
        `mutation($id:ID!) { disablePullRequestAutoMerge(input:{pullRequestId:$id}) { pullRequest { id } } }`,
        variables,
      );
    }
    // Disabling can race with auto-merge enqueueing; inspect queue membership
    // again before removing it, then verify both independent fields are clear.
    const currentRaw = gateway.readArmState();
    const current = armState(currentRaw);
    if (current.id !== before.id) {
      panic("Disarm read returned a different pull request");
    }
    if (
      expectedHeadSha !== undefined &&
      checkDisarmHead(currentRaw, expectedHeadSha).isErr()
    ) {
      return Result.err(
        new DisarmChangedError({ message: DISARM_CHANGED_MESSAGE }),
      );
    }
    if (current.queue !== null) {
      gateway.mutateHandoff(
        `mutation($id:ID!) { dequeuePullRequest(input:{id:$id}) { clientMutationId } }`,
        variables,
      );
    }
    const afterRaw = gateway.readArmState();
    const after = armState(afterRaw);
    if (after.id !== before.id) {
      panic("Disarm read returned a different pull request");
    }
    if (
      expectedHeadSha !== undefined &&
      checkDisarmHead(afterRaw, expectedHeadSha).isErr()
    ) {
      return Result.err(
        new DisarmChangedError({ message: DISARM_CHANGED_MESSAGE }),
      );
    }
    if (after.autoMerge !== null || after.queue !== null) {
      return Result.err(
        new DisarmError({
          message:
            "NOT DISARMED: Disarm verification failed: auto-merge or queue membership remains",
        }),
      );
    }
    return Result.ok({
      status: "disarmed",
      id: after.id,
      headSha: after.headSha,
    } as const);
  })
    .mapError(
      (error) => new DisarmError({ message: `NOT DISARMED: ${error.message}` }),
    )
    .andThen((result) => result);

const RELEASE_TITLE_PREFIX = "chore: release v";

/**
 * Recognized as in release-pr.yml's gate: a ready pull request into main
 * from this repository whose title starts with "chore: release v".
 */
export const isReleasePullRequest = (
  pullRequest: Pick<
    PullRequestSnapshot,
    "title" | "isDraft" | "isCrossRepository" | "baseRefName"
  >,
): boolean =>
  pullRequest.baseRefName === "main" &&
  pullRequest.title.startsWith(RELEASE_TITLE_PREFIX) &&
  !pullRequest.isDraft &&
  !pullRequest.isCrossRepository;

export type MergeWhenReadyAction =
  | { kind: "arm" }
  | { kind: "enqueue-jump" }
  // A jump was wanted, but the queue accepts one only once every required
  // check has succeeded. Nothing is armed: auto-merge would enqueue at the
  // back, which is the opposite of a jump. `armedSince` is set when an
  // auto-merge armed earlier will do exactly that.
  | { kind: "jump-waits-for-checks"; armedSince: string | null }
  // `verifyFront`: a jump was wanted, so the place it already holds must be
  // the front of the queue.
  | { kind: "already-queued"; entryId: string; verifyFront: boolean };

/**
 * What a passing merge bar does on a merge-queue branch. A jump enqueues
 * directly at the front, superseding an armed auto-merge (which would enqueue
 * at the back). A pull request already in the queue keeps its place: moving
 * it means dequeuing it first.
 */
export const mergeWhenReadyAction = ({
  handoff,
  jump,
  checksSucceeded,
}: {
  handoff: MergeHandoff;
  jump: boolean;
  checksSucceeded: boolean;
}): MergeWhenReadyAction => {
  if (handoff.status === "queued") {
    return {
      kind: "already-queued",
      entryId: handoff.entryId,
      verifyFront: jump,
    };
  }
  if (jump) {
    return checksSucceeded
      ? { kind: "enqueue-jump" }
      : {
          kind: "jump-waits-for-checks",
          armedSince: handoff.status === "armed" ? handoff.enabledAt : null,
        };
  }
  return { kind: "arm" };
};

export type MergeQueueEntrySnapshot = {
  pullNumber: number;
  position: number;
  jump: boolean;
  state: string;
};

type EnqueuedMergeQueueEntry = Pick<
  MergeQueueEntrySnapshot,
  "position" | "jump" | "state"
>;

export class ArmVerificationError extends TaggedError("ArmVerificationError")<{
  message: string;
}> {}

const armState = (value: unknown) => {
  const raw = readRecord(value, "arm verification pull request");
  return {
    id: readString(raw, "id"),
    headSha: readString(raw, "headRefOid"),
    updatedAt: readTimestamp(raw, "updatedAt"),
    autoMerge:
      raw["autoMergeRequest"] === null
        ? null
        : {
            enabledAt: readTimestamp(
              readRecord(raw["autoMergeRequest"], "autoMergeRequest"),
              "enabledAt",
            ),
          },
    queue:
      raw["mergeQueueEntry"] === null
        ? null
        : readRecord(raw["mergeQueueEntry"], "mergeQueueEntry"),
  };
};
// An entry's `headCommit` is the merge-group commit once GitHub builds the
// group, not the pull request head, so it cannot identify the queued head.
// The head is pinned instead by `expectedHeadOid` on enqueue and by the
// `headRefOid` read alongside the entry: a push removes a queued PR.
const queueReceipt = (raw: Record<string, unknown>) => {
  const position = raw["position"];
  if (
    typeof position !== "number" ||
    !Number.isSafeInteger(position) ||
    position < 1
  ) {
    return panic("Expected positive merge queue position");
  }
  return {
    position,
    jump: readBoolean(raw, "jump"),
    state: readString(raw, "state"),
  };
};
type ArmAndVerifyOptions = {
  pullRequestId: string;
  expectedHeadSha: string;
  jump: boolean;
  checksSucceeded: boolean;
  readState: () => unknown;
  readRemovals: () => readonly MergeQueueRemoval[];
  mutate: GitHubGateway["mutateHandoff"];
};

type VerifyArmReceiptOptions = {
  receipt: ReturnType<typeof armState>;
  after: ReturnType<typeof armState>;
  pullRequestId: string;
  expectedHeadSha: string;
  invalidatedAt: number;
  mode: "existing" | "refreshed";
};
const refuseArm = (reason: string) =>
  Result.err(new ArmVerificationError({ message: `NOT ARMED: ${reason}` }));
const verifyArmReceipt = ({
  receipt,
  after,
  pullRequestId,
  expectedHeadSha,
  invalidatedAt,
  mode,
}: VerifyArmReceiptOptions) => {
  if (
    receipt.id !== pullRequestId ||
    receipt.headSha !== expectedHeadSha ||
    after.id !== pullRequestId ||
    after.headSha !== expectedHeadSha
  ) {
    return refuseArm("HEAD_MOVED_DURING_ARMING");
  }
  if (after.queue !== null) {
    return Result.ok({
      kind: "queued",
      entry: queueReceipt(after.queue),
    } as const);
  }
  const staleReason =
    mode === "existing"
      ? "AUTO_MERGE_STALE_DURING_VERIFICATION"
      : "AUTO_MERGE_STALE_AFTER_ENABLE";
  if (receipt.autoMerge === null || after.autoMerge === null) {
    return refuseArm(
      mode === "existing" ? staleReason : "AUTO_MERGE_ABSENT_AFTER_ENABLE",
    );
  }
  const enabledAt = Date.parse(after.autoMerge.enabledAt);
  const stale =
    mode === "existing"
      ? enabledAt <= Math.max(invalidatedAt, Date.parse(after.updatedAt))
      : enabledAt < invalidatedAt;
  if (after.autoMerge.enabledAt !== receipt.autoMerge.enabledAt || stale) {
    return refuseArm(staleReason);
  }
  return Result.ok({
    kind: "armed",
    enabledAt: after.autoMerge.enabledAt,
  } as const);
};

// This is the sole owner of auto-merge and enqueue mutations. A pre-existing
// field predating a head update or queue removal is never evidence of arming.
// Verify a trusted request or refresh it against one new read. PR updatedAt
// conservatively bounds the latest head push;
// commit dates cannot establish when a commit was actually pushed.
export const armAndVerify = ({
  pullRequestId,
  expectedHeadSha,
  jump,
  checksSucceeded,
  readState,
  readRemovals,
  mutate,
}: ArmAndVerifyOptions) =>
  Result.try(() => {
    const before = armState(readState());
    if (before.id !== pullRequestId || before.headSha !== expectedHeadSha) {
      return refuseArm("HEAD_MOVED_DURING_ARMING");
    }
    if (before.queue !== null) {
      return Result.ok({
        kind: "already-queued",
        entry: queueReceipt(before.queue),
      } as const);
    }
    let lastRemoval = 0;
    for (const removal of readRemovals()) {
      lastRemoval = Math.max(
        lastRemoval,
        Date.parse(
          readTimestamp({ removedAt: removal.removedAt }, "removedAt"),
        ),
      );
    }
    const invalidatedAt = Math.max(Date.parse(before.updatedAt), lastRemoval);
    if (
      !jump &&
      before.autoMerge !== null &&
      Date.parse(before.autoMerge.enabledAt) > invalidatedAt
    ) {
      return verifyArmReceipt({
        receipt: before,
        after: armState(readState()),
        pullRequestId,
        expectedHeadSha,
        invalidatedAt,
        mode: "existing",
      });
    }
    if (jump || checksSucceeded) {
      const result = readRecord(
        mutate(
          `mutation($id:ID!, $sha:GitObjectID!) {
        enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$sha,jump:${jump ? "true" : "false"}}) {
          mergeQueueEntry { id position jump state }
        }
      }`,
          { id: pullRequestId, sha: expectedHeadSha },
        ),
        "enqueue response",
      );
      const receipt = queueReceipt(
        readRecord(
          readRecord(
            readRecord(result["data"], "data")["enqueuePullRequest"],
            "enqueue result",
          )["mergeQueueEntry"],
          "enqueue entry",
        ),
      );
      const after = armState(readState());
      if (after.id !== pullRequestId || after.headSha !== expectedHeadSha) {
        return refuseArm("HEAD_MOVED_DURING_ARMING");
      }
      if (!jump && after.queue === null) {
        return refuseArm("QUEUE_ENTRY_ABSENT_AFTER_ENQUEUE");
      }
      return Result.ok({ kind: "queued", entry: receipt } as const);
    }
    if (before.autoMerge !== null) {
      const disabled = readRecord(
        mutate(
          `mutation($id:ID!) { disablePullRequestAutoMerge(input:{pullRequestId:$id}) { pullRequest { id headRefOid autoMergeRequest { enabledAt } } } }`,
          { id: pullRequestId, sha: expectedHeadSha },
        ),
        "disable response",
      );
      const cleared = readRecord(
        readRecord(
          readRecord(disabled["data"], "data")["disablePullRequestAutoMerge"],
          "disable result",
        )["pullRequest"],
        "disabled pull request",
      );
      if (
        cleared["id"] !== pullRequestId ||
        cleared["headRefOid"] !== expectedHeadSha ||
        cleared["autoMergeRequest"] !== null
      ) {
        return refuseArm("AUTO_MERGE_NOT_CLEARED");
      }
    }
    const result = readRecord(
      mutate(
        `mutation($id:ID!, $sha:GitObjectID!) {
      enablePullRequestAutoMerge(input:{pullRequestId:$id,expectedHeadOid:$sha,mergeMethod:SQUASH}) {
        pullRequest { id headRefOid updatedAt autoMergeRequest { enabledAt } mergeQueueEntry { id position jump state } }
      }
    }`,
        { id: pullRequestId, sha: expectedHeadSha },
      ),
      "enable response",
    );
    const receipt = armState(
      readRecord(
        readRecord(result["data"], "data")["enablePullRequestAutoMerge"],
        "enable result",
      )["pullRequest"],
    );
    return verifyArmReceipt({
      receipt,
      after: armState(readState()),
      pullRequestId,
      expectedHeadSha,
      invalidatedAt,
      mode: "refreshed",
    });
  })
    .mapError(
      (error) =>
        new ArmVerificationError({ message: `NOT ARMED: ${error.message}` }),
    )
    .andThen((result) => result);

export type QueuePlacement =
  | { status: "front"; position: number }
  | { status: "absent"; queueLength: number }
  | { status: "behind"; position: number; ahead: readonly number[] };

/**
 * Where a pull request actually sits, from a queue read taken after the
 * enqueue. The enqueue response alone is not evidence: GitHub can accept a
 * jump request and still place the entry behind others.
 */
export const evaluateQueuePlacement = ({
  entries,
  pullNumber,
}: {
  entries: readonly Pick<MergeQueueEntrySnapshot, "pullNumber" | "position">[];
  pullNumber: number;
}): QueuePlacement => {
  const own = entries.find((entry) => entry.pullNumber === pullNumber);
  if (own === undefined) {
    return { status: "absent", queueLength: entries.length };
  }
  const ahead = entries
    .filter((entry) => entry.position < own.position)
    .toSorted((left, right) => left.position - right.position)
    .map((entry) => entry.pullNumber);
  // Positions are 1-based. A snapshot with a gap ahead of the entry (only it,
  // at position 2) is not proof of the front, so it fails closed.
  return own.position === 1 && ahead.length === 0
    ? { status: "front", position: own.position }
    : { status: "behind", position: own.position, ahead };
};

export const formatQueuePlacementFailure = (
  placement: Exclude<QueuePlacement, { status: "front" }>,
): string => {
  if (placement.status === "absent") {
    return `it is not among the ${placement.queueLength} merge queue entries`;
  }
  if (placement.ahead.length === 0) {
    return `it is at position ${placement.position}, with no entry listed ahead of it`;
  }
  return `it is at position ${placement.position}, behind ${placement.ahead
    .map((number) => `#${number}`)
    .join(", ")}`;
};

type VerifyFrontOfQueueOptions = {
  gateway: Pick<GitHubGateway, "readMergeQueue">;
  pullNumber: number;
  repo: string;
  branch: string;
  context: string;
  release: boolean;
  enqueuedEntry?: EnqueuedMergeQueueEntry;
};

// A recorded jump can be pending while GitHub rebuilds merge groups. Read
// once and report that state; only a fresh first position proves completion.
export const verifyFrontOfQueue = ({
  gateway,
  pullNumber,
  repo,
  branch,
  context,
  release,
  enqueuedEntry,
}: VerifyFrontOfQueueOptions): { exitCode: 0 | 1 | 2; message: string } => {
  const entries = gateway.readMergeQueue(branch);
  const placement = evaluateQueuePlacement({ entries, pullNumber });
  if (placement.status === "front") {
    return {
      exitCode: 0,
      message: `\nverdict: QUEUED AT THE FRONT — ${context}; verified first in the queue (position ${placement.position})${release ? " (release pull request)" : ""}`,
    };
  }
  const entry =
    entries.find((candidate) => candidate.pullNumber === pullNumber) ??
    enqueuedEntry;
  if (
    (placement.status === "absent" || placement.position > 1) &&
    entry?.jump === true
  ) {
    return {
      exitCode: 2,
      message:
        `\nverdict: JUMP PENDING (position ${entry.position}, state ${entry.state}) — ${context}. ` +
        `GitHub recorded the jump; ${placement.status === "absent" ? "the queue read did not list it yet" : "first place is not yet verified"}.\n` +
        `next: wait once for ${repo}#${pullNumber} to merge, close or fail checks; do not jump again.`,
    };
  }
  const reason =
    entry !== undefined && !entry.jump
      ? `GitHub queued the PR without the jump (position ${entry.position}).`
      : "GitHub did not confirm the jump at the front of the queue.";
  return {
    exitCode: 1,
    message: `\nverdict: JUMP DROPPED — ${context}; ${formatQueuePlacementFailure(placement)}. ${reason}`,
  };
};

const readBoolean = (record: Record<string, unknown>, key: string): boolean => {
  const value = record[key];
  if (typeof value !== "boolean") {
    panic(`Expected boolean field \`${key}\` in gh response`);
  }
  return value;
};

const readMember = <T extends string>(
  allowed: readonly T[],
  value: string,
  label: string,
): T => {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    panic(`Unexpected ${label} from gh: ${value}`);
  }
  return match;
};

// Automation can supply a workflow read token without widening the release
// App's permissions. Only the two merge operations use the write credential.
const githubEnvironment = (access: "read" | "write") => ({
  ...process.env,
  GH_TOKEN:
    access === "read"
      ? (process.env["GH_READ_TOKEN"] ?? process.env["GH_TOKEN"])
      : process.env["GH_TOKEN"],
});

const runGhProcess = (
  args: readonly string[],
  access: "read" | "write" = "read",
) =>
  Bun.spawnSync(
    ["bash", fileURLToPath(new URL("gh-retry.sh", import.meta.url)), ...args],
    {
      env: githubEnvironment(access),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

const runGh = (
  args: readonly string[],
  access: "read" | "write" = "read",
): string => {
  const result = runGhProcess(args, access);
  if (result.exitCode !== 0) {
    panic(
      `gh ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};

const readRepositoryMergeHold = (repo: string) => {
  const result = runGhProcess([
    "variable",
    "get",
    "STELLA_MERGE_HOLD",
    "--repo",
    repo,
  ]);
  if (result.exitCode === 0) {
    // gh appends a newline; whitespace in the variable itself still activates a hold.
    return Result.ok(result.stdout.toString().replace(/\r?\n$/u, ""));
  }
  if (
    result.stderr.toString().trim() ===
    "variable STELLA_MERGE_HOLD was not found"
  ) {
    return Result.ok(null);
  }
  return Result.err(
    new MergeHoldReadError({
      message: `Cannot read STELLA_MERGE_HOLD (${result.exitCode}): ${result.stderr.toString()}`,
    }),
  );
};

const readReleaseRecognition = (repo: string, pullNumber: number) => {
  const result = Bun.spawnSync(
    [
      "bash",
      fileURLToPath(new URL("release-pull-requests.sh", import.meta.url)),
      "--repo",
      repo,
      "--number",
      String(pullNumber),
    ],
    {
      env: githubEnvironment("read"),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    return Result.err(
      new MergeHoldReadError({
        message: `Cannot recognize release pull request (${result.exitCode}): ${result.stderr.toString()}`,
      }),
    );
  }
  const match = /^current_is_release=(true|false)$/mu.exec(
    result.stdout.toString(),
  );
  if (match === null) {
    return Result.err(
      new MergeHoldReadError({
        message: "Invalid release recognition response",
      }),
    );
  }
  return Result.ok(match[1] === "true");
};

const runGhJson = (args: readonly string[]): unknown => JSON.parse(runGh(args));

type RecheckRatchetOptions = {
  repositoryRoot: string;
  repo: string;
  baseSha: string;
  headSha: string;
};

/**
 * Runs the base's own `ratchet.ts --check` against the base merged with the
 * head. The pull request's tree is only measured as data (`--head` exports
 * it), so none of its code runs; the checker runs from a worktree of the base
 * commit under the ignored `.cache`, where it resolves this checkout's
 * installed dependencies, with no credentials in its environment. The merge
 * is built with plumbing, so no hook runs and no ref moves.
 */
const recheckRatchetOnBase = ({
  repositoryRoot,
  repo,
  baseSha,
  headSha,
}: RecheckRatchetOptions): Result<void, RatchetRecheckError> => {
  const git = (args: readonly string[], env?: Record<string, string>) =>
    Bun.spawnSync(["git", ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
  const fail = (step: string, result: { stderr: Buffer; stdout: Buffer }) =>
    Result.err(
      new RatchetRecheckError({
        message: `${step} failed: ${(result.stderr.toString() || result.stdout.toString()).trim()}`,
      }),
    );
  const fetched = git([
    "fetch",
    "--no-tags",
    "--quiet",
    `https://github.com/${repo}.git`,
    baseSha,
    headSha,
  ]);
  if (fetched.exitCode !== 0) {
    return fail("fetching the base and head", fetched);
  }
  const merged = git(["merge-tree", "--write-tree", baseSha, headSha]);
  const tree = /^([0-9a-f]{40})$/mu.exec(merged.stdout.toString())?.[1];
  if (merged.exitCode !== 0 || tree === undefined) {
    return fail("merging the base into the head", merged);
  }
  const committed = git(
    [
      "-c",
      "commit.gpgSign=false",
      "commit-tree",
      tree,
      "-p",
      baseSha,
      "-p",
      headSha,
      "-m",
      "merge-bar ratchet recheck",
    ],
    {
      GIT_AUTHOR_NAME: "merge-bar",
      GIT_AUTHOR_EMAIL: "merge-bar@localhost",
      GIT_COMMITTER_NAME: "merge-bar",
      GIT_COMMITTER_EMAIL: "merge-bar@localhost",
    },
  );
  if (committed.exitCode !== 0) {
    return fail("committing the merged tree", committed);
  }
  const cacheDirectory = path.join(repositoryRoot, ".cache");
  mkdirSync(cacheDirectory, { recursive: true });
  const worktree = mkdtempSync(path.join(cacheDirectory, "merge-bar-ratchet-"));
  const added = git([
    "worktree",
    "add",
    "--detach",
    "--quiet",
    worktree,
    baseSha,
  ]);
  if (added.exitCode !== 0) {
    rmSync(worktree, { recursive: true, force: true });
    return fail("creating the base worktree", added);
  }
  try {
    const checked = Bun.spawnSync(
      [
        "bun",
        "scripts/ratchet.ts",
        "--check",
        "--base",
        baseSha,
        "--head",
        committed.stdout.toString().trim(),
      ],
      {
        cwd: worktree,
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: process.env["HOME"] ?? "",
          TMPDIR: process.env["TMPDIR"] ?? "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (checked.exitCode !== 0) {
      return fail("ratchet --check", checked);
    }
    return Result.ok();
  } finally {
    git(["worktree", "remove", "--force", worktree]);
  }
};

const readLiveRepositoryPolicy = (
  repo: MergeBarRepository,
  baseRefName: string,
): RepositoryPolicy =>
  mergeBarRepositoryPolicy(
    repo,
    runGhJson([
      "api",
      `repos/${repo}/rules/branches/${encodeURIComponent(baseRefName)}`,
    ]),
  );

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved }
      }
    }
  }
}`;

const MERGE_QUEUE_REMOVALS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(
        itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]
        last: 100
      ) {
        nodes {
          __typename
          ... on RemovedFromMergeQueueEvent { createdAt reason beforeCommit { oid } }
          ... on PullRequestCommit { commit { oid } }
          ... on HeadRefForcePushedEvent { afterCommit { oid } }
        }
      }
    }
  }
}`;

const MERGE_GROUP_BRANCH_PATTERN =
  /^gh-readonly-queue\/.+\/pr-(?<number>\d+)-(?<base>[0-9a-f]{40})$/u;

const migrationDirectoryFromFile = ({
  filename,
  migrationDirectory,
}: {
  filename: string;
  migrationDirectory: string;
}): string | null => {
  const prefix = `${migrationDirectory}/`;
  const suffix = "/migration.sql";
  if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) {
    return null;
  }
  const name = filename.slice(prefix.length, -suffix.length);
  return name !== "" && !name.includes("/") ? `${prefix}${name}` : null;
};

const createGhGateway = ({
  repo,
  pullNumber,
  migrationDirectory,
}: {
  repo: string;
  pullNumber: number;
  migrationDirectory: string | null;
}): GitHubGateway => {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined || name === "") {
    panic(`--repo must be owner/name, got: ${repo}`);
  }
  const prArgs = [String(pullNumber), "--repo", repo];

  const readChangedFiles = () => {
    const rawChangedFiles = runGhJson([
      "api",
      `repos/${repo}/pulls/${pullNumber}`,
      "--jq",
      ".changed_files",
    ]);
    if (
      typeof rawChangedFiles !== "number" ||
      !Number.isSafeInteger(rawChangedFiles) ||
      rawChangedFiles < 0
    ) {
      panic("Expected a nonnegative changed_files count from gh");
    }
    const changedFiles = runGh([
      "api",
      "--paginate",
      `repos/${repo}/pulls/${pullNumber}/files`,
      "--jq",
      ".[] | {status, filename, previous_filename} | @json",
    ])
      .split("\n")
      .filter(Boolean)
      .map((line) => readRecord(JSON.parse(line), "changed pull request file"));
    if (changedFiles.length !== rawChangedFiles) {
      panic(
        `Expected ${rawChangedFiles} changed files from gh, received ${changedFiles.length}`,
      );
    }
    return changedFiles;
  };

  return {
    sleep: (milliseconds) => Bun.sleepSync(milliseconds),
    readHeadSha: () =>
      readString(
        readRecord(
          runGhJson(["pr", "view", ...prArgs, "--json", "headRefOid"]),
          "pr view",
        ),
        "headRefOid",
      ),

    readPullRequest: () => {
      const response = readRecord(
        runGhJson([
          "api",
          "graphql",
          "-f",
          `query=query($owner:String!, $name:String!, $number:Int!) {
            repository(owner:$owner, name:$name) {
              pullRequest(number:$number) {
                id number title isCrossRepository
                state isDraft mergeable headRefOid baseRefName
                autoMergeRequest { enabledAt }
                mergeQueueEntry { id }
              }
            }
          }`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-F",
          `number=${pullNumber}`,
        ]),
        "pull request response",
      );
      const raw = readRecord(
        readRecord(
          readRecord(response["data"], "data")["repository"],
          "repository",
        )["pullRequest"],
        "pull request",
      );
      const number = raw["number"];
      if (typeof number !== "number") {
        panic("Expected numeric field `number` in gh response");
      }
      return {
        id: readString(raw, "id"),
        number,
        title: readString(raw, "title"),
        isCrossRepository: readBoolean(raw, "isCrossRepository"),
        baseRefName: readString(raw, "baseRefName"),
        state: readMember(
          PULL_REQUEST_STATES,
          readString(raw, "state"),
          "state",
        ),
        isDraft: readBoolean(raw, "isDraft"),
        mergeable: readMember(
          MERGEABLE_STATES,
          readString(raw, "mergeable"),
          "mergeable",
        ),
        handoff: readMergeHandoff(raw),
        headSha: readString(raw, "headRefOid"),
      };
    },

    // Read the check runs recorded against one exact commit. `statusCheckRollup`
    // is deliberately avoided: it is a summary whose emptiness is ambiguous.
    readCheckRuns: (headSha) => {
      const lines = runGh([
        "api",
        "--paginate",
        `repos/${repo}/commits/${headSha}/check-runs`,
        "--jq",
        '.check_runs[] | [.id, .name, .status, (.conclusion // ""), (.output.title // ""), (.check_suite.id // "")] | @tsv',
      ])
        .split("\n")
        .filter(Boolean);

      const runs: CheckRunSnapshot[] = [];
      for (const line of lines) {
        const [rawId, runName, status, conclusion, outputTitle, rawSuiteId] =
          line.split("\t");
        const id = Number(rawId);
        const checkSuiteId =
          rawSuiteId === undefined || rawSuiteId === ""
            ? undefined
            : Number(rawSuiteId);
        if (
          !Number.isSafeInteger(id) ||
          runName === undefined ||
          status === undefined ||
          (checkSuiteId !== undefined && !Number.isSafeInteger(checkSuiteId))
        ) {
          panic(`Malformed check-run row from gh: ${line}`);
        }
        runs.push({
          id,
          name: runName,
          status,
          conclusion:
            conclusion === undefined || conclusion === "" ? null : conclusion,
          outputTitle: outputTitle ?? "",
          ...(checkSuiteId === undefined ? {} : { checkSuiteId }),
        });
      }
      return runs;
    },

    readHeadWorkflowRuns: (headSha) =>
      runGh([
        "api",
        "--paginate",
        `repos/${repo}/actions/runs?head_sha=${headSha}&per_page=100`,
        "--jq",
        ".workflow_runs[] | [.check_suite_id, .path, .event] | @tsv",
      ])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [rawSuiteId, workflowPath, event] = line.split("\t");
          const checkSuiteId = Number(rawSuiteId);
          if (
            !Number.isSafeInteger(checkSuiteId) ||
            workflowPath === undefined ||
            event === undefined
          ) {
            return panic(`Malformed workflow-run row from gh: ${line}`);
          }
          return { checkSuiteId, path: workflowPath, event };
        }),

    readWorkflowRun: (checkRunId) => {
      const check = readRecord(
        runGhJson(["api", `repos/${repo}/check-runs/${checkRunId}`]),
        "ci-result check run",
      );
      const url = readString(check, "details_url");
      const parsed = URL.canParse(url) ? new URL(url) : null;
      const [, urlOwner, urlName, actions, runs, runId] =
        parsed?.pathname.split("/") ?? [];
      if (
        parsed?.origin !== "https://github.com" ||
        urlOwner === undefined ||
        urlName === undefined ||
        `${urlOwner}/${urlName}`.toLowerCase() !== repo.toLowerCase() ||
        actions !== "actions" ||
        runs !== "runs" ||
        runId === undefined ||
        !PULL_NUMBER_PATTERN.test(runId)
      ) {
        panic(
          "ci-result check does not link to a workflow run in this repository",
        );
      }
      return runGhJson(["api", `repos/${repo}/actions/runs/${runId}`]);
    },

    readBaseComparison: (testedBaseSha, baseRefName) =>
      runGhJson([
        "api",
        `repos/${repo}/compare/${encodeURIComponent(testedBaseSha)}...${encodeURIComponent(baseRefName)}`,
      ]),

    readPullFiles: () =>
      readChangedFiles().flatMap((file) => {
        const filename = readString(file, "filename");
        const previousFilename = file["previous_filename"];
        return typeof previousFilename === "string"
          ? [filename, previousFilename]
          : [filename];
      }),

    readBaseWorkflow: (ref) => {
      const result = runGhProcess([
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/${repo}/contents/${CI_WORKFLOW}?ref=${encodeURIComponent(ref)}`,
      ]);
      if (result.exitCode === 0) {
        return result.stdout.toString();
      }
      if (result.stderr.toString().includes("HTTP 404")) {
        return null;
      }
      return panic(
        `gh could not read ${CI_WORKFLOW} at ${ref} (${result.exitCode}): ${result.stderr.toString()}`,
      );
    },

    readRunCoverage: (runId) => {
      const jobId = runGh([
        "api",
        `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
        "--jq",
        '.jobs[] | select(.name == "ci-result") | .id',
      ]).trim();
      if (!PULL_NUMBER_PATTERN.test(jobId)) {
        panic("Missing unique ci-result job for coverage evidence");
      }
      Bun.sleepSync(1100);
      return parseCiCoverageLog(
        runGh([
          "api",
          "--allow-escape-sequences",
          `repos/${repo}/actions/jobs/${jobId}/logs`,
        ]),
      );
    },

    readRunJobs: (runId) =>
      runGh([
        "api",
        "--paginate",
        `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
        "--jq",
        '.jobs[] | [.name, (.conclusion // "")] | @tsv',
      ])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [jobName, conclusion] = line.split("\t");
          if (jobName === undefined || jobName === "") {
            return panic(`Malformed job row from gh: ${line}`);
          }
          return {
            name: jobName,
            conclusion:
              conclusion === undefined || conclusion === "" ? null : conclusion,
          };
        }),

    readRatchetDefinitionPaths: (baseRefName) =>
      runGhJson([
        "api",
        "-H",
        "Accept: application/vnd.github.raw+json",
        `repos/${repo}/contents/scripts/ratchet-definition-paths.json?ref=${encodeURIComponent(baseRefName)}`,
      ]),

    readReviewThreads: () => {
      const threads: ReviewThreadSnapshot[] = [];
      let cursor: string | null = null;

      for (;;) {
        // Omit the variable entirely on the first page: `after: ""` is not the
        // same as `after: null` to the GraphQL connection.
        const cursorArgs = cursor === null ? [] : ["-F", `cursor=${cursor}`];
        const page = readRecord(
          runGhJson([
            "api",
            "graphql",
            "-f",
            `query=${REVIEW_THREADS_QUERY}`,
            "-f",
            `owner=${owner}`,
            "-f",
            `name=${name}`,
            "-F",
            `number=${pullNumber}`,
            ...cursorArgs,
            "--jq",
            ".data.repository.pullRequest.reviewThreads",
          ]),
          "reviewThreads",
        );

        const nodes = page["nodes"];
        if (!Array.isArray(nodes)) {
          panic("Expected `nodes` array in reviewThreads response");
        }
        for (const node of nodes) {
          const thread = readRecord(node, "review thread");
          threads.push({
            id: readString(thread, "id"),
            isResolved: readBoolean(thread, "isResolved"),
          });
        }

        const pageInfo = readRecord(page["pageInfo"], "pageInfo");
        if (!readBoolean(pageInfo, "hasNextPage")) {
          return threads;
        }
        cursor = readString(pageInfo, "endCursor");
      }
    },

    // Read the pull request's changed files from the API rather than the local
    // checkout, which can be behind the base branch.
    readMigrationDirectories: () => {
      if (migrationDirectory === null) {
        return {
          addedDirectories: [],
          removedDirectories: [],
          modifiedDirectories: [],
          unsupportedChanges: [],
          inventoryChanged: false,
        };
      }
      const changedFiles = readChangedFiles();
      const addedDirectories: string[] = [];
      const removedDirectories: string[] = [];
      const modifiedDirectories: string[] = [];
      const unsupportedChanges: string[] = [];
      let inventoryChanged = false;
      for (const file of changedFiles) {
        const status = readString(file, "status");
        const filename = readString(file, "filename");
        const directory = migrationDirectoryFromFile({
          filename,
          migrationDirectory,
        });
        const previousFilename =
          status === "renamed" || status === "copied"
            ? readString(file, "previous_filename")
            : filename;
        const previousDirectory = migrationDirectoryFromFile({
          filename: previousFilename,
          migrationDirectory,
        });
        if (
          filename === MIGRATION_ALIAS_INVENTORY ||
          (status === "renamed" &&
            previousFilename === MIGRATION_ALIAS_INVENTORY)
        ) {
          inventoryChanged = true;
        }
        if (status === "changed" || status === "copied") {
          if (directory !== null || previousDirectory !== null) {
            unsupportedChanges.push(
              `${status}: ${String(previousDirectory ?? directory)}`,
            );
          }
          continue;
        }
        if (
          status !== "added" &&
          status !== "removed" &&
          status !== "modified" &&
          status !== "renamed"
        ) {
          if (directory !== null) {
            unsupportedChanges.push(`${status}: ${directory}`);
          }
          continue;
        }
        if (
          (status === "added" || status === "renamed") &&
          directory !== null
        ) {
          addedDirectories.push(directory);
        }
        if (
          (status === "removed" || status === "renamed") &&
          previousDirectory !== null
        ) {
          removedDirectories.push(previousDirectory);
        }
        if (status === "modified" && directory !== null) {
          modifiedDirectories.push(directory);
        }
      }
      return {
        addedDirectories,
        removedDirectories,
        modifiedDirectories,
        unsupportedChanges,
        inventoryChanged,
      };
    },

    merge: ({ expectedHeadSha }) => {
      runGh(
        [
          "pr",
          "merge",
          ...prArgs,
          "--squash",
          "--match-head-commit",
          expectedHeadSha,
        ],
        "write",
      );
      // The merge already happened; the commit SHA just may not be attached to
      // the pull request yet. Retry rather than fail on a reporting lag, which
      // would read as a failed merge.
      for (let attempt = 1; attempt <= MERGE_COMMIT_POLL_ATTEMPTS; attempt++) {
        const mergeCommit = readRecord(
          runGhJson(["pr", "view", ...prArgs, "--json", "mergeCommit"]),
          "pr view",
        )["mergeCommit"];
        if (isRecord(mergeCommit)) {
          return readString(mergeCommit, "oid");
        }
        Bun.sleepSync(MERGEABLE_POLL_INTERVAL_MS);
      }
      return panic(
        "Merge succeeded but GitHub did not report a merge commit; " +
          `check ${repo}#${pullNumber} manually.`,
      );
    },

    readArmState: () => {
      const response = readRecord(
        runGhJson([
          "api",
          "graphql",
          "-f",
          `query=query($owner:String!, $name:String!, $number:Int!) {
          repository(owner:$owner,name:$name) { pullRequest(number:$number) {
            id state headRefOid updatedAt autoMergeRequest { enabledAt }
            commits(last:1) { nodes { commit { oid statusCheckRollup { state } } } }
            mergeQueueEntry { id position jump state }
          } }
        }`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-F",
          `number=${pullNumber}`,
        ]),
        "arm state response",
      );
      return readRecord(
        readRecord(response["data"], "data")["repository"],
        "repository",
      )["pullRequest"];
    },

    mutateHandoff: (query, { id, sha }) =>
      JSON.parse(
        runGh(
          [
            "api",
            "graphql",
            "-f",
            `query=${query}`,
            "-f",
            `id=${id}`,
            "-f",
            `sha=${sha}`,
          ],
          "write",
        ),
      ),

    readMergeQueue: (branch) => {
      const response = readRecord(
        runGhJson([
          "api",
          "graphql",
          "-f",
          `query=query($owner:String!, $name:String!, $branch:String!) {
            repository(owner:$owner, name:$name) {
              mergeQueue(branch:$branch) {
                entries(first:100) {
                  totalCount
                  nodes { position jump state pullRequest { number } }
                }
              }
            }
          }`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-f",
          `branch=${branch}`,
        ]),
        "merge queue response",
      );
      const entries = readRecord(
        readRecord(
          readRecord(
            readRecord(response["data"], "data")["repository"],
            "repository",
          )["mergeQueue"],
          "mergeQueue",
        )["entries"],
        "entries",
      );
      const nodes = entries["nodes"];
      if (!Array.isArray(nodes)) {
        return panic("Expected merge queue entry nodes");
      }
      // A partial listing could hide entries ahead of this one.
      if (entries["totalCount"] !== nodes.length) {
        return panic(
          `Merge queue listing is partial (${nodes.length} of ${String(entries["totalCount"])} entries)`,
        );
      }
      return nodes.map((node: unknown) => {
        const record = readRecord(node, "merge queue entry");
        const position = record["position"];
        const entryNumber = readRecord(
          record["pullRequest"],
          "merge queue pull request",
        )["number"];
        if (typeof position !== "number" || typeof entryNumber !== "number") {
          return panic("Expected numeric merge queue position and number");
        }
        return {
          pullNumber: entryNumber,
          position,
          // An omitted jump flag cannot confirm that GitHub recorded it.
          jump:
            record["jump"] === undefined || record["jump"] === null
              ? false
              : readBoolean(record, "jump"),
          state: readString(record, "state"),
        };
      });
    },

    readMergeQueueRemovals: () =>
      parseMergeQueueRemovals(
        runGhJson([
          "api",
          "graphql",
          "-f",
          `query=${MERGE_QUEUE_REMOVALS_QUERY}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-F",
          `number=${pullNumber}`,
          "--jq",
          ".data.repository.pullRequest.timelineItems.nodes",
        ]),
      ),

    // `head_sha` is an exact filter; the branch name records the base the
    // group was built on.
    readMergeGroup: (groupSha) => {
      const response = readRecord(
        runGhJson([
          "api",
          `repos/${repo}/actions/runs?event=merge_group&head_sha=${encodeURIComponent(groupSha)}&per_page=100`,
        ]),
        "merge group runs",
      );
      const rawRuns = response["workflow_runs"];
      if (!Array.isArray(rawRuns)) {
        return panic("Expected `workflow_runs` array from gh");
      }
      const runs = rawRuns.map((run: unknown) =>
        readRecord(run, "merge group run"),
      );
      const run =
        runs.find((candidate) => candidate["conclusion"] === "failure") ??
        runs.at(0);
      if (run === undefined) {
        return { type: "not-found" };
      }
      const branch = readString(run, "head_branch");
      const match = MERGE_GROUP_BRANCH_PATTERN.exec(branch)?.groups;
      const baseSha = match?.["base"];
      if (baseSha === undefined || match?.["number"] !== String(pullNumber)) {
        return panic(
          `Unexpected merge group branch for #${pullNumber}: ${branch}`,
        );
      }
      return {
        type: "found",
        baseSha,
        runUrl: readString(run, "html_url"),
      };
    },

    readBranchTip: (branch) => {
      const tip = readRecord(
        runGhJson([
          "api",
          `repos/${repo}/commits/${encodeURIComponent(branch)}`,
          "--jq",
          "{sha, committedAt: .commit.committer.date}",
        ]),
        "branch tip",
      );
      return {
        sha: readString(tip, "sha"),
        committedAt: readTimestamp(tip, "committedAt"),
      };
    },
  };
};

// --- CLI --------------------------------------------------------------------

type MergeBarCommonOptions = {
  pullNumber: number;
  repo: MergeBarRepository;
  dryRun: boolean;
};

type MergeBarOptions = MergeBarCommonOptions &
  (
    | { mode: "merge"; jump: boolean }
    | { mode: "disarm"; jump: false; expectedHeadSha?: string }
    | { mode: "update-branch"; jump: false; expectedHeadSha: string }
  );

type ReadPullReferenceOptions = {
  reference: string;
  explicitRepo: MergeBarRepository | undefined;
  mode: MergeBarOptions["mode"];
};

const readPullReference = ({
  reference,
  explicitRepo,
  mode,
}: ReadPullReferenceOptions) => {
  let repo = explicitRepo ?? DEFAULT_REPO;
  let rawNumber = reference;
  if (rawNumber.includes("#")) {
    if (mode !== "update-branch") {
      panic(
        "Repository#number references are accepted only with --update-branch",
      );
    }
    const [referenceRepo, referenceNumber, extra] = rawNumber.split("#");
    repo = readMergeBarRepository(referenceRepo ?? panic("Missing repository"));
    if (
      extra !== undefined ||
      (explicitRepo !== undefined && explicitRepo !== repo)
    ) {
      panic(
        "Pull request reference conflicts with --repo or contains multiple separators",
      );
    }
    rawNumber = referenceNumber ?? panic("Missing pull request number");
  }
  if (!PULL_NUMBER_PATTERN.test(rawNumber)) {
    panic(`PR number must be digits only, got: ${rawNumber}`);
  }
  const pullNumber = Number(rawNumber);
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    panic(`PR number must be a positive integer, got: ${rawNumber}`);
  }
  return { pullNumber, repo };
};

export const parseOptions = (argv: readonly string[]): MergeBarOptions => {
  const positional: string[] = [];
  let explicitRepo: MergeBarRepository | undefined;
  let dryRun = false;
  let jump = false;
  let mode: MergeBarOptions["mode"] = "merge";
  let expectedHeadSha: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") {
      index += 1;
      explicitRepo = readMergeBarRepository(
        argv[index] ?? panic("--repo requires a value"),
      );
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--jump") {
      jump = true;
      continue;
    }
    if (argument === "--disarm" || argument === "--update-branch") {
      if (mode !== "merge") {
        panic("Only one of --disarm or --update-branch may be supplied");
      }
      mode = argument === "--disarm" ? "disarm" : "update-branch";
      continue;
    }
    if (argument === "--expected-head-sha") {
      index += 1;
      expectedHeadSha =
        argv[index] ?? panic("--expected-head-sha requires a value");
      if (!/^[a-f0-9]{40}$/u.test(expectedHeadSha)) {
        panic("--expected-head-sha requires a full lowercase commit SHA");
      }
      continue;
    }
    if (argument === undefined || argument.startsWith("--")) {
      panic(`Unknown argument: ${argument ?? "<empty>"}`);
    }
    positional.push(argument);
  }
  if (positional.length !== 1) {
    panic(
      `Expected exactly one PR number, got ${positional.length}. Usage: bun scripts/merge-bar.ts <pr-number> [--repo owner/name] [--dry-run] [--jump | --disarm | --update-branch --expected-head-sha <sha>]`,
    );
  }
  const { pullNumber, repo } = readPullReference({
    reference: positional[0] ?? panic("unreachable: length checked above"),
    explicitRepo,
    mode,
  });
  if (mode !== "merge" && jump) {
    panic(`--${mode} cannot be combined with --jump`);
  }
  if (mode === "merge" && expectedHeadSha !== undefined) {
    panic("--expected-head-sha requires --update-branch or --disarm");
  }
  switch (mode) {
    case "update-branch":
      if (expectedHeadSha === undefined) {
        panic("--update-branch requires --expected-head-sha");
      }
      return { mode, pullNumber, repo, dryRun, jump: false, expectedHeadSha };
    case "disarm":
      if (expectedHeadSha === undefined) {
        return { mode, pullNumber, repo, dryRun, jump: false };
      }
      return { mode, pullNumber, repo, dryRun, jump: false, expectedHeadSha };
    case "merge":
      return { mode, pullNumber, repo, dryRun, jump };
    default:
      mode satisfies never;
      return panic("Unknown merge-bar mode");
  }
};
const formatVerdict = (verdict: MergeBarVerdict): string =>
  verdict.gates
    .map((gate) =>
      gate.status === "pass"
        ? `  PASS ${gate.gate}: ${gate.detail}`
        : `  FAIL ${gate.gate}: ${gate.reason} — ${gate.detail}`,
    )
    .join("\n");

// Mergeability is computed asynchronously on GitHub's side, so UNKNOWN on the
// first read means "not yet", not "no". Poll briefly, then let the gate refuse.
// Blocking is correct here: the whole tool is one strictly ordered read
// sequence, and it has nothing else to do while GitHub finishes.
const readSettledPullRequest = (
  gateway: GitHubGateway,
): PullRequestSnapshot => {
  let pullRequest = gateway.readPullRequest();
  for (
    let attempt = 1;
    attempt < MERGEABLE_POLL_ATTEMPTS &&
    pullRequest.mergeable === "UNKNOWN" &&
    pullRequest.handoff.status !== "queued";
    attempt += 1
  ) {
    Bun.sleepSync(MERGEABLE_POLL_INTERVAL_MS);
    pullRequest = gateway.readPullRequest();
  }
  return pullRequest;
};

type RatchetFreshnessForOptions = {
  repo: MergeBarRepository;
  readDefinitionPaths: (baseRefName: string) => unknown;
  recheck: Extract<RatchetFreshness, { type: "base-definitions" }>["recheck"];
};

/** The ratchet-freshness check `MERGE_BAR_REPOSITORIES` declares for `repo`. */
export const ratchetFreshnessFor = ({
  repo,
  readDefinitionPaths,
  recheck,
}: RatchetFreshnessForOptions): RatchetFreshness => {
  const capability = MERGE_BAR_REPOSITORIES[repo].ratchetFreshness;
  switch (capability) {
    case "none":
      return { type: "none" };
    case "base-definitions":
      return { type: "base-definitions", readDefinitionPaths, recheck };
    default:
      capability satisfies never;
      return panic(
        `Unknown ratchet freshness capability: ${String(capability)}`,
      );
  }
};

if (import.meta.main) {
  const options = parseOptions(Bun.argv.slice(2));
  // Before any read: a stale checkout runs a bar main has since fixed. The
  // CLI tests drive this script offline with a fake gh; only a local test
  // run can skip the check.
  const repositoryRoot = path.dirname(import.meta.dir);
  const barFreshness =
    process.env["STELLA_MERGE_BAR_TEST_SKIP_FRESHNESS"] === "1" &&
    readRuntimeMode().isLocalTestRun
      ? ({ type: "current" } as const)
      : decideBarFreshness(
          readBarFreshness({
            repositoryRoot,
            entry: path.relative(repositoryRoot, import.meta.filename),
          }),
        );
  if (barFreshness.type === "refuse") {
    console.error(barFreshness.message);
    process.exit(1);
  }
  if (barFreshness.type === "branch-bar") {
    console.log(barFreshness.message);
  }
  if (options.mode === "update-branch") {
    let lastCall = 0;
    const paced = (
      args: readonly string[],
      access: "read" | "write" = "read",
    ) => {
      const wait = 1100 - (Date.now() - lastCall);
      if (wait > 0) {
        Bun.sleepSync(wait);
      }
      lastCall = Date.now();
      // The existing transport resolves gh from PATH and never retries writes.
      return runGhProcess(args, access);
    };
    const stateRoot =
      process.env["STELLA_MERGE_BAR_STATE_DIR"] ??
      path.join(
        process.env["XDG_STATE_HOME"] ??
          path.join(homedir(), ".local", "state"),
        "stella",
        "merge-bar",
        "branch-updates",
      );
    const receipt = updatePullRequestBranch({
      repo: options.repo,
      pullNumber: options.pullNumber,
      expectedHeadSha: options.expectedHeadSha,
      dryRun: options.dryRun,
      store: createBranchUpdateStore(stateRoot),
      readPullRequest: () => {
        const response = paced([
          "api",
          `repos/${options.repo}/pulls/${options.pullNumber}`,
        ]);
        if (response.exitCode !== 0) {
          panic(`Cannot read pull request (gh exit ${response.exitCode})`);
        }
        const raw = readRecord(
          JSON.parse(response.stdout.toString()),
          "pull request",
        );
        const head = readRecord(raw["head"], "head");
        const base = readRecord(raw["base"], "base");
        return {
          state: readString(raw, "state"),
          headSha: readString(head, "sha"),
          headRepository:
            head["repo"] === null
              ? null
              : readString(
                  readRecord(head["repo"], "head repository"),
                  "full_name",
                ),
          baseRepository: readString(
            readRecord(base["repo"], "base repository"),
            "full_name",
          ),
        };
      },
      update: (expectedHeadSha) => {
        const response = paced(
          [
            "api",
            "--include",
            "--method",
            "PUT",
            `repos/${options.repo}/pulls/${options.pullNumber}/update-branch`,
            "-f",
            `expected_head_sha=${expectedHeadSha}`,
          ],
          "write",
        );
        return branchUpdateResponse({
          stdout: response.stdout.toString(),
          stderr: response.stderr.toString(),
          exitCode: response.exitCode,
        });
      },
    });
    if (receipt.isErr()) {
      console.error(receipt.error.message);
      process.exit(1);
    }
    console.log(
      `${options.repo}#${options.pullNumber}: ${JSON.stringify(receipt.value)}`,
    );
    process.exit(0);
  }
  const gateway = createGhGateway({
    repo: options.repo,
    pullNumber: options.pullNumber,
    migrationDirectory: MERGE_BAR_REPOSITORIES[options.repo].migrationDirectory,
  });

  if (options.mode === "disarm") {
    const receipt = disarmPullRequest({
      gateway,
      dryRun: options.dryRun,
      ...(options.expectedHeadSha === undefined
        ? {}
        : { expectedHeadSha: options.expectedHeadSha }),
    });
    if (receipt.isErr()) {
      console.error(receipt.error.message);
      process.exit(receipt.error instanceof DisarmChangedError ? 2 : 1);
    }
    console.log(
      `${receipt.value.status === "dry-run" ? "DRY RUN: would disarm" : "DISARMED"} ${options.repo}#${options.pullNumber}: ${JSON.stringify(receipt.value)}`,
    );
    process.exit(0);
  }

  // Version Packages uses this CLI as release-pr.yml's auto-merge-command too.
  const hold = checkMergeHold({
    readVariable: () => readRepositoryMergeHold(options.repo),
    readIsRelease: () =>
      readReleaseRecognition(options.repo, options.pullNumber),
    checkedByWorkflow: process.env["STELLA_MERGE_HOLD_CHECKED_BY_WORKFLOW"],
    githubActions: process.env["GITHUB_ACTIONS"],
  });
  if (hold.isErr()) {
    console.error(hold.error.message);
    process.exit(1);
  }

  if (hold.value.source === "workflow") {
    console.log(
      "merge hold: checked by the calling workflow; final CI verdict enforces it",
    );
  }

  const pullRequest = readSettledPullRequest(gateway);
  const policy = readLiveRepositoryPolicy(
    options.repo,
    pullRequest.baseRefName,
  );
  const jump = options.jump;
  const requireFrontOfQueue = (
    context: string,
    enqueuedEntry?: EnqueuedMergeQueueEntry,
  ): void => {
    const verdict = verifyFrontOfQueue({
      gateway,
      pullNumber: pullRequest.number,
      repo: options.repo,
      branch: pullRequest.baseRefName,
      context,
      release: isReleasePullRequest(pullRequest),
      ...(enqueuedEntry === undefined ? {} : { enqueuedEntry }),
    });
    if (verdict.exitCode === 0) {
      console.log(verdict.message);
      return;
    }
    console.error(verdict.message);
    process.exit(verdict.exitCode);
  };
  if (
    policy.landing === "merge-when-ready" &&
    pullRequest.handoff.status === "queued"
  ) {
    if (jump) {
      requireFrontOfQueue(
        `${options.repo}#${options.pullNumber} is already in the merge queue`,
      );
      process.exit(0);
    }
    console.log(
      `verdict: QUEUED — ${options.repo}#${options.pullNumber} is already in the merge queue; nothing changed.`,
    );
    process.exit(0);
  }
  if (policy.landing === "merge-when-ready") {
    const ejectedHead = checkEjectedHead({ gateway, pullRequest });
    if (ejectedHead.isErr()) {
      console.error(ejectedHead.error.message);
      process.exit(1);
    }
    if (ejectedHead.value !== null) {
      console.log(ejectedHead.value);
    }
  }
  // Read order is load-bearing: each gate's window is the time between its
  // own read and the write, so the head SHA the write pins is read last.
  const checkRuns = pullRequestCheckRuns({
    checkRuns: gateway.readCheckRuns(pullRequest.headSha),
    workflowRuns: gateway.readHeadWorkflowRuns(pullRequest.headSha),
  });
  const freshness = checkGreenResultFreshness({
    pullRequest,
    jump: options.jump,
    checkRuns,
    readWorkflowRun: gateway.readWorkflowRun,
    readBaseComparison: gateway.readBaseComparison,
    readPullFiles: gateway.readPullFiles,
    readBaseWorkflow: () => gateway.readBaseWorkflow(pullRequest.baseRefName),
    // The selector's detector scripts run from this checkout.
    runSelector: (input) =>
      runPlanScopes({
        ...input,
        cwd: fileURLToPath(new URL("..", import.meta.url)),
      }),
    readRunJobs: gateway.readRunJobs,
    readRunCoverage: gateway.readRunCoverage,
    mergeGroupRetests: policy.landing === "merge-when-ready",
    ratchet: ratchetFreshnessFor({
      repo: options.repo,
      readDefinitionPaths: gateway.readRatchetDefinitionPaths,
      recheck: ({ headSha, baseRefName }) =>
        recheckRatchetOnBase({
          repositoryRoot: fileURLToPath(new URL("..", import.meta.url)),
          repo: options.repo,
          baseSha: gateway.readBranchTip(baseRefName).sha,
          headSha,
        }),
    }),
  });
  if (freshness.isErr()) {
    console.error(freshness.error.message);
    process.exit(1);
  }
  const snapshot: MergeBarSnapshot = {
    pullRequest,
    landing: policy.landing,
    requiredCheckRuns: policy.requiredCheckRuns,
    checkRunsHeadSha: pullRequest.headSha,
    checkRuns,
    migrations: gateway.readMigrationDirectories(),
    reviewThreads: gateway.readReviewThreads(),
    headShaBeforeMerge: gateway.readHeadSha(),
  };

  const verdict = evaluateMergeBar(snapshot);
  console.log(`merge bar: ${options.repo}#${options.pullNumber}`);
  console.log(formatVerdict(verdict));

  if (verdict.decision === "abort") {
    console.log("\nverdict: ABORT — not merging.");
    process.exit(1);
  }

  // Chosen before the dry-run return, so a dry run reports the same non-write
  // failure a real run would.
  const mergeWhenReady =
    policy.landing === "merge-when-ready"
      ? mergeWhenReadyAction({
          handoff: pullRequest.handoff,
          jump,
          checksSucceeded: requiredChecksSucceeded({
            checkRuns: snapshot.checkRuns,
            requiredCheckRuns: snapshot.requiredCheckRuns,
          }),
        })
      : null;
  if (mergeWhenReady?.kind === "jump-waits-for-checks") {
    const armed =
      mergeWhenReady.armedSince === null
        ? "Nothing was armed."
        : `Auto-merge has been on since ${mergeWhenReady.armedSince} and will ` +
          "enqueue it at the BACK when they pass; disable it to keep the jump.";
    console.error(
      "\nverdict: NOT JUMPED — required checks are still running, and " +
        `the queue accepts a jump only once they pass. ${armed} ` +
        "Run the bar again once the checks pass.",
    );
    process.exit(1);
  }

  if (options.dryRun) {
    console.log("\nverdict: MERGE (dry run, nothing written).");
    process.exit(0);
  }

  switch (policy.landing) {
    case "merge": {
      const mergeSha = gateway.merge({
        expectedHeadSha: snapshot.headShaBeforeMerge,
      });
      console.log(`\nverdict: MERGE — squashed as ${mergeSha}`);
      break;
    }
    case "merge-when-ready": {
      const action =
        mergeWhenReady ??
        panic("unreachable: chosen for merge-when-ready above");
      switch (action.kind) {
        case "already-queued":
          if (action.verifyFront) {
            requireFrontOfQueue(`${action.entryId} is already queued`);
            break;
          }
          console.log(`\nverdict: QUEUED — ${action.entryId}`);
          break;
        case "enqueue-jump":
        case "arm": {
          const handoff = armAndVerify({
            pullRequestId: pullRequest.id,
            expectedHeadSha: snapshot.headShaBeforeMerge,
            jump: action.kind === "enqueue-jump",
            checksSucceeded: requiredChecksSucceeded({
              checkRuns: snapshot.checkRuns,
              requiredCheckRuns: snapshot.requiredCheckRuns,
            }),
            readState: gateway.readArmState,
            readRemovals: gateway.readMergeQueueRemovals,
            mutate: gateway.mutateHandoff,
          });
          if (handoff.isErr()) {
            console.error(handoff.error.message);
            process.exit(1);
          }
          const handoffResult = handoff.value;
          switch (handoffResult.kind) {
            case "already-queued":
              // Queued before this run (an earlier arm's auto-merge): the
              // entry is not an enqueue response, so a jump verifies the
              // queue itself.
              if (action.kind === "enqueue-jump") {
                requireFrontOfQueue(
                  `${snapshot.headShaBeforeMerge} was already queued (position ${handoffResult.entry.position}); no jump was requested`,
                );
                break;
              }
              console.log(
                `\nverdict: ALREADY QUEUED at ${snapshot.headShaBeforeMerge} (position ${handoffResult.entry.position}, ${handoffResult.entry.state}); nothing changed.`,
              );
              break;
            case "queued":
              if (action.kind === "enqueue-jump") {
                requireFrontOfQueue(
                  `${snapshot.headShaBeforeMerge} was enqueued after requesting a jump (GitHub reported position ${handoffResult.entry.position})`,
                  handoffResult.entry,
                );
                break;
              }
              console.log(
                `\nverdict: QUEUED — verified entry for ${snapshot.headShaBeforeMerge}`,
              );
              break;
            case "armed":
              if (action.kind === "enqueue-jump") {
                panic("Jump must return a queue receipt");
              }
              console.log(
                `\nverdict: ARMED — verified auto-merge for ${snapshot.headShaBeforeMerge}, enabled at ${handoffResult.enabledAt}`,
              );
              break;
            default:
              handoffResult satisfies never;
              panic("Unhandled arm result");
          }
          break;
        }
        default:
          action satisfies never;
          panic("Unhandled merge-when-ready action");
      }
      break;
    }
    default:
      policy.landing satisfies never;
      panic(`Unhandled landing: ${String(policy.landing)}`);
  }
}
