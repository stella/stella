import { describe, expect, test } from "bun:test";
import path from "node:path";

import { UI_LOCALES } from "@stll/locales";

import { buildMcpAppMessages } from "../../scripts/lib/mcp-app-catalog";
import { MCP_APP_CONSUMED_FIELDS } from "./app-consumed-fields";
import { MCP_APP_OUTPUT_SCHEMAS } from "./app-contracts";
import {
  APP_LOOKUP_FIXTURE,
  APP_SEARCH_FIXTURE,
  APP_UNAVAILABLE_FIXTURE,
} from "./app-fixtures";
import { inspectAppManifest, inspectAppSchemas } from "./app-guards";
import { isMcpAppAvailable } from "./app-policy";
import { inspectAppSources } from "./app-source-guard";
import {
  filterDefaults,
  lookupView,
  searchFilterInput,
  searchView,
} from "./apps/case-law-results/model";
import { CASE_LAW_RESULTS_APP, MCP_APPS } from "./apps/manifest";
import type { LookupResults, SearchResults } from "./apps/shared/contracts";
import type { McpMode } from "./constants";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolOutputContract,
} from "./static-tool-definitions";
import { serializeToolResult, toolDataResult } from "./tool-utils";

APP_SEARCH_FIXTURE satisfies SearchResults;
APP_LOOKUP_FIXTURE satisfies LookupResults;
APP_UNAVAILABLE_FIXTURE satisfies SearchResults & LookupResults;

const appRoot = path.resolve(import.meta.dirname, "apps");
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
  test("the guard refuses a write call in a presentation app", () => {
    const apps = MCP_APPS.map((app) =>
      app.type === "presentation"
        ? { ...app, callableTools: ["invoke_capability"] }
        : app,
    );
    expect(
      inspectAppManifest({
        apps,
        tools: DEFAULT_MCP_TOOL_DEFINITIONS,
        directories,
      }),
    ).toContain("Presentation apps require read-only tools: invoke_capability");
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
            app.type === "presentation" ? app.linkedTools : [],
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
  test("all shipped locales use the product catalog projection", async () => {
    const actual: unknown = await Bun.file(
      path.join(appRoot, "shared/generated/messages.json"),
    ).json();
    const expected = await buildMcpAppMessages();
    expect(Object.keys(expected).toSorted()).toEqual(
      [...UI_LOCALES].toSorted(),
    );
    expect(actual).toEqual(expected);
  });
  test("app consumed-field snapshots match the fields the view actually reads", () => {
    const search = new Set([
      ...observedFields(APP_SEARCH_FIXTURE, searchView),
      ...observedFields(APP_UNAVAILABLE_FIXTURE, searchView),
    ]);
    const lookup = new Set([
      ...observedFields(APP_LOOKUP_FIXTURE, lookupView),
      ...observedFields(APP_UNAVAILABLE_FIXTURE, lookupView),
    ]);
    expect([...search].toSorted()).toEqual(
      [...MCP_APP_CONSUMED_FIELDS.search_case_law].toSorted(),
    );
    expect([...lookup].toSorted()).toEqual(
      [...MCP_APP_CONSUMED_FIELDS.lookup_case_law].toSorted(),
    );
    const view = searchView(APP_SEARCH_FIXTURE);
    expect(view).not.toHaveProperty("total");
    if (view.type !== "search") {
      throw new Error("Expected search view");
    }
    expect(view.results.at(0)).not.toHaveProperty("citationAuthority");
    expect(lookupView(APP_LOOKUP_FIXTURE)).not.toHaveProperty("resourceName");
  });
  test("filter changes restart the search without discarding unrelated filters", () => {
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
    ).toEqual({
      queries: ["náhrada škody"],
      source_id: "source",
      limit: 10,
      country: "SVK",
      court: "court",
      date_from: "2024-01-01",
    });
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
  test("linking an app leaves text and structured content byte-identical", () => {
    for (const [name, fixtures] of [
      ["search_case_law", [APP_SEARCH_FIXTURE, APP_UNAVAILABLE_FIXTURE]],
      ["lookup_case_law", [APP_LOOKUP_FIXTURE, APP_UNAVAILABLE_FIXTURE]],
    ] as const) {
      for (const fixture of fixtures) {
        const result = serializeToolResult(
          toolDataResult(fixture),
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
      facets: null,
      nextCursor: null,
      searches: [],
      results: [],
      total: { type: "not_counted" },
    };
    expect(
      serializeToolResult(
        toolDataResult(empty),
        getStaticMcpToolOutputContract("search_case_law"),
      ),
    ).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "{"facets":null,"nextCursor":null,"searches":[],"results":[],"total":{"type":"not_counted"}}",
            "type": "text",
          },
        ],
        "structuredContent": {
          "facets": null,
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
      "lookup_case_law",
    ]);
  });
});
