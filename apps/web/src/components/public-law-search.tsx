import type { ReactNode } from "react";

import { useRouterState } from "@tanstack/react-router";
import { MessageSquareTextIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { CONTROL_SIZE } from "@stll/ui/control-size";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { openPublicLawChat } from "@/components/public-law-ask";
import { usePublicSignInRequest } from "@/components/public-sign-in-request";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";

export type PublicLawSearchCountry = {
  /** The pill's value, as the route carries it. */
  value: string;
  label: string;
};

type PublicLawSearchProps = {
  country: string;
  countries: readonly PublicLawSearchCountry[];
  maxLength: number;
  onCountryChange: (country: string) => void;
  onQueryChange: (value: string) => void;
  /** Submitted: open what the entry names, when it names one thing. */
  onSubmit: () => void;
  placeholder: string;
  query: string;
  searchLabel: string;
  /**
   * The chat prompt for the current entry, scoped the way the pill is. Null
   * hides the chat button (nothing to ask about yet).
   */
  askPrompt: (query: string) => string | null;
  /**
   * `inline`: the pill beside the box, as a results screen's toolbar.
   * `entry`: the box on a row of its own, the pill and the optional filters
   * beneath it, as the home's one way in.
   */
  layout?: "inline" | "entry";
  /** Controls shown before the pill in the `entry` layout. */
  filters?: ReactNode;
  /** What follows the pill in the `entry` layout, e.g. example identifiers. */
  hints?: ReactNode;
};

/**
 * The one box of a public-law browser: an identifier, an alias or words,
 * scoped by the jurisdiction pill. A form so Enter submits the way the
 * browser already knows how to. The home, the statutes and the case-law
 * browsers share it so a reader learns one box, not three.
 */
export const PublicLawSearch = ({
  askPrompt,
  country,
  countries,
  filters,
  hints,
  layout = "inline",
  maxLength,
  onCountryChange,
  onQueryChange,
  onSubmit,
  placeholder,
  query,
  searchLabel,
}: PublicLawSearchProps) => {
  const trimmed = query.trim();
  const prompt = trimmed.length > 0 ? askPrompt(trimmed) : null;
  const countrySelect = (
    <CountrySelect
      countries={countries}
      country={country}
      onCountryChange={onCountryChange}
    />
  );

  if (layout === "entry") {
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        role="search"
      >
        <div className="flex items-center gap-2">
          <Input
            aria-label={searchLabel}
            className="flex-1"
            maxLength={maxLength}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder={placeholder}
            size={CONTROL_SIZE.lg}
            type="search"
            value={query}
          />
          {prompt !== null && <AskInChat label={trimmed} prompt={prompt} />}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {filters}
          {countrySelect}
          {hints}
        </div>
      </form>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      role="search"
    >
      {countrySelect}
      <Input
        aria-label={searchLabel}
        className="min-w-64 flex-1 sm:max-w-md"
        maxLength={maxLength}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        placeholder={placeholder}
        type="search"
        value={query}
      />
      {prompt !== null && <AskInChat label={trimmed} prompt={prompt} />}
    </form>
  );
};

type CountrySelectProps = Pick<
  PublicLawSearchProps,
  "countries" | "country" | "onCountryChange"
>;

/** The jurisdiction pill: one value, the route's, in the route's own form. */
const CountrySelect = ({
  countries,
  country,
  onCountryChange,
}: CountrySelectProps) => {
  const t = useTranslations();

  return (
    <Select
      onValueChange={(value: string | null) => {
        if (value !== null && value !== country) {
          onCountryChange(value);
        }
      }}
      value={country}
    >
      <SelectTrigger aria-label={t("common.country")} className="w-40">
        <SelectValue placeholder={t("common.country")} />
      </SelectTrigger>
      <SelectPopup>
        {countries.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

/**
 * Hands the entry to a chat with the corpus tools. The chat is an account
 * feature: a visitor is sent to sign in and comes back to the same list.
 */
const AskInChat = ({ label, prompt }: { label: string; prompt: string }) => {
  const t = useTranslations();
  const user = useMaybeAuthenticatedUser();
  const requestSignIn = usePublicSignInRequest();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });

  if (user === null && requestSignIn === null) {
    return null;
  }

  const ask = () => {
    if (user === null) {
      if (requestSignIn !== null) {
        requestSignIn(currentHref);
      }
      return;
    }
    openPublicLawChat({ label, prompt });
  };

  return (
    <Button
      className="text-muted-foreground text-xs"
      onClick={ask}
      size="sm"
      type="button"
      variant="ghost"
    >
      <MessageSquareTextIcon aria-hidden="true" className="size-3.5" />
      {t("common.askInChat")}
    </Button>
  );
};
