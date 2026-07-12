import type {
  ChatMentionCategory,
  ChatMentionHrefPrefixMap,
} from "@stll/api/types";

export type MentionCategory = ChatMentionCategory;

const CHAT_MENTION_HREF_PREFIXES = {
  entity: "#stella-entity=",
  workspace: "#stella-workspace=",
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
): { category: MentionCategory; id: string } | null => {
  for (const [category, prefix] of CHAT_MENTION_HREF_ENTRIES) {
    if (href.startsWith(prefix)) {
      return {
        category,
        id: href.slice(prefix.length),
      };
    }
  }

  return null;
};

export const CHAT_MENTION_CATEGORY_PATTERN = CHAT_MENTION_HREF_ENTRIES.map(
  ([category]) => category,
).join("|");
