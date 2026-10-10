import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

type PickerApp = "document-upload" | "file-comparison";

declare global {
  var pickerFixtureCalls: number;
}

type MountPickerOptions = { page: Page; app: PickerApp };
const mountPicker = async ({ page, app }: MountPickerOptions) => {
  const html = await readFile(
    new URL(`../src/mcp/apps/${app}/generated/app.html.txt`, import.meta.url),
    "utf-8",
  );
  const fixtureUrl = "http://localhost/file-picker-fixture";
  await page.route(fixtureUrl, async (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<iframe id="picker" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>',
    }),
  );
  await page.goto(fixtureUrl);
  const mounted = await page.evaluate(
    ({ html: appHtml }) => {
      const iframe = document.querySelector<HTMLIFrameElement>("iframe");
      if (iframe === null) {
        return "missing" as const;
      }
      window.pickerFixtureCalls = 0;
      const reply = (message: unknown) =>
        iframe.contentWindow?.postMessage(message, "*");
      const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);
      window.addEventListener("message", (event) => {
        const data: unknown = event.data;
        if (event.source !== iframe.contentWindow || !isRecord(data)) {
          return;
        }
        const { method, id } = data;
        switch (method) {
          case "ui/initialize":
            reply({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: "2026-01-26",
                hostInfo: { name: "picker-fixture", version: "1.0.0" },
                hostCapabilities: { serverTools: {} },
                hostContext: { locale: "en-GB", theme: "light" },
              },
            });
            break;
          case "ui/notifications/initialized":
            reply({
              jsonrpc: "2.0",
              method: "ui/notifications/tool-input",
              params: { arguments: { entity_id: "fixture-document" } },
            });
            reply({
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: {
                content: [],
                structuredContent: {
                  entityId: "fixture-document",
                  workspaceId: "fixture-matter",
                },
              },
            });
            break;
          case "tools/call":
            window.pickerFixtureCalls += 1;
            reply({
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: "Fixture upload failed" }],
              },
            });
            break;
          default:
            break;
        }
      });
      // safe-html: build-mcp-apps.ts emits the repository's self-contained picker bundle.
      iframe.srcdoc = appHtml;
      return "mounted" as const;
    },
    { html },
  );
  expect(mounted).toBe("mounted");
  return page.frameLocator("#picker");
};

for (const app of ["document-upload", "file-comparison"] as const) {
  test(`${app}: keyboard upload retries after failure and requires all files`, async ({
    page,
  }) => {
    const picker = await mountPicker({ page, app });
    const upload = picker.locator("#upload");
    await expect(upload).toBeDisabled();
    const fields = picker.locator('[data-slot="file-input-trigger"]');
    const count = app === "document-upload" ? 1 : 2;
    await expect(fields).toHaveCount(count);
    for (let index = 0; index < count; index += 1) {
      const chooser = page.waitForEvent("filechooser");
      await fields.nth(index).click();
      await (
        await chooser
      ).setFiles({
        name: `fixture-${index}.docx`,
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: Buffer.from("fixture file"),
      });
      if (index + 1 < count) {
        await expect(upload).toBeDisabled();
      }
    }
    await expect(upload).toBeEnabled();
    // Host rerenders must preserve the button's React interaction state.
    await page.evaluate(() => {
      document
        .querySelector<HTMLIFrameElement>("iframe")
        ?.contentWindow?.postMessage(
          {
            jsonrpc: "2.0",
            method: "ui/notifications/host-context-changed",
            params: { locale: "en-GB", theme: "light" },
          },
          "*",
        );
    });
    await upload.focus();
    await upload.press("Enter");
    await expect(picker.locator("#status")).toContainText(
      "Fixture upload failed",
    );
    await expect
      .poll(async () => page.evaluate(() => window.pickerFixtureCalls))
      .toBe(1);
    await expect(upload).toBeEnabled();
    for (let index = 0; index < count; index += 1) {
      await expect(fields.nth(index)).toBeEnabled();
    }
    await upload.focus();
    await upload.press("Space");
    await expect
      .poll(async () => page.evaluate(() => window.pickerFixtureCalls))
      .toBe(2);
    await expect(upload).toBeEnabled();
  });
}
