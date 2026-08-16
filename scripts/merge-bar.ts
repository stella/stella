#!/usr/bin/env bun
//
// Merge bar: the sanctioned way to merge a pull request.
//
// `gh pr merge` is a single write with no state assertions, so the operator
// supplies the safety argument from whatever they happened to read earlier.
// This tool re-reads every input inside one invocation and asserts each gate
// POSITIVELY before it writes. Three failure classes motivate it:
//
// (a) Negative-check misreads. "No failing checks" is not "checks passed".
//     A CONFLICTING pull request produces ZERO check runs, a draft produces
//     ZERO check runs, and a rollup filtered for failures over an empty list
//     is empty — all three read as green to a negative predicate. Every gate
//     here therefore demands a positive observation: the `ci-result` check run
//     must EXIST on the exact current head SHA with conclusion `success`, and
//     an empty check-run list fails rather than passes.
//
// (b) Time-of-check to time-of-use. Review threads, reviews, and pushes land
//     between a state read and the merge call. Gate inputs read minutes ago
//     describe a pull request that no longer exists. Everything below is
//     fetched in THIS invocation, and the head SHA is re-read immediately
//     before the merge so a push mid-flight aborts instead of merging code
//     nothing verified. The same staleness applies across pull requests:
//     migration ordering is re-checked against the live default branch,
//     because a branch's own CI run cannot see a migration that landed on the
//     default branch after that run finished.
//
// (c) Merge-body file clobbering. `gh pr merge --body-file path` reads the
//     file at merge time, so a concurrent writer to that path silently
//     rewrites the commit message. The body is read and inlined here at
//     startup; the merge call never receives a path.
//
// What this tool deliberately does NOT gate: review depth. Automated review
// requests are budgeted at two per pull request, because a third round buys
// re-litigation of the same diff rather than new findings. Spend both, address
// what they surface, resolve the threads, and let the gates below decide. A
// green bar is the merge argument; another review request is not.
//
// Usage:
//   bun scripts/merge-bar.ts <pr-number> [--repo owner/name] [--body-file path]
//                                        [--admin] [--dry-run]
//
// Without --body-file the pull request body read in this invocation becomes
// the squash body, so the commit message never degrades into a commit list.

import { panic } from "better-result";
import { readFileSync } from "node:fs";

import { findMigrationOrderViolation } from "./check-migration-order";

const DEFAULT_REPO = "stella/stella";
const REQUIRED_CHECK_RUN = "ci-result";
const MIGRATION_DIRECTORY = "apps/api/drizzle";
const MERGEABLE_POLL_ATTEMPTS = 8;
const MERGEABLE_POLL_INTERVAL_MS = 2000;

// --- Gate model -------------------------------------------------------------

const GATE_IDS = [
  "pull-request-state",
  "mergeable",
  "required-check",
  "review-threads",
  "migration-order",
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
  unresolvedReviewThreads: "UNRESOLVED_REVIEW_THREADS",
  migrationOrder: "MIGRATION_ORDER_VIOLATION",
  headMoved: "HEAD_MOVED_DURING_CHECKS",
} as const;
type MergeBarReason =
  (typeof MERGE_BAR_REASONS)[keyof typeof MERGE_BAR_REASONS];

const PULL_REQUEST_STATES = ["OPEN", "CLOSED", "MERGED"] as const;
const MERGEABLE_STATES = ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const;

type PullRequestSnapshot = {
  number: number;
  title: string;
  body: string;
  state: (typeof PULL_REQUEST_STATES)[number];
  isDraft: boolean;
  mergeable: (typeof MERGEABLE_STATES)[number];
  headSha: string;
};

type CheckRunSnapshot = {
  name: string;
  status: string;
  conclusion: string | null;
};

type ReviewThreadSnapshot = { id: string; isResolved: boolean };

type MigrationSnapshot = {
  // Migration directories present on the default branch right now.
  baseDirectories: readonly string[];
  // Migration directories this pull request adds.
  addedDirectories: readonly string[];
};

export type MergeBarSnapshot = {
  pullRequest: PullRequestSnapshot;
  // The SHA the check runs were actually fetched for. Kept separate from
  // `pullRequest.headSha` so a read against a stale commit cannot masquerade
  // as a read against the current one.
  checkRunsHeadSha: string;
  checkRuns: readonly CheckRunSnapshot[];
  reviewThreads: readonly ReviewThreadSnapshot[];
  migrations: MigrationSnapshot;
  // Re-read immediately before the merge call.
  headShaBeforeMerge: string;
};

type GateVerdict =
  | { gate: GateId; status: "pass"; detail: string }
  | { gate: GateId; status: "fail"; reason: MergeBarReason; detail: string };

export type MergeBarVerdict = {
  decision: "merge" | "abort";
  gates: readonly GateVerdict[];
};

// --- Gates (pure) -----------------------------------------------------------

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

const evaluateRequiredCheck = ({
  checkRuns,
  checkRunsHeadSha,
  headSha,
}: {
  checkRuns: readonly CheckRunSnapshot[];
  checkRunsHeadSha: string;
  headSha: string;
}): GateVerdict => {
  if (checkRunsHeadSha !== headSha) {
    return {
      gate: "required-check",
      status: "fail",
      reason: MERGE_BAR_REASONS.checkRunsStale,
      detail: `check runs read for ${checkRunsHeadSha}, head is ${headSha}`,
    };
  }

  const required = checkRuns.filter((run) => run.name === REQUIRED_CHECK_RUN);
  // The load-bearing case: an empty list is an ABSENT verdict, not a passing
  // one. Filtering a rollup for failures would report "none" here and merge.
  if (required.length === 0) {
    return {
      gate: "required-check",
      status: "fail",
      reason: MERGE_BAR_REASONS.requiredCheckMissing,
      detail:
        `no \`${REQUIRED_CHECK_RUN}\` check run on ${headSha} ` +
        `(${checkRuns.length} check run(s) present)`,
    };
  }

  const incomplete = required.filter((run) => run.status !== "completed");
  if (incomplete.length > 0) {
    return {
      gate: "required-check",
      status: "fail",
      reason: MERGE_BAR_REASONS.requiredCheckIncomplete,
      detail: `\`${REQUIRED_CHECK_RUN}\` is ${incomplete.at(0)?.status ?? "pending"}`,
    };
  }

  const unsuccessful = required.filter((run) => run.conclusion !== "success");
  if (unsuccessful.length > 0) {
    return {
      gate: "required-check",
      status: "fail",
      reason: MERGE_BAR_REASONS.requiredCheckNotSuccessful,
      detail: `\`${REQUIRED_CHECK_RUN}\` concluded ${unsuccessful.at(0)?.conclusion ?? "null"}`,
    };
  }

  return {
    gate: "required-check",
    status: "pass",
    detail: `\`${REQUIRED_CHECK_RUN}\` success on ${headSha}`,
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

const evaluateMigrationOrder = (migrations: MigrationSnapshot): GateVerdict => {
  const violation = findMigrationOrderViolation({
    baseDirectories: migrations.baseDirectories,
    newDirectories: migrations.addedDirectories,
  });
  if (violation?.type === "invalid-name") {
    return {
      gate: "migration-order",
      status: "fail",
      reason: MERGE_BAR_REASONS.migrationOrder,
      detail: `${violation.directory} does not start with a 14-digit timestamp`,
    };
  }
  if (violation?.type === "not-after-base") {
    return {
      gate: "migration-order",
      status: "fail",
      reason: MERGE_BAR_REASONS.migrationOrder,
      detail:
        `${violation.directory} (${violation.timestamp}) is not above ` +
        `${violation.previousTimestamp}; rename it to a timestamp above ` +
        `${violation.previousTimestamp} so already-migrated databases apply it`,
    };
  }
  return {
    gate: "migration-order",
    status: "pass",
    detail: `${migrations.addedDirectories.length} added migration(s) ordered above the default branch`,
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
    }),
    evaluateReviewThreads(snapshot.reviewThreads),
    evaluateMigrationOrder(snapshot.migrations),
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

// --- gh seam ----------------------------------------------------------------

type GitHubGateway = {
  readPullRequest: () => PullRequestSnapshot;
  // Deliberately separate from `readPullRequest`: the pre-merge re-read only
  // needs the SHA, and a narrow read makes the TOCTOU window smaller.
  readHeadSha: () => string;
  readCheckRuns: (headSha: string) => readonly CheckRunSnapshot[];
  readReviewThreads: () => readonly ReviewThreadSnapshot[];
  readMigrationDirectories: () => MigrationSnapshot;
  merge: (input: { subject: string; body: string; admin: boolean }) => string;
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

const runGh = (args: readonly string[]): string => {
  const result = Bun.spawnSync(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(
      `gh ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};

const runGhJson = (args: readonly string[]): unknown => JSON.parse(runGh(args));

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

const createGhGateway = ({
  repo,
  pullNumber,
}: {
  repo: string;
  pullNumber: number;
}): GitHubGateway => {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined || name === "") {
    panic(`--repo must be owner/name, got: ${repo}`);
  }
  const prArgs = [String(pullNumber), "--repo", repo];

  return {
    readHeadSha: () =>
      readString(
        readRecord(
          runGhJson(["pr", "view", ...prArgs, "--json", "headRefOid"]),
          "pr view",
        ),
        "headRefOid",
      ),

    readPullRequest: () => {
      const raw = readRecord(
        runGhJson([
          "pr",
          "view",
          ...prArgs,
          "--json",
          "number,title,body,state,isDraft,mergeable,headRefOid",
        ]),
        "pr view",
      );
      const number = raw["number"];
      if (typeof number !== "number") {
        panic("Expected numeric field `number` in gh response");
      }
      return {
        number,
        title: readString(raw, "title"),
        body: readString(raw, "body"),
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
        '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv',
      ])
        .split("\n")
        .filter(Boolean);

      const runs: CheckRunSnapshot[] = [];
      for (const line of lines) {
        const [runName, status, conclusion] = line.split("\t");
        if (runName === undefined || status === undefined) {
          panic(`Malformed check-run row from gh: ${line}`);
        }
        runs.push({
          name: runName,
          status,
          conclusion:
            conclusion === undefined || conclusion === "" ? null : conclusion,
        });
      }
      return runs;
    },

    readReviewThreads: () => {
      const threads: ReviewThreadSnapshot[] = [];
      let cursor: string | null = null;

      for (;;) {
        const cursorArgs =
          cursor === null ? ["-F", "cursor="] : ["-F", `cursor=${cursor}`];
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

    // Read both sides from the API rather than the local checkout: the local
    // clone can be behind the default branch, which is the very staleness this
    // gate exists to catch.
    readMigrationDirectories: () => {
      const defaultBranch = readString(
        readRecord(
          runGhJson([
            "api",
            `repos/${repo}`,
            "--jq",
            "{name: .default_branch}",
          ]),
          "repo",
        ),
        "name",
      );
      const baseDirectories = runGh([
        "api",
        `repos/${repo}/contents/${MIGRATION_DIRECTORY}?ref=${defaultBranch}`,
        "--jq",
        '.[] | select(.type == "dir") | .name',
      ])
        .split("\n")
        .filter(Boolean);

      const addedDirectories = runGh([
        "api",
        "--paginate",
        `repos/${repo}/pulls/${pullNumber}/files`,
        "--jq",
        '.[] | select(.status == "added") | .filename',
      ])
        .split("\n")
        .filter(
          (file) =>
            file.startsWith(`${MIGRATION_DIRECTORY}/`) &&
            file.endsWith("/migration.sql"),
        )
        .map((file) => file.slice(0, file.lastIndexOf("/")));

      return { baseDirectories, addedDirectories };
    },

    // The body arrives already inlined: no path is passed to gh, so no
    // concurrent writer can rewrite the commit message between the check and
    // the merge.
    merge: ({ subject, body, admin }) => {
      runGh([
        "pr",
        "merge",
        ...prArgs,
        "--squash",
        "--subject",
        subject,
        "--body",
        body,
        ...(admin ? ["--admin"] : []),
      ]);
      return readString(
        readRecord(
          readRecord(
            runGhJson(["pr", "view", ...prArgs, "--json", "mergeCommit"]),
            "pr view",
          )["mergeCommit"],
          "mergeCommit",
        ),
        "oid",
      );
    },
  };
};

// --- CLI --------------------------------------------------------------------

type MergeBarOptions = {
  pullNumber: number;
  repo: string;
  bodyFile: string | null;
  admin: boolean;
  dryRun: boolean;
};

const parseOptions = (argv: readonly string[]): MergeBarOptions => {
  const positional: string[] = [];
  let repo = DEFAULT_REPO;
  let bodyFile: string | null = null;
  let admin = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") {
      index += 1;
      repo = argv[index] ?? panic("--repo requires a value");
      continue;
    }
    if (argument === "--body-file") {
      index += 1;
      bodyFile = argv[index] ?? panic("--body-file requires a value");
      continue;
    }
    if (argument === "--admin") {
      admin = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === undefined || argument.startsWith("--")) {
      panic(`Unknown argument: ${argument ?? "<empty>"}`);
    }
    positional.push(argument);
  }

  const rawNumber = positional.at(0);
  if (rawNumber === undefined) {
    panic(
      "Usage: bun scripts/merge-bar.ts <pr-number> [--repo owner/name] " +
        "[--body-file path] [--admin] [--dry-run]",
    );
  }
  const pullNumber = Number.parseInt(rawNumber, 10);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    panic(`PR number must be a positive integer, got: ${rawNumber}`);
  }

  return { pullNumber, repo, bodyFile, admin, dryRun };
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
    attempt < MERGEABLE_POLL_ATTEMPTS && pullRequest.mergeable === "UNKNOWN";
    attempt += 1
  ) {
    Bun.sleepSync(MERGEABLE_POLL_INTERVAL_MS);
    pullRequest = gateway.readPullRequest();
  }
  return pullRequest;
};

if (import.meta.main) {
  const options = parseOptions(Bun.argv.slice(2));
  // Read the body FIRST and keep only its contents: after this line the path
  // is irrelevant, so a concurrent writer cannot reach the merge commit.
  const bodyOverride =
    options.bodyFile === null ? null : readFileSync(options.bodyFile, "utf-8");

  const gateway = createGhGateway({
    repo: options.repo,
    pullNumber: options.pullNumber,
  });

  const pullRequest = readSettledPullRequest(gateway);
  const snapshot: MergeBarSnapshot = {
    pullRequest,
    checkRunsHeadSha: pullRequest.headSha,
    checkRuns: gateway.readCheckRuns(pullRequest.headSha),
    reviewThreads: gateway.readReviewThreads(),
    migrations: gateway.readMigrationDirectories(),
    // Deliberately the LAST read before the verdict: everything above is now
    // known to describe this exact commit, or the gate fails.
    headShaBeforeMerge: gateway.readHeadSha(),
  };

  const verdict = evaluateMergeBar(snapshot);
  console.log(`merge bar: ${options.repo}#${options.pullNumber}`);
  console.log(formatVerdict(verdict));

  if (verdict.decision === "abort") {
    console.log("\nverdict: ABORT — not merging.");
    process.exit(1);
  }

  if (options.dryRun) {
    console.log("\nverdict: MERGE (dry run, nothing written).");
    process.exit(0);
  }

  const mergeSha = gateway.merge({
    subject: `${pullRequest.title} (#${pullRequest.number})`,
    body: bodyOverride ?? pullRequest.body,
    admin: options.admin,
  });
  console.log(`\nverdict: MERGE — squashed as ${mergeSha}`);
}
