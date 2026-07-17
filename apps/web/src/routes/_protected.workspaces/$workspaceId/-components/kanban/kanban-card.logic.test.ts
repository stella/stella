import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import { getInternalPropertyId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

import {
  getKanbanCardMetadataVisibility,
  getKanbanCardRenameInitialValue,
} from "./kanban-card.logic";

describe("kanban card metadata visibility", () => {
  test("preserves task metadata chips for non-task cards", () => {
    const visibility = getKanbanCardMetadataVisibility(
      [
        getInternalPropertyId("status"),
        getInternalPropertyId("priority"),
        getInternalPropertyId("due-date"),
      ],
      false,
    );

    expect(visibility).toEqual({
      showStatus: true,
      showPriority: true,
      showDueDate: true,
    });
  });

  test("leaves task metadata to task-specific badges", () => {
    const visibility = getKanbanCardMetadataVisibility(
      [
        getInternalPropertyId("status"),
        getInternalPropertyId("priority"),
        getInternalPropertyId("due-date"),
      ],
      true,
    );

    expect(visibility).toEqual({
      showStatus: false,
      showPriority: false,
      showDueDate: false,
    });
  });
});

describe("kanban card rename initial value", () => {
  const titlePropertyId = toSafeId<"property">("title");

  test("prefers editable text field value over the rendered fallback name", () => {
    const entity = createEntity({
      fields: {
        [titlePropertyId]: {
          entityId: toSafeId<"entity">("entity-1"),
          id: toSafeId<"field">("field-1"),
          propertyId: titlePropertyId,
          content: { type: "text", version: 1, value: "Contract title" },
        },
      },
    });

    expect(getKanbanCardRenameInitialValue(entity, "Contract.pdf")).toBe(
      "Contract title",
    );
  });

  test("falls back when the text field is empty", () => {
    const entity = createEntity({
      fields: {
        [titlePropertyId]: {
          entityId: toSafeId<"entity">("entity-1"),
          id: toSafeId<"field">("field-1"),
          propertyId: titlePropertyId,
          content: { type: "text", version: 1, value: "  " },
        },
      },
    });

    expect(getKanbanCardRenameInitialValue(entity, "Contract.pdf")).toBe(
      "Contract.pdf",
    );
  });
});

type EntityInput = Parameters<typeof getKanbanCardRenameInitialValue>[0];

const createEntity = (overrides: Partial<EntityInput>): EntityInput => ({
  entityId: toSafeId<"entity">("entity-1"),
  kind: "document",
  name: null,
  parentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: null,
  createdByImage: null,
  createdByDeletedAt: null,
  updatedAt: null,
  version: 1,
  status: null,
  priority: null,
  listItemType: "event",
  dueDate: null,
  agendaKind: "event",
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
  fields: {},
  cellMetadata: {},
  ...overrides,
});
