import { useState } from "react";

import { CheckIcon, SearchIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { compareByLocale } from "@stll/collation";
import { Field, FieldLabel } from "@stll/ui/field";
import { Input } from "@stll/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/input-group";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { useFormatter, useLocale } from "@/i18n/formatting-context";
import { createCountryOptions } from "@/lib/jurisdictions";
import type { BirthDateDraft } from "@/routes/_protected.contacts/-components/person-details-fields.logic";

type PersonDetailsFieldsProps = {
  birthDate: BirthDateDraft;
  onBirthDateChange: (value: BirthDateDraft) => void;
  nationalityCodes: readonly string[];
  onNationalityCodesChange: (value: string[]) => void;
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
  const selected = new Set(nationalityCodes);
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  const countries = createCountryOptions(locale, format.displayName)
    .filter(
      ({ name, code }) =>
        !normalizedQuery ||
        name.toLocaleLowerCase(locale).includes(normalizedQuery) ||
        code.toLocaleLowerCase(locale).includes(normalizedQuery),
    )
    .toSorted((a, b) => {
      if (selected.has(a.code) !== selected.has(b.code)) {
        return selected.has(a.code) ? -1 : 1;
      }
      return compareByLocale(locale)(a.name, b.name);
    });

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel>{t("contacts.fields.dateOfBirth")}</FieldLabel>
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
                  day: event.target.value.replaceAll(/\D/gu, ""),
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
                  month: event.target.value.replaceAll(/\D/gu, ""),
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
                year: event.target.value.replaceAll(/\D/gu, ""),
              })
            }
            placeholder={t("contacts.fields.year")}
            value={birthDate.year}
          />
        </div>
      </Field>
      <Field>
        <FieldLabel>{t("contacts.fields.nationalities")}</FieldLabel>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t("contacts.searchCountries")}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("contacts.searchCountries")}
            value={query}
          />
        </InputGroup>
        <div className="border-border rounded-md border">
          <ScrollArea
            aria-label={t("contacts.fields.nationalities")}
            className="h-40 max-h-40"
          >
            {countries.map(({ code, name }) => {
              const isSelected = selected.has(code);
              return (
                <button
                  aria-pressed={isSelected}
                  className={cn(
                    "hover:bg-accent flex min-h-11 w-full items-center gap-2 px-3 text-start text-sm",
                    isSelected && "bg-accent",
                  )}
                  key={code}
                  onClick={() =>
                    onNationalityCodesChange(
                      isSelected
                        ? nationalityCodes.filter((item) => item !== code)
                        : [...nationalityCodes, code],
                    )
                  }
                  type="button"
                >
                  <span className="flex-1">{name}</span>
                  <bdi className="text-muted-foreground text-xs">{code}</bdi>
                  {isSelected && <CheckIcon aria-hidden className="size-4" />}
                </button>
              );
            })}
          </ScrollArea>
        </div>
      </Field>
    </div>
  );
};
