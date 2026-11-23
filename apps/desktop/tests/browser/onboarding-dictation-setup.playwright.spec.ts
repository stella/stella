import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import en from "../../src/i18n/langs/en.json" with { type: "json" };
import { ONBOARDING_STEPS } from "../../src/onboarding/onboarding-types";
import type { OnboardingSnapshot } from "../../src/onboarding/onboarding-types";
import type { DictationSnapshot } from "../../src/onboarding/use-dictation";
import {
  controlMetrics,
  openOnboardingWindow,
  unexpectedNativeCalls,
  WINDOW_EDGE_INSET,
  windowGeometryViolations,
} from "./desktop-window-harness";
import type { DesktopTestPlatform } from "./desktop-window-harness";
import { DICTATION_READY } from "./fixtures/desktop-window-snapshots";
import { emitTauriEvent, tauriInvocations } from "./tauri-ipc";

/**
 * The Dictation step's screens, each drawn in the real setup window at its
 * native size, in both colour schemes: the content stays inside the window,
 * the controls share one scale, and each screen says what it is for.
 */

test.use({ deviceScaleFactor: 2 });

test.afterEach(async ({ page }) => {
  expect(await unexpectedNativeCalls(page)).toEqual([]);
});

const STEP: OnboardingSnapshot = {
  activityAvailable: true,
  activityPermissions: ["accessibility"],
  dictationAvailable: true,
  dictationPermissions: ["microphone", "accessibility"],
  documentApp: null,
  linked: true,
  mode: { type: "tour" },
  step: "dictation",
  steps: [...ONBOARDING_STEPS],
  trayLocation: null,
};

/** Dictation on, the speech model still to download, stella AI offered. */
const DICTATION = {
  ...DICTATION_READY,
  model: { status: "missing" },
} as const satisfies DictationSnapshot;

const setup = en.onboarding.dictationSetup;

const SCREENS = [
  { name: "microphone", title: setup.microphone.title },
  { name: "transcription", title: setup.transcription.title },
  { name: "app", title: setup.app.title },
  { name: "context", title: setup.context.title },
  { name: "words", title: setup.words.title },
] as const;

const heading = (page: Page) => page.getByRole("heading", { level: 1 });

/** Continues from the first screen until `title` heads the step. */
const continueTo = async (page: Page, title: string) => {
  // Until the dictation snapshot arrives the step shows only its label, and
  // Continue there leaves the step: read the heading once a screen is drawn.
  await expect(page.locator("[data-dictation-screen]")).toBeVisible();
  for (const screen of SCREENS) {
    if ((await heading(page).textContent()) === title) {
      return;
    }
    await page
      .getByRole("button", { exact: true, name: en.onboarding.continue })
      .click();
    await expect(heading(page)).not.toHaveText(screen.title);
  }
  await expect(heading(page)).toHaveText(title);
};

const expectFits = async (page: Page) => {
  expect(await windowGeometryViolations(page, WINDOW_EDGE_INSET)).toEqual([]);
  const controls = await controlMetrics(page, "main");
  expect(
    new Set(controls.map(({ scale }) => scale)).size,
    JSON.stringify(controls),
  ).toBeLessThanOrEqual(1);
};

for (const scheme of ["light", "dark"] as const) {
  for (const [index, screen] of SCREENS.entries()) {
    test(`dictation setup ${index + 1}, ${screen.name}, fits the window (${scheme})`, async ({
      page,
    }) => {
      await openOnboardingWindow(page, STEP, {
        dictation: DICTATION,
        language: "en",
        platform: "mac",
        scheme,
      });
      await continueTo(page, screen.title);

      await expect(
        page.locator(`[data-dictation-screen=${screen.name}]`),
      ).toBeVisible();
      await expect(page.locator("[aria-current=step]")).toHaveText(
        setup.screens[screen.name],
      );
      await expectFits(page);
    });
  }

  test(`dictation setup with stella AI chosen shows the model and its warning (${scheme})`, async ({
    page,
  }) => {
    await openOnboardingWindow(page, STEP, {
      dictation: {
        ...DICTATION,
        cloudModel: "elevenlabs-direct/scribe-v3",
        destination: "cloud",
      },
      language: "en",
      platform: "mac",
      scheme,
    });
    await continueTo(page, setup.transcription.title);

    await expect(page.getByRole("radio", { checked: true })).toHaveValue(
      "cloud",
    );
    await expect(
      page.getByText(
        en.dictation.destination.retainsDataTitle.replace(
          "{provider}",
          "ElevenLabs",
        ),
      ),
    ).toBeVisible();
    await expectFits(page);
  });
}

for (const platform of [
  "mac",
  "windows",
] as const satisfies readonly DesktopTestPlatform[]) {
  test(`the microphone screen asks for Accessibility only on a Mac (${platform})`, async ({
    page,
  }) => {
    await openOnboardingWindow(page, STEP, {
      dictation: DICTATION,
      language: "en",
      platform,
      scheme: "light",
    });

    await expect(
      page.getByText(en.onboarding.dictationMicrophone),
    ).toBeVisible();
    await expect(
      page.getByText(en.onboarding.dictationAccessibility),
    ).toHaveCount(platform === "mac" ? 1 : 0);
  });
}

test("the microphone screen tests the microphone and says whether it hears you", async ({
  page,
}) => {
  await openOnboardingWindow(page, STEP, {
    dictation: DICTATION,
    language: "en",
    platform: "mac",
    scheme: "light",
  });
  const card = page.locator("[data-microphone-choice]");
  await expect(card.getByRole("combobox")).toHaveText(
    "System default (AirPods Pro 3)",
  );

  await card
    .getByRole("button", { name: en.dictation.microphone.test })
    .click();
  await expect
    .poll(async () =>
      (await tauriInvocations(page)).filter(
        ({ command }) => command === "dictation_test_microphone_start",
      ),
    )
    .toEqual([
      { args: { id: null }, command: "dictation_test_microphone_start" },
    ]);
  await emitTauriEvent(page, "dictation-microphone-level", {
    device: "AirPods Pro 3",
    finished: false,
    levelDb: -20,
    peakDb: -14,
    status: "hearing",
  });
  await expect(card.getByText(en.dictation.microphone.hearing)).toBeVisible();
  await expect(
    card.getByRole("meter", { name: en.dictation.microphone.level }),
  ).toBeVisible();
  await expectFits(page);
});

test("the transcription choice writes the destination Settings reads", async ({
  page,
}) => {
  await openOnboardingWindow(page, STEP, {
    dictation: DICTATION,
    language: "en",
    platform: "mac",
    scheme: "light",
  });
  await continueTo(page, setup.transcription.title);

  await page
    .getByRole("radio", { name: setup.transcription.cloudTitle })
    .check();

  await expect(page.getByText(en.dictation.destination.model)).toBeVisible();
  expect(
    (await tauriInvocations(page)).filter(
      ({ command }) => command === "dictation_set_destination",
    ),
  ).toEqual([
    { args: { destination: "cloud" }, command: "dictation_set_destination" },
  ]);
});

test("without stella AI for the account the transcription screen offers no choice", async ({
  page,
}) => {
  await openOnboardingWindow(page, STEP, {
    dictation: { ...DICTATION, cloudAvailable: false },
    language: "en",
    platform: "mac",
    scheme: "light",
  });
  await continueTo(page, setup.transcription.titleLocal);

  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByText(setup.transcription.cloudTitle)).toHaveCount(0);
  await expectFits(page);
});
