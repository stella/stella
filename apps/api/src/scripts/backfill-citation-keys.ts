/**
 * Populate `citation_key` on decisions and citations, then resolve.
 *
 * Both sides canonicalize through `bareCitationKey`, so once the column is
 * filled, resolution is an indexed equality join (see
 * `handlers/case-law/citation-resolution.ts`). Rows written after the
 * column landed already carry it; this fills everything older.
 *
 * Keyset-paginated by id and idempotent: it can stop anywhere and resume,
 * and re-running only touches rows still missing a key.
 *
 *   bun apps/api/src/scripts/backfill-citation-keys.ts
 *   bun apps/api/src/scripts/backfill-citation-keys.ts --keys-only
 *   bun apps/api/src/scripts/backfill-citation-keys.ts --resolve-only
 */

import { sql } from "drizzle-orm";

import { rlsDb, rootDb } from "@/api/db/root";
import { createIngestionDb } from "@/api/db/scoped";
import { resolveCitationBatch } from "@/api/handlers/case-law/citation-resolution";
import { bareCitationKey } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { isRecord } from "@/api/lib/type-guards";

const BATCH = 5000;
const KEYS_ONLY = process.argv.includes("--keys-only");
const RESOLVE_ONLY = process.argv.includes("--resolve-only");

const ingestionDb = createIngestionDb(rlsDb);

const keyOf = (text: string): string | null => bareCitationKey(text) || null;

/**
 * Fill one table's keys. `source` is the column the key derives from, and
 * rows whose text does not canonicalize get an empty key rather than being
 * revisited forever — null means "not yet computed", so leaving it null on
 * an uncanonicalizable row would make the scan never terminate.
 */
/**
 * Fill one table's keys. `sourceColumn` is where the key derives from, and
 * rows whose text does not canonicalize get an empty key rather than being
 * revisited forever — null means "not yet computed", so leaving it null on
 * an uncanonicalizable row would make the scan never terminate.
 *
 * Expressed as a walk rather than a loop: each step depends on the
 * previous step's last id, so there is nothing to parallelise, and the
 * depth is bounded by rows/BATCH.
 */
const backfillFrom = async (
  table: "case_law_decisions" | "case_law_citations",
  sourceColumn: "case_number" | "citation_text",
  after: string | null,
  seen: number,
  keyed: number,
): Promise<{ seen: number; keyed: number }> => {
  const result: unknown = await rootDb.execute(
    sql`SELECT id, ${sql.raw(sourceColumn)} AS text
          FROM ${sql.raw(table)}
         WHERE citation_key IS NULL
           ${after === null ? sql`` : sql`AND id > ${after}`}
         ORDER BY id
         LIMIT ${BATCH}`,
  );
  const rows = (Array.isArray(result) ? result : []).flatMap((row) =>
    isRecord(row) &&
    typeof row["id"] === "string" &&
    typeof row["text"] === "string"
      ? [{ id: row["id"], text: row["text"] }]
      : [],
  );

  if (rows.length === 0) {
    return { seen, keyed };
  }

  const values = rows.map(
    (row) => sql`(${row.id}::uuid, ${keyOf(row.text) ?? ""}::varchar)`,
  );
  await rootDb.execute(
    sql`UPDATE ${sql.raw(table)} AS t
           SET citation_key = v.key
          FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, key)
         WHERE t.id = v.id`,
  );

  const nextSeen = seen + rows.length;
  const nextKeyed =
    keyed + rows.filter((row) => keyOf(row.text) !== null).length;
  console.log(`  ${table}: ${nextSeen} scanned, ${nextKeyed} keyed`);
  return await backfillFrom(
    table,
    sourceColumn,
    rows.at(-1)?.id ?? after,
    nextSeen,
    nextKeyed,
  );
};

/** Walk resolution to completion; same shape, same reason. */
const resolveFrom = async (
  after: string | null,
  scanned: number,
  resolved: number,
): Promise<{ scanned: number; resolved: number }> => {
  const batch = await resolveCitationBatch(ingestionDb, {
    limit: BATCH,
    afterId: after,
  });
  if (batch.scanned === 0) {
    return { scanned, resolved };
  }
  const next = {
    scanned: scanned + batch.scanned,
    resolved: resolved + batch.resolved,
  };
  console.log(`  scanned ${next.scanned}, resolved ${next.resolved}`);
  return await resolveFrom(batch.lastId, next.scanned, next.resolved);
};

if (!RESOLVE_ONLY) {
  console.log("=== Backfilling citation keys ===");
  await backfillFrom("case_law_decisions", "case_number", null, 0, 0);
  await backfillFrom("case_law_citations", "citation_text", null, 0, 0);
}

if (!KEYS_ONLY) {
  console.log("=== Resolving citations ===");
  const { scanned, resolved } = await resolveFrom(null, 0, 0);
  console.log(`Done. Scanned ${scanned}, resolved ${resolved}.`);
}

process.exit(0);
