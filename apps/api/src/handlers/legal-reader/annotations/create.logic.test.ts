import { describe, expect, test } from "bun:test";

import { storedAnnotationMatchesRequest } from "@/api/handlers/legal-reader/annotations/create.logic";
import type { CreateAnnotationBody } from "@/api/handlers/legal-reader/annotations/schema";
import { toSafeId } from "@/api/lib/branded-types";

const targetId = "019b0121-9dd7-7000-8000-000000000001";
const requestId = toSafeId<"legalReaderAnnotation">(
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
  targetId,
  targetType: "decision",
  visibility: "private",
} satisfies CreateAnnotationBody;

/** Derived from the checker itself, so the fixture cannot drift from it. */
type StoredRow = Parameters<
  typeof storedAnnotationMatchesRequest
>[0]["rows"][number];

const rows: StoredRow[] = body.spans.map((span) => ({
  blockAnchorId: span.blockAnchorId,
  body: null,
  color: body.color,
  endOffset: span.endOffset,
  groupId: requestId,
  kind: body.kind,
  quote: span.quote,
  startOffset: span.startOffset,
  style: body.style,
  targetId,
  targetType: body.targetType,
  visibility: body.visibility,
}));

/** One stored row with a field changed, built outside the map. */
const changed = (row: StoredRow, overrides: Partial<StoredRow>): StoredRow => ({
  ...row,
  ...overrides,
});

describe("annotation create idempotency", () => {
  test("accepts an exact replay regardless of stored row order", () => {
    expect(
      storedAnnotationMatchesRequest({ body, rows: rows.toReversed() }),
    ).toBe(true);
  });

  test("rejects reuse for changed legal text", () => {
    const changedRows = rows.map((row, index) =>
      index === 0 ? changed(row, { quote: "different" }) : row,
    );
    expect(storedAnnotationMatchesRequest({ body, rows: changedRows })).toBe(
      false,
    );
  });

  test("rejects reuse across documents", () => {
    const otherDocument = rows.map((row) =>
      changed(row, { targetId: "019b0121-9dd7-7000-8000-000000000003" }),
    );
    expect(storedAnnotationMatchesRequest({ body, rows: otherDocument })).toBe(
      false,
    );
  });

  test("rejects reuse across corpora holding the same id", () => {
    const sameIdOtherCorpus = rows.map((row) =>
      changed(row, { targetType: "statute" }),
    );
    expect(
      storedAnnotationMatchesRequest({ body, rows: sameIdOtherCorpus }),
    ).toBe(false);
  });
});
