/// <reference lib="webworker" />

import type { ChatAnonResult } from "@stll/anonymize-chat";

import type { DemoEngine } from "./anonymize-demo-engine";
import { loadDemoEngine } from "./anonymize-demo-engine";

/**
 * Off-main-thread runner for the landing page's live anonymization demo.
 * Mirrors apps/web's src/workers/anonymize-chat-worker.ts (loads the wasm
 * runtime + name dictionaries once, then reuses them for every request);
 * trimmed to the single fixed demo workspace this public page needs, with
 * no app-internal path aliases so it stands alone under apps/landing.
 *
 * Module evaluation deliberately pulls in no third-party module by value:
 * `anonymize-demo-engine` imports the wasm runtime and the dictionaries
 * dynamically, from inside a promise whose rejection is reported over the
 * message channel. A failing static import would abort evaluation before the
 * message listener below is installed, and the page would then wait forever
 * for a reply that no code is left to send.
 */

export type DemoRequest = { id: number; text: string };

/**
 * Worker -> main-thread protocol. `started` is the handshake: it proves the
 * module evaluated and the listener is live, so the client can distinguish
 * "worker never booted" from "engine still loading". `init-error` reports a
 * failure that will fail every request, even when none is in flight.
 */
export type DemoResponse =
  | { type: "started" }
  | { type: "init-error"; error: string }
  | { type: "result"; id: number; result: ChatAnonResult }
  | { type: "error"; id: number; error: string };

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

let enginePromise: Promise<DemoEngine> | null = null;

// eslint-disable-next-line @typescript-eslint/promise-function-async -- lazy init returns the cached promise without awaiting
const getEngine = (): Promise<DemoEngine> => {
  enginePromise ??= loadDemoEngine();
  return enginePromise;
};

// Serializes pipeline calls: the native pipeline context is not safe to
// reenter concurrently, so overlapping requests (e.g. a stale debounce
// firing alongside a fresh one) are queued rather than raced.
let pipelineQueue: Promise<void> = Promise.resolve();
const runWithPipelineContext = async <T>(
  task: () => Promise<T>,
): Promise<T> => {
  const run = pipelineQueue.then(task, task);
  pipelineQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return await run;
};

const handle = async ({ id, text }: DemoRequest): Promise<DemoResponse> => {
  try {
    const result = await runWithPipelineContext(async () => {
      const engine = await getEngine();
      return await engine.run(text);
    });
    return { type: "result", id, result };
  } catch (error) {
    return { type: "error", id, error: describeError(error) };
  }
};

const isDedicatedWorkerScope = (
  value: typeof globalThis,
): value is typeof globalThis & DedicatedWorkerGlobalScope =>
  "importScripts" in value && "WorkerGlobalScope" in globalThis;

if (!isDedicatedWorkerScope(globalThis)) {
  throw new TypeError("The anonymization demo must run in a dedicated worker");
}

const scope = globalThis;

const post = (message: DemoResponse): void => {
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- worker postMessage has no targetOrigin param, rule is window-specific
  scope.postMessage(message);
};

scope.addEventListener("message", (event: MessageEvent<DemoRequest>) => {
  const { id } = event.data;
  handle(event.data)
    .then((response) => {
      post(response);
      return;
    })
    .catch((error: unknown) => {
      // Reached when posting the reply itself throws (an uncloneable payload).
      // Swallowing it here would strand the caller's promise forever, so fall
      // back to a message built only from strings, which always clones.
      post({ type: "error", id, error: describeError(error) });
    });
});

post({ type: "started" });

// Warm the engine while the visitor reads the page, and surface a load failure
// even when no request is in flight.
getEngine().catch((error: unknown) => {
  post({ type: "init-error", error: describeError(error) });
});
