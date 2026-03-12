import { getTranslator } from "@/i18n/i18n-store";

const SUFFIX = " | stella";

/** Build a page title from an i18n key, e.g. "Matters | stella". */
export const pageTitle = (i18nKey: string) => {
  const t = getTranslator();
  // SAFETY: i18nKey is always a dot-path key from en.json (e.g.
  // "navigation.chat"). The generated Messages type is a nested
  // object, not a dot-path union, so we cast to satisfy use-intl's
  // internal overload. Callers pass literal key strings checked
  // against en.json at review time.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return `${t(i18nKey as never)}${SUFFIX}`;
};

/**
 * Build a page title from a literal string (e.g., a dynamic
 * workspace name from loader data).
 */
export const pageTitleLiteral = (section: string) => `${section}${SUFFIX}`;
