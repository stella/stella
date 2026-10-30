import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { contactBirthDateSchema } from "@stll/api-contract/contact-date";
import { ARABIC_DIGIT_FOLDS, normalizeUnicode } from "@stll/text-normalize";
import { filterBySearchQuery } from "@stll/text-normalize/search-query-matcher";

import type { PersonDateOfBirth } from "@/lib/contacts/mutations";

export type BirthDateDraft = {
  precision: PersonDateOfBirth["precision"];
  year: string;
  month: string;
  day: string;
};

export const normalizeBirthDateDigits = (value: string): string =>
  Array.from(
    normalizeUnicode(value, "NFKC"),
    (char) => ARABIC_DIGIT_FOLDS[char] ?? char,
  )
    .join("")
    .replaceAll(/\D/gu, "");

export const birthDateDraft = (
  value: PersonDateOfBirth | null | undefined,
): BirthDateDraft => ({
  precision: value?.precision ?? "day",
  year: value ? String(value.year) : "",
  month: value && value.precision !== "year" ? String(value.month) : "",
  day: value?.precision === "day" ? String(value.day) : "",
});

export const parseBirthDateDraft = (
  value: BirthDateDraft,
): PersonDateOfBirth | null => {
  if (!/^\d{4}$/u.test(value.year)) {
    return null;
  }
  const year = parseIntegerToken(value.year, {
    sign: "unsigned",
    min: 1000,
  }).unwrapOr(null);
  if (year === null) {
    return null;
  }
  if (value.precision === "year") {
    const candidate = { precision: "year" as const, year };
    return v.safeParse(contactBirthDateSchema, candidate).success
      ? candidate
      : null;
  }
  if (!/^\d{1,2}$/u.test(value.month)) {
    return null;
  }
  const month = parseIntegerToken(value.month, {
    sign: "unsigned",
  }).unwrapOr(null);
  if (month === null || month < 1 || month > 12) {
    return null;
  }
  if (value.precision === "month") {
    const candidate = { precision: "month" as const, year, month };
    return v.safeParse(contactBirthDateSchema, candidate).success
      ? candidate
      : null;
  }
  if (!/^\d{1,2}$/u.test(value.day)) {
    return null;
  }
  const day = parseIntegerToken(value.day, {
    sign: "unsigned",
  }).unwrapOr(null);
  if (day === null) {
    return null;
  }
  const candidate = { precision: "day" as const, year, month, day };
  return v.safeParse(contactBirthDateSchema, candidate).success
    ? candidate
    : null;
};

type FilterNationalityOptionsArgs<T> = {
  countries: readonly T[];
  query: string;
};

/** Nationalities whose localized name or code matches the query, in order. */
export const filterNationalityOptions = <
  T extends { name: string; code: string },
>({
  countries,
  query,
}: FilterNationalityOptionsArgs<T>): T[] =>
  filterBySearchQuery({
    items: countries,
    query,
    fields: ({ code, name }) => [name, code],
  });
