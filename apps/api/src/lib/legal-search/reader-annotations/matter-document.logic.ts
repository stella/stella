/**
 * Where a mark on a matter document's PDF lands: each span names a page and
 * UTF-16 offsets into that page's extracted text, and is placed only when the
 * page has text and its words at those offsets are the quoted words. The
 * stored quote is therefore always the document's own wording, and the page
 * text's digest goes with it so a later reading can tell whether the offsets
 * still point at those words.
 */

import { Result } from "better-result";

import {
  MATTER_DOCUMENT_ANNOTATION_REFUSALS,
  readerPdfPageAnchorId,
} from "@stll/api-contract/legal-reader-annotations";
import type { MatterDocumentAnnotationRefusal } from "@stll/api-contract/legal-reader-annotations";

import { pdfPageTextSha256 } from "@/api/lib/files/pdf-page-text";

export type DocumentPageSpan = {
  /** 1-based. */
  pageNumber: number;
  startOffset: number;
  endOffset: number;
  quote: string;
};

export type PlacedDocumentSpans = {
  spans: {
    blockAnchorId: string;
    startOffset: number;
    endOffset: number;
    quote: string;
  }[];
  pageTextSha256ByAnchorId: Map<string, string>;
};

export type DocumentSpanRefusal = {
  code: Exclude<
    MatterDocumentAnnotationRefusal,
    | typeof MATTER_DOCUMENT_ANNOTATION_REFUSALS.fileNotPdf
    | typeof MATTER_DOCUMENT_ANNOTATION_REFUSALS.fileEncrypted
  >;
  pageNumber: number;
};

type PlaceDocumentSpansOptions = {
  /** The text of each page the spans name, by 1-based number; a page the
   *  document does not have is absent. */
  pages: ReadonlyMap<number, string>;
  spans: readonly DocumentPageSpan[];
};

export const placeDocumentSpans = ({
  pages,
  spans,
}: PlaceDocumentSpansOptions): Result<
  PlacedDocumentSpans,
  DocumentSpanRefusal
> => {
  const placed: PlacedDocumentSpans = {
    spans: [],
    pageTextSha256ByAnchorId: new Map(),
  };
  for (const span of spans) {
    const text = pages.get(span.pageNumber);
    if (text === undefined) {
      return Result.err({
        code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.pageMissing,
        pageNumber: span.pageNumber,
      });
    }
    // A scan without a text layer extracts to whitespace at most; there is no
    // word on it for a mark to point at.
    if (text.trim().length === 0) {
      return Result.err({
        code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.pageWithoutText,
        pageNumber: span.pageNumber,
      });
    }
    if (
      span.endOffset > text.length ||
      text.slice(span.startOffset, span.endOffset) !== span.quote
    ) {
      return Result.err({
        code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.quoteMismatch,
        pageNumber: span.pageNumber,
      });
    }
    const blockAnchorId = readerPdfPageAnchorId(span.pageNumber);
    placed.spans.push({
      blockAnchorId,
      startOffset: span.startOffset,
      endOffset: span.endOffset,
      quote: span.quote,
    });
    placed.pageTextSha256ByAnchorId.set(blockAnchorId, pdfPageTextSha256(text));
  }
  return Result.ok(placed);
};
