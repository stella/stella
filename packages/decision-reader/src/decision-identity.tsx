import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";
import { BidiText } from "@stll/ui/bidi-text";
import { BreadcrumbPage } from "@stll/ui/breadcrumb";

import { CourtName } from "./court-name";

export const DECISION_TITLE_SEPARATOR = "·";

type DecisionIdentityProps = {
  presentation?: "breadcrumb" | "embedded";
  caseNumber: string;
  court: string;
  courtAbbreviation: string | null;
  courtTier: CourtTierLabel | undefined;
};

/** The public decision breadcrumb's identity, shared with embedded readers. */
export const DecisionIdentity = ({
  presentation = "breadcrumb",
  caseNumber,
  court,
  courtAbbreviation,
  courtTier,
}: DecisionIdentityProps) => (
  <>
    <BreadcrumbPage
      className={
        presentation === "embedded"
          ? "min-w-0 font-medium wrap-break-word"
          : "min-w-0 flex-1 truncate font-medium"
      }
    >
      <BidiText>{caseNumber}</BidiText>
    </BreadcrumbPage>
    <span
      className={
        presentation === "embedded"
          ? "text-muted-foreground flex min-w-0 items-center gap-1.5"
          : "text-muted-foreground flex min-w-0 items-center gap-1.5 truncate max-sm:hidden"
      }
    >
      {DECISION_TITLE_SEPARATOR}
      <CourtName
        abbreviation={courtAbbreviation}
        court={court}
        tier={courtTier}
      />
    </span>
  </>
);
