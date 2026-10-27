import { expect, test } from "@playwright/test";

import en from "../../src/i18n/langs/en.json" with { type: "json" };
import { ONBOARDING_STEPS } from "../../src/onboarding/onboarding-types";
import type {
  OnboardingSnapshot,
  TrayLocation,
} from "../../src/onboarding/onboarding-types";
import {
  openOnboardingWindow,
  unexpectedNativeCalls,
} from "./desktop-window-harness";
import { tauriInvocations } from "./tauri-ipc";

const done = (trayLocation: TrayLocation | null): OnboardingSnapshot => ({
  activityAvailable: true,
  activityPermissions: ["accessibility"],
  documentApp: null,
  linked: true,
  mode: { type: "tour" },
  step: "done",
  steps: [...ONBOARDING_STEPS],
  trayLocation,
});

const MAC = { language: "en", platform: "mac", scheme: "light" } as const;

test.afterEach(async ({ page }) => {
  expect(await unexpectedNativeCalls(page)).toEqual([]);
});

for (const location of [
  { along: 0.78, edge: "top" },
  { along: 0.5, edge: "top" },
  { along: 0.94, edge: "bottom" },
  { along: 0.2, edge: "bottom" },
] as const satisfies readonly TrayLocation[]) {
  test(`the last step draws the icon where the OS reports it (${location.edge} ${location.along})`, async ({
    page,
  }) => {
    await openOnboardingWindow(page, done(location), MAC);

    const drawing = await page.evaluate(() => {
      const icon = document.querySelector("[data-tray-icon]");
      const bar = document.querySelector("[data-tray-bar]");
      const frame = bar?.parentElement;
      if (!icon || !bar || !frame) {
        return null;
      }
      const box = frame.getBoundingClientRect();
      const iconBox = icon.getBoundingClientRect();
      const barBox = bar.getBoundingClientRect();
      return {
        along: (iconBox.left + iconBox.width / 2 - box.left) / box.width,
        barAtTop: barBox.top - box.top < box.bottom - barBox.bottom,
      };
    });

    expect(drawing).not.toBeNull();
    expect(drawing?.along).toBeCloseTo(location.along, 2);
    expect(drawing?.barAtTop).toBe(location.edge === "top");
  });
}

test("an icon the OS cannot place is not drawn at a guessed position", async ({
  page,
}) => {
  await openOnboardingWindow(page, done(null), MAC);

  await expect(page.locator("[data-tray-icon]")).toHaveCount(0);
  await expect(page.getByText(en.onboarding.doneBodyMac)).toBeVisible();
});

for (const outcome of ["granted", "denied"] as const) {
  test(`the last step asks the OS for notifications and shows its answer (${outcome})`, async ({
    page,
  }) => {
    await openOnboardingWindow(page, done({ along: 0.8, edge: "top" }), {
      ...MAC,
      requestOutcome: outcome,
    });
    const card = page.locator("[data-done-permissions]");
    await expect(card.getByText(en.settings.notifications)).toBeVisible();

    await card
      .getByRole("button", { name: en.settings.permissionAllow, exact: true })
      .click();

    expect(
      (await tauriInvocations(page)).filter(
        ({ command }) => command === "permissions_request",
      ),
    ).toEqual([
      {
        args: { permission: "notifications" },
        command: "permissions_request",
      },
    ]);
    if (outcome === "granted") {
      await expect(card.getByText(en.settings.permissionAllowed)).toBeVisible();
      return;
    }
    await expect(card.getByText(en.settings.permissionDenied)).toBeVisible();
    await expect(
      card.getByRole("button", {
        name: en.settings.permissionOpenSettings,
        exact: true,
      }),
    ).toBeVisible();
    await expect(card.getByText(en.settings.permissionAllowed)).toHaveCount(0);
  });
}
