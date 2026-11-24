import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  emitTauriEvent,
  installTauriIpc,
  tauriInvocations,
  unexpectedTauriCalls,
} from "./tauri-ipc";

/** Mirrors `WIDTH` and `HEIGHT` in `dictation_preview.rs`. */
const PANEL = { width: 380, height: 176 } as const;
const CHANGED_EVENT = "dictation-preview-changed";
/** Where a spec puts the snapshot the native side answers with next. */
const SNAPSHOT_GLOBAL = "__dictationPreviewSnapshot";

type Snapshot = {
  stage: "hidden" | "listening" | "finishing";
  text: string;
  anchor: "top" | "bottom";
};

const HIDDEN: Snapshot = { stage: "hidden", text: "", anchor: "top" };

test.use({ deviceScaleFactor: 2 });

test.afterEach(async ({ page }) => {
  expect(await unexpectedTauriCalls(page)).toEqual([]);
  expect(
    (await tauriInvocations(page)).filter(
      ({ command }) => command === "desktop_report_error",
    ),
  ).toEqual([]);
});

const openPanel = async (
  page: Page,
  scheme: "dark" | "light",
  snapshot: Snapshot,
) => {
  await page.setViewportSize(PANEL);
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await installTauriIpc(page, {
    windowLabel: "dictation-preview",
    unhandled: "rejectAsUnexpected",
    arg: { initial: snapshot, global: SNAPSHOT_GLOBAL },
    handlers: (data) => ({
      account_record_use: () => null,
      desktop_report_error: () => null,
      get_desktop_appearance: () => "system",
      get_desktop_language: () => "en",
      set_desktop_language: () => null,
      dictation_preview_get_snapshot: () => {
        const next: unknown = Reflect.get(globalThis, data.global);
        return next ?? data.initial;
      },
    }),
  });
  await page.goto("/");
};

const answer = async (page: Page, snapshot: Snapshot) => {
  await page.evaluate(
    ({ global, next }) => {
      Reflect.set(globalThis, global, next);
    },
    { global: SNAPSHOT_GLOBAL, next: snapshot },
  );
  await emitTauriEvent(page, CHANGED_EVENT);
};

const card = (page: Page) =>
  page.getByRole("region", { name: "What you have said so far" });

/** WCAG contrast of the text against the card it sits on. */
const textContrast = async (page: Page) =>
  await page.evaluate(() => {
    const section = document.querySelector("section");
    const text = section?.querySelector(".dictation-preview-text p");
    if (!(section instanceof HTMLElement) || !(text instanceof HTMLElement)) {
      return 0;
    }
    const channels = (color: string) => {
      const probe = document.createElement("canvas").getContext("2d");
      if (probe === null) {
        return [0, 0, 0, 0];
      }
      probe.fillStyle = color;
      probe.fillRect(0, 0, 1, 1);
      return [...probe.getImageData(0, 0, 1, 1).data];
    };
    const luminance = ([red = 0, green = 0, blue = 0]: number[]) => {
      const linear = (value: number) => {
        const channel = value / 255;
        return channel <= 0.04
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      };
      return (
        0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
      );
    };
    const foreground = luminance(channels(getComputedStyle(text).color));
    const background = luminance(
      channels(getComputedStyle(section).backgroundColor),
    );
    const [lighter, darker] =
      foreground > background
        ? [foreground, background]
        : [background, foreground];
    return (lighter + 0.05) / (darker + 0.05);
  });

for (const scheme of ["light", "dark"] as const) {
  test(`the running transcript grows in the panel and stays readable (${scheme})`, async ({
    page,
  }) => {
    await openPanel(page, scheme, {
      stage: "listening",
      text: "Dear Ms Novak,",
      anchor: "top",
    });
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText("Listening…");
    await expect(card(page)).toContainText("Dear Ms Novak,");
    expect(await textContrast(page)).toBeGreaterThanOrEqual(4.5);

    await answer(page, {
      stage: "listening",
      text: "Dear Ms Novak, thank you for the draft.",
      anchor: "top",
    });
    await expect(card(page)).toContainText("thank you for the draft.");

    await answer(page, {
      stage: "finishing",
      text: "Dear Ms Novak, thank you for the draft. We agree.",
      anchor: "top",
    });
    await expect(card(page)).toContainText("Finishing…");
    await expect(card(page)).toContainText("We agree.");

    await answer(page, HIDDEN);
    await expect(card(page)).toHaveCount(0);
  });
}

test("nothing shows before the first text or for a hidden dictation", async ({
  page,
}) => {
  await openPanel(page, "light", {
    stage: "listening",
    text: "",
    anchor: "top",
  });
  await expect(page.locator("main.dictation-preview-window")).toBeAttached();
  await expect(card(page)).toHaveCount(0);
  await answer(page, { stage: "hidden", text: "stale", anchor: "top" });
  await expect(card(page)).toHaveCount(0);
});

test("a long transcript keeps its newest words in view and fades the top", async ({
  page,
}) => {
  const sentence = "The parties agree that the term ends on 31 December.";
  const text = [
    ...Array.from({ length: 12 }, () => sentence),
    "Last words.",
  ].join(" ");
  await openPanel(page, "light", { stage: "listening", text, anchor: "top" });
  await expect(card(page)).toBeVisible();
  const box = page.locator(".dictation-preview-text");
  await expect(box).toHaveAttribute("data-overflowing", "true");
  const geometry = await box.evaluate((element) => {
    const outer = element.getBoundingClientRect();
    const range = document.createRange();
    const paragraph = element.querySelector("p");
    if (paragraph?.lastChild === null || paragraph?.lastChild === undefined) {
      return null;
    }
    range.selectNodeContents(paragraph.lastChild);
    const rects = [...range.getClientRects()];
    const last = rects.at(-1);
    return last === undefined
      ? null
      : {
          bottom: outer.bottom,
          lastBottom: last.bottom,
          lastTop: last.top,
          top: outer.top,
        };
  });
  expect(geometry).not.toBeNull();
  // The last line sits inside the card's text box, at its bottom.
  expect(geometry?.lastTop ?? 0).toBeGreaterThanOrEqual(geometry?.top ?? 1);
  expect(geometry?.lastBottom ?? 1).toBeLessThanOrEqual(
    (geometry?.bottom ?? 0) + 1,
  );
  // The card stays inside the window.
  const cardBox = await card(page).boundingBox();
  expect(cardBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect(
    (cardBox?.y ?? 0) + (cardBox?.height ?? PANEL.height + 1),
  ).toBeLessThanOrEqual(PANEL.height);
});

test("under a taskbar icon the card sits on the bottom edge", async ({
  page,
}) => {
  await openPanel(page, "dark", {
    stage: "listening",
    text: "Short note.",
    anchor: "bottom",
  });
  await expect(card(page)).toBeVisible();
  const cardBox = await card(page).boundingBox();
  // Against the bottom edge, inside the window's padding.
  expect(
    PANEL.height - ((cardBox?.y ?? 0) + (cardBox?.height ?? 0)),
  ).toBeLessThanOrEqual(12);
  await expect(page.locator(".dictation-preview-text")).toHaveAttribute(
    "data-overflowing",
    "false",
  );
});
