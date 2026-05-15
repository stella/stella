import * as v from "valibot";

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
  "birth number",
  "national identification number",
  "social security number",
  "registration number",
  "credit card number",
  "passport number",
  "monetary amount",
  "land parcel",
  "misc",
] as const;

export type ChatAnonPair = {
  placeholder: string;
  original: string;
  /**
   * Entity label as emitted by the pipeline (e.g. "person",
   * "organization", "phone number"). Same vocabulary as
   * {@link DEFAULT_CHAT_ANON_ENTITY_LABELS}. Consumers that need
   * to colour or group by entity type read this directly instead
   * of parsing the placeholder string.
   */
  label: string;
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

export const CHAT_SEND_MODE = {
  anonymized: "anonymized",
  rawOverride: "rawOverride",
} as const;

export const CHAT_SEND_MODES = [
  CHAT_SEND_MODE.anonymized,
  CHAT_SEND_MODE.rawOverride,
] as const;

export const chatSendModeSchema = v.picklist(CHAT_SEND_MODES);
export type ChatSendMode = v.InferOutput<typeof chatSendModeSchema>;

export const isChatSendMode = (value: unknown): value is ChatSendMode =>
  v.safeParse(chatSendModeSchema, value).success;

export const getPreferredChatSendMode = (anonymized: boolean): ChatSendMode =>
  anonymized ? CHAT_SEND_MODE.anonymized : CHAT_SEND_MODE.rawOverride;

export const CHAT_TRANSPORT_ERROR_CODE = {
  thirdPartyBoundaryRefusal: "third_party_boundary_refusal",
} as const;

export const CHAT_TRANSPORT_ERROR_CODES = [
  CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
] as const;

export const chatTransportErrorCodeSchema = v.picklist(
  CHAT_TRANSPORT_ERROR_CODES,
);
export type ChatTransportErrorCode = v.InferOutput<
  typeof chatTransportErrorCodeSchema
>;

export const chatTransportErrorPayloadSchema = v.strictObject({
  code: chatTransportErrorCodeSchema,
  message: v.string(),
});
export type ChatTransportErrorPayload = v.InferOutput<
  typeof chatTransportErrorPayloadSchema
>;

export const createThirdPartyBoundaryRefusalPayload = (
  message: string,
): ChatTransportErrorPayload => ({
  code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
  message,
});

export const parseChatTransportErrorPayload = (
  payload: unknown,
): ChatTransportErrorPayload | null => {
  const result = v.safeParse(chatTransportErrorPayloadSchema, payload);
  return result.success ? result.output : null;
};

export const parseChatTransportErrorMessage = (
  message: string,
): ChatTransportErrorPayload | null => {
  try {
    return parseChatTransportErrorPayload(JSON.parse(message));
  } catch {
    return null;
  }
};

export const isThirdPartyBoundaryRefusalPayload = (
  payload: ChatTransportErrorPayload | null,
): boolean =>
  payload?.code === CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal;

export const isThirdPartyBoundaryRefusalError = (error: Error): boolean =>
  isThirdPartyBoundaryRefusalPayload(
    parseChatTransportErrorMessage(error.message),
  );

export type ChatAnonRuntime = {
  createPipelineContext: typeof createPipelineContext;
  defaultOperatorConfig: typeof DEFAULT_OPERATOR_CONFIG;
  preparePipelineSearch?: (input: {
    config: PipelineConfig;
    context: PipelineContext;
    gazetteerEntries: GazetteerEntry[];
  }) => Promise<unknown>;
  redactText: typeof redactText;
  runPipeline: typeof runPipeline;
};

type ScopedPipelineConfig = PipelineConfig & {
  nameCorpusLanguages?: string[];
};

const normalizeLocaleLanguage = (locale: string | undefined): string | null => {
  const [languagePart] = locale?.split(/[-_]/u) ?? [];
  const language = languagePart?.trim().toLowerCase();
  return language && /^[a-z]{2}$/u.test(language) ? language : null;
};

export const buildChatAnonPipelineConfig = ({
  hasGazetteer,
  locale,
  workspaceId,
}: {
  hasGazetteer: boolean;
  locale?: string | undefined;
  workspaceId: string;
}): ScopedPipelineConfig => {
  const nameCorpusLanguage = normalizeLocaleLanguage(locale);
  const config: ScopedPipelineConfig = {
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
  };
  if (nameCorpusLanguage !== null) {
    config.nameCorpusLanguages = [nameCorpusLanguage];
  }
  return config;
};

/**
 * Fold a surface form to its comparison key for the
 * excluded-canonicals filter. Mirrors Folio's
 * decoration matcher: NFKC + lowercase, with runs of
 * whitespace collapsed so "Acme  Corp" and "Acme Corp"
 * collide.
 */
const normalizeForExclusion = (value: string): string =>
  value.normalize("NFKC").toLowerCase().replaceAll(/\s+/g, " ").trim();

export const runChatAnonPipeline = async ({
  context: providedContext,
  dictionaries,
  excludedCanonicals,
  gazetteerEntries = [],
  runtime,
  text,
  locale,
  workspaceId,
}: {
  runtime: ChatAnonRuntime;
  dictionaries: NonNullable<PipelineConfig["dictionaries"]>;
  text: string;
  locale?: string | undefined;
  workspaceId: string;
  gazetteerEntries?: GazetteerEntry[] | undefined;
  context?: PipelineContext | undefined;
  /**
   * Surface forms the caller has marked as never-anonymize.
   * After the pipeline runs, any entity whose normalized text
   * matches one of these (NFKC + lowercase, collapsed whitespace)
   * is dropped before the redaction step, so the placeholder
   * counter stays continuous and the original text passes
   * through unchanged.
   */
  excludedCanonicals?: readonly string[] | undefined;
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
  const config = {
    ...buildChatAnonPipelineConfig({
      hasGazetteer: gazetteerEntries.length > 0,
      locale,
      workspaceId,
    }),
    dictionaries,
  };
  await runtime.preparePipelineSearch?.({
    config,
    context,
    gazetteerEntries,
  });
  const rawEntities: Entity[] = await runtime.runPipeline({
    fullText: text,
    config,
    gazetteerEntries,
    context,
  });
  const excludedSet =
    excludedCanonicals && excludedCanonicals.length > 0
      ? new Set(excludedCanonicals.map(normalizeForExclusion))
      : null;
  const entities: Entity[] =
    excludedSet === null
      ? rawEntities
      : rawEntities.filter(
          (entity) => !excludedSet.has(normalizeForExclusion(entity.text)),
        );
  const result: RedactionResult = runtime.redactText(
    text,
    entities,
    runtime.defaultOperatorConfig,
    context,
  );
  // Index entities by their surface text so each placeholder
  // can carry the originating entity's label out to consumers.
  // Same text + same label maps to the same placeholder by the
  // wasm operator config, so a Map keyed on the entity text is
  // enough to recover the label per pair.
  const labelByOriginal = new Map<string, string>();
  for (const entity of entities) {
    if (!labelByOriginal.has(entity.text)) {
      labelByOriginal.set(entity.text, entity.label);
    }
  }
  const pairs: ChatAnonPair[] = [...result.redactionMap.entries()].map(
    ([placeholder, original]) => ({
      placeholder,
      original,
      label: labelByOriginal.get(original) ?? "misc",
    }),
  );

  return {
    redactedText: result.redactedText,
    pairs,
    redactionMap: result.redactionMap,
    entityCount: result.entityCount,
  };
};
