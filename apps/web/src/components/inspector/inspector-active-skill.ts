import { BUILT_IN_SKILL_ORIGIN } from "@/components/inspector/inspector-store-types";
import type { SkillResourceTab } from "@/components/inspector/inspector-store-types";
import type {
  ChatTab,
  InspectorTab,
} from "@/components/inspector/inspector-tabs-store";

export type ActiveSkillChatContext = NonNullable<ChatTab["activeSkill"]>;

type ActiveSkillCatalogueEntry = {
  chatSkillId: string | null;
  displayName: string;
  kind: string;
  slug: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

/** Whether stored or broadcast JSON is a chat's active skill. */
export const isActiveSkillContext = (
  value: unknown,
): value is ActiveSkillChatContext =>
  isRecord(value) &&
  typeof value["skillName"] === "string" &&
  isOptionalString(value["skillId"]) &&
  isOptionalString(value["skillDisplayName"]);

/** An installed skill's chat context: one with a row to name by `skillId`. */
const isInstalledActiveSkillContext = (
  value: unknown,
): value is ActiveSkillChatContext & { skillId: string } =>
  isActiveSkillContext(value) && typeof value.skillId === "string";

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
      skillDisplayName: entry.displayName,
      skillId: entry.chatSkillId,
      skillName: entry.slug,
    };
  }

  const activeSkill = payload["activeSkill"];
  return isInstalledActiveSkillContext(activeSkill) ? activeSkill : undefined;
};

/** The skill a skill-resource tab belongs to, named as a chat names it. */
export const skillResourceTabSkill = (
  tab: SkillResourceTab,
): ActiveSkillChatContext =>
  tab.origin === BUILT_IN_SKILL_ORIGIN
    ? { skillName: tab.skillName }
    : {
        skillId: tab.skillId,
        skillName: tab.skillName,
        ...(tab.skillDisplayName === undefined
          ? {}
          : { skillDisplayName: tab.skillDisplayName }),
      };

export const getActiveSkillChatContext = (
  tab: InspectorTab | undefined,
  catalogueEntries?: readonly ActiveSkillCatalogueEntry[],
): ActiveSkillChatContext | undefined => {
  if (tab?.type === "skill-resource") {
    return skillResourceTabSkill(tab);
  }

  if (tab?.type === "chat") {
    return tab.activeSkill;
  }

  if (tab?.type === "view" && tab.viewType === "tool-detail") {
    return getToolDetailActiveSkillContext(tab.payload, catalogueEntries);
  }

  return undefined;
};
