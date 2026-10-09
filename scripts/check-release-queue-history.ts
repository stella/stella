#!/usr/bin/env bun

import { Result } from "better-result";
import nodePath from "node:path";

const REPOSITORY_NAME = "stella";
const REPOSITORY_OWNER = "stella";
const REPOSITORY = `${REPOSITORY_OWNER}/${REPOSITORY_NAME}`;
const HEAVY_CONTEXT = "main/heavy";
const GITHUB_ACTIONS_BOT = "github-actions[bot]";
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

const parseJson = (value: string, source: string): unknown => {
  const parsed = Result.try((): unknown => JSON.parse(value));
  if (Result.isError(parsed)) {
    throw new ReleaseQueueHistoryError(
      `${source} returned an unexpected payload`,
      { cause: parsed.error },
    );
  }
  return parsed.value;
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

const hasSuccessfulHeavyStatus = (
  baseSha: string,
  command: CommandRunner,
  ghRetryScript: string,
): boolean => {
  const payload = apiJson(`commits/${baseSha}/status`, command, ghRetryScript);
  if (!isRecord(payload) || !Array.isArray(payload["statuses"])) {
    throw new ReleaseQueueHistoryError(
      `Commit statuses for ${baseSha} returned an unexpected payload`,
    );
  }
  const status = payload["statuses"].find(
    (entry) => isRecord(entry) && entry["context"] === HEAVY_CONTEXT,
  );
  return (
    isRecord(status) &&
    status["state"] === "success" &&
    isRecord(status["creator"]) &&
    status["creator"]["login"] === GITHUB_ACTIONS_BOT
  );
};

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

export const assertReleaseQueueHistory = ({
  baseSha,
  previousTag,
  command = runCommand,
  ghRetryScript = process.env["GH_RETRY_SCRIPT"] ??
    nodePath.join(ROOT_DIR, "scripts/gh-retry.sh"),
}: QueueHistoryOptions & {
  command?: CommandRunner;
  ghRetryScript?: string;
}): void => {
  const resolvedBaseSha = command([
    "git",
    "rev-parse",
    "--verify",
    `${baseSha}^{commit}`,
  ]).trim();
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
    }
  }

  const skipped: PullRequest[] = [];
  for (const pullRequest of mergedPullRequests) {
    if (!wasMergedThroughQueue(pullRequest, command, ghRetryScript)) {
      skipped.push(pullRequest);
    }
  }
  if (
    (skipped.length === 0 && commitsWithoutPullRequests.length === 0) ||
    hasSuccessfulHeavyStatus(resolvedBaseSha, command, ghRetryScript)
  ) {
    return;
  }

  const unvalidatedChanges = [
    ...skipped.map(
      ({ html_url, number, title }) =>
        `  #${String(number)} ${title} (${html_url})`,
    ),
    ...commitsWithoutPullRequests.map(
      (commit) => `  ${commit} (no associated merged pull request)`,
    ),
  ].join("\n");
  throw new ReleaseQueueHistoryError(
    [
      `Release history ${previousTag}..${resolvedBaseSha} includes changes not validated through the merge queue:`,
      unvalidatedChanges,
      `Validate the base commit, then retry:`,
      `  gh workflow run main-heavy.yml --repo ${REPOSITORY} --ref main -f sha=${resolvedBaseSha} -f release_candidate=true`,
    ].join("\n"),
  );
};

const parseOptions = (args: readonly string[]): QueueHistoryOptions => {
  const previousTagIndex = args.indexOf("--from");
  const baseIndex = args.indexOf("--base");
  const previousTag = args.at(previousTagIndex + 1);
  const baseSha = args.at(baseIndex + 1);
  if (
    args.length !== 4 ||
    previousTagIndex === -1 ||
    baseIndex === -1 ||
    !previousTag ||
    !baseSha
  ) {
    throw new ReleaseQueueHistoryError(
      "Usage: check-release-queue-history.ts --from <tag> --base <sha>",
    );
  }
  return { baseSha, previousTag };
};

if (import.meta.main) {
  const result = Result.try(() =>
    assertReleaseQueueHistory(parseOptions(process.argv.slice(2))),
  );
  if (Result.isError(result)) {
    console.error(result.error.message);
    process.exit(1);
  }
}
