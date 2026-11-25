/**
 * Citations stored before `identifier_match_key` existed get their key here,
 * the online repair behind migration
 * 20261125150000_case_law_citation_match_key.
 *
 * The key is written from the same fold the trigger applies
 * (`citationIdentifierMatchKeySql`), and the write names the column, so the
 * trigger computes it again from the row the update actually sees: a key
 * written here can never disagree with the row's own values, even when a
 * writer changes them meanwhile.
 *
 * Only a pending row is selected and only its key is written, guarded by the
 * pending predicate: a committed batch is never selected again, a re-run
 * changes nothing, and no other column of a citation is touched. The pending
 * rows are the checkpoint, walked in id order through their partial index,
 * which the repair empties. Until it is empty, a reopen also matches the rows
 * still in it by their folded columns (`citation-arrivals.ts`), so nothing
 * waits on this pass for its answer.
 */
import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  CITATION_IDENTIFIER_MATCH_KEY_MIGRATION,
  citationIdentifierMatchKeyPendingSql,
  citationIdentifierMatchKeySql,
} from "@/api/handlers/case-law/citation-identifier-match-key";
import { isRecord } from "@/api/lib/type-guards";

import {
  createPendingRowBackfill,
  type PendingRowBackfillOptions,
} from "./pending-row-backfill";

/** Citations per batch; the runtime may shrink it under load. */
const BATCH = 2000;

const dialect = new PgDialect();

/** A fragment with no bound value, as the migrate connection's text. */
const render = (fragment: SQL): string => {
  const { sql: text, params } = dialect.sqlToQuery(fragment);
  return params.length === 0
    ? text
    : panic("A citation match-key fragment unexpectedly binds a value");
};

const COLUMNS = {
  identifierMatchKey: sql.raw('"identifier_match_key"'),
  normalizedIdentifierValue: sql.raw('"normalized_identifier_value"'),
  citationKey: sql.raw('"citation_key"'),
};

export const CITATION_MATCH_KEY_PENDING = render(
  citationIdentifierMatchKeyPendingSql(COLUMNS),
);

const STORED_KEY = render(citationIdentifierMatchKeySql(COLUMNS));

/**
 * One batch. `$1` is the batch size and, after the first batch, `$2` the last
 * id of the previous one; the relation is a parameter only so a test can run
 * the statement against another table. Both forms walk the pending index in
 * id order and stop at the batch size.
 */
export const citationMatchKeyBatchSql = (
  relation: string,
  { after }: { after: boolean },
): string => `
  WITH picked AS MATERIALIZED (
    SELECT id
      FROM ${relation}
     WHERE ${CITATION_MATCH_KEY_PENDING}${after ? "\n       AND id > $2::uuid" : ""}
     ORDER BY id
     LIMIT $1
  ),
  keyed AS (
    UPDATE ${relation} AS citation
       SET identifier_match_key = ${STORED_KEY}
      FROM picked
     WHERE citation.id = picked.id
       AND ${CITATION_MATCH_KEY_PENDING}
    RETURNING citation.id
  )
  SELECT (SELECT id::text FROM picked ORDER BY id DESC LIMIT 1) AS last_id,
         (SELECT count(*)::int FROM picked) AS picked,
         (SELECT count(*)::int FROM keyed) AS keyed`;

const decodeBatch = (
  row: unknown,
): { lastId: string | null; picked: number; keyed: number } => {
  if (!isRecord(row)) {
    return panic("Invalid citation match-key batch row");
  }
  const lastId = row["last_id"];
  const picked = row["picked"];
  const keyed = row["keyed"];
  return (typeof lastId === "string" || lastId === null) &&
    typeof picked === "number" &&
    typeof keyed === "number"
    ? { lastId, picked, keyed }
    : panic("Invalid citation match-key batch row");
};

export const createCitationIdentifierMatchKeyBackfill = ({
  batchSize = BATCH,
  ...options
}: PendingRowBackfillOptions = {}) =>
  createPendingRowBackfill(
    {
      name: "citation-identifier-match-key",
      introducedBy: CITATION_IDENTIFIER_MATCH_KEY_MIGRATION,
      tableName: "case_law_citations",
      pending: CITATION_MATCH_KEY_PENDING,
      reason: "citations stored before their match key await it",
      batchSize,
      batch: async ({ tx, size, cursor }) => {
        const { lastId, picked, keyed } = decodeBatch(
          (cursor === null
            ? await tx.query(
                citationMatchKeyBatchSql('public."case_law_citations"', {
                  after: false,
                }),
                [size],
              )
            : await tx.query(
                citationMatchKeyBatchSql('public."case_law_citations"', {
                  after: true,
                }),
                [size, cursor],
              )
          ).at(0),
        );
        return picked === 0 || lastId === null
          ? { cursor: null, done: true, value: 0 }
          : { cursor: lastId, done: false, value: keyed };
      },
    },
    options,
  );

export const CITATION_IDENTIFIER_MATCH_KEY_BACKFILL =
  createCitationIdentifierMatchKeyBackfill();
