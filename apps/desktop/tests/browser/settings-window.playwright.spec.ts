import { expect, test } from "@playwright/test";

import {
  controlMetrics,
  openSettingsWindow,
  scrollSettingsPaneToEnd,
  SETTINGS_TABS,
  unexpectedNativeCalls,
  WINDOW_EDGE_INSET,
  WINDOW_VARIANTS,
  windowGeometryViolations,
} from "./desktop-window-harness";

// Drawn at twice its size, as on a Retina display.
test.use({ deviceScaleFactor: 2 });

test.afterEach(async ({ page }) => {
  expect(await unexpectedNativeCalls(page)).toEqual([]);
});

for (const tab of SETTINGS_TABS) {
  for (const variant of WINDOW_VARIANTS) {
    test(`settings ${tab} keeps its content inside the window and its controls on one scale (${variant.language}, ${variant.platform}, ${variant.scheme})`, async ({
      page,
    }) => {
      await openSettingsWindow(page, tab, variant);

      expect(await windowGeometryViolations(page, WINDOW_EDGE_INSET)).toEqual(
        [],
      );
      // Neighbouring rows read as one list only when their buttons and
      // fields share one height and one type size.
      const controls = await controlMetrics(page, "[role=tabpanel]");
      expect(
        new Set(controls.map(({ scale }) => scale)).size,
        JSON.stringify(controls),
      ).toBeLessThanOrEqual(1);

      // A pane longer than the window scrolls inside its frame; its end
      // keeps the same edges.
      if (await scrollSettingsPaneToEnd(page)) {
        expect(await windowGeometryViolations(page, WINDOW_EDGE_INSET)).toEqual(
          [],
        );
      }
    });
  }
}
