import type { PDF, PDFPage } from "@libpdf/core";

import type { PageViewport } from "@/lib/pdf/pdfjs-loader";
import { MAX_SEARCH_PREVIEW_MATCHES } from "@/lib/search-match-navigation";
import {
  findNormalizedSearchTextMatches,
  getSearchTextCandidates,
} from "@/lib/search-text";
import type { SearchTextQuery } from "@/lib/search-text";

export type PDFSearchBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PDFSearchMatch = {
  pageIndex: number;
  boxes: PDFSearchBox[];
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
  searchText: SearchTextQuery;
  signal: AbortSignal;
};

type ViewerSearchPage = {
  page: PDFPage;
  pageIndex: number;
};

const MIN_SAME_LINE_OVERLAP_RATIO = 0.5;
const MAX_INLINE_GAP_HEIGHT_RATIO = 0.75;

const getVerticalOverlap = (first: PDFSearchBox, second: PDFSearchBox) =>
  Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) -
      Math.max(first.y, second.y),
  );

const canMergePDFSearchBoxes = (
  current: PDFSearchBox,
  next: PDFSearchBox,
): boolean => {
  const minimumHeight = Math.min(current.height, next.height);
  const verticalOverlap = getVerticalOverlap(current, next);
  const horizontalGap = next.x - (current.x + current.width);
  const maximumInlineGap =
    Math.max(current.height, next.height) * MAX_INLINE_GAP_HEIGHT_RATIO;

  return (
    minimumHeight > 0 &&
    verticalOverlap / minimumHeight >= MIN_SAME_LINE_OVERLAP_RATIO &&
    horizontalGap <= maximumInlineGap
  );
};

export const mergePDFSearchBoxes = (
  boxes: readonly PDFSearchBox[],
): PDFSearchBox[] => {
  const merged: PDFSearchBox[] = [];

  for (const box of boxes) {
    if (box.width <= 0 || box.height <= 0) {
      continue;
    }

    const current = merged.at(-1);
    if (!current || !canMergePDFSearchBoxes(current, box)) {
      merged.push({ ...box });
      continue;
    }

    const right = Math.max(current.x + current.width, box.x + box.width);
    const top = Math.max(current.y + current.height, box.y + box.height);
    current.x = Math.min(current.x, box.x);
    current.y = Math.min(current.y, box.y);
    current.width = right - current.x;
    current.height = top - current.y;
  }

  return merged;
};

type PageText = ReturnType<PDFPage["extractText"]>;

type PageSearchText = {
  boxesByOffset: (PDFSearchBox | null)[];
  text: string;
};

const buildPageSearchText = (pageText: PageText): PageSearchText => {
  const boxesByOffset: (PDFSearchBox | null)[] = [];
  const textParts: string[] = [];

  for (const [lineIndex, line] of pageText.lines.entries()) {
    if (lineIndex > 0) {
      textParts.push("\n");
      boxesByOffset.push(null);
    }

    for (const span of line.spans) {
      for (const character of span.chars) {
        textParts.push(character.char);
        for (const _codeUnit of character.char.split("")) {
          boxesByOffset.push(character.bbox);
        }
      }
    }
  }

  return { boxesByOffset, text: textParts.join("") };
};

const getPDFSearchMatchKey = ({ boxes, pageIndex }: PDFSearchMatch): string =>
  `${String(pageIndex)}:${boxes
    .map(
      (box) =>
        `${String(box.x)}:${String(box.y)}:${String(box.width)}:${String(box.height)}`,
    )
    .join("|")}`;

const comparePDFSearchMatches = (
  first: PDFSearchMatch,
  second: PDFSearchMatch,
) => {
  if (first.pageIndex !== second.pageIndex) {
    return first.pageIndex - second.pageIndex;
  }
  const firstBox = first.boxes.at(0);
  const secondBox = second.boxes.at(0);
  if (!firstBox || !secondBox) {
    return 0;
  }
  return secondBox.y - firstBox.y || firstBox.x - secondBox.x;
};

type FindCaseInsensitiveSearchTextMatchesOptions = {
  content: string;
  maxMatches: number;
  searchText: string;
};

const findCaseInsensitiveSearchTextMatches = ({
  content,
  maxMatches,
  searchText,
}: FindCaseInsensitiveSearchTextMatchesOptions) => {
  const matches: { start: number; end: number }[] = [];
  const normalizedContent = content.toLowerCase();
  const normalizedSearchText = searchText.toLowerCase();
  let searchFrom = 0;

  while (matches.length < maxMatches) {
    const start = normalizedContent.indexOf(normalizedSearchText, searchFrom);
    if (start === -1) {
      break;
    }
    matches.push({ start, end: start + normalizedSearchText.length });
    searchFrom = start + 1;
  }

  return matches;
};

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
    boxes: mergePDFSearchBoxes(boxes),
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
  findNormalizedSearchTextMatches(pageSearchText.text, candidate, {
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
}: FindPageMatchesOptions): PDFSearchMatch[] => {
  const matches = new Map<string, PDFSearchMatch>();

  const exactMatches = findCaseInsensitiveSearchTextMatches({
    content: pageSearchText.text,
    maxMatches,
    searchText: candidate,
  });
  for (const { end, start } of exactMatches) {
    const match = toPDFSearchMatch({
      end,
      pageIndex,
      pageSearchText,
      start,
    });
    if (match.boxes.length > 0) {
      matches.set(getPDFSearchMatchKey(match), match);
    }
  }

  if (matches.size < maxMatches) {
    for (const match of findNormalizedPageMatches({
      candidate,
      maxMatches,
      pageSearchText,
      pageIndex,
    })) {
      if (match.boxes.length > 0) {
        matches.set(getPDFSearchMatchKey(match), match);
      }
      if (matches.size >= maxMatches) {
        break;
      }
    }
  }

  return [...matches.values()].toSorted(comparePDFSearchMatches);
};

const getViewerSearchPages = async (
  pdf: PDF,
  signal: AbortSignal,
): Promise<ViewerSearchPage[]> => {
  const rootPages = pdf.getPages();
  const pdfAttachments: Uint8Array[] = [];

  for (const [name, attachment] of pdf.getAttachments()) {
    signal.throwIfAborted();
    if (!attachment.filename.trim().toLowerCase().endsWith(".pdf")) {
      continue;
    }
    const content = pdf.getAttachment(name);
    if (content) {
      pdfAttachments.push(content);
    }
  }

  if (rootPages.length > 1 || pdfAttachments.length === 0) {
    return rootPages.map((page, pageIndex) => ({ page, pageIndex }));
  }

  const { PDF } = await import("@libpdf/core");
  const pages: ViewerSearchPage[] = [];
  const attachments = await Promise.all(
    pdfAttachments.map((content) => {
      signal.throwIfAborted();
      // Embedded portfolio PDFs are loaded without the container password,
      // just like the viewer's attachment loading path. Promise.all preserves
      // the name-tree order used by the viewer.
      return PDF.load(content);
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

  const pages = await getViewerSearchPages(pdf, signal);
  signal.throwIfAborted();
  const candidates = getSearchTextCandidates(searchText);
  const pageSearchTextCache = new WeakMap<PDFPage, PageSearchText>();

  const collectCandidateMatches = (
    candidate: string,
    matches: Map<string, PDFSearchMatch>,
  ): boolean => {
    for (const { page, pageIndex } of pages) {
      signal.throwIfAborted();
      const remainingMatchLimit = MAX_SEARCH_PREVIEW_MATCHES + 1 - matches.size;
      if (remainingMatchLimit <= 0) {
        return true;
      }
      let pageSearchText = pageSearchTextCache.get(page);
      if (!pageSearchText) {
        pageSearchText = buildPageSearchText(page.extractText());
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
          return true;
        }
      }
    }
    return false;
  };

  const toResult = (
    matches: ReadonlyMap<string, PDFSearchMatch>,
    truncated: boolean,
  ): PDFSearchResult => ({
    matches: [...matches.values()]
      .toSorted(comparePDFSearchMatches)
      .slice(0, MAX_SEARCH_PREVIEW_MATCHES),
    truncated,
  });

  if (typeof searchText !== "string") {
    const matches = new Map<string, PDFSearchMatch>();
    let truncated = false;
    for (const candidate of candidates) {
      truncated ||= collectCandidateMatches(candidate, matches);
      if (truncated) {
        break;
      }
    }
    return toResult(matches, truncated);
  }

  const phraseCandidate = candidates.at(0);
  const phraseMatches = new Map<string, PDFSearchMatch>();
  const phraseTruncated = phraseCandidate
    ? collectCandidateMatches(phraseCandidate, phraseMatches)
    : false;
  if (phraseMatches.size > 0 || candidates.length <= 1) {
    return phraseMatches.size > 0
      ? toResult(phraseMatches, phraseTruncated)
      : null;
  }

  const matches = new Map<string, PDFSearchMatch>();
  for (const candidate of candidates.slice(1)) {
    if (collectCandidateMatches(candidate, matches)) {
      return toResult(matches, true);
    }
  }

  if (matches.size === 0) {
    return null;
  }

  return toResult(matches, false);
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
