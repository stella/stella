/// <reference lib="webworker" />

import { loadNameDictionaries } from "@stll/anonymize-data";
import {
  createPipelineContext,
  DEFAULT_OPERATOR_CONFIG,
  redactText,
  runPipeline,
} from "@stll/anonymize-wasm";
import type { GazetteerEntry, PipelineConfig } from "@stll/anonymize-wasm";

import { DEFAULT_ENTITY_LABELS } from "@/lib/anonymize/constants";

/**
 * Off-main-thread runner for the chat-input anonymization pipeline.
 *
 * Loading the wasm module + name dictionaries is heavy enough that
 * doing it on the main thread blocks keystrokes. The pipeline
 * itself is synchronous, so the only real fix is to relocate it to
 * a Web Worker — that's what this file does. The protocol is a
 * single request/response pair keyed by a numeric `id` so the
 * client can multiplex.
 */

type AnonRequest = {
  id: number;
  text: string;
  workspaceId: string;
  gazetteerEntries?: GazetteerEntry[];
};

type AnonPair = { placeholder: string; original: string };

type AnonResponse =
  | { id: number; ok: true; redactedText: string; pairs: AnonPair[] }
  | { id: number; ok: false; error: string };

let dictionariesPromise: Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> | null = null;

// eslint-disable-next-line @typescript-eslint/promise-function-async -- lazy init returns the cached promise without awaiting
const getDictionaries = (): Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> => {
  dictionariesPromise ??= loadNameDictionaries();
  return dictionariesPromise;
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

const handle = async (request: AnonRequest): Promise<AnonResponse> => {
  const { id, text, workspaceId, gazetteerEntries = [] } = request;
  try {
    if (text.trim().length === 0) {
      return { id, ok: true, redactedText: text, pairs: [] };
    }
    const dictionaries = await getDictionaries();
    const config: PipelineConfig = {
      ...buildPipelineConfig({
        hasGazetteer: gazetteerEntries.length > 0,
        workspaceId,
      }),
      dictionaries,
    };
    const context = createPipelineContext();
    const entities = await runPipeline({
      fullText: text,
      config,
      gazetteerEntries,
      context,
    });
    const result = redactText(text, entities, DEFAULT_OPERATOR_CONFIG, context);
    const pairs: AnonPair[] = [...result.redactionMap.entries()].map(
      ([placeholder, original]) => ({ placeholder, original }),
    );
    return { id, ok: true, redactedText: result.redactedText, pairs };
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
  });
});
