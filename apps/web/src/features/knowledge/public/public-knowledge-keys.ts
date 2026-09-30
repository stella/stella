/**
 * Catalogue reads: the same bytes for every visitor, keyed under their own
 * audience so no entry is ever shared with an organization's own Knowledge.
 */
export const publicKnowledgeKeys = {
  all: ["knowledge", "public"] as const,
  templates: {
    all: () => [...publicKnowledgeKeys.all, "templates"] as const,
    catalogue: () =>
      [...publicKnowledgeKeys.templates.all(), "catalogue"] as const,
    detail: (packId: string, templateId: string) =>
      [
        ...publicKnowledgeKeys.templates.all(),
        packId,
        templateId,
        "detail",
      ] as const,
    preview: (packId: string, templateId: string) =>
      [
        ...publicKnowledgeKeys.templates.all(),
        packId,
        templateId,
        "preview",
      ] as const,
  },
  playbooks: {
    starters: () =>
      [...publicKnowledgeKeys.all, "playbooks", "starters"] as const,
  },
};
