import { describe, expect, test } from "bun:test";

import {
  createWasmBinding,
  isRawWasmModule,
  RAW_WASM_MODULE_FUNCTION_MEMBERS,
  RAW_WASM_PREPARED_SEARCH_FACTORY_MEMBERS,
  type RawWasmModule,
} from "../wasm-binding";

const unavailable = (): never => {
  throw new Error("not used by this test");
};

const fakeRawModule = (): RawWasmModule => {
  class PreparedSearch {}
  const WasmPreparedSearch = Object.assign(PreparedSearch, {
    fromConfigJsonBytes: unavailable,
    fromPreparedPackageBytes: unavailable,
    fromTrustedPreparedPackageBytes: unavailable,
  });
  return {
    default: async () => ({}),
    normalizeForSearch: (text) => text,
    nativePackageVersion: () => "test",
    externalDetectionLimitsJson: () => "{}",
    convertExternalDetectionBatchJson: () => "[]",
    extractDocxTextJson: () => "{}",
    rewriteDocxTextNative: (document) => ({
      document,
      rewrittenBlockCount: 0,
      appliedReplacementCount: 0,
    }),
    planDocxRestorationJson: () => "{}",
    inspectPdfJson: () => "{}",
    rewritePdfRasterFromDetectionsJson: (document) => ({
      document,
      certificateJson: "{}",
    }),
    prepareStaticSearchPackageBytes: (bytes) => bytes,
    prepareStaticSearchCompressedPackageBytes: (bytes) => bytes,
    assembleStaticSearchConfigJson: (bytes) => bytes,
    assembleStaticSearchPackageBytes: (bytes) => bytes,
    assembleStaticSearchCompressedPackageBytes: (bytes) => bytes,
    WasmPreparedSearch,
  };
};

describe("raw WASM binding invariants", () => {
  test("accepts the complete raw surface", () => {
    expect(isRawWasmModule(fakeRawModule())).toBe(true);
  });

  for (const member of RAW_WASM_MODULE_FUNCTION_MEMBERS) {
    test(`rejects a missing raw export: ${member}`, () => {
      expect(isRawWasmModule({ ...fakeRawModule(), [member]: undefined })).toBe(
        false,
      );
    });
  }

  for (const member of RAW_WASM_PREPARED_SEARCH_FACTORY_MEMBERS) {
    test(`rejects a missing prepared-search factory: ${member}`, () => {
      const raw = fakeRawModule();
      class PreparedSearch {}
      const factory = Object.assign(PreparedSearch, raw.WasmPreparedSearch, {
        [member]: undefined,
      });
      expect(isRawWasmModule({ ...raw, WasmPreparedSearch: factory })).toBe(
        false,
      );
    });
  }

  test("requires the prepared-search export to be a constructor", () => {
    const raw = fakeRawModule();
    expect(
      isRawWasmModule({
        ...raw,
        WasmPreparedSearch: { ...raw.WasmPreparedSearch },
      }),
    ).toBe(false);
  });
});

describe("WASM result and byte contracts", () => {
  test("rejects malformed PDF pixel page inputs before calling WASM", () => {
    const raw = fakeRawModule();
    let called = false;
    raw.rewritePdfRasterFromDetectionsJson = (document) => {
      called = true;
      return { document, certificateJson: "{}" };
    };
    const binding = createWasmBinding(raw);
    expect(() =>
      binding.rewritePdfRasterFromDetectionsJson(new Uint8Array(), "{}", [
        new ArrayBuffer(1),
      ] as unknown as Uint8Array[]),
    ).toThrow("pagePixels[0] must be a Uint8Array");
    expect(called).toBe(false);
  });

  test("rejects an unknown operator in a raw redaction result", () => {
    const raw = fakeRawModule();
    const resultJson = JSON.stringify({
      resolved_entities: [],
      redaction: {
        redacted_text: "",
        redaction_map: [],
        operator_map: [{ placeholder: "<X>", operator: "unknown" }],
        entity_count: 0,
      },
    });
    raw.WasmPreparedSearch.fromConfigJsonBytes = () => ({
      prepareDiagnosticsJson: () => "{}",
      warmLazyRegex: () => undefined,
      warmLazyRegexDiagnosticsJson: () => "{}",
      createRedactionSession: unavailable,
      createRedactionSessionWithLifecycle: unavailable,
      restoreRedactionSession: unavailable,
      restoreEncryptedRedactionSession: unavailable,
      redactStaticEntitiesJson: () => resultJson,
      redactStaticEntitiesWithCallerDetectionsJson: () => resultJson,
      redactStaticEntitiesWithCallerDetectionsDiagnosticsJson: () => "{}",
      redactStaticEntitiesDiagnosticsJson: () => "{}",
      redactStaticEntitiesSummaryDiagnosticsJson: () => "{}",
      redactStaticEntitiesResultStreamJson: () => resultJson,
      redactStaticEntitiesDiagnosticsStreamJson: () => "{}",
    });
    const prepared = createWasmBinding(
      raw,
    ).NativePreparedSearch.fromConfigJsonBytes(new Uint8Array());
    expect(() => prepared.redactStaticEntities("text")).toThrow(
      "Unknown redaction operator: unknown",
    );
  });
});
