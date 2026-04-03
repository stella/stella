import { getTranslator } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";

const SUFFIX = " | stella";

/** Build a page title from an i18n key, e.g. "Matters | stella". */
export const pageTitle = (i18nKey: TranslationKey) => {
  const t = getTranslator();
  // TranslationKey and use-intl's NamespacedMessageKeys are
  // derived from the same Messages object but flatten with
  // different algorithms; TS cannot verify assignability at
  // ~1075 union members.
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  return `${t(i18nKey as Parameters<typeof t>[0])}${SUFFIX}`;
};

/**
 * Build a page title from a literal string (e.g., a dynamic
 * workspace name from loader data).
 */
export const pageTitleLiteral = (section: string) => `${section}${SUFFIX}`;
