import { describe, expect, test } from "bun:test";

import type { TableTreeNode } from "@/components/workspaces/table/types";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity } from "@/lib/types";

import { calculateFolderStatistics } from "./folder-statistics.logic";

const entityId = (value: string) => toSafeId<"entity">(value);

type EntityOptions = {
  children?: TableTreeNode[];
  sizeBytes?: number;
};

const entity = (
  id: string,
  kind: WorkspaceEntity["kind"],
  { children = [], sizeBytes }: EntityOptions = {},
): TableTreeNode => {
  const safeEntityId = entityId(id);
  const propertyId = toSafeId<"property">(`property-${id}`);

  return {
    entityId: safeEntityId,
    kind,
    name: id,
    parentId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    createdBy: null,
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
    children,
  };
};

describe("folder statistics", () => {
  test("aggregates all descendant files through nested and empty folders", () => {
    const statistics = calculateFolderStatistics([
      entity("root", "folder", {
        children: [
          entity("direct-document", "document", { sizeBytes: 100 }),
          entity("nested", "folder", {
            children: [
              entity("nested-document", "document", { sizeBytes: 250 }),
              entity("deep", "folder", {
                children: [
                  entity("deep-document", "document", { sizeBytes: 25 }),
                ],
              }),
            ],
          }),
          entity("empty", "folder"),
        ],
      }),
    ]);

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
    const directFile = entity("direct-document", "document", {
      sizeBytes: 125,
    });
    const childFolder = entity("child", "folder", {
      children: [
        entity("child-document", "document", { sizeBytes: 275 }),
        entity("missing-file-field", "document"),
      ],
    });
    const statistics = calculateFolderStatistics([
      entity("parent", "folder", { children: [directFile, childFolder] }),
    ]);
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
});
