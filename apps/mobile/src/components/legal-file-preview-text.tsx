import { panic } from "better-result";

import type { PreviewTextFormat } from "@stll/api-contract/preview-text";
import { Text } from "@stll/ui/text";

import { MarkdownView } from "@/components/markdown-view";

/**
 * A contained document's text in a legal-file preview, in the markup its
 * reader named, as the web draws it: Markdown as formatted text, plain text
 * as written with its line breaks.
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
      return <MarkdownView markdown={text} />;
    case "plain":
      return <Text selectable>{text}</Text>;
    default:
      format satisfies never;
      return panic("Unhandled legal file preview text format");
  }
};
