import { useState } from "react";

import { useTranslations } from "use-intl";

import type { AnalysisAnchorRange } from "@stll/legal-ast/analysis";
import type { Block } from "@stll/legal-ast/document-ast";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { ScrollArea } from "@stll/ui/scroll-area";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import type { Analytics } from "@/lib/analytics/types";
import { ClientTelemetryError } from "@/lib/errors/telemetry";

import {
  paragraphPreview,
  paragraphRangeIndices,
} from "./paragraph-reference.logic";
import type { ResolvedParagraphReference } from "./paragraph-reference.logic";

/** Long enough that reading past a chip does not open its card. */
const PREVIEW_OPEN_DELAY_MS = 400;
const PREVIEW_CLOSE_DELAY_MS = 100;

type ParagraphReferenceProps = {
  /** The decision's language, which the portalled card no longer inherits. */
  language: string;
  onAnchorClick: (startAnchorId: string, endAnchorId: string) => void;
  reference: ResolvedParagraphReference;
};

/**
 * A citation of the decision's own paragraphs. Hovering or focusing it shows
 * their text in place; pressing it moves the reader to them, as a tap does
 * on touch, where there is no hover.
 */
export const ParagraphReference = ({
  language,
  onAnchorClick,
  reference,
}: ParagraphReferenceProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const { startAnchorId, endAnchorId, paragraphs } = reference;
  const preview = paragraphPreview(paragraphs);
  const jump = () => {
    setOpen(false);
    onAnchorClick(startAnchorId, endAnchorId);
  };

  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger
        closeDelay={PREVIEW_CLOSE_DELAY_MS}
        delay={PREVIEW_OPEN_DELAY_MS}
        render={
          <button
            aria-label={t("caseLaw.viewer.paragraphReference", {
              number: reference.label.slice(1, -1).replace("]-[", "–"),
            })}
            className="reader-chrome text-muted-foreground hover:text-foreground data-popup-open:text-foreground rounded-sm underline-offset-2 hover:underline data-popup-open:underline"
            onClick={jump}
            type="button"
          />
        }
      >
        <bdi>{reference.label}</bdi>
      </PreviewCardTrigger>
      <PreviewCardPopup align="start" className="w-96 max-w-[calc(100vw-2rem)]">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <ScrollArea axis="vertical" className="max-h-72" scrollFade>
            <div
              className="reader-body text-foreground flex flex-col gap-2 text-start text-sm leading-relaxed"
              data-paragraph-preview=""
              lang={language}
            >
              {preview.paragraphs.map(({ anchorId, number, text }, index) => (
                <div className="flex items-baseline gap-2" key={anchorId}>
                  <bdi className="reader-chrome text-muted-foreground shrink-0 text-xs tabular-nums">
                    {number}
                  </bdi>
                  <BidiText
                    as="span"
                    className="min-w-0 flex-1 text-pretty whitespace-pre-line"
                  >
                    {text}
                    {preview.truncated &&
                      index === preview.paragraphs.length - 1 &&
                      " …"}
                  </BidiText>
                </div>
              ))}
            </div>
          </ScrollArea>
          {preview.truncated && (
            <Button
              className="w-fit"
              onClick={jump}
              size="xs"
              variant="outline"
            >
              {t("caseLaw.viewer.goToParagraph", { count: paragraphs.length })}
            </Button>
          )}
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
};

// Ranges already reported, per analytics client (one per page load), so a
// remounted reader or a reopened decision never reports a range twice.
const reportedRanges = new WeakMap<Analytics, Set<string>>();

type UnresolvedCitationTelemetryOptions = {
  blocks: readonly Block[];
  ranges: readonly AnalysisAnchorRange[];
  /** What the ranges were generated against: the analysis's input. */
  source: string;
};

/**
 * Reports cited ranges the loaded text cannot resolve. The analysis was
 * generated from this text, so a citation that misses it is a data defect;
 * the reader draws no reference for it.
 */
export const useUnresolvedCitationTelemetry = ({
  blocks,
  ranges,
  source,
}: UnresolvedCitationTelemetryOptions) => {
  const analytics = useAnalytics();
  useExternalSyncEffect(() => {
    let reported = reportedRanges.get(analytics);
    if (reported === undefined) {
      reported = new Set();
      reportedRanges.set(analytics, reported);
    }
    let fresh = 0;
    for (const range of ranges) {
      if (paragraphRangeIndices(blocks, range) !== null) {
        continue;
      }
      const key = JSON.stringify([
        source,
        range.startAnchorId,
        range.endAnchorId,
      ]);
      if (reported.has(key)) {
        continue;
      }
      reported.add(key);
      fresh += 1;
    }
    if (fresh === 0) {
      return;
    }
    analytics.captureError(
      new ClientTelemetryError({
        area: "case-law-paragraph-citation",
        message:
          "[Paragraph citation] An analysis cites a paragraph the decision text does not contain",
      }),
      {
        fingerprintKey: "useUnresolvedCitationTelemetry:ClientTelemetryError",
        scope: { type: "handler", handlerId: "case-law.paragraph-citation" },
      },
    );
  }, [analytics, blocks, ranges, source]);
};
