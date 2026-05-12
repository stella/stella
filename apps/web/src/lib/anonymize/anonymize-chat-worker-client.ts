import type { ChatAnonResult } from "@stll/anonymize-chat";

/**
 * Main-thread client for the chat-input anonymization Web Worker.
 *
 * One worker is shared per tab (lazy-created on first use). All
 * pending requests are tracked by a numeric id so multiple
 * concurrent calls (e.g. live preview + sent-message render) can
 * be in flight without crossing wires.
 */

type WorkerRequest = {
  id: number;
  text: string;
  workspaceId: string;
};

type WorkerResponse =
  | ({ id: number; ok: true } & ChatAnonResult)
  | { id: number; ok: false; error: string };

type Pending = {
  resolve: (value: ChatAnonResult) => void;
  reject: (reason: Error) => void;
};

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, Pending>();

const ensureWorker = (): Worker => {
  if (worker !== null) {
    return worker;
  }
  const created = new Worker(
    new URL("../../workers/anonymize-chat-worker.ts", import.meta.url),
    { type: "module" },
  );
  created.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(message.id);
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
    // The worker crashed — reject every in-flight request and
    // drop the singleton so the next call recreates it.
    const errored = new Error("anonymize-chat worker crashed");
    for (const [, entry] of pending) {
      entry.reject(errored);
    }
    pending.clear();
    worker = null;
  });
  worker = created;
  return created;
};

// eslint-disable-next-line @typescript-eslint/promise-function-async -- the body is the Promise; an inner async wrapper would just add a microtask
export const anonymizeChatTextInWorker = ({
  text,
  workspaceId,
}: {
  text: string;
  workspaceId: string;
}): Promise<ChatAnonResult> => {
  const w = ensureWorker();
  nextRequestId += 1;
  const id = nextRequestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: WorkerRequest = { id, text, workspaceId };
    // Worker postMessage doesn't take a targetOrigin.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    w.postMessage(request);
  });
};

let warmedUp = false;

/**
 * Boot the anonymization worker without waiting for the first
 * keystroke. The cold path is heavy in dev: Vite has to compile
 * the worker module, fetch `@stll/anonymize-wasm` (wasm binary)
 * and `@stll/anonymize-data` (name dictionary JSONs), and the
 * worker then runs `loadNameDictionaries()` to parse them. Doing
 * that lazily on the first preview means the user types a name,
 * waits ~200 ms for the debounce, then sits through several
 * seconds of cold-start before the highlights paint.
 *
 * Calling this when the anonymization layer mounts pushes that
 * one-time cost behind the scenes. The empty-text branch in the
 * worker resolves instantly *after* the dictionaries finish
 * loading, so by the time the user pauses typing the worker is
 * warm and the real call returns in milliseconds.
 *
 * Idempotent — only the first call kicks the worker.
 */
export const warmupChatAnonymizeWorker = (): void => {
  if (warmedUp) {
    return;
  }
  warmedUp = true;
  // Send a single-character payload (not empty) so the worker
  // exits its "blank input" fast-path and actually runs
  // `loadNameDictionaries()` + the wasm pipeline once. The `"x"`
  // here has no semantic meaning; we just need *some* token so
  // the heavy initialisation happens before the user types.
  void anonymizeChatTextInWorker({ text: "x", workspaceId: "warmup" }).catch(
    () => {
      // Swallow — a cold-start failure shouldn't bubble; the
      // next real call will surface the error properly. We also
      // reset the flag so a transient worker crash can be
      // retried on the next mount.
      warmedUp = false;
    },
  );
};
