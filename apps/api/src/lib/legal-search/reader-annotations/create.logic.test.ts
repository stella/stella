import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { storedAnnotationMatchesRequest } from "@/api/lib/legal-search/reader-annotations/create.logic";
import type { CreateAnnotationBody } from "@/api/lib/legal-search/reader-annotations/schema";

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
      quotePrefix: "",
      quoteSuffix: "",
      startOffset: 0,
    },
    {
      blockAnchorId: "p-2",
      endOffset: 8,
      quote: "language",
      quotePrefix: "",
      quoteSuffix: "",
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
  quotePrefix: span.quotePrefix,
  quoteSuffix: span.quoteSuffix,
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
      storedAnnotationMatchesRequest({
        body,
        identity: "spans",
        rows: rows.toReversed(),
      }),
    ).toBe(true);
  });

  test("rejects reuse for changed legal text", () => {
    const changedRows = rows.map((row, index) =>
      index === 0 ? changed(row, { quote: "different" }) : row,
    );
    expect(
      storedAnnotationMatchesRequest({
        body,
        identity: "spans",
        rows: changedRows,
      }),
    ).toBe(false);
  });

  test("rejects reuse across documents", () => {
    const otherDocument = rows.map((row) =>
      changed(row, { targetId: "019b0121-9dd7-7000-8000-000000000003" }),
    );
    expect(
      storedAnnotationMatchesRequest({
        body,
        identity: "spans",
        rows: otherDocument,
      }),
    ).toBe(false);
  });

  test("a request named by its words replays a mark a re-parse has moved", () => {
    // The first create was placed before a re-parse; its retry finds the
    // same words at another anchor, offset and spacing.
    const moved = rows.map((row) =>
      changed(row, {
        blockAnchorId: "p-9",
        startOffset: row.startOffset + 3,
        endOffset: row.endOffset + 3,
        quotePrefix: "Sąd ",
      }),
    );
    expect(
      storedAnnotationMatchesRequest({ body, identity: "words", rows: moved }),
    ).toBe(true);
    expect(
      storedAnnotationMatchesRequest({ body, identity: "spans", rows: moved }),
    ).toBe(false);
    const otherWords = moved.map((row, index) =>
      index === 0 ? changed(row, { quote: "different" }) : row,
    );
    expect(
      storedAnnotationMatchesRequest({
        body,
        identity: "words",
        rows: otherWords,
      }),
    ).toBe(false);
  });

  test("rejects reuse across corpora holding the same id", () => {
    const sameIdOtherCorpus = rows.map((row) =>
      changed(row, { targetType: "statute" }),
    );
    expect(
      storedAnnotationMatchesRequest({
        body,
        identity: "spans",
        rows: sameIdOtherCorpus,
      }),
    ).toBe(false);
  });
});
