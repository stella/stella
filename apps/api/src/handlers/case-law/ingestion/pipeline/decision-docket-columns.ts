import { docketFamilyKeyOf } from "@stll/api-contract/decision-docket-reference";
import type { DecisionPrimaryReferenceType } from "@stll/legal-ast/decision-identifier";

import type { caseLawDecisions } from "@/api/db/schema";
import { decisionCitationKeyOf } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { primaryReferenceIsDocket } from "@/api/lib/legal-search/decision-primary-reference";

/**
 * The columns a decision's primary reference is stored under, every one of
 * them derived from the reference itself: the reference and its kind, its
 * citation key, and the case file its docket belongs to.
 *
 * The one place a row's reference is turned into columns. A write that sets
 * the reference without its derived keys leaves them describing the
 * reference it replaced, so the lookup reads the row under a docket it no
 * longer has; built together here, a writer cannot set one without the
 * others (`decision-docket-columns.test.ts` holds every writer to it).
 */
export type DecisionDocketColumns = Required<
  Pick<
    typeof caseLawDecisions.$inferInsert,
    "caseNumber" | "caseNumberType" | "citationKey" | "docketFamilyKey"
  >
>;

export const decisionDocketColumns = ({
  caseNumber,
  caseNumberType,
  country,
}: {
  caseNumber: string;
  caseNumberType: DecisionPrimaryReferenceType;
  country: string;
}): DecisionDocketColumns => ({
  caseNumber,
  caseNumberType,
  citationKey: decisionCitationKeyOf({ caseNumber, caseNumberType }),
  // Only a docket has a case file; a reporter or neutral citation names its
  // decision outright.
  docketFamilyKey: primaryReferenceIsDocket(caseNumberType)
    ? docketFamilyKeyOf(caseNumber, country)
    : null,
});
