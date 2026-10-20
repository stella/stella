import { expect, test } from "bun:test";

import { LOCAL_CLIENT_IDENTITY_HEADER } from "@stll/api-contract/local-client-identity";

import { localMcpClientHeaders } from "./local-client-identity";

test("local MCP requests carry the shared client identity", () => {
  expect(localMcpClientHeaders("1.2.3").get(LOCAL_CLIENT_IDENTITY_HEADER)).toBe(
    "mcp-kit/1.2.3",
  );
});
