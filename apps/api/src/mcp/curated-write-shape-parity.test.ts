import { expect, test } from "bun:test";

import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";

import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

const CURATED_WRITE_CAPABILITIES = {
  save_matter: ["matters.create", "matters.update"],
  save_contact: ["contacts.create", "contacts.update"],
  save_task: ["tasks.create", "tasks.update"],
} as const;

type CuratedWriteTool = keyof typeof CURATED_WRITE_CAPABILITIES;
type ShapeExclusion = {
  capability: (typeof CURATED_WRITE_CAPABILITIES)[CuratedWriteTool][number];
  field: string;
  reason: string;
};

const SHAPE_EXCLUSIONS: readonly ShapeExclusion[] = [
  {
    capability: "matters.create",
    field: "id",
    reason: "Allocated by the tool.",
  },
  {
    capability: "matters.create",
    field: "filePropertyName",
    reason: "The tool applies the standard document-column name.",
  },
  {
    capability: "matters.create",
    field: "memberUserIds",
    reason: "Matter membership is managed by the member capability.",
  },
  {
    capability: "matters.update",
    field: "expectedClientId",
    reason: "Optimistic client reassignment is an HTTP concurrency control.",
  },
  {
    capability: "matters.update",
    field: "color",
    reason: "Matter colour is presentation metadata.",
  },
  {
    capability: "matters.update",
    field: "leadUserId",
    reason: "Matter leads are managed with membership.",
  },
  {
    capability: "contacts.create",
    field: "id",
    reason: "Allocated by the tool.",
  },
  {
    capability: "tasks.create",
    field: "parentId",
    reason: "Task hierarchy is managed separately.",
  },
  {
    capability: "tasks.create",
    field: "agendaKind",
    reason: "Agenda events use the calendar capability.",
  },
  {
    capability: "tasks.create",
    field: "listPosition",
    reason: "List ordering is managed by list operations.",
  },
  {
    capability: "tasks.create",
    field: "ownerUserId",
    reason: "Governed-work ownership is managed by workflow capabilities.",
  },
  {
    capability: "tasks.create",
    field: "workingTargetDate",
    reason: "Governed deadlines use workflow capabilities.",
  },
  {
    capability: "tasks.create",
    field: "hardDeadlineDate",
    reason: "Governed deadlines use workflow capabilities.",
  },
  {
    capability: "tasks.create",
    field: "sourceDescription",
    reason: "Governed-work provenance is not an ordinary task field.",
  },
  {
    capability: "tasks.update",
    field: "agendaKind",
    reason: "Agenda events use the calendar capability.",
  },
  {
    capability: "tasks.update",
    field: "sortOrder",
    reason: "List ordering is managed by list operations.",
  },
  ...[
    "startAt",
    "endAt",
    "occurredAt",
    "remindAt",
    "allDay",
    "timeZone",
    "location",
    "onlineMeetingUrl",
    "availability",
    "sensitivity",
    "organizer",
    "attendees",
    "recurrence",
  ].flatMap((field) => [
    {
      capability: "tasks.create",
      field,
      reason: "Agenda fields use the calendar capability.",
    } satisfies ShapeExclusion,
    {
      capability: "tasks.update",
      field,
      reason: "Agenda fields use the calendar capability.",
    } satisfies ShapeExclusion,
  ]),
];

const FIELD_PROJECTIONS: Readonly<Record<string, string>> = {
  "tasks.create.assigneeIds": "assignee",
  "tasks.create.listDescription": "description",
  "tasks.create.listItemType": "item_type",
  "tasks.update.listItemType": "item_type",
};

const objectValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : null;

const bodyProperties = (entry: unknown): readonly string[] => {
  const input = objectValue(entry);
  const schema = objectValue(input?.["inputSchema"]);
  const body = objectValue(schema?.["body"]);
  const properties = objectValue(body?.["properties"]);
  return properties === null ? [] : Object.keys(properties);
};

const capabilityId = (entry: unknown): string | null => {
  const object = objectValue(entry);
  return typeof object?.["id"] === "string" ? object["id"] : null;
};

const snakeCase = (field: string): string =>
  field.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

test("curated matter, contact and task writes expose every capability field", () => {
  const catalog = readCapabilityCatalog();
  for (const [toolName, capabilityIds] of Object.entries(
    CURATED_WRITE_CAPABILITIES,
  )) {
    const tool = DEFAULT_MCP_TOOL_DEFINITIONS.find(
      ({ name }) => name === toolName,
    );
    expect(tool, toolName).toBeDefined();
    const toolFields = new Set(Object.keys(tool?.inputSchema.properties ?? {}));
    for (const id of capabilityIds) {
      const capability = catalog.find((entry) => capabilityId(entry) === id);
      expect(capability, id).toBeDefined();
      const missing = bodyProperties(capability).filter((field) => {
        const projected =
          FIELD_PROJECTIONS[`${id}.${field}`] ?? snakeCase(field);
        const excluded = SHAPE_EXCLUSIONS.some(
          (item) => item.capability === id && item.field === field,
        );
        return !toolFields.has(projected) && !excluded;
      });
      expect(missing, `${id} fields missing from ${toolName}`).toEqual([]);
    }
  }
});
