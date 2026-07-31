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
const backfillKeys = async (
  table: "case_law_decisions" | "case_law_citations",
  sourceColumn: "case_number" | "citation_text",
): Promise<void> => {
  let after: string | null = null;
  let seen = 0;
  let keyed = 0;

  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- keyset walk: each batch starts where the previous ended
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
      break;
    }

    const values = rows.map((row) => {
      const key = keyOf(row.text) ?? "";
      return sql`(${row.id}::uuid, ${key}::varchar)`;
    });

    // oxlint-disable-next-line no-await-in-loop -- one bounded batch write per iteration
    await rootDb.execute(
      sql`UPDATE ${sql.raw(table)} AS t
             SET citation_key = v.key
            FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, key)
           WHERE t.id = v.id`,
    );

    seen += rows.length;
    keyed += rows.filter((row) => keyOf(row.text) !== null).length;
    after = rows.at(-1)?.id ?? after;
    console.log(`  ${table}: ${seen} scanned, ${keyed} keyed`);
  }
};

if (!RESOLVE_ONLY) {
  console.log("=== Backfilling citation keys ===");
  await backfillKeys("case_law_decisions", "case_number");
  await backfillKeys("case_law_citations", "citation_text");
}

if (!KEYS_ONLY) {
  console.log("=== Resolving citations ===");
  let after: string | null = null;
  let scanned = 0;
  let resolved = 0;

  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- keyset walk: each batch's cursor comes from the previous one
    const batch = await resolveCitationBatch(ingestionDb, {
      limit: BATCH,
      afterId: after,
    });
    if (batch.scanned === 0) {
      break;
    }
    scanned += batch.scanned;
    resolved += batch.resolved;
    after = batch.lastId;
    console.log(`  scanned ${scanned}, resolved ${resolved}`);
  }
  console.log(`Done. Scanned ${scanned}, resolved ${resolved}.`);
}

process.exit(0);
