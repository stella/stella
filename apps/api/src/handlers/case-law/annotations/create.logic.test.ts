import { describe, expect, test } from "bun:test";

import { storedAnnotationMatchesRequest } from "@/api/handlers/case-law/annotations/create.logic";
import type { CreateAnnotationBody } from "@/api/handlers/case-law/annotations/schema";
import { toSafeId } from "@/api/lib/branded-types";

const decisionId = "019b0121-9dd7-7000-8000-000000000001";
const requestId = toSafeId<"caseLawDecisionAnnotation">(
  "019b0121-9dd7-7000-8000-000000000002",
);
const body = {
  color: "yellow",
  kind: "highlight",
  requestId,
  spans: [
    {
      blockAnchorId: "p-1",
      endOffset: 9,
      quote: "important",
      startOffset: 0,
    },
    {
      blockAnchorId: "p-2",
      endOffset: 8,
      quote: "language",
      startOffset: 0,
    },
  ],
  style: "highlight",
  visibility: "private",
} satisfies CreateAnnotationBody;

const rows = body.spans.map((span) => ({
  ...span,
  body: null,
  color: body.color,
  decisionId,
  groupId: requestId,
  kind: body.kind,
  style: body.style,
  visibility: body.visibility,
}));

describe("annotation create idempotency", () => {
  test("accepts an exact replay regardless of stored row order", () => {
    expect(
      storedAnnotationMatchesRequest({
        body,
        decisionId,
        rows: rows.toReversed(),
      }),
    ).toBe(true);
  });

  test("rejects reuse for changed legal text", () => {
    const changedRows = rows.map((row, index) =>
      index === 0 ? { ...row, quote: "different" } : row,
    );
    expect(
      storedAnnotationMatchesRequest({
        body,
        decisionId,
        rows: changedRows,
      }),
    ).toBe(false);
  });

  test("rejects reuse across decisions", () => {
    expect(
      storedAnnotationMatchesRequest({
        body,
        decisionId: "019b0121-9dd7-7000-8000-000000000003",
        rows,
      }),
    ).toBe(false);
  });
});
