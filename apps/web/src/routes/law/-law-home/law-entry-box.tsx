import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ComposerStatusRow } from "@stll/ui/composer";
import { ComposerFrame } from "@stll/ui/composer-frame";
import { Form } from "@stll/ui/form";
import { SearchIcon } from "@stll/ui/icons";
import { Textarea } from "@stll/ui/textarea";
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
  const t = useTranslations();
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
        {/* The chat composer's frame, shared with the chat input. */}
        <ComposerFrame
          leading={
            askScope !== null &&
            trimmed.length > 0 && (
              <PublicLawAskInChat askScope={askScope} question={trimmed} />
            )
          }
          ring="focus"
          stature="large"
          text={
            <Textarea
              aria-label={searchLabel}
              autoComplete="off"
              appearance="composer"
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
          }
          trailing={
            <Button
              aria-label={searchLabel}
              className={cn(trimmed.length === 0 && "opacity-50")}
              disabled={trimmed.length === 0}
              disabledReason={t("common.enterSearchQuery")}
              size="icon-round"
              tooltip={searchLabel}
              type="submit"
              variant="composer"
            >
              <SearchIcon className="size-3.5" />
            </Button>
          }
        />
      </Form>
      <ComposerStatusRow
        end={status}
        start={<div className="flex min-w-0 items-center gap-1">{pickers}</div>}
      />
    </div>
  );
};
