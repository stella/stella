import type { RegisteredRouter, RouterState } from "@tanstack/react-router";

import { toLanguageCode } from "@stll/locales";
import type { TextDirection, UiLocale } from "@stll/locales";

type PageMatch = RouterState<RegisteredRouter["routeTree"]>["matches"][number];

/**
 * The language of the document the leaf route renders, when it renders one:
 * a decision or a statute is written in its own language whatever the
 * interface around it is set to.
 */
export const pageDocumentLanguage = (
  matches: readonly PageMatch[],
): string | null => {
  const leaf = matches.at(-1);
  if (leaf === undefined) {
    return null;
  }

  if (
    leaf.routeId === "/law/$country/cases/$court/$slug" ||
    leaf.routeId === "/law/$country/cases/$court/$language/$slug"
  ) {
    return leaf.loaderData?.language ?? null;
  }
  if (
    leaf.routeId === "/law/$country/statutes/$slug/" ||
    leaf.routeId === "/law/$country/statutes/$slug/v/$version"
  ) {
    const data = leaf.loaderData;
    return data ? (data.statute ?? data.work).language : null;
  }
  return null;
};

type ResolveDocumentLanguageInput = {
  documentLanguage: string | null;
  interfaceLocale: UiLocale;
};

type ResolvedPageLanguage = {
  lang: string;
  /** Whether `lang` names the rendered document or the interface. */
  source: "document" | "interface";
};

/**
 * The `lang` of the whole page: the document's language where the page
 * renders one, otherwise the interface locale.
 */
export const resolveDocumentLanguage = ({
  documentLanguage,
  interfaceLocale,
}: ResolveDocumentLanguageInput): ResolvedPageLanguage => {
  const lang =
    documentLanguage === null ? null : toLanguageCode(documentLanguage);
  return lang === null
    ? { lang: interfaceLocale, source: "interface" }
    : { lang, source: "document" };
};

type DocumentLanguageAttributes = {
  dir: TextDirection;
  lang: string;
};

/** Write the page language onto the live root element (browser only). */
export const applyDocumentLanguage = ({
  dir,
  lang,
}: DocumentLanguageAttributes): void => {
  const root = document.documentElement;
  root.lang = lang;
  root.dir = dir;
};
