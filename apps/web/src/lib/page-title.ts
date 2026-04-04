import { getTranslator } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";

const SUFFIX = " | stella";

/** Build a page title from an i18n key, e.g. "Matters | stella". */
export const pageTitle = (i18nKey: TranslationKey) => {
  const t = getTranslator();
  return `${t(i18nKey)}${SUFFIX}`;
};

/**
 * Build a page title from a literal string (e.g., a dynamic
 * workspace name from loader data).
 */
export const pageTitleLiteral = (section: string) => `${section}${SUFFIX}`;
