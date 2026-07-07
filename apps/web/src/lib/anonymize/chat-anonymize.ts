import { runChatAnonPipeline } from "@stll/anonymize-chat";
import type { ChatAnonResult, ChatAnonRuntime } from "@stll/anonymize-chat";
import type { GazetteerEntry, PipelineConfig } from "@stll/anonymize-wasm";

import { createPipelineContextRunner } from "@/lib/anonymize/pipeline-context";

export type { ChatAnonPair, ChatAnonResult } from "@stll/anonymize-chat";

// Dictionaries are large but idempotent and HTTP-cached. Hold a
// single promise so repeated calls in the same tab share one
// network/parse cycle.
let dictionariesPromise: Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> | null = null;
const runWithPipelineContext = createPipelineContextRunner();

// eslint-disable-next-line @typescript-eslint/promise-function-async -- lazy init returns the cached promise without awaiting
const getDictionaries = (): Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> => {
  dictionariesPromise ??= (async () => {
    const { loadNameDictionaries } = await import("@stll/anonymize-data");
    return loadNameDictionaries();
  })();
  return dictionariesPromise;
};

/**
 * Run the same wasm pipeline the server uses against a single
 * chat-sized text from the main thread. Calls run serially; each
 * input gets its own `PipelineContext` (now purely a prepared-package
 * assembly cache — the native pipeline no longer carries coreference
 * or placeholder-counter state across calls).
 */
export const anonymizeChatText = async ({
  gazetteerEntries = [],
  locale = navigator.language,
  text,
  workspaceId,
}: {
  locale?: string | undefined;
  text: string;
  workspaceId: string;
  gazetteerEntries?: GazetteerEntry[];
}): Promise<ChatAnonResult> => {
  const [wasm, dictionaries] = await Promise.all([
    import("@stll/anonymize-wasm"),
    getDictionaries(),
  ]);
  return await runWithPipelineContext(async () => {
    const context = wasm.createPipelineContext();
    const runtime: ChatAnonRuntime = {
      getBinding: wasm.getBinding,
      createNativePipelineFromConfig: wasm.createNativePipelineFromConfig,
      createPipelineContext: wasm.createPipelineContext,
      deanonymise: wasm.deanonymise,
    };
    return await runChatAnonPipeline({
      runtime,
      dictionaries,
      text,
      locale,
      workspaceId,
      gazetteerEntries,
      context,
    });
  });
};
