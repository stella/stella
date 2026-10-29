import type { ReactNode } from "react";

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
import { Form } from "@stll/ui/form";
import { SearchIcon } from "@stll/ui/icons";
import { contentDir } from "@stll/ui/use-content-dir";
import { cn } from "@stll/ui/utils";

import { PublicLawAskInChat } from "@/components/public-law-search";
import type { PublicLawAskScope } from "@/components/public-law-search";

type LawEntryBoxProps = {
  /** The corpus "Ask in chat" scopes the question to; null hides it. */
  askScope: PublicLawAskScope | null;
  /** The pickers in the status row under the box: jurisdiction, scope. */
  pickers: ReactNode;
  /** The row's end slot, where the chat keeps its meter: the corpus's status. */
  status: ReactNode;
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
  askScope,
  maxLength,
  onQueryChange,
  onSubmit,
  pickers,
  placeholder,
  query,
  searchLabel,
  status,
}: LawEntryBoxProps) => {
  const trimmed = query.trim();

  return (
    <div className="flex w-full flex-col">
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        role="search"
      >
        {/* The chat composer's shell, shared with the chat input through the
            composer's class constants. */}
        <div className={cn(COMPOSER_BOX_CLASS, COMPOSER_BOX_FOCUS_CLASS)}>
          <div
            className={cn("relative min-w-0", COMPOSER_LARGE_TEXT_WELL_CLASS)}
          >
            {/* oxlint-disable-next-line no-native-ui/no-native-textarea -- the composer's own text well, one growing line whose metrics come from the composer constants (COMPOSER_TEXT_CLASS, COMPOSER_LARGE_EDITOR_CLASS) that the chat editor shares; Textarea's default draws a control box and its in-place variant pads and rings the text itself, while the composer rings the whole box, and the shared constants cannot be passed to a component */}
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
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
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
              {askScope !== null && trimmed.length > 0 && (
                <PublicLawAskInChat askScope={askScope} question={trimmed} />
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
                tooltip={searchLabel}
                type="submit"
              >
                <SearchIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </Form>
      <ComposerStatusRow
        end={status}
        start={<div className="flex min-w-0 items-center gap-1">{pickers}</div>}
      />
    </div>
  );
};
