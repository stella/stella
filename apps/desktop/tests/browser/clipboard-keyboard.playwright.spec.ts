import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { TauriEvent } from "@tauri-apps/api/event";

import { DEFAULT_CLIPBOARD_GROUP_COLOR } from "../../src/clipboard/clipboard-style";
import { isClipboardSnapshot } from "../../src/clipboard/clipboard-types";
import type {
  ClipboardCaptureUpdate,
  ClipboardSnapshot,
} from "../../src/clipboard/clipboard-types";
import arMessages from "../../src/i18n/langs/ar.json" with { type: "json" };
import enMessages from "../../src/i18n/langs/en.json" with { type: "json" };
import { installTauriIpc, tauriInvocations } from "./tauri-ipc";

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
  revision: 0,
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

type NativeBoundaryOptions = {
  language: "ar" | "en";
  groups?: ClipboardSnapshot["groups"];
  copyLifecycle?: "keepVisible" | "hideUntilReopened";
};

const installNativeBoundary = async (
  page: Page,
  {
    language,
    groups = SNAPSHOT.groups,
    copyLifecycle = "keepVisible",
  }: NativeBoundaryOptions,
) => {
  expect(isClipboardSnapshot(SNAPSHOT)).toBe(true);
  await installTauriIpc(page, {
    windowLabel: "clipboard",
    unhandled: "resolveUndefined",
    arg: {
      clipboardSnapshot: { ...SNAPSHOT, groups },
      nativeLanguage: language,
      nativeBlurEvent: TauriEvent.WINDOW_BLUR,
      nativeCopyLifecycle: copyLifecycle,
    },
    handlers: (
      {
        clipboardSnapshot,
        nativeLanguage,
        nativeBlurEvent,
        nativeCopyLifecycle,
      },
      { emit, invocations },
    ) => {
      let session = 1;
      let latestCapture: ClipboardCaptureUpdate | null = null;
      Reflect.set(
        window,
        "__STELLA_TEST_CAPTURE_CLIPBOARD__",
        (texts: string[]) => {
          const notifications = [];
          for (const text of texts) {
            clipboardSnapshot.revision += 1;
            const original = clipboardSnapshot.items.at(0);
            if (!original) {
              throw new TypeError(
                "Capture fixture requires an existing text item",
              );
            }
            const item = {
              ...original,
              id: `captured-${clipboardSnapshot.revision}`,
              name: text,
              plainText: text,
            };
            clipboardSnapshot.items.unshift(item);
            latestCapture = {
              revision: clipboardSnapshot.revision,
              item,
              removedItemIds: [],
              sourceAppVisuals: [],
            };
            const payload = { revision: clipboardSnapshot.revision };
            notifications.push(payload);
            emit("clipboard-history-changed", payload);
          }
          return notifications;
        },
      );
      Reflect.set(window, "__STELLA_TEST_REOPEN_CLIPBOARD__", () => {
        if (!document.documentElement.hidden) {
          throw new TypeError("Clipboard must be hidden before a new session");
        }
        document.documentElement.hidden = false;
        window.dispatchEvent(new FocusEvent("focus"));
        session += 1;
        return session;
      });
      Reflect.set(window, "__STELLA_TEST_NATIVE_BLUR__", () => {
        const subscription = invocations.findLast(
          ({ args, command }) =>
            command === "plugin:event|listen" &&
            args["event"] === nativeBlurEvent,
        );
        emit(nativeBlurEvent, null);
        return subscription?.args["target"];
      });
      const copy = () => {
        if (nativeCopyLifecycle === "hideUntilReopened") {
          document.documentElement.hidden = true;
          window.dispatchEvent(new FocusEvent("blur"));
        }
        return undefined;
      };
      return {
        clipboard_copy_item: copy,
        clipboard_copy_items: copy,
        clipboard_hide: copy,
        clipboard_delete_item: (args) => ({
          ...clipboardSnapshot,
          items: clipboardSnapshot.items.filter(
            (item) => item.id !== args["id"],
          ),
        }),
        clipboard_get_capture_update: async (args) => {
          // A burst can replace the retained delta before a request is served.
          await Promise.resolve();
          return latestCapture?.revision === args["revision"]
            ? latestCapture
            : null;
        },
        clipboard_get_snapshot: () => structuredClone(clipboardSnapshot),
        clipboard_create_group: (args) => {
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
        },
        clipboard_update_group: (args) => ({
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
        }),
        clipboard_set_screen_capture: (args) => ({
          ...clipboardSnapshot,
          screenCapture: args["capture"] === "visible" ? "visible" : "hidden",
        }),
        clipboard_exclude_item_source_app: (args) => {
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
        },
        clipboard_remove_source_app_exclusion: () => ({
          ...clipboardSnapshot,
          sourceAppExclusions: [],
        }),
        get_desktop_language: () => nativeLanguage,
        registry_get_state: () => ({ status: "disconnected" }),
        is_autostart_enabled: () => false,
      };
    },
  });
};

const openClipboard = async (page: Page, language: "ar" | "en") => {
  await installNativeBoundary(page, { language });
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
  (await tauriInvocations(page)).filter(
    (invocation) => invocation.command === command,
  ).length;

const lastInvocationArgs = async (page: Page, command: string) =>
  (await tauriInvocations(page)).findLast(
    (invocation) => invocation.command === command,
  )?.args ?? null;

/**
 * Resolves once a tooltip popup is on screen, or once the open delay has
 * passed without one. Tooltips open on a timer, so a missing popup is only
 * conclusive after that window.
 */
const waitForTooltip = async (page: Page) =>
  await page
    .locator('[data-slot="tooltip-popup"]')
    .first()
    .waitFor({ state: "attached", timeout: 800 })
    .then(
      () => true,
      () => false,
    );

test("captures use a caller-scoped delta and recover a burst revision gap", async ({
  page,
}) => {
  await openClipboard(page, "en");
  const capture = async (texts: string[]) =>
    page.evaluate((values): unknown => {
      const emit: unknown = Reflect.get(
        window,
        "__STELLA_TEST_CAPTURE_CLIPBOARD__",
      );
      if (typeof emit !== "function") {
        throw new TypeError("Native capture boundary is missing");
      }
      return emit(values);
    }, texts);
  expect(await capture(["First new capture"])).toEqual([{ revision: 1 }]);
  await expect(
    page.getByText("First new capture", { exact: true }).first(),
  ).toBeVisible();
  expect(
    await lastInvocationArgs(page, "clipboard_get_capture_update"),
  ).toEqual({ revision: 1 });
  const snapshotsBeforeBurst = (await tauriInvocations(page)).filter(
    ({ command }) => command === "clipboard_get_snapshot",
  ).length;
  expect(await capture(["Second new capture", "Third new capture"])).toEqual([
    { revision: 2 },
    { revision: 3 },
  ]);
  await expect(
    page.getByText("Third new capture", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Second new capture", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("First new capture", { exact: true }).first(),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await tauriInvocations(page)).filter(
          ({ command }) => command === "clipboard_get_snapshot",
        ).length,
    )
    .toBe(snapshotsBeforeBurst + 1);
});

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
      // Swallow the rail's scroll events, then scroll it: the card window is
      // now computed for the old offset, which is the blank rail a scroll the
      // listeners missed (one applied while the window was parked) leaves
      // behind. The rail is measured in the same task as the scroll, because
      // any later commit, such as one still settling the page after load,
      // already reconciles it.
      const visibleCards = await rail.evaluate(
        (node, toward) => {
          node.addEventListener(
            "scroll",
            (event) => event.stopImmediatePropagation(),
            { capture: true },
          );
          node.scrollTo({ behavior: "instant", left: toward * 2400 });
          const bounds = node.getBoundingClientRect();
          return Array.from(
            node.querySelectorAll("[data-clipboard-id]"),
          ).filter((card) => {
            const { left, right } = card.getBoundingClientRect();
            return right > bounds.left && left < bounds.right;
          }).length;
        },
        language === "ar" ? -1 : 1,
      );
      expect(visibleCards).toBe(0);
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

const FORMATTED_CLIP = { id: "clip-1", plainText: "Clipboard item 1" } as const;

const expectPastePreview = async (
  page: Page,
  format: "original" | "plainText",
) => {
  const card = page.locator(`[data-clipboard-id="${FORMATTED_CLIP.id}"]`);
  const content = card.locator("[data-clipboard-card-trigger]");
  const label = card.locator("[data-clipboard-paste-preview-label]");
  await expect(card).toHaveAttribute("data-clipboard-render-format", format);
  await expect(content).toContainText(FORMATTED_CLIP.plainText);
  if (format === "plainText") {
    await expect(label).toHaveText(enMessages.clipboard.plainTextPreview);
    await expect(content.locator("strong")).toHaveCount(0);
    return;
  }
  await expect(label).toHaveCount(0);
  await expect(content.locator("strong")).toHaveText(FORMATTED_CLIP.plainText);
};

// Base UI ignores a WebKit mouse move that reports no movement (a pointer
// resting while the list scrolls under it), and Playwright's WebKit reports
// movementX/Y 0 for every synthetic move, `hover()` and stepped moves alike.
// A real pointer arriving over an item moves, so the hover adds that move.
const hoverMenuItem = async (item: Locator) => {
  await item.hover();
  await item.dispatchEvent("mousemove", {
    bubbles: true,
    movementX: 1,
    movementY: 1,
  });
};

test("hovering a plain-text paste option previews the clip without formatting", async ({
  page,
}) => {
  const cards = await openClipboard(page, "en");
  await expectPastePreview(page, "original");

  await cards.first().click({ button: "right" });
  await hoverMenuItem(page.getByRole("menuitem", { name: "Paste text as" }));
  const plainText = page.getByRole("menuitem", { name: "Plain text" });
  const original = page.getByRole("menuitem", {
    name: "Original formatting",
  });
  await hoverMenuItem(plainText);
  await expectPastePreview(page, "plainText");
  await hoverMenuItem(original);
  await expectPastePreview(page, "original");
  await hoverMenuItem(plainText);
  await expectPastePreview(page, "plainText");
  await hoverMenuItem(page.getByRole("menuitem", { name: "Edit clip" }));
  await expect(plainText).toBeHidden();
  await expectPastePreview(page, "original");

  await hoverMenuItem(page.getByRole("menuitem", { name: "Paste text as" }));
  await hoverMenuItem(plainText);
  await expectPastePreview(page, "plainText");
  // The first Escape closes only the submenu.
  await page.keyboard.press("Escape");
  await expect(plainText).toBeHidden();
  await expectPastePreview(page, "original");
  await hoverMenuItem(page.getByRole("menuitem", { name: "Paste text as" }));
  await hoverMenuItem(plainText);
  await expectPastePreview(page, "plainText");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expectPastePreview(page, "original");

  // Reopening the menu starts without the preview it closed with.
  await cards.first().click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await expectPastePreview(page, "original");
});

// Quarantined: on WebKit the "Plain text" paste option is sometimes not yet in
// the reopened menu when the arrow key moves focus, so the focus assertion
// fails intermittently on unrelated changes (runs 40380441414 and 40353303055
// attempt 1). The fix waits for the menu and its focus by state and removes
// this skip.
// test-quarantine-expires: 2026-11-02T00:00:00.000Z
test.skip("arrow-highlighting a plain-text paste option previews the clip without formatting", async ({
  page,
}) => {
  await openClipboard(page, "en");
  await page
    .locator(
      `[data-clipboard-id="${FORMATTED_CLIP.id}"] [data-clipboard-more-trigger]`,
    )
    .focus();
  await page.keyboard.press("Enter");
  const pasteTextAs = page.getByRole("menuitem", { name: "Paste text as" });
  await expect(pasteTextAs).toBeVisible();
  // Engines differ in which item, if any, an Enter-opened menu highlights, so
  // the walk starts from the submenu trigger.
  await pasteTextAs.focus();
  await expect(pasteTextAs).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const original = page.getByRole("menuitem", {
    name: "Original formatting",
  });
  const plainText = page.getByRole("menuitem", { name: "Plain text" });
  await expect(original).toBeFocused();
  await expectPastePreview(page, "original");
  await page.keyboard.press("ArrowDown");
  await expect(plainText).toBeFocused();
  await expectPastePreview(page, "plainText");
  await page.keyboard.press("ArrowUp");
  await expect(original).toBeFocused();
  await expectPastePreview(page, "original");
  await page.keyboard.press("ArrowDown");
  await expectPastePreview(page, "plainText");
  await page.keyboard.press("ArrowLeft");
  await expect(plainText).toBeHidden();
  await expect(pasteTextAs).toBeFocused();
  await expectPastePreview(page, "original");

  // Reopening the submenu moves focus in asynchronously; ArrowDown before it
  // lands stays on the closed trigger.
  await page.keyboard.press("ArrowRight");
  await expect(original).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(plainText).toBeFocused();
  await expectPastePreview(page, "plainText");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expectPastePreview(page, "original");
});

test("the plain-text format shortcut previews the clip until it is left", async ({
  page,
}) => {
  const cards = await openClipboard(page, "en");
  const shortcuts = page.locator("[data-clipboard-format-shortcuts]");
  const plainText = shortcuts.getByRole("button", { name: "Plain text" });

  await plainText.hover();
  await expectPastePreview(page, "plainText");
  await shortcuts.getByRole("button", { name: "Original formatting" }).hover();
  await expectPastePreview(page, "original");
  await plainText.hover();
  await expectPastePreview(page, "plainText");
  await page.mouse.move(0, 0);
  await expectPastePreview(page, "original");

  // The row unmounts under the pointer when the card stops being active; the
  // preview must not come back with the row.
  await plainText.hover();
  await expectPastePreview(page, "plainText");
  await cards.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(cards.nth(1)).toBeFocused();
  await expectPastePreview(page, "original");
  await page.mouse.move(0, 0);
  await page.keyboard.press("ArrowLeft");
  await expect(cards.first()).toBeFocused();
  await expect(shortcuts).toBeVisible();
  await expectPastePreview(page, "original");

  await plainText.focus();
  await expectPastePreview(page, "plainText");
  await cards.first().focus();
  await expectPastePreview(page, "original");
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
  await page.keyboard.press("Escape");
  await expect(menuSetting).toBeHidden();
  expect(await invocationCount(page, "clipboard_hide")).toBe(1);
  // Closing the menu returns focus to its trigger. Browsers that count that
  // focus as visible open the trigger's tooltip, which becomes the next
  // overlay in the chain and owns the next Escape; browsers that do not open
  // it go straight to hiding. Either way the window waits for an empty chain,
  // so wait out the tooltip's open delay before deciding which case this is.
  const triggerTooltip = page.locator('[data-slot="tooltip-popup"]');
  const tooltipOpened = await waitForTooltip(page);
  if (tooltipOpened) {
    await expect(triggerTooltip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(triggerTooltip).toBeHidden();
    expect(await invocationCount(page, "clipboard_hide")).toBe(1);
  }
  await expect(triggerTooltip).toBeHidden();
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

test("Escape closes a footer overlay whose trigger still holds focus", async ({
  page,
}) => {
  await openClipboard(page, "en");

  const triggers = page.locator(".clipboard-controls [aria-haspopup]");
  const triggerCount = await triggers.count();
  expect(triggerCount).toBeGreaterThan(0);

  const popup = page.getByRole("menu");
  for (let index = 0; index < triggerCount; index += 1) {
    const trigger = triggers.nth(index);
    await trigger.click();
    await expect(popup).toBeVisible();
    // Popups take focus a beat after they open, so Escape often arrives while
    // the trigger still holds it. The overlay owns Escape either way. Wait for
    // the popup to take focus before handing it back, or the late move races
    // the trigger focus below.
    await expect
      .poll(
        async () =>
          await popup.evaluate((element) =>
            element.contains(document.activeElement),
          ),
      )
      .toBe(true);
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await expect(popup).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    expect(await invocationCount(page, "clipboard_hide")).toBe(0);
  }
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
  const createGroupArgs =
    (await tauriInvocations(page)).find(
      ({ command }) => command === "clipboard_create_group",
    )?.args ?? null;
  expect(createGroupArgs).toMatchObject({
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
  const updateGroupArgs = await lastInvocationArgs(
    page,
    "clipboard_update_group",
  );
  expect(updateGroupArgs).toEqual({
    color: "#112233",
    id: "created-group",
    name: "Client intake renamed",
  });
});

for (const language of ["en", "ar"] as const) {
  test(`clip more button reveals without shifting and shares the context menu (${language})`, async ({
    page,
  }) => {
    const cards = await openClipboard(page, language);
    expect(
      await page.evaluate(() => matchMedia("(pointer: fine)").matches),
    ).toBe(true);
    const card = page.locator('[data-clipboard-id="clip-2"]');
    const more = card.locator("[data-clipboard-more-trigger]");
    await expect(card).not.toHaveAttribute("aria-current", "true");
    await expect(more).toHaveCSS("opacity", "0");
    const before = await more.boundingBox();
    expect(before).not.toBeNull();
    await card.hover();
    await expect(more).toHaveCSS("opacity", "1");
    expect(await more.boundingBox()).toEqual(before);
    const placement = await more.evaluate((button) => {
      const cardBounds = button.closest("article")?.getBoundingClientRect();
      if (!cardBounds) {
        throw new TypeError("More button has no clip card");
      }
      const bounds = button.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        top: bounds.top - cardBounds.top,
        left: bounds.left - cardBounds.left,
        right: cardBounds.right - bounds.right,
        nested: button.parentElement?.closest("button") !== null,
      };
    });
    expect(placement.width).toBeGreaterThanOrEqual(24);
    expect(placement.height).toBeGreaterThanOrEqual(24);
    expect(placement.top).toBe(8);
    expect(language === "ar" ? placement.left : placement.right).toBe(8);
    expect(placement.nested).toBe(false);
    await expect(more).toHaveCSS("transition-property", "opacity");
    await page.mouse.move(0, 0);
    await expect(more).toHaveCSS("opacity", "0");
    await more.focus();
    await expect(more).toHaveCSS("opacity", "1");

    await cards.nth(1).click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const secondaryClickItems = await menu
      .getByRole("menuitem")
      .allTextContents();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await more.click({ position: { x: 1, y: 1 } });
    await expect(menu).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    expect(await menu.getByRole("menuitem").allTextContents()).toEqual(
      secondaryClickItems,
    );
    expect(await invocationCount(page, "clipboard_copy_item")).toBe(0);
    expect(await invocationCount(page, "clipboard_hide")).toBe(0);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    const menuPosition = page.locator('[data-slot="menu-positioner"]');
    await more.click({ position: { x: 1, y: 1 } });
    await expect(menu).toBeVisible();
    const firstPosition = await menuPosition.boundingBox();
    expect(firstPosition).not.toBeNull();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await more.click({ position: { x: 18, y: 18 } });
    await expect(menu).toBeVisible();
    await expect
      .poll(async () => await menuPosition.boundingBox())
      .toEqual(firstPosition);
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    expect(await invocationCount(page, "clipboard_copy_item")).toBe(0);
    expect(await invocationCount(page, "clipboard_hide")).toBe(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(more).toHaveCSS("transition-duration", "0s");
  });

  test(`clip more button opens by Tab and Enter and restores focus on Escape (${language})`, async ({
    browserName,
    page,
  }) => {
    const cards = await openClipboard(page, language);
    const more = page.locator(
      '[data-clipboard-id="clip-1"] [data-clipboard-more-trigger]',
    );
    const messages = language === "ar" ? arMessages : enMessages;
    await expect(more).toHaveAccessibleName(
      messages.clipboard.moreItemActions.replace("{number}", "1"),
    );
    await expect(more).toHaveAttribute("aria-haspopup", "menu");
    await expect(more).toHaveCSS("opacity", "1");
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const pasteOptions = page.locator(
      "[data-clipboard-format-shortcuts] button",
    );
    await expect(pasteOptions).toHaveCount(2);
    await cards.first().press(tab);
    await expect(pasteOptions.first()).toBeFocused();
    await page.keyboard.press(tab);
    await expect(pasteOptions.last()).toBeFocused();
    await page.keyboard.press(tab);
    await expect(more).toBeFocused();
    await more.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(more).toBeFocused();
    expect(await invocationCount(page, "clipboard_copy_item")).toBe(0);
    expect(await invocationCount(page, "clipboard_hide")).toBe(0);
  });
}

test.describe("clip more button on coarse pointers", () => {
  test.use({ hasTouch: true });

  for (const language of ["en", "ar"] as const) {
    test(`inactive card shows its actions and opens the context menu (${language})`, async ({
      page,
    }) => {
      const cards = await openClipboard(page, language);
      expect(
        await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      ).toBe(true);
      const card = page.locator('[data-clipboard-id="clip-2"]');
      const more = card.locator("[data-clipboard-more-trigger]");
      await expect(card).not.toHaveAttribute("aria-current", "true");
      await expect(more).toHaveCSS("opacity", "1");

      await cards.nth(1).click({ button: "right" });
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      const contextItems = await menu.getByRole("menuitem").allTextContents();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await more.tap();
      await expect(menu).toBeVisible();
      await expect(more).toHaveAttribute("aria-expanded", "true");
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual(
        contextItems,
      );
      expect(await invocationCount(page, "clipboard_copy_item")).toBe(0);
      expect(await invocationCount(page, "clipboard_hide")).toBe(0);
    });
  }
});

test("Cmd-click toggles ordered selection and Escape clears it before hiding", async ({
  page,
}) => {
  const cards = await openClipboard(page, "en");
  await cards.nth(2).click({ modifiers: ["Meta"] });
  await cards.nth(0).click({ modifiers: ["Meta"] });
  await cards.nth(1).click({ modifiers: ["Meta"] });
  await expect(cards.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(cards.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(cards.nth(2)).toHaveAttribute("aria-pressed", "true");
  expect(await invocationCount(page, "clipboard_copy_item")).toBe(0);
  await cards.nth(0).click({ modifiers: ["Meta"] });
  await expect(cards.nth(0)).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-selected]")).toHaveCount(0);
  expect(await invocationCount(page, "clipboard_hide")).toBe(0);
  await cards.nth(2).click({ modifiers: ["Meta"] });
  await cards.nth(1).click({ modifiers: ["Meta"] });
  await page.keyboard.press("Meta+c");
  expect(await lastInvocationArgs(page, "clipboard_copy_items")).toEqual({
    format: "original",
    ids: ["clip-3", "clip-2"],
  });
  await expect(page.locator("[data-selected]")).toHaveCount(0);
  await cards.nth(0).click();
  expect(await lastInvocationArgs(page, "clipboard_copy_item")).toEqual({
    format: "original",
    id: "clip-1",
  });
});

test("click and Enter paste the selection in click order using either format", async ({
  page,
}) => {
  const cards = await openClipboard(page, "en");
  await cards.nth(1).click({ modifiers: ["Meta"] });
  await cards.nth(0).click({ modifiers: ["Meta"] });
  await cards.nth(2).click({ modifiers: ["Meta"] });
  await cards.nth(0).click();
  expect(await lastInvocationArgs(page, "clipboard_copy_items")).toEqual({
    format: "original",
    ids: ["clip-2", "clip-1", "clip-3"],
  });
  await expect(page.locator("[data-selected]")).toHaveCount(0);
  await cards.nth(1).click({ modifiers: ["Meta"] });
  await cards.nth(0).click({ modifiers: ["Meta"] });
  await cards.nth(2).click({ modifiers: ["Meta"] });
  await page.keyboard.press("Shift+Enter");
  expect(await lastInvocationArgs(page, "clipboard_copy_items")).toEqual({
    format: "plainText",
    ids: ["clip-2", "clip-1", "clip-3"],
  });
});

test("paste footer options share hover and focus treatment and activate independently", async ({
  page,
}) => {
  await openClipboard(page, "en");
  const footer = page.locator("[data-clipboard-format-shortcuts]");
  const original = footer.getByRole("button", { name: "Original formatting" });
  const plain = footer.getByRole("button", { name: "Plain text" });
  for (const option of [original, plain]) {
    await option.hover();
    const hovered = await option.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await page.mouse.move(0, 0);
    await option.focus();
    expect(
      await option.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    ).toBe(hovered);
  }
  await page.keyboard.press("Enter");
  expect(await lastInvocationArgs(page, "clipboard_copy_item")).toEqual({
    format: "plainText",
    id: "clip-1",
  });
  await original.click();
  expect(await lastInvocationArgs(page, "clipboard_copy_item")).toEqual({
    format: "original",
    id: "clip-1",
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`every group chip keeps its focus marker inside the rail (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await installNativeBoundary(page, {
      language: "en",
      groups: [
        ...SNAPSHOT.groups,
        ...Array.from({ length: 9 }, (_, index) => ({
          color: DEFAULT_CLIPBOARD_GROUP_COLOR,
          id: `overflow-group-${index}`,
          name: `Collection ${index + 1}`,
        })),
      ],
    });
    await page.goto("/");
    await expect(
      page.locator("[data-clipboard-card-trigger]").first(),
    ).toBeFocused();
    const rail = page.locator(".clipboard-groups-rail");
    expect(
      await rail
        .locator("[data-clipboard-groups-scroller]")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
    const chips = rail.locator("button");
    expect(await chips.count()).toBeGreaterThanOrEqual(3);
    for (const chip of await chips.all()) {
      await chip.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowLeft");
      await expect(chip).toBeFocused();
      const marker = await chip.evaluate((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        const parentRail =
          element.closest("[data-clipboard-groups-scroller]") ??
          element.closest("nav");
        if (!parentRail) {
          throw new TypeError("Chip has no rail");
        }
        const railBounds = parentRail.getBoundingClientRect();
        return {
          inset: style.getPropertyValue("--tw-ring-inset").trim(),
          offset: style.getPropertyValue("--tw-ring-offset-width").trim(),
          outline: Number.parseFloat(style.outlineWidth),
          outlineOffset: Number.parseFloat(style.outlineOffset),
          bounds: {
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            bottom: bounds.bottom,
          },
          railBounds: {
            left: railBounds.left,
            right: railBounds.right,
            top: railBounds.top,
            bottom: railBounds.bottom,
          },
        };
      });
      expect(marker.inset).toBe("inset");
      expect(marker.offset).toBe("0px");
      expect(marker.outlineOffset).toBeLessThanOrEqual(-marker.outline);
      expect(marker.bounds.left).toBeGreaterThanOrEqual(marker.railBounds.left);
      expect(marker.bounds.right).toBeLessThanOrEqual(marker.railBounds.right);
      expect(marker.bounds.top).toBeGreaterThanOrEqual(marker.railBounds.top);
      expect(marker.bounds.bottom).toBeLessThanOrEqual(
        marker.railBounds.bottom,
      );
    }
  });
}

test("a successful multi-copy cannot carry selection into a reopened clipboard session", async ({
  page,
}) => {
  await installNativeBoundary(page, {
    language: "en",
    copyLifecycle: "hideUntilReopened",
  });
  await page.goto("/");
  const cards = page.locator("[data-clipboard-card-trigger]");
  await expect(cards.first()).toBeFocused();
  await cards.nth(0).click({ modifiers: ["Meta"] });
  await cards.nth(2).click({ modifiers: ["Meta"] });
  await page.keyboard.press("Meta+c");
  await expect(page.locator("html")).toHaveAttribute("hidden", "");
  expect(await lastInvocationArgs(page, "clipboard_copy_items")).toEqual({
    format: "original",
    ids: ["clip-1", "clip-3"],
  });
  const session = await page.evaluate(() => {
    const reopen: unknown = Reflect.get(
      window,
      "__STELLA_TEST_REOPEN_CLIPBOARD__",
    );
    if (typeof reopen !== "function") {
      throw new TypeError("Native reopen boundary missing");
    }
    return reopen();
  });
  expect(session).toBe(2);
  await expect(page.locator("html")).not.toHaveAttribute("hidden");
  await cards.nth(3).click();
  expect(await lastInvocationArgs(page, "clipboard_copy_item")).toEqual({
    format: "original",
    id: "clip-4",
  });
  expect(await invocationCount(page, "clipboard_copy_items")).toBe(1);
});

test("dismissing and reopening starts a new selection session without a copy", async ({
  page,
}) => {
  await installNativeBoundary(page, {
    language: "en",
    copyLifecycle: "hideUntilReopened",
  });
  await page.goto("/");
  const cards = page.locator("[data-clipboard-card-trigger]");
  await expect(cards.first()).toBeFocused();
  await cards.first().click({ modifiers: ["Meta"] });
  await expect(page.locator("[data-selected]")).toHaveCount(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("hidden", "");
  expect(
    await page.evaluate(() => {
      const reopen: unknown = Reflect.get(
        window,
        "__STELLA_TEST_REOPEN_CLIPBOARD__",
      );
      if (typeof reopen !== "function") {
        throw new TypeError("Native reopen boundary missing");
      }
      return reopen();
    }),
  ).toBe(2);
  await expect(page.locator("[data-selected]")).toHaveCount(0);
  await cards.nth(3).click();
  expect(await lastInvocationArgs(page, "clipboard_copy_item")).toEqual({
    format: "original",
    id: "clip-4",
  });
  expect(await invocationCount(page, "clipboard_copy_items")).toBe(0);
});

for (const language of ["en", "ar"] as const) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`scrolled collection chips never paint under the create control (${language}, ${colorScheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await installNativeBoundary(page, {
        language,
        groups: [
          ...SNAPSHOT.groups,
          ...Array.from({ length: 9 }, (_, index) => ({
            color: DEFAULT_CLIPBOARD_GROUP_COLOR,
            id: `overflow-group-${index}`,
            name: `Collection ${index + 1}`,
          })),
        ],
      });
      await page.goto("/");
      await expect(
        page.locator("[data-clipboard-card-trigger]").first(),
      ).toBeFocused();
      const rail = page.locator(".clipboard-groups-rail");
      const create = rail.locator("button").nth(1);
      const before = await create.boundingBox();
      await rail.locator("[data-group-chip]").last().focus();
      await expect(create).toBeVisible();
      const overlaps = await rail.evaluate((element) => {
        const createControl = element.querySelectorAll("button").item(1);
        const createBounds = createControl.getBoundingClientRect();
        return Array.from(element.querySelectorAll("[data-group-chip]")).map(
          (chip) => {
            const viewport =
              chip.closest("[data-clipboard-groups-scroller]") ?? element;
            const bounds = chip.getBoundingClientRect();
            const clip = viewport.getBoundingClientRect();
            const left = Math.max(bounds.left, clip.left);
            const right = Math.min(bounds.right, clip.right);
            return Math.max(
              0,
              Math.min(right, createBounds.right) -
                Math.max(left, createBounds.left),
            );
          },
        );
      });
      for (const overlap of overlaps) {
        expect(overlap).toBe(0);
      }
      expect(await create.boundingBox()).toEqual(before);
      await create.click();
      await expect(page.getByRole("dialog")).toBeVisible();
    });
  }
}

test("Control-click builds an ordered selection on Windows and Linux", async ({
  page,
}) => {
  test.skip(
    process.platform === "darwin",
    "macOS reserves Control-click for its native context menu",
  );
  const cards = await openClipboard(page, "en");
  await cards.nth(2).click({ modifiers: ["Control"] });
  await cards.first().click({ modifiers: ["Control"] });
  await expect(cards.nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(cards.first()).toHaveAttribute("aria-pressed", "true");
  expect(await invocationCount(page, "clipboard_copy_item")).toBe(0);
  await page.keyboard.press("Enter");
  expect(await lastInvocationArgs(page, "clipboard_copy_items")).toEqual({
    format: "original",
    ids: ["clip-3", "clip-1"],
  });
});

test("Space toggles the focused card once per press without copying", async ({
  page,
}) => {
  const cards = await openClipboard(page, "en");
  await page.keyboard.down("Space");
  await page.keyboard.down("Space");
  await page.keyboard.up("Space");
  await expect(cards.first()).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(cards.first()).toHaveAttribute("aria-pressed", "false");
  await cards.nth(2).focus();
  await page.keyboard.press("Space");
  await cards.first().focus();
  await page.keyboard.press("Space");
  expect(await invocationCount(page, "clipboard_copy_item")).toBe(0);
  await page.keyboard.press("Enter");
  expect(await lastInvocationArgs(page, "clipboard_copy_items")).toEqual({
    format: "original",
    ids: ["clip-3", "clip-1"],
  });
});

test("deleting a selected clip removes it from the next ordered paste", async ({
  page,
}) => {
  const cards = await openClipboard(page, "en");
  await cards.first().click({ modifiers: ["Meta"] });
  await cards.nth(2).click({ modifiers: ["Meta"] });
  await cards.first().focus();
  await page.keyboard.press("Delete");
  await expect(page.locator('[data-clipboard-id="clip-1"]')).toHaveCount(0);
  await page.keyboard.press("Meta+c");
  expect(await lastInvocationArgs(page, "clipboard_copy_items")).toEqual({
    format: "original",
    ids: ["clip-3"],
  });
});
