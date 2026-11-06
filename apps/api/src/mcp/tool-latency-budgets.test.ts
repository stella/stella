import { describe, expect, test } from "bun:test";

import { MCP_STATIC_TOOL_NAMES } from "@/api/mcp/static-tool-names";
import {
  judgeMcpToolLatency,
  MCP_TOOL_LATENCY_BUDGET_OVERRIDES,
  MCP_TOOL_LATENCY_DEFAULT_BUDGET_MS,
  mcpToolLatencyBudgetMs,
} from "@/api/mcp/tool-latency-budgets";

/**
 * Calibration: the slowest healthy deployed calls of each kind, from the
 * `mcp.request.phases` records (total, ms). Budgets must hold them with room
 * to spare, or the canary fails a healthy deployment.
 */
const HEALTHY_SLOWEST_CALLS = [
  { toolName: "read_case_law_decision", elapsedMs: 507 },
  { toolName: "read_statute", elapsedMs: 626 },
  { toolName: "read_statute_provisions", elapsedMs: 576 },
  { toolName: "read_provision_history", elapsedMs: 357 },
  { toolName: "resolve_case_law_decision", elapsedMs: 344 },
  { toolName: "save_task", elapsedMs: 562 },
  { toolName: "delete_task", elapsedMs: 164 },
  { toolName: "list_tasks", elapsedMs: 60 },
  { toolName: "search_across_matters", elapsedMs: 198 },
  { toolName: "lookup_business_registry", elapsedMs: 139 },
  // A healthy day's slowest case-law search.
  { toolName: "search_case_law", elapsedMs: 3260 },
] as const;

/** Margin a healthy call keeps under its budget. */
const HEALTHY_MARGIN = 2;

describe("MCP tool latency budgets", () => {
  test("holds the slowest healthy calls with margin", () => {
    expect(
      HEALTHY_SLOWEST_CALLS.filter(
        ({ toolName, elapsedMs }) =>
          elapsedMs * HEALTHY_MARGIN > mcpToolLatencyBudgetMs(toolName),
      ),
    ).toEqual([]);
  });

  test("fails a search that waits out a ten-second dependency", () => {
    expect(
      judgeMcpToolLatency({
        toolName: "search_legislation",
        elapsedMs: 10_500,
      }),
    ).toEqual({
      toolName: "search_legislation",
      elapsedMs: 10_500,
      budgetMs: 8000,
      overBudget: true,
    });
    expect(
      judgeMcpToolLatency({ toolName: "case_law_coverage", elapsedMs: 3100 })
        .overBudget,
    ).toBe(true);
  });

  test("treats a call at its budget as within it", () => {
    expect(
      judgeMcpToolLatency({ toolName: "list_tasks", elapsedMs: 2000 })
        .overBudget,
    ).toBe(false);
    expect(
      judgeMcpToolLatency({ toolName: "list_tasks", elapsedMs: 2001 })
        .overBudget,
    ).toBe(true);
  });

  test("gives an unlisted or unknown tool the default", () => {
    expect(mcpToolLatencyBudgetMs("list_matters")).toBe(
      MCP_TOOL_LATENCY_DEFAULT_BUDGET_MS,
    );
    expect(mcpToolLatencyBudgetMs("unknown")).toBe(
      MCP_TOOL_LATENCY_DEFAULT_BUDGET_MS,
    );
    expect(mcpToolLatencyBudgetMs("toString")).toBe(
      MCP_TOOL_LATENCY_DEFAULT_BUDGET_MS,
    );
  });

  test("overrides only real tools, only upward, each with a reason", () => {
    const keys = new Set<string>([
      ...MCP_STATIC_TOOL_NAMES,
      "external_mcp",
      "skill",
      "unknown",
    ]);
    for (const [toolName, { budgetMs, reason }] of Object.entries(
      MCP_TOOL_LATENCY_BUDGET_OVERRIDES,
    )) {
      expect({ toolName, known: keys.has(toolName) }).toEqual({
        toolName,
        known: true,
      });
      expect(budgetMs).toBeGreaterThan(MCP_TOOL_LATENCY_DEFAULT_BUDGET_MS);
      expect(Number.isSafeInteger(budgetMs)).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
