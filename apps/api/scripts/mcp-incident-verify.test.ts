import { describe, expect, test } from "bun:test";

import { classifyMcpIncident } from "./mcp-incident-verify";

const name = "search_case_law";
const beforeDeploy = {
  name,
  outputSchema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
  },
};
const afterDeploy = {
  name,
  outputSchema: {
    ...beforeDeploy.outputSchema,
    properties: {
      results: {
        ...beforeDeploy.outputSchema.properties.results,
        items: {
          ...beforeDeploy.outputSchema.properties.results.items,
          properties: {
            id: { type: "string" },
            terms: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

const stale = {
  type: "available",
  source: "saved tools/list",
  tools: [{ name: "unrelated_tool" }, beforeDeploy],
} as const;
const matchingFresh = {
  type: "returned" as const,
  tool: afterDeploy,
  result: {
    content: [],
    structuredContent: { results: [{ id: "decision-1", terms: ["test"] }] },
  },
};

describe("MCP incident classification", () => {
  test("identifies a stale-only rejection when the fresh schema accepts a new field", () => {
    expect(classifyMcpIncident(matchingFresh, stale)).toEqual({
      label: "STALE SESSIONS ONLY",
      exitCode: 2,
      fresh: "structuredContent matches outputSchema",
      stale:
        "saved tools/list · structuredContent violates outputSchema (additionalProperties)",
    });
  });

  test("identifies a failure under the schema advertised by a fresh session", () => {
    expect(
      classifyMcpIncident(
        {
          ...matchingFresh,
          result: {
            content: [],
            structuredContent: { results: [{ id: 123 }] },
          },
        },
        stale,
      ),
    ).toMatchObject({
      label: "ALL CLIENTS BROKEN",
      exitCode: 1,
      fresh: "structuredContent violates outputSchema (type)",
    });
  });

  test("an advertised output schema requires structuredContent", () => {
    expect(
      classifyMcpIncident({ ...matchingFresh, result: { content: [] } }, stale),
    ).toMatchObject({
      label: "ALL CLIENTS BROKEN",
      exitCode: 1,
      fresh: "structuredContent is missing",
    });
  });

  test("reports no reproduction when both lists accept the result", () => {
    expect(
      classifyMcpIncident(
        {
          ...matchingFresh,
          result: {
            content: [],
            structuredContent: { results: [{ id: "decision-1" }] },
          },
        },
        stale,
      ),
    ).toEqual({
      label: "NOT REPRODUCED",
      exitCode: 0,
      fresh: "structuredContent matches outputSchema",
      stale: "saved tools/list · structuredContent matches outputSchema",
    });
  });

  test("reports a tool error before attempting schema validation", () => {
    expect(
      classifyMcpIncident(
        { ...matchingFresh, result: { content: [], isError: true } },
        stale,
      ),
    ).toMatchObject({
      label: "SERVER ERROR",
      exitCode: 3,
      fresh: "tools/call returned isError",
    });
  });

  test("includes the reason when no historical schema is available", () => {
    expect(
      classifyMcpIncident(matchingFresh, {
        type: "unavailable",
        detail: "no local prior stable registry snapshot",
      }),
    ).toMatchObject({
      label: "NOT REPRODUCED",
      exitCode: 0,
      stale: "no local prior stable registry snapshot",
    });
  });

  test("distinguishes an undiscoverable tool from a tools/call transport error", () => {
    expect(classifyMcpIncident({ type: "not_listed" }, stale)).toMatchObject({
      label: "ALL CLIENTS BROKEN",
      exitCode: 1,
    });
    expect(
      classifyMcpIncident(
        { type: "server_error", detail: "tools/call HTTP 503" },
        stale,
      ),
    ).toMatchObject({
      label: "SERVER ERROR",
      exitCode: 3,
      fresh: "tools/call HTTP 503",
    });
  });
});
