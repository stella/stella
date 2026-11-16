import { expect, type Locator, type Page, test } from "@playwright/test";
import { panic } from "better-result";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { launchExtensionHarness } from "./fixtures/harness";

type Harness = Awaited<ReturnType<typeof launchExtensionHarness>>;
type ColorScheme = "dark" | "light";

const UI_PACKAGE = path.join(import.meta.dirname, "../../../packages/ui");

/**
 * Each popup token and the web app token it takes its value from: all of
 * them in dark, where the popup follows the app; the page background in
 * light too.
 */
const APP_TOKENS = {
  dark: {
    "--background": "--background",
    "--foreground": "--foreground",
    "--muted-foreground": "--muted-foreground",
    "--primary": "--primary",
    "--primary-foreground": "--primary-foreground",
    "--secondary": "--input",
    "--secondary-foreground": "--secondary-foreground",
    "--status-access-needed": "--warning-foreground",
    "--status-connected": "--success-foreground",
    "--status-idle": "--ring",
  },
  light: { "--background": "--background" },
} as const satisfies Record<ColorScheme, Record<string, string>>;

/** The declarations of the first `selector` rule that sets the page background. */
const themeRule = (css: string, selector: string): Map<string, string> => {
  const rule =
    css
      .split(`\n${selector} {\n`)
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf("\n}")))
      .find((body) => /^\s*--background:/mu.test(body)) ??
    panic(`No ${selector} rule sets --background`);
  return new Map(
    [...rule.matchAll(/(--[\w-]+):\s*([^;]+);/gu)].map(([, name, value]) => [
      name ?? "",
      (value ?? "").replaceAll(/\s+/gu, " ").trim(),
    ]),
  );
};

/**
 * The web app's tokens for one scheme, read from its stylesheet with the
 * colour scale substituted, so Chrome can paint them as they are.
 */
const appTokens = async (
  colorScheme: ColorScheme,
): Promise<Map<string, string>> => {
  const [appCss, scaleCss] = await Promise.all([
    readFile(path.join(UI_PACKAGE, "src/styles/theme.css"), "utf-8"),
    readFile(
      createRequire(path.join(UI_PACKAGE, "package.json")).resolve(
        "tailwindcss/theme.css",
      ),
      "utf-8",
    ),
  ]);
  const scale = new Map(
    [...scaleCss.matchAll(/(--color-[\w-]+):\s*([^;]+);/gu)].map(
      ([, name, value]) => [name ?? "", (value ?? "").trim()],
    ),
  );
  const rule = themeRule(appCss, colorScheme === "dark" ? ".dark" : ":root");
  const resolve = (value: string): string =>
    value
      .replaceAll(
        /--alpha\((.+?) \/ ([\d.]+%)\)/gu,
        (_match, colour: string, amount: string) =>
          `color-mix(in srgb, ${colour} ${amount}, transparent)`,
      )
      .replaceAll(
        /var\((--color-[\w-]+)\)/gu,
        (_match, name: string) =>
          scale.get(name) ?? panic(`Unknown colour ${name}`),
      )
      .replaceAll(/var\(--background\)/gu, () =>
        resolve(rule.get("--background") ?? panic("No app background")),
      );
  return new Map(
    Object.entries(APP_TOKENS[colorScheme]).map(([popupToken, appToken]) => [
      popupToken,
      resolve(rule.get(appToken) ?? panic(`No app token ${appToken}`)),
    ]),
  );
};

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

/** Any CSS colour as the sRGB bytes Chrome paints for it, over `behind`. */
const paintedColour = async (
  page: Page,
  css: string,
  behind = "transparent",
): Promise<number[]> =>
  await page.evaluate(
    ({ colour, under }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (context === null) {
        return [];
      }
      for (const fill of [under, colour]) {
        context.fillStyle = fill;
        context.fillRect(0, 0, 1, 1);
      }
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    },
    { colour: css, under: behind },
  );

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

      // Every mirrored token paints as the web app's own value.
      const body = popup.locator("body");
      const expected = await appTokens(colorScheme);
      const appBackground = expected.get("--background") ?? "";
      for (const [token, appValue] of expected) {
        const popupValue = await popup.evaluate(
          (name) =>
            getComputedStyle(document.documentElement).getPropertyValue(name),
          token,
        );
        const painted = await paintedColour(popup, popupValue, appBackground);
        const wanted = await paintedColour(popup, appValue, appBackground);
        expect(painted, token).toHaveLength(3);
        // Chrome and the build may round a mixed colour one step apart.
        for (const [channel, value] of painted.entries()) {
          expect(
            Math.abs(value - (wanted[channel] ?? -9)),
            `${token}: ${popupValue} against ${appValue}`,
          ).toBeLessThanOrEqual(1);
        }
      }
      expect(
        await paintedColour(popup, await computed(body, "background-color")),
      ).toEqual(await paintedColour(popup, appBackground));
      expect(
        await paintedColour(popup, await computed(body, "background-color")),
      ).not.toEqual(
        await paintedColour(
          popup,
          (await appTokens(colorScheme === "dark" ? "light" : "dark")).get(
            "--background",
          ) ?? "",
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

      // The mark is the extension's own icon, the one the toolbar shows.
      const mark = popup.locator("img.mark");
      const icon = await popup.evaluate(
        () => chrome.runtime.getManifest().icons?.["128"] ?? null,
      );
      expect(icon).not.toBeNull();
      expect(
        await mark.evaluate((image) =>
          image instanceof HTMLImageElement
            ? { naturalWidth: image.naturalWidth, src: image.src }
            : null,
        ),
      ).toEqual({
        naturalWidth: 128,
        src: new URL(`/${icon ?? ""}`, popup.url()).href,
      });
      await expect(mark).toHaveCSS("width", "32px");

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
