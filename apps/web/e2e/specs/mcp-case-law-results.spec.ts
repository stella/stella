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
            history.push({
              name: data.params.name,
              arguments: data.params.arguments,
            });
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
  await page.clock.install({ time: new Date("2024-04-15T12:00:00Z") });
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
    app.getByRole("cell").filter({ hasText: "I. ÚS 123/24" }),
  ).toBeVisible();
  await expect(app.locator(".snippet")).toHaveText(
    "Náhrada škody: <b>právní jistota</b>.",
  );
  await expect(app.locator(".snippet b")).toHaveCount(0);
  await expect(app.locator("html")).toHaveCSS("color-scheme", "dark");
  await app
    .getByRole("button", { name: "Open in stella", exact: true })
    .click();
  await expect
    .poll(() => hostHistory(page, "appLinks"))
    .toEqual([APP_SEARCH_FIXTURE.results.at(0)?.appUrl]);
  await page.evaluate((payload) => {
    const first = payload.results.at(0);
    if (first === undefined) {
      throw new Error("Missing search fixture");
    }
    globalThis.appFixtureHost.sendAppResult({
      ...payload,
      results: [
        first,
        {
          ...first,
          decisionId: "fixture-sorted",
          court: "Krajský soud",
          decisionDate: "2025-01-01",
          caseNumber: "44 Co 92/2022",
        },
      ],
    });
  }, APP_SEARCH_FIXTURE);
  await app.getByRole("combobox", { name: "Sort", exact: true }).click();
  await app.getByRole("option", { name: "Court", exact: true }).click();
  await expect(app.locator("tbody tr").first()).toContainText("44 Co 92/2022");
  await app.getByRole("combobox", { name: "Sort", exact: true }).click();
  await app.getByRole("option", { name: "Newest", exact: true }).click();
  await expect(app.locator("tbody tr").first()).toContainText("44 Co 92/2022");
  await app.getByRole("combobox", { name: "Sort", exact: true }).click();
  await app.getByRole("option", { name: "Most relevant", exact: true }).click();
  await expect(app.locator("tbody tr").first()).toContainText("I. ÚS 123/24");
  await page.evaluate(
    (payload) => globalThis.appFixtureHost.sendAppResult(payload),
    APP_SEARCH_FIXTURE,
  );
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
    app.getByRole("cell").filter({ hasText: "I. ÚS 123/24" }),
  ).toBeVisible();
  await app.getByRole("combobox", { name: "Court", exact: true }).click();
  await app
    .getByRole("option", { name: "Constitutional courts", exact: true })
    .click();
  await app.getByRole("button", { name: /^From/u }).click();
  await app.getByRole("button", { name: "Today", exact: true }).click();
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
        date_from: "2024-04-15",
      },
    });
  await page.evaluate(() =>
    globalThis.appFixtureHost.sendAppLocale("ar-u-nu-arab"),
  );
  await expect(app.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(app.getByRole("heading")).not.toHaveText("Case Law");
  await expect(
    app
      .locator("td")
      .filter({ hasText: /[٠-٩]/u })
      .first(),
  ).toContainText(/[٠-٩]/u);
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
    app.getByRole("cell").filter({ hasText: "I. ÚS 123/24" }),
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

test("desktop rows stay single-line with long references and summaries", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const app = await mountApp({
    page,
    locale: "cs",
    tool: "search_case_law",
    payload: APP_SEARCH_FIXTURE,
  });
  await expect(app.getByRole("heading")).toBeVisible();
  await page.evaluate((payload) => {
    const first = payload.results.at(0);
    if (first === undefined) {
      throw new Error("Missing search fixture");
    }
    globalThis.appFixtureHost.sendAppResult({
      ...payload,
      results: [
        { ...first, snippet: "Náhrada škody." },
        {
          ...first,
          decisionId: "long-reference",
          courtAbbreviation: "KS Brno",
          court: "Krajský soud v Brně",
          caseNumber: "44 Co 123456/2024-1234",
          snippet:
            "Posouzení odpovědnosti a příčinné souvislosti při náhradě škody a dlouhé odůvodnění právního posouzení opakované pro ověření zkracování textu.",
        },
        {
          ...first,
          decisionId: "long-date",
          courtAbbreviation: "NSS",
          caseNumber: "6 As 123456/2024-1234",
          decisionDate: "2024-12-31",
          snippet: "Přezkum správního rozhodnutí a zásada proporcionality.",
        },
      ],
    });
  }, APP_SEARCH_FIXTURE);
  await expect(app.locator("tbody tr")).toHaveCount(3);
  const geometry = await app.locator("tbody tr").evaluateAll((rows) =>
    rows.map((row) => {
      const reference = row.querySelector("td bdi");
      const snippet = row.querySelector(".snippet");
      if (reference === null || snippet === null) {
        throw new Error("Missing row text");
      }
      const referenceStyle = getComputedStyle(reference);
      const snippetStyle = getComputedStyle(snippet);
      return {
        height: row.getBoundingClientRect().height,
        referenceLines: reference.getClientRects().length,
        nowrap: snippetStyle.whiteSpace,
        ellipsis: snippetStyle.textOverflow,
        referenceNowrap: referenceStyle.whiteSpace,
      };
    }),
  );
  expect(new Set(geometry.map(({ height }) => height)).size).toBe(1);
  expect(
    geometry.every(
      ({ referenceLines, nowrap, ellipsis, referenceNowrap }) =>
        referenceLines === 1 &&
        nowrap === "nowrap" &&
        referenceNowrap === "nowrap" &&
        ellipsis === "ellipsis",
    ),
  ).toBe(true);
  await expect(app.locator("tbody")).not.toContainText("ECLI:");
  await expect(
    app.getByText("Rozhodnutí", { exact: false }).first(),
  ).toBeVisible();
});

test("filter labels align and date fields remain fixed when opened", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const app = await mountApp({
    page,
    locale: "en-GB",
    tool: "search_case_law",
    payload: APP_SEARCH_FIXTURE,
  });
  const labels = app.locator('[data-slot="field-label"]');
  await expect(labels).toHaveCount(4);
  const labelBoxes = await labels.evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, height } = element.getBoundingClientRect();
      return { x, y, height };
    }),
  );
  expect(new Set(labelBoxes.map(({ y, height }) => y + height)).size).toBe(1);
  const controls = app.locator(
    '[data-slot="field"] [data-slot="select-trigger"], [data-slot="field"] [data-slot="popover-trigger"]',
  );
  await expect(controls).toHaveCount(4);
  for (let index = 0; index < 4; index++) {
    const labelBox = await labels.nth(index).boundingBox();
    const controlBox = await controls.nth(index).boundingBox();
    expect(labelBox).not.toBeNull();
    expect(controlBox).not.toBeNull();
    if (labelBox !== null && controlBox !== null) {
      expect(Math.abs(labelBox.x - controlBox.x)).toBeLessThanOrEqual(0.5);
    }
  }
  const trigger = app.getByRole("button", { name: /^To /u });
  const label = labels.last();
  const beforeTrigger = await trigger.boundingBox();
  const beforeLabel = await label.boundingBox();
  await trigger.click();
  await expect(app.locator('[data-slot="date-picker-popup"]')).toBeVisible();
  expect(await trigger.boundingBox()).toEqual(beforeTrigger);
  expect(await label.boundingBox()).toEqual(beforeLabel);
  await expect(
    app.locator('[data-slot="date-picker-popup"] [aria-current="date"]'),
  ).toBeFocused();
});

test("reader and publisher buttons open their own URLs only after a click", async ({
  page,
}) => {
  const first = APP_SEARCH_FIXTURE.results.at(0);
  if (first === undefined) {
    throw new Error("Missing search fixture");
  }
  const sourceUrl = "https://example.org/fixture-publisher-decision";
  const found = APP_LOOKUP_FIXTURE.items.filter(
    (item) => item.status === "found",
  );
  const scenarios = [
    {
      tool: "search_case_law" as const,
      payload: {
        ...APP_SEARCH_FIXTURE,
        results: [
          { ...first, source_url: sourceUrl },
          { ...first, decisionId: "no-source", url: sourceUrl },
        ],
      },
      readers: 2,
    },
    {
      tool: "lookup_case_law" as const,
      payload: {
        ...APP_LOOKUP_FIXTURE,
        items: found.map((item) => ({ ...item, source_url: sourceUrl })),
      },
      readers: 1,
    },
  ];
  for (const { tool, payload, readers } of scenarios) {
    const app = await mountApp({ page, locale: "en-GB", tool, payload });
    const reader = app.getByRole("button", {
      name: "Open in stella",
      exact: true,
    });
    const original = app.getByRole("button", {
      name: "Open original source",
      exact: true,
    });
    await expect(reader).toHaveCount(readers);
    await expect(original).toHaveCount(1);
    expect(await hostHistory(page, "appLinks")).toEqual([]);
    await reader.first().click();
    await expect
      .poll(() => hostHistory(page, "appLinks"))
      .toEqual([first.appUrl]);
    await original.click();
    await expect
      .poll(() => hostHistory(page, "appLinks"))
      .toEqual([first.appUrl, sourceUrl]);
  }
});

test("missing and non-HTTP decision URLs do not expose link actions", async ({
  page,
}) => {
  const app = await mountApp({
    page,
    locale: "en-GB",
    tool: "search_case_law",
    payload: APP_SEARCH_FIXTURE,
  });
  const rejectedUrls = [
    null,
    ...["javascript", "data", "file", "ftp"].map(
      (protocol) => `${protocol}:fixture`,
    ),
  ];
  for (const appUrl of rejectedUrls) {
    await page.evaluate(
      ({ payload, appUrl: decisionUrl }) =>
        globalThis.appFixtureHost.sendAppResult({
          ...payload,
          results: payload.results.map((row) => ({
            ...row,
            appUrl: decisionUrl,
            source_url: "file:///fixture",
          })),
        }),
      { payload: APP_SEARCH_FIXTURE, appUrl },
    );
    await expect(app.locator("tbody tr")).toHaveCount(1);
    await expect(
      app.getByRole("button", { name: "Open in stella", exact: true }),
    ).toHaveCount(0);
    await expect(
      app.getByRole("button", { name: "Open original source", exact: true }),
    ).toHaveCount(0);
    expect(await hostHistory(page, "appLinks")).toEqual([]);
  }
});
