import { useTranslations } from "use-intl";

import { SEARCH_HIT_MARK, TextMark } from "@stll/ui/text-mark";
import { cn } from "@stll/ui/utils";

import {
  CLIPBOARD_CARD_PREVIEW_MAX_CHARACTERS,
  clipboardSearchPreviewText,
  highlightClipboardText,
} from "./clipboard-logic";
import type { ClipboardCopyFormat, ClipboardItem } from "./clipboard-types";
import { ClipboardImagePreview } from "./ClipboardImagePreview";
import type { ClipboardImagePreviewStatus } from "./ClipboardImagePreview";

type ClipboardCardPreviewProps = {
  /** "plainText" shows how a formatted clip pastes without its formatting. */
  format: ClipboardCopyFormat;
  imagePreviewRetryToken: number;
  item: ClipboardItem;
  onImagePreviewStatusChange: (status: ClipboardImagePreviewStatus) => void;
  query: string;
};

export const ClipboardCardPreview = ({
  format,
  imagePreviewRetryToken,
  item,
  onImagePreviewStatusChange,
  query,
}: ClipboardCardPreviewProps) => {
  const t = useTranslations("clipboard");
  if (item.type === "image") {
    return (
      <div className="size-full" dir="auto">
        <ClipboardImagePreview
          alt={item.name ?? t("image")}
          id={item.id}
          onStatusChange={onImagePreviewStatusChange}
          retryToken={imagePreviewRetryToken}
          surface="timeline"
        />
      </div>
    );
  }
  const rendersHtml =
    item.type === "formattedText" && format === "original" && !query;
  const previewClassName = cn(
    "text-foreground line-clamp-8 text-sm leading-5 text-pretty wrap-break-word",
    // HTML collapses its source whitespace; only plain text (and <pre>) keeps it.
    rendersHtml
      ? "clipboard-html [&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_code]:font-mono [&_li]:ms-4 [&_ol]:list-decimal [&_pre]:whitespace-pre-wrap [&_strong]:font-semibold [&_ul]:list-disc"
      : "whitespace-pre-wrap tab-4",
  );
  if (rendersHtml) {
    return (
      <div
        className={previewClassName}
        dangerouslySetInnerHTML={{
          // safe-html: Rust ammonia::Builder removes active content and permits only the semantic formatting tags declared in clipboard.rs before IPC.
          __html: item.html,
        }}
        dir="auto"
      />
    );
  }
  if (query) {
    const searchPreview = clipboardSearchPreviewText(item, query);
    const highlightedText = highlightClipboardText(searchPreview.text, query);
    return (
      <div className={previewClassName} dir="auto">
        {searchPreview.truncated ? (
          <span aria-hidden="true" className="text-muted-foreground">
            {"… "}
          </span>
        ) : null}
        {highlightedText.map((segment) =>
          segment.match ? (
            <TextMark {...SEARCH_HIT_MARK} key={segment.start}>
              {segment.text}
            </TextMark>
          ) : (
            <span key={segment.start}>{segment.text}</span>
          ),
        )}
      </div>
    );
  }
  return (
    <div className={previewClassName} dir="auto">
      {item.plainText.slice(0, CLIPBOARD_CARD_PREVIEW_MAX_CHARACTERS)}
    </div>
  );
};
