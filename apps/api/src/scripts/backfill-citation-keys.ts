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

import { panic } from "better-result";
import { sql } from "drizzle-orm";

import {
  lockCitationGraph,
  reopenCitationsForKeys,
} from "@/api/handlers/case-law/citation-resolution";
import { CITATION_RESOLUTION_STATUS } from "@/api/handlers/case-law/citation-resolution-status";
import {
  citationKeyOf,
  decisionCitationKeyOf,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { primaryReferenceTypeFromStored } from "@/api/lib/legal-search/decision-primary-reference";
import { isRecord } from "@/api/lib/type-guards";

const RECANONICALIZE_FLAG = "--recanonicalize";

/** Which rows a pass rewrites: those with no key, or every stale one. */
const KEY_SCOPE = {
  MISSING: "missing",
  STALE: "stale",
} as const;

type KeyScope = (typeof KEY_SCOPE)[keyof typeof KEY_SCOPE];

const args = process.argv.slice(2);
const unsupported = args.filter((argument) => argument !== RECANONICALIZE_FLAG);
if (unsupported.length > 0) {
  panic(`Unsupported argument: ${unsupported.join(" ")}`);
}
const scope: KeyScope = args.includes(RECANONICALIZE_FLAG)
  ? KEY_SCOPE.STALE
  : KEY_SCOPE.MISSING;

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
  const missingOnly = scope === KEY_SCOPE.MISSING;

  while (true) {
    // db-await-in-loop: keyset page per iteration; the page is the batch
    const result: unknown = await rootDb.execute(
      sql`SELECT id, ${sql.raw(sourceColumn)} AS text, citation_key AS stored,
                 ${sql.raw(table === "case_law_decisions" ? "case_number_type" : "NULL")} AS type
            FROM ${sql.raw(table)}
           WHERE ${missingOnly ? sql`citation_key IS NULL` : sql`TRUE`}
             ${after === null ? sql`` : sql`AND id > ${after}`}
           ORDER BY id
           LIMIT ${BATCH}`,
    );
    const rows = (Array.isArray(result) ? result : []).flatMap((row) =>
      isRecord(row) &&
      typeof row["id"] === "string" &&
      typeof row["text"] === "string"
        ? [
            {
              id: row["id"],
              // A decision whose primary reference is not a docket keeps no
              // key: filling one here would undo what the pipeline wrote.
              key:
                table === "case_law_decisions"
                  ? decisionCitationKeyOf({
                      caseNumber: row["text"],
                      caseNumberType: primaryReferenceTypeFromStored(
                        row["type"],
                      ),
                    })
                  : citationKeyOf(row["text"]),
              stored: typeof row["stored"] === "string" ? row["stored"] : null,
            },
          ]
        : [],
    );

    if (rows.length === 0) {
      return totals;
    }

    const keyed = rows.filter(({ key, stored }) =>
      missingOnly ? key !== null : key !== stored,
    );
    if (keyed.length > 0) {
      const values = sql.join(
        keyed.map(({ id, key }) => sql`(${id}::uuid, ${key}::varchar)`),
        sql`, `,
      );
      // One transaction, because giving a decision a key is the same event the
      // ingestion pipeline announces and it has to be announced the same way.
      // The citation graph's advisory lock is taken before any row is written,
      // the order the resolver takes it in, so the write and its announcement
      // are serialized against the standing walk: without that, a resolver
      // batch holding a pre-key snapshot can wait on this statement's row
      // locks and then commit a target or an `unmatched` read off the old key
      // over the reset, and the row stays settled forever. The maintenance
      // lane held above serializes operator passes only, not the resolver.
      //
      // A citation gaining a key was `pending` all along — it was excluded
      // from the walk by having no key, and now it is not. A citation whose
      // key changes spelling was settled against the old one, so it goes back
      // to `pending`; a decision's rekeying reopens the citations of both its
      // old and its new key.
      // db-await-in-loop: bounded batch per iteration under the graph lock
      await rootDb.transaction(async (tx) => {
        await lockCitationGraph(tx);
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
          return;
        }
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
      });
    }

    totals.seen += rows.length;
    totals.keyed += keyed.length;
    console.log(`  ${table}: ${totals.seen} scanned, ${totals.keyed} keyed`);
    after = rows.at(-1)?.id ?? after;
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
