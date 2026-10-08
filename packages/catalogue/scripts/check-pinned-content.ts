/** Validate committed pinned-content facts offline; --refresh acquires and replaces facts. */
import { Result } from "better-result";

import { isAllowedResourcePath, normalizeResourcePath } from "@stll/skills";
import {
  SKILL_NAME_PATTERN,
  SKILL_PACKAGE_LIMITS,
} from "@stll/skills/package-limits";

import { isGithubSkillEntry, loadCatalogue } from "../src/loader";
import { catalogueLicensesMatch, type CatalogueLicense } from "../src/schema";
import {
  PinnedContentError,
  assertCompleteGithubContentsListing,
  readPinnedSnapshot,
  recordingPinnedSource,
  writePinnedSnapshot,
  type FrontmatterFacts,
  type GithubTarget,
  type GithubContentItem,
  type PinnedSource,
} from "./pinned-content-facts";

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
  length: number;
};

const frontmatterFieldLimitError = (
  slug: string,
  { field, limit, length }: FrontmatterFieldLimit,
): string | null => {
  if (length <= limit) {
    return null;
  }
  return `${slug}: frontmatter ${field} is ${length} chars, exceeds the ${limit} install limit`;
};

export const checkFrontmatterLimits = (
  slug: string,
  metadata: FrontmatterFacts,
): string[] => {
  const errors: string[] = [];
  const fields: FrontmatterFieldLimit[] = [
    {
      field: "description",
      limit: SKILL_PACKAGE_LIMITS.descriptionMaxChars,
      length: metadata.descriptionUtf16Length,
    },
    {
      field: "version",
      limit: SKILL_PACKAGE_LIMITS.versionMaxChars,
      length: metadata.versionUtf16Length,
    },
    {
      field: "license",
      limit: SKILL_PACKAGE_LIMITS.licenseMaxChars,
      length: metadata.licenseUtf16Length,
    },
    {
      field: "compatibility",
      limit: SKILL_PACKAGE_LIMITS.compatibilityMaxChars,
      length: metadata.compatibilityUtf16Length,
    },
  ];
  for (const field of fields) {
    const error = frontmatterFieldLimitError(slug, field);
    if (error) {
      errors.push(error);
    }
  }

  const entries = metadata.metadata;
  if (entries.length > SKILL_PACKAGE_LIMITS.metadataEntriesMax) {
    errors.push(
      `${slug}: frontmatter metadata has ${entries.length} entries, exceeds the ${SKILL_PACKAGE_LIMITS.metadataEntriesMax} install limit`,
    );
  }
  for (const [
    index,
    { keyUtf16Length, valueUtf16Length },
  ] of entries.entries()) {
    if (keyUtf16Length > SKILL_PACKAGE_LIMITS.metadataKeyMaxChars) {
      errors.push(
        `${slug}: frontmatter metadata key #${index} is ${keyUtf16Length} chars, exceeds the ${SKILL_PACKAGE_LIMITS.metadataKeyMaxChars} install limit`,
      );
    }
    if (valueUtf16Length > SKILL_PACKAGE_LIMITS.metadataValueMaxChars) {
      errors.push(
        `${slug}: frontmatter metadata value for key #${index} is ${valueUtf16Length} chars, exceeds the ${SKILL_PACKAGE_LIMITS.metadataValueMaxChars} install limit`,
      );
    }
  }
  return errors;
};

type PinnedLicenseMismatchInput = {
  catalogueLicense: CatalogueLicense;
  slug: string;
  upstreamLicense: string | null | undefined;
};

export const pinnedLicenseMismatchError = ({
  catalogueLicense,
  slug,
  upstreamLicense,
}: PinnedLicenseMismatchInput): string | null => {
  if (
    catalogueLicensesMatch({
      catalogueLicense,
      upstreamLicense,
    })
  ) {
    return null;
  }
  return `${slug}: frontmatter license does not match the reviewed catalogue manifest`;
};

type ResourceContentLimitInput = {
  utf16Length: number;
  path: string;
  slug: string;
};

export const resourceContentLimitError = ({
  utf16Length,
  path,
  slug,
}: ResourceContentLimitInput): string | null => {
  if (utf16Length <= SKILL_PACKAGE_LIMITS.resourceMaxChars) {
    return null;
  }
  return `${slug}: resource ${path} is ${utf16Length} chars, exceeds the ${SKILL_PACKAGE_LIMITS.resourceMaxChars} install limit`;
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

/** Enforce install limits on facts produced by the real skill parser. */
type SkillFileCheckResult = {
  byteLength: number;
  errors: string[];
};

const checkSkillFile = async (
  target: GithubTarget,
  source: PinnedSource,
): Promise<SkillFileCheckResult> => {
  const file = await source.skill(target);
  if (file === null) {
    return {
      byteLength: 0,
      errors: [`${target.slug}: SKILL.md not found at pinned rev`],
    };
  }

  const errors: string[] = [];
  if (file.byteLength > RESOURCE_MAX_BYTES) {
    errors.push(
      `${target.slug}: SKILL.md exceeds the ${RESOURCE_MAX_BYTES} byte install limit`,
    );
  }
  if (file.frontmatter.descriptionUtf16Length === 0) {
    errors.push(`${target.slug}: SKILL.md description must be nonempty`);
  }
  if (!SKILL_NAME_PATTERN.test(file.frontmatter.name)) {
    errors.push(
      `${target.slug}: frontmatter name "${file.frontmatter.name}" fails the skill name pattern`,
    );
  }
  if (file.bodyUtf16Length > SKILL_PACKAGE_LIMITS.bodyMaxChars) {
    errors.push(
      `${target.slug}: SKILL.md body is ${file.bodyUtf16Length} chars, exceeds the ${SKILL_PACKAGE_LIMITS.bodyMaxChars} install limit`,
    );
  }
  const licenseError = pinnedLicenseMismatchError({
    catalogueLicense: target.license,
    slug: target.slug,
    upstreamLicense: file.frontmatter.license,
  });
  if (licenseError) {
    errors.push(licenseError);
  }
  errors.push(...checkFrontmatterLimits(target.slug, file.frontmatter));
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
  source: PinnedSource,
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

    const resource = await source.resource({ path: item.path, target });
    if (resource === null) {
      throw new PinnedContentError({
        message: `resource ${normalized} disappeared during validation`,
      });
    }
    if (resource.byteLength > RESOURCE_MAX_BYTES) {
      errors.push(
        `${target.slug}: resource ${normalized} exceeds the ${RESOURCE_MAX_BYTES} byte install limit`,
      );
    }
    const contentLimitError = resourceContentLimitError({
      utf16Length: resource.utf16Length,
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
    const listing = await source.directory({ directory, target });
    assertCompleteGithubContentsListing({
      itemCount: listing.itemCount,
      repoRelativePath: directory,
    });
    const shouldContinue = await processItems(listing.items, 0);
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

export const collectGithubTargets = (): GithubTarget[] =>
  loadCatalogue()
    .filter(isGithubSkillEntry)
    .map((entry) => ({
      directory: entry.directory ?? "",
      license: entry.license,
      repo: entry.repo,
      rev: entry.rev,
      slug: entry.slug,
    }));

export const validatePinnedSource = async (
  source: PinnedSource,
): Promise<string[]> => {
  const targets = collectGithubTargets();
  const errors: string[] = [];

  const checkTarget = async (target: GithubTarget): Promise<void> => {
    try {
      const skillFile = await checkSkillFile(target, source);
      // Resource validation depends on a valid skill file.
      let resourceErrors: string[] = [];
      if (skillFile.errors.length === 0) {
        resourceErrors = await checkResources(
          target,
          skillFile.byteLength,
          source,
        );
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
  const refresh = Bun.argv.includes("--refresh");
  const result = await Result.tryPromise({
    try: async () => {
      if (
        refresh &&
        (Bun.argv.includes("--check") || Bun.argv.includes("--from-snapshot"))
      ) {
        throw new PinnedContentError({
          message: "--refresh cannot be combined with offline check modes",
        });
      }
      if (!refresh) {
        return await validatePinnedSource(
          await readPinnedSnapshot(collectGithubTargets()),
        );
      }
      const { upstreamPinnedSource } =
        await import("./pinned-content-upstream");
      const recording = recordingPinnedSource(upstreamPinnedSource);
      const errors = await validatePinnedSource(recording.source);
      if (errors.length === 0) {
        await writePinnedSnapshot(recording.entries());
      }
      return errors;
    },
    catch: (error) => error,
  });
  const errors = result.isErr() ? [errorMessage(result.error)] : result.value;
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
