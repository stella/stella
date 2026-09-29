import type { LoadedCatalogueEntry } from "@stll/catalogue";

import type {
  KnowledgeTool,
  KnowledgeToolDetail,
} from "@/features/knowledge/views/tools/tools-seam";

/**
 * A published catalogue entry as the shared tool views render it. What only
 * an organization knows (whether it is recommended, installed or connected)
 * is left out.
 */
export const toKnowledgeTool = (
  entry: LoadedCatalogueEntry,
): KnowledgeTool => ({
  slug: entry.slug,
  kind: entry.kind,
  displayName: entry.displayName,
  description: entry.description,
  author: entry.author,
  cost: entry.cost,
  setup: entry.setup,
  icon: entry.icon,
  iconUrl: entry.iconUrl ?? null,
  jurisdictions: entry.jurisdictions,
  tags: entry.tags,
});

export const toKnowledgeToolDetail = (
  entry: LoadedCatalogueEntry,
): KnowledgeToolDetail => ({
  ...toKnowledgeTool(entry),
  authorUrl: entry.authorUrl,
  homepage: entry.homepage,
  license: entry.license,
});
