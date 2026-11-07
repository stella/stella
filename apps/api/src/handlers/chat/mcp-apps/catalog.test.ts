import { expect, test } from "bun:test";

import { MCP_WEB_HANDOFF_TOOL_NAME } from "@stll/api-contract/mcp-web-handoff";

import { isRegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";

import { CHAT_MCP_APPS, chatMcpAppForTool } from "./catalog";

// The app routes are gated on the public corpus; an app that presented or
// called anything else would be served where its tools are not.
test("every chat app presents and calls public-law reads only", () => {
  expect(CHAT_MCP_APPS.length).toBeGreaterThan(0);
  for (const app of CHAT_MCP_APPS) {
    for (const name of [...app.linkedTools, ...app.callableTools]) {
      if (name === MCP_WEB_HANDOFF_TOOL_NAME) {
        continue;
      }
      const definition = getStaticMcpToolDefinition(name);
      expect({ name, access: definition?.access }).toEqual({
        name,
        access: "read",
      });
      expect({ name, feature: definition?.feature }).toEqual({
        name,
        feature: "FEATURE_PUBLIC_LAW",
      });
      expect({ name, read: isRegistryReadToolName(name) }).toEqual({
        name,
        read: true,
      });
    }
  }
});

test("each presented tool names the app it links", () => {
  for (const app of CHAT_MCP_APPS) {
    for (const name of app.linkedTools) {
      expect(chatMcpAppForTool(name)?.uri).toBe(app.uri);
      const ui = getStaticMcpToolDefinition(name)?._meta?.["ui"];
      expect({ name, ui }).toMatchObject({
        name,
        ui: { resourceUri: app.uri },
      });
    }
  }
});
