import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { encodePaginationCursor } from "@/api/lib/pagination";
import { brandPersistedDocxSuggestionId } from "@/api/lib/safe-id-boundaries";

import {
  decodeDocxSuggestionCursor,
  encodeDocxSuggestionCursor,
} from "./cursor";

// The cursor is exactly `(created_at ISO string, suggestion uuid)`. Any value
// in the `Date` range round-trips through `toISOString()`; the only value that
// cannot is the Invalid Date, which the encoder never produces.
const validDate = fc.date({ noInvalidDate: true });

// Local copies of the shapes the codec accepts, used only to filter generators
// away from the (astronomically unlikely) case where a random string is itself
// a valid part.
const uuidCursorPartPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const isDateTimeCursorPart = (value: string): boolean => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
};

describe("docx suggestion cursor codec (properties)", () => {
  test("decode ∘ encode recovers the (createdAt, id) pair", () => {
    fc.assert(
      fc.property(validDate, fc.uuid(), (createdAt, rawId) => {
        const id = brandPersistedDocxSuggestionId(rawId);
        const decoded = decodeDocxSuggestionCursor(
          encodeDocxSuggestionCursor({ createdAt, id }),
        );
        expect(decoded).not.toBeNull();
        expect(decoded?.createdAt).toEqual(createdAt);
        expect(decoded?.id).toBe(id);
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("decode never throws and yields a valid cursor or null for any string", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const decoded = decodeDocxSuggestionCursor(raw);
        expect(
          decoded === null ||
            (decoded.createdAt instanceof Date &&
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
        expect(decodeDocxSuggestionCursor(encoded)).toBeNull();
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
          decodeDocxSuggestionCursor(encodePaginationCursor(parts)),
        ).toBeNull();
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a non-UUID id part decodes to null", () => {
    fc.assert(
      fc.property(validDate, fc.string(), (createdAt, rawId) => {
        fc.pre(!uuidCursorPartPattern.test(rawId));
        expect(
          decodeDocxSuggestionCursor(
            encodePaginationCursor([createdAt.toISOString(), rawId]),
          ),
        ).toBeNull();
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a non-datetime created-at part decodes to null", () => {
    fc.assert(
      fc.property(fc.string(), fc.uuid(), (rawCreatedAt, rawId) => {
        fc.pre(!isDateTimeCursorPart(rawCreatedAt));
        expect(
          decodeDocxSuggestionCursor(
            encodePaginationCursor([rawCreatedAt, rawId]),
          ),
        ).toBeNull();
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
