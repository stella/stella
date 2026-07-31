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

import { rootDb } from "@/api/db/root";
import { isRecord } from "@/api/lib/type-guards";

const BATCH = 2000;

const adapterArgIndex = process.argv.indexOf("--adapter");
const ADAPTER_FILTER =
  adapterArgIndex === -1 ? null : (process.argv[adapterArgIndex + 1] ?? null);

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

const rowCount = (result: unknown): number => {
  if (Array.isArray(result)) {
    return result.length;
  }
  return isRecord(result) && Array.isArray(result["rows"])
    ? result["rows"].length
    : 0;
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
  filled: number,
): Promise<number> => {
  const result = await rootDb.execute(sql`
    WITH batch AS (
      SELECT d.id
      FROM case_law_decisions d
      JOIN case_law_sources s ON s.id = d.source_id
      WHERE s.adapter_key = ${adapterKey}
        AND d.source_document_id IS NULL
      LIMIT ${BATCH}
    )
    UPDATE case_law_decisions d
    SET source_document_id = ${sql.raw(expression)}
    FROM batch
    WHERE d.id = batch.id
      AND ${sql.raw(expression)} IS NOT NULL
      AND ${sql.raw(expression)} <> ''
    RETURNING d.id
  `);

  const updated = rowCount(result);
  if (updated === 0) {
    return filled;
  }
  const total = filled + updated;
  console.info(`${adapterKey}: ${total.toLocaleString()} filled`);
  return await fillFrom(adapterKey, expression, total);
};

const adapters = Object.entries(ID_EXPRESSION_BY_ADAPTER).filter(
  ([adapterKey]) => ADAPTER_FILTER === null || adapterKey === ADAPTER_FILTER,
);

if (adapters.length === 0) {
  console.error(
    `No id derivation known for "${ADAPTER_FILTER}". Known: ${Object.keys(ID_EXPRESSION_BY_ADAPTER).join(", ")}`,
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
  const filled = await fillFrom(adapterKey, expression, 0);
  console.info(`${adapterKey}: done, ${filled.toLocaleString()} rows`);
  await fillEach(rest);
};

await fillEach(adapters);

process.exit(0);
