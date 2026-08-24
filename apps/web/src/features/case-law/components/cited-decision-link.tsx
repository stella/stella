import type { MouseEvent, ReactNode } from "react";

import { Link } from "@tanstack/react-router";

import { BidiText } from "@stll/ui/bidi-text";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { cn } from "@stll/ui/utils";

import { useInspectorView } from "@/components/inspector/use-inspector-view";
import {
  createCaseDecisionViewTab,
  opensCitationInInspector,
} from "@/features/case-law/case-decision-inspector.logic";
import { citedDecisionLabel } from "@/features/case-law/cited-decision-label";
import { formatDecisionDate } from "@/features/case-law/decision-date";
import { useFormatter } from "@/i18n/formatting-context";
import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";

type CitedDecisionLinkProps = {
  children: ReactNode;
  className?: string | undefined;
  decision: {
    caseNumber: string;
    country: string;
    court: string;
    decisionDate: string | null;
    decisionType?: string | null | undefined;
    id: string;
    language?: string | null | undefined;
    languageAlternateCount?: number | null | undefined;
    languageAlternates?: readonly unknown[] | null | undefined;
    slug?: string | null | undefined;
  };
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
  const inspector = useInspectorView();
  const params = createCaseLawDecisionRouteParams({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
    language: decision.language,
    languageAlternateCount: decision.languageAlternateCount,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  });
  const decided = formatDecisionDate(decision.decisionDate, format);
  const onCitationClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!opensCitationInInspector(event)) {
      return;
    }

    event.preventDefault();
    inspector.open(
      createCaseDecisionViewTab({
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionId: decision.id,
        language: decision.language,
        languageAlternateCount: decision.languageAlternateCount,
        languageAlternates: decision.languageAlternates,
        slug: decision.slug,
      }),
    );
  };
  const linkClassName = cn(
    "text-primary decoration-primary/40 underline underline-offset-2 hover:decoration-current",
    className,
  );
  const link =
    params.language === undefined ? (
      <Link
        className={linkClassName}
        onClick={onCitationClick}
        params={{
          country: params.country,
          court: params.court,
          slug: params.slug,
        }}
        to="/law/$country/cases/$court/$slug"
      />
    ) : (
      <Link
        className={linkClassName}
        onClick={onCitationClick}
        params={{
          country: params.country,
          court: params.court,
          language: params.language,
          slug: params.slug,
        }}
        to="/law/$country/cases/$court/$language/$slug"
      />
    );

  return (
    <PreviewCard>
      <PreviewCardTrigger render={link}>{children}</PreviewCardTrigger>
      <PreviewCardPopup className="w-auto max-w-72 flex-col gap-0.5 p-3 font-sans">
        <BidiText as="span" className="text-foreground text-sm font-medium">
          {citedDecisionLabel(decision)}
        </BidiText>
        <span className="text-muted-foreground text-xs">
          {decided === null ? decision.court : `${decision.court} · ${decided}`}
        </span>
      </PreviewCardPopup>
    </PreviewCard>
  );
};
