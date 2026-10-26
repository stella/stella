import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { READER_COPY_MODES } from "@stll/api-contract/legal-reader-annotations";
import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";
import { copyToClipboard } from "@stll/clipboard";
import { MenuPreviewLayout, PreviewPane } from "@stll/ui/preview-pane";
import { stellaToast } from "@stll/ui/toast";

import { citationCopyText } from "@/components/legal-reader/citation-copy.logic";
import type { QuotationMarks } from "@/components/legal-reader/citation-copy.logic";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";

/** How much of a long quotation the preview shows before trimming. */
const PREVIEW_QUOTE_CHARS = 220;

/**
 * The copy choices for a cited passage, each previewed as the reader hovers
 * or focuses it. The surface owns the container (the readers' selection bar,
 * a quotation's popover); this owns the choices, the clipboard write and its
 * confirmation.
 */
export const CitationCopyOptions = ({
  citation,
  marks,
  onCopied,
  quote,
}: {
  citation: string;
  /** The source language's quotation marks (`quotationMarksFor`). */
  marks: QuotationMarks;
  /** After a successful copy, so the surface can close and clean up. */
  onCopied: () => void;
  quote: string;
}) => {
  const t = useTranslations();
  const [previewMode, setPreviewMode] = useState<ReaderCopyMode | null>(null);
  const previewQuote =
    quote.length > PREVIEW_QUOTE_CHARS
      ? `${quote.slice(0, PREVIEW_QUOTE_CHARS)}…`
      : quote;

  return (
    <MenuPreviewLayout
      preview={
        // The submenu paints over the pane rather than in it, so its floor
        // is the viewport's, not the pane's.
        <PreviewPane className="w-[min(18rem,calc(100vw-9rem))]">
          {previewMode !== null && (
            <p className="text-foreground text-2xs leading-snug whitespace-pre-wrap">
              {citationCopyText(previewMode, {
                citation,
                marks,
                quote: previewQuote,
              })}
            </p>
          )}
        </PreviewPane>
      }
    >
      {READER_COPY_MODES.map((mode) => (
        <button
          className="hover:bg-accent block w-full rounded-sm px-2 py-1.5 text-start text-xs whitespace-nowrap"
          key={mode}
          onClick={() => {
            const text = citationCopyText(mode, { citation, marks, quote });
            detached(
              (async () => {
                const copied = await copyToClipboard(text);
                if (Result.isError(copied)) {
                  notifyUserError(copied.error, t("errors.actionFailed"));
                  return;
                }
                stellaToast.add({ title: t("common.copied"), type: "success" });
                // A failed copy keeps the menu open, so the reader can retry.
                onCopied();
              })(),
              "citation-copy.copy",
            );
          }}
          onFocus={() => setPreviewMode(mode)}
          // A press must not move focus: the readers' selection would clear.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setPreviewMode(mode)}
          type="button"
        >
          {t(`legalReader.copyMenu.${mode}`)}
        </button>
      ))}
    </MenuPreviewLayout>
  );
};
