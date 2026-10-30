import { useState } from "react";

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { ScrollArea } from "@stll/ui/scroll-area";

import { paragraphPreview } from "./paragraph-reference.logic";
import type { ResolvedParagraphReference } from "./paragraph-reference.logic";

/** Long enough that reading past a chip does not open its card. */
const PREVIEW_OPEN_DELAY_MS = 400;
const PREVIEW_CLOSE_DELAY_MS = 100;

export type ParagraphReferenceProps = {
  /** The decision's language, which the portalled card no longer inherits. */
  language: string;
  onAnchorClick: (startAnchorId: string, endAnchorId: string) => void;
  reference: ResolvedParagraphReference;
};

/**
 * A citation of the decision's own paragraphs. Hovering or focusing it shows
 * their text in place; pressing it moves the reader to them, as a tap does
 * on touch, where there is no hover. Surfaces render it through
 * `CitationChip`, which owns citation kinds.
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
