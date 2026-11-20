import { expect, type Page, test } from "@playwright/test";

import en from "../../src/i18n/langs/en.json" with { type: "json" };
import {
  emitTauriEvent,
  installTauriIpc,
  unexpectedTauriCalls,
} from "./tauri-ipc";

/** The window's native size (`transcribe_window.rs`). */
const SIZE = { width: 1120, height: 720 } as const;
const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const SCREENSHOTS = process.env["TRANSCRIBE_SCREENSHOTS"];

const MATTER = {
  id: "0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a8b",
  name: "Novák v Stavby Praha",
  reference: "NSP-2026-014",
  color: "--option-emerald",
};

type Variant = {
  /** Snapshot reads fail until the spec lets them answer. */
  snapshotFails?: boolean;
  /** The stella AI model cannot be read. */
  modelFails?: boolean;
  /** Native code refuses the first start: the model the window showed is
   *  out of date. */
  firstStartRefused?: boolean;
};

/** The page flag that keeps snapshot reads failing. */
const SNAPSHOT_FAILS = "__TRANSCRIBE_SNAPSHOT_FAILS__";

const open = async (
  page: Page,
  scheme: "light" | "dark",
  variant: Variant = {},
) => {
  await page.setViewportSize(SIZE);
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await page.addInitScript((userAgent) => {
    Object.defineProperty(navigator, "userAgent", { get: () => userAgent });
  }, MAC_USER_AGENT);
  await installTauriIpc(page, {
    windowLabel: "transcribe",
    unhandled: "rejectAsUnexpected",
    arg: { matter: MATTER, variant, failsFlag: SNAPSHOT_FAILS },
    handlers: (
      {
        matter,
        variant: { snapshotFails, modelFails, firstStartRefused },
        failsFlag,
      },
      ipc,
    ) => {
      Reflect.set(window, failsFlag, snapshotFails === true);
      let modelReads = 0;
      let starts = 0;
      return {
        account_record_use: () => null,
        desktop_report_error: () => null,
        get_desktop_language: () => "en",
        transcribe_get_snapshot: () => {
          if (Reflect.get(window, failsFlag) === true) {
            throw new Error("The snapshot is not readable yet");
          }
          return {
            available: true,
            localReady: true,
            cloudAvailable: true,
            destination: "cloud",
            file: null,
            running: null,
          };
        },
        transcribe_get_model: () => {
          if (modelFails === true) {
            throw new Error("The model list is not readable");
          }
          return {
            id: "elevenlabs-direct/scribe-v3",
            displayName: "Scribe v3",
            provider: "ElevenLabs",
            retainsData: false,
            ticket: (modelReads += 1),
          };
        },
        transcribe_clear_file: () => null,
        // A stand-in for the organization's model: the part comes back
        // formatted, with an instruction for whoever files it.
        transcribe_clean_up: ({ request }) => {
          const transcript =
            typeof request === "object" && request !== null
              ? String(Reflect.get(request, "transcript"))
              : "";
          const [first = "", ...rest] = transcript.split("\n\n");
          return {
            instructions: ["File it in the matter."],
            markdown: [
              "## Memo to file",
              first.replace("opposing counsel", "**opposing counsel**"),
              ...rest.map((paragraph) => `- ${paragraph}`),
            ].join("\n\n"),
          };
        },
        transcribe_search_matters: () => [matter],
        transcribe_choose_file: () => {
          ipc.emit("transcribe-file", {
            status: "ready",
            selection: 1,
            name: "Memo to file 2026-11-14.m4a",
            format: "M4A",
            durationMs: 42 * 60_000,
          });
          return null;
        },
        transcribe_start: ({ request }) => {
          starts += 1;
          if (firstStartRefused === true && starts === 1) {
            throw new Error("the stella AI model shown is out of date");
          }
          // A start names the model the window was last shown.
          const ticket =
            typeof request === "object" && request !== null
              ? Reflect.get(request, "modelTicket")
              : undefined;
          if (ticket !== modelReads) {
            throw new Error("the stella AI model shown is out of date");
          }
          return {
            job: 1,
            model: {
              id: "elevenlabs-direct/scribe-v3",
              displayName: "Scribe v3",
              provider: "ElevenLabs",
              retainsData: false,
            },
            autoCleanup: true,
          };
        },
      };
    },
  });
  await page.goto("/");
};

const PIECES = [
  [
    0,
    0,
    "Memo to file in Novák versus Stavby Praha. I spoke with opposing counsel this morning about the inspection of the site at Libeňská 12.",
  ],
  [
    1,
    38_000,
    "They accept the expert's report as to the cracks in the load-bearing wall, but not as to the cause.",
  ],
  [
    2,
    102_000,
    "They propose a joint expert. I said we would consider it if the costs are shared equally and the expert is chosen from the court's list.",
  ],
  [
    3,
    195_000,
    "Next, the settlement figure. The client's instruction remains four hundred and twenty thousand crowns, with costs.",
  ],
] as const;

for (const scheme of ["light", "dark"] as const) {
  test(`a recording is chosen, transcribed piece by piece and stopped (${scheme})`, async ({
    page,
  }) => {
    await open(page, scheme);
    const t = en.transcribe;
    await expect(page.getByText(t.drop.title)).toBeVisible();
    await expect(page.getByText(t.note)).toBeVisible();
    await expect(
      page.getByText(
        t.destination.cloudDescriptionModel.replace("{model}", "Scribe v3"),
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: t.matter.none }).click();
    await page
      .getByRole("button", { name: new RegExp(MATTER.name, "u") })
      .click();
    if (SCREENSHOTS) {
      await page.screenshot({ path: `${SCREENSHOTS}/choose-${scheme}.png` });
    }
    await page.getByRole("button", { name: t.drop.choose }).click();
    await expect(page.getByText("Memo to file 2026-11-14.m4a")).toBeVisible();
    for (const [index, startMs, text] of PIECES) {
      await emitTauriEvent(page, "transcribe-piece", {
        job: 1,
        index,
        startMs,
        endMs: startMs + 30_000,
        pauseBeforeMs: index === 2 ? 2000 : 300,
        text,
      });
    }
    await expect(page.getByText("1:42")).toBeVisible();
    await expect(page.getByRole("status")).toContainText("of 42 min");
    await expect(
      page.getByRole("button", { name: t.result.saveToMatter }),
    ).toBeDisabled();
    if (SCREENSHOTS) {
      await page.screenshot({ path: `${SCREENSHOTS}/result-${scheme}.png` });
    }
    await emitTauriEvent(page, "transcribe-finished", {
      outcome: "stopped",
      job: 1,
    });
    await expect(
      page.getByRole("button", { name: t.result.saveToMatter }),
    ).toBeEnabled();
    // Once transcription ends, the rest is cleaned up beside the transcript.
    await expect(
      page.getByRole("heading", { name: "Memo to file" }),
    ).toBeVisible();
    await expect(page.getByText("File it in the matter.")).toBeVisible();
    await expect(
      page.getByText("opposing counsel", { exact: true }),
    ).toBeVisible();
    if (SCREENSHOTS) {
      await page.screenshot({ path: `${SCREENSHOTS}/cleaned-${scheme}.png` });
    }
    expect(await unexpectedTauriCalls(page)).toEqual([]);
  });
}

test("the empty transcript explains why its copy and save menus cannot open", async ({
  page,
}) => {
  await open(page, "light");
  const t = en.transcribe;
  await page.getByRole("button", { name: t.drop.choose }).click();

  const tooltip = page.locator('[data-slot="tooltip-popup"][data-open]');
  for (const name of [t.copyMenu.label, t.result.saveAs]) {
    const triggers = page.getByRole("button", { name, exact: true });
    await expect(triggers).toHaveCount(2);
    for (const trigger of await triggers.all()) {
      await expect(trigger).toBeDisabled();
      await trigger.focus();
      await expect(trigger).toBeFocused();
      await trigger.hover();
      await expect(trigger).toHaveAttribute("data-popup-open");
      await expect(tooltip).toHaveText(t.progress.transcribing);

      await page.keyboard.press("ArrowDown");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("menu")).toHaveCount(0);

      await trigger.click({ force: true });
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
  }

  expect(await unexpectedTauriCalls(page)).toEqual([]);
});

test("a dropped DS2 file is refused with the export note", async ({ page }) => {
  await open(page, "light");
  await expect(page.getByText(en.transcribe.drop.title)).toBeVisible();
  await emitTauriEvent(page, "transcribe-file", {
    status: "refused",
    name: "Interview.ds2",
    reason: "dictaphone",
  });
  await expect(page.getByRole("alert")).toHaveText(en.transcribe.note);
  expect(await unexpectedTauriCalls(page)).toEqual([]);
});

test("a window that could not load offers to try again", async ({ page }) => {
  await open(page, "light", { snapshotFails: true });
  await expect(page.getByRole("alert")).toHaveText(en.transcribe.failure.load);
  await page.evaluate((flag) => {
    Reflect.set(window, flag, false);
  }, SNAPSHOT_FAILS);
  await page.getByRole("button", { name: en.transcribe.retry }).click();
  await expect(page.getByText(en.transcribe.drop.title)).toBeVisible();
});

test("stella AI takes no file until its model is read", async ({ page }) => {
  await open(page, "light", { modelFails: true });
  await expect(
    page.getByText(en.transcribe.destination.modelFailed),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: en.transcribe.drop.choose }),
  ).toBeDisabled();
  // This computer stays available.
  await page
    .getByRole("button", { name: en.transcribe.destination.thisComputer })
    .click();
  await expect(
    page.getByRole("button", { name: en.transcribe.drop.choose }),
  ).toBeEnabled();
});

test("a stella AI file a start refused waits until the model is shown again", async ({
  page,
}) => {
  await open(page, "light", { firstStartRefused: true });
  const t = en.transcribe;
  await page.getByRole("button", { name: t.drop.choose }).click();
  const start = page.getByRole("button", { name: t.kept.start });
  await expect(
    page.getByText(
      t.kept.ready.replace("{name}", "Memo to file 2026-11-14.m4a"),
    ),
  ).toBeVisible();
  // The model is read again, and shown, before the file can start.
  await expect(
    page.getByText(
      t.destination.cloudDescriptionModel.replace("{model}", "Scribe v3"),
    ),
  ).toBeVisible();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(
    page.getByRole("button", { name: t.result.saveAs }).first(),
  ).toBeVisible();
  expect(await unexpectedTauriCalls(page)).toEqual([]);
});
