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
// migration ordering is checked against the base as it stands at merge time.
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

import { panic } from "better-result";

import { findMigrationOrderViolation } from "./check-migration-order";

const DEFAULT_REPO = "stella/stella";
const MERGEABLE_POLL_ATTEMPTS = 8;
const MERGEABLE_POLL_INTERVAL_MS = 2000;
const MERGE_COMMIT_POLL_ATTEMPTS = 5;
// GitHub's REST contents listing silently truncates past this many entries.
const CONTENTS_ENDPOINT_ENTRY_LIMIT = 1000;
const PULL_NUMBER_PATTERN = /^\d+$/u;

// --- Repository policy --------------------------------------------------------

const LANDINGS = ["merge-when-ready", "merge"] as const;
type Landing = (typeof LANDINGS)[number];

export type RepositoryPolicy = {
  requiredCheckRuns: readonly string[];
  // Where committed migrations live, for repositories that carry any.
  migrationDirectory: string | null;
  landing: Landing;
};

export const mergeBarRepositoryPolicy = (repo: string): RepositoryPolicy => {
  switch (repo.toLowerCase()) {
    case "stella/stella":
      return {
        requiredCheckRuns: ["ci-result"],
        migrationDirectory: "apps/api/drizzle",
        landing: "merge-when-ready",
      };
    case "stella/stella-infra":
      return {
        requiredCheckRuns: [
          "Lint & Validate",
          "Plan (production)",
          "Plan (staging)",
        ],
        migrationDirectory: null,
        landing: "merge",
      };
    case "stella/stella-plane":
      return {
        requiredCheckRuns: ["Overlay check"],
        migrationDirectory: null,
        landing: "merge",
      };
    default:
      return panic(`No merge-bar policy is registered for ${repo}`);
  }
};

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
  state: (typeof PULL_REQUEST_STATES)[number];
  isDraft: boolean;
  mergeable: (typeof MERGEABLE_STATES)[number];
  // When "merge when ready" was already armed, the moment it was; arming it
  // again is neither needed nor accepted by GitHub.
  autoMergeEnabledAt: string | null;
  headSha: string;
};

type CheckRunSnapshot = {
  name: string;
  status: string;
  conclusion: string | null;
};

type ReviewThreadSnapshot = { id: string; isResolved: boolean };

type MigrationSnapshot = {
  // Migration directories present on the base branch right now.
  baseDirectories: readonly string[];
  // Migration directories this pull request adds.
  addedDirectories: readonly string[];
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

  const required = checkRuns.filter((run) =>
    requiredCheckRuns.includes(run.name),
  );
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
    detail: `${migrations.addedDirectories.length} added migration(s) ordered above the base branch`,
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
  // Deliberately separate from `readPullRequest`: the pre-write re-read only
  // needs the SHA, and a narrow read makes the TOCTOU window smaller.
  readHeadSha: () => string;
  readCheckRuns: (headSha: string) => readonly CheckRunSnapshot[];
  readReviewThreads: () => readonly ReviewThreadSnapshot[];
  readMigrationDirectories: () => MigrationSnapshot;
  // Both writes pin the head every gate was evaluated against, so GitHub
  // rejects them server-side if it moved since: the head-stability assertion
  // is enforced by the write itself, not by the gap between the last read and
  // it. `merge` returns the squash commit; `armMergeWhenReady` returns what
  // GitHub did: enabled auto-merge, or added the pull request to the queue.
  merge: (input: { expectedHeadSha: string }) => string;
  armMergeWhenReady: (input: { expectedHeadSha: string }) => string;
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
          "number,state,isDraft,mergeable,autoMergeRequest,headRefOid",
        ]),
        "pr view",
      );
      const number = raw["number"];
      if (typeof number !== "number") {
        panic("Expected numeric field `number` in gh response");
      }
      const autoMergeRequest = raw["autoMergeRequest"];
      return {
        number,
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
        autoMergeEnabledAt: isRecord(autoMergeRequest)
          ? readString(autoMergeRequest, "enabledAt")
          : null,
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

    // Read both sides from the API rather than the local checkout: the local
    // clone can be behind the base branch, which is the very staleness this
    // gate exists to catch.
    readMigrationDirectories: () => {
      if (migrationDirectory === null) {
        return { baseDirectories: [], addedDirectories: [] };
      }
      const baseRefName = readString(
        readRecord(
          runGhJson(["pr", "view", ...prArgs, "--json", "baseRefName"]),
          "pr view",
        ),
        "baseRefName",
      );
      // Pin the listing to one commit so it provably describes one tree rather
      // than whatever the branch pointed at between two separate requests.
      const baseSha = readString(
        readRecord(
          runGhJson([
            "api",
            `repos/${repo}/commits/${baseRefName}`,
            "--jq",
            "{sha: .sha}",
          ]),
          "base commit",
        ),
        "sha",
      );
      const baseDirectories = runGh([
        "api",
        `repos/${repo}/contents/${migrationDirectory}?ref=${baseSha}`,
        "--jq",
        '.[] | select(.type == "dir") | .name',
      ])
        .split("\n")
        .filter(Boolean);
      // The contents endpoint truncates at 1000 entries without saying so. A
      // truncated listing would drop the newest migrations and let the gate
      // pass on the exact ordering it exists to catch, so refuse instead.
      if (baseDirectories.length >= CONTENTS_ENDPOINT_ENTRY_LIMIT) {
        panic(
          `${migrationDirectory} has ${baseDirectories.length} entries at ` +
            `${baseSha}, at or past the contents endpoint's ` +
            `${CONTENTS_ENDPOINT_ENTRY_LIMIT}-entry limit. The listing may be ` +
            "truncated; switch this gate to the git tree API before merging.",
        );
      }

      const addedDirectories = runGh([
        "api",
        "--paginate",
        `repos/${repo}/pulls/${pullNumber}/files`,
        "--jq",
        '.[] | select(.status == "added") | .filename',
      ])
        .split("\n")
        .filter(
          (filename) =>
            filename.startsWith(`${migrationDirectory}/`) &&
            filename.endsWith("/migration.sql"),
        )
        .map((filename) => filename.slice(0, filename.lastIndexOf("/")));

      return { baseDirectories, addedDirectories };
    },

    merge: ({ expectedHeadSha }) => {
      runGh([
        "pr",
        "merge",
        ...prArgs,
        "--squash",
        "--match-head-commit",
        expectedHeadSha,
      ]);
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
      runGh([
        "pr",
        "merge",
        ...prArgs,
        "--squash",
        "--auto",
        "--match-head-commit",
        expectedHeadSha,
      ]).trim(),
  };
};

// --- CLI --------------------------------------------------------------------

type MergeBarOptions = {
  pullNumber: number;
  repo: string;
  dryRun: boolean;
};

const parseOptions = (argv: readonly string[]): MergeBarOptions => {
  const positional: string[] = [];
  let repo = DEFAULT_REPO;
  let dryRun = false;

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
        "[--dry-run]",
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

  return { pullNumber, repo, dryRun };
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
  const policy = mergeBarRepositoryPolicy(options.repo);
  const gateway = createGhGateway({
    repo: options.repo,
    pullNumber: options.pullNumber,
    migrationDirectory: policy.migrationDirectory,
  });

  const pullRequest = readSettledPullRequest(gateway);
  // Read order is load-bearing: each gate's window is the time between its
  // own read and the write, so the head SHA the write pins is read last.
  const snapshot: MergeBarSnapshot = {
    pullRequest,
    landing: policy.landing,
    requiredCheckRuns: policy.requiredCheckRuns,
    checkRunsHeadSha: pullRequest.headSha,
    checkRuns: gateway.readCheckRuns(pullRequest.headSha),
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
      if (pullRequest.autoMergeEnabledAt !== null) {
        console.log(
          `\nverdict: ARMED — merge when ready has been on since ${pullRequest.autoMergeEnabledAt}`,
        );
        break;
      }
      const outcome = gateway.armMergeWhenReady({
        expectedHeadSha: snapshot.headShaBeforeMerge,
      });
      console.log(
        `\nverdict: ARMED — ${outcome}; the queue merges ` +
          `${snapshot.headShaBeforeMerge} once its checks pass`,
      );
      break;
    }
    default:
      policy.landing satisfies never;
      panic(`Unhandled landing: ${String(policy.landing)}`);
  }
}
