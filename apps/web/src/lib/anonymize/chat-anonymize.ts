import type { GazetteerEntry, PipelineConfig } from "@stll/anonymize-wasm";

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

const buildPipelineConfig = ({
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
 * chat-sized text. A fresh `PipelineContext` is created per call
 * so coreference numbering restarts at `_1` for each preview /
 * sent-message render — otherwise the same name would get
 * different placeholders depending on call order, which is
 * confusing for the audit-pill the UI shows.
 *
 * The dictionaries cache (module-scoped) keeps follow-up calls
 * fast (~tens of ms in practice).
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
  if (text.trim().length === 0) {
    return { redactedText: text, pairs: [] };
  }

  const [wasm, dictionaries] = await Promise.all([
    import("@stll/anonymize-wasm"),
    getDictionaries(),
  ]);
  const config: PipelineConfig = {
    ...buildPipelineConfig({
      hasGazetteer: gazetteerEntries.length > 0,
      workspaceId,
    }),
    dictionaries,
  };
  const context = wasm.createPipelineContext();

  const entities = await wasm.runPipeline({
    fullText: text,
    config,
    gazetteerEntries,
    context,
  });
  const result = wasm.redactText(
    text,
    entities,
    wasm.DEFAULT_OPERATOR_CONFIG,
    context,
  );

  const pairs: ChatAnonPair[] = [...result.redactionMap.entries()].map(
    ([placeholder, original]) => ({ placeholder, original }),
  );
  return { redactedText: result.redactedText, pairs };
};
