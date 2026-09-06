import { describe, expect, test } from "bun:test";

import {
  AI_PROVIDERS,
  hasNativeImageProbeSupport,
  isHeicMimeType,
  isNativeHeicInputSupported,
  parseNativeImageProbeReport,
} from "./index";
import type { NativeImageProbeRecord } from "./index";
import snapshot from "./native-image-probes.json";

const record = {
  provider: "google",
  modelId: "synthetic-model",
  mimeType: "image/heic",
  status: "supported",
  checkedAt: "2026-09-06T12:00:00.000Z",
  fixtureSha256: "a".repeat(64),
  adapterVersion: "test-version",
  sourceRevision: `${"b".repeat(40)}:${"c".repeat(64)}`,
} as const satisfies NativeImageProbeRecord;

describe("native HEIC probe evidence", () => {
  test("accepts exact positive evidence for any provider without inheriting support", () => {
    for (const provider of AI_PROVIDERS) {
      const evidence = { ...record, provider };
      expect(hasNativeImageProbeSupport([evidence], evidence)).toBe(true);
      expect(
        hasNativeImageProbeSupport([evidence], {
          ...evidence,
          mimeType: "image/heif",
        }),
      ).toBe(false);
      expect(
        hasNativeImageProbeSupport([evidence], {
          ...evidence,
          modelId: "other-model",
        }),
      ).toBe(false);
      for (const otherProvider of AI_PROVIDERS) {
        if (otherProvider === provider) {
          continue;
        }
        expect(
          hasNativeImageProbeSupport([evidence], {
            ...evidence,
            provider: otherProvider,
          }),
        ).toBe(false);
      }
    }
  });

  test("untested, unsupported and inconclusive tuples never enable input", () => {
    expect(hasNativeImageProbeSupport([], record)).toBe(false);
    for (const status of ["unsupported", "inconclusive"] as const) {
      expect(hasNativeImageProbeSupport([{ ...record, status }], record)).toBe(
        false,
      );
    }
  });

  test("runtime support equals committed evidence and denies unknown tuples", () => {
    const report = parseNativeImageProbeReport(snapshot);
    for (const evidence of report.records) {
      expect(isNativeHeicInputSupported(evidence)).toBe(
        evidence.status === "supported",
      );
    }
    for (const provider of AI_PROVIDERS) {
      expect(isNativeHeicInputSupported({ ...record, provider })).toBe(false);
    }
  });

  test("recognizes only canonical still-image HEIC and HEIF MIME types", () => {
    for (const mimeType of ["image/heic", "image/heif"]) {
      expect(isHeicMimeType(mimeType)).toBe(true);
    }
    for (const mimeType of [
      "image/heic-sequence",
      "image/heif-sequence",
      "image/avif",
      "image/jpeg",
      "application/pdf",
      "application/octet-stream",
    ]) {
      expect(isHeicMimeType(mimeType)).toBe(false);
    }
  });
});
