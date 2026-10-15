import type { QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";

import { resolveUiLocale } from "@stll/locales";

import {
  initializeRenderedLocale,
  loadLocaleMessages,
} from "@/i18n/i18n-store";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { getBrowserPresentationPrefs } from "@/lib/account/presentation-prefs/provider";
import { readPresentationPrefs } from "@/lib/account/presentation-prefs/server";
import { fetchSession } from "@/lib/auth-queries";
import { loadAuthContext } from "@/routes/-auth-context";

const documentUsers = new WeakMap<QueryClient, string | null>();

export const initializeDocumentUser = (
  queryClient: QueryClient,
  userId: string | null,
) => {
  documentUsers.set(queryClient, userId);
};

export const loadClientDocumentPresentation = async (
  queryClient: QueryClient,
) => {
  const prefs = getBrowserPresentationPrefs();
  const { user } = await loadAuthContext(queryClient);
  const userId = user?.id ?? null;
  if (
    !documentUsers.has(queryClient) ||
    documentUsers.get(queryClient) !== userId
  ) {
    const locale = resolveUiLocale(user?.locale ?? prefs.visitorLocale) ?? "en";
    const messages = await loadLocaleMessages(locale);
    initializeRenderedLocale({ locale, messages, prefs });
    initializeDocumentUser(queryClient, userId);
  }
  return prefs;
};
// Read the profile only to choose the catalogue. Public SSR must not put
// identity into the query cache that is transported to the browser.
export const loadServerDocumentPresentation = async (
  prefs: PresentationPrefs,
) => {
  const auth = await fetchSession();
  const locale =
    resolveUiLocale(auth?.user.locale ?? prefs.visitorLocale) ?? "en";
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
