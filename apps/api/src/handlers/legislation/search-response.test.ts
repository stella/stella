import { Value } from "@sinclair/typebox/value";
import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
  SEARCH_TOTAL_NOT_COUNTED,
} from "@stll/api-contract/search";
import { assertProperty } from "@stll/property-testing";

import {
  projectLegislationSearchHit,
  PUBLIC_LEGISLATION_SEARCH_RESPONSE_MAX_BYTES,
} from "@/api/handlers/legislation/search-response";
import { searchLegislationSuccessResponseSchema } from "@/api/handlers/legislation/search-schema";
import { CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import { LIMITS } from "@/api/lib/limits";
import { escapeSearchHtml } from "@/api/lib/search/highlight";

const unicode = fc
  .array(
    fc.constantFrom(
      "ě",
      "ř",
      "ů",
      "ľ",
      "ô",
      "😀",
      "👩‍⚖️",
      "e\u0301",
      "\u0000",
      '"',
      "\\",
      "\ud800",
    ),
    { minLength: 1, maxLength: 100 },
  )
  .map((parts) => parts.join(""));

const hitWithText = (text: string, headline: string) =>
  ({
    match: { type: "strict" },
    documentId: text,
    eli: text,
    slug: text,
    title: text,
    country: text,
    language: text,
    documentType: text,
    status: text,
    effectiveDate: text,
    sourceUrl: text,
    headline,
    score: -Number.MAX_VALUE,
  }) as const;

const assertBalanced = (headline: string) => {
  let depth = 0;
  for (const tag of headline.matchAll(/<\/?mark>/gu)) {
    depth += tag[0] === "<mark>" ? 1 : -1;
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0);
  expect(headline.replaceAll(/<\/?mark>/gu, "")).not.toContain("<");
};

test("search projection preserves whole escaped entities at the byte boundary", () => {
  assertProperty(
    "search projection preserves whole escaped entities at the byte boundary",
    fc.property(
      fc.array(fc.constantFrom("&", "<", ">", '"', "'"), {
        minLength: 1,
        maxLength: 30,
      }),
      fc.integer({ min: 0, max: 4 }),
      (characters, depth) => {
        const entities = characters.map(escapeSearchHtml);
        const escaped = entities.join("");
        const tagBytes = depth * ("<mark>".length + "</mark>".length);
        // Exercise every possible cut inside the randomly generated entities,
        // including the exact fit while reserving all closing tags.
        for (let remaining = 0; remaining <= escaped.length; remaining += 1) {
          const prefix = "a".repeat(
            LIMITS.legislationSearchTextBytes.headline - tagBytes - remaining,
          );
          const headline =
            "<mark>".repeat(depth) + prefix + escaped + "</mark>".repeat(depth);
          const result = projectLegislationSearchHit(hitWithText("", headline));
          const projected = result.headline ?? "";
          let kept = "";
          for (const entity of entities) {
            if (kept.length + entity.length > remaining) {
              break;
            }
            kept += entity;
          }
          expect(projected).toBe(
            "<mark>".repeat(depth) + prefix + kept + "</mark>".repeat(depth),
          );
          expect(Buffer.byteLength(projected)).toBeLessThanOrEqual(
            LIMITS.legislationSearchTextBytes.headline,
          );
          assertBalanced(projected);
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("search projection bounds Unicode text and balances highlight markup", () => {
  assertProperty(
    "search projection bounds Unicode text and balances highlight markup",
    fc.property(
      unicode,
      fc.integer({ min: 1, max: 1000 }),
      (text, fragments) => {
        const longText = text.repeat(
          LIMITS.legislationSearchTextBytes.sourceUrl,
        );
        const headline = Array.from(
          { length: fragments },
          () => `<mark>${text}</mark>`,
        ).join(" … ");
        const projected = projectLegislationSearchHit(
          hitWithText(longText, headline),
        );
        for (const [field, limit] of Object.entries(
          LIMITS.legislationSearchTextBytes,
        )) {
          const value = Object.entries(projected).find(
            ([name]) => name === field,
          )?.[1];
          expect(typeof value).toBe("string");
          if (typeof value !== "string") {
            continue;
          }
          expect(Buffer.byteLength(value, "utf-8")).toBeLessThanOrEqual(limit);
          expect(value.isWellFormed()).toBe(true);
          expect(
            new TextDecoder("utf-8", { fatal: true }).decode(
              new TextEncoder().encode(value),
            ),
          ).toBe(value);
        }
        assertBalanced(projected.headline ?? "");
        const response = {
          items: Array.from(
            { length: LIMITS.publicStatuteSearchPageSizeMax },
            () => projected,
          ),
          nextCursor: "a".repeat(CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH),
          paginationOutcome: SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
          total: SEARCH_TOTAL_NOT_COUNTED,
        };
        expect(
          Value.Check(searchLegislationSuccessResponseSchema, response),
        ).toBe(true);
        expect(
          Buffer.byteLength(JSON.stringify(response), "utf-8"),
        ).toBeLessThanOrEqual(PUBLIC_LEGISLATION_SEARCH_RESPONSE_MAX_BYTES);
      },
    ),
    { numRuns: 100 },
  );
});

test("every text field rejects multi-byte values beyond its schema byte bound", () => {
  const projected = projectLegislationSearchHit(hitWithText("", ""));
  for (const [field, limit] of Object.entries(
    LIMITS.legislationSearchTextBytes,
  )) {
    const oversized = "😀".repeat(Math.floor(limit / 4) + 1);
    const response = {
      items: [{ ...projected, [field]: oversized }],
      nextCursor: null,
      paginationOutcome: SEARCH_PAGINATION_COMPLETE,
      total: SEARCH_TOTAL_NOT_COUNTED,
    };
    expect(Value.Check(searchLegislationSuccessResponseSchema, response)).toBe(
      false,
    );
  }
});

test("truncation reserves closing tags and repairs incomplete backend highlights", () => {
  for (const headline of [
    `<mark>${"😀".repeat(LIMITS.legislationSearchTextBytes.headline)}`,
    `${"a".repeat(LIMITS.legislationSearchTextBytes.headline - 3)}<mark>z</mark>`,
    `</mark><mark><mark>${"ř".repeat(LIMITS.legislationSearchTextBytes.headline)}`,
  ]) {
    const result = projectLegislationSearchHit(hitWithText("title", headline));
    expect(
      Buffer.byteLength(result.headline ?? "", "utf-8"),
    ).toBeLessThanOrEqual(LIMITS.legislationSearchTextBytes.headline);
    assertBalanced(result.headline ?? "");
  }
});

test("valid stored identifiers and URLs survive projection unchanged", () => {
  const hit = {
    ...hitWithText("", ""),
    documentId: "01940000-0000-7000-8000-000000000001",
    eli: "😀".repeat(512),
    slug: "ř".repeat(256),
    country: "CZE",
    language: "cs",
    documentType: "ř".repeat(128),
    status: "ř".repeat(32),
    effectiveDate: "2026-10-03",
    sourceUrl: "😀".repeat(2048),
  };
  expect(projectLegislationSearchHit(hit)).toEqual(hit);
});
