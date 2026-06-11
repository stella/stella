import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import { allocateFileObject } from "@/api/handlers/files/file-object-ids";
import { toSafeId } from "@/api/lib/branded-types";

import {
  remapFileIds,
  type EntitySnapshot,
  type FileMapping,
} from "./copy-utils";

const workspaceId = toSafeId<"workspace">("workspace_1");
const organizationId = toSafeId<"organization">("organization_1");
const firstEntityId = toSafeId<"entity">("entity_1");
const secondEntityId = toSafeId<"entity">("entity_2");
const filePropertyId = toSafeId<"property">("property_file");

const sharedSourceFile = {
  encrypted: false,
  fileName: "shared.pdf",
  id: "shared-source-file",
  mimeType: "application/pdf",
  pdfFileId: null,
  sha256Hex: "a".repeat(64),
  sizeBytes: 42,
  type: "file",
  version: 1,
} satisfies FieldContent;

describe("remapFileIds", () => {
  test("remaps by field occurrence rather than shared source file id", () => {
    const sourceEntities: EntitySnapshot[] = [
      {
        currentVersion: {
          fields: [{ content: sharedSourceFile, propertyId: filePropertyId }],
        },
        id: firstEntityId,
        kind: "document",
        name: "First.pdf",
        parentId: null,
      },
      {
        currentVersion: {
          fields: [{ content: sharedSourceFile, propertyId: filePropertyId }],
        },
        id: secondEntityId,
        kind: "document",
        name: "Second.pdf",
        parentId: null,
      },
    ];
    const firstNewFileId = allocateFileObject();
    const secondNewFileId = allocateFileObject();
    const mappings: FileMapping[] = [
      {
        mimeType: sharedSourceFile.mimeType,
        newFileId: firstNewFileId,
        sourceEntityId: firstEntityId,
        sourceFileId: sharedSourceFile.id,
        sourceKey: `${organizationId}/${workspaceId}/${sharedSourceFile.id}.pdf`,
        sourcePropertyId: filePropertyId,
        targetKey: `${organizationId}/${workspaceId}/${firstNewFileId}.pdf`,
      },
      {
        mimeType: sharedSourceFile.mimeType,
        newFileId: secondNewFileId,
        sourceEntityId: secondEntityId,
        sourceFileId: sharedSourceFile.id,
        sourceKey: `${organizationId}/${workspaceId}/${sharedSourceFile.id}.pdf`,
        sourcePropertyId: filePropertyId,
        targetKey: `${organizationId}/${workspaceId}/${secondNewFileId}.pdf`,
      },
    ];

    const remapped = remapFileIds(sourceEntities, mappings);
    const firstContent = remapped.at(0)?.currentVersion?.fields.at(0)?.content;
    const secondContent = remapped.at(1)?.currentVersion?.fields.at(0)?.content;

    expect(firstContent?.type).toBe("file");
    expect(secondContent?.type).toBe("file");
    if (firstContent?.type !== "file" || secondContent?.type !== "file") {
      throw new Error("Expected remapped file fields");
    }

    expect(firstContent.id).toBe(firstNewFileId);
    expect(secondContent.id).toBe(secondNewFileId);
    expect(firstContent.id).not.toBe(secondContent.id);
  });
});
