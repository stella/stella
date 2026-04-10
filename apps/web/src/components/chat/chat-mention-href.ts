import type {
  ChatMentionCategory,
  ChatMentionHrefPrefixMap,
} from "@stella/api/types";

import { typedEntries } from "@/lib/object";

export type MentionCategory = ChatMentionCategory;

const CHAT_MENTION_HREF_PREFIXES = {
  entity: "#stella-entity=",
  workspace: "#stella-workspace=",
} as const satisfies ChatMentionHrefPrefixMap;

export const isMentionCategory = (value: string): value is MentionCategory => {
  for (const [category] of typedEntries(CHAT_MENTION_HREF_PREFIXES)) {
    if (value === category) {
      return true;
    }
  }

  return false;
};

export const parseStellaMentionHref = (
  href: string,
): { category: MentionCategory; id: string } | null => {
  for (const [category, prefix] of typedEntries(CHAT_MENTION_HREF_PREFIXES)) {
    if (href.startsWith(prefix)) {
      return {
        category,
        id: href.slice(prefix.length),
      };
    }
  }

  return null;
};

export const CHAT_MENTION_CATEGORY_PATTERN = typedEntries(
  CHAT_MENTION_HREF_PREFIXES,
)
  .map(([category]) => category)
  .join("|");
