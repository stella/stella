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
  .client(loadClientDocumentPresentation);
