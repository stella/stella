import { describe, expect, test } from "bun:test";

import { MCP_MODES } from "@/api/mcp/constants";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";

const ALWAYS_LOAD_KEY = "anthropic/alwaysLoad";
const ALWAYS_LOADED = ["fetch", "search"];

/**
 * Claude Code defers every MCP tool behind its tool search unless the tool's
 * `_meta` asks to load. Only the OpenAI-compatible pair asks; a tool that
 * joined it would put its whole definition in every turn's context.
 */
describe.each(MCP_MODES.map((mode) => ({ mode })))(
  "the $mode listing",
  ({ mode }) => {
    const tools = toMcpTools(listStaticMcpToolDefinitions(mode), { mode });

    test("asks Claude Code to load only search and fetch up front", () => {
      const loaded = tools
        .filter((tool) => tool._meta?.[ALWAYS_LOAD_KEY] !== undefined)
        .map((tool) => ({
          name: tool.name,
          value: tool._meta?.[ALWAYS_LOAD_KEY],
        }))
        // Tool names are ASCII identifiers; code-unit order is the order.
        .toSorted((left, right) => (left.name < right.name ? -1 : 1));
      const listedPair = ALWAYS_LOADED.filter((name) =>
        tools.some((tool) => tool.name === name),
      );
      expect(loaded).toEqual(listedPair.map((name) => ({ name, value: true })));
    });

    test("serves no other Anthropic host key", () => {
      const keys = tools.flatMap((tool) =>
        Object.keys(tool._meta ?? {})
          .filter((key) => key.startsWith("anthropic/"))
          .map((key) => `${tool.name}:${key}`),
      );
      expect(keys.toSorted()).toEqual(
        tools
          .filter((tool) => ALWAYS_LOADED.includes(tool.name))
          .map((tool) => `${tool.name}:${ALWAYS_LOAD_KEY}`)
          .toSorted(),
      );
    });
  },
);

// Agent runs connect to the default listing; the per-mode checks above would
// pass vacuously if the pair ever left it.
test("the default listing carries the pair", () => {
  const names = toMcpTools(listStaticMcpToolDefinitions("default")).map(
    (tool) => tool.name,
  );
  expect(names).toEqual(expect.arrayContaining(ALWAYS_LOADED));
});
