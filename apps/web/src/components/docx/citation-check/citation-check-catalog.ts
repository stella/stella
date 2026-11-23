/**
 * The citation check's strings, loaded with the check's lazy chunk rather
 * than with the app's English bundle (see `src/i18n/README.md`).
 */

import { defineFeatureCatalog } from "@/i18n/feature-catalog";

export const citationCheckCatalog = defineFeatureCatalog({
  en: async () => (await import("./i18n/langs/en.json")).default,
  ar: async () => (await import("./i18n/langs/ar.json")).default,
  cs: async () => (await import("./i18n/langs/cs.json")).default,
  de: async () => (await import("./i18n/langs/de.json")).default,
  es: async () => (await import("./i18n/langs/es.json")).default,
  et: async () => (await import("./i18n/langs/et.json")).default,
  fr: async () => (await import("./i18n/langs/fr.json")).default,
  hu: async () => (await import("./i18n/langs/hu.json")).default,
  lt: async () => (await import("./i18n/langs/lt.json")).default,
  lv: async () => (await import("./i18n/langs/lv.json")).default,
  pl: async () => (await import("./i18n/langs/pl.json")).default,
  "pt-BR": async () => (await import("./i18n/langs/pt-BR.json")).default,
  sk: async () => (await import("./i18n/langs/sk.json")).default,
});

/** A key of the citation check's own strings. */
export type CitationCheckTranslationKey = Parameters<
  ReturnType<typeof citationCheckCatalog.useTranslations>
>[0];
