import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  DESKTOP_APPEARANCE_CHANGED_EVENT,
  DESKTOP_APPEARANCE_STORAGE_KEY,
} from "../../src/shared/desktop-appearance";
import {
  openSettingsWindow,
  unexpectedNativeCalls,
} from "./desktop-window-harness";
import { emitTauriEvent, tauriInvocations } from "./tauri-ipc";

test.afterEach(async ({ page }) => {
  expect(await unexpectedNativeCalls(page)).toEqual([]);
});

const documentScheme = async (page: Page) =>
  await page.evaluate((key) => {
    const root = document.documentElement;
    return {
      cached: localStorage.getItem(key),
      colorScheme: root.style.colorScheme,
      dark: root.classList.contains("dark"),
    };
  }, DESKTOP_APPEARANCE_STORAGE_KEY);

const appearancePicker = (page: Page) =>
  page.getByRole("combobox", { name: "Appearance" });

test("choosing Dark darkens the window at once and saves the choice natively", async ({
  page,
}) => {
  await openSettingsWindow(page, "general", {
    language: "en",
    platform: "mac",
    scheme: "light",
  });
  await expect(appearancePicker(page)).toHaveText("Match system");
  await expect
    .poll(async () => documentScheme(page))
    .toEqual({
      cached: "system",
      colorScheme: "light",
      dark: false,
    });

  await appearancePicker(page).click();
  await page.getByRole("option", { name: "Dark" }).click();

  await expect(appearancePicker(page)).toHaveText("Dark");
  await expect
    .poll(async () => documentScheme(page))
    .toEqual({
      cached: "dark",
      colorScheme: "dark",
      dark: true,
    });
  expect(
    (await tauriInvocations(page)).filter(
      ({ command }) => command === "set_desktop_appearance",
    ),
  ).toEqual([
    { args: { appearance: "dark" }, command: "set_desktop_appearance" },
  ]);
});

test("a choice made in another window switches this one", async ({ page }) => {
  await openSettingsWindow(page, "general", {
    language: "en",
    platform: "mac",
    scheme: "dark",
  });
  await expect.poll(async () => (await documentScheme(page)).dark).toBe(true);

  await emitTauriEvent(page, DESKTOP_APPEARANCE_CHANGED_EVENT, {
    appearance: "light",
  });

  await expect(appearancePicker(page)).toHaveText("Light");
  await expect
    .poll(async () => documentScheme(page))
    .toEqual({
      cached: "light",
      colorScheme: "light",
      dark: false,
    });
});

test("Match system follows the system's scheme as it changes", async ({
  page,
}) => {
  await openSettingsWindow(page, "general", {
    language: "en",
    platform: "mac",
    scheme: "light",
  });
  await expect.poll(async () => (await documentScheme(page)).dark).toBe(false);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => (await documentScheme(page)).dark).toBe(true);

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(async () => (await documentScheme(page)).dark).toBe(false);
});

test("a chosen scheme holds when the system's changes", async ({ page }) => {
  await openSettingsWindow(page, "general", {
    appearance: "light",
    language: "en",
    platform: "mac",
    scheme: "dark",
  });
  await expect(appearancePicker(page)).toHaveText("Light");
  await expect.poll(async () => (await documentScheme(page)).dark).toBe(false);

  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });

  await expect
    .poll(async () => documentScheme(page))
    .toEqual({
      cached: "light",
      colorScheme: "light",
      dark: false,
    });
});

test("the native answer replaces a stale cached choice", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "dark");
  }, DESKTOP_APPEARANCE_STORAGE_KEY);
  await openSettingsWindow(page, "general", {
    appearance: "light",
    language: "en",
    platform: "mac",
    scheme: "light",
  });

  await expect(appearancePicker(page)).toHaveText("Light");
  await expect
    .poll(async () => documentScheme(page))
    .toEqual({
      cached: "light",
      colorScheme: "light",
      dark: false,
    });
});

test("a window listens for changes before it reads the saved choice", async ({
  page,
}) => {
  await openSettingsWindow(page, "general", {
    language: "en",
    platform: "mac",
    scheme: "light",
  });

  const calls = await tauriInvocations(page);
  const listening = calls.findIndex(
    ({ args, command }) =>
      command === "plugin:event|listen" &&
      args["event"] === DESKTOP_APPEARANCE_CHANGED_EVENT,
  );
  const reading = calls.findIndex(
    ({ command }) => command === "get_desktop_appearance",
  );
  expect(listening).toBeGreaterThanOrEqual(0);
  expect(reading).toBeGreaterThan(listening);
});
