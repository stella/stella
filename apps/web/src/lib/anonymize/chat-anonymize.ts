import type {
  createPipelineContext,
  DEFAULT_OPERATOR_CONFIG,
  Entity,
  GazetteerEntry,
  PipelineConfig,
  PipelineContext,
  redactText,
  RedactionResult,
  runPipeline,
} from "@stll/anonymize-wasm";

import { DEFAULT_ENTITY_LABELS } from "@/lib/anonymize/constants";

export type ChatAnonPair = {
  placeholder: string;
  original: string;
};

export type ChatAnonResult = {
  /** Text with placeholders substituted in (`Jan Novák` → `[PERSON_1]`). */
  redactedText: string;
  /** Per-occurrence pair for the rehype-anon-spans renderer. */
  pairs: ChatAnonPair[];
};

/**
 * Shared pipeline config for the chat-input anonymizer. Both the
 * Web Worker (statically imported wasm) and the main-thread
 * fallback (dynamic-imported wasm) feed this into `runPipeline` so
 * the recognition surface stays identical across paths.
 */
export const buildChatAnonPipelineConfig = ({
  hasGazetteer,
  workspaceId,
}: {
  hasGazetteer: boolean;
  workspaceId: string;
}): PipelineConfig => ({
  threshold: 0.4,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableNameCorpus: true,
  enableDenyList: false,
  enableGazetteer: hasGazetteer,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: true,
  enableLegalForms: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId,
});

/**
 * Wasm-package functions the pipeline needs. Threading these
 * through as a dependency record (rather than importing them at
 * module top-level) lets the Web Worker reuse this code with its
 * own static imports, while the main-thread fallback hydrates them
 * lazily via `import()`.
 */
export type ChatAnonRuntime = {
  createPipelineContext: typeof createPipelineContext;
  defaultOperatorConfig: typeof DEFAULT_OPERATOR_CONFIG;
  redactText: typeof redactText;
  runPipeline: typeof runPipeline;
};

export const runChatAnonPipeline = async ({
  runtime,
  dictionaries,
  text,
  workspaceId,
  gazetteerEntries = [],
}: {
  runtime: ChatAnonRuntime;
  dictionaries: NonNullable<PipelineConfig["dictionaries"]>;
  text: string;
  workspaceId: string;
  gazetteerEntries?: GazetteerEntry[];
}): Promise<ChatAnonResult> => {
  if (text.trim().length === 0) {
    return { redactedText: text, pairs: [] };
  }
  const config: PipelineConfig = {
    ...buildChatAnonPipelineConfig({
      hasGazetteer: gazetteerEntries.length > 0,
      workspaceId,
    }),
    dictionaries,
  };
  const context: PipelineContext = runtime.createPipelineContext();
  const entities: Entity[] = await runtime.runPipeline({
    fullText: text,
    config,
    gazetteerEntries,
    context,
  });
  const result: RedactionResult = runtime.redactText(
    text,
    entities,
    runtime.defaultOperatorConfig,
    context,
  );
  const pairs: ChatAnonPair[] = [...result.redactionMap.entries()].map(
    ([placeholder, original]) => ({ placeholder, original }),
  );
  return { redactedText: result.redactedText, pairs };
};

// Dictionaries are large but idempotent and HTTP-cached. Hold a
// single promise so repeated calls in the same tab share one
// network/parse cycle.
let dictionariesPromise: Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> | null = null;

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
 * chat-sized text from the main thread. Each call gets a fresh
 * `PipelineContext`, matching the chat-anonymize-worker's
 * per-request semantics.
 */
export const anonymizeChatText = async ({
  gazetteerEntries = [],
  text,
  workspaceId,
}: {
  text: string;
  workspaceId: string;
  gazetteerEntries?: GazetteerEntry[];
}): Promise<ChatAnonResult> => {
  const [wasm, dictionaries] = await Promise.all([
    import("@stll/anonymize-wasm"),
    getDictionaries(),
  ]);
  return await runChatAnonPipeline({
    runtime: {
      createPipelineContext: wasm.createPipelineContext,
      defaultOperatorConfig: wasm.DEFAULT_OPERATOR_CONFIG,
      redactText: wasm.redactText,
      runPipeline: wasm.runPipeline,
    },
    dictionaries,
    text,
    workspaceId,
    gazetteerEntries,
  });
};
