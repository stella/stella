import { STELLA_API_VERSION_PREFIX } from "./index";

// desktop-feature-access.json carries the same values for the native client;
// desktop-feature-access.test.ts binds the two.
export const DESKTOP_FEATURE_ACCESS_PATH =
  `${STELLA_API_VERSION_PREFIX}/desktop/feature-access` as const;

export const DESKTOP_FEATURE_IDS = [
  "activity-timeline",
  "time-billing",
] as const;

export type DesktopFeatureId = (typeof DESKTOP_FEATURE_IDS)[number];
