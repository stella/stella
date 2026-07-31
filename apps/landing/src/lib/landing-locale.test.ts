import { expect, test } from "bun:test";

import { resolveLandingLocaleRedirect } from "./landing-locale";

const baseLayoutPath = new URL("../layouts/Base.astro", import.meta.url);

const localizedRoutes = [
  { locale: "en", path: "/product/agent" },
  { locale: "cs", path: "/cs/product/agent" },
  { locale: "pt-BR", path: "/pt-br/product/agent" },
] as const;

test("redirects a fresh Czech browser to the Czech localized route", () => {
  expect(
    resolveLandingLocaleRedirect({
      browserLanguages: ["cs-CZ", "en-US"],
      currentLocale: "en",
      hash: "#demo",
      localizedRoutes,
      savedLocale: null,
      search: "?source=homepage",
    }),
  ).toBe("/cs/product/agent?source=homepage#demo");
});

test("an explicit English choice wins over the browser language", () => {
  expect(
    resolveLandingLocaleRedirect({
      browserLanguages: ["cs-CZ", "en-US"],
      currentLocale: "en",
      hash: "",
      localizedRoutes,
      savedLocale: "en",
      search: "",
    }),
  ).toBeUndefined();
});

test("does not redirect source-only or already localized routes", () => {
  const route = {
    browserLanguages: ["cs-CZ"],
    hash: "",
    savedLocale: null,
    search: "",
  } as const;

  expect(
    resolveLandingLocaleRedirect({
      ...route,
      currentLocale: "en",
      localizedRoutes: [],
    }),
  ).toBeUndefined();
  expect(
    resolveLandingLocaleRedirect({
      ...route,
      currentLocale: "cs",
      localizedRoutes,
    }),
  ).toBeUndefined();
});

test("matches regional browser tags to a supported language", () => {
  expect(
    resolveLandingLocaleRedirect({
      browserLanguages: ["pt-PT"],
      currentLocale: "en",
      hash: "",
      localizedRoutes: [
        { locale: "en", path: "/" },
        { locale: "pt-BR", path: "/pt-br/" },
      ],
      savedLocale: null,
      search: "",
    }),
  ).toBe("/pt-br/");
});

test("locale selection reruns after client-routed page loads", async () => {
  const baseLayout = await Bun.file(baseLayoutPath).text();

  expect(baseLayout).toContain(
    'document.addEventListener("astro:page-load", initializeLandingLocale);',
  );
});
