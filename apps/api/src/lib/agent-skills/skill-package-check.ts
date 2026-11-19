import { panic } from "better-result";

import {
  SKILL_FILE_NAME,
  SKILL_PACKAGE_LIMITS,
  type SkillPackageDiagnostic,
  type SkillPackageFile,
  type SkippedSkillPackageFile,
  validateSkillPackage,
} from "@stll/skills/format";
import { parseSkillFile } from "@stll/skills/frontmatter";

import { skillRequirableToolNames } from "@/api/lib/agent-skills/required-tools-validation";

/** One resource file as a chat tool writes it. */
export type SkillPackageResourceInput = { content: string; path: string };

/**
 * A file of the package: `text` is in hand and checked whole; `stored` is
 * already saved and was checked when it was written, so it is checked by its
 * path and size without reading its content back into the API.
 */
export type SkillPackageEntry =
  | { type: "text"; content: string; path: string }
  | { type: "stored"; chars: number; path: string; sizeBytes: number };

/** A whole package: its SKILL.md and every file beside it. */
export type SkillPackageInput = {
  resources: readonly SkillPackageEntry[];
  skillMd: string;
};

const SKILL_PACKAGE_CHECK_STATUS = {
  accepted: "accepted",
  rejected: "rejected",
} as const;

type SkillPackageCheckStatus =
  (typeof SKILL_PACKAGE_CHECK_STATUS)[keyof typeof SKILL_PACKAGE_CHECK_STATUS];

type ExplainedDiagnostic = SkillPackageDiagnostic & { message: string };

/** What a check of a package found, in the shape a model reads. */
export type SkillPackageCheck = {
  status: SkillPackageCheckStatus;
  /** Every problem, missing references included; empty when accepted. */
  diagnostics: ExplainedDiagnostic[];
  /** Backticked paths in SKILL.md that name no file of the package yet. */
  missingReferences: string[];
  /** SKILL.md's frontmatter, or null when it cannot be read. */
  skill: {
    compatibility: string | null;
    description: string;
    descriptionChars: number;
    invocation: "auto" | "manual";
    license: string | null;
    metadata: Record<string, string>;
    name: string;
    version: string | null;
  } | null;
  bodyChars: number | null;
  resources: { chars: number; path: string }[];
  /** Files left out because they are not text. */
  skipped: SkippedSkillPackageFile[];
  totals: { chars: number; files: number };
  limits: {
    bodyMaxChars: number;
    descriptionMaxChars: number;
    resourceMaxChars: number;
    resourcesPerSkillMax: number;
  };
};

/**
 * Each diagnostic as a sentence that names the fix, so the model's next call
 * repairs the package instead of guessing.
 */
const explainDiagnostic = (diagnostic: SkillPackageDiagnostic): string => {
  switch (diagnostic.type) {
    case "entrypoint_missing":
      return "The package has no SKILL.md.";
    case "frontmatter_invalid":
      return `SKILL.md frontmatter: ${diagnostic.message}. It needs a YAML block between --- lines with at least name and description.`;
    case "limit_exceeded":
      return `${diagnostic.field} exceeds its limit of ${String(diagnostic.limit)}; shorten it or move text into a references/ file.`;
    case "bidi_control":
      return `${diagnostic.field} contains bidirectional formatting characters; remove them.`;
    case "name_invalid":
      return `Name "${diagnostic.name}" is not a valid skill name: use 1-64 lowercase letters, digits and single hyphens, such as contract-review.`;
    case "metadata_key_unknown":
      return `Metadata key ${diagnostic.key} is not one stella reads; remove it or drop the stella- prefix.`;
    case "metadata_value_invalid":
      return `Metadata ${diagnostic.key} has no valid value.`;
    case "required_tool_unknown":
      return `stella-required-tools names ${diagnostic.tool}, which is not a stella tool; remove it.`;
    case "resource_path_invalid":
      return `File path ${diagnostic.path} is not allowed: use a relative path with / separators, such as references/topic.md.`;
    case "resource_duplicate":
      return `File path ${diagnostic.path} collides with another file of the package (paths that differ only by case count as one).`;
    case "resource_reference_missing":
      return `SKILL.md names ${diagnostic.path}, which the package does not hold; add the file or fix the path.`;
    default:
      diagnostic satisfies never;
      return panic("Unknown skill package diagnostic");
  }
};

const readSkillSummary = (
  skillMd: string,
): Pick<SkillPackageCheck, "bodyChars" | "skill"> => {
  const parsed = parseSkillFile(skillMd);
  if (parsed.isErr()) {
    return { bodyChars: null, skill: null };
  }
  const { body, metadata } = parsed.value;
  return {
    bodyChars: body.length,
    skill: {
      compatibility: metadata.compatibility ?? null,
      description: metadata.description,
      descriptionChars: metadata.description.length,
      invocation: metadata.invocation,
      license: metadata.license ?? null,
      metadata: metadata.metadata ?? {},
      name: metadata.name,
      version: metadata.version,
    },
  };
};

const entryFile = (entry: SkillPackageEntry): SkillPackageFile => {
  switch (entry.type) {
    case "text":
      return { content: entry.content, path: entry.path };
    case "stored":
      return { content: "", path: entry.path, sizeBytes: entry.sizeBytes };
    default:
      entry satisfies never;
      return panic("Unknown skill package entry");
  }
};

const entryChars = (entry: SkillPackageEntry): number =>
  entry.type === "text" ? entry.content.length : entry.chars;

/** The package as the files `validateSkillPackage` reads. */
const skillPackageFiles = ({
  resources,
  skillMd,
}: SkillPackageInput): SkillPackageFile[] => [
  { content: skillMd, path: SKILL_FILE_NAME },
  ...resources.map(entryFile),
];

/**
 * Check a package exactly as every install path does (`validateSkillPackage`
 * with stella's tool names), and describe it: frontmatter, sizes, files and
 * every diagnostic with its fix.
 */
export const checkSkillPackage = (
  input: SkillPackageInput,
): SkillPackageCheck => {
  const validated = validateSkillPackage({
    files: skillPackageFiles(input),
    tools: { known: skillRequirableToolNames(), type: "check" },
  });
  const diagnostics = validated.isErr() ? validated.error : [];
  const skipped = validated.isOk() ? [...validated.value.skipped] : [];
  const resources = input.resources
    .map((entry) => ({ chars: entryChars(entry), path: entry.path }))
    .toSorted((left, right) => (left.path < right.path ? -1 : 1));
  return {
    status:
      diagnostics.length === 0
        ? SKILL_PACKAGE_CHECK_STATUS.accepted
        : SKILL_PACKAGE_CHECK_STATUS.rejected,
    diagnostics: diagnostics.map((diagnostic) => ({
      ...diagnostic,
      message: explainDiagnostic(diagnostic),
    })),
    missingReferences: diagnostics.flatMap((diagnostic) =>
      diagnostic.type === "resource_reference_missing" ? [diagnostic.path] : [],
    ),
    ...readSkillSummary(input.skillMd),
    resources,
    skipped,
    totals: {
      chars:
        input.skillMd.length +
        resources.reduce((total, { chars }) => total + chars, 0),
      files: resources.length + 1,
    },
    limits: {
      bodyMaxChars: SKILL_PACKAGE_LIMITS.bodyMaxChars,
      descriptionMaxChars: SKILL_PACKAGE_LIMITS.descriptionMaxChars,
      resourceMaxChars: SKILL_PACKAGE_LIMITS.resourceMaxChars,
      resourcesPerSkillMax: SKILL_PACKAGE_LIMITS.resourcesPerSkillMax,
    },
  };
};

/**
 * Diagnostics that stop a save. A missing reference does not: a large
 * package arrives over several calls, and SKILL.md may name files a later
 * call sends.
 */
export const blockingSkillPackageDiagnostics = (
  check: SkillPackageCheck,
): ExplainedDiagnostic[] =>
  check.diagnostics.filter(
    (diagnostic) => diagnostic.type !== "resource_reference_missing",
  );
