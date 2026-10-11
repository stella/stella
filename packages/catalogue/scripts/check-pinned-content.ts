/** Validate committed pinned-content facts offline; --refresh acquires and replaces facts. */
import { panic, Result } from "better-result";

import {
  SKILL_FILE_NAME,
  SKILL_RESOURCE_FOLDERS,
  validateSkillPackage,
  type SkillPackageDiagnostic,
  type SkillPackageFile,
} from "@stll/skills/format";

import { catalogueLicensesMatch, type CatalogueLicense } from "../src/schema";
import {
  PinnedContentError,
  assertCompleteGithubContentsListing,
  collectGithubTargets,
  readPinnedSnapshot,
  recordingPinnedSource,
  syntheticSkillSource,
  writePinnedSnapshot,
  type GithubTarget,
  type PinnedSource,
} from "./pinned-content-facts";

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
  if (catalogueLicensesMatch({ catalogueLicense, upstreamLicense })) {
    return null;
  }
  return `${slug}: frontmatter license does not match the reviewed catalogue manifest`;
};

const diagnosticMessage = (
  slug: string,
  diagnostic: SkillPackageDiagnostic,
): string => {
  switch (diagnostic.type) {
    case "entrypoint_missing":
      return `${slug}: SKILL.md not found at pinned rev`;
    case "frontmatter_invalid":
      return `${slug}: SKILL.md frontmatter is invalid (${diagnostic.message})`;
    case "limit_exceeded":
      return `${slug}: ${diagnostic.field} exceeds the ${diagnostic.limit} install limit`;
    case "bidi_control":
      return `${slug}: ${diagnostic.field} contains a bidirectional control character`;
    case "name_invalid":
      return `${slug}: frontmatter name "${diagnostic.name}" fails the skill name pattern`;
    case "metadata_key_unknown":
      return `${slug}: unknown stella metadata key "${diagnostic.key}"`;
    case "metadata_value_invalid":
      return `${slug}: invalid value for metadata key "${diagnostic.key}"`;
    case "required_tool_unknown":
      return `${slug}: unknown required tool "${diagnostic.tool}"`;
    case "resource_path_invalid":
      return `${slug}: invalid resource path ${diagnostic.path}`;
    case "resource_duplicate":
      return `${slug}: duplicate normalized resource path ${diagnostic.path}`;
    case "resource_reference_missing":
      return `${slug}: referenced resource ${diagnostic.path} is missing`;
    default: {
      diagnostic satisfies never;
      return panic("Unknown skill package diagnostic");
    }
  }
};

const collectPinnedFiles = async (
  target: GithubTarget,
  source: PinnedSource,
): Promise<SkillPackageFile[]> => {
  const skill = await source.skill(target);
  if (skill === null) {
    return [];
  }
  const files: SkillPackageFile[] = [
    {
      content: syntheticSkillSource(
        skill.frontmatter,
        skill.bodyUtf16Length,
        skill.referencedResourcePaths,
      ),
      path: `${target.directory ? `${target.directory}/` : ""}${SKILL_FILE_NAME}`,
      sizeBytes: skill.byteLength,
    },
  ];
  const pending = [target.directory];
  const queued = new Set(pending);
  const resourceFolders = SKILL_RESOURCE_FOLDERS;

  while (pending.length > 0) {
    const directory = pending.shift();
    if (directory === undefined) {
      break;
    }
    const listing = await source.directory({ directory, target });
    assertCompleteGithubContentsListing({
      itemCount: listing.itemCount,
      repoRelativePath: directory,
    });
    for (const item of listing.items) {
      const relative = relativeToSkillRoot(target.directory, item.path);
      if (relative === null) {
        continue;
      }
      if (item.type === "dir") {
        const root = relative.split("/").at(0);
        if (root && resourceFolders.has(root) && !queued.has(item.path)) {
          queued.add(item.path);
          pending.push(item.path);
        }
        continue;
      }
      if (item.type !== "file" || relative === SKILL_FILE_NAME) {
        continue;
      }
      const root = relative.split("/").at(0);
      if (!root || !resourceFolders.has(root)) {
        continue;
      }
      const resource = await source.resource({ path: item.path, target });
      if (resource === null) {
        throw new PinnedContentError({
          message: `resource ${relative} disappeared during validation`,
        });
      }
      files.push({
        content: "x".repeat(resource.utf16Length),
        path: item.path,
        sizeBytes: resource.byteLength,
      });
    }
  }
  return files;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const validatePinnedSource = async (
  source: PinnedSource,
): Promise<string[]> => {
  const errors: string[] = [];
  for (const target of collectGithubTargets()) {
    const checked = await Result.tryPromise({
      try: async () => {
        const files = await collectPinnedFiles(target, source);
        const validated = validateSkillPackage({
          files,
          tools: { type: "deferred" },
        });
        if (validated.isErr()) {
          return validated.error.map((diagnostic) =>
            diagnosticMessage(target.slug, diagnostic),
          );
        }
        const packageErrors: string[] = [];
        if (validated.value.metadata.name !== target.slug) {
          packageErrors.push(
            `${target.slug}: frontmatter name "${validated.value.metadata.name}" must match the catalogue id`,
          );
        }
        const licenseError = pinnedLicenseMismatchError({
          catalogueLicense: target.license,
          slug: target.slug,
          upstreamLicense: validated.value.metadata.license,
        });
        if (licenseError) {
          packageErrors.push(licenseError);
        }
        return packageErrors;
      },
      catch: (error) => error,
    });
    if (checked.isErr()) {
      errors.push(
        `${target.slug}: pinned-content check failed (${errorMessage(checked.error)})`,
      );
    } else {
      errors.push(...checked.value);
    }
  }
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
