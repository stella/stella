import type { Document } from "@stll/folio-core";
import { getAllParagraphs } from "@stll/folio-core/docx/documentParser";
import { getParagraphPlainText } from "@stll/folio-core/docx/serializer/paragraphSerializer";
import {
  createDefaultFindOptions,
  findAllMatches,
  findInParagraph,
} from "@stll/folio-core/utils/findReplace";
import type { FindMatch } from "@stll/folio-core/utils/findReplace";

import {
  findNormalizedSearchTextMatches,
  getSearchTextCandidates,
} from "@/lib/search-text";
import type { SearchTextMatch } from "@/lib/search-text";

export {
  findNormalizedSearchTextMatches,
  getSearchTextCandidates,
  normalizeSearchText,
} from "@/lib/search-text";

const documentSearchOptions = createDefaultFindOptions();

const searchTextMatchKey = ({ end, start }: SearchTextMatch) =>
  `${String(start)}:${String(end)}`;

const sortSearchTextMatches = (
  first: SearchTextMatch,
  second: SearchTextMatch,
) => first.start - second.start || first.end - second.end;

const findTextCandidateMatches = (content: string, candidate: string) => {
  const exactMatches = findAllMatches(
    content,
    candidate,
    documentSearchOptions,
  );
  return exactMatches.length > 0
    ? exactMatches
    : findNormalizedSearchTextMatches(content, candidate);
};

export const findSearchTextMatches = (content: string, searchText: string) => {
  const candidates = getSearchTextCandidates(searchText);
  const phraseCandidate = candidates.at(0);
  const phraseMatches = phraseCandidate
    ? findTextCandidateMatches(content, phraseCandidate)
    : [];
  if (phraseMatches.length > 0 || candidates.length <= 1) {
    return phraseMatches;
  }

  const matches = new Map<string, SearchTextMatch>();
  for (const candidate of candidates.slice(1)) {
    for (const match of findTextCandidateMatches(content, candidate)) {
      matches.set(searchTextMatchKey(match), match);
    }
  }
  return [...matches.values()].toSorted(sortSearchTextMatches);
};

const documentMatchKey = ({
  endOffset,
  paragraphIndex,
  startOffset,
}: FindMatch) =>
  `${String(paragraphIndex)}:${String(startOffset)}:${String(endOffset)}`;

const sortDocumentMatches = (first: FindMatch, second: FindMatch) =>
  first.paragraphIndex - second.paragraphIndex ||
  first.startOffset - second.startOffset ||
  first.endOffset - second.endOffset;

type FindDocumentCandidateMatchesOptions = {
  candidate: string;
  document: Document;
  limit: number;
};

const findDocumentCandidateMatches = ({
  candidate,
  document,
  limit,
}: FindDocumentCandidateMatchesOptions): FindMatch[] => {
  const paragraphs = getAllParagraphs(document.package.document);
  const matches: FindMatch[] = [];

  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    for (const match of findInParagraph(
      paragraph,
      candidate,
      documentSearchOptions,
      paragraphIndex,
    )) {
      matches.push(match);
      if (matches.length >= limit) {
        return matches;
      }
    }
  }
  if (matches.length > 0) {
    return matches;
  }

  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const paragraphText = getParagraphPlainText(paragraph);
    for (const normalizedMatch of findNormalizedSearchTextMatches(
      paragraphText,
      candidate,
    )) {
      const originalText = paragraphText.slice(
        normalizedMatch.start,
        normalizedMatch.end,
      );
      const match = findInParagraph(
        paragraph,
        originalText,
        documentSearchOptions,
        paragraphIndex,
      ).find(
        (item) =>
          item.startOffset === normalizedMatch.start &&
          item.endOffset === normalizedMatch.end,
      );
      if (match) {
        matches.push(match);
        if (matches.length >= limit) {
          return matches;
        }
      }
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
  searchText: string;
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
  const phraseCandidate = candidates.at(0);
  const phraseMatches = phraseCandidate
    ? findDocumentCandidateMatches({
        candidate: phraseCandidate,
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

  const matches = new Map<string, FindMatch>();
  let truncated = false;
  for (const candidate of candidates.slice(1)) {
    const candidateMatches = findDocumentCandidateMatches({
      candidate,
      document,
      limit: collectionLimit,
    });
    const candidateWasTruncated =
      candidateMatches.length > normalizedMaxMatches;
    for (const match of candidateMatches) {
      matches.set(documentMatchKey(match), match);
      if (matches.size > normalizedMaxMatches) {
        truncated = true;
        break;
      }
    }
    if (truncated) {
      break;
    }
    if (candidateWasTruncated) {
      truncated = true;
      break;
    }
  }

  return {
    matches: [...matches.values()]
      .toSorted(sortDocumentMatches)
      .slice(0, normalizedMaxMatches),
    truncated,
  };
};

export const findDocumentSearchMatches = (
  document: Document | null,
  searchText: string,
) =>
  findDocumentSearchResult({
    document,
    searchText,
    maxMatches: Number.MAX_SAFE_INTEGER,
  }).matches;

export const findFirstDocumentSearchMatch = (
  document: Document | null,
  searchText: string,
) =>
  findDocumentSearchResult({ document, searchText, maxMatches: 1 }).matches.at(
    0,
  ) ?? null;
