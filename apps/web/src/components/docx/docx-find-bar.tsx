import { useRef } from "react";

import { SearchIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";

import { SearchMatchControls } from "@/components/search-match-controls";
import { useExternalSyncEffect } from "@/hooks/use-effect";

import type { DocxFind } from "./use-docx-find";

type DocxFindBarProps = {
  find: DocxFind;
};

/**
 * Find bar docked at the top of the inspector's DOCX pane, matching the
 * external-reference panel's bar rather than floating over the page.
 */
export const DocxFindBar = ({ find }: DocxFindBarProps) => {
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hasQuery = find.query.trim().length > 0;

  // Mount, plus every later press of the shortcut, hands focus back to the
  // query and selects what is there so retyping replaces it.
  useExternalSyncEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, [find.focusSeq]);

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
      <SearchIcon className="text-muted-foreground size-3.5 shrink-0" />
      <Input
        aria-label={t("folio.findReplace.findText")}
        className="h-7 flex-1 rounded-md"
        nativeInput
        onChange={(event) => {
          find.setQuery(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            find.close();
            return;
          }
          if (event.key !== "Enter") {
            return;
          }
          event.preventDefault();
          find.step(event.shiftKey ? "previous" : "next");
        }}
        placeholder={t("folio.findReplace.findPlaceholder")}
        ref={inputRef}
        size="sm"
        type="search"
        value={find.query}
      />
      {hasQuery && (
        <SearchMatchControls
          activeIndex={find.activeIndex}
          matchCount={find.summary.count}
          onNext={() => {
            find.step("next");
          }}
          onPrevious={() => {
            find.step("previous");
          }}
          truncated={find.summary.truncated}
        />
      )}
      <Button
        aria-label={t("folio.findReplace.close")}
        onClick={find.close}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
};
