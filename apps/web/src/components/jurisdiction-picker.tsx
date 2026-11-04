import { useState } from "react";

import { useTranslations } from "use-intl";

import type { CountryCode } from "@stll/country-codes";
import { Button } from "@stll/ui/button";
import { CheckIcon, SearchIcon, StarIcon } from "@stll/ui/icons";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/input-group";
import { cn } from "@stll/ui/utils";

import { filterJurisdictionOptions } from "@/components/jurisdiction-picker.logic";
import { useFormatter, useFormattingLocale } from "@/i18n/formatting-context";
import { createCountryOptions, removeJurisdiction } from "@/lib/jurisdictions";
import type { PracticeJurisdiction } from "@/lib/jurisdictions";

const MAX_SELECTED_JURISDICTIONS = 12;

const NO_SUGGESTED_COUNTRY_CODES: readonly CountryCode[] = [];

type JurisdictionPickerProps = {
  selected: readonly PracticeJurisdiction[];
  suggestedCountryCodes?: readonly CountryCode[];
  onChange: (jurisdictions: PracticeJurisdiction[]) => void;
  autoFocus?: boolean;
};

export const JurisdictionPicker = ({
  selected,
  suggestedCountryCodes = NO_SUGGESTED_COUNTRY_CODES,
  onChange,
  autoFocus = false,
}: JurisdictionPickerProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const locale = useFormattingLocale();
  const [query, setQuery] = useState("");
  const selectedCodes = selected.map(
    (jurisdiction) => jurisdiction.countryCode,
  );
  const countryOptions = createCountryOptions(locale, format.displayName);
  const filteredCountries = filterJurisdictionOptions({
    countries: countryOptions,
    locale,
    query,
    selectedCodes,
    suggestedCodes: suggestedCountryCodes,
  });
  const selectedSet = new Set(selectedCodes);
  const suggestedSet = new Set(suggestedCountryCodes);

  const toggleCountry = (countryCode: CountryCode) => {
    if (selectedSet.has(countryCode)) {
      onChange(removeJurisdiction(selected, countryCode));
      return;
    }

    if (selected.length >= MAX_SELECTED_JURISDICTIONS) {
      return;
    }

    onChange([
      ...selected,
      {
        countryCode,
        isPrimary: selected.length === 0,
      },
    ]);
  };

  const makePrimary = (countryCode: CountryCode) => {
    onChange(
      selected.map((jurisdiction) => ({
        ...jurisdiction,
        isPrimary: jurisdiction.countryCode === countryCode,
      })),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon className="text-muted-foreground" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label={t("onboarding.jurisdictionSearchLabel")}
          autoFocus={autoFocus}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("onboarding.jurisdictionSearchPlaceholder")}
          value={query}
        />
      </InputGroup>

      <div className="border-border max-h-[310px] overflow-y-auto rounded-lg border">
        {filteredCountries.map((country) => {
          const isSelected = selectedSet.has(country.code);
          const isSuggested = suggestedSet.has(country.code);
          const isPrimary = selected.some(
            (jurisdiction) =>
              jurisdiction.countryCode === country.code &&
              jurisdiction.isPrimary,
          );

          return (
            <div
              className={cn(
                "border-border/70 flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0",
                isSelected && "bg-accent text-foreground",
              )}
              key={country.code}
            >
              <Button
                aria-pressed={isSelected}
                className="min-w-0 flex-1"
                onClick={() => toggleCountry(country.code)}
                size="row"
                variant="ghost"
              >
                <span
                  className={cn(
                    "border-border flex size-5 shrink-0 items-center justify-center rounded-full border",
                    isSelected && "bg-primary text-primary-foreground",
                  )}
                >
                  {isSelected && <CheckIcon className="size-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate font-normal">
                  {country.name}
                </span>
                {isSuggested && (
                  <span className="bg-muted text-muted-foreground text-3xs rounded-full px-1.5 py-0.5">
                    {t("common.suggested")}
                  </span>
                )}
                <span className="text-muted-foreground text-xs">
                  {country.code}
                </span>
              </Button>
              {isSelected && selected.length > 1 && (
                // An icon button names itself in its tooltip.
                <Button
                  aria-label={t("onboarding.jurisdictionMakePrimary", {
                    name: country.name,
                  })}
                  aria-pressed={isPrimary}
                  onClick={() => makePrimary(country.code)}
                  size="icon-sm"
                  variant={isPrimary ? "ghost" : "muted"}
                >
                  <StarIcon
                    className={cn(
                      "size-4",
                      isPrimary && "text-primary fill-current",
                    )}
                  />
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
