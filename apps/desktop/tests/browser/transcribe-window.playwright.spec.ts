import { expect, type Page, test } from "@playwright/test";

import en from "../../src/i18n/langs/en.json" with { type: "json" };
import { installTauriIpc, unexpectedTauriCalls } from "./tauri-ipc";

/** The window's native size (`transcribe_window.rs`). */
const SIZE = { width: 760, height: 600 } as const;
const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const SCREENSHOTS = process.env["TRANSCRIBE_SCREENSHOTS"];

const MATTER = {
  id: "0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a8b",
  name: "Novák v Stavby Praha",
  reference: "NSP-2026-014",
  color: "--option-emerald",
};

const open = async (page: Page, scheme: "light" | "dark") => {
  await page.setViewportSize(SIZE);
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await page.addInitScript((userAgent) => {
    Object.defineProperty(navigator, "userAgent", { get: () => userAgent });
  }, MAC_USER_AGENT);
  await installTauriIpc(page, {
    windowLabel: "transcribe",
    unhandled: "rejectAsUnexpected",
    arg: { matter: MATTER },
    handlers: ({ matter }, ipc) => ({
      account_record_use: () => null,
      desktop_report_error: () => null,
      get_desktop_language: () => "en",
      transcribe_get_snapshot: () => ({
        available: true,
        localReady: true,
        cloudAvailable: true,
        destination: "cloud",
        file: null,
        running: null,
      }),
      dictation_get_snapshot: () => ({
        cloudModel: "elevenlabs-direct/scribe-v3",
      }),
      dictation_get_cloud_models: () => ({
        models: [
          {
            id: "elevenlabs-direct/scribe-v3",
            displayName: "Scribe v3",
            provider: "ElevenLabs",
            outsideRegion: false,
            retainsData: false,
          },
        ],
        defaultModelId: "elevenlabs-direct/scribe-v3",
        unavailable: null,
      }),
      transcribe_search_matters: () => [matter],
      transcribe_choose_file: () => {
        ipc.emit("transcribe-file", {
          status: "ready",
          name: "Memo to file 2026-11-14.m4a",
          format: "M4A",
          durationMs: 42 * 60_000,
        });
        return null;
      },
      transcribe_start: () => ({
        job: 1,
        model: {
          id: "elevenlabs-direct/scribe-v3",
          displayName: "Scribe v3",
          retainsData: false,
        },
      }),
    }),
  });
  await page.goto("/");
};

/** Delivers a native event to the page's listeners. */
const emit = async (page: Page, event: string, payload: unknown) => {
  await page.evaluate(
    ([name, data]) => {
      const ipc: unknown = Reflect.get(window, "__STELLA_TAURI_IPC__");
      const deliver: unknown =
        typeof ipc === "object" && ipc !== null
          ? Reflect.get(ipc, "emit")
          : undefined;
      if (typeof deliver !== "function") {
        throw new TypeError("The Tauri IPC boundary is not installed");
      }
      deliver(name, data);
    },
    [event, payload] as const,
  );
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
      await emit(page, "transcribe-piece", {
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
    await emit(page, "transcribe-finished", { outcome: "stopped", job: 1 });
    await expect(
      page.getByRole("button", { name: t.result.saveToMatter }),
    ).toBeEnabled();
    expect(await unexpectedTauriCalls(page)).toEqual([]);
  });
}

test("a dropped DS2 file is refused with the export note", async ({ page }) => {
  await open(page, "light");
  await expect(page.getByText(en.transcribe.drop.title)).toBeVisible();
  await emit(page, "transcribe-file", {
    status: "refused",
    name: "Interview.ds2",
    reason: "dictaphone",
  });
  await expect(page.getByRole("alert")).toHaveText(en.transcribe.note);
  expect(await unexpectedTauriCalls(page)).toEqual([]);
});
