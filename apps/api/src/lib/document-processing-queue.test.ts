import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import {
  isAutomaticOcrRepairCandidate,
  isCurrentOcrSource,
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
