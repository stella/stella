/**
 * useFindReplace Hook
 *
 * Encapsulates the document-level find/replace handlers that were previously
 * inline in DocxEditor.tsx. The dialog state itself is managed by
 * `useFindReplace` from `dialogs/useFindReplace.ts`; this hook layers the
 * document-aware operations (find, replace, scroll-to-match) on top.
 */

import { useRef, useCallback } from "react";

import type { Document } from "../../core/types/document";
import { replaceTextInDocument } from "../../core/utils/replaceText";
import { getAdjacentFindIndex } from "../dialogs/findReplaceInteraction";
import { findInDocument, scrollToMatch } from "../dialogs/findReplaceUtils";
import type {
  FindMatch,
  FindOptions,
  FindResult,
} from "../dialogs/findReplaceUtils";
import type { UseFindReplaceReturn as FindReplaceStateReturn } from "../dialogs/useFindReplace";

// ============================================================================
// TYPES
// ============================================================================

type UseFindReplaceParams = {
  /** Current document state fallback for existing mounted callers during HMR */
  documentState?: Document | null;
  /** Returns the current live document state from the editor */
  getDocumentState?: () => Document | null;
  /** Ref to the scrollable container for scrollToMatch */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Callback to push a new document state */
  handleDocumentChange: (newDoc: Document) => void;
  /** Dialog state manager from useFindReplace (dialogs) */
  findReplace: FindReplaceStateReturn;
  /** Select and reveal a match in the live editor */
  selectMatch?: (match: FindMatch) => boolean;
};

export type UseFindReplaceReturn = {
  /** Ref holding the current find result (needed by FindReplaceDialog) */
  findResultRef: React.RefObject<FindResult | null>;
  /** Execute a find operation */
  handleFind: (searchText: string, options: FindOptions) => FindResult | null;
  /** Navigate to the next match */
  handleFindNext: () => FindMatch | null;
  /** Navigate to the previous match */
  handleFindPrevious: () => FindMatch | null;
  /** Replace the current match */
  handleReplace: (replaceText: string) => boolean;
  /** Replace all matches */
  handleReplaceAll: (
    searchText: string,
    replaceText: string,
    options: FindOptions,
  ) => number;
};

// ============================================================================
// HOOK
// ============================================================================

export function useFindReplace({
  documentState,
  getDocumentState,
  containerRef,
  handleDocumentChange,
  findReplace,
  selectMatch,
}: UseFindReplaceParams): UseFindReplaceReturn {
  // Store the current find result for navigation
  const findResultRef = useRef<FindResult | null>(null);
  const { setMatches, goToMatch } = findReplace;

  const readDocumentState = useCallback(
    () => getDocumentState?.() ?? documentState ?? null,
    [getDocumentState, documentState],
  );

  // Handle find operation
  const handleFind = useCallback(
    (searchText: string, options: FindOptions): FindResult | null => {
      const currentDocument = readDocumentState();
      if (!currentDocument || !searchText.trim()) {
        findResultRef.current = null;
        return null;
      }

      const matches = findInDocument(currentDocument, searchText, options);
      const result: FindResult = {
        matches,
        totalCount: matches.length,
        currentIndex: 0,
      };

      findResultRef.current = result;
      setMatches(matches, 0);

      // Scroll to first match
      if (matches.length > 0) {
        // SAFETY: length > 0 guarantees index 0 exists
        const firstMatch = matches[0]!;
        if (!selectMatch?.(firstMatch) && containerRef.current) {
          scrollToMatch(containerRef.current, firstMatch);
        }
      }

      return result;
    },
    [readDocumentState, setMatches, containerRef, selectMatch],
  );

  // Handle find next
  const handleFindNext = useCallback((): FindMatch | null => {
    const currentResult = findResultRef.current;
    if (!currentResult || currentResult.matches.length === 0) {
      return null;
    }

    const newIndex = getAdjacentFindIndex(
      currentResult.currentIndex,
      currentResult.matches.length,
      "next",
    );
    const match = currentResult.matches[newIndex];
    findResultRef.current = {
      ...currentResult,
      currentIndex: newIndex,
    };
    goToMatch(newIndex);

    // Scroll to the match
    if (match && !selectMatch?.(match) && containerRef.current) {
      scrollToMatch(containerRef.current, match);
    }

    return match || null;
  }, [goToMatch, containerRef, selectMatch]);

  // Handle find previous
  const handleFindPrevious = useCallback((): FindMatch | null => {
    const currentResult = findResultRef.current;
    if (!currentResult || currentResult.matches.length === 0) {
      return null;
    }

    const newIndex = getAdjacentFindIndex(
      currentResult.currentIndex,
      currentResult.matches.length,
      "previous",
    );
    const match = currentResult.matches[newIndex];
    findResultRef.current = {
      ...currentResult,
      currentIndex: newIndex,
    };
    goToMatch(newIndex);

    // Scroll to the match
    if (match && !selectMatch?.(match) && containerRef.current) {
      scrollToMatch(containerRef.current, match);
    }

    return match || null;
  }, [goToMatch, containerRef, selectMatch]);

  // Handle replace current match
  const handleReplace = useCallback(
    (replaceText: string): boolean => {
      const currentDocument = readDocumentState();
      if (
        !currentDocument ||
        !findResultRef.current ||
        findResultRef.current.matches.length === 0
      ) {
        return false;
      }

      const currentMatch =
        findResultRef.current.matches[findResultRef.current.currentIndex];
      if (!currentMatch) {
        return false;
      }

      // Execute replace command
      try {
        const newDoc = replaceTextInDocument(
          currentDocument,
          {
            start: {
              paragraphIndex: currentMatch.paragraphIndex,
              offset: currentMatch.startOffset,
            },
            end: {
              paragraphIndex: currentMatch.paragraphIndex,
              offset: currentMatch.endOffset,
            },
          },
          replaceText,
        );

        handleDocumentChange(newDoc);
        return true;
      } catch {
        return false;
      }
    },
    [readDocumentState, handleDocumentChange],
  );

  // Handle replace all matches
  const handleReplaceAll = useCallback(
    (searchText: string, replaceText: string, options: FindOptions): number => {
      const currentDocument = readDocumentState();
      if (!currentDocument || !searchText.trim()) {
        return 0;
      }

      // Find all matches first
      const matches = findInDocument(currentDocument, searchText, options);
      if (matches.length === 0) {
        return 0;
      }

      // Replace from end to start to maintain correct indices
      let doc = currentDocument;
      const sortedMatches = [...matches].toSorted((a, b) => {
        if (a.paragraphIndex !== b.paragraphIndex) {
          return b.paragraphIndex - a.paragraphIndex;
        }
        return b.startOffset - a.startOffset;
      });

      for (const match of sortedMatches) {
        try {
          doc = replaceTextInDocument(
            doc,
            {
              start: {
                paragraphIndex: match.paragraphIndex,
                offset: match.startOffset,
              },
              end: {
                paragraphIndex: match.paragraphIndex,
                offset: match.endOffset,
              },
            },
            replaceText,
          );
        } catch {
          continue;
        }
      }

      handleDocumentChange(doc);
      findResultRef.current = null;
      setMatches([], 0);

      return matches.length;
    },
    [readDocumentState, handleDocumentChange, setMatches],
  );

  return {
    findResultRef,
    handleFind,
    handleFindNext,
    handleFindPrevious,
    handleReplace,
    handleReplaceAll,
  };
}
