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
//
// A non-empty STELLA_MERGE_HOLD repository variable holds ordinary pull requests;
// recognized release pull requests remain exempt, including --jump.
// Set: gh variable set STELLA_MERGE_HOLD --repo stella/stella --body "<reason>"
// Lift: gh variable delete STELLA_MERGE_HOLD --repo stella/stella

import { panic, Result, TaggedError } from "better-result";
import { fileURLToPath } from "node:url";

import { findMigrationIdentityViolation } from "./check-migration-order";

const DEFAULT_REPO = "stella/stella";
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

const repositoryMigrationDirectory = (repo: string): string | null =>
  repo.toLowerCase() === "stella/stella" ? "apps/api/drizzle" : null;

/**
 * Derive the landing contract from GitHub's active rules for the target
 * branch. Required checks and merge-queue state change independently of this
 * repository, so a local mirror silently drifts and eventually blocks a valid
 * merge or admits one under the wrong policy.
 */
export const mergeBarRepositoryPolicy = (
  repo: string,
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
    migrationDirectory: repositoryMigrationDirectory(repo),
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
}: {
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
  const cla = latestByName.get("cla");
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

// Limit unrelated drift too: beyond twenty commits, path overlap alone is
// too weak a signal for whether an old green run still represents integration.
const MAX_GREEN_BASE_DRIFT = 20;
const COMPARE_FILE_LIMIT = 300;

class StaleGreenResultError extends TaggedError("StaleGreenResultError")<{
  message: string;
}> {}

type CheckGreenResultFreshnessOptions = {
  pullRequest: PullRequestSnapshot;
  jump: boolean;
  checkRuns: readonly CheckRunSnapshot[];
  readWorkflowRun: (checkRunId: number) => unknown;
  readBaseComparison: (testedBaseSha: string, baseRefName: string) => unknown;
  readPullFiles: () => readonly string[];
};

export const checkGreenResultFreshness = ({
  pullRequest,
  jump,
  checkRuns,
  readWorkflowRun,
  readBaseComparison,
  readPullFiles,
}: CheckGreenResultFreshnessOptions) => {
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
  if (commits > MAX_GREEN_BASE_DRIFT) {
    return refuse(
      `main advanced ${commits} commits since the green run (limit ${MAX_GREEN_BASE_DRIFT})`,
    );
  }
  const files = comparison["files"];
  if (!Array.isArray(files) || files.length >= COMPARE_FILE_LIMIT) {
    return refuse("cannot establish complete changed-file coverage for main");
  }
  const changedPaths = new Set<string>();
  for (const rawFile of files) {
    const file = readRecord(rawFile, "base changed file");
    changedPaths.add(readString(file, "filename"));
    if (typeof file["previous_filename"] === "string") {
      changedPaths.add(file["previous_filename"]);
    }
  }
  const overlap = readPullFiles().filter((filename) =>
    changedPaths.has(filename),
  );
  if (overlap.length > 0) {
    return refuse(
      `main changed files also touched by this PR: ${overlap.join(", ")}`,
    );
  }
  return Result.ok();
};

// --- gh seam ----------------------------------------------------------------

type GitHubGateway = {
  readPullRequest: () => PullRequestSnapshot;
  // Deliberately separate from `readPullRequest`: the pre-write re-read only
  // needs the SHA, and a narrow read makes the TOCTOU window smaller.
  readHeadSha: () => string;
  readCheckRuns: (headSha: string) => readonly CheckRunSnapshot[];
  readWorkflowRun: (checkRunId: number) => unknown;
  readBaseComparison: (testedBaseSha: string, baseRefName: string) => unknown;
  readPullFiles: () => readonly string[];
  readReviewThreads: () => readonly ReviewThreadSnapshot[];
  readMigrationDirectories: () => MigrationSnapshot;
  // Both writes pin the head every gate was evaluated against, so GitHub
  // rejects them server-side if it moved since: the head-stability assertion
  // is enforced by the write itself, not by the gap between the last read and
  // it. `merge` returns the squash commit; `armMergeWhenReady` returns what
  // GitHub did: enabled auto-merge, or added the pull request to the queue.
  merge: (input: { expectedHeadSha: string }) => string;
  armMergeWhenReady: (input: { expectedHeadSha: string }) => string;
  // Preserve the mutation's jump receipt while the fresh queue listing
  // catches up. Only `readMergeQueue` can confirm first place.
  enqueueWithJump: (input: {
    pullRequestId: string;
    expectedHeadSha: string;
  }) => EnqueuedMergeQueueEntry;
  readMergeQueue: (branch: string) => readonly MergeQueueEntrySnapshot[];
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
  | { kind: "already-armed"; enabledAt: string }
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
  if (handoff.status === "armed") {
    return { kind: "already-armed", enabledAt: handoff.enabledAt };
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
        `pw sub pr ${repo}#${pullNumber} --on merged,closed,checks-failed`,
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
  Bun.spawnSync(["gh", ...args], {
    env: githubEnvironment(access),
    stdout: "pipe",
    stderr: "pipe",
  });

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

const readLiveRepositoryPolicy = (
  repo: string,
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
        '.check_runs[] | [.id, .name, .status, (.conclusion // ""), (.output.title // "")] | @tsv',
      ])
        .split("\n")
        .filter(Boolean);

      const runs: CheckRunSnapshot[] = [];
      for (const line of lines) {
        const [rawId, runName, status, conclusion, outputTitle] =
          line.split("\t");
        const id = Number(rawId);
        if (
          !Number.isSafeInteger(id) ||
          runName === undefined ||
          status === undefined
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
        });
      }
      return runs;
    },

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

    // `gh` picks the operation the queue accepts for the pull request's
    // current state: auto-merge while required checks are still running,
    // a direct enqueue once they have passed (GitHub refuses auto-merge on
    // an already-clean pull request). Both carry the head pin.
    armMergeWhenReady: ({ expectedHeadSha }) =>
      runGh(
        [
          "pr",
          "merge",
          ...prArgs,
          "--squash",
          "--auto",
          "--match-head-commit",
          expectedHeadSha,
        ],
        "write",
      ).trim(),

    enqueueWithJump: ({ pullRequestId, expectedHeadSha }) => {
      const response = readRecord(
        JSON.parse(
          runGh(
            [
              "api",
              "graphql",
              "-f",
              `query=mutation($id:ID!, $sha:GitObjectID!) {
                enqueuePullRequest(input:{
                  pullRequestId:$id, expectedHeadOid:$sha, jump:true
                }) { mergeQueueEntry { id position jump state } }
              }`,
              "-f",
              `id=${pullRequestId}`,
              "-f",
              `sha=${expectedHeadSha}`,
            ],
            "write",
          ),
        ),
        "enqueue response",
      );
      const entry = readRecord(
        readRecord(
          readRecord(response["data"], "data")["enqueuePullRequest"],
          "enqueuePullRequest",
        )["mergeQueueEntry"],
        "mergeQueueEntry",
      );
      const position = entry["position"];
      if (typeof position !== "number") {
        return panic("Expected numeric merge queue position");
      }
      return {
        position,
        jump:
          entry["jump"] === undefined || entry["jump"] === null
            ? false
            : readBoolean(entry, "jump"),
        state: readString(entry, "state"),
      };
    },

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
  };
};

// --- CLI --------------------------------------------------------------------

type MergeBarOptions = {
  pullNumber: number;
  repo: string;
  dryRun: boolean;
  // Enqueue at the front of the queue only when explicitly requested.
  jump: boolean;
};

const parseOptions = (argv: readonly string[]): MergeBarOptions => {
  const positional: string[] = [];
  let repo = DEFAULT_REPO;
  let dryRun = false;
  let jump = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") {
      index += 1;
      repo = argv[index] ?? panic("--repo requires a value");
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
    if (argument === undefined || argument.startsWith("--")) {
      panic(`Unknown argument: ${argument ?? "<empty>"}`);
    }
    positional.push(argument);
  }

  // Exactly one, all digits. `Number.parseInt("2137oops", 10)` is 2137, so a
  // mistyped suffix would silently merge a different real pull request; extra
  // positionals would silently pick the first.
  if (positional.length !== 1) {
    panic(
      `Expected exactly one PR number, got ${positional.length}. ` +
        "Usage: bun scripts/merge-bar.ts <pr-number> [--repo owner/name] " +
        "[--dry-run] [--jump]",
    );
  }
  const rawNumber = positional[0] ?? panic("unreachable: length checked above");
  if (!PULL_NUMBER_PATTERN.test(rawNumber)) {
    panic(`PR number must be digits only, got: ${rawNumber}`);
  }
  const pullNumber = Number(rawNumber);
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    panic(`PR number must be a positive integer, got: ${rawNumber}`);
  }

  return { pullNumber, repo, dryRun, jump };
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

if (import.meta.main) {
  const options = parseOptions(Bun.argv.slice(2));
  const gateway = createGhGateway({
    repo: options.repo,
    pullNumber: options.pullNumber,
    migrationDirectory: repositoryMigrationDirectory(options.repo),
  });

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
  // Read order is load-bearing: each gate's window is the time between its
  // own read and the write, so the head SHA the write pins is read last.
  const checkRuns = gateway.readCheckRuns(pullRequest.headSha);
  const freshness = checkGreenResultFreshness({
    pullRequest,
    jump: options.jump,
    checkRuns,
    readWorkflowRun: gateway.readWorkflowRun,
    readBaseComparison: gateway.readBaseComparison,
    readPullFiles: gateway.readPullFiles,
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
        case "already-armed":
          console.log(
            `\nverdict: ARMED — merge when ready has been on since ${action.enabledAt}`,
          );
          break;
        case "enqueue-jump": {
          const reported = gateway.enqueueWithJump({
            pullRequestId: pullRequest.id,
            expectedHeadSha: snapshot.headShaBeforeMerge,
          });
          requireFrontOfQueue(
            `${snapshot.headShaBeforeMerge} was enqueued after requesting a jump ` +
              `(GitHub reported position ${reported.position})`,
            reported,
          );
          break;
        }
        case "arm": {
          const outcome = gateway.armMergeWhenReady({
            expectedHeadSha: snapshot.headShaBeforeMerge,
          });
          console.log(
            `\nverdict: ARMED — ${outcome}; the queue merges ${snapshot.headShaBeforeMerge} once its checks pass`,
          );
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
