import {
  CHAT_RESOURCE_HREF_PREFIX,
  parseChatResourceHref,
  RESOURCE_TYPE,
} from "@stll/api-contract";
import type { ChatMentionResourceLinkTarget } from "@stll/api-contract";
import type {
  ChatMentionCategory,
  ChatMentionHrefPrefixMap,
} from "@stll/api/types";

export type MentionCategory = ChatMentionCategory;

const CHAT_MENTION_HREF_PREFIXES = {
  entity: CHAT_RESOURCE_HREF_PREFIX.entity,
  workspace: CHAT_RESOURCE_HREF_PREFIX.workspace,
} as const satisfies ChatMentionHrefPrefixMap;

const CHAT_MENTION_HREF_ENTRIES = [
  ["entity", CHAT_MENTION_HREF_PREFIXES.entity],
  ["workspace", CHAT_MENTION_HREF_PREFIXES.workspace],
] as const satisfies readonly (readonly [MentionCategory, string])[];

export const isMentionCategory = (value: string): value is MentionCategory => {
  for (const [category] of CHAT_MENTION_HREF_ENTRIES) {
    if (value === category) {
      return true;
    }
  }

  return false;
};

export const parseStellaMentionHref = (
  href: string,
): {
  category: MentionCategory;
  id: string;
  target: ChatMentionResourceLinkTarget;
} | null => {
  const target = parseChatResourceHref(href);
  if (target?.type === RESOURCE_TYPE.ENTITY) {
    return {
      category: "entity",
      id:
        target.location.type === "workspace"
          ? `${target.location.workspace.id}:${target.resource.id}`
          : target.resource.id,
      target,
    };
  }
  if (target?.type === RESOURCE_TYPE.WORKSPACE) {
    return { category: "workspace", id: target.resource.id, target };
  }

  return null;
};

export const resolveMentionWorkspaceId = (
  target: ChatMentionResourceLinkTarget,
  renderContextWorkspaceId?: string,
): string | undefined => {
  switch (target.type) {
    case RESOURCE_TYPE.ENTITY:
      return target.location.type === "workspace"
        ? target.location.workspace.id
        : renderContextWorkspaceId;
    case RESOURCE_TYPE.WORKSPACE:
      return renderContextWorkspaceId;
    default:
      return target satisfies never;
  }
};

export const CHAT_MENTION_CATEGORY_PATTERN = CHAT_MENTION_HREF_ENTRIES.map(
  ([category]) => category,
).join("|");
