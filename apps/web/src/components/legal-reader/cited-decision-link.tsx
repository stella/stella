import type { ReactNode } from "react";

import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
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
import type { CitationAnchorSource } from "@/features/case-law/citation-anchors";
import {
  CITATION_TREATMENT_DOT,
  CITATION_TREATMENT_LABEL,
} from "@/features/case-law/citation-treatment";
import type {
  CitedDecisionAddress,
  CitationTreatment,
} from "@/features/case-law/citation-treatment";
import {
  CitationPassageQuote,
  useCitationPassage,
} from "@/features/case-law/components/case-viewer/citation-passage-preview";
import { detached } from "@/lib/detached";

type CitedDecisionTarget = Pick<
  CitedDecisionAddress,
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

type CitedDecisionLinkProps = CitedDecisionPreviewProps & {
  decision: CitedDecisionTarget;
  presentation?: DecisionCitationPresentation | undefined;
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

  const openDecision = () => {
    const tab = createCaseDecisionViewTab({
      caseNumber: decision.caseNumber,
      country: decision.country,
      court: decision.court,
      decisionId: decision.id,
      language: decision.language,
      languageAlternates: decision.languageAlternates,
      slug: decision.slug,
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
          readerUrl: createCaseLawDecisionPath(params),
          originalUrl: decision.sourceUrl,
        }}
        onOpen={openDecision}
        passage={
          passage !== undefined || treatment !== undefined ? (
            <CitedDecisionPreview passage={passage} treatment={treatment} />
          ) : undefined
        }
        presentation={presentation}
      />
    </>
  );
};
