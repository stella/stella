import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";
import { BidiText } from "@stll/ui/bidi-text";
import { BreadcrumbPage } from "@stll/ui/breadcrumb";
import { TruncatedText } from "@stll/ui/truncated-text";

import { CourtName } from "./court-name";
import { DECISION_TITLE_SEPARATOR } from "./decision-title";

type DecisionIdentityProps = {
  caseNumber: string;
  court: string;
  courtAbbreviation: string | null;
  courtTier: CourtTierLabel | undefined;
};

/** The public decision breadcrumb's identity, shared with embedded readers. */
export const DecisionIdentity = ({
  caseNumber,
  court,
  courtAbbreviation,
  courtTier,
}: DecisionIdentityProps) => (
  <>
    <BreadcrumbPage className="min-w-0 flex-1 font-medium">
      <TruncatedText render={<BidiText />}>{caseNumber}</TruncatedText>
    </BreadcrumbPage>
    {/* On narrow screens the case number identifies the decision by itself.
        The court name cuts itself and carries its own title. */}
    <TruncatedText
      className="text-muted-foreground flex items-center gap-1.5 max-sm:hidden"
      hint={false}
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
