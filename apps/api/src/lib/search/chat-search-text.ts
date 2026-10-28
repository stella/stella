import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";

export type SearchablePersistedChatMessageContent = {
  data: unknown[];
  metadata?: unknown;
  version: 3;
};

const isPersistedChatMessageContent = (
  value: unknown,
): value is SearchablePersistedChatMessageContent =>
  isRecord(value) && value["version"] === 3 && Array.isArray(value["data"]);

type SearchableChatTextPart = {
  content: string;
  type: "text";
};

type SearchableChatMessageMetadata = Record<string, unknown> & {
  sourceDocuments?: SearchableChatSourceDocument[] | undefined;
};

type NormalizedSearchableChatMessageContent = {
  metadata: SearchableChatMessageMetadata;
  parts: SearchableChatTextPart[];
};

/** `[label](href)` and `![alt](src)`, with the label captured. Neither class
 *  admits its own opening delimiter, which keeps the match linear in the
 *  subject (`super-linear-regexes` is a ratcheted metric, and this runs over
 *  whole persisted threads). The cost is that a label containing `[` or a
 *  target containing `(` is left alone; a chat mention href never has either,
 *  and an unstripped link is the safe direction to fail. */
const MARKDOWN_LINK_REGEX = /!?\[([^[\]]*)\]\([^()]*\)/gu;

/**
 * Drop link targets from persisted chat markdown, keeping the link label.
 *
 * Assistant text cites matters and entities as `[Name](#stella-workspace=<uuid>)`
 * (see `resolveAssistantTextRefs`), so the raw text carries an href for every
 * citation. Indexing it verbatim made the href both matchable and visible: a
 * search hit rendered its `ts_headline` inline, so the result row showed the
 * mention URL and could even highlight a fragment of the workspace UUID. The
 * label is the only part a reader searches for or wants to see.
 */
const stripMarkdownLinkTargets = (text: string): string =>
  text.replaceAll(MARKDOWN_LINK_REGEX, (_match, label: string) => label);

const toSearchableTextPart = (part: unknown): SearchableChatTextPart | null => {
  if (!isRecord(part) || part["type"] !== "text") {
    return null;
  }
  if (typeof part["content"] === "string") {
    return { type: "text", content: stripMarkdownLinkTargets(part["content"]) };
  }
  return null;
};

type SearchableChatSourceDocument = {
  entityId?: string;
  entityRef?: string;
  kind: string;
  matterRef?: string;
  mention?: string;
  mimeType?: string | null;
  title: string;
  workspaceId?: string | null;
};

const toSearchableChatSourceDocument = (
  value: unknown,
): SearchableChatSourceDocument | null => {
  if (
    !isRecord(value) ||
    typeof value["kind"] !== "string" ||
    typeof value["title"] !== "string"
  ) {
    return null;
  }
  return {
    kind: value["kind"],
    title: value["title"],
    ...(typeof value["entityId"] === "string"
      ? { entityId: value["entityId"] }
      : {}),
    ...(typeof value["entityRef"] === "string"
      ? { entityRef: value["entityRef"] }
      : {}),
    ...(typeof value["matterRef"] === "string"
      ? { matterRef: value["matterRef"] }
      : {}),
    ...(typeof value["mention"] === "string"
      ? { mention: value["mention"] }
      : {}),
    ...(value["mimeType"] === null || typeof value["mimeType"] === "string"
      ? { mimeType: value["mimeType"] }
      : {}),
    ...(value["workspaceId"] === null ||
    typeof value["workspaceId"] === "string"
      ? { workspaceId: value["workspaceId"] }
      : {}),
  };
};

export const normalizeSearchableChatMessageContent = (content: unknown) => {
  if (isRecord(content) && content["version"] !== 3) {
    panic("Stored chat content requires the v3 data backfill");
  }
  if (!isPersistedChatMessageContent(content)) {
    return null;
  }

  const parts = content.data.flatMap((part) => {
    const searchable = toSearchableTextPart(part);
    return searchable ? [searchable] : [];
  });
  const rawMetadata = isRecord(content.metadata) ? content.metadata : {};
  const rawSourceDocuments = rawMetadata["sourceDocuments"];
  const metadata: SearchableChatMessageMetadata = {
    ...rawMetadata,
    ...(rawSourceDocuments === undefined
      ? {}
      : {
          sourceDocuments: Array.isArray(rawSourceDocuments)
            ? rawSourceDocuments.flatMap((sourceDocument) => {
                const searchable =
                  toSearchableChatSourceDocument(sourceDocument);
                return searchable ? [searchable] : [];
              })
            : [],
        }),
  };

  return { metadata, parts } satisfies NormalizedSearchableChatMessageContent;
};

export const extractMessageSearchText = (content: unknown): string => {
  const parts: string[] = [];
  const message = normalizeSearchableChatMessageContent(content);
  if (!message) {
    return "";
  }
  for (const part of message.parts) {
    const trimmed = part.content.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }

  const sourceDocuments = message.metadata.sourceDocuments;
  if (!sourceDocuments) {
    return parts.join(" ");
  }
  for (const sourceDocumentData of sourceDocuments) {
    for (const value of [
      sourceDocumentData.title,
      sourceDocumentData.mention,
      sourceDocumentData.kind,
    ]) {
      if (typeof value !== "string") {
        continue;
      }

      const trimmed = value.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
    }
  }

  return parts.join(" ").slice(0, LIMITS.chatMessageSearchTextMaxLength);
};

export const chatSearchVectorSql = (text: SQL) =>
  sql`to_tsvector('simple', unaccent(arabic_normalize(coalesce(${text}, ''))))`;
