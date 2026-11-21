import { panic } from "better-result";

import type { PreviewTextFormat } from "@stll/api-contract/preview-text";

import { MarkdownPreview } from "@/components/markdown-preview";

/**
 * A contained document's text in a legal-file preview (signed containers,
 * text-only formats), rendered in the markup its reader named: Markdown as
 * formatted text through the shared document preview, plain text as written,
 * line breaks kept. One renderer for every legal format, so none of them
 * prints Markdown source or reflows a plain text file.
 */
export const LegalFilePreviewText = ({
  format,
  text,
}: {
  format: PreviewTextFormat;
  text: string;
}) => {
  switch (format) {
    case "markdown":
      return (
        <div className="wrap-break-word" dir="auto">
          <MarkdownPreview>{text}</MarkdownPreview>
        </div>
      );
    case "plain":
      return (
        <pre
          className="font-sans text-sm leading-relaxed wrap-break-word whitespace-pre-wrap"
          dir="auto"
        >
          {text}
        </pre>
      );
    default:
      format satisfies never;
      return panic("Unhandled legal file preview text format");
  }
};
