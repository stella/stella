import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { DEFAULT_CLIPBOARD_GROUP_COLOR } from "../../src/clipboard/clipboard-style";
import { isClipboardSnapshot } from "../../src/clipboard/clipboard-types";
import type { ClipboardSnapshot } from "../../src/clipboard/clipboard-types";
import arMessages from "../../src/i18n/langs/ar.json" with { type: "json" };
import enMessages from "../../src/i18n/langs/en.json" with { type: "json" };

const CLIPBOARD_ITEMS = Array.from({ length: 14 }, (_, index) => ({
  copiedAt: "2026-09-08T05:00:00.000Z",
  groupId: index === 1 ? "work" : null,
  groupedAt: index === 1 ? "2026-09-08T05:00:00.000Z" : null,
  id: `clip-${index + 1}`,
  name: `Clip ${index + 1}`,
  plainText: `Clipboard item ${index + 1}`,
  sourceApp: null,
  type: "text" as const,
})) satisfies ClipboardSnapshot["items"];

const SNAPSHOT = {
  captureStatus: "active",
  groups: [{ color: DEFAULT_CLIPBOARD_GROUP_COLOR, id: "work", name: "Work" }],
  items: CLIPBOARD_ITEMS,
  persistence: { imageCleanup: "idle", status: "encrypted" },
  retention: "month",
  screenCapture: "hidden",
  sourceAppVisuals: [],
  welcomeStatus: "completed",
} satisfies ClipboardSnapshot;

const installNativeBoundary = async (page: Page, language: "ar" | "en") => {
  expect(isClipboardSnapshot(SNAPSHOT)).toBe(true);
  await page.addInitScript(
    ({ clipboardSnapshot, nativeLanguage }) => {
      const callbacks = new Map<number, (data: unknown) => unknown>();
      const invocations: {
        args: Record<string, unknown>;
        command: string;
      }[] = [];
      let nextCallbackId = 1;

      Reflect.set(window, "__STELLA_TEST_INVOCATIONS__", invocations);
      Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
        unregisterListener: () => undefined,
      });
      Reflect.set(window, "__TAURI_INTERNALS__", {
        callbacks,
        convertFileSrc: (path: string) => path,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          invocations.push({ args, command });
          if (command === "clipboard_get_snapshot") {
            return clipboardSnapshot;
          }
          if (command === "clipboard_create_group") {
            const groupId = "created-group";
            const itemId = args["itemId"];
            const name = args["name"];
            return {
              ...clipboardSnapshot,
              groups: [
                ...clipboardSnapshot.groups,
                {
                  color:
                    typeof args["color"] === "string"
                      ? args["color"]
                      : clipboardSnapshot.groups[0]?.color,
                  id: groupId,
                  name: typeof name === "string" ? name : "Created group",
                },
              ],
              items: clipboardSnapshot.items.map((item) =>
                item.id === itemId
                  ? {
                      ...item,
                      groupId,
                      groupedAt: "2026-09-08T06:00:00.000Z",
                    }
                  : item,
              ),
            };
          }
          if (command === "clipboard_update_group") {
            return {
              ...clipboardSnapshot,
              groups: clipboardSnapshot.groups.map((group) =>
                group.id === args["id"]
                  ? {
                      ...group,
                      color:
                        typeof args["color"] === "string"
                          ? args["color"]
                          : group.color,
                      name:
                        typeof args["name"] === "string"
                          ? args["name"]
                          : group.name,
                    }
                  : group,
              ),
            };
          }
          if (command === "clipboard_set_screen_capture") {
            return {
              ...clipboardSnapshot,
              screenCapture:
                args["capture"] === "visible" ? "visible" : "hidden",
            };
          }
          if (command === "get_desktop_language") {
            return nativeLanguage;
          }
          if (command === "is_autostart_enabled") {
            return false;
          }
          if (command === "plugin:event|listen") {
            return args["handler"];
          }
          return undefined;
        },
        metadata: {
          currentWebview: {
            label: "clipboard",
            windowLabel: "clipboard",
          },
          currentWindow: { label: "clipboard" },
        },
        runCallback: (id: number, data: unknown) => callbacks.get(id)?.(data),
        transformCallback: (
          callback: ((data: unknown) => unknown) | undefined,
          once = false,
        ) => {
          const id = nextCallbackId;
          nextCallbackId += 1;
          callbacks.set(id, (data) => {
            if (once) {
              callbacks.delete(id);
            }
            return callback?.(data);
          });
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
      });
    },
    { clipboardSnapshot: SNAPSHOT, nativeLanguage: language },
  );
};

const openClipboard = async (page: Page, language: "ar" | "en") => {
  await installNativeBoundary(page, language);
  await page.goto("/");
  const cards = page.locator("[data-clipboard-card-trigger]");
  await expect(cards.first()).toBeFocused();
  return cards;
};

const readPickerOverflow = async (picker: Locator) =>
  picker.evaluate((controls) => {
    const viewport = controls.closest('[data-slot="scroll-area-viewport"]');
    if (!viewport) {
      return null;
    }
    const viewportBounds = viewport.getBoundingClientRect();
    return {
      horizontal: viewport.scrollWidth > viewport.clientWidth,
      vertical: viewport.scrollHeight > viewport.clientHeight,
      clipped: Array.from(controls.querySelectorAll("button")).flatMap(
        (swatch) => {
          const bounds = swatch.getBoundingClientRect();
          const ring = 4;
          return bounds.top - ring < viewportBounds.top ||
            bounds.bottom + ring > viewportBounds.bottom ||
            bounds.left - ring < viewportBounds.left ||
            bounds.right + ring > viewportBounds.right
            ? [swatch.getAttribute("aria-label")]
            : [];
        },
      ),
    };
  });

const readCardEmphasis = async (page: Page, id: string) =>
  page.locator(`[data-clipboard-id="${id}"]`).evaluate((card) => {
    const cardStyle = getComputedStyle(card);
    const selectionStyle = getComputedStyle(card, "::after");
    return {
      backgroundColor: cardStyle.backgroundColor,
      boxShadow: cardStyle.boxShadow,
      selectionOpacity: selectionStyle.opacity,
    };
  });

const readFocusIndicator = async (
  page: Page,
  selector = '[data-clipboard-group-id][aria-pressed="true"]',
) =>
  page.locator(selector).evaluate((control) => {
    const style = getComputedStyle(control);
    return {
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });

const invocationCount = async (page: Page, command: string) =>
  page.evaluate((expectedCommand) => {
    const invocations: unknown = Reflect.get(
      window,
      "__STELLA_TEST_INVOCATIONS__",
    );
    if (!Array.isArray(invocations)) {
      return 0;
    }
    return invocations.filter(
      (invocation) =>
        typeof invocation === "object" &&
        invocation !== null &&
        "command" in invocation &&
        invocation.command === expectedCommand,
    ).length;
  }, command);

const DIRECTIONS = [
  { groupKey: "ArrowRight", language: "en", nextCardKey: "ArrowRight" },
  { groupKey: "ArrowLeft", language: "ar", nextCardKey: "ArrowLeft" },
] as const;

for (const { groupKey, language, nextCardKey } of DIRECTIONS) {
  test.describe(`${language} clipboard direction`, () => {
    test.use({ locale: language });

    test("color swatches and selection rings fit without scrollbars", async ({
      page,
    }) => {
      const messages = language === "ar" ? arMessages : enMessages;
      await openClipboard(page, language);
      await page
        .getByRole("button", {
          name: messages.clipboard.createGroup,
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog", {
        name: messages.clipboard.createGroup,
      });
      await expect(dialog).toBeVisible();
      const picker = dialog.locator('[data-slot="color-picker"]');
      await expect(picker.getByRole("button")).toHaveCount(7);
      await picker.getByRole("button", { name: "#FB7185" }).click();
      await expect
        .poll(async () => readPickerOverflow(picker))
        .toEqual({ clipped: [], horizontal: false, vertical: false });
    });

    test("keeps card emphasis hidden while focus traverses the footer", async ({
      page,
    }) => {
      const cards = await openClipboard(page, language);
      const selectedCard = page.locator('[data-clipboard-id="clip-2"]');
      const restingCard = page.locator('[data-clipboard-id="clip-1"]');
      const activeGroup = page.locator(
        '[data-clipboard-group-id][aria-pressed="true"]',
      );

      await page.keyboard.press(nextCardKey);
      await expect(cards.nth(1)).toBeFocused();
      await page.mouse.move(0, 0);
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("searchbox")).toBeFocused();

      await page.keyboard.press(groupKey);
      await expect(activeGroup).toBeFocused();
      await expect(selectedCard).toHaveAttribute("aria-current", "true");
      await expect
        .poll(
          async () => (await readCardEmphasis(page, "clip-2")).selectionOpacity,
        )
        .toBe("0");
      const selectedEmphasis = await readCardEmphasis(page, "clip-2");
      const restingEmphasis = await readCardEmphasis(page, "clip-1");
      expect({
        backgroundColor: selectedEmphasis.backgroundColor,
        boxShadow: selectedEmphasis.boxShadow,
      }).toEqual({
        backgroundColor: restingEmphasis.backgroundColor,
        boxShadow: restingEmphasis.boxShadow,
      });
      await expect(restingCard).not.toHaveAttribute("aria-current", "true");

      await page.keyboard.press(groupKey);
      await expect(
        page.locator(".clipboard-groups-rail button").nth(1),
      ).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(cards.nth(1)).toBeFocused();
      await expect
        .poll(
          async () => (await readCardEmphasis(page, "clip-2")).selectionOpacity,
        )
        .toBe("1");
    });

    test("a queued card navigation cannot steal focus from the footer", async ({
      page,
    }) => {
      const cards = await openClipboard(page, language);
      const search = page.getByRole("searchbox");

      await cards.first().evaluate(
        (card, keys) => {
          for (const key of keys) {
            card.dispatchEvent(
              new KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                key,
              }),
            );
          }
        },
        [nextCardKey, "ArrowDown"],
      );
      await expect(search).toBeFocused();

      await page.evaluate(
        async () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve();
              });
            });
          }),
      );
      await expect(search).toBeFocused();
      await expect(
        page.locator('[data-clipboard-id="clip-2"]'),
      ).toHaveAttribute("aria-current", "true");
    });
  });
}

test("keyboard navigation mounts and focuses virtualized cards", async ({
  page,
}) => {
  await openClipboard(page, "en");
  await expect(page.locator('[data-clipboard-id="clip-13"]')).toHaveCount(0);

  for (let index = 1; index < 13; index += 1) {
    await page.keyboard.press("ArrowRight");
  }

  const targetCard = page.locator('[data-clipboard-id="clip-13"]');
  await expect(
    targetCard.locator("[data-clipboard-card-trigger]"),
  ).toBeFocused();
  await expect(targetCard).toHaveAttribute("aria-current", "true");
});

test("restores footer arrow navigation after changing a menu setting", async ({
  page,
}) => {
  const cards = await openClipboard(page, "en");
  const search = page.getByRole("searchbox");
  const activeGroup = page.locator(
    '[data-clipboard-group-id][aria-pressed="true"]',
  );
  const focusActiveGroup = async () => {
    await page.keyboard.press("ArrowDown");
    await expect(search).toBeFocused();
    const searchFocusColor = await page
      .locator(".clipboard-search")
      .evaluate(
        (control) => getComputedStyle(control, "::after").borderTopColor,
      );
    await page.keyboard.press("ArrowRight");
    await expect(activeGroup).toBeFocused();
    return { indicator: await readFocusIndicator(page), searchFocusColor };
  };

  const initialFocus = await focusActiveGroup();
  expect(initialFocus.indicator.outlineColor).toBe(
    initialFocus.searchFocusColor,
  );
  expect(initialFocus.indicator.outlineStyle).toBe("solid");
  expect(initialFocus.indicator.outlineWidth).toBe("2px");
  await page.keyboard.press("ArrowUp");
  await expect(cards.first()).toBeFocused();

  const moreOptions = page.getByRole("button", { name: "More options" });
  await moreOptions.click();
  const screenCaptureSetting = page.getByRole("menuitemcheckbox");
  await screenCaptureSetting.click();
  await expect(screenCaptureSetting).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(screenCaptureSetting).toBeHidden();
  await expect(moreOptions).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(moreOptions).toBeFocused();
  await expect(screenCaptureSetting).toBeHidden();
  await page.keyboard.press("ArrowLeft");
  const workGroup = page.locator('[data-clipboard-group-id="work"]');
  await expect(workGroup).toBeFocused();
  expect(
    await readFocusIndicator(page, '[data-clipboard-group-id="work"]'),
  ).toEqual(initialFocus.indicator);
  await page.keyboard.press("ArrowRight");
  await expect(moreOptions).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(moreOptions).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(cards.first()).toBeFocused();

  await page.keyboard.press("ArrowDown");
  const footerControls = page.locator(
    ".clipboard-controls button:not([disabled]):not([aria-disabled='true']), .clipboard-controls a[href], .clipboard-controls input:not([disabled])",
  );
  await expect(footerControls).toHaveCount(7);
  await expect(footerControls.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(footerControls.first()).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(footerControls.nth(1)).toBeFocused();
  for (let index = 2; index < 7; index += 1) {
    await page.keyboard.press("ArrowRight");
    await expect(footerControls.nth(index)).toBeFocused();
  }
  for (let index = 5; index >= 0; index -= 1) {
    await page.keyboard.press("ArrowLeft");
    await expect(footerControls.nth(index)).toBeFocused();
  }
});

test("Escape closes the active overlay before hiding the clipboard", async ({
  page,
}) => {
  const cards = await openClipboard(page, "en");

  await page.getByRole("searchbox").fill("Clipboard");
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => await invocationCount(page, "clipboard_hide"))
    .toBe(1);
  await expect(page.getByRole("searchbox")).toHaveValue("Clipboard");

  const moreOptions = page.getByRole("button", { name: "More options" });
  await moreOptions.click();
  const menuSetting = page.getByRole("menuitemcheckbox");
  await expect(menuSetting).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menuSetting).toBeHidden();
  expect(await invocationCount(page, "clipboard_hide")).toBe(1);
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => await invocationCount(page, "clipboard_hide"))
    .toBe(2);

  await cards.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to group" }).hover();
  await page.getByRole("menuitem", { name: "New group" }).click();
  const dialog = page.getByRole("dialog", { name: "New group" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await invocationCount(page, "clipboard_hide")).toBe(2);
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => await invocationCount(page, "clipboard_hide"))
    .toBe(3);
});

test("creates a group from a clip with inline preset and custom colors", async ({
  page,
}) => {
  const cards = await openClipboard(page, "en");

  await cards.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to group" }).hover();
  await page.getByRole("menuitem", { name: "New group" }).click();

  const dialog = page.getByRole("dialog", { name: "New group" });
  await expect(dialog).toBeVisible();
  const groupName = dialog.getByRole("textbox");
  await expect(groupName).toBeFocused();
  await groupName.fill("Client intake");

  const picker = dialog.locator('[data-slot="color-picker"]');
  const colorControls = picker.getByRole("button");
  await expect(colorControls).toHaveCount(7);
  await expect(page.locator('[data-slot="color-picker-popup"]')).toHaveCount(0);
  await expect(
    page.locator('[data-slot="color-picker-custom-popup"]'),
  ).toHaveCount(0);
  await expect(dialog).not.toContainText("#60A5FA");
  const clipping = await picker.evaluate((controls) => {
    const dialogBounds = controls
      .closest('[role="dialog"]')
      ?.getBoundingClientRect();
    if (!dialogBounds) {
      return null;
    }
    return Array.from(controls.querySelectorAll("button")).map((swatch) => {
      const bounds = swatch.getBoundingClientRect();
      return {
        bottom: bounds.bottom > Math.min(dialogBounds.bottom, innerHeight),
        height: bounds.height,
        left: bounds.left < Math.max(dialogBounds.left, 0),
        right: bounds.right > Math.min(dialogBounds.right, innerWidth),
        top: bounds.top < Math.max(dialogBounds.top, 0),
        width: bounds.width,
      };
    });
  });
  expect(clipping).toEqual(
    Array.from({ length: 7 }, () => ({
      bottom: false,
      height: 44,
      left: false,
      right: false,
      top: false,
      width: 44,
    })),
  );
  const preset = picker.getByRole("button", { name: "#60A5FA" });
  await preset.click();
  await expect(preset).toHaveAttribute("aria-pressed", "true");
  const pickerOverflow = await readPickerOverflow(picker);
  expect(pickerOverflow).toEqual({
    clipped: [],
    horizontal: false,
    vertical: false,
  });
  await expect(
    page.locator('[data-slot="color-picker-custom-popup"]'),
  ).toHaveCount(0);

  const customColor = picker.getByRole("button", { name: "Custom color" });
  await customColor.click();
  const customPicker = page.locator('[data-slot="color-picker-custom-popup"]');
  await expect(customPicker).toBeVisible();
  const customHex = customPicker.getByRole("textbox", {
    name: "Custom hex color",
  });
  await expect(customHex).toBeVisible();
  await customHex.fill("112233");
  await expect(customColor).toHaveAttribute("aria-pressed", "true");
  await expect(customColor).toHaveCSS("background-color", "rgb(17, 34, 51)");
  await expect(dialog).not.toContainText("#112233");
  const expandedPickerBounds = await customPicker.evaluate((popup) => {
    const bounds = popup.getBoundingClientRect();
    return {
      bottom: bounds.bottom <= innerHeight,
      left: bounds.left >= 0,
      right: bounds.right <= innerWidth,
      top: bounds.top >= 0,
    };
  });
  expect(expandedPickerBounds).toEqual({
    bottom: true,
    left: true,
    right: true,
    top: true,
  });
  await page.keyboard.press("Escape");
  await expect(customPicker).toBeHidden();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Create" }).click();

  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Client intake" }),
  ).toBeVisible();
  const createGroupArgs = await page.evaluate(() => {
    const invocations: unknown = Reflect.get(
      window,
      "__STELLA_TEST_INVOCATIONS__",
    );
    if (!Array.isArray(invocations)) {
      return null;
    }
    for (const invocation of invocations) {
      if (
        typeof invocation !== "object" ||
        invocation === null ||
        !("command" in invocation) ||
        invocation.command !== "clipboard_create_group" ||
        !("args" in invocation) ||
        typeof invocation.args !== "object" ||
        invocation.args === null
      ) {
        continue;
      }
      return {
        color: "color" in invocation.args ? invocation.args.color : undefined,
        itemId:
          "itemId" in invocation.args ? invocation.args.itemId : undefined,
        name: "name" in invocation.args ? invocation.args.name : undefined,
      };
    }
    return null;
  });
  expect(createGroupArgs).toEqual({
    color: "#112233",
    itemId: "clip-1",
    name: "Client intake",
  });

  const createdGroup = page.getByRole("button", { name: "Client intake" });
  await createdGroup.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit group" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit group" });
  const savedCustomColor = editDialog.getByRole("button", {
    name: "Custom color",
  });
  await expect(savedCustomColor).toHaveAttribute("aria-pressed", "true");
  await expect(savedCustomColor).toHaveCSS(
    "background-color",
    "rgb(17, 34, 51)",
  );
  await editDialog.getByRole("textbox").fill("Client intake renamed");
  await editDialog.getByRole("button", { name: "Edit group" }).click();
  const updateGroupArgs = await page.evaluate(() => {
    const invocations: unknown = Reflect.get(
      window,
      "__STELLA_TEST_INVOCATIONS__",
    );
    if (!Array.isArray(invocations)) {
      return null;
    }
    const invocation = invocations.findLast(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        "command" in candidate &&
        candidate.command === "clipboard_update_group",
    );
    if (
      typeof invocation !== "object" ||
      invocation === null ||
      !("args" in invocation) ||
      typeof invocation.args !== "object" ||
      invocation.args === null
    ) {
      return null;
    }
    return invocation.args;
  });
  expect(updateGroupArgs).toEqual({
    color: "#112233",
    id: "created-group",
    name: "Client intake renamed",
  });
});
