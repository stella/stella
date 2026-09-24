/// <reference lib="webworker" />

import { panic } from "better-result";

import { runChatAnonPipeline } from "@stll/anonymize-chat";
import type { ChatAnonRuntime } from "@stll/anonymize-chat";
import { loadNameDictionaries } from "@stll/anonymize-data";
import * as anonymizeRuntime from "@stll/anonymize-wasm";
import type { PipelineConfig } from "@stll/anonymize-wasm";

import type {
  AnonymizeChatWorkerRequest,
  AnonymizeChatWorkerResponse,
} from "@/lib/anonymize/anonymize-chat-worker-protocol";
import { createPipelineContextRunner } from "@/lib/anonymize/pipeline-context";

/**
 * Off-main-thread runner for the chat-input anonymization
 * pipeline. Loading the wasm module + name dictionaries is heavy
 * enough that doing it on the main thread blocks keystrokes. The
 * pipeline itself is synchronous, so the only real fix is to
 * relocate it here.
 *
 * The wasm-side recognition logic and config live in
 * `@stll/anonymize-chat`; this file owns the worker plumbing:
 * dictionaries cache, message protocol, request multiplexing.
 */

let dictionariesPromise: Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> | null = null;

const runWithPipelineContext = createPipelineContextRunner();

// eslint-disable-next-line @typescript-eslint/promise-function-async -- lazy init returns the cached promise without awaiting
const getDictionaries = (): Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> => {
  dictionariesPromise ??= loadNameDictionaries();
  return dictionariesPromise;
};

const defaultLocale = globalThis.navigator.language;

const failureResponse = (
  id: AnonymizeChatWorkerRequest["id"],
  error: unknown,
): AnonymizeChatWorkerResponse => ({
  id,
  ok: false,
  error: error instanceof Error ? error.message : String(error),
});

const handle = async (
  request: AnonymizeChatWorkerRequest,
): Promise<AnonymizeChatWorkerResponse> => {
  const {
    id,
    text,
    workspaceId,
    gazetteerEntries = [],
    excludedCanonicals,
    locale = defaultLocale,
  } = request;
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
        locale,
        workspaceId,
        gazetteerEntries,
        excludedCanonicals,
        context,
      });
    });
    return { id, ok: true, result };
  } catch (error) {
    return failureResponse(id, error);
  }
};

const isDedicatedWorkerScope = (
  value: typeof globalThis,
): value is typeof globalThis & DedicatedWorkerGlobalScope =>
  "importScripts" in value && "WorkerGlobalScope" in globalThis;

if (!isDedicatedWorkerScope(globalThis)) {
  panic("Chat anonymization must run in a dedicated worker");
}

const scope = globalThis;

const postResponse = (response: AnonymizeChatWorkerResponse): void => {
  // Worker postMessage doesn't take a targetOrigin (unlike
  // window.postMessage); the lint rule is window-specific.
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- worker postMessage has no targetOrigin param, rule is window-specific
  scope.postMessage(response);
};

scope.addEventListener(
  "message",
  (event: MessageEvent<AnonymizeChatWorkerRequest>) => {
    // Worker-local handling keeps the off-main-thread anonymizer self-contained:
    // routing through the app's detached()/analytics stack would pull PostHog and
    // env into every worker cold start. The handler already converts pipeline
    // failures into an error response; a response that fails to post (for
    // example, one that cannot be cloned) is answered with an error response
    // too, so the main-thread request settles instead of hanging.
    handle(event.data)
      .then(postResponse)
      .catch((error: unknown) => {
        postResponse(failureResponse(event.data.id, error));
      });
  },
);
