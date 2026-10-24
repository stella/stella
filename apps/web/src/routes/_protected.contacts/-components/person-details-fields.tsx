import { useState } from "react";

import { useTranslations } from "use-intl";

import { isCountryCode } from "@stll/country-codes";
import type { CountryCode } from "@stll/country-codes";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxValue,
} from "@stll/ui/combobox";
import { Field, FieldLabel } from "@stll/ui/field";
import { SearchIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";

import { useFormatter, useLocale } from "@/i18n/formatting-context";
import { createCountryOptions } from "@/lib/jurisdictions";
import {
  filterNationalityOptions,
  normalizeBirthDateDigits,
} from "@/routes/_protected.contacts/-components/person-details-fields.logic";
import type { BirthDateDraft } from "@/routes/_protected.contacts/-components/person-details-fields.logic";

type PersonDetailsFieldsProps = {
  birthDate: BirthDateDraft;
  onBirthDateChange: (value: BirthDateDraft) => void;
  nationalityCodes: readonly string[];
  onNationalityCodesChange: (value: CountryCode[]) => void;
};

export const PersonDetailsFields = ({
  birthDate,
  onBirthDateChange,
  nationalityCodes,
  onNationalityCodesChange,
}: PersonDetailsFieldsProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const parsedNationalityCodes = nationalityCodes.filter(isCountryCode);
  const allCountries = createCountryOptions(locale, format.displayName);
  const nameByCode = new Map(
    allCountries.map(({ code, name }) => [code, name]),
  );
  // Alphabetical, as `createCountryOptions` orders them; the popup is closed
  // until the field is focused, so the full list is never on screen at rest.
  const visibleCodes = filterNationalityOptions({
    countries: allCountries,
    query,
    locale,
  }).map(({ code }) => code);

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel>{t("common.anonymizationLabels.dateOfBirth")}</FieldLabel>
        <div className="flex flex-wrap gap-2" dir="ltr">
          <select
            aria-label={t("contacts.datePrecision")}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            onChange={(event) =>
              onBirthDateChange({
                ...birthDate,
                precision:
                  event.target.value === "month" || event.target.value === "day"
                    ? event.target.value
                    : "year",
                ...(event.target.value !== "day" && { day: "" }),
                ...(event.target.value === "year" && { month: "" }),
              })
            }
            value={birthDate.precision}
          >
            <option value="year">{t("contacts.precision.year")}</option>
            <option value="month">{t("contacts.precision.month")}</option>
            <option value="day">{t("contacts.precision.day")}</option>
          </select>
          {birthDate.precision === "day" && (
            <Input
              aria-label={t("contacts.fields.day")}
              className="w-20"
              dir="ltr"
              inputMode="numeric"
              maxLength={2}
              onChange={(event) =>
                onBirthDateChange({
                  ...birthDate,
                  day: normalizeBirthDateDigits(event.target.value),
                })
              }
              placeholder={t("contacts.fields.day")}
              value={birthDate.day}
            />
          )}
          {birthDate.precision !== "year" && (
            <Input
              aria-label={t("contacts.fields.month")}
              className="w-24"
              dir="ltr"
              inputMode="numeric"
              maxLength={2}
              onChange={(event) =>
                onBirthDateChange({
                  ...birthDate,
                  month: normalizeBirthDateDigits(event.target.value),
                })
              }
              placeholder={t("contacts.fields.month")}
              value={birthDate.month}
            />
          )}
          <Input
            aria-label={t("contacts.fields.year")}
            className="w-28"
            dir="ltr"
            inputMode="numeric"
            maxLength={4}
            onChange={(event) =>
              onBirthDateChange({
                ...birthDate,
                year: normalizeBirthDateDigits(event.target.value),
              })
            }
            placeholder={t("contacts.fields.year")}
            value={birthDate.year}
          />
        </div>
      </Field>
      <Field>
        <FieldLabel>{t("contacts.fields.nationalities")}</FieldLabel>
        <Combobox
          filter={null}
          inputValue={query}
          itemToStringLabel={(code) => nameByCode.get(code) ?? code}
          items={visibleCodes}
          multiple
          onInputValueChange={setQuery}
          onOpenChange={setOpen}
          onValueChange={onNationalityCodesChange}
          open={open}
          value={parsedNationalityCodes}
        >
          <ComboboxChips startAddon={<SearchIcon />}>
            <ComboboxValue>
              {(codes: CountryCode[]) =>
                codes.map((code: CountryCode) => (
                  <ComboboxChip
                    aria-label={nameByCode.get(code) ?? code}
                    key={code}
                  >
                    {nameByCode.get(code) ?? code}
                  </ComboboxChip>
                ))
              }
            </ComboboxValue>
            <ComboboxChipsInput
              aria-label={t("contacts.searchCountries")}
              onFocus={() => setOpen(true)}
              placeholder={
                parsedNationalityCodes.length === 0
                  ? t("contacts.searchCountries")
                  : undefined
              }
            />
          </ComboboxChips>
          <ComboboxPopup>
            <ComboboxEmpty>{t("common.noResults")}</ComboboxEmpty>
            <ComboboxList>
              {(code: CountryCode) => (
                <ComboboxItem key={code} value={code}>
                  <span className="flex items-center gap-2">
                    <span className="flex-1">
                      {nameByCode.get(code) ?? code}
                    </span>
                    <bdi className="text-muted-foreground text-xs">{code}</bdi>
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      </Field>
    </div>
  );
};
