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
 *   bun apps/api/src/scripts/backfill-citation-keys.ts
 */

import { sql } from "drizzle-orm";

import { reopenCitationsForKeys } from "@/api/handlers/case-law/citation-resolution";
import { citationKeyOf } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { isRecord } from "@/api/lib/type-guards";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { rootDb } = await enterCaseLawMaintenanceLane();

const BATCH = 5000;

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
  let after: string | null = null;

  while (true) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- keyset page per iteration; the page is the batch
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
        ? [{ id: row["id"], key: citationKeyOf(row["text"]) }]
        : [],
    );

    if (rows.length === 0) {
      return totals;
    }

    const keyed = rows.filter(({ key }) => key !== null);
    if (keyed.length > 0) {
      const values = sql.join(
        keyed.map(({ id, key }) => sql`(${id}::uuid, ${key}::varchar)`),
        sql`, `,
      );
      // One transaction, because giving a decision a key is the same event the
      // ingestion pipeline announces and it has to be announced the same way.
      // `reopenCitationsForKeys` takes the citation graph's advisory lock, so
      // the write and its announcement are serialized against the standing
      // walk: without that, a resolver batch holding a pre-key snapshot can
      // commit `unmatched` after this statement has already decided there was
      // nothing to reopen, and the row stays terminal forever.
      //
      // Only for decisions. A citation gaining a key was `pending` all along —
      // it was excluded from the walk by having no key, and now it is not.
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded batch per iteration under the graph lock
      await rootDb.transaction(async (tx) => {
        await tx.execute(
          sql`WITH v(id, key) AS (VALUES ${values})
              UPDATE ${sql.raw(table)} AS t
                 SET citation_key = v.key
                FROM v
               WHERE t.id = v.id`,
        );
        if (table === "case_law_decisions") {
          await reopenCitationsForKeys(
            tx,
            keyed.flatMap(({ key }) => (key === null ? [] : [key])),
          );
        }
      });
    }

    totals.seen += rows.length;
    totals.keyed += keyed.length;
    console.log(`  ${table}: ${totals.seen} scanned, ${totals.keyed} keyed`);
    after = rows.at(-1)?.id ?? after;
  }
};

console.log("=== Backfilling citation keys ===");
const decisions = await backfillTable("case_law_decisions", "case_number");
const citations = await backfillTable("case_law_citations", "citation_text");
console.log(
  `Done. decisions ${decisions.keyed}/${decisions.seen}, ` +
    `citations ${citations.keyed}/${citations.seen}.`,
);

process.exit(0);
