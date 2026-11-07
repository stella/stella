import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { SourceFieldInventory } from "@/api/lib/legal-search/ingestion-types";
import {
  inspectPublisherFieldCoverage,
  PUBLISHER_FIELD_COVERAGE_EVENT,
  recordPublisherFieldCoverage,
  retainedPublisherParts,
} from "@/api/lib/legal-search/publisher-field-coverage";
import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
} from "@/api/lib/legal-search/source-raw-envelope";
import type { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

const knownField = {
  disposition: "stored",
  target: {
    type: "raw",
    part: "record",
    path: ["known"],
    reason: "Source value",
  },
} as const;

const inventory = {
  status: "declared",
  fields: { known: knownField },
  listSourceFields: (parts) => {
    const value: unknown = JSON.parse(parts["record"] ?? "null");
    return isRecord(value) ? Object.keys(value) : [];
  },
} satisfies SourceFieldInventory;

const captureReports = () => {
  const reports: Parameters<typeof logger.error>[] = [];
  const report: typeof logger.error = (...args) => {
    reports.push(args);
  };
  return { reports, report };
};

describe("publisher field retention", () => {
  test("publisher-field-retention: every unmapped field is archived unchanged and counted once", async () => {
    await assertProperty(
      "publisher-field-retention: every unmapped field is archived unchanged and counted once",
      fc.asyncProperty(
        fc.dictionary(fc.string(), fc.jsonValue()),
        async (extra) => {
          const payload = { ...extra, known: "stored" };
          const record = JSON.stringify(payload);
          const sourceRaw = encodeSourceRawEnvelope({ record });
          const result = Object.freeze({ sourceRaw });
          const { reports, report } = captureReports();
          await inspectPublisherFieldCoverage({
            adapterKey: "fixture",
            inventory,
            result,
            report,
          });
          expect(result.sourceRaw).toBe(sourceRaw);
          expect(decodeSourceRawEnvelope(result.sourceRaw)?.["record"]).toBe(
            record,
          );
          const count = Object.keys(payload).filter(
            (field) => field !== "known",
          ).length;
          expect(reports).toEqual(
            count === 0
              ? []
              : [
                  [
                    PUBLISHER_FIELD_COVERAGE_EVENT.UNMAPPED,
                    {
                      adapterKey: "fixture",
                      recordCount: 1,
                      unmappedFieldCount: count,
                      retainedRaw: true,
                    },
                  ],
                ],
          );
        },
      ),
    );
  });

  test("deleting a mapping and adding a publisher field both produce drift", () => {
    const { reports, report } = captureReports();
    expect(
      recordPublisherFieldCoverage({
        adapterKey: "fixture",
        inventory,
        observedFields: ["known"],
        report,
      }).unmapped,
    ).toEqual([]);
    expect(
      recordPublisherFieldCoverage({
        adapterKey: "fixture",
        inventory: { fields: {} },
        observedFields: ["known"],
        report,
      }).unmapped,
    ).toEqual(["known"]);
    expect(
      recordPublisherFieldCoverage({
        adapterKey: "fixture",
        inventory,
        observedFields: ["known", "new", "new"],
        report,
      }).unmapped,
    ).toEqual(["new"]);
    expect(
      reports.map(([, attributes]) => attributes?.["unmappedFieldCount"]),
    ).toEqual([1, 1]);
  });

  test("a reader failure alerts without discarding its retained response", async () => {
    const sourceRaw = encodeSourceRawEnvelope({
      record: "publisher changed format",
    });
    const result = Object.freeze({ sourceRaw });
    const { reports, report } = captureReports();
    await inspectPublisherFieldCoverage({
      adapterKey: "fixture",
      inventory,
      result,
      report,
    });
    expect(result.sourceRaw).toBe(sourceRaw);
    expect(reports).toEqual([
      [
        PUBLISHER_FIELD_COVERAGE_EVENT.READER_FAILED,
        {
          adapterKey: "fixture",
          recordCount: 1,
          retainedRaw: true,
          readerFailure: "SyntaxError",
        },
      ],
    ]);
  });

  test("an absent envelope or a main binary that would overwrite it cannot pass live capture", () => {
    for (const result of [{}, { sourceRaw: "publisher text" }]) {
      expect(() =>
        retainedPublisherParts({ adapterKey: "fixture", result }),
      ).toThrow("fixture: publisher record has no retained raw envelope");
    }
    expect(() =>
      retainedPublisherParts({
        adapterKey: "fixture",
        result: {
          sourceRaw: encodeSourceRawEnvelope({ record: "metadata" }),
          sourceRawBytes: new Uint8Array([1]),
        },
      }),
    ).toThrow(
      "publisher responses must use an envelope with named binary objects",
    );
  });
});
