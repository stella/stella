import { normalizeUnicode, ARABIC_DIGIT_FOLDS } from "@stll/text-normalize";

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
  precision: value?.precision ?? "year",
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
  const year = Number(value.year);
  if (year < 1000) {
    return null;
  }
  if (value.precision === "year") {
    return { precision: "year", year };
  }
  if (!/^\d{1,2}$/u.test(value.month)) {
    return null;
  }
  const month = Number(value.month);
  if (month < 1 || month > 12) {
    return null;
  }
  if (value.precision === "month") {
    return { precision: "month", year, month };
  }
  if (!/^\d{1,2}$/u.test(value.day)) {
    return null;
  }
  const day = Number(value.day);
  const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  let lastDay = 31;
  if (month === 2) {
    lastDay = leapYear ? 29 : 28;
  } else if ([4, 6, 9, 11].includes(month)) {
    lastDay = 30;
  }
  if (day < 1 || day > lastDay) {
    return null;
  }
  return { precision: "day", year, month, day };
};
