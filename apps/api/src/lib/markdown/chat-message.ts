import * as cheerio from "cheerio";

import {
  chatSourceScopeKey,
  isChatMentionCategory,
  isChatReferenceCategory,
  isChatSourceScopeKind,
  parseChatSourceScopeId,
  RESOURCE_TYPE,
  resourceRef,
  SKILL_REF_HREF_PREFIX,
  toChatMentionResourceHref,
  toChatResourceHref,
  toChatSourceScopeHref,
} from "@stll/api-contract";
import type { ChatSourceScope } from "@stll/api-contract";

import type { ChatMention, ChatMentionHref } from "@/api/lib/chat/references";
import { htmlToMarkdown } from "@/api/lib/markdown/html-to-markdown";
import { createHtmlSanitizer } from "@/api/lib/markdown/sanitize-html";
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

const isAllowedLocalHref = (href: string): boolean =>
  href.startsWith(SKILL_REF_HREF_PREFIX) &&
  href.length > SKILL_REF_HREF_PREFIX.length;

const sanitizeHtml = createHtmlSanitizer({
  allowedTags: ALLOWED_TAGS,
  allowedAttrs: ALLOWED_ATTRS,
  allowedHrefSchemes: ALLOWED_HREF_SCHEMES,
  isAllowedLocalHref,
});

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

const dedupeSourceScopes = (
  scopes: readonly ChatSourceScope[],
): ChatSourceScope[] => [
  ...new Map(
    scopes.map((scope) => [chatSourceScopeKey(scope), scope]),
  ).values(),
];

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
): {
  html: string;
  mentions: ChatMention[];
  sourceScopes: ChatSourceScope[];
} => {
  const $ = cheerio.load(html, undefined, false);
  const mentions: ChatMention[] = [];
  const sourceScopes: ChatSourceScope[] = [];

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

    // A source chip (a public corpus, a business registry, an MCP connector)
    // scopes the turn's source tools. It is a reference, not a mention, so it
    // never widens the thread's workspace data scope.
    if (isChatSourceScopeKind(referenceCategory)) {
      const scope = parseChatSourceScopeId(referenceCategory, id);
      // An id that names no source keeps the label the user saw, as plain text.
      if (scope === null) {
        $(node).text(label);
        $(node).replaceWith($(node).contents());
        return;
      }
      sourceScopes.push(scope);
      const anchor = $("<a></a>")
        .attr("href", toChatSourceScopeHref(scope))
        .text(label);
      $(node).replaceWith(anchor);
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
    sourceScopes: dedupeSourceScopes(sourceScopes),
  };
};

export const normalizeChatMessageHtml = (
  html: string,
  accessibleWorkspaceIds: string[],
): {
  mentions: ChatMention[];
  sourceScopes: ChatSourceScope[];
  text: string;
} => {
  if (!html.trim()) {
    return { mentions: [], sourceScopes: [], text: "" };
  }

  const sanitizedHtml = sanitizeHtml(html);
  const {
    html: parsedHtml,
    mentions,
    sourceScopes,
  } = replaceMentionsWithAnchors(sanitizedHtml, accessibleWorkspaceIds);
  const text = htmlToMarkdown(parsedHtml).trim();

  return {
    mentions,
    sourceScopes,
    text,
  };
};
