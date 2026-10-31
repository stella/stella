import { Result } from "better-result";
import * as v from "valibot";

import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
  ORGANIZATION_SLUG_PATTERN,
} from "@stll/api-contract/organization-create";
import { Temporal } from "@stll/time";

import { getTranslator, useI18nStore } from "@/i18n/i18n-store";
import { requiredTrimmedStringSchema } from "@/lib/schema";

export const getOrganizationSchema = () => {
  const t = getTranslator();

  return v.strictObject({
    name: v.pipe(
      requiredTrimmedStringSchema(t("validation.organizationNameRequired")),
      v.maxLength(ORGANIZATION_NAME_MAX_LENGTH),
    ),
    slug: v.pipe(
      v.string(),
      v.trim(),
      v.transform((slug) => (slug.length === 0 ? undefined : slug)),
      v.optional(
        v.pipe(
          v.string(),
          v.maxLength(ORGANIZATION_SLUG_MAX_LENGTH, t("validation.slugFormat")),
          v.regex(ORGANIZATION_SLUG_PATTERN, t("validation.slugFormat")),
        ),
      ),
    ),
  });
};
export const formatMemberDate = (date: string | Date, locale?: string) => {
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
