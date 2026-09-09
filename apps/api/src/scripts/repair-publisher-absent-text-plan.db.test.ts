/**
 * The repair's two halves against a real PostgreSQL: the walk, which decides
 * which stored rows are looked at at all, and the write, which decides what a
 * looked-at row becomes. Neither is exercised anywhere else — an operator
 * script's SQL is never executed by CI — and the SQL reading of a marker has
 * to agree with the TypeScript one the adapters write through, or the two
 * paths disagree about what absence is.
 *
 * The source fixture is deliberately larger than a page. The fault this walk
 * was rebuilt for only appears at scale: a selection bounded by matches reads
 * to the end of a source looking for rows that are not there, which a handful
 * of fixtures can never show.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  TEXT_FIELD_TYPE,
  absentTextComparisonsFor,
  sourceTextField,
} from "@/api/lib/case-law/decision-text";
import { publisherHeadnoteOf } from "@/api/lib/case-law/publisher-summary";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  absentTextSourcesStatement,
  carriesAbsentPublisherText,
  parseAbsentTextPage,
  parseAbsentTextSources,
  selectAbsentTextPageStatement,
  strippedPublisherMetadata,
} from "@/api/scripts/repair-publisher-absent-text-plan";
import type {
  AbsentTextCursor,
  AbsentTextPage,
} from "@/api/scripts/repair-publisher-absent-text-plan";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const usSourceId = createSafeId<"caseLawSource">();
const nsSourceId = createSafeId<"caseLawSource">();

const HEADNOTE = "Uloží-li soud rodičům povinnost účastnit se mediace.";
const LEGAL_SENTENCE_MARKER = "Právní věta není k dispozici.";
const ABSTRACT_MARKER = "Abstrakt není k dispozici.";
const NEAR_MISS = "Právní věta není k dispozici v tomto jazyce.";

/** When the fixtures were last written, long before any run of the repair. */
const STORED_AT = new Date("2020-01-01T00:00:00.000Z");

/** Rows the source holds. Several pages' worth at the size the walk uses. */
const SOURCE_ROWS = 240;

const US_MARKERS = absentTextComparisonsFor(ADAPTER_KEYS.CZ_US);
const NS_MARKERS = absentTextComparisonsFor(ADAPTER_KEYS.CZ_NS);

/**
 * What each interesting row of the source holds under its publisher-summary
 * keys. Spread on purpose, and with a long run of ordinary rows after the last
 * of them: a walk that only advanced on a match would stall exactly there.
 */
const PLANTED = new Map<number, Record<string, unknown>>([
  [
    3,
    {
      abstract: ABSTRACT_MARKER,
      legalSentence: LEGAL_SENTENCE_MARKER,
      keywords: ["Daně", "Správní řízení"],
    },
  ],
  [4, { legalSentence: "  Právní   věta\nnení k dispozici.  " }],
  [97, { legalSentence: HEADNOTE, abstract: ABSTRACT_MARKER }],
  [98, { legalSentence: NEAR_MISS }],
  [140, { legalSentence: 42, summary: ["not prose"] }],
  [141, { abstract: ABSTRACT_MARKER }],
]);

/** Which keys the repair must remove from each planted row. */
const STRIPPED = new Map<number, readonly string[]>([
  [3, ["abstract", "legalSentence"]],
  [4, ["legalSentence"]],
  [97, ["abstract"]],
  [98, []],
  [140, []],
  [141, ["abstract"]],
]);

const fixtureIds = Array.from({ length: SOURCE_ROWS }, () =>
  createSafeId<"caseLawDecision">(),
);

/** The id at `index`, which the fixture array is built to hold. */
const fixtureId = (index: number): SafeId<"caseLawDecision"> => {
  const id = fixtureIds[index];
  if (id === undefined) {
    throw new Error(`no fixture at ${String(index)}`);
  }
  return id;
};

/** The metadata row `index` holds: a headnote the court wrote, unless planted. */
const metadataOf = (index: number): Record<string, unknown> =>
  PLANTED.get(index) ?? { legalSentence: `${HEADNOTE} (${String(index)})` };

const strippedOf = (index: number): readonly string[] =>
  STRIPPED.get(index) ?? [];

const markerIds = new Set(
  [...STRIPPED.entries()]
    .filter(([, keys]) => keys.length > 0)
    .map(([index]) => fixtureId(index)),
);

/**
 * The other source's row, holding the same words under a summary key. Its
 * adapter declares no marker, so nothing about it is absence.
 */
const otherSourceId = createSafeId<"caseLawDecision">();
const OTHER_SOURCE_METADATA = { summary: LEGAL_SENTENCE_MARKER };

const INDEXED_HASH = "a".repeat(64);

/** Read one page, exactly as the script reads it. */
const readPage = async (
  after: AbsentTextCursor | null,
  pageSize: number,
): Promise<AbsentTextPage> =>
  parseAbsentTextPage(
    executedRows(
      await db.execute(
        selectAbsentTextPageStatement({
          after,
          markers: US_MARKERS,
          pageSize,
          sourceId: usSourceId,
        }),
      ),
    ),
  );

type Walk = {
  /** Every page the walk read, in order. */
  pages: AbsentTextPage[];
  ids: SafeId<"caseLawDecision">[];
};

/** Walk the source to its end, as the script's loop does. */
const walk = async (pageSize: number): Promise<Walk> => {
  const pages: AbsentTextPage[] = [];
  const ids: SafeId<"caseLawDecision">[] = [];
  let cursor: AbsentTextCursor | null = null;
  // A walk that does not terminate is the failure this test exists to catch,
  // so the loop is bounded and the bound is asserted rather than trusted.
  for (let read = 0; read <= SOURCE_ROWS + 2; read += 1) {
    const page = await readPage(cursor, pageSize);
    pages.push(page);
    ids.push(...page.ids);
    if (page.cursor === null) {
      return { pages, ids };
    }
    cursor = page.cursor;
  }
  throw new Error("the walk did not reach the end of the source");
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
  await db
    .delete(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [...fixtureIds, otherSourceId]));
  await db.insert(caseLawDecisions).values([
    ...fixtureIds.map((id, index) => ({
      id,
      sourceId: usSourceId,
      caseNumber: `${String(index)} C ${String(index)}/2020`,
      court: "Ústavní soud",
      country: "CZE",
      language: "cs",
      decisionDate: "2024-01-01",
      metadata: metadataOf(index),
      // Both hashes present and equal: the row reads as projected and up to
      // date, which is the state a metadata-only change has to disturb.
      contentHash: INDEXED_HASH,
      indexedHash: INDEXED_HASH,
      slug: `us-${String(index)}`,
      languageGroupKey: `us-${String(index)}`,
      // Distinct and increasing, so the walk's order is the one the index
      // serves and a page boundary falls where this test says it does.
      createdAt: new Date(STORED_AT.getTime() + index * 1000),
    })),
    {
      id: otherSourceId,
      sourceId: nsSourceId,
      caseNumber: "1 C 1/2020",
      court: "Nejvyšší soud",
      country: "CZE",
      language: "cs",
      decisionDate: "2024-01-01",
      metadata: OTHER_SOURCE_METADATA,
      contentHash: INDEXED_HASH,
      indexedHash: INDEXED_HASH,
      slug: "ns-1",
      languageGroupKey: "ns-1",
      createdAt: STORED_AT,
    },
  ]);
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
    .where(inArray(caseLawDecisions.id, [...fixtureIds, otherSourceId]));
  return new Map(
    rows.map((row) => [
      row.id,
      { metadata: row.metadata, indexed: row.indexedHash !== null },
    ]),
  );
};

/** The repair's own write over one source's rows, with that source's markers. */
const repair = async (
  sourceId: SafeId<"caseLawSource">,
  markers: readonly string[],
): Promise<string[]> => {
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
  new Set([
    ...(await repair(usSourceId, US_MARKERS)),
    ...(await repair(nsSourceId, NS_MARKERS)),
  ]);

describe("the walk", () => {
  test("finds the sources by the adapters that declare a marker", async () => {
    const sources = parseAbsentTextSources(
      executedRows(
        await db.execute(absentTextSourcesStatement([ADAPTER_KEYS.CZ_US])),
      ),
    );
    expect(sources).toEqual([
      { adapterKey: ADAPTER_KEYS.CZ_US, sourceId: usSourceId },
    ]);
    expect(
      parseAbsentTextSources(
        executedRows(await db.execute(absentTextSourcesStatement([]))),
      ),
    ).toEqual([]);
  });

  test("examines one bounded page per statement", async () => {
    const pageSize = 50;
    const { pages } = await walk(pageSize);

    // What bounds a statement is rows examined, so that is what is asserted:
    // no page may read more than it was given, however few of its rows match.
    expect(pages.every((page) => page.scanned <= pageSize)).toBe(true);
    // Every row of the source is examined exactly once, and the walk stops on
    // the empty page that follows the last full one.
    expect(pages.reduce((total, page) => total + page.scanned, 0)).toBe(
      SOURCE_ROWS,
    );
    expect(pages).toHaveLength(Math.ceil(SOURCE_ROWS / pageSize) + 1);
    expect(pages.at(-1)?.cursor).toBeNull();
  });

  test("advances over a page whose rows all hold", async () => {
    const { pages } = await walk(50);
    const barren = pages.filter(
      (page) => page.scanned > 0 && page.ids.length === 0,
    );
    // The fixture puts a long run of ordinary rows after the last planted one,
    // so this is not a vacuous filter: a page that matched nothing still
    // states where the next one starts.
    expect(barren.length).toBeGreaterThan(0);
    expect(barren.every((page) => page.cursor !== null)).toBe(true);
  });

  test("reads the same rows however it is paged", async () => {
    const finely = await walk(7);
    const coarsely = await walk(SOURCE_ROWS * 2);

    expect(finely.ids.toSorted()).toEqual(coarsely.ids.toSorted());
    expect(coarsely.pages).toHaveLength(2);
  });

  test("reads this source's rows carrying one of its own markers", async () => {
    const { ids } = await walk(50);
    expect(new Set(ids)).toEqual(markerIds);
  });

  test("pages across rows that share a millisecond", async () => {
    // `created_at` holds microseconds. A cursor carried at millisecond
    // precision compares as the start of its millisecond, so every row sharing
    // that millisecond is read again on the next page — a page boundary inside
    // one never advances, and the walk does not end. Ten rows are moved into a
    // single millisecond, two of them carrying markers, and the page size is
    // small enough that a boundary lands among them.
    const shared = Array.from({ length: 10 }, (_, offset) => 95 + offset);
    await db.execute(sql`
      UPDATE case_law_decisions AS d
         SET created_at = timestamptz '2020-01-01 00:01:35Z'
                        + (v.micros * interval '1 microsecond')
        FROM (VALUES ${sql.join(
          shared.map(
            (index, position) =>
              sql`(${fixtureId(index)}::uuid, ${position + 1}::int)`,
          ),
          sql`, `,
        )}) AS v(id, micros)
       WHERE d.id = v.id
    `);

    // The walk terminates — its own bound throws otherwise — and every row is
    // examined exactly once: a re-read would push the total above the source,
    // a skip would leave it below.
    const { pages, ids } = await walk(3);
    expect(pages.reduce((total, page) => total + page.scanned, 0)).toBe(
      SOURCE_ROWS,
    );
    // The markers inside the shared millisecond are still each found once.
    expect(new Set(ids)).toEqual(markerIds);
    expect(ids).toHaveLength(markerIds.size);
  });

  test("refuses a cursor that is not the database's own text form", () => {
    // The precision has to be pinned at the parser, because whether a driver
    // hands back text or a date object is a driver's choice: `pglite` returns
    // the microseconds as text, and a driver that returns a date instead would
    // round them away and page from the start of the millisecond. The
    // statement asks for text, so anything else is a page this walk must not
    // continue from.
    expect(() =>
      parseAbsentTextPage([
        {
          cursor_created_at: new Date(),
          cursor_id: fixtureId(0),
          scanned: 1,
          match_id: null,
        },
      ]),
    ).toThrow(/cursor_created_at/u);
  });

  test("does not read another source's rows", async () => {
    const { ids } = await walk(50);
    expect(ids).not.toContain(otherSourceId);
  });
});

describe("the write", () => {
  test("strips exactly the keys the write path would now leave absent", async () => {
    const repaired = await repairEverySource();
    const stored = await storedRows();

    for (const [index, id] of fixtureIds.entries()) {
      const row = stored.get(id);
      expect(row).toBeDefined();
      const metadata: Record<string, unknown> = row?.metadata ?? {};
      const stripped = strippedOf(index);

      for (const key of stripped) {
        expect(metadata).not.toHaveProperty(key);
      }
      // Everything the row held besides the stripped keys is still there, with
      // the value the publisher published.
      for (const [key, value] of Object.entries(metadataOf(index))) {
        if (stripped.includes(key)) {
          continue;
        }
        expect(metadata[key]).toEqual(value);
      }
      // A changed row is re-enqueued for the index; an untouched one is left
      // exactly as it was, so the repair cannot re-project the whole corpus.
      expect(repaired.has(id)).toBe(stripped.length > 0);
      expect(row?.indexed).toBe(stripped.length === 0);
    }
  });

  test("a marker is only absence for the source that prints it", async () => {
    expect(await repair(nsSourceId, NS_MARKERS)).toEqual([]);
    const stored = await storedRows();
    expect(stored.get(otherSourceId)?.metadata).toEqual(OTHER_SOURCE_METADATA);
    expect(stored.get(otherSourceId)?.indexed).toBe(true);
    // The same words at the source that does declare them are absence, so the
    // assertion above is scope rather than a predicate that matches nothing.
    expect(await repair(usSourceId, US_MARKERS)).toContain(fixtureId(3));
  });

  test("what the repair strips is what that source's adapter reads as absent", async () => {
    // The binding: the SQL reading and `sourceTextField` decide the same
    // way about the same stored values, under the same adapter, so a marker
    // declared once is recognised on both the write path and the repair path.
    await repairEverySource();
    const stored = await storedRows();
    for (const [index, id] of fixtureIds.entries()) {
      const after: Record<string, unknown> = stored.get(id)?.metadata ?? {};
      for (const [key, value] of Object.entries(metadataOf(index))) {
        if (typeof value !== "string") {
          continue;
        }
        expect(key in after).toBe(
          sourceTextField(ADAPTER_KEYS.CZ_US, value).type ===
            TEXT_FIELD_TYPE.PRESENT,
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

    expect(headnoteOf(fixtureId(3))).toBeNull();
    expect(headnoteOf(fixtureId(4))).toBeNull();
    expect(headnoteOf(fixtureId(97))).toBe(HEADNOTE);
    expect(headnoteOf(fixtureId(98))).toBe(NEAR_MISS);
  });

  test("a second pass finds nothing left to repair", async () => {
    await repairEverySource();
    expect(await repair(usSourceId, US_MARKERS)).toEqual([]);
    expect(await repair(nsSourceId, NS_MARKERS)).toEqual([]);
    expect((await walk(50)).ids).toEqual([]);
  });
});
