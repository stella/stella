import * as v from "valibot";

import { Temporal } from "@stll/time";

import { isApiDate } from "./api-date";

export const CONTACT_BIRTH_YEAR_MIN = 1900;

const yearSchema = v.pipe(v.number(), v.integer());
const monthSchema = v.pipe(v.number(), v.integer());
const daySchema = v.pipe(v.number(), v.integer());

const contactDateShapeSchema = v.variant("precision", [
  v.strictObject({ precision: v.literal("year"), year: yearSchema }),
  v.strictObject({
    precision: v.literal("month"),
    year: yearSchema,
    month: monthSchema,
  }),
  v.strictObject({
    precision: v.literal("day"),
    year: yearSchema,
    month: monthSchema,
    day: daySchema,
  }),
]);

export type ContactDate = v.InferOutput<typeof contactDateShapeSchema>;

const pad = (value: number) => String(value).padStart(2, "0");

export const isValidContactBirthDate = (value: ContactDate): boolean => {
  const today = Temporal.Now.plainDateISO();
  const todayParts = [today.year, today.month, today.day];
  const parts = [
    value.year,
    ...(value.precision === "year" ? [] : [value.month]),
    ...(value.precision === "day" ? [value.day] : []),
  ];
  if (value.year < CONTACT_BIRTH_YEAR_MIN) {
    return false;
  }
  if (value.precision !== "year" && (value.month < 1 || value.month > 12)) {
    return false;
  }
  if (
    value.precision === "day" &&
    !isApiDate(`${value.year}-${pad(value.month)}-${pad(value.day)}`)
  ) {
    return false;
  }
  for (const [index, part] of parts.entries()) {
    const todayPart = todayParts[index] ?? 0;
    if (part < todayPart) {
      return true;
    }
    if (part > todayPart) {
      return false;
    }
  }
  return true;
};

/** A birth date at the precision known, bounded by real chronology. */
export const contactBirthDateSchema = v.pipe(
  contactDateShapeSchema,
  v.check(
    isValidContactBirthDate,
    "Expected a valid birth date from 1900 through today",
  ),
);
