import { panic } from "better-result";

import featureOrder from "../../fixtures/desktop-feature-order.json" with { type: "json" };

/** The features the desktop app lists; their order is the contract's. */
const FEATURES = {
  activity: true,
  clipboard: true,
  dictation: true,
  documents: true,
  signing: true,
} as const;

export type DesktopFeature = keyof typeof FEATURES;

const isDesktopFeature = (value: string): value is DesktopFeature =>
  Object.hasOwn(FEATURES, value);

/**
 * The desktop features in the one order every surface lists them in: the
 * setup overview and the Settings sidebar here, the tray menu and the setup
 * tour on the native side. `fixtures/desktop-feature-order.json` holds the
 * order for both sides, so no surface keeps one of its own.
 */
export const DESKTOP_FEATURES: readonly DesktopFeature[] =
  featureOrder.features.map((feature) =>
    isDesktopFeature(feature)
      ? feature
      : panic(`Unknown desktop feature in the shared order: ${feature}`),
  );
