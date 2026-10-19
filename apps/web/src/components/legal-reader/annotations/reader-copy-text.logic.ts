import { panic } from "better-result";

import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";

import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import {
  formatDecisionCitation,
  formatJurisdictionQuotation,
} from "@/features/case-law/citation-format";
import { formatStatuteCitation } from "@/lib/statutes/statute-format";

// A date or docket can already supply the citation's terminal period.
const punctuateCitation = (citation: string) => ({
  inline: citation,
  sentence: citation.endsWith(".") ? citation : `${citation}.`,
});

/** The citation a copied quotation carries. */
export const readerTargetCitation = ({
  locator,
  target,
}: {
  locator: string | null;
  target: ReaderAnnotationTarget;
}) => {
  switch (target.type) {
    case "decision": {
      return punctuateCitation(
        formatDecisionCitation({
          caseNumber: target.caseNumber,
          caseNumberType: target.caseNumberType,
          country: target.country,
          court: target.court,
          decisionDate: target.decisionDate,
          decisionType: target.decisionType,
          ecli: target.ecli,
          name: target.name,
          // The reader's locator is a reporter page; its selection does not
          // carry the court's paragraph number.
          paragraph: null,
          pincite: locator,
        }),
      );
    }
    case "statute": {
      return punctuateCitation(
        formatStatuteCitation({
          eli: target.eli,
          provision: locator,
          title: target.title,
          versionValidFrom: target.versionValidFrom,
        }),
      );
    }
    default: {
      target satisfies never;
      return panic(`Unhandled reader target: ${String(target)}`);
    }
  }
};

type CopyTextOptions = {
  mode: ReaderCopyMode;
  selected: { cleanText: string; locator: string | null };
  target: ReaderAnnotationTarget;
};

export const copyTextFor = ({
  mode,
  selected,
  target,
}: CopyTextOptions): ReaderCopyText => {
  const quote = selected.cleanText;
  const citation = readerTargetCitation({
    locator: selected.locator,
    target,
  });
  const quoted = formatJurisdictionQuotation(quote, target.country);
  let segments: ReaderCopySegment[];
  let blockQuote = false;
  switch (mode) {
    case "quoteWithCitation": {
      segments = [
        { text: quoted, emphasis: true },
        { text: ` ${citation.sentence}`, emphasis: false },
      ];
      break;
    }
    case "citationWithQuote": {
      segments = [
        { text: `${citation.inline} (`, emphasis: false },
        { text: quoted, emphasis: true },
        { text: ").", emphasis: false },
      ];
      break;
    }
    case "blockQuoteWithCitation": {
      segments = [
        { text: quote, emphasis: true },
        { text: `\n\n${citation.sentence}`, emphasis: false },
      ];
      blockQuote = true;
      break;
    }
    case "textOnly": {
      segments = [{ text: quote, emphasis: true }];
      break;
    }
    case "citationOnly": {
      segments = [{ text: citation.sentence, emphasis: false }];
      break;
    }
    default: {
      mode satisfies never;
      return panic(`Unhandled mode: ${String(mode)}`);
    }
  }
  return copyTextFromSegments(segments, blockQuote);
};

export type ReaderCopySegment = { text: string; emphasis: boolean };

export type ReaderCopyText = {
  html: string;
  plain: string;
  segments: readonly ReaderCopySegment[];
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

const renderParagraphs = (segments: readonly ReaderCopySegment[]): string[] => {
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
  segments: ReaderCopySegment[],
  blockQuote: boolean,
): ReaderCopyText => {
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
