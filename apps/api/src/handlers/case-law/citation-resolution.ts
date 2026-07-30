/**
 * Citation resolution: link a citation to the decision it cites.
 *
 * Both sides carry the same canonical key (`bareCitationKey` over the
 * citation's text and over the decision's case number), so resolution is an
 * indexed equality join rather than a scan. The work happens inside one
 * statement per batch: nothing about it scales with corpus size, and a run
 * can stop and resume anywhere.
 *
 * Three rules keep a link honest, and each of them is a filter in the join
 * rather than a check afterwards:
 *
 * - **Jurisdiction.** A case number is only unique within its own court
 *   system; the same string means different cases in different countries.
 * - **Time.** A decision cannot cite one published after it. This is the
 *   rule that catches a coincidental key collision with a later case, which
 *   is otherwise indistinguishable from a real citation.
 * - **Uniqueness.** A key matching more than one decision is ambiguous, and
 *   an ambiguous link is worse than none: it puts a wrong edge in the
 *   citation graph and thus a wrong number in the authority ranking. Those
 *   rows stay unresolved for the adjudication tier to pick up.
 */

import { sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCitations, caseLawDecisions } from "@/api/db/schema";
import { isRecord } from "@/api/lib/type-guards";

export type CitationResolutionBatch = {
  /** Rows examined. Zero means the scan reached the end. */
  scanned: number;
  /** Rows linked to a decision. */
  resolved: number;
  /**
   * Opaque cursor: the highest citation id examined, passed back as
   * `afterId` to continue. Keyset rather than offset because resolved rows
   * leave the predicate, which would make an offset skip unexamined rows.
   * Not a `SafeId` — it addresses a position in the scan, never an entity.
   */
  lastId: string | null;
};

export type ResolveCitationBatchOptions = {
  limit: number;
  /** Cursor from the previous batch's `lastId`; null starts at the beginning. */
  afterId: string | null;
};

const toCount = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * `execute` yields the rows directly on the server driver and wraps them in
 * `{ rows }` under pglite. Reading only one shape silently returns zero
 * counts on the other — the statement still runs, so the miscount is
 * invisible until someone trusts the number.
 */
const firstRow = (result: unknown): unknown => {
  if (Array.isArray(result)) {
    return result.at(0);
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"].at(0);
  }
  return undefined;
};

export const resolveCitationBatch = async (
  scopedDb: ScopedDb,
  { limit, afterId }: ResolveCitationBatchOptions,
): Promise<CitationResolutionBatch> =>
  await scopedDb(async (tx) => {
    // audit: skip — derived citation graph, not a user action
    const result: unknown = await tx.execute(sql`
      WITH batch AS (
        SELECT c.id,
               c.citation_key,
               c.citing_decision_id,
               citing.country AS citing_country,
               citing.decision_date AS citing_date
          FROM ${caseLawCitations} c
          JOIN ${caseLawDecisions} citing ON citing.id = c.citing_decision_id
         WHERE c.cited_decision_id IS NULL
           AND c.citation_key IS NOT NULL
           ${afterId === null ? sql`` : sql`AND c.id > ${afterId}`}
         ORDER BY c.id
         LIMIT ${limit}
      ),
      matched AS (
        SELECT b.id AS citation_id,
               cited.id AS decision_id,
               count(*) OVER (PARTITION BY b.id) AS matches
          FROM batch b
          JOIN ${caseLawDecisions} cited
            ON cited.citation_key = b.citation_key
           AND cited.country = b.citing_country
           AND cited.id <> b.citing_decision_id
           AND (
                 cited.decision_date IS NULL
              OR b.citing_date IS NULL
              OR b.citing_date >= cited.decision_date
               )
      ),
      updated AS (
        UPDATE ${caseLawCitations} target
           SET cited_decision_id = m.decision_id
          FROM matched m
         WHERE target.id = m.citation_id
           AND m.matches = 1
        RETURNING target.id
      )
      SELECT (SELECT count(*) FROM batch) AS scanned,
             (SELECT count(*) FROM updated) AS resolved,
             (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS last_id
    `);

    const row: unknown = firstRow(result);
    if (!isRecord(row)) {
      return { scanned: 0, resolved: 0, lastId: null };
    }
    const lastId = row["last_id"];
    return {
      scanned: toCount(row["scanned"]),
      resolved: toCount(row["resolved"]),
      lastId: typeof lastId === "string" ? lastId : null,
    };
  });
