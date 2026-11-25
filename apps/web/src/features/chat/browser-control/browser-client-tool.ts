import { toolDefinition } from "@tanstack/ai";
import { panic } from "better-result";

import { BROWSER_CONTROL_TOOL_NAME } from "@stll/api-contract/browser-control";
import {
  browserControlCommandJsonSchema,
  browserControlResultJsonSchema,
} from "@stll/api-contract/browser-control-json-schema";
import type { DesktopRunnerApprovalMode } from "@stll/api-contract/desktop-runner";

import {
  beginBrowserCommand,
  currentBrowserStepDecision,
  observeBrowserVisit,
} from "./browser-approval-state";
import { executeBrowserExtensionCommand } from "./browser-extension-bridge";
import { waitForBrowserSignIn } from "./browser-sign-in-handoff";
import { createBrowserToolExecutionCache } from "./browser-tool-execution";
import { createTurnStopper } from "./browser-turn";

type BrowserExtensionToolOptions = {
  /**
   * The chat turn a tool call belongs to, or the latest turn without one;
   * null before the thread has a user message. The extension budgets
   * commands per turn, and Stop ends a turn.
   */
  turnIdFor: (toolCallId?: string) => string | null;
  /**
   * The permission level of the turn a tool call belongs to, the one its
   * card answers by: a step the level refuses (Plan) is answered without
   * reaching the extension.
   */
  levelFor: (toolCallId: string) => DesktopRunnerApprovalMode;
  /** The chat's thread: the websites its commands reach are kept for it. */
  threadId: string;
};

/** Website approvals never lift a refusal or a sign-in, so none are read. */
const NO_GRANTS: ReadonlySet<string> = new Set();

export const createBrowserExtensionTool = ({
  levelFor,
  threadId,
  turnIdFor,
}: BrowserExtensionToolOptions) => {
  // The outcome is tracked per web tab, not per chat runtime: every chat in
  // this tab drives the same controlled Chrome tab. The websites a page was
  // reported from are kept for this chat.
  const executions = createBrowserToolExecutionCache(
    async (input, toolCallId, run) => {
      const result = await executeBrowserExtensionCommand(
        input,
        toolCallId,
        run,
      );
      observeBrowserVisit(threadId, result);
      return result;
    },
    beginBrowserCommand,
    (command, toolCallId) =>
      currentBrowserStepDecision({
        command,
        grantedOrigins: NO_GRANTS,
        level: levelFor(toolCallId),
        threadId,
      }),
    waitForBrowserSignIn,
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
    /**
     * Lets the latest turn's browser commands run again after a stop: a
     * regeneration reuses that turn's user message, and so its turn.
     */
    resume(): void {
      const turnId = turnIdFor();
      if (turnId !== null) {
        stopper.resume(turnId);
      }
    },
    tool,
  };
};
