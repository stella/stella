import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";

import {
  collectFileCopySources,
  getFolderSubtree,
  remapFileIds,
  type EntitySnapshot,
  type EntityFieldSnapshot,
  type EntityVersionSnapshot,
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

type VersionFixture = {
  id: string;
  versionNumber?: number;
  fields: EntityFieldSnapshot[];
};

const version = ({
  id,
  versionNumber = 1,
  fields,
}: VersionFixture): EntityVersionSnapshot => ({
  id: toSafeId<"entityVersion">(id),
  versionNumber,
  stamp: null,
  label: null,
  description: null,
  diffWordsAdded: null,
  diffWordsRemoved: null,
  createdBy: null,
  source: null,
  collaborationContributorUserIds: null,
  detectedLanguage: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  fields,
});

const fileField = (id: string): EntityFieldSnapshot => ({
  id: toSafeId<"field">(id),
  content: sharedSourceFile,
  propertyId: filePropertyId,
});

const documentWith = (
  id: SafeId<"entity">,
  versions: EntityVersionSnapshot[],
): EntitySnapshot => ({
  currentVersionId: versions.at(-1)?.id ?? null,
  id,
  kind: "document",
  name: `${id}.pdf`,
  parentId: null,
  versions,
});

describe("collectFileCopySources", () => {
  test("copies one object per source file per entity", () => {
    const sources = collectFileCopySources({
      sourceEntities: [
        documentWith(firstEntityId, [
          version({
            id: "version_1",
            versionNumber: 1,
            fields: [fileField("field_1")],
          }),
          version({
            id: "version_2",
            versionNumber: 2,
            fields: [fileField("field_2")],
          }),
        ]),
        documentWith(secondEntityId, [
          version({ id: "version_3", fields: [fileField("field_3")] }),
        ]),
      ],
      organizationId,
      sourceWorkspaceId: workspaceId,
    });

    // Both versions of the first document point at one object, so the move
    // copies it once and both carried versions reference that copy.
    expect(
      sources.map(({ sourceEntityId, sourceFileId }) => ({
        sourceEntityId,
        sourceFileId,
      })),
    ).toEqual([
      { sourceEntityId: firstEntityId, sourceFileId: sharedSourceFile.id },
      { sourceEntityId: secondEntityId, sourceFileId: sharedSourceFile.id },
    ]);
  });
});

describe("remapFileIds", () => {
  test("remaps per entity rather than by shared source file id", () => {
    const sourceEntities: EntitySnapshot[] = [
      documentWith(firstEntityId, [
        version({ id: "version_1", fields: [fileField("field_1")] }),
      ]),
      documentWith(secondEntityId, [
        version({ id: "version_2", fields: [fileField("field_2")] }),
      ]),
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
        targetKey: `${organizationId}/${workspaceId}/${firstNewFileId}.pdf`,
      },
      {
        mimeType: sharedSourceFile.mimeType,
        newFileId: secondNewFileId,
        sourceEntityId: secondEntityId,
        sourceFileId: sharedSourceFile.id,
        sourceKey: `${organizationId}/${workspaceId}/${sharedSourceFile.id}.pdf`,
        targetKey: `${organizationId}/${workspaceId}/${secondNewFileId}.pdf`,
      },
    ];

    const remapped = remapFileIds(sourceEntities, mappings);
    const firstContent = remapped.at(0)?.versions.at(0)?.fields.at(0)?.content;
    const secondContent = remapped.at(1)?.versions.at(0)?.fields.at(0)?.content;

    expect(firstContent?.type).toBe("file");
    expect(secondContent?.type).toBe("file");
    if (firstContent?.type !== "file" || secondContent?.type !== "file") {
      throw new Error("Expected remapped file fields");
    }

    expect(firstContent.id).toBe(firstNewFileId);
    expect(secondContent.id).toBe(secondNewFileId);
    expect(firstContent.id).not.toBe(secondContent.id);
  });

  test("points every carried version at the one copy of a shared file", () => {
    const newFileId = allocateFileObject();
    const remapped = remapFileIds(
      [
        documentWith(firstEntityId, [
          version({
            id: "version_1",
            versionNumber: 1,
            fields: [fileField("field_1")],
          }),
          version({
            id: "version_2",
            versionNumber: 2,
            fields: [fileField("field_2")],
          }),
        ]),
      ],
      [
        {
          mimeType: sharedSourceFile.mimeType,
          newFileId,
          sourceEntityId: firstEntityId,
          sourceFileId: sharedSourceFile.id,
          sourceKey: `${organizationId}/${workspaceId}/${sharedSourceFile.id}.pdf`,
          targetKey: `${organizationId}/${workspaceId}/${newFileId}.pdf`,
        },
      ],
    );

    const fileIds = remapped
      .at(0)
      ?.versions.flatMap(({ fields }) =>
        fields.flatMap((field) =>
          field.content.type === "file" ? [field.content.id] : [],
        ),
      );

    expect(fileIds).toEqual([newFileId, newFileId]);
  });
});

describe("getFolderSubtree", () => {
  const folder = (
    id: SafeId<"entity">,
    parentId: SafeId<"entity"> | null,
  ): EntitySnapshot => ({
    currentVersionId: toSafeId<"entityVersion">(`version_${id}`),
    id,
    kind: "folder",
    name: id,
    parentId,
    versions: [version({ id: `version_${id}`, fields: [] })],
  });

  test("collects the root and every descendant once", () => {
    const child = toSafeId<"entity">("entity_child");
    const grandchild = toSafeId<"entity">("entity_grandchild");
    const subtree = getFolderSubtree(
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
      getFolderSubtree(
        [
          folder(firstEntityId, secondEntityId),
          folder(secondEntityId, firstEntityId),
        ],
        firstEntityId,
      ),
    ).toThrow("Entity parent chain contains a cycle");
  });
});
