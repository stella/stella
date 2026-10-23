import { expect, test } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import * as v from "valibot";

import { MCP_APP_SANDBOX_CONTENT_DIRECTIVES } from "@stll/api-contract/mcp-app-sandbox-policy";
import { MCP_WEB_HANDOFF_TOOL_NAME } from "@stll/api-contract/mcp-web-handoff";

import { READ_PROVISION_HISTORY_PROJECTION } from "../src/lib/chat/legislation-result-projections";

type ProvisionHistory = v.InferInput<typeof READ_PROVISION_HISTORY_PROJECTION>;
type FixtureHost = {
  calls: { name: string; arguments: Record<string, unknown> }[];
  failures: string[];
  openedUrls: string[];
  setTheme: (theme: "light" | "dark") => void;
};
declare global {
  var statuteTimelineFixtureHost: FixtureHost;
}

const INPUT = { eli: "cz:act:2012:89", anchor: "par_1", language: "cs" };
const VERSION_2020 = {
  url: "https://stella.example/legislation/2020",
  documentId: "00000000-0000-4000-8000-000000000001",
  resourceName:
    "stella://resource/legislation_document/id=00000000-0000-4000-8000-000000000001",
  versionValidFrom: "2020-01-01",
  versionValidTo: "2020-12-31",
  expressionKind: "consolidation",
  windowDisposition: "effective",
  windowDispositionBasis: null,
  status: "found",
  text: "A person may exercise this right. This wording applies in the first version.",
  nextTextCursor:
    "ptw1.76.zCTeT_qJpfxvyScxpKvf2ZUsXuPizOybc5k-5yBoLh8.Xgc8NU2ep8EOvsz4dzqjr1nEdiNeB-5ipD7bUVzu5bE",
  truncated: true,
} satisfies ProvisionHistory["items"][number];
const VERSION_2021 = {
  url: null,
  documentId: "00000000-0000-4000-8000-000000000002",
  resourceName:
    "stella://resource/legislation_document/id=00000000-0000-4000-8000-000000000002",
  versionValidFrom: "2021-01-01",
  versionValidTo: null,
  expressionKind: "consolidation",
  windowDisposition: "effective",
  windowDispositionBasis: null,
  status: "found",
  text: "A person may exercise this updated right in the later version.",
  nextTextCursor: null,
  truncated: false,
} satisfies ProvisionHistory["items"][number];
const VERSION_WITHHELD = {
  url: "https://publisher.example/legislation/2019",
  documentId: "00000000-0000-4000-8000-000000000003",
  resourceName:
    "stella://resource/legislation_document/id=00000000-0000-4000-8000-000000000003",
  versionValidFrom: null,
  versionValidTo: "2019-12-31",
  expressionKind: "consolidation",
  windowDisposition: "effective",
  windowDispositionBasis: null,
  status: "text_withheld",
  message: "The source does not permit displaying this wording.",
} satisfies ProvisionHistory["items"][number];
const VERSION_WITHDRAWN = {
  ...VERSION_2020,
  url: null,
  documentId: "00000000-0000-4000-8000-000000000004",
  resourceName:
    "stella://resource/legislation_document/id=00000000-0000-4000-8000-000000000004",
  versionValidFrom: "2018-01-01",
  versionValidTo: "2019-01-01",
  expressionKind: "promulgated",
  windowDisposition: "withdrawn",
  windowDispositionBasis: "publisher-unlisted",
  text: "The publisher withdrew this published wording.",
  nextTextCursor: null,
  truncated: false,
} satisfies ProvisionHistory["items"][number];
const VERSION_NEVER_IN_FORCE = {
  ...VERSION_2020,
  url: null,
  documentId: "00000000-0000-4000-8000-000000000005",
  resourceName:
    "stella://resource/legislation_document/id=00000000-0000-4000-8000-000000000005",
  versionValidFrom: "2019-01-01",
  versionValidTo: "2020-01-01",
  windowDisposition: "never-in-force",
  windowDispositionBasis: "publisher-flag",
  text: "The publisher marks this wording as never having entered into force.",
  nextTextCursor: null,
  truncated: false,
} satisfies ProvisionHistory["items"][number];
const FIRST_PAGE = v.parse(READ_PROVISION_HISTORY_PROJECTION, {
  eli: INPUT.eli,
  anchor: INPUT.anchor,
  items: [VERSION_2021, VERSION_2020],
  nextCursor: "timeline-page-2",
} satisfies ProvisionHistory);
const SECOND_PAGE = v.parse(READ_PROVISION_HISTORY_PROJECTION, {
  eli: INPUT.eli,
  anchor: INPUT.anchor,
  items: [VERSION_WITHHELD],
  nextCursor: null,
} satisfies ProvisionHistory);

const mountTimeline = async ({
  page,
  theme = "light",
  width = 1024,
  locale = "en-GB",
  initialHistory = FIRST_PAGE,
  browserErrors,
}: {
  page: Page;
  theme?: "light" | "dark";
  width?: number;
  locale?: string;
  initialHistory?: ProvisionHistory;
  browserErrors: string[];
}): Promise<FrameLocator> => {
  const parsedHistory = v.parse(
    READ_PROVISION_HISTORY_PROJECTION,
    initialHistory,
  );
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  await page.setViewportSize({ width, height: 820 });
  const bundle = await readFile(
    new URL(
      "../../../packages/mcp-apps/src/statute-timeline/generated/app.html.txt",
      import.meta.url,
    ),
    "utf-8",
  );
  const html = bundle.replace(
    "<head>",
    () =>
      `<head><meta http-equiv="Content-Security-Policy" content="${MCP_APP_SANDBOX_CONTENT_DIRECTIVES.join("; ")}">`,
  );
  await page.route("http://localhost/statute-timeline-fixture", async (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<iframe id="timeline" sandbox="allow-scripts allow-forms" style="width:100%;height:760px;border:0"></iframe>',
    }),
  );
  await page.goto("http://localhost/statute-timeline-fixture");
  const mounted = await page.evaluate(
    ({
      html: appHtml,
      initialTheme,
      hostLocale,
      input,
      firstPage,
      secondPage,
      handoffTool,
    }) => {
      const iframe = document.querySelector<HTMLIFrameElement>("iframe");
      if (iframe === null) {
        return false;
      }
      const calls: FixtureHost["calls"] = [];
      const failures: string[] = [];
      const openedUrls: string[] = [];
      const reply = (message: unknown) =>
        iframe.contentWindow?.postMessage(message, "*");
      const toolResult = (data: unknown) => ({
        content: [],
        structuredContent: data,
      });
      const record = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);
      const reject = (id: unknown, message: string) => {
        failures.push(message);
        reply({ jsonrpc: "2.0", id, error: { code: -32_602, message } });
      };
      window.addEventListener("message", (event) => {
        if (event.source !== iframe.contentWindow || !record(event.data)) {
          return;
        }
        const { method, params, id } = event.data;
        if (typeof method !== "string") {
          return;
        }
        if (method === "ui/initialize") {
          reply({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2026-01-26",
              hostInfo: { name: "Fixture", version: "1.0.0" },
              hostCapabilities: { serverTools: {}, openLinks: {} },
              hostContext: {
                locale: hostLocale,
                theme: initialTheme,
                displayMode: "inline",
                availableDisplayModes: ["inline"],
                toolInfo: {
                  id: "statute-timeline-fixture",
                  tool: {
                    name: "read_provision_history",
                    inputSchema: { type: "object" },
                  },
                },
              },
            },
          });
          return;
        }
        if (method === "ui/notifications/initialized") {
          reply({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: input },
          });
          reply({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: toolResult(firstPage),
          });
          return;
        }
        if (method === "ui/open-link") {
          if (!record(params) || typeof params["url"] !== "string") {
            reject(id, "Invalid timeline fixture link");
            return;
          }
          openedUrls.push(params["url"]);
          reply({ jsonrpc: "2.0", id, result: {} });
          return;
        }
        if (method === "tools/call") {
          if (
            !record(params) ||
            typeof params["name"] !== "string" ||
            !record(params["arguments"])
          ) {
            reject(id, "Invalid timeline fixture request");
            return;
          }
          const { name, arguments: args } = params;
          calls.push({ name, arguments: args });
          // The host declines the sign-in handoff, so links open unchanged.
          if (name === handoffTool) {
            reply({
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: "Handoff declined." }],
              },
            });
            return;
          }
          if (
            name === "read_provision_history" &&
            args["cursor"] === "timeline-page-2"
          ) {
            reply({ jsonrpc: "2.0", id, result: toolResult(secondPage) });
            return;
          }
          reply({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Unsupported fixture tool." }],
            },
          });
          return;
        }
        if (id !== undefined) {
          reply({ jsonrpc: "2.0", id, result: {} });
        }
      });
      globalThis.statuteTimelineFixtureHost = {
        calls,
        failures,
        openedUrls,
        setTheme: (nextTheme) =>
          reply({
            jsonrpc: "2.0",
            method: "ui/notifications/host-context-changed",
            params: { theme: nextTheme },
          }),
      } satisfies FixtureHost;
      // safe-html: trusted generated MCP app bundle from the repository build.
      iframe.srcdoc = appHtml;
      return true;
    },
    {
      html,
      initialTheme: theme,
      hostLocale: locale,
      input: INPUT,
      firstPage: parsedHistory,
      secondPage: SECOND_PAGE,
      handoffTool: MCP_WEB_HANDOFF_TOOL_NAME,
    },
  );
  expect(mounted).toBe(true);
  return page.frameLocator("#timeline");
};

const calls = async (page: Page) =>
  page.evaluate(() => ({
    calls: globalThis.statuteTimelineFixtureHost.calls,
    failures: globalThis.statuteTimelineFixtureHost.failures,
    openedUrls: globalThis.statuteTimelineFixtureHost.openedUrls,
  }));

test("timeline selection, adjacent comparison and paging work in the fixture host", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  const app = await mountTimeline({ page, browserErrors });
  await expect(
    app.getByRole("heading", { name: "Provision history" }),
  ).toBeVisible();
  const versions = app.locator("button[data-version-id]");
  await expect(versions).toHaveCount(2);
  await expect(versions.nth(0)).toContainText("2021");
  await expect(app.getByTestId("version-wording")).toContainText(
    VERSION_2021.text,
  );

  await versions.nth(1).click();
  await expect(app.getByTestId("version-wording")).toContainText(
    VERSION_2020.text,
  );
  await app.getByRole("button", { name: "Open version" }).click();
  await expect(app.getByText("This wording is truncated.")).toBeVisible();
  await versions.nth(0).click();
  await app.getByRole("button", { name: "Compare adjacent versions" }).click();
  await expect(app.locator('[data-slot="review-diff-text"]')).toBeVisible();
  const wordings = await app
    .locator('[data-slot="review-diff-text"]')
    .evaluate((diff) => {
      const segments = [...diff.children];
      return {
        older: segments
          .filter((segment) => segment.tagName !== "INS")
          .map((segment) => segment.textContent)
          .join(""),
        newer: segments
          .filter((segment) => segment.tagName !== "DEL")
          .map((segment) => segment.textContent)
          .join(""),
      };
    });
  expect(wordings).toEqual({
    older: VERSION_2020.text,
    newer: VERSION_2021.text,
  });

  await app.getByRole("button", { name: "Load more" }).click();
  await expect(versions).toHaveCount(3);
  await expect(versions.nth(2)).toHaveAttribute(
    "data-version-id",
    VERSION_WITHHELD.documentId,
  );
  await versions.nth(2).click();
  await expect(app.getByText(VERSION_WITHHELD.message)).toBeVisible();
  await app.getByRole("button", { name: "Open version" }).click();
  await page.waitForFunction(
    () => globalThis.statuteTimelineFixtureHost.openedUrls.length === 2,
  );
  const recorded = await calls(page);
  expect(recorded.failures).toEqual([]);
  expect(recorded.calls).toContainEqual({
    name: "read_provision_history",
    arguments: { ...INPUT, cursor: "timeline-page-2" },
  });
  expect(recorded.openedUrls).toEqual([VERSION_2020.url, VERSION_WITHHELD.url]);
  expect(
    recorded.calls.filter(({ name }) => name === "read_statute_provisions"),
  ).toHaveLength(0);
  expect(browserErrors).toEqual([]);
});

test("effective history and non-effective versions have distinct localized labels and marks", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  const app = await mountTimeline({
    page,
    locale: "cs",
    browserErrors,
    initialHistory: {
      eli: INPUT.eli,
      anchor: INPUT.anchor,
      items: [VERSION_2020, VERSION_WITHDRAWN, VERSION_NEVER_IN_FORCE],
      nextCursor: null,
    },
  });
  const versions = app.locator("button[data-version-id]");
  await expect(versions).toHaveCount(3);
  const effective = versions
    .nth(0)
    .locator('[data-window-disposition="effective"]');
  await expect(effective).toHaveText("Konsolidované znění · Období účinnosti");
  await expect(effective).not.toHaveClass(/border-dashed/u);
  const withdrawn = versions
    .nth(1)
    .locator('[data-window-disposition="withdrawn"]');
  await expect(withdrawn).toHaveText("Vyhlášené znění · Stažené znění");
  await expect(withdrawn).toHaveClass(/border-dashed/u);
  const neverInForce = versions
    .nth(2)
    .locator('[data-window-disposition="never-in-force"]');
  await expect(neverInForce).toHaveText(
    "Konsolidované znění · Nikdy nenabylo účinnosti",
  );
  await expect(neverInForce).toHaveClass(/border-dashed/u);
  const chart = app.getByTestId("statute-timeline-chart");
  await expect(chart).toBeVisible();
  await expect(
    chart.locator('rect[fill="none"][stroke="var(--foreground)"]'),
  ).toHaveCount(2);
  await expect(chart.locator('rect[fill="var(--foreground)"]')).toHaveCount(1);
  await versions.nth(1).click();
  await expect(app.getByTestId("version-wording")).toHaveText(
    VERSION_WITHDRAWN.text,
  );
  await expect(
    app.locator('section [data-window-disposition="withdrawn"]'),
  ).toHaveText("Vyhlášené znění · Stažené znění");
  await versions.nth(2).click();
  await expect(app.getByTestId("version-wording")).toHaveText(
    VERSION_NEVER_IN_FORCE.text,
  );
  await expect(
    app.locator('section [data-window-disposition="never-in-force"]'),
  ).toHaveText("Konsolidované znění · Nikdy nenabylo účinnosti");
  expect(browserErrors).toEqual([]);
});

test("source wording keeps its direction in an Arabic host", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  const app = await mountTimeline({ page, locale: "ar", browserErrors });
  await expect(app.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(app.locator("main > p > bdi")).toHaveText(INPUT.anchor);
  const wording = app.getByTestId("version-wording");
  await expect(wording).toHaveAttribute("dir", "auto");
  expect(
    await wording.evaluate((node) => getComputedStyle(node).direction),
  ).toBe("ltr");
  await app
    .locator('button[aria-pressed="false"]:not([data-version-id])')
    .click();
  const comparison = app
    .locator('[data-slot="review-diff-text"]')
    .locator("..");
  await expect(comparison).toHaveAttribute("dir", "auto");
  expect(
    await comparison.evaluate((node) => getComputedStyle(node).direction),
  ).toBe("ltr");
  expect(browserErrors).toEqual([]);
});

test("timeline controls remain visible and keyboard reachable across themes and narrow widths", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  const app = await mountTimeline({ page, width: 390, browserErrors });
  const chart = app.getByTestId("statute-timeline-chart");
  await expect(chart).toBeHidden();
  await expect(app.locator("button[data-version-id]")).toHaveCount(2);
  await app
    .locator(`button[data-version-id="${VERSION_2020.documentId}"]`)
    .click();
  await expect(app.getByRole("button", { name: "Open version" })).toBeVisible();
  await expect(
    app.getByRole("heading", { name: "Provision history" }),
  ).toBeVisible();

  const dimensions = await app.locator("body").evaluate((body) => ({
    scrollWidth: body.scrollWidth,
    clientWidth: body.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

  const firstVersion = app.locator("button[data-version-id]").first();
  await firstVersion.focus();
  await expect(firstVersion).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(app.getByTestId("version-wording")).toContainText(
    VERSION_2021.text,
  );

  await page.evaluate(() =>
    globalThis.statuteTimelineFixtureHost.setTheme("dark"),
  );
  await expect(app.locator("html")).toHaveClass(/dark/u);
  await app
    .locator(`button[data-version-id="${VERSION_2020.documentId}"]`)
    .click();
  await expect(app.getByRole("button", { name: "Open version" })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  test(`timeline chart and controls render without overflow in ${theme} mode at desktop width`, async ({
    page,
  }) => {
    const browserErrors: string[] = [];
    const app = await mountTimeline({ page, theme, browserErrors });
    await expect(app.getByTestId("statute-timeline-chart")).toBeVisible();
    await expect(app.locator("button[data-version-id]")).toHaveCount(2);
    await expect(
      app.getByRole("heading", { name: "Provision history" }),
    ).toBeVisible();
    const classes = await app.locator("html").getAttribute("class");
    expect(classes?.split(/\s+/u).includes("dark") ?? false).toBe(
      theme === "dark",
    );
    const dimensions = await app.locator("body").evaluate((body) => ({
      scrollWidth: body.scrollWidth,
      clientWidth: body.clientWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    expect(browserErrors).toEqual([]);
  });
}
