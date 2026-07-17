/**
 * Upstream revision checker for github-sourced catalogue skills.
 *
 * Each github skill pins an immutable commit SHA (`rev`). This script
 * asks the GitHub API for the latest commit touching the skill's
 * directory (or repo root) on the repo's default branch and reports the
 * entries whose upstream has advanced past the pinned SHA. It never
 * edits manifests: the scheduled `catalogue-upstream` workflow consumes
 * the `--json` output, bumps the revs, regenerates, and opens a PR for
 * a maintainer to review the upstream diff before merging.
 *
 * Usage:
 *   bun scripts/check-upstream.ts          # human-readable summary
 *   bun scripts/check-upstream.ts --json   # machine-readable output
 *
 * Set GITHUB_TOKEN to raise the API rate limit (Authorization header).
 */
import { TaggedError } from "better-result";

import { isGithubSkillEntry, loadCatalogue } from "../src/loader";

/** Expected per-entry failure while querying the GitHub commits API. */
class UpstreamFetchError extends TaggedError("UpstreamFetchError")<{
  message: string;
}>() {}

const COMMITS_API_TIMEOUT_MS = 10_000;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

type GithubSkillTarget = {
  currentRev: string;
  directory: string | null;
  repo: string;
  slug: string;
};

export type UpstreamUpdate = {
  compareUrl: string;
  currentRev: string;
  directory: string | null;
  latestRev: string;
  manifestPath: string;
  repo: string;
  slug: string;
};

export type UpstreamFailure = {
  message: string;
  repo: string;
  slug: string;
};

export type UpstreamCheckResult = {
  failures: UpstreamFailure[];
  updates: UpstreamUpdate[];
};

/**
 * GitHub commits API endpoint for the latest commit touching a path
 * (or the repo root when `directory` is null) on the default branch.
 */
export const buildCommitsApiUrl = ({
  directory,
  repo,
}: {
  directory: string | null;
  repo: string;
}): string => {
  const url = new URL(`https://api.github.com/repos/${repo}/commits`);
  url.searchParams.set("per_page", "1");
  if (directory) {
    url.searchParams.set("path", directory);
  }
  return url.toString();
};

/** Compare view for the pinned SHA against the newly observed SHA. */
export const buildCompareUrl = ({
  currentRev,
  latestRev,
  repo,
}: {
  currentRev: string;
  latestRev: string;
  repo: string;
}): string => `https://github.com/${repo}/compare/${currentRev}...${latestRev}`;

/** Repo-root-relative manifest path for a catalogue skill slug. */
export const catalogueManifestPath = (slug: string): string =>
  `packages/catalogue/entries/skills/${slug}/manifest.json`;

/**
 * Extract the newest commit SHA from a `GET /commits?per_page=1`
 * response. Returns null when the payload is not the expected shape or
 * the SHA is malformed, so a bad response fails loudly per entry.
 */
export const parseLatestCommitSha = (payload: unknown): string | null => {
  if (!Array.isArray(payload)) {
    return null;
  }
  const first = payload.at(0);
  if (!isRecord(first)) {
    return null;
  }
  const sha = first["sha"];
  return typeof sha === "string" && COMMIT_SHA_PATTERN.test(sha) ? sha : null;
};

export const hasUpstreamUpdate = (
  currentRev: string,
  latestRev: string,
): boolean => currentRev !== latestRev;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const collectGithubSkillTargets = (): GithubSkillTarget[] =>
  loadCatalogue()
    .filter(isGithubSkillEntry)
    .map((entry) => ({
      currentRev: entry.rev,
      directory: entry.directory ?? null,
      repo: entry.repo,
      slug: entry.slug,
    }));

const githubHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "stella-catalogue-upstream-check",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
};

const fetchLatestRev = async (target: GithubSkillTarget): Promise<string> => {
  const response = await fetch(
    buildCommitsApiUrl({ directory: target.directory, repo: target.repo }),
    {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(COMMITS_API_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new UpstreamFetchError({
      message: `GitHub API returned HTTP ${response.status}`,
    });
  }
  const sha = parseLatestCommitSha(await response.json());
  if (sha === null) {
    throw new UpstreamFetchError({
      message: "GitHub commits response had no usable commit SHA",
    });
  }
  return sha;
};

const toUpdate = (
  target: GithubSkillTarget,
  latestRev: string,
): UpstreamUpdate => ({
  compareUrl: buildCompareUrl({
    currentRev: target.currentRev,
    latestRev,
    repo: target.repo,
  }),
  currentRev: target.currentRev,
  directory: target.directory,
  latestRev,
  manifestPath: catalogueManifestPath(target.slug),
  repo: target.repo,
  slug: target.slug,
});

export const runUpstreamCheck = async (): Promise<UpstreamCheckResult> => {
  const updates: UpstreamUpdate[] = [];
  const failures: UpstreamFailure[] = [];

  for (const target of collectGithubSkillTargets()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential sweep keeps the GitHub API request rate low
      const latestRev = await fetchLatestRev(target);
      if (hasUpstreamUpdate(target.currentRev, latestRev)) {
        updates.push(toUpdate(target, latestRev));
      }
    } catch (error) {
      failures.push({
        message: error instanceof Error ? error.message : String(error),
        repo: target.repo,
        slug: target.slug,
      });
    }
  }

  return { failures, updates };
};

const printSummary = (result: UpstreamCheckResult): void => {
  if (result.updates.length === 0) {
    console.log("✓ All github-sourced catalogue skills are up to date.");
  } else {
    console.log(`Updates available (${result.updates.length}):`);
    for (const update of result.updates) {
      console.log(
        `  • ${update.slug} (${update.repo}): ${update.currentRev} → ${update.latestRev}`,
      );
      console.log(`    ${update.compareUrl}`);
    }
  }

  if (result.failures.length > 0) {
    console.error(`Failures (${result.failures.length}):`);
    for (const failure of result.failures) {
      console.error(
        `  ✗ ${failure.slug} (${failure.repo}): ${failure.message}`,
      );
    }
  }
};

if (import.meta.main) {
  const asJson = process.argv.includes("--json");
  const result = await runUpstreamCheck();

  if (asJson) {
    // Machine mode always exits 0: the workflow consumes both `updates`
    // and `failures` from stdout and decides how to surface each.
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
    if (result.failures.length > 0) {
      process.exitCode = 1;
    }
  }
}
