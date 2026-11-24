import { expect, test } from "bun:test";

import { closestToolNames } from "@/api/mcp/tool-utils";

test("bounds tool name suggestion work", () => {
  const candidates = Array.from(
    { length: 350 },
    (_, index) => `catalog.tool_${index}`,
  );
  expect(closestToolNames("x".repeat(10_000), candidates)).toEqual([]);
});
