import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity } from "@/lib/types";

import { calculateFolderStatistics } from "./folder-statistics.logic";

const entityId = (value: string) => toSafeId<"entity">(value);

type EntityOptions = {
  parentId?: string;
  sizeBytes?: number;
};

const entity = (
  id: string,
  kind: WorkspaceEntity["kind"],
  { parentId, sizeBytes }: EntityOptions = {},
): WorkspaceEntity => {
  const safeEntityId = entityId(id);
  const propertyId = toSafeId<"property">(`property-${id}`);

  return {
    entityId: safeEntityId,
    kind,
    name: id,
    parentId: parentId ? entityId(parentId) : null,
    createdAt: "2025-01-01T00:00:00.000Z",
    createdBy: null,
    createdByUserId: null,
    createdByImage: null,
    createdByDeletedAt: null,
    updatedAt: null,
    version: 1,
    status: null,
    priority: null,
    listItemType: kind === "task" ? "task" : null,
    dueDate: null,
    agendaKind: "task",
    startAt: null,
    endAt: null,
    occurredAt: null,
    remindAt: null,
    allDay: false,
    timeZone: null,
    location: null,
    onlineMeetingUrl: null,
    availability: null,
    sensitivity: null,
    organizer: null,
    attendees: null,
    recurrence: null,
    agendaSource: "manual",
    externalSource: null,
    externalId: null,
    externalChangeKey: null,
    externalICalUid: null,
    readOnly: false,
    sortOrder: null,
    activeEditBy: null,
    cellMetadata: {},
    assignees: [],
    fields:
      sizeBytes === undefined
        ? {}
        : {
            [propertyId]: {
              entityId: safeEntityId,
              id: toSafeId<"field">(`field-${id}`),
              propertyId,
              content: {
                version: 1,
                type: "file",
                id: toSafeId<"userFile">(`file-${id}`),
                fileName: `${id}.pdf`,
                mimeType: "application/pdf",
                sizeBytes,
                encrypted: false,
                sha256Hex: id,
                pdfFileId: null,
              },
            },
          },
  };
};

describe("folder statistics", () => {
  test("aggregates all descendant files through nested and empty folders", () => {
    const statistics = calculateFolderStatistics(
      [
        entity("root", "folder"),
        entity("direct-document", "document", {
          parentId: "root",
          sizeBytes: 100,
        }),
        entity("nested", "folder", { parentId: "root" }),
        entity("nested-document", "document", {
          parentId: "nested",
          sizeBytes: 250,
        }),
        entity("deep", "folder", { parentId: "nested" }),
        entity("deep-document", "document", {
          parentId: "deep",
          sizeBytes: 25,
        }),
        entity("empty", "folder", { parentId: "root" }),
      ],
      [],
    );

    expect(statistics.get(entityId("deep"))).toEqual({
      fileCount: 1,
      totalSizeBytes: 25,
    });
    expect(statistics.get(entityId("nested"))).toEqual({
      fileCount: 2,
      totalSizeBytes: 275,
    });
    expect(statistics.get(entityId("empty"))).toEqual({
      fileCount: 0,
      totalSizeBytes: 0,
    });
    expect(statistics.get(entityId("root"))).toEqual({
      fileCount: 3,
      totalSizeBytes: 375,
    });
  });

  test("keeps parent totals equal to direct files plus child-folder totals", () => {
    const statistics = calculateFolderStatistics(
      [
        entity("parent", "folder"),
        entity("direct-document", "document", {
          parentId: "parent",
          sizeBytes: 125,
        }),
        entity("child", "folder", { parentId: "parent" }),
        entity("child-document", "document", {
          parentId: "child",
          sizeBytes: 275,
        }),
        entity("missing-file-field", "document", { parentId: "child" }),
      ],
      [],
    );
    const childStatistics = statistics.get(entityId("child"));

    expect(childStatistics).toBeDefined();
    if (!childStatistics) {
      throw new Error("Expected child folder statistics");
    }

    expect(statistics.get(entityId("parent"))).toEqual({
      fileCount: 1 + childStatistics.fileCount,
      totalSizeBytes: 125 + childStatistics.totalSizeBytes,
    });
  });

  test("ignores every non-document leaf kind", () => {
    const statistics = calculateFolderStatistics(
      [
        entity("root", "folder"),
        entity("task", "task", { parentId: "root", sizeBytes: 10 }),
        entity("message", "message", { parentId: "root", sizeBytes: 20 }),
        entity("link", "link", { parentId: "root", sizeBytes: 30 }),
      ],
      [],
    );

    expect(statistics.get(entityId("root"))).toEqual({
      fileCount: 0,
      totalSizeBytes: 0,
    });
  });

  test("connects filtered documents through hidden ancestor folders", () => {
    const statistics = calculateFolderStatistics(
      [
        entity("visible-root", "folder"),
        entity("matching-document", "document", {
          parentId: "hidden-folder",
          sizeBytes: 425,
        }),
      ],
      [
        {
          entityId: entityId("hidden-folder"),
          parentId: entityId("visible-root"),
        },
      ],
    );

    expect(statistics.get(entityId("visible-root"))).toEqual({
      fileCount: 1,
      totalSizeBytes: 425,
    });
  });
});
