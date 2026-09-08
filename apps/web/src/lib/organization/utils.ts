import { Result } from "better-result";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { getTranslator, useI18nStore } from "@/i18n/i18n-store";
import { requiredTrimmedStringSchema } from "@/lib/schema";

const SLUG_PATTERN = /^[a-z0-9-]+$/u;

export const createSlug = (value: string) =>
  `${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(
      /^-|-$/gu,
      "",
    )}-${String(Math.floor(Temporal.Now.instant().epochMilliseconds / 1000))}`;

export const getOrganizationSchema = () => {
  const t = getTranslator();

  return v.strictObject({
    name: requiredTrimmedStringSchema(t("validation.organizationNameRequired")),
    slug: v.pipe(
      v.string(),
      v.trim(),
      v.nonEmpty(t("validation.slugRequired")),
      v.regex(SLUG_PATTERN, t("validation.slugFormat")),
    ),
  });
};
export const formatDate = (date: string | Date, locale?: string) => {
  const timestamp = Result.try(() => {
    if (date instanceof Date) {
      return Temporal.Instant.fromEpochMilliseconds(date.getTime())
        .epochMilliseconds;
    }
    if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
      return Temporal.PlainDate.from(date).toZonedDateTime({
        plainTime: Temporal.PlainTime.from("00:00"),
        timeZone: "UTC",
      }).epochMilliseconds;
    }
    return Temporal.Instant.from(date).epochMilliseconds;
  }).unwrapOr(Number.NaN);
  return new Intl.DateTimeFormat(locale ?? useI18nStore.getState().lang).format(
    timestamp,
  );
};
