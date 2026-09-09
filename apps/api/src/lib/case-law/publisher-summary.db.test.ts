import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  TEXT_ABSENCE_REASON,
} from "@stll/api-contract/case-law-text-field";
import { propertyConfig } from "@stll/property-testing";

import {
  PUBLISHER_SUMMARY_SOURCES,
  publisherSummaryMetadataSql,
  publisherSummaryOf,
} from "@/api/lib/case-law/publisher-summary";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * One ordered source list, two implementations: `publisherSummaryOf` in
 * TypeScript for the projection, `publisherSummaryMetadataSql` in SQL for the
 * read path. Neither may be edited into a different answer, so the list is
 * walked here and both readings are proved equal on a fixture per source,
 * against a real PostgreSQL.
 */

type MetadataSource = Extract<
  (typeof PUBLISHER_SUMMARY_SOURCES)[number],
  { origin: "metadata" }
>;

const METADATA_SOURCES: readonly MetadataSource[] =
  PUBLISHER_SUMMARY_SOURCES.filter(
    (source): source is MetadataSource => source.origin === "metadata",
  );

/**
 * A fixture per value shape, total so a new shape cannot be added without a
 * fixture that pins how both implementations read it. Every fixture carries
 * padding, and the list carries a blank and a non-string item, because that is
 * where a hand-written pair of readings drifts.
 */
const FIXTURE_BY_SHAPE = {
  text: { value: " \n Publisher text \t", expected: "Publisher text" },
  list: { value: ["  alfa ", "  ", 7, "beta"], expected: "alfa · beta" },
} as const satisfies Record<
  MetadataSource["shape"],
  { value: unknown; expected: string }
>;

/**
 * Metadata carrying every source from `index` on. Walking the list this way
 * proves both the per-source reading and the fall-through order: with the
 * better sources removed, the answer must be exactly the next one.
 */
const metadataFrom = (index: number): Record<string, unknown> =>
  Object.fromEntries(
    METADATA_SOURCES.slice(index).map(({ key, shape }) => [
      key,
      FIXTURE_BY_SHAPE[shape].value,
    ]),
  );

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

/** Rows from `execute` under either driver shape (bare array or `{ rows }`). */
const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

const readSummary = (row: unknown): string | null => {
  const value = isRecord(row) ? row["summary"] : undefined;
  if (value === null || typeof value === "string") {
    return value ?? null;
  }
  throw new TypeError("summary did not render as text");
};

const readMetadataSummary = async (
  metadata: Record<string, unknown>,
): Promise<string | null> => {
  const rows = executedRows(
    await db.execute(sql`
      SELECT ${publisherSummaryMetadataSql(sql.raw("f.metadata"))} AS "summary"
        FROM (VALUES (${JSON.stringify(metadata)}::text::jsonb)) AS f(metadata)
    `),
  );
  return readSummary(rows.at(0));
};

test("both readings of the source list agree, source by source", async () => {
  const fixtures = METADATA_SOURCES.map((_, index) => metadataFrom(index));
  const values = sql.join(
    fixtures.map(
      (metadata, index) =>
        sql`(${index}::int, ${JSON.stringify(metadata)}::text::jsonb)`,
    ),
    sql`, `,
  );
  const rows = executedRows(
    await db.execute(sql`
      SELECT f.ordinal AS "ordinal",
             ${publisherSummaryMetadataSql(sql.raw("f.metadata"))} AS "summary"
        FROM (VALUES ${values}) AS f(ordinal, metadata)
       ORDER BY f.ordinal
    `),
  );

  expect(rows.length).toBe(METADATA_SOURCES.length);
  for (const [index, source] of METADATA_SOURCES.entries()) {
    const expected = FIXTURE_BY_SHAPE[source.shape].expected;
    expect([
      source.key,
      publisherSummaryOf({
        documentAst: null,
        metadata: fixtures[index] ?? null,
      }),
    ]).toEqual([source.key, expected]);
    expect([source.key, readSummary(rows[index])]).toEqual([
      source.key,
      expected,
    ]);
  }
});

test("both readings answer nothing for metadata with no publisher summary", async () => {
  const empty = {
    legalSentence: "   ",
    keywords: [],
    legalAreas: ["  ", 3],
    unrelated: "not a summary source",
  };
  expect(publisherSummaryOf({ documentAst: null, metadata: empty })).toBeNull();
  expect(await readMetadataSummary(empty)).toBeNull();
});

test("both readings keep a leading word the trim set must not eat", async () => {
  // "v" is a preposition every Czech and Slovak summary tends to open with,
  // and a one-character word is exactly what a trim set built on an escape the
  // manual does not document would start eating. Pinned here so the set can
  // never quietly acquire a letter.
  const metadata = { legalSentence: "v řízení o dovolání" };
  const expected = "v řízení o dovolání";

  expect(publisherSummaryOf({ documentAst: null, metadata })).toBe(expected);
  expect(await readMetadataSummary(metadata)).toBe(expected);
});

test("both readings still strip the whitespace the set does cover", async () => {
  const metadata = {
    legalSentence: " \u000b\tPrávní věta\u000b ",
  };

  expect(publisherSummaryOf({ documentAst: null, metadata })).toBe(
    "Právní věta",
  );
  expect(await readMetadataSummary(metadata)).toBe("Právní věta");
});

test("both readings preserve whitespace outside the shared trim set", async () => {
  const metadata = { legalSentence: "\u00a0" };

  expect(publisherSummaryOf({ documentAst: null, metadata })).toBe("\u00a0");
  expect(await readMetadataSummary(metadata)).toBe("\u00a0");
});

test("both readings honor an explicit absence before falling through", async () => {
  const metadata = {
    [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
      {
        field: "legalSentence",
        reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
      },
    ],
    abstract: "Fallback text",
    legalSentence: "Contradictory text",
  };

  expect(publisherSummaryOf({ documentAst: null, metadata })).toBe(
    "Fallback text",
  );
  expect(await readMetadataSummary(metadata)).toBe("Fallback text");
});

test("both readings leave other text fields present", async () => {
  const metadata = {
    [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
      {
        field: "abstract",
        reason: TEXT_ABSENCE_REASON.PARSE_FAILED,
      },
    ],
    abstract: "Suppressed text",
    legalSentence: "Preferred text",
  };

  expect(publisherSummaryOf({ documentAst: null, metadata })).toBe(
    "Preferred text",
  );
  expect(await readMetadataSummary(metadata)).toBe("Preferred text");
});

test("both readings fail closed on malformed absence sidecars", async () => {
  const malformedSidecars = [
    null,
    "invalid",
    {},
    [null],
    [{ field: "abstract" }],
    [
      {
        field: "abstract",
        reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
      },
    ],
    [
      {
        field: "abstract",
        reason: TEXT_ABSENCE_REASON.PARSE_FAILED,
        unexpected: true,
      },
    ],
    [{ field: "unknown", reason: TEXT_ABSENCE_REASON.PARSE_FAILED }],
    [{ field: "abstract", reason: "unknown" }],
    [
      { field: "abstract", reason: TEXT_ABSENCE_REASON.PARSE_FAILED },
      {
        field: "abstract",
        reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
      },
    ],
  ];

  for (const sidecar of malformedSidecars) {
    const metadata = {
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: sidecar,
      legalArea: "Fallback classification",
      legalSentence: "Untrusted text",
    };
    expect(publisherSummaryOf({ documentAst: null, metadata })).toBe(
      "Fallback classification",
    );
    expect(await readMetadataSummary(metadata)).toBe("Fallback classification");
  }
});

test("both readings agree for arbitrary stored absence shapes", async () => {
  const safeString = fc
    .string({ maxLength: 16 })
    .filter((value) => !value.includes(String.fromCodePoint(0)));
  const scalar = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    safeString,
  );
  const object = fc.dictionary(safeString, scalar, { maxKeys: 4 });
  const sidecar = fc.oneof(
    scalar,
    object,
    fc.array(fc.oneof(scalar, object, fc.array(scalar, { maxLength: 3 })), {
      maxLength: 5,
    }),
  );

  await fc.assert(
    fc.asyncProperty(sidecar, safeString, async (value, candidateText) => {
      const metadata = {
        [DECISION_TEXT_ABSENCE_METADATA_KEY]: value,
        legalArea: "Fallback classification",
        legalSentence: candidateText,
      };
      expect(await readMetadataSummary(metadata)).toBe(
        publisherSummaryOf({ documentAst: null, metadata }),
      );
    }),
    propertyConfig({ numRuns: 100 }),
  );
});
