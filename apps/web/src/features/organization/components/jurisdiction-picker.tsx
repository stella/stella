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
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { filterJurisdictionOptions } from "@/features/organization/components/jurisdiction-picker.logic";
import {
  JURISDICTION_PICKER_CLASS,
  JURISDICTION_ROW_CLASS,
} from "@/features/organization/components/jurisdiction-picker.pending";
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
  disabled?: boolean;
  disabledReason?: string;
};

export const JurisdictionPicker = ({
  selected,
  suggestedCountryCodes = NO_SUGGESTED_COUNTRY_CODES,
  onChange,
  autoFocus = false,
  disabled = false,
  disabledReason,
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
    if (disabled) {
      return;
    }
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
    if (disabled) {
      return;
    }
    onChange(
      selected.map((jurisdiction) => ({
        ...jurisdiction,
        isPrimary: jurisdiction.countryCode === countryCode,
      })),
    );
  };

  return (
    <div className={JURISDICTION_PICKER_CLASS}>
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
                JURISDICTION_ROW_CLASS,
                isSelected && "bg-accent text-foreground",
              )}
              key={country.code}
            >
              <Button
                aria-pressed={isSelected}
                className="min-w-0 flex-1"
                disabled={disabled}
                disabledReason={disabledReason}
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
                <TruncatedText className="flex-1 font-normal">
                  {country.name}
                </TruncatedText>
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
                  disabled={disabled}
                  disabledReason={disabledReason}
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
