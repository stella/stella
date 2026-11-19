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

const AIRPODS = "AirPods Pro 3";

const NOTICES = [
  { fix: "request", inputDevice: null, kind: "microphone" },
  { fix: "openSettings", inputDevice: AIRPODS, kind: "microphone" },
  { fix: null, inputDevice: null, kind: "microphone" },
  { fix: "openSound", inputDevice: AIRPODS, kind: "nothingHeard" },
] as const;

const responses = async (page: Parameters<typeof tauriInvocations>[0]) =>
  (await tauriInvocations(page))
    .filter(({ command }) => command === "dictation_notice_respond")
    .map(({ args }) => args);

for (const notice of NOTICES) {
  for (const variant of WINDOW_VARIANTS) {
    test(`the ${notice.kind} notice (${notice.fix ?? "no action"}) fits its panel (${variant.language}, ${variant.platform}, ${variant.scheme})`, async ({
      page,
    }) => {
      await openDictationNoticeWindow(page, notice, variant);

      expect(await windowGeometryViolations(page, PANEL_INSET)).toEqual([]);
      // The fix and the dismissal, or the dismissal alone.
      await expect(page.getByRole("button")).toHaveCount(
        notice.fix === null ? 1 : 2,
      );
    });
  }
}

test("the notice names the fix and hands it to the native side", async ({
  page,
}) => {
  await openDictationNoticeWindow(page, NOTICES[1], WINDOW_VARIANTS[0]);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("stella could not hear your microphone");
  await expect(alert).toContainText(`Input: ${AIRPODS}`);

  await page.getByRole("button", { name: "Open System Settings" }).click();

  await expect.poll(async () => responses(page)).toEqual([{ action: "fix" }]);
});

test("an unasked microphone is asked for from the notice", async ({ page }) => {
  await openDictationNoticeWindow(page, NOTICES[0], WINDOW_VARIANTS[0]);

  await expect(page.getByRole("alert")).toContainText(
    "Allow microphone access, then try again.",
  );
  await page.getByRole("button", { name: "Dismiss" }).click();

  await expect
    .poll(async () => responses(page))
    .toEqual([{ action: "dismiss" }]);
});

test("a dictation without speech names the input and opens Sound settings", async ({
  page,
}) => {
  await openDictationNoticeWindow(page, NOTICES[3], WINDOW_VARIANTS[0]);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("stella did not hear any speech");
  await expect(alert).toContainText(`Input: ${AIRPODS}`);

  await page.getByRole("button", { name: "Open Sound settings" }).click();

  await expect.poll(async () => responses(page)).toEqual([{ action: "fix" }]);
});
