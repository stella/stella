import type { CreateAnnotationBody } from "@/api/handlers/case-law/annotations/schema";

type StoredAnnotation = {
  blockAnchorId: string;
  body: string | null;
  color: string | null;
  decisionId: string;
  endOffset: number;
  groupId: string | null;
  kind: string;
  quote: string;
  startOffset: number;
  style: string | null;
  visibility: string;
};

const spanKey = ({
  blockAnchorId,
  endOffset,
  quote,
  startOffset,
}: {
  blockAnchorId: string;
  endOffset: number;
  quote: string;
  startOffset: number;
}): string => JSON.stringify([blockAnchorId, startOffset, endOffset, quote]);

/**
 * An idempotency key is a receipt for one exact request, never an alias that
 * can silently overwrite a different mark. Span order is immaterial once the
 * rows are stored, so compare their canonical multisets.
 */
export const storedAnnotationMatchesRequest = ({
  body,
  decisionId,
  rows,
}: {
  body: CreateAnnotationBody;
  decisionId: string;
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
        row.decisionId !== decisionId ||
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
  const expectedSpans = body.spans.map(spanKey).sort();
  const storedSpans = rows.map(spanKey).sort();
  return expectedSpans.every((span, index) => span === storedSpans.at(index));
};
