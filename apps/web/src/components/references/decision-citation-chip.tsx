import type { MouseEvent, ReactNode } from "react";

import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";
import { isPlainPrimaryClick } from "@stll/decision-reader/citation-click";
import { ReferencePeek } from "@stll/decision-reader/reference-peek";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { BidiText } from "@stll/ui/bidi-text";
import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import { LandmarkIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import type { DecisionCitationMetadata } from "@/components/references/decision-citation-chip.logic";
import { DECISION_CITATION_PRESENTATION } from "@/components/references/decision-citation-presentation.logic";
import type { DecisionCitationPresentation } from "@/components/references/decision-citation-presentation.logic";
import { env } from "@/env";
import { useFormatter } from "@/i18n/formatting-context";
import { formatDecisionDate } from "@/lib/decision-date";
import { detached } from "@/lib/detached";

export type DecisionCitationChipProps = {
  decision: DecisionCitationMetadata;
  passage?: ReactNode;
  /** A complete, lazily mounted preview for surfaces with richer metadata. */
  preview?: ReactNode;
  presentation?: DecisionCitationPresentation | undefined;
  /** The court's own number on the cited block; null when it printed none. */
  paragraphNumber?: number | null | undefined;
  /** Opens the decision beside the text; omitted where nothing can dock. */
  onOpenInSidePanel?: (() => void) | undefined;
  /**
   * Prose that already names the decision ("III. ÚS 2429/24"). It becomes
   * the trigger itself, quietly underlined, instead of being followed by a
   * badge that repeats the court the text just named.
   */
  label?: ReactNode;
  /**
   * The citing text's own words for the decision, drawn ahead of the badge
   * inside the same trigger, so the whole reference opens the preview and
   * not only its badge.
   */
  citingText?: ReactNode;
};

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

/** How the trigger sits in its line, by what it draws. */
const triggerShapeClassName = ({
  label,
  citingText,
}: Pick<DecisionCitationChipProps, "label" | "citingText">): string => {
  if (label !== undefined) {
    return "decoration-foreground-placeholder hover:decoration-foreground-muted data-[popup-open]:decoration-foreground-muted rounded-xs underline decoration-dotted underline-offset-2 transition-[text-decoration-color] duration-150";
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
}: Pick<DecisionCitationChipProps, "citingText" | "decision" | "label"> & {
  /** The court's number, already in the reader's formatting locale. */
  paragraph: string | null;
  presentation: DecisionCitationPresentation;
}) => {
  const t = useTranslations();
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
 * Surfaces render it through `CitationChip`, which owns citation kinds.
 */
export const DecisionCitationChip = ({
  decision,
  passage,
  preview,
  presentation = DECISION_CITATION_PRESENTATION.compact,
  paragraphNumber = null,
  onOpenInSidePanel,
  label,
  citingText,
}: DecisionCitationChipProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const navigate = useNavigate();
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
  const originalUrl = sanitizeHref(links.source_url) ?? null;
  // A plain click opens the full page in the app; every browser gesture
  // follows the href.
  const onOpenPage = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainPrimaryClick(event)) {
      return;
    }
    event.preventDefault();
    detached(navigate({ href: readerHref }), "decision-citation.open-page");
  };
  const body =
    preview === undefined &&
    paragraph === null &&
    passage === undefined ? undefined : (
      <>
        {preview}
        {preview === undefined && paragraph !== null && (
          <span className="text-sm">
            {t("caseLaw.citation.paragraphLabel", { paragraph })}
          </span>
        )}
        {passage !== undefined && (
          <div className="text-sm wrap-anywhere whitespace-pre-wrap" dir="auto">
            {passage}
          </div>
        )}
      </>
    );

  return (
    <ReferencePeek
      body={body}
      header={{
        primary: decision.caseNumber,
        meta: [
          { part: "court", text: decision.court },
          { part: "date", text: date },
        ],
      }}
      target={{
        kind: "decision",
        actions: {
          openInSidePanel: onOpenInSidePanel ?? null,
          openInStella: (
            <a
              aria-label={t("common.openInStella")}
              href={sanitizeHref(readerHref)}
              onClick={onOpenPage}
            />
          ),
          openOriginal: originalUrl,
        },
      }}
      trigger={{
        type: "link",
        element: (
          <a
            aria-label={reference}
            className={cn(
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
              triggerShapeClassName({ label, citingText }),
            )}
            data-citation-presentation={presentation}
            data-decision-citation={decision.decisionId}
            href={sanitizeHref(readerHref)}
          />
        ),
      }}
    >
      <DecisionCitationTriggerContent
        citingText={citingText}
        decision={decision}
        label={label}
        paragraph={paragraph}
        presentation={presentation}
      />
    </ReferencePeek>
  );
};
