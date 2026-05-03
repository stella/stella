import { describe, expect, test } from "bun:test";

import {
  buildEntityMentionOption,
  buildWorkspaceMentionOptions,
  getMentionViewScope,
} from "@/components/chat-mention-helpers";
import type { WorkspaceEntity } from "@/lib/types";

describe("buildWorkspaceMentionOptions", () => {
  test("includes only workspaces that have an openable view and preserves workspace ids", () => {
    expect(
      buildWorkspaceMentionOptions({
        firstViewIdsByWorkspaceId: {
          ws_alpha: "view_alpha",
          ws_beta: null,
        },
        workspaces: [
          { id: "ws_alpha", name: "Alpha Matter" },
          { id: "ws_beta", name: "Beta Matter" },
        ],
      }),
    ).toEqual([
      {
        id: "ws_alpha",
        label: "Alpha Matter",
        category: "workspace",
        kind: "workspace",
        mimeType: null,
        sourceViewId: "view_alpha",
      },
    ]);
  });
});

describe("buildEntityMentionOption", () => {
  test("preserves source workspace context for cross-matter entity mentions", () => {
    const entity: WorkspaceEntity = {
      entityId: "ent_1",
      kind: "document",
      name: "Closing Binder",
      parentId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
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
      fields: {
        file: {
          id: "field_1",
          entityId: "ent_1",
          content: {
            version: 1,
            type: "file",
            id: "file_1",
            fileName: "closing-binder.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
            encrypted: false,
            sha256Hex:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            pdfFileId: null,
          },
        },
      },
    };

    expect(
      buildEntityMentionOption({
        entity,
        sourceWorkspaceId: "ws_other",
      }),
    ).toEqual({
      id: "ent_1",
      label: "Closing Binder",
      category: "entity",
      kind: "document",
      mimeType: "application/pdf",
      sourceWorkspaceId: "ws_other",
    });
  });
});

describe("getMentionViewScope", () => {
  test("returns the selected view filters and sorts for mention queries", () => {
    expect(
      getMentionViewScope({
        filters: [
          {
            id: "filter-1",
            field: "property",
            propertyId: "name",
            op: "contains",
            value: "nda",
          },
        ],
        sorts: [{ propertyId: "updatedAt", desc: true }],
      }),
    ).toEqual({
      filters: [
        {
          id: "filter-1",
          field: "property",
          propertyId: "name",
          op: "contains",
          value: "nda",
        },
      ],
      sorts: [{ propertyId: "updatedAt", desc: true }],
    });
  });

  test("falls back to an empty scope when no view is available", () => {
    expect(getMentionViewScope(null)).toEqual({
      filters: [],
      sorts: [],
    });
  });
});
