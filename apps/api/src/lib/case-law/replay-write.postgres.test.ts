import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import {
  caseLawDecisions,
  caseLawDecisionSupplements,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { markSupplementsMerged } from "@/api/handlers/case-law/ingestion/supplement-composition";
import { replaceDecisionJudges } from "@/api/handlers/case-law/judges/decision-judges";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { writeDesiredStates } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const ROWS = 1000;

if (!databaseUrl || !enabled) {
  describe.skip("replay physical fixed point (postgres)", () => {
    test("requires the Postgres harness", () => expect(enabled).toBe(false));
  });
} else {
  test("unchanged replay writers keep their physical rows", async () => {
    expect(
      ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(databaseUrl).hostname,
      ),
    ).toBe(true);
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const sourceId = createSafeId<"caseLawSource">();
      const decisions = Array.from({ length: ROWS }, (_, i) => ({
        id: createSafeId<"caseLawDecision">(),
        sourceId,
        projectionEpoch: 1n,
        caseNumber: `Replay ${i}`,
        court: "Test court",
        country: "CZE",
        language: "cs",
      }));
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `replay-${sourceId}`,
        name: "Replay fixture",
      });
      try {
        await db
          .insert(corpusIndexGenerations)
          .values({
            family: "case_law",
            generation: "case_law_v5",
            cluster: "q09",
            manifestDigest: corpusIndexManifestDigest(
              CORPUS_INDEX_MANIFESTS.case_law_v5,
            ),
            status: "building",
          })
          .onConflictDoNothing();
        await db.insert(caseLawDecisions).values(decisions);
        const supplements = decisions.map(
          (decision) =>
            ({
              sourceId,
              sourceDocumentId: decision.id,
              decisionId: decision.id,
              kind: "reasons",
              caseNumber: decision.caseNumber,
              court: decision.court,
              language: "cs",
              judgmentDecisionTypes: ["judgment"],
              fulltext: "Odůvodnění č. 1",
              documentAst: EMPTY_AST,
              sourceHash: "a".repeat(64),
              metadata: {},
              mergedSourceHash: "a".repeat(64),
              observedAt: new Date("2026-01-01T00:00:00Z"),
            }) satisfies typeof caseLawDecisionSupplements.$inferInsert,
        );
        await db.insert(caseLawDecisionSupplements).values(supplements);
        const projections = decisions.map(
          ({ id }) =>
            ({
              family: "case_law",
              generation: "case_law_v5",
              entityId: id,
              desiredAction: "erase",
              desiredEpoch: 1n,
            }) satisfies typeof corpusIndexProjectionStates.$inferInsert,
        );
        await db.insert(corpusIndexProjectionStates).values(projections);
        const judges = [
          { role: "panel-member", nameAsPrinted: "Ludmila Nováková" },
          { role: "panel-member", nameAsPrinted: "Petr Černý" },
        ] satisfies Parameters<typeof replaceDecisionJudges>[1]["judges"];
        for (const decision of decisions) {
          await db.transaction(
            async (tx) =>
              await replaceDecisionJudges(tx, {
                decisionId: decision.id,
                judges,
              }),
          );
        }
        const versions = async () =>
          executedRows(
            await db.execute(sql`
          SELECT 'judge' AS kind, decision_id::text AS owner, role || ':' || name_key AS key, xmin::text AS version
          FROM case_law_decision_judges WHERE decision_id IN (SELECT id FROM case_law_decisions WHERE source_id=${sourceId})
          UNION ALL SELECT 'supplement', decision_id::text, source_document_id, xmin::text
          FROM case_law_decision_supplements WHERE source_id=${sourceId}
          UNION ALL SELECT 'projection', entity_id::text, generation, xmin::text
          FROM corpus_index_projection_states WHERE entity_id IN (SELECT id FROM case_law_decisions WHERE source_id=${sourceId})
          ORDER BY kind, owner, key
        `),
          );
        const statistics = async () => {
          await db.execute(sql`SELECT pg_stat_force_next_flush()`);
          await db.execute(sql`SELECT pg_stat_clear_snapshot()`);
          return executedRows(
            await db.execute(
              sql`SELECT relname, n_tup_upd::text, n_tup_ins::text, n_tup_del::text FROM pg_stat_user_tables WHERE relname IN ('case_law_decision_judges','case_law_decision_supplements','corpus_index_projection_states') ORDER BY relname`,
            ),
          );
        };
        const replay = async () => {
          for (const decision of decisions) {
            await db.transaction(async (tx) => {
              await replaceDecisionJudges(tx, {
                decisionId: decision.id,
                judges,
              });
              await markSupplementsMerged(tx, {
                sourceId,
                decisionId: decision.id,
                supplements: [
                  {
                    sourceDocumentId: decision.id,
                    kind: "reasons",
                    sourceHash: "a".repeat(64),
                    fulltext: "Odůvodnění č. 1",
                    documentAst: EMPTY_AST,
                    sourceUrl: null,
                  },
                ],
              });
            });
          }
          await db.transaction(
            async (tx) => await writeDesiredStates(tx, projections),
          );
        };
        const before = await versions();
        const beforeStatistics = await statistics();
        // Warm all writer and lookup pages before measuring WAL; first reads of
        // the cloned fixture can emit full-page hint records. Check the warmup
        // too, so it cannot conceal a mutation before the measured replay.
        await replay();
        expect(await versions()).toEqual(before);
        expect(await statistics()).toEqual(beforeStatistics);
        const lsn = executedRows(
          await db.execute(sql`SELECT pg_current_wal_lsn()::text AS lsn`),
        ).at(0);
        if (!lsn || !("lsn" in lsn) || typeof lsn.lsn !== "string") {
          throw new TypeError("WAL LSN missing");
        }
        await replay();
        const wal = executedRows(
          await db.execute(
            sql`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), ${lsn.lsn}::pg_lsn)::text AS bytes`,
          ),
        );
        process.stdout.write(`REPLAY_WAL_1000 ${JSON.stringify(wal)}\n`);
        const after = await versions();
        process.stdout.write(
          `REPLAY_VERSIONS ${before.filter((row, i) => JSON.stringify(row) !== JSON.stringify(after.at(i))).length}\n`,
        );
        expect(after).toEqual(before);
        expect(await statistics()).toEqual(beforeStatistics);
        // These upserts still lock conflicting tuples. Measure the same four
        // rows per decision and commit grouping as a conservative WAL control.
        const controlBefore = executedRows(
          await db.execute(sql`SELECT pg_current_wal_lsn()::text AS lsn`),
        ).at(0);
        if (
          !controlBefore ||
          !("lsn" in controlBefore) ||
          typeof controlBefore.lsn !== "string"
        ) {
          throw new TypeError("Control WAL LSN missing");
        }
        for (const decision of decisions) {
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT decision_id FROM case_law_decision_judges WHERE decision_id=${decision.id} FOR UPDATE`,
            );
            await tx.execute(
              sql`SELECT source_document_id FROM case_law_decision_supplements WHERE source_id=${sourceId} AND source_document_id=${decision.id} FOR UPDATE`,
            );
          });
        }
        await db.transaction(
          async (tx) =>
            await tx.execute(
              sql`SELECT entity_id FROM corpus_index_projection_states WHERE entity_id IN (SELECT id FROM case_law_decisions WHERE source_id=${sourceId}) FOR UPDATE`,
            ),
        );
        const control = executedRows(
          await db.execute(
            sql`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), ${controlBefore.lsn}::pg_lsn)::text AS bytes`,
          ),
        ).at(0);
        const measured = wal.at(0);
        if (
          !control ||
          !("bytes" in control) ||
          typeof control.bytes !== "string" ||
          !measured ||
          !("bytes" in measured) ||
          typeof measured.bytes !== "string"
        ) {
          throw new TypeError("WAL measurement missing");
        }
        process.stdout.write(`REPLAY_LOCK_CONTROL_1000 ${control.bytes}\n`);
        // Allow one 64 KiB WAL segment fraction beyond the measured lock and
        // commit control; baseline main produced 2,035,464 bytes for this fixture.
        expect(Number(measured.bytes)).toBeLessThanOrEqual(
          Number(control.bytes) + 65_536,
        );
        expect(Number(measured.bytes)).toBeLessThan(2_035_464 / 4);
      } finally {
        await db
          .update(corpusIndexGenerations)
          .set({ status: "retired" })
          .where(eq(corpusIndexGenerations.generation, "case_law_v5"));
        await db
          .delete(corpusIndexProjectionStates)
          .where(
            sql`${corpusIndexProjectionStates.entityId} IN (SELECT id FROM case_law_decisions WHERE source_id=${sourceId})`,
          );
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });
  });
}
