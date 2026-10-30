import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";

import { quotationMarksFor } from "@/components/legal-reader/citation-copy.logic";
import type { SelectedLayerText } from "@/components/pdf/annotations/document-mark-anchor.logic";
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
  /** Each page's share of the selection, in reading order. */
  layers: SelectedLayerText[];
  pages: PdfPageSpan;
  /** The selected words on one line: a quotation, not the page layout. */
  quote: string;
};

type LayerSelection = Omit<SelectedLayerText, "pageNumber">;

/**
 * The selected words inside one page's text layer, and where in the layer's
 * text they begin. pdf.js ends each line with a `<br>` rather than a space,
 * so reading the text nodes alone would glue the last word of a line to the
 * first of the next.
 */
const layerSelection = (range: Range, layer: Element): LayerSelection => {
  const walker = layer.ownerDocument.createTreeWalker(
    layer,
    NodeFilter.SHOW_ALL,
  );
  const parts: string[] = [];
  let before = 0;
  let total = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    let data: string | null = null;
    if (node.nodeName === "BR") {
      data = "\n";
    } else if (node instanceof Text) {
      data = node.data;
    }
    if (data === null) {
      continue;
    }
    total += data.length;
    if (!range.intersectsNode(node)) {
      if (range.comparePoint(node, 0) < 0) {
        before += data.length;
      }
      continue;
    }
    if (!(node instanceof Text)) {
      parts.push(data);
      continue;
    }
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    if (parts.length === 0) {
      before += start;
    }
    parts.push(node.data.slice(start, end));
  }
  return { before, text: parts.join(""), total };
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
  const layers: SelectedLayerText[] = [];
  let firstPage: number | null = null;
  let lastPage: number | null = null;
  for (const layer of root.querySelectorAll(`[${TEXT_LAYER_ATTRIBUTE}]`)) {
    const pageId = layer.getAttribute(TEXT_LAYER_ATTRIBUTE);
    if (pageId === null || !range.intersectsNode(layer)) {
      continue;
    }
    const page = pageNumberOf(pageId);
    const selection = layerSelection(range, layer);
    if (page === null || selection.text.trim() === "") {
      continue;
    }
    firstPage ??= page;
    lastPage = page;
    layers.push({ ...selection, pageNumber: page });
  }
  const quote = layers
    .map((layer) => layer.text)
    .join(" ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return firstPage === null || lastPage === null || quote === ""
    ? null
    : { layers, pages: { end: lastPage, start: firstPage }, quote };
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
