import type { Document } from "@stll/folio-core";
import { getAllParagraphs } from "@stll/folio-core/docx/documentParser";
import { getParagraphPlainText } from "@stll/folio-core/docx/serializer/paragraphSerializer";
import {
  createDefaultFindOptions,
  findAllMatches,
  findInDocument,
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

const findNormalizedDocumentCandidateMatches = (
  document: Document,
  candidate: string,
): FindMatch[] => {
  const matches: FindMatch[] = [];
  const paragraphs = getAllParagraphs(document.package.document);

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
      }
    }
  }

  return matches;
};

const findDocumentCandidateMatches = (
  document: Document,
  candidate: string,
) => {
  const exactMatches = findInDocument(
    document,
    candidate,
    documentSearchOptions,
  );
  return exactMatches.length > 0
    ? exactMatches
    : findNormalizedDocumentCandidateMatches(document, candidate);
};

export const findDocumentSearchMatches = (
  document: Document | null,
  searchText: string,
) => {
  if (!document) {
    return [];
  }

  const candidates = getSearchTextCandidates(searchText);
  const phraseCandidate = candidates.at(0);
  const phraseMatches = phraseCandidate
    ? findDocumentCandidateMatches(document, phraseCandidate)
    : [];
  if (phraseMatches.length > 0 || candidates.length <= 1) {
    return phraseMatches;
  }

  const matches = new Map<string, FindMatch>();
  for (const candidate of candidates.slice(1)) {
    for (const match of findDocumentCandidateMatches(document, candidate)) {
      matches.set(documentMatchKey(match), match);
    }
  }
  return [...matches.values()].toSorted(sortDocumentMatches);
};

export const findFirstDocumentSearchMatch = (
  document: Document | null,
  searchText: string,
) => findDocumentSearchMatches(document, searchText).at(0) ?? null;
