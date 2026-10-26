import type { QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";

import { resolveUiLocale } from "@stll/locales";

import {
  initializeRenderedLocale,
  loadLocaleMessages,
} from "@/i18n/i18n-store";
import type { SupportedLanguage } from "@/i18n/i18n-store";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { initializeBrowserPresentationPrefs } from "@/lib/account/presentation-prefs/provider";
import { readPresentationPrefs } from "@/lib/account/presentation-prefs/server";

export const loadClientDocumentPresentation = async (
  queryClient: QueryClient,
) =>
  await (
    await import("@/i18n/client-document-locale")
  ).loadClientDocumentPresentation(queryClient);

/** Restore the server snapshot before React hydrates the document. */
export const restoreHydratedDocumentPresentation = async (presentation: {
  locale: SupportedLanguage;
  prefs: PresentationPrefs;
}) => {
  const messages = await loadLocaleMessages(presentation.locale);
  initializeBrowserPresentationPrefs(presentation.prefs);
  initializeRenderedLocale({
    locale: presentation.locale,
    prefs: presentation.prefs,
    messages,
  });
};

// Public SSR is anonymous and must not render an identity-derived locale into
// a cacheable document. The browser resolves the profile after hydration.
export const loadServerDocumentPresentation = async (
  prefs: PresentationPrefs,
) => {
  const locale = resolveUiLocale(prefs.visitorLocale) ?? "en";
  const messages = await loadLocaleMessages(locale);
  initializeRenderedLocale({ locale, messages, prefs });
  return prefs;
};

export const loadDocumentPresentation = createIsomorphicFn()
  .client(loadClientDocumentPresentation)
  .server(
    async () =>
      await loadServerDocumentPresentation(await readPresentationPrefs()),
  );
