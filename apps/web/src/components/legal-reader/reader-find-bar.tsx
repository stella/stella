import { useRef } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { XIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";

import { SearchMatchControls } from "@/components/search-match-controls";
import { useExternalSyncEffect } from "@/hooks/use-effect";

type ReaderFindBarProps = {
  query: string;
  activeIndex: number;
  matchCount: number;
  focusRequest: number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  truncated?: boolean | undefined;
  children?: ReactNode;
};

/** A zero-height frame anchors the overlay below any reader header without moving its text. */
export const ReaderFindBar = ({
  query,
  activeIndex,
  matchCount,
  focusRequest,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
  truncated,
  children,
}: ReaderFindBarProps) => {
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement | null>(null);
  useExternalSyncEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  return (
    <div
      className="relative z-20 h-0 w-full shrink-0"
      data-slot="reader-find-frame"
    >
      {children}
      <div
        className="bg-popover ring-border absolute end-3 top-0 flex h-10 w-80 max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-s-md rounded-b-md ps-2 shadow-md ring-1"
        data-slot="reader-find-bar"
      >
        <Input
          aria-label={t("folio.findReplace.findText")}
          className="h-7 min-w-0 flex-1"
          nativeInput
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key !== "Enter") {
              return;
            }
            event.preventDefault();
            if (event.shiftKey) {
              onPrevious();
              return;
            }
            onNext();
          }}
          placeholder={t("folio.findReplace.findPlaceholder")}
          ref={inputRef}
          size="sm"
          type="search"
          value={query}
        />
        {query.trim().length > 0 && (
          <SearchMatchControls
            activeIndex={activeIndex}
            matchCount={matchCount}
            onNext={onNext}
            onPrevious={onPrevious}
            truncated={truncated}
          />
        )}
        <Button
          aria-label={t("folio.findReplace.close")}
          onClick={onClose}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
};
