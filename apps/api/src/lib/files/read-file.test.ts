import { describe, expect, mock, test } from "bun:test";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";

import type { ScopedDb } from "@/api/db/safe-db";
import { isHttpStatusResponse } from "@/api/http/status";
import { toSafeId } from "@/api/lib/branded-types";
import { readFileHandler } from "@/api/lib/files/read-file";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const fileRow = (mimeType: string, pdfFileId: string | null) => ({
  content: {
    type: "file",
    version: 1,
    id: "11111111-1111-4111-8111-111111111111",
    fileName: "drawing",
    mimeType,
    pdfFileId,
    sizeBytes: 1,
    encrypted: false,
  },
  entityId: toSafeId<"entity">("entity"),
  entityVersionId: toSafeId<"entityVersion">("version"),
  propertyId: toSafeId<"property">("property"),
  versionStamp: null,
  verificationCode: null,
});

const read = async (
  purpose: "display" | "native-display",
  row: ReturnType<typeof fileRow>,
) =>
  await readFileHandler({
    fieldId: toSafeId<"field">("field"),
    organizationId: toSafeId<"organization">("organization"),
    purpose,
    readSessionAuthority: asTestRaw(mock(async () => undefined)),
    recordAuditEvent: mock(async () => undefined),
    scopedDb: asTestRaw<ScopedDb>(mock(async () => [row])),
    source: asTestRaw({}),
    userId: toSafeId<"user">("user"),
    workspaceId: toSafeId<"workspace">("workspace"),
  });

describe("a file with nothing to show", () => {
  test.each(["display", "native-display"] as const)(
    "answers %s with the typed code clients act on",
    async (purpose) => {
      const answer = await read(purpose, fileRow("image/svg+xml", null));

      expect(isHttpStatusResponse(answer)).toBe(true);
      expect(answer).toMatchObject({
        code: 400,
        response: { code: PREVIEW_UNAVAILABLE_ERROR_CODE },
      });
    },
  );
});
