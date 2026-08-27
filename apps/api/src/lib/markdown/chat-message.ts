import * as cheerio from "cheerio";
import { decodeHTMLAttribute } from "entities";

import {
  resourceRef,
  RESOURCE_TYPE,
  toChatMentionResourceHref,
  toChatResourceHref,
  isChatMentionCategory,
  isChatReferenceCategory,
} from "@stll/api-contract";

import type { ChatMention, ChatMentionHref } from "@/api/lib/chat/references";
import { htmlToMarkdown } from "@/api/lib/markdown/html-to-markdown";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

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
const SKILL_REF_HREF_PREFIX = "#stella-skill-ref=";

const REMOVE_ENTIRELY = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "textarea",
]);

const isAllowedLocalHref = (href: string): boolean =>
  href.startsWith(SKILL_REF_HREF_PREFIX) &&
  href.length > SKILL_REF_HREF_PREFIX.length;

const sanitizeHtml = (html: string): string =>
  new HTMLRewriter()
    .on("*", {
      element(el) {
        const tagName = el.tagName;
        if (REMOVE_ENTIRELY.has(tagName)) {
          el.remove();
          return;
        }
        if (!ALLOWED_TAGS.has(tagName)) {
          el.removeAndKeepContent();
          return;
        }
        const allowed = ALLOWED_ATTRS[tagName];
        const toRemove: string[] = [];
        for (const [name] of el.attributes) {
          if (!allowed?.has(name)) {
            toRemove.push(name);
          }
        }
        for (const name of toRemove) {
          el.removeAttribute(name);
        }
        if (tagName !== "a") {
          return;
        }
        const rawHref = el.getAttribute("href");
        if (!rawHref) {
          return;
        }
        // getAttribute returns the attribute text as written; downstream
        // consumers decode entities, so validate the decoded value and emit
        // exactly what was checked.
        const href = decodeHTMLAttribute(rawHref);
        if (isAllowedLocalHref(href)) {
          el.setAttribute("href", href);
          return;
        }
        if (!URL.canParse(href, "https://placeholder.invalid")) {
          el.removeAttribute("href");
          return;
        }
        const url = new URL(href, "https://placeholder.invalid");
        if (!ALLOWED_HREF_SCHEMES.has(url.protocol)) {
          el.removeAttribute("href");
          return;
        }
        el.setAttribute("href", href);
      },
    })
    .transform(html);

const parseMentionCategory = (value: string) =>
  isChatMentionCategory(value) ? value : null;

const parseReferenceCategory = (value: string) =>
  isChatReferenceCategory(value) ? value : null;

const toMentionHref = (mention: ChatMention): ChatMentionHref => {
  if (mention.category === "entity") {
    return toChatMentionResourceHref({
      type: RESOURCE_TYPE.ENTITY,
      resource: mention.resource,
      location:
        mention.workspaceId === null
          ? { type: "render_context" }
          : {
              type: "workspace",
              workspace: resourceRef({
                type: RESOURCE_TYPE.WORKSPACE,
                id: brandPersistedWorkspaceId(mention.workspaceId),
              }),
            },
    });
  }

  return toChatMentionResourceHref({
    type: RESOURCE_TYPE.WORKSPACE,
    resource: mention.resource,
  });
};

const toDecisionReferenceHref = (id: string) =>
  toChatResourceHref({
    type: RESOURCE_TYPE.CASE_LAW_DECISION,
    resource: resourceRef({
      type: RESOURCE_TYPE.CASE_LAW_DECISION,
      id: brandPersistedCaseLawDecisionId(id),
    }),
  });

const dedupeMentions = (mentions: readonly ChatMention[]): ChatMention[] => {
  const seen = new Set<string>();
  const deduped: ChatMention[] = [];

  for (const mention of mentions) {
    const key =
      mention.category === "entity"
        ? JSON.stringify([
            mention.resource.type,
            mention.workspaceId,
            mention.resource.id,
          ])
        : JSON.stringify([mention.resource.type, mention.resource.id]);

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
  accessibleWorkspaceIds: readonly string[],
): boolean => {
  if (mention.category === "workspace") {
    return accessibleWorkspaceIds.includes(mention.resource.id);
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
    const referenceCategory = parseReferenceCategory(rawCategory ?? "");
    const category = parseMentionCategory(rawCategory ?? "");

    if (!id || !label || !referenceCategory) {
      $(node).replaceWith($(node).contents());
      return;
    }

    if (!category) {
      const href = toDecisionReferenceHref(id);
      const anchor = $("<a></a>").attr("href", href).text(label);
      $(node).replaceWith(anchor);
      return;
    }

    const mention =
      category === "entity"
        ? {
            category,
            id,
            label,
            resource: resourceRef({
              type: RESOURCE_TYPE.ENTITY,
              id: brandPersistedEntityId(id),
            }),
            workspaceId: sourceWorkspaceId,
          }
        : {
            category,
            id,
            label,
            resource: resourceRef({
              type: RESOURCE_TYPE.WORKSPACE,
              id: brandPersistedWorkspaceId(id),
            }),
          };

    if (!mentionIsWorkspaceAccessible(mention, accessibleWorkspaceIds)) {
      $(node).remove();
      return;
    }

    mentions.push(mention);

    const href = toMentionHref(mention);
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
  const text = htmlToMarkdown(parsedHtml).trim();

  return {
    mentions,
    text,
  };
};
