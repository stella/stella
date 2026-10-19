import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("keeps static tool invocation at its owner", async () => {
  expect(
    await lintSingleRule(
      "no-raw-mcp-tool-handler-import",
      'import { MATTER_TOOL_HANDLERS } from "@/api/mcp/matter-tools";',
      { sourcePath: "apps/api/src/example.ts" },
    ),
  ).toEqual([1]);

  expect(
    await lintSingleRule(
      "no-raw-mcp-tool-handler-import",
      'import { invokeStaticMcpTool } from "@/api/mcp/static-tool-definitions";',
      { sourcePath: "apps/api/src/example.ts" },
    ),
  ).toEqual([]);
});
