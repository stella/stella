import { linkOptions } from "@tanstack/react-router";

import { statuteActLabel } from "@stll/api-contract/statute-act-number";
import { toStatuteCountrySegment } from "@stll/api-contract/statute-route";

import { yearDateRange } from "@/features/case-law/case-law-index-search.logic";
import { decisionYear } from "@/features/case-law/citation-format";
import { decisionCaseListLink } from "@/features/case-law/decision-case-list-link";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import type { PublicStatute } from "@/features/statutes/queries/statutes";
import { statuteDocumentIdentity } from "@/lib/legal/statute-act-number";

export const statuteLawCrumbTrailOf = ({
  eli,
  title,
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
>) => {
  const identity = statuteDocumentIdentity(eli);
  const label = statuteActLabel({ eli, title });
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
    citation: label.number,
    shortTitle: label.name,
    fullTitle: title,
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
  | "court"
  | "courtAbbreviation"
  | "caseNumber"
  | "decisionDate"
  | "metadata"
> & {
  courtTier?: PublicCaseLawDecision["courtTier"] | undefined;
};

export const decisionLawCrumbTrailOf = ({
  country,
  court,
  courtAbbreviation,
  courtTier,
  caseNumber,
  decisionDate,
  metadata,
}: DecisionLawCrumbTrailInput) => {
  const year = decisionYear(decisionDate);
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
    legalArea:
      typeof metadata["legalArea"] === "string" ? metadata["legalArea"] : null,
  } as const;
};

export type LawCrumbTrail =
  | ReturnType<typeof statuteLawCrumbTrailOf>
  | ReturnType<typeof decisionLawCrumbTrailOf>;
