import * as v from "valibot";

import type {
  createNativePipelineFromConfig,
  createPipelineContext,
  deanonymise,
  getBinding,
  GazetteerEntry,
  NativePipelineEntity,
  OperatorType,
  PipelineConfig,
  PipelineContext,
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
  "country",
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
  "crypto",
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

/**
 * Runtime seam the wasm entry (main thread or worker) injects into
 * {@link runChatAnonPipeline}. `createNativePipelineFromConfig`
 * assembles (or reuses, via `context`) a prepared native pipeline
 * for a config + gazetteer; `redactText` on the resulting pipeline
 * runs detection and redaction as ONE combined call — there is no
 * separate detect-then-redact step anymore.
 */
export type ChatAnonRuntime = {
  getBinding: typeof getBinding;
  createNativePipelineFromConfig: typeof createNativePipelineFromConfig;
  createPipelineContext: typeof createPipelineContext;
  deanonymise: typeof deanonymise;
};

export const normalizeChatAnonLocaleLanguage = (
  locale: string | undefined,
): string | null => {
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
}): PipelineConfig => {
  const nameCorpusLanguage = normalizeChatAnonLocaleLanguage(locale);
  const config: PipelineConfig = {
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
  value.normalize("NFKC").toLowerCase().replaceAll(/\s+/gu, " ").trim();

const PLACEHOLDER_TOKEN = /\[[A-Z][A-Z0-9_]*_\d+\]/gu;

const restoreLiteralPlaceholders = (
  text: string,
  restoreMap: ReadonlyMap<string, string>,
): string => {
  let result = text;
  for (const [sentinel, placeholder] of restoreMap) {
    result = result.replaceAll(sentinel, placeholder);
  }
  return result;
};

const protectLiteralPlaceholders = (
  text: string,
): {
  text: string;
  restore: (value: string) => string;
} => {
  const restoreMap = new Map<string, string>();
  let index = 0;
  const protectedText = text.replaceAll(PLACEHOLDER_TOKEN, (placeholder) => {
    const sentinel = `\uE000CHAT_PLACEHOLDER_${index}\uE001`;
    restoreMap.set(sentinel, placeholder);
    index += 1;
    return sentinel;
  });

  return {
    text: protectedText,
    restore: (value) => restoreLiteralPlaceholders(value, restoreMap),
  };
};

type NativeRedaction = {
  redactedText: string;
  redactionMap: Map<string, string>;
  operatorMap: Map<string, OperatorType>;
  entityCount: number;
};

const PLACEHOLDER_LABEL = /^\[(?<label>[A-Z][A-Z0-9_]*)_\d+\]$/u;

const parsePlaceholderLabel = (placeholder: string): string | null => {
  const match = PLACEHOLDER_LABEL.exec(placeholder);
  return match?.groups?.["label"] ?? null;
};

const normalizeEntityLabelForPlaceholder = (label: string): string =>
  label.trim().toUpperCase().replaceAll(/\s+/gu, "_");

/**
 * Build the public {@link ChatAnonResult} from a (possibly already
 * filtered) entity list and its matching redaction. Pairs are keyed
 * off `redactionMap` (placeholder -> original), which only contains
 * reversible ("replace") entries; the placeholder prefix disambiguates
 * entities that share text but have different labels.
 */
const toChatAnonResult = (
  resolvedEntities: readonly NativePipelineEntity[],
  redaction: Pick<
    NativeRedaction,
    "redactedText" | "redactionMap" | "entityCount"
  >,
): ChatAnonResult => {
  const pairs: ChatAnonPair[] = [...redaction.redactionMap.entries()].map(
    ([placeholder, original]) => {
      const placeholderLabel = parsePlaceholderLabel(placeholder);
      const matchingEntity = resolvedEntities.find(
        (entity) =>
          entity.text === original &&
          normalizeEntityLabelForPlaceholder(entity.label) === placeholderLabel,
      );
      return {
        placeholder,
        original,
        label: matchingEntity?.label ?? "misc",
      };
    },
  );

  return {
    redactedText: redaction.redactedText,
    pairs,
    redactionMap: redaction.redactionMap,
    entityCount: redaction.entityCount,
  };
};

/**
 * Post-hoc selective revert for the user's never-anonymize
 * allowlist. Detection and redaction are now a single combined
 * native call (`pipeline.redactText`), so excluded entities can no
 * longer be filtered out *before* redaction the way the old TS
 * pipeline did: every entity is detected, numbered, and redacted
 * first. Afterwards, any entity whose normalized text matches an
 * excluded canonical has its placeholder reverted back to the
 * original text — the same restore the CLI's `--revert` flag does —
 * and is dropped from `pairs` / `redactionMap` / `entityCount`. This
 * keeps the *observable* result identical to the old pre-redaction
 * filter, though the placeholder numbers assigned to the remaining
 * (non-excluded) entities may now differ, since the native pipeline
 * still counts the excluded ones while allocating placeholders.
 */
const applyExcludedCanonicals = ({
  deanonymiseText,
  excludedCanonicals,
  resolvedEntities,
  redaction,
}: {
  deanonymiseText: typeof deanonymise;
  excludedCanonicals: readonly string[] | undefined;
  resolvedEntities: readonly NativePipelineEntity[];
  redaction: NativeRedaction;
}): ChatAnonResult => {
  if (excludedCanonicals === undefined || excludedCanonicals.length === 0) {
    return toChatAnonResult(resolvedEntities, redaction);
  }

  const excludedSet = new Set(excludedCanonicals.map(normalizeForExclusion));
  const revertMap = new Map<string, string>();
  for (const [placeholder, original] of redaction.redactionMap) {
    if (excludedSet.has(normalizeForExclusion(original))) {
      revertMap.set(placeholder, original);
    }
  }

  if (revertMap.size === 0) {
    return toChatAnonResult(resolvedEntities, redaction);
  }

  const redactedText = deanonymiseText(redaction.redactedText, revertMap);
  const redactionMap = new Map(
    [...redaction.redactionMap].filter(
      ([placeholder]) => !revertMap.has(placeholder),
    ),
  );
  const remainingEntities = resolvedEntities.filter(
    (entity) => !excludedSet.has(normalizeForExclusion(entity.text)),
  );
  // Occurrence-based approximation: `entityCount` reports redacted
  // *occurrences*, while `revertMap` is keyed per distinct
  // placeholder. Subtracting the excluded occurrence count (rather
  // than the reverted placeholder count) keeps parity with the old
  // pipeline when the same excluded value appears more than once.
  const excludedOccurrences =
    resolvedEntities.length - remainingEntities.length;

  return toChatAnonResult(remainingEntities, {
    redactedText,
    redactionMap,
    entityCount: Math.max(0, redaction.entityCount - excludedOccurrences),
  });
};

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
   * Surface forms the caller has marked as never-anonymize. After
   * the combined detect+redact call, any entity whose normalized
   * text matches one of these (NFKC + lowercase, collapsed
   * whitespace) has its redaction reverted; see
   * {@link applyExcludedCanonicals}.
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
  const config: PipelineConfig = {
    ...buildChatAnonPipelineConfig({
      hasGazetteer: gazetteerEntries.length > 0,
      locale,
      workspaceId,
    }),
    dictionaries,
  };

  const binding = await runtime.getBinding();
  const pipeline = await runtime.createNativePipelineFromConfig({
    binding,
    config,
    gazetteerEntries,
    context,
  });
  const protectedInput = protectLiteralPlaceholders(text);
  const { resolvedEntities, redaction } = pipeline.redactText(
    protectedInput.text,
  );

  const result = applyExcludedCanonicals({
    deanonymiseText: runtime.deanonymise,
    excludedCanonicals,
    resolvedEntities,
    redaction,
  });
  return {
    ...result,
    redactedText: protectedInput.restore(result.redactedText),
  };
};
