import type { NativePreparedSearchConfig } from "./native-search-config";
import type { OperatorSelection, OperatorType } from "./types";

export type { NativePreparedSearchConfig } from "./native-search-config";

type NativeBindingOperatorConfig = {
  operators?: Record<string, OperatorSelection>;
  redactString?: string;
};

type NativeBindingCallerRedactionOptions = {
  requestJson: string;
  operators?: NativeBindingOperatorConfig;
};

type NativeBindingSessionCallerRedactionInput = {
  fullText: string;
  requestJson: string;
};

type NativeBindingSessionCallerRedactionPlanOptions = {
  inputs: NativeBindingSessionCallerRedactionInput[];
  operators?: NativeBindingOperatorConfig;
  observedAtEpochSeconds?: number;
};

type NativeBindingOpenSessionArchiveOptions = {
  archive: Uint8Array;
  key: Uint8Array;
  expectedSessionId: string;
  observedAtEpochSeconds?: number;
};

export type NativeDiagnosticsBatchCallback = (diagnosticsJson: string) => void;
export type NativeResultEventCallback = (eventJson: string) => void;

type NativeBindingRedactionEntry = {
  placeholder: string;
  original: string;
};

type NativeBindingOperatorEntry = {
  placeholder: string;
  operator: OperatorType;
};

type NativeBindingPipelineEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
  source: string;
  sourceDetail?: string | null;
  providerId?: string | null;
  detectionId?: string | null;
};

type NativeBindingRedactionResult = {
  redactedText: string;
  redactionMap: NativeBindingRedactionEntry[];
  operatorMap: NativeBindingOperatorEntry[];
  entityCount: number;
};

type NativeBindingStaticRedactionResult = {
  resolvedEntities: NativeBindingPipelineEntity[];
  redaction: NativeBindingRedactionResult;
};

type CanonicalPipelineEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
  source: string;
  source_detail?: string | null;
  provider_id?: string | null;
  detection_id?: string | null;
};

type CanonicalStaticRedactionResult = {
  resolved_entities: CanonicalPipelineEntity[];
  redaction: {
    redacted_text: string;
    redaction_map: NativeBindingRedactionEntry[];
    operator_map: NativeBindingOperatorEntry[];
    entity_count: number;
  };
};

type CanonicalSessionMetadata = {
  session_id: string;
  created_at_epoch_seconds: number | null;
  expires_at_epoch_seconds: number | null;
  mapping_count: number;
  status: NativeSessionStatus;
};

type CanonicalSessionDeletionSummary = {
  session_id: string;
  deleted_mapping_count: number;
};

type CanonicalSessionRedactionPlanResult = {
  replacements: Array<{
    start: number;
    end: number;
    replacement: string;
  }>;
  entity_count: number;
  caller_entity_count: number;
};

export type NativeSessionStatus =
  | "active"
  | "not_yet_active"
  | "expired"
  | "deleted";

export type NativeSessionLifecycle = {
  createdAtEpochSeconds: number;
  expiresAtEpochSeconds?: number;
};

export type NativeSessionMetadata = {
  sessionId: string;
  createdAtEpochSeconds: number | null;
  expiresAtEpochSeconds: number | null;
  mappingCount: number;
  status: NativeSessionStatus;
};

export type NativeSessionDeletionSummary = {
  sessionId: string;
  deletedMappingCount: number;
};

export type NativeSessionRedactionAtOptions = {
  fullText: string;
  observedAtEpochSeconds: number;
  operators?: NativeOperatorConfig;
};

export type NativeCreateSessionWithLifecycleOptions = NativeSessionLifecycle & {
  sessionId: string;
};

export type NativeOpenSessionArchiveOptions = {
  archive: Uint8Array;
  key: Uint8Array;
  expectedSessionId: string;
  observedAtEpochSeconds?: number;
};

export type NativePreparedRedactionSessionBinding = {
  sessionId: () => string;
  mappingCount: () => number;
  restoreText: (fullText: string) => string;
  restoreTextAt: (fullText: string, observedAtEpochSeconds: number) => string;
  toPlaintextJson: () => string;
  toPlaintextJsonAt: (observedAtEpochSeconds: number) => string;
  toEncryptedArchive: (key: Uint8Array) => Uint8Array;
  toEncryptedArchiveAt: (
    key: Uint8Array,
    observedAtEpochSeconds: number,
  ) => Uint8Array;
  inspectJson: (observedAtEpochSeconds?: number) => string;
  deleteJson: () => string;
  redactStaticEntitiesJson: (
    fullText: string,
    operators?: NativeBindingOperatorConfig,
  ) => string;
  redactStaticEntitiesJsonAt: (
    fullText: string,
    observedAtEpochSeconds: number,
    operators?: NativeBindingOperatorConfig,
  ) => string;
  planStaticEntitiesWithCallerDetections: (
    options: NativeBindingSessionCallerRedactionPlanOptions,
  ) => NativePreparedSessionRedactionPlanBinding;
};

export type NativePreparedSessionRedactionPlanBinding = {
  resultJson: () => string;
  commit: () => void;
};

export type NativePreparedSearchBinding = {
  prepareDiagnosticsJson: () => string;
  warmLazyRegex: () => void;
  warmLazyRegexDiagnosticsJson: () => string;
  createRedactionSession: (
    sessionId: string,
  ) => NativePreparedRedactionSessionBinding;
  createRedactionSessionWithLifecycle: (
    sessionId: string,
    createdAtEpochSeconds: number,
    expiresAtEpochSeconds?: number,
  ) => NativePreparedRedactionSessionBinding;
  restoreRedactionSession: (
    plaintextJson: string,
  ) => NativePreparedRedactionSessionBinding;
  restoreEncryptedRedactionSession: (
    options: NativeBindingOpenSessionArchiveOptions,
  ) => NativePreparedRedactionSessionBinding;
  redactStaticEntities: (
    fullText: string,
    operators?: NativeBindingOperatorConfig,
  ) => NativeBindingStaticRedactionResult;
  redactStaticEntitiesJson: (
    fullText: string,
    operators?: NativeBindingOperatorConfig,
  ) => string;
  redactStaticEntitiesWithCallerDetectionsJson: (
    fullText: string,
    options: NativeBindingCallerRedactionOptions,
  ) => string;
  redactStaticEntitiesWithCallerDetectionsDiagnosticsJson: (
    fullText: string,
    options: NativeBindingCallerRedactionOptions,
  ) => string;
  redactStaticEntitiesResultStreamJson: (
    fullText: string,
    operators: NativeBindingOperatorConfig | undefined,
    onEvent: NativeResultEventCallback,
  ) => string;
  redactStaticEntitiesDiagnosticsJson: (
    fullText: string,
    operators?: NativeBindingOperatorConfig,
  ) => string;
  redactStaticEntitiesDiagnosticsStreamJson: (
    fullText: string,
    operators: NativeBindingOperatorConfig | undefined,
    onBatch: NativeDiagnosticsBatchCallback,
  ) => string;
  redactStaticEntitiesSummaryDiagnosticsJson: (
    fullText: string,
    operators?: NativeBindingOperatorConfig,
  ) => string;
};

export type NativeAnonymizeBinding = {
  convertExternalDetectionBatch: (
    document: Uint8Array,
    batchJson: string,
  ) => NativeCallerDetection[];
  externalDetectionLimitsJson: () => string;
  extractDocxTextJson: (document: Uint8Array) => string;
  inspectPdfJson: (document: Uint8Array, observationsJson?: string) => string;
  rewritePdfRasterFromDetectionsJson: (
    document: Uint8Array,
    requestJson: string,
    pagePixels: readonly Uint8Array[],
  ) => { document: Uint8Array; certificateJson: string };
  rewriteDocxTextNative: (
    document: Uint8Array,
    rewritesJson: string,
  ) => {
    document: Uint8Array;
    rewrittenBlockCount: number;
    appliedReplacementCount: number;
  };
  planDocxRestorationJson: (document: Uint8Array, sessionId: string) => string;
  normalizeForSearch: (text: string) => string;
  nativePackageVersion: () => string;
  NativePreparedSearch: {
    fromConfigJsonBytes: (
      configJson: Uint8Array,
    ) => NativePreparedSearchBinding;
    fromPreparedPackageBytes: (
      packageBytes: Uint8Array,
    ) => NativePreparedSearchBinding;
    fromPreparedPackageBytesWithoutCache: (
      packageBytes: Uint8Array,
    ) => NativePreparedSearchBinding;
    fromTrustedPreparedPackageBytes: (
      packageBytes: Uint8Array,
    ) => NativePreparedSearchBinding;
    fromTrustedPreparedPackageBytesWithoutCache: (
      packageBytes: Uint8Array,
    ) => NativePreparedSearchBinding;
  };
  prepareStaticSearchPackageBytes: (configJson: Uint8Array) => Uint8Array;
  prepareStaticSearchCompressedPackageBytes: (
    configJson: Uint8Array,
  ) => Uint8Array;
  // Rust config assembler (replaces the retired TypeScript config-assembly
  // layer). Takes the pipeline config plus out-of-band dictionaries and
  // gazetteer JSON and returns either the assembled config JSON or ready
  // package bytes. Every parity runtime must expose these required members.
  assembleStaticSearchConfigJson: (
    pipelineConfigJson: Uint8Array,
    dictionariesJson?: Uint8Array,
    gazetteerJson?: Uint8Array,
  ) => Uint8Array;
  assembleStaticSearchPackageBytes: (
    pipelineConfigJson: Uint8Array,
    dictionariesJson?: Uint8Array,
    gazetteerJson?: Uint8Array,
  ) => Uint8Array;
  assembleStaticSearchCompressedPackageBytes: (
    pipelineConfigJson: Uint8Array,
    dictionariesJson?: Uint8Array,
    gazetteerJson?: Uint8Array,
  ) => Uint8Array;
};

type FunctionMemberNames<T> = {
  [Key in keyof T]-?: T[Key] extends (...args: never[]) => unknown
    ? Key
    : never;
}[keyof T];

/** Exhaustive runtime-member contract shared by loaders and parity gates. */
export const NATIVE_BINDING_PARITY_MEMBERS = {
  root: [
    "convertExternalDetectionBatch",
    "externalDetectionLimitsJson",
    "extractDocxTextJson",
    "inspectPdfJson",
    "rewritePdfRasterFromDetectionsJson",
    "rewriteDocxTextNative",
    "planDocxRestorationJson",
    "normalizeForSearch",
    "nativePackageVersion",
    "prepareStaticSearchPackageBytes",
    "prepareStaticSearchCompressedPackageBytes",
    "assembleStaticSearchConfigJson",
    "assembleStaticSearchPackageBytes",
    "assembleStaticSearchCompressedPackageBytes",
  ],
  factories: [
    "fromConfigJsonBytes",
    "fromPreparedPackageBytes",
    "fromPreparedPackageBytesWithoutCache",
    "fromTrustedPreparedPackageBytes",
    "fromTrustedPreparedPackageBytesWithoutCache",
  ],
  prepared: [
    "prepareDiagnosticsJson",
    "warmLazyRegex",
    "warmLazyRegexDiagnosticsJson",
    "createRedactionSession",
    "createRedactionSessionWithLifecycle",
    "restoreRedactionSession",
    "restoreEncryptedRedactionSession",
    "redactStaticEntities",
    "redactStaticEntitiesJson",
    "redactStaticEntitiesWithCallerDetectionsJson",
    "redactStaticEntitiesWithCallerDetectionsDiagnosticsJson",
    "redactStaticEntitiesResultStreamJson",
    "redactStaticEntitiesDiagnosticsJson",
    "redactStaticEntitiesDiagnosticsStreamJson",
    "redactStaticEntitiesSummaryDiagnosticsJson",
  ],
  session: [
    "sessionId",
    "mappingCount",
    "restoreText",
    "restoreTextAt",
    "toPlaintextJson",
    "toPlaintextJsonAt",
    "toEncryptedArchive",
    "toEncryptedArchiveAt",
    "inspectJson",
    "deleteJson",
    "redactStaticEntitiesJson",
    "redactStaticEntitiesJsonAt",
    "planStaticEntitiesWithCallerDetections",
  ],
  plan: ["resultJson", "commit"],
} as const satisfies {
  root: readonly FunctionMemberNames<NativeAnonymizeBinding>[];
  factories: readonly FunctionMemberNames<
    NativeAnonymizeBinding["NativePreparedSearch"]
  >[];
  prepared: readonly FunctionMemberNames<NativePreparedSearchBinding>[];
  session: readonly FunctionMemberNames<NativePreparedRedactionSessionBinding>[];
  plan: readonly FunctionMemberNames<NativePreparedSessionRedactionPlanBinding>[];
};

const ROOT_PARITY_IS_EXHAUSTIVE: Exclude<
  FunctionMemberNames<NativeAnonymizeBinding>,
  (typeof NATIVE_BINDING_PARITY_MEMBERS.root)[number]
> extends never
  ? true
  : never = true;
const FACTORY_PARITY_IS_EXHAUSTIVE: Exclude<
  FunctionMemberNames<NativeAnonymizeBinding["NativePreparedSearch"]>,
  (typeof NATIVE_BINDING_PARITY_MEMBERS.factories)[number]
> extends never
  ? true
  : never = true;
const PREPARED_PARITY_IS_EXHAUSTIVE: Exclude<
  FunctionMemberNames<NativePreparedSearchBinding>,
  (typeof NATIVE_BINDING_PARITY_MEMBERS.prepared)[number]
> extends never
  ? true
  : never = true;
const SESSION_PARITY_IS_EXHAUSTIVE: Exclude<
  FunctionMemberNames<NativePreparedRedactionSessionBinding>,
  (typeof NATIVE_BINDING_PARITY_MEMBERS.session)[number]
> extends never
  ? true
  : never = true;
const PLAN_PARITY_IS_EXHAUSTIVE: Exclude<
  FunctionMemberNames<NativePreparedSessionRedactionPlanBinding>,
  (typeof NATIVE_BINDING_PARITY_MEMBERS.plan)[number]
> extends never
  ? true
  : never = true;
void [
  ROOT_PARITY_IS_EXHAUSTIVE,
  FACTORY_PARITY_IS_EXHAUSTIVE,
  PREPARED_PARITY_IS_EXHAUSTIVE,
  SESSION_PARITY_IS_EXHAUSTIVE,
  PLAN_PARITY_IS_EXHAUSTIVE,
];

const isBindingPropertyBag = (
  value: unknown,
): value is Record<string, unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/** Validate the complete runtime-neutral root and factory binding shape. */
export const isNativeAnonymizeBinding = (
  candidate: unknown,
): candidate is NativeAnonymizeBinding => {
  if (!isBindingPropertyBag(candidate)) {
    return false;
  }
  if (
    !NATIVE_BINDING_PARITY_MEMBERS.root.every(
      (name) => typeof candidate[name] === "function",
    )
  ) {
    return false;
  }
  const preparedSearch = candidate["NativePreparedSearch"];
  return (
    isBindingPropertyBag(preparedSearch) &&
    NATIVE_BINDING_PARITY_MEMBERS.factories.every(
      (name) => typeof preparedSearch[name] === "function",
    )
  );
};

export type NativeOperatorConfig = {
  operators?: Record<string, OperatorSelection>;
  redactString?: string;
};

export const CALLER_DETECTION_CONTRACT_VERSION = 2;

export const EXTERNAL_DETECTION_BATCH_VERSION = 1 as const;
export const EXTERNAL_DETECTION_BATCH_MAX_BYTES = 16 * 1024 * 1024;
export const EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024;
export const EXTERNAL_DETECTION_MAX_DETECTIONS = 100_000;
export const EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS = 4_096;
export const EXTERNAL_DETECTION_MAX_METADATA_BYTES = 256;
export const EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES = 128;

export const EXTERNAL_DETECTION_OFFSET_UNITS = {
  unicodeCodePoint: "unicode-code-point",
  utf16CodeUnit: "utf16-code-unit",
  utf8Byte: "utf8-byte",
} as const;

export type ExternalDetectionOffsetUnit =
  (typeof EXTERNAL_DETECTION_OFFSET_UNITS)[keyof typeof EXTERNAL_DETECTION_OFFSET_UNITS];

export type ExternalDetectionBatch = {
  version: typeof EXTERNAL_DETECTION_BATCH_VERSION;
  document: { sha256: string };
  offsetUnit: ExternalDetectionOffsetUnit;
  provider: { id: string; name: string; version: string };
  labelMap: readonly {
    providerLabel: string;
    entityLabel: string;
  }[];
  detections: readonly {
    id: string;
    start: number;
    end: number;
    label: string;
    score: number;
  }[];
};

export type NativeCallerDetection = {
  start: number;
  end: number;
  label: string;
  score: number;
  providerId: string;
  detectionId: string;
};

export type ConvertExternalDetectionBatchOptions = {
  binding: NativeAnonymizeBinding;
  document: Uint8Array;
  batch: ExternalDetectionBatch | string;
};

export const convert_external_detection_batch = ({
  binding,
  document,
  batch,
}: ConvertExternalDetectionBatchOptions): NativeCallerDetection[] => {
  return binding.convertExternalDetectionBatch(
    document,
    typeof batch === "string" ? batch : JSON.stringify(batch),
  );
};

export type NativeCallerRedactionOptions = {
  detections: readonly NativeCallerDetection[];
  operators?: NativeOperatorConfig;
};

export type NativeSessionCallerRedactionInput = {
  fullText: string;
  detections: readonly NativeCallerDetection[];
};

export type NativeSessionCallerRedactionPlanOptions = {
  inputs: readonly NativeSessionCallerRedactionInput[];
  operators?: NativeOperatorConfig;
  observedAtEpochSeconds?: number;
};

export type NativeTextReplacement = {
  start: number;
  end: number;
  replacement: string;
};

export type NativeSessionBlockRedactionPlan = {
  replacements: readonly NativeTextReplacement[];
  entityCount: number;
  callerEntityCount: number;
};

const callerDetectionRequestJson = (
  detections: readonly NativeCallerDetection[],
): string =>
  JSON.stringify({
    version: CALLER_DETECTION_CONTRACT_VERSION,
    detections: detections.map((detection) => ({
      start: detection.start,
      end: detection.end,
      label: detection.label,
      score: detection.score,
      provider_id: detection.providerId,
      detection_id: detection.detectionId,
    })),
  });

export type NativePipelineEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
  source: string;
  sourceDetail?: string;
  providerId?: string;
  detectionId?: string;
};

export type NativeRedactionResult = {
  redactedText: string;
  redactionMap: Map<string, string>;
  operatorMap: Map<string, OperatorType>;
  entityCount: number;
};

export type NativeStaticRedactionResult = {
  resolvedEntities: NativePipelineEntity[];
  redaction: NativeRedactionResult;
};

export type NativeSearchPackageOptions = {
  binding: NativeAnonymizeBinding;
  config: NativePreparedSearchConfig;
  compressed?: boolean;
};

export type NativeSearchPackageInput =
  | NativePreparedSearchConfig
  | string
  | Uint8Array;

export type SharedNativeSearchPackageOptions = {
  binding: NativeAnonymizeBinding;
  config: NativeSearchPackageInput;
  compressed?: boolean;
};

export type SharedNativePreparedPackageOptions = {
  binding: NativeAnonymizeBinding;
  packageBytes: Uint8Array;
};

export type SharedNativeRedactTextJsonOptions = {
  binding: NativeAnonymizeBinding;
  config: NativeSearchPackageInput;
  fullText: string;
  operators?: NativeOperatorConfig;
};

export type SharedNativeRedactTextOptions = SharedNativeRedactTextJsonOptions;

export type SharedNativeDiagnosticsJsonOptions =
  SharedNativeRedactTextJsonOptions;

export type SharedNativeDiagnosticsStreamJsonOptions =
  SharedNativeRedactTextJsonOptions & {
    onBatch: NativeDiagnosticsBatchCallback;
  };

export type SharedNativeRedactTextStreamJsonOptions =
  SharedNativeRedactTextJsonOptions & {
    onEvent: NativeResultEventCallback;
  };

export type NativeNormalizeOptions = {
  binding: NativeAnonymizeBinding;
  text: string;
};

export type NativeAnonymizerFromConfigOptions = {
  binding: NativeAnonymizeBinding;
  config: NativePreparedSearchConfig;
};

export type NativeAnonymizerFromPackageOptions = {
  binding: NativeAnonymizeBinding;
  packageBytes: Uint8Array;
};

export type NativePipelineFromPackageOptions =
  NativeAnonymizerFromPackageOptions;

export type NativeBindingVersionOptions = {
  binding: NativeAnonymizeBinding;
  expectedVersion: string;
};

export class PreparedNativeRedactionSession {
  readonly #session: NativePreparedRedactionSessionBinding;

  constructor(session: NativePreparedRedactionSessionBinding) {
    this.#session = session;
  }

  sessionId(): string {
    return this.#session.sessionId();
  }

  session_id(): string {
    return this.sessionId();
  }

  mappingCount(): number {
    return this.#session.mappingCount();
  }

  mapping_count(): number {
    return this.mappingCount();
  }

  restoreText(fullText: string, observedAtEpochSeconds?: number): string {
    if (observedAtEpochSeconds === undefined) {
      return this.#session.restoreText(fullText);
    }
    return this.#session.restoreTextAt(fullText, observedAtEpochSeconds);
  }

  restore_text(fullText: string, observedAtEpochSeconds?: number): string {
    return this.restoreText(fullText, observedAtEpochSeconds);
  }

  toPlaintextJson(): string {
    return this.#session.toPlaintextJson();
  }

  to_plaintext_json(): string {
    return this.toPlaintextJson();
  }

  toPlaintextJsonAt(observedAtEpochSeconds: number): string {
    return this.#session.toPlaintextJsonAt(observedAtEpochSeconds);
  }

  to_plaintext_json_at(observedAtEpochSeconds: number): string {
    return this.toPlaintextJsonAt(observedAtEpochSeconds);
  }

  toEncryptedArchive(key: Uint8Array): Uint8Array {
    return this.#session.toEncryptedArchive(key);
  }

  to_encrypted_archive(key: Uint8Array): Uint8Array {
    return this.toEncryptedArchive(key);
  }

  toEncryptedArchiveAt(
    key: Uint8Array,
    observedAtEpochSeconds: number,
  ): Uint8Array {
    return this.#session.toEncryptedArchiveAt(key, observedAtEpochSeconds);
  }

  to_encrypted_archive_at(
    key: Uint8Array,
    observedAtEpochSeconds: number,
  ): Uint8Array {
    return this.toEncryptedArchiveAt(key, observedAtEpochSeconds);
  }

  inspect(observedAtEpochSeconds?: number): NativeSessionMetadata {
    const metadata: CanonicalSessionMetadata = JSON.parse(
      this.#session.inspectJson(observedAtEpochSeconds),
    );
    return {
      sessionId: metadata.session_id,
      createdAtEpochSeconds: metadata.created_at_epoch_seconds,
      expiresAtEpochSeconds: metadata.expires_at_epoch_seconds,
      mappingCount: metadata.mapping_count,
      status: metadata.status,
    };
  }

  delete(): NativeSessionDeletionSummary {
    const summary: CanonicalSessionDeletionSummary = JSON.parse(
      this.#session.deleteJson(),
    );
    return {
      sessionId: summary.session_id,
      deletedMappingCount: summary.deleted_mapping_count,
    };
  }

  redactStaticEntities(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    const result: CanonicalStaticRedactionResult = JSON.parse(
      this.redact_text_json(fullText, operators),
    );
    return fromCanonicalStaticRedactionResult(result);
  }

  redactText(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return this.redactStaticEntities(fullText, operators);
  }

  redact_text(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return this.redactText(fullText, operators);
  }

  redactTextJson(fullText: string, operators?: NativeOperatorConfig): string {
    return this.redact_text_json(fullText, operators);
  }

  redact_text_json(fullText: string, operators?: NativeOperatorConfig): string {
    return this.#session.redactStaticEntitiesJson(
      fullText,
      toBindingOperatorConfig(operators),
    );
  }

  redactStaticEntitiesAt(
    options: NativeSessionRedactionAtOptions,
  ): NativeStaticRedactionResult {
    const result: CanonicalStaticRedactionResult = JSON.parse(
      this.redactTextJsonAt(options),
    );
    return fromCanonicalStaticRedactionResult(result);
  }

  redactTextAt(
    options: NativeSessionRedactionAtOptions,
  ): NativeStaticRedactionResult {
    return this.redactStaticEntitiesAt(options);
  }

  redact_text_at(
    options: NativeSessionRedactionAtOptions,
  ): NativeStaticRedactionResult {
    return this.redactTextAt(options);
  }

  redact_static_entities_at(
    options: NativeSessionRedactionAtOptions,
  ): NativeStaticRedactionResult {
    return this.redactStaticEntitiesAt(options);
  }

  redactTextJsonAt({
    fullText,
    observedAtEpochSeconds,
    operators,
  }: NativeSessionRedactionAtOptions): string {
    return this.#session.redactStaticEntitiesJsonAt(
      fullText,
      observedAtEpochSeconds,
      toBindingOperatorConfig(operators),
    );
  }

  redact_text_json_at(options: NativeSessionRedactionAtOptions): string {
    return this.redactTextJsonAt(options);
  }

  planTextBatchWithCallerDetections({
    inputs,
    operators,
    observedAtEpochSeconds,
  }: NativeSessionCallerRedactionPlanOptions): PreparedNativeSessionRedactionPlan {
    const bindingOperators = toBindingOperatorConfig(operators);
    const bindingPlan = this.#session.planStaticEntitiesWithCallerDetections({
      inputs: inputs.map(({ detections, fullText }) => ({
        fullText,
        requestJson: callerDetectionRequestJson(detections),
      })),
      ...(bindingOperators === undefined
        ? {}
        : { operators: bindingOperators }),
      ...(observedAtEpochSeconds === undefined
        ? {}
        : { observedAtEpochSeconds }),
    });
    return new PreparedNativeSessionRedactionPlan(bindingPlan);
  }
}

export class PreparedNativeSessionRedactionPlan {
  readonly blocks: readonly NativeSessionBlockRedactionPlan[];
  readonly #plan: NativePreparedSessionRedactionPlanBinding;

  constructor(plan: NativePreparedSessionRedactionPlanBinding) {
    this.#plan = plan;
    const blocks: CanonicalSessionRedactionPlanResult[] = JSON.parse(
      plan.resultJson(),
    );
    this.blocks = blocks.map(
      ({ caller_entity_count, entity_count, replacements }) => ({
        replacements,
        entityCount: entity_count,
        callerEntityCount: caller_entity_count,
      }),
    );
  }

  commit(): void {
    this.#plan.commit();
  }
}

export class PreparedNativeAnonymizer {
  readonly #prepared: NativePreparedSearchBinding;

  constructor(prepared: NativePreparedSearchBinding) {
    this.#prepared = prepared;
  }

  prepareDiagnosticsJson(): string {
    return this.#prepared.prepareDiagnosticsJson();
  }

  prepare_diagnostics_json(): string {
    return this.prepareDiagnosticsJson();
  }

  warmLazyRegex(): void {
    this.#prepared.warmLazyRegex();
  }

  warm_lazy_regex(): void {
    this.warmLazyRegex();
  }

  warmLazyRegexDiagnosticsJson(): string {
    return this.#prepared.warmLazyRegexDiagnosticsJson();
  }

  warm_lazy_regex_diagnostics_json(): string {
    return this.warmLazyRegexDiagnosticsJson();
  }

  createRedactionSession(sessionId: string): PreparedNativeRedactionSession {
    return new PreparedNativeRedactionSession(
      this.#prepared.createRedactionSession(sessionId),
    );
  }

  create_redaction_session(sessionId: string): PreparedNativeRedactionSession {
    return this.createRedactionSession(sessionId);
  }

  createRedactionSessionWithLifecycle({
    sessionId,
    createdAtEpochSeconds,
    expiresAtEpochSeconds,
  }: NativeCreateSessionWithLifecycleOptions): PreparedNativeRedactionSession {
    return new PreparedNativeRedactionSession(
      this.#prepared.createRedactionSessionWithLifecycle(
        sessionId,
        createdAtEpochSeconds,
        expiresAtEpochSeconds,
      ),
    );
  }

  create_redaction_session_with_lifecycle(
    options: NativeCreateSessionWithLifecycleOptions,
  ): PreparedNativeRedactionSession {
    return this.createRedactionSessionWithLifecycle(options);
  }

  restoreRedactionSession(
    plaintextJson: string,
  ): PreparedNativeRedactionSession {
    return new PreparedNativeRedactionSession(
      this.#prepared.restoreRedactionSession(plaintextJson),
    );
  }

  restore_redaction_session(
    plaintextJson: string,
  ): PreparedNativeRedactionSession {
    return this.restoreRedactionSession(plaintextJson);
  }

  restoreEncryptedRedactionSession({
    archive,
    key,
    expectedSessionId,
    observedAtEpochSeconds,
  }: NativeOpenSessionArchiveOptions): PreparedNativeRedactionSession {
    return new PreparedNativeRedactionSession(
      this.#prepared.restoreEncryptedRedactionSession({
        archive,
        key,
        expectedSessionId,
        ...(observedAtEpochSeconds === undefined
          ? {}
          : { observedAtEpochSeconds }),
      }),
    );
  }

  restore_encrypted_redaction_session(
    options: NativeOpenSessionArchiveOptions,
  ): PreparedNativeRedactionSession {
    return this.restoreEncryptedRedactionSession(options);
  }

  redactStaticEntities(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return toNativeStaticRedactionResult(
      this.#prepared.redactStaticEntities(
        fullText,
        toBindingOperatorConfig(operators),
      ),
    );
  }

  redact_text(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return this.redactStaticEntities(fullText, operators);
  }

  redact_text_json(fullText: string, operators?: NativeOperatorConfig): string {
    const bindingOperators = toBindingOperatorConfig(operators);
    return this.#prepared.redactStaticEntitiesJson(fullText, bindingOperators);
  }

  redactStaticEntitiesWithCallerDetections(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): NativeStaticRedactionResult {
    const requestJson = callerDetectionRequestJson(options.detections);
    const operators = toBindingOperatorConfig(options.operators);
    const result: CanonicalStaticRedactionResult = JSON.parse(
      this.#prepared.redactStaticEntitiesWithCallerDetectionsJson(fullText, {
        requestJson,
        ...(operators ? { operators } : {}),
      }),
    );
    return fromCanonicalStaticRedactionResult(result);
  }

  redact_text_with_caller_detections(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): NativeStaticRedactionResult {
    return this.redactStaticEntitiesWithCallerDetections(fullText, options);
  }

  redactStaticEntitiesWithCallerDetectionsDiagnosticsJson(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): string {
    const requestJson = callerDetectionRequestJson(options.detections);
    const operators = toBindingOperatorConfig(options.operators);
    return this.#prepared.redactStaticEntitiesWithCallerDetectionsDiagnosticsJson(
      fullText,
      {
        requestJson,
        ...(operators ? { operators } : {}),
      },
    );
  }

  redact_static_entities_with_caller_detections_diagnostics_json(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): string {
    return this.redactStaticEntitiesWithCallerDetectionsDiagnosticsJson(
      fullText,
      options,
    );
  }

  redactTextJson(fullText: string, operators?: NativeOperatorConfig): string {
    return this.redact_text_json(fullText, operators);
  }

  redactTextStreamJson(
    fullText: string,
    onEvent: NativeResultEventCallback,
    operators?: NativeOperatorConfig,
  ): string {
    return this.#prepared.redactStaticEntitiesResultStreamJson(
      fullText,
      toBindingOperatorConfig(operators),
      onEvent,
    );
  }

  redact_text_stream_json(
    fullText: string,
    onEvent: NativeResultEventCallback,
    operators?: NativeOperatorConfig,
  ): string {
    return this.redactTextStreamJson(fullText, onEvent, operators);
  }

  redactStaticEntitiesDiagnosticsJson(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string {
    return this.#prepared.redactStaticEntitiesDiagnosticsJson(
      fullText,
      toBindingOperatorConfig(operators),
    );
  }

  diagnostics_json(fullText: string, operators?: NativeOperatorConfig): string {
    return this.redactStaticEntitiesDiagnosticsJson(fullText, operators);
  }

  diagnosticsStreamJson(
    fullText: string,
    onBatch: NativeDiagnosticsBatchCallback,
    operators?: NativeOperatorConfig,
  ): string {
    return this.#prepared.redactStaticEntitiesDiagnosticsStreamJson(
      fullText,
      toBindingOperatorConfig(operators),
      onBatch,
    );
  }

  diagnostics_stream_json(
    fullText: string,
    onBatch: NativeDiagnosticsBatchCallback,
    operators?: NativeOperatorConfig,
  ): string {
    return this.diagnosticsStreamJson(fullText, onBatch, operators);
  }

  redactStaticEntitiesSummaryDiagnosticsJson(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string {
    return this.#prepared.redactStaticEntitiesSummaryDiagnosticsJson(
      fullText,
      toBindingOperatorConfig(operators),
    );
  }

  summary_diagnostics_json(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string {
    return this.redactStaticEntitiesSummaryDiagnosticsJson(fullText, operators);
  }
}

export class PreparedNativePipeline {
  readonly #anonymizer: PreparedNativeAnonymizer;

  constructor(anonymizer: PreparedNativeAnonymizer) {
    this.#anonymizer = anonymizer;
  }

  prepareDiagnosticsJson(): string {
    return this.#anonymizer.prepareDiagnosticsJson();
  }

  prepare_diagnostics_json(): string {
    return this.prepareDiagnosticsJson();
  }

  warmLazyRegex(): void {
    this.#anonymizer.warmLazyRegex();
  }

  warm_lazy_regex(): void {
    this.warmLazyRegex();
  }

  warmLazyRegexDiagnosticsJson(): string {
    return this.#anonymizer.warmLazyRegexDiagnosticsJson();
  }

  warm_lazy_regex_diagnostics_json(): string {
    return this.warmLazyRegexDiagnosticsJson();
  }

  createRedactionSession(sessionId: string): PreparedNativeRedactionSession {
    return this.#anonymizer.createRedactionSession(sessionId);
  }

  create_redaction_session(sessionId: string): PreparedNativeRedactionSession {
    return this.createRedactionSession(sessionId);
  }

  createRedactionSessionWithLifecycle(
    options: NativeCreateSessionWithLifecycleOptions,
  ): PreparedNativeRedactionSession {
    return this.#anonymizer.createRedactionSessionWithLifecycle(options);
  }

  create_redaction_session_with_lifecycle(
    options: NativeCreateSessionWithLifecycleOptions,
  ): PreparedNativeRedactionSession {
    return this.createRedactionSessionWithLifecycle(options);
  }

  restoreRedactionSession(
    plaintextJson: string,
  ): PreparedNativeRedactionSession {
    return this.#anonymizer.restoreRedactionSession(plaintextJson);
  }

  restore_redaction_session(
    plaintextJson: string,
  ): PreparedNativeRedactionSession {
    return this.restoreRedactionSession(plaintextJson);
  }

  restoreEncryptedRedactionSession(
    options: NativeOpenSessionArchiveOptions,
  ): PreparedNativeRedactionSession {
    return this.#anonymizer.restoreEncryptedRedactionSession(options);
  }

  restore_encrypted_redaction_session(
    options: NativeOpenSessionArchiveOptions,
  ): PreparedNativeRedactionSession {
    return this.restoreEncryptedRedactionSession(options);
  }

  redactText(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return this.#anonymizer.redactStaticEntities(fullText, operators);
  }

  redact_text(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return this.redactText(fullText, operators);
  }

  redact_text_json(fullText: string, operators?: NativeOperatorConfig): string {
    return this.#anonymizer.redact_text_json(fullText, operators);
  }

  redactTextWithCallerDetections(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): NativeStaticRedactionResult {
    return this.#anonymizer.redactStaticEntitiesWithCallerDetections(
      fullText,
      options,
    );
  }

  redact_text_with_caller_detections(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): NativeStaticRedactionResult {
    return this.redactTextWithCallerDetections(fullText, options);
  }

  redactTextWithCallerDetectionsDiagnosticsJson(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): string {
    return this.#anonymizer.redactStaticEntitiesWithCallerDetectionsDiagnosticsJson(
      fullText,
      options,
    );
  }

  redact_text_with_caller_detections_diagnostics_json(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): string {
    return this.redactTextWithCallerDetectionsDiagnosticsJson(
      fullText,
      options,
    );
  }

  redactTextJson(fullText: string, operators?: NativeOperatorConfig): string {
    return this.redact_text_json(fullText, operators);
  }

  redactTextStreamJson(
    fullText: string,
    onEvent: NativeResultEventCallback,
    operators?: NativeOperatorConfig,
  ): string {
    return this.#anonymizer.redactTextStreamJson(fullText, onEvent, operators);
  }

  redact_text_stream_json(
    fullText: string,
    onEvent: NativeResultEventCallback,
    operators?: NativeOperatorConfig,
  ): string {
    return this.redactTextStreamJson(fullText, onEvent, operators);
  }

  redactTextDiagnosticsJson(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string {
    return this.#anonymizer.redactStaticEntitiesDiagnosticsJson(
      fullText,
      operators,
    );
  }

  diagnostics_json(fullText: string, operators?: NativeOperatorConfig): string {
    return this.redactTextDiagnosticsJson(fullText, operators);
  }

  diagnosticsStreamJson(
    fullText: string,
    onBatch: NativeDiagnosticsBatchCallback,
    operators?: NativeOperatorConfig,
  ): string {
    return this.#anonymizer.diagnosticsStreamJson(fullText, onBatch, operators);
  }

  diagnostics_stream_json(
    fullText: string,
    onBatch: NativeDiagnosticsBatchCallback,
    operators?: NativeOperatorConfig,
  ): string {
    return this.diagnosticsStreamJson(fullText, onBatch, operators);
  }

  redactTextSummaryDiagnosticsJson(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string {
    return this.#anonymizer.redactStaticEntitiesSummaryDiagnosticsJson(
      fullText,
      operators,
    );
  }

  summary_diagnostics_json(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string {
    return this.redactTextSummaryDiagnosticsJson(fullText, operators);
  }
}

export const encodeNativeSearchConfig = (
  config: NativePreparedSearchConfig,
): Uint8Array => new TextEncoder().encode(JSON.stringify(config));

export const encodeNativeSearchConfigInput = (
  config: NativeSearchPackageInput,
): Uint8Array => {
  if (typeof config === "string") {
    return new TextEncoder().encode(config);
  }
  if (config instanceof Uint8Array) {
    return config;
  }
  return encodeNativeSearchConfig(config);
};

export const getNativeBindingVersion = (
  binding: NativeAnonymizeBinding,
): string => binding.nativePackageVersion();

export const native_package_version = getNativeBindingVersion;

export const normalize_for_search = ({
  binding,
  text,
}: NativeNormalizeOptions): string => binding.normalizeForSearch(text);

export const assertNativeBindingVersion = ({
  binding,
  expectedVersion,
}: NativeBindingVersionOptions): void => {
  const actualVersion = getNativeBindingVersion(binding);
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Native anonymize binding version ${actualVersion} does not match ${expectedVersion}`,
    );
  }
};

export const prepareNativeSearchPackage = ({
  binding,
  config,
  compressed = false,
}: NativeSearchPackageOptions): Uint8Array => {
  const configBytes = encodeNativeSearchConfig(config);
  return compressed
    ? binding.prepareStaticSearchCompressedPackageBytes(configBytes)
    : binding.prepareStaticSearchPackageBytes(configBytes);
};

export const prepare_search_package = ({
  binding,
  config,
  compressed = false,
}: SharedNativeSearchPackageOptions): Uint8Array => {
  const configBytes = encodeNativeSearchConfigInput(config);
  return compressed
    ? binding.prepareStaticSearchCompressedPackageBytes(configBytes)
    : binding.prepareStaticSearchPackageBytes(configBytes);
};

export const createNativeAnonymizerFromConfig = ({
  binding,
  config,
}: NativeAnonymizerFromConfigOptions): PreparedNativeAnonymizer =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfig(config),
    ),
  );

export const createNativeAnonymizerFromPackage = ({
  binding,
  packageBytes,
}: NativeAnonymizerFromPackageOptions): PreparedNativeAnonymizer =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromPreparedPackageBytes(packageBytes),
  );

export const load_prepared_package = ({
  binding,
  packageBytes,
}: SharedNativePreparedPackageOptions): PreparedNativeAnonymizer =>
  createNativeAnonymizerFromPackage({ binding, packageBytes });

export const redact_text_json = ({
  binding,
  config,
  fullText,
  operators,
}: SharedNativeRedactTextJsonOptions): string =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfigInput(config),
    ),
  ).redact_text_json(fullText, operators);

export const redact_text = ({
  binding,
  config,
  fullText,
  operators,
}: SharedNativeRedactTextOptions): NativeStaticRedactionResult =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfigInput(config),
    ),
  ).redact_text(fullText, operators);

export const redact_text_stream_json = ({
  binding,
  config,
  fullText,
  operators,
  onEvent,
}: SharedNativeRedactTextStreamJsonOptions): string =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfigInput(config),
    ),
  ).redact_text_stream_json(fullText, onEvent, operators);

export const diagnostics_json = ({
  binding,
  config,
  fullText,
  operators,
}: SharedNativeDiagnosticsJsonOptions): string =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfigInput(config),
    ),
  ).diagnostics_json(fullText, operators);

export const diagnostics_stream_json = ({
  binding,
  config,
  fullText,
  operators,
  onBatch,
}: SharedNativeDiagnosticsStreamJsonOptions): string =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfigInput(config),
    ),
  ).diagnostics_stream_json(fullText, onBatch, operators);

export const summary_diagnostics_json = ({
  binding,
  config,
  fullText,
  operators,
}: SharedNativeDiagnosticsJsonOptions): string =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfigInput(config),
    ),
  ).summary_diagnostics_json(fullText, operators);

export const createNativePipelineFromPackage = ({
  binding,
  packageBytes,
}: NativePipelineFromPackageOptions): PreparedNativePipeline =>
  new PreparedNativePipeline(
    createNativeAnonymizerFromPackage({ binding, packageBytes }),
  );

export const PreparedSearch = PreparedNativeAnonymizer;
export type PreparedSearch = PreparedNativeAnonymizer;
export const PreparedAnonymizer = PreparedNativeAnonymizer;
export type PreparedAnonymizer = PreparedNativeAnonymizer;

const toBindingOperatorConfig = (
  config: NativeOperatorConfig | undefined,
): NativeBindingOperatorConfig | undefined => {
  if (!config) {
    return undefined;
  }
  const bindingConfig: NativeBindingOperatorConfig = {};
  if (config.operators !== undefined) {
    bindingConfig.operators = config.operators;
  }
  if (config.redactString !== undefined) {
    bindingConfig.redactString = config.redactString;
  }
  return bindingConfig;
};

const toNativeStaticRedactionResult = (
  result: NativeBindingStaticRedactionResult,
): NativeStaticRedactionResult => ({
  resolvedEntities: result.resolvedEntities.map(toNativePipelineEntity),
  redaction: toNativeRedactionResult(result.redaction),
});

const fromCanonicalStaticRedactionResult = (
  result: CanonicalStaticRedactionResult,
): NativeStaticRedactionResult => ({
  resolvedEntities: result.resolved_entities.map(
    ({ source_detail, provider_id, detection_id, ...entity }) => ({
      ...entity,
      ...(source_detail ? { sourceDetail: source_detail } : {}),
      ...(provider_id ? { providerId: provider_id } : {}),
      ...(detection_id ? { detectionId: detection_id } : {}),
    }),
  ),
  redaction: {
    redactedText: result.redaction.redacted_text,
    redactionMap: toRedactionMap(result.redaction.redaction_map),
    operatorMap: toOperatorMap(result.redaction.operator_map),
    entityCount: result.redaction.entity_count,
  },
});

const toNativePipelineEntity = (
  entity: NativeBindingPipelineEntity,
): NativePipelineEntity => ({
  start: entity.start,
  end: entity.end,
  label: entity.label,
  text: entity.text,
  score: entity.score,
  source: entity.source,
  ...(entity.sourceDetail ? { sourceDetail: entity.sourceDetail } : {}),
  ...(entity.providerId ? { providerId: entity.providerId } : {}),
  ...(entity.detectionId ? { detectionId: entity.detectionId } : {}),
});

const toNativeRedactionResult = (
  result: NativeBindingRedactionResult,
): NativeRedactionResult => ({
  redactedText: result.redactedText,
  redactionMap: toRedactionMap(result.redactionMap),
  operatorMap: toOperatorMap(result.operatorMap),
  entityCount: result.entityCount,
});

const toRedactionMap = (
  entries: readonly NativeBindingRedactionEntry[],
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const entry of entries) {
    map.set(entry.placeholder, entry.original);
  }
  return map;
};

const toOperatorMap = (
  entries: readonly NativeBindingOperatorEntry[],
): Map<string, OperatorType> => {
  const map = new Map<string, OperatorType>();
  for (const entry of entries) {
    map.set(entry.placeholder, entry.operator);
  }
  return map;
};
