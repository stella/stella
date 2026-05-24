/// <reference lib="webworker" />

import { runChatAnonPipeline } from "@stll/anonymize-chat";
import type { ChatAnonResult } from "@stll/anonymize-chat";
import { loadNameDictionaries } from "@stll/anonymize-data";
import * as anonymizeRuntime from "@stll/anonymize-wasm";
import type { GazetteerEntry, PipelineConfig } from "@stll/anonymize-wasm";

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

type AnonRequest = {
  id: number;
  locale?: string | undefined;
  text: string;
  workspaceId: string;
  gazetteerEntries?: GazetteerEntry[];
  excludedCanonicals?: readonly string[];
};

type AnonResponse =
  | ({ id: number; ok: true } & ChatAnonResult)
  | { id: number; ok: false; error: string };

let dictionariesPromise: Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> | null = null;

const pipelineContext = anonymizeRuntime.createPipelineContext();
const runWithPipelineContext = createPipelineContextRunner();

// eslint-disable-next-line @typescript-eslint/promise-function-async -- lazy init returns the cached promise without awaiting
const getDictionaries = (): Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> => {
  dictionariesPromise ??= loadNameDictionaries();
  return dictionariesPromise;
};

const defaultLocale = globalThis.navigator.language;

const handle = async (request: AnonRequest): Promise<AnonResponse> => {
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
      pipelineContext.corefSourceMap.clear();
      const runtime = {
        createPipelineContext: anonymizeRuntime.createPipelineContext,
        defaultOperatorConfig: anonymizeRuntime.DEFAULT_OPERATOR_CONFIG,
        preparePipelineSearch: anonymizeRuntime.preparePipelineSearch,
        redactText: anonymizeRuntime.redactText,
        runPipeline: anonymizeRuntime.runPipeline,
      };
      return await runChatAnonPipeline({
        runtime,
        dictionaries,
        text,
        locale,
        workspaceId,
        gazetteerEntries,
        excludedCanonicals,
        context: pipelineContext,
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

// SAFETY: this module only runs inside a Web Worker — `self` is
// the dedicated worker scope.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener("message", (event: MessageEvent<AnonRequest>) => {
  void handle(event.data).then((response) => {
    // Worker postMessage doesn't take a targetOrigin (unlike
    // window.postMessage); the lint rule is window-specific.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    scope.postMessage(response);
    return;
  });
});
