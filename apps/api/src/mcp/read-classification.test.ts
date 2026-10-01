import { describe, expect, expectTypeOf, test } from "bun:test";

import catalog from "@stll/cli/capability-catalog.json";

import { resolveCapabilityReadClass } from "@/api/mcp/capability-tools";
import { encodeCompatId } from "@/api/mcp/compat-ids";
import { resolveCompatFetchReadClass } from "@/api/mcp/compat-tools";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import {
  resolveMcpReadClass,
  type McpToolAccessBranch,
} from "@/api/mcp/tool-types";

describe("MCP reads retain their canonical source classification", () => {
  test("a native read cannot omit its classification", () => {
    expectTypeOf<
      Extract<McpToolAccessBranch, { access: "read" }>
    >().toHaveProperty("readClass");
    expectTypeOf<{ access: "read" }>().not.toMatchTypeOf<
      Pick<Extract<McpToolAccessBranch, { access: "read" }>, "readClass">
    >();
  });

  test("every generated read target carries its declared classification", () => {
    for (const entry of catalog) {
      expect(resolveCapabilityReadClass({ capability: entry.id })).toBe(
        entry.access === "read" ? entry.readClass : undefined,
      );
      if (entry.access === "read") {
        expect(["tenant", "public", "both"]).toContain(entry.readClass);
      }
    }
    expect(
      resolveCapabilityReadClass({ capability: "unknown.capability" }),
    ).toBeUndefined();
  });

  test("compat fetch reads the same identifier vocabulary as dispatch", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(
      resolveCompatFetchReadClass({
        id: encodeCompatId({ kind: "document", entityId: id }),
      }),
    ).toBe("tenant");
    expect(
      resolveCompatFetchReadClass({
        id: encodeCompatId({ kind: "decision", decisionId: id }),
      }),
    ).toBe("public");
    expect(
      resolveCompatFetchReadClass({
        id: encodeCompatId({ kind: "statute", eli: "es/rd/2020/1" }),
      }),
    ).toBe("public");
    expect(resolveCompatFetchReadClass({ id: "invalid" })).toBeUndefined();
  });

  test("capability aliases retain their native read source", async () => {
    const native = new Map(
      listStaticMcpToolDefinitions().map((tool) => [tool.name, tool]),
    );
    for (const entry of catalog) {
      if (entry.access !== "read" || entry.mcp.type === "capability") {
        continue;
      }
      const name = entry.mcp.type === "tool" ? entry.mcp.name : entry.mcp.by;
      const definition = native.get(name);
      if (definition?.access !== "read") {
        continue;
      }
      expect(resolveCapabilityReadClass({ capability: entry.id })).toBe(
        await resolveMcpReadClass(definition, {}),
      );
    }
    expect(
      resolveCapabilityReadClass({ capability: "case-law.matter-links.list" }),
    ).toBe("both");
  });

  test("mixed search charges both source classes on each tenant surface", async () => {
    for (const mode of ["default", "anonymized", "law"] as const) {
      const search = listStaticMcpToolDefinitions(mode).find(
        ({ name }) => name === "search",
      );
      expect(search).toBeDefined();
      if (search === undefined) {
        throw new Error("Missing compat search definition");
      }
      expect(await resolveMcpReadClass(search, { query: "synthetic" })).toBe(
        mode === "law" ? "public" : "both",
      );
    }
  });
});
