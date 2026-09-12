import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  type BrowserControlCommand,
  type BrowserControlResult,
  parseBrowserControlResult,
} from "@stll/api-contract/browser-control";

import { browserControlError } from "./browser-control-result";
import { BROWSER_EXECUTION_RECEIPTS_STORAGE_KEY } from "./storage-keys";

type StartedExecutionReceipt = {
  fingerprint: string;
  key: string;
  status: "started";
};

type CompletedExecutionReceipt = {
  fingerprint: string;
  key: string;
  result: BrowserControlResult;
  status: "completed";
};

type ExecutionReceipt = CompletedExecutionReceipt | StartedExecutionReceipt;

export type ExecutionReceiptStore = {
  read: () => Promise<ExecutionReceipt[]>;
  write: (receipts: ExecutionReceipt[]) => Promise<void>;
};

const parseExecutionReceipt = (input: unknown): ExecutionReceipt | null => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("fingerprint" in input) ||
    typeof input.fingerprint !== "string" ||
    !("key" in input) ||
    typeof input.key !== "string" ||
    !("status" in input)
  ) {
    return null;
  }
  if (input.status === "started") {
    return {
      fingerprint: input.fingerprint,
      key: input.key,
      status: "started",
    };
  }
  if (input.status !== "completed" || !("result" in input)) {
    return null;
  }
  const result = parseBrowserControlResult(input.result);
  return result
    ? {
        fingerprint: input.fingerprint,
        key: input.key,
        result,
        status: "completed",
      }
    : null;
};

const chromeExecutionReceiptStore: ExecutionReceiptStore = {
  async read() {
    const stored = await chrome.storage.session.get(
      BROWSER_EXECUTION_RECEIPTS_STORAGE_KEY,
    );
    const receipts = stored[BROWSER_EXECUTION_RECEIPTS_STORAGE_KEY];
    return Array.isArray(receipts)
      ? receipts
          .map(parseExecutionReceipt)
          .filter((receipt) => receipt !== null)
      : [];
  },
  async write(receipts) {
    await chrome.storage.session.set({
      [BROWSER_EXECUTION_RECEIPTS_STORAGE_KEY]: receipts,
    });
  },
};

const executionFingerprint = (command: BrowserControlCommand): string =>
  JSON.stringify(command);

type ExecuteAtMostOnceOptions = {
  command: BrowserControlCommand;
  controllerId: string;
  execute: () => Promise<BrowserControlResult>;
  store?: ExecutionReceiptStore;
  toolCallId: string;
};

export const executeAtMostOnce = async ({
  command,
  controllerId,
  execute,
  store = chromeExecutionReceiptStore,
  toolCallId,
}: ExecuteAtMostOnceOptions): Promise<BrowserControlResult> => {
  const fingerprint = executionFingerprint(command);
  const key = `${controllerId}:${toolCallId}`;
  const receipts = await store.read();
  const existing = receipts.find((receipt) => receipt.key === key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.invalidCommand,
        "A browser action retry reused its tool-call id with different input.",
      );
    }
    if (existing.status === "completed") {
      return existing.result;
    }
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.replayStateUnknown,
      "Chrome stopped while this browser action was running. Inspect the page before requesting a new action.",
    );
  }

  const startedReceipt = {
    fingerprint,
    key,
    status: "started",
  } satisfies StartedExecutionReceipt;
  const boundedReceipts = [
    ...receipts.slice(-(BROWSER_CONTROL_LIMITS.executionReceipts - 1)),
    startedReceipt,
  ];
  await store.write(boundedReceipts);

  const result = await execute();
  const completedReceipt = {
    fingerprint,
    key,
    result,
    status: "completed",
  } satisfies CompletedExecutionReceipt;
  await store.write([...boundedReceipts.slice(0, -1), completedReceipt]);
  return result;
};
