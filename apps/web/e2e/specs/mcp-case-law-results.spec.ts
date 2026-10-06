import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { MCP_APP_SANDBOX_CONTENT_DIRECTIVES } from "../../../api/src/handlers/mcp-app-sandbox/policy";
import {
  APP_LOOKUP_FIXTURE,
  APP_SEARCH_FIXTURE,
  APP_UNAVAILABLE_FIXTURE,
} from "../../../api/src/mcp/app-fixtures";

type AppFixtureHost = {
  appCalls: unknown[];
  appLinks: string[];
  sendAppResult: (data: unknown) => void;
  sendAppError: () => void;
  sendAppLocale: (nextLocale: string) => void;
};
declare global {
  var appFixtureHost: AppFixtureHost;
}

type HostOptions = {
  page: Page;
  locale: string;
  tool: "search_case_law" | "lookup_case_law";
  payload: typeof APP_SEARCH_FIXTURE | typeof APP_LOOKUP_FIXTURE;
};

const mountApp = async ({ page, locale, tool, payload }: HostOptions) => {
  const bundle = await readFile(
    new URL(
      "../../../api/src/mcp/apps/case-law-results/generated/app.html.txt",
      import.meta.url,
    ),
    "utf-8",
  );
  const html = bundle.replace(
    "<head>",
    () =>
      `<head><meta http-equiv="Content-Security-Policy" content="${MCP_APP_SANDBOX_CONTENT_DIRECTIVES.join("; ")}">`,
  );
  await page.setContent(
    '<iframe id="app" sandbox="allow-scripts allow-forms" style="width:100%;height:650px;border:0"></iframe>',
  );
  await page.evaluate(
    ({
      html: appHtml,
      locale: hostLocale,
      tool: hostTool,
      payload: hostPayload,
    }) => {
      const iframe = document.querySelector<HTMLIFrameElement>("iframe");
      if (iframe === null) {
        throw new Error("App iframe is missing");
      }
      const history: unknown[] = [];
      const links: string[] = [];
      const reply = (message: unknown) =>
        iframe.contentWindow?.postMessage(message, "*");
      const toolsResult = (data: unknown) => ({
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
      });
      const queries = { queries: ["náhrada škody"], country: "CZE", limit: 10 };
      window.addEventListener("message", ({ source, data }) => {
        if (
          source !== iframe.contentWindow ||
          typeof data !== "object" ||
          data === null
        ) {
          return;
        }
        switch (data.method) {
          case "ui/initialize":
            reply({
              jsonrpc: "2.0",
              id: data.id,
              result: {
                protocolVersion: "2026-01-26",
                hostInfo: { name: "fixture-host", version: "1.0.0" },
                hostCapabilities: { serverTools: {}, openLinks: {} },
                hostContext: {
                  locale: hostLocale,
                  theme: "dark",
                  toolInfo: {
                    tool: { name: hostTool, inputSchema: { type: "object" } },
                  },
                  styles: {
                    variables: {
                      "--color-text-primary": "rgb(230, 230, 230)",
                      "--color-background-primary": "rgb(30, 30, 30)",
                    },
                  },
                },
              },
            });
            break;
          case "ui/notifications/initialized":
            reply({
              jsonrpc: "2.0",
              method: "ui/notifications/tool-input",
              params: {
                arguments:
                  hostTool === "search_case_law"
                    ? queries
                    : { identifiers: ["I. ÚS 123/24"], country: "CZE" },
              },
            });
            reply({
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: toolsResult(hostPayload),
            });
            break;
          case "tools/call":
            history.push(data.params);
            reply({
              jsonrpc: "2.0",
              id: data.id,
              result: toolsResult(hostPayload),
            });
            break;
          case "ui/open-link":
            links.push(data.params.url);
            reply({ jsonrpc: "2.0", id: data.id, result: {} });
            break;
        }
      });
      globalThis.appFixtureHost = {
        appCalls: history,
        appLinks: links,
        sendAppResult: (data: unknown) =>
          reply({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: toolsResult(data),
          }),
        sendAppError: () =>
          reply({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
              isError: true,
              content: [{ type: "text", text: "Read unavailable." }],
            },
          }),
        sendAppLocale: (nextLocale: string) =>
          reply({
            jsonrpc: "2.0",
            method: "ui/notifications/host-context-changed",
            params: { locale: nextLocale },
          }),
      } satisfies AppFixtureHost;
      // safe-html: repository build-mcp-apps.ts emits this self-contained fixture bundle.
      iframe.srcdoc = appHtml;
    },
    { html, locale, tool, payload },
  );
  return page.frameLocator("#app");
};

const hostHistory = (page: Page, key: "appCalls" | "appLinks") =>
  page.evaluate((historyKey) => globalThis.appFixtureHost[historyKey], key);

test("case-law app filters, pages and opens links through the MCP host", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", ({ message }) => errors.push(message));
  const app = await mountApp({
    page,
    locale: "en-GB",
    tool: "search_case_law",
    payload: APP_SEARCH_FIXTURE,
  });
  await expect(app.getByRole("heading", { name: "Case Law" })).toBeVisible();
  await expect(
    app.getByRole("cell", { name: "Ústavní soud", exact: true }),
  ).toBeVisible();
  await expect(app.locator(".snippet")).toHaveText(
    "Náhrada škody: <b>právní jistota</b>.",
  );
  await expect(app.locator(".snippet b")).toHaveCount(0);
  await expect(app.locator("html")).toHaveCSS("color-scheme", "dark");
  await app.getByRole("button", { name: "Open", exact: true }).click();
  await expect
    .poll(() => hostHistory(page, "appLinks"))
    .toEqual([APP_SEARCH_FIXTURE.results.at(0)?.appUrl]);
  await app.getByRole("button", { name: "Next", exact: true }).click();
  await expect
    .poll(() => hostHistory(page, "appCalls"))
    .toEqual([
      {
        name: "search_case_law",
        arguments: {
          queries: ["náhrada škody"],
          country: "CZE",
          limit: 10,
          cursor: "next_fixture_cursor",
        },
      },
    ]);
  await expect(
    app.getByRole("cell", { name: "Ústavní soud", exact: true }),
  ).toBeVisible();
  await app
    .getByLabel("Court", { exact: true })
    .selectOption("tier:constitutional");
  await app.getByLabel("From", { exact: true }).fill("2024-01-01");
  await app.getByRole("button", { name: "Filter", exact: true }).click();
  await expect
    .poll(async () => (await hostHistory(page, "appCalls")).at(-1))
    .toEqual({
      name: "search_case_law",
      arguments: {
        queries: ["náhrada škody"],
        country: "CZE",
        limit: 10,
        courts: ["Ústavní soud"],
        date_from: "2024-01-01",
      },
    });
  await page.evaluate(() =>
    globalThis.appFixtureHost.sendAppLocale("ar-u-nu-arab"),
  );
  await expect(app.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(app.getByRole("heading")).not.toHaveText("Case Law");
  await expect(app.locator("td bdi").first()).toContainText(/[٠-٩]/u);
  expect(errors).toEqual([]);
});

test("lookup app renders every lookup status and surfaces recoverable errors", async ({
  page,
}) => {
  const app = await mountApp({
    page,
    locale: "cs",
    tool: "lookup_case_law",
    payload: APP_LOOKUP_FIXTURE,
  });
  await expect(app.getByText("Choose a court.")).toBeVisible();
  await expect(
    app.getByText("No matching decision. Search case law."),
  ).toBeVisible();
  await expect(app.getByText("Lookup unavailable.")).toBeVisible();
  await expect(
    app.getByRole("cell", { name: "Ústavní soud", exact: true }),
  ).toHaveCount(1);
  await page.evaluate(() => globalThis.appFixtureHost.sendAppError());
  await expect(app.getByRole("alert")).toContainText("Read unavailable.");
  await app.getByRole("button").click();
  await expect
    .poll(() => hostHistory(page, "appCalls"))
    .toEqual([
      {
        name: "lookup_case_law",
        arguments: { identifiers: ["I. ÚS 123/24"], country: "CZE" },
      },
    ]);
  await page.evaluate(
    (payload) => globalThis.appFixtureHost.sendAppResult(payload),
    APP_UNAVAILABLE_FIXTURE,
  );
  await expect(app.getByRole("status")).toContainText(
    "Corpus unavailable. Choose another country.",
  );
  await page.evaluate(() =>
    globalThis.appFixtureHost.sendAppResult({ unexpected: true }),
  );
  await expect(app.getByRole("alert")).toBeVisible();
});
