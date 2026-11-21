import { expect, test } from "bun:test";

import { localMcpClientHeaders } from "./local-client-identity";

test("local MCP requests carry the shared client identity", () => {
  expect([...localMcpClientHeaders("1.2.3").values()]).toEqual([
    "mcp-kit/1.2.3",
  ]);
});
