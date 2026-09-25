import type { BrowserControlResult } from "@stll/api-contract/browser-control";

type BrowserCommandExecutor = (
  input: unknown,
  toolCallId: string,
) => Promise<BrowserControlResult>;

/** Marks a command as running; the returned callback reports how it ended. */
type BeginBrowserCommand = () => (succeeded: boolean) => void;

/**
 * Coalesces same-runtime retries. Durable at-most-once enforcement lives in
 * the extension and receives this same tool-call id across reloads. Each real
 * execution (never a coalesced retry, whose outcome is already recorded) is
 * reported to `beginCommand`, which gates read auto-approval.
 */
export const createBrowserToolExecutionCache = (
  execute: BrowserCommandExecutor,
  beginCommand: BeginBrowserCommand,
) => {
  const executions = new Map<string, Promise<BrowserControlResult>>();

  const run = async (toolCallId: string, input: unknown) => {
    const finish = beginCommand();
    let succeeded = false;
    try {
      const result = await execute(input, toolCallId);
      succeeded = result.status === "success";
      return result;
    } finally {
      finish(succeeded);
    }
  };

  return {
    async executeOnce(toolCallId: string, input: unknown) {
      const existing = executions.get(toolCallId);
      if (existing) {
        return await existing;
      }
      const execution = run(toolCallId, input);
      executions.set(toolCallId, execution);
      return await execution;
    },
  };
};
