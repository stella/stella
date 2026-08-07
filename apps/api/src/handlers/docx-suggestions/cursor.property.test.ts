import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { parsePgTimestampCursorValue } from "@/api/lib/db-pagination";
import {
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedDocxSuggestionId } from "@/api/lib/safe-id-boundaries";

import { docxSuggestionCursor } from "./cursor";

// The cursor is `(PostgreSQL microsecond timestamp text, suggestion uuid)`.
// The timestamp half is the database's own rendering of `created_at`, never
// a JS `Date`: a `Date` carries milliseconds, so a boundary built from one
// re-admits the row the page was cut at and the list never advances.
const microsecondTimestamp = fc
  .tuple(
    fc.date({
      min: new Date("2000-01-01T00:00:00.000Z"),
      max: new Date("2099-12-31T23:59:59.999Z"),
      noInvalidDate: true,
    }),
    fc.integer({ min: 0, max: 999_999 }),
  )
  .map(
    ([date, microseconds]) =>
      `${date.toISOString().slice(0, 19)}.${microseconds.toString().padStart(6, "0")}Z`,
  );

describe("docx suggestion cursor codec (properties)", () => {
  test("INVARIANT: decode ∘ encode recovers the timestamp at full precision", () => {
    fc.assert(
      fc.property(microsecondTimestamp, fc.uuid(), (timestamp, rawId) => {
        const id = brandPersistedDocxSuggestionId(rawId);
        expect(
          docxSuggestionCursor.decode(
            docxSuggestionCursor.encode(timestamp, id),
          ),
        ).toEqual({
          timestamp: {
            type: "pgTimestampCursor",
            value: timestamp,
            precision: "microseconds",
          },
          id,
        });
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("INVARIANT: cursors issued before the fix still decode, tagged millisecond", () => {
    // The old encoder was `encodePaginationCursor([createdAt.toISOString(), id])`.
    // Those cursors are in flight in clients; decoding one must never throw or
    // 400, it only resumes at the coarser precision it was cut with.
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00.000Z"),
          max: new Date("2099-12-31T23:59:59.999Z"),
          noInvalidDate: true,
        }),
        fc.uuid(),
        (createdAt, rawId) => {
          const id = brandPersistedDocxSuggestionId(rawId);
          expect(
            docxSuggestionCursor.decode(
              encodePaginationCursor([createdAt.toISOString(), rawId]),
            ),
          ).toEqual({
            timestamp: {
              type: "pgTimestampCursor",
              value: createdAt.toISOString(),
              precision: "milliseconds",
            },
            id,
          });
        },
      ),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("decode never throws and yields a valid cursor or null for any string", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const decoded = docxSuggestionCursor.decode(raw);
        expect(
          decoded === null ||
            (typeof decoded.timestamp.value === "string" &&
              typeof decoded.id === "string"),
        ).toBe(true);
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("a well-formed but non-array payload decodes to null", () => {
    const nonArray = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.dictionary(fc.string(), fc.string()),
    );
    fc.assert(
      fc.property(nonArray, (value) => {
        const encoded = Buffer.from(JSON.stringify(value)).toString(
          "base64url",
        );
        expect(docxSuggestionCursor.decode(encoded)).toBeNull();
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a payload that is not a 2-tuple decodes to null", () => {
    const wrongArity = fc
      .array(fc.oneof(fc.string(), fc.integer()))
      .filter((parts) => parts.length !== 2);
    fc.assert(
      fc.property(wrongArity, (parts) => {
        expect(
          docxSuggestionCursor.decode(encodePaginationCursor(parts)),
        ).toBeNull();
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  // Both preconditions reuse the production predicates the codec itself
  // applies, so they cannot drift from what `decode` actually accepts.
  test("a non-UUID id part decodes to null", () => {
    fc.assert(
      fc.property(microsecondTimestamp, fc.string(), (timestamp, rawId) => {
        fc.pre(!isUuidPaginationCursorPart(rawId));
        expect(
          docxSuggestionCursor.decode(
            encodePaginationCursor([timestamp, rawId]),
          ),
        ).toBeNull();
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a non-timestamp created-at part decodes to null", () => {
    fc.assert(
      fc.property(fc.string(), fc.uuid(), (rawCreatedAt, rawId) => {
        fc.pre(parsePgTimestampCursorValue(rawCreatedAt) === null);
        expect(
          docxSuggestionCursor.decode(
            encodePaginationCursor([rawCreatedAt, rawId]),
          ),
        ).toBeNull();
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
