import { unreachable } from "@/api/lib/errors/tagged-errors";

import {
  canonicalizeGithubCommitSkillUrl,
  type SkillSourceIntegrity,
} from "./skill-package";

type SkillImportItem = {
  integrity: SkillSourceIntegrity;
  sourceUrl: string;
};

type DeduplicateSkillImportItemsResult = {
  failed: { message: string; sourceUrl: string }[];
  items: SkillImportItem[];
};

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

export const deduplicateSkillImportItems = (
  requestedItems: readonly SkillImportItem[],
): DeduplicateSkillImportItemsResult => {
  const failed: { message: string; sourceUrl: string }[] = [];
  const conflictingSourceUrls = new Set<string>();
  const itemsBySourceUrl = new Map<string, SkillImportItem>();
  for (const item of requestedItems) {
    const requestedSourceUrl = item.sourceUrl.trim();
    let sourceUrl: string | null = requestedSourceUrl;
    let integrity = item.integrity;
    if (integrity.type === "github-commit") {
      sourceUrl = canonicalizeGithubCommitSkillUrl({
        commitSha: integrity.value,
        rawUrl: requestedSourceUrl,
      });
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
        message: "Skill source changed after discovery; review it again",
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
      message: "Duplicate skill URL has conflicting integrity values",
      sourceUrl,
    });
  }
  return { failed, items: [...itemsBySourceUrl.values()] };
};
