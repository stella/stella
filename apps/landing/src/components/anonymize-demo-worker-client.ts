import type { ChatAnonResult } from "@stll/anonymize-chat";

/**
 * Main-thread client for the landing page's anonymization demo worker.
 * One worker is shared per tab (lazy-created on first use); pending
 * requests are tracked by id so a stale in-flight call from a fast edit
 * can't resolve after a newer one.
 */

type WorkerRequest = { id: number; text: string };

type WorkerResponse =
  | ({ id: number; ok: true } & ChatAnonResult)
  | { id: number; ok: false; error: string };

type Pending = {
  resolve: (value: ChatAnonResult) => void;
  reject: (reason: Error) => void;
};

let worker: Worker | null = null;
let nextRequestId = 0;
const pendingRequests = new Map<number, Pending>();

const rejectAllPending = (error: Error): void => {
  for (const entry of pendingRequests.values()) {
    entry.reject(error);
  }
  pendingRequests.clear();
};

const ensureWorker = (): Worker => {
  if (worker !== null) {
    return worker;
  }
  const created = new Worker(
    new URL("anonymize-demo-worker.ts", import.meta.url),
    { type: "module" },
  );
  created.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const entry = pendingRequests.get(message.id);
    if (entry === undefined) {
      return;
    }
    pendingRequests.delete(message.id);
    if (message.ok) {
      entry.resolve({
        redactedText: message.redactedText,
        pairs: message.pairs,
        redactionMap: message.redactionMap,
        entityCount: message.entityCount,
      });
    } else {
      entry.reject(new Error(message.error));
    }
  });
  created.addEventListener("error", () => {
    rejectAllPending(new Error("anonymization demo worker crashed"));
    worker = null;
  });
  worker = created;
  return created;
};

// eslint-disable-next-line @typescript-eslint/promise-function-async -- the body is the Promise; an inner async wrapper would just add a microtask
export const runAnonymizeDemo = (text: string): Promise<ChatAnonResult> => {
  const w = ensureWorker();
  nextRequestId += 1;
  const id = nextRequestId;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    const request: WorkerRequest = { id, text };
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin param (window-only)
    w.postMessage(request);
  });
};
