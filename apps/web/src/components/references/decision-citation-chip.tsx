import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { CourtBadge } from "@stll/ui/court-badge";
import { ExternalLinkIcon, LandmarkIcon } from "@stll/ui/icons";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";
import { containedEventHandler } from "@stll/ui/use-contained-handler";

import { isPlainPrimaryClick } from "@/components/inspector/case-decision-view";
import { DECISION_CITATION_PRESENTATION } from "@/components/references/decision-citation-presentation.logic";
import type { DecisionCitationPresentation } from "@/components/references/decision-citation-presentation.logic";
import { env } from "@/env";
import { useFormatter } from "@/i18n/formatting-context";
import { formatDecisionDate } from "@/lib/decision-date";
import { sanitizeHref } from "@/lib/sanitize-href";

export type DecisionCitationMetadata = {
  decisionId: string;
  court: string;
  courtShortCode: string;
  caseNumber: string;
  decisionDate: string | null;
  readerUrl: string;
  originalUrl: string | null;
};

type DecisionCitationChipProps = {
  decision: DecisionCitationMetadata;
  passage?: ReactNode;
  presentation?: DecisionCitationPresentation | undefined;
  onOpen?: (() => void) | undefined;
};

const DecisionCitationLabel = ({
  decision,
  presentation,
}: {
  decision: DecisionCitationMetadata;
  presentation: DecisionCitationPresentation;
}) => {
  switch (presentation) {
    case DECISION_CITATION_PRESENTATION.compact:
      return (
        <CourtBadge abbreviation={decision.courtShortCode} weight="outline" />
      );
    case DECISION_CITATION_PRESENTATION.expanded:
      return (
        <span className="inline-flex items-center gap-1">
          <LandmarkIcon aria-hidden="true" className="size-3 shrink-0" />
          <CourtBadge abbreviation={decision.courtShortCode} weight="outline" />
          <BidiText as="span">{decision.caseNumber}</BidiText>
        </span>
      );
    default:
      presentation satisfies never;
      return panic(
        `Unhandled decision citation presentation: ${String(presentation)}`,
      );
  }
};

/** The same decision annotation in answers, provenance cards and reader text. */
export const DecisionCitationChip = ({
  decision,
  passage,
  presentation = DECISION_CITATION_PRESENTATION.compact,
  onOpen,
}: DecisionCitationChipProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  const restoringFocus = useRef(false);
  const date =
    formatDecisionDate(decision.decisionDate, format) ??
    t("caseLaw.citation.dateUnavailable");
  const reference = t("caseLaw.citation.referenceLabel", {
    court: decision.court,
    caseNumber: decision.caseNumber,
    date,
  });
  const links = resolveLegalCitationLinks({
    appUrl: decision.readerUrl,
    sourceUrl: decision.originalUrl,
    appOrigins: new Set([
      new URL(env.VITE_PUBLIC_APP_URL).origin,
      ...(typeof window === "undefined" ? [] : [window.location.origin]),
    ]),
  });
  if (links.type !== "decision") {
    return panic("Decision citation must resolve to its internal reader");
  }
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
        render={
          <a
            className="focus-visible:ring-ring inline-flex rounded align-baseline focus-visible:ring-2 focus-visible:outline-none"
            href={sanitizeHref(links.url)}
            ref={triggerRef}
            onClick={containedEventHandler((event) => {
              if (isPlainPrimaryClick(event)) {
                event.preventDefault();
              }
            })}
          />
        }
        tooltip={false}
      >
        <DecisionCitationLabel
          decision={decision}
          presentation={presentation}
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
        <div className="flex flex-col gap-1">
          <BidiText as="span" className="text-sm font-medium">
            {decision.court}
          </BidiText>
          <BidiText as="span" className="text-sm">
            {decision.caseNumber}
          </BidiText>
          <span className="text-muted-foreground text-xs">{date}</span>
        </div>
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
            render={<a href={sanitizeHref(links.url)} />}
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
