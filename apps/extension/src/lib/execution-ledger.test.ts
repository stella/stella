import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type BrowserControlResult,
} from "@stll/api-contract/browser-control";

import {
  executeAtMostOnce,
  type ExecutionReceiptStore,
} from "./execution-ledger";

const success = {
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  snapshot: {
    contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
    elements: [],
    revision: "revision-1",
    text: "Ready",
    title: "Example",
    url: "https://example.com/",
  },
  status: "success",
} satisfies BrowserControlResult;

const createStore = (): ExecutionReceiptStore => {
  let receipts: Awaited<ReturnType<ExecutionReceiptStore["read"]>> = [];
  return {
    async read() {
      return receipts;
    },
    async write(nextReceipts) {
      receipts = nextReceipts;
    },
  };
};

describe("browser action execution ledger", () => {
  test("reuses a completed result after the web and worker runtimes restart", async () => {
    const store = createStore();
    let calls = 0;
    const options = {
      command: { action: "snapshot" } as const,
      controllerId: "controller-1",
      execute: async () => {
        calls += 1;
        return success;
      },
      store,
      toolCallId: "tool-call-1",
    };

    expect(await executeAtMostOnce(options)).toEqual(success);
    expect(await executeAtMostOnce(options)).toEqual(success);
    expect(calls).toBe(1);
  });

  test("does not repeat an action after a crash between execution and completion", async () => {
    const store = createStore();
    let calls = 0;
    const options = {
      command: { action: "open", url: "https://example.com/" } as const,
      controllerId: "controller-1",
      execute: async (): Promise<BrowserControlResult> => {
        calls += 1;
        throw new TypeError("simulated worker crash");
      },
      store,
      toolCallId: "tool-call-1",
    };

    const crashError = await executeAtMostOnce(options).then(
      () => null,
      (error: unknown) => error,
    );
    expect(crashError).toBeInstanceOf(TypeError);
    expect(crashError).toHaveProperty("message", "simulated worker crash");
    const retried = await executeAtMostOnce(options);
    expect(retried).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.replayStateUnknown,
      status: "error",
    });
    expect(calls).toBe(1);
  });

  test("rejects a reused tool-call id with different input", async () => {
    const store = createStore();
    await executeAtMostOnce({
      command: { action: "snapshot" },
      controllerId: "controller-1",
      execute: async () => success,
      store,
      toolCallId: "tool-call-1",
    });

    const result = await executeAtMostOnce({
      command: { action: "go-back" },
      controllerId: "controller-1",
      execute: async () => success,
      store,
      toolCallId: "tool-call-1",
    });
    expect(result).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.invalidCommand,
      status: "error",
    });
  });
});
