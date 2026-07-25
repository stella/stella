import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  EXTERNAL_DETECTION_BATCH_MAX_BYTES,
  EXTERNAL_DETECTION_BATCH_VERSION,
  EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES,
  EXTERNAL_DETECTION_MAX_DETECTIONS,
  EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS,
  EXTERNAL_DETECTION_MAX_METADATA_BYTES,
  EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES,
  type ExternalDetectionBatch,
  convert_external_detection_batch,
} from "../native";
import { loadNativeAnonymizeBinding } from "../native-node";
import { convert_external_detection_batch as convertWasmExternalDetectionBatch } from "../wasm";

const binding = loadNativeAnonymizeBinding();
const document = new TextEncoder().encode("😀Alice signed.");
const sha256 = createHash("sha256").update(document).digest("hex");

type FakeProviderSpan = {
  offsetUnit: ExternalDetectionBatch["offsetUnit"];
  start: number;
  end: number;
};

const fakeProviderBatch = (
  { offsetUnit, start, end }: FakeProviderSpan = {
    offsetUnit: "unicode-code-point",
    start: 1,
    end: 6,
  },
): ExternalDetectionBatch => ({
  version: EXTERNAL_DETECTION_BATCH_VERSION,
  document: { sha256 },
  offsetUnit,
  provider: {
    id: "fake-provider",
    name: "Deterministic fake provider",
    version: "1.0.0",
  },
  labelMap: [{ providerLabel: "PER", entityLabel: "person" }],
  detections: [
    {
      id: "fake-person-1",
      start,
      end,
      label: "PER",
      score: 0.99,
    },
  ],
});

describe("ExternalDetectionBatch v1", () => {
  test("public TypeScript limits exactly match the Rust contract", () => {
    const limitsJson = binding.externalDetectionLimitsJson();
    expect(JSON.parse(limitsJson)).toEqual({
      batchMaxBytes: EXTERNAL_DETECTION_BATCH_MAX_BYTES,
      documentMaxBytes: EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES,
      maxDetections: EXTERNAL_DETECTION_MAX_DETECTIONS,
      maxLabelMappings: EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS,
      maxMetadataBytes: EXTERNAL_DETECTION_MAX_METADATA_BYTES,
      providerIdMaxBytes: EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES,
    });
    expect(JSON.parse(limitsJson)).toEqual({
      batchMaxBytes: 16_777_216,
      documentMaxBytes: 67_108_864,
      maxDetections: 100_000,
      maxLabelMappings: 4_096,
      maxMetadataBytes: 256,
      providerIdMaxBytes: 128,
    });
  });

  test("converts every source unit identically through Node and WASM", async () => {
    const expected = [
      {
        start: 2,
        end: 7,
        label: "person",
        score: 0.99,
        providerId: "fake-provider",
        detectionId: "fake-person-1",
      },
    ];
    const spans: readonly FakeProviderSpan[] = [
      { offsetUnit: "utf8-byte", start: 4, end: 9 },
      { offsetUnit: "utf16-code-unit", start: 2, end: 7 },
      { offsetUnit: "unicode-code-point", start: 1, end: 6 },
    ];

    for (const span of spans) {
      const batch = fakeProviderBatch(span);
      expect(
        convert_external_detection_batch({ binding, document, batch }),
      ).toEqual(expected);
      expect(
        await convertWasmExternalDetectionBatch(document, batch, { binding }),
      ).toEqual(expected);
    }
  });

  test("fails closed on stale bytes and unknown contract fields", () => {
    const stale = fakeProviderBatch();
    stale.document.sha256 = "0".repeat(64);
    expect(() =>
      convert_external_detection_batch({ binding, document, batch: stale }),
    ).toThrow("sha256 does not match");

    const unknown = JSON.stringify({
      ...fakeProviderBatch(),
      legacyOffsetGuessing: true,
    });
    expect(() =>
      convert_external_detection_batch({ binding, document, batch: unknown }),
    ).toThrow("unknown field");
  });

  test("rejects an injected binding with a missing parity member", async () => {
    const staleBinding = new Proxy(binding, {
      get: (target, property, receiver) =>
        property === "convertExternalDetectionBatch"
          ? undefined
          : Reflect.get(target, property, receiver),
    });

    expect(staleBinding.normalizeForSearch("Alice")).toBe("Alice");
    expect(
      convertWasmExternalDetectionBatch(document, fakeProviderBatch(), {
        binding: staleBinding,
      }),
    ).rejects.toThrow(
      "wasm binding module does not expose the native anonymize surface",
    );
  });

  test("normalizes validation errors identically through Node and WASM", async () => {
    const stale = fakeProviderBatch();
    stale.document.sha256 = "0".repeat(64);
    const unknown = JSON.stringify({
      ...fakeProviderBatch(),
      legacyOffsetGuessing: true,
    });

    for (const batch of [stale, unknown]) {
      let nodeMessage: string | undefined;
      try {
        convert_external_detection_batch({ binding, document, batch });
      } catch (error) {
        nodeMessage = error instanceof Error ? error.message : undefined;
      }

      let wasmMessage: string | undefined;
      try {
        await convertWasmExternalDetectionBatch(document, batch, { binding });
      } catch (error) {
        wasmMessage = error instanceof Error ? error.message : undefined;
      }

      expect(nodeMessage).toBeDefined();
      expect(wasmMessage).toBe(nodeMessage);
    }
  });
});
