import { useRouterState } from "@tanstack/react-router";
import { MessageSquareTextIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { usePublicSignInRequest } from "@/components/public-sign-in-request";
import { openProvisionChat } from "@/features/statutes/provision-ask";
import { useFormatter } from "@/i18n/formatting-context";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  isStatuteCountry,
  STATUTE_COUNTRIES,
  type StatuteCountry,
} from "@/lib/statute-route";

type StatuteSearchProps = {
  country: string;
  maxLength: number;
  onCountryChange: (country: StatuteCountry) => void;
  onQueryChange: (value: string) => void;
  /** Submitted: open what the entry names, when it names one thing. */
  onSubmit: () => void;
  query: string;
};

/**
 * The one box of the statutes browser: an act number, an alias or a title,
 * scoped by the jurisdiction pill beside it. A form so Enter submits the way
 * the browser already knows how to.
 */
export const StatuteSearch = ({
  country,
  maxLength,
  onCountryChange,
  onQueryChange,
  onSubmit,
  query,
}: StatuteSearchProps) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      role="search"
    >
      <Select
        onValueChange={(value: string | null) => {
          if (value !== null && isStatuteCountry(value) && value !== country) {
            onCountryChange(value);
          }
        }}
        value={country}
      >
        <SelectTrigger aria-label={t("common.country")} className="w-36">
          <SelectValue placeholder={t("common.country")} />
        </SelectTrigger>
        <SelectPopup>
          {Object.entries(STATUTE_COUNTRIES).map(([segment, { region }]) => (
            <SelectItem key={segment} value={segment}>
              {format.displayName(region, { type: "region" })}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Input
        aria-label={t("statutes.searchLabel")}
        className="min-w-64 flex-1 sm:max-w-md"
        maxLength={maxLength}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        placeholder={t("statutes.searchPlaceholder")}
        type="search"
        value={query}
      />
      {query.trim().length > 0 && (
        <AskInChat country={country} query={query.trim()} />
      )}
    </form>
  );
};

/**
 * Hands the entry to a chat with the corpus tools, scoped to the jurisdiction
 * the box is set to: `OZ` is a different act in each. The chat is an account
 * feature: a visitor is sent to sign in and comes back to the same list.
 */
const AskInChat = ({ country, query }: { country: string; query: string }) => {
  const t = useTranslations();
  const format = useFormatter();
  const user = useMaybeAuthenticatedUser();
  const requestSignIn = usePublicSignInRequest();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });

  const ask = () => {
    if (user === null) {
      if (requestSignIn !== null) {
        requestSignIn(currentHref);
      }
      return;
    }
    const region = isStatuteCountry(country)
      ? STATUTE_COUNTRIES[country].region
      : country.toUpperCase();
    openProvisionChat({
      label: query,
      prompt: t("statutes.searchAskPrompt", {
        country: format.displayName(region, { type: "region" }),
        query,
      }),
    });
  };

  if (user === null && requestSignIn === null) {
    return null;
  }

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
