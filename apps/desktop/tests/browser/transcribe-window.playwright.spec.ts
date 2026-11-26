import { expect, type Page, test } from "@playwright/test";
import { panic } from "better-result";

import en from "../../src/i18n/langs/en.json" with { type: "json" };
import { desktopCspViolations, enforceDesktopCsp } from "./desktop-csp";
import { docxBodyText } from "./docx-text";
import {
  emitTauriEvent,
  installTauriIpc,
  tauriInvocations,
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
  /** Cleanup answers only once the spec releases it. */
  cleanupHeld?: boolean;
  /** The first cleanup request gets no answer. */
  firstCleanupFails?: boolean;
  /** A save to the matter stops mid-upload until the spec releases it. */
  saveHeld?: boolean;
  /** What did not reach the matter folder; everything did by default. */
  folderShortfall?: {
    notFiled: string[];
    audio: { outcome: string; maxBytes?: number };
  };
};

/** The page flag that keeps snapshot reads failing. */
const SNAPSHOT_FAILS = "__TRANSCRIBE_SNAPSHOT_FAILS__";
/** The page function that lets held cleanup and save requests, and every later one, answer. */
const RELEASE_CLEANUP = "__TRANSCRIBE_RELEASE_CLEANUP__";
/** Where the page keeps the bytes of the last Word document saved. */
const SAVED_DOCX = "__TRANSCRIBE_SAVED_DOCX__";

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
    arg: {
      matter: MATTER,
      variant,
      failsFlag: SNAPSHOT_FAILS,
      releaseCleanup: RELEASE_CLEANUP,
      savedDocx: SAVED_DOCX,
    },
    handlers: (
      {
        matter,
        variant: {
          snapshotFails,
          modelFails,
          firstStartRefused,
          cleanupHeld,
          firstCleanupFails,
          saveHeld,
          folderShortfall,
        },
        failsFlag,
        releaseCleanup,
        savedDocx,
      },
      ipc,
    ) => {
      Reflect.set(window, failsFlag, snapshotFails === true);
      let modelReads = 0;
      let starts = 0;
      let cleanups = 0;
      const held: (() => void)[] = [];
      // Releasing also lets every later request answer at once: a test may
      // release before the held request has reached this stand-in.
      let released = false;
      Reflect.set(window, releaseCleanup, () => {
        released = true;
        for (const release of held.splice(0)) {
          release();
        }
      });
      return {
        account_record_use: () => null,
        desktop_report_error: () => null,
        get_desktop_appearance: () => "system",
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
        transcribe_clean_up: async ({ request }) => {
          cleanups += 1;
          if (cleanupHeld === true && !released) {
            await new Promise<void>((resolve) => {
              held.push(resolve);
            });
          }
          if (firstCleanupFails === true && cleanups === 1) {
            throw new Error("The organization model did not answer");
          }
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
        transcribe_copy_text: () => null,
        transcribe_copy_rich: () => null,
        transcribe_save_text: () => true,
        // Files the folder as native code does: progress first, then what
        // became of each document and of the recording.
        transcribe_save_to_matter_folder: async () => {
          ipc.emit("transcribe-save-progress", { stage: "preparing" });
          ipc.emit("transcribe-save-progress", { stage: "documents" });
          ipc.emit("transcribe-save-progress", {
            stage: "uploading",
            sentBytes: 1_250_000,
            totalBytes: 2_500_000,
          });
          if (saveHeld === true && !released) {
            await new Promise<void>((resolve) => {
              held.push(resolve);
            });
          }
          ipc.emit("transcribe-save-progress", { stage: "finishing" });
          return {
            folderName: "Memo to file 2026-11-14",
            files: [
              {
                kind: "transcript",
                fileName: "Memo to file 2026-11-14 transcript.docx",
              },
              ...(folderShortfall?.notFiled.includes("cleaned") === true
                ? []
                : [
                    {
                      kind: "cleaned",
                      fileName: "Memo to file 2026-11-14 cleaned up.docx",
                    },
                  ]),
            ],
            notFiled: folderShortfall?.notFiled ?? [],
            audio: folderShortfall?.audio ?? {
              outcome: "saved",
              fileName: "Memo to file 2026-11-14.m4a",
            },
          };
        },
        transcribe_save_docx: (bytes) => {
          Reflect.set(
            window,
            savedDocx,
            bytes instanceof Uint8Array ? Array.from(bytes) : null,
          );
          return true;
        },
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
  await enforceDesktopCsp(page);
  // Errors the page throws and nothing catches, such as one in an event
  // listener: the window keeps running, so only this list shows them.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  await page.goto("/");
  return { pageErrors };
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
      await expect(trigger).toHaveAccessibleDescription(
        t.progress.transcribing,
      );
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
  // The note answers such a file; it is not standing advice.
  await expect(page.getByText(en.transcribe.note)).toHaveCount(0);
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
  await expect(page.getByRole("alert")).toHaveText(
    en.transcribe.destination.modelFailed,
  );
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

/** Chooses the recording, transcribes every piece and finishes. */
const transcribeAll = async (page: Page) => {
  await page.getByRole("button", { name: en.transcribe.drop.choose }).click();
  for (const [index, startMs, text] of PIECES) {
    await emitTauriEvent(page, "transcribe-piece", {
      job: 1,
      index,
      startMs,
      endMs: startMs + 30_000,
      pauseBeforeMs: 300,
      text,
    });
  }
  await emitTauriEvent(page, "transcribe-finished", {
    outcome: "done",
    job: 1,
    durationMs: 225_000,
  });
};

const cleanedPane = (page: Page) =>
  page.getByRole("region", { name: en.transcribe.cleaned.title, exact: true });

const cleanedEditor = (page: Page) =>
  page.getByRole("region", { name: en.transcribe.cleaned.editorLabel });

/** The arguments of the last call of `command`. */
const lastCall = async (page: Page, command: string) => {
  const call = (await tauriInvocations(page)).findLast(
    (invocation) => invocation.command === command,
  );
  if (call === undefined) {
    panic(`The window never called ${command}`);
  }
  return call.args;
};

const requestOf = (args: Record<string, unknown>): Record<string, unknown> => {
  const request = args["request"];
  if (typeof request !== "object" || request === null) {
    panic("The call carries no request");
  }
  return Object.fromEntries(Object.entries(request));
};

/** Saves the cleaned-up text through one Save as entry. */
const saveCleanedAs = async (page: Page, entry: string) => {
  await cleanedPane(page)
    .getByRole("button", { name: en.transcribe.result.saveAs })
    .click();
  await page.getByRole("menuitem", { name: entry }).click();
};

/** The body text of the Word document saved last, which it then forgets. */
const savedDocxText = async (page: Page) => {
  await expect
    .poll(async () =>
      page.evaluate(
        (global) => Array.isArray(Reflect.get(window, global)),
        SAVED_DOCX,
      ),
    )
    .toBe(true);
  const bytes = await page.evaluate((global): unknown => {
    const saved: unknown = Reflect.get(window, global);
    Reflect.set(window, global, null);
    return saved;
  }, SAVED_DOCX);
  if (!Array.isArray(bytes)) {
    panic("No Word document was saved");
  }
  return docxBodyText(Uint8Array.from(bytes.map(Number)));
};

/** Places the caret at the end of the line that holds `text` and types. */
const typeAfter = async (page: Page, text: string, typed: string) => {
  await cleanedEditor(page).getByText(text, { exact: false }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(typed);
};

const EDIT = "Payment is due within 30 days.";

test("the cleaned-up text opens for editing once cleanup is done, and every copy and save takes the edits", async ({
  page,
}) => {
  const { pageErrors } = await open(page, "light");
  const t = en.transcribe;
  await transcribeAll(page);
  const editor = cleanedEditor(page);
  await expect(editor.getByText("with costs", { exact: false })).toBeVisible();
  // The dictation's instructions stay outside the text that can be edited.
  await expect(
    cleanedPane(page).getByText("File it in the matter."),
  ).toBeVisible();
  await expect(editor.getByText("File it in the matter.")).toHaveCount(0);
  const discard = cleanedPane(page).getByRole("button", {
    name: t.cleaned.discardEdits,
  });
  await expect(discard).toHaveCount(0);

  await typeAfter(page, "with costs", ` ${EDIT}`);
  await expect(editor).toContainText(EDIT);
  await expect(discard).toBeVisible();

  // Copy, with formatting and as plain text.
  await cleanedPane(page)
    .getByRole("button", { name: t.result.copy, exact: true })
    .click();
  const rich = await lastCall(page, "transcribe_copy_rich");
  expect(String(rich["text"])).toContain(EDIT);
  expect(String(rich["html"])).toContain(EDIT);
  expect(String(rich["text"])).toContain("File it in the matter.");
  await cleanedPane(page)
    .getByRole("button", { name: t.copyMenu.label })
    .click();
  await page.getByRole("menuitemradio", { name: t.copyMenu.plain }).click();
  await cleanedPane(page)
    .getByRole("button", { name: t.result.copy, exact: true })
    .click();
  expect(
    String((await lastCall(page, "transcribe_copy_text"))["text"]),
  ).toContain(EDIT);

  // Every Save as entry.
  await saveCleanedAs(page, t.cleaned.saveMarkdown);
  const markdown = requestOf(await lastCall(page, "transcribe_save_text"));
  expect(markdown["format"]).toBe("markdown");
  expect(String(markdown["text"])).toContain(EDIT);
  await saveCleanedAs(page, t.cleaned.saveText);
  const text = requestOf(await lastCall(page, "transcribe_save_text"));
  expect(text["format"]).toBe("text");
  expect(String(text["text"])).toContain(EDIT);
  await saveCleanedAs(page, t.matterFolder.saveDocx);
  expect(await savedDocxText(page)).toContain(EDIT);

  // Discarding brings the AI text back, and copies and saves follow it.
  await discard.click();
  await expect(discard).toHaveCount(0);
  await expect(editor).not.toContainText(EDIT);
  await saveCleanedAs(page, t.cleaned.saveMarkdown);
  const restored = String(
    requestOf(await lastCall(page, "transcribe_save_text"))["text"],
  );
  expect(restored).toContain("with costs.");
  expect(restored).not.toContain(EDIT);
  await saveCleanedAs(page, t.matterFolder.saveDocx);
  expect(await savedDocxText(page)).not.toContain(EDIT);

  expect(pageErrors).toEqual([]);
  expect(await desktopCspViolations(page)).toEqual([]);
  expect(await unexpectedTauriCalls(page)).toEqual([]);
});

test("the cleaned-up text stays read-only while a part is being cleaned up", async ({
  page,
}) => {
  await open(page, "light", { cleanupHeld: true });
  const t = en.transcribe;
  await transcribeAll(page);
  const status = cleanedPane(page).locator(
    "[data-slot=truncated-text][aria-live=polite]",
  );
  await expect(status).toHaveText(t.cleaned.running);
  await expect(cleanedEditor(page)).toHaveCount(0);
  await page.evaluate((global) => {
    const release: unknown = Reflect.get(window, global);
    if (typeof release === "function") {
      Reflect.apply(release, window, []);
    }
  }, RELEASE_CLEANUP);
  await expect(cleanedEditor(page)).toBeVisible();
  await expect(status).toHaveText("");
  expect(await desktopCspViolations(page)).toEqual([]);
  expect(await unexpectedTauriCalls(page)).toEqual([]);
});

test("a part cleanup missed can be tried again until the first edit", async ({
  page,
}) => {
  const { pageErrors } = await open(page, "light", {
    firstCleanupFails: true,
  });
  const t = en.transcribe;
  await transcribeAll(page);
  const editor = cleanedEditor(page);
  const retry = cleanedPane(page).getByRole("button", { name: t.retry });
  await expect(editor).toBeVisible();
  await expect(retry).toBeVisible();
  await expect(cleanedPane(page).getByText(t.cleaned.partFailed)).toBeVisible();

  // The part is in the editor as transcribed; an edit hides Try again.
  await typeAfter(page, "with costs", ` ${EDIT}`);
  await expect(retry).toHaveCount(0);

  // Without edits, Try again is back and replaces the part.
  await cleanedPane(page)
    .getByRole("button", { name: t.cleaned.discardEdits })
    .click();
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(
    editor.getByRole("heading", { name: "Memo to file" }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(await desktopCspViolations(page)).toEqual([]);
  expect(await unexpectedTauriCalls(page)).toEqual([]);
});

test("the shipped CSP is in force while the editor runs", async ({ page }) => {
  await open(page, "light");
  await transcribeAll(page);
  await expect(cleanedEditor(page)).toBeVisible();
  expect(await desktopCspViolations(page)).toEqual([]);
  // The policy is applied, not only read: a remote image is refused.
  await page.evaluate(() => {
    const image = document.createElement("img");
    image.src = "https://example.com/pixel.png";
    document.body.append(image);
  });
  await expect
    .poll(async () => desktopCspViolations(page))
    .toEqual(["img-src https://example.com/pixel.png"]);
});

/** Chooses the matter, then transcribes the recording into it. */
const transcribeIntoMatter = async (page: Page) => {
  await page.getByRole("button", { name: en.transcribe.matter.none }).click();
  await page
    .getByRole("button", { name: new RegExp(MATTER.name, "u") })
    .click();
  await transcribeAll(page);
};

const saveToMatterButton = (page: Page) =>
  page.getByRole("button", { name: en.transcribe.result.saveToMatter });

const statusRow = (page: Page) => page.getByRole("status");

test("Save to matter files the transcript and the edited text as one folder, showing its progress", async ({
  page,
}) => {
  const { pageErrors } = await open(page, "light", { saveHeld: true });
  const t = en.transcribe;
  await transcribeIntoMatter(page);
  await typeAfter(page, "with costs", ` ${EDIT}`);
  await saveToMatterButton(page).click();

  // The upload's progress shows in the status row while it runs.
  await expect(statusRow(page)).toHaveText(
    t.matterFolder.uploading.replace("{percent, number}", "50"),
  );
  const request = requestOf(
    await lastCall(page, "transcribe_save_to_matter_folder"),
  );
  expect(request["matterId"]).toBe(MATTER.id);
  expect(request["title"]).toBe("Memo to file 2026-11-14");
  expect(request["transcriptName"]).toBe(
    t.result.documentTitle.replace("{title}", "Memo to file 2026-11-14"),
  );
  expect(request["cleanedName"]).toBe(
    t.matterFolder.cleanedTitle.replace("{title}", "Memo to file 2026-11-14"),
  );
  // The pieces as the transcript pane shows them: close pieces share a
  // paragraph.
  expect(request["paragraphs"]).toEqual([
    { startMs: 0, text: `${PIECES[0][2]} ${PIECES[1][2]}` },
    { startMs: PIECES[2][1], text: PIECES[2][2] },
    { startMs: PIECES[3][1], text: PIECES[3][2] },
  ]);
  // The cleaned-up document is the text as edited, with the instructions
  // apart.
  expect(request["cleaned"]).toEqual({
    markdown: expect.stringContaining(EDIT),
    instructions: ["File it in the matter."],
  });

  await page.evaluate((global) => {
    const release: unknown = Reflect.get(window, global);
    if (typeof release === "function") {
      Reflect.apply(release, window, []);
    }
  }, RELEASE_CLEANUP);
  await expect(statusRow(page)).toHaveText(
    t.matterFolder.saved
      .replace("{matter}", () => MATTER.name)
      .replace("{folder}", "Memo to file 2026-11-14"),
  );
  await expect(saveToMatterButton(page)).toBeDisabled();
  expect(pageErrors).toEqual([]);
  expect(await desktopCspViolations(page)).toEqual([]);
  expect(await unexpectedTauriCalls(page)).toEqual([]);
});

test("Save to matter without edits files the AI text", async ({ page }) => {
  await open(page, "light");
  await transcribeIntoMatter(page);
  await expect(cleanedEditor(page)).toBeVisible();
  await saveToMatterButton(page).click();
  await expect(statusRow(page)).toContainText(MATTER.name);
  const cleaned = requestOf(
    await lastCall(page, "transcribe_save_to_matter_folder"),
  )["cleaned"];
  expect(cleaned).toEqual({
    markdown: expect.stringContaining("## Memo to file"),
    instructions: ["File it in the matter."],
  });
  expect(JSON.stringify(cleaned)).not.toContain(EDIT);
});

for (const { name, shortfall, said } of [
  {
    name: "a recording too large for the matter",
    shortfall: { notFiled: [], audio: { outcome: "tooLarge", maxBytes: 2e9 } },
    said: [en.transcribe.matterFolder.audioTooLarge.replace("{size}", "2 GB")],
  },
  {
    name: "a recording no longer open",
    shortfall: { notFiled: [], audio: { outcome: "missing" } },
    said: [en.transcribe.matterFolder.audioMissing],
  },
  {
    name: "a recording that failed and cleaned-up text the matter did not take",
    shortfall: { notFiled: ["cleaned"], audio: { outcome: "failed" } },
    said: [
      en.transcribe.matterFolder.cleanedNotFiled,
      en.transcribe.matterFolder.audioFailed,
    ],
  },
]) {
  test(`a saved folder says plainly what it lacks: ${name}`, async ({
    page,
  }) => {
    await open(page, "light", { folderShortfall: shortfall });
    await transcribeIntoMatter(page);
    await expect(cleanedEditor(page)).toBeVisible();
    await saveToMatterButton(page).click();
    const saved = en.transcribe.matterFolder.saved
      .replace("{matter}", () => MATTER.name)
      .replace("{folder}", "Memo to file 2026-11-14");
    await expect(statusRow(page)).toHaveText([saved, ...said].join(""));
    expect(await unexpectedTauriCalls(page)).toEqual([]);
  });
}
