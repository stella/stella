import { panic } from "better-result";

import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";

import type { QuotationMarks } from "@/components/legal-reader/citation-copy.logic";

/** A citation as it closes a sentence and as it sits inside one. */
export type SelectionCitation = { inline: string; sentence: string };

// A date or docket can already supply the citation's terminal period.
export const punctuateCitation = (citation: string): SelectionCitation => ({
  inline: citation,
  sentence: citation.endsWith(".") ? citation : `${citation}.`,
});

type SelectionCopySegment = { text: string; emphasis: boolean };

export type SelectionCopyText = {
  html: string;
  plain: string;
  segments: readonly SelectionCopySegment[];
};

type SelectionCopyTextOptions = {
  citation: SelectionCitation;
  /** The marks the quoted words take; the source's convention, not the UI's. */
  marks: QuotationMarks;
  mode: ReaderCopyMode;
  quote: string;
};

/**
 * Selected words as each copy choice of a selection bar writes them: the
 * structure every document shares, whatever cites it. The citation and the
 * quotation marks are the document's own.
 */
export const selectionCopyText = ({
  citation,
  marks,
  mode,
  quote,
}: SelectionCopyTextOptions): SelectionCopyText => {
  const quoted = `${marks.open}${quote}${marks.close}`;
  switch (mode) {
    case "quoteWithCitation": {
      return copyTextFromSegments(
        [
          { text: quoted, emphasis: true },
          { text: ` ${citation.sentence}`, emphasis: false },
        ],
        false,
      );
    }
    case "citationWithQuote": {
      return copyTextFromSegments(
        [
          { text: `${citation.inline} (`, emphasis: false },
          { text: quoted, emphasis: true },
          { text: ").", emphasis: false },
        ],
        false,
      );
    }
    case "blockQuoteWithCitation": {
      return copyTextFromSegments(
        [
          { text: quote, emphasis: true },
          { text: `\n\n${citation.sentence}`, emphasis: false },
        ],
        true,
      );
    }
    case "textOnly": {
      return copyTextFromSegments([{ text: quote, emphasis: true }], false);
    }
    case "citationOnly": {
      return copyTextFromSegments(
        [{ text: citation.sentence, emphasis: false }],
        false,
      );
    }
    default: {
      mode satisfies never;
      return panic(`Unhandled mode: ${String(mode)}`);
    }
  }
};

const escapeHtml = (text: string): string =>
  text.replaceAll(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return panic(`Unhandled HTML character: ${character}`);
    }
  });

const renderLineBreaks = (text: string): string =>
  escapeHtml(text).replaceAll("\n", "<br>");

const renderParagraphs = (
  segments: readonly SelectionCopySegment[],
): string[] => {
  const paragraphs = [""];
  for (const { emphasis, text } of segments) {
    const parts = text.split("\n\n");
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        paragraphs.push("");
      }
      const rendered = renderLineBreaks(part);
      paragraphs[paragraphs.length - 1] += emphasis
        ? `<em>${rendered}</em>`
        : rendered;
    }
  }
  return paragraphs;
};

const copyTextFromSegments = (
  segments: SelectionCopySegment[],
  blockQuote: boolean,
): SelectionCopyText => {
  const plain = segments.map(({ text }) => text).join("");
  if (blockQuote) {
    const quote = segments[0];
    const citation = segments
      .slice(1)
      .map(({ text }) => text)
      .join("")
      .trim();
    return {
      html: `<blockquote>${renderParagraphs(quote === undefined ? [] : [quote])
        .map((paragraph) => `<p>${paragraph}</p>`)
        .join("")}</blockquote><p>${renderLineBreaks(citation)}</p>`,
      plain,
      segments,
    };
  }
  const paragraphs = renderParagraphs(segments);
  if (paragraphs.length > 1) {
    return {
      html: paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join(""),
      plain,
      segments,
    };
  }
  return {
    html: paragraphs[0] ?? "",
    plain,
    segments,
  };
};
