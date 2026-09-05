import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { SourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import {
  CASE_LAW_REPLAY_SCOPE,
  countReplayability,
  REPLAY_LISTED_PROBLEMS_PER_OUTCOME,
  REPLAY_ROW_OUTCOME,
  replayCaseLawSource,
  selectReplayPage,
  selectScopeEnd,
} from "@/api/handlers/case-law/ingestion/replay";
import type {
  CaseLawReplayScope,
  ReplayVisitBound,
  StoredRawReader,
} from "@/api/handlers/case-law/ingestion/replay";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// The walk's boundary is the thing under test. Postgres stores `timestamptz`
// at microsecond precision and a JS `Date` carries milliseconds, so a cursor
// that leaves the database as a `Date` compares against a truncated value:
// an ascending keyset then re-admits every row inside the boundary's
// millisecond, and the walk never terminates. Every row below is written
// inside ONE millisecond, differing only in its sub-millisecond digits, so
// nothing but exact precision can page through them.

// Relations are wired in because the pipeline's own reads use the relational
// query API; without them `tx.query` is undefined and the apply path below
// would fail for a reason that has nothing to do with replaying.
const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
  });

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the walk expects; the walk
  // only issues reads under this test.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

/** Same millisecond for every row; only the last three digits differ. */
const SHARED_MILLISECOND = "2026-03-01 12:00:00.000";

const microsecondTimestamp = (sub: number): string =>
  `${SHARED_MILLISECOND}${String(sub).padStart(3, "0")}+00`;

type InsertDecisionOptions = {
  sourceId: SafeId<"caseLawSource">;
  id: SafeId<"caseLawDecision">;
  /** Sub-millisecond digits, 0-999. */
  sub: number;
  caseNumber: string;
  court?: string | undefined;
  storedRaw: boolean;
  sourceHash: string;
};

/**
 * Written through raw SQL because a Drizzle insert would carry `created_at`
 * as a JS `Date` and lose exactly the precision under test.
 */
const insertDecision = async ({
  sourceId,
  id,
  sub,
  caseNumber,
  court = "Court of Justice",
  storedRaw,
  sourceHash,
}: InsertDecisionOptions): Promise<void> => {
  // `document_ast` is the empty AST rather than SQL NULL, which is what an
  // ingest writes for a source whose parser produced no structure. A null
  // there is a different stored payload, and the replay would rightly call
  // it a change.
  await db.execute(sql`
    insert into case_law_decisions
      (id, source_id, case_number, court, country, language,
       source_raw_s3_key, source_raw_content_type, source_hash,
       document_ast, metadata, created_at)
    values (
      ${id}, ${sourceId}, ${caseNumber}, ${court}, 'EU', 'en',
      ${storedRaw ? `case-law/raw/${sourceId}/${id}` : null},
      ${storedRaw ? "application/xhtml+xml" : null},
      ${sourceHash},
      '{}'::jsonb,
      ${JSON.stringify({ celex: `celex-${caseNumber}` })}::text::jsonb,
      ${microsecondTimestamp(sub)}::timestamptz
    )`);
};

const createSource = async (): Promise<SafeId<"caseLawSource">> => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `replay-${sourceId}`,
    name: "replay walk fixture",
  });
  return sourceId;
};

/** Bound the walk so a boundary that re-serves its own row fails loudly. */
const WALK_STEP_BUDGET = 200;

const walkIds = async (
  sourceId: SafeId<"caseLawSource">,
  pageSize: number,
): Promise<SafeId<"caseLawDecision">[]> => {
  const seen: SafeId<"caseLawDecision">[] = [];
  const until = await selectScopeEnd({
    scopedDb,
    sourceId,
    scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
  });
  if (until === null) {
    return seen;
  }
  let after: SafeId<"caseLawDecision"> | null = null;
  for (let step = 0; step < WALK_STEP_BUDGET; step += 1) {
    const page = await selectReplayPage({
      scopedDb,
      sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      after,
      until,
      limit: pageSize,
    });
    if (page.length === 0) {
      return seen;
    }
    for (const row of page) {
      seen.push(row.id);
      after = row.id;
    }
  }
  throw new Error(
    `Walk did not terminate within ${WALK_STEP_BUDGET} pages: the boundary re-served its own rows`,
  );
};

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, propertyTestTimeout(120_000));

afterAll(async () => {
  await client.close();
});

describe("replay walk boundary", () => {
  test(
    "every stored decision is served exactly once, at any page size",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(fc.integer({ min: 0, max: 999 }), {
            minLength: 2,
            maxLength: 6,
          }),
          fc.integer({ min: 1, max: 3 }),
          async (subMicroseconds, pageSize) => {
            const sourceId = await createSource();
            const inserted = await Promise.all(
              subMicroseconds.map(async (sub, index) => {
                const id = createSafeId<"caseLawDecision">();
                await insertDecision({
                  sourceId,
                  id,
                  sub,
                  caseNumber: `C-${index}/26`,
                  storedRaw: true,
                  sourceHash: `hash-${index}`,
                });
                return { id, sub };
              }),
            );

            const seen = await walkIds(sourceId, pageSize);

            // Each row exactly once...
            expect(seen).toHaveLength(inserted.length);
            expect(new Set(seen).size).toBe(inserted.length);
            // ...in the order the keyset claims: ascending sub-millisecond
            // timestamp, id breaking a tie that cannot occur here.
            expect(seen).toEqual(
              [...inserted]
                .sort((left, right) => left.sub - right.sub)
                .map(({ id }) => id),
            );
          },
        ),
        propertyConfig({ numRuns: 12 }),
      );
    },
    propertyTestTimeout(60_000),
  );

  test("a millisecond-truncated boundary re-serves the row it stopped on", async () => {
    const sourceId = await createSource();
    const ids = await Promise.all(
      [1, 2, 3].map(async (sub) => {
        const id = createSafeId<"caseLawDecision">();
        await insertDecision({
          sourceId,
          id,
          sub,
          caseNumber: `C-${sub}/26`,
          storedRaw: true,
          sourceHash: `hash-${sub}`,
        });
        return id;
      }),
    );
    const boundaryId = ids[0];
    if (boundaryId === undefined) {
      throw new TypeError("Expected a boundary row");
    }

    const scopeEnd = await selectScopeEnd({
      scopedDb,
      sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
    });
    if (scopeEnd === null) {
      throw new TypeError("Expected the scope to hold replayable rows");
    }

    // The shape the walk uses: the boundary never leaves the database.
    const exact = await selectReplayPage({
      scopedDb,
      sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      after: boundaryId,
      until: scopeEnd,
      limit: 10,
    });
    expect(exact.map((row) => row.id)).not.toContain(boundaryId);
    expect(exact).toHaveLength(2);

    // The shape it must not use. `created_at` is read into a JS `Date`,
    // which drops the sub-millisecond digits; casting the truncated value
    // back to `timestamptz` cannot restore them, so the boundary row is
    // strictly greater than its own cursor and comes back forever.
    const [stored] = await db
      .select({ createdAt: caseLawDecisions.createdAt })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, boundaryId));
    const truncatedBoundary = stored?.createdAt.toISOString();
    expect(truncatedBoundary).toBeDefined();

    const truncated = await db
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        sql`${caseLawDecisions.sourceId} = ${sourceId} and (${caseLawDecisions.createdAt}, ${caseLawDecisions.id}) > (${truncatedBoundary}::timestamptz, ${boundaryId})`,
      );
    expect(truncated.map((row) => row.id)).toContain(boundaryId);
    expect(truncated).toHaveLength(3);
  });
});

const storedRawReader =
  (reads: string[]): StoredRawReader =>
  async (key) => {
    reads.push(key);
    return await Promise.resolve(
      new TextEncoder().encode("<html><body>stored</body></html>"),
    );
  };

type StubAdapterOptions = {
  reparse: NonNullable<SourceAdapter["reparseStoredRaw"]>;
};

const stubAdapter = ({ reparse }: StubAdapterOptions): SourceAdapter => ({
  key: ADAPTER_KEYS.EU_ECJ,
  name: "replay stub",
  country: "EU",
  language: "en",
  minRequestIntervalMs: 0,
  fetchPage: async () => {
    throw new Error("a replay must never fetch from the publisher");
  },
  getTotalCount: async () => {
    throw new Error("a replay must never fetch from the publisher");
  },
  reconciliation: {
    firstSlice: "1970-01-01",
    sliceOf: () => "1970-01-01",
    nextSlice: () => null,
    previousSlice: () => null,
    tipWindowDays: 1,
    listSlicePage: async () => {
      throw new Error("a replay must never list the publisher");
    },
    buildDecision: async () => {
      throw new Error("a replay must never build from publisher data");
    },
  },
  reparseStoredRaw: reparse,
});

describe("replay of a source", () => {
  test("an adapter that cannot re-parse a stored payload is refused, not run", async () => {
    const sourceId = await createSource();
    for (const sub of [1, 2, 3]) {
      await insertDecision({
        sourceId,
        id: createSafeId<"caseLawDecision">(),
        sub,
        caseNumber: `C-${sub}/26`,
        storedRaw: true,
        sourceHash: `hash-${sub}`,
      });
    }

    const refusedReads: string[] = [];
    const refused = await replayCaseLawSource({
      adapter: czNsAdapter,
      scopedDb,
      sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      readStoredRaw: storedRawReader(refusedReads),
      sourceLease: null,
      bound: { type: "at-most", limit: 10 },
      pageSize: 10,
    });

    expect(refused).toEqual({
      type: "unsupported",
      adapterKey: czNsAdapter.key,
    });
    expect(refusedReads).toEqual([]);

    // The same rows, through an adapter that does implement the seam: the
    // refusal above was a refusal, not an empty source.
    const capableReads: string[] = [];
    const ran = await replayCaseLawSource({
      adapter: stubAdapter({
        reparse: () => ({
          type: "rejected",
          rejection: "no-document",
          detail: "stub",
        }),
      }),
      scopedDb,
      sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      readStoredRaw: storedRawReader(capableReads),
      sourceLease: null,
      bound: { type: "at-most", limit: 10 },
      pageSize: 2,
    });

    if (ran.type !== "ran") {
      throw new TypeError("Expected the capable adapter to run");
    }
    expect(ran.report.visited).toBe(3);
    expect(capableReads).toHaveLength(3);
    expect(ran.report.outcomes[REPLAY_ROW_OUTCOME.REJECTED]).toBe(3);
    expect(ran.report.rejections["no-document"]).toBe(3);
  });

  test("a payload read that fails halts the run without stepping over the row", async () => {
    const sourceId = await createSource();
    const ids: SafeId<"caseLawDecision">[] = [];
    for (const sub of [1, 2, 3]) {
      const id = createSafeId<"caseLawDecision">();
      ids.push(id);
      await insertDecision({
        sourceId,
        id,
        sub,
        caseNumber: `C-${sub}/26`,
        storedRaw: true,
        sourceHash: `hash-${sub}`,
      });
    }
    const [firstId, secondId] = ids;
    if (firstId === undefined || secondId === undefined) {
      throw new TypeError("Expected three fixture rows");
    }

    const adapter = stubAdapter({
      reparse: () => ({
        type: "rejected",
        rejection: "no-document",
        detail: "stub",
      }),
    });
    const run = async (readStoredRaw: StoredRawReader) =>
      await replayCaseLawSource({
        adapter,
        scopedDb,
        sourceId,
        scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
        readStoredRaw,
        sourceLease: null,
        bound: { type: "at-most", limit: 10 },
        pageSize: 10,
      });

    // A transport failure on the second row: it says nothing about that
    // decision, so it must not be recorded against it and the resume cursor
    // must stay behind it.
    const failing = await run(async (key) =>
      key.endsWith(secondId)
        ? Promise.reject(new Error("connection reset"))
        : await Promise.resolve(new TextEncoder().encode("<html></html>")),
    );
    if (failing.type !== "ran") {
      throw new TypeError("Expected the capable adapter to run");
    }
    expect(failing.report.visited).toBe(1);
    expect(failing.report.resumeAfter).toBe(firstId);
    expect(failing.report.haltReason).toContain("C-2/26");
    expect(failing.report.outcomes[REPLAY_ROW_OUTCOME.MISSING_PAYLOAD]).toBe(0);

    // A store that confirms it holds no such object is the opposite: a fact
    // about the row, recorded as one, and the walk carries on past it.
    const absent = await run(async () => await Promise.resolve(null));
    if (absent.type !== "ran") {
      throw new TypeError("Expected the capable adapter to run");
    }
    expect(absent.report.visited).toBe(3);
    expect(absent.report.outcomes[REPLAY_ROW_OUTCOME.MISSING_PAYLOAD]).toBe(3);
    expect(absent.report.haltReason).toBeNull();
  });

  test("a resume boundary from another source is refused, not silently empty", async () => {
    const sourceId = await createSource();
    const otherSourceId = await createSource();
    await insertDecision({
      sourceId,
      id: createSafeId<"caseLawDecision">(),
      sub: 1,
      caseNumber: "C-1/26",
      storedRaw: true,
      sourceHash: "hash-1",
    });
    const foreignId = createSafeId<"caseLawDecision">();
    await insertDecision({
      sourceId: otherSourceId,
      id: foreignId,
      sub: 2,
      caseNumber: "C-2/26",
      storedRaw: true,
      sourceHash: "hash-2",
    });

    const reads: string[] = [];
    const adapter = stubAdapter({
      reparse: () => ({
        type: "rejected",
        rejection: "no-document",
        detail: "stub",
      }),
    });
    const resume = async (after: SafeId<"caseLawDecision">) =>
      await replayCaseLawSource({
        adapter,
        scopedDb,
        sourceId,
        scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
        readStoredRaw: storedRawReader(reads),
        sourceLease: null,
        bound: { type: "at-most", limit: 10 },
        pageSize: 10,
        after,
      });

    // Positioned by a row of another source, the keyset would silently skip
    // whatever sorts before that row; unknown ids make the comparison null
    // and return nothing at all. Both read as "no work to do".
    expect(await resume(foreignId)).toEqual({
      type: "unknown-boundary",
      after: foreignId,
    });
    const unknownId = createSafeId<"caseLawDecision">();
    expect(await resume(unknownId)).toEqual({
      type: "unknown-boundary",
      after: unknownId,
    });
    expect(reads).toEqual([]);
  });

  test("a court scope selects, counts, and resumes inside that court only", async () => {
    const sourceId = await createSource();
    const matchingId = createSafeId<"caseLawDecision">();
    const matchingWithoutRawId = createSafeId<"caseLawDecision">();
    const otherCourtId = createSafeId<"caseLawDecision">();
    const court = "Nejvyšší správní soud";
    await insertDecision({
      sourceId,
      id: matchingId,
      sub: 11,
      caseNumber: "4 As 3/2008",
      court,
      storedRaw: true,
      sourceHash: "nss-stored",
    });
    await insertDecision({
      sourceId,
      id: matchingWithoutRawId,
      sub: 12,
      caseNumber: "5 As 4/2009",
      court,
      storedRaw: false,
      sourceHash: "nss-refetch",
    });
    await insertDecision({
      sourceId,
      id: otherCourtId,
      sub: 13,
      caseNumber: "30 Cdo 1/2010",
      court: "Nejvyšší soud",
      storedRaw: true,
      sourceHash: "ns-stored",
    });
    const scope = {
      type: "court",
      court,
    } as const satisfies CaseLawReplayScope;

    const courtEnd = await selectScopeEnd({ scopedDb, sourceId, scope });
    if (courtEnd === null) {
      throw new TypeError("Expected the court scope to hold a replayable row");
    }
    const selected = await selectReplayPage({
      scopedDb,
      sourceId,
      scope,
      after: null,
      until: courtEnd,
      limit: 10,
    });
    expect(selected.map(({ id }) => id)).toEqual([matchingId]);
    expect(await countReplayability({ scopedDb, sourceId, scope })).toEqual({
      storedLocally: 1,
      needsRefetch: 1,
    });

    const reads: string[] = [];
    const adapter = stubAdapter({
      reparse: () => ({
        type: "rejected",
        rejection: "no-document",
        detail: "stub",
      }),
    });
    const outsideBoundary = await replayCaseLawSource({
      adapter,
      scopedDb,
      sourceId,
      scope,
      readStoredRaw: storedRawReader(reads),
      sourceLease: null,
      bound: { type: "at-most", limit: 10 },
      pageSize: 10,
      after: otherCourtId,
    });
    expect(outsideBoundary).toEqual({
      type: "unknown-boundary",
      after: otherCourtId,
    });
    expect(reads).toEqual([]);

    const ran = await replayCaseLawSource({
      adapter,
      scopedDb,
      sourceId,
      scope,
      readStoredRaw: storedRawReader(reads),
      sourceLease: null,
      bound: { type: "at-most", limit: 10 },
      pageSize: 10,
    });
    if (ran.type !== "ran") {
      throw new TypeError("Expected the court-scoped adapter to run");
    }
    expect(ran.report.visited).toBe(1);
    expect(ran.report.resumeAfter).toBe(matchingId);
    expect(reads).toHaveLength(1);
  });

  test("a dry run classifies each row by its re-parsed hash and writes nothing", async () => {
    const sourceId = await createSource();
    const unchangedId = createSafeId<"caseLawDecision">();
    const changedId = createSafeId<"caseLawDecision">();
    await insertDecision({
      sourceId,
      id: unchangedId,
      sub: 1,
      caseNumber: "C-1/26",
      storedRaw: true,
      sourceHash: "stored-hash-1",
    });
    await insertDecision({
      sourceId,
      id: changedId,
      sub: 2,
      caseNumber: "C-2/26",
      storedRaw: true,
      sourceHash: "stored-hash-2",
    });

    const ran = await replayCaseLawSource({
      adapter: stubAdapter({
        // The first row re-parses to what is stored (the fixed point a
        // re-run converges to); the second to something new.
        reparse: (stored) => ({
          type: "parsed",
          result: {
            caseNumber: stored.caseNumber,
            court: stored.court,
            country: "EU",
            language: stored.language,
            metadata: stored.metadata,
            rawHash:
              stored.caseNumber === "C-1/26" ? "stored-hash-1" : "new-hash-2",
            documentAst: EMPTY_AST,
          },
        }),
      }),
      scopedDb,
      sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      readStoredRaw: storedRawReader([]),
      sourceLease: null,
      bound: { type: "at-most", limit: 10 },
      pageSize: 10,
    });

    if (ran.type !== "ran") {
      throw new TypeError("Expected the capable adapter to run");
    }
    expect(ran.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
    expect(ran.report.outcomes[REPLAY_ROW_OUTCOME.WOULD_APPLY]).toBe(1);
    expect(ran.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(0);
    expect(ran.report.resumeAfter).toBe(changedId);

    const rows = await db
      .select({
        id: caseLawDecisions.id,
        sourceHash: caseLawDecisions.sourceHash,
        fulltext: caseLawDecisions.fulltext,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, sourceId));
    expect(rows.map(({ sourceHash }) => String(sourceHash)).toSorted()).toEqual(
      ["stored-hash-1", "stored-hash-2"],
    );
    expect(rows.every(({ fulltext }) => fulltext === null)).toBe(true);
  });

  test("a reparse cannot redirect a replay to another decision identity", async () => {
    const sourceId = await createSource();
    const id = createSafeId<"caseLawDecision">();
    await insertDecision({
      sourceId,
      id,
      sub: 41,
      caseNumber: "C-41/26",
      storedRaw: true,
      sourceHash: "stored-hash-41",
    });

    const ran = await replayCaseLawSource({
      adapter: stubAdapter({
        reparse: (stored) => ({
          type: "parsed",
          result: {
            caseNumber: "C-42/26",
            court: stored.court,
            country: "EU",
            language: stored.language,
            metadata: stored.metadata,
            rawHash: "new-hash-41",
            documentAst: EMPTY_AST,
          },
        }),
      }),
      scopedDb,
      sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      readStoredRaw: storedRawReader([]),
      sourceLease: null,
      bound: { type: "at-most", limit: 10 },
      pageSize: 10,
    });

    if (ran.type !== "ran") {
      throw new TypeError("Expected the capable adapter to run");
    }
    expect(ran.report.rejections["identity-mismatch"]).toBe(1);
    expect(ran.report.problems).toEqual([
      expect.objectContaining({ id, outcome: REPLAY_ROW_OUTCOME.REJECTED }),
    ]);
  });

  test("a pending corpus mirror is reported as work even when content matches", async () => {
    const sourceId = await createSource();
    const id = createSafeId<"caseLawDecision">();
    await insertDecision({
      sourceId,
      id,
      sub: 42,
      caseNumber: "C-42/26",
      storedRaw: true,
      sourceHash: "stored-hash-42",
    });
    await db
      .update(caseLawDecisions)
      .set({ corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING })
      .where(eq(caseLawDecisions.id, id));

    const ran = await replayCaseLawSource({
      adapter: stubAdapter({
        reparse: (stored) => ({
          type: "parsed",
          result: {
            caseNumber: stored.caseNumber,
            court: stored.court,
            country: "EU",
            language: stored.language,
            metadata: stored.metadata,
            rawHash: "stored-hash-42",
            documentAst: EMPTY_AST,
          },
        }),
      }),
      scopedDb,
      sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      readStoredRaw: storedRawReader([]),
      sourceLease: null,
      bound: { type: "at-most", limit: 10 },
      pageSize: 10,
    });

    if (ran.type !== "ran") {
      throw new TypeError("Expected the capable adapter to run");
    }
    expect(ran.report.outcomes[REPLAY_ROW_OUTCOME.WOULD_APPLY]).toBe(1);
    expect(ran.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(0);
  });

  test("every skipped row is listed or counted, and the listing stays bounded", async () => {
    const sourceId = await createSource();
    const inserted = await Promise.all(
      Array.from({ length: 55 }, async (_, index) => {
        const id = createSafeId<"caseLawDecision">();
        await insertDecision({
          sourceId,
          id,
          sub: 100 + index,
          caseNumber: `C-${100 + index}/26`,
          storedRaw: true,
          sourceHash: `stored-hash-${100 + index}`,
        });
        return id;
      }),
    );

    const ran = await replayCaseLawSource({
      adapter: stubAdapter({
        reparse: () => ({
          type: "rejected",
          rejection: "no-document",
          detail: "fixture rejection",
        }),
      }),
      scopedDb,
      sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      readStoredRaw: storedRawReader([]),
      sourceLease: null,
      bound: { type: "at-most", limit: inserted.length },
      pageSize: 13,
    });

    if (ran.type !== "ran") {
      throw new TypeError("Expected the capable adapter to run");
    }
    // The count is exact and every problem row is accounted for, but the
    // listing is capped: a run over a whole source holds this report in
    // memory until it ends.
    expect(ran.report.outcomes[REPLAY_ROW_OUTCOME.REJECTED]).toBe(
      inserted.length,
    );
    expect(ran.report.problems).toHaveLength(
      REPLAY_LISTED_PROBLEMS_PER_OUTCOME,
    );
    expect(ran.report.problems.length + ran.report.omittedProblems).toBe(
      inserted.length,
    );
    const listed = new Set(ran.report.problems.map(({ id }) => id));
    expect(listed.size).toBe(REPLAY_LISTED_PROBLEMS_PER_OUTCOME);
    expect(inserted.filter((id) => listed.has(id))).toHaveLength(listed.size);
    expect(ran.report.resumeAfter).not.toBeNull();
  });

  test("a row ingested after the run's end was read is not visited by it", async () => {
    const sourceId = await createSource();
    await insertDecision({
      sourceId,
      id: createSafeId<"caseLawDecision">(),
      sub: 300,
      caseNumber: "C-300/26",
      storedRaw: true,
      sourceHash: "stored-hash-300",
    });

    const until = await selectScopeEnd({
      scopedDb,
      sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
    });
    if (until === null) {
      throw new TypeError("Expected the scope to hold a replayable row");
    }

    // What a standing ingestion does while an unleased run walks: without a
    // frozen end the walk would follow the source as it grows.
    const arrived = createSafeId<"caseLawDecision">();
    await insertDecision({
      sourceId,
      id: arrived,
      sub: 301,
      caseNumber: "C-301/26",
      storedRaw: true,
      sourceHash: "stored-hash-301",
    });

    const page = await selectReplayPage({
      scopedDb,
      sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      after: null,
      until,
      limit: 10,
    });
    expect(page.map(({ id }) => id)).toEqual([until]);
    expect(page.map(({ id }) => id)).not.toContain(arrived);
  });

  test("an unbounded run visits the whole scope, a bounded one stops at its cap", async () => {
    const sourceId = await createSource();
    const rows = 12;
    await Promise.all(
      Array.from({ length: rows }, async (_, index) => {
        await insertDecision({
          sourceId,
          id: createSafeId<"caseLawDecision">(),
          sub: 200 + index,
          caseNumber: `C-${200 + index}/26`,
          storedRaw: true,
          sourceHash: `stored-hash-${200 + index}`,
        });
      }),
    );

    const replay = async (bound: ReplayVisitBound) =>
      await replayCaseLawSource({
        adapter: stubAdapter({
          reparse: () => ({
            type: "rejected",
            rejection: "no-document",
            detail: "fixture rejection",
          }),
        }),
        scopedDb,
        sourceId,
        scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
        readStoredRaw: storedRawReader([]),
        sourceLease: null,
        bound,
        // Smaller than the scope, so an unbounded run has to page.
        pageSize: 5,
      });

    const all = await replay({ type: "all" });
    const capped = await replay({ type: "at-most", limit: 4 });
    if (all.type !== "ran" || capped.type !== "ran") {
      throw new TypeError("Expected the capable adapter to run");
    }
    expect(all.report.visited).toBe(rows);
    expect(capped.report.visited).toBe(4);
  });

  test("the replayable split counts stored payloads against re-fetches", async () => {
    const sourceId = await createSource();
    for (const [index, storedRaw] of [
      true,
      true,
      false,
      false,
      false,
    ].entries()) {
      await insertDecision({
        sourceId,
        id: createSafeId<"caseLawDecision">(),
        sub: index,
        caseNumber: `C-${index}/26`,
        storedRaw,
        sourceHash: `hash-${index}`,
      });
    }

    expect(
      await countReplayability({
        scopedDb,
        sourceId,
        scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      }),
    ).toEqual({
      storedLocally: 2,
      needsRefetch: 3,
    });
  });
});
