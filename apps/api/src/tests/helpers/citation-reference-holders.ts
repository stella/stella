/**
 * Every decision holding one reference's identity, read the way the
 * resolver's candidate join matches them: the typed identifier, and the legacy
 * key bridge for a case-number or untyped reference whose holder has no
 * case-number identifier under that key. Nothing is filtered: jurisdiction,
 * time, self, language grouping and the cap are `resolveDecisionReference`'s.
 *
 * The sheet and court facts come from the resolver's own SQL fragments, so a
 * test comparing the two statements of the doctrine compares their rules, not
 * two spellings of a pattern.
 */

import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import { caseLawDecisionIdentifiers, caseLawDecisions } from "@/api/db/schema";
import { courtNameKeySql } from "@/api/handlers/case-law/citation-court-hint";
import { holderAnswersSheetSql } from "@/api/handlers/case-law/citation-resolution";
import type {
  ReferenceHolder,
  ResolvableReference,
} from "@/api/handlers/case-law/citations/reference-resolution";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/** A reference in the columns a citation row stores it under. */
export type StoredReference = ResolvableReference & {
  identifierType: DecisionIdentifierType | null;
  normalizedValue: string | null;
};

type HolderReader = {
  execute: (query: SQL) => Promise<{ rows: unknown[] }>;
};

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export const readReferenceHolders = async (
  db: HolderReader,
  { citationKey, identifierType, normalizedValue, hints }: StoredReference,
): Promise<ReferenceHolder[]> => {
  if (citationKey === null) {
    return [];
  }
  const sheet = sql`${hints.sheetNumber}::varchar`;
  const court = sql`${hints.court}::varchar`;
  const type = sql`${identifierType}::varchar`;
  const key = sql`${citationKey}::varchar`;
  const result = await db.execute(sql`
    SELECT d.id::text AS id,
           d.country,
           d.decision_date::text AS decision_date,
           d.court,
           d.decision_type,
           d.language,
           d.language_group_key,
           coalesce(${holderAnswersSheetSql(sql.raw("d"), sheet)}, false)
             AS answers_sheet,
           coalesce(
             ${court} IS NOT NULL
             AND ${courtNameKeySql(sql.raw("d.court"))} = ${courtNameKeySql(court)},
             false
           ) AS sits_at_court
      FROM ${caseLawDecisions} d
     WHERE d.id IN (
             SELECT identifier.decision_id
               FROM ${caseLawDecisionIdentifiers} identifier
              WHERE identifier.type = coalesce(${type}, 'case-number')
                AND identifier.normalized_value
                      = coalesce(${normalizedValue}::varchar, ${key})
             UNION
             SELECT bridged.id
               FROM ${caseLawDecisions} bridged
              WHERE (${type} IS NULL OR ${type} = 'case-number')
                AND bridged.citation_key = ${key}
                AND NOT EXISTS (
                  SELECT 1
                    FROM ${caseLawDecisionIdentifiers} existing
                   WHERE existing.decision_id = bridged.id
                     AND existing.type = 'case-number'
                     AND existing.normalized_value = ${key}
                )
           )
  `);
  return result.rows.map((row) => {
    if (!isRecord(row) || typeof row["id"] !== "string") {
      return panic("expected a holder row with an id");
    }
    return {
      decisionId: brandPersistedCaseLawDecisionId(row["id"]),
      jurisdiction: textOrNull(row["country"]),
      decisionDate: textOrNull(row["decision_date"]),
      court: textOrNull(row["court"]),
      decisionType: textOrNull(row["decision_type"]),
      language: String(row["language"]),
      languageGroupKey: textOrNull(row["language_group_key"]),
      answersPrintedSheet: row["answers_sheet"] === true,
      sitsAtPrintedCourt: row["sits_at_court"] === true,
    };
  });
};
