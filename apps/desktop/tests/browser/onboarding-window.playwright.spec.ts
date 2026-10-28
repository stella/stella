import { expect, test } from "@playwright/test";

import {
  controlMetrics,
  ONBOARDING_SCREENS,
  openOnboardingWindow,
  unexpectedNativeCalls,
  WINDOW_EDGE_INSET,
  WINDOW_VARIANTS,
  windowGeometryViolations,
} from "./desktop-window-harness";

// Drawn at twice its size, as on a Retina display, so a failure screenshot
// shows what a reader of the real window sees.
test.use({ deviceScaleFactor: 2 });

test.afterEach(async ({ page }) => {
  expect(await unexpectedNativeCalls(page)).toEqual([]);
});

for (const screen of ONBOARDING_SCREENS) {
  for (const variant of WINDOW_VARIANTS) {
    test(`setup ${screen.name} keeps its content inside the window and its controls on one scale (${variant.language}, ${variant.platform}, ${variant.scheme})`, async ({
      page,
    }) => {
      await openOnboardingWindow(page, screen.snapshot, variant);

      expect(await windowGeometryViolations(page, WINDOW_EDGE_INSET)).toEqual(
        [],
      );
      // A step's actions and the controls in its cards share one height
      // and one type size.
      const controls = await controlMetrics(page, "main");
      expect(
        new Set(controls.map(({ scale }) => scale)).size,
        JSON.stringify(controls),
      ).toBeLessThanOrEqual(1);
    });
  }
}
