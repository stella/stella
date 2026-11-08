import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import {
  storedDecisionTextAbsenceEntriesSql,
  storedDecisionTextAbsenceValidSql,
} from "@/api/lib/case-law/decision-text-sql";

/** Residual filters for bounded decision-id lookups.
 * Structured categories are excluded; only strings the search input accepts
 * can match. PostgreSQL text search refuses these unindexed filters. */
export const decisionSearchCategorySql = (metadata: SQLWrapper) =>
  sql`(CASE WHEN jsonb_typeof(${metadata} -> 'category') = 'string'
    AND length(${metadata} ->> 'category') <= 128
    THEN ${metadata} ->> 'category' END)`;

/** Countries whose dockets open with a senate and a register. */
export const DOCKET_REGISTER_COUNTRIES: ReadonlySet<string> = new Set([
  "CZE",
  "SVK",
]);

type DocketRegisterFilter = {
  docketRegisters?: readonly string[] | undefined;
  senate?: number | undefined;
};

/**
 * A pattern for "<senate> <register> <number>" dockets, as Czech and Slovak
 * courts write them ("21 Cdo 641/2018", "6Co/163/2012"). The register is
 * matched whole, so "Cdo" leaves "Cdon" out. A Constitutional Court docket
 * ("III.ÚS 336/96") opens with neither and never matches.
 */
export const docketRegisterPattern = ({
  docketRegisters,
  senate,
}: DocketRegisterFilter): string => {
  const senatePattern = senate === undefined ? "\\d+" : String(senate);
  const registerPattern =
    docketRegisters === undefined
      ? "[^\\s\\d/]+"
      : `(?:${docketRegisters.map((register) => register.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})`;
  return `^\\s*${senatePattern}\\s*${registerPattern}[\\s/]`;
};

export const decisionDocketRegisterSql = (
  caseNumber: SQLWrapper,
  filter: DocketRegisterFilter,
) => sql`${caseNumber} ~* ${docketRegisterPattern(filter)}`;

export const decisionHasLegalSentenceSql = (metadata: SQLWrapper) => {
  const absenceEntries = storedDecisionTextAbsenceEntriesSql(metadata);

  return sql`(coalesce(
    ${storedDecisionTextAbsenceValidSql(metadata, absenceEntries)}
    AND NOT ${absenceEntries} @> jsonb_build_array(
      jsonb_build_object('field', 'legalSentence')
    )
    AND jsonb_typeof(${metadata} -> 'legalSentence') = 'string'
    AND length(btrim(${metadata} ->> 'legalSentence')) > 0,
    false
  ))`;
};
