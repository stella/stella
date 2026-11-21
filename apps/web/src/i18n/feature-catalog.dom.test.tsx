import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { IntlProvider, useTranslations } = await import("use-intl");
const { defineFeatureCatalog, mergeFeatureMessages } =
  await import("./feature-catalog");

afterEach(() => {
  cleanup();
});
afterAll(async () => await unregisterDomEnvironment());

const fixtureMessages = {
  featureCatalogFixture: { greeting: "Hello from the feature" },
};

/** Counts loads per locale, so a test can tell a cached load from a new one. */
const loads: string[] = [];
const loader = (lang: string) => async () => {
  loads.push(lang);
  return await Promise.resolve(fixtureMessages);
};
const fixtureCatalog = defineFeatureCatalog({
  en: loader("en"),
  ar: loader("ar"),
  cs: loader("cs"),
  de: loader("de"),
  es: loader("es"),
  et: loader("et"),
  fr: loader("fr"),
  hu: loader("hu"),
  lt: loader("lt"),
  lv: loader("lv"),
  pl: loader("pl"),
  "pt-BR": loader("pt-BR"),
  sk: loader("sk"),
});

const TypedGreeting = () => {
  const t = fixtureCatalog.useTranslations();
  return <p>{t("featureCatalogFixture.greeting")}</p>;
};

const AppGreeting = () => {
  // App strings still resolve inside the feature's provider.
  const t = useTranslations();
  return <p>{t("common.close")}</p>;
};

test("the provider shows its fallback, then the feature's and the app's strings", async () => {
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <fixtureCatalog.Provider
        fallback={<span data-testid="feature-pending" />}
      >
        <TypedGreeting />
        <AppGreeting />
      </fixtureCatalog.Provider>
    </IntlProvider>,
  );
  expect(await screen.findByText("Hello from the feature")).toBeTruthy();
  expect(screen.getByText(messages.common.close)).toBeTruthy();
  expect(screen.queryByTestId("feature-pending")).toBeNull();
});

test("a locale's catalog is loaded once", () => {
  loads.length = 0;
  fixtureCatalog.preload("de");
  fixtureCatalog.preload("de");
  expect(loads).toEqual(["de"]);
});

test("a feature namespace may not shadow an app namespace", () => {
  expect(() =>
    mergeFeatureMessages(messages, { common: { close: "Shadowed" } }),
  ).toThrow('Feature catalog namespace "common" is already an app namespace');
});
