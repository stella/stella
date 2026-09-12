import { describe, expect, test } from "bun:test";

import { BROWSER_CONTROL_TOOL_NAME } from "@stll/api-contract/browser-control";

import { createBrowserClientTool } from "./browser-client-tool";

describe("chat browser client tool", () => {
  test("registers the approved browser command as a native client tool", () => {
    const tool = createBrowserClientTool();

    expect(tool).toMatchObject({
      __toolSide: "client",
      name: BROWSER_CONTROL_TOOL_NAME,
      needsApproval: true,
    });
    expect(tool.execute).toBeFunction();
  });
});
