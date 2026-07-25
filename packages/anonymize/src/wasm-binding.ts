import type {
  NativeAnonymizeBinding,
  NativeCallerDetection,
  NativePreparedRedactionSessionBinding,
  NativePreparedSearchBinding,
  NativePreparedSessionRedactionPlanBinding,
} from "./native";
import type { OperatorType } from "./types";

type OperatorConfig = Parameters<
  NativePreparedSearchBinding["redactStaticEntities"]
>[1];
type BindingResult = ReturnType<
  NativePreparedSearchBinding["redactStaticEntities"]
>;

type RawPreparedSearch = {
  prepareDiagnosticsJson: () => string;
  warmLazyRegex: () => void;
  warmLazyRegexDiagnosticsJson: () => string;
  createRedactionSession: (sessionId: string) => RawRedactionSession;
  createRedactionSessionWithLifecycle: (
    sessionId: string,
    createdAtEpochSeconds: number,
    expiresAtEpochSeconds?: number,
  ) => RawRedactionSession;
  restoreRedactionSession: (plaintextJson: string) => RawRedactionSession;
  restoreEncryptedRedactionSession: (
    archive: Uint8Array,
    key: Uint8Array,
    expectedSessionId: string,
    observedAtEpochSeconds?: number,
  ) => RawRedactionSession;
  redactStaticEntitiesJson: (
    fullText: string,
    operatorsJson?: string,
  ) => string;
  redactStaticEntitiesWithCallerDetectionsJson: (
    fullText: string,
    requestJson: string,
    operatorsJson?: string,
  ) => string;
  redactStaticEntitiesWithCallerDetectionsDiagnosticsJson: (
    fullText: string,
    requestJson: string,
    operatorsJson?: string,
  ) => string;
  redactStaticEntitiesDiagnosticsJson: (
    fullText: string,
    operatorsJson?: string,
  ) => string;
  redactStaticEntitiesSummaryDiagnosticsJson: (
    fullText: string,
    operatorsJson?: string,
  ) => string;
  redactStaticEntitiesResultStreamJson: (
    fullText: string,
    operatorsJson: string | undefined,
    onEvent: (eventJson: string) => void,
  ) => string;
  redactStaticEntitiesDiagnosticsStreamJson: (
    fullText: string,
    operatorsJson: string | undefined,
    onBatch: (batchJson: string) => void,
  ) => string;
};

type RawRedactionSession = {
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
    operatorsJson?: string,
  ) => string;
  redactStaticEntitiesJsonAt: (
    fullText: string,
    observedAtEpochSeconds: number,
    operatorsJson?: string,
  ) => string;
  planStaticEntitiesWithCallerDetections: (
    inputsJson: string,
    operatorsJson?: string,
    observedAtEpochSeconds?: number,
  ) => RawRedactionPlan;
};

type RawRedactionPlan = {
  resultJson: () => string;
  commit: () => void;
};

type RawDocumentRewriteResult = {
  readonly document: Uint8Array;
  readonly rewrittenBlockCount: number;
  readonly appliedReplacementCount: number;
};

type RawPdfRasterResult = {
  readonly document: Uint8Array;
  readonly certificateJson: string;
};

export type RawWasmModule = {
  default: (input?: unknown) => Promise<unknown>;
  normalizeForSearch: (text: string) => string;
  nativePackageVersion: () => string;
  externalDetectionLimitsJson: () => string;
  convertExternalDetectionBatchJson: (
    document: Uint8Array,
    batchJson: string,
  ) => string;
  extractDocxTextJson: (document: Uint8Array) => string;
  rewriteDocxTextNative: (
    document: Uint8Array,
    rewritesJson: string,
  ) => RawDocumentRewriteResult;
  planDocxRestorationJson: (document: Uint8Array, sessionId: string) => string;
  inspectPdfJson: (document: Uint8Array, observationsJson?: string) => string;
  rewritePdfRasterFromDetectionsJson: (
    document: Uint8Array,
    requestJson: string,
    pagePixels: Uint8Array[],
  ) => RawPdfRasterResult;
  prepareStaticSearchPackageBytes: (configJson: Uint8Array) => Uint8Array;
  prepareStaticSearchCompressedPackageBytes: (
    configJson: Uint8Array,
  ) => Uint8Array;
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
  WasmPreparedSearch: {
    fromConfigJsonBytes: (configJson: Uint8Array) => RawPreparedSearch;
    fromPreparedPackageBytes: (packageBytes: Uint8Array) => RawPreparedSearch;
    fromTrustedPreparedPackageBytes: (
      packageBytes: Uint8Array,
    ) => RawPreparedSearch;
  };
};

type FunctionMemberNames<T> = {
  [Key in keyof T]-?: T[Key] extends (...args: never[]) => unknown
    ? Key
    : never;
}[keyof T];

export const RAW_WASM_MODULE_FUNCTION_MEMBERS = [
  "default",
  "normalizeForSearch",
  "nativePackageVersion",
  "externalDetectionLimitsJson",
  "convertExternalDetectionBatchJson",
  "extractDocxTextJson",
  "rewriteDocxTextNative",
  "planDocxRestorationJson",
  "inspectPdfJson",
  "rewritePdfRasterFromDetectionsJson",
  "prepareStaticSearchPackageBytes",
  "prepareStaticSearchCompressedPackageBytes",
  "assembleStaticSearchConfigJson",
  "assembleStaticSearchPackageBytes",
  "assembleStaticSearchCompressedPackageBytes",
] as const satisfies readonly FunctionMemberNames<RawWasmModule>[];

export const RAW_WASM_PREPARED_SEARCH_FACTORY_MEMBERS = [
  "fromConfigJsonBytes",
  "fromPreparedPackageBytes",
  "fromTrustedPreparedPackageBytes",
] as const satisfies readonly FunctionMemberNames<
  RawWasmModule["WasmPreparedSearch"]
>[];

const RAW_ROOT_EXPORTS_ARE_EXHAUSTIVE: Exclude<
  FunctionMemberNames<RawWasmModule>,
  (typeof RAW_WASM_MODULE_FUNCTION_MEMBERS)[number]
> extends never
  ? true
  : never = true;
const RAW_FACTORY_EXPORTS_ARE_EXHAUSTIVE: Exclude<
  FunctionMemberNames<RawWasmModule["WasmPreparedSearch"]>,
  (typeof RAW_WASM_PREPARED_SEARCH_FACTORY_MEMBERS)[number]
> extends never
  ? true
  : never = true;
void [RAW_ROOT_EXPORTS_ARE_EXHAUSTIVE, RAW_FACTORY_EXPORTS_ARE_EXHAUSTIVE];

const isPropertyBag = (value: unknown): value is Record<string, unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/** Validate every raw export consumed by the runtime adapter. */
export const isRawWasmModule = (value: unknown): value is RawWasmModule => {
  if (
    !isPropertyBag(value) ||
    !RAW_WASM_MODULE_FUNCTION_MEMBERS.every(
      (name) => typeof value[name] === "function",
    )
  ) {
    return false;
  }
  const preparedSearch = value["WasmPreparedSearch"];
  return (
    isPropertyBag(preparedSearch) &&
    typeof preparedSearch === "function" &&
    isPropertyBag(preparedSearch["prototype"]) &&
    RAW_WASM_PREPARED_SEARCH_FACTORY_MEMBERS.every(
      (name) => typeof preparedSearch[name] === "function",
    )
  );
};

export const createWasmBinding = (
  raw: RawWasmModule,
): NativeAnonymizeBinding => ({
  convertExternalDetectionBatch: (document, batchJson) => {
    const detections: Array<{
      start: number;
      end: number;
      label: string;
      score: number;
      provider_id: string;
      detection_id: string;
    }> = JSON.parse(raw.convertExternalDetectionBatchJson(document, batchJson));
    return detections.map(
      ({ start, end, label, score, provider_id, detection_id }) =>
        ({
          start,
          end,
          label,
          score,
          providerId: provider_id,
          detectionId: detection_id,
        }) satisfies NativeCallerDetection,
    );
  },
  externalDetectionLimitsJson: raw.externalDetectionLimitsJson,
  extractDocxTextJson: raw.extractDocxTextJson,
  inspectPdfJson: raw.inspectPdfJson,
  rewritePdfRasterFromDetectionsJson: (document, requestJson, pagePixels) => {
    assertPdfPixelPages(pagePixels);
    const result = raw.rewritePdfRasterFromDetectionsJson(
      document,
      requestJson,
      [...pagePixels],
    );
    return {
      document: result.document,
      certificateJson: result.certificateJson,
    };
  },
  rewriteDocxTextNative: (document, rewritesJson) => {
    const result = raw.rewriteDocxTextNative(document, rewritesJson);
    return {
      document: result.document,
      rewrittenBlockCount: result.rewrittenBlockCount,
      appliedReplacementCount: result.appliedReplacementCount,
    };
  },
  planDocxRestorationJson: raw.planDocxRestorationJson,
  normalizeForSearch: raw.normalizeForSearch,
  nativePackageVersion: raw.nativePackageVersion,
  NativePreparedSearch: {
    fromConfigJsonBytes: (bytes) =>
      wrapPrepared(raw.WasmPreparedSearch.fromConfigJsonBytes(bytes)),
    fromPreparedPackageBytes: (bytes) =>
      wrapPrepared(raw.WasmPreparedSearch.fromPreparedPackageBytes(bytes)),
    fromPreparedPackageBytesWithoutCache: (bytes) =>
      wrapPrepared(raw.WasmPreparedSearch.fromPreparedPackageBytes(bytes)),
    fromTrustedPreparedPackageBytes: (bytes) =>
      wrapPrepared(
        raw.WasmPreparedSearch.fromTrustedPreparedPackageBytes(bytes),
      ),
    fromTrustedPreparedPackageBytesWithoutCache: (bytes) =>
      wrapPrepared(
        raw.WasmPreparedSearch.fromTrustedPreparedPackageBytes(bytes),
      ),
  },
  prepareStaticSearchPackageBytes: raw.prepareStaticSearchPackageBytes,
  prepareStaticSearchCompressedPackageBytes:
    raw.prepareStaticSearchCompressedPackageBytes,
  assembleStaticSearchConfigJson: raw.assembleStaticSearchConfigJson,
  assembleStaticSearchPackageBytes: raw.assembleStaticSearchPackageBytes,
  assembleStaticSearchCompressedPackageBytes:
    raw.assembleStaticSearchCompressedPackageBytes,
});

const wrapPrepared = (raw: RawPreparedSearch): NativePreparedSearchBinding => ({
  prepareDiagnosticsJson: raw.prepareDiagnosticsJson.bind(raw),
  warmLazyRegex: raw.warmLazyRegex.bind(raw),
  warmLazyRegexDiagnosticsJson: raw.warmLazyRegexDiagnosticsJson.bind(raw),
  createRedactionSession: (sessionId) =>
    wrapSession(raw.createRedactionSession(sessionId)),
  createRedactionSessionWithLifecycle: (
    sessionId,
    createdAtEpochSeconds,
    expiresAtEpochSeconds,
  ) =>
    wrapSession(
      raw.createRedactionSessionWithLifecycle(
        sessionId,
        createdAtEpochSeconds,
        expiresAtEpochSeconds,
      ),
    ),
  restoreRedactionSession: (plaintextJson) =>
    wrapSession(raw.restoreRedactionSession(plaintextJson)),
  restoreEncryptedRedactionSession: ({
    archive,
    key,
    expectedSessionId,
    observedAtEpochSeconds,
  }) =>
    wrapSession(
      raw.restoreEncryptedRedactionSession(
        archive,
        key,
        expectedSessionId,
        observedAtEpochSeconds,
      ),
    ),
  redactStaticEntities: (fullText, operators) =>
    canonicalResult(
      JSON.parse(raw.redactStaticEntitiesJson(fullText, json(operators))),
    ),
  redactStaticEntitiesJson: (fullText, operators) =>
    raw.redactStaticEntitiesJson(fullText, json(operators)),
  redactStaticEntitiesWithCallerDetectionsJson: (
    fullText,
    { requestJson, operators },
  ) =>
    raw.redactStaticEntitiesWithCallerDetectionsJson(
      fullText,
      requestJson,
      json(operators),
    ),
  redactStaticEntitiesWithCallerDetectionsDiagnosticsJson: (
    fullText,
    { requestJson, operators },
  ) =>
    raw.redactStaticEntitiesWithCallerDetectionsDiagnosticsJson(
      fullText,
      requestJson,
      json(operators),
    ),
  redactStaticEntitiesResultStreamJson: (fullText, operators, onEvent) => {
    return raw.redactStaticEntitiesResultStreamJson(
      fullText,
      json(operators),
      onEvent,
    );
  },
  redactStaticEntitiesDiagnosticsJson: (fullText, operators) =>
    raw.redactStaticEntitiesDiagnosticsJson(fullText, json(operators)),
  redactStaticEntitiesDiagnosticsStreamJson: (fullText, operators, onBatch) =>
    raw.redactStaticEntitiesDiagnosticsStreamJson(
      fullText,
      json(operators),
      onBatch,
    ),
  redactStaticEntitiesSummaryDiagnosticsJson: (fullText, operators) =>
    raw.redactStaticEntitiesSummaryDiagnosticsJson(fullText, json(operators)),
});

const wrapSession = (
  raw: RawRedactionSession,
): NativePreparedRedactionSessionBinding => ({
  sessionId: raw.sessionId.bind(raw),
  mappingCount: raw.mappingCount.bind(raw),
  restoreText: raw.restoreText.bind(raw),
  restoreTextAt: raw.restoreTextAt.bind(raw),
  toPlaintextJson: raw.toPlaintextJson.bind(raw),
  toPlaintextJsonAt: raw.toPlaintextJsonAt.bind(raw),
  toEncryptedArchive: raw.toEncryptedArchive.bind(raw),
  toEncryptedArchiveAt: raw.toEncryptedArchiveAt.bind(raw),
  inspectJson: raw.inspectJson.bind(raw),
  deleteJson: raw.deleteJson.bind(raw),
  redactStaticEntitiesJson: (fullText, operators) =>
    raw.redactStaticEntitiesJson(fullText, json(operators)),
  redactStaticEntitiesJsonAt: (fullText, observedAtEpochSeconds, operators) =>
    raw.redactStaticEntitiesJsonAt(
      fullText,
      observedAtEpochSeconds,
      json(operators),
    ),
  planStaticEntitiesWithCallerDetections: ({
    inputs,
    operators,
    observedAtEpochSeconds,
  }): NativePreparedSessionRedactionPlanBinding =>
    raw.planStaticEntitiesWithCallerDetections(
      JSON.stringify(
        inputs.map(({ fullText, requestJson }) => ({
          full_text: fullText,
          request_json: requestJson,
        })),
      ),
      json(operators),
      observedAtEpochSeconds,
    ),
});

const json = (value: OperatorConfig | undefined): string | undefined =>
  value === undefined ? undefined : JSON.stringify(value);

type CanonicalResult = {
  resolved_entities: Array<{
    start: number;
    end: number;
    label: string;
    text: string;
    score: number;
    source: string;
    source_detail?: string | null;
    provider_id?: string | null;
    detection_id?: string | null;
  }>;
  redaction: {
    redacted_text: string;
    redaction_map: Array<{ placeholder: string; original: string }>;
    operator_map: Array<{ placeholder: string; operator: string }>;
    entity_count: number;
  };
};

const canonicalResult = (result: CanonicalResult): BindingResult => ({
  resolvedEntities: result.resolved_entities.map(
    ({ source_detail, provider_id, detection_id, ...entity }) => ({
      ...entity,
      ...(source_detail === undefined ? {} : { sourceDetail: source_detail }),
      ...(provider_id === undefined ? {} : { providerId: provider_id }),
      ...(detection_id === undefined ? {} : { detectionId: detection_id }),
    }),
  ),
  redaction: {
    redactedText: result.redaction.redacted_text,
    redactionMap: result.redaction.redaction_map,
    operatorMap: result.redaction.operator_map.map(
      ({ placeholder, operator }) => ({
        placeholder,
        operator: parseOperatorType(operator),
      }),
    ),
    entityCount: result.redaction.entity_count,
  },
});

const parseOperatorType = (operator: string): OperatorType => {
  switch (operator) {
    case "keep":
    case "mask":
    case "redact":
    case "replace":
      return operator;
    default:
      throw new TypeError(`Unknown redaction operator: ${operator}`);
  }
};

const assertPdfPixelPages = (pagePixels: readonly Uint8Array[]): void => {
  for (const [index, page] of pagePixels.entries()) {
    if (!(page instanceof Uint8Array)) {
      throw new TypeError(`PDF pagePixels[${index}] must be a Uint8Array`);
    }
  }
};
