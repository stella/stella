import { expect, test } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";
import { panic } from "better-result";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript6";
import type * as v from "valibot";

import { MCP_APP_SANDBOX_CONTENT_DIRECTIVES } from "@stll/api-contract/mcp-app-sandbox-policy";
import { APP_SEARCH_FIXTURE } from "@stll/api-contract/mcp-app.fixtures";
import { MCP_WEB_HANDOFF_TOOL_NAME } from "@stll/api-contract/mcp-web-handoff";
import type { mcpWebHandoffLinkOutputSchema } from "@stll/api-contract/mcp-web-handoff";
import type { Block } from "@stll/legal-ast/document-ast";
import type { SearchResults } from "@stll/mcp-apps/shared/contracts";

import APP_INPUT_SCHEMAS from "../../../packages/mcp-apps/src/shared/generated/input-schemas.json" with { type: "json" };
import type {
  blocksDecisionOutput,
  openDecisionOutput,
  provisionPreviewOutput,
} from "../src/lib/chat/decision-reader-projections";

type ReaderPage = v.InferInput<typeof blocksDecisionOutput>;
type ReaderPreview = v.InferInput<typeof provisionPreviewOutput>;
type ReaderOpen = v.InferInput<typeof openDecisionOutput>;
type ReaderFixtureHost = {
  calls: { name: string; arguments: Record<string, unknown> }[];
  links: string[];
  messages: { method: string; params: unknown }[];
  toolResponses: { content: unknown[] }[];
  failures: string[];
  grantFullscreen: () => void;
  grantInline: () => void;
};
declare global {
  var readerFixtureHost: ReaderFixtureHost;
}

const metadata = {
  decisionId: "00000000-0000-4000-8000-000000000001",
  caseNumber: "I. ÚS 123/24",
  court: "Ústavní soud",
  caseNumberType: "case-number",
  courtTier: "constitutional",
  courtAbbreviation: "ÚS",
  language: "cs",
  country: "CZE",
  date: "2024-04-15",
  ecli: null,
  url: "https://stella.example/case-law/fixture",
} as const satisfies ReaderPage["metadata"];
const OPEN = {
  status: "available",
  metadata,
  outline: [],
  window: [],
  truncated: true,
} satisfies ReaderOpen;
const WITHHELD = {
  status: "withheld",
  metadata,
  withheldReason: {
    code: "source_licence",
    message: "Open the decision in stella.",
  },
} satisfies ReaderOpen;
const WITHHELD_PAGE = {
  metadata,
  content: { status: "withheld", withheldReason: WITHHELD.withheldReason },
} satisfies ReaderPage;
const paragraph = (number: number) =>
  ({
    type: "paragraph",
    id: `block${number}`,
    anchorId: `para${number}`,
    number,
    plainText: `Reader-only paragraph ${number}. ${"Legal reasoning. ".repeat(20)}`,
    inlines: [
      {
        type: "text",
        text: `Reader-only paragraph ${number}. ${"Legal reasoning. ".repeat(20)}`,
      },
    ],
  }) satisfies Block;
const FIRST = {
  metadata,
  content: {
    status: "available",
    phase: "blocks",
    items: Array.from({ length: 12 }, (_, index) => paragraph(index + 1)),
    blockFragments: [],
    citationAnchors: [],
    provisionAnchors: [],
    provisionStatus: null,
    nextCursor: "fixture-page-2",
    limit: 60_000,
  },
} satisfies ReaderPage;
const SECOND = {
  metadata,
  content: {
    status: "available",
    phase: "blocks",
    items: [paragraph(48), paragraph(49)],
    blockFragments: [],
    citationAnchors: [],
    provisionAnchors: [],
    provisionStatus: null,
    nextCursor: null,
    limit: 60_000,
  },
} satisfies ReaderPage;

const revisedParagraph = (number: number): Block => ({
  ...paragraph(number),
  plainText: `Updated paragraph ${number}.`,
  inlines: [{ type: "text", text: `Updated paragraph ${number}.` }],
});
const REVISED_PAGES = [
  {
    ...FIRST,
    content: {
      ...FIRST.content,
      items: [revisedParagraph(1)],
      nextCursor: "fixture-revised-page-2",
    },
  },
  {
    ...SECOND,
    content: {
      ...SECOND.content,
      items: [revisedParagraph(48), revisedParagraph(49)],
    },
  },
] satisfies ReaderPage[];

const citedDecisionId = "00000000-0000-4000-8000-000000000002";
const citedDecisionUrl =
  "https://stella.example/law/cze/cases/constitutional/official-cited-slug";
const provisionUrl =
  "https://stella.example/law/cze/statutes/89-2012-sb/v/2020-01-01#par_1-odst_1";
const provision = {
  document_id: "00000000-0000-4000-8000-000000000003",
  anchor: "par_1",
  cited_anchor: "par_1-odst_1",
};
const linkedText = "Cited decision and cited provision.";
const linkedBlock = {
  type: "paragraph",
  id: "linked-block",
  anchorId: "linked-paragraph",
  number: 1,
  plainText: linkedText,
  inlines: [{ type: "text", text: linkedText }],
} satisfies Block;
const LINK_PAGES = [
  {
    ...SECOND,
    content: {
      ...SECOND.content,
      items: [linkedBlock],
      nextCursor: "fixture-link-citations",
    },
  },
  {
    ...SECOND,
    content: {
      ...SECOND.content,
      phase: "citations",
      items: [],
      nextCursor: "fixture-link-provisions",
      citationAnchors: [
        {
          pieceId: linkedBlock.id,
          start: 0,
          end: "Cited decision".length,
          citationId: "linked-citation",
          decisionId: citedDecisionId,
          url: citedDecisionUrl,
        },
      ],
    },
  },
  {
    ...SECOND,
    content: {
      ...SECOND.content,
      phase: "provisions",
      items: [],
      provisionAnchors: [
        {
          pieceId: linkedBlock.id,
          start: linkedText.indexOf("cited provision"),
          end: linkedText.indexOf("cited provision") + "cited provision".length,
          provision,
          url: provisionUrl,
        },
      ],
    },
  },
] satisfies ReaderPage[];
const CITED_OPEN = {
  ...OPEN,
  metadata: {
    ...metadata,
    decisionId: citedDecisionId,
    caseNumber: "II. ÚS 456/24",
    url: citedDecisionUrl,
  },
} satisfies ReaderOpen;
const CITED_PAGE = {
  ...SECOND,
  metadata: CITED_OPEN.metadata,
  content: { ...SECOND.content, items: [paragraph(90)] },
} satisfies ReaderPage;
const PREVIEW = {
  country: "CZE",
  documentId: provision.document_id,
  language: "cs",
  anchorId: provision.anchor,
  citedAnchorId: provision.cited_anchor,
  url: provisionUrl,
  headings: [],
  heading: null,
  blocks: [
    {
      id: "provision-block",
      anchorId: provision.cited_anchor,
      text: "Exact cited provision wording.",
    },
  ],
} satisfies ReaderPreview;

const RESULT_TARGET_INDEX = 20;
const searchRow = APP_SEARCH_FIXTURE.results.at(0);
if (searchRow === undefined) {
  panic("Search fixture requires a decision row");
}
const RESULT_FIXTURE = {
  ...APP_SEARCH_FIXTURE,
  nextCursor: null,
  results: Array.from({ length: 35 }, (_, index) => ({
    ...searchRow,
    decisionId:
      index === RESULT_TARGET_INDEX
        ? metadata.decisionId
        : `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
    caseNumber:
      index === RESULT_TARGET_INDEX
        ? metadata.caseNumber
        : `Fixture result ${index + 1}`,
    url:
      index === RESULT_TARGET_INDEX
        ? `${metadata.url}#par=48-49`
        : `https://stella.example/law/cze/cases/fixture/result-${index + 1}`,
  })),
} satisfies SearchResults;

type HostOptions = {
  page: Page;
  host: "ChatGPT" | "Claude";
  locale?: string;
  open?: ReaderOpen;
  paragraphs?: string;
  pages?: ReaderPage[];
  navigation?: "tools" | "links";
  surface?: "reader" | "results";
  sandbox?: "opaque" | "same-origin";
  revision?: "stable" | "updated";
  search?: SearchResults;
  searchInput?: Record<string, unknown>;
  theme?: "light" | "dark";
  fullscreen?: "supported" | "unsupported";
  maxHeight?: number;
  acceptFullscreen?: boolean;
  directory?: string;
  handoff?: "minted" | "declined";
};
const mountReader = async ({
  page,
  host,
  locale = "en-GB",
  open = OPEN,
  paragraphs,
  pages = [FIRST, SECOND],
  navigation = "tools",
  surface = "reader",
  sandbox = "opaque",
  revision = "stable",
  search = RESULT_FIXTURE,
  searchInput = { queries: ["náhrada škody"], country: "CZE", limit: 100 },
  theme = "light",
  fullscreen = "supported",
  maxHeight = 900,
  acceptFullscreen = host === "ChatGPT",
  directory = surface === "reader" ? "decision-reader" : "case-law-results",
  handoff = "declined",
}: HostOptions) => {
  const bundle = await readFile(
    process.env["MCP_APP_BUNDLE_DIRECTORY"] === undefined
      ? new URL(
          `../../../packages/mcp-apps/src/${directory}/generated/app.html.txt`,
          import.meta.url,
        )
      : path.join(
          process.env["MCP_APP_BUNDLE_DIRECTORY"] ?? "",
          `${directory}.html`,
        ),
    "utf-8",
  );
  const html = bundle.replace(
    "<head>",
    () =>
      `<head><meta http-equiv="Content-Security-Policy" content="${MCP_APP_SANDBOX_CONTENT_DIRECTIVES.join("; ")}">`,
  );
  const fixtureUrl = "http://localhost/decision-reader-fixture";
  const sandboxPermissions =
    sandbox === "same-origin"
      ? "allow-scripts allow-forms allow-same-origin"
      : "allow-scripts allow-forms";
  await page.route(fixtureUrl, async (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<iframe id="reader" sandbox="${sandboxPermissions}" style="width:100%;height:650px;border:0"></iframe>`,
    }),
  );
  await page.goto(fixtureUrl);
  const mounted = await page.evaluate(
    ({
      html: appHtml,
      host: hostName,
      locale: hostLocale,
      open: result,
      paragraphs: range,
      pages: results,
      navigation: navigationMode,
      citedOpening,
      citedPage,
      provisionPreview,
      surface: appSurface,
      searchResult,
      searchArguments,
      revision: documentRevision,
      revisedPages,
      theme: hostTheme,
      fullscreen: fullscreenCapability,
      maxHeight: inlineMaxHeight,
      acceptFullscreen: grantRequest,
      handoff: handoffStatus,
      handoffTool,
    }) => {
      const iframe = document.querySelector<HTMLIFrameElement>("iframe");
      if (iframe === null) {
        return "missing" as const;
      }
      const calls: ReaderFixtureHost["calls"] = [];
      const links: string[] = [];
      const failures: string[] = [];
      const messages: ReaderFixtureHost["messages"] = [];
      const toolResponses: ReaderFixtureHost["toolResponses"] = [];
      let revisionState: "initial" | "conflict" | "revised" = "initial";
      const reply = (message: unknown) =>
        iframe.contentWindow?.postMessage(message, "*");
      const toolResult = (data: unknown) => ({
        content: [],
        structuredContent: data,
      });
      const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);
      const rejectRequest = (id: unknown, message: string) => {
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
                  availableDisplayModes:
                    fullscreenCapability === "supported"
                      ? ["inline", "fullscreen"]
                      : ["inline"],
                  containerDimensions: { maxHeight: inlineMaxHeight },
                  toolInfo: {
                    id: "fixture-repeated-request-id",
                    tool: {
                      name:
                        appSurface === "reader"
                          ? "open_case_law_decision"
                          : "search_case_law",
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
              params: {
                arguments:
                  appSurface === "reader"
                    ? {
                        decision_id: result.metadata.decisionId,
                        ...(range === undefined ? {} : { paragraphs: range }),
                      }
                    : searchArguments,
              },
            });
            reply({
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: toolResult(
                appSurface === "reader" ? result : searchResult,
              ),
            });
            break;
          case "tools/call": {
            if (
              !isRecord(params) ||
              typeof params["name"] !== "string" ||
              !isRecord(params["arguments"])
            ) {
              rejectRequest(id, "Invalid fixture tool request");
              return;
            }
            const { name, arguments: args } = params;
            calls.push({ name, arguments: args });
            if (name === handoffTool) {
              if (typeof args["url"] !== "string") {
                rejectRequest(id, "Invalid fixture handoff URL");
                return;
              }
              reply({
                jsonrpc: "2.0",
                id,
                result:
                  handoffStatus === "minted"
                    ? toolResult({
                        url: `${args["url"]}#sh=sh1_fixture`,
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
            if (name === "search_case_law") {
              reply({ jsonrpc: "2.0", id, result: toolResult(searchResult) });
              break;
            }
            if (name === "open_case_law_decision") {
              reply({
                jsonrpc: "2.0",
                id,
                result: toolResult(
                  args["decision_id"] === result.metadata.decisionId
                    ? result
                    : citedOpening,
                ),
              });
              break;
            }
            if (name === "preview_cited_provision") {
              const output = toolResult(provisionPreview);
              toolResponses.push(output);
              reply({ jsonrpc: "2.0", id, result: output });
              break;
            }
            if (name !== "read_case_law_decision_blocks") {
              reply({
                jsonrpc: "2.0",
                id,
                result: {
                  isError: true,
                  content: [
                    { type: "text", text: "Unsupported fixture tool." },
                  ],
                },
              });
              break;
            }
            if (
              documentRevision === "updated" &&
              revisionState === "initial" &&
              args["cursor"] !== undefined
            ) {
              revisionState = "conflict";
              const output = {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error: {
                        code: "conflict",
                        message: "The decision changed while loading.",
                        hint: "Read the decision again without a cursor.",
                        retryable: true,
                      },
                    }),
                  },
                ],
              };
              toolResponses.push(output);
              reply({ jsonrpc: "2.0", id, result: output });
              break;
            }
            if (
              documentRevision === "updated" &&
              revisionState === "conflict" &&
              args["cursor"] === undefined
            ) {
              revisionState = "revised";
            }
            const activePages =
              revisionState === "revised" ? revisedPages : results;
            const index =
              args["cursor"] === undefined
                ? 0
                : activePages.findIndex(
                    (entry) =>
                      entry.content.status === "available" &&
                      entry.content.nextCursor === args["cursor"],
                  ) + 1;
            const response =
              args["decision_id"] === citedOpening.metadata.decisionId
                ? citedPage
                : activePages.at(index);
            if (response === undefined) {
              failures.push("Missing reader page fixture");
              reply({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32_603,
                  message: "Missing reader page fixture",
                },
              });
              return;
            }
            const output = toolResult(response);
            toolResponses.push(output);
            reply({ jsonrpc: "2.0", id, result: output });
            break;
          }
          case "ui/notifications/size-changed":
            if (isRecord(params) && typeof params["height"] === "number") {
              iframe.style.height = `${params["height"]}px`;
            }
            break;
          case "ui/request-display-mode":
            if (grantRequest) {
              iframe.style.height = "900px";
            }
            reply({
              jsonrpc: "2.0",
              id,
              result: { mode: grantRequest ? "fullscreen" : "inline" },
            });
            break;
          case "ui/open-link":
            if (!isRecord(params) || typeof params["url"] !== "string") {
              rejectRequest(id, "Invalid fixture link request");
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
      globalThis.readerFixtureHost = {
        calls,
        links,
        messages,
        toolResponses,
        failures,
        grantInline: () => {
          reply({
            jsonrpc: "2.0",
            method: "ui/notifications/host-context-changed",
            params: {
              displayMode: "inline",
              containerDimensions: { maxHeight: inlineMaxHeight },
            },
          });
        },
        grantFullscreen: () => {
          iframe.style.height = "900px";
          reply({
            jsonrpc: "2.0",
            method: "ui/notifications/host-context-changed",
            params: {
              displayMode: "fullscreen",
              containerDimensions: { height: 900 },
            },
          });
        },
      } satisfies ReaderFixtureHost;
      // safe-html: build-mcp-apps.ts emits the repository's self-contained reader bundle.
      iframe.srcdoc = appHtml;
      return "mounted" as const;
    },
    {
      html,
      host,
      locale,
      open,
      paragraphs,
      pages,
      navigation,
      citedOpening: CITED_OPEN,
      citedPage: CITED_PAGE,
      provisionPreview: PREVIEW,
      surface,
      searchResult: search,
      searchArguments: searchInput,
      revision,
      revisedPages: REVISED_PAGES,
      theme,
      fullscreen,
      maxHeight,
      acceptFullscreen,
      handoff,
      handoffTool: MCP_WEB_HANDOFF_TOOL_NAME,
    },
  );
  expect(mounted).toBe("mounted");
  return page.frameLocator("#reader");
};
const history = async (page: Page) => {
  const recorded = await page.evaluate(() => ({
    calls: globalThis.readerFixtureHost.calls,
    links: globalThis.readerFixtureHost.links,
    messages: globalThis.readerFixtureHost.messages,
    toolResponses: globalThis.readerFixtureHost.toolResponses,
    failures: globalThis.readerFixtureHost.failures,
  }));
  expect(recorded.failures).toEqual([]);
  return recorded;
};

const expectNoCopyAction = async (app: FrameLocator) => {
  await expect(
    app.locator('button[aria-label="Copy link"], a[aria-label="Copy link"]'),
  ).toHaveCount(0);
};

for (const host of ["ChatGPT", "Claude"] as const) {
  test(`${host} reader reloads revised pages after a continuation conflict`, async ({
    page,
  }) => {
    const app = await mountReader({
      page,
      host,
      paragraphs: "48-49",
      open: {
        ...OPEN,
        metadata: { ...metadata, url: `${metadata.url}#par=48-49` },
      },
      revision: "updated",
    });
    await expect(
      app.getByRole("status").filter({ hasText: "The document was updated." }),
    ).toBeVisible();
    await expect(app.locator("#para1")).toHaveCount(0);
    await expect(app.getByRole("alert")).toHaveCount(0);
    await app.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(app.locator("#para1")).toContainText("Updated paragraph 1.");
    await expect(app.locator("#para48[data-reader-landing]")).toContainText(
      "Updated paragraph 48.",
    );
    await expect(app.locator("#para49[data-reader-landing]")).toContainText(
      "Updated paragraph 49.",
    );
    await expect(
      app.getByText("Reader-only paragraph", { exact: false }),
    ).toHaveCount(0);
    await expectNoCopyAction(app);
    await expect(
      app.getByRole("status").filter({ hasText: "The document was updated." }),
    ).toBeVisible();
    await expect
      .poll(async () => (await history(page)).calls)
      .toEqual([
        {
          name: "read_case_law_decision_blocks",
          arguments: { decision_id: metadata.decisionId },
        },
        {
          name: "read_case_law_decision_blocks",
          arguments: {
            decision_id: metadata.decisionId,
            cursor: "fixture-page-2",
          },
        },
        {
          name: "read_case_law_decision_blocks",
          arguments: { decision_id: metadata.decisionId },
        },
        {
          name: "read_case_law_decision_blocks",
          arguments: {
            decision_id: metadata.decisionId,
            cursor: "fixture-revised-page-2",
          },
        },
      ]);
    const recorded = await history(page);
    expect(recorded.toolResponses.at(1)).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "conflict",
              message: "The decision changed while loading.",
              hint: "Read the decision again without a cursor.",
              retryable: true,
            },
          }),
        },
      ],
    });
    expect(
      recorded.messages.some(
        ({ method }) =>
          method === "ui/update-model-context" || method === "ui/message",
      ),
    ).toBe(false);
  });

  test(`${host} reader loads app-only pages and opens the web reader through the host`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", ({ message }) => errors.push(message));
    const app = await mountReader({ page, host });
    await expect(app.locator("#para1")).toContainText(
      "Reader-only paragraph 1.",
    );
    await expectNoCopyAction(app);
    await expect(app.locator("#para48")).toHaveCount(0);
    await app.locator("[data-app-fullscreen]").click();
    await expect
      .poll(async () =>
        (await history(page)).messages
          .filter(({ method }) => method === "ui/request-display-mode")
          .map(({ params }) => params),
      )
      .toContainEqual({ mode: "fullscreen" });
    if (host === "Claude") {
      await expect
        .poll(
          async () =>
            (await history(page)).messages.filter(
              ({ method }) => method === "ui/notifications/size-changed",
            ).length,
        )
        .toBeGreaterThan(0);
      await page.evaluate(() => globalThis.readerFixtureHost.grantFullscreen());
    }
    await app.getByRole("button", { name: "Next", exact: true }).click();
    await expect(app.locator("#para48")).toContainText(
      "Reader-only paragraph 48.",
    );
    await expect(app.locator("#para1")).toContainText(
      "Reader-only paragraph 1.",
    );
    await expectNoCopyAction(app);
    await expect
      .poll(async () => (await history(page)).calls)
      .toEqual([
        {
          name: "read_case_law_decision_blocks",
          arguments: { decision_id: metadata.decisionId },
        },
        {
          name: "read_case_law_decision_blocks",
          arguments: {
            decision_id: metadata.decisionId,
            cursor: "fixture-page-2",
          },
        },
      ]);
    await app
      .getByRole("button", { name: "Open in stella", exact: true })
      .click();
    await expect
      .poll(async () => (await history(page)).links)
      .toEqual([metadata.url]);
    const recorded = await history(page);
    expect(recorded.toolResponses).toHaveLength(2);
    expect(
      recorded.toolResponses.every(({ content }) => content.length === 0),
    ).toBe(true);
    expect(
      recorded.messages.some(
        ({ method }) =>
          method === "ui/update-model-context" || method === "ui/message",
      ),
    ).toBe(false);
    expect(JSON.stringify(recorded.messages)).not.toContain(
      "Reader-only paragraph",
    );
    expect(errors).toEqual([]);
  });

  test(`${host} reader loads and highlights a paragraph range on a later page`, async ({
    page,
  }) => {
    const app = await mountReader({
      page,
      host,
      paragraphs: "48-49",
      open: {
        ...OPEN,
        metadata: { ...metadata, url: `${metadata.url}#par=48-49` },
      },
    });
    await expect(app.locator("#para48[data-reader-landing]")).toBeVisible();
    await expect(app.locator("#para49[data-reader-landing]")).toBeVisible();
    await expectNoCopyAction(app);
    await expect
      .poll(async () =>
        app.locator("#para48").evaluate((element) => {
          const top = element.getBoundingClientRect().top;
          return top >= 0 && top < 650;
        }),
      )
      .toBe(true);
    await app
      .getByRole("button", { name: "Open in stella", exact: true })
      .click();
    await expect
      .poll(async () => (await history(page)).links)
      .toEqual([`${metadata.url}#par=48-49`]);
    expect(
      (await history(page)).calls.map(({ arguments: args }) => args["cursor"]),
    ).toEqual([undefined, "fixture-page-2"]);
  });

  for (const handoff of ["minted", "declined"] as const) {
    test(`${host} reader respects app-only withheld status and exposes a localized web action (handoff ${handoff})`, async ({
      page,
    }) => {
      const app = await mountReader({
        page,
        host,
        locale: "cs",
        open: WITHHELD,
        pages: [WITHHELD_PAGE],
        handoff,
      });
      await expect(
        app.getByText(metadata.caseNumber, { exact: true }),
      ).toBeVisible();
      await expect(app.locator("article")).toHaveCount(0);
      await app
        .getByRole("button", { name: "Otevřít ve stelle", exact: true })
        .click();
      await expect
        .poll(async () => (await history(page)).links)
        .toEqual([
          handoff === "minted"
            ? `${metadata.url}#sh=sh1_fixture`
            : metadata.url,
        ]);
      expect((await history(page)).calls).toEqual([
        {
          name: "read_case_law_decision_blocks",
          arguments: { decision_id: metadata.decisionId },
        },
        {
          name: MCP_WEB_HANDOFF_TOOL_NAME,
          arguments: { url: metadata.url },
        },
      ]);
    });
  }

  test(`${host} reader displays app-only body when the opening result withholds model text`, async ({
    page,
  }) => {
    const app = await mountReader({ page, host, open: WITHHELD });
    await expect(app.locator("#para1")).toContainText(
      "Reader-only paragraph 1.",
    );
    await app.getByRole("button", { name: "Next", exact: true }).click();
    await expect(app.locator("#para48")).toContainText(
      "Reader-only paragraph 48.",
    );
    const recorded = await history(page);
    expect(recorded.calls).toHaveLength(2);
    expect(
      recorded.messages.some(
        ({ method }) =>
          method === "ui/update-model-context" || method === "ui/message",
      ),
    ).toBe(false);
    expect(JSON.stringify(recorded.messages)).not.toContain(
      "Reader-only paragraph",
    );
  });
}

const loadReferencePages = async (app: FrameLocator) => {
  await app.getByRole("button", { name: "Next", exact: true }).click();
  await app.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    app.getByRole("button", { name: "Next", exact: true }),
  ).toHaveCount(0);
};
const expectOnlyReferencePageCalls = (calls: ReaderFixtureHost["calls"]) => {
  expect(calls.map(({ name }) => name)).toEqual(
    LINK_PAGES.map(() => "read_case_law_decision_blocks"),
  );
  expect(calls.map(({ arguments: args }) => args["cursor"])).toEqual([
    undefined,
    "fixture-link-citations",
    "fixture-link-provisions",
  ]);
};

for (const host of ["ChatGPT", "Claude"] as const) {
  test(`${host} reader opens cited decisions and provisions through app-only host tools`, async ({
    page,
  }) => {
    const app = await mountReader({ page, host, pages: LINK_PAGES });
    await loadReferencePages(app);
    await app
      .getByRole("button", { name: "cited provision", exact: true })
      .click();
    await expect(app.locator("aside")).toContainText(
      "Exact cited provision wording.",
    );
    await expect
      .poll(async () => (await history(page)).calls)
      .toContainEqual({
        name: "preview_cited_provision",
        arguments: { provision },
      });
    await app
      .locator("aside")
      .getByRole("button", { name: "Open in stella", exact: true })
      .click();
    await expect
      .poll(async () => (await history(page)).links)
      .toEqual([provisionUrl]);
    await app
      .getByRole("button", { name: "Cited decision", exact: true })
      .click();
    await expect(
      app.getByText(CITED_OPEN.metadata.caseNumber, { exact: true }),
    ).toBeVisible();
    await expect(app.locator("#para90")).toContainText(
      "Reader-only paragraph 90.",
    );
    await expect(app.locator("#linked-paragraph")).toHaveCount(0);
    await expect(app.locator("aside")).toHaveCount(0);
    await expect(
      app.getByText("Exact cited provision wording.", { exact: true }),
    ).toHaveCount(0);
    const recorded = await history(page);
    expect(recorded.calls).toContainEqual({
      name: "open_case_law_decision",
      arguments: { decision_id: citedDecisionId },
    });
    expect(recorded.calls).toContainEqual({
      name: "read_case_law_decision_blocks",
      arguments: { decision_id: citedDecisionId },
    });
    expect(
      recorded.toolResponses.every(({ content }) => content.length === 0),
    ).toBe(true);
    expect(
      recorded.messages.some(
        ({ method }) =>
          method === "ui/update-model-context" || method === "ui/message",
      ),
    ).toBe(false);
    expect(JSON.stringify(recorded.messages)).not.toContain(
      "Exact cited provision wording.",
    );
    expect(JSON.stringify(recorded.messages)).not.toContain(
      "Reader-only paragraph",
    );
  });

  test(`${host} reader uses exact canonical URLs when in-app navigation is unavailable`, async ({
    page,
  }) => {
    const app = await mountReader({
      page,
      host,
      navigation: "links",
      pages: LINK_PAGES,
    });
    await loadReferencePages(app);
    const pageCalls = (await history(page)).calls;
    expectOnlyReferencePageCalls(pageCalls);
    await app
      .getByRole("button", { name: "Cited decision", exact: true })
      .click();
    await app
      .getByRole("button", { name: "cited provision", exact: true })
      .click();
    await expect
      .poll(async () => (await history(page)).links)
      .toEqual([citedDecisionUrl, provisionUrl]);
    expect((await history(page)).calls).toEqual([
      ...pageCalls,
      {
        name: MCP_WEB_HANDOFF_TOOL_NAME,
        arguments: { url: citedDecisionUrl },
      },
      {
        name: MCP_WEB_HANDOFF_TOOL_NAME,
        arguments: { url: provisionUrl },
      },
    ]);
  });

  test(`${host} reader leaves references as text when neither navigation nor a URL is available`, async ({
    page,
  }) => {
    const pagesWithoutUrls = LINK_PAGES.map((readerPage) => ({
      ...readerPage,
      content: {
        ...readerPage.content,
        citationAnchors: readerPage.content.citationAnchors.map((anchor) => ({
          ...anchor,
          url: null,
        })),
        provisionAnchors: readerPage.content.provisionAnchors.map((anchor) => ({
          ...anchor,
          url: null,
        })),
      },
    })) satisfies ReaderPage[];
    const app = await mountReader({
      page,
      host,
      navigation: "links",
      pages: pagesWithoutUrls,
    });
    await loadReferencePages(app);
    await expect(app.locator("#linked-paragraph")).toContainText(linkedText);
    await expect(
      app.getByRole("button", { name: "Cited decision", exact: true }),
    ).toHaveCount(0);
    await expect(
      app.getByRole("button", { name: "cited provision", exact: true }),
    ).toHaveCount(0);
    const recorded = await history(page);
    expect(recorded.links).toEqual([]);
    expectOnlyReferencePageCalls(recorded.calls);
  });
}

test("reader reassembles fragmented blocks and consumes anchor-only pages", async ({
  page,
}) => {
  const block = paragraph(48);
  const json = JSON.stringify(block);
  const split = Math.floor(json.length / 2);
  const pages = [
    {
      ...FIRST,
      content: {
        ...FIRST.content,
        items: [],
        blockFragments: [
          {
            blockId: block.id,
            offset: 0,
            totalChars: json.length,
            json: json.slice(0, split),
          },
        ],
      },
    },
    {
      ...SECOND,
      content: {
        ...SECOND.content,
        items: [],
        blockFragments: [
          {
            blockId: block.id,
            offset: split,
            totalChars: json.length,
            json: json.slice(split),
          },
        ],
        nextCursor: "fixture-anchors",
      },
    },
    {
      ...SECOND,
      content: {
        ...SECOND.content,
        phase: "citations",
        items: [],
        citationAnchors: [
          {
            pieceId: block.id,
            start: 0,
            end: 9,
            citationId: "fixture-citation",
            url: citedDecisionUrl,
            decisionId: "00000000-0000-4000-8000-000000000002",
          },
        ],
      },
    },
  ] satisfies ReaderPage[];
  const app = await mountReader({ page, host: "ChatGPT", pages });
  await expect(
    app.getByRole("button", { name: "Next", exact: true }),
  ).toBeVisible();
  await expect(app.locator("#para48")).toHaveCount(0);
  await app.getByRole("button", { name: "Next", exact: true }).click();
  await expect(app.locator("#para48")).toContainText(
    "Reader-only paragraph 48.",
  );
  await app.getByRole("button", { name: "Next", exact: true }).click();
  await expect
    .poll(async () =>
      (await history(page)).calls.map(({ arguments: args }) => args["cursor"]),
    )
    .toEqual([undefined, "fixture-page-2", "fixture-anchors"]);
  await expect(
    app
      .locator("#para48")
      .getByRole("button", { name: "Reader-on", exact: true }),
  ).toBeVisible();
  await expect(
    app.getByRole("button", { name: "Next", exact: true }),
  ).toHaveCount(0);
});

for (const host of ["ChatGPT", "Claude"] as const) {
  test(`${host} results open the reader in the same iframe and restore the row after Back, Escape and Alt+Left`, async ({
    page,
  }) => {
    const app = await mountReader({
      page,
      host,
      surface: "results",
      open: {
        ...OPEN,
        metadata: { ...metadata, url: `${metadata.url}#par=48-49` },
      },
    });
    const rows = app.locator("tbody tr");
    await expect(rows).toHaveCount(35);
    const opener = rows
      .nth(RESULT_TARGET_INDEX)
      .getByRole("button", { name: "Open", exact: true });
    await opener.scrollIntoViewIfNeeded();
    await opener.focus();
    const scrollBefore = await opener.evaluate(
      () => document.querySelector("[data-app-viewport]")?.scrollTop,
    );
    expect(scrollBefore).toBeGreaterThan(0);
    await opener.press("Enter");
    await expect(app.locator("#para48[data-reader-landing]")).toBeVisible();
    await expect(app.locator("#para49[data-reader-landing]")).toBeVisible();
    await expectNoCopyAction(app);
    const header = app.locator('[data-slot="reader-header"]');
    const back = header.getByRole("button", { name: "Back", exact: true });
    await expect(back.locator("svg")).toHaveCount(1);
    await expect(
      header.getByText(metadata.caseNumber, { exact: true }),
    ).toBeVisible();
    await expect(
      header.getByText(metadata.court, { exact: true }),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: "Open in stella", exact: true }),
    ).toBeVisible();
    await expect(app.getByText("cs", { exact: true })).toHaveCount(0);
    for (const width of [360, 900]) {
      await page.locator("iframe").evaluate((element, viewportWidth) => {
        element.style.width = `${viewportWidth}px`;
      }, width);
      await expect(
        header.getByText(metadata.court, { exact: true }),
      ).toBeVisible();
      const bounds = await back.boundingBox();
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
      expect(
        await header.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    }
    await page.locator("iframe").evaluate((element) => {
      element.style.width = "100%";
    });
    await app
      .getByRole("button", { name: "Open in stella", exact: true })
      .click();
    await expect
      .poll(async () => (await history(page)).links)
      .toEqual([`${metadata.url}#par=48-49`]);
    await expect(page.locator("iframe")).toHaveCount(1);
    await expect
      .poll(async () => (await history(page)).calls)
      .toContainEqual({
        name: "open_case_law_decision",
        arguments: { decision_id: metadata.decisionId, paragraphs: "48-49" },
      });
    await app.locator("[data-app-fullscreen]").click();
    await expect
      .poll(async () =>
        (await history(page)).messages
          .filter(({ method }) => method === "ui/request-display-mode")
          .map(({ params }) => params),
      )
      .toContainEqual({ mode: "fullscreen" });
    await app.getByRole("button", { name: "Back", exact: true }).click();
    await expect(rows).toHaveCount(35);
    await expect(opener).toBeFocused();
    expect(
      await opener.evaluate(
        () => document.querySelector("[data-app-viewport]")?.scrollTop,
      ),
    ).toBe(scrollBefore);
    await opener.press("Enter");
    await expect(app.locator("#para48[data-reader-landing]")).toBeVisible();
    await expectNoCopyAction(app);
    await app
      .getByRole("button", { name: "Back", exact: true })
      .press("Escape");
    await expect(rows).toHaveCount(35);
    await expect(opener).toBeFocused();
    expect(
      await opener.evaluate(
        () => document.querySelector("[data-app-viewport]")?.scrollTop,
      ),
    ).toBe(scrollBefore);
    await opener.press("Enter");
    await expect(app.locator("#para48[data-reader-landing]")).toBeVisible();
    await back.press("Alt+ArrowLeft");
    await expect(rows).toHaveCount(35);
    await expect(opener).toBeFocused();
    expect((await history(page)).links).toEqual([`${metadata.url}#par=48-49`]);
    await expect(page.locator("iframe")).toHaveCount(1);
  });
}

for (const host of ["ChatGPT", "Claude"] as const) {
  test(`${host} reader openings in separate host pages remain independent without conversation identity`, async ({
    page,
  }) => {
    const first = await mountReader({ page, host, sandbox: "same-origin" });
    await expect(first.locator("#para1")).toContainText(
      "Reader-only paragraph 1.",
    );
    expect(await first.locator("html").evaluate(() => window.origin)).toBe(
      "http://localhost",
    );
    await first.locator("html").evaluate((element) => {
      const channel = new BroadcastChannel("stella-fixture-shared-origin");
      channel.addEventListener(
        "message",
        (event) => {
          const data: unknown = event.data;
          if (data !== "fixture-delivered") {
            return;
          }
          element.dataset["fixtureChannel"] = data;
          channel.close();
        },
        { once: true },
      );
    });
    const secondPage = await page.context().newPage();
    const second = await mountReader({
      page: secondPage,
      host,
      sandbox: "same-origin",
      pages: LINK_PAGES,
    });
    await expect(second.locator("#linked-paragraph")).toContainText(linkedText);
    expect(await second.locator("html").evaluate(() => window.origin)).toBe(
      "http://localhost",
    );
    await second.locator("html").evaluate(() => {
      const channel = new BroadcastChannel("stella-fixture-shared-origin");
      const send = channel.postMessage.bind(channel);
      send("fixture-delivered");
      channel.close();
    });
    await expect(first.locator("html")).toHaveAttribute(
      "data-fixture-channel",
      "fixture-delivered",
    );
    await expect(first.locator("#para1")).toContainText(
      "Reader-only paragraph 1.",
    );
    await loadReferencePages(second);
    await second
      .getByRole("button", { name: "cited provision", exact: true })
      .click();
    await expect(second.locator("aside")).toContainText(
      "Exact cited provision wording.",
    );
    await second
      .getByRole("button", { name: "Cited decision", exact: true })
      .click();
    await expect(second.locator("#para90")).toContainText(
      "Reader-only paragraph 90.",
    );
    await expect(second.locator("#linked-paragraph")).toHaveCount(0);
    await expect(second.locator("aside")).toHaveCount(0);
    await expect(first.locator("#para1")).toContainText(
      "Reader-only paragraph 1.",
    );
    await first.getByRole("button", { name: "Next", exact: true }).click();
    await expect(first.locator("#para48")).toContainText(
      "Reader-only paragraph 48.",
    );
    await expect(first.locator("#para1")).toContainText(
      "Reader-only paragraph 1.",
    );
    await expect(second.locator("#para90")).toContainText(
      "Reader-only paragraph 90.",
    );
    expect(
      (await history(page)).calls.map(({ arguments: args }) => args["cursor"]),
    ).toEqual([undefined, "fixture-page-2"]);
    expect((await history(secondPage)).calls).toContainEqual({
      name: "open_case_law_decision",
      arguments: { decision_id: citedDecisionId },
    });
  });
}

test("search notes use one compact disclosure and hide model-only instructions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const search = {
    ...RESULT_FIXTURE,
    searches: [
      {
        warnings: [
          { audience: "user", message: "Žádná odpovídající rozhodnutí" },
          { audience: "user", message: "Žádné výsledky s filtry: Soud" },
          { audience: "agent", message: "MODEL ONLY: Pass strict: true" },
        ],
      },
    ],
  } satisfies SearchResults;
  const app = await mountReader({
    page,
    host: "ChatGPT",
    surface: "results",
    locale: "cs",
    search,
  });
  const notice = app.locator("[data-app-notice]");
  await expect(notice).toHaveCount(1);
  await expect(notice.locator("summary")).toContainText(
    "Žádná odpovídající rozhodnutí",
  );
  await expect(notice.locator("summary")).toContainText(
    "Žádné výsledky s filtry: Soud",
  );
  await expect(notice).not.toHaveAttribute("open");
  await expect(notice.locator("ul")).toBeHidden();
  const collapsedHeight = await notice.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(collapsedHeight).toBeLessThanOrEqual(24);
  await notice.locator("summary").press("Enter");
  await expect(notice).toHaveAttribute("open", "");
  await expect(notice.locator("li")).toHaveCount(2);
  await expect(notice.locator("li").first()).toBeVisible();
  await expect(app.getByText("MODEL ONLY", { exact: false })).toHaveCount(0);
  await expect(app.getByText("Pass strict", { exact: false })).toHaveCount(0);
  await notice.locator("summary").press("Space");
  await expect(notice).not.toHaveAttribute("open");
});

test("search pages with only model guidance have no notice", async ({
  page,
}) => {
  const search = {
    ...RESULT_FIXTURE,
    searches: [
      {
        warnings: [
          {
            audience: "agent",
            message: "MODEL ONLY",
          },
        ],
      },
    ],
  } satisfies SearchResults;
  const app = await mountReader({
    page,
    host: "Claude",
    surface: "results",
    search,
  });
  await expect(app.locator("tbody tr")).toHaveCount(35);
  await expect(app.locator("[data-app-notice]")).toHaveCount(0);
});

test("search next page and filter pass the declared model arguments to the server, which normalizes them", async ({
  page,
}) => {
  const search = {
    ...RESULT_FIXTURE,
    nextCursor: "fixture-search-page-2",
  } satisfies SearchResults;
  const searchInput = {
    queries: ["dismissal"],
    country: "CZE",
    limit: 50,
    date_from: "2024",
    courts: "X",
  };
  const app = await mountReader({
    page,
    host: "ChatGPT",
    surface: "results",
    search,
    searchInput,
  });
  await app.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    app.getByRole("button", { name: "Filter", exact: true }),
  ).toBeVisible();
  await app.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(
    app.getByRole("button", { name: "Filter", exact: true }),
  ).toBeVisible();
  const recorded = await history(page);
  expect(recorded.calls).toEqual([
    {
      name: "search_case_law",
      arguments: { ...searchInput, cursor: "fixture-search-page-2" },
    },
    {
      name: "search_case_law",
      arguments: {
        queries: ["dismissal"],
        country: "CZE",
        limit: 50,
        date_from: "2024-01-01",
        courts: ["X"],
      },
    },
  ]);
});

test("court multi-selection respects the declared cap, tier unions, search and accessible chips", async ({
  page,
}) => {
  const maxCourts =
    APP_INPUT_SCHEMAS.search_case_law.properties.courts.maxItems;
  const regionalCourts = Array.from({ length: maxCourts + 1 }, (_, index) => ({
    value: `Regional Court ${index + 1}`,
  }));
  const search = {
    ...RESULT_FIXTURE,
    facets: {
      court: [
        {
          tierLabel: "supreme",
          courts: [{ value: "Nejvyšší soud" }, { value: "Ústavní soud" }],
        },
        { tierLabel: "regional", courts: regionalCourts },
      ],
    },
  } satisfies SearchResults;
  const searchInput = { queries: ["náhrada škody"], country: "CZE", limit: 20 };
  const app = await mountReader({
    page,
    host: "ChatGPT",
    surface: "results",
    search,
    searchInput,
  });
  const trigger = app.getByRole("button", { name: /^Court/u });
  await trigger.click();
  const popup = app.locator('[data-slot="popover-popup"][data-open]');
  const regionalTier = popup.getByRole("checkbox", {
    name: "High and regional courts",
    exact: true,
  });
  await expect(regionalTier).toBeDisabled();
  const supremeTier = popup.getByRole("checkbox", {
    name: "Supreme courts",
    exact: true,
  });
  await supremeTier.check();
  await expect(
    popup.getByRole("checkbox", { name: "Nejvyšší soud", exact: true }),
  ).toBeChecked();
  await expect(
    popup.getByRole("checkbox", { name: "Ústavní soud", exact: true }),
  ).toBeChecked();
  const searchCourts = popup.getByRole("searchbox", { name: "Search" });
  await searchCourts.fill("ustavni");
  await expect(
    popup.getByRole("checkbox", { name: "Ústavní soud", exact: true }),
  ).toBeVisible();
  await expect(
    popup.getByRole("checkbox", { name: "Nejvyšší soud", exact: true }),
  ).toHaveCount(0);
  await supremeTier.uncheck();
  await searchCourts.fill("");
  await expect(
    popup.getByRole("checkbox", { name: "Nejvyšší soud", exact: true }),
  ).toBeChecked();
  await supremeTier.check();
  for (const { value } of regionalCourts.slice(0, maxCourts - 2)) {
    await popup.getByRole("checkbox", { name: value, exact: true }).check();
  }
  await expect(popup.getByRole("status")).toContainText(String(maxCourts));
  await expect(
    popup.getByRole("checkbox", {
      name: `Regional Court ${maxCourts - 1}`,
      exact: true,
    }),
  ).toBeDisabled();
  await expect(regionalTier).toBeDisabled();
  await popup
    .getByRole("checkbox", { name: "Nejvyšší soud", exact: true })
    .uncheck();
  await expect(supremeTier).toHaveAttribute("aria-checked", "mixed");
  await expect(
    popup.getByRole("checkbox", {
      name: `Regional Court ${maxCourts - 1}`,
      exact: true,
    }),
  ).toBeEnabled();
  await popup
    .getByRole("checkbox", {
      name: `Regional Court ${maxCourts - 1}`,
      exact: true,
    })
    .check();
  await searchCourts.press("Escape");
  await expect(trigger).toHaveAccessibleName(
    new RegExp(`Court.*Ústavní soud.*Regional Court ${maxCourts - 1}`, "u"),
  );
  await app.getByRole("button", { name: "Filter", exact: true }).click();
  const calls = (await history(page)).calls;
  expect(calls).toContainEqual({
    name: "search_case_law",
    arguments: {
      ...searchInput,
      courts: [
        "Ústavní soud",
        ...regionalCourts.slice(0, maxCourts - 1).map(({ value }) => value),
      ],
    },
  });
});

const reportedHeight = async (page: Page) =>
  page.evaluate(() => {
    const last = globalThis.readerFixtureHost.messages.findLast(
      ({ method }) => method === "ui/notifications/size-changed",
    )?.params;
    return typeof last === "object" &&
      last !== null &&
      "height" in last &&
      typeof last.height === "number"
      ? last.height
      : 0;
  });

for (const host of ["Claude", "ChatGPT"] as const) {
  for (const surface of ["reader", "results"] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`${host} ${surface} bounds inline reading and fills fullscreen in ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1100, height: 1000 });
        const app = await mountReader({
          page,
          host,
          surface,
          theme,
          acceptFullscreen: false,
        });
        await expect(
          app.locator(surface === "reader" ? "#para1" : "tbody tr").first(),
        ).toBeVisible();
        await expect.poll(async () => reportedHeight(page)).toBe(600);
        const viewport = app.locator("[data-app-viewport]");
        await expect
          .poll(async () =>
            viewport.evaluate(
              (element) => element.scrollHeight > element.clientHeight,
            ),
          )
          .toBe(true);
        await viewport.evaluate((element) => {
          element.scrollTop = 200;
        });
        await expect
          .poll(async () => viewport.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0);
        expect(
          (await history(page)).messages.filter(
            ({ method }) => method === "ui/request-display-mode",
          ),
        ).toEqual([]);
        await viewport.evaluate((element) => {
          element.scrollTop = 0;
        });
        const screenshotRoot = process.env["MCP_APP_HEIGHT_SCREENSHOTS"];
        if (screenshotRoot !== undefined) {
          await mkdir(screenshotRoot, { recursive: true });
          await page.locator("#reader").screenshot({
            path: path.join(
              screenshotRoot,
              `${host.toLowerCase()}-${surface}-${theme}-inline.png`,
            ),
          });
        }
        await app.locator("[data-app-fullscreen]").click();
        await expect
          .poll(async () =>
            (await history(page)).messages
              .filter(({ method }) => method === "ui/request-display-mode")
              .map(({ params }) => params),
          )
          .toEqual([{ mode: "fullscreen" }]);
        await page.evaluate(() =>
          globalThis.readerFixtureHost.grantFullscreen(),
        );
        await expect.poll(async () => reportedHeight(page)).toBe(900);
        await expect
          .poll(async () =>
            viewport.evaluate((element) => element.clientHeight),
          )
          .toBe(900);
        await expect(app.locator("[data-app-fullscreen]")).toBeHidden();
        if (screenshotRoot !== undefined) {
          await page.locator("#reader").screenshot({
            path: path.join(
              screenshotRoot,
              `${host.toLowerCase()}-${surface}-${theme}-fullscreen.png`,
            ),
          });
        }
        await page.evaluate(() => globalThis.readerFixtureHost.grantInline());
        await expect.poll(async () => reportedHeight(page)).toBe(600);
      });
    }
  }
  test(`${host} respects the smaller inline host maximum and hides unsupported fullscreen`, async ({
    page,
  }) => {
    const app = await mountReader({
      page,
      host,
      maxHeight: 420,
      fullscreen: "unsupported",
    });
    await expect(app.locator("#para1")).toBeVisible();
    await expect.poll(async () => reportedHeight(page)).toBe(420);
    await expect(app.locator("[data-app-fullscreen]")).toBeHidden();
    expect(
      (await history(page)).messages.filter(
        ({ method }) => method === "ui/request-display-mode",
      ),
    ).toEqual([]);
  });
  test(`${host} leaves short results at their natural inline height`, async ({
    page,
  }) => {
    const app = await mountReader({
      page,
      host,
      surface: "results",
      search: { ...RESULT_FIXTURE, results: [] },
    });
    await expect(app.locator("[data-app-viewport]")).toBeVisible();
    await expect.poll(async () => reportedHeight(page)).toBeGreaterThan(0);
    expect(await reportedHeight(page)).toBeLessThan(600);
    const viewport = app.locator("[data-app-viewport]");
    expect(
      await viewport.evaluate(
        (element) => element.scrollHeight <= element.clientHeight,
      ),
    ).toBe(true);
  });
}

const manifestSource = ts.createSourceFile(
  "manifest.ts",
  await readFile(
    new URL("../../../packages/mcp-apps/src/manifest.ts", import.meta.url),
    "utf-8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const registeredDirectories: string[] = [];
const visitManifest = (node: ts.Node): void => {
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText(manifestSource) === "directory" &&
    ts.isStringLiteral(node.initializer)
  ) {
    registeredDirectories.push(node.initializer.text);
  }
  ts.forEachChild(node, visitManifest);
};
visitManifest(manifestSource);
expect(registeredDirectories.length).toBeGreaterThan(0);

for (const directory of registeredDirectories) {
  test(`registered ${directory} bounds all long inline content`, async ({
    page,
  }) => {
    const app = await mountReader({
      page,
      host: "Claude",
      directory,
      fullscreen: "unsupported",
    });
    const viewport = app.locator("[data-app-viewport]");
    await expect(viewport).toBeVisible();
    const appended = await viewport.evaluate((element) => {
      const longContent = document.createElement("article");
      longContent.style.height = "4000px";
      longContent.textContent = "Long reading fixture";
      const content = element.querySelector("#app");
      if (content === null) {
        return false;
      }
      content.append(longContent);
      return true;
    });
    expect(appended).toBe(true);
    await expect.poll(async () => reportedHeight(page)).toBe(600);
    await expect
      .poll(async () => viewport.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(4000);
    await viewport.evaluate((element) => {
      element.scrollTop = 150;
    });
    await expect
      .poll(async () => viewport.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
  });
}

for (const locale of ["en-GB", "cs", "sk", "ar"] as const) {
  test(`fullscreen control uses host locale and direction in ${locale}`, async ({
    page,
  }) => {
    const app = await mountReader({ page, host: "Claude", locale });
    const button = app.locator("[data-app-fullscreen]");
    await expect(button).toBeVisible();
    await expect(button).toHaveText(
      {
        "en-GB": "Open full reader",
        cs: "Otevřít celou čtečku",
        sk: "Otvoriť celú čítačku",
        ar: "فتح القارئ الكامل",
      }[locale],
    );
    await expect(app.locator("html")).toHaveAttribute(
      "dir",
      locale === "ar" ? "rtl" : "ltr",
    );
  });
}

for (const locale of ["cs-CZ", "en-GB", "sk-SK"]) {
  test(`decision reader exposes named controls and localized document metadata in ${locale}`, async ({
    page,
  }) => {
    const app = await mountReader({ page, host: "ChatGPT", locale });
    await expect(app.locator("article").first()).toBeVisible();
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
