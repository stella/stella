import { useEffect, useRef } from "react";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { Separator } from "@stll/ui/components/separator";
import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import Tooltip from "@/components/tooltip";
import { useCaseSearchStore } from "@/lib/case-search-store";

const FIND_HOTKEY = "Mod+F";

export const CaseSearchTrigger = () => {
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement>(null);
  const {
    isOpen,
    focusSeq,
    query,
    matchCount,
    activeMatchIndex,
    open,
    close,
    setQuery,
    goToNext,
    goToPrevious,
  } = useCaseSearchStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      focusSeq: s.focusSeq,
      query: s.query,
      matchCount: s.matchCount,
      activeMatchIndex: s.activeMatchIndex,
      open: s.open,
      close: s.close,
      setQuery: s.setQuery,
      goToNext: s.goToNext,
      goToPrevious: s.goToPrevious,
    })),
  );

  useHotkey(FIND_HOTKEY, open);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [focusSeq, isOpen]);

  if (!isOpen) {
    return (
      <Tooltip
        content={
          <span className="inline-flex items-center gap-2">
            <span>{t("navigation.search")}</span>
            <kbd className="bg-muted text-muted-foreground rounded border px-1.5 py-0.5 text-[0.625rem]">
              {formatForDisplay(FIND_HOTKEY)}
            </kbd>
          </span>
        }
        render={
          <Button
            aria-label={t("navigation.search")}
            onClick={open}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <SearchIcon className="size-4" />
      </Tooltip>
    );
  }

  const hasQuery = query.trim().length > 0;

  return (
    <div className="flex items-center gap-0.5">
      <SearchIcon className="text-muted-foreground me-2 size-4 shrink-0" />
      <Input
        aria-label={t("navigation.search")}
        className="h-7 w-44 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            // Skip while an IME candidate window is open (CJK
            // composition). Enter commits the candidate there
            // and shouldn't also jump to the next match.
            if (event.nativeEvent.isComposing) {
              return;
            }
            event.preventDefault();
            if (event.shiftKey) {
              goToPrevious();
            } else {
              goToNext();
            }
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        placeholder={t("common.search")}
        ref={inputRef}
        value={query}
      />
      {hasQuery && (
        <div className="text-muted-foreground px-1 text-end font-sans text-xs tabular-nums">
          {matchCount === 0
            ? t("common.noResults")
            : `${activeMatchIndex + 1} / ${matchCount}`}
        </div>
      )}
      <Tooltip
        content={t("common.previous")}
        render={
          <Button
            aria-label={t("common.previous")}
            disabled={matchCount === 0}
            onClick={goToPrevious}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <ChevronUpIcon className="size-4" />
      </Tooltip>
      <Tooltip
        content={t("common.next")}
        render={
          <Button
            aria-label={t("common.next")}
            disabled={matchCount === 0}
            onClick={goToNext}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <ChevronDownIcon className="size-4" />
      </Tooltip>
      <Tooltip
        content={t("common.done")}
        render={
          <Button
            aria-label={t("common.done")}
            onClick={close}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <XIcon className="size-4" />
      </Tooltip>
      <Separator className="mx-1 h-4" orientation="vertical" />
    </div>
  );
};
