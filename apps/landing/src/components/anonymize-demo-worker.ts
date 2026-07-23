/// <reference lib="webworker" />

// eslint-disable-next-line unicorn/prefer-node-protocol -- this is the `buffer` browser-polyfill package (npm, no Node dependency), not Node's own `node:buffer` core module; `node:buffer` would not resolve the same way in a browser/worker bundle
import { Buffer } from "buffer";

import { runChatAnonPipeline } from "@stll/anonymize-chat";
import type { ChatAnonResult, ChatAnonRuntime } from "@stll/anonymize-chat";
import { loadNameDictionaries } from "@stll/anonymize-data";
import * as anonymizeRuntime from "@stll/anonymize-wasm";
import type { PipelineConfig } from "@stll/anonymize-wasm";

// The napi-rs/emnapi wasm binding (@stll/anonymize-wasm's native glue) checks
// `globalThis.Buffer` for some Node-API operations; browsers/workers have no
// such global, so it throws "NotSupportBufferError" the first time that path
// is hit at runtime. Node itself would provide this for free — a worker in a
// real browser needs the polyfill installed before the pipeline actually
// runs (module evaluation order doesn't matter here: this only needs to
// land before the first `handle()` call below, which only fires once the
// worker receives a message, well after this module finishes loading).
// eslint-disable-next-line typescript/no-unnecessary-condition -- ambient lib types claim globalThis.Buffer always exists; a real browser/worker genuinely may not have it, which is exactly the runtime gap this line covers
globalThis.Buffer ??= Buffer;

/**
 * Off-main-thread runner for the landing page's live anonymization demo.
 * Mirrors apps/web's src/workers/anonymize-chat-worker.ts (loads the wasm
 * runtime + name dictionaries once, then reuses them for every request);
 * trimmed to the single fixed demo workspace this public page needs, with
 * no app-internal path aliases so it stands alone under apps/landing.
 */

type DemoRequest = {
  id: number;
  text: string;
};

type DemoResponse =
  | ({ id: number; ok: true } & ChatAnonResult)
  | { id: number; ok: false; error: string };

// Public demo has no organisation, so no blacklist/gazetteer/exclusion input
// is needed; every visitor gets the same fixed workspace id and locale.
const DEMO_WORKSPACE_ID = "landing-demo";
const DEMO_LOCALE = "en";

let dictionariesPromise: Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> | null = null;

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

// eslint-disable-next-line @typescript-eslint/promise-function-async -- lazy init returns the cached promise without awaiting
const getDictionaries = (): Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> => {
  dictionariesPromise ??= loadNameDictionaries();
  return dictionariesPromise;
};

const handle = async (request: DemoRequest): Promise<DemoResponse> => {
  const { id, text } = request;
  try {
    const result = await runWithPipelineContext(async () => {
      const dictionaries = await getDictionaries();
      const context = anonymizeRuntime.createPipelineContext();
      const runtime: ChatAnonRuntime = {
        getBinding: anonymizeRuntime.getBinding,
        createNativePipelineFromConfig:
          anonymizeRuntime.createNativePipelineFromConfig,
        createPipelineContext: anonymizeRuntime.createPipelineContext,
        deanonymise: anonymizeRuntime.deanonymise,
      };
      return await runChatAnonPipeline({
        runtime,
        dictionaries,
        text,
        locale: DEMO_LOCALE,
        workspaceId: DEMO_WORKSPACE_ID,
        gazetteerEntries: [],
        context,
      });
    });
    return { id, ok: true, ...result };
  } catch (error) {
    return {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
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

scope.addEventListener("message", (event: MessageEvent<DemoRequest>) => {
  handle(event.data)
    .then((response) => {
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- worker postMessage has no targetOrigin param, rule is window-specific
      scope.postMessage(response);
      return;
    })
    .catch(() => undefined);
});
