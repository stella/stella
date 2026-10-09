#!/usr/bin/env bun

// The tag gate (check-release-main-health.sh) enforces; this check reports.

import nodePath from "node:path";

const REPOSITORY_NAME = "stella";
const REPOSITORY_OWNER = "stella";
const REPOSITORY = `${REPOSITORY_OWNER}/${REPOSITORY_NAME}`;
const HEAVY_RUN_TITLE_PREFIX = "Main heavy suites ";
const MAX_MERGE_QUEUE_BATCH_SIZE = 4;
const RUNS_PER_PAGE = 100;
const MAX_DISPATCH_RUN_PAGES = 20;
const ROOT_DIR = nodePath.resolve(import.meta.dirname, "..");
const MERGE_QUEUE_TIMELINE_QUERY = `
  query MergeQueueTimeline($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
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
  previousTag: string;
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

const runCommand: CommandRunner = (command) => {
  const result = Bun.spawnSync([...command], {
    cwd: ROOT_DIR,
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

const isPullRequest = (value: unknown): value is PullRequest =>
  isRecord(value) &&
  typeof value["html_url"] === "string" &&
  (typeof value["merge_commit_sha"] === "string" ||
    value["merge_commit_sha"] === null) &&
  (typeof value["merged_at"] === "string" || value["merged_at"] === null) &&
  typeof value["number"] === "number" &&
  typeof value["title"] === "string";

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

const wasMergedThroughQueue = (
  pullRequest: MergedPullRequest,
  command: CommandRunner,
  ghRetryScript: string,
): boolean => {
  const payload = parseJson(
    command([
      "bash",
      ghRetryScript,
      "api",
      "graphql",
      "-f",
      `query=${MERGE_QUEUE_TIMELINE_QUERY}`,
      "-f",
      `owner=${REPOSITORY_OWNER}`,
      "-f",
      `name=${REPOSITORY_NAME}`,
      "-F",
      `number=${String(pullRequest.number)}`,
    ]),
    `Timeline for pull request #${String(pullRequest.number)}`,
  );
  const data = isRecord(payload) ? payload["data"] : undefined;
  const repository = isRecord(data) ? data["repository"] : undefined;
  const pullRequestPayload = isRecord(repository)
    ? repository["pullRequest"]
    : undefined;
  const timelineItems = isRecord(pullRequestPayload)
    ? pullRequestPayload["timelineItems"]
    : undefined;
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
  command = runCommand,
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
  if (hasSuccessfulHeavyRun(resolvedBaseSha, command, ghRetryScript)) {
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
    `${previousTag}..${resolvedBaseSha}`,
  ])
    .split("\n")
    .filter(Boolean);
  const mergedPullRequests: MergedPullRequest[] = [];
  const commitsWithoutPullRequests: string[] = [];
  const pullRequestByCommit = new Map<string, MergedPullRequest>();

  for (const sha of commits) {
    const payload = apiJson(
      `commits/${sha}/pulls?per_page=100`,
      command,
      ghRetryScript,
    );
    if (!Array.isArray(payload) || !payload.every(isPullRequest)) {
      throw new ReleaseQueueHistoryError(
        `Pull requests for ${sha} returned an unexpected payload`,
      );
    }
    const pullRequests = payload.filter((candidate) =>
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
    if (wasMergedThroughQueue(pullRequest, command, ghRetryScript)) {
      queueCandidates.add(pullRequest.merge_commit_sha);
    }
  }
  const mergeGroupValidated = new Map<string, boolean>();
  const hasMergeGroupRun = (sha: string): boolean => {
    const known = mergeGroupValidated.get(sha);
    if (known !== undefined) {
      return known;
    }
    const found = hasSuccessfulRunOnCommit({
      workflow: "ci.yml",
      event: "merge_group",
      sha,
      command,
      ghRetryScript,
    });
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
    "The tag requires main/heavy success on the release commit:",
    "  gh workflow run main-heavy.yml --ref main -f sha=<release-sha> -f release_candidate=true",
  ].join("\n");

export const parseOptions = (args: readonly string[]): QueueHistoryOptions => {
  const previousTagIndex = args.indexOf("--from");
  const baseIndex = args.indexOf("--base");
  const previousTag = args.at(previousTagIndex + 1);
  const baseSha = args.at(baseIndex + 1);
  if (
    args.length !== 4 ||
    previousTagIndex === -1 ||
    baseIndex === -1 ||
    !previousTag ||
    !baseSha ||
    previousTag.startsWith("-") ||
    baseSha.startsWith("-")
  ) {
    throw new ReleaseQueueHistoryError(
      "Usage: check-release-queue-history.ts --from <tag> --base <sha>",
    );
  }
  return { baseSha, previousTag };
};

export const runReleaseQueueHistoryCli = (
  args: readonly string[],
  writeWarning = (message: string) => process.stdout.write(`${message}\n`),
  check = assertReleaseQueueHistory,
): number => {
  const warning = (message: string) =>
    writeWarning(
      `::warning::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
    );
  try {
    const report = check(parseOptions(args));
    if (!report.validated) {
      warning(formatReleaseQueueHistoryNotice(report));
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warning(`Release queue history could not be checked: ${reason}`);
  }
  return 0;
};

if (import.meta.main) {
  process.exitCode = runReleaseQueueHistoryCli(process.argv.slice(2));
}
