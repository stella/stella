import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import type {
  WorkspaceEntity,
  WorkspaceField,
  WorkspaceProperty,
} from "@/lib/types";

import {
  isAIExtractionProperty,
  resolveAiCellTargets,
  type AIExtractionProperty,
} from "./table-column.logic";

const entity = (
  fields: WorkspaceEntity["fields"],
  overrides: Partial<WorkspaceEntity> = {},
): WorkspaceEntity => ({
  entityId: toSafeId<"entity">("entity-1"),
  kind: "document",
  name: "Source document",
  parentId: null,
  createdAt: "2026-06-12T00:00:00.000Z",
  createdBy: null,
  createdByImage: null,
  createdByDeletedAt: null,
  updatedAt: null,
  version: 1,
  status: null,
  priority: null,
  listItemType: "task",
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
  fields,
  cellMetadata: {},
  ...overrides,
});

const aiProperty = (id: string): AIExtractionProperty => ({
  id: toSafeId<"property">(id),
  name: "AI summary",
  createdAt: new Date("2026-06-12T00:00:00.000Z"),
  workspaceId: toSafeId<"workspace">("workspace-1"),
  status: "fresh",
  content: { version: 1, type: "text" },
  tool: {
    version: 1,
    type: "ai-model",
    prompt: "Extract a summary",
    dependencies: [],
  },
});

const manualProperty = (
  id: string,
  content: WorkspaceProperty["content"],
): WorkspaceProperty => ({
  id: toSafeId<"property">(id),
  name: id,
  createdAt: new Date("2026-06-12T00:00:00.000Z"),
  workspaceId: toSafeId<"workspace">("workspace-1"),
  status: "fresh",
  content,
  tool: { version: 1, type: "manual-input" },
});

describe("AI table cell targets", () => {
  test("keeps the source file id separate from the AI retry property id", () => {
    const extractionProperty = aiProperty("ai-property");
    const extractionField = {
      entityId: toSafeId<"entity">("entity-1"),
      id: toSafeId<"field">("ai-field"),
      propertyId: toSafeId<"property">("ai-property"),
      content: { version: 1, type: "text", value: "Extracted value" },
    } satisfies WorkspaceField;

    const targets = resolveAiCellTargets({
      entity: entity({
        [toSafeId<"property">("ai-property")]: extractionField,
        [toSafeId<"property">("file-property")]: {
          entityId: toSafeId<"entity">("entity-1"),
          id: toSafeId<"field">("file-field"),
          propertyId: toSafeId<"property">("file-property"),
          content: {
            version: 1,
            type: "file",
            id: toSafeId<"userFile">("file-1"),
            fileName: "contract.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
            encrypted: true,
            sha256Hex: "abc123",
            pdfFileId: toSafeId<"userFile">("pdf-file-1"),
          },
        },
      }),
      extractionField,
      extractionProperty,
      justificationFileFieldId: toSafeId<"field">("file-field"),
    });

    expect(targets?.sourceFile).toMatchObject({
      type: "source-file",
      fieldId: "file-field",
      propertyId: "file-property",
      fileName: "contract.pdf",
    });
    expect(targets?.extraction).toMatchObject({
      type: "ai-extraction",
      entityId: "entity-1",
      fieldId: "ai-field",
      property: { id: "ai-property" },
    });
    expect(targets?.sourceFile.propertyId).not.toBe(
      targets?.extraction.property.id,
    );
  });

  test("only AI non-file properties are retryable extraction properties", () => {
    expect(isAIExtractionProperty(aiProperty("ai-property"))).toBe(true);
    expect(
      isAIExtractionProperty(
        manualProperty("manual-file", { version: 1, type: "file" }),
      ),
    ).toBe(false);
    expect(
      isAIExtractionProperty({
        ...aiProperty("ai-file"),
        content: { version: 1, type: "file" },
      }),
    ).toBe(false);
  });
});
