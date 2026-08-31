import type { Document } from "@stll/folio-core";
import { getAllParagraphs } from "@stll/folio-core/docx/documentParser";
import { getParagraphPlainText } from "@stll/folio-core/docx/serializer/paragraphSerializer";
import {
  createDefaultFindOptions,
  findInParagraph,
} from "@stll/folio-core/utils/findReplace";
import type { FindMatch } from "@stll/folio-core/utils/findReplace";
import { findSearchMatchRanges } from "@stll/text-normalize";

import {
  getSearchTextCandidates,
  selectNonOverlappingSearchMatches,
} from "@/lib/search-text";
import type { SearchTextMatch, SearchTextQuery } from "@/lib/search-text";

const documentSearchOptions = createDefaultFindOptions();

const searchTextMatchKey = ({ end, start }: SearchTextMatch) =>
  `${String(start)}:${String(end)}`;

const selectNonOverlappingSearchTextMatches = (
  matches: Iterable<SearchTextMatch>,
  maxMatches: number,
) =>
  selectNonOverlappingSearchMatches({
    getRange: ({ end, start }) => ({ end, group: 0, start }),
    matches,
    maxMatches,
  });

type FindTextCandidateMatchesOptions = {
  candidate: string;
  content: string;
  maxMatches: number;
};

const findTextCandidateMatches = ({
  candidate,
  content,
  maxMatches,
}: FindTextCandidateMatchesOptions) =>
  findSearchMatchRanges(content, candidate, { maxMatches });

type FindSearchTextMatchesOptions = {
  maxMatches?: number | undefined;
};

export const findSearchTextMatches = (
  content: string,
  searchText: SearchTextQuery,
  options: FindSearchTextMatchesOptions = {},
) => {
  const maxMatches = Math.max(
    0,
    Math.floor(options.maxMatches ?? Number.MAX_SAFE_INTEGER),
  );
  if (maxMatches === 0) {
    return [];
  }
  const candidates = getSearchTextCandidates(searchText);
  if (typeof searchText !== "string") {
    const matches = new Map<string, SearchTextMatch>();
    for (const candidate of candidates) {
      for (const match of findTextCandidateMatches({
        candidate,
        content,
        maxMatches,
      })) {
        matches.set(searchTextMatchKey(match), match);
      }
    }
    return selectNonOverlappingSearchTextMatches(matches.values(), maxMatches);
  }
  const phraseCandidate = candidates.at(0);
  const phraseMatches = phraseCandidate
    ? findTextCandidateMatches({
        candidate: phraseCandidate,
        content,
        maxMatches,
      })
    : [];
  if (phraseMatches.length > 0 || candidates.length <= 1) {
    return phraseMatches;
  }

  const matches = new Map<string, SearchTextMatch>();
  for (const candidate of candidates.slice(1)) {
    for (const match of findTextCandidateMatches({
      candidate,
      content,
      maxMatches,
    })) {
      matches.set(searchTextMatchKey(match), match);
    }
  }
  return selectNonOverlappingSearchTextMatches(matches.values(), maxMatches);
};

type DocumentMatchPosition = Pick<
  FindMatch,
  "endOffset" | "paragraphIndex" | "startOffset"
>;

const documentMatchPositionKey = ({
  endOffset,
  paragraphIndex,
  startOffset,
}: DocumentMatchPosition) =>
  `${String(paragraphIndex)}:${String(startOffset)}:${String(endOffset)}`;

const documentMatchKey = (match: FindMatch) => documentMatchPositionKey(match);

type FindDocumentCandidateMatchesOptions = {
  candidates: readonly string[];
  document: Document;
  limit: number;
};

const findDocumentCandidateMatches = ({
  candidates,
  document,
  limit,
}: FindDocumentCandidateMatchesOptions): FindMatch[] => {
  const paragraphs = getAllParagraphs(document.package.document);
  const matches: FindMatch[] = [];

  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const paragraphLimit = limit - matches.length;
    const paragraphMatches = new Map<string, FindMatch>();
    const nativeMatchesByText = new Map<string, Map<string, FindMatch>>();
    const getNativeMatches = (text: string) => {
      const cachedMatches = nativeMatchesByText.get(text);
      if (cachedMatches) {
        return cachedMatches;
      }

      const nativeMatches = new Map<string, FindMatch>();
      for (const match of findInParagraph(
        paragraph,
        text,
        documentSearchOptions,
        paragraphIndex,
      )) {
        nativeMatches.set(documentMatchKey(match), match);
        if (nativeMatches.size >= paragraphLimit) {
          break;
        }
      }
      nativeMatchesByText.set(text, nativeMatches);
      return nativeMatches;
    };
    const paragraphText = getParagraphPlainText(paragraph);
    for (const candidate of candidates) {
      const candidateMatches = new Map<string, FindMatch>();
      for (const match of getNativeMatches(candidate).values()) {
        candidateMatches.set(documentMatchKey(match), match);
      }
      const normalizedMatches = findSearchMatchRanges(
        paragraphText,
        candidate,
        { maxMatches: paragraphLimit },
      );
      for (const normalizedMatch of normalizedMatches) {
        const originalText = paragraphText.slice(
          normalizedMatch.start,
          normalizedMatch.end,
        );
        const match = getNativeMatches(originalText).get(
          documentMatchPositionKey({
            paragraphIndex,
            startOffset: normalizedMatch.start,
            endOffset: normalizedMatch.end,
          }),
        );
        if (match) {
          candidateMatches.set(documentMatchKey(match), match);
        }
      }

      for (const match of candidateMatches.values()) {
        paragraphMatches.set(documentMatchKey(match), match);
      }
      const orderedParagraphMatches = selectNonOverlappingSearchMatches({
        getRange: ({ endOffset, paragraphIndex: group, startOffset }) => ({
          end: endOffset,
          group,
          start: startOffset,
        }),
        matches: paragraphMatches.values(),
        maxMatches: paragraphLimit,
      });
      paragraphMatches.clear();
      for (const match of orderedParagraphMatches) {
        paragraphMatches.set(documentMatchKey(match), match);
      }
    }
    for (const match of paragraphMatches.values()) {
      matches.push(match);
    }
    if (matches.length >= limit) {
      return matches;
    }
  }

  return matches;
};

export type DocumentSearchResult = {
  matches: FindMatch[];
  truncated: boolean;
};

type FindDocumentSearchResultOptions = {
  document: Document | null;
  searchText: SearchTextQuery;
  maxMatches: number;
};

export const findDocumentSearchResult = ({
  document,
  searchText,
  maxMatches,
}: FindDocumentSearchResultOptions): DocumentSearchResult => {
  if (!document) {
    return { matches: [], truncated: false };
  }

  const normalizedMaxMatches = Math.max(0, Math.floor(maxMatches));
  const collectionLimit = normalizedMaxMatches + 1;
  const candidates = getSearchTextCandidates(searchText);
  if (typeof searchText !== "string") {
    const matches = findDocumentCandidateMatches({
      candidates,
      document,
      limit: collectionLimit,
    });
    return {
      matches: matches.slice(0, normalizedMaxMatches),
      truncated: matches.length > normalizedMaxMatches,
    };
  }
  const phraseCandidate = candidates.at(0);
  const phraseMatches = phraseCandidate
    ? findDocumentCandidateMatches({
        candidates: [phraseCandidate],
        document,
        limit: collectionLimit,
      })
    : [];
  if (phraseMatches.length > 0 || candidates.length <= 1) {
    return {
      matches: phraseMatches.slice(0, normalizedMaxMatches),
      truncated: phraseMatches.length > normalizedMaxMatches,
    };
  }

  const matches = findDocumentCandidateMatches({
    candidates: candidates.slice(1),
    document,
    limit: collectionLimit,
  });

  return {
    matches: matches.slice(0, normalizedMaxMatches),
    truncated: matches.length > normalizedMaxMatches,
  };
};

export const findDocumentSearchMatches = (
  document: Document | null,
  searchText: SearchTextQuery,
) =>
  findDocumentSearchResult({
    document,
    searchText,
    maxMatches: Number.MAX_SAFE_INTEGER,
  }).matches;

export const findFirstDocumentSearchMatch = (
  document: Document | null,
  searchText: SearchTextQuery,
) =>
  findDocumentSearchResult({ document, searchText, maxMatches: 1 }).matches.at(
    0,
  ) ?? null;
