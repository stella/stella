import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  caseLawCorpusPackRefs,
  caseLawDecisionJudges,
  caseLawDecisions,
  caseLawDecisionSupplements,
  caseLawSources,
  euCompletionControls,
  SOURCE_TOTAL_ORIGIN,
} from "@/api/db/schema";
import { createEuCompletionStore } from "@/api/handlers/case-law/ingestion/eu-completion-store";
import {
  LISTING_CENSUS_CONFIG_KEY,
  LISTING_CENSUS_STATUS,
  recordSlice,
} from "@/api/handlers/case-law/ingestion/listing-census";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import {
  placeSupplementTx,
  supplementContent,
} from "@/api/handlers/case-law/ingestion/pipeline/supplement-placement";
import { setSourceReportedTotal } from "@/api/handlers/case-law/ingestion/source-totals";
import { replaceDecisionJudges } from "@/api/handlers/case-law/judges/decision-judges";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import {
  replayRawWrite,
  replayWrite,
  replayWriteOutcome,
} from "@/api/lib/case-law/replay-write";
import { executedRows } from "@/api/lib/db/executed-rows";
import { recordCorpusPackRefsTx } from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { DECISION_SUPPLEMENT_KIND } from "@/api/lib/legal-search/decision-supplement-kind";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import type { DecisionSupplement } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const fixture = async (
  run: (
    db: GatedTestDb,
    sourceId: ReturnType<typeof createSafeId<"caseLawSource">>,
    decisionId: ReturnType<typeof createSafeId<"caseLawDecision">>,
  ) => Promise<void>,
) => {
  if (!databaseUrl || !enabled) {
    return panic("Postgres fixture not enabled");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db } = openClient({ max: 1 });
    const sourceId = createSafeId<"caseLawSource">();
    const decisionId = createSafeId<"caseLawDecision">();
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: sourceId,
      name: "Replay contract fixture",
    });
    await db.insert(caseLawDecisions).values({
      id: decisionId,
      sourceId,
      caseNumber: "1 As 1/2026",
      country: "CZE",
      language: "cs",
      court: "Test court",
    });
    try {
      await run(db, sourceId, decisionId);
    } finally {
      await db
        .delete(euCompletionControls)
        .where(eq(euCompletionControls.sourceId, sourceId));
      await db
        .delete(caseLawCorpusPackRefs)
        .where(eq(caseLawCorpusPackRefs.decisionId, decisionId));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    }
  });
};
const bench = fc
  .uniqueArray(
    fc.constantFrom(
      "Ludmila Nováková",
      "Petr Černý",
      "Vojtěch Šimáček",
      "Radomír Čapek",
    ),
    { maxLength: 4 },
  )
  .map((names) =>
    names.map(
      (nameAsPrinted) =>
        ({ role: "panel-member", nameAsPrinted }) satisfies Parameters<
          typeof replaceDecisionJudges
        >[1]["judges"][number],
    ),
  );
const packed = (index: number) => `pack:fixture-${index}@0+1#${"a".repeat(64)}`;
const packedPayload = (keys: readonly number[]) => {
  const [text, sections, ast] = keys;
  return {
    textKey: text === undefined ? "fixture/text" : packed(text),
    sectionsKey: sections === undefined ? "fixture/sections" : packed(sections),
    astKey: ast === undefined ? "fixture/ast" : packed(ast),
    contentHash: "a".repeat(64),
  };
};

if (!databaseUrl || !enabled) {
  describe.skip("replay write contracts (postgres)", () =>
    test("requires Postgres", () => expect(enabled).toBe(false)));
} else {
  test("case-law child diffs match replacement and retain equal physical rows", async () => {
    await fixture(async (db, _sourceId, decisionId) => {
      const judges = async () =>
        await db
          .select()
          .from(caseLawDecisionJudges)
          .where(eq(caseLawDecisionJudges.decisionId, decisionId))
          .orderBy(caseLawDecisionJudges.nameKey);
      const refs = async () =>
        await db
          // Creation provenance is retained by a diff, like stable row ids.
          // Compare the source-derived relation against replacement separately.
          .select({
            decisionId: caseLawCorpusPackRefs.decisionId,
            kind: caseLawCorpusPackRefs.kind,
            packKey: caseLawCorpusPackRefs.packKey,
            location: caseLawCorpusPackRefs.location,
          })
          .from(caseLawCorpusPackRefs)
          .where(eq(caseLawCorpusPackRefs.decisionId, decisionId))
          .orderBy(caseLawCorpusPackRefs.kind);
      const versions = async () =>
        executedRows(
          await db.execute(
            sql`SELECT role || name_key AS key, xmin::text FROM case_law_decision_judges WHERE decision_id=${decisionId} UNION ALL SELECT kind, xmin::text FROM case_law_corpus_pack_refs WHERE decision_id=${decisionId} ORDER BY key`,
          ),
        );
      await assertProperty(
        "case-law child diffs match replacement and retain equal physical rows",
        fc.asyncProperty(
          bench,
          bench,
          fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 3 }),
          fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 3 }),
          async (oldJudges, newJudges, oldPacks, newPacks) => {
            await db.transaction(async (tx) => {
              await replaceDecisionJudges(tx, {
                decisionId,
                judges: oldJudges,
              });
              await recordCorpusPackRefsTx(
                tx,
                decisionId,
                packedPayload(oldPacks),
              );
            });
            await db.transaction(async (tx) => {
              await replaceDecisionJudges(tx, {
                decisionId,
                judges: newJudges,
              });
              await recordCorpusPackRefsTx(
                tx,
                decisionId,
                packedPayload(newPacks),
              );
            });
            const differential = { judges: await judges(), refs: await refs() };
            const unchanged = await versions();
            await db.transaction(async (tx) => {
              await replaceDecisionJudges(tx, {
                decisionId,
                judges: newJudges,
              });
              await recordCorpusPackRefsTx(
                tx,
                decisionId,
                packedPayload(newPacks),
              );
            });
            expect(await versions()).toEqual(unchanged);
            await db
              .delete(caseLawDecisionJudges)
              .where(eq(caseLawDecisionJudges.decisionId, decisionId));
            await db
              .delete(caseLawCorpusPackRefs)
              .where(eq(caseLawCorpusPackRefs.decisionId, decisionId));
            await db.transaction(async (tx) => {
              await replaceDecisionJudges(tx, {
                decisionId,
                judges: newJudges,
              });
              await recordCorpusPackRefsTx(
                tx,
                decisionId,
                packedPayload(newPacks),
              );
            });
            expect({ judges: await judges(), refs: await refs() }).toEqual(
              differential,
            );
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  test("a skipped source, listing, supplement and held tick retains its accepted result", async () => {
    await fixture(async (db, sourceId) => {
      const asOf = new Date("2026-01-01T00:00:00Z");
      const scopedDb = async <T>(
        run: (
          tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
        ) => Promise<T>,
      ) => await db.transaction(run);
      const source = {
        scopedDb,
        adapterKey: sourceId,
        total: 7,
        asOf,
        origin: SOURCE_TOTAL_ORIGIN.LISTING_CENSUS,
      };
      expect(await setSourceReportedTotal(source)).toBe(true);
      const beforeSource = executedRows(
        await db.execute(
          sql`SELECT xmin::text FROM case_law_sources WHERE id=${sourceId}`,
        ),
      );
      expect(await setSourceReportedTotal(source)).toBe(true);
      expect(
        executedRows(
          await db.execute(
            sql`SELECT xmin::text FROM case_law_sources WHERE id=${sourceId}`,
          ),
        ),
      ).toEqual(beforeSource);
      const checkpoint = {
        status: LISTING_CENSUS_STATUS.COUNTING,
        fromSlice: "2026-01",
        toSlice: "2026-02",
        asOf: asOf.toISOString(),
        slicesCounted: 0,
        nextSlice: "2026-01",
        counted: 0,
      };
      await db
        .update(caseLawSources)
        .set({ config: { [LISTING_CENSUS_CONFIG_KEY]: checkpoint } })
        .where(eq(caseLawSources.id, sourceId));
      const beforeListing = executedRows(
        await db.execute(
          sql`SELECT xmin::text FROM case_law_sources WHERE id=${sourceId}`,
        ),
      );
      expect(
        await db.transaction(
          async (tx) =>
            await recordSlice({
              tx,
              sourceId,
              adapterKey: sourceId,
              asOf,
              observed: checkpoint,
              next: checkpoint,
            }),
        ),
      ).toBe("advanced");
      expect(
        executedRows(
          await db.execute(
            sql`SELECT xmin::text FROM case_law_sources WHERE id=${sourceId}`,
          ),
        ),
      ).toEqual(beforeListing);
      const document = {
        ...plainTextIngestionResult({
          caseNumber: "1 As 1/2026",
          sourceDocumentId: "supplement",
          court: "Test court",
          country: "CZE",
          language: "cs",
          decisionDate: "2026-01-01",
          decisionType: "judgment",
          fulltext: "Odůvodnění",
          metadata: {},
          textFields: absentDecisionTextFields(
            TEXT_ABSENCE_REASON.NOT_PUBLISHED,
          ),
          rawHash: "a".repeat(64),
          documentAst: EMPTY_AST,
        }),
        sourceDocumentId: "supplement",
      };
      const supplement = {
        kind: DECISION_SUPPLEMENT_KIND.REASONS,
        target: { decisionTypes: ["judgment"] },
        document,
      } satisfies DecisionSupplement;
      const content = supplementContent(supplement, document);
      const placement = {
        key: {
          sourceId,
          court: "Test court",
          caseNumber: "1 As 1/2026",
          language: "cs",
        },
        sourceId,
        sourceDocumentId: "supplement",
        supplement,
        observedAt: asOf,
        content,
      };
      const placed = await db.transaction(
        async (tx) => await placeSupplementTx(tx, placement),
      );
      const beforeSupplement = executedRows(
        await db.execute(
          sql`SELECT xmin::text FROM case_law_decision_supplements WHERE source_id=${sourceId}`,
        ),
      );
      expect(
        await db.transaction(
          async (tx) => await placeSupplementTx(tx, placement),
        ),
      ).toEqual(placed);
      expect(
        executedRows(
          await db.execute(
            sql`SELECT xmin::text FROM case_law_decision_supplements WHERE source_id=${sourceId}`,
          ),
        ),
      ).toEqual(beforeSupplement);
      const store = createEuCompletionStore({ db, now: () => asOf.getTime() });
      const tick = {
        sourceId,
        mode: "dry-run",
        healthyCompleted: 0,
        intentionallyHeld: true,
        counts: {
          attempted: 0,
          applied: 0,
          unchanged: 0,
          reviewRequired: 0,
          failed: 0,
        },
      } satisfies Parameters<typeof store.recordTick>[0];
      const progress = await store.recordTick(tick);
      const beforeTick = executedRows(
        await db.execute(
          sql`SELECT xmin::text FROM eu_completion_controls WHERE source_id=${sourceId}`,
        ),
      );
      expect(await store.recordTick(tick)).toEqual(progress);
      expect(
        executedRows(
          await db.execute(
            sql`SELECT xmin::text FROM eu_completion_controls WHERE source_id=${sourceId}`,
          ),
        ),
      ).toEqual(beforeTick);
      expect(replayWriteOutcome([], [])).toEqual({ status: "ownership-lost" });
    });
  });

  test("converted child triggers retain update and foreign-key enforcement", async () => {
    await fixture(async (db, _sourceId, decisionId) => {
      const triggers = executedRows(
        await db.execute(sql`
        SELECT relation.relname AS relation, procedure.proname AS function, trigger.tgisinternal AS internal
        FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid
        JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid
        WHERE relation.relname IN ('case_law_decision_judges','case_law_corpus_pack_refs')
        ORDER BY relation.relname, procedure.proname
      `),
      );
      expect(triggers).toEqual([
        {
          relation: "case_law_decision_judges",
          function: "RI_FKey_check_ins",
          internal: true,
        },
        {
          relation: "case_law_decision_judges",
          function: "RI_FKey_check_ins",
          internal: true,
        },
        {
          relation: "case_law_decision_judges",
          function: "RI_FKey_check_upd",
          internal: true,
        },
        {
          relation: "case_law_decision_judges",
          function: "RI_FKey_check_upd",
          internal: true,
        },
        {
          relation: "case_law_decision_judges",
          function: "case_law_decision_judges_plain_text_guard",
          internal: false,
        },
      ]);
      const original = [
        { role: "panel-member", nameAsPrinted: "Ludmila Nováková" },
        { role: "panel-member", nameAsPrinted: "Petr Černý" },
      ] satisfies Parameters<typeof replaceDecisionJudges>[1]["judges"];
      await db.transaction(
        async (tx) =>
          await replaceDecisionJudges(tx, { decisionId, judges: original }),
      );
      const before = await db
        .select()
        .from(caseLawDecisionJudges)
        .where(eq(caseLawDecisionJudges.decisionId, decisionId))
        .orderBy(caseLawDecisionJudges.nameKey);
      await db.transaction(
        async (tx) =>
          await replaceDecisionJudges(tx, {
            decisionId,
            judges: original.toReversed(),
          }),
      );
      const after = await db
        .select()
        .from(caseLawDecisionJudges)
        .where(eq(caseLawDecisionJudges.decisionId, decisionId))
        .orderBy(caseLawDecisionJudges.nameKey);
      expect(after.map(({ position }) => position)).toEqual(
        before.map(({ position }) => 1 - position),
      );
      const markup = replayWrite(caseLawDecisionJudges, {
        nameAsPrinted: "<b>Ludmila</b>",
      });
      const failed = await rejectionOf(
        db
          .update(caseLawDecisionJudges)
          .set(markup.set)
          .where(
            and(
              eq(caseLawDecisionJudges.decisionId, decisionId),
              markup.setWhere,
            ),
          ),
      );
      expect(
        isPgConstraintError(
          failed,
          PG_ERROR.CHECK_VIOLATION,
          "plain_text_no_markup",
        ),
      ).toBe(true);
      const foreign = replayWrite(caseLawDecisionJudges, {
        judgeId: createSafeId<"caseLawJudge">(),
      });
      const foreignFailure = await rejectionOf(
        db
          .update(caseLawDecisionJudges)
          .set(foreign.set)
          .where(
            and(
              eq(caseLawDecisionJudges.decisionId, decisionId),
              foreign.setWhere,
            ),
          ),
      );
      expect(
        isPgConstraintError(
          foreignFailure,
          PG_ERROR.FOREIGN_KEY_VIOLATION,
          "case_law_decision_judges_judge_id_fk",
        ),
      ).toBe(true);
      expect(
        await db
          .select()
          .from(caseLawDecisionJudges)
          .where(eq(caseLawDecisionJudges.decisionId, decisionId))
          .orderBy(caseLawDecisionJudges.nameKey),
      ).toEqual(after);
    });
  });

  test("equal replay values keep xmin and differing written values match unconditional SET", async () => {
    await fixture(async (db, sourceId) => {
      const where = and(
        eq(caseLawDecisionSupplements.sourceId, sourceId),
        eq(caseLawDecisionSupplements.sourceDocumentId, "generated-set"),
      );
      await db.insert(caseLawDecisionSupplements).values({
        sourceId,
        sourceDocumentId: "generated-set",
        kind: DECISION_SUPPLEMENT_KIND.REASONS,
        caseNumber: "1 As 1/2026",
        court: "Test court",
        language: "cs",
        judgmentDecisionTypes: ["judgment"],
        documentAst: EMPTY_AST,
        sourceHash: "a".repeat(64),
        metadata: {},
        observedAt: new Date("2026-01-01T00:00:00Z"),
      });
      const values = fc.record({
        fulltext: fc.option(
          fc.constantFrom("Ludmila Nováková", "Petr Černý", ""),
          { nil: null },
        ),
        metadata: fc.record({
          label: fc.constantFrom("žluťoučký", "nový", '"citace"'),
          count: fc.integer({ min: 0, max: 10 }),
        }),
        latestDecisionDate: fc.option(
          fc.constantFrom("2026-01-01", "2026-02-03"),
          { nil: null },
        ),
        sourceUrl: fc.option(
          fc.constantFrom("https://example.org/a", "https://example.org/b"),
          { nil: null },
        ),
        judgmentDecisionTypes: fc.array(fc.constantFrom("judgment", "order"), {
          maxLength: 3,
        }),
        observedAt: fc.constantFrom(
          new Date("2026-01-01T00:00:00Z"),
          new Date("2026-02-01T00:00:00Z"),
        ),
      });
      const read = async () =>
        (
          await db
            .select({
              row: caseLawDecisionSupplements,
              version: sql<string>`xmin::text`,
            })
            .from(caseLawDecisionSupplements)
            .where(where)
        ).at(0) ?? panic("Generated replay row missing");
      await assertProperty(
        "equal replay values keep xmin and differing written values match unconditional SET",
        fc.asyncProperty(values, values, async (oldValues, newValues) => {
          await db
            .update(caseLawDecisionSupplements)
            .set(oldValues)
            .where(where);
          const expected =
            (
              await db
                .update(caseLawDecisionSupplements)
                .set(newValues)
                .where(where)
                .returning()
            ).at(0) ?? panic("Unconditional SET returned no row");
          await db
            .update(caseLawDecisionSupplements)
            .set(oldValues)
            .where(where);
          const before = await read();
          const different =
            JSON.stringify(before.row) !== JSON.stringify(expected);
          const write = replayWrite(caseLawDecisionSupplements, newValues);
          const written = await db
            .update(caseLawDecisionSupplements)
            .set(write.set)
            .where(and(where, write.setWhere))
            .returning();
          expect(written.length).toBe(Number(different));
          const after = await read();
          expect(after.row).toEqual(expected);
          if (different) {
            expect(after.version).not.toBe(before.version);
          } else {
            expect(after.version).toBe(before.version);
          }
          expect(
            await db
              .update(caseLawDecisionSupplements)
              .set(write.set)
              .where(and(where, write.setWhere))
              .returning(),
          ).toEqual([]);
          expect((await read()).version).toBe(after.version);
        }),
        { numRuns: 40 },
      );
      const unchangedExpression = replayWrite(caseLawDecisionSupplements, {
        fulltext: sql`${caseLawDecisionSupplements.fulltext}`,
      });
      expect(
        await db
          .update(caseLawDecisionSupplements)
          .set(unchangedExpression.set)
          .where(and(where, unchangedExpression.setWhere))
          .returning(),
      ).toEqual([]);
    });
  });

  test("source observation allocation always advances a stored counter", async () => {
    await fixture(async (db, sourceId) => {
      const leaseToken = createSafeId<"caseLawSourceIngestionLease">();
      await db
        .update(caseLawSources)
        .set({
          ingestionLeaseToken: leaseToken,
          ingestionLeaseExpiresAt: new Date("2100-01-01T00:00:00Z"),
        })
        .where(eq(caseLawSources.id, sourceId));
      await assertProperty(
        "source observation allocation always advances a stored counter",
        fc.asyncProperty(
          fc.bigInt({ min: 0n, max: 10_000n }),
          async (before) => {
            await db
              .update(caseLawSources)
              .set({ observationOrder: before })
              .where(eq(caseLawSources.id, sourceId));
            const next = await allocateSourceObservationOrder({
              sourceId,
              leaseToken,
              scopedDb: async (run) => await db.transaction(run),
            });
            const stored =
              (
                await db
                  .select({ order: caseLawSources.observationOrder })
                  .from(caseLawSources)
                  .where(eq(caseLawSources.id, sourceId))
              ).at(0) ?? panic("Observation source missing");
            expect(next).toBe(before + 1n);
            expect(stored.order).toBe(next);
          },
        ),
        { numRuns: 20 },
      );
    });
  });
  test("lease acquisition and release change selected ownership", async () => {
    await fixture(async (db, sourceId) => {
      const before =
        (
          await db
            .select()
            .from(caseLawSources)
            .where(eq(caseLawSources.id, sourceId))
        ).at(0) ?? panic("Lease source missing");
      const scopedDb = async <T>(
        run: (
          tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
        ) => Promise<T>,
      ) => await db.transaction(run);
      const lease = await acquireCaseLawSourceIngestionLease({
        scopedDb,
        sourceId,
      });
      if (lease === null) {
        return panic("Available lease was not acquired");
      }
      expect(before.ingestionLeaseToken).toBeNull();
      expect(lease.source.ingestionLeaseToken).toBe(lease.leaseToken);
      expect(lease.source.ingestionLeaseExpiresAt?.getTime()).toBeGreaterThan(
        before.ingestionLeaseExpiresAt?.getTime() ?? 0,
      );
      expect(
        await acquireCaseLawSourceIngestionLease({ scopedDb, sourceId }),
      ).toBeNull();
      await lease.release();
      const released =
        (
          await db
            .select()
            .from(caseLawSources)
            .where(eq(caseLawSources.id, sourceId))
        ).at(0) ?? panic("Released source missing");
      expect(released.ingestionLeaseToken).toBeNull();
      expect(released.ingestionLeaseExpiresAt).toBeNull();
      const version = executedRows(
        await db.execute(
          sql`SELECT xmin::text AS version FROM case_law_sources WHERE id=${sourceId}`,
        ),
      );
      await lease.release();
      expect(
        executedRows(
          await db.execute(
            sql`SELECT xmin::text AS version FROM case_law_sources WHERE id=${sourceId}`,
          ),
        ),
      ).toEqual(version);
      const expiredToken = createSafeId<"caseLawSourceIngestionLease">();
      const expiredAt = new Date("2020-01-01T00:00:00Z");
      await db
        .update(caseLawSources)
        .set({
          ingestionLeaseToken: expiredToken,
          ingestionLeaseExpiresAt: expiredAt,
        })
        .where(eq(caseLawSources.id, sourceId));
      const replacement = await acquireCaseLawSourceIngestionLease({
        scopedDb,
        sourceId,
      });
      if (replacement === null) {
        return panic("Expired ownership was not replaced");
      }
      expect(
        replacement.source.ingestionLeaseExpiresAt?.getTime(),
      ).toBeGreaterThan(expiredAt.getTime());
      expect(replacement.source.ingestionLeaseToken).not.toBe(expiredToken);
      await lease.release();
      const stillOwned =
        (
          await db
            .select({ token: caseLawSources.ingestionLeaseToken })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, sourceId))
        ).at(0) ?? panic("Replacement source missing");
      expect(stillOwned.token).toBe(replacement.leaseToken);
      await replacement.release();
    });
  });

  test("complete raw replay statements skip equal rows and retain caller predicates", async () => {
    await fixture(async (db, sourceId, decisionId) => {
      const read = async () =>
        v.parse(
          v.tuple([v.object({ metadata: v.unknown(), version: v.string() })]),
          executedRows(
            await db.execute(
              sql`SELECT metadata, xmin::text AS version FROM ${caseLawDecisions} WHERE id=${decisionId}`,
            ),
          ),
        )[0];
      const initial = await read();
      const equal = replayRawWrite({
        table: caseLawDecisions,
        values: { metadata: {} },
        predicate: eq(caseLawDecisions.id, decisionId),
        operation: { kind: "update" },
        result: { kind: "rows", columns: sql`metadata` },
      });
      expect("getSQL" in equal).toBe(false);
      expect("setWhere" in equal).toBe(false);
      expect(
        executedRows(await equal.execute({ kind: "drizzle", connection: db })),
      ).toEqual([]);
      expect(await read()).toEqual(initial);
      await assertProperty(
        "complete raw replay statements skip equal rows and retain caller predicates",
        fc.asyncProperty(
          fc.record({ label: fc.string(), count: fc.integer() }),
          async (metadata) => {
            const before = await read();
            const statement = replayRawWrite({
              table: caseLawDecisions,
              values: { metadata },
              predicate: eq(caseLawDecisions.id, decisionId),
              operation: { kind: "update" },
              result: { kind: "rows", columns: sql`metadata` },
            });
            const changed = executedRows(
              await statement.execute({ kind: "drizzle", connection: db }),
            );
            expect(changed).toEqual([{ metadata }]);
            const after = await read();
            expect(after.version).not.toBe(before.version);
            expect(
              executedRows(
                await statement.execute({ kind: "drizzle", connection: db }),
              ),
            ).toEqual([]);
            expect(await read()).toEqual(after);
            // Reset to a different shape so every generated case exercises a write.
            await db
              .update(caseLawDecisions)
              .set({ metadata: {} })
              .where(eq(caseLawDecisions.id, decisionId));
          },
        ),
        { numRuns: 20 },
      );
      const blocked = replayRawWrite({
        table: caseLawDecisions,
        values: { metadata: { changed: true } },
        predicate: sql`false OR false`,
        operation: { kind: "update" },
        result: { kind: "rows", columns: sql`id` },
      });
      expect(
        executedRows(
          await blocked.execute({ kind: "drizzle", connection: db }),
        ),
      ).toEqual([]);
      const upsert = replayRawWrite({
        table: caseLawSources,
        values: { name: sql`EXCLUDED.name` },
        operation: {
          kind: "upsert",
          columns: [
            caseLawSources.id,
            caseLawSources.adapterKey,
            caseLawSources.name,
          ],
          source: sql`VALUES (${sourceId},${sourceId},'Raw replay source')`,
          target: [caseLawSources.id],
        },
        predicate: sql`true`,
        result: { kind: "rows", columns: sql`name` },
      });
      expect(
        executedRows(await upsert.execute({ kind: "drizzle", connection: db })),
      ).toEqual([{ name: "Raw replay source" }]);
      expect(
        executedRows(await upsert.execute({ kind: "drizzle", connection: db })),
      ).toEqual([]);
      const composed = replayRawWrite({
        table: caseLawDecisions,
        alias: "d",
        values: { metadata: sql`input.metadata` },
        predicate: sql`d.id = input.id`,
        operation: { kind: "update", from: sql`input` },
        ctes: [
          {
            name: "input",
            query: sql`SELECT ${decisionId}::uuid AS id, '{"raw":true}'::jsonb AS metadata`,
          },
        ],
        result: {
          kind: "query",
          name: "changed",
          columns: sql`d.id`,
          query: sql`SELECT count(*)::int AS changed FROM changed`,
        },
      });
      expect(
        executedRows(
          await composed.execute({ kind: "drizzle", connection: db }),
        ),
      ).toEqual([{ changed: 1 }]);
      expect(
        executedRows(
          await composed.execute({ kind: "drizzle", connection: db }),
        ),
      ).toEqual([{ changed: 0 }]);
    });
  });

  test("the effective SET has a physical fixed point for every written column", async () => {
    await fixture(async (db, sourceId) => {
      const baseline = {
        kind: DECISION_SUPPLEMENT_KIND.REASONS,
        caseNumber: "1 As 1/2026",
        court: "Test court",
        language: "cs",
        judgmentDecisionTypes: ["judgment"],
        fulltext: "Původní",
        documentAst: EMPTY_AST,
        sourceHash: "a".repeat(64),
        metadata: { label: "žluťoučký", nested: [1, null] },
        observedAt: new Date("2026-01-01T00:00:00Z"),
      };
      const changes = {
        caseNumber: "2 As 2/2026",
        court: "Changed court",
        language: "en",
        judgmentDecisionTypes: ["order"],
        fulltext: "Změněný",
        sourceHash: "b".repeat(64),
        metadata: { label: "nový", nested: [2, null] },
        observedAt: new Date("2026-02-01T00:00:00Z"),
      };
      await db
        .insert(caseLawDecisionSupplements)
        .values({ sourceId, sourceDocumentId: "effective-set", ...baseline });
      for (const [key, value] of Object.entries(changes)) {
        const where = and(
          eq(caseLawDecisionSupplements.sourceId, sourceId),
          eq(caseLawDecisionSupplements.sourceDocumentId, "effective-set"),
        );
        await db.update(caseLawDecisionSupplements).set(baseline).where(where);
        const write = replayWrite(caseLawDecisionSupplements, {
          ...baseline,
          [key]: value,
        });
        const result = await db
          .update(caseLawDecisionSupplements)
          .set(write.set)
          .where(and(where, write.setWhere))
          .returning();
        expect(result.length).toBe(1);
        const row = result.at(0) ?? panic("Changed replay returned no row");
        expect(Reflect.get(row, key)).toEqual(value);
        expect(
          await db
            .update(caseLawDecisionSupplements)
            .set(write.set)
            .where(and(where, write.setWhere))
            .returning(),
        ).toEqual([]);
      }
      const where = and(
        eq(caseLawDecisionSupplements.sourceId, sourceId),
        eq(caseLawDecisionSupplements.sourceDocumentId, "effective-set"),
      );
      await db.update(caseLawDecisionSupplements).set(baseline).where(where);
      const fixedTimestamp = new Date("2027-01-01T00:00:00Z");
      const noChange = replayWrite(
        caseLawDecisionSupplements,
        { metadata: { nested: [1, null], label: "žluťoučký" } },
        {
          modifiedAt: {
            column: caseLawDecisionSupplements.updatedAt,
            value: fixedTimestamp,
          },
        },
      );
      expect(
        await db
          .update(caseLawDecisionSupplements)
          .set(noChange.set)
          .where(and(where, noChange.setWhere))
          .returning(),
      ).toEqual([]);
      const changed = replayWrite(
        caseLawDecisionSupplements,
        { fulltext: null, latestDecisionDate: "2026-03-01" },
        {
          modifiedAt: {
            column: caseLawDecisionSupplements.updatedAt,
            value: fixedTimestamp,
          },
        },
      );
      const updated =
        (
          await db
            .update(caseLawDecisionSupplements)
            .set(changed.set)
            .where(and(where, changed.setWhere))
            .returning()
        ).at(0) ?? panic("Changed payload missing");
      expect(updated.updatedAt).toEqual(fixedTimestamp);
      expect(updated.fulltext).toBeNull();
      expect(updated.latestDecisionDate).toBe("2026-03-01");
      expect(
        await db
          .update(caseLawDecisionSupplements)
          .set(changed.set)
          .where(and(where, changed.setWhere))
          .returning(),
      ).toEqual([]);
      const unknownKey = "UNKNOWN_COLUMN".toLowerCase();
      expect(() =>
        replayWrite(caseLawDecisionSupplements, {
          ...baseline,
          [unknownKey]: "value",
        }),
      ).toThrow("Replay cannot write unknown column");
      expect(() => replayWriteOutcome([{ id: 1 }, { id: 2 }], [])).toThrow(
        "single-row ownership predicate",
      );
    });
  });
}
