import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type * as v from "valibot";

import { MCP_APP_SANDBOX_CONTENT_DIRECTIVES } from "@stll/api-contract/mcp-app-sandbox-policy";
import {
  APP_RESOLVE_FIXTURE,
  APP_RESOLVE_STATUS_FIXTURES,
  APP_SEARCH_FIXTURE,
} from "@stll/api-contract/mcp-app.fixtures";
import { MCP_WEB_HANDOFF_TOOL_NAME } from "@stll/api-contract/mcp-web-handoff";
import type { mcpWebHandoffLinkOutputSchema } from "@stll/api-contract/mcp-web-handoff";
import { installBrowserClock } from "@stll/ui/browser-clock";

test.use({ storageState: { cookies: [], origins: [] } });

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
  tool: "search_case_law" | "resolve_case_law_decision";
  payload: typeof APP_SEARCH_FIXTURE | typeof APP_RESOLVE_FIXTURE;
  queries?: string[];
  bundle?: "committed" | "country-fixture";
  theme?: "light" | "dark";
  handoff?: "minted" | "declined";
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
  handoff = "declined",
}: HostOptions) => {
  const bundle =
    bundleKind === "country-fixture"
      ? countryFixtureBundle()
      : await readFile(
          new URL(
            "../../../../packages/mcp-apps/src/case-law-results/generated/app.html.txt",
            import.meta.url,
          ),
          "utf-8",
        );
  const html = bundle.replace(
    "<head>",
    () =>
      `<head><meta http-equiv="Content-Security-Policy" content="${MCP_APP_SANDBOX_CONTENT_DIRECTIVES.join("; ")}">`,
  );
  // setContent preserves host listeners across mounts in the same test.
  await page.goto("about:blank", { waitUntil: "commit" });
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
      handoff: handoffStatus,
      handoffTool,
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
                    : { identifier: "I. ÚS 123/24", country: "CZE" },
              },
            });
            reply({
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: toolsResult(hostPayload),
            });
            break;
          case "tools/call": {
            history.push({
              name: data.params.name,
              arguments: data.params.arguments,
            });
            if (data.params.name === handoffTool) {
              // The host script runs in the page, so module imports are absent.
              const handoffUrl: unknown = data.params.arguments.url;
              if (typeof handoffUrl !== "string") {
                throw new TypeError("Handoff call is missing its URL");
              }
              reply({
                jsonrpc: "2.0",
                id: data.id,
                result:
                  handoffStatus === "minted"
                    ? toolsResult({
                        url: `${handoffUrl}#sh=sh1_fixture`,
                      } satisfies v.InferInput<
                        typeof mcpWebHandoffLinkOutputSchema
                      >)
                    : {
                        isError: true,
                        content: [{ type: "text", text: "Handoff declined." }],
                      },
              });
              break;
            }
            reply({
              jsonrpc: "2.0",
              id: data.id,
              result: toolsResult(hostPayload),
            });
            break;
          }
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
    {
      html,
      locale,
      tool,
      payload,
      queries,
      theme,
      handoff,
      handoffTool: MCP_WEB_HANDOFF_TOOL_NAME,
    },
  );
  return page.frameLocator("#app");
};

const hostHistory = async (page: Page, key: "appCalls" | "appLinks") =>
  page.evaluate((historyKey) => globalThis.appFixtureHost[historyKey], key);

test("case-law app filters, pages and opens links through the MCP host", async ({
  page,
}) => {
  await installBrowserClock(page, new Date("2024-04-15T12:00:00Z"));
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
    .toEqual([APP_SEARCH_FIXTURE.results.at(0)?.url]);
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
        name: MCP_WEB_HANDOFF_TOOL_NAME,
        arguments: { url: APP_SEARCH_FIXTURE.results.at(0)?.url },
      },
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
    app.locator("td").filter({ hasText: /[٠-٩]/u }).first(),
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

test("resolve app renders every status and surfaces recoverable errors", async ({
  page,
}) => {
  const app = await mountApp({
    page,
    locale: "cs",
    tool: "resolve_case_law_decision",
    payload: APP_RESOLVE_FIXTURE,
  });
  await expect(
    app.getByRole("cell").filter({ hasText: "I. ÚS 123/24" }),
  ).toHaveCount(1);
  const notices = {
    ambiguous:
      "Odkazu odpovídá více rozhodnutí. Vyberte rozhodnutí k otevření.",
    not_found: "Přesné rozhodnutí nenalezeno. Zkuste vyhledávání judikatury.",
    incomplete_identifier: "Doplňte do odkazu: sheet.",
    country_unavailable:
      "Pro tuto zemi není dostupné dohledání rozhodnutí podle odkazu.",
  } as const;
  for (const fixture of APP_RESOLVE_STATUS_FIXTURES) {
    if (fixture.status === "resolved") {
      continue;
    }
    await page.evaluate(
      (payload) => globalThis.appFixtureHost.sendAppResult(payload),
      fixture,
    );
    await expect(app.getByRole("status")).toContainText(
      notices[fixture.status],
    );
  }
  expect(await hostHistory(page, "appCalls")).toEqual([]);
  await page.evaluate(() => globalThis.appFixtureHost.sendAppError());
  await expect(app.getByRole("alert")).toContainText("Read unavailable.");
  await app.getByRole("button").click();
  await expect
    .poll(async () => hostHistory(page, "appCalls"))
    .toEqual([
      {
        name: "resolve_case_law_decision",
        arguments: { identifier: "I. ÚS 123/24", country: "CZE" },
      },
    ]);
  await page.evaluate(() =>
    globalThis.appFixtureHost.sendAppResult({ unexpected: true }),
  );
  await expect(app.getByRole("alert")).toBeVisible();
});

for (const locale of ["en-GB", "ar"]) {
  for (const handoff of ["minted", "declined"] as const) {
    test(`resolve ambiguity opens only the chosen decision (${locale}, handoff ${handoff})`, async ({
      page,
    }) => {
      const ambiguous = APP_RESOLVE_STATUS_FIXTURES.find(
        (fixture) => fixture.status === "ambiguous",
      );
      if (ambiguous === undefined) {
        throw new Error("Missing ambiguity fixture");
      }
      const app = await mountApp({
        page,
        locale,
        tool: "resolve_case_law_decision",
        payload: APP_RESOLVE_FIXTURE,
        handoff,
      });
      await page.evaluate(
        (payload) => globalThis.appFixtureHost.sendAppResult(payload),
        ambiguous,
      );
      const candidate = app.getByRole("button", {
        name: "I. ÚS 123/24",
        exact: true,
      });
      await expect(candidate).toBeVisible();
      expect(await hostHistory(page, "appCalls")).toEqual([]);
      await candidate.click();
      await expect
        .poll(async () => hostHistory(page, "appLinks"))
        .toEqual([
          handoff === "minted"
            ? `${APP_RESOLVE_FIXTURE.document.readerUrl}#sh=sh1_fixture`
            : APP_RESOLVE_FIXTURE.document.readerUrl,
        ]);
      expect(await hostHistory(page, "appCalls")).toEqual([
        {
          name: MCP_WEB_HANDOFF_TOOL_NAME,
          arguments: { url: APP_RESOLVE_FIXTURE.document.readerUrl },
        },
      ]);
    });
  }
}

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
  const controls = app.locator(
    'form [data-slot="select-trigger"], form [data-slot="popover-trigger"]',
  );
  await expect(controls).toHaveCount(4);
  const fields = await controls.evaluateAll((elements) =>
    elements.map((element) => {
      const labelId = element.getAttribute("aria-labelledby")?.split(" ").at(0);
      const label = labelId
        ? element.ownerDocument.querySelector(`#${CSS.escape(labelId)}`)
        : element
            .closest('[data-slot="field"]')
            ?.querySelector('[data-slot="field-label"]');
      if (!label) {
        throw new Error("Missing filter label");
      }
      const { x, y, height } = label.getBoundingClientRect();
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(label);
      return {
        label: label.textContent,
        labelLeft: x,
        labelBaseline: y + height,
        textLeft: range.getBoundingClientRect().left,
        controlLeft: element.getBoundingClientRect().left,
      };
    }),
  );
  expect(fields.map(({ label }) => label)).toEqual([
    "Country",
    "Court",
    "From",
    "To",
  ]);
  expect(new Set(fields.map(({ labelBaseline }) => labelBaseline)).size).toBe(
    1,
  );
  for (const { labelLeft, textLeft, controlLeft } of fields) {
    expect(Math.abs(labelLeft - controlLeft)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(textLeft - controlLeft)).toBeLessThanOrEqual(0.5);
  }
  const trigger = app.getByRole("button", { name: /^From /u });
  const label = app.locator("form").getByText("From", { exact: true });
  await expect(label).toBeVisible();
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
      .toEqual([first.url]);
    await original.click();
    await expect
      .poll(async () => hostHistory(page, "appLinks"))
      .toEqual([first.url, sourceUrl]);
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
  for (const url of rejectedUrls) {
    await page.evaluate(
      ({ payload, url: decisionUrl }) =>
        globalThis.appFixtureHost.sendAppResult({
          ...payload,
          results: payload.results.map((row) => ({
            ...row,
            url: decisionUrl,
            source_url: "file:///fixture",
          })),
        }),
      { payload: APP_SEARCH_FIXTURE, url },
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
      // After the disclosure come the in-app reader action and the fixture
      // row's one host action (the app link; no source URL).
      const actions = row.getByRole("button");
      await expect(actions.nth(-3)).toHaveAttribute(
        "data-slot",
        "accordion-trigger",
      );
      await page.keyboard.press("Tab");
      await expect(actions.nth(-2)).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(actions.last()).toBeFocused();
      await row.locator(".snippet").click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await row.locator('[data-slot="tooltip-trigger"]').first().click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      // The reference opens the in-app reader; the app link opens stella.
      await actions.last().click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect
        .poll(async () => hostHistory(page, "appLinks"))
        .toEqual([first.url]);
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
        APP_RESOLVE_FIXTURE,
      );
      await expect(app.locator('[data-slot="accordion-trigger"]')).toHaveCount(
        0,
      );
    });
  }
}

for (const locale of ["cs-CZ", "en-GB", "sk-SK"]) {
  test(`case-law app exposes named controls and localized document metadata in ${locale}`, async ({
    page,
  }) => {
    const app = await mountApp({
      page,
      locale,
      tool: "search_case_law",
      payload: APP_SEARCH_FIXTURE,
    });
    await expect(app.getByRole("heading").first()).toBeVisible();
    await expect(app.locator("html")).toHaveAttribute("lang", locale);
    // <title> is not rendered, so read the frame document's title directly.
    await expect
      .poll(
        async () => await app.locator("html").evaluate(() => document.title),
      )
      .toMatch(/\S/u);
    const controls = app
      .locator(
        'button:visible, input:not([type="hidden"]):visible, select:visible, textarea:visible, [role="button"]:visible, [role="combobox"]:visible',
      )
      .and(
        app.locator(
          ':not([aria-hidden="true"], [aria-hidden="true"] *, [inert], [inert] *)',
        ),
      );
    expect(await controls.count()).toBeGreaterThan(0);
    for (const control of await controls.all()) {
      await expect(control).toHaveAccessibleName(/\S/u);
    }
  });
}
