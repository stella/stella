/**
 * Find and Replace Dialog Component
 *
 * Modal dialog for searching and replacing text in the document.
 * Supports find, find next/previous, replace, and replace all operations.
 *
 * Logic and utilities are in separate files:
 * - findReplaceUtils.ts — Pure search/replace functions and types
 * - useFindReplace.ts   — React hook for dialog state management
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { CSSProperties, KeyboardEvent, ChangeEvent } from "react";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { Input } from "@stll/ui/components/input";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { FindOptions, FindResult, FindMatch } from "./findReplaceUtils";

// Re-export types and utilities so existing imports still work
export type {
  FindMatch,
  FindOptions,
  FindResult,
  HighlightOptions,
} from "./findReplaceUtils";
export {
  createDefaultFindOptions,
  findAllMatches,
  escapeRegexString,
  createSearchPattern,
  replaceAllInContent,
  replaceFirstInContent,
  getMatchCountText,
  isEmptySearch,
  getDefaultHighlightOptions,
  findInDocument,
  findInParagraph,
  scrollToMatch,
} from "./findReplaceUtils";

export type {
  FindReplaceOptions,
  FindReplaceState,
  UseFindReplaceReturn,
} from "./useFindReplace";
export { useFindReplace } from "./useFindReplace";

// ============================================================================
// PROPS
// ============================================================================

/**
 * Props for the FindReplaceDialog component
 */
export type FindReplaceDialogProps = {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when dialog is closed */
  onClose: () => void;
  /** Callback when searching for text */
  onFind: (searchText: string, options: FindOptions) => FindResult | null;
  /** Callback when navigating to next match */
  onFindNext: () => FindMatch | null;
  /** Callback when navigating to previous match */
  onFindPrevious: () => FindMatch | null;
  /** Callback when replacing current match */
  onReplace: (replaceText: string) => boolean;
  /** Callback when replacing all matches */
  onReplaceAll: (
    searchText: string,
    replaceText: string,
    options: FindOptions,
  ) => number;
  /** Callback to highlight matches in document */
  onHighlightMatches?: (matches: FindMatch[]) => void;
  /** Callback to clear highlights */
  onClearHighlights?: () => void;
  /** Initial search text (e.g., from selected text) */
  initialSearchText?: string;
  /** Whether to start in replace mode */
  replaceMode?: boolean;
  /** Current match result (from external state) */
  currentResult?: FindResult | null;
  /** Additional CSS class */
  className?: string;
  /** Additional inline styles */
  style?: CSSProperties;
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * FindReplaceDialog component - Modal for finding and replacing text
 */
export function FindReplaceDialog({
  isOpen,
  onClose,
  onFind,
  onFindNext,
  onFindPrevious,
  onReplace,
  onReplaceAll,
  onHighlightMatches,
  onClearHighlights,
  initialSearchText = "",
  replaceMode = false,
  currentResult,
  className,
  style,
}: FindReplaceDialogProps): React.ReactElement | null {
  const t = useTranslations("folio");
  // State
  const [searchText, setSearchText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showReplace, setShowReplace] = useState(replaceMode);
  const [matchCase, setMatchCase] = useState(false);
  const [matchWholeWord, setMatchWholeWord] = useState(false);
  const [result, setResult] = useState<FindResult | null>(null);

  // Refs
  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Sync with external result if provided
  useEffect(() => {
    if (currentResult !== undefined) {
      setResult(currentResult);
    }
  }, [currentResult]);

  // Initialize when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSearchText(initialSearchText);
      setReplaceText("");
      setShowReplace(replaceMode);
      setResult(null);

      setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 100);

      if (initialSearchText) {
        const searchResult = onFind(initialSearchText, {
          matchCase,
          matchWholeWord,
        });
        setResult(searchResult);
        if (searchResult?.matches && onHighlightMatches) {
          onHighlightMatches(searchResult.matches);
        }
      }
    } else if (onClearHighlights) {
      onClearHighlights();
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialSearchText, replaceMode]);

  const performSearch = useCallback(() => {
    if (!searchText.trim()) {
      setResult(null);
      if (onClearHighlights) {
        onClearHighlights();
      }
      return;
    }

    const searchResult = onFind(searchText, { matchCase, matchWholeWord });
    setResult(searchResult);

    if (searchResult?.matches && onHighlightMatches) {
      onHighlightMatches(searchResult.matches);
    } else if (onClearHighlights) {
      onClearHighlights();
    }
  }, [
    searchText,
    matchCase,
    matchWholeWord,
    onFind,
    onHighlightMatches,
    onClearHighlights,
  ]);

  useEffect(() => {
    if (isOpen && searchText.trim()) {
      performSearch();
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [matchCase, matchWholeWord]);

  const handleSearchChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setSearchText(e.target.value);
  }, []);

  const handleSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          handleFindPrevious();
        } else if (!result) {
          performSearch();
        } else {
          handleFindNext();
        }
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [result, performSearch, onClose],
  );

  const handleReplaceKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleReplace();
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [onClose],
  );

  const handleFindNext = useCallback(() => {
    if (!searchText.trim()) {
      performSearch();
      return;
    }

    if (!result) {
      performSearch();
      return;
    }

    const match = onFindNext();
    if (match && result) {
      const newIndex = (result.currentIndex + 1) % result.totalCount;
      setResult({
        ...result,
        currentIndex: newIndex,
      });
    }
  }, [searchText, result, performSearch, onFindNext]);

  const handleFindPrevious = useCallback(() => {
    if (!searchText.trim()) {
      performSearch();
      return;
    }

    if (!result) {
      performSearch();
      return;
    }

    const match = onFindPrevious();
    if (match && result) {
      const newIndex =
        result.currentIndex === 0
          ? result.totalCount - 1
          : result.currentIndex - 1;
      setResult({
        ...result,
        currentIndex: newIndex,
      });
    }
  }, [searchText, result, performSearch, onFindPrevious]);

  const handleReplace = useCallback(() => {
    if (!result || result.totalCount === 0) {
      return;
    }

    const success = onReplace(replaceText);
    if (success) {
      const newResult = onFind(searchText, { matchCase, matchWholeWord });
      setResult(newResult);
      if (newResult?.matches && onHighlightMatches) {
        onHighlightMatches(newResult.matches);
      }
    }
  }, [
    result,
    replaceText,
    searchText,
    matchCase,
    matchWholeWord,
    onReplace,
    onFind,
    onHighlightMatches,
  ]);

  const handleReplaceAll = useCallback(() => {
    if (!searchText.trim()) {
      return;
    }

    const count = onReplaceAll(searchText, replaceText, {
      matchCase,
      matchWholeWord,
    });
    if (count > 0) {
      setResult({
        matches: [],
        totalCount: 0,
        currentIndex: -1,
      });
      if (onClearHighlights) {
        onClearHighlights();
      }
    }
  }, [
    searchText,
    replaceText,
    matchCase,
    matchWholeWord,
    onReplaceAll,
    onClearHighlights,
  ]);

  const toggleReplaceMode = useCallback(() => {
    setShowReplace((prev) => {
      const newValue = !prev;
      if (newValue) {
        setTimeout(() => replaceInputRef.current?.focus(), 100);
      }
      return newValue;
    });
  }, []);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      // Don't close on overlay click - this is a non-modal dialog
    }
  }, []);

  const handleDialogKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose],
  );

  if (!isOpen) {
    return null;
  }

  const hasMatches = result && result.totalCount > 0;
  const noMatches = result && result.totalCount === 0 && searchText.trim();

  return (
    <div
      role="presentation"
      className={`docx-find-replace-dialog-overlay pointer-events-none fixed inset-0 z-[10000] flex items-start justify-end bg-transparent ${className || ""}`}
      style={style}
      data-slot="folio-find-replace-overlay"
      onClick={handleOverlayClick}
      onKeyDown={handleDialogKeyDown}
    >
      <div
        className="docx-find-replace-dialog bg-popover text-popover-foreground pointer-events-auto me-5 mt-15 w-[min(440px,calc(100vw-40px))] rounded-lg border shadow-xl"
        data-testid="find-replace-dialog"
        role="dialog"
        aria-modal="false"
        aria-labelledby="find-replace-dialog-title"
      >
        <div className="bg-muted/30 flex items-center justify-between gap-3 border-b px-3 py-2">
          <h2
            id="find-replace-dialog-title"
            className="flex min-w-0 items-center gap-2 text-sm font-medium"
          >
            <SearchIcon className="text-muted-foreground size-4 shrink-0" />
            <span className="truncate">
              {showReplace
                ? t("findReplace.findAndReplace")
                : t("findReplace.find")}
            </span>
          </h2>
          <Button
            onClick={onClose}
            aria-label={t("findReplace.close")}
            size="icon-xs"
            title={t("findReplace.close")}
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>

        <div className="space-y-2 p-3">
          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-2">
            <label
              className="text-muted-foreground text-xs font-medium"
              htmlFor="find-text"
            >
              {t("findReplace.find")}
            </label>
            <Input
              ref={searchInputRef}
              id="find-text"
              nativeInput
              type="text"
              className="h-8"
              size="sm"
              value={searchText}
              onChange={handleSearchChange}
              onKeyDown={handleSearchKeyDown}
              onBlur={() => {
                if (searchText.trim() && !result) {
                  performSearch();
                }
              }}
              placeholder={t("findReplace.findPlaceholder")}
              aria-label={t("findReplace.findText")}
            />
            <div className="flex items-center gap-0.5">
              <Button
                onClick={handleFindPrevious}
                disabled={!hasMatches}
                aria-label={t("findReplace.previous")}
                title={t("findReplace.previousShortcut")}
                size="icon-xs"
                variant="ghost"
              >
                <ChevronUpIcon />
              </Button>
              <Button
                onClick={handleFindNext}
                disabled={!hasMatches}
                aria-label={t("findReplace.next")}
                title={t("findReplace.nextShortcut")}
                size="icon-xs"
                variant="ghost"
              >
                <ChevronDownIcon />
              </Button>
            </div>
          </div>

          {hasMatches && (
            <div className="text-muted-foreground ms-20 text-xs tabular-nums">
              {t("findReplace.matchCounter", {
                current: String(result.currentIndex + 1),
                total: String(result.totalCount),
              })}
            </div>
          )}
          {noMatches && (
            <div className="text-destructive ms-20 text-xs">
              {t("findReplace.noResults")}
            </div>
          )}

          {showReplace && (
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-2">
              <label
                className="text-muted-foreground text-xs font-medium"
                htmlFor="replace-text"
              >
                {t("findReplace.replace")}
              </label>
              <Input
                ref={replaceInputRef}
                id="replace-text"
                nativeInput
                type="text"
                className="h-8"
                size="sm"
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                onKeyDown={handleReplaceKeyDown}
                placeholder={t("findReplace.replacePlaceholder")}
                aria-label={t("findReplace.replaceText")}
              />
              <div className="flex items-center gap-1">
                <Button
                  onClick={handleReplace}
                  disabled={!hasMatches}
                  size="xs"
                  title={t("findReplace.replaceCurrent")}
                  variant="outline"
                >
                  {t("findReplace.replace")}
                </Button>
                <Button
                  onClick={handleReplaceAll}
                  disabled={!hasMatches}
                  size="xs"
                  title={t("findReplace.replaceAll")}
                  variant="outline"
                >
                  {t("findReplace.replaceAll")}
                </Button>
              </div>
            </div>
          )}

          <div className="ms-20 flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              <Checkbox checked={matchCase} onCheckedChange={setMatchCase} />
              {t("findReplace.matchCase")}
            </label>
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              <Checkbox
                checked={matchWholeWord}
                onCheckedChange={setMatchWholeWord}
              />
              {t("findReplace.wholeWords")}
            </label>
            {!showReplace && (
              <Button onClick={toggleReplaceMode} size="xs" variant="ghost">
                {t("findReplace.showReplace")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
