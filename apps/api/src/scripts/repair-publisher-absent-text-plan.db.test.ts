import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, count, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  absentTextComparisonsFor,
  sourceTextOrAbsent,
} from "@/api/handlers/case-law/ingestion/adapters/absent-source-text";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { publisherHeadnoteOf } from "@/api/lib/case-law/publisher-summary";
import {
  carriesAbsentPublisherText,
  carriesDeclaredAbsentPublisherText,
  strippedPublisherMetadata,
} from "@/api/scripts/repair-publisher-absent-text-plan";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The repair recognises a marker in SQL while the adapters recognise it in
 * TypeScript, and the two readings have to be the same reading: a row the
 * write path would now store without the sentence but the repair does not
 * strip keeps serving it forever, and a row the repair strips that the write
 * path would have kept loses a real headnote. Both directions are checked
 * here against a real PostgreSQL, over the value shapes the sources publish.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const usSourceId = createSafeId<"caseLawSource">();
const nsSourceId = createSafeId<"caseLawSource">();

const HEADNOTE = "Uloží-li soud rodičům povinnost účastnit se mediace.";
const LEGAL_SENTENCE_MARKER = "Právní věta není k dispozici.";
const ABSTRACT_MARKER = "Abstrakt není k dispozici.";

type Fixture = {
  id: SafeId<"caseLawDecision">;
  label: string;
  metadata: Record<string, unknown>;
  sourceId: SafeId<"caseLawSource">;
  /** Metadata keys the repair must remove from this row. */
  stripped: readonly string[];
};

const bothMarkers: Fixture = {
  id: createSafeId<"caseLawDecision">(),
  label: "both fields carry the court's own absence sentence",
  metadata: {
    abstract: ABSTRACT_MARKER,
    legalSentence: LEGAL_SENTENCE_MARKER,
    keywords: ["Daně", "Správní řízení"],
  },
  sourceId: usSourceId,
  stripped: ["abstract", "legalSentence"],
};

const wrappedMarker: Fixture = {
  id: createSafeId<"caseLawDecision">(),
  label: "the marker as the page indents and wraps it",
  metadata: { legalSentence: "  Právní   věta\nnení k dispozici.  " },
  sourceId: usSourceId,
  stripped: ["legalSentence"],
};

const writtenHeadnote: Fixture = {
  id: createSafeId<"caseLawDecision">(),
  label: "a headnote the court wrote, beside an empty abstract",
  metadata: { legalSentence: HEADNOTE, abstract: ABSTRACT_MARKER },
  sourceId: usSourceId,
  stripped: ["abstract"],
};

const nearMiss: Fixture = {
  id: createSafeId<"caseLawDecision">(),
  label: "a sentence that only opens like the marker",
  metadata: {
    legalSentence: `${LEGAL_SENTENCE_MARKER.slice(0, -1)} v tomto jazyce.`,
  },
  sourceId: usSourceId,
  stripped: [],
};

const nothingPublished: Fixture = {
  id: createSafeId<"caseLawDecision">(),
  label: "a decision the publisher filled nothing in for",
  metadata: {},
  sourceId: usSourceId,
  stripped: [],
};

const wrongShape: Fixture = {
  id: createSafeId<"caseLawDecision">(),
  label: "a value of the wrong JSON shape under a summary key",
  metadata: { legalSentence: 42, summary: ["not prose"] },
  sourceId: usSourceId,
  stripped: [],
};

/**
 * A marker belongs to the source that prints it. Another source's row holding
 * the same words is left alone: its adapter does not read the sentence as
 * absence, so the next crawl would write it straight back and the repair would
 * never reach a fixed point.
 */
const otherSource: Fixture = {
  id: createSafeId<"caseLawDecision">(),
  label: "another source's row carrying the same sentence",
  metadata: { summary: LEGAL_SENTENCE_MARKER },
  sourceId: nsSourceId,
  stripped: [],
};

const fixtures: readonly Fixture[] = [
  bothMarkers,
  wrappedMarker,
  writtenHeadnote,
  nearMiss,
  nothingPublished,
  wrongShape,
  otherSource,
];

const INDEXED_HASH = "a".repeat(64);

/** Which adapter each seeded source belongs to, and so which markers it has. */
const ADAPTER_OF_SOURCE = new Map([
  [usSourceId, ADAPTER_KEYS.CZ_US],
  [nsSourceId, ADAPTER_KEYS.CZ_NS],
]);

const markersOf = (sourceId: SafeId<"caseLawSource">): readonly string[] => {
  const adapter = ADAPTER_OF_SOURCE.get(sourceId);
  return adapter === undefined ? [] : absentTextComparisonsFor(adapter);
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.insert(caseLawSources).values([
      { id: usSourceId, adapterKey: ADAPTER_KEYS.CZ_US, name: "us source" },
      { id: nsSourceId, adapterKey: ADAPTER_KEYS.CZ_NS, name: "ns source" },
    ]);
  },
  { timeout: 120_000 },
);

// Every test seeds its own rows, so each states its whole precondition and one
// selected by name behaves as it does in a whole run.
beforeEach(async () => {
  await db.delete(caseLawDecisions).where(
    inArray(
      caseLawDecisions.id,
      fixtures.map(({ id }) => id),
    ),
  );
  await db.insert(caseLawDecisions).values(
    fixtures.map((fixture, index) => ({
      id: fixture.id,
      sourceId: fixture.sourceId,
      caseNumber: `${String(index)} C ${String(index)}/2020`,
      court: "Ústavní soud",
      country: "CZE",
      language: "cs",
      decisionDate: "2024-01-01",
      metadata: fixture.metadata,
      // Both hashes present and equal: the row reads as projected and up to
      // date, which is the state a metadata-only change has to disturb.
      contentHash: INDEXED_HASH,
      indexedHash: INDEXED_HASH,
      slug: `fixture-${String(index)}`,
      languageGroupKey: `fixture-${String(index)}`,
    })),
  );
});

afterAll(async () => {
  await client.close();
});

const storedRows = async (): Promise<
  Map<string, { metadata: Record<string, unknown> | null; indexed: boolean }>
> => {
  const rows = await db
    .select({
      id: caseLawDecisions.id,
      metadata: caseLawDecisions.metadata,
      indexedHash: caseLawDecisions.indexedHash,
    })
    .from(caseLawDecisions)
    .where(
      inArray(
        caseLawDecisions.id,
        fixtures.map(({ id }) => id),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.id,
      { metadata: row.metadata, indexed: row.indexedHash !== null },
    ]),
  );
};

/** The repair's own write over one source's rows, with that source's markers. */
const repair = async (sourceId: SafeId<"caseLawSource">): Promise<string[]> => {
  const markers = markersOf(sourceId);
  const repaired = await db
    .update(caseLawDecisions)
    .set({
      metadata: strippedPublisherMetadata(markers),
      indexedHash: null,
    })
    .where(
      and(
        eq(caseLawDecisions.sourceId, sourceId),
        carriesAbsentPublisherText(markers),
      ),
    )
    .returning({ id: caseLawDecisions.id });
  return repaired.map(({ id }) => id);
};

/** Both sources, as one run of the script would walk them. */
const repairEverySource = async (): Promise<Set<string>> =>
  new Set([...(await repair(usSourceId)), ...(await repair(nsSourceId))]);

/** The survey the script reads before it writes anything. */
const surveyed = async (): Promise<{ adapterKey: string; rows: number }[]> =>
  await db
    .select({ adapterKey: caseLawSources.adapterKey, rows: count() })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(carriesDeclaredAbsentPublisherText)
    .groupBy(caseLawSources.id, caseLawSources.adapterKey);

test("the survey counts the rows a repair would touch, per source", async () => {
  const perSource = new Map(
    (await surveyed()).map(({ adapterKey, rows }) => [adapterKey, rows]),
  );

  expect(perSource.get(ADAPTER_KEYS.CZ_US)).toBe(
    fixtures.filter(
      ({ sourceId, stripped }) =>
        sourceId === usSourceId && stripped.length > 0,
    ).length,
  );
  // The other source's row holds the same sentence and is still not counted:
  // its adapter declares no marker, so nothing about it is absence.
  expect(perSource.has(ADAPTER_KEYS.CZ_NS)).toBe(false);
});

test("a marker is only absence for the source that prints it", async () => {
  expect(await repair(nsSourceId)).toEqual([]);
  const stored = await storedRows();
  expect(stored.get(otherSource.id)?.metadata).toEqual(otherSource.metadata);
  expect(stored.get(otherSource.id)?.indexed).toBe(true);
  // The same words at the source that does declare them are absence, so the
  // assertion above is scope rather than a predicate that matches nothing.
  expect(await repair(usSourceId)).toContain(bothMarkers.id);
});

test("the repair strips exactly the keys the write path would now leave absent", async () => {
  const repaired = await repairEverySource();
  const stored = await storedRows();

  for (const fixture of fixtures) {
    const row = stored.get(fixture.id);
    expect(row).toBeDefined();
    const metadata: Record<string, unknown> = row?.metadata ?? {};

    for (const key of fixture.stripped) {
      expect(metadata).not.toHaveProperty(key);
    }
    // Everything the row held besides the stripped keys is still there, with
    // the value the publisher published.
    for (const [key, value] of Object.entries(fixture.metadata)) {
      if (fixture.stripped.includes(key)) {
        continue;
      }
      expect(metadata[key]).toEqual(value);
    }
    // A changed row is re-enqueued for the index; an untouched one is left
    // exactly as it was, so the repair cannot re-project the whole corpus.
    expect(repaired.has(fixture.id)).toBe(fixture.stripped.length > 0);
    expect(row?.indexed).toBe(fixture.stripped.length === 0);
  }
});

test("what the repair strips is what that source's adapter reads as absent", async () => {
  // The binding: the SQL reading and `sourceTextOrAbsent` decide the same way
  // about the same stored values, under the same adapter, so a marker declared
  // once is recognised on both the write path and the repair path.
  await repairEverySource();
  const stored = await storedRows();
  for (const fixture of fixtures) {
    const adapter = ADAPTER_OF_SOURCE.get(fixture.sourceId);
    expect(adapter).toBeDefined();
    const after: Record<string, unknown> =
      stored.get(fixture.id)?.metadata ?? {};
    for (const [key, value] of Object.entries(fixture.metadata)) {
      if (typeof value !== "string" || adapter === undefined) {
        continue;
      }
      expect(key in after).toBe(
        sourceTextOrAbsent(adapter, value) !== undefined,
      );
    }
  }
});

test("a repaired row shows the next headnote the publisher wrote, or none", async () => {
  await repairEverySource();
  const stored = await storedRows();
  const headnoteOf = (id: SafeId<"caseLawDecision">): string | null =>
    publisherHeadnoteOf({
      documentAst: null,
      metadata: stored.get(id)?.metadata ?? null,
    });

  expect(headnoteOf(bothMarkers.id)).toBeNull();
  expect(headnoteOf(wrappedMarker.id)).toBeNull();
  expect(headnoteOf(writtenHeadnote.id)).toBe(HEADNOTE);
});

test("a second pass finds nothing left to repair", async () => {
  await repairEverySource();
  expect(await repair(usSourceId)).toEqual([]);
  expect(await repair(nsSourceId)).toEqual([]);
  expect(await surveyed()).toEqual([]);
});
