import type { RegisteredRouter, RouterState } from "@tanstack/react-router";

import { toLanguageCode } from "@stll/locales";
import type { UiLocale } from "@stll/locales";

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

  switch (leaf.routeId) {
    case "/law/$country/cases/$court/$slug":
    case "/law/$country/cases/$court/$language/$slug":
      return leaf.loaderData?.language ?? null;
    case "/law/$country/statutes/$slug/":
    case "/law/$country/statutes/$slug/v/$version": {
      const data = leaf.loaderData;
      return data ? (data.statute ?? data.work).language : null;
    }
    default:
      return null;
  }
};

type ResolveDocumentLanguageInput = {
  documentLanguage: string | null;
  interfaceLocale: UiLocale;
};

/**
 * The `lang` of the whole page: the document's language where the page
 * renders one, otherwise the interface locale.
 */
export const resolveDocumentLanguage = ({
  documentLanguage,
  interfaceLocale,
}: ResolveDocumentLanguageInput): string =>
  (documentLanguage === null ? null : toLanguageCode(documentLanguage)) ??
  interfaceLocale;
