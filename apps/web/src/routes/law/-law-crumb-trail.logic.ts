import { toStatuteCountrySegment } from "@stll/api-contract/statute-route";

import { decisionYear } from "@/features/case-law/citation-format";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import type { PublicStatute } from "@/features/statutes/queries/statutes";
import {
  statuteActLabel,
  statuteDocumentIdentity,
} from "@/lib/legal/statute-act-number";

export const statuteLawCrumbTrailOf = ({
  eli,
  title,
  country,
}: Pick<PublicStatute, "eli" | "title" | "country">) => {
  const identity = statuteDocumentIdentity(eli);
  const label = statuteActLabel({ eli, title });
  return {
    kind: "statute",
    identity,
    citation: label.number,
    shortTitle: label.name,
    fullTitle: title,
    yearLink:
      identity.year === null
        ? null
        : {
            to: "/law/$country/statutes",
            params: { country: toStatuteCountrySegment(country) },
            search: { year: Number(identity.year) },
          },
  } as const;
};

type DecisionLawCrumbTrailInput = Pick<
  PublicCaseLawDecision,
  "court" | "courtAbbreviation" | "caseNumber" | "decisionDate" | "metadata"
> & {
  courtTier?: PublicCaseLawDecision["courtTier"] | undefined;
};

export const decisionLawCrumbTrailOf = ({
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
    court: {
      name: court,
      abbreviation: courtAbbreviation,
      tier: courtTier,
      link: { to: "/law/cases", search: { court } },
    },
    yearLink:
      year === null ? null : { to: "/law/cases", search: { court, year } },
    caseNumber,
    legalArea:
      typeof metadata.legalArea === "string" ? metadata.legalArea : null,
  } as const;
};

export type LawCrumbTrail =
  | ReturnType<typeof statuteLawCrumbTrailOf>
  | ReturnType<typeof decisionLawCrumbTrailOf>;
