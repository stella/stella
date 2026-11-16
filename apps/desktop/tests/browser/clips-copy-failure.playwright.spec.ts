import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { DEFAULT_CLIPBOARD_GROUP_COLOR } from "../../src/clipboard/clipboard-style";
import {
  isClipboardEditorContext,
  isClipboardSnapshot,
} from "../../src/clipboard/clipboard-types";
import type {
  ClipboardEditorContext,
  ClipboardSnapshot,
} from "../../src/clipboard/clipboard-types";
import enMessages from "../../src/i18n/langs/en.json" with { type: "json" };
import { installTauriIpc } from "./tauri-ipc";

const ITEM = {
  copiedAt: "2026-09-08T05:00:00.000Z",
  groupId: null,
  groupedAt: null,
  html: "<strong>Clause 4</strong>",
  id: "clip-1",
  name: "Clause",
  plainText: "Clause 4",
  sourceApp: null,
  type: "formattedText",
} satisfies ClipboardSnapshot["items"][number];

const GROUPS = [
  { color: DEFAULT_CLIPBOARD_GROUP_COLOR, id: "work", name: "Work" },
];

const SNAPSHOT = {
  revision: 0,
  captureStatus: "active",
  groupLimit: 24,
  groups: GROUPS,
  items: [ITEM],
  persistence: { imageCleanup: "idle", status: "encrypted" },
  retention: "month",
  screenCapture: "hidden",
  sourceAppExclusionLimit: 128,
  sourceAppExclusions: [],
  sourceAppVisuals: [],
  welcomeStatus: "completed",
} satisfies ClipboardSnapshot;

const EDITOR_CONTEXT = {
  groupLimit: 24,
  groups: GROUPS,
  item: ITEM,
  sourceAppVisual: null,
} satisfies ClipboardEditorContext;

/** Opens a Clips window whose first selection copy fails and later ones work. */
const openWindow = async (
  page: Page,
  windowLabel: "clipboard" | "clipboard-editor",
) => {
  expect(isClipboardSnapshot(SNAPSHOT)).toBe(true);
  expect(isClipboardEditorContext(EDITOR_CONTEXT)).toBe(true);
  await installTauriIpc(page, {
    windowLabel,
    unhandled: "resolveUndefined",
    arg: { context: EDITOR_CONTEXT, snapshot: SNAPSHOT },
    handlers: ({ context, snapshot }) => {
      let failing = true;
      return {
        clipboard_copy_selection: () => {
          if (failing) {
            failing = false;
            throw new TypeError("clipboard write failed");
          }
          return undefined;
        },
        clipboard_get_editor_context: () => structuredClone(context),
        clipboard_get_snapshot: () => structuredClone(snapshot),
        get_desktop_language: () => "en",
        registry_get_state: () => ({ status: "disconnected" }),
      };
    },
  });
  await page.goto("/");
  await page.locator("strong").first().waitFor();
};

/**
 * Selects text the way each window offers it: the panel's search field, and the
 * clip's text in the editor.
 */
const selectText = async (
  page: Page,
  windowLabel: "clipboard" | "clipboard-editor",
) => {
  if (windowLabel === "clipboard") {
    const search = page.getByRole("searchbox");
    await search.fill("Clause");
    await search.selectText();
    return;
  }
  await page.getByRole("textbox", { name: "Clip text" }).focus();
  await page.evaluate(() => {
    const clip = document.querySelector("strong");
    if (!clip) {
      throw new TypeError("The clip is not rendered");
    }
    document.getSelection()?.selectAllChildren(clip);
  });
};

/** Fires the copy the OS shortcut would. */
const fireCopy = async (page: Page) => {
  await page.evaluate(() => {
    document.dispatchEvent(
      new ClipboardEvent("copy", { bubbles: true, cancelable: true }),
    );
  });
};

for (const windowLabel of ["clipboard", "clipboard-editor"] as const) {
  test(`${windowLabel} says so when a copy fails, until a copy works`, async ({
    page,
  }) => {
    await openWindow(page, windowLabel);
    const alert = page.getByRole("alert").filter({
      hasText: enMessages.clipboard.errorPaste,
    });
    await expect(alert).toHaveCount(0);
    await selectText(page, windowLabel);

    await fireCopy(page);
    await expect(alert).toBeVisible();

    await fireCopy(page);
    await expect(alert).toHaveCount(0);
  });
}
