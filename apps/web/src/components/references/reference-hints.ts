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

type JsonNode = { type?: unknown; attrs?: unknown; content?: unknown };

const isJsonNode = (value: unknown): value is JsonNode =>
  typeof value === "object" && value !== null;

const collectMentionAttrs = (node: unknown, out: unknown[]): void => {
  if (!isJsonNode(node)) {
    return;
  }
  if (node.type === "mention") {
    out.push(node.attrs);
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
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
  const mentions: unknown[] = [];
  collectMentionAttrs(doc, mentions);
  for (const attrs of mentions) {
    if (typeof attrs !== "object" || attrs === null) {
      continue;
    }
    const id = Reflect.get(attrs, "id");
    const category = Reflect.get(attrs, "category");
    const kind = Reflect.get(attrs, "kind");
    const mimeType = Reflect.get(attrs, "mimeType");
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
