import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
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
import { Button } from "@stll/ui/button";
import { PopoverClose } from "@stll/ui/popover";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { createCaseDecisionViewTab } from "@/components/inspector/case-decision-view";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import type { CitationOccurrences } from "@/components/legal-reader/citation-occurrences.logic";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { CitationChip } from "@/components/references/citation-chip";
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
import { isPublicLawMissError } from "@/lib/public-law-api";
import { queryView } from "@/lib/query-view.logic";

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

/** The decision's other mentions in the text the reader is in. */
type CitationOccurrenceNavigation = {
  occurrences: CitationOccurrences;
  /** The paragraph holding the mention whose card is open. */
  currentBlockId: string;
  onJump: (anchorId: string) => void;
};

type CitedDecisionChipProps = CitedDecisionPreviewProps & {
  decision: CitedDecisionTarget;
  presentation?: DecisionCitationPresentation | undefined;
  occurrences?: CitationOccurrenceNavigation | undefined;
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

/** The shared decision chip, wired to open the decision beside the text. */
export const CitedDecisionChip = ({
  decision,
  label,
  citingText,
  passage,
  treatment,
  presentation,
  occurrences,
}: CitedDecisionChipProps) => {
  const inspector = useInspectorView();
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

  const openInSidePanel = () => {
    inspector.open(
      createCaseDecisionViewTab({
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionId: decision.id,
        language: decision.language,
        languageAlternates: decision.languageAlternates,
        slug: decision.slug,
        searchQuery,
      }),
    );
  };

  return (
    <CitationChip
      kind="decision"
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
      onOpenInSidePanel={openInSidePanel}
      preview={
        <>
          <CitedDecisionCard decision={decision} treatment={treatment} />
          {occurrences !== undefined &&
            occurrences.occurrences.mentions > 1 && (
              <CitationOccurrenceLinks {...occurrences} />
            )}
        </>
      }
      passage={
        passage !== undefined ? (
          <CitedDecisionPreview passage={passage} />
        ) : undefined
      }
      presentation={presentation}
    />
  );
};

/**
 * What the summary read adds to a cited decision's peek: its type, how the
 * citing text treats it, its legal sentence and how often it is cited.
 */
export const CitedDecisionCard = ({
  decision: knownDecision,
  treatment,
}: {
  decision: Pick<CitedDecisionTarget, "id">;
  treatment: CitationTreatment | undefined;
}) => {
  const t = useTranslations();
  const read = useQuery(decisionCardSummaryOptions(knownDecision.id));
  const view = queryView(read);

  if (view.type === "pending") {
    return (
      <div aria-busy="true" className="flex flex-col gap-2 py-1">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  // The peek's header already names the court, the case and the date.
  if (view.type !== "items") {
    // A miss is an answer, not a failure: the public corpus holds no such
    // decision, so the card says so under the header's own facts.
    return view.type === "error" && isPublicLawMissError(view.error) ? (
      <span className="text-muted-foreground text-xs">
        {t("caseLaw.citation.notInStella")}
      </span>
    ) : (
      <QueryViewFeedback view={view} />
    );
  }

  const decision = view.items;
  const headnote =
    decision.headnote.type === "present" ? decision.headnote.text : null;

  return (
    <div className="flex flex-col gap-3">
      <QueryViewFeedback view={view} />
      <div className="flex items-center justify-between gap-3">
        {decision.decisionType !== null && (
          <span className="text-muted-foreground text-xs capitalize">
            {decision.decisionType}
          </span>
        )}
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

/**
 * Where else the text names the decision, by paragraph. The reader is already
 * in one of them, so the card repeats none of their words and only offers the
 * way to the others.
 */
const CitationOccurrenceLinks = ({
  occurrences: { mentions, paragraphs },
  currentBlockId,
  onJump,
}: CitationOccurrenceNavigation) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1 border-t pt-2 text-xs">
      <span className="me-1">
        {t("caseLaw.citation.mentionsInDecision", { count: mentions })}
      </span>
      {paragraphs.map((paragraph) => {
        const mark =
          paragraph.paragraphNumber === null
            ? t("caseLaw.citation.mentionMark", {
                number: format.number(paragraph.firstMention),
              })
            : t("caseLaw.citation.paragraphMark", {
                paragraph: format.number(paragraph.paragraphNumber),
              });
        if (paragraph.blockId === currentBlockId) {
          return (
            <span
              aria-current="location"
              className="text-foreground px-2 font-medium whitespace-nowrap"
              key={paragraph.blockId}
            >
              {mark}
            </span>
          );
        }
        return (
          <PopoverClose
            aria-label={
              paragraph.paragraphNumber === null
                ? t("caseLaw.citation.goToMention", {
                    number: format.number(paragraph.firstMention),
                  })
                : t("caseLaw.citation.goToParagraph", {
                    paragraph: format.number(paragraph.paragraphNumber),
                  })
            }
            key={paragraph.blockId}
            onClick={() => {
              onJump(paragraph.anchorId);
            }}
            render={<Button size="xs" variant="muted" />}
          >
            {mark}
          </PopoverClose>
        );
      })}
    </div>
  );
};
