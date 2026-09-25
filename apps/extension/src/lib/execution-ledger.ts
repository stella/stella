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

/**
 * Tool-call keys that ever started, kept far longer than result payloads: a
 * retry whose result was evicted must still never run twice.
 */
const EXECUTED_KEY_LIMIT = 4096;

type ExecutionLedger = {
  executedKeys: string[];
  receipts: ExecutionReceipt[];
};

export type ExecutionReceiptStore = {
  read: () => Promise<ExecutionLedger>;
  write: (ledger: ExecutionLedger) => Promise<void>;
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

const parseExecutionLedger = (input: unknown): ExecutionLedger => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("executedKeys" in input) ||
    !Array.isArray(input.executedKeys) ||
    !("receipts" in input) ||
    !Array.isArray(input.receipts)
  ) {
    return { executedKeys: [], receipts: [] };
  }
  return {
    executedKeys: input.executedKeys.filter(
      (key): key is string => typeof key === "string",
    ),
    receipts: input.receipts
      .map(parseExecutionReceipt)
      .filter((receipt) => receipt !== null),
  };
};

const chromeExecutionReceiptStore: ExecutionReceiptStore = {
  async read() {
    const stored = await chrome.storage.session.get(
      BROWSER_EXECUTION_RECEIPTS_STORAGE_KEY,
    );
    return parseExecutionLedger(stored[BROWSER_EXECUTION_RECEIPTS_STORAGE_KEY]);
  },
  async write(ledger) {
    await chrome.storage.session.set({
      [BROWSER_EXECUTION_RECEIPTS_STORAGE_KEY]: ledger,
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
  const { executedKeys, receipts } = await store.read();
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
  if (executedKeys.includes(key)) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.replayStateUnknown,
      "This browser action already ran and its result is no longer kept. Take a snapshot to inspect the page instead of repeating it.",
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
  const boundedKeys = [...executedKeys.slice(-(EXECUTED_KEY_LIMIT - 1)), key];
  await store.write({ executedKeys: boundedKeys, receipts: boundedReceipts });

  const result = await execute();
  const completedReceipt = {
    fingerprint,
    key,
    result,
    status: "completed",
  } satisfies CompletedExecutionReceipt;
  await store.write({
    executedKeys: boundedKeys,
    receipts: [...boundedReceipts.slice(0, -1), completedReceipt],
  });
  return result;
};
