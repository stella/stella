import { expect, test } from "@playwright/test";

import { DEFAULT_CLIPBOARD_GROUP_COLOR } from "../../src/clipboard/clipboard-style";
import { isClipboardEditorContext } from "../../src/clipboard/clipboard-types";
import type { ClipboardEditorContext } from "../../src/clipboard/clipboard-types";
import { installTauriIpc } from "./tauri-ipc";

const EDITOR_CONTEXT = {
  groupLimit: 24,
  groups: [{ color: DEFAULT_CLIPBOARD_GROUP_COLOR, id: "work", name: "Work" }],
  item: {
    copiedAt: "2026-09-08T05:00:00.000Z",
    groupId: null,
    groupedAt: null,
    id: "clip-1",
    name: "Quarterly memo",
    plainText: "Quarterly memo body",
    sourceApp: null,
    type: "text",
  },
  sourceAppVisual: null,
} satisfies ClipboardEditorContext;

for (const colorScheme of ["light", "dark"] as const) {
  test(`the clip name field shows its caret and focus state (${colorScheme})`, async ({
    page,
  }) => {
    expect(isClipboardEditorContext(EDITOR_CONTEXT)).toBe(true);
    await page.emulateMedia({ colorScheme });
    await installTauriIpc(page, {
      windowLabel: "clipboard-editor",
      unhandled: "resolveUndefined",
      arg: { editorContext: EDITOR_CONTEXT },
      handlers: ({ editorContext }) => ({
        clipboard_get_editor_context: () => structuredClone(editorContext),
        get_desktop_language: () => "en",
        registry_get_state: () => ({ status: "disconnected" }),
      }),
    });
    await page.goto("/");

    const name = page.locator("[data-clipboard-editor-name]");
    await expect(name).toHaveValue("Quarterly memo");
    await name.click();
    await page.keyboard.type(" v2");
    await expect(name).toHaveValue("Quarterly memo v2");

    const state = await name.evaluate((input) => {
      const style = getComputedStyle(input);
      const wrapper = input.closest('[data-slot="input-control"]');
      const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null;
      return {
        active: document.activeElement === input,
        caretColor: style.caretColor,
        focusVisible: input.matches(":focus-visible"),
        hasFocus: document.hasFocus(),
        userSelect:
          style.userSelect || style.getPropertyValue("-webkit-user-select"),
        wrapperBoxShadow: wrapperStyle?.boxShadow ?? null,
      };
    });

    expect(state.active).toBe(true);
    expect(state.focusVisible).toBe(true);
    expect(state.hasFocus).toBe(true);
    expect(state.userSelect).not.toBe("none");
    expect(state.caretColor).not.toMatch(/transparent|rgba\(0, 0, 0, 0\)/u);
    // The focus ring is the wrapper's 3px ring shadow.
    expect(state.wrapperBoxShadow).toContain("3px");
  });
}
