import type { QueryClient } from "@tanstack/react-query";
import { queryOptions, skipToken } from "@tanstack/react-query";

import { isEntityKind } from "@stll/api-contract";
import type { EntityKind } from "@stll/api-contract";

/**
 * What the composer knew about an entity it mentioned: its kind and file type.
 * Persisted text keeps only the entity's identity, so the sent message would
 * otherwise draw a loading glyph until a read returns what the composer chip
 * already showed. The hint lives in the query client, so it is scoped to the
 * signed-in session and cleared with it.
 */
export type ReferenceHint = { kind: EntityKind; mimeType: string | null };

const referenceHintKey = (entityId: string) =>
  ["chat-reference-hint", entityId] as const;

/** Read-only: hints are only ever written by `seedReferenceHints`. */
export const referenceHintOptions = (entityId: string | null) =>
  queryOptions<ReferenceHint>({
    queryKey: referenceHintKey(entityId ?? ""),
    queryFn: skipToken,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

type JsonRecord = Record<string, unknown>;

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null;

const collectMentionAttrs = (node: unknown, out: JsonRecord[]): void => {
  if (!isJsonRecord(node)) {
    return;
  }
  const { attrs, content, type } = node;
  if (type === "mention" && isJsonRecord(attrs)) {
    out.push(attrs);
  }
  if (Array.isArray(content)) {
    for (const child of content) {
      collectMentionAttrs(child, out);
    }
  }
};

/** Record the kind of every entity mentioned in a composer document that is
 * about to be sent. */
export const seedReferenceHints = (
  queryClient: QueryClient,
  doc: unknown,
): void => {
  const mentions: JsonRecord[] = [];
  collectMentionAttrs(doc, mentions);
  for (const { category, id, kind, mimeType } of mentions) {
    if (
      category !== "entity" ||
      typeof id !== "string" ||
      id.length === 0 ||
      !isEntityKind(kind)
    ) {
      continue;
    }
    queryClient.setQueryData(referenceHintOptions(id).queryKey, {
      kind,
      mimeType: typeof mimeType === "string" ? mimeType : null,
    });
  }
};
