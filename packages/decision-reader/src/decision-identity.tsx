import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";
import { BidiText } from "@stll/ui/bidi-text";
import { BreadcrumbPage } from "@stll/ui/breadcrumb";
import { TruncatedText } from "@stll/ui/truncated-text";

import { CourtName } from "./court-name";
import { DECISION_TITLE_SEPARATOR } from "./decision-title";

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
          : "min-w-0 flex-1 font-medium"
      }
    >
      <TruncatedText
        lines={presentation === "embedded" ? "none" : 1}
        render={<BidiText />}
      >
        {caseNumber}
      </TruncatedText>
    </BreadcrumbPage>
    {/* On narrow screens the case number identifies the decision by itself.
        The court name cuts itself and carries its own title. An embedded
        reader wraps both instead of cutting them. */}
    <TruncatedText
      className={
        presentation === "embedded"
          ? "text-muted-foreground flex items-center gap-1.5"
          : "text-muted-foreground flex items-center gap-1.5 max-sm:hidden"
      }
      hint={false}
      lines={presentation === "embedded" ? "none" : 1}
    >
      {DECISION_TITLE_SEPARATOR}
      <CourtName
        abbreviation={courtAbbreviation}
        court={court}
        tier={courtTier}
      />
    </TruncatedText>
  </>
);
