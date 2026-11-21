import { panic } from "better-result";

import { readerTextQuoteKey } from "@stll/legal-ast/reader-text-quote";

import type { CreateAnnotationRequest } from "@/api/lib/legal-search/reader-annotations/schema";

/**
 * What a replayed request must share with the stored mark besides its look.
 * `spans`: the exact positions and context, from a reader client that
 * measured them and resends them as they were. `words`: the quoted words
 * only, from a request that named its passages by their words and had them
 * placed server-side, where a re-parse between a call and its retry can move
 * the positions; the mark keeps those of the first successful create.
 */
export type AnnotationReplayIdentity = "spans" | "words";

type StoredAnnotation = {
  blockAnchorId: string;
  body: string | null;
  color: string | null;
  endOffset: number;
  groupId: string | null;
  kind: string;
  quote: string;
  quotePrefix: string;
  quoteSuffix: string;
  startOffset: number;
  style: string | null;
  targetId: string;
  targetType: string;
  visibility: string;
};

const spanKey = ({
  blockAnchorId,
  endOffset,
  quote,
  quotePrefix,
  quoteSuffix,
  startOffset,
}: {
  blockAnchorId: string;
  endOffset: number;
  quote: string;
  quotePrefix: string;
  quoteSuffix: string;
  startOffset: number;
}): string =>
  JSON.stringify([
    blockAnchorId,
    startOffset,
    endOffset,
    quote,
    quotePrefix,
    quoteSuffix,
  ]);

/**
 * An idempotency key is a receipt for one exact request, never an alias that
 * can silently overwrite a different mark. Span order is immaterial once the
 * rows are stored, so compare their canonical multisets.
 */
export const storedAnnotationMatchesRequest = ({
  body,
  identity,
  rows,
}: {
  body: CreateAnnotationRequest;
  identity: AnnotationReplayIdentity;
  rows: readonly StoredAnnotation[];
}): boolean => {
  if (rows.length !== body.spans.length) {
    return false;
  }
  const expectedVisibility = body.visibility ?? "private";
  const expectedColor = body.kind === "highlight" ? body.color : null;
  const expectedStyle = body.kind === "highlight" ? body.style : null;
  if (
    rows.some(
      (row) =>
        row.targetType !== body.targetType ||
        row.targetId !== body.targetId ||
        row.kind !== body.kind ||
        row.visibility !== expectedVisibility ||
        row.color !== expectedColor ||
        row.style !== expectedStyle,
    )
  ) {
    return false;
  }
  const groupIds = new Set(rows.map((row) => row.groupId));
  if (
    (rows.length === 1 && (groupIds.size !== 1 || !groupIds.has(null))) ||
    (rows.length > 1 && (groupIds.size !== 1 || groupIds.has(null)))
  ) {
    return false;
  }
  const bodies = rows.map((row) => row.body).filter((value) => value !== null);
  if (
    (body.kind === "highlight" && bodies.length !== 0) ||
    (body.kind === "comment" &&
      (bodies.length !== 1 || bodies.at(0) !== body.body))
  ) {
    return false;
  }
  const keyOf = (span: (typeof body.spans)[number] | StoredAnnotation) => {
    switch (identity) {
      case "spans":
        return spanKey(span);
      case "words":
        return readerTextQuoteKey(span.quote);
      default:
        identity satisfies never;
        return panic(`Unhandled replay identity: ${String(identity)}`);
    }
  };
  const expectedSpans = body.spans.map(keyOf).toSorted();
  const storedSpans = rows.map(keyOf).toSorted();
  return expectedSpans.every((span, index) => span === storedSpans.at(index));
};
