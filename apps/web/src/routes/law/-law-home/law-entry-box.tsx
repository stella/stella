import type { ReactNode } from "react";

import { SearchIcon } from "lucide-react";

import { Button } from "@stll/ui/button";
import {
  COMPOSER_BOX_CLASS,
  COMPOSER_BOX_FOCUS_CLASS,
  COMPOSER_CONTROL_BUTTON_SIZE,
  COMPOSER_LARGE_ACTION_ROW_CLASS,
  COMPOSER_LARGE_EDITOR_CLASS,
  COMPOSER_LARGE_TEXT_WELL_CLASS,
  COMPOSER_LEADING_GROUP_CLASS,
  COMPOSER_SEND_BUTTON_CLASS,
  COMPOSER_TEXT_CLASS,
  ComposerStatusRow,
} from "@stll/ui/composer";
import { contentDir } from "@stll/ui/use-content-dir";
import { cn } from "@stll/ui/utils";

import { PublicLawAskInChat } from "@/components/public-law-search";

type LawEntryBoxProps = {
  /** The chat prompt for the current entry; null hides the chat button. */
  askPrompt: (query: string) => string | null;
  /** The pickers in the status row under the box: scope, jurisdiction. */
  pickers: ReactNode;
  maxLength: number;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  query: string;
  searchLabel: string;
};

/**
 * The law home's one way in, rendered from the same composer shell as the
 * chat home's box: the text well, the action row with the round submit,
 * and the status row under the box holding what narrows the entry. Enter
 * submits; the box is one line's worth of intent, not a draft.
 */
export const LawEntryBox = ({
  askPrompt,
  maxLength,
  onQueryChange,
  onSubmit,
  pickers,
  placeholder,
  query,
  searchLabel,
}: LawEntryBoxProps) => {
  const trimmed = query.trim();
  const prompt = trimmed.length > 0 ? askPrompt(trimmed) : null;

  return (
    <div className="flex w-full flex-col">
      <form
        className={cn(COMPOSER_BOX_CLASS, COMPOSER_BOX_FOCUS_CLASS)}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        role="search"
      >
        <div className={cn("relative min-w-0", COMPOSER_LARGE_TEXT_WELL_CLASS)}>
          <textarea
            aria-label={searchLabel}
            autoComplete="off"
            className={cn(
              "placeholder:text-foreground-placeholder block w-full resize-none bg-transparent outline-none",
              COMPOSER_TEXT_CLASS,
              COMPOSER_LARGE_EDITOR_CLASS,
            )}
            dir={contentDir(query)}
            maxLength={maxLength}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
            placeholder={placeholder}
            rows={1}
            value={query}
          />
        </div>
        <div className={COMPOSER_LARGE_ACTION_ROW_CLASS}>
          <div className={cn(COMPOSER_LEADING_GROUP_CLASS, "me-auto")}>
            {prompt !== null && (
              <PublicLawAskInChat label={trimmed} prompt={prompt} />
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              aria-label={searchLabel}
              className={cn(
                COMPOSER_SEND_BUTTON_CLASS,
                trimmed.length === 0 && "opacity-50",
              )}
              disabled={trimmed.length === 0}
              size={COMPOSER_CONTROL_BUTTON_SIZE}
              type="submit"
            >
              <SearchIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      </form>
      <ComposerStatusRow
        start={<div className="flex min-w-0 items-center gap-1">{pickers}</div>}
      />
    </div>
  );
};
