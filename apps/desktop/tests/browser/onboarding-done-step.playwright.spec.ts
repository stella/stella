import { expect, type Page, test } from "@playwright/test";

import en from "../../src/i18n/langs/en.json" with { type: "json" };
import {
  ONBOARDING_STEPS,
  SCREEN_EDGES,
} from "../../src/onboarding/onboarding-types";
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

const readDrawing = (page: Page) =>
  page.evaluate(() => {
    const icon = document.querySelector("[data-tray-icon]");
    const bar = document.querySelector("[data-tray-bar]");
    const pointer = document.querySelector("[data-tray-pointer]");
    const frame = bar?.parentElement;
    if (!icon || !bar || !pointer || !frame) {
      return null;
    }
    const box = frame.getBoundingClientRect();
    const iconBox = icon.getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    const pointerBox = pointer.getBoundingClientRect();
    const vertical = barBox.height > barBox.width;
    const centre = (rect: DOMRect) =>
      vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
    const origin = vertical ? barBox.top : barBox.left;
    const length = vertical ? barBox.height : barBox.width;
    const edges = vertical
      ? [
          { edge: "left", distance: barBox.left - box.left },
          { edge: "right", distance: box.right - barBox.right },
        ]
      : [
          { edge: "top", distance: barBox.top - box.top },
          { edge: "bottom", distance: box.bottom - barBox.bottom },
        ];
    const inside = (rect: DOMRect) =>
      rect.left >= box.left &&
      rect.right <= box.right &&
      rect.top >= box.top &&
      rect.bottom <= box.bottom;
    return {
      along: (centre(iconBox) - origin) / length,
      edge: edges.toSorted((a, b) => a.distance - b.distance).at(0)?.edge,
      iconInside: inside(iconBox),
      pointerAlong: (centre(pointerBox) - origin) / length,
      pointerInside: inside(pointerBox),
    };
  });

const POSITIONS_BY_EDGE = {
  top: [0.78, 0.5],
  bottom: [0.94, 0.2],
  left: [0.2, 0.8],
  right: [0.2, 0.8],
} as const satisfies Record<TrayLocation["edge"], readonly number[]>;

for (const edge of SCREEN_EDGES) {
  for (const along of POSITIONS_BY_EDGE[edge]) {
    const location = { along, edge };
    test(`the last step draws the icon where the OS reports it (${location.edge} ${location.along})`, async ({
      page,
    }) => {
      await openOnboardingWindow(page, done(location), MAC);

      const drawing = await readDrawing(page);

      expect(drawing).not.toBeNull();
      expect(drawing?.along).toBeCloseTo(location.along, 2);
      expect(drawing?.edge).toBe(location.edge);
      expect(drawing?.pointerAlong).toBeCloseTo(location.along, 2);
    });
  }
  for (const along of [0, 1]) {
    test(`the last step keeps the icon and pointer inside the drawing (${edge} ${along})`, async ({
      page,
    }) => {
      await openOnboardingWindow(page, done({ edge, along }), MAC);
      const drawing = await readDrawing(page);
      expect(drawing).not.toBeNull();
      expect(drawing?.edge).toBe(edge);
      expect(drawing?.iconInside).toBe(true);
      expect(drawing?.pointerInside).toBe(true);
      expect(drawing?.pointerAlong).toBeCloseTo(drawing?.along ?? -1, 2);
    });
  }
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
