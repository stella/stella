import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import {
  allocateFileObject,
  fileContentWithMintedObject,
} from "@/api/handlers/files/file-object-ids";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  buildVersionStamp,
  cloneFieldsForRevision,
  nextEntityVersionNumber,
} from "./version-utils";

describe("nextEntityVersionNumber", () => {
  // The allocator reads MAX(versionNumber); the mock returns that scalar row.
  const txReturning = (rows: { max: number | null }[]) =>
    asTestRaw<Transaction>({
      select: () => ({
        from: () => ({
          where: async () => rows,
        }),
      }),
    });

  const target = {
    entityId: toSafeId<"entity">("11111111-1111-1111-1111-111111111111"),
    workspaceId: toSafeId<"workspace">("22222222-2222-2222-2222-222222222222"),
  };

  test("returns MAX(versionNumber) + 1, counting a tombstoned latest version", async () => {
    // Tombstoning v5 promotes currentVersionId back to v4, but the tombstoned
    // v5 row is still the MAX. The allocator must return 6, not (4 + 1) = 5,
    // which would collide with the withdrawn v5.
    expect(
      await nextEntityVersionNumber(txReturning([{ max: 5 }]), target),
    ).toBe(6);
  });

  test("returns 1 for an entity with no versions", async () => {
    expect(
      await nextEntityVersionNumber(txReturning([{ max: null }]), target),
    ).toBe(1);
    expect(await nextEntityVersionNumber(txReturning([]), target)).toBe(1);
  });
});

describe("buildVersionStamp", () => {
  test("builds the next stamped reference when the workspace has numbering", () => {
    const result = buildVersionStamp({
      docSequence: 15,
      versionNumber: 3,
      workspaceReference: "2026/001",
    });

    expect(result.stamp).toBe("2026/001/015.v3");
    expect(result.verificationCode).toMatch(
      /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/u,
    );
  });

  test("returns nulls when the entity has no stampable workspace reference", () => {
    expect(
      buildVersionStamp({
        docSequence: null,
        versionNumber: 2,
        workspaceReference: "2026/001",
      }),
    ).toEqual({
      stamp: null,
      verificationCode: null,
    });

    expect(
      buildVersionStamp({
        docSequence: 42,
        versionNumber: 2,
        workspaceReference: null,
      }),
    ).toEqual({
      stamp: null,
      verificationCode: null,
    });
  });
});

describe("cloneFieldsForRevision", () => {
  test("replaces only the targeted file property and preserves other fields", () => {
    const workspaceId = toSafeId<"workspace">("ws_test123");
    const filePropertyId = toSafeId<"property">("prop_file");
    const textPropertyId = toSafeId<"property">("prop_text");
    const nextVersionId = toSafeId<"entityVersion">("version_next");
    const replacementFile = fileContentWithMintedObject({
      encrypted: false,
      fileName: "agreement.docx",
      id: allocateFileObject(),
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdfFileId: null,
      sha256Hex: "a".repeat(64),
      sizeBytes: 128,
      type: "file",
      version: 1,
    });

    const cloned = cloneFieldsForRevision({
      currentFields: [
        {
          content: {
            encrypted: false,
            fileName: "old.docx",
            id: Bun.randomUUIDv7(),
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            pdfFileId: null,
            sha256Hex: "b".repeat(64),
            sizeBytes: 64,
            type: "file",
            version: 1,
          },
          propertyId: filePropertyId,
        },
        {
          content: {
            type: "text",
            value: "Keep me",
            version: 1,
          },
          propertyId: textPropertyId,
        },
      ],
      entityVersionId: nextVersionId,
      propertyId: filePropertyId,
      replacementContent: replacementFile,
      workspaceId,
    });

    expect(cloned).toEqual([
      {
        content: replacementFile,
        entityVersionId: nextVersionId,
        propertyId: filePropertyId,
        workspaceId,
      },
      {
        content: {
          type: "text",
          value: "Keep me",
          version: 1,
        },
        entityVersionId: nextVersionId,
        propertyId: textPropertyId,
        workspaceId,
      },
    ]);
  });

  test("uses the replacement field id only for the targeted file field", () => {
    const workspaceId = toSafeId<"workspace">("ws_test123");
    const filePropertyId = toSafeId<"property">("prop_file");
    const textPropertyId = toSafeId<"property">("prop_text");
    const nextVersionId = toSafeId<"entityVersion">("version_next");
    const replacementFieldId = toSafeId<"field">("field_replacement");
    const replacementFile = fileContentWithMintedObject({
      encrypted: false,
      fileName: "agreement.docx",
      id: allocateFileObject(),
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdfFileId: null,
      sha256Hex: "a".repeat(64),
      sizeBytes: 128,
      type: "file",
      version: 1,
    });

    const cloned = cloneFieldsForRevision({
      currentFields: [
        {
          content: {
            encrypted: false,
            fileName: "old.docx",
            id: Bun.randomUUIDv7(),
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            pdfFileId: null,
            sha256Hex: "b".repeat(64),
            sizeBytes: 64,
            type: "file",
            version: 1,
          },
          propertyId: filePropertyId,
        },
        {
          content: {
            type: "text",
            value: "Keep me",
            version: 1,
          },
          propertyId: textPropertyId,
        },
      ],
      entityVersionId: nextVersionId,
      propertyId: filePropertyId,
      replacementContent: replacementFile,
      replacementFieldId,
      workspaceId,
    });

    expect(cloned.at(0)).toMatchObject({ id: replacementFieldId });
    expect(cloned.at(1)).not.toHaveProperty("id");
  });
});
