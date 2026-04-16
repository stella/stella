import { convert } from "@kreuzberg/html-to-markdown";
import * as cheerio from "cheerio";

import type {
  ChatMention,
  ChatMentionCategory,
  ChatMentionHref,
} from "@/api/handlers/chat/types";
import { CHAT_MENTION_HREF_PREFIXES } from "@/api/handlers/chat/types";
import { typedEntries } from "@/api/lib/object";

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "entity-mention",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "strong",
  "sub",
  "sup",
  "u",
  "ul",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  "entity-mention": new Set([
    "data-category",
    "data-id",
    "data-label",
    "data-source-workspace-id",
  ]),
};

const ALLOWED_HREF_SCHEMES = new Set(["https:", "mailto:", "tel:"]);

const sanitizeHtml = (html: string): string => {
  const $ = cheerio.load(html, undefined, false);

  $("script, style, iframe, object, embed, form, textarea").remove();

  for (const el of $("*").get().toReversed()) {
    if (!("tagName" in el)) {
      continue;
    }

    const tagName = el.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) {
      $(el).replaceWith($(el).contents());
      continue;
    }

    const allowed = ALLOWED_ATTRS[tagName];
    for (const attr of Object.keys(el.attribs)) {
      if (!allowed?.has(attr)) {
        $(el).removeAttr(attr);
      }
    }

    if (tagName !== "a" || !el.attribs.href) {
      continue;
    }

    if (!URL.canParse(el.attribs.href, "https://placeholder.invalid")) {
      $(el).removeAttr("href");
      continue;
    }

    const url = new URL(el.attribs.href, "https://placeholder.invalid");
    if (!ALLOWED_HREF_SCHEMES.has(url.protocol)) {
      $(el).removeAttr("href");
    }
  }

  return $.html();
};

const parseMentionCategory = (value: string): ChatMentionCategory | null => {
  for (const [category] of typedEntries(CHAT_MENTION_HREF_PREFIXES)) {
    if (value === category) {
      return category;
    }
  }

  return null;
};

const toMentionHref = ({
  category,
  id,
}: {
  category: ChatMentionCategory;
  id: string;
}): ChatMentionHref => `${CHAT_MENTION_HREF_PREFIXES[category]}${id}`;

const dedupeMentions = (mentions: ChatMention[]): ChatMention[] => {
  const seen = new Set<string>();
  const deduped: ChatMention[] = [];

  for (const mention of mentions) {
    const key =
      mention.category === "entity"
        ? `${mention.category}:${mention.workspaceId ?? ""}:${mention.id}`
        : `${mention.category}:${mention.id}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(mention);
  }

  return deduped;
};

const mentionIsWorkspaceAccessible = (
  mention: ChatMention,
  accessibleWorkspaceIds: string[],
): boolean => {
  if (mention.category === "workspace") {
    return accessibleWorkspaceIds.includes(mention.id);
  }

  if (mention.workspaceId !== null) {
    return accessibleWorkspaceIds.includes(mention.workspaceId);
  }

  return true;
};

const replaceMentionsWithAnchors = (
  html: string,
  accessibleWorkspaceIds: string[],
): { html: string; mentions: ChatMention[] } => {
  const $ = cheerio.load(html, undefined, false);
  const mentions: ChatMention[] = [];

  $("entity-mention").each((_, node) => {
    const id = $(node).attr("data-id");
    const label = $(node).attr("data-label");
    const sourceWorkspaceId = $(node).attr("data-source-workspace-id") ?? null;
    const rawCategory = $(node).attr("data-category");
    const category = parseMentionCategory(rawCategory ?? "");

    if (!id || !label || !category) {
      $(node).replaceWith($(node).contents());
      return;
    }

    const mention =
      category === "entity"
        ? {
            category,
            id,
            label,
            workspaceId: sourceWorkspaceId,
          }
        : {
            category,
            id,
            label,
          };

    if (!mentionIsWorkspaceAccessible(mention, accessibleWorkspaceIds)) {
      $(node).remove();
      return;
    }

    mentions.push(mention);

    const href = toMentionHref({ category, id });
    const anchor = $("<a></a>").attr("href", href).text(label);

    $(node).replaceWith(anchor);
  });

  return {
    html: $.html(),
    mentions: dedupeMentions(mentions),
  };
};

export const normalizeChatMessageHtml = (
  html: string,
  accessibleWorkspaceIds: string[],
): { mentions: ChatMention[]; text: string } => {
  if (!html.trim()) {
    return { mentions: [], text: "" };
  }

  const sanitizedHtml = sanitizeHtml(html);
  const { html: parsedHtml, mentions } = replaceMentionsWithAnchors(
    sanitizedHtml,
    accessibleWorkspaceIds,
  );
  const text = convert(parsedHtml).trim();

  return {
    mentions,
    text,
  };
};
