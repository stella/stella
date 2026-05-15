import { runChatAnonPipeline } from "@stll/anonymize-chat";
import type { ChatAnonResult } from "@stll/anonymize-chat";
import type {
  GazetteerEntry,
  PipelineConfig,
  PipelineContext,
} from "@stll/anonymize-wasm";

export type { ChatAnonPair, ChatAnonResult } from "@stll/anonymize-chat";

// Dictionaries are large but idempotent and HTTP-cached. Hold a
// single promise so repeated calls in the same tab share one
// network/parse cycle.
let dictionariesPromise: Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> | null = null;
let pipelineContextPromise: Promise<PipelineContext> | null = null;
let pipelineQueue: Promise<void> = Promise.resolve();

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

const getPipelineContext = async () => {
  pipelineContextPromise ??= (async () => {
    const wasm = await import("@stll/anonymize-wasm");
    return wasm.createPipelineContext();
  })();
  return await pipelineContextPromise;
};

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

/**
 * Run the same wasm pipeline the server uses against a single
 * chat-sized text from the main thread. Calls share the
 * `PipelineContext` search caches, but run serially so
 * per-document coreference state can be cleared between inputs.
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
  const [wasm, dictionaries, context] = await Promise.all([
    import("@stll/anonymize-wasm"),
    getDictionaries(),
    getPipelineContext(),
  ]);
  return await runWithPipelineContext(async () => {
    context.corefSourceMap.clear();
    const runtime = {
      createPipelineContext: wasm.createPipelineContext,
      defaultOperatorConfig: wasm.DEFAULT_OPERATOR_CONFIG,
      preparePipelineSearch: wasm.preparePipelineSearch,
      redactText: wasm.redactText,
      runPipeline: wasm.runPipeline,
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
