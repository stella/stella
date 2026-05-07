import { useMemo, useState } from "react";

import { Input } from "@stll/ui/components/input";
import { cn } from "@stll/ui/lib/utils";
import { CheckIcon, SearchIcon, StarIcon } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { createCountryOptions, removeJurisdiction } from "@/lib/jurisdictions";
import type { PracticeJurisdiction } from "@/lib/jurisdictions";

export const MAX_SELECTED_JURISDICTIONS = 12;

type JurisdictionPickerProps = {
  selected: readonly PracticeJurisdiction[];
  suggestedCountryCodes?: readonly string[];
  onChange: (jurisdictions: PracticeJurisdiction[]) => void;
};

export const JurisdictionPicker = ({
  selected,
  suggestedCountryCodes = [],
  onChange,
}: JurisdictionPickerProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const selectedCodes = selected.map(
    (jurisdiction) => jurisdiction.countryCode,
  );
  const countryOptions = useMemo(() => createCountryOptions(locale), [locale]);
  const selectedSet = useMemo(() => new Set(selectedCodes), [selectedCodes]);
  const suggestedSet = useMemo(
    () => new Set(suggestedCountryCodes),
    [suggestedCountryCodes],
  );

  const filteredCountries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const sorted = [...countryOptions].sort((a, b) => {
      const aSuggested = suggestedSet.has(a.code);
      const bSuggested = suggestedSet.has(b.code);

      if (aSuggested !== bSuggested) {
        return aSuggested ? -1 : 1;
      }

      return a.name.localeCompare(b.name, locale);
    });

    if (!normalizedQuery) {
      return sorted;
    }

    return sorted.filter(
      (country) =>
        country.name.toLowerCase().includes(normalizedQuery) ||
        country.code.toLowerCase().includes(normalizedQuery),
    );
  }, [countryOptions, locale, query, suggestedSet]);

  const toggleCountry = (countryCode: string) => {
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

  const makePrimary = (countryCode: string) => {
    onChange(
      selected.map((jurisdiction) => ({
        ...jurisdiction,
        isPrimary: jurisdiction.countryCode === countryCode,
      })),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <SearchIcon className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" />
        <Input
          aria-label={t("onboarding.jurisdictionSearchLabel")}
          className="ps-9"
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("onboarding.jurisdictionSearchPlaceholder")}
          value={query}
        />
      </div>

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
                "border-border/70 flex items-center gap-2 border-b px-2 py-1.5 transition-colors last:border-b-0",
                isSelected && "bg-accent text-foreground",
              )}
              key={country.code}
            >
              <button
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors",
                  !isSelected && "hover:bg-accent",
                )}
                onClick={() => toggleCountry(country.code)}
                type="button"
              >
                <span
                  className={cn(
                    "border-border flex size-5 shrink-0 items-center justify-center rounded-full border",
                    isSelected && "bg-primary text-primary-foreground",
                  )}
                >
                  {isSelected && <CheckIcon className="size-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{country.name}</span>
                <span className="text-muted-foreground text-xs">
                  {country.code}
                </span>
                {isSuggested && (
                  <span className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px]">
                    {t("onboarding.jurisdictionSuggested")}
                  </span>
                )}
              </button>
              {isSelected && selected.length > 1 && (
                <button
                  aria-label={t("onboarding.jurisdictionMakePrimary", {
                    name: country.name,
                  })}
                  className={cn(
                    "hover:bg-background/40 flex size-8 items-center justify-center rounded-md transition-colors",
                    isPrimary
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => makePrimary(country.code)}
                  type="button"
                >
                  <StarIcon
                    className={cn("size-4", isPrimary && "fill-current")}
                  />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
