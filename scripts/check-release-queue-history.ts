#!/usr/bin/env bun

// Two modes. By default the check reports: pull request and merge-group CI and
// maintenance preparation print a warning and continue. With --require it
// enforces: the release gate (check-release-main-health.sh, through
// check-release-receipt-coverage.sh) runs it before it lets a merge-group
// receipt on the release commit stand in for main/heavy and main/pr-depth,
// and any unvalidated or unreadable history keeps both statuses required.

import nodePath from "node:path";

const REPOSITORY_NAME = "stella";
const REPOSITORY_OWNER = "stella";
const REPOSITORY = `${REPOSITORY_OWNER}/${REPOSITORY_NAME}`;
const HEAVY_RUN_TITLE_PREFIX = "Main heavy suites ";
const MAX_MERGE_QUEUE_BATCH_SIZE = 4;
const RUNS_PER_PAGE = 100;
const MAX_DISPATCH_RUN_PAGES = 20;
const ROOT_DIR = nodePath.resolve(import.meta.dirname, "..");
// One GraphQL query answers a whole slice of the release history: for every
// commit, the pull requests GitHub associates with it (the REST
// commits/{sha}/pulls answer), each one's merge queue timeline, and the
// commit's GitHub Actions check suites, which hold its merge-group CI run.
// Per-commit and per-pull-request reads made a release cut wait minutes.
// Sized against GitHub's GraphQL timeout: 50 commits with 100 suites each
// answered HTTP 504, 25 commits with 50 suites each answer in about 5 s, and a
// typical commit has fewer than 50 Actions suites.
const COMMIT_BATCH_SIZE = 25;
const ASSOCIATED_PULL_REQUEST_LIMIT = 10;
const CHECK_SUITE_PAGE_SIZE = 50;
const MAX_CHECK_SUITE_PAGES = 20;
// The GitHub Actions app on github.com; its check suites carry workflow runs.
const GITHUB_ACTIONS_APP_ID = 15_368;
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const CHECK_SUITE_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes { conclusion workflowRun { event file { path } } }
`;
const RELEASE_COMMIT_FRAGMENT = `
  fragment ReleaseCommit on Commit {
    oid
    associatedPullRequests(first: ${String(ASSOCIATED_PULL_REQUEST_LIMIT)}) {
      pageInfo { hasNextPage }
      nodes {
        number
        title
        url
        mergedAt
        mergeCommit { oid }
        timelineItems(
          last: 100
          itemTypes: [
            ADDED_TO_MERGE_QUEUE_EVENT
            REMOVED_FROM_MERGE_QUEUE_EVENT
            MERGED_EVENT
          ]
        ) {
          pageInfo { hasPreviousPage }
          nodes { __typename }
        }
      }
    }
    checkSuites(
      first: ${String(CHECK_SUITE_PAGE_SIZE)}
      filterBy: { appId: ${String(GITHUB_ACTIONS_APP_ID)} }
    ) {${CHECK_SUITE_FIELDS}}
  }
`;
const CHECK_SUITES_QUERY = `
  query ReleaseCommitCheckSuites(
    $owner: String!
    $name: String!
    $oid: GitObjectID!
    $after: String!
  ) {
    repository(owner: $owner, name: $name) {
      object(oid: $oid) {
        ... on Commit {
          checkSuites(
            first: ${String(CHECK_SUITE_PAGE_SIZE)}
            after: $after
            filterBy: { appId: ${String(GITHUB_ACTIONS_APP_ID)} }
          ) {${CHECK_SUITE_FIELDS}}
        }
      }
    }
  }
`;

type PullRequest = {
  html_url: string;
  merge_commit_sha: string | null;
  merged_at: string | null;
  number: number;
  title: string;
};

type MergedPullRequest = PullRequest & {
  merge_commit_sha: string;
  merged_at: string;
};

type QueueHistoryOptions = {
  baseSha: string;
  // Omitted: the nearest release tag reachable from the base's parent. VERSION
  // never names it, because a version commit can be superseded untagged.
  previousTag?: string;
  // Strict mode answers only whether the merge queue validated every commit;
  // a green main heavy run on the base does not count, because the release
  // gate validates that status itself when it falls back to it.
  strict?: boolean;
  // Checkout whose history is read; defaults to the one holding this script.
  repoDir?: string;
};

export type ReleaseQueueHistoryReport = {
  validated: boolean;
  bypassingPullRequests: PullRequest[];
  commitsWithoutPullRequest: string[];
};

type CommandRunner = (command: readonly string[]) => string;

export class ReleaseQueueHistoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleaseQueueHistoryError";
  }
}

/** Commit SHAs are inlined as aliases, so only full lowercase SHAs pass. */
export const releaseCommitHistoryQuery = (shas: readonly string[]): string => {
  for (const sha of shas) {
    if (!FULL_SHA.test(sha)) {
      throw new ReleaseQueueHistoryError(
        `Release history commit ${sha} is not a full SHA`,
      );
    }
  }
  const aliases = shas
    .map(
      (sha, index) =>
        `c${String(index)}: object(oid: "${sha}") { ...ReleaseCommit }`,
    )
    .join("\n      ");
  return `
  query ReleaseCommitHistory {
    repository(owner: "${REPOSITORY_OWNER}", name: "${REPOSITORY_NAME}") {
      ${aliases}
    }
  }
${RELEASE_COMMIT_FRAGMENT}`;
};

/**
 * The previous release is the nearest release tag the base's parent reaches,
 * the rule check-release-receipt-coverage.sh applies at the tag gate. It is
 * never `v` + VERSION: a later version commit supersedes an untagged VERSION.
 */
export const previousReleaseTag = (
  baseSha: string,
  command: CommandRunner,
): string =>
  command([
    "git",
    "describe",
    "--tags",
    "--abbrev=0",
    "--match",
    "v*",
    `${baseSha}^`,
  ]).trim();

const commandRunner =
  (cwd: string): CommandRunner =>
  (command) => {
    const result = Bun.spawnSync([...command], {
      cwd,
      stderr: "pipe",
      stdout: "pipe",
    });
    if (!result.success) {
      throw new ReleaseQueueHistoryError(
        `Command failed: ${command.join(" ")}\n${result.stderr.toString().trim()}`,
      );
    }
    return result.stdout.toString().trim();
  };

// This script runs before dependencies are installed: built-ins only.
const parseJson = (value: string, source: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ReleaseQueueHistoryError(
      `${source} returned an unexpected payload`,
      { cause: error },
    );
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isMergedAtCommit = (
  pullRequest: PullRequest,
  sha: string,
): pullRequest is MergedPullRequest =>
  pullRequest.merge_commit_sha === sha && pullRequest.merged_at !== null;

const apiJson = (
  path: string,
  command: CommandRunner,
  ghRetryScript: string,
): unknown =>
  parseJson(
    command(["bash", ghRetryScript, "api", `repos/${REPOSITORY}/${path}`]),
    path,
  );

const graphqlData = (
  args: readonly string[],
  source: string,
  command: CommandRunner,
  ghRetryScript: string,
): Record<string, unknown> => {
  const payload = parseJson(
    command(["bash", ghRetryScript, "api", "graphql", ...args]),
    source,
  );
  // A partial answer is no answer: errors beside data fail the read.
  const data = isRecord(payload) ? payload["data"] : undefined;
  if (!isRecord(data) || (isRecord(payload) && "errors" in payload)) {
    throw new ReleaseQueueHistoryError(
      `${source} returned an unexpected payload`,
    );
  }
  return data;
};

/** What the history check needs to know about one first-parent commit. */
type CommitHistory = {
  /** Pull requests GitHub lists for the commit, as the REST pulls listing. */
  pullRequests: PullRequest[];
  /** Raw merge queue timeline of each listed pull request, by number. */
  timelines: Map<number, unknown>;
  /** Check suites read so far, and the cursor of the next page if any. */
  checkSuites: unknown[];
  checkSuitesCursor: string | null;
};

const unexpectedPullRequests = (sha: string) =>
  new ReleaseQueueHistoryError(
    `Pull requests for ${sha} returned an unexpected payload`,
  );

const unexpectedCheckSuites = (sha: string) =>
  new ReleaseQueueHistoryError(
    `Check suites for ${sha} returned an unexpected payload`,
  );

type CheckSuitePage = { nodes: unknown[]; cursor: string | null };

const readCheckSuitePage = (value: unknown, sha: string): CheckSuitePage => {
  const pageInfo = isRecord(value) ? value["pageInfo"] : undefined;
  const nodes = isRecord(value) ? value["nodes"] : undefined;
  if (!isRecord(pageInfo) || !Array.isArray(nodes)) {
    throw unexpectedCheckSuites(sha);
  }
  if (pageInfo["hasNextPage"] === false) {
    return { nodes, cursor: null };
  }
  const cursor = pageInfo["endCursor"];
  if (pageInfo["hasNextPage"] !== true || typeof cursor !== "string") {
    throw unexpectedCheckSuites(sha);
  }
  return { nodes, cursor };
};

const readPullRequestNode = (
  node: unknown,
  sha: string,
): { pullRequest: PullRequest; timeline: unknown } => {
  if (!isRecord(node)) {
    throw unexpectedPullRequests(sha);
  }
  const { number, title, url, mergedAt, mergeCommit } = node;
  const mergeCommitSha = isRecord(mergeCommit) ? mergeCommit["oid"] : null;
  if (
    typeof number !== "number" ||
    typeof title !== "string" ||
    typeof url !== "string" ||
    (typeof mergedAt !== "string" && mergedAt !== null) ||
    (mergeCommit !== null && typeof mergeCommitSha !== "string")
  ) {
    throw unexpectedPullRequests(sha);
  }
  return {
    pullRequest: {
      html_url: url,
      merge_commit_sha:
        typeof mergeCommitSha === "string" ? mergeCommitSha : null,
      merged_at: mergedAt,
      number,
      title,
    },
    timeline: node["timelineItems"],
  };
};

const readCommitHistory = (value: unknown, sha: string): CommitHistory => {
  if (!isRecord(value) || value["oid"] !== sha) {
    throw unexpectedPullRequests(sha);
  }
  const associated = value["associatedPullRequests"];
  const pageInfo = isRecord(associated) ? associated["pageInfo"] : undefined;
  const nodes = isRecord(associated) ? associated["nodes"] : undefined;
  // More associated pull requests than one page holds: the listing is cut.
  if (
    !isRecord(pageInfo) ||
    pageInfo["hasNextPage"] !== false ||
    !Array.isArray(nodes)
  ) {
    throw unexpectedPullRequests(sha);
  }
  const pullRequests: PullRequest[] = [];
  const timelines = new Map<number, unknown>();
  for (const node of nodes) {
    const { pullRequest, timeline } = readPullRequestNode(node, sha);
    pullRequests.push(pullRequest);
    timelines.set(pullRequest.number, timeline);
  }
  const checkSuites = readCheckSuitePage(value["checkSuites"], sha);
  return {
    pullRequests,
    timelines,
    checkSuites: checkSuites.nodes,
    checkSuitesCursor: checkSuites.cursor,
  };
};

/**
 * Reads every commit's pull requests, their merge queue timelines and the
 * first page of its check suites in COMMIT_BATCH_SIZE commits per query.
 * Anything missing or cut short throws: unknown history is never validated.
 */
const readCommitHistories = (
  commits: readonly string[],
  command: CommandRunner,
  ghRetryScript: string,
): Map<string, CommitHistory> => {
  const histories = new Map<string, CommitHistory>();
  for (let start = 0; start < commits.length; start += COMMIT_BATCH_SIZE) {
    const batch = commits.slice(start, start + COMMIT_BATCH_SIZE);
    const data = graphqlData(
      ["-f", `query=${releaseCommitHistoryQuery(batch)}`],
      `Release history for ${batch[0] ?? ""}..${batch.at(-1) ?? ""}`,
      command,
      ghRetryScript,
    );
    const repository = data["repository"];
    for (const [index, sha] of batch.entries()) {
      const commit = isRecord(repository)
        ? repository[`c${String(index)}`]
        : undefined;
      histories.set(sha, readCommitHistory(commit, sha));
    }
  }
  return histories;
};

const wasMergedThroughQueue = (
  pullRequest: MergedPullRequest,
  timelineItems: unknown,
): boolean => {
  const pageInfo = isRecord(timelineItems)
    ? timelineItems["pageInfo"]
    : undefined;
  const nodes = isRecord(timelineItems) ? timelineItems["nodes"] : undefined;
  if (
    !isRecord(pageInfo) ||
    pageInfo["hasPreviousPage"] !== false ||
    !Array.isArray(nodes)
  ) {
    throw new ReleaseQueueHistoryError(
      `Timeline for pull request #${String(pullRequest.number)} returned an unexpected payload`,
    );
  }

  let inQueue = false;
  for (const node of nodes) {
    if (!isRecord(node) || typeof node["__typename"] !== "string") {
      throw new ReleaseQueueHistoryError(
        `Timeline for pull request #${String(pullRequest.number)} returned an unexpected payload`,
      );
    }
    switch (node["__typename"]) {
      case "AddedToMergeQueueEvent":
        inQueue = true;
        break;
      case "RemovedFromMergeQueueEvent":
        inQueue = false;
        break;
      case "MergedEvent":
        return inQueue;
      default:
        throw new ReleaseQueueHistoryError(
          `Timeline for pull request #${String(pullRequest.number)} returned an unexpected payload`,
        );
    }
  }
  throw new ReleaseQueueHistoryError(
    `Timeline for merged pull request #${String(pullRequest.number)} did not include a merge event`,
  );
};

// A successful ci.yml run for the merge_group event whose head is the commit:
// the check suite GitHub attaches to that commit, as the REST runs listing
// filtered by head_sha, event=merge_group and status=success answers it.
const isSuccessfulMergeGroupSuite = (suite: unknown, sha: string): boolean => {
  if (!isRecord(suite)) {
    throw unexpectedCheckSuites(sha);
  }
  const { conclusion, workflowRun } = suite;
  if (typeof conclusion !== "string" && conclusion !== null) {
    throw unexpectedCheckSuites(sha);
  }
  if (workflowRun === null) {
    return false;
  }
  const file = isRecord(workflowRun) ? workflowRun["file"] : undefined;
  if (
    !isRecord(workflowRun) ||
    typeof workflowRun["event"] !== "string" ||
    (file !== null && (!isRecord(file) || typeof file["path"] !== "string"))
  ) {
    throw unexpectedCheckSuites(sha);
  }
  return (
    conclusion === "SUCCESS" &&
    workflowRun["event"] === "merge_group" &&
    isRecord(file) &&
    file["path"] === CI_WORKFLOW_PATH
  );
};

/**
 * Pages through the commit's check suites only while no successful
 * merge-group run has been seen; most commits answer from the batched page.
 */
const hasSuccessfulMergeGroupSuite = (
  sha: string,
  history: CommitHistory,
  command: CommandRunner,
  ghRetryScript: string,
): boolean => {
  let suites = history.checkSuites;
  let cursor = history.checkSuitesCursor;
  for (let page = 1; ; page += 1) {
    if (suites.some((suite) => isSuccessfulMergeGroupSuite(suite, sha))) {
      return true;
    }
    if (cursor === null) {
      return false;
    }
    if (page >= MAX_CHECK_SUITE_PAGES) {
      throw new ReleaseQueueHistoryError(
        `Check suites for ${sha} exceed ${String(MAX_CHECK_SUITE_PAGES)} pages of ${String(CHECK_SUITE_PAGE_SIZE)}`,
      );
    }
    const data = graphqlData(
      [
        "-f",
        `query=${CHECK_SUITES_QUERY}`,
        "-f",
        `owner=${REPOSITORY_OWNER}`,
        "-f",
        `name=${REPOSITORY_NAME}`,
        "-f",
        `oid=${sha}`,
        "-f",
        `after=${cursor}`,
      ],
      `Check suites for ${sha}`,
      command,
      ghRetryScript,
    );
    const repository = data["repository"];
    const object = isRecord(repository) ? repository["object"] : undefined;
    const next = readCheckSuitePage(
      isRecord(object) ? object["checkSuites"] : undefined,
      sha,
    );
    suites = next.nodes;
    cursor = next.cursor;
  }
};

type RunsPageOptions = {
  workflow: string;
  query: string;
  page: number;
  perPage: number;
  command: CommandRunner;
  ghRetryScript: string;
};

const successfulRunsPage = ({
  workflow,
  query,
  page,
  perPage,
  command,
  ghRetryScript,
}: RunsPageOptions): Record<string, unknown>[] => {
  const payload = apiJson(
    `actions/workflows/${workflow}/runs?${query}&status=success&per_page=${String(perPage)}&page=${String(page)}`,
    command,
    ghRetryScript,
  );
  const workflowRuns = isRecord(payload) ? payload["workflow_runs"] : undefined;
  if (!Array.isArray(workflowRuns) || !workflowRuns.every(isRecord)) {
    throw new ReleaseQueueHistoryError(
      `Successful ${workflow} runs returned an unexpected payload`,
    );
  }
  return workflowRuns.filter((run) => run["conclusion"] === "success");
};

type CommitRunOptions = {
  workflow: string;
  event: string;
  sha: string;
  command: CommandRunner;
  ghRetryScript: string;
};

// Exact per-commit lookups avoid the 1,000-result cap on filtered run searches.
const hasSuccessfulRunOnCommit = ({
  workflow,
  event,
  sha,
  command,
  ghRetryScript,
}: CommitRunOptions): boolean =>
  successfulRunsPage({
    workflow,
    query: `head_sha=${sha}&event=${event}`,
    page: 1,
    perPage: 1,
    command,
    ghRetryScript,
  }).some((run) => run["head_sha"] === sha && run["event"] === event);

// Main heavy names each run "Main heavy suites <tested sha>". Push and
// schedule runs test their head; a dispatch tests its sha input, whatever ref
// it ran on, so only its title counts.
const hasSuccessfulHeavyRun = (
  baseSha: string,
  command: CommandRunner,
  ghRetryScript: string,
): boolean => {
  for (const event of ["push", "schedule"]) {
    if (
      hasSuccessfulRunOnCommit({
        workflow: "main-heavy.yml",
        event,
        sha: baseSha,
        command,
        ghRetryScript,
      })
    ) {
      return true;
    }
  }
  for (let page = 1; page <= MAX_DISPATCH_RUN_PAGES; page += 1) {
    const runs = successfulRunsPage({
      workflow: "main-heavy.yml",
      query: "event=workflow_dispatch",
      page,
      perPage: RUNS_PER_PAGE,
      command,
      ghRetryScript,
    });
    if (
      runs.some(
        (run) => run["display_title"] === `${HEAVY_RUN_TITLE_PREFIX}${baseSha}`,
      )
    ) {
      return true;
    }
    if (runs.length < RUNS_PER_PAGE) {
      return false;
    }
  }
  throw new ReleaseQueueHistoryError(
    `Successful main-heavy.yml dispatch runs exceed ${String(MAX_DISPATCH_RUN_PAGES)} pages of ${String(RUNS_PER_PAGE)}`,
  );
};

export const assertReleaseQueueHistory = ({
  baseSha,
  previousTag,
  strict = false,
  repoDir = ROOT_DIR,
  command = commandRunner(repoDir),
  ghRetryScript = process.env["GH_RETRY_SCRIPT"] ??
    nodePath.join(ROOT_DIR, "scripts/gh-retry.sh"),
}: QueueHistoryOptions & {
  command?: CommandRunner;
  ghRetryScript?: string;
}): ReleaseQueueHistoryReport => {
  const resolvedBaseSha = command([
    "git",
    "rev-parse",
    "--verify",
    `${baseSha}^{commit}`,
  ]).trim();
  if (
    !strict &&
    hasSuccessfulHeavyRun(resolvedBaseSha, command, ghRetryScript)
  ) {
    return {
      validated: true,
      bypassingPullRequests: [],
      commitsWithoutPullRequest: [],
    };
  }
  const commits = command([
    "git",
    "rev-list",
    "--reverse",
    "--first-parent",
    `${previousTag ?? previousReleaseTag(resolvedBaseSha, command)}..${resolvedBaseSha}`,
  ])
    .split("\n")
    .filter(Boolean);
  const mergedPullRequests: MergedPullRequest[] = [];
  const commitsWithoutPullRequests: string[] = [];
  const pullRequestByCommit = new Map<string, MergedPullRequest>();
  const histories = readCommitHistories(commits, command, ghRetryScript);
  const historyOf = (sha: string): CommitHistory => {
    const history = histories.get(sha);
    if (history === undefined) {
      throw unexpectedPullRequests(sha);
    }
    return history;
  };

  for (const sha of commits) {
    const pullRequests = historyOf(sha).pullRequests.filter((candidate) =>
      isMergedAtCommit(candidate, sha),
    );
    if (pullRequests.length === 0) {
      commitsWithoutPullRequests.push(
        command(["git", "show", "--no-patch", "--format=%h %s", sha]).trim(),
      );
    }
    for (const pullRequest of pullRequests) {
      mergedPullRequests.push(pullRequest);
      pullRequestByCommit.set(sha, pullRequest);
    }
  }

  const queueCandidates = new Set<string>();
  for (const pullRequest of mergedPullRequests) {
    const sha = pullRequest.merge_commit_sha;
    if (
      wasMergedThroughQueue(
        pullRequest,
        historyOf(sha).timelines.get(pullRequest.number),
      )
    ) {
      queueCandidates.add(sha);
    }
  }
  const mergeGroupValidated = new Map<string, boolean>();
  const hasMergeGroupRun = (sha: string): boolean => {
    const known = mergeGroupValidated.get(sha);
    if (known !== undefined) {
      return known;
    }
    const found = hasSuccessfulMergeGroupSuite(
      sha,
      historyOf(sha),
      command,
      ghRetryScript,
    );
    mergeGroupValidated.set(sha, found);
    return found;
  };
  const skipped: PullRequest[] = [];
  for (const [index, sha] of commits.entries()) {
    const pullRequest = pullRequestByCommit.get(sha);
    if (!pullRequest || !queueCandidates.has(sha)) {
      if (pullRequest) {
        skipped.push(pullRequest);
      }
      continue;
    }

    let validated = false;
    for (
      let candidateIndex = index;
      candidateIndex <
      Math.min(index + MAX_MERGE_QUEUE_BATCH_SIZE, commits.length);
      candidateIndex += 1
    ) {
      const candidateSha = commits[candidateIndex];
      if (!candidateSha || !queueCandidates.has(candidateSha)) {
        break;
      }
      if (hasMergeGroupRun(candidateSha)) {
        validated = true;
        break;
      }
    }
    if (!validated) {
      skipped.push(pullRequest);
    }
  }
  if (skipped.length === 0 && commitsWithoutPullRequests.length === 0) {
    return {
      validated: true,
      bypassingPullRequests: [],
      commitsWithoutPullRequest: [],
    };
  }

  return {
    validated: false,
    bypassingPullRequests: skipped,
    commitsWithoutPullRequest: commitsWithoutPullRequests,
  };
};

export const formatReleaseQueueHistoryNotice = (
  report: ReleaseQueueHistoryReport,
): string =>
  [
    "Release history includes changes not validated through the merge queue:",
    ...report.bypassingPullRequests.map(
      ({ html_url, number, title }) =>
        `  #${String(number)} ${title} (${html_url})`,
    ),
    ...report.commitsWithoutPullRequest.map(
      (commit) => `  ${commit} (no associated merged pull request)`,
    ),
    "A merge-group receipt on the release commit does not cover them; run the release-candidate gate, which starts heavy, PR-depth, and staging checks:",
    "  gh workflow run main-heavy.yml --ref main -f sha=<release-sha> -f release_candidate=true",
  ].join("\n");

const USAGE =
  "Usage: check-release-queue-history.ts --base <sha> [--from <tag>] [--require] [--repo-dir <path>]";
const VALUE_OPTIONS = new Set(["--from", "--base", "--repo-dir"]);

export const parseOptions = (args: readonly string[]): QueueHistoryOptions => {
  const values = new Map<string, string>();
  let strict = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--require" && !strict) {
      strict = true;
      continue;
    }
    const value = args[index + 1];
    if (
      !VALUE_OPTIONS.has(arg) ||
      values.has(arg) ||
      !value ||
      value.startsWith("-")
    ) {
      throw new ReleaseQueueHistoryError(USAGE);
    }
    values.set(arg, value);
    index += 1;
  }
  const previousTag = values.get("--from");
  const baseSha = values.get("--base");
  const repoDir = values.get("--repo-dir");
  if (!baseSha) {
    throw new ReleaseQueueHistoryError(USAGE);
  }
  return {
    baseSha,
    strict,
    ...(previousTag ? { previousTag } : {}),
    ...(repoDir ? { repoDir } : {}),
  };
};

/**
 * Turns a check into a notice: null when the history is validated, otherwise
 * what is unvalidated, or why the history could not be read at all. The
 * caller decides what a notice means; only strict mode treats it as fatal.
 */
export const releaseQueueHistoryWarning = (
  readOptions: () => QueueHistoryOptions,
  check = assertReleaseQueueHistory,
): string | null => {
  try {
    const report = check(readOptions());
    return report.validated ? null : formatReleaseQueueHistoryNotice(report);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Release queue history could not be checked: ${reason}`;
  }
};

/**
 * Advisory by default: prints a warning and exits 0. With --require, an
 * unvalidated or unreadable history (unknown is not safe), or unusable
 * arguments, print the same notice as an error and exit 1.
 */
export const runReleaseQueueHistoryCli = (
  args: readonly string[],
  writeWarning = (message: string) => process.stdout.write(`${message}\n`),
  check = assertReleaseQueueHistory,
): number => {
  const strict = args.includes("--require");
  const message = releaseQueueHistoryWarning(() => parseOptions(args), check);
  if (message === null) {
    return 0;
  }
  writeWarning(
    `::${strict ? "error" : "warning"}::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
  );
  return strict ? 1 : 0;
};

if (import.meta.main) {
  process.exitCode = runReleaseQueueHistoryCli(process.argv.slice(2));
}
