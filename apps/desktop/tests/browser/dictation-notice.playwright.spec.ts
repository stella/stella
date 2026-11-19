import { expect, test } from "@playwright/test";

import {
  openDictationNoticeWindow,
  unexpectedNativeCalls,
  WINDOW_VARIANTS,
  windowGeometryViolations,
} from "./desktop-window-harness";
import { tauriInvocations } from "./tauri-ipc";

test.use({ deviceScaleFactor: 2 });

test.afterEach(async ({ page }) => {
  expect(await unexpectedNativeCalls(page)).toEqual([]);
});

/** The panel's padding: its text and buttons keep this far from each edge. */
const PANEL_INSET = 12;

for (const fix of ["request", "openSettings", null] as const) {
  for (const variant of WINDOW_VARIANTS) {
    test(`the dictation notice (${fix ?? "no action"}) fits its panel (${variant.language}, ${variant.platform}, ${variant.scheme})`, async ({
      page,
    }) => {
      await openDictationNoticeWindow(page, fix, variant);

      expect(await windowGeometryViolations(page, PANEL_INSET)).toEqual([]);
      // The fix and the dismissal, or the dismissal alone.
      await expect(page.getByRole("button")).toHaveCount(fix === null ? 1 : 2);
    });
  }
}

test("the notice names the fix and hands it to the native side", async ({
  page,
}) => {
  await openDictationNoticeWindow(page, "openSettings", WINDOW_VARIANTS[0]);
  await expect(page.getByRole("alert")).toContainText(
    "stella could not hear your microphone",
  );

  await page.getByRole("button", { name: "Open System Settings" }).click();

  await expect
    .poll(async () =>
      (await tauriInvocations(page))
        .filter(({ command }) => command === "dictation_notice_respond")
        .map(({ args }) => args),
    )
    .toEqual([{ action: "fix" }]);
});

test("an unasked microphone is asked for from the notice", async ({ page }) => {
  await openDictationNoticeWindow(page, "request", WINDOW_VARIANTS[0]);

  await expect(page.getByRole("alert")).toContainText(
    "Allow microphone access, then try again.",
  );
  await page.getByRole("button", { name: "Dismiss" }).click();

  await expect
    .poll(async () =>
      (await tauriInvocations(page))
        .filter(({ command }) => command === "dictation_notice_respond")
        .map(({ args }) => args),
    )
    .toEqual([{ action: "dismiss" }]);
});
