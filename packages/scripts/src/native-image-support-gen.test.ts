import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { hasNativeImageProbeSupport } from "@stll/ai-catalog";
import type { NativeImageProbeRecord } from "@stll/ai-catalog";

import {
  hasNativeImageSupportChanged,
  mergeNativeImageProbeReports,
  NativeImageProbeImportError,
} from "./native-image-support-gen";

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
const report = (records: NativeImageProbeRecord[]) => ({
  probeVersion: 1 as const,
  records,
});

const expectImportError = (
  result: ReturnType<typeof mergeNativeImageProbeReports>,
  message: string,
): void => {
  expect(Result.isError(result)).toBe(true);
  if (!Result.isError(result)) {
    return;
  }
  expect(NativeImageProbeImportError.is(result.error)).toBe(true);
  expect(result.error.message).toContain(message);
};

describe("native image canary evidence import", () => {
  test("CI detects effective support drift while ignoring refreshed provenance", () => {
    const current = report([record]);
    const refreshed = {
      ...record,
      checkedAt: "2026-09-07T12:00:00.000Z",
      adapterVersion: "next-version",
    };
    const unchanged = mergeNativeImageProbeReports({
      current,
      incoming: report([refreshed]),
    }).unwrap();
    expect(hasNativeImageSupportChanged({ current, incoming: unchanged })).toBe(
      false,
    );
    for (const status of ["unsupported", "inconclusive"] as const) {
      const revoked = mergeNativeImageProbeReports({
        current,
        incoming: report([{ ...refreshed, status }]),
      }).unwrap();
      expect(hasNativeImageSupportChanged({ current, incoming: revoked })).toBe(
        true,
      );
      expect(
        hasNativeImageSupportChanged({ current: revoked, incoming: unchanged }),
      ).toBe(true);
    }
    expect(
      hasNativeImageSupportChanged({
        current: report([{ ...record, status: "unsupported" }]),
        incoming: report([{ ...refreshed, status: "inconclusive" }]),
      }),
    ).toBe(false);
    expect(
      hasNativeImageSupportChanged({
        current,
        incoming: report([{ ...record, provider: "openai" }]),
      }),
    ).toBe(true);
  });

  test("a report for one provider preserves newer evidence for another provider", () => {
    const newer = {
      ...record,
      provider: "openai",
      checkedAt: "2026-09-08T12:00:00.000Z",
    } as const;
    const current = report([newer]);
    const merged = mergeNativeImageProbeReports({
      current,
      incoming: report([record]),
    }).unwrap();
    expect(merged.records).toContainEqual(newer);
    expect(merged.records).toContainEqual(record);
  });
  test("newest rejected or inconclusive evidence revokes support", () => {
    const current = report([record]);
    expect(hasNativeImageProbeSupport(current.records, record)).toBe(true);
    for (const status of ["unsupported", "inconclusive"] as const) {
      const latest = {
        ...record,
        status,
        checkedAt: "2026-09-07T12:00:00.000Z",
      };
      const merged = mergeNativeImageProbeReports({
        current,
        incoming: report([latest]),
      }).unwrap();
      expect(merged.records).toEqual([latest]);
      expect(hasNativeImageProbeSupport(merged.records, record)).toBe(false);
    }
  });

  test("imports are deterministic and repeated identical evidence is a fixed point", () => {
    const other = { ...record, provider: "openai" } as const;
    const first = mergeNativeImageProbeReports({
      current: report([]),
      incoming: report([record, other]),
    }).unwrap();
    const reverse = mergeNativeImageProbeReports({
      current: report([]),
      incoming: report([other, record]),
    }).unwrap();
    expect(first).toEqual(reverse);
    expect(
      mergeNativeImageProbeReports({
        current: first,
        incoming: report([other, record]),
      }).unwrap(),
    ).toEqual(first);
  });

  test("rejects duplicate, stale and conflicting evidence", () => {
    expectImportError(
      mergeNativeImageProbeReports({
        current: report([]),
        incoming: report([record, record]),
      }),
      "Duplicate native image probe",
    );
    expectImportError(
      mergeNativeImageProbeReports({
        current: report([record, record]),
        incoming: report([]),
      }),
      "Duplicate native image probe",
    );
    expectImportError(
      mergeNativeImageProbeReports({
        current: report([record]),
        incoming: report([
          { ...record, checkedAt: "2026-09-05T12:00:00.000Z" },
        ]),
      }),
      "Stale native image probe",
    );
    expectImportError(
      mergeNativeImageProbeReports({
        current: report([record]),
        incoming: report([{ ...record, status: "unsupported" }]),
      }),
      "Conflicting native image probe",
    );
  });

  test("validates the report before importing any evidence", () => {
    for (const incoming of [
      { probeVersion: 2, records: [] },
      { probeVersion: 1, records: [], unknown: true },
      report([{ ...record, fixtureSha256: "invalid" }]),
      report([{ ...record, sourceRevision: "invalid" }]),
      report([{ ...record, checkedAt: "yesterday" }]),
      report([{ ...record, checkedAt: "2026-02-30T12:00:00.000Z" }]),
      report([{ ...record, adapterVersion: "" }]),
      { probeVersion: 1, records: [{ ...record, status: "passed" }] },
      { probeVersion: 1, records: [{ ...record, mimeType: "image/jpeg" }] },
      { probeVersion: 1, records: [{ ...record, provider: "unknown" }] },
      {
        probeVersion: 1,
        records: [{ ...record, error: "unbounded provider output" }],
      },
    ]) {
      expectImportError(
        mergeNativeImageProbeReports({ current: report([]), incoming }),
        "Invalid",
      );
    }
  });
});
