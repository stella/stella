import type { QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";

import { resolveUiLocale } from "@stll/locales";

import {
  initializeRenderedLocale,
  loadLocaleMessages,
} from "@/i18n/i18n-store";
import { getBrowserPresentationPrefs } from "@/lib/presentation-prefs-provider";
import { readPresentationPrefs } from "@/lib/presentation-prefs-server";
import { loadAuthContext } from "@/routes/-auth-context";

// Resolve once per document on the server. Client navigations retain the
// already loaded catalogue and preferences instead of resetting from a cache.
export const loadDocumentPresentation = createIsomorphicFn()
  .server(async (queryClient: QueryClient) => {
    const [prefs, auth] = await Promise.all([
      readPresentationPrefs(),
      loadAuthContext(queryClient),
    ]);
    const locale =
      resolveUiLocale(auth.user?.locale ?? prefs.visitorLocale) ?? "en";
    const messages = await loadLocaleMessages(locale);
    initializeRenderedLocale({ locale, messages, prefs });
    return prefs;
  })
  .client(
    async (_queryClient: QueryClient) =>
      await Promise.resolve(getBrowserPresentationPrefs()),
  );
