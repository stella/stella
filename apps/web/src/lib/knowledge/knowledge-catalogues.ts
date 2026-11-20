import { toolsCataloguePathOf } from "@/lib/knowledge/public-tools-catalogue-path";

/**
 * Where each Knowledge section's published catalogue lives. The section's own
 * address (`/knowledge/templates`, …) is an organization's page; the
 * catalogue beside it is the same for every visitor, so public links,
 * canonicals and sitemaps name only these.
 */
export const KNOWLEDGE_CATALOGUE_PATHS = {
  templates: "/knowledge/templates/catalogue",
  playbooks: "/knowledge/playbooks/catalogue",
  tools: toolsCataloguePathOf("/knowledge/tools"),
} as const;

export type KnowledgeCataloguePath =
  (typeof KNOWLEDGE_CATALOGUE_PATHS)[keyof typeof KNOWLEDGE_CATALOGUE_PATHS];
