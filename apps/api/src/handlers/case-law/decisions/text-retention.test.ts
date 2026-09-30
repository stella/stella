import { describe, expect, test } from "bun:test";

import { publicTextRetentionSummary } from "@/api/handlers/case-law/decisions/text-retention";
import { createSafeId } from "@/api/lib/branded-types";
import { ORACLE_VERSION } from "@/api/lib/legal-search/text-retention/types";
import { EXCLUSION_VERSION } from "@/api/lib/legal-search/text-retention/validation";

const fixture = () => {
  const record = {
    decisionId: createSafeId<"caseLawDecision">(),
    payloadFingerprint: "a".repeat(64),
    parserVersion: 7,
    oracleVersion: ORACLE_VERSION,
    exclusionVersion: EXCLUSION_VERSION,
    checkedAt: new Date("2026-01-01T00:00:00Z"),
    status: "assessed" as const,
    retainedRatio: 1,
    defect: null,
    reason: null,
  };
  return {
    record,
    current: {
      contentHash: record.payloadFingerprint,
      parserVersion: record.parserVersion,
      redactedAt: null,
      payloadState: "available" as const,
    },
  };
};

describe("public retention describes only the current served payload", () => {
  test("an unchanged payload reports its measured ratio and check versions", () => {
    const input = fixture();
    expect(publicTextRetentionSummary(input)).toEqual({
      status: "assessed",
      retainedRatio: 1,
      defect: null,
      reason: null,
      checkedAt: input.record.checkedAt,
      parserVersion: 7,
      oracleVersion: ORACLE_VERSION,
      exclusionVersion: EXCLUSION_VERSION,
    });
    expect(
      publicTextRetentionSummary({
        ...input,
        record: {
          ...input.record,
          retainedRatio: 0.75,
          defect: "text_loss_suspected",
        },
      }),
    ).toMatchObject({
      status: "assessed",
      retainedRatio: 0.75,
      defect: "text_loss_suspected",
    });
  });

  test("every mismatched fingerprint or version suppresses the old pass", () => {
    const input = fixture();
    const changed = [
      { ...input, current: { ...input.current, contentHash: "b".repeat(64) } },
      { ...input, current: { ...input.current, parserVersion: 8 } },
      { ...input, current: { ...input.current, parserVersion: null } },
      {
        ...input,
        record: { ...input.record, oracleVersion: ORACLE_VERSION + 1 },
      },
      {
        ...input,
        record: { ...input.record, exclusionVersion: EXCLUSION_VERSION + 1 },
      },
    ];
    for (const candidate of changed) {
      expect(publicTextRetentionSummary(candidate)).toMatchObject({
        status: "unavailable",
        reason: "stale_verdict",
        retainedRatio: null,
        defect: null,
      });
    }
  });

  test("a missing or unreadable canonical payload cannot inherit a pass", () => {
    const input = fixture();
    expect(
      publicTextRetentionSummary({
        ...input,
        current: { ...input.current, contentHash: null },
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: "payload_unavailable",
      retainedRatio: null,
    });
    expect(
      publicTextRetentionSummary({
        ...input,
        current: { ...input.current, payloadState: "unavailable" },
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: "payload_unavailable",
      retainedRatio: null,
    });
  });

  test("unassessed, empty and absent verdicts remain distinct", () => {
    const input = fixture();
    expect(
      publicTextRetentionSummary({ ...input, record: undefined }),
    ).toMatchObject({
      status: "missing",
      reason: "not_checked",
      checkedAt: null,
      retainedRatio: null,
    });
    expect(
      publicTextRetentionSummary({
        ...input,
        record: {
          ...input.record,
          status: "empty_source",
          retainedRatio: null,
        },
      }),
    ).toMatchObject({
      status: "empty_source",
      retainedRatio: null,
      reason: null,
    });
    expect(
      publicTextRetentionSummary({
        ...input,
        record: {
          ...input.record,
          status: "unavailable",
          reason: "no_raw",
          retainedRatio: null,
        },
      }),
    ).toMatchObject({
      status: "unavailable",
      retainedRatio: null,
      reason: "no_raw",
    });
  });

  test("redaction suppresses even check time and versions", () => {
    const input = fixture();
    expect(
      publicTextRetentionSummary({
        ...input,
        current: { ...input.current, redactedAt: new Date() },
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: "redacted",
      checkedAt: null,
      parserVersion: null,
      oracleVersion: null,
      exclusionVersion: null,
      retainedRatio: null,
    });
  });

  test("a transient reparse cannot report a stored pass or its check metadata", () => {
    const input = fixture();
    expect(
      publicTextRetentionSummary({
        ...input,
        current: { ...input.current, payloadState: "transient" },
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: "transient_payload",
      checkedAt: null,
      retainedRatio: null,
      parserVersion: null,
      oracleVersion: null,
      exclusionVersion: null,
    });
  });

  test("summary never exports operational references or diagnostics", () => {
    const input = fixture();
    const record = {
      ...input.record,
      rawS3Key: "private/captured/payload",
      rawFingerprint: "c".repeat(64),
      sourceHash: "d".repeat(64),
      compositionFingerprint: "e".repeat(64),
      missingSampleHash: "f".repeat(64),
      components: [{ id: "private-component" }],
    };
    const summary = publicTextRetentionSummary({ ...input, record });
    expect(Object.keys(summary).toSorted()).toEqual([
      "checkedAt",
      "defect",
      "exclusionVersion",
      "oracleVersion",
      "parserVersion",
      "reason",
      "retainedRatio",
      "status",
    ]);
  });
});
