import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

import ar from "../../src/i18n/langs/ar.json" with { type: "json" };
import en from "../../src/i18n/langs/en.json" with { type: "json" };

const html = readFileSync(
  new URL("../../src/mainview/selfhost-connect-dialog.html", import.meta.url),
  "utf-8",
);

for (const [locale, { dialog: strings }] of Object.entries({ en, ar })) {
  for (const recovery of ["close", "retry"] as const) {
    test(`${locale} handoff ${recovery} renders the available action`, async ({
      page,
    }) => {
      const responses: unknown[] = [];
      await page.exposeFunction("recordResponse", (response: unknown) =>
        responses.push(response),
      );
      await page.addInitScript(() => {
        Reflect.set(window, "__TAURI_INTERNALS__", {
          invoke: (command: string, args: unknown) =>
            command === "fit_static_dialog"
              ? Promise.resolve(null)
              : Reflect.get(window, "recordResponse")(args),
        });
      });
      await page.route("**/handoff-dialog-test", async (route) => {
        await route.fulfill({ contentType: "text/html", body: html });
      });
      const params = new URLSearchParams({
        mode: "handoff",
        message:
          recovery === "retry"
            ? strings.handoffFailed
            : strings.handoffUnavailable,
        detail: "detail",
        action: recovery === "retry" ? strings.handoffRetry : "",
        strings: JSON.stringify(strings),
        lang: locale,
        dir: locale === "ar" ? "rtl" : "ltr",
      });
      await page.goto(`/handoff-dialog-test#${params}`);
      await expect(page.locator("html")).toHaveAttribute(
        "dir",
        locale === "ar" ? "rtl" : "ltr",
      );
      await expect(page.getByRole("heading")).toHaveText(
        recovery === "retry"
          ? strings.handoffFailed
          : strings.handoffUnavailable,
      );
      await expect(page.getByRole("button")).toHaveCount(
        recovery === "retry" ? 2 : 1,
      );
      await page
        .getByRole("button", {
          name: recovery === "retry" ? strings.handoffRetry : strings.close,
          exact: true,
        })
        .click();
      await expect
        .poll(() => responses)
        .toEqual([{ approved: recovery === "retry" }]);
    });
  }
}
