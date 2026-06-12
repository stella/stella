import type {
  ChatTab,
  InspectorTab,
} from "@/components/inspector/inspector-store";

export type ActiveSkillChatContext = NonNullable<ChatTab["activeSkill"]>;

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
): ActiveSkillChatContext | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }

  const activeSkill = payload["activeSkill"];
  return isActiveSkillChatContext(activeSkill) ? activeSkill : undefined;
};

export const getActiveSkillChatContext = (
  tab: InspectorTab | undefined,
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
    return getToolDetailActiveSkillContext(tab.payload);
  }

  return undefined;
};
