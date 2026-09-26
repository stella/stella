import { toolDefinition } from "@tanstack/ai";
import { panic } from "better-result";

import { BROWSER_CONTROL_TOOL_NAME } from "@stll/api-contract/browser-control";
import {
  browserControlCommandJsonSchema,
  browserControlResultJsonSchema,
} from "@stll/api-contract/browser-control-json-schema";

import { beginBrowserCommand } from "./browser-approval-mode";
import { executeBrowserExtensionCommand } from "./browser-extension-bridge";
import { createBrowserToolExecutionCache } from "./browser-tool-execution";
import { createTurnStopper } from "./browser-turn";

type BrowserClientToolOptions = {
  /**
   * The chat turn a tool call belongs to, or the latest turn without one;
   * null before the thread has a user message. The extension budgets
   * commands per turn, and Stop ends a turn.
   */
  turnIdFor: (toolCallId?: string) => string | null;
};

export const createBrowserClientTool = ({
  turnIdFor,
}: BrowserClientToolOptions) => {
  // The outcome is tracked per web tab, not per chat runtime: every chat in
  // this tab drives the same controlled Chrome tab.
  const executions = createBrowserToolExecutionCache(
    executeBrowserExtensionCommand,
    beginBrowserCommand,
  );
  const stopper = createTurnStopper();

  const tool = toolDefinition({
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
    const turnId =
      turnIdFor(toolCallId) ??
      panic("A browser command ran in a thread without a user message");
    return await executions.executeOnce(toolCallId, input, {
      signal: stopper.signalFor(turnId),
      turnId,
    });
  });

  return {
    /**
     * Stops the latest turn's browser commands: the extension is told to
     * stop, a running command ends at once, and no command of that turn runs
     * afterwards, even one already approved.
     */
    cancel(): void {
      const turnId = turnIdFor();
      if (turnId !== null) {
        stopper.stop(turnId);
      }
    },
    tool,
  };
};
