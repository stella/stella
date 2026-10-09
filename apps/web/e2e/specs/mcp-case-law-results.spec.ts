import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { MCP_APP_SANDBOX_CONTENT_DIRECTIVES } from "@stll/api-contract/mcp-app-sandbox-policy";
import {
  APP_LOOKUP_FIXTURE,
  APP_SEARCH_FIXTURE,
  APP_UNAVAILABLE_FIXTURE,
} from "@stll/api-contract/mcp-app.fixtures";

type AppFixtureHost = {
  appCalls: unknown[];
  appLinks: string[];
  appSizes: { height: number }[];
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
  queries?: string[];
  bundle?: "committed" | "country-fixture";
  theme?: "light" | "dark";
};

let countryFixture: string | undefined;
/** Built once per worker; the build takes seconds. */
const countryFixtureBundle = (): string =>
  (countryFixture ??= execFileSync(
    "bun",
    [
      fileURLToPath(
        new URL(
          "../../../api/scripts/build-mcp-country-filter-fixture.ts",
          import.meta.url,
        ),
      ),
    ],
    { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
  ));

const mountApp = async ({
  page,
  locale,
  tool,
  payload,
  queries = ["náhrada škody"],
  bundle: bundleKind = "committed",
  theme = "dark",
}: HostOptions) => {
  const bundle =
    bundleKind === "country-fixture"
      ? countryFixtureBundle()
      : await readFile(
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
      queries: hostQueries,
      theme: hostTheme,
    }) => {
      const iframe = document.querySelector<HTMLIFrameElement>("iframe");
      if (iframe === null) {
        throw new Error("App iframe is missing");
      }
      const history: unknown[] = [];
      const links: string[] = [];
      const sizes: { height: number }[] = [];
      const reply = (message: unknown) =>
        iframe.contentWindow?.postMessage(message, "*");
      const toolsResult = (data: unknown) => ({
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
      });
      const searchInput = { queries: hostQueries, country: "CZE", limit: 10 };
      window.addEventListener("message", ({ source, data }) => {
        if (
          source !== iframe.contentWindow ||
          typeof data !== "object" ||
          data === null
        ) {
          return;
        }
        const method = data.method;
        if (
          method !== "ui/initialize" &&
          method !== "ui/notifications/initialized" &&
          method !== "tools/call" &&
          method !== "ui/open-link" &&
          method !== "ui/notifications/size-changed"
        ) {
          return;
        }
        switch (method) {
          case "ui/notifications/size-changed":
            sizes.push({ height: data.params.height });
            iframe.style.height = `${String(data.params.height)}px`;
            break;
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
                  theme: hostTheme,
                  toolInfo: {
                    tool: { name: hostTool, inputSchema: { type: "object" } },
                  },
                  styles: {
                    variables: {
                      "--color-text-primary":
                        hostTheme === "dark"
                          ? "rgb(230, 230, 230)"
                          : "rgb(30, 30, 30)",
                      "--color-background-primary":
                        hostTheme === "dark"
                          ? "rgb(30, 30, 30)"
                          : "rgb(255, 255, 255)",
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
                    ? searchInput
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
          default:
            throw new Error(`Unhandled MCP fixture method: ${String(method)}`);
        }
      });
      globalThis.appFixtureHost = {
        appCalls: history,
        appLinks: links,
        appSizes: sizes,
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
    { html, locale, tool, payload, queries, theme },
  );
  return page.frameLocator("#app");
};

const hostHistory = async (page: Page, key: "appCalls" | "appLinks") =>
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
    .poll(async () => hostHistory(page, "appLinks"))
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
    .poll(async () => hostHistory(page, "appCalls"))
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
  const today = app.locator('[role="gridcell"][aria-current="date"]');
  const selectedDate = await today.getAttribute("data-date");
  await today.click();
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
        date_from: selectedDate,
      },
    });
  await page.evaluate(() =>
    globalThis.appFixtureHost.sendAppLocale("ar-u-nu-arab"),
  );
  await expect(app.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(app.getByRole("heading", { level: 1 })).not.toHaveText(
    "Case Law",
  );
  await expect(
    app
      .locator("td")
      .filter({ hasText: /[٠-٩]/u })
      .first(),
  ).toContainText(/[٠-٩]/u);
  expect(errors).toEqual([]);
});

test("court filters preserve multiple query phrasings until the search text is edited", async ({
  page,
}) => {
  const queries = ["náhrada škody", "odpovědnost za škodu"];
  const app = await mountApp({
    page,
    locale: "en-GB",
    tool: "search_case_law",
    payload: APP_SEARCH_FIXTURE,
    queries,
  });
  await expect(app.locator("tbody tr")).toHaveCount(1);
  await app.getByRole("combobox", { name: "Court", exact: true }).click();
  await app
    .getByRole("option", { name: "Constitutional courts", exact: true })
    .click();
  await app.getByRole("button", { name: "Filter", exact: true }).click();
  await expect
    .poll(async () => hostHistory(page, "appCalls"))
    .toEqual([
      {
        name: "search_case_law",
        arguments: {
          queries,
          country: "CZE",
          limit: 10,
          courts: ["Ústavní soud"],
        },
      },
    ]);
  await expect(app.locator("tbody tr")).toHaveCount(1);
  await app
    .getByRole("searchbox", { name: "Search", exact: true })
    .fill("edited phrasing");
  await app.getByRole("button", { name: "Filter", exact: true }).click();
  await expect
    .poll(async () => (await hostHistory(page, "appCalls")).at(-1))
    .toEqual({
      name: "search_case_law",
      arguments: {
        queries: ["edited phrasing"],
        country: "CZE",
        limit: 10,
        courts: ["Ústavní soud"],
      },
    });
});

for (const { selection, filter } of [
  { selection: "Ústavní soud", filter: { court: "Ústavní soud" } },
  { selection: "Constitutional courts", filter: { courts: ["Ústavní soud"] } },
]) {
  test(`changing country clears the ${selection} court selection`, async ({
    page,
  }) => {
    const app = await mountApp({
      page,
      locale: "en-GB",
      tool: "search_case_law",
      payload: APP_SEARCH_FIXTURE,
      bundle: "country-fixture",
    });
    await expect(app.locator("tbody tr")).toHaveCount(1);
    await app.getByRole("combobox", { name: "Court", exact: true }).click();
    await app.getByRole("option", { name: selection, exact: true }).click();
    await app.getByRole("button", { name: "Filter", exact: true }).click();
    await expect
      .poll(async () => (await hostHistory(page, "appCalls")).at(-1))
      .toEqual({
        name: "search_case_law",
        arguments: {
          queries: ["náhrada škody"],
          country: "CZE",
          limit: 10,
          ...filter,
        },
      });
    await app.getByRole("combobox", { name: "Country", exact: true }).click();
    await app.getByRole("option", { name: "SVK", exact: true }).click();
    await expect(
      app.getByRole("combobox", { name: "Court", exact: true }),
    ).toHaveText("All");
    await app.getByRole("button", { name: "Filter", exact: true }).click();
    await expect
      .poll(async () => (await hostHistory(page, "appCalls")).at(-1))
      .toEqual({
        name: "search_case_law",
        arguments: {
          queries: ["náhrada škody"],
          country: "SVK",
          limit: 10,
        },
      });
  });
}

test("a selected court tier survives a later response without facets", async ({
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
  await expect(app.locator("tbody tr")).toHaveCount(1);
  await app.getByRole("combobox", { name: "Court", exact: true }).click();
  await app
    .getByRole("option", { name: "Constitutional courts", exact: true })
    .click();
  await expect(
    app.getByRole("combobox", { name: "Court", exact: true }),
  ).toHaveText("Constitutional courts");
  await page.evaluate(
    (payload) =>
      globalThis.appFixtureHost.sendAppResult({
        ...payload,
        facets: null,
        results: [],
      }),
    APP_SEARCH_FIXTURE,
  );
  await expect(app.locator("tbody tr")).toHaveCount(0);
  await expect(
    app.getByRole("combobox", { name: "Court", exact: true }),
  ).toHaveText("Constitutional courts");
  await app.getByRole("button", { name: "Filter", exact: true }).click();
  await expect
    .poll(async () => hostHistory(page, "appCalls"))
    .toEqual([
      {
        name: "search_case_law",
        arguments: {
          queries: ["náhrada škody"],
          country: "CZE",
          limit: 10,
          courts: ["Ústavní soud"],
        },
      },
    ]);
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
    .poll(async () => hostHistory(page, "appCalls"))
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

test("collapsed rows stay single-line with long references and summaries", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const app = await mountApp({
    page,
    locale: "cs",
    tool: "search_case_law",
    payload: APP_SEARCH_FIXTURE,
  });
  await expect(app.getByRole("heading", { level: 1 })).toBeVisible();
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
  // Collapsed borders contribute half a pixel to the last row.
  const heights = geometry.map(({ height }) => height);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
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
      const textLeft = await labels.nth(index).evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect().left;
      });
      const controlLeft = await controls
        .nth(index)
        .evaluate((element) => element.getBoundingClientRect().left);
      expect(Math.abs(textLeft - controlLeft)).toBeLessThanOrEqual(0.5);
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
      .poll(async () => hostHistory(page, "appLinks"))
      .toEqual([first.appUrl]);
    await original.click();
    await expect
      .poll(async () => hostHistory(page, "appLinks"))
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
  await expect(app.locator("tbody tr")).toHaveCount(1);
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

for (const theme of ["light", "dark"] as const) {
  for (const locale of ["en-GB", "ar"] as const) {
    test(`rows disclose passages with mouse and keyboard in ${theme} ${locale}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const first = APP_SEARCH_FIXTURE.results.at(0);
      if (first === undefined) {
        throw new Error("Missing search fixture");
      }
      const passage =
        "The court examines causation and the right to compensation. ".repeat(
          12,
        );
      const headnote =
        "Compensation requires proof of a causal connection.\nThe assessment must address each claim. "
          .repeat(8)
          .trim();
      const app = await mountApp({
        page,
        locale,
        theme,
        tool: "search_case_law",
        payload: {
          ...APP_SEARCH_FIXTURE,
          results: [
            {
              ...first,
              snippet: passage,
              headnote: { type: "present", text: headnote, truncated: false },
            },
          ],
        },
      });
      const row = app.locator("tbody tr").first();
      const trigger = row.locator('[data-slot="accordion-trigger"]');
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      const panelId = await trigger.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      const panel = app.locator(`[id="${String(panelId)}"]`);
      await expect(panel).toBeHidden();
      await expect
        .poll(async () =>
          page.evaluate(() => globalThis.appFixtureHost.appSizes.length),
        )
        .toBeGreaterThan(0);
      await app.locator("body").evaluate(async () => {
        await document.fonts.ready;
      });
      await expect
        .poll(async () => {
          const reported = await page.evaluate(
            () => globalThis.appFixtureHost.appSizes.at(-1)?.height ?? 0,
          );
          const rendered = await app
            .locator("body")
            .evaluate((element) =>
              Math.ceil(element.getBoundingClientRect().height),
            );
          return Math.abs(reported - rendered);
        })
        .toBeLessThanOrEqual(1);
      const collapsedHeight = await row.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      const hostHeight = await page.evaluate(
        () => globalThis.appFixtureHost.appSizes.at(-1)?.height ?? 0,
      );
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(passage.trim());
      await expect(panel).toContainText(headnote);
      await expect(panel).toContainText("Náhrada škody");
      expect(
        await row.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThan(collapsedHeight);
      await expect
        .poll(async () =>
          page.evaluate(
            () => globalThis.appFixtureHost.appSizes.at(-1)?.height ?? 0,
          ),
        )
        .toBeGreaterThan(hostHeight);
      const readingStyle = await panel
        .locator('p[dir="auto"]')
        .first()
        .evaluate((element) => ({
          whiteSpace: getComputedStyle(element).whiteSpace,
          overflow: getComputedStyle(element).overflowY,
        }));
      expect(readingStyle).toEqual({
        whiteSpace: "pre-wrap",
        overflow: "visible",
      });
      await trigger.press("Enter");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(panel).toBeHidden();
      await expect
        .poll(async () =>
          page.evaluate(
            () => globalThis.appFixtureHost.appSizes.at(-1)?.height ?? 0,
          ),
        )
        .toBeLessThanOrEqual(hostHeight + 1);
      await trigger.press("Space");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await trigger.press("Space");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      // Reading content adds no tab stops between the reference and host actions.
      const reference = row.getByRole("button", {
        name: first.caseNumber,
        exact: true,
      });
      await reference.focus();
      await page.keyboard.press("Tab");
      await expect(trigger).toBeFocused();
      // The fixture row carries one host action (the app link, no source URL),
      // directly after the disclosure.
      const actions = row.getByRole("button");
      await expect(actions.nth(-2)).toHaveAttribute(
        "data-slot",
        "accordion-trigger",
      );
      await page.keyboard.press("Tab");
      await expect(actions.last()).toBeFocused();
      await row.locator(".snippet").click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await row.locator('[data-slot="tooltip-trigger"]').first().click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await reference.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect
        .poll(async () => hostHistory(page, "appLinks"))
        .toEqual([first.appUrl]);
      await row.locator(".snippet").click();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await page.evaluate(
        (payload) => globalThis.appFixtureHost.sendAppResult(payload),
        {
          ...APP_SEARCH_FIXTURE,
          // Keep the test passage so only the cleared keywords carried the term.
          results: [
            { ...first, snippet: passage, headnote: null, keywords: null },
          ],
        },
      );
      await trigger.click();
      await expect(panel).not.toContainText("Náhrada škody");
      await expect(panel).toContainText(
        locale === "ar" ? "لم يرد في الحكم" : "Not stated in the decision",
      );
      await page.evaluate(
        (payload) => globalThis.appFixtureHost.sendAppResult(payload),
        {
          ...APP_SEARCH_FIXTURE,
          headnotes: "omitted",
          results: [{ ...first, headnote: null, keywords: null }],
        },
      );
      await expect(panel).toContainText(
        locale === "ar"
          ? "حُذفت خلاصات الأحكام لتقليل حجم هذه الصفحة. افتح القرار للاطلاع على التفاصيل."
          : "Headnotes omitted to keep this page small. Open the decision for details.",
      );
      await expect(panel).not.toContainText(
        locale === "ar" ? "لم يرد في الحكم" : "Not stated in the decision",
      );
      await page.evaluate(
        (payload) => globalThis.appFixtureHost.sendAppResult(payload),
        { ...APP_SEARCH_FIXTURE, results: [{ ...first, snippet: null }] },
      );
      await expect(panel).toContainText(first.headnote.text);
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await page.evaluate(
        (payload) => globalThis.appFixtureHost.sendAppResult(payload),
        APP_LOOKUP_FIXTURE,
      );
      await expect(app.locator('[data-slot="accordion-trigger"]')).toHaveCount(
        0,
      );
    });
  }
}
