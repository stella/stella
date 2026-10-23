import type { ReactNode } from "react";

import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import type {
  CitationAnchorSource,
  CitedDecisionTarget as ReaderCitedDecisionTarget,
} from "@stll/decision-reader/reader-types";
import { useIsMobile } from "@stll/ui/use-mobile";
import { cn } from "@stll/ui/utils";

import {
  createCaseDecisionViewTab,
  navigateToCaseDecisionMain,
} from "@/components/inspector/case-decision-view";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
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
import { detached } from "@/lib/detached";

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
};

type CitedDecisionLinkProps = Omit<CitedDecisionChipProps, "label"> & {
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
 * The source wording stays in the document; its court chip opens the shared
 * preview and keeps the inspector navigation action beside the source text.
 */
export const CitedDecisionLink = ({
  children,
  className,
  ...chip
}: CitedDecisionLinkProps) => (
  <>
    <span className={className}>{children}</span>{" "}
    <CitedDecisionChip {...chip} label={undefined} />
  </>
);

/**
 * The shared decision chip, wired to open the decision beside the text on a
 * wide screen and in the main view on a narrow one.
 */
export const CitedDecisionChip = ({
  decision,
  label,
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
      onOpen={openDecision}
      passage={
        passage !== undefined || treatment !== undefined ? (
          <CitedDecisionPreview passage={passage} treatment={treatment} />
        ) : undefined
      }
      presentation={presentation}
    />
  );
};
