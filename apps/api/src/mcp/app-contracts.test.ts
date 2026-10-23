import { describe, expect, test } from "bun:test";
import path from "node:path";
import * as v from "valibot";

import MCP_APP_MESSAGES from "@stll/api-contract/mcp-app-messages";
import {
  APP_RESOLVE_FIXTURE,
  APP_RESOLVE_STATUS_FIXTURES,
  APP_SEARCH_FIXTURE,
  APP_UNAVAILABLE_FIXTURE,
} from "@stll/api-contract/mcp-app.fixtures";
import { MCP_WEB_HANDOFF_TOOL_NAME } from "@stll/api-contract/mcp-web-handoff";
import { UI_LOCALES } from "@stll/locales";
import {
  filterDefaults,
  resolveView,
  searchFilterInput,
  searchView,
  sortResultRows,
} from "@stll/mcp-apps/case-law-results/model";
import { createCaseLawParser } from "@stll/mcp-apps/case-law-results/parse";
import {
  CASE_LAW_RESULTS_APP,
  CITATION_GRAPH_APP,
  MCP_APPS,
} from "@stll/mcp-apps/manifest";
import type {
  ResolveResults,
  SearchResults,
} from "@stll/mcp-apps/shared/contracts";

import {
  READ_PROVISION_HISTORY_PROJECTION,
  READ_STATUTE_PROVISIONS_PROJECTION,
} from "../lib/chat/legislation-result-projections";
import { MCP_APP_CONSUMED_FIELDS } from "./app-consumed-fields";
import { MCP_APP_OUTPUT_SCHEMAS } from "./app-contracts";
import { inspectAppManifest, inspectAppSchemas } from "./app-guards";
import { isMcpAppAvailable } from "./app-policy";
import { inspectAppHtmlSources, inspectAppSources } from "./app-source-guard";
import type { McpMode } from "./constants";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolOutputContract,
} from "./static-tool-definitions";
import { serializeToolResult, untypedToolDataResult } from "./tool-utils";

type ProvisionHistoryFixture = v.InferInput<
  typeof READ_PROVISION_HISTORY_PROJECTION
>;
type StatuteProvisionsFixture = v.InferInput<
  typeof READ_STATUTE_PROVISIONS_PROJECTION
>;

APP_SEARCH_FIXTURE satisfies SearchResults;
APP_RESOLVE_FIXTURE satisfies ResolveResults;
APP_UNAVAILABLE_FIXTURE satisfies SearchResults;
APP_RESOLVE_STATUS_FIXTURES satisfies ResolveResults[];

const PROVISION_HISTORY_FIXTURE = v.parse(READ_PROVISION_HISTORY_PROJECTION, {
  eli: "cz:act:2012:89",
  anchor: "par_1",
  items: [
    {
      url: null,
      documentId: "history-version-found",
      resourceName:
        "stella://resource/legislation_document/id=history-version-found",
      versionValidFrom: "2020-01-01",
      versionValidTo: "2020-12-31",
      expressionKind: "consolidation",
      windowDisposition: "effective",
      windowDispositionBasis: null,
      status: "found",
      nextTextCursor: null,
      text: "The provision wording.",
      truncated: false,
    },
    {
      url: null,
      documentId: "history-version-withheld",
      resourceName:
        "stella://resource/legislation_document/id=history-version-withheld",
      versionValidFrom: null,
      versionValidTo: "2019-12-31",
      expressionKind: "consolidation",
      windowDisposition: "effective",
      windowDispositionBasis: null,
      status: "text_withheld",
      message: "The source does not permit displaying this wording.",
    },
  ],
  nextCursor: "history-next-page",
}) satisfies ProvisionHistoryFixture;

const STATUTE_PROVISIONS_FIXTURE = v.parse(READ_STATUTE_PROVISIONS_PROJECTION, {
  items: [
    {
      eli: "cz:act:2012:89",
      anchor: "par_1",
      url: null,
      documentId: "provision-version-found",
      resourceName:
        "stella://resource/legislation_document/id=provision-version-found",
      status: "found",
      nextTextCursor: null,
      text: "The full provision wording.",
      truncated: false,
      versionValidFrom: "2020-01-01",
      versionValidTo: "2020-12-31",
    },
    {
      eli: "cz:act:2012:89",
      anchor: "par_1",
      url: null,
      status: "text_withheld",
      message: "The source does not permit displaying this wording.",
    },
  ],
}) satisfies StatuteProvisionsFixture;

const appRoot = path.resolve(
  import.meta.dirname,
  "../../../../packages/mcp-apps/src",
);
const directories = [...new Bun.Glob("*/app.html").scanSync(appRoot)].map(
  (file) => path.dirname(file),
);

const observedFields = <T extends object>(
  value: T,
  read: (value: T) => unknown,
): Set<string> => {
  const fields = new Set<string>();
  const observe = <Value extends object>(input: Value, prefix: string): Value =>
    new Proxy(input, {
      get: (target, key, receiver): unknown => {
        const entry = Reflect.get(target, key, receiver);
        if (
          typeof key !== "string" ||
          typeof entry === "function" ||
          (Array.isArray(target) && key === "length")
        ) {
          return entry;
        }
        const field = Array.isArray(target)
          ? `${prefix}[]`
          : `${prefix}${prefix === "" ? "" : "."}${key}`;
        if (typeof entry === "object" && entry !== null) {
          return observe(entry, field);
        }
        fields.add(field);
        return entry;
      },
    });
  read(observe(value, ""));
  return fields;
};

describe("MCP app registry and contracts", () => {
  test("every app declares its links and call class", () => {
    expect(
      inspectAppManifest({
        apps: MCP_APPS,
        tools: DEFAULT_MCP_TOOL_DEFINITIONS,
        directories,
      }),
    ).toEqual([]);
  });
  test("citation graph links its read tool and declares both read contracts", () => {
    expect(CITATION_GRAPH_APP.linkedTools).toEqual(["read_case_law_citations"]);
    expect(CITATION_GRAPH_APP.callableTools).toEqual([
      MCP_WEB_HANDOFF_TOOL_NAME,
      "read_case_law_citations",
      "open_case_law_decision",
    ]);
    expect(MCP_APP_OUTPUT_SCHEMAS).toHaveProperty("read_case_law_citations");
  });
  test("the guard refuses a model-visible write call in a presentation app", () => {
    const apps = MCP_APPS.map((app) =>
      app.type === "presentation"
        ? { ...app, callableTools: ["write_capability"] }
        : app,
    );
    expect(
      inspectAppManifest({
        apps,
        tools: DEFAULT_MCP_TOOL_DEFINITIONS,
        directories,
      }),
    ).toContain(
      "Presentation apps cannot call model-visible write tools: write_capability",
    );
  });
  test("the guard refuses an app with no call class", () => {
    expect(
      inspectAppManifest({
        apps: [
          ...MCP_APPS,
          {
            directory: "unclassified",
            uri: "ui://stella/unclassified",
            linkedTools: [],
            callableTools: [],
          },
        ],
        tools: DEFAULT_MCP_TOOL_DEFINITIONS,
        directories: [...directories, "unclassified"],
      }),
    ).toEqual(["Every app requires a declared call class and tool policy"]);
  });
  test("the mutation-app set cannot grow", () => {
    const extra = {
      ...MCP_APPS[0],
      uri: "ui://stella/extra",
      directory: "extra",
    };
    expect(
      inspectAppManifest({
        apps: [...MCP_APPS, extra],
        tools: DEFAULT_MCP_TOOL_DEFINITIONS,
        directories: [...directories, "extra"],
      }),
    ).toContain(
      "Only existing upload flows may be mutation apps: ui://stella/extra",
    );
  });
  test("all app SDK calls use declared boundaries", async () => {
    const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(appRoot)];
    const sources = Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          await Bun.file(path.join(appRoot, file)).text(),
        ]),
      ),
    );
    expect(inspectAppSources(sources)).toEqual([]);
    expect(
      inspectAppSources({
        "extra/app.ts":
          'import { App } from "@modelcontextprotocol/ext-apps"; new App().callServerTool({name:"write"});',
      }),
    ).toEqual([
      "App SDK import requires the shared bridge: extra/app.ts",
      "App calls require the shared bridge: extra/app.ts",
    ]);
    for (const source of [
      'export { App } from "@modelcontextprotocol/ext-apps";',
      'import("@modelcontextprotocol/ext-apps");',
      'require("@modelcontextprotocol/ext-apps");',
    ]) {
      expect(inspectAppSources({ "extra/app.ts": source })).toEqual([
        "App SDK import requires the shared bridge: extra/app.ts",
      ]);
    }
  });
  test("browser apps reject server imports, including type-only edges", () => {
    for (const module of [
      "../../../apps/api/src/mcp/static-tool-definitions",
      "@/api/mcp/context",
      "@stll/api",
      "@stll/api/mcp/context",
      "../../../apps/api/src/db/long-running-connection",
      "@/api/handlers/case-law/decisions/get",
    ]) {
      for (const source of [
        `import type { Tool } from "${module}";`,
        `export type { Tool } from "${module}";`,
        `type Tool = import("${module}").Tool;`,
        `import("${module}");`,
        `require("${module}");`,
      ]) {
        expect(inspectAppSources({ "manifest.ts": source })).toEqual([
          "Server modules must stay outside browser apps: manifest.ts",
        ]);
      }
    }
  });
  test("browser ownership scans omit test and declaration surfaces", () => {
    const source =
      'import { App } from "@modelcontextprotocol/ext-apps"; new App().callServerTool({name:"write"});';
    for (const file of [
      "document-upload/runtime.test.tsx",
      "file-comparison/runtime.spec.ts",
      "tests/setup.ts",
      "setup-env.ts",
      "shared/generated/contracts.d.ts",
    ]) {
      expect(inspectAppSources({ [file]: source })).toEqual([]);
    }
  });
  test("SDK owners also reject server imports", () => {
    for (const file of [
      "shared/bridge.ts",
      "document-upload/runtime.ts",
      "file-comparison/runtime.ts",
    ]) {
      expect(
        inspectAppSources({
          [file]:
            'import type { Tool } from "@/api/mcp/static-tool-definitions";',
        }),
      ).toEqual([`Server modules must stay outside browser apps: ${file}`]);
    }
  });
  test.each(["default", "documents", "anonymized", "law"] as const)(
    "app resources follow linked tool feature admission in %s",
    (mode: McpMode) => {
      for (const app of MCP_APPS) {
        for (const name of app.linkedTools) {
          expect(
            isMcpAppAvailable({
              uri: app.uri,
              mode,
              context: {
                testDependencies: {
                  featureAccessBindings: {
                    tools: new Map([[name, "fixture-hidden"]]),
                    resources: new Map(),
                    capabilities: new Map(),
                  },
                },
              },
            }),
          ).toBe(false);
        }
      }
    },
  );
  test("every presentation tool's browser schema is its advertised output snapshot", async () => {
    const actual: Record<string, unknown> = await Bun.file(
      path.join(appRoot, "shared/generated/schemas.json"),
    ).json();
    const expected = Object.fromEntries(
      Object.keys(MCP_APP_OUTPUT_SCHEMAS).map((name) => [
        name,
        getStaticMcpToolOutputContract(name)?.outputSchema,
      ]),
    );
    expect(Object.keys(actual).toSorted()).toEqual(
      [
        ...new Set(
          MCP_APPS.flatMap((app) =>
            app.type === "presentation" ? app.callableTools : [],
          ),
        ),
      ].toSorted(),
    );
    expect(inspectAppSchemas({ actual, expected })).toEqual([]);
    expect(
      inspectAppSchemas({
        actual: { ...actual, search_case_law: { type: "string" } },
        expected,
      }),
    ).toContain("App schema differs from tool output: search_case_law");
  });
  test("all shipped locales use the shared app catalog", async () => {
    const actual: unknown = await Bun.file(
      path.join(appRoot, "shared/generated/messages.json"),
    ).json();
    const expected = MCP_APP_MESSAGES;
    expect(Object.keys(expected).toSorted()).toEqual(
      [...UI_LOCALES].toSorted(),
    );
    expect(actual).toEqual(expected);
    for (const locale of ["cs", "en", "sk"] as const) {
      expect(Object.keys(expected[locale]).toSorted()).toEqual(
        Object.keys(expected.en).toSorted(),
      );
      expect(
        Object.values(expected[locale]).every((value) => value.trim() !== ""),
      ).toBe(true);
    }
  });
  test("static app copy comes from the shared catalog", async () => {
    const files = [...new Bun.Glob("**/*.html").scanSync(appRoot)];
    const sources = Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          await Bun.file(path.join(appRoot, file)).text(),
        ]),
      ),
    );
    expect(inspectAppHtmlSources(sources)).toEqual([]);
  });
  test("static copy guard rejects text nodes and accessible labels", () => {
    expect(
      inspectAppHtmlSources({
        "file-comparison/app.html":
          '<title>Compare two files</title><h1>Compare two files</h1><input aria-label="Original" placeholder="Choose file"><img alt="Preview"><button title="Upload">Upload for redline</button>',
      }),
    ).toEqual([
      "App HTML copy requires the shared catalog: file-comparison/app.html: Compare two files",
      "App HTML copy requires the shared catalog: file-comparison/app.html: Compare two files",
      "App HTML copy requires the shared catalog: file-comparison/app.html: Original",
      "App HTML copy requires the shared catalog: file-comparison/app.html: Choose file",
      "App HTML copy requires the shared catalog: file-comparison/app.html: Preview",
      "App HTML copy requires the shared catalog: file-comparison/app.html: Upload for redline",
      "App HTML copy requires the shared catalog: file-comparison/app.html: Upload",
    ]);
    expect(
      inspectAppHtmlSources({
        "shared/app.html":
          '<title>stella</title><style>body { color: red; }</style><script>const title = "Compare two files";</script><!-- Original --><div>…</div><button aria-label=""></button>',
      }),
    ).toEqual([]);
  });
  test("app consumed-field snapshots match the fields the view actually reads", () => {
    const search = new Set([
      ...observedFields(APP_SEARCH_FIXTURE, searchView),
      ...observedFields(APP_UNAVAILABLE_FIXTURE, searchView),
    ]);
    const resolution = new Set([
      ...APP_RESOLVE_STATUS_FIXTURES.flatMap((fixture) => [
        ...observedFields(fixture, resolveView),
      ]),
    ]);
    expect([...search].toSorted()).toEqual(
      [...MCP_APP_CONSUMED_FIELDS.search_case_law].toSorted(),
    );
    expect([...resolution].toSorted()).toEqual(
      [...MCP_APP_CONSUMED_FIELDS.resolve_case_law_decision].toSorted(),
    );
    const view = searchView(APP_SEARCH_FIXTURE);
    expect(view).not.toHaveProperty("total");
    if (view.type !== "search") {
      throw new Error("Expected search view");
    }
    expect(view.results.at(0)).not.toHaveProperty("citationAuthority");
    expect(view.results.at(0)).not.toHaveProperty("appUrl");
    expect(resolveView(APP_RESOLVE_FIXTURE)).not.toHaveProperty("resourceName");
  });
  test("publisher headnotes survive the MCP projection and absence is explicit", () => {
    const first = APP_SEARCH_FIXTURE.results.at(0);
    if (first === undefined) {
      throw new Error("Missing search fixture");
    }
    for (const headnote of [first.headnote, null]) {
      const parsed = v.parse(MCP_APP_OUTPUT_SCHEMAS.search_case_law, {
        ...APP_SEARCH_FIXTURE,
        results: [{ ...first, headnote }],
      });
      if (!("results" in parsed)) {
        throw new Error("Expected projected search results");
      }
      expect(parsed.results.at(0)?.headnote).toEqual(headnote);
      expect(parsed.results.at(0)?.keywords).toEqual(first.keywords);
      const serialized = serializeToolResult(
        untypedToolDataResult(parsed),
        getStaticMcpToolOutputContract("search_case_law"),
      );
      expect(serialized.structuredContent).toEqual(parsed);
      const view = searchView(parsed);
      if (view.type !== "search") {
        throw new Error("Expected search view");
      }
      expect(view.results.at(0)?.headnote).toEqual(
        headnote ?? { type: "not_stated" },
      );
    }
    const absent = searchView({
      ...APP_SEARCH_FIXTURE,
      results: [{ ...first, headnote: null, keywords: null }],
    });
    if (absent.type !== "search") {
      throw new Error("Expected search view");
    }
    expect(absent.results.at(0)?.keywords).toBeNull();
    const resolution = resolveView(APP_RESOLVE_FIXTURE);
    if (resolution.status !== "resolved") {
      throw new Error("Expected resolve view");
    }
    expect(resolution.rows).not.toHaveLength(0);
    for (const row of resolution.rows) {
      expect(row).toMatchObject({ type: "resolve", snippet: null });
    }
  });
  test.each([
    { availability: "included" as const, expected: "not_stated" },
    { availability: "omitted" as const, expected: "omitted" },
  ])(
    "null headnotes preserve the page's presentation state ($availability)",
    ({ availability, expected }) => {
      const first = APP_SEARCH_FIXTURE.results.at(0);
      if (first === undefined) {
        throw new Error("Missing search fixture");
      }
      const page = {
        ...APP_SEARCH_FIXTURE,
        headnotes: availability,
        results: [{ ...first, headnote: null }],
      };
      expect(page.results.at(0)?.headnote).toBeNull();
      const view = searchView(page);
      if (view.type !== "search") {
        throw new Error("Expected search view");
      }
      expect(view.results).toHaveLength(1);
      expect(view.results.at(0)?.headnote).toEqual({ type: expected });
      expect(view.results.at(0)?.url).toBe(first.url);
    },
  );
  test("decision actions use only HTTP links from their own contract fields", () => {
    const first = APP_SEARCH_FIXTURE.results.at(0);
    if (first === undefined) {
      throw new Error("Missing search fixture");
    }
    for (const scheme of ["javascript", "data", "file", "ftp"]) {
      const view = searchView({
        ...APP_SEARCH_FIXTURE,
        results: [
          {
            ...first,
            url: `${scheme}:invalid`,
            source_url: `${scheme}:invalid`,
          },
        ],
      });
      if (view.type !== "search") {
        throw new Error("Expected search view");
      }
      expect(view.results.at(0)?.url).toBeNull();
      expect(view.results.at(0)?.source_url).toBeUndefined();
    }
    const view = searchView({
      ...APP_SEARCH_FIXTURE,
      results: [
        {
          ...first,
          url: null,
          source_url: "http://example.org/original",
        },
      ],
    });
    if (view.type !== "search") {
      throw new Error("Expected search view");
    }
    expect(view.results.at(0)?.url).toBeNull();
    expect(view.results.at(0)?.source_url).toBe("http://example.org/original");
  });
  test("filter changes restart the search without discarding unrelated filters", () => {
    const expected = {
      queries: ["náhrada škody"],
      source_id: "source",
      limit: 10,
      country: "SVK",
      court: "court",
      date_from: "2024-01-01",
    };
    expect(
      searchFilterInput({
        input: {
          queries: ["náhrada škody"],
          country: "CZE",
          cursor: "old",
          courts: ["old court"],
          source_id: "source",
          limit: 10,
          date_to: "2023-01-01",
        },
        country: "SVK",
        court: { type: "court", name: "court" },
        from: "2024-01-01",
        to: "",
      }),
    ).toEqual(expected);
  });
  test("filter controls use the shared wire readers", () => {
    expect(
      filterDefaults({
        country: "SK",
        date_from: "2024",
        date_to: "2024",
        courts: "Najvyšší súd",
      }),
    ).toEqual({
      status: "ready",
      country: "SVK",
      from: "2024-01-01",
      to: "2024-12-31",
      courts: ["Najvyšší súd"],
      court: "",
    });
    expect(filterDefaults({ country: "CZE" })).toEqual({
      status: "ready",
      country: "CZE",
      from: "",
      to: "",
      courts: [],
      court: "",
    });
    expect(filterDefaults({ country: "ambiguous" }).status).toBe("invalid");
    expect(
      filterDefaults({ country: "CZE", date_from: "invalid" }).status,
    ).toBe("invalid");
    expect(filterDefaults({ country: "CZE", date_to: "invalid" }).status).toBe(
      "invalid",
    );
    expect(filterDefaults({ country: "CZE", courts: [1] }).status).toBe(
      "invalid",
    );
  });
  test("browser validation strips fields the app does not render", () => {
    const parse = createCaseLawParser();
    const view = parse(
      {
        ...APP_SEARCH_FIXTURE,
        total: "not consumed",
        results: APP_SEARCH_FIXTURE.results.map((row) => ({
          ...row,
          citationAuthority: "not consumed",
        })),
      },
      { country: "CZE" },
    );
    expect(view?.type).toBe("search");
    expect(view).not.toHaveProperty("total");
    expect(
      parse(
        {
          ...APP_SEARCH_FIXTURE,
          results: [{ ...APP_SEARCH_FIXTURE.results.at(0), court: 123 }],
        },
        {},
      ),
    ).toBeUndefined();
  });
  test("court and date sorts preserve the provider relevance order", () => {
    const view = searchView(APP_SEARCH_FIXTURE);
    if (view.type !== "search") {
      throw new Error("Expected fixture results");
    }
    const first = view.results.at(0);
    if (first === undefined) {
      throw new Error("Expected fixture row");
    }
    const rows = [
      { ...first, decisionId: "b", court: "Žilina", decisionDate: null },
      { ...first, decisionId: "a", court: "Brno", decisionDate: "2024-01-01" },
      { ...first, decisionId: "c", court: "Praha", decisionDate: "2025-01-01" },
    ];
    expect(sortResultRows(rows, "relevance", "cs")).toBe(rows);
    expect(
      sortResultRows(rows, "court", "cs").map(({ decisionId }) => decisionId),
    ).toEqual(["a", "c", "b"]);
    expect(
      sortResultRows(rows, "date", "cs").map(({ decisionId }) => decisionId),
    ).toEqual(["c", "a", "b"]);
    expect(rows.map(({ decisionId }) => decisionId)).toEqual(["b", "a", "c"]);
  });
  test("resolve text and structured content preserve the shared envelope", () => {
    const result = serializeToolResult(
      untypedToolDataResult(APP_RESOLVE_FIXTURE),
      getStaticMcpToolOutputContract("resolve_case_law_decision"),
      "resolve_case_law_decision",
    );
    expect(result.structuredContent).toEqual(APP_RESOLVE_FIXTURE);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(APP_RESOLVE_FIXTURE) },
    ]);
  });
  test("linking an app leaves text and structured content byte-identical", () => {
    for (const [name, fixtures] of [
      ["search_case_law", [APP_SEARCH_FIXTURE, APP_UNAVAILABLE_FIXTURE]],
      ["resolve_case_law_decision", APP_RESOLVE_STATUS_FIXTURES],
      ["read_provision_history", [PROVISION_HISTORY_FIXTURE]],
      ["read_statute_provisions", [STATUTE_PROVISIONS_FIXTURE]],
    ] as const) {
      for (const fixture of fixtures) {
        const result = serializeToolResult(
          untypedToolDataResult(fixture),
          getStaticMcpToolOutputContract(name),
          name,
        );
        expect(result).toEqual({
          content: [{ type: "text", text: JSON.stringify(fixture) }],
          structuredContent: fixture,
        });
        expect(JSON.stringify(result.structuredContent)).toBe(
          JSON.stringify(fixture),
        );
      }
    }
    const empty = {
      headnotes: "included",
      facets: null,
      nextCursor: null,
      searches: [],
      results: [],
      total: { type: "not_counted" },
    };
    expect(
      serializeToolResult(
        untypedToolDataResult(empty),
        getStaticMcpToolOutputContract("search_case_law"),
      ),
    ).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "{"headnotes":"included","facets":null,"nextCursor":null,"searches":[],"results":[],"total":{"type":"not_counted"}}",
            "type": "text",
          },
        ],
        "structuredContent": {
          "facets": null,
          "headnotes": "included",
          "nextCursor": null,
          "results": [],
          "searches": [],
          "total": {
            "type": "not_counted",
          },
        },
      }
    `);
    expect(CASE_LAW_RESULTS_APP.linkedTools).toEqual([
      "search_case_law",
      "resolve_case_law_decision",
    ]);
  });
});
