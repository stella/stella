import { expect, test } from "@playwright/test";

const DOCUMENTS = [{ html: "/", module: /\/main\.tsx(?:\?.*)?$/u }] as const;
const SCHEMES = [
  {
    backgroundColor: "rgb(255, 255, 255)",
    colorScheme: "light",
    dark: false,
    scheme: "light",
  },
  {
    backgroundColor: "rgb(12, 12, 13)",
    colorScheme: "dark",
    dark: true,
    scheme: "dark",
  },
] as const;

for (const documentCase of DOCUMENTS) {
  for (const schemeCase of SCHEMES) {
    test(`applies ${schemeCase.scheme} before ${documentCase.html} loads its module`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: schemeCase.scheme });
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
      ).toEqual({
        backgroundColor: schemeCase.backgroundColor,
        colorScheme: schemeCase.colorScheme,
        dark: schemeCase.dark,
      });

      releaseModule?.();
    });
  }
}
