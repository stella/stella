import type { BrowserControlResult } from "@stll/api-contract/browser-control";

type BrowserCommandExecutor = (
  input: unknown,
  toolCallId: string,
) => Promise<BrowserControlResult>;

/**
 * Coalesces same-runtime retries. Durable at-most-once enforcement lives in
 * the extension and receives this same tool-call id across reloads.
 */
export const createBrowserToolExecutionCache = (
  execute: BrowserCommandExecutor,
) => {
  const executions = new Map<string, Promise<BrowserControlResult>>();

  return {
    async executeOnce(toolCallId: string, input: unknown) {
      const existing = executions.get(toolCallId);
      if (existing) {
        return await existing;
      }
      const execution = execute(input, toolCallId);
      executions.set(toolCallId, execution);
      return await execution;
    },
  };
};
