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
import type { SkillMetadata } from "@stll/skills";
import {
  SKILL_NAME_PATTERN,
  SKILL_PACKAGE_LIMITS,
} from "@stll/skills/package-limits";
import { readCappedBytes } from "@stll/skills/streaming";

import { isGithubSkillEntry, loadCatalogue } from "../src/loader";

/** Expected per-entry failure while fetching upstream content. */
class PinnedContentError extends TaggedError("PinnedContentError")<{
  message: string;
}>() {}

const FETCH_TIMEOUT_MS = 10_000;
const SKILL_FILE_NAME = "SKILL.md";

const RESOURCE_MAX_BYTES = SKILL_PACKAGE_LIMITS.resourceMaxChars * 4;
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

const toContentItems = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) {
    return payload;
  }
  return isRecord(payload) ? [payload] : [];
};

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

type FetchPinnedTextFileOptions = {
  allowNotFound?: boolean;
  label: string;
  maxBytes: number;
  repoRelativePath: string;
  target: GithubTarget;
};

type PinnedTextFile = {
  byteLength: number;
  content: string;
};

const fetchPinnedTextFile = async ({
  allowNotFound = false,
  label,
  maxBytes,
  repoRelativePath,
  target,
}: FetchPinnedTextFileOptions): Promise<PinnedTextFile | null> => {
  const response = await fetch(rawContentUrl(target, repoRelativePath), {
    headers: githubHeaders("text/plain"),
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 404 && allowNotFound) {
    return null;
  }
  if (!response.ok) {
    throw new PinnedContentError({
      message: `${label} fetch returned HTTP ${response.status}`,
    });
  }
  if (!response.body) {
    throw new PinnedContentError({ message: `${label} response has no body` });
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new PinnedContentError({
      message: `${label} is larger than ${maxBytes} bytes`,
    });
  }
  const bytes = await readCappedBytes(response.body, maxBytes);
  if (bytes === null) {
    throw new PinnedContentError({
      message: `${label} is larger than ${maxBytes} bytes`,
    });
  }
  return { byteLength: bytes.byteLength, content: UTF8_DECODER.decode(bytes) };
};

/**
 * Fetch the pinned `SKILL.md` as text. Returns null on a 404 so the
 * caller can report the specific "not found at pinned rev" failure;
 * every other non-2xx response and any redirect throws.
 */
const fetchSkillFile = async (
  target: GithubTarget,
): Promise<PinnedTextFile | null> =>
  await fetchPinnedTextFile({
    allowNotFound: true,
    label: SKILL_FILE_NAME,
    maxBytes: RESOURCE_MAX_BYTES,
    repoRelativePath: joinRepoPath(target.directory, SKILL_FILE_NAME),
    target,
  });

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
  const items = toContentItems(payload);
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

type FrontmatterFieldLimit = {
  field: string;
  limit: number;
  value: string | null | undefined;
};

const frontmatterFieldLimitError = (
  slug: string,
  { field, limit, value }: FrontmatterFieldLimit,
): string | null => {
  if (!value || value.length <= limit) {
    return null;
  }
  return `${slug}: frontmatter ${field} is ${value.length} chars, exceeds the ${limit} install limit`;
};

export const checkFrontmatterLimits = (
  slug: string,
  metadata: SkillMetadata,
): string[] => {
  const errors: string[] = [];
  const fields: FrontmatterFieldLimit[] = [
    {
      field: "description",
      limit: SKILL_PACKAGE_LIMITS.descriptionMaxChars,
      value: metadata.description,
    },
    {
      field: "version",
      limit: SKILL_PACKAGE_LIMITS.versionMaxChars,
      value: metadata.version,
    },
    {
      field: "license",
      limit: SKILL_PACKAGE_LIMITS.licenseMaxChars,
      value: metadata.license,
    },
    {
      field: "compatibility",
      limit: SKILL_PACKAGE_LIMITS.compatibilityMaxChars,
      value: metadata.compatibility,
    },
  ];
  for (const field of fields) {
    const error = frontmatterFieldLimitError(slug, field);
    if (error) {
      errors.push(error);
    }
  }

  const entries = Object.entries(metadata.metadata ?? {});
  if (entries.length > SKILL_PACKAGE_LIMITS.metadataEntriesMax) {
    errors.push(
      `${slug}: frontmatter metadata has ${entries.length} entries, exceeds the ${SKILL_PACKAGE_LIMITS.metadataEntriesMax} install limit`,
    );
  }
  for (const [key, value] of entries) {
    if (key.length > SKILL_PACKAGE_LIMITS.metadataKeyMaxChars) {
      errors.push(
        `${slug}: frontmatter metadata key "${key}" is ${key.length} chars, exceeds the ${SKILL_PACKAGE_LIMITS.metadataKeyMaxChars} install limit`,
      );
    }
    if (value.length > SKILL_PACKAGE_LIMITS.metadataValueMaxChars) {
      errors.push(
        `${slug}: frontmatter metadata value for "${key}" is ${value.length} chars, exceeds the ${SKILL_PACKAGE_LIMITS.metadataValueMaxChars} install limit`,
      );
    }
  }
  return errors;
};

type ResourceContentLimitInput = {
  content: string;
  path: string;
  slug: string;
};

export const resourceContentLimitError = ({
  content,
  path,
  slug,
}: ResourceContentLimitInput): string | null => {
  if (content.length <= SKILL_PACKAGE_LIMITS.resourceMaxChars) {
    return null;
  }
  return `${slug}: resource ${path} is ${content.length} chars, exceeds the ${SKILL_PACKAGE_LIMITS.resourceMaxChars} install limit`;
};

type ResourcePathLimitInput = {
  path: string;
  slug: string;
};

export const resourcePathLimitError = ({
  path,
  slug,
}: ResourcePathLimitInput): string | null => {
  if (path.length <= SKILL_PACKAGE_LIMITS.resourcePathMaxChars) {
    return null;
  }
  return `${slug}: resource path ${path} is ${path.length} chars, exceeds the ${SKILL_PACKAGE_LIMITS.resourcePathMaxChars} install limit`;
};

type DuplicateResourcePathInput = {
  path: string;
  slug: string;
};

const duplicateResourcePathError = ({
  path,
  slug,
}: DuplicateResourcePathInput): string =>
  `${slug}: duplicate normalized resource path ${path}`;

type RegisterResourcePathInput = {
  path: string;
  seenPaths: Set<string>;
  slug: string;
};

export const registerResourcePath = ({
  path,
  seenPaths,
  slug,
}: RegisterResourcePathInput): string | null => {
  const pathLimitError = resourcePathLimitError({ path, slug });
  if (pathLimitError) {
    return pathLimitError;
  }
  if (seenPaths.has(path)) {
    return duplicateResourcePathError({ path, slug });
  }
  seenPaths.add(path);
  return null;
};

type ArchiveSizeLimitInput = {
  resourceBytes: number;
  skillFileBytes: number;
  slug: string;
};

export const archiveSizeLimitError = ({
  resourceBytes,
  skillFileBytes,
  slug,
}: ArchiveSizeLimitInput): string | null => {
  if (
    resourceBytes + skillFileBytes <=
    SKILL_PACKAGE_LIMITS.archiveUncompressedMaxBytes
  ) {
    return null;
  }
  return `${slug}: skill package exceeds ${SKILL_PACKAGE_LIMITS.archiveUncompressedMaxBytes} bytes in total`;
};

/**
 * Check the pinned `SKILL.md`: fetch it, parse it with the real skill
 * parser (which requires name + description), and enforce the install
 * name pattern and body length. Returns collected error strings.
 */
type SkillFileCheckResult = {
  byteLength: number;
  errors: string[];
};

const checkSkillFile = async (
  target: GithubTarget,
): Promise<SkillFileCheckResult> => {
  const file = await fetchSkillFile(target);
  if (file === null) {
    return {
      byteLength: 0,
      errors: [`${target.slug}: SKILL.md not found at pinned rev`],
    };
  }

  let parsed: ReturnType<typeof parseSkillFile>;
  try {
    parsed = parseSkillFile(file.content);
  } catch (error) {
    return {
      byteLength: file.byteLength,
      errors: [
        `${target.slug}: SKILL.md frontmatter is invalid (${errorMessage(error)})`,
      ],
    };
  }

  const errors: string[] = [];
  if (!SKILL_NAME_PATTERN.test(parsed.metadata.name)) {
    errors.push(
      `${target.slug}: frontmatter name "${parsed.metadata.name}" fails the skill name pattern`,
    );
  }
  if (parsed.body.length > SKILL_PACKAGE_LIMITS.bodyMaxChars) {
    errors.push(
      `${target.slug}: SKILL.md body is ${parsed.body.length} chars, exceeds the ${SKILL_PACKAGE_LIMITS.bodyMaxChars} install limit`,
    );
  }
  errors.push(...checkFrontmatterLimits(target.slug, parsed.metadata));
  return { byteLength: file.byteLength, errors };
};

/**
 * Enumerate the pinned directory's resource files (breadth-first over
 * the allowed resource roots) and enforce the install path's resource
 * count, per-file size, cumulative size, and directory-count limits.
 */
const checkResources = async (
  target: GithubTarget,
  skillFileBytes: number,
): Promise<string[]> => {
  const errors: string[] = [];
  const rootPath = target.directory;
  const pending: string[] = [rootPath];
  const queued = new Set(pending);
  let resourceCount = 0;
  let resourceBytes = 0;
  const resourcePaths = new Set<string>();

  const processItems = async (
    items: readonly GithubContentItem[],
    index: number,
  ): Promise<boolean> => {
    const item = items.at(index);
    if (!item) {
      return true;
    }

    const relative = relativeToSkillRoot(rootPath, item.path);
    if (relative === null) {
      return processItems(items, index + 1);
    }

    if (item.type === "dir") {
      const root = relative.split("/").at(0);
      if (root && SKILL_RESOURCE_ROOTS.has(root) && !queued.has(item.path)) {
        if (queued.size + 1 > SKILL_PACKAGE_LIMITS.githubDirectoriesMax) {
          errors.push(
            `${target.slug}: more than ${SKILL_PACKAGE_LIMITS.githubDirectoriesMax} resource directories`,
          );
          return false;
        }
        queued.add(item.path);
        pending.push(item.path);
      }
      return processItems(items, index + 1);
    }
    if (item.type !== "file") {
      return processItems(items, index + 1);
    }

    const normalized = safeNormalize(relative);
    if (
      !normalized ||
      normalized === SKILL_FILE_NAME ||
      !isAllowedResourcePath(normalized)
    ) {
      return processItems(items, index + 1);
    }

    const pathError = registerResourcePath({
      path: normalized,
      seenPaths: resourcePaths,
      slug: target.slug,
    });
    if (pathError) {
      errors.push(pathError);
      return processItems(items, index + 1);
    }

    resourceCount += 1;
    if (resourceCount > SKILL_PACKAGE_LIMITS.resourcesPerSkillMax) {
      errors.push(
        `${target.slug}: more than ${SKILL_PACKAGE_LIMITS.resourcesPerSkillMax} resource files`,
      );
      return false;
    }
    if (item.size !== null && item.size > RESOURCE_MAX_BYTES) {
      errors.push(
        `${target.slug}: resource ${normalized} is ${item.size} bytes, exceeds the ${RESOURCE_MAX_BYTES} install limit`,
      );
      return processItems(items, index + 1);
    }

    const resource = await fetchPinnedTextFile({
      label: `resource ${normalized}`,
      maxBytes: RESOURCE_MAX_BYTES,
      repoRelativePath: item.path,
      target,
    });
    if (resource === null) {
      throw new PinnedContentError({
        message: `resource ${normalized} disappeared during validation`,
      });
    }
    const contentLimitError = resourceContentLimitError({
      content: resource.content,
      path: normalized,
      slug: target.slug,
    });
    if (contentLimitError) {
      errors.push(contentLimitError);
    }
    resourceBytes += resource.byteLength;
    const archiveLimitError = archiveSizeLimitError({
      resourceBytes,
      skillFileBytes,
      slug: target.slug,
    });
    if (archiveLimitError) {
      errors.push(archiveLimitError);
      return false;
    }
    return processItems(items, index + 1);
  };

  const visitNextDirectory = async (): Promise<void> => {
    const directory = pending.shift();
    if (directory === undefined) {
      return;
    }
    const items = await fetchDirectoryContents(target, directory);
    const shouldContinue = await processItems(items, 0);
    if (!shouldContinue) {
      return;
    }
    return visitNextDirectory();
  };

  await visitNextDirectory();
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

  const checkTarget = async (target: GithubTarget): Promise<void> => {
    try {
      const skillFile = await checkSkillFile(target);
      // Skip the resource enumeration when SKILL.md itself is broken:
      // the entry already fails, and the extra API calls add nothing.
      let resourceErrors: string[] = [];
      if (skillFile.errors.length === 0) {
        resourceErrors = await checkResources(target, skillFile.byteLength);
      }
      errors.push(...skillFile.errors, ...resourceErrors);
    } catch (error) {
      errors.push(
        `${target.slug}: pinned-content check failed (${errorMessage(error)})`,
      );
    }
  };

  const checkNextTarget = async (index: number): Promise<void> => {
    const target = targets.at(index);
    if (!target) {
      return;
    }
    await checkTarget(target);
    return checkNextTarget(index + 1);
  };

  await checkNextTarget(0);
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
