import { panic } from "better-result";
import * as v from "valibot";

import type {
  createNativePipelineFromConfig,
  createPipelineContext,
  deanonymise,
  DefaultEntityLabel,
  getBinding,
  GazetteerEntry,
  NativePipelineEntity,
  OperatorType,
  PipelineConfig,
  SupportedLanguage,
} from "@stll/anonymize-wasm";

/**
 * Default entity labels supported by the anonymization pipeline.
 *
 * Keep this constant here, rather than importing the wasm package at
 * runtime, so browser code can use the shared chat config without
 * pulling the wasm module onto the main thread just for constants.
 * The compile-time completeness check below preserves parity with the WASM
 * package without loading the WASM module on the browser main thread.
 */
const DEFAULT_CHAT_ANON_ENTITY_LABEL_VALUES = [
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
  "case number",
  "credit card number",
  "passport number",
  "crypto",
  "monetary amount",
  "land parcel",
  "misc",
] as const satisfies readonly DefaultEntityLabel[];

type MissingDefaultChatAnonEntityLabel = Exclude<
  DefaultEntityLabel,
  (typeof DEFAULT_CHAT_ANON_ENTITY_LABEL_VALUES)[number]
>;

true satisfies MissingDefaultChatAnonEntityLabel extends never ? true : never;

export const DEFAULT_CHAT_ANON_ENTITY_LABELS =
  DEFAULT_CHAT_ANON_ENTITY_LABEL_VALUES;

/** Maximum exact values one anonymization call may force into detection. */
export const FORCED_SENSITIVE_VALUES_MAX = 256;

/** Maximum UTF-16 length of one forced sensitive value. */
export const FORCED_SENSITIVE_VALUE_MAX_LENGTH = 4096;

const FORCED_SENSITIVE_DEFAULT_LABEL = "misc" satisfies DefaultEntityLabel;
const FORCED_SENSITIVE_PLACEHOLDER_ESCAPE_LABEL =
  "case number" satisfies DefaultEntityLabel;

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

export const CHAT_SEND_MODES = ["anonymized", "rawOverride"] as const;

export type ChatSendMode = (typeof CHAT_SEND_MODES)[number];

export const CHAT_SEND_MODE = {
  anonymized: "anonymized",
  rawOverride: "rawOverride",
} as const satisfies { [TMode in ChatSendMode]: TMode };

export const chatSendModeSchema = v.picklist(CHAT_SEND_MODES);

export const isChatSendMode = (value: unknown): value is ChatSendMode =>
  v.is(chatSendModeSchema, value);

export const getPreferredChatSendMode = (anonymized: boolean): ChatSendMode =>
  anonymized ? CHAT_SEND_MODE.anonymized : CHAT_SEND_MODE.rawOverride;

export const CHAT_TRANSPORT_ERROR_CODE = {
  thirdPartyBoundaryRefusal: "third_party_boundary_refusal",
} as const;

const CHAT_TRANSPORT_ERROR_CODE_VALUES = [
  CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
] as const;

type ChatTransportErrorCodeValue =
  (typeof CHAT_TRANSPORT_ERROR_CODE)[keyof typeof CHAT_TRANSPORT_ERROR_CODE];
type MissingChatTransportErrorCode = Exclude<
  ChatTransportErrorCodeValue,
  (typeof CHAT_TRANSPORT_ERROR_CODE_VALUES)[number]
>;

true satisfies MissingChatTransportErrorCode extends never ? true : never;

export const CHAT_TRANSPORT_ERROR_CODES = CHAT_TRANSPORT_ERROR_CODE_VALUES;

export const chatTransportErrorCodeSchema = v.picklist(
  CHAT_TRANSPORT_ERROR_CODES,
);
export type ChatTransportErrorCode = ChatTransportErrorCodeValue;

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

type ChatAnonPipeline = Pick<
  Awaited<ReturnType<typeof createNativePipelineFromConfig>>,
  "redactText"
>;

type ChatAnonPipelineOptions<TBinding, TPipelineContext> = Omit<
  Parameters<typeof createNativePipelineFromConfig>[0],
  "binding" | "context"
> & {
  binding: TBinding;
  context: TPipelineContext;
};

/**
 * Runtime seam the browser WASM or server-native entry injects into
 * {@link runChatAnonPipeline}. `createNativePipelineFromConfig`
 * assembles (or reuses, via `context`) a prepared native pipeline
 * for a config + gazetteer; `redactText` on the resulting pipeline
 * runs detection and redaction as ONE combined call — there is no
 * separate detect-then-redact step anymore.
 */
export type ChatAnonRuntime<
  TBinding = Awaited<ReturnType<typeof getBinding>>,
  TPipelineContext = ReturnType<typeof createPipelineContext>,
  TPipeline extends ChatAnonPipeline = Awaited<
    ReturnType<typeof createNativePipelineFromConfig>
  >,
> = {
  getBinding: () => Promise<TBinding> | TBinding;
  createNativePipelineFromConfig: (
    options: ChatAnonPipelineOptions<TBinding, TPipelineContext>,
  ) => Promise<TPipeline> | TPipeline;
  createPipelineContext: () => TPipelineContext;
  deanonymise: typeof deanonymise;
};

// Keep this runtime value local so importing the shared chat contract on the
// browser main thread does not pull in the WASM entrypoint. The two type checks
// make additions or removals in the upstream supported-language union fail the
// build until this list follows them.
const CHAT_ANON_SUPPORTED_LANGUAGES = [
  "cs",
  "de",
  "en",
  "es",
  "fr",
  "hu",
  "it",
  "lv",
  "pl",
  "pt-br",
  "ro",
  "sk",
  "sv",
] as const satisfies readonly SupportedLanguage[];

type MissingChatAnonSupportedLanguage = Exclude<
  SupportedLanguage,
  (typeof CHAT_ANON_SUPPORTED_LANGUAGES)[number]
>;

true satisfies MissingChatAnonSupportedLanguage extends never ? true : never;

const supportedPipelineLanguages: ReadonlySet<string> = new Set(
  CHAT_ANON_SUPPORTED_LANGUAGES,
);

const isSupportedPipelineLanguage = (
  language: string,
): language is SupportedLanguage => supportedPipelineLanguages.has(language);

export const normalizeChatAnonLocaleLanguage = (
  locale: string | undefined,
): SupportedLanguage | null => {
  const normalized = locale?.trim().toLowerCase().replaceAll("_", "-");
  if (!normalized) {
    return null;
  }
  const subtags = normalized.split("-");
  while (subtags.length > 0) {
    const candidate = subtags.join("-");
    if (isSupportedPipelineLanguage(candidate)) {
      return candidate;
    }
    subtags.pop();
  }
  return null;
};

export const buildChatAnonPipelineConfig = ({
  hasGazetteer,
  locale,
  workspaceId,
  enableDenyList = false,
  denyListCountries,
  standaloneStreetDetection,
}: {
  hasGazetteer: boolean;
  locale?: string | undefined;
  workspaceId: string;
  /**
   * Opt in to the deny-list detection layer (Places, orgs, courts,
   * …). Off by default: the chat→AI path stays light (names + regex
   * + coreference + legal-forms) and keeps low-sensitivity context
   * like city names. Enable it — together with the matching
   * dictionaries — when the caller wants place/deny-list coverage,
   * e.g. a capability showcase.
   */
  enableDenyList?: boolean | undefined;
  /**
   * Country codes whose deny-list/city dictionaries the caller has
   * loaded. Only meaningful when `enableDenyList` is on.
   */
  denyListCountries?: readonly string[] | undefined;
  /**
   * Opt in to detecting a street with a house number even when no
   * known city anchors it ("14 Rue de la Paix"). Off by default —
   * mirrors the engine's own default.
   */
  standaloneStreetDetection?: PipelineConfig["standaloneStreetDetection"];
}): PipelineConfig => {
  const nameCorpusLanguage = normalizeChatAnonLocaleLanguage(locale);
  const config: PipelineConfig = {
    threshold: 0.4,
    enableTriggerPhrases: true,
    enableRegex: true,
    enableNameCorpus: true,
    enableDenyList,
    enableGazetteer: hasGazetteer,
    enableConfidenceBoost: false,
    enableCoreference: true,
    enableLegalForms: true,
    labels: [...DEFAULT_CHAT_ANON_ENTITY_LABELS],
    workspaceId,
  };
  if (nameCorpusLanguage !== null) {
    config.nameCorpusLanguages = [nameCorpusLanguage];
  }
  if (denyListCountries !== undefined && denyListCountries.length > 0) {
    config.denyListCountries = [...denyListCountries];
  }
  if (standaloneStreetDetection !== undefined) {
    config.standaloneStreetDetection = standaloneStreetDetection;
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
const PLACEHOLDER_LABEL = /^\[(?<label>[A-Z][A-Z0-9_]*)_\d+\]$/u;

/**
 * Return the distinct anonymization placeholders found in text, in first-seen
 * order. Hosts can combine placeholders from source text and a redaction map
 * to reject unknown tokens before restoring a provider response.
 */
export const findChatAnonPlaceholders = (text: string): string[] => {
  const placeholders = text.match(PLACEHOLDER_TOKEN);
  if (placeholders === null) {
    return [];
  }
  return [...new Set(placeholders)];
};

const parsePlaceholderLabel = (placeholder: string): string | null => {
  const match = PLACEHOLDER_LABEL.exec(placeholder);
  return match?.groups?.["label"] ?? null;
};

const normalizeEntityLabelForPlaceholder = (label: string): string =>
  label.trim().toUpperCase().replaceAll(/\s+/gu, "_");

const LITERAL_PLACEHOLDER_SENTINEL_RANGES = [
  { end: 0xf8_ff, start: 0xe0_00 },
  { end: 0xf_ff_fd, start: 0xf_00_00 },
  { end: 0x10_ff_fd, start: 0x10_00_00 },
] as const;

type LiteralPlaceholderSentinelCursor = {
  codePoint: number;
  rangeIndex: number;
};

const allocateLiteralPlaceholderSentinel = ({
  blockedValues,
  cursor,
  text,
}: {
  blockedValues: ReadonlySet<string>;
  cursor: LiteralPlaceholderSentinelCursor;
  text: string;
}): string => {
  while (cursor.rangeIndex < LITERAL_PLACEHOLDER_SENTINEL_RANGES.length) {
    const range = LITERAL_PLACEHOLDER_SENTINEL_RANGES.at(cursor.rangeIndex);
    if (range === undefined) {
      break;
    }
    if (cursor.codePoint > range.end) {
      cursor.rangeIndex += 1;
      const nextRange = LITERAL_PLACEHOLDER_SENTINEL_RANGES.at(
        cursor.rangeIndex,
      );
      if (nextRange !== undefined) {
        cursor.codePoint = nextRange.start;
      }
      continue;
    }

    const sentinel = String.fromCodePoint(cursor.codePoint);
    cursor.codePoint += 1;
    if (text.includes(sentinel)) {
      continue;
    }

    let overlapsBlockedValue = false;
    for (const blockedValue of blockedValues) {
      if (blockedValue.includes(sentinel) || sentinel.includes(blockedValue)) {
        overlapsBlockedValue = true;
        break;
      }
    }
    if (!overlapsBlockedValue) {
      return sentinel;
    }
  }

  throw new RangeError("literal placeholder sentinel space exhausted");
};

const restoreLiteralPlaceholders = (
  text: string,
  restoreMap: ReadonlyMap<string, string>,
): string => {
  let result = text;
  for (const [sentinel, placeholder] of restoreMap) {
    result = result.replaceAll(sentinel, () => placeholder);
  }
  return result;
};

const spanOverlapsLiteralValue = ({
  end,
  start,
  text,
  values,
}: {
  end: number;
  start: number;
  text: string;
  values: ReadonlySet<string>;
}): boolean => {
  for (const value of values) {
    const valueOffset = text.lastIndexOf(value, end - 1);
    if (valueOffset !== -1 && valueOffset + value.length > start) {
      return true;
    }
  }
  return false;
};

const protectLiteralPlaceholders = ({
  detectorVisibleValues,
  forcedSensitiveValues,
  text,
}: {
  detectorVisibleValues: ReadonlySet<string>;
  forcedSensitiveValues: ReadonlySet<string>;
  text: string;
}): {
  sourcePlaceholders: ReadonlySet<string>;
  text: string;
  restore: (value: string) => string;
} => {
  const restoreMap = new Map<string, string>();
  const sourcePlaceholders = new Set<string>();
  const cursor: LiteralPlaceholderSentinelCursor = {
    codePoint: LITERAL_PLACEHOLDER_SENTINEL_RANGES[0].start,
    rangeIndex: 0,
  };
  const protectedText = text.replaceAll(
    PLACEHOLDER_TOKEN,
    (placeholder, offset: number) => {
      sourcePlaceholders.add(placeholder);
      if (
        spanOverlapsLiteralValue({
          end: offset + placeholder.length,
          start: offset,
          text,
          values: forcedSensitiveValues,
        })
      ) {
        return placeholder;
      }

      const sentinel = allocateLiteralPlaceholderSentinel({
        blockedValues: detectorVisibleValues,
        cursor,
        text,
      });
      restoreMap.set(sentinel, placeholder);
      return sentinel;
    },
  );

  return {
    sourcePlaceholders,
    text: protectedText,
    restore: (value) => restoreLiteralPlaceholders(value, restoreMap),
  };
};

const forcedSensitiveGazetteerEntries = ({
  forcedSensitiveValues,
  text,
  workspaceId,
}: {
  forcedSensitiveValues: readonly string[];
  text: string;
  workspaceId: string;
}): GazetteerEntry[] => {
  if (forcedSensitiveValues.length > FORCED_SENSITIVE_VALUES_MAX) {
    throw new RangeError(
      `forcedSensitiveValues exceeds ${String(FORCED_SENSITIVE_VALUES_MAX)} entries`,
    );
  }

  const values = new Set<string>();
  for (const value of forcedSensitiveValues) {
    if (value.length > FORCED_SENSITIVE_VALUE_MAX_LENGTH) {
      throw new RangeError(
        `forced sensitive value exceeds ${String(FORCED_SENSITIVE_VALUE_MAX_LENGTH)} characters`,
      );
    }
    if (value.length > 0 && text.includes(value)) {
      values.add(value);
    }
  }

  return [...values]
    .toSorted((left, right) => right.length - left.length)
    .map((canonical, index) => {
      const label =
        parsePlaceholderLabel(canonical) ===
        normalizeEntityLabelForPlaceholder(FORCED_SENSITIVE_DEFAULT_LABEL)
          ? FORCED_SENSITIVE_PLACEHOLDER_ESCAPE_LABEL
          : FORCED_SENSITIVE_DEFAULT_LABEL;
      return {
        id: `forced-sensitive-${String(index + 1)}`,
        canonical,
        label,
        variants: [],
        workspaceId,
        createdAt: 0,
        source: "manual",
      };
    });
};

const gazetteerExactValues = (
  entries: readonly GazetteerEntry[],
): ReadonlySet<string> => {
  const values = new Set<string>();
  for (const entry of entries) {
    if (entry.canonical.length > 0) {
      values.add(entry.canonical);
    }
    for (const variant of entry.variants) {
      if (variant.length > 0) {
        values.add(variant);
      }
    }
  }
  return values;
};

type NativeRedaction = {
  redactedText: string;
  redactionMap: Map<string, string>;
  operatorMap: Map<string, OperatorType>;
  entityCount: number;
};

const rekeyReservedPlaceholderCollisions = ({
  redaction,
  reservedPlaceholders,
}: {
  redaction: NativeRedaction;
  reservedPlaceholders: ReadonlySet<string>;
}): NativeRedaction => {
  if (
    ![...redaction.redactionMap.keys()].some((placeholder) =>
      reservedPlaceholders.has(placeholder),
    )
  ) {
    return redaction;
  }

  const blocked = new Set([
    ...reservedPlaceholders,
    ...redaction.redactionMap.keys(),
  ]);
  const redactionMap = new Map<string, string>();
  const operatorMap = new Map(redaction.operatorMap);
  let redactedText = redaction.redactedText;

  for (const [placeholder, original] of redaction.redactionMap) {
    let replacement = placeholder;
    if (reservedPlaceholders.has(placeholder)) {
      const label =
        parsePlaceholderLabel(placeholder) ??
        panic("native redaction emitted an invalid placeholder");
      let index = 1;
      replacement = `[${label}_${String(index)}]`;
      while (blocked.has(replacement)) {
        index += 1;
        replacement = `[${label}_${String(index)}]`;
      }
      blocked.add(replacement);
      redactedText = redactedText.replaceAll(placeholder, () => replacement);
      const operator = operatorMap.get(placeholder);
      operatorMap.delete(placeholder);
      if (operator !== undefined) {
        operatorMap.set(replacement, operator);
      }
    }

    redactionMap.set(replacement, original);
  }

  return {
    entityCount: redaction.entityCount,
    operatorMap,
    redactedText,
    redactionMap,
  };
};

const assertForcedSensitiveValuesRedacted = ({
  forcedSensitiveValues,
  redaction,
  resolvedEntities,
  sourceText,
}: {
  forcedSensitiveValues: ReadonlySet<string>;
  redaction: Pick<NativeRedaction, "redactionMap">;
  resolvedEntities: readonly NativePipelineEntity[];
  sourceText: string;
}): void => {
  for (const forcedValue of forcedSensitiveValues) {
    const occurrences: { end: number; start: number }[] = [];
    let offset = sourceText.indexOf(forcedValue);
    while (offset !== -1) {
      occurrences.push({ end: offset + forcedValue.length, start: offset });
      offset = sourceText.indexOf(forcedValue, offset + 1);
    }

    const fullyCovered = occurrences.filter((occurrence) =>
      resolvedEntities.some(
        (entity) =>
          entity.start <= occurrence.start && entity.end >= occurrence.end,
      ),
    );
    for (const occurrence of occurrences) {
      const overlapsCoveredOccurrence = fullyCovered.some(
        (covered) =>
          covered.start < occurrence.end && occurrence.start < covered.end,
      );
      if (!overlapsCoveredOccurrence) {
        panic("forced sensitive value remained after anonymization");
      }
    }
  }

  for (const [placeholder, original] of redaction.redactionMap) {
    if (placeholder === original && forcedSensitiveValues.has(original)) {
      panic("forced sensitive value became its own placeholder");
    }
  }
};

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
  forcedSensitiveValues,
  resolvedEntities,
  redaction,
  sourceText,
}: {
  deanonymiseText: typeof deanonymise;
  excludedCanonicals: readonly string[] | undefined;
  forcedSensitiveValues: ReadonlySet<string>;
  resolvedEntities: readonly NativePipelineEntity[];
  redaction: NativeRedaction;
  sourceText: string;
}): ChatAnonResult => {
  if (excludedCanonicals === undefined || excludedCanonicals.length === 0) {
    return toChatAnonResult(resolvedEntities, redaction);
  }

  const excludedSet = new Set(excludedCanonicals.map(normalizeForExclusion));
  const isForcedEntity = (entity: NativePipelineEntity) =>
    spanOverlapsLiteralValue({
      end: entity.end,
      start: entity.start,
      text: sourceText,
      values: forcedSensitiveValues,
    });

  const revertMap = new Map<string, string>();
  for (const [placeholder, original] of redaction.redactionMap) {
    const isExcluded = excludedSet.has(normalizeForExclusion(original));
    const hasForcedOccurrence = resolvedEntities.some(
      (entity) => entity.text === original && isForcedEntity(entity),
    );
    if (isExcluded && !hasForcedOccurrence) {
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
    (entity) =>
      !excludedSet.has(normalizeForExclusion(entity.text)) ||
      isForcedEntity(entity),
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

export const runChatAnonPipeline = async <
  TBinding,
  TPipelineContext,
  TPipeline extends ChatAnonPipeline,
>({
  context: providedContext,
  dictionaries,
  excludedCanonicals,
  forcedSensitiveValues = [],
  gazetteerEntries = [],
  runtime,
  text,
  locale,
  workspaceId,
  enableDenyList,
  denyListCountries,
  standaloneStreetDetection,
}: {
  runtime: ChatAnonRuntime<TBinding, TPipelineContext, TPipeline>;
  dictionaries: NonNullable<PipelineConfig["dictionaries"]>;
  text: string;
  locale?: string | undefined;
  workspaceId: string;
  gazetteerEntries?: GazetteerEntry[] | undefined;
  context?: TPipelineContext | undefined;
  /**
   * Exact non-empty values that must be detected even when the probabilistic
   * pipeline would not classify them. They share the native pipeline's single
   * placeholder allocation and override a matching allowlist entry.
   */
  forcedSensitiveValues?: readonly string[] | undefined;
  /** Opt in to deny-list detection; see {@link buildChatAnonPipelineConfig}. */
  enableDenyList?: boolean | undefined;
  /** Country codes whose deny-list/city dictionaries are loaded. */
  denyListCountries?: readonly string[] | undefined;
  /** Opt-in standalone street detection; see {@link buildChatAnonPipelineConfig}. */
  standaloneStreetDetection?: PipelineConfig["standaloneStreetDetection"];
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

  const forcedEntries = forcedSensitiveGazetteerEntries({
    forcedSensitiveValues,
    text,
    workspaceId,
  });
  const effectiveGazetteerEntries = [...gazetteerEntries, ...forcedEntries];

  const context = providedContext ?? runtime.createPipelineContext();
  const config: PipelineConfig = {
    ...buildChatAnonPipelineConfig({
      hasGazetteer: effectiveGazetteerEntries.length > 0,
      locale,
      workspaceId,
      enableDenyList,
      denyListCountries,
      standaloneStreetDetection,
    }),
    dictionaries,
  };

  const binding = await runtime.getBinding();
  const pipeline = await runtime.createNativePipelineFromConfig({
    binding,
    config,
    gazetteerEntries: effectiveGazetteerEntries,
    context,
  });
  const forcedSensitiveSet = new Set(
    forcedEntries.map(({ canonical }) => canonical),
  );
  const protectedInput = protectLiteralPlaceholders({
    detectorVisibleValues: gazetteerExactValues(effectiveGazetteerEntries),
    forcedSensitiveValues: forcedSensitiveSet,
    text,
  });
  const { resolvedEntities, redaction: nativeRedaction } = pipeline.redactText(
    protectedInput.text,
  );
  const redaction = rekeyReservedPlaceholderCollisions({
    redaction: nativeRedaction,
    reservedPlaceholders: protectedInput.sourcePlaceholders,
  });
  assertForcedSensitiveValuesRedacted({
    forcedSensitiveValues: forcedSensitiveSet,
    redaction,
    resolvedEntities,
    sourceText: protectedInput.text,
  });

  const result = applyExcludedCanonicals({
    deanonymiseText: runtime.deanonymise,
    excludedCanonicals,
    forcedSensitiveValues: forcedSensitiveSet,
    resolvedEntities,
    redaction,
    sourceText: protectedInput.text,
  });
  const redactedText = protectedInput.restore(result.redactedText);
  return {
    ...result,
    redactedText,
  };
};
