import { panic } from "better-result";

import {
  CHAT_RESOURCE_HREF_PREFIX,
  parseChatResourceHref,
  RESOURCE_TYPE,
} from "@stll/api-contract";
import type { ChatMentionResourceLinkTarget } from "@stll/api-contract";

import type {
  ChatMentionCategory,
  ChatMentionHrefPrefixMap,
} from "@/lib/api-contract";

export type MentionCategory = ChatMentionCategory;

const CHAT_MENTION_HREF_PREFIXES = {
  entity: CHAT_RESOURCE_HREF_PREFIX.entity,
  workspace: CHAT_RESOURCE_HREF_PREFIX.workspace,
} as const satisfies ChatMentionHrefPrefixMap;

const CHAT_MENTION_HREF_ENTRIES = [
  ["entity", CHAT_MENTION_HREF_PREFIXES.entity],
  ["workspace", CHAT_MENTION_HREF_PREFIXES.workspace],
] as const satisfies readonly (readonly [MentionCategory, string])[];

type MissingMentionCategory = Exclude<
  MentionCategory,
  (typeof CHAT_MENTION_HREF_ENTRIES)[number][0]
>;

true satisfies MissingMentionCategory extends never ? true : never;

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
  target: ChatMentionResourceLinkTarget;
} | null => {
  const target = parseChatResourceHref(href);
  if (target?.type === RESOURCE_TYPE.ENTITY) {
    return { category: "entity", target };
  }
  if (target?.type === RESOURCE_TYPE.WORKSPACE) {
    return { category: "workspace", target };
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
      target satisfies never;
      return panic(`Unhandled target: ${String(target)}`);
  }
};

export const CHAT_MENTION_CATEGORY_PATTERN = CHAT_MENTION_HREF_ENTRIES.map(
  ([category]) => category,
).join("|");
