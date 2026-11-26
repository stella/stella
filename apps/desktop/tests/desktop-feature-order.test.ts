import { expect, test } from "bun:test";

import { SETTINGS_PAGES, SIDEBAR_PAGES } from "../src/mainview/settings-pages";
import type { SettingsPage } from "../src/mainview/settings-pages";
import { DESKTOP_FEATURES } from "../src/shared/desktop-features";
import type { DesktopFeature } from "../src/shared/desktop-features";

/** The page that holds each feature's settings. */
const FEATURE_PAGES = {
  activity: "activity",
  clipboard: "clipboard",
  dictation: "dictation",
  documents: "general",
  signing: "signing",
} as const satisfies Record<DesktopFeature, SettingsPage>;

test("the shared order names every feature once", () => {
  const features: readonly string[] = DESKTOP_FEATURES;
  expect(features.toSorted()).toEqual(Object.keys(FEATURE_PAGES).toSorted());
});

test("the sidebar holds every page once, General first and About last", () => {
  expect(SIDEBAR_PAGES.toSorted()).toEqual(SETTINGS_PAGES.toSorted());
  expect(SIDEBAR_PAGES.at(0)).toBe("general");
  expect(SIDEBAR_PAGES.at(-1)).toBe("about");
});

test("the sidebar's feature pages follow the shared feature order", () => {
  const positions = DESKTOP_FEATURES.map((feature) =>
    SIDEBAR_PAGES.indexOf(FEATURE_PAGES[feature]),
  );
  expect(positions).not.toContain(-1);
  expect(positions).toEqual(positions.toSorted((a, b) => a - b));
});
