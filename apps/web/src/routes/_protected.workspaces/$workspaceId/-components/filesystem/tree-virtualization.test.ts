import { describe, expect, test } from "bun:test";

import type { WorkspaceEntity } from "@/lib/types";
import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";

import { flattenFilesystemRows } from "./tree-virtualization";

const entity = (
  entityId: string,
  kind: WorkspaceEntity["kind"],
  children: TableTreeNode[] = [],
): TableTreeNode => ({
  entityId,
  kind,
  name: entityId,
  parentId: null,
  createdAt: "2025-01-01T00:00:00.000Z",
  createdBy: null,
  createdByImage: null,
  updatedAt: null,
  version: 1,
  status: null,
  priority: null,
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
  fields: {},
  children,
});

describe("filesystem row virtualization", () => {
  test("flattens expanded folders depth-first", () => {
    const rows = flattenFilesystemRows(
      [
        entity("folder-a", "folder", [
          entity("doc-a-1", "document"),
          entity("folder-b", "folder", [entity("doc-b-1", "document")]),
        ]),
        entity("doc-root", "document"),
      ],
      new Set(["folder-a", "folder-b"]),
    );

    expect(rows.map((row) => row.node.entityId)).toEqual([
      "folder-a",
      "doc-a-1",
      "folder-b",
      "doc-b-1",
      "doc-root",
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 2, 0]);
    expect(rows.map((row) => row.isLast)).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
    const nestedDoc = rows.at(3);
    expect(nestedDoc).toBeDefined();
    if (!nestedDoc) {
      throw new Error("Expected nested document row");
    }
    expect([...nestedDoc.ancestorIds]).toEqual(["folder-a", "folder-b"]);
    expect(nestedDoc.guideDepths).toEqual([0]);
  });

  test("omits collapsed descendants while preserving later roots", () => {
    const rows = flattenFilesystemRows(
      [
        entity("folder-a", "folder", [
          entity("doc-a-1", "document"),
          entity("folder-b", "folder", [entity("doc-b-1", "document")]),
        ]),
        entity("doc-root", "document"),
      ],
      new Set(["folder-a"]),
    );

    expect(rows.map((row) => row.node.entityId)).toEqual([
      "folder-a",
      "doc-a-1",
      "folder-b",
      "doc-root",
    ]);
    const nestedFolder = rows.at(2);
    expect(nestedFolder).toBeDefined();
    if (!nestedFolder) {
      throw new Error("Expected nested folder row");
    }
    expect([...nestedFolder.ancestorIds]).toEqual(["folder-a"]);
    expect(nestedFolder.guideDepths).toEqual([0]);
  });
});
