/**
 * The byte budget the search candidate index's variable-width columns share.
 *
 * A B-tree tuple may not exceed 2704 bytes, and `case_law_decisions_search_
 * candidate_idx` carries `court`, `language_group_key` and `decision_type`.
 * All three are `varchar(n)`, which bounds characters rather than bytes, so
 * 512 + 512 + 128 characters of three-byte text builds a 3456-byte row the
 * index refuses ("index row size 3536 exceeds btree version 4 maximum 2704"),
 * and the write fails. Today's corpus is nowhere near it (the longest court
 * name is 64 bytes, and a language group key is an ECLI or
 * `<source uuid>:<case number>`), but nothing stopped a future publisher.
 *
 * The other eight columns and the tuple header measured 80 bytes, so this
 * budget caps an index row at about 2080 and leaves some 600 in reserve.
 * Enforced at the table rather than in the ingestion pipeline: a value this
 * long is a publisher's, not a caller's, and failing the write is the correct
 * outcome. Truncating it would change what a court is called.
 */
import type { Column, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

export const CASE_LAW_SEARCH_CANDIDATE_ROW_BOUND_CONSTRAINT =
  "case_law_decisions_search_candidate_row_bound";

export const CASE_LAW_SEARCH_CANDIDATE_ROW_MAX_BYTES = 2000;

type SearchCandidateRowColumns = {
  court: Column;
  decisionType: Column;
  languageGroupKey: Column;
};

export const searchCandidateRowWithinBoundsSql = ({
  court,
  decisionType,
  languageGroupKey,
}: SearchCandidateRowColumns): SQL =>
  sql`octet_length(${court})
    + coalesce(octet_length(${languageGroupKey}), 0)
    + coalesce(octet_length(${decisionType}), 0)
    <= ${sql.raw(String(CASE_LAW_SEARCH_CANDIDATE_ROW_MAX_BYTES))}`;
