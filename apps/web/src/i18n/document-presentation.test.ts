import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test } from "bun:test";

import type { UiLocale } from "@stll/locales";
import { runInRequest } from "@stll/start-runtime/test-request";
import { getFirstWeekday } from "@stll/ui/week";

import {
  getFormattingLocale,
  initializeRenderedLocale,
  loadLocaleMessages,
  useI18nStore,
} from "@/i18n/i18n-store";
import {
  defaultPresentationPrefs,
  parsePresentationPrefs,
  parseVisitorPresentationPrefs,
  serializePresentationPrefs,
} from "@/lib/account/presentation-prefs/preferences";

import { withRequestI18n } from "./request-i18n.server";

let initialI18nState = useI18nStore.getState();
beforeEach(() => {
  initialI18nState = useI18nStore.getState();
});
afterEach(async () => {
  await useI18nStore.getState().loadMessages(initialI18nState.loadedLang);
  useI18nStore.setState(initialI18nState);
});

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

test("public server presentation uses the visitor locale without reading identity", async () => {
  const { loadServerDocumentPresentation } =
    await import("./document-presentation");
  const originalFetch = globalThis.fetch;
  const profile = sessionFor({ id: "presentation-user", locale: "cs" });
  let profileReads = 0;
  globalThis.fetch = Object.assign(
    async () => {
      profileReads++;
      return Response.json(profile);
    },
    {
      preconnect: () => undefined,
    },
  );
  const queryClient = new QueryClient();
  try {
    await withRequestI18n(async () => {
      await runInRequest(
        async () =>
          await loadServerDocumentPresentation({
            ...defaultPresentationPrefs,
            visitorLocale: "de",
          }),
        new Request("http://localhost:3000/tools", {
          headers: { "accept-language": "en-US" },
        }),
      );
      expect(profileReads).toBe(0);
      expect(useI18nStore.getState().loadedLang).toBe("de");
      expect(queryClient.getQueryCache().getAll()).toEqual([]);
      expect(renderToStaticMarkup(createElement(DocumentSnapshot))).toContain(
        "Rechtsdatenbank",
      );
    });
  } finally {
    queryClient.clear();
    globalThis.fetch = originalFetch;
  }
});

test.each([
  { language: "ar-SA", region: "SA", weekStart: 0 },
  { language: "ar-AE", region: "AE", weekStart: 1 },
])(
  "fresh $language server renders preserve formatting and week start",
  async ({ language, region, weekStart }) => {
    await withRequestI18n(async () => {
      const prefs = parseVisitorPresentationPrefs(
        undefined,
        `en;q=0.2,${language};q=0.9`,
      );
      const locale = prefs.visitorLocale;
      initializeRenderedLocale({
        locale,
        prefs,
        messages: await loadLocaleMessages(locale),
      });
      const formattingLocale = getFormattingLocale();
      expect(useI18nStore.getState().region).toBe(region);
      expect(formattingLocale).toBe(`${language}-u-ca-gregory-nu-arab`);
      expect(getFirstWeekday(formattingLocale)).toBe(weekStart);
      expect(renderToStaticMarkup(createElement(DocumentSnapshot))).toContain(
        'lang="ar"',
      );
      // The router serializes the same prefs alongside the selected catalogue.
      expect(parsePresentationPrefs(serializePresentationPrefs(prefs))).toEqual(
        prefs,
      );
    });
  },
);
