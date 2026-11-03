import { panic } from "better-result";

import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";

import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import {
  punctuateCitation,
  selectionCopyText,
} from "@/components/selection-toolbar-copy.logic";
import type { SelectionCopyText } from "@/components/selection-toolbar-copy.logic";
import {
  formatDecisionCitation,
  jurisdictionQuotationMarks,
} from "@/features/case-law/citation-format";
import { formatStatuteCitation } from "@/lib/statutes/statute-format";

/** Chrome that must never leak into a quotation. */
const QUOTE_CHROME_SELECTOR = "[data-reader-chrome], .reader-note-ref";

const BLOCK_BOUNDARY_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote";

export const cleanSelectionText = (range: Range): string => {
  const holder =
    range.startContainer.ownerDocument?.createElement("div") ?? null;
  if (holder === null) {
    return "";
  }
  holder.append(range.cloneContents());
  for (const el of holder.querySelectorAll(QUOTE_CHROME_SELECTOR)) {
    el.remove();
  }
  // textContent concatenates block elements without any separator, gluing
  // the last word of one paragraph to the first of the next; give each
  // block an explicit boundary before flattening.
  for (const block of holder.querySelectorAll(BLOCK_BOUNDARY_SELECTOR)) {
    block.append("\n");
  }
  return holder.textContent
    .replaceAll(/[^\S\n]+/gu, " ")
    .replaceAll(/ *\n */gu, "\n")
    .trim();
};

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
}: CopyTextOptions): SelectionCopyText =>
  selectionCopyText({
    citation: readerTargetCitation({ locator: selected.locator, target }),
    marks: jurisdictionQuotationMarks(target.country),
    mode,
    quote: selected.cleanText,
  });
