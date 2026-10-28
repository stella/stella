import type { PDF, PDFPage } from "@libpdf/core";

import {
  mergePdfTextBoxes,
  readPdfPageGlyphText,
} from "@stll/api-contract/pdf-mark-placement";
import type {
  PdfPageGlyphText,
  PdfTextBox,
} from "@stll/api-contract/pdf-mark-placement";
import { findSearchMatchRanges } from "@stll/text-normalize";

import { resolvePDFPageSource } from "@/lib/pdf/pdf-page-source";
import type { PDFPageSource } from "@/lib/pdf/pdf-page-source";
import type { PageViewport } from "@/lib/pdf/pdfjs-loader";
import { MAX_SEARCH_PREVIEW_MATCHES } from "@/lib/search-match-navigation";
import {
  getSearchTextCandidates,
  selectNonOverlappingSearchMatches,
} from "@/lib/search-text";
import type { SearchTextQuery } from "@/lib/search-text";

export type PDFSearchBox = PdfTextBox;

type PDFSearchMatch = {
  pageIndex: number;
  boxes: PDFSearchBox[];
  textEndOffset: number;
  textOffset: number;
};

export type PDFSearchResult = {
  matches: PDFSearchMatch[];
  truncated: boolean;
};

export type PDFSearchViewportBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type FindPDFSearchResultsOptions = {
  bytes: Uint8Array;
  password?: string | undefined;
  pageSource: PDFPageSource;
  searchText: SearchTextQuery;
  signal: AbortSignal;
};

type ViewerSearchPage = {
  page: PDFPage;
  pageIndex: number;
};

/**
 * A page's text as LibPDF extracts it, with the glyph box behind each UTF-16
 * unit; see `readPdfPageGlyphText`.
 */
export type PageSearchText = PdfPageGlyphText;

const getPDFSearchMatchKey = ({
  pageIndex,
  textEndOffset,
  textOffset,
}: PDFSearchMatch): string =>
  `${String(pageIndex)}:${String(textOffset)}:${String(textEndOffset)}`;

const comparePDFSearchMatches = (
  first: PDFSearchMatch,
  second: PDFSearchMatch,
) =>
  first.pageIndex - second.pageIndex ||
  first.textOffset - second.textOffset ||
  second.textEndOffset - first.textEndOffset;

type ToPDFSearchMatchOptions = {
  end: number;
  pageIndex: number;
  pageSearchText: PageSearchText;
  start: number;
};

const toPDFSearchMatch = ({
  end,
  pageIndex,
  pageSearchText,
  start,
}: ToPDFSearchMatchOptions): PDFSearchMatch => {
  const boxes = pageSearchText.boxesByOffset
    .slice(start, end)
    .filter((box): box is PDFSearchBox => box !== null);
  return {
    pageIndex,
    boxes: mergePdfTextBoxes(boxes),
    textEndOffset: end,
    textOffset: start,
  };
};

type FindNormalizedPageMatchesOptions = {
  candidate: string;
  maxMatches: number;
  pageIndex: number;
  pageSearchText: PageSearchText;
};

const findNormalizedPageMatches = ({
  candidate,
  maxMatches,
  pageIndex,
  pageSearchText,
}: FindNormalizedPageMatchesOptions): PDFSearchMatch[] =>
  findSearchMatchRanges(pageSearchText.text, candidate, {
    maxMatches,
  })
    .map(({ end, start }) =>
      toPDFSearchMatch({ end, pageIndex, pageSearchText, start }),
    )
    .filter((match) => match.boxes.length > 0);

type FindPageMatchesOptions = {
  candidate: string;
  maxMatches: number;
  pageIndex: number;
  pageSearchText: PageSearchText;
};

const findPageMatches = ({
  candidate,
  maxMatches,
  pageIndex,
  pageSearchText,
}: FindPageMatchesOptions): PDFSearchMatch[] =>
  findNormalizedPageMatches({
    candidate,
    maxMatches,
    pageSearchText,
    pageIndex,
  });

type GetViewerSearchPagesOptions = {
  pdf: PDF;
  signal: AbortSignal;
  pageSource: PDFPageSource;
};

const getViewerSearchPages = async ({
  pdf,
  signal,
  pageSource,
}: GetViewerSearchPagesOptions): Promise<ViewerSearchPage[]> => {
  const rootPages = pdf.getPages();
  const pdfAttachments: Uint8Array[] = [];

  const attachmentEntries =
    pageSource === "portfolio" ? pdf.getAttachments() : [];
  for (const [name, attachment] of attachmentEntries) {
    signal.throwIfAborted();
    if (!attachment.filename.trim().toLowerCase().endsWith(".pdf")) {
      continue;
    }
    const content = pdf.getAttachment(name);
    if (content) {
      pdfAttachments.push(content);
    }
  }

  if (
    resolvePDFPageSource({
      pageSource,
      documentPageCount: rootPages.length,
      attachmentCount: pdfAttachments.length,
    }) === "document"
  ) {
    return rootPages.map((page, pageIndex) => ({ page, pageIndex }));
  }

  const { PDF } = await import("@libpdf/core");
  const pages: ViewerSearchPage[] = [];
  const attachments = await Promise.all(
    pdfAttachments.map(async (content) => {
      signal.throwIfAborted();
      // Embedded portfolio PDFs are loaded without the container password,
      // just like the viewer's attachment loading path. Promise.all preserves
      // the name-tree order used by the viewer.
      return await PDF.load(content);
    }),
  );
  signal.throwIfAborted();
  for (const attachment of attachments) {
    for (const page of attachment.getPages()) {
      signal.throwIfAborted();
      pages.push({ page, pageIndex: pages.length });
    }
  }
  return pages;
};

export const findPDFSearchResults = async ({
  bytes,
  password,
  pageSource,
  searchText,
  signal,
}: FindPDFSearchResultsOptions): Promise<PDFSearchResult | null> => {
  signal.throwIfAborted();
  const { PDF } = await import("@libpdf/core");
  signal.throwIfAborted();
  const pdf = await PDF.load(
    bytes,
    password ? { credentials: password } : undefined,
  );
  signal.throwIfAborted();

  const pages = await getViewerSearchPages({ pdf, signal, pageSource });
  signal.throwIfAborted();
  const candidates = getSearchTextCandidates(searchText);
  const pageSearchTextCache = new WeakMap<PDFPage, PageSearchText>();

  const collectCandidateMatches = (candidate: string) => {
    const matches = new Map<string, PDFSearchMatch>();
    for (const { page, pageIndex } of pages) {
      signal.throwIfAborted();
      const remainingMatchLimit = MAX_SEARCH_PREVIEW_MATCHES + 1 - matches.size;
      if (remainingMatchLimit <= 0) {
        return { matches, truncated: true };
      }
      let pageSearchText = pageSearchTextCache.get(page);
      if (!pageSearchText) {
        pageSearchText = readPdfPageGlyphText(page.extractText());
        pageSearchTextCache.set(page, pageSearchText);
      }
      for (const match of findPageMatches({
        candidate,
        maxMatches: remainingMatchLimit,
        pageSearchText,
        pageIndex,
      })) {
        matches.set(getPDFSearchMatchKey(match), match);
        if (matches.size > MAX_SEARCH_PREVIEW_MATCHES) {
          return { matches, truncated: true };
        }
      }
    }
    return { matches, truncated: false };
  };

  const toResult = (
    matches: ReadonlyMap<string, PDFSearchMatch>,
    truncated: boolean,
  ): PDFSearchResult => {
    const selectedMatches = selectNonOverlappingSearchMatches({
      getRange: ({
        pageIndex: group,
        textEndOffset: end,
        textOffset: start,
      }) => ({ end, group, start }),
      matches: matches.values(),
      maxMatches: MAX_SEARCH_PREVIEW_MATCHES + 1,
    }).toSorted(comparePDFSearchMatches);
    return {
      matches: selectedMatches.slice(0, MAX_SEARCH_PREVIEW_MATCHES),
      truncated:
        truncated || selectedMatches.length > MAX_SEARCH_PREVIEW_MATCHES,
    };
  };

  const collectCandidates = (searchCandidates: readonly string[]) => {
    const matches = new Map<string, PDFSearchMatch>();
    let truncated = false;
    for (const candidate of searchCandidates) {
      const candidateResult = collectCandidateMatches(candidate);
      truncated ||= candidateResult.truncated;
      for (const [key, match] of candidateResult.matches) {
        matches.set(key, match);
      }
    }
    return { matches, truncated };
  };

  if (typeof searchText !== "string") {
    const result = collectCandidates(candidates);
    return toResult(result.matches, result.truncated);
  }

  const phraseCandidate = candidates.at(0);
  const phraseResult = phraseCandidate
    ? collectCandidateMatches(phraseCandidate)
    : { matches: new Map<string, PDFSearchMatch>(), truncated: false };
  if (phraseResult.matches.size > 0 || candidates.length <= 1) {
    return phraseResult.matches.size > 0
      ? toResult(phraseResult.matches, phraseResult.truncated)
      : null;
  }

  const result = collectCandidates(candidates.slice(1));

  if (result.matches.size === 0) {
    return null;
  }

  return toResult(result.matches, result.truncated);
};

export const toPDFSearchViewportBox = (
  box: PDFSearchBox,
  viewport: Pick<PageViewport, "convertToViewportPoint">,
): PDFSearchViewportBox | null => {
  const parsePoint = (value: unknown) => {
    if (!Array.isArray(value)) {
      return null;
    }
    const x: unknown = value.at(0);
    const y: unknown = value.at(1);
    if (typeof x !== "number" || typeof y !== "number") {
      return null;
    }
    return { x, y };
  };
  const start = parsePoint(viewport.convertToViewportPoint(box.x, box.y));
  const end = parsePoint(
    viewport.convertToViewportPoint(box.x + box.width, box.y + box.height),
  );
  if (!start || !end) {
    return null;
  }

  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
};

/** One page's search text, by its 1-based number in the document. */
export type NumberedPageSearchText = PageSearchText & { pageNumber: number };

type ExtractPDFPageSearchTextsOptions = {
  bytes: Uint8Array;
  /** 1-based; a number past the last page is skipped. */
  pageNumbers: readonly number[];
  signal: AbortSignal;
};

/**
 * The search text of the document's own pages, read the way the server reads
 * a PDF for verification (`PDF.load(bytes)`, then each page's
 * `extractText()`), so a server offset into page N's text indexes the same
 * unit here. Embedded portfolio PDFs are not opened.
 */
export const extractPDFPageSearchTexts = async ({
  bytes,
  pageNumbers,
  signal,
}: ExtractPDFPageSearchTextsOptions): Promise<NumberedPageSearchText[]> => {
  signal.throwIfAborted();
  const { PDF } = await import("@libpdf/core");
  const pdf = await PDF.load(bytes);
  signal.throwIfAborted();
  const pages = pdf.getPages();
  const texts: NumberedPageSearchText[] = [];
  for (const pageNumber of new Set(pageNumbers)) {
    signal.throwIfAborted();
    const page = pages.at(pageNumber - 1);
    if (pageNumber < 1 || page === undefined) {
      continue;
    }
    texts.push({ pageNumber, ...readPdfPageGlyphText(page.extractText()) });
  }
  return texts;
};
