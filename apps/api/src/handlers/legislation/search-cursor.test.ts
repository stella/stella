import { expect, test } from "bun:test";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";
import {
  PUBLIC_COUNTRIES,
  PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
  publicCountryUnavailable,
} from "@stll/api-contract/public-country-capability";

import {
  legislationQueryFingerprint,
  searchLegislationHandler,
} from "@/api/handlers/legislation/search";
import { toSafeId } from "@/api/lib/branded-types";
import { encodeCorpusSearchCursor } from "@/api/lib/legal-search/corpus-search-cursor";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";

const DOCUMENT_ID = "6b1d2f34-58aa-4d1c-9d0f-2c3b4a5e6f70";

/**
 * A database that refuses to be read. Both search paths begin by reading
 * through one, so a call here would mean the cursor got past the boundary.
 */
const unreachableDb = () => {
  let reads = 0;
  const db: LegislationReadDb = async () => {
    reads += 1;
    // Never resolves to a transaction, because no test below lets it be
    // called: the assertion is that the boundary answered first.
    throw new Error("a search path read the database");
  };
  return { db, reads: () => reads };
};

const CASE_LAW_CURSOR = encodeCorpusSearchCursor({
  dictionary: { contentHash: "a".repeat(64), type: "dictionary" },
  id: DOCUMENT_ID,
  score: 0.5,
  sort: "relevance",
  windowStart: 0,
  target: null,
});

test.each(["DEU", "cze", "cz", "*"])(
  "jurisdiction %s is refused with the admitted codes before reading",
  async (jurisdiction) => {
    const { db, reads } = unreachableDb();
    const result = await searchLegislationHandler(
      { jurisdiction, query: "nájemné" },
      db,
      "unobserved",
    );

    expect(result).toMatchObject({
      code: 400,
      response: {
        message: expect.stringContaining(
          `Admitted jurisdiction codes (uppercase): ${PUBLIC_LEGISLATION_COUNTRIES.join(", ")}`,
        ),
      },
    });
    expect(reads()).toBe(0);
  },
);

test.each(
  PUBLIC_COUNTRIES.filter(
    (country) => publicCountryUnavailable(country) !== null,
  ),
)(
  "pending jurisdiction %s returns its capability before reading",
  async (jurisdiction) => {
    const { db, reads } = unreachableDb();
    const result = await searchLegislationHandler(
      { jurisdiction, query: "nájemné" },
      db,
      "unobserved",
    );
    expect(result).toMatchObject({
      code: PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
      response: publicCountryUnavailable(jurisdiction),
    });
    expect(reads()).toBe(0);
  },
);

// The legislation corpus is never expanded, so a cursor naming a dictionary
// came from an expanded case-law search: its score, id and window bound a
// ranking of other documents entirely. The database would throw if either
// search path started, so the refusal is proven to cost nothing as well as to
// happen.
test.each(["corpus-index", "pg-fts"] as const)(
  "a cursor naming a dictionary is refused before %s reads",
  async (provider) => {
    const { db, reads } = unreachableDb();

    const result = await searchLegislationHandler(
      { cursor: CASE_LAW_CURSOR, query: "nájemné" },
      db,
      "unobserved",
      { provider, loadSearchConfigs: async () => [] },
    );

    expect(result).not.toHaveProperty("items");
    expect(result).toMatchObject({
      code: 400,
      response: { message: "Invalid cursor" },
    });
    expect(reads()).toBe(0);
  },
);

test.each(["corpus-index", "pg-fts"] as const)(
  "%s cursors reject changed queries and filters before reading",
  async (provider) => {
    const body = { query: "nájemné", jurisdiction: "CZE" };
    const cursor = encodeCorpusSearchCursor({
      dictionary: { type: "none" },
      id: DOCUMENT_ID,
      score: 0.5,
      sort: "relevance",
      target: null,
      windowStart: 0,
      phase: {
        type: "strict",
        fingerprint: legislationQueryFingerprint(body),
        generation: provider === "pg-fts" ? null : "legislation_v2",
      },
    });
    const changes = [
      { query: "náhrada škody" },
      { documentType: "act" },
      { status: "current" },
      { language: "cs" },
      { source: toSafeId<"legislationSource">(DOCUMENT_ID) },
      { dateFrom: "2020-01-01" },
      { dateTo: "2030-01-01" },
    ];
    for (const change of changes) {
      const { db, reads } = unreachableDb();
      // db-await-in-loop: each cursor replay independently tests the boundary
      const result = await searchLegislationHandler(
        { ...body, ...change, cursor },
        db,
        "unobserved",
        { provider, loadSearchConfigs: async () => [] },
      );
      expect(result).toMatchObject({
        code: 400,
        response: { message: "Invalid cursor" },
      });
      expect(reads()).toBe(0);
    }
  },
);
