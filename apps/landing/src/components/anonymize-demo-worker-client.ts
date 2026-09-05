import { panic } from "better-result";

import type { ChatAnonResult } from "@stll/anonymize-chat";

// Type-only, so the worker module is never pulled onto the main thread: one
// declaration of the protocol keeps the two sides from drifting apart.
import type { DemoRequest, DemoResponse } from "./anonymize-demo-worker";

/**
 * Main-thread client for the landing page's anonymization demo worker.
 * One worker is shared per tab (lazy-created on first use); pending
 * requests are tracked by id so a stale in-flight call from a fast edit
 * can't resolve after a newer one.
 *
 * Every promise this module hands out is guaranteed to settle. A worker can
 * fail in ways that produce no reply at all (its module fails to load, the
 * wasm boot hangs, the pipeline wedges the serialized queue), and a caller
 * waiting on a reply that never comes is what leaves the page stuck on its
 * loading copy. Both timeouts below therefore end in a rejection, and any
 * such failure tears the worker down so the next call boots a clean one.
 */

// The worker posts `started` as the last step of module evaluation, before any
// dependency is loaded, so this only has to cover fetching and parsing the
// worker bundle itself.
const HANDSHAKE_TIMEOUT_MS = 15_000;

// A single run, including the first one that downloads the wasm runtime and
// the name/city dictionaries over whatever connection the visitor has.
const REQUEST_TIMEOUT_MS = 45_000;

type Pending = {
  resolve: (value: ChatAnonResult) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let worker: Worker | null = null;
let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
let nextRequestId = 0;
const pendingRequests = new Map<number, Pending>();

const settle = (id: number): Pending | undefined => {
  const entry = pendingRequests.get(id);
  if (entry === undefined) {
    return undefined;
  }
  clearTimeout(entry.timer);
  pendingRequests.delete(id);
  return entry;
};

/**
 * Discards the worker and fails everything waiting on it. Used for every
 * unrecoverable condition, including a request timeout: the worker serializes
 * pipeline calls, so a run that never returns would block every later request
 * behind it, and only a fresh worker clears that.
 */
const failWorker = (message: string): void => {
  if (handshakeTimer !== null) {
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
  }
  worker?.terminate();
  worker = null;
  const ids = [...pendingRequests.keys()];
  for (const id of ids) {
    settle(id)?.reject(new Error(message));
  }
};

const onMessage = (event: MessageEvent<DemoResponse>) => {
  const message = event.data;
  switch (message.type) {
    case "started": {
      if (handshakeTimer !== null) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
      return;
    }
    case "init-error": {
      failWorker(message.error);
      return;
    }
    case "result": {
      settle(message.id)?.resolve(message.result);
      return;
    }
    case "error": {
      settle(message.id)?.reject(new Error(message.error));
      return;
    }
    default: {
      message satisfies never;
      panic(`unhandled anonymization worker message: ${String(message)}`);
    }
  }
};

const ensureWorker = (): Worker => {
  if (worker !== null) {
    return worker;
  }
  const created = new Worker(
    new URL("anonymize-demo-worker.ts", import.meta.url),
    { type: "module" },
  );
  created.addEventListener("message", onMessage);
  created.addEventListener("error", () => {
    failWorker("The anonymisation engine failed to start.");
  });
  worker = created;
  handshakeTimer = setTimeout(() => {
    failWorker("The anonymisation engine did not start in time.");
  }, HANDSHAKE_TIMEOUT_MS);
  return created;
};

// eslint-disable-next-line @typescript-eslint/promise-function-async -- the body is the Promise; an inner async wrapper would just add a microtask
export const runAnonymizeDemo = (text: string): Promise<ChatAnonResult> => {
  const w = ensureWorker();
  nextRequestId += 1;
  const id = nextRequestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      failWorker("The anonymisation engine timed out.");
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timer });
    const request: DemoRequest = { id, text };
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin param (window-only)
    w.postMessage(request);
  });
};
