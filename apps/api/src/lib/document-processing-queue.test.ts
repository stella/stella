import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import {
  automaticOcrRetryDelayMs,
  classifyOcrProjectionSource,
  isAutomaticOcrRepairCandidate,
  isCurrentOcrSource,
  isReversibleAutomaticOcrCancellation,
  isRetryableAutomaticOcrFailure,
  requiresOcrPolicy,
} from "@/api/lib/document-processing-queue";

const fileContent = {
  type: "file",
  version: 1,
  id: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
  fileName: "rozsudek.pdf",
  mimeType: "application/pdf",
  sizeBytes: 123,
  sha256Hex: "a".repeat(64),
  encrypted: false,
  pdfFileId: null,
} satisfies FieldContent;

const run = {
  entityVersionId: toSafeId<"entityVersion">(
    "019864b8-48d0-7f37-94d5-948e3bcf3f45",
  ),
  fieldId: toSafeId<"field">("019864b8-48d0-7f37-94d5-948e3bcf3f46"),
  sourceFileId: fileContent.id,
  sourceSha256Hex: fileContent.sha256Hex,
};

const source = {
  content: fileContent,
  currentVersionId: run.entityVersionId,
  entityReadOnly: false,
  fieldEntityVersionId: run.entityVersionId,
  versionDeletedAt: null,
};

describe("isCurrentOcrSource", () => {
  test("accepts the exact live immutable PDF source", () => {
    expect(isCurrentOcrSource({ run, source })).toBe(true);
  });

  test("rejects a replaced source with the same field", () => {
    expect(
      isCurrentOcrSource({
        run,
        source: {
          ...source,
          content: { ...fileContent, sha256Hex: "b".repeat(64) },
        },
      }),
    ).toBe(false);
  });

  test("rejects a no-longer-current version", () => {
    expect(
      isCurrentOcrSource({
        run,
        source: {
          ...source,
          currentVersionId: toSafeId<"entityVersion">(
            "019864b8-48d0-7f37-94d5-948e3bcf3f47",
          ),
        },
      }),
    ).toBe(false);
  });
});

describe("classifyOcrProjectionSource", () => {
  test("preserves an inactive workspace cancellation for recovery", () => {
    expect(
      classifyOcrProjectionSource({
        run,
        source,
        workspaceStatus: "archived",
      }),
    ).toBe("workspace_unavailable");
    expect(
      classifyOcrProjectionSource({
        run,
        source,
        workspaceStatus: "deleting",
      }),
    ).toBe("workspace_unavailable");
  });

  test("classifies only an active stale source as superseded", () => {
    expect(
      classifyOcrProjectionSource({
        run,
        source: {
          ...source,
          content: { ...fileContent, sha256Hex: "b".repeat(64) },
        },
        workspaceStatus: "active",
      }),
    ).toBe("source_superseded");
  });
});

describe("isAutomaticOcrRepairCandidate", () => {
  test("only repairs an unencrypted PDF source", () => {
    expect(isAutomaticOcrRepairCandidate(fileContent)).toBe(true);
    expect(
      isAutomaticOcrRepairCandidate({
        ...fileContent,
        encrypted: true,
      }),
    ).toBe(false);
    expect(
      isAutomaticOcrRepairCandidate({
        ...fileContent,
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe(false);
  });
});

describe("requiresOcrPolicy", () => {
  test("applies opt-out to every automatic request source", () => {
    expect(requiresOcrPolicy("upload")).toBe(true);
    expect(requiresOcrPolicy("repair")).toBe(true);
    expect(requiresOcrPolicy("manual")).toBe(false);
  });
});

describe("isReversibleAutomaticOcrCancellation", () => {
  test("revives policy and workspace cancellations, but not source cancellation", () => {
    expect(
      isReversibleAutomaticOcrCancellation({
        errorCode: "policy_disabled",
        status: "cancelled",
      }),
    ).toBe(true);
    expect(
      isReversibleAutomaticOcrCancellation({
        errorCode: "workspace_unavailable",
        status: "cancelled",
      }),
    ).toBe(true);
    expect(
      isReversibleAutomaticOcrCancellation({
        errorCode: "source_superseded",
        status: "cancelled",
      }),
    ).toBe(false);
  });
});

describe("automatic OCR failure recovery", () => {
  test("uses bounded exponential backoff", () => {
    expect(automaticOcrRetryDelayMs(1)).toBe(30_000);
    expect(automaticOcrRetryDelayMs(2)).toBe(60_000);
    expect(automaticOcrRetryDelayMs(10)).toBe(30 * 60 * 1000);
  });

  test("requeues only retryable automatic failures below the attempt cap", () => {
    expect(
      isRetryableAutomaticOcrFailure({
        attemptCount: 4,
        errorCode: "request_failed",
        requestSource: "upload",
      }),
    ).toBe(true);
    expect(
      isRetryableAutomaticOcrFailure({
        attemptCount: 5,
        errorCode: "request_failed",
        requestSource: "upload",
      }),
    ).toBe(false);
    expect(
      isRetryableAutomaticOcrFailure({
        attemptCount: 1,
        errorCode: "invalid_response",
        requestSource: "repair",
      }),
    ).toBe(false);
    expect(
      isRetryableAutomaticOcrFailure({
        attemptCount: 1,
        errorCode: "processing_failed",
        requestSource: "manual",
      }),
    ).toBe(false);
  });
});
