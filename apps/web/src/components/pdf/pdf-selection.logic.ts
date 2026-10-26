import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";

import { quotationMarksFor } from "@/components/legal-reader/citation-copy.logic";
import {
  punctuateCitation,
  selectionCopyText,
} from "@/components/selection-toolbar-copy.logic";
import type {
  SelectionCitation,
  SelectionCopyText,
} from "@/components/selection-toolbar-copy.logic";
import { TEXT_LAYER_ATTRIBUTE } from "@/lib/pdf/consts";

/** The first and last page a passage covers, numbered as the viewer shows them. */
export type PdfPageSpan = { end: number; start: number };

export type PdfSelectionPassage = {
  pages: PdfPageSpan;
  /** The selected words on one line: a quotation, not the page layout. */
  quote: string;
};

/**
 * The selected words inside one page's text layer. pdf.js ends each line with
 * a `<br>` rather than a space, so reading the text nodes alone would glue the
 * last word of a line to the first of the next.
 */
const layerSelectionText = (range: Range, layer: Element): string => {
  const walker = layer.ownerDocument.createTreeWalker(
    layer,
    NodeFilter.SHOW_ALL,
  );
  const parts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) {
      continue;
    }
    if (node.nodeName === "BR") {
      parts.push("\n");
      continue;
    }
    if (!(node instanceof Text)) {
      continue;
    }
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    parts.push(node.data.slice(start, end));
  }
  return parts.join("");
};

type PdfSelectionPassageOptions = {
  /** The viewer's page number for a text layer's page id; null for a layer
   *  that is not a page of the document on screen (one still unmounting after
   *  a document switch). */
  pageNumberOf: (pageId: string) => number | null;
  range: Range;
  root: HTMLElement;
};

/**
 * What a selection over the PDF's text layers quotes, and on which pages.
 * Null when it holds no words of the document: a press on the page chrome,
 * the canvas, or an overlay label.
 */
export const pdfSelectionPassage = ({
  pageNumberOf,
  range,
  root,
}: PdfSelectionPassageOptions): PdfSelectionPassage | null => {
  const lines: string[] = [];
  let pages: PdfPageSpan | null = null;
  for (const layer of root.querySelectorAll(`[${TEXT_LAYER_ATTRIBUTE}]`)) {
    const pageId = layer.getAttribute(TEXT_LAYER_ATTRIBUTE);
    if (pageId === null || !range.intersectsNode(layer)) {
      continue;
    }
    const page = pageNumberOf(pageId);
    const text = layerSelectionText(range, layer);
    if (page === null || text.trim() === "") {
      continue;
    }
    pages = { end: page, start: pages?.start ?? page };
    lines.push(text);
  }
  const quote = lines.join(" ").replaceAll(/\s+/gu, " ").trim();
  return pages === null || quote === "" ? null : { pages, quote };
};

/** How the reader's language writes a page locator ("p. 3", "s. 3–4"). */
type PdfPageLabels = {
  page: (page: string) => string;
  pageRange: (start: string, end: string) => string;
};

export const pdfPageLocator = (
  pages: PdfPageSpan,
  labels: PdfPageLabels,
): string =>
  pages.start === pages.end
    ? labels.page(String(pages.start))
    : labels.pageRange(String(pages.start), String(pages.end));

/** The matter document a passage is quoted from, as its citation names it. */
export type PdfCitedDocument = {
  name: string;
  /** The matter's reference, where the organization numbers its matters. */
  reference: string | null;
};

type PdfPassageCitationOptions = {
  document: PdfCitedDocument;
  locator: string;
};

/** The document's own reference: its name, the matter's number, the page. */
export const pdfPassageCitation = ({
  document,
  locator,
}: PdfPassageCitationOptions): SelectionCitation =>
  punctuateCitation(
    [document.name, document.reference, locator]
      .filter((part) => part !== null && part !== "")
      .join(", "),
  );

type PdfPassageCopyTextOptions = {
  citation: SelectionCitation;
  /** The reader's language. A matter PDF does not declare its own, and the
   *  reader's is the best evidence of the language its words are in. */
  language: string;
  mode: ReaderCopyMode;
  quote: string;
};

export const pdfPassageCopyText = ({
  citation,
  language,
  mode,
  quote,
}: PdfPassageCopyTextOptions): SelectionCopyText =>
  selectionCopyText({
    citation,
    marks: quotationMarksFor({ country: null, language }),
    mode,
    quote,
  });
