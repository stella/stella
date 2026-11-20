import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  openSettingsWindow,
  unexpectedNativeCalls,
  WINDOW_VARIANTS,
} from "./desktop-window-harness";
import { emitTauriEvent, tauriInvocations } from "./tauri-ipc";

test.use({ deviceScaleFactor: 2 });

test.afterEach(async ({ page }) => {
  expect(await unexpectedNativeCalls(page)).toEqual([]);
});

const calls = async (page: Page, command: string) =>
  (await tauriInvocations(page))
    .filter((call) => call.command === command)
    .map(({ args }) => args);

const level = (
  status: "hearing" | "listening" | "silent" | "zeros",
  levelDb: number,
) => ({
  device: "AirPods Pro 3",
  finished: false,
  levelDb,
  peakDb: levelDb + 6,
  status,
});

const openDictation = async (page: Page) => {
  await openSettingsWindow(page, "dictation", WINDOW_VARIANTS[0]);
  const row = page.locator("[data-slot=settings-row]").filter({
    hasText: "Microphone",
  });
  await expect(row.getByRole("combobox")).toHaveText(
    "System default (AirPods Pro 3)",
  );
  return row;
};

test("the microphone select lists the default first and marks Bluetooth", async ({
  page,
}) => {
  const row = await openDictation(page);

  await row.getByRole("combobox").click();
  const options = page.getByRole("option");
  // The selected option also carries its check mark's label.
  await expect(options).toHaveText([
    /System default \(AirPods Pro 3\)$/u,
    "Built-in Microphone",
    "AirPods Pro 3 · Bluetooth",
  ]);
  await options.filter({ hasText: "Built-in Microphone" }).click();

  await expect
    .poll(async () => calls(page, "dictation_set_microphone"))
    .toEqual([{ id: "coreaudio:BuiltInMicrophoneDevice" }]);
  await expect(row.getByRole("combobox")).toHaveText("Built-in Microphone");
});

test("the microphone test shows the level and says when it hears speech", async ({
  page,
}) => {
  const row = await openDictation(page);

  await row.getByRole("button", { name: "Test microphone" }).click();
  await expect
    .poll(async () => calls(page, "dictation_test_microphone_start"))
    .toEqual([{ id: null }]);
  const meter = row.getByRole("meter", { name: "Input level" });
  await expect(meter).toBeVisible();

  await emitTauriEvent(
    page,
    "dictation-microphone-level",
    level("hearing", -20),
  );
  await expect(meter).toHaveAttribute("aria-valuenow", "-20");
  await expect(row).toContainText("We hear you.");
  await expect(row.locator("[data-slot=microphone-test]")).toHaveAttribute(
    "data-status",
    "hearing",
  );

  await row.getByRole("button", { name: "Stop" }).click();
  await expect
    .poll(async () => calls(page, "dictation_test_microphone_stop"))
    .not.toEqual([]);
  await expect(
    row.getByRole("button", { name: "Test microphone" }),
  ).toBeVisible();
});

test("exact zeros say no sound and lead to Microphone access", async ({
  page,
}) => {
  const row = await openDictation(page);
  await row.getByRole("button", { name: "Test microphone" }).click();
  await expect(row.getByRole("meter")).toBeVisible();

  await emitTauriEvent(page, "dictation-microphone-level", level("zeros", -90));

  await expect(row).toContainText("No sound from AirPods Pro 3.");
  await row.getByRole("button", { name: "Check Microphone access" }).click();
  await expect
    .poll(async () => calls(page, "permissions_open_settings"))
    .toEqual([{ permission: "microphone" }]);
});

test("near silence says no sound without the access link", async ({ page }) => {
  const row = await openDictation(page);
  await row.getByRole("button", { name: "Test microphone" }).click();
  await expect(row.getByRole("meter")).toBeVisible();

  await emitTauriEvent(
    page,
    "dictation-microphone-level",
    level("silent", -70),
  );

  await expect(row).toContainText("No sound from AirPods Pro 3.");
  await expect(
    row.getByRole("button", { name: "Check Microphone access" }),
  ).toHaveCount(0);
});

test("the test ends when the native side says so", async ({ page }) => {
  const row = await openDictation(page);
  await row.getByRole("button", { name: "Test microphone" }).click();
  await expect(row.getByRole("button", { name: "Stop" })).toBeVisible();

  await emitTauriEvent(page, "dictation-microphone-test-ended", null);

  await expect(
    row.getByRole("button", { name: "Test microphone" }),
  ).toBeVisible();
});
