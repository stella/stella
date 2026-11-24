import { expect, test } from "@playwright/test";

import { DESKTOP_APPEARANCE_STORAGE_KEY } from "../../src/shared/desktop-appearance";
import type { DesktopAppearance } from "../../src/shared/desktop-appearance";

const DOCUMENTS = [{ html: "/", module: /\/main\.tsx(?:\?.*)?$/u }] as const;
const LIGHT = {
  backgroundColor: "rgb(255, 255, 255)",
  colorScheme: "light",
  dark: false,
} as const;
const DARK = {
  backgroundColor: "rgb(12, 12, 13)",
  colorScheme: "dark",
  dark: true,
} as const;

/** What the window paints first, for the system's scheme and the cached
 *  choice (none when no window has cached one yet). */
const CASES = [
  { cached: null, expected: LIGHT, scheme: "light" },
  { cached: null, expected: DARK, scheme: "dark" },
  { cached: "system", expected: DARK, scheme: "dark" },
  { cached: "dark", expected: DARK, scheme: "light" },
  { cached: "light", expected: LIGHT, scheme: "dark" },
] as const satisfies readonly {
  cached: DesktopAppearance | null;
  expected: typeof LIGHT | typeof DARK;
  scheme: "dark" | "light";
}[];

for (const documentCase of DOCUMENTS) {
  for (const { cached, expected, scheme } of CASES) {
    test(`applies ${expected.colorScheme} for a ${scheme} system and ${cached ?? "no"} cached choice before ${documentCase.html} loads its module`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      if (cached !== null) {
        await page.addInitScript(
          ({ key, value }) => {
            localStorage.setItem(key, value);
          },
          { key: DESKTOP_APPEARANCE_STORAGE_KEY, value: cached },
        );
      }
      let signalModuleRequested: (() => void) | undefined;
      const moduleRequested = new Promise<void>((resolve) => {
        signalModuleRequested = resolve;
      });
      let releaseModule: (() => void) | undefined;
      const moduleReleased = new Promise<void>((resolve) => {
        releaseModule = resolve;
      });
      await page.route(documentCase.module, async (route) => {
        signalModuleRequested?.();
        await moduleReleased;
        await route.fulfill({ body: "", contentType: "text/javascript" });
      });

      const navigation = page.goto(documentCase.html, { waitUntil: "commit" });
      await moduleRequested;
      await navigation;
      await page.waitForFunction(
        () => document.documentElement.style.colorScheme !== "",
      );

      expect(
        await page.evaluate(() => ({
          backgroundColor: document.documentElement.style.backgroundColor,
          colorScheme: document.documentElement.style.colorScheme,
          dark: document.documentElement.classList.contains("dark"),
        })),
      ).toEqual(expected);

      releaseModule?.();
    });
  }
}
