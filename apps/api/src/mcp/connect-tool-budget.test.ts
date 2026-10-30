import { describe, expect, test } from "bun:test";

import {
  CONNECT_WEIGHT_ESTIMATOR,
  connectToolWeights,
  measureConnectTool,
} from "@/api/mcp/connect-tool-weights";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

import committedWeights from "../../mcp-connect-tool-weights.json" with { type: "json" };

// Starts at today's total so it only blocks growth; lower it as tools shrink.
const TOTAL_CONNECT_CHAR_BUDGET = 127_472;
const PER_TOOL_CONNECT_CHAR_CAP = 7000;

describe("MCP connect-time tool budget", () => {
  const current = connectToolWeights(DEFAULT_MCP_TOOL_DEFINITIONS);

  test("committed per-tool weights match the registry", () => {
    expect(committedWeights).toEqual(current);
  });

  test("the registry stays within total and per-tool connect budgets", () => {
    expect(
      current.totals.characters,
      `Connect-time definitions use ${String(current.totals.characters)} characters; budget is ${String(TOTAL_CONNECT_CHAR_BUDGET)}`,
    ).toBeLessThanOrEqual(TOTAL_CONNECT_CHAR_BUDGET);

    for (const tool of current.tools) {
      expect(
        tool.totalChars,
        `${tool.name} uses ${String(tool.totalChars)} connect-time characters; cap is ${String(PER_TOOL_CONNECT_CHAR_CAP)}`,
      ).toBeLessThanOrEqual(PER_TOOL_CONNECT_CHAR_CAP);
    }
  });

  test("the estimator counts prose and schema JSON at their own rates", () => {
    expect(
      measureConnectTool({
        name: "abc",
        description: "defghi",
        inputSchema: { a: 1 },
      }),
    ).toEqual({
      name: "abc",
      nameChars: 3,
      descriptionChars: 6,
      inputSchemaChars: 7,
      totalChars: 16,
      // ceil(9 / 3 + 7 / 2.4) = ceil(5.916...)
      estimatedTokens: 6,
    });
    expect(CONNECT_WEIGHT_ESTIMATOR.proseCharactersPerToken).toBe(3);
  });
});
