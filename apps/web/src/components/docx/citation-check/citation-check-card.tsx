import { panic } from "better-result";
import { XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import { cn } from "@stll/ui/utils";

import { CITATION_RELATION_DISPLAY } from "@/components/docx/citation-check/citation-check.logic";
import type {
  CitationCheckResult,
  CitationCheckState,
} from "@/components/docx/citation-check/use-citation-check";
import { CitedDecisionLink } from "@/components/legal-reader/cited-decision-link";

type CitationCheckCardProps = {
  state: CitationCheckState;
  onDismiss: () => void;
  /** Scroll the editor back to the paragraph the answer is about. */
  onRevealParagraph: (blockId: string) => void;
};

/**
 * What the checks answered, beside the document rather than inside it.
 *
 * A finding is an opinion about the writer's sentence, not an edit to it, so
 * it never touches the text: the writer reads it, opens the decision or the
 * passage it rests on, and dismisses it. The newest answer is shown in full
 * and the ones before it stay as a short stack, because the checks run as the
 * writer moves through the document and an answer scrolled past is still the
 * only record that the citation was read. Docked to the inline start so it
 * clears the review stepper, which owns the bottom centre.
 */
export const CitationCheckCard = ({
  onDismiss,
  onRevealParagraph,
  state,
}: CitationCheckCardProps) => {
  const t = useTranslations();
  const [latest, ...earlier] = state.results;
  if (latest === undefined && state.pending === null) {
    return null;
  }
  const latestBlockId = latest?.blockId ?? null;

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
          {latestBlockId !== null && (
            <Button
              onClick={() => onRevealParagraph(latestBlockId)}
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
      {state.pending !== null && <Checking citation={state.pending.citation} />}
      {latest !== undefined && <CitationCheckBody result={latest} />}
      {earlier.length > 0 && (
        <div className="border-border flex flex-col gap-1.5 border-t pt-2">
          <span className="text-muted-foreground text-2xs font-medium">
            {t("docxCitationCheck.earlier")}
          </span>
          {earlier.map((result) => (
            <EarlierResult key={result.key} result={result} />
          ))}
        </div>
      )}
    </aside>
  );
};

const CitationCheckBody = ({ result }: { result: CitationCheckResult }) => {
  const t = useTranslations();
  switch (result.status) {
    case "failed":
      return (
        <p className="text-destructive text-sm">
          {t("docxCitationCheck.failed")}
        </p>
      );
    case "not_found":
      return <NotFound citation={result.citation} />;
    case "unavailable":
      return (
        <p className="text-muted-foreground text-sm">
          {result.reason === "no_text"
            ? t("docxCitationCheck.unavailableNoText")
            : t("docxCitationCheck.unavailableDerivedAi")}
        </p>
      );
    case "checked":
      return <CheckedReading result={result} />;
    default:
      result satisfies never;
      return panic("Unhandled citation-check result");
  }
};

/** One answer from earlier in the session: how it read, and what it read. */
const EarlierResult = ({ result }: { result: CitationCheckResult }) => {
  const t = useTranslations();
  switch (result.status) {
    case "not_found":
      return <NotFound citation={result.citation} className="text-xs" />;
    case "failed":
    case "unavailable":
      // Nothing was decided about this reference, so the row says only that
      // it was read: the reasons are long and belong to the answer in full.
      return (
        <BidiText as="p" className="text-muted-foreground text-xs">
          {result.citation}
        </BidiText>
      );
    case "checked": {
      const display = CITATION_RELATION_DISPLAY[result.relation];

      return (
        <div className="flex flex-wrap items-center gap-2">
          <ReviewStatusBadge tone={display.tone} variant="solid">
            {t(display.label)}
          </ReviewStatusBadge>
          <CitedDecisionLink decision={result.decision}>
            <BidiText as="span" className="text-xs">
              {result.decision.caseNumber}
            </BidiText>
          </CitedDecisionLink>
        </div>
      );
    }
    default:
      result satisfies never;
      return panic("Unhandled citation-check result");
  }
};

const NotFound = ({
  citation,
  className = "text-sm",
}: {
  citation: string;
  className?: string;
}) => {
  const t = useTranslations();

  return (
    <BidiText as="p" className={cn("text-destructive", className)}>
      {t("docxCitationCheck.notFound", { citation })}
    </BidiText>
  );
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
  result,
}: {
  result: Extract<CitationCheckResult, { status: "checked" }>;
}) => {
  const t = useTranslations();
  const display = CITATION_RELATION_DISPLAY[result.relation];

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
            probability: result.probability,
          })}
        </span>
      </div>
      <CitedDecisionLink decision={result.decision}>
        <BidiText as="span">{result.decision.caseNumber}</BidiText>
      </CitedDecisionLink>
      {result.passage === null ? (
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
              {result.passage.text}
            </BidiText>
          </PopoverPanel>
        </Popover>
      )}
      {result.alternatives.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("docxCitationCheck.alternatives", {
            count: result.alternatives.length,
          })}
        </p>
      )}
    </>
  );
};
