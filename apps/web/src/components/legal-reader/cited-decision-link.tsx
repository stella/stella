import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { createCaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { useIsMobile } from "@stll/ui/use-mobile";
import { cn } from "@stll/ui/utils";

import {
  createCaseDecisionViewTab,
  navigateToCaseDecisionMain,
} from "@/components/inspector/case-decision-view";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { LEGAL_CITATION_LINK_CLASS_NAME } from "@/components/legal-reader/citation-link";
import {
  citedDecisionClick,
  CITED_DECISION_CLICK,
} from "@/components/legal-reader/cited-decision-link.logic";
import type { CitationAnchorSource } from "@/features/case-law/citation-anchors";
import {
  CITATION_TREATMENT_DOT,
  CITATION_TREATMENT_LABEL,
} from "@/features/case-law/citation-treatment";
import type { CitationTreatment } from "@/features/case-law/citation-treatment";
import {
  CitationPassageQuote,
  useCitationPassage,
} from "@/features/case-law/components/case-viewer/citation-passage-preview";
import { useFormatter } from "@/i18n/formatting-context";
import { citedDecisionLabel } from "@/lib/cited-decision-label";
import { formatDecisionDate } from "@/lib/decision-date";
import { detached } from "@/lib/detached";

type CitedDecisionTarget = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: string | null;
  decisionType?: string | null | undefined;
  id: string;
  language?: string | null | undefined;
  languageAlternates?: readonly unknown[] | null | undefined;
  slug?: string | null | undefined;
};

/** Where the citing text names the decision, when a passage can be quoted. */
type CitedDecisionPassage = {
  citation: CitationAnchorSource;
  /** The decision whose text holds the citation. */
  textDecisionId: string;
};

type CitedDecisionPreviewProps = {
  decision: CitedDecisionTarget;
  onOpen: () => void;
  passage?: CitedDecisionPassage | undefined;
  /** How the citing text treats the cited decision. */
  treatment?: CitationTreatment | undefined;
};

type CitedDecisionLinkProps = Omit<CitedDecisionPreviewProps, "onOpen"> & {
  children: ReactNode;
  className?: string | undefined;
};

/**
 * Base UI adds `preventBaseUIHandler` to the rightmost handler of a merged
 * chain; calling it drops the handlers merged to its left, which is how the
 * popover trigger's own click is suppressed for a navigation gesture.
 */
type TriggerClick = MouseEvent<HTMLAnchorElement> & {
  preventBaseUIHandler?: (() => void) | undefined;
};

/**
 * What the citing text says about a cited decision: the passage, how it
 * treats the decision, its court and its date, and the one action that opens
 * it. Reading a citation and following it are separate gestures, so weighing
 * one never costs the reader the text they are in.
 */
export const CitedDecisionPreview = ({
  decision,
  onOpen,
  passage,
  treatment,
}: CitedDecisionPreviewProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const decided = formatDecisionDate(decision.decisionDate, format);

  return (
    <>
      <span className="flex flex-col gap-0.5">
        <BidiText as="span" className="text-foreground text-sm font-medium">
          {citedDecisionLabel(decision)}
        </BidiText>
        <span className="text-muted-foreground text-xs">
          {decided === null ? decision.court : `${decision.court} · ${decided}`}
        </span>
      </span>
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
      {passage !== undefined && <CitingPassage passage={passage} />}
      <Button
        className="h-6 w-fit px-2"
        onClick={onOpen}
        size="sm"
        variant="outline"
      >
        {t("caseLaw.citation.openDecision")}
      </Button>
    </>
  );
};

/**
 * Its own component so the read that finds the passage starts when the
 * preview opens, not when the citation is rendered: a decision's text names
 * dozens of others, and none of those reads is worth paying up front.
 */
const CitingPassage = ({ passage }: { passage: CitedDecisionPassage }) => {
  const read = useCitationPassage(passage);

  return <CitationPassageQuote read={read} />;
};

/**
 * A link to another decision that shows the preview above before it takes the
 * reader anywhere. Keyboard reaches both steps: Enter on the citation opens
 * the preview, whose only tabbable element is the action Base UI focuses, so
 * Enter again opens the decision.
 */
export const CitedDecisionLink = ({
  children,
  className,
  decision,
  passage,
  treatment,
}: CitedDecisionLinkProps) => {
  const isMobile = useIsMobile();
  const inspector = useInspectorView();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const params = createCaseLawDecisionRouteParams({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  });

  const onTriggerClick = (event: TriggerClick) => {
    if (citedDecisionClick(event) === CITED_DECISION_CLICK.navigate) {
      event.preventBaseUIHandler?.();
      return;
    }

    // The trigger's own handler opens the preview; this only stops the
    // navigation the anchor would otherwise do underneath it.
    event.preventDefault();
  };

  const openDecision = () => {
    setOpen(false);
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

  const linkClassName = cn(LEGAL_CITATION_LINK_CLASS_NAME, className);
  const link =
    params.language === undefined ? (
      <Link
        className={linkClassName}
        onClick={onTriggerClick}
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
        onClick={onTriggerClick}
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
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger render={link}>{children}</PopoverTrigger>
      {/* Panel, not Popup: Base UI renders popup children inside its own
          viewport, so a content stack has to be laid out below that. */}
      <PopoverPanel
        align="start"
        className="reader-chrome w-[min(28rem,calc(100vw-2rem))] max-w-none"
        contentClassName="gap-2"
        side="bottom"
      >
        <CitedDecisionPreview
          decision={decision}
          onOpen={openDecision}
          passage={passage}
          treatment={treatment}
        />
      </PopoverPanel>
    </Popover>
  );
};
