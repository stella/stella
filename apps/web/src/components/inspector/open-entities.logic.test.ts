import { describe, expect, test } from "bun:test";

import type { InspectorOpenTarget } from "@/components/inspector/inspector-store-types";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity } from "@/lib/types";

import { planInspectorOpen } from "./open-entities.logic";

const WORKSPACE_ID = "workspace-1";

const entity = (
  entityId: string,
  kind: WorkspaceEntity["kind"],
  fields: WorkspaceEntity["fields"] = {},
): WorkspaceEntity => ({
  entityId: toSafeId<"entity">(entityId),
  kind,
  name: entityId,
  parentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: null,
  createdByUserId: null,
  createdByImage: null,
  createdByDeletedAt: null,
  updatedAt: null,
  version: 1,
  status: null,
  priority: null,
  listItemType: null,
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
  fields,
});

const fileFields = ({
  entityId,
  fileName,
  mimeType,
  pdfFileId = null,
}: {
  entityId: string;
  fileName: string;
  mimeType: string;
  pdfFileId?: string | null;
}): WorkspaceEntity["fields"] => {
  const propertyId = toSafeId<"property">(`property-${entityId}`);
  return {
    [propertyId]: {
      id: toSafeId<"field">(`field-${entityId}`),
      propertyId,
      entityId: toSafeId<"entity">(entityId),
      content: {
        type: "file",
        version: 1,
        id: `file-${entityId}`,
        fileName,
        mimeType,
        sizeBytes: 1,
        encrypted: false,
        sha256Hex: "a".repeat(64),
        pdfFileId,
      },
    },
  };
};

const pdfEntity = (entityId: string) =>
  entity(
    entityId,
    "document",
    fileFields({
      entityId,
      fileName: `${entityId}.pdf`,
      mimeType: "application/pdf",
    }),
  );

/** The targets a selection opens; every entity is its own anchor here
 *  because these tests are about which tabs open, not which one focuses. */
const targetsOf = (
  entities: readonly WorkspaceEntity[],
  workspaceId: string,
): readonly InspectorOpenTarget[] =>
  planInspectorOpen({
    entities,
    anchor: entities[0] ?? entity("none", "document", {}),
    workspaceId,
  })?.targets ?? [];

describe("projecting a selection onto inspector tabs", () => {
  test("keeps the caller's order so the tab strip matches the selection", () => {
    const targets = targetsOf(
      [pdfEntity("b"), pdfEntity("a"), pdfEntity("c")],
      WORKSPACE_ID,
    );

    expect(targets.map((target) => target.id)).toEqual([
      "field-b",
      "field-a",
      "field-c",
    ]);
  });

  test("skips folders and files the inspector cannot render", () => {
    const unrenderable = entity(
      "raw",
      "document",
      fileFields({
        entityId: "raw",
        fileName: "archive.zip",
        mimeType: "application/zip",
      }),
    );

    // The fixture must actually be unrenderable, or the assertion is vacuous.
    expect(targetsOf([unrenderable], WORKSPACE_ID)).toEqual([]);
    expect(
      targetsOf(
        [entity("folder", "folder"), unrenderable, pdfEntity("doc")],
        WORKSPACE_ID,
      ).map((target) => target.id),
    ).toEqual(["field-doc"]);
  });

  test("opens the first displayable file, not the first file", () => {
    const zipPropertyId = toSafeId<"property">("property-zip");
    const pdfPropertyId = toSafeId<"property">("property-pdf");
    const mixed = entity("mixed", "document", {
      [zipPropertyId]: {
        id: toSafeId<"field">("field-zip"),
        propertyId: zipPropertyId,
        entityId: toSafeId<"entity">("mixed"),
        content: {
          type: "file",
          version: 1,
          id: "file-zip",
          fileName: "archive.zip",
          mimeType: "application/zip",
          sizeBytes: 1,
          encrypted: false,
          sha256Hex: "a".repeat(64),
          pdfFileId: null,
        },
      },
      [pdfPropertyId]: {
        id: toSafeId<"field">("field-pdf"),
        propertyId: pdfPropertyId,
        entityId: toSafeId<"entity">("mixed"),
        content: {
          type: "file",
          version: 1,
          id: "file-pdf",
          fileName: "brief.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
          encrypted: false,
          sha256Hex: "b".repeat(64),
          pdfFileId: null,
        },
      },
    });

    expect(targetsOf([mixed], WORKSPACE_ID).map((target) => target.id)).toEqual(
      ["field-pdf"],
    );
  });

  test("opens a converted file on its PDF derivative", () => {
    const converted = entity(
      "docx",
      "document",
      fileFields({
        entityId: "docx",
        fileName: "brief.docx",
        mimeType: "application/octet-stream",
        pdfFileId: "pdf-docx",
      }),
    );

    expect(targetsOf([converted], WORKSPACE_ID)).toEqual([
      {
        type: "pdf",
        id: "field-docx",
        entityId: "docx",
        label: "docx",
        fileName: "brief.docx",
        mimeType: "application/octet-stream",
        pdfFileId: "pdf-docx",
        propertyId: "property-docx",
        workspaceId: WORKSPACE_ID,
      },
    ]);
  });

  test("maps a task to a ready task tab", () => {
    expect(targetsOf([entity("t1", "task")], WORKSPACE_ID)).toEqual([
      {
        type: "task",
        id: "t1",
        creationStatus: "ready",
        label: "t1",
        isNew: false,
        workspaceId: WORKSPACE_ID,
      },
    ]);
  });
});

describe("planning which tab a selection focuses", () => {
  test("focuses the anchor rather than the last target opened", () => {
    const anchor = pdfEntity("b");

    expect(
      planInspectorOpen({
        entities: [pdfEntity("a"), anchor, pdfEntity("c")],
        anchor,
        workspaceId: WORKSPACE_ID,
      }),
    ).toMatchObject({ activeId: "field-b" });
  });

  test("falls back to the first target when the anchor cannot open", () => {
    const folder = entity("folder", "folder");

    expect(
      planInspectorOpen({
        entities: [folder, pdfEntity("a")],
        anchor: folder,
        workspaceId: WORKSPACE_ID,
      }),
    ).toMatchObject({ activeId: "field-a" });
  });

  test("has no plan when nothing in the selection can open", () => {
    expect(
      planInspectorOpen({
        entities: [entity("folder", "folder")],
        anchor: entity("folder", "folder"),
        workspaceId: WORKSPACE_ID,
      }),
    ).toBeNull();
  });
});
