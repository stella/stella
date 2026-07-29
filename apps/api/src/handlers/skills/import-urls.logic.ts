import { unreachable } from "@/api/lib/errors/tagged-errors";

import type { SkillSourceIntegrity } from "./skill-package";

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
      return `${integrity.type}:${integrity.value}:${integrity.entrypointHash}`;
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
    const sourceUrl = item.sourceUrl.trim();
    if (conflictingSourceUrls.has(sourceUrl)) {
      continue;
    }
    const existing = itemsBySourceUrl.get(sourceUrl);
    if (!existing) {
      itemsBySourceUrl.set(sourceUrl, {
        integrity: item.integrity,
        sourceUrl,
      });
      continue;
    }
    if (
      skillIntegrityKey(existing.integrity) ===
      skillIntegrityKey(item.integrity)
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
