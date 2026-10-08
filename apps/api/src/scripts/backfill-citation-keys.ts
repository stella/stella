import { panic } from "better-result";
/**
 * Populate `citation_key` on decisions and citations.
 *
 * Both sides canonicalize through `citationKeyOf`, so once the column is
 * filled, resolution is an indexed equality join (see
 * `handlers/case-law/citation-resolution.ts`). Rows written after the column
 * landed already carry it; this fills everything older.
 *
 * Resolution itself is no longer this script's job: it is a standing loop in
 * the corpus daemon, driven by `resolution_status`, so a one-shot pass would
 * only duplicate work the daemon does continuously and resumably.
 *
 * Keyset-paginated by id and idempotent: it can stop anywhere and resume, and
 * re-running only touches rows still missing a key.
 *
 * `--recanonicalize` walks every row instead and rewrites each key the current
 * `citationKeyOf` spells differently, which is what a change to the key rule
 * needs: stored keys otherwise keep the old spelling, and the exact-identity
 * lookup and the legacy resolver bridge compare against them.
 *
 *   bun apps/api/src/scripts/backfill-citation-keys.ts [--recanonicalize]
 */
import { sql } from "drizzle-orm";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { runScriptWithErrorOutput } from "@stll/errors";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import { reopenCitationsForKeys } from "@/api/handlers/case-law/citation-resolution";
import { CITATION_RESOLUTION_STATUS } from "@/api/handlers/case-law/citation-resolution-status";
import {
  citationKeyOf,
  decisionCitationKeyOf,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { executedRows } from "@/api/lib/db/executed-rows";
import { primaryReferenceTypeFromStored } from "@/api/lib/legal-search/decision-primary-reference";
import { isRecord } from "@/api/lib/type-guards";
import { backfillEntrypoints } from "@/api/scripts/backfill-entrypoint";

const plan = backfillEntrypoints["citation-keys"]({
  args: process.argv.slice(2),
});
const scope = plan.scope;
// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
await runScriptWithErrorOutput(async () => {
  const { rootDb } = await enterCaseLawMaintenanceLane();

  type KeyedTable = "case_law_decisions" | "case_law_citations";

  type BackfillTotals = { seen: number; keyed: number };

  /**
   * Fill one table's keys.
   *
   * A row whose text does not canonicalize gets `NULL`, which is also the value
   * that means "not computed yet" — so the scan cannot use the column to tell
   * the two apart and would revisit those rows forever. The keyset cursor is
   * what terminates it instead: the walk advances by id whether or not a row
   * received a key. The alternative once used here, writing `''` for an
   * uncanonicalizable text, terminated the scan by making every such row a key
   * that matches every other such row, which is a wrong edge in the citation
   * graph rather than a missing one. The database now refuses that value.
   */
  const backfillTable = async (
    table: KeyedTable,
    sourceColumn: "case_number" | "citation_text",
  ): Promise<BackfillTotals> => {
    const totals: BackfillTotals = { seen: 0, keyed: 0 };
    const missingOnly = scope === "missing";

    const runtime = plan.open(
      (options) => createScriptBackfillRuntime({ ...options, db: rootDb }),
      { name: `${plan.name}:${table}`, tableName: table },
    );
    try {
      const pass = await runBackfillPass({
        step: async () =>
          await runtime.step(
            async ({ tx: batchTx, size, cursor }) =>
              await runCitationGraphTransaction(
                async (run) => await run(batchTx),
                async (tx) => {
                  const result: unknown = await tx.execute(
                    sql`SELECT id, ${sql.raw(sourceColumn)} AS text, citation_key AS stored,
                   ${sql.raw(table === "case_law_decisions" ? "case_number_type" : "NULL")} AS type
              FROM ${sql.raw(table)}
             WHERE ${missingOnly ? sql`citation_key IS NULL` : sql`TRUE`}
               ${cursor === null ? sql`` : sql`AND id > ${cursor}::uuid`}
             ORDER BY id
             LIMIT ${size}
             FOR UPDATE`,
                  );
                  const rows = executedRows(result).map((row) => {
                    if (
                      !isRecord(row) ||
                      typeof row["id"] !== "string" ||
                      typeof row["text"] !== "string"
                    ) {
                      return panic(
                        "Citation key batch returned an invalid row",
                      );
                    }
                    return {
                      id: row["id"],
                      // A non-docket primary reference keeps no citation key.
                      key:
                        table === "case_law_decisions"
                          ? decisionCitationKeyOf({
                              caseNumber: row["text"],
                              caseNumberType: primaryReferenceTypeFromStored(
                                row["type"],
                              ),
                            })
                          : citationKeyOf(row["text"]),
                      stored:
                        typeof row["stored"] === "string"
                          ? row["stored"]
                          : null,
                    };
                  });

                  if (rows.length === 0) {
                    return { cursor, done: true, value: { seen: 0, keyed: 0 } };
                  }

                  const keyed = rows.filter(({ key, stored }) =>
                    missingOnly ? key !== null : key !== stored,
                  );
                  if (keyed.length > 0) {
                    const values = sql.join(
                      keyed.map(
                        ({ id, key }) => sql`(${id}::uuid, ${key}::varchar)`,
                      ),
                      sql`, `,
                    );
                    // Rekeying and reopening affected citations share the checkpoint transaction.
                    if (table === "case_law_decisions") {
                      await tx.execute(
                        sql`WITH v(id, key) AS (VALUES ${values})
                  UPDATE case_law_decisions AS t
                     SET citation_key = v.key
                    FROM v
                   WHERE t.id = v.id`,
                      );
                      await reopenCitationsForKeys(
                        tx,
                        keyed.flatMap(({ key, stored }) =>
                          [key, stored].filter((value) => value !== null),
                        ),
                      );
                    } else {
                      await tx.execute(
                        missingOnly
                          ? sql`WITH v(id, key) AS (VALUES ${values})
                    UPDATE case_law_citations AS t
                       SET citation_key = v.key
                      FROM v
                     WHERE t.id = v.id`
                          : sql`WITH v(id, key) AS (VALUES ${values})
                    UPDATE case_law_citations AS t
                       SET citation_key = v.key,
                           resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING},
                           cited_decision_id = NULL,
                           resolution_rule_id = NULL,
                           resolution_attempted_at = NULL
                      FROM v
                     WHERE t.id = v.id`,
                      );
                    }
                  }
                  return {
                    cursor: rows.at(-1)?.id ?? cursor,
                    done: rows.length < size,
                    value: { seen: rows.length, keyed: keyed.length },
                  };
                },
              ),
          ),
        onBatch: ({ value: batch }) => {
          totals.seen += batch.seen;
          totals.keyed += batch.keyed;
          console.log(
            `  ${table}: ${totals.seen} scanned, ${totals.keyed} keyed`,
          );
        },
        sleep: Bun.sleep,
      });
      if (pass.isErr()) {
        throw pass.error;
      }
      return totals;
    } finally {
      await runtime.close();
    }
  };

  console.log(`=== Backfilling citation keys (${scope}) ===`);
  const decisions = await backfillTable("case_law_decisions", "case_number");
  const citations = await backfillTable("case_law_citations", "citation_text");
  console.log(
    `Done. decisions ${decisions.keyed}/${decisions.seen}, ` +
      `citations ${citations.keyed}/${citations.seen}.`,
  );

  process.exit(0);
});
