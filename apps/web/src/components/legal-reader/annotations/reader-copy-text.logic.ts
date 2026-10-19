import { panic } from "better-result";

import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";

import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import {
  formatDecisionCitation,
  formatDecisionQuotation,
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
}: CopyTextOptions): string => {
  const quote = selected.cleanText;
  const citation = readerTargetCitation({
    locator: selected.locator,
    target,
  });
  const quoted =
    target.type === "decision"
      ? formatDecisionQuotation(quote, target.country)
      : `“${quote}”`;
  switch (mode) {
    case "quoteWithCitation": {
      return `${quoted} ${citation.sentence}`;
    }
    case "citationWithQuote": {
      return `${citation.inline} (${quoted}).`;
    }
    case "blockQuoteWithCitation": {
      return `${quote}\n\n${citation.sentence}`;
    }
    case "textOnly": {
      return quote;
    }
    case "citationOnly": {
      return citation.sentence;
    }
    default: {
      mode satisfies never;
      return panic(`Unhandled mode: ${String(mode)}`);
    }
  }
};
