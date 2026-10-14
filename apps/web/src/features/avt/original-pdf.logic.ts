/**
 * Where a verification's claims sit on the original PDF's pages.
 *
 * The server stored each page's text exactly as LibPDF extracts it
 * (`page.text`: the lines of span characters joined by "\n"), and a claim's
 * offsets are UTF-16 units into that text. The viewer reads the same bytes
 * with the same extractor and keeps the glyph box behind every unit, so when
 * the page text it reads equals the stored text, a claim's offsets are the
 * viewer's offsets unchanged. When the two differ (the field now holds a
 * different file, an extractor change), the claim's own words are looked for
 * on the page and the occurrence nearest the stored offset wins; a claim whose
 * words are not on the page is reported rather than drawn somewhere near.
 */

import { findSearchMatchRanges } from "@stll/text-normalize";

import type { VerificationClaim, VerificationRun } from "@/features/avt/types";
import { mergePDFSearchBoxes } from "@/lib/pdf/pdf-search";
import type { PageSearchText, PDFSearchBox } from "@/lib/pdf/pdf-search";

type VerificationBlock = VerificationRun["blocks"][number];
type ClaimId = VerificationClaim["id"];

type TextRange = { start: number; end: number };

/** One claim's words as boxes on its page, in PDF user space. */
export type LocatedPdfClaim = {
  claimId: ClaimId;
  pageNumber: number;
  boxes: PDFSearchBox[];
};

export type PdfClaimLocations = {
  located: LocatedPdfClaim[];
  /** Claims with no place in the original, in reading order. */
  unlocated: ClaimId[];
};

const occurrences = (text: string, needle: string): TextRange[] => {
  const ranges: TextRange[] = [];
  let from = text.indexOf(needle);
  while (from !== -1) {
    ranges.push({ start: from, end: from + needle.length });
    from = text.indexOf(needle, from + 1);
  }
  return ranges;
};

/**
 * Where a range of the stored page text sits in the page text the viewer
 * read. Identical texts map one to one; otherwise the stored words are found
 * verbatim, then with the search folds (case, diacritics), nearest the stored
 * offset first.
 */
export const translatePageRange = ({
  stored,
  page,
  start,
  end,
}: {
  stored: string;
  page: string;
  start: number;
  end: number;
}): TextRange | null => {
  if (start < 0 || end > stored.length || start >= end) {
    return null;
  }
  if (stored === page) {
    return { start, end };
  }
  const needle = stored.slice(start, end);
  if (needle.trim().length === 0) {
    return null;
  }
  const exact = occurrences(page, needle);
  const candidates =
    exact.length > 0 ? exact : findSearchMatchRanges(page, needle);
  let nearest: TextRange | null = null;
  for (const candidate of candidates) {
    if (
      nearest === null ||
      Math.abs(candidate.start - start) < Math.abs(nearest.start - start)
    ) {
      nearest = { start: candidate.start, end: candidate.end };
    }
  }
  return nearest;
};

/** The merged glyph boxes of a range of the viewer's page text. */
export const boxesForRange = (
  page: PageSearchText,
  range: TextRange,
): PDFSearchBox[] =>
  mergePDFSearchBoxes(
    page.boxesByOffset
      .slice(range.start, range.end)
      .filter((box): box is PDFSearchBox => box !== null),
  );

/** The pages the run's PDF claims sit on, ascending. */
export const claimPageNumbers = (
  claims: readonly Pick<VerificationClaim, "anchor">[],
): number[] =>
  [
    ...new Set(
      claims.flatMap((claim) =>
        claim.anchor.type === "pdf-page" ? [claim.anchor.pageNumber] : [],
      ),
    ),
  ].toSorted((a, b) => a - b);

type ResolvePdfClaimLocationsArgs = Omit<LocateClaimsOnPagesArgs, "pages"> & {
  /** The page texts once read; undefined while reading or skipped. */
  pages: ReadonlyMap<number, PageSearchText> | undefined;
  /** The file or its page texts could not be read. */
  failed: boolean;
};

/**
 * The claims' places once they are known, or null while the page texts are
 * still being read. A run with no claim on a PDF page reads no page text: every
 * claim is unlocated at once, as is every claim of a file that cannot be read.
 */
export const resolvePdfClaimLocations = ({
  pages,
  failed,
  blocks,
  claims,
}: ResolvePdfClaimLocationsArgs): PdfClaimLocations | null => {
  if (claimPageNumbers(claims).length === 0) {
    return locateClaimsOnPages({ pages: new Map(), blocks, claims });
  }
  if (pages !== undefined) {
    return locateClaimsOnPages({ pages, blocks, claims });
  }
  if (failed) {
    return locateClaimsOnPages({ pages: new Map(), blocks, claims });
  }
  return null;
};

type LocateClaimsOnPagesArgs = {
  /** The viewer's text of each page, by 1-based page number. */
  pages: ReadonlyMap<number, PageSearchText>;
  blocks: readonly VerificationBlock[];
  claims: readonly Pick<VerificationClaim, "id" | "position" | "anchor">[];
};

/** Resolve every claim to boxes on the page the viewer draws. */
export const locateClaimsOnPages = ({
  pages,
  blocks,
  claims,
}: LocateClaimsOnPagesArgs): PdfClaimLocations => {
  const storedByPage = new Map<number, string>();
  for (const block of blocks) {
    if (block.kind === "pdf-page" && block.pageNumber !== null) {
      storedByPage.set(block.pageNumber, block.text);
    }
  }
  const located: LocatedPdfClaim[] = [];
  const unlocated: ClaimId[] = [];
  for (const claim of claims.toSorted((a, b) => a.position - b.position)) {
    const { anchor } = claim;
    const stored =
      anchor.type === "pdf-page" ? storedByPage.get(anchor.pageNumber) : null;
    const page =
      anchor.type === "pdf-page" ? pages.get(anchor.pageNumber) : undefined;
    const range =
      anchor.type !== "pdf-page" ||
      stored === undefined ||
      stored === null ||
      page === undefined
        ? null
        : translatePageRange({
            stored,
            page: page.text,
            start: anchor.start,
            end: anchor.end,
          });
    const boxes =
      range === null || page === undefined ? [] : boxesForRange(page, range);
    if (anchor.type !== "pdf-page" || boxes.length === 0) {
      unlocated.push(claim.id);
      continue;
    }
    located.push({ claimId: claim.id, pageNumber: anchor.pageNumber, boxes });
  }
  return { located, unlocated };
};
