/**
 * `case_law_citations.identifier_match_key`: the match key of a citation's
 * effective identifier, stored.
 *
 * A citation names a case by its normalized identifier, or by its citation
 * key on rows written before identifiers. An arriving decision's identifier
 * answers the citations whose key folds to the same match key
 * (`case-number-match-key.ts`). Folding every candidate inside the query made
 * that lookup depend on an expression index; the stored key makes it an
 * equality probe on a plain column.
 *
 * One owner: the trigger `case_law_citations_identifier_match_key` (migration
 * `20261126120000_case_law_citation_match_key`) sets the key on every insert
 * and on every update that names either input or the key itself, from the
 * same fold `caseNumberMatchKeySql` renders. Rows stored before the column
 * get it from the online repair `citation-identifier-match-key`; until then a
 * reopen also matches them by their folded columns (`citation-arrivals.ts`).
 * `citation-identifier-match-key.db.test.ts` holds the trigger's body to the
 * renderer and its output to `caseNumberMatchKey`.
 */
import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { effectiveCitationIdentifierValueSql } from "@/api/handlers/case-law/citation-resolution-status";
import { caseNumberMatchKeySql } from "@/api/lib/case-law/case-number-match-key";

export const CITATION_IDENTIFIER_MATCH_KEY_TRIGGER =
  "case_law_citations_identifier_match_key";

export const CITATION_IDENTIFIER_MATCH_KEY_FUNCTION =
  "case_law_citations_identifier_match_key";

export const CITATION_IDENTIFIER_MATCH_KEY_MIGRATION =
  "20261126120000_case_law_citation_match_key";

type CitationKeyColumns = {
  normalizedIdentifierValue: SQLWrapper;
  citationKey: SQLWrapper;
};

/** The key the trigger stores for a row with these two key columns. */
export const citationIdentifierMatchKeySql = ({
  normalizedIdentifierValue,
  citationKey,
}: CitationKeyColumns): SQL =>
  caseNumberMatchKeySql(
    effectiveCitationIdentifierValueSql(normalizedIdentifierValue, citationKey),
  );

/**
 * A row stored before the key existed: it has a key to fold and none stored.
 * Only such rows can lack a key the trigger would have written, so this is
 * the repair's selection and the partial index's predicate.
 */
export const citationIdentifierMatchKeyPendingSql = ({
  identifierMatchKey,
  normalizedIdentifierValue,
  citationKey,
}: CitationKeyColumns & { identifierMatchKey: SQLWrapper }): SQL =>
  sql`${identifierMatchKey} IS NULL AND ${effectiveCitationIdentifierValueSql(
    normalizedIdentifierValue,
    citationKey,
  )} IS NOT NULL`;
