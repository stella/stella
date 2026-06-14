import type {
  ChatTab,
  InspectorTab,
} from "@/components/inspector/inspector-store";

export type ActiveSkillChatContext = NonNullable<ChatTab["activeSkill"]>;

type ActiveSkillCatalogueEntry = {
  chatSkillId: string | null;
  displayName: string;
  kind: string;
  slug: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isActiveSkillChatContext = (
  value: unknown,
): value is ActiveSkillChatContext => {
  if (!isRecord(value) || typeof value["skillName"] !== "string") {
    return false;
  }

  const skillId = value["skillId"];
  return skillId === undefined || typeof skillId === "string";
};

const getToolDetailActiveSkillContext = (
  payload: unknown,
  catalogueEntries?: readonly ActiveSkillCatalogueEntry[],
): ActiveSkillChatContext | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }

  if (catalogueEntries !== undefined) {
    const kind = payload["kind"];
    const slug = payload["slug"];
    if (kind !== "skill" || typeof slug !== "string") {
      return undefined;
    }

    const entry = catalogueEntries.find(
      (candidate) => candidate.kind === "skill" && candidate.slug === slug,
    );
    if (!entry || entry.chatSkillId === null) {
      return undefined;
    }

    return {
      skillId: entry.chatSkillId,
      skillName: entry.displayName,
    };
  }

  const activeSkill = payload["activeSkill"];
  return isActiveSkillChatContext(activeSkill) ? activeSkill : undefined;
};

export const getActiveSkillChatContext = (
  tab: InspectorTab | undefined,
  catalogueEntries?: readonly ActiveSkillCatalogueEntry[],
): ActiveSkillChatContext | undefined => {
  if (tab?.type === "skill-resource") {
    return {
      ...(tab.skillId === null ? {} : { skillId: tab.skillId }),
      skillName: tab.skillName,
    };
  }

  if (tab?.type === "chat") {
    return tab.activeSkill;
  }

  if (tab?.type === "view" && tab.viewType === "tool-detail") {
    return getToolDetailActiveSkillContext(tab.payload, catalogueEntries);
  }

  return undefined;
};
