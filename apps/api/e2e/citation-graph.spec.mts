import { expect, test } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type * as v from "valibot";

import MCP_APP_MESSAGES from "@stll/api-contract/mcp-app-messages" with { type: "json" };
import { MCP_APP_SANDBOX_CONTENT_DIRECTIVES } from "@stll/api-contract/mcp-app-sandbox-policy";
import { MCP_WEB_HANDOFF_TOOL_NAME } from "@stll/api-contract/mcp-web-handoff";

import type { READ_CASE_LAW_CITATIONS_PROJECTION } from "../src/lib/chat/case-law-citation-projection";
import type { openDecisionOutput } from "../src/lib/chat/decision-reader-projections";

type CitationPage = v.InferOutput<typeof READ_CASE_LAW_CITATIONS_PROJECTION>;
const EN_MESSAGES = MCP_APP_MESSAGES.en;
const AR_MESSAGES = MCP_APP_MESSAGES.ar;
type FixtureHost = {
  calls: { name: string; arguments: Record<string, unknown> }[];
  links: string[];
  messages: { method: string; params: unknown }[];
  failures: string[];
};
declare global {
  var citationGraphFixtureHost: FixtureHost;
}

const SUBJECT_ID = "00000000-0000-4000-8000-000000000001";
const DECISION_IDS = [
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
  "00000000-0000-4000-8000-000000000007",
] as const;
const caseNumber = (index: number) =>
  index === 0
    ? `Fixture case ${"1234567890".repeat(24)}`
    : `Fixture case ${index + 1}`;
const decisionUrl = (id: string) =>
  `https://stella.example/law/cze/cases/${id}`;
const citation = (
  index: number,
  polarity: CitationPage["citations"][number]["polarity"],
  decisionId: string | null,
) =>
  ({
    citationId: `fixture-citation-${index}`,
    citationText: `Fixture reference ${index + 1}`,
    textWithheldReason: null,
    polarity,
    doctrine: null,
    decision:
      decisionId === null
        ? null
        : {
            url: decisionUrl(decisionId),
            caseNumber: caseNumber(index),
            caseNumberType: "case-number",
            citationAuthority: index + 1,
            court: "Fixture court",
            decisionDate: "2024-04-15",
            decisionId,
            decisionType: null,
            resourceName: `fixture-resource-${index}`,
          },
    passage: {
      anchorId: `fixture-anchor-${index}`,
      text: `Fixture passage ${index + 1}.`,
      truncated: index === 0,
      mention: "sole",
    },
  }) satisfies CitationPage["citations"][number];

const firstCitation = citation(0, "negative", DECISION_IDS[0]);
const firstCitations = [
  firstCitation,
  citation(1, "neutral", DECISION_IDS[1]),
  citation(2, "positive", DECISION_IDS[2]),
  citation(3, "supportive", DECISION_IDS[3]),
  citation(4, "mixed", DECISION_IDS[4]),
  citation(5, "unclassified", DECISION_IDS[5]),
  citation(6, "unclassified", null),
] satisfies CitationPage["citations"];
const firstPage = {
  doctrineAvailability: "unavailable",
  decisionId: SUBJECT_ID,
  direction: "cites",
  nextCursor: "fixture-cites-more",
  citations: firstCitations,
} satisfies CitationPage;
const morePage = {
  doctrineAvailability: "unavailable",
  decisionId: SUBJECT_ID,
  direction: "cites",
  nextCursor: null,
  // The repeated citationId is intentional: a cursor page must not duplicate
  // an edge already rendered from the subject's first page.
  citations: [
    firstCitation,
    citation(7, "positive", "00000000-0000-4000-8000-000000000008"),
  ],
} satisfies CitationPage;
const expandedPage = {
  doctrineAvailability: "unavailable",
  decisionId: DECISION_IDS[0],
  direction: "cites",
  nextCursor: null,
  citations: [
    citation(8, "supportive", "00000000-0000-4000-8000-000000000009"),
  ],
} satisfies CitationPage;

type HostOptions = {
  page: Page;
  host?: "ChatGPT" | "Claude" | "Codex";
  locale?: string;
  navigation?: "tools" | "links";
  theme?: "light" | "dark";
  direction?: CitationPage["direction"];
  expansionPages?: CitationPage[];
};
const mountGraph = async ({
  page,
  host = "ChatGPT",
  locale = "en-GB",
  navigation = "tools",
  theme = "light",
  direction = "cites",
  expansionPages = [expandedPage],
}: HostOptions): Promise<FrameLocator> => {
  const bundle = await readFile(
    new URL(
      "../../../packages/mcp-apps/src/citation-graph/generated/app.html.txt",
      import.meta.url,
    ),
    "utf-8",
  );
  const html = bundle.replace(
    "<head>",
    () =>
      `<head><meta http-equiv="Content-Security-Policy" content="${MCP_APP_SANDBOX_CONTENT_DIRECTIVES.join("; ")}">`,
  );
  const fixtureUrl = "http://localhost/citation-graph-fixture";
  await page.route(fixtureUrl, async (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<iframe id="graph" sandbox="allow-scripts allow-forms" style="width:100%;height:650px;border:0"></iframe>',
    }),
  );
  await page.goto(fixtureUrl);
  const mounted = await page.evaluate(
    ({
      appHtml,
      hostLocale,
      navigationMode,
      hostTheme,
      subjectId,
      initialPage,
      hostName,
      pagedResult,
      expandedResults,
      handoffTool,
    }) => {
      const iframe = document.querySelector<HTMLIFrameElement>("iframe");
      if (iframe === null) {
        return "missing" as const;
      }
      const calls: FixtureHost["calls"] = [];
      const links: string[] = [];
      const messages: FixtureHost["messages"] = [];
      const failures: string[] = [];
      const reply = (message: unknown) =>
        iframe.contentWindow?.postMessage(message, "*");
      const toolResult = (data: unknown) => ({
        content: [],
        structuredContent: data,
      });
      const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);
      const reject = (id: unknown, message: string) => {
        failures.push(message);
        reply({ jsonrpc: "2.0", id, error: { code: -32_602, message } });
      };
      window.addEventListener("message", (event) => {
        const data: unknown = event.data;
        if (event.source !== iframe.contentWindow || !isRecord(data)) {
          return;
        }
        const { method, params, id } = data;
        if (typeof method !== "string") {
          return;
        }
        messages.push({ method, params });
        switch (method) {
          case "ui/initialize":
            reply({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: "2026-01-26",
                hostInfo: { name: hostName, version: "1.0.0" },
                hostCapabilities: {
                  ...(navigationMode === "tools" ? { serverTools: {} } : {}),
                  openLinks: {},
                  updateModelContext: { text: {}, structuredContent: {} },
                },
                hostContext: {
                  locale: hostLocale,
                  theme: hostTheme,
                  displayMode: "inline",
                  availableDisplayModes: ["inline", "fullscreen"],
                  toolInfo: {
                    id: `fixture-${hostName.toLowerCase()}-citation-graph`,
                    tool: {
                      name: "read_case_law_citations",
                      inputSchema: { type: "object" },
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
              params: { arguments: { decision_id: subjectId } },
            });
            reply({
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: toolResult(initialPage),
            });
            break;
          case "tools/call": {
            if (
              !isRecord(params) ||
              typeof params["name"] !== "string" ||
              !isRecord(params["arguments"])
            ) {
              reject(id, "Invalid fixture tool request");
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
              break;
            }
            if (name === "open_case_law_decision") {
              const decisionId = args["decision_id"];
              if (typeof decisionId !== "string") {
                reject(id, "Invalid fixture decision id");
                return;
              }
              reply({
                jsonrpc: "2.0",
                id,
                result: toolResult({
                  status: "unavailable",
                  metadata: {
                    decisionId,
                    url: `https://stella.example/law/cze/cases/${decisionId}`,
                    caseNumber: "Fixture case",
                    caseNumberType: "case-number",
                    courtAbbreviation: null,
                    courtTier: "supreme",
                    language: "en",
                    court: "Fixture court",
                    country: "cze",
                    date: null,
                    ecli: null,
                  },
                } satisfies v.InferOutput<typeof openDecisionOutput>),
              });
              break;
            }
            if (name !== "read_case_law_citations") {
              reject(id, `Unexpected tool request: ${name}`);
              return;
            }
            const requestedDirection = args["direction"];
            const cursor = args["cursor"];
            const decisionId = args["decision_id"];
            const expansion = expandedResults.find(
              (entry) => entry.decisionId === decisionId,
            );
            let result: CitationPage = initialPage;
            if (decisionId === subjectId && cursor === "fixture-cites-more") {
              result = pagedResult;
            } else if (expansion !== undefined) {
              result = expansion;
            } else if (requestedDirection === "cited_by") {
              result = {
                ...initialPage,
                direction: "cited_by",
                nextCursor: null,
              };
            }
            reply({ jsonrpc: "2.0", id, result: toolResult(result) });
            break;
          }
          case "ui/open-link":
            if (!isRecord(params) || typeof params["url"] !== "string") {
              reject(id, "Invalid fixture link request");
              return;
            }
            links.push(params["url"]);
            reply({ jsonrpc: "2.0", id, result: {} });
            break;
          default:
            if (id !== undefined) {
              reply({ jsonrpc: "2.0", id, result: {} });
            }
        }
      });
      globalThis.citationGraphFixtureHost = {
        calls,
        links,
        messages,
        failures,
      } satisfies FixtureHost;
      // safe-html: build-mcp-apps.ts emits the self-contained citation graph bundle.
      iframe.srcdoc = appHtml;
      return "mounted" as const;
    },
    {
      appHtml: html,
      hostName: host,
      hostLocale: locale,
      navigationMode: navigation,
      hostTheme: theme,
      subjectId: SUBJECT_ID,
      initialPage: { ...firstPage, direction },
      pagedResult: morePage,
      expandedResults: expansionPages,
      handoffTool: MCP_WEB_HANDOFF_TOOL_NAME,
    },
  );
  expect(mounted).toBe("mounted");
  return page.frameLocator("#graph");
};

const history = async (page: Page) => {
  const recorded = await page.evaluate(
    () => globalThis.citationGraphFixtureHost,
  );
  expect(recorded.failures).toEqual([]);
  return recorded;
};

test("citation graph renders the subject, six treatments, unresolved citations, and list view", async ({
  page,
}) => {
  const app = await mountGraph({ page });
  await expect(
    app.getByRole("heading", { name: EN_MESSAGES.graphTitle }),
  ).toBeVisible();
  await expect(app.getByTestId("citation-graph")).toBeVisible();
  await expect(app.locator(`[data-node-id="${SUBJECT_ID}"]`)).toBeVisible();
  await expect(
    app.getByRole("button", { name: "Graph", exact: true }),
  ).toBeVisible();
  await app.getByRole("button", { name: "List", exact: true }).click();
  await expect(
    app.getByTestId("citation-list").locator("article[data-citation-id]"),
  ).toHaveCount(7);
  await expect(
    app.getByText("Unresolved citation", { exact: true }),
  ).toBeVisible();
  for (const polarity of [
    "negative",
    "neutral",
    "positive",
    "supportive",
    "mixed",
    "unclassified",
  ] as const) {
    await expect(
      app.getByTestId("citation-list").locator(`[data-polarity="${polarity}"]`),
    ).toHaveText(
      firstCitations
        .filter((entry) => entry.polarity === polarity)
        .map(() => `${EN_MESSAGES.cites} · ${EN_MESSAGES[polarity]}`),
    );
  }
  await expect(
    app.locator('article[data-citation-id="fixture-citation-0"] blockquote'),
  ).toHaveText("Fixture passage 1.…");
  await expect(
    app.locator('article[data-citation-id="fixture-citation-1"] blockquote'),
  ).toHaveText("Fixture passage 2.");
  expect((await history(page)).calls).toEqual([]);
});

test("citation graph pagination deduplicates an edge and expansion loads the selected decision", async ({
  page,
}) => {
  const app = await mountGraph({ page });
  await app.getByRole("button", { name: "List", exact: true }).click();
  const firstRow = app.locator(
    'article[data-citation-id="fixture-citation-0"]',
  );
  const expand = firstRow.getByRole("button", { name: /Expand citations/u });
  await expand.focus();
  await expect(expand).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    app
      .getByTestId("citation-list")
      .locator('article[data-citation-id="fixture-citation-8"]'),
  ).toBeVisible();
  await expect
    .poll(async () => (await history(page)).calls)
    .toContainEqual({
      name: "read_case_law_citations",
      arguments: { decision_id: DECISION_IDS[0], direction: "cites" },
    });
  await app.getByRole("button", { name: `Load more: ${SUBJECT_ID}` }).click();
  await expect(
    app.getByTestId("citation-list").locator("article[data-citation-id]"),
  ).toHaveCount(9);
  await expect
    .poll(async () => (await history(page)).calls)
    .toContainEqual({
      name: "read_case_law_citations",
      arguments: {
        decision_id: SUBJECT_ID,
        direction: "cites",
        cursor: "fixture-cites-more",
      },
    });
});

for (const direction of ["cites", "cited_by"] as const) {
  for (const depth of [1, 2]) {
    test(`citation graph opens the subject reached through ${depth} ${direction} expansions`, async ({
      page,
    }) => {
      const subjectCitation = citation(10, "neutral", SUBJECT_ID);
      const expansionPages = [
        {
          doctrineAvailability: "unavailable",
          decisionId: DECISION_IDS[0],
          direction,
          nextCursor: null,
          citations: [
            depth === 1
              ? subjectCitation
              : citation(9, "positive", DECISION_IDS[1]),
          ],
        },
        {
          doctrineAvailability: "unavailable",
          decisionId: DECISION_IDS[1],
          direction,
          nextCursor: null,
          citations: [subjectCitation],
        },
      ] satisfies CitationPage[];
      const app = await mountGraph({ page, direction, expansionPages });
      await app.getByRole("button", { name: "List", exact: true }).click();
      await app
        .locator('article[data-citation-id="fixture-citation-0"]')
        .getByRole("button", { name: /Expand citations/u })
        .click();
      if (depth === 2) {
        await app
          .locator('article[data-citation-id="fixture-citation-9"]')
          .getByRole("button", { name: /Expand citations/u })
          .click();
      }
      const subjectRow = app.locator(
        'article[data-citation-id="fixture-citation-10"]',
      );
      const open = subjectRow.getByRole("button", {
        name: caseNumber(10),
        exact: true,
      });
      await expect(open).toBeEnabled();
      await expect(
        subjectRow.getByRole("button", { name: /Expand citations/u }),
      ).toBeDisabled();
      await open.click();
      await expect
        .poll(async () => (await history(page)).calls)
        .toContainEqual({
          name: "open_case_law_decision",
          arguments: { decision_id: SUBJECT_ID },
        });
      await expect
        .poll(async () => (await history(page)).links)
        .toEqual([decisionUrl(SUBJECT_ID)]);
      await app.getByRole("button", { name: "Graph", exact: true }).click();
      await expect(app.locator(`[data-node-id="${SUBJECT_ID}"]`)).toHaveText(
        EN_MESSAGES.subjectDecision,
      );
      await expect(
        app.locator(`g:has([data-node-id="${SUBJECT_ID}"]) > circle`),
      ).toHaveAttribute("stroke-width", "3");
    });
  }
}

test("citation graph opens decisions through host tools and openLink fallback", async ({
  page,
}) => {
  const app = await mountGraph({ page });
  await app.getByRole("button", { name: "List", exact: true }).click();
  await app.getByRole("button", { name: caseNumber(0), exact: true }).click();
  await expect
    .poll(async () => (await history(page)).calls)
    .toContainEqual({
      name: "open_case_law_decision",
      arguments: { decision_id: DECISION_IDS[0] },
    });

  await expect
    .poll(async () => (await history(page)).links)
    .toEqual([decisionUrl(DECISION_IDS[0])]);

  const fallbackPage = await page.context().newPage();
  const fallback = await mountGraph({
    page: fallbackPage,
    navigation: "links",
  });
  await fallback.getByRole("button", { name: "List", exact: true }).click();
  await fallback
    .getByRole("button", { name: caseNumber(0), exact: true })
    .click();
  await expect
    .poll(async () => (await history(fallbackPage)).links)
    .toEqual([decisionUrl(DECISION_IDS[0])]);
  await fallbackPage.close();
});

for (const theme of ["light", "dark"] as const) {
  test(`citation graph fits a wide ${theme} surface and exposes keyboard-reachable graph nodes`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 720 });
    const app = await mountGraph({ page, theme });
    await expect(app.getByTestId("citation-graph")).toBeVisible();
    const layout = await app.locator("body").evaluate((body) => ({
      clientWidth: body.ownerDocument.documentElement.clientWidth,
      scrollWidth: body.ownerDocument.documentElement.scrollWidth,
      controlsVisible: [
        ...body.querySelectorAll<HTMLButtonElement>("[data-node-id]"),
      ].every((node) => {
        const bounds = node.getBoundingClientRect();
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.left >= 0 &&
          bounds.right <= body.ownerDocument.documentElement.clientWidth
        );
      }),
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.controlsVisible).toBe(true);
    await app.getByRole("button", { name: EN_MESSAGES.graphView }).focus();
    await page.keyboard.press("Tab");
    await expect(
      app.getByRole("button", { name: EN_MESSAGES.listView }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(app.locator(`[data-node-id="${SUBJECT_ID}"]`)).toBeFocused();
  });
}

test("citation graph keeps the list and its actions visible at narrow widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 720 });
  const app = await mountGraph({ page, theme: "dark" });
  await expect(app.getByTestId("citation-graph")).toBeHidden();
  await expect(app.getByTestId("citation-list")).toBeVisible();
  const layout = await app.locator("body").evaluate((body) => ({
    clientWidth: body.ownerDocument.documentElement.clientWidth,
    scrollWidth: body.ownerDocument.documentElement.scrollWidth,
    actionsVisible: [
      ...body.querySelectorAll<HTMLButtonElement>("article button"),
    ].every((button) => {
      const bounds = button.getBoundingClientRect();
      return (
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.left >= 0 &&
        bounds.right <= body.ownerDocument.documentElement.clientWidth
      );
    }),
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.actionsVisible).toBe(true);
  const hostLayout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(hostLayout.scrollWidth).toBeLessThanOrEqual(hostLayout.clientWidth);
});

for (const host of ["ChatGPT", "Claude", "Codex"] as const) {
  test(`citation graph renders in the ${host} host context`, async ({
    page,
  }) => {
    const app = await mountGraph({ page, host });
    await expect(
      app.getByRole("heading", { name: EN_MESSAGES.graphTitle }),
    ).toBeVisible();
    expect((await history(page)).calls).toEqual([]);
  });
}

test("citation graph uses Arabic messages and right-to-left layout", async ({
  page,
}) => {
  const app = await mountGraph({ page, locale: "ar" });
  await expect(
    app.getByRole("heading", { name: AR_MESSAGES.graphTitle }),
  ).toBeVisible();
  await expect(app.locator("html")).toHaveAttribute("dir", "rtl");
  const direction = app.locator(
    'article[data-citation-id="fixture-citation-0"] p[dir="ltr"]',
  );
  await expect(direction).toHaveText(`${SUBJECT_ID} → ${DECISION_IDS[0]}`);
  const order = await direction.evaluate((row) => {
    const endpoints = row.querySelectorAll("bdi");
    const source = endpoints.item(0).getBoundingClientRect();
    const target = endpoints.item(1).getBoundingClientRect();
    return {
      sourceX: source.left,
      targetX: target.left,
      direction: getComputedStyle(row).direction,
    };
  });
  expect(order.direction).toBe("ltr");
  expect(order.sourceX).toBeLessThan(order.targetX);
  await app
    .getByRole("button", { name: AR_MESSAGES.graphView, exact: true })
    .click();
  await expect(app.getByTestId("citation-graph")).toBeVisible();
});
