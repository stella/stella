import * as v from "valibot";

import { getTranslator, useI18nStore } from "@/i18n/i18n-store";

const SLUG_PATTERN = /^[a-z0-9-]+$/;

export const createSlug = (value: string) =>
  `${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}-${String(Math.floor(Date.now() / 1000))}`;

export const getOrganizationSchema = () => {
  const t = getTranslator();

  return v.object({
    name: v.pipe(
      v.string(),
      v.nonEmpty(t("validation.organizationNameRequired")),
    ),
    slug: v.pipe(
      v.string(),
      v.nonEmpty(t("validation.slugRequired")),
      v.regex(SLUG_PATTERN, t("validation.slugFormat")),
    ),
  });
};
export const formatDate = (date: string | Date, locale?: string) =>
  new Date(date).toLocaleDateString(locale ?? useI18nStore.getState().lang);
