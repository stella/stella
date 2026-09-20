import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { TauriEvent } from "@tauri-apps/api/event";

import { DEFAULT_CLIPBOARD_GROUP_COLOR } from "../../src/clipboard/clipboard-style";
import { isClipboardSnapshot } from "../../src/clipboard/clipboard-types";
import type { ClipboardSnapshot } from "../../src/clipboard/clipboard-types";
import arMessages from "../../src/i18n/langs/ar.json" with { type: "json" };
import enMessages from "../../src/i18n/langs/en.json" with { type: "json" };

const CLIPBOARD_ITEMS = Array.from({ length: 14 }, (_, index) => {
  const item = {
    copiedAt: "2026-09-08T05:00:00.000Z",
    groupId: index === 1 ? "work" : null,
    groupedAt: index === 1 ? "2026-09-08T05:00:00.000Z" : null,
    id: `clip-${index + 1}`,
    name: `Clip ${index + 1}`,
    plainText: `Clipboard item ${index + 1}`,
    sourceApp:
      index === 0
        ? {
            identifier: "com.example.editor",
            name: "Example Editor",
            page: null,
            visualKey: null,
          }
        : null,
  };
  return index === 0
    ? {
        ...item,
        html: "<strong>Clipboard item 1</strong>",
        type: "formattedText" as const,
      }
    : { ...item, type: "text" as const };
}) satisfies ClipboardSnapshot["items"];

const SNAPSHOT = {
  captureStatus: "active",
  groupLimit: 24,
  groups: [{ color: DEFAULT_CLIPBOARD_GROUP_COLOR, id: "work", name: "Work" }],
  items: CLIPBOARD_ITEMS,
  persistence: { imageCleanup: "idle", status: "encrypted" },
  retention: "month",
  screenCapture: "hidden",
  sourceAppExclusionLimit: 128,
  sourceAppExclusions: [],
  sourceAppVisuals: [],
  welcomeStatus: "completed",
} satisfies ClipboardSnapshot;

const installNativeBoundary = async (page: Page, language: "ar" | "en") => {
  expect(isClipboardSnapshot(SNAPSHOT)).toBe(true);
  await page.addInitScript(
    ({ clipboardSnapshot, nativeLanguage, nativeBlurEvent }) => {
      const callbacks = new Map<number, (data: unknown) => unknown>();
      const invocations: {
        args: Record<string, unknown>;
        command: string;
      }[] = [];
      let nextCallbackId = 1;

      Reflect.set(window, "__STELLA_TEST_INVOCATIONS__", invocations);
      Reflect.set(window, "__STELLA_TEST_NATIVE_BLUR__", () => {
        const subscription = invocations.findLast(
          ({ args, command }) =>
            command === "plugin:event|listen" &&
            args["event"] === nativeBlurEvent,
        );
        const id = subscription?.args["handler"];
        if (typeof id !== "number") {
          throw new TypeError("Native window blur listener is not installed");
        }
        callbacks.get(id)?.({ event: nativeBlurEvent, id, payload: null });
        return subscription?.args["target"];
      });
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
          if (command === "clipboard_exclude_item_source_app") {
            const item = clipboardSnapshot.items.find(
              ({ id }) => id === args["id"],
            );
            const sourceApp = item?.sourceApp;
            return sourceApp?.identifier
              ? {
                  ...clipboardSnapshot,
                  sourceAppExclusions: [
                    {
                      identifier: sourceApp.identifier.toLowerCase(),
                      name: sourceApp.name,
                    },
                  ],
                }
              : clipboardSnapshot;
          }
          if (command === "clipboard_remove_source_app_exclusion") {
            return { ...clipboardSnapshot, sourceAppExclusions: [] };
          }
          if (command === "get_desktop_language") {
            return nativeLanguage;
          }
          if (command === "registry_get_state") {
            return { status: "disconnected" };
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
    {
      clipboardSnapshot: SNAPSHOT,
      nativeLanguage: language,
      nativeBlurEvent: TauriEvent.WINDOW_BLUR,
    },
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

const lastInvocationArgs = async (page: Page, command: string) =>
  page.evaluate((expectedCommand) => {
    const invocations: unknown = Reflect.get(
      window,
      "__STELLA_TEST_INVOCATIONS__",
    );
    if (!Array.isArray(invocations)) {
      return null;
    }
    const invocation: unknown = invocations.findLast(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        "command" in candidate &&
        candidate.command === expectedCommand,
    );
    if (
      typeof invocation !== "object" ||
      invocation === null ||
      !("args" in invocation)
    ) {
      return null;
    }
    return invocation.args;
  }, command);

const DIRECTIONS = [
  {
    groupKey: "ArrowRight",
    language: "en",
    nextCardKey: "ArrowRight",
    previousGroupKey: "ArrowLeft",
  },
  {
    groupKey: "ArrowLeft",
    language: "ar",
    nextCardKey: "ArrowLeft",
    previousGroupKey: "ArrowRight",
  },
] as const;

for (const {
  groupKey,
  language,
  nextCardKey,
  previousGroupKey,
} of DIRECTIONS) {
  test.describe(`${language} clipboard direction`, () => {
    test.use({ locale: language });

    for (const activation of ["pointer", "keyboard"] as const) {
      test(`${activation} search action opens registry results in the same clipboard window`, async ({
        page,
      }) => {
        const messages = language === "ar" ? arMessages : enMessages;
        await openClipboard(page, language);
        await page.getByRole("searchbox").fill("Clipboard item 2");
        if (activation === "pointer") {
          await page.locator("[data-clipboard-scope]").click();
        } else {
          await page.locator("[data-clipboard-scope]").focus();
          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("Tab");
        }
        await expect(page.locator("[data-clipboard-scope]")).toHaveAttribute(
          "data-clipboard-scope",
          "registry",
        );
        await expect(page.getByRole("searchbox")).toHaveValue(
          "Clipboard item 2",
        );
        await expect(page.getByRole("searchbox")).toBeFocused();
        await expect(
          page.getByRole("button", {
            name: messages.clipboard.registryConnect,
            exact: true,
          }),
        ).toBeVisible();
        await expect(page).toHaveURL(/\/$/u);
        expect(await invocationCount(page, "registry_show")).toBe(0);
        expect(await invocationCount(page, "registry_search")).toBe(0);
      });
    }

    test("an empty clip search offers the same query to registries", async ({
      page,
    }) => {
      const messages = language === "ar" ? arMessages : enMessages;
      const query = "No local match";
      await openClipboard(page, language);
      await page.getByRole("searchbox").fill(query);
      const searchRegistries = page.getByRole("button", {
        name: messages.clipboard.noResultsDescription.replace(
          "{query}",
          () => query,
        ),
      });

      await searchRegistries.click();
      await expect(page.locator("[data-clipboard-scope]")).toHaveAttribute(
        "data-clipboard-scope",
        "registry",
      );
      await expect(page.getByRole("searchbox")).toHaveValue(query);
      await expect(page.getByRole("searchbox")).toBeFocused();
      await expect(
        page.getByRole("button", {
          name: messages.clipboard.registryConnect,
          exact: true,
        }),
      ).toBeVisible();
    });

    test("search focus and card emphasis stay visually exclusive", async ({
      page,
    }) => {
      const cards = await openClipboard(page, language);
      const search = page.getByRole("searchbox");
      await page.keyboard.press(nextCardKey);
      await expect(cards.nth(1)).toBeFocused();
      await search.focus();
      await expect(search).toBeFocused();
      await expect(
        page.locator('[data-clipboard-id="clip-2"]'),
      ).toHaveAttribute("aria-current", "true");
      await expect
        .poll(
          async () => (await readCardEmphasis(page, "clip-2")).selectionOpacity,
        )
        .toBe("0");
      await page.keyboard.press("ArrowUp");
      await expect(cards.nth(1)).toBeFocused();
      await expect
        .poll(
          async () => (await readCardEmphasis(page, "clip-2")).selectionOpacity,
        )
        .toBe("1");
    });

    test("the forward arrow leaves search for the active clip group", async ({
      page,
    }) => {
      await openClipboard(page, language);
      const search = page.getByRole("searchbox");
      await search.fill("Clipboard");
      await search.evaluate((input, atEnd) => {
        if (!(input instanceof HTMLInputElement)) {
          throw new TypeError("Search field is not an input");
        }
        const position = atEnd ? input.value.length : 0;
        input.setSelectionRange(position, position);
      }, groupKey === "ArrowRight");

      await page.keyboard.press(groupKey);
      await expect(
        page.locator('[data-clipboard-group-id][aria-pressed="true"]'),
      ).toBeFocused();
      await page.keyboard.press(previousGroupKey);
      await expect(search).toBeFocused();
    });

    test("the switcher changes only the search source and preserves the group filter", async ({
      page,
    }) => {
      const cards = await openClipboard(page, language);
      const search = page.getByRole("searchbox");
      const switcher = page.locator("[data-clipboard-scope]");
      // The groups rail yields to the registry chooser in registry scope.
      const groupsRail = page.locator(".clipboard-groups-rail");
      const pressedGroup = page.locator(
        '[data-clipboard-group-id][aria-pressed="true"]',
      );
      await page.keyboard.press(nextCardKey);
      await expect(cards.nth(1)).toBeFocused();
      // Vertical arrows move between the rail and the field, never the scope.
      await page.keyboard.press("ArrowDown");
      await expect(search).toBeFocused();
      await expect(groupsRail).toBeVisible();
      await page.keyboard.press("ArrowUp");
      await expect(cards.nth(1)).toBeFocused();
      await expect(groupsRail).toBeVisible();
      await page.locator('[data-clipboard-group-id="work"]').click();
      await expect(switcher).toHaveAttribute("data-clipboard-scope", "clips");
      await expect(pressedGroup).toHaveAttribute(
        "data-clipboard-group-id",
        "work",
      );
      await search.focus();
      await page.keyboard.press("ArrowDown");
      await expect(search).toBeFocused();
      await switcher.focus();
      await page.keyboard.press("ArrowDown");
      await expect(switcher).toBeFocused();
      await expect(groupsRail).toBeHidden();
      await page.keyboard.press("ArrowDown");
      await expect(groupsRail).toBeHidden();
      await page.keyboard.press("ArrowUp");
      await expect(groupsRail).toBeVisible();
      await expect(pressedGroup).toHaveAttribute(
        "data-clipboard-group-id",
        "work",
      );
      await page.keyboard.press("ArrowUp");
      await expect(groupsRail).toBeVisible();
      await expect(switcher).toBeFocused();
      await expect(
        page.locator('[data-clipboard-id="clip-2"]'),
      ).toHaveAttribute("aria-current", "true");
      // Typing on the switcher lands in the field like everywhere else.
      await page.keyboard.press("C");
      await expect(search).toBeFocused();
      await expect(search).toHaveValue("C");
      expect(await invocationCount(page, "registry_search")).toBe(0);
    });

    for (const dismissal of ["dom", "native"] as const) {
      test(`prepares the first card before reopening after ${dismissal} dismissal`, async ({
        page,
      }) => {
        await openClipboard(page, language);
        for (let index = 0; index < 10; index += 1) {
          await page.keyboard.press(nextCardKey);
        }
        await expect(
          page.locator('[data-clipboard-id="clip-11"]'),
        ).toHaveAttribute("aria-current", "true");

        const parked = await page.evaluate((source) => {
          let eventTarget: unknown;
          if (source === "native") {
            const emit: unknown = Reflect.get(
              window,
              "__STELLA_TEST_NATIVE_BLUR__",
            );
            if (typeof emit !== "function") {
              throw new TypeError(
                "Native window blur boundary is not installed",
              );
            }
            eventTarget = emit();
          } else {
            window.dispatchEvent(new FocusEvent("blur"));
          }
          const selected = document.querySelector<HTMLElement>(
            '[data-clipboard-id][aria-current="true"]',
          );
          const rail = selected?.closest('[role="list"]');
          return {
            selectedId: selected?.dataset["clipboardId"],
            scrollLeft: rail?.scrollLeft,
            eventTarget,
          };
        }, dismissal);
        expect(parked).toEqual({
          selectedId: "clip-1",
          scrollLeft: 0,
          eventTarget:
            dismissal === "native"
              ? { kind: "Window", label: "clipboard" }
              : undefined,
        });
        await page.evaluate(() =>
          window.dispatchEvent(new FocusEvent("focus")),
        );
        await expect(
          page.locator(
            '[data-clipboard-id="clip-1"] [data-clipboard-card-trigger]',
          ),
        ).toBeFocused();
      });
    }

    test("a vertical wheel advances the timeline toward its end", async ({
      page,
    }) => {
      await openClipboard(page, language);
      const rail = page.getByRole("list");
      await rail.hover();
      for (let step = 0; step < 12; step += 1) {
        await page.mouse.wheel(0, 200);
      }
      await expect(
        page.locator('[data-clipboard-id="clip-14"]'),
      ).toBeInViewport();
      const offset = await rail.evaluate((node) => node.scrollLeft);
      expect(language === "ar" ? -offset : offset).toBeGreaterThan(0);
    });

    test("pointer selection fully reveals a partially visible clip", async ({
      page,
    }) => {
      await openClipboard(page, language);
      const rail = page.getByRole("list");
      await rail.evaluate(
        (node, toward) =>
          node.scrollTo({ behavior: "instant", left: toward * 350 }),
        language === "ar" ? -1 : 1,
      );
      await expect
        .poll(async () =>
          rail.evaluate((node) => {
            const railBounds = node.getBoundingClientRect();
            return Array.from(
              node.querySelectorAll<HTMLElement>("[data-clipboard-id]"),
            ).some((card) => {
              const bounds = card.getBoundingClientRect();
              const visible =
                bounds.right > railBounds.left &&
                bounds.left < railBounds.right;
              const clipped =
                bounds.left < railBounds.left - 30 ||
                bounds.right > railBounds.right + 30;
              return visible && clipped;
            });
          }),
        )
        .toBe(true);
      const target = await rail.evaluate((node) => {
        const railBounds = node.getBoundingClientRect();
        const card = Array.from(
          node.querySelectorAll<HTMLElement>("[data-clipboard-id]"),
        ).find((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          const visible =
            bounds.right > railBounds.left && bounds.left < railBounds.right;
          const clipped =
            bounds.left < railBounds.left - 30 ||
            bounds.right > railBounds.right + 30;
          return visible && clipped;
        });
        if (!card) {
          return null;
        }
        const bounds = card.getBoundingClientRect();
        const visibleLeft = Math.max(bounds.left, railBounds.left) + 2;
        const visibleRight = Math.min(bounds.right, railBounds.right) - 2;
        return {
          id: card.dataset["clipboardId"],
          x: (visibleLeft + visibleRight) / 2,
          y: bounds.top + bounds.height / 2,
        };
      });
      expect(target).not.toBeNull();
      if (!target?.id) {
        throw new TypeError("Partially visible clipboard card is missing");
      }
      const search = page.getByRole("searchbox");
      await search.focus();
      await expect(search).toBeFocused();
      await page.mouse.move(target.x, target.y);
      await page.mouse.move(target.x + 1, target.y);

      const selected = page.locator(`[data-clipboard-id="${target.id}"]`);
      await expect(selected).toHaveAttribute("aria-current", "true");
      await expect
        .poll(async () =>
          selected.evaluate((card) => {
            const railBounds = card.parentElement?.getBoundingClientRect();
            const cardBounds = card.getBoundingClientRect();
            return Boolean(
              railBounds &&
              cardBounds.left >= railBounds.left + 19 &&
              cardBounds.right <= railBounds.right - 19,
            );
          }),
        )
        .toBe(true);
    });

    test("a scroll the rail never observed is reconciled by the next commit", async ({
      page,
    }) => {
      await openClipboard(page, language);
      const rail = page.getByRole("list");
      const visibleCards = async () =>
        rail.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          return Array.from(
            node.querySelectorAll("[data-clipboard-id]"),
          ).filter((card) => {
            const { left, right } = card.getBoundingClientRect();
            return right > bounds.left && left < bounds.right;
          }).length;
        });
      // Swallow the rail's scroll events, then scroll it: the card window is
      // now computed for the old offset, which is the blank rail a scroll the
      // listeners missed (one applied while the window was parked) leaves
      // behind.
      await rail.evaluate(
        (node, toward) => {
          node.addEventListener(
            "scroll",
            (event) => event.stopImmediatePropagation(),
            { capture: true },
          );
          node.scrollTo({ behavior: "instant", left: toward * 2400 });
        },
        language === "ar" ? -1 : 1,
      );
      await page.waitForTimeout(100);
      expect(await visibleCards()).toBe(0);
      // Any commit re-reads the rail; typing a query every clip matches is one
      // that neither scrolls nor changes the list.
      await page.getByRole("searchbox").fill("Clipboard item");
      await expect(
        page.locator('[data-clipboard-id="clip-14"]'),
      ).toBeInViewport();
    });

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
      browserName,
      page,
    }) => {
      const tabBack = browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
      const tabForward = browserName === "webkit" ? "Alt+Tab" : "Tab";
      const cards = await openClipboard(page, language);
      const selectedCard = page.locator('[data-clipboard-id="clip-2"]');
      const restingCard = page.locator('[data-clipboard-id="clip-1"]');
      const activeGroup = page.locator(
        '[data-clipboard-group-id][aria-pressed="true"]',
      );

      await page.keyboard.press(nextCardKey);
      await expect(cards.nth(1)).toBeFocused();
      await page.mouse.move(0, 0);
      await page.getByRole("searchbox").focus();
      await expect(page.getByRole("searchbox")).toBeFocused();

      await page.keyboard.press(tabBack);
      await expect(page.locator("[data-clipboard-scope]")).toBeFocused();
      await page.keyboard.press(tabBack);
      await expect(
        page.getByRole("link", { name: "Stella", exact: true }),
      ).toBeFocused();
      await page.keyboard.press(groupKey);
      await expect(page.getByRole("searchbox")).toBeFocused();
      await page.keyboard.press(tabForward);
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
      await cards.nth(1).focus();
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
        [nextCardKey, "C"],
      );
      await expect(search).toBeFocused();
      await expect(search).toHaveValue("C");
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
    });
  });
}

test("formatted clips expose copy variants and reversible app exclusions", async ({
  page,
}) => {
  const cards = await openClipboard(page, "en");
  await cards.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Paste text as" }).hover();
  await page.getByRole("menuitem", { name: "Plain text" }).click();
  expect(await lastInvocationArgs(page, "clipboard_copy_item")).toEqual({
    format: "plainText",
    id: "clip-1",
  });

  await cards.first().click({ button: "right" });
  await page
    .getByRole("menuitem", {
      name: "Stop saving new clips from Example Editor",
    })
    .click();
  expect(
    await lastInvocationArgs(page, "clipboard_exclude_item_source_app"),
  ).toEqual({ id: "clip-1" });

  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Excluded applications" }).hover();
  await page
    .getByRole("menuitem", {
      name: "Save new clips from Example Editor again",
    })
    .click();
  expect(
    await lastInvocationArgs(page, "clipboard_remove_source_app_exclusion"),
  ).toEqual({ identifier: "com.example.editor" });
});

test("formatted clips advertise and execute both keyboard paste formats", async ({
  page,
}) => {
  const cards = await openClipboard(page, "en");
  const shortcuts = page.locator("[data-clipboard-format-shortcuts]");
  await expect(shortcuts).toContainText("Original formatting");
  await expect(shortcuts).toContainText("Plain text");
  await expect(shortcuts.locator("kbd")).toHaveText(["↵", "⇧↵"]);

  await page.keyboard.press("Shift+Enter");
  expect(await lastInvocationArgs(page, "clipboard_copy_item")).toEqual({
    format: "plainText",
    id: "clip-1",
  });

  await page.keyboard.press("Enter");
  expect(await lastInvocationArgs(page, "clipboard_copy_item")).toEqual({
    format: "original",
    id: "clip-1",
  });

  await page.keyboard.press("ArrowRight");
  await expect(cards.nth(1)).toBeFocused();
  await expect(shortcuts).toHaveCount(0);
});

test("source application names stay isolated inside RTL actions", async ({
  page,
}) => {
  const cards = await openClipboard(page, "ar");
  await cards.first().click({ button: "right" });
  const excludeLabel = arMessages.clipboard.excludeSourceApp.replace(
    "<bdi>{source}</bdi>",
    "Example Editor",
  );
  const excludeAction = page.getByRole("menuitem", { name: excludeLabel });
  await expect(excludeAction.locator("bdi[dir=auto]")).toHaveText(
    "Example Editor",
  );
  await excludeAction.click();

  await page
    .getByRole("button", { name: arMessages.clipboard.moreOptions })
    .click();
  await page
    .getByRole("menuitem", {
      name: arMessages.clipboard.excludedApplications,
    })
    .hover();
  const restoreLabel = arMessages.clipboard.removeSourceAppExclusion.replace(
    "<bdi>{source}</bdi>",
    "Example Editor",
  );
  await expect(
    page.getByRole("menuitem", { name: restoreLabel }).locator("bdi[dir=auto]"),
  ).toHaveText("Example Editor");
});

test("inline clip naming uses the full footer width", async ({ page }) => {
  await openClipboard(page, "en");
  const card = page.locator('[data-clipboard-id="clip-1"]');
  await card.locator('button[title="Edit clip"]').click();
  const input = card.locator("[data-clipboard-name-input]");

  await expect(input).toBeFocused();
  await expect(card.locator("footer kbd")).toHaveCount(0);
  // Enter and Shift+Enter finish the rename here, so the copy hints must go.
  await expect(card.locator("[data-clipboard-format-shortcuts]")).toHaveCount(
    0,
  );
  expect((await input.boundingBox())?.width ?? 0).toBeGreaterThan(190);
});

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

test("the selected group tints the whole clipboard window", async ({
  page,
}) => {
  await openClipboard(page, "en");
  const clipboardWindow = page.locator('[role="application"]');
  await expect(clipboardWindow).not.toHaveAttribute("data-active-group");

  await page.locator('[data-clipboard-group-id="work"]').click();
  await expect(clipboardWindow).toHaveAttribute("data-active-group", "");

  await page.locator('[data-clipboard-group-id="__no_group__"]').click();
  await expect(clipboardWindow).not.toHaveAttribute("data-active-group");
});

test("restores footer arrow navigation after changing a menu setting", async ({
  browserName,
  page,
}) => {
  const tabBack = browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
  const cards = await openClipboard(page, "en");
  const search = page.getByRole("searchbox");
  const activeGroup = page.locator(
    '[data-clipboard-group-id][aria-pressed="true"]',
  );
  const focusActiveGroup = async () => {
    await search.focus();
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
  await cards.first().focus();
  await expect(cards.first()).toBeFocused();

  const moreOptions = page.getByRole("button", { name: "More options" });
  await moreOptions.click();
  const screenCaptureSetting = page.getByRole("menuitemcheckbox");
  await screenCaptureSetting.click();
  await expect(screenCaptureSetting).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(screenCaptureSetting).toBeHidden();
  await expect(moreOptions).toBeFocused();

  // A closed menu trigger keeps the standard menu-button arrows.
  await page.keyboard.press("ArrowDown");
  await expect(screenCaptureSetting).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(screenCaptureSetting).toBeHidden();
  await expect(moreOptions).toBeFocused();
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
  await cards.first().focus();
  await expect(cards.first()).toBeFocused();

  await search.focus();
  const footerControls = page.locator(
    ".clipboard-controls button:not([disabled]):not([aria-disabled='true']):not([data-clipboard-scope]), .clipboard-controls a[href], .clipboard-controls input:not([disabled])",
  );
  const footerControlCount = await footerControls.count();
  expect(footerControlCount).toBeGreaterThan(1);
  await expect(footerControls.nth(1)).toHaveAccessibleName(
    enMessages.clipboard.search,
  );
  await expect(
    page.locator(".clipboard-search button:not([data-clipboard-scope])"),
  ).toHaveCount(0);
  await expect(footerControls.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(footerControls.nth(2)).toBeFocused();
  for (let index = 3; index < footerControlCount; index += 1) {
    await page.keyboard.press("ArrowRight");
    await expect(footerControls.nth(index)).toBeFocused();
  }
  for (let index = footerControlCount - 2; index >= 0; index -= 1) {
    if (index === 0) {
      await page.keyboard.press(tabBack);
    }
    await page.keyboard.press(index === 0 ? tabBack : "ArrowLeft");
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
  // The popup takes focus a beat after it opens; Escape must reach the menu,
  // not the trigger, to exercise overlay-before-clipboard dismissal.
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.activeElement?.closest('[role="menu"]') !== null,
        ),
    )
    .toBe(true);
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

  await page.getByRole("searchbox").focus();
  await page.getByRole("searchbox").evaluate((input) => input.blur());
  await expect(page.locator("body")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => await invocationCount(page, "clipboard_hide"))
    .toBe(4);
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
