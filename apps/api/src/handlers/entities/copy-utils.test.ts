import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";

import {
  getEntitySubtree,
  remapFileIds,
  type EntitySnapshot,
  type FileMapping,
} from "./copy-utils";

const workspaceId = toSafeId<"workspace">("workspace_1");
const organizationId = toSafeId<"organization">("organization_1");
const firstEntityId = toSafeId<"entity">("entity_1");
const secondEntityId = toSafeId<"entity">("entity_2");
const messageEntityId = toSafeId<"entity">("message_1");
const attachmentEntityId = toSafeId<"entity">("attachment_1");
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

describe("getEntitySubtree", () => {
  const folder = (
    id: SafeId<"entity">,
    parentId: SafeId<"entity"> | null,
  ): EntitySnapshot => ({
    currentVersion: { fields: [] },
    id,
    kind: "folder",
    name: id,
    parentId,
  });

  test("collects the root and every descendant once", () => {
    const child = toSafeId<"entity">("entity_child");
    const grandchild = toSafeId<"entity">("entity_grandchild");
    const subtree = getEntitySubtree(
      [
        folder(firstEntityId, null),
        folder(child, firstEntityId),
        folder(grandchild, child),
        folder(secondEntityId, null),
      ],
      firstEntityId,
    );

    expect(subtree?.map((entity) => entity.id)).toEqual([
      firstEntityId,
      child,
      grandchild,
    ]);
  });

  test("refuses a snapshot whose parent chain closes into a cycle", () => {
    // Two folders each parented to the other: the walk would enqueue forever.
    expect(() =>
      getEntitySubtree(
        [
          folder(firstEntityId, secondEntityId),
          folder(secondEntityId, firstEntityId),
        ],
        firstEntityId,
      ),
    ).toThrow("Entity parent chain contains a cycle");
  });

  test("includes attachment children of an ingested message", () => {
    const subtree = getEntitySubtree(
      [
        {
          currentVersion: { fields: [] },
          id: messageEntityId,
          kind: "message",
          name: "Email.eml",
          parentId: null,
        },
        {
          currentVersion: { fields: [] },
          id: attachmentEntityId,
          kind: "document",
          name: "Attachment.pdf",
          parentId: messageEntityId,
        },
      ],
      messageEntityId,
    );

    expect(subtree?.map((entity) => entity.id)).toEqual([
      messageEntityId,
      attachmentEntityId,
    ]);
  });
});
