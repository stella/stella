import { toolDefinition } from "@tanstack/ai";
import { panic } from "better-result";

import { BROWSER_CONTROL_TOOL_NAME } from "@stll/api-contract/browser-control";
import {
  browserControlCommandJsonSchema,
  browserControlResultJsonSchema,
} from "@stll/api-contract/browser-control-json-schema";

import { executeBrowserExtensionCommand } from "./browser-extension-bridge";
import { createBrowserToolExecutionCache } from "./browser-tool-execution";

export const createBrowserClientTool = () => {
  const executions = createBrowserToolExecutionCache(
    executeBrowserExtensionCommand,
  );

  return toolDefinition({
    name: BROWSER_CONTROL_TOOL_NAME,
    description: "Execute an approved command in the stella Chrome extension.",
    inputSchema: browserControlCommandJsonSchema,
    outputSchema: browserControlResultJsonSchema,
    needsApproval: true,
  }).client(async (input, executionContext) => {
    const toolCallId = executionContext?.toolCallId;
    if (toolCallId === undefined) {
      return panic("Browser client tool execution omitted its tool-call id");
    }
    return await executions.executeOnce(toolCallId, input);
  });
};
