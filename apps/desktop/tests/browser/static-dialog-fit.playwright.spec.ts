import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";

const localeRoot = new URL("../../src/i18n/langs/", import.meta.url);
const locales = readdirSync(localeRoot).filter((name) =>
  name.endsWith(".json"),
);

const flattenStrings = (
  value: unknown,
  prefix = "",
): Record<string, string> => {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Expected a catalogue object");
  }
  const entries: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") {
      entries[path] = child;
    } else {
      Object.assign(entries, flattenStrings(child, path));
    }
  }
  return entries;
};

for (const file of locales) {
  const locale = file.slice(0, -5);
  const catalog: unknown = JSON.parse(
    readFileSync(new URL(file, localeRoot), "utf-8"),
  );
  if (
    typeof catalog !== "object" ||
    catalog === null ||
    !("dialog" in catalog)
  ) {
    throw new TypeError("Missing dialog catalogue");
  }
  const strings = flattenStrings(catalog.dialog);
  for (const kind of ["selfhost-connect", "pdf-sign"] as const) {
    test(`${locale} ${kind} fits its localized content`, async ({ page }) => {
      await page.setViewportSize({ width: 420, height: 320 });
      await page.exposeFunction(
        "resizeDialog",
        async ({ width, height }: { width: number; height: number }) => {
          await page.setViewportSize({ width, height });
          return { maxWidth: 720, maxHeight: 704 };
        },
      );
      await page.addInitScript(() => {
        Object.defineProperties(screen, {
          availHeight: { value: 768 },
          availWidth: { value: 1440 },
        });
        Reflect.set(window, "__TAURI_INTERNALS__", {
          invoke: (command: string, size: unknown) =>
            command === "fit_static_dialog"
              ? Reflect.get(window, "resizeDialog")(size)
              : Promise.resolve(null),
        });
      });
      const params = new URLSearchParams({
        lang: locale,
        dir: locale === "ar" ? "rtl" : "ltr",
        strings: JSON.stringify(strings),
        webOrigin: "https://matters.example.test",
        apiBaseUrl: "https://api.matters.example.test",
        documentName:
          "Commercial lease renewal — Riverside office premises.pdf",
        workspaceName: "Riverside office lease renewal",
        apiOrigin: "https://api.matters.example.test",
        versionNumber: "12",
        state: JSON.stringify("ready"),
        identities: JSON.stringify([
          {
            id: "certificate",
            label: "Practice signing certificate",
            issuer: "Practice certificate authority",
            expiresOn: "2027-10-09",
          },
        ]),
      });
      await page.goto(`/${kind}-dialog.html#${params}`);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const dialog = document.querySelector(".dialog");
            if (!dialog) {
              return false;
            }
            const rect = dialog.getBoundingClientRect();
            return (
              rect.bottom <= innerHeight &&
              rect.width <= innerWidth &&
              innerHeight > 320
            );
          }),
        )
        .toBe(true);
      expect(
        await page.evaluate(() => ({
          scrolling: document.documentElement.scrollHeight > innerHeight,
          firstContentTop: document
            .querySelector(".mark")
            ?.getBoundingClientRect().top,
        })),
      ).toMatchObject({ scrolling: false, firstContentTop: 56 });
      await expect(page.getByRole("button").last()).toBeInViewport({
        ratio: 1,
      });
      if (locale === "ar" || locale === "de") {
        await page.screenshot({
          path: `.cache/dialog-fit-${locale}-${kind}.png`,
        });
      }
      if (kind === "pdf-sign") {
        const failure = Object.entries(strings)
          .filter(([key]) => key.startsWith("pdfSignErrors."))
          .toSorted(([, left], [, right]) => right.length - left.length)
          .at(0)
          ?.at(1);
        await page.evaluate((message) => {
          const status = document.querySelector("#status");
          if (!(status instanceof HTMLElement)) {
            throw new TypeError(
              "The PDF-sign dialog must contain a status element",
            );
          }
          status.textContent = message;
          status.hidden = false;
        }, failure ?? "");
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (document.querySelector(".actions")?.getBoundingClientRect()
                  .bottom ?? Infinity) <= innerHeight,
            ),
          )
          .toBe(true);
      }
    });
  }
}
