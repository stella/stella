/**
 * Pinned-content checker for github-sourced catalogue skills.
 *
 * Nothing else validates the bytes a github skill actually pins: the
 * schema/loader only check the manifest, and the rev-bump automation
 * never fetches the upstream `SKILL.md`. So a pin whose upstream fails
 * the install path (bad frontmatter, an oversized body, too many/large
 * resource files) ships with green CI and only fails at a user's
 * install click. This script closes that gap: for every github entry it
 * fetches the pinned `SKILL.md` and enumerates the pinned directory, and
 * fails per-entry when any install-time limit would be violated.
 *
 * Usage:
 *   bun scripts/check-pinned-content.ts
 *
 * Set GITHUB_TOKEN to raise the GitHub API rate limit (Authorization
 * header on the contents API). Network is required; run in CI or with
 * connectivity, not on the offline verify path.
 */
import { TaggedError } from "better-result";

import {
  isAllowedResourcePath,
  normalizeResourcePath,
  parseSkillFile,
} from "@stll/skills";

import { isGithubSkillEntry, loadCatalogue } from "../src/loader";

/** Expected per-entry failure while fetching upstream content. */
class PinnedContentError extends TaggedError("PinnedContentError")<{
  message: string;
}>() {}

const FETCH_TIMEOUT_MS = 10_000;
const SKILL_FILE_NAME = "SKILL.md";

/**
 * Limits mirror the install path (apps/api/src/lib/limits.ts and
 * handlers/skills/skill-package.ts). The install handler is the
 * enforcer; this pre-flight must match it so a broken pin fails at PR
 * time, not at install time. Keep these in sync if the install limits
 * change.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const BODY_MAX_CHARS = 80_000; // agentSkillBodyMaxChars
const RESOURCE_MAX_CHARS = 100_000; // agentSkillResourceMaxChars
const RESOURCE_MAX_BYTES = RESOURCE_MAX_CHARS * 4; // GITHUB_SKILL_FILE_MAX_BYTES
const TOTAL_MAX_BYTES = 6 * 1024 * 1024; // agentSkillArchiveUncompressedMaxBytes
const RESOURCES_PER_SKILL_MAX = 50; // agentSkillResourcesPerSkill
const DIRECTORIES_MAX = 100; // agentSkillGithubDirectoriesMax
const SKILL_RESOURCE_ROOTS: ReadonlySet<string> = new Set([
  "assets",
  "knowledge",
  "prompts",
  "reference",
  "references",
  "scripts",
  "templates",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type GithubTarget = {
  directory: string;
  repo: string;
  rev: string;
  slug: string;
};

type GithubContentItem = {
  path: string;
  size: number | null;
  type: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const githubHeaders = (accept: string): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "stella-catalogue-pinned-check",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
};

const joinRepoPath = (directory: string, relative: string): string =>
  directory ? `${directory}/${relative}` : relative;

const encodePath = (repoRelativePath: string): string =>
  repoRelativePath
    .split("/")
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
    .join("/");

const rawContentUrl = (
  target: GithubTarget,
  repoRelativePath: string,
): string =>
  `https://raw.githubusercontent.com/${target.repo}/${target.rev}/${encodePath(repoRelativePath)}`;

const contentsApiUrl = (
  target: GithubTarget,
  repoRelativePath: string,
): string => {
  const encoded = encodePath(repoRelativePath);
  const url = new URL(
    encoded.length > 0
      ? `https://api.github.com/repos/${target.repo}/contents/${encoded}`
      : `https://api.github.com/repos/${target.repo}/contents`,
  );
  url.searchParams.set("ref", target.rev);
  return url.toString();
};

/**
 * Fetch the pinned `SKILL.md` as text. Returns null on a 404 so the
 * caller can report the specific "not found at pinned rev" failure;
 * every other non-2xx response and any redirect throws.
 */
const fetchSkillMarkdown = async (
  target: GithubTarget,
): Promise<string | null> => {
  const response = await fetch(
    rawContentUrl(target, joinRepoPath(target.directory, SKILL_FILE_NAME)),
    {
      headers: githubHeaders("text/plain"),
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new PinnedContentError({
      message: `SKILL.md fetch returned HTTP ${response.status}`,
    });
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > RESOURCE_MAX_BYTES) {
    throw new PinnedContentError({
      message: `SKILL.md is larger than ${RESOURCE_MAX_BYTES} bytes`,
    });
  }
  return UTF8_DECODER.decode(buffer);
};

const fetchDirectoryContents = async (
  target: GithubTarget,
  repoRelativePath: string,
): Promise<GithubContentItem[]> => {
  const response = await fetch(contentsApiUrl(target, repoRelativePath), {
    headers: githubHeaders("application/vnd.github+json"),
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // A missing resource directory is not an error: the skill simply has
  // no files under that root.
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new PinnedContentError({
      message: `GitHub contents API returned HTTP ${response.status} for ${repoRelativePath || "<root>"}`,
    });
  }

  const payload: unknown = await response.json();
  const items = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? [payload]
      : [];
  const parsed: GithubContentItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const path = item["path"];
    const size = item["size"];
    const type = item["type"];
    if (typeof path === "string" && typeof type === "string") {
      parsed.push({
        path,
        size: typeof size === "number" && Number.isFinite(size) ? size : null,
        type,
      });
    }
  }
  return parsed;
};

/** Path of `repoRelativePath` relative to the skill directory, or null. */
const relativeToSkillRoot = (
  rootPath: string,
  repoRelativePath: string,
): string | null => {
  if (!rootPath) {
    return repoRelativePath;
  }
  if (repoRelativePath === rootPath) {
    return repoRelativePath.split("/").at(-1) ?? repoRelativePath;
  }
  const prefix = `${rootPath}/`;
  return repoRelativePath.startsWith(prefix)
    ? repoRelativePath.slice(prefix.length)
    : null;
};

const safeNormalize = (path: string): string | null => {
  try {
    return normalizeResourcePath(path);
  } catch {
    return null;
  }
};

/**
 * Check the pinned `SKILL.md`: fetch it, parse it with the real skill
 * parser (which requires name + description), and enforce the install
 * name pattern and body length. Returns collected error strings.
 */
const checkSkillFile = async (target: GithubTarget): Promise<string[]> => {
  const markdown = await fetchSkillMarkdown(target);
  if (markdown === null) {
    return [`${target.slug}: SKILL.md not found at pinned rev`];
  }

  let parsed: ReturnType<typeof parseSkillFile>;
  try {
    parsed = parseSkillFile(markdown);
  } catch (error) {
    return [
      `${target.slug}: SKILL.md frontmatter is invalid (${errorMessage(error)})`,
    ];
  }

  const errors: string[] = [];
  if (!SKILL_NAME_PATTERN.test(parsed.metadata.name)) {
    errors.push(
      `${target.slug}: frontmatter name "${parsed.metadata.name}" fails the skill name pattern`,
    );
  }
  if (parsed.body.length > BODY_MAX_CHARS) {
    errors.push(
      `${target.slug}: SKILL.md body is ${parsed.body.length} chars, exceeds the ${BODY_MAX_CHARS} install limit`,
    );
  }
  return errors;
};

/**
 * Enumerate the pinned directory's resource files (breadth-first over
 * the allowed resource roots) and enforce the install path's resource
 * count, per-file size, cumulative size, and directory-count limits.
 */
const checkResources = async (target: GithubTarget): Promise<string[]> => {
  const errors: string[] = [];
  const rootPath = target.directory;
  const pending: string[] = [rootPath];
  const queued = new Set(pending);
  let resourceCount = 0;
  let totalBytes = 0;

  while (pending.length > 0) {
    const directory = pending.shift();
    if (directory === undefined) {
      break;
    }

    // oxlint-disable-next-line no-await-in-loop -- breadth-first traversal: each directory's contents enqueue the next
    const items = await fetchDirectoryContents(target, directory);
    for (const item of items) {
      const relative = relativeToSkillRoot(rootPath, item.path);
      if (relative === null) {
        continue;
      }

      if (item.type === "dir") {
        const root = relative.split("/").at(0);
        if (root && SKILL_RESOURCE_ROOTS.has(root) && !queued.has(item.path)) {
          if (queued.size + 1 > DIRECTORIES_MAX) {
            errors.push(
              `${target.slug}: more than ${DIRECTORIES_MAX} resource directories`,
            );
            return errors;
          }
          queued.add(item.path);
          pending.push(item.path);
        }
        continue;
      }
      if (item.type !== "file") {
        continue;
      }

      const normalized = safeNormalize(relative);
      if (
        !normalized ||
        normalized === SKILL_FILE_NAME ||
        !isAllowedResourcePath(normalized)
      ) {
        continue;
      }

      resourceCount += 1;
      if (resourceCount > RESOURCES_PER_SKILL_MAX) {
        errors.push(
          `${target.slug}: more than ${RESOURCES_PER_SKILL_MAX} resource files`,
        );
        return errors;
      }
      if (item.size !== null && item.size > RESOURCE_MAX_BYTES) {
        errors.push(
          `${target.slug}: resource ${normalized} is ${item.size} bytes, exceeds the ${RESOURCE_MAX_BYTES} install limit`,
        );
      }
      if (item.size !== null) {
        totalBytes += item.size;
        if (totalBytes > TOTAL_MAX_BYTES) {
          errors.push(
            `${target.slug}: resource files exceed ${TOTAL_MAX_BYTES} bytes in total`,
          );
          return errors;
        }
      }
    }
  }

  return errors;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const collectGithubTargets = (): GithubTarget[] =>
  loadCatalogue()
    .filter(isGithubSkillEntry)
    .map((entry) => ({
      directory: entry.directory ?? "",
      repo: entry.repo,
      rev: entry.rev,
      slug: entry.slug,
    }));

const run = async (): Promise<string[]> => {
  const targets = collectGithubTargets();
  const errors: string[] = [];

  for (const target of targets) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential sweep keeps the GitHub API request rate low
      const fileErrors = await checkSkillFile(target);
      // Skip the resource enumeration when SKILL.md itself is broken:
      // the entry already fails, and the extra API calls add nothing.
      const resourceErrors =
        fileErrors.length > 0
          ? []
          : // oxlint-disable-next-line no-await-in-loop -- sequential sweep keeps the GitHub API request rate low
            await checkResources(target);
      errors.push(...fileErrors, ...resourceErrors);
    } catch (error) {
      errors.push(
        `${target.slug}: pinned-content check failed (${errorMessage(error)})`,
      );
    }
  }

  return errors;
};

if (import.meta.main) {
  const errors = await run();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`✗ ${error}`);
    }
    console.error(`Pinned-content check failed (${errors.length} error(s)).`);
    process.exitCode = 1;
  } else {
    console.log("✓ Pinned content OK for all github-sourced catalogue skills");
  }
}
