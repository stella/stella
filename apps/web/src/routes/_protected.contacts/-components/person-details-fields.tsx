import { useId, useState } from "react";

import { useTranslations } from "use-intl";

import {
  CONTACT_BIRTH_YEAR_MIN,
  isValidContactBirthDate,
} from "@stll/api-contract/contact-date";
import { isCountryCode } from "@stll/country-codes";
import type { CountryCode } from "@stll/country-codes";
import { Temporal } from "@stll/time";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { useFormatter, useFormattingLocale } from "@/i18n/formatting-context";
import { createCountryOptions } from "@/lib/jurisdictions";
import {
  filterNationalityOptions,
  normalizeBirthDateDigits,
  parseBirthDateDraft,
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
  const birthDateLabelId = useId();
  const precisionLabelId = useId();
  const parsedBirthDate = parseBirthDateDraft(birthDate);
  const pickerValue =
    parsedBirthDate?.precision === "day"
      ? Temporal.PlainDate.from(parsedBirthDate).toString()
      : null;
  const format = useFormatter();
  const locale = useFormattingLocale();
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
  }).map(({ code }) => code);

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel id={birthDateLabelId}>
          {t("common.anonymizationLabels.dateOfBirth")}
        </FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          {birthDate.precision === "day" ? (
            <DatePickerPopover
              className="w-auto max-w-full"
              dateInputLabel={t("common.anonymizationLabels.dateOfBirth")}
              labelledBy={birthDateLabelId}
              minDate={`${CONTACT_BIRTH_YEAR_MIN}-01-01`}
              isDateDisabled={(value) => {
                const { year, month, day } = Temporal.PlainDate.from(value);
                return !isValidContactBirthDate({
                  precision: "day",
                  year,
                  month,
                  day,
                });
              }}
              onChange={(value) => {
                if (value === null) {
                  onBirthDateChange({
                    precision: "day",
                    year: "",
                    month: "",
                    day: "",
                  });
                  return;
                }
                const date = Temporal.PlainDate.from(value);
                onBirthDateChange({
                  precision: "day",
                  year: String(date.year),
                  month: String(date.month),
                  day: String(date.day),
                });
              }}
              value={pickerValue}
              variant="field"
            />
          ) : (
            <>
              {birthDate.precision === "month" && (
                <Input
                  aria-label={t("contacts.fields.month")}
                  className="w-24"
                  dir="ltr"
                  inputMode="numeric"
                  nativeInput
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
                nativeInput
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
            </>
          )}
          <Field>
            <FieldLabel className="sr-only" id={precisionLabelId}>
              {t("contacts.datePrecision")}
            </FieldLabel>
            <Select
              onValueChange={(precision) => {
                if (precision === null) {
                  return;
                }
                onBirthDateChange({
                  ...birthDate,
                  precision,
                  ...(precision !== "day" && { day: "" }),
                  ...(precision === "year" && { month: "" }),
                });
              }}
              value={birthDate.precision}
            >
              <SelectTrigger
                aria-labelledby={precisionLabelId}
                className="w-32"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="year">
                  {t("contacts.precision.year")}
                </SelectItem>
                <SelectItem value="month">
                  {t("contacts.precision.month")}
                </SelectItem>
                <SelectItem value="day">
                  {t("contacts.precision.day")}
                </SelectItem>
              </SelectPopup>
            </Select>
          </Field>
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
