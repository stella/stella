/**
 * Which decisions a citation may link to: the one definition the resolver
 * links by and the census classifies by.
 *
 * Three rules narrow a key's holders to its candidates. Jurisdiction: the
 * citing country's declared reach. Time: a decision cannot cite one handed
 * down after it. Self: a decision is not a candidate for its own citations.
 * The census reads the same set because it reports on the resolver's
 * backlog; a shape computed over holders the resolver never considers would
 * file a key under the wrong disposition.
 */

import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";
import { citationResolutionPolicyRows } from "@/api/lib/case-law/citation-jurisdiction-policy";
import { CITATION_CANDIDATE_SCAN_CAP } from "@/api/lib/case-law/citation-resolution-status";
import type { CaseLawJurisdiction } from "@/api/lib/legal-search/ingestion-constants";

export const varcharArray = (values: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::varchar[]`;

const jurisdictionArray = (
  jurisdictions: readonly CaseLawJurisdiction[],
): SQL => varcharArray(jurisdictions);

/**
 * The declared reach of every jurisdiction as `(citing, allowed[])` rows.
 *
 * The whole map travels with the statement rather than one row's entry,
 * because a batch spans jurisdictions and each row picks up its own reach by
 * joining on its citing decision's country. Built per call: it is five rows
 * of constants, and caching it would only add a second place for the policy
 * to be stale.
 */
export const policyCte = (): SQL =>
  sql`policy(citing_country, resolves_to) AS (VALUES ${sql.join(
    citationResolutionPolicyRows().map(
      ({ jurisdiction, resolvesTo }) =>
        sql`(${jurisdiction}::varchar, ${jurisdictionArray(resolvesTo)})`,
    ),
    sql`, `,
  )})`;

export type CandidateHoldersSqlOptions = {
  /** Alias the holder row is read under; the subquery selects its columns. */
  holder: SQL;
  /** The citation's canonical key, as a column reference. */
  citationKey: SQL;
  /** The citing decision's id, excluded from its own candidates. */
  citingDecisionId: SQL;
  /** The citing decision's date; a null date disables the time rule. */
  citingDate: SQL;
  /** The citing jurisdiction's reach, a varchar[] expression. */
  resolvesTo: SQL;
};

/**
 * The bounded candidate set for one citation: `id`, `court`, `decision_type`
 * of at most `CITATION_CANDIDATE_SCAN_CAP` holders that pass every rule.
 * Callers aggregate over it; the cap is what keeps one citation's cost
 * independent of how popular its key is.
 */
export const candidateHoldersSql = ({
  holder,
  citationKey,
  citingDecisionId,
  citingDate,
  resolvesTo,
}: CandidateHoldersSqlOptions): SQL => sql`
  SELECT ${holder}.id, ${holder}.court, ${holder}.decision_type
    FROM ${caseLawDecisions} ${holder}
   WHERE ${holder}.citation_key = ${citationKey}
     AND ${holder}.country = ANY (${resolvesTo})
     AND ${holder}.id <> ${citingDecisionId}
     AND (
           ${holder}.decision_date IS NULL
        OR ${citingDate} IS NULL
        OR ${citingDate} >= ${holder}.decision_date
         )
   LIMIT ${CITATION_CANDIDATE_SCAN_CAP}`;
