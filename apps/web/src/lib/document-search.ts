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
  const matches = new Map<string, SearchTextMatch>();
  for (const match of findAllMatches(
    content,
    candidate,
    documentSearchOptions,
  )) {
    matches.set(searchTextMatchKey(match), match);
  }
  for (const match of findNormalizedSearchTextMatches(content, candidate)) {
    matches.set(searchTextMatchKey(match), match);
  }
  return [...matches.values()].toSorted(sortSearchTextMatches);
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

const sortDocumentMatches = (first: FindMatch, second: FindMatch) =>
  first.paragraphIndex - second.paragraphIndex ||
  first.startOffset - second.startOffset ||
  first.endOffset - second.endOffset;

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
      const normalizedMatches = findNormalizedSearchTextMatches(
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
      const orderedParagraphMatches = [...paragraphMatches.values()]
        .toSorted(sortDocumentMatches)
        .slice(0, paragraphLimit);
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
