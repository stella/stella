import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { APP_SEARCH_FIXTURE } from "@stll/api-contract/mcp-app.fixtures";

import { SEARCH_CASE_LAW_PROJECTION } from "@/api/lib/chat/case-law-result-projections";
import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { isRecord } from "@/api/lib/type-guards";
import { MCP_MODES } from "@/api/mcp/constants";
import {
  resolveMcpToolOutputContract,
  toMcpTools,
} from "@/api/mcp/gateway/list-tools";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import { compileClientWireSchema } from "@/api/tests/helpers/wire-json-schema";

// The validator the official client compiles each advertised output schema
// with before it accepts a `tools/call` result.
const clientValidator = new AjvJsonSchemaValidator();

type SearchFixture = typeof APP_SEARCH_FIXTURE;

/**
 * Results a later deploy could return. A client keeps the listing it fetched
 * for its whole session, so a listing taken before the deploy must accept
 * each of them.
 */
const LATER_RESULTS = {
  "a field added to each hit": {
    change: (output: SearchFixture): Record<string, unknown> => ({
      ...output,
      results: output.results.map((result) => ({
        ...result,
        addedLater: { query: 0, matched: ["a"], missing: [] },
      })),
    }),
    closedError: "data/results/0 must NOT have additional properties",
  },
  "a value added to a hit's value list": {
    change: (output: SearchFixture): Record<string, unknown> => ({
      ...output,
      results: output.results.map((result) => ({
        ...result,
        match: "added_later",
      })),
    }),
    closedError:
      "data/results/0/match must be equal to one of the allowed values",
  },
} as const;

/** The listing as the converter emits it, with every object and list closed. */
const closedSearchListing = () => {
  const closed: unknown = toJsonSchema(SEARCH_CASE_LAW_PROJECTION, {
    errorMode: "ignore",
    target: "draft-07",
    typeMode: "input",
  });
  if (!isRecord(closed)) {
    return panic("The search_case_law projection converts to a schema object");
  }
  return compileClientWireSchema(clientValidator, closed);
};

/**
 * JSON pointers of every schema node that rejects a key or a value it does
 * not name: a closed object or a closed value list.
 */
const closedNodePaths = (schema: unknown, path = ""): string[] => {
  if (Array.isArray(schema)) {
    return schema.flatMap((nested: unknown, index) =>
      closedNodePaths(nested, `${path}/${String(index)}`),
    );
  }
  if (!isRecord(schema)) {
    return [];
  }
  return Object.entries(schema).flatMap(([key, value]) => {
    if (key === "additionalProperties" && value === false) {
      return [`${path}/additionalProperties`];
    }
    if (key === "enum") {
      return [`${path}/enum`];
    }
    if (key === "required" || key === "examples") {
      return [];
    }
    return closedNodePaths(value, `${path}/${key}`);
  });
};

describe("advertised output schemas survive a deploy that widens a result", () => {
  test.each(Object.entries(LATER_RESULTS))(
    "a search_case_law listing accepts a result with %s",
    (_name, { change, closedError }) => {
      const listed = resolveMcpToolOutputContract(
        "search_case_law",
        "default",
      )?.outputSchema;
      if (listed === undefined) {
        panic("search_case_law advertises no output schema");
      }
      const output = v.parse(SEARCH_CASE_LAW_PROJECTION, APP_SEARCH_FIXTURE);
      expect(output).toEqual(APP_SEARCH_FIXTURE);
      const later = change(APP_SEARCH_FIXTURE);

      // The fixture reaches the fault: a closed listing rejects the later
      // result exactly as a client holding a pre-deploy listing did, and the
      // executable source the server parses through stays exact.
      const closed = closedSearchListing()(later);
      expect(closed.valid).toBe(false);
      expect(closed.errorMessage).toContain(closedError);
      expect(v.safeParse(SEARCH_CASE_LAW_PROJECTION, later).success).toBe(
        false,
      );

      const advertised = compileClientWireSchema(clientValidator, listed);
      expect(advertised(output).valid).toBe(true);
      expect(advertised(later)).toEqual({
        valid: true,
        data: later,
        errorMessage: undefined,
      });
    },
  );

  test("no tool in any mode advertises an output object or value list closed to additions", () => {
    const census: string[] = [];
    const closed: string[] = [];
    for (const mode of MCP_MODES) {
      for (const tool of toMcpTools(listStaticMcpToolDefinitions(mode), {
        mode,
      })) {
        if (tool.outputSchema === undefined) {
          continue;
        }
        census.push(`${mode}/${tool.name}`);
        closed.push(
          ...closedNodePaths(tool.outputSchema).map(
            (path) => `${mode}/${tool.name}${path}`,
          ),
        );
      }
    }
    expect(census).toContain("default/search_case_law");
    expect(census).toContain("law/search");
    expect(
      closed,
      "A closed output object or value list turns each field or value a deploy adds into a rejected call for every session listed before it. Derive the schema with deriveMcpOutputSchema, which keeps both open.",
    ).toEqual([]);
  });
});
