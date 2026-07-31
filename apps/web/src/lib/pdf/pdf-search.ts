import type { PDFPage } from "@libpdf/core";

import type { PageViewport } from "@/lib/pdf/pdfjs-loader";
import { MAX_SEARCH_PREVIEW_MATCHES } from "@/lib/search-match-navigation";
import {
  findNormalizedSearchTextMatches,
  getSearchTextCandidates,
} from "@/lib/search-text";

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
  searchText: string;
  signal: AbortSignal;
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

const findNormalizedPageMatches = (
  page: PDFPage,
  candidate: string,
): PDFSearchMatch[] => {
  const pageSearchText = buildPageSearchText(page.extractText());

  return findNormalizedSearchTextMatches(pageSearchText.text, candidate)
    .map((match) => {
      const boxes = pageSearchText.boxesByOffset
        .slice(match.start, match.end)
        .filter((box): box is PDFSearchBox => box !== null);
      return {
        pageIndex: page.index,
        boxes: mergePDFSearchBoxes(boxes),
      };
    })
    .filter((match) => match.boxes.length > 0);
};

const findPageMatches = (
  page: PDFPage,
  candidate: string,
): PDFSearchMatch[] => {
  const exactMatches = page
    .findText(candidate, { caseSensitive: false })
    .map((match) => ({
      pageIndex: page.index,
      boxes: mergePDFSearchBoxes(
        match.charBoxes.length > 0 ? match.charBoxes : [match.bbox],
      ),
    }));
  const matches = new Map<string, PDFSearchMatch>();

  for (const match of [
    ...exactMatches,
    ...findNormalizedPageMatches(page, candidate),
  ]) {
    if (match.boxes.length > 0) {
      matches.set(getPDFSearchMatchKey(match), match);
    }
  }

  return [...matches.values()].toSorted(comparePDFSearchMatches);
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

  const pages = pdf.getPages();
  const candidates = getSearchTextCandidates(searchText);

  const findCandidateMatches = (candidate: string) => {
    const matches: PDFSearchMatch[] = [];

    for (const page of pages) {
      signal.throwIfAborted();
      matches.push(...findPageMatches(page, candidate));
      if (matches.length >= MAX_SEARCH_PREVIEW_MATCHES) {
        return {
          matches: matches.slice(0, MAX_SEARCH_PREVIEW_MATCHES),
          truncated: true,
        };
      }
    }

    return { matches, truncated: false };
  };

  const phraseCandidate = candidates.at(0);
  const phraseResult = phraseCandidate
    ? findCandidateMatches(phraseCandidate)
    : { matches: [], truncated: false };
  if (phraseResult.matches.length > 0 || candidates.length <= 1) {
    return phraseResult.matches.length > 0 ? phraseResult : null;
  }

  const matches = new Map<string, PDFSearchMatch>();
  for (const candidate of candidates.slice(1)) {
    const candidateResult = findCandidateMatches(candidate);
    for (const match of candidateResult.matches) {
      matches.set(getPDFSearchMatchKey(match), match);
      if (matches.size >= MAX_SEARCH_PREVIEW_MATCHES) {
        return {
          matches: [...matches.values()]
            .toSorted(comparePDFSearchMatches)
            .slice(0, MAX_SEARCH_PREVIEW_MATCHES),
          truncated: true,
        };
      }
    }
  }

  if (matches.size === 0) {
    return null;
  }

  return {
    matches: [...matches.values()].toSorted(comparePDFSearchMatches),
    truncated: false,
  };
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
