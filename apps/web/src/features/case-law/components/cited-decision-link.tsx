import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";

import { BidiText } from "@stll/ui/bidi-text";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { cn } from "@stll/ui/utils";

import type { CitedDecision } from "@/features/case-law/citation-treatment";
import { formatDecisionDate } from "@/features/case-law/decision-date";
import { useFormatter } from "@/i18n/formatting-context";
import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";

type CitedDecisionLinkProps = {
  children: ReactNode;
  className?: string | undefined;
  decision: CitedDecision;
};

/**
 * A link to another decision that shows the decision's header on hover, so
 * a reader can place a citation without leaving the text. The preview is
 * drawn from the citation row itself; nothing is fetched for it.
 */
export const CitedDecisionLink = ({
  children,
  className,
  decision,
}: CitedDecisionLinkProps) => {
  const format = useFormatter();
  const params = createCaseLawDecisionRouteParams({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
    slug: decision.slug,
  });
  const decided = formatDecisionDate(decision.decisionDate, format);

  return (
    <PreviewCard>
      <PreviewCardTrigger
        render={
          <Link
            className={cn(
              "text-primary decoration-primary/40 underline underline-offset-2 hover:decoration-current",
              className,
            )}
            params={{
              country: params.country,
              court: params.court,
              slug: params.slug,
            }}
            to="/law/$country/cases/$court/$slug"
          />
        }
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardPopup className="w-auto max-w-72 flex-col gap-0.5 p-3 font-sans">
        <BidiText as="span" className="text-foreground text-sm font-medium">
          {decision.caseNumber}
        </BidiText>
        <span className="text-muted-foreground text-xs">
          {decided === null ? decision.court : `${decision.court} · ${decided}`}
        </span>
      </PreviewCardPopup>
    </PreviewCard>
  );
};
