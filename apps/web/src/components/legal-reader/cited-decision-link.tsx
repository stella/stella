import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { HeadnoteOriginLabel } from "@stll/decision-reader/headnote-block";
import type { CitedDecisionTarget as ReaderCitedDecisionTarget } from "@stll/decision-reader/reader-types";
import { BidiText } from "@stll/ui/bidi-text";
import { Skeleton } from "@stll/ui/skeleton";
import { useIsMobile } from "@stll/ui/use-mobile";
import { cn } from "@stll/ui/utils";

import {
  createCaseDecisionViewTab,
  navigateToCaseDecisionMain,
} from "@/components/inspector/case-decision-view";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { DecisionCitationChip } from "@/components/references/decision-citation-chip";
import { decisionCitationCourtLabel } from "@/components/references/decision-citation-chip.logic";
import type { DecisionCitationPresentation } from "@/components/references/decision-citation-presentation.logic";
import {
  CITATION_TREATMENT_DOT,
  CITATION_TREATMENT_LABEL,
} from "@/features/case-law/citation-treatment";
import type { CitationTreatment } from "@/features/case-law/citation-treatment";
import { decisionOptions } from "@/features/case-law/queries/decisions";
import { useFormatter } from "@/i18n/formatting-context";
import { formatDecisionDate } from "@/lib/decision-date";
import { detached } from "@/lib/detached";
import { useQueryView } from "@/lib/use-query-view";

type CitedDecisionTarget = Pick<
  ReaderCitedDecisionTarget,
  | "caseNumber"
  | "country"
  | "court"
  | "courtAbbreviation"
  | "sourceUrl"
  | "decisionDate"
  | "id"
  | "language"
  | "languageAlternates"
  | "slug"
>;

type CitedDecisionLinkProps = {
  decision: CitedDecisionTarget;
  /** Retained for navigation to the words selected in a generated answer. */
  passage?: { type: "text"; text: string } | { type: "citation" } | undefined;
  treatment?: CitationTreatment | undefined;
  presentation?: DecisionCitationPresentation | undefined;
  children: ReactNode;
  className?: string | undefined;
};

/**
 * The source wording stays in the document; its court chip opens the shared
 * preview and keeps the inspector navigation action beside the source text.
 */
export const CitedDecisionLink = ({
  children,
  className,
  decision,
  passage,
  treatment,
  presentation,
}: CitedDecisionLinkProps) => {
  const isMobile = useIsMobile();
  const inspector = useInspectorView();
  const navigate = useNavigate();
  const params = createCaseLawDecisionRouteParams({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  });

  const searchQuery = passage?.type === "text" ? passage.text : undefined;
  const readerPath = createCaseLawDecisionPath(params);
  const readerUrl =
    searchQuery === undefined
      ? readerPath
      : `${readerPath}?${new URLSearchParams({ q: searchQuery })}`;

  const openDecision = () => {
    const tab = createCaseDecisionViewTab({
      caseNumber: decision.caseNumber,
      country: decision.country,
      court: decision.court,
      decisionId: decision.id,
      language: decision.language,
      languageAlternates: decision.languageAlternates,
      slug: decision.slug,
      searchQuery,
    });
    if (isMobile) {
      // No inspector to dock beside: the decision takes the main view.
      detached(
        navigateToCaseDecisionMain(navigate, tab.payload),
        "case-law.open-cited-decision",
      );
      return;
    }
    inspector.open(tab);
  };

  return (
    <>
      <span className={className}>{children}</span>{" "}
      <DecisionCitationChip
        decision={{
          decisionId: decision.id,
          court: decision.court,
          courtShortCode: decisionCitationCourtLabel(decision),
          caseNumber: decision.caseNumber,
          decisionDate: decision.decisionDate,
          readerUrl,
          originalUrl: decision.sourceUrl ?? null,
        }}
        onOpen={openDecision}
        preview={
          <CitedDecisionCard decisionId={decision.id} treatment={treatment} />
        }
        presentation={presentation}
      />
    </>
  );
};

export const CitedDecisionCard = ({
  decisionId,
  treatment,
}: {
  decisionId: string;
  treatment: CitationTreatment | undefined;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const read = useQuery(decisionOptions(decisionId));
  const view = useQueryView(read);

  if (view.type === "pending") {
    return (
      <div aria-busy="true" className="flex flex-col gap-2 py-1">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (view.type !== "items") {
    return <QueryViewFeedback view={view} />;
  }

  const decision = view.items;
  const date = formatDecisionDate(decision.decisionDate, format);
  const headnote =
    decision.headnote.type === "present" ? decision.headnote.text : null;
  const publication = decision.identifiers.find(
    ({ type }) => type === "reporter-citation",
  )?.value;

  return (
    <div className="flex flex-col gap-3">
      <QueryViewFeedback view={view} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <BidiText as="div" className="text-sm font-medium">
            {decision.court}
          </BidiText>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
            <BidiText as="span">{decision.caseNumber}</BidiText>
            {date !== null && <span>{date}</span>}
            {decision.decisionType !== null && (
              <span className="capitalize">{decision.decisionType}</span>
            )}
          </div>
        </div>
        {treatment !== undefined && (
          <span className="bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                CITATION_TREATMENT_DOT[treatment],
              )}
            />
            {t(CITATION_TREATMENT_LABEL[treatment])}
          </span>
        )}
      </div>
      {headnote !== null && (
        <div className="space-y-1">
          <div className="text-foreground-disabled flex items-center justify-between text-xs font-semibold tracking-wide uppercase">
            <span>{t("caseLaw.viewer.legalSentence")}</span>
            <HeadnoteOriginLabel
              origin={{
                type: "court",
                chip:
                  decision.courtAbbreviation === null
                    ? null
                    : {
                        abbreviation: decision.courtAbbreviation,
                        tier: decision.courtTier,
                      },
              }}
            />
          </div>
          <BidiText as="p" className="line-clamp-6 text-sm leading-relaxed">
            {headnote}
          </BidiText>
        </div>
      )}
      <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
        <span>
          {t("caseLaw.citation.citedByCount", {
            count: decision.citationCount,
          })}
        </span>
        {publication !== undefined && (
          <BidiText as="span">{publication}</BidiText>
        )}
      </div>
    </div>
  );
};
