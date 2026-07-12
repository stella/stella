import type { CatalogueEntry } from "./catalogue-types";
import type { ToolDetailKind, ToolDetailPayload } from "./tool-detail-view";

/**
 * Build the inspector tab id for a given catalogue entry. The kind
 * is part of the id because (kind, slug) is the catalogue's actual
 * uniqueness key; using slug alone would collapse an MCP and a skill
 * sharing the same slug onto the same tab.
 */
export const toolDetailTabId = (kind: ToolDetailKind, slug: string): string =>
  `tool-detail:${kind}:${slug}`;

export const getToolDetailPayload = (
  entry: CatalogueEntry,
  organizationId: string,
): ToolDetailPayload => {
  const activeSkill =
    entry.kind === "skill" && entry.chatSkillId !== null
      ? {
          skillId: entry.chatSkillId,
          skillName: entry.displayName,
        }
      : undefined;

  return {
    kind: entry.kind,
    slug: entry.slug,
    organizationId,
    ...(activeSkill === undefined ? {} : { activeSkill }),
    iconHint: {
      icon: entry.icon,
      iconUrl: entry.iconUrl ?? null,
    },
  };
};
