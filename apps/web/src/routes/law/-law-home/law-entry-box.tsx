import type { ReactNode } from "react";

import { ArrowUpIcon } from "lucide-react";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { cn } from "@stll/ui/utils";

import {
  COMPOSER_BOX_CLASS,
  COMPOSER_BOX_FOCUS_CLASS,
} from "@/components/chat/composer-control-style";
import {
  PublicLawAskInChat,
  PublicLawCountrySelect,
  type PublicLawSearchCountry,
} from "@/components/public-law-search";

type LawEntryBoxProps = {
  /** The chat prompt for the current entry; null hides the chat button. */
  askPrompt: (query: string) => string | null;
  countries: readonly PublicLawSearchCountry[];
  country: string;
  /** What narrows the entry, shown in the box's bottom row before the pill. */
  filters: ReactNode;
  maxLength: number;
  onCountryChange: (country: string) => void;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  query: string;
  searchLabel: string;
};

/**
 * The law home's one way in, shaped like the chat home's composer so the two
 * homes read as one product: the entry on top, what narrows it in the bottom
 * row, and the submit where the chat's send sits.
 */
export const LawEntryBox = ({
  askPrompt,
  countries,
  country,
  filters,
  maxLength,
  onCountryChange,
  onQueryChange,
  onSubmit,
  placeholder,
  query,
  searchLabel,
}: LawEntryBoxProps) => {
  const trimmed = query.trim();
  const prompt = trimmed.length > 0 ? askPrompt(trimmed) : null;

  return (
    <form
      className={cn(
        COMPOSER_BOX_CLASS,
        COMPOSER_BOX_FOCUS_CLASS,
        "flex w-full flex-col shadow-sm",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      role="search"
    >
      <div className="ps-4 pe-4 pt-3 pb-1">
        <Input
          aria-label={searchLabel}
          autoComplete="off"
          className="w-full"
          maxLength={maxLength}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder={placeholder}
          type="text"
          unstyled
          value={query}
        />
      </div>
      <div className="flex items-center justify-between gap-2 ps-2.5 pe-2.5 pb-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {filters}
          <PublicLawCountrySelect
            countries={countries}
            country={country}
            onCountryChange={onCountryChange}
            variant="ghost"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {prompt !== null && (
            <PublicLawAskInChat label={trimmed} prompt={prompt} />
          )}
          <Button
            aria-label={searchLabel}
            className="rounded-full"
            disabled={trimmed.length === 0}
            size="icon"
            type="submit"
          >
            <ArrowUpIcon className="size-4" />
          </Button>
        </div>
      </div>
    </form>
  );
};
