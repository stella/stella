import { expect, type Locator, type Page, test } from "@playwright/test";

import { launchExtensionHarness } from "./fixtures/harness";

type Harness = Awaited<ReturnType<typeof launchExtensionHarness>>;

/**
 * The page backgrounds of the web app's light and dark themes
 * (packages/ui/src/styles/theme.css), written as the app writes them.
 */
const APP_BACKGROUND = {
  dark: "color-mix(in srgb, oklch(14.5% 0 0) 95%, #fff)",
  light: "#fff",
} as const;

const openPopup = async ({ context, worker }: Harness): Promise<Page> => {
  const popup = await context.newPage();
  await popup.goto(new URL("/popup.html", worker.url()).href);
  return popup;
};

const activeTabUrl = async ({ worker }: Harness): Promise<string | null> =>
  await worker.evaluate(
    async () =>
      (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).at(0)
        ?.url ?? null,
  );

/** Any CSS colour as the sRGB bytes Chrome paints for it. */
const paintedColour = async (page: Page, css: string): Promise<number[]> =>
  await page.evaluate((colour) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (context === null) {
      return [];
    }
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }, css);

const relativeLuminance = (rgb: readonly number[]): number => {
  const [red = 0, green = 0, blue = 0] = rgb.map((byte) => {
    const channel = byte / 255;
    // The sRGB threshold; no byte falls between 0.04 and 0.04045.
    return channel <= 0.04
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

const contrast = (one: readonly number[], other: readonly number[]): number => {
  const [lighter, darker] = [relativeLuminance(one), relativeLuminance(other)]
    .toSorted((left, right) => right - left)
    .map((luminance) => luminance + 0.05);
  return (lighter ?? 1) / (darker ?? 1);
};

const computed = async (
  locator: Locator,
  property: "background-color" | "color",
): Promise<string> =>
  await locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );

/** Text against what is painted behind it: its own fill, or the page. */
const expectReadable = async (
  page: Page,
  locator: Locator,
  { against, minimum }: { against: "own" | "page"; minimum: number },
) => {
  const text = await paintedColour(page, await computed(locator, "color"));
  const behind = await paintedColour(
    page,
    await computed(
      against === "own" ? locator : page.locator("body"),
      "background-color",
    ),
  );
  expect(contrast(text, behind)).toBeGreaterThanOrEqual(minimum);
};

for (const colorScheme of ["light", "dark"] as const) {
  test(`the popup follows the ${colorScheme} system theme and offers to open stella`, async () => {
    const harness = await launchExtensionHarness({ colorScheme });
    try {
      const popup = await openPopup(harness);
      // The popup is the tab in front, so no stella tab is there to connect.
      await expect(popup.locator("#status-text")).toHaveText(
        "Open stella to connect",
      );

      const body = popup.locator("body");
      expect(
        await paintedColour(popup, await computed(body, "background-color")),
      ).toEqual(await paintedColour(popup, APP_BACKGROUND[colorScheme]));
      expect(
        await paintedColour(popup, await computed(body, "background-color")),
      ).not.toEqual(
        await paintedColour(
          popup,
          APP_BACKGROUND[colorScheme === "dark" ? "light" : "dark"],
        ),
      );

      // The status reads as a status, not as a control.
      const status = popup.locator("#status");
      await expect(status).toHaveAttribute("role", "status");
      await expect(status).not.toHaveCSS("cursor", "pointer");
      await expect(status).toHaveCSS("border-top-style", "none");
      await expect(status).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

      // Until stella desktop is allowed, its row is the link alone.
      await expect(popup.locator("#desktop-status")).toBeHidden();
      await expect(
        popup.getByRole("button", { name: "Use with stella desktop" }),
      ).toBeVisible();

      // The mark draws the bundled symbol in the tile's foreground colour.
      const symbol = popup.locator(".mark-symbol");
      await expect(symbol).toHaveCSS(
        "mask-image",
        /\/brand\/stella-symbol\.svg/u,
      );
      expect(
        await popup.evaluate(
          async () =>
            (
              await fetch("/brand/stella-symbol.svg", {
                signal: AbortSignal.timeout(10_000),
              })
            ).ok,
        ),
      ).toBe(true);
      const tile = popup.locator(".mark");
      expect(
        contrast(
          await paintedColour(
            popup,
            await computed(symbol, "background-color"),
          ),
          await paintedColour(popup, await computed(tile, "background-color")),
        ),
      ).toBeGreaterThanOrEqual(4.5);

      const primary = popup.locator("#primary");
      await expect(primary).toHaveText("Open stella");
      await expect(primary).toBeEnabled();
      await expectReadable(popup, primary, { against: "own", minimum: 4.5 });
      await expectReadable(popup, popup.locator("#status-text"), {
        against: "page",
        minimum: 4.5,
      });
      await expectReadable(popup, popup.locator("#purpose"), {
        against: "page",
        minimum: 4.5,
      });
      await expectReadable(
        popup,
        popup.getByRole("button", { name: "Remove access" }),
        { against: "page", minimum: 4.5 },
      );
      // A status dot is a graphic: 3:1 against the page.
      expect(
        contrast(
          await paintedColour(
            popup,
            await computed(
              popup.locator("#status .status-marker"),
              "background-color",
            ),
          ),
          await paintedColour(popup, await computed(body, "background-color")),
        ),
      ).toBeGreaterThanOrEqual(3);

      // Opening brings the open stella tab forward; the popup then offers
      // the usual connect step for it.
      await primary.click();
      await expect
        .poll(async () => await activeTabUrl(harness))
        .toBe(`${harness.stellaOrigin}/chat`);
      await expect(primary).toHaveText("Connect stella");
      await primary.click();
      await expect(popup.locator("#status-text")).toHaveText("Connected");
      const disconnect = popup.getByRole("button", { name: "Disconnect" });
      await expectReadable(popup, disconnect, { against: "own", minimum: 4.5 });
      expect(
        contrast(
          await paintedColour(
            popup,
            await computed(
              status.locator(".status-marker"),
              "background-color",
            ),
          ),
          await paintedColour(popup, await computed(body, "background-color")),
        ),
      ).toBeGreaterThanOrEqual(3);
    } finally {
      await harness.close();
    }
  });
}
