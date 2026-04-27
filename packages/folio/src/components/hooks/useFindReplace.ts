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
  /** Current document state from history */
  documentState: Document | null;
  /** Ref to the scrollable container for scrollToMatch */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Callback to push a new document state */
  handleDocumentChange: (newDoc: Document) => void;
  /** Dialog state manager from useFindReplace (dialogs) */
  findReplace: FindReplaceStateReturn;
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
  containerRef,
  handleDocumentChange,
  findReplace,
}: UseFindReplaceParams): UseFindReplaceReturn {
  // Store the current find result for navigation
  const findResultRef = useRef<FindResult | null>(null);

  // Handle find operation
  const handleFind = useCallback(
    (searchText: string, options: FindOptions): FindResult | null => {
      if (!documentState || !searchText.trim()) {
        findResultRef.current = null;
        return null;
      }

      const matches = findInDocument(documentState, searchText, options);
      const result: FindResult = {
        matches,
        totalCount: matches.length,
        currentIndex: 0,
      };

      findResultRef.current = result;
      findReplace.setMatches(matches, 0);

      // Scroll to first match
      if (matches.length > 0 && containerRef.current) {
        // SAFETY: length > 0 guarantees index 0 exists
        scrollToMatch(containerRef.current, matches[0]!);
      }

      return result;
    },
    [documentState, findReplace, containerRef],
  );

  // Handle find next
  const handleFindNext = useCallback((): FindMatch | null => {
    if (!findResultRef.current || findResultRef.current.matches.length === 0) {
      return null;
    }

    const newIndex = findReplace.goToNextMatch();
    const match = findResultRef.current.matches[newIndex];

    // Scroll to the match
    if (match && containerRef.current) {
      scrollToMatch(containerRef.current, match);
    }

    return match || null;
  }, [findReplace, containerRef]);

  // Handle find previous
  const handleFindPrevious = useCallback((): FindMatch | null => {
    if (!findResultRef.current || findResultRef.current.matches.length === 0) {
      return null;
    }

    const newIndex = findReplace.goToPreviousMatch();
    const match = findResultRef.current.matches[newIndex];

    // Scroll to the match
    if (match && containerRef.current) {
      scrollToMatch(containerRef.current, match);
    }

    return match || null;
  }, [findReplace, containerRef]);

  // Handle replace current match
  const handleReplace = useCallback(
    (replaceText: string): boolean => {
      if (
        !documentState ||
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
          documentState,
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
    [documentState, handleDocumentChange],
  );

  // Handle replace all matches
  const handleReplaceAll = useCallback(
    (searchText: string, replaceText: string, options: FindOptions): number => {
      if (!documentState || !searchText.trim()) {
        return 0;
      }

      // Find all matches first
      const matches = findInDocument(documentState, searchText, options);
      if (matches.length === 0) {
        return 0;
      }

      // Replace from end to start to maintain correct indices
      let doc = documentState;
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
      findReplace.setMatches([], 0);

      return matches.length;
    },
    [documentState, handleDocumentChange, findReplace],
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
