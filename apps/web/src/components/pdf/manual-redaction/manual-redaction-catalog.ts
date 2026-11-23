/**
 * Strings for marking PDF areas to redact, loaded with the reader's and the
 * anonymization facet's lazy chunks (see `src/i18n/README.md`).
 */

import { defineFeatureCatalog } from "@/i18n/feature-catalog";

export const manualRedactionCatalog = defineFeatureCatalog({
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
