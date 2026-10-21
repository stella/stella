import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty, propertyConfig } from "@stll/property-testing";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_SLICE_CONFIG,
  corpusSliceManifest,
  isInCorpusSlice,
  parseCorpusSliceManifest,
} from "@/api/lib/case-law/corpus-slice";
import type { CorpusSliceRow } from "@/api/lib/case-law/corpus-slice";
import { corpusSliceCensus } from "@/api/lib/case-law/corpus-slice-census";
import { corpusSliceCensusOutput } from "@/api/scripts/corpus-slice-census-output";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const rowArbitrary = fc.record({
  id: fc.constantFrom(
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
  ),
  sourceKey: fc.string({ minLength: 1, maxLength: 8 }),
  court: fc.string({ minLength: 1, maxLength: 12 }),
  decisionDate: fc.option(
    fc
      .date({
        min: new Date("1990-01-01T00:00:00.000Z"),
        max: new Date("2040-12-31T00:00:00.000Z"),
        noInvalidDate: true,
      })
      .map((date) => date.toISOString().slice(0, 10)),
    { nil: null },
  ),
});

test("the corpus slice contains exactly recent or pinned decisions", () => {
  assertProperty(
    "the corpus slice contains exactly recent or pinned decisions",
    fc.property(
      rowArbitrary,
      fc.date({
        min: new Date("2000-01-01T00:00:00.000Z"),
        max: new Date("2035-12-31T23:59:59.999Z"),
        noInvalidDate: true,
      }),
      (row, asOf) => {
        const firstYear =
          asOf.getUTCFullYear() - CORPUS_SLICE_CONFIG.recentYears + 1;
        const expected =
          CORPUS_SLICE_CONFIG.pinnedDecisionIds.includes(row.id) ||
          (row.decisionDate !== null &&
            Number.parseInt(row.decisionDate.slice(0, 4), 10) >= firstYear &&
            new Date(`${row.decisionDate}T00:00:00.000Z`) <= asOf);
        expect(isInCorpusSlice(row, { asOf })).toBe(expected);
      },
    ),
    propertyConfig({ numRuns: 100 }),
  );
});

test("the manifest groups every slice member and has an order-independent digest", () => {
  assertProperty(
    "the manifest groups every slice member and has an order-independent digest",
    fc.property(
      fc.array(rowArbitrary, { maxLength: 40 }),
      fc.date({
        min: new Date("2000-01-01T00:00:00.000Z"),
        max: new Date("2035-12-31T23:59:59.999Z"),
        noInvalidDate: true,
      }),
      (rows, asOf) => {
        const manifest = corpusSliceManifest(rows, asOf);
        const members = rows.filter((row) => isInCorpusSlice(row, { asOf }));
        expect(manifest.memberCount).toBe(members.length);
        expect(manifest.cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(
          members.length,
        );
        expect(corpusSliceManifest(rows.toReversed(), asOf)).toEqual(manifest);
        expect(parseCorpusSliceManifest(manifest).isOk()).toBe(true);
      },
    ),
    propertyConfig({ numRuns: 100 }),
  );
});

describe("the corpus slice census", () => {
  const sourceId = createSafeId<"caseLawSource">();
  const firstId = createSafeId<"caseLawDecision">();
  const secondId = createSafeId<"caseLawDecision">();
  const extraId = createSafeId<"caseLawDecision">();
  const replacementId = createSafeId<"caseLawDecision">();
  const asOf = new Date("2026-10-20T12:00:00.000Z");
  const firstRow: CorpusSliceRow = {
    id: firstId,
    sourceKey: "test-source",
    court: "First Court",
    decisionDate: "2026-01-02",
  };
  const secondRow: CorpusSliceRow = {
    id: secondId,
    sourceKey: "test-source",
    court: "Second Court",
    decisionDate: "2025-02-03",
  };
  const rows = [firstRow, secondRow];
  const manifest = corpusSliceManifest(rows, asOf);
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  const readDb = async <T>(
    read: (tx: Pick<typeof db, "select">) => Promise<T>,
  ): Promise<T> =>
    await withPublicLawReaderRole(db, async (tx) => await read(tx));

  const decision = (row: CorpusSliceRow) => ({
    id: row.id,
    sourceId,
    caseNumber: row.id,
    country: "ZZZ",
    language: "en",
    court: row.court,
    decisionDate: row.decisionDate,
  });

  beforeAll(async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db.insert(caseLawSources).values(
      caseLawSourceRow({
        id: sourceId,
        adapterKey: "test-source",
        name: "Test source",
      }),
    );
    await db.insert(caseLawDecisions).values(rows.map(decision));
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  test("a database holding exactly the slice is complete", async () => {
    expect(await corpusSliceCensus(manifest, readDb)).toMatchObject({
      verdict: "complete",
      cells: [{ type: "complete" }, { type: "complete" }],
    });
  });

  test("one missing decision marks its cell missing", async () => {
    await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, firstId));
    const census = await corpusSliceCensus(manifest, readDb);
    expect(census.verdict).toBe("incomplete");
    expect(census.cells).toContainEqual({
      type: "missing",
      sourceKey: "test-source",
      court: "First Court",
      year: { type: "year", year: 2026 },
      expected: 1,
      held: 0,
    });
    await db.insert(caseLawDecisions).values(decision(firstRow));
  });

  test("one extra decision marks its cell extra", async () => {
    await db.insert(caseLawDecisions).values(
      decision({
        id: extraId,
        sourceKey: "test-source",
        court: "Extra Court",
        decisionDate: "2024-04-05",
      }),
    );
    const census = await corpusSliceCensus(manifest, readDb);
    expect(census.verdict).toBe("incomplete");
    expect(census.cells).toContainEqual({
      type: "extra",
      sourceKey: "test-source",
      court: "Extra Court",
      year: { type: "year", year: 2024 },
      held: 1,
    });
    await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, extraId));
  });

  test("a same-cell replacement reports a membership mismatch", async () => {
    await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, firstId));
    await db
      .insert(caseLawDecisions)
      .values(decision({ ...firstRow, id: replacementId }));
    const census = await corpusSliceCensus(manifest, readDb);
    expect(census).toMatchObject({
      verdict: "membership_mismatch",
      cells: [{ type: "complete" }, { type: "complete" }],
    });
    expect(corpusSliceCensusOutput(census)).toEqual({
      json: expect.stringContaining('"verdict": "membership_mismatch"'),
      exitCode: 1,
    });
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.id, replacementId));
    await db.insert(caseLawDecisions).values(decision(firstRow));
  });

  test("a manifest whose member count disagrees is not complete", async () => {
    const census = await corpusSliceCensus(
      { ...manifest, memberCount: manifest.memberCount + 1 },
      readDb,
    );
    expect(census.verdict).toBe("membership_mismatch");
  });
});
