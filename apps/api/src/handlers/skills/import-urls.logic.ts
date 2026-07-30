import { unreachable } from "@/api/lib/errors/tagged-errors";

import {
  canonicalizeGithubCommitSkillUrl,
  type SkillSourceIntegrity,
} from "./skill-package";

type SkillImportItem = {
  integrity: SkillSourceIntegrity;
  sourceUrl: string;
};

type DeduplicatedSkillImportItem = SkillImportItem & {
  reportedSourceUrl: string;
};

export const SKILL_IMPORT_FAILURE_CODE = {
  FETCH_FAILED: "fetch_failed",
  INSTALL_FAILED: "install_failed",
  INTEGRITY_CONFLICT: "integrity_conflict",
  INTEGRITY_MISMATCH: "integrity_mismatch",
  NAME_CONFLICT: "name_conflict",
  SOURCE_CHANGED: "source_changed",
  TEAM_LIMIT_REACHED: "team_limit_reached",
  USER_LIMIT_REACHED: "user_limit_reached",
} as const;

export type SkillImportFailureCode =
  (typeof SKILL_IMPORT_FAILURE_CODE)[keyof typeof SKILL_IMPORT_FAILURE_CODE];

export type SkillImportFailure = {
  code: SkillImportFailureCode;
  sourceUrl: string;
};

type DeduplicateSkillImportItemsResult = {
  failed: SkillImportFailure[];
  items: DeduplicatedSkillImportItem[];
};

export const skillImportRequestBudget = ({
  maxGithubDirectories,
  maxImports,
  maxResourcesPerSkill,
}: {
  maxGithubDirectories: number;
  maxImports: number;
  maxResourcesPerSkill: number;
}): number =>
  maxImports * (maxGithubDirectories + 2 * maxResourcesPerSkill + 2);

const skillIntegrityKey = (integrity: SkillSourceIntegrity): string => {
  switch (integrity.type) {
    case "content-hash":
      return `${integrity.type}:${integrity.value}`;
    case "github-commit":
      return `${integrity.type}:${integrity.value}:${integrity.entrypointHash}:${integrity.sourceUrl}`;
    default:
      return unreachable("Unknown skill source integrity type");
  }
};

const canonicalizeContentHashSkillUrl = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).toString();
  } catch {
    return rawUrl;
  }
};

export const deduplicateSkillImportItems = (
  requestedItems: readonly SkillImportItem[],
): DeduplicateSkillImportItemsResult => {
  const failed: SkillImportFailure[] = [];
  const conflictingSourceUrls = new Set<string>();
  const itemsBySourceUrl = new Map<string, DeduplicatedSkillImportItem>();
  for (const item of requestedItems) {
    const requestedSourceUrl = item.sourceUrl.trim();
    let integrity = item.integrity;
    let sourceUrl =
      integrity.type === "content-hash"
        ? canonicalizeContentHashSkillUrl(requestedSourceUrl)
        : canonicalizeGithubCommitSkillUrl({
            commitSha: integrity.value,
            rawUrl: requestedSourceUrl,
          });
    if (integrity.type === "github-commit") {
      const integritySourceUrl = canonicalizeGithubCommitSkillUrl({
        commitSha: integrity.value,
        rawUrl: integrity.sourceUrl,
      });
      if (sourceUrl !== integritySourceUrl) {
        sourceUrl = null;
      } else if (integritySourceUrl !== null) {
        integrity = { ...integrity, sourceUrl: integritySourceUrl };
      }
    }
    if (sourceUrl === null) {
      failed.push({
        code: SKILL_IMPORT_FAILURE_CODE.SOURCE_CHANGED,
        sourceUrl: requestedSourceUrl,
      });
      continue;
    }
    if (conflictingSourceUrls.has(sourceUrl)) {
      continue;
    }
    const existing = itemsBySourceUrl.get(sourceUrl);
    if (!existing) {
      itemsBySourceUrl.set(sourceUrl, {
        integrity,
        reportedSourceUrl: requestedSourceUrl,
        sourceUrl,
      });
      continue;
    }
    if (
      skillIntegrityKey(existing.integrity) === skillIntegrityKey(integrity)
    ) {
      continue;
    }
    itemsBySourceUrl.delete(sourceUrl);
    conflictingSourceUrls.add(sourceUrl);
    failed.push({
      code: SKILL_IMPORT_FAILURE_CODE.INTEGRITY_CONFLICT,
      sourceUrl: existing.reportedSourceUrl,
    });
  }
  const contentHashes = new Set<string>();
  const items = [...itemsBySourceUrl.values()].filter((item) => {
    if (item.integrity.type !== "content-hash") {
      return true;
    }
    if (contentHashes.has(item.integrity.value)) {
      return false;
    }
    contentHashes.add(item.integrity.value);
    return true;
  });
  return { failed, items };
};
