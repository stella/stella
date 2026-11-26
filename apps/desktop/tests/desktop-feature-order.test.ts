import { expect, test } from "bun:test";

import contract from "../fixtures/desktop-feature-order.json" with { type: "json" };
import { SETTINGS_PAGES } from "../src/mainview/settings-pages";
import type { SettingsPage } from "../src/mainview/settings-pages";
import { ONBOARDING_STEPS } from "../src/onboarding/onboarding-types";
import type { OnboardingStep } from "../src/onboarding/onboarding-types";
import { DESKTOP_FEATURES } from "../src/shared/desktop-features";
import type { DesktopFeature } from "../src/shared/desktop-features";

/** The feature a settings page belongs to; null for a page of its own.
 *  Documents settings live on General. */
const PAGE_FEATURE = {
  about: null,
  activity: "activity",
  agents: null,
  clipboard: "clipboard",
  dictation: "dictation",
  general: "documents",
  notifications: null,
  permissions: null,
  signing: "signing",
} as const satisfies Record<SettingsPage, DesktopFeature | null>;

/** The feature a setup step sets up; null for a step of its own. */
const STEP_FEATURE = {
  activity: "activity",
  connect: null,
  dictation: "dictation",
  done: null,
  howItWorks: null,
  permissions: null,
  tryIt: "clipboard",
  welcome: null,
} as const satisfies Record<OnboardingStep, DesktopFeature | null>;

/** The features `surface` lists, in its order. */
const featuresOf = <Item extends string>(
  surface: readonly Item[],
  feature: (item: Item) => DesktopFeature | null,
): DesktopFeature[] =>
  surface.flatMap((item) => {
    const named = feature(item);
    return named === null ? [] : [named];
  });

/** `features` as the one order lists them. */
const inOrder = (features: readonly DesktopFeature[]) =>
  DESKTOP_FEATURES.filter((feature) => features.includes(feature));

test("the native contract holds the same feature order", () => {
  expect(contract.features).toEqual([...DESKTOP_FEATURES]);
});

test("the Settings sidebar lists the feature pages in the one order", () => {
  const listed = featuresOf(SETTINGS_PAGES, (page) => PAGE_FEATURE[page]);
  expect(listed).toEqual(inOrder(listed));
});

test("the setup tour sets the features up in the one order", () => {
  const listed = featuresOf(ONBOARDING_STEPS, (step) => STEP_FEATURE[step]);
  expect(listed).toEqual(inOrder(listed));
});
