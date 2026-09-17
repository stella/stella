import { panic } from "better-result";
import { XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";

import { CITATION_RELATION_DISPLAY } from "@/components/docx/citation-check/citation-check.logic";
import type { CitationCheckState } from "@/components/docx/citation-check/use-citation-check";
import { CitedDecisionLink } from "@/components/legal-reader/cited-decision-link";

type CitationCheckCardProps = {
  state: CitationCheckState;
  onDismiss: () => void;
  /** Scroll the editor back to the paragraph the answer is about. */
  onRevealParagraph: (blockId: string) => void;
};

/**
 * What the check answered, beside the document rather than inside it.
 *
 * The finding is an opinion about the writer's sentence, not an edit to it,
 * so it never touches the text: the writer reads it, opens the decision or
 * the passage it rests on, and dismisses it. Docked to the inline start so it
 * clears the review stepper, which owns the bottom centre.
 */
export const CitationCheckCard = ({
  onDismiss,
  onRevealParagraph,
  state,
}: CitationCheckCardProps) => {
  const t = useTranslations();
  if (state.status === "idle") {
    return null;
  }
  const { blockId } = state;

  return (
    <aside
      aria-label={t("docxCitationCheck.title")}
      className="bg-popover text-popover-foreground border-border absolute start-6 bottom-24 z-20 flex w-[min(26rem,calc(100vw-3rem))] flex-col gap-2 rounded-lg border p-3 shadow-lg"
    >
      <header className="flex items-start justify-between gap-2">
        <span className="text-muted-foreground text-xs font-medium">
          {t("docxCitationCheck.title")}
        </span>
        <div className="flex items-center gap-1">
          {/* The writer keeps typing while the check runs, so the answer has
              to be able to point back at the paragraph it is about. */}
          {blockId !== null && (
            <Button
              onClick={() => onRevealParagraph(blockId)}
              size="xs"
              variant="ghost"
            >
              {t("docxCitationCheck.goToParagraph")}
            </Button>
          )}
          <Button
            aria-label={t("common.close")}
            onClick={onDismiss}
            size="icon-xs"
            variant="ghost"
          >
            <XIcon size={14} />
          </Button>
        </div>
      </header>
      <CitationCheckBody state={state} />
    </aside>
  );
};

const CitationCheckBody = ({ state }: { state: CitationCheckState }) => {
  const t = useTranslations();
  switch (state.status) {
    case "idle":
      return null;
    case "checking":
      return <Checking citation={state.citation} />;
    case "failed":
      return (
        <p className="text-destructive text-sm">
          {t("docxCitationCheck.failed")}
        </p>
      );
    case "not_found":
      return (
        <BidiText as="p" className="text-destructive text-sm">
          {t("docxCitationCheck.notFound", { citation: state.citation })}
        </BidiText>
      );
    case "unavailable":
      return (
        <p className="text-muted-foreground text-sm">
          {state.reason === "no_text"
            ? t("docxCitationCheck.unavailableNoText")
            : t("docxCitationCheck.unavailableDerivedAi")}
        </p>
      );
    case "checked":
      return <CheckedReading state={state} />;
    default:
      state satisfies never;
      return panic("Unhandled citation-check state");
  }
};

const Checking = ({ citation }: { citation: string }) => {
  const t = useTranslations();
  const label = t("docxCitationCheck.checking", { citation });

  return (
    <p className="text-muted-foreground flex items-center gap-2 text-sm">
      <Loader label={label} size="sm" />
      <BidiText as="span">{label}</BidiText>
    </p>
  );
};

const CheckedReading = ({
  state,
}: {
  state: Extract<CitationCheckState, { status: "checked" }>;
}) => {
  const t = useTranslations();
  const display = CITATION_RELATION_DISPLAY[state.relation];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <ReviewStatusBadge size="sm" tone={display.tone} variant="solid">
          {t(display.label)}
        </ReviewStatusBadge>
        <span className="text-muted-foreground text-xs">
          {/* A percent placeholder, not a pre-multiplied number: the locale
              decides the sign's position and whether a space precedes it. */}
          {t("docxCitationCheck.probability", {
            probability: state.probability,
          })}
        </span>
      </div>
      <CitedDecisionLink decision={state.decision}>
        <BidiText as="span">{state.decision.caseNumber}</BidiText>
      </CitedDecisionLink>
      {state.passage === null ? (
        <p className="text-muted-foreground text-xs">
          {t("docxCitationCheck.noPassage")}
        </p>
      ) : (
        <Popover>
          <PopoverTrigger
            render={<Button className="w-fit" size="sm" variant="outline" />}
          >
            {t("docxCitationCheck.showPassage")}
          </PopoverTrigger>
          <PopoverPanel
            align="start"
            className="w-[min(28rem,calc(100vw-2rem))] max-w-none"
            side="top"
          >
            <BidiText as="p" className="text-foreground text-sm">
              {state.passage.text}
            </BidiText>
          </PopoverPanel>
        </Popover>
      )}
      {state.alternatives.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("docxCitationCheck.alternatives", {
            count: state.alternatives.length,
          })}
        </p>
      )}
    </>
  );
};
