import { linkOptions } from "@tanstack/react-router";

import { statuteDisplayLabel } from "@stll/api-contract/statute-display-label";
import { toStatuteCountrySegment } from "@stll/api-contract/statute-route";

import { yearDateRange } from "@/features/case-law/case-law-index-search.logic";
import { decisionYear } from "@/features/case-law/citation-format";
import { decisionCaseListLink } from "@/features/case-law/decision-case-list-link";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import type { PublicStatute } from "@/features/statutes/queries/statutes";
import { statuteDocumentIdentity } from "@/lib/legal/statute-act-number";
import { hasOtherCaseFileDocuments } from "@/routes/law/-components/public-decision-case-file.logic";

export const statuteLawCrumbTrailOf = ({
  eli,
  title,
  documentType,
  country,
  status,
  versionValidFrom,
  expressionKind,
  windowDisposition,
}: Pick<
  PublicStatute,
  | "eli"
  | "title"
  | "country"
  | "status"
  | "versionValidFrom"
  | "expressionKind"
  | "windowDisposition"
> & { documentType?: string | null }) => {
  const identity = statuteDocumentIdentity(eli);
  const label = statuteDisplayLabel({
    eli,
    title,
    country,
    documentType: documentType ?? null,
  });
  const year = identity.year === null ? null : Number(identity.year);
  return {
    kind: "statute",
    country: {
      code: country,
      link: linkOptions({
        to: "/law/$country/statutes",
        params: { country: toStatuteCountrySegment(country) },
      }),
    },
    status,
    validFrom: versionValidFrom,
    expression: { expressionKind, windowDisposition },
    identity,
    citation: label.identity,
    shortTitle: label.subject,
    fullTitle: label.text,
    yearLink:
      year === null
        ? null
        : {
            year,
            link: linkOptions({
              to: "/law/$country/statutes",
              params: { country: toStatuteCountrySegment(country) },
              search: { year },
            }),
          },
  } as const;
};

type DecisionLawCrumbTrailInput = Pick<
  PublicCaseLawDecision,
  | "country"
  | "caseFile"
  | "court"
  | "courtAbbreviation"
  | "caseNumber"
  | "decisionDate"
  | "id"
  | "languageGroupKey"
  | "metadata"
> & {
  courtTier?: PublicCaseLawDecision["courtTier"] | undefined;
};

export const decisionLawCrumbTrailOf = ({
  country,
  caseFile,
  court,
  courtAbbreviation,
  courtTier,
  caseNumber,
  decisionDate,
  id,
  languageGroupKey,
  metadata,
}: DecisionLawCrumbTrailInput) => {
  const year = decisionYear(decisionDate);
  const current = { id, languageGroupKey };
  return {
    kind: "decision",
    country: { code: country, link: decisionCaseListLink({ country }) },
    court: {
      name: court,
      abbreviation: courtAbbreviation,
      tier: courtTier,
      link: decisionCaseListLink({ country }, { court }),
    },
    // The year's span in the form the results page writes; `year` is only read
    // there, for links made before the range existed.
    yearLink:
      year === null
        ? null
        : {
            year,
            link: decisionCaseListLink(
              { country },
              { court, ...yearDateRange(String(year)) },
            ),
          },
    caseNumber,
    // The case number's document list: offered only when it holds somewhere
    // to go besides the open decision.
    caseFile: hasOtherCaseFileDocuments(caseFile, current)
      ? { ...caseFile, current }
      : null,
    legalArea:
      typeof metadata["legalArea"] === "string" ? metadata["legalArea"] : null,
  } as const;
};

export type LawCrumbTrail =
  | ReturnType<typeof statuteLawCrumbTrailOf>
  | ReturnType<typeof decisionLawCrumbTrailOf>;
