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

/**
 * Default entity labels supported by the anonymization pipeline.
 *
 * Keep this constant here, rather than importing the wasm package at
 * runtime, so browser code can use the shared chat config without
 * pulling the wasm module onto the main thread just for constants.
 * `index.test.ts` verifies parity with the wasm package export.
 */
export const DEFAULT_CHAT_ANON_ENTITY_LABELS = [
  "person",
  "organization",
  "phone number",
  "address",
  "email address",
  "date",
  "date of birth",
  "bank account number",
  "iban",
  "tax identification number",
  "identity card number",
  "registration number",
  "credit card number",
  "passport number",
  "monetary amount",
  "land parcel",
] as const;

export type ChatAnonPair = {
  placeholder: string;
  original: string;
};

export type ChatAnonResult = {
  /** Text with placeholders substituted in (`Jan Novák` -> `[PERSON_1]`). */
  redactedText: string;
  /** Per-occurrence pair for UI renderers and restoration metadata. */
  pairs: ChatAnonPair[];
  /** Placeholder -> original map produced by the reversible replace operator. */
  redactionMap: Map<string, string>;
  entityCount: number;
};

export type ChatAnonRuntime = {
  createPipelineContext: typeof createPipelineContext;
  defaultOperatorConfig: typeof DEFAULT_OPERATOR_CONFIG;
  redactText: typeof redactText;
  runPipeline: typeof runPipeline;
};

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
  labels: [...DEFAULT_CHAT_ANON_ENTITY_LABELS],
  workspaceId,
});

export const runChatAnonPipeline = async ({
  context: providedContext,
  dictionaries,
  gazetteerEntries = [],
  runtime,
  text,
  workspaceId,
}: {
  runtime: ChatAnonRuntime;
  dictionaries: NonNullable<PipelineConfig["dictionaries"]>;
  text: string;
  workspaceId: string;
  gazetteerEntries?: GazetteerEntry[] | undefined;
  context?: PipelineContext | undefined;
}): Promise<ChatAnonResult> => {
  if (text.trim().length === 0) {
    return {
      redactedText: text,
      pairs: [],
      redactionMap: new Map<string, string>(),
      entityCount: 0,
    };
  }

  const context = providedContext ?? runtime.createPipelineContext();
  const entities: Entity[] = await runtime.runPipeline({
    fullText: text,
    config: {
      ...buildChatAnonPipelineConfig({
        hasGazetteer: gazetteerEntries.length > 0,
        workspaceId,
      }),
      dictionaries,
    },
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

  return {
    redactedText: result.redactedText,
    pairs,
    redactionMap: result.redactionMap,
    entityCount: result.entityCount,
  };
};
