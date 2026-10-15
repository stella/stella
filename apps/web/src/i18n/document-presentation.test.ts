import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import type { UiLocale } from "@stll/locales";

import {
  initializeRenderedLocale,
  loadLocaleMessages,
  useI18nStore,
} from "@/i18n/i18n-store";
import {
  parseVisitorPresentationPrefs,
  defaultPresentationPrefs,
  serializePresentationPrefs,
} from "@/lib/account/presentation-prefs/preferences";
import { sessionOptions } from "@/lib/auth-query-options";

import {
  initializeDocumentUser,
  loadClientDocumentPresentation,
} from "./document-presentation";
import { withRequestI18n } from "./request-i18n.server";

const sessionFor = ({ id, locale }: { id: string; locale: UiLocale }) => ({
  user: {
    id,
    locale,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    email: "member@example.test",
    emailVerified: true,
    name: "Member",
    timezoneId: "UTC",
    twoFactorEnabled: false,
  },
  session: {
    id: "fixture-session",
    token: "fixture-token",
    userId: id,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    activeOrganizationId: "fixture-org",
  },
});

test("account changes replace the catalogue before navigation completes without a document reload", async () =>
  await withRequestI18n(async () => {
    const queryClient = new QueryClient();
    initializeDocumentUser(queryClient, null);
    for (const user of [
      { id: "first", locale: "cs", navigation: "Právní databáze" },
      { id: "second", locale: "de", navigation: "Rechtsdatenbank" },
      { id: "first", locale: "cs", navigation: "Právní databáze" },
    ] as const) {
      queryClient.setQueryData(sessionOptions.queryKey, sessionFor(user));
      await loadClientDocumentPresentation(queryClient);
      expect(useI18nStore.getState().loadedLang).toBe(user.locale);
      expect(useI18nStore.getState().messages.common.legalDatabase).toBe(
        user.navigation,
      );
    }
    queryClient.clear();
  }));

test("navigation by the same account retains a freshly selected catalogue despite a cached profile", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    sessionOptions.queryKey,
    sessionFor({ id: "same", locale: "en" }),
  );
  initializeDocumentUser(queryClient, "same");
  await useI18nStore.getState().loadMessages("cs");
  await loadClientDocumentPresentation(queryClient);
  expect(useI18nStore.getState().loadedLang).toBe("cs");
  queryClient.clear();
});

const DocumentSnapshot = () => {
  const { loadedLang, messages } = useI18nStore((state) => state);
  return createElement(
    "html",
    { lang: loadedLang },
    createElement("span", null, messages.common.legalDatabase),
  );
};

test("cookie-free Czech requests render Czech HTML while an explicit cookie overrides the header", async () => {
  for (const cookie of [
    undefined,
    serializePresentationPrefs({
      ...defaultPresentationPrefs,
      visitorLocale: "en",
    }),
  ]) {
    await withRequestI18n(async () => {
      const prefs = parseVisitorPresentationPrefs(
        cookie,
        "en;q=0.2,cs-CZ;q=0.9",
      );
      const locale = prefs.visitorLocale;
      initializeRenderedLocale({
        locale,
        prefs,
        messages: await loadLocaleMessages(locale),
      });
      const html = renderToStaticMarkup(createElement(DocumentSnapshot));
      expect(html).toContain(cookie === undefined ? 'lang="cs"' : 'lang="en"');
      expect(html).toContain(
        cookie === undefined ? "Právní databáze" : "Legal database",
      );
    });
  }
});

test("server presentation uses the profile locale without adding identity to the hydration cache", async () => {
  const { requestHandler } = await import("@tanstack/react-start/server");
  const { loadServerDocumentPresentation } =
    await import("./document-presentation");
  const originalFetch = globalThis.fetch;
  const profile = sessionFor({ id: "presentation-user", locale: "cs" });
  globalThis.fetch = Object.assign(async () => Response.json(profile), {
    preconnect: () => undefined,
  });
  const queryClient = new QueryClient();
  try {
    await withRequestI18n(async () => {
      const handle = requestHandler(async () => {
        await loadServerDocumentPresentation(defaultPresentationPrefs);
        return new Response(null);
      });
      await handle(
        new Request("http://localhost:3000/tools", {
          headers: { "accept-language": "en-US" },
        }),
      );
      expect(useI18nStore.getState().loadedLang).toBe("cs");
      expect(queryClient.getQueryCache().getAll()).toEqual([]);
      expect(renderToStaticMarkup(createElement(DocumentSnapshot))).toContain(
        "Právní databáze",
      );
    });
  } finally {
    queryClient.clear();
    globalThis.fetch = originalFetch;
  }
});
