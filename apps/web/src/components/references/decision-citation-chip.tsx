import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import { ExternalLinkIcon, LandmarkIcon } from "@stll/ui/icons";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";
import { containedEventHandler } from "@stll/ui/use-contained-handler";
import { cn } from "@stll/ui/utils";

import { isPlainPrimaryClick } from "@/components/inspector/case-decision-view";
import type { DecisionCitationMetadata } from "@/components/references/decision-citation-chip.logic";
import { DECISION_CITATION_PRESENTATION } from "@/components/references/decision-citation-presentation.logic";
import type { DecisionCitationPresentation } from "@/components/references/decision-citation-presentation.logic";
import { env } from "@/env";
import { useFormatter } from "@/i18n/formatting-context";
import { formatDecisionDate } from "@/lib/decision-date";

type DecisionCitationChipShared = {
  decision: DecisionCitationMetadata;
  passage?: ReactNode;
  /** A complete, lazily mounted preview for surfaces with richer metadata. */
  preview?: ReactNode;
  onOpen?: (() => void) | undefined;
};

/**
 * A reference inside the text of a decision being read. The chip decorates
 * the court's own characters and draws nothing else into the text flow: no
 * badge, no case number, no paragraph mark, so the paragraph still reads,
 * selects and copies as the court wrote it, punctuation included. Who the
 * reference names is in the trigger's accessible name and its preview.
 *
 * Every drawing that adds words is unrepresentable here, not merely unused.
 */
type DecisionCitationOverSourceText = {
  /** The characters of the decision text the reference was found at. */
  sourceText: ReactNode;
  presentation?: never;
  paragraphNumber?: never;
  label?: never;
  citingText?: never;
};

/** A reference drawn on a surface of its own: an answer, a list, a card. */
type DecisionCitationBesideText = {
  sourceText?: never;
  presentation?: DecisionCitationPresentation | undefined;
  /** The court's own number on the cited block; null when it printed none. */
  paragraphNumber?: number | null | undefined;
  /**
   * Prose that already names the decision ("III. ÚS 2429/24"). It becomes
   * the trigger itself, quietly underlined, instead of being followed by a
   * badge that repeats the court the text just named.
   */
  label?: ReactNode;
  /**
   * Words for the decision on a surface that is not the decision's text,
   * drawn ahead of the badge inside the same trigger, so the whole reference
   * opens the preview and not only its badge.
   */
  citingText?: ReactNode;
};

/** How a decision chip draws itself: over source text, or beside text. */
export type DecisionCitationDrawing =
  DecisionCitationOverSourceText | DecisionCitationBesideText;

export type DecisionCitationChipProps = DecisionCitationChipShared &
  DecisionCitationDrawing;

const DecisionCitationLabel = ({
  decision,
  presentation,
  paragraphNumber,
}: {
  decision: DecisionCitationMetadata;
  presentation: DecisionCitationPresentation;
  /** The court's number, already in the reader's formatting locale. */
  paragraphNumber: string | null;
}) => {
  const t = useTranslations();
  const paragraph =
    paragraphNumber === null ? null : (
      <span className="whitespace-nowrap">
        {t("caseLaw.citation.paragraphMark", { paragraph: paragraphNumber })}
      </span>
    );
  const badge = (
    <DocumentIdentityBadge
      identity={{
        kind: "decision",
        courtAbbreviation: decision.courtShortCode,
      }}
    />
  );
  switch (presentation) {
    case DECISION_CITATION_PRESENTATION.compact:
      return paragraph === null ? (
        badge
      ) : (
        <span className="inline-flex items-center gap-1">
          {badge}
          {paragraph}
        </span>
      );
    case DECISION_CITATION_PRESENTATION.expanded:
      return (
        <span className="inline-flex items-center gap-1">
          <LandmarkIcon aria-hidden="true" className="size-3 shrink-0" />
          {badge}
          <BidiText as="span">{decision.caseNumber}</BidiText>
          {paragraph}
        </span>
      );
    case DECISION_CITATION_PRESENTATION.inline:
      return (
        <span className="inline-flex items-center gap-1">
          {badge}
          <BidiText as="span">{decision.caseNumber}</BidiText>
          {paragraph}
        </span>
      );
    default:
      presentation satisfies never;
      return panic(
        `Unhandled decision citation presentation: ${String(presentation)}`,
      );
  }
};

const UNDERLINED_TRIGGER_CLASS =
  "decoration-foreground-placeholder hover:decoration-foreground-muted data-[popup-open]:decoration-foreground-muted rounded-xs underline decoration-dotted underline-offset-2 transition-[text-decoration-color] duration-150";

/** How the trigger sits in its line, by what it draws. */
const triggerShapeClassName = ({
  sourceText,
  label,
  citingText,
}: Pick<DecisionCitationBesideText, "label" | "citingText"> & {
  sourceText: ReactNode;
}): string => {
  if (sourceText !== undefined || label !== undefined) {
    return UNDERLINED_TRIGGER_CLASS;
  }
  if (citingText !== undefined) {
    // Inline, so a long reference still wraps with the prose.
    return "rounded-sm";
  }
  return "inline-flex rounded align-baseline";
};

const DecisionCitationTriggerContent = ({
  citingText,
  decision,
  label,
  paragraph,
  presentation,
  sourceText,
}: Pick<DecisionCitationBesideText, "citingText" | "label"> &
  Pick<DecisionCitationChipShared, "decision"> & {
    /** The court's number, already in the reader's formatting locale. */
    paragraph: string | null;
    presentation: DecisionCitationPresentation;
    sourceText: ReactNode;
  }) => {
  const t = useTranslations();
  if (sourceText !== undefined) {
    return sourceText;
  }
  const badge = (
    <DecisionCitationLabel
      decision={decision}
      presentation={presentation}
      paragraphNumber={paragraph}
    />
  );
  if (label !== undefined) {
    return (
      <>
        {label}
        {paragraph !== null && (
          <span className="ms-1 whitespace-nowrap">
            {t("caseLaw.citation.paragraphMark", { paragraph })}
          </span>
        )}
      </>
    );
  }
  if (citingText === undefined) {
    return badge;
  }
  return (
    <>
      {citingText}
      {/* The badge is not the citing text's words: as reader chrome it stays
          off the offsets a selection is stored in, so a quote around a
          citation still matches the decision text. */}
      <span data-reader-chrome=""> {badge}</span>
    </>
  );
};

/**
 * The same decision annotation in answers, provenance cards and reader text.
 * Surfaces render it through `CitationChip`, which owns citation kinds. Over
 * a decision's own text it is drawn with `sourceText`, and the trigger is
 * then those characters exactly.
 */
export const DecisionCitationChip = (props: DecisionCitationChipProps) => {
  const { decision, passage, preview, onOpen, sourceText } = props;
  const label = props.label;
  const citingText = props.citingText;
  const presentation =
    props.presentation ?? DECISION_CITATION_PRESENTATION.compact;
  const paragraphNumber = props.paragraphNumber ?? null;
  const t = useTranslations();
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  const restoringFocus = useRef(false);
  const date =
    formatDecisionDate(decision.decisionDate, format) ??
    t("caseLaw.citation.dateUnavailable");
  // Formatted once, in the formatting locale, which may differ from the UI
  // language (an Arabic numbering system, a grouping preference).
  const paragraph =
    paragraphNumber === null ? null : format.number(paragraphNumber);
  const reference =
    paragraph === null
      ? t("caseLaw.citation.referenceLabel", {
          court: decision.court,
          caseNumber: decision.caseNumber,
          date,
        })
      : t("caseLaw.citation.paragraphReferenceLabel", {
          court: decision.court,
          caseNumber: decision.caseNumber,
          date,
          paragraph,
        });
  const links = resolveLegalCitationLinks({
    url: decision.readerUrl,
    sourceUrl: decision.originalUrl,
    appOrigins: new Set([
      new URL(env.VITE_PUBLIC_APP_URL).origin,
      ...(typeof window === "undefined" ? [] : [window.location.origin]),
    ]),
  });
  if (links.type !== "decision") {
    return panic("Decision citation must resolve to its internal reader");
  }
  const readerUrl = new URL(links.url);
  // The resolver validates a served reader route; native navigation stays on
  // this deployment even when source metadata names the public app origin.
  const readerHref = `${readerUrl.pathname}${readerUrl.search}${readerUrl.hash}`;
  const originalUrl = sanitizeHref(links.source_url ?? "");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={reference}
        data-decision-citation={decision.decisionId}
        data-citation-presentation={presentation}
        nativeButton={false}
        openOnHover
        onFocus={(event) => {
          if (event.currentTarget === event.target && !restoringFocus.current) {
            setOpen(true);
          }
        }}
        onClick={containedEventHandler((event) => {
          // Focus or hover may already have opened the preview. A primary
          // press opens it explicitly instead of toggling it closed.
          event.preventBaseUIHandler();
          if (!isPlainPrimaryClick(event)) {
            return;
          }
          event.preventDefault();
          setOpen(true);
        })}
        render={
          <a
            className={cn(
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
              triggerShapeClassName({ sourceText, label, citingText }),
            )}
            href={sanitizeHref(readerHref)}
            ref={triggerRef}
          />
        }
      >
        <DecisionCitationTriggerContent
          citingText={citingText}
          decision={decision}
          label={label}
          paragraph={paragraph}
          presentation={presentation}
          sourceText={sourceText}
        />
      </PopoverTrigger>
      <PopoverPanel
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)]"
        finalFocus={() => {
          // Restoring keyboard focus after dismissal must not reopen the chip.
          restoringFocus.current = true;
          triggerRef.current?.focus({ preventScroll: true });
          restoringFocus.current = false;
          return false;
        }}
      >
        {preview ?? (
          <div className="flex flex-col gap-1">
            <BidiText as="span" className="text-sm font-medium">
              {decision.court}
            </BidiText>
            <BidiText as="span" className="text-sm">
              {decision.caseNumber}
            </BidiText>
            {paragraph !== null && (
              <span className="text-sm">
                {t("caseLaw.citation.paragraphLabel", { paragraph })}
              </span>
            )}
            <span className="text-muted-foreground text-xs">{date}</span>
          </div>
        )}
        {passage !== undefined && (
          <ScrollArea axis="vertical" className="max-h-64">
            <div
              className="text-sm wrap-anywhere whitespace-pre-wrap"
              dir="auto"
            >
              {passage}
            </div>
          </ScrollArea>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            render={<a href={sanitizeHref(readerHref)} />}
            onClick={(event) => {
              if (onOpen !== undefined && isPlainPrimaryClick(event)) {
                event.preventDefault();
                onOpen();
                setOpen(false);
              }
            }}
            size="sm"
            variant="outline"
          >
            {t("common.openInStella")}
          </Button>
          {originalUrl ? (
            <Button
              render={
                <a
                  href={sanitizeHref(originalUrl)}
                  rel="noopener noreferrer"
                  target="_blank"
                />
              }
              size="sm"
              variant="ghost"
            >
              {t("inspector.external.openOriginal")}
              <ExternalLinkIcon aria-hidden="true" />
            </Button>
          ) : (
            <Button disabled size="sm" variant="ghost">
              {t("inspector.external.openOriginal")}
            </Button>
          )}
        </div>
      </PopoverPanel>
    </Popover>
  );
};
