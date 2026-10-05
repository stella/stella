import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";

import { parseCatalog } from "@/api/mcp/capability-tools";
import { encodeCompatId } from "@/api/mcp/compat-ids";
import { compatFetchConsumesServices } from "@/api/mcp/compat-tools";
import { ALL_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";

const budgetedPublicReads = (
  tools: readonly Pick<
    McpToolDefinition,
    "name" | "readClass" | "consumesServices"
  >[],
) =>
  tools.filter((tool) => tool.readClass === "public" && tool.consumesServices);

const assertPublicReadsAreUnbudgeted = (
  tools: readonly Pick<
    McpToolDefinition,
    "name" | "readClass" | "consumesServices"
  >[],
) => {
  const violations = budgetedPublicReads(tools);
  if (violations.length > 0) {
    panic(
      `Public reads consume managed services: ${violations.map(({ name }) => name).join(", ")}`,
    );
  }
};

describe("public legal reads do not consume managed services", () => {
  test("every public read in every audience is unbudgeted", () => {
    const publicReads = ALL_MCP_TOOL_DEFINITIONS.filter(
      (tool) => tool.readClass === "public",
    );
    expect(publicReads.length).toBeGreaterThan(0);
    assertPublicReadsAreUnbudgeted(ALL_MCP_TOOL_DEFINITIONS);
  });

  test("every public capability alias retains data admission", () => {
    const aliases = parseCatalog(readCapabilityCatalog()).filter(
      (entry) =>
        entry.access === "read" &&
        entry.readClass === "public" &&
        entry.mcp.type !== "capability",
    );
    expect(aliases.length).toBeGreaterThan(0);
    for (const alias of aliases) {
      expect(alias.consumesServices).toBe(false);
    }
  });

  test("the census detects a wrongly classified public read", () => {
    const fixture = {
      name: "wrong_public_read",
      readClass: "public",
      consumesServices: true,
    } as const satisfies Pick<
      McpToolDefinition,
      "name" | "readClass" | "consumesServices"
    >;
    expect(() => assertPublicReadsAreUnbudgeted([fixture])).toThrow(
      "Public reads consume managed services: wrong_public_read",
    );
  });

  test("compat fetch classifies every public target as data", () => {
    for (const target of [
      { kind: "decision", decisionId: "11111111-1111-4111-8111-111111111111" },
      { kind: "statute", eli: "es/rd/2020/1" },
    ] as const) {
      expect(compatFetchConsumesServices({ id: encodeCompatId(target) })).toBe(
        false,
      );
    }
  });
});
