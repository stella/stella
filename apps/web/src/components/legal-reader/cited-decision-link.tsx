import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { CourtTierBadge } from "@stll/decision-reader/court-tier-badge";
import type {
  CitationAnchorSource,
  CitedDecisionTarget as ReaderCitedDecisionTarget,
} from "@stll/decision-reader/reader-types";
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
import {
  CitationPassageQuote,
  useCitationPassage,
} from "@/features/case-law/components/case-viewer/citation-passage-preview";
import { decisionCardSummaryOptions } from "@/features/case-law/queries/decisions";
import { useFormatter } from "@/i18n/formatting-context";
import { formatDecisionDate } from "@/lib/decision-date";
import { detached } from "@/lib/detached";
import { useQueryView } from "@/lib/use-query-view";

/** Where the citing text names the decision, when a passage can be quoted. */
type CitedDecisionPassage =
  | {
      type: "citation";
      citation: CitationAnchorSource;
      /** The decision whose text holds the citation. */
      textDecisionId: string;
    }
  | { type: "text"; text: string };

type CitedDecisionPreviewProps = {
  passage?: CitedDecisionPassage | undefined;
  /** How the citing text treats the cited decision. */
  treatment?: CitationTreatment | undefined;
};

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

type CitedDecisionChipProps = CitedDecisionPreviewProps & {
  decision: CitedDecisionTarget;
  presentation?: DecisionCitationPresentation | undefined;
  /**
   * Text that already names the decision, drawn as the trigger itself in
   * place of a court badge that would repeat it.
   */
  label?: ReactNode;
  /** The citing text's own words, opened together with the court badge. */
  citingText?: ReactNode;
};

type CitedDecisionLinkProps = Omit<
  CitedDecisionChipProps,
  "label" | "citingText"
> & {
  children: ReactNode;
  className?: string | undefined;
};

/**
 * What the citing text says about a cited decision: the passage, how it
 * treats the decision. Metadata and navigation belong to the shared chip.
 * Reading a citation and following it are separate gestures, so weighing one
 * never costs the reader the text they are in.
 */
export const CitedDecisionPreview = ({
  passage,
  treatment,
}: CitedDecisionPreviewProps) => {
  const t = useTranslations();
  let quoted: ReactNode;
  if (passage !== undefined) {
    switch (passage.type) {
      case "citation":
        quoted = <CitingPassage passage={passage} />;
        break;
      case "text":
        quoted = <span dir="auto">{passage.text}</span>;
        break;
      default:
        passage satisfies never;
        return panic("Unhandled cited decision passage");
    }
  }

  return (
    <>
      {treatment !== undefined && (
        <span className="text-muted-foreground flex items-center gap-1.5 text-[calc(0.7rem*var(--reader-text-scale))]">
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
      {quoted}
    </>
  );
};

/**
 * Its own component so the read that finds the passage starts when the
 * preview opens, not when the citation is rendered: a decision's text names
 * dozens of others, and none of those reads is worth paying up front.
 */
const CitingPassage = ({
  passage,
}: {
  passage: Extract<CitedDecisionPassage, { type: "citation" }>;
}) => {
  const read = useCitationPassage(passage);

  return <CitationPassageQuote read={read} />;
};

/**
 * The source wording stays in the document and, together with its court
 * chip, opens the shared preview: the reader points at the reference they
 * are reading, not at a badge beside it.
 */
export const CitedDecisionLink = ({
  children,
  className,
  ...chip
}: CitedDecisionLinkProps) => (
  <CitedDecisionChip
    {...chip}
    citingText={<span className={className}>{children}</span>}
    label={undefined}
  />
);

/**
 * The shared decision chip, wired to open the decision beside the text on a
 * wide screen and in the main view on a narrow one.
 */
export const CitedDecisionChip = ({
  decision,
  label,
  citingText,
  passage,
  treatment,
  presentation,
}: CitedDecisionChipProps) => {
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
      label={label}
      citingText={citingText}
      onOpen={openDecision}
      preview={<CitedDecisionCard decision={decision} treatment={treatment} />}
      passage={
        passage !== undefined ? (
          <CitedDecisionPreview passage={passage} />
        ) : undefined
      }
      presentation={presentation}
    />
  );
};

export const CitedDecisionCard = ({
  decision: knownDecision,
  treatment,
}: {
  decision: Pick<CitedDecisionTarget, "id" | "court" | "caseNumber">;
  treatment: CitationTreatment | undefined;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const read = useQuery(decisionCardSummaryOptions(knownDecision.id));
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
    return (
      <div className="flex flex-col gap-2">
        <BidiText as="div" className="text-sm font-medium">
          {knownDecision.court}
        </BidiText>
        <BidiText as="div" className="text-sm">
          {knownDecision.caseNumber}
        </BidiText>
        <QueryViewFeedback view={view} />
      </div>
    );
  }

  const decision = view.items;
  const date = formatDecisionDate(decision.decisionDate, format);
  const headnote =
    decision.headnote.type === "present" ? decision.headnote.text : null;

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
            {decision.courtAbbreviation === null ? (
              <span className="align-middle">{t("common.court")}</span>
            ) : (
              <CourtTierBadge
                abbreviation={decision.courtAbbreviation}
                className="align-middle"
                tier={decision.courtTier}
              />
            )}
          </div>
          <BidiText as="p" className="line-clamp-6 text-sm leading-relaxed">
            {headnote}
          </BidiText>
        </div>
      )}
      <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
        <span>
          {t("caseLaw.citation.citedSummary", {
            count: decision.citationCount,
          })}
        </span>
        {decision.publication !== null && (
          <BidiText as="span">{decision.publication}</BidiText>
        )}
      </div>
    </div>
  );
};
