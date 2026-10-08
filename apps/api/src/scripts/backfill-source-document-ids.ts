import { panic } from "better-result";
/**
 * Populate `source_document_id` on decisions from data already stored.
 *
 * Identity keys on the publisher's own document id (see the column's note in
 * `db/schema/case-law.ts`). Rows written after the column landed carry it;
 * this fills everything older, with no re-crawl, because every source that
 * states an id also records it in `source_url` or in `metadata`.
 *
 * Derivation per source:
 *   sk-courts    metadata->>'guid'
 *   cz-regional  last path segment of source_url  (/api/finaldoc/<id>)
 *   pl-courts    last path segment of source_url  (/judgments/<id>)
 *
 * A source not listed here publishes no such id; its rows keep the
 * case-number key and are deliberately left NULL.
 *
 * Keyset-paginated by id and idempotent: it can stop anywhere and resume,
 * and re-running only touches rows that still lack an id.
 *
 *   bun apps/api/src/scripts/backfill-source-document-ids.ts
 *   bun apps/api/src/scripts/backfill-source-document-ids.ts --adapter sk-courts
 */
import { sql } from "drizzle-orm";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { runScriptWithErrorOutput } from "@stll/errors";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import { backfillEntrypoints } from "@/api/scripts/backfill-entrypoint";

await runScriptWithErrorOutput(async () => {
  // Hold the maintenance lane before the first statement: operator passes over
  // the case-law tables serialize here instead of deadlocking on row locks.
  const { rootDb } = await enterCaseLawMaintenanceLane();

  const plan = backfillEntrypoints["source-document-ids"]({
    args: process.argv.slice(2),
  });
  const ADAPTER_FILTER = plan.adapter;

  /**
   * How each source states its document id, as SQL over columns we already
   * hold. Kept as expressions rather than fetched-and-parsed in TypeScript so
   * a batch is one statement: at corpus scale the round-trips dominate.
   */
  const ID_EXPRESSION_BY_ADAPTER: Record<string, string> = {
    "sk-courts": `metadata->>'guid'`,
    "cz-regional": `regexp_replace(source_url, '^.*/([^/?]+)/?(\\?.*)?$', '\\1')`,
    "pl-courts": `regexp_replace(source_url, '^.*/([^/?]+)/?(\\?.*)?$', '\\1')`,
  };

  /**
   * Fill one source's ids, one batch at a time.
   *
   * Expressed as a walk rather than a loop because each step depends on where
   * the previous one stopped. The `IS NOT NULL` guard on the derived value
   * keeps a row whose url or metadata carries nothing from being rewritten as
   * an empty string, which would key every such row together — exactly the
   * collapse this column exists to prevent.
   */
  const fillFrom = async (
    adapterKey: string,
    expression: string,
  ): Promise<number> => {
    const runtime = plan.open(
      (options) => createScriptBackfillRuntime({ ...options, db: rootDb }),
      { name: `${plan.name}:${adapterKey}`, tableName: plan.tableName },
    );
    let filled = 0;
    try {
      const pass = await runBackfillPass({
        sleep: Bun.sleep,
        step: async () =>
          await runtime.step(async ({ tx, size, cursor }) => {
            const result = await tx.execute(sql`
          WITH batch AS (
            SELECT d.id
            FROM case_law_decisions d
            JOIN case_law_sources s ON s.id = d.source_id
            WHERE s.adapter_key = ${adapterKey}
              AND d.source_document_id IS NULL
              AND ${sql.raw(expression)} IS NOT NULL
              AND ${sql.raw(expression)} <> ''
              ${cursor === null ? sql`` : sql`AND d.id > ${cursor}::uuid`}
            ORDER BY d.id
            LIMIT ${size}
            FOR UPDATE OF d
          )
          UPDATE case_law_decisions d
          SET source_document_id = ${sql.raw(expression)}
          FROM batch
          WHERE d.id = batch.id AND d.source_document_id IS NULL
          RETURNING d.id
        `);
            const rows = executedRows(result);
            const ids = rows
              .map((row) => {
                if (!isRecord(row) || typeof row["id"] !== "string") {
                  return panic("Source identity batch returned an invalid row");
                }
                return row["id"];
              })
              .toSorted();
            return {
              cursor: ids.at(-1) ?? cursor,
              done: rows.length < size,
              value: rows.length,
            };
          }),
        onBatch: ({ value }) => {
          filled += value;
          console.info(`${adapterKey}: ${filled.toLocaleString()} filled`);
        },
      });
      if (pass.isErr()) {
        throw pass.error;
      }
      return filled;
    } finally {
      await runtime.close();
    }
  };

  const adapters = Object.entries(ID_EXPRESSION_BY_ADAPTER).filter(
    ([adapterKey]) => ADAPTER_FILTER === null || adapterKey === ADAPTER_FILTER,
  );

  if (adapters.length === 0) {
    console.error(
      `No id derivation known for "${ADAPTER_FILTER ?? "any adapter"}". Known: ${Object.keys(ID_EXPRESSION_BY_ADAPTER).join(", ")}`,
    );
    process.exit(1);
  }

  /**
   * Walk the sources one at a time. Sequential by design: each is a full table
   * pass, and running them together would multiply the write load on one table.
   * Expressed as a walk rather than a loop so the sequencing is the shape of the
   * code rather than an awaited step inside an iteration.
   */
  const fillEach = async (
    remaining: readonly (readonly [string, string])[],
  ): Promise<void> => {
    const [next, ...rest] = remaining;
    if (next === undefined) {
      return;
    }
    const [adapterKey, expression] = next;
    const filled = await fillFrom(adapterKey, expression);
    console.info(`${adapterKey}: done, ${filled.toLocaleString()} rows`);
    await fillEach(rest);
  };

  await fillEach(adapters);

  process.exit(0);
});
