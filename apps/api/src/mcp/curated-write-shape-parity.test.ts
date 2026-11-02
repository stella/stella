import { expect, test } from "bun:test";

import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";

import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

const CURATED_WRITE_CAPABILITIES = {
  add_matter_member: {
    noCapabilityReason: "This native tool owns membership orchestration.",
  },
  compare_documents: {
    noCapabilityReason:
      "This native tool owns document comparison orchestration.",
  },
  configure_template_fields: {
    noCapabilityReason: "This native tool owns template configuration.",
  },
  create_organization: ["organizations.create"],
  create_reader_annotation: {
    noCapabilityReason: "This native tool owns reader annotations.",
  },
  create_template: {
    noCapabilityReason: "This native tool owns template creation.",
  },
  delete_clause: {
    noCapabilityReason: "This native tool owns clause deletion.",
  },
  delete_contact: {
    noCapabilityReason: "This native tool owns contact deletion.",
  },
  delete_document: {
    noCapabilityReason: "This native tool owns document deletion.",
  },
  delete_matter: {
    noCapabilityReason: "This native tool owns matter deletion.",
  },
  delete_reader_annotation: {
    noCapabilityReason: "This native tool owns reader annotations.",
  },
  delete_task: { noCapabilityReason: "This native tool owns task deletion." },
  delete_time_entry: {
    noCapabilityReason: "This native tool owns time-entry deletion.",
  },
  fill_template: {
    noCapabilityReason: "This native tool owns template filling.",
  },
  link_matter_contact: {
    noCapabilityReason: "This native tool owns matter-contact links.",
  },
  mint_web_handoff: {
    noCapabilityReason:
      "This tool mints a consent-checked handoff rather than calling a capability.",
  },
  open_document_version_upload: {
    noCapabilityReason: "This app-only tool opens the upload UI.",
  },
  open_file_comparison: {
    noCapabilityReason: "This app-only tool opens the file-comparison UI.",
  },
  prepare_file_comparison: {
    noCapabilityReason:
      "This native tool prepares an uploaded-file comparison.",
  },
  prepare_file_comparison_from_links: {
    noCapabilityReason:
      "This native tool prepares a comparison from external links.",
  },
  remove_matter_member: {
    noCapabilityReason: "This native tool owns membership orchestration.",
  },
  run_playbook: {
    noCapabilityReason: "This native tool owns playbook execution.",
  },
  save_clause: {
    noCapabilityReason: "This native tool owns clause persistence.",
  },
  save_matter: ["matters.create", "matters.update"],
  save_contact: ["contacts.create", "contacts.update"],
  save_document: {
    noCapabilityReason: "This native tool owns document persistence.",
  },
  save_filled_template: {
    noCapabilityReason: "This native tool owns filled-template persistence.",
  },
  save_playbook: {
    noCapabilityReason: "This native tool owns playbook persistence.",
  },
  save_task: ["tasks.create", "tasks.update"],
  save_time_entry: {
    noCapabilityReason: "This native tool owns time-entry persistence.",
  },
  set_field_value: {
    noCapabilityReason: "This native tool owns entity-field persistence.",
  },
  set_practice_jurisdictions: {
    noCapabilityReason:
      "This native tool owns organization jurisdiction settings.",
  },
  submit_feedback: {
    noCapabilityReason:
      "This native tool submits feedback to an external service.",
  },
  update_organization_settings: {
    noCapabilityReason: "This native tool owns organization settings.",
  },
  update_reader_annotation: {
    noCapabilityReason: "This native tool owns reader annotations.",
  },
  upload_document_version: {
    noCapabilityReason:
      "This tool orchestrates the reserve, upload, finalize, and abort lifecycle.",
  },
  write_capability: {
    noCapabilityReason:
      "The target capability is selected dynamically from the call input.",
  },
} as const satisfies Record<CuratedWriteTool, CuratedWriteCapabilityMapping>;

type RegisteredTool = (typeof DEFAULT_MCP_TOOL_DEFINITIONS)[number];
type CuratedWriteTool = Extract<RegisteredTool, { access: "write" }>["name"];
type CuratedWriteCapabilityMapping =
  readonly string[] | { readonly noCapabilityReason: string };
const hasNoCapabilityReason = (
  mapping: CuratedWriteCapabilityMapping,
): mapping is { readonly noCapabilityReason: string } =>
  !Array.isArray(mapping);
type ShapeExclusion = {
  capability: string;
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
    capability: "matters.update",
    field: "billingNarrativeLanguage",
    reason:
      "The narrative language only steers activity billing drafts and is set through the matter capability.",
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

test("every curated write exposes every field of each backing capability", () => {
  const catalog = readCapabilityCatalog();
  const registeredWriteNames = DEFAULT_MCP_TOOL_DEFINITIONS.flatMap(
    (definition) => (definition.access === "write" ? [definition.name] : []),
  );
  expect(Object.keys(CURATED_WRITE_CAPABILITIES).toSorted()).toEqual(
    registeredWriteNames.toSorted(),
  );
  for (const [toolName, mapping] of Object.entries(
    CURATED_WRITE_CAPABILITIES,
  )) {
    const tool = DEFAULT_MCP_TOOL_DEFINITIONS.find(
      ({ name }) => name === toolName,
    );
    expect(tool, toolName).toBeDefined();
    if (hasNoCapabilityReason(mapping)) {
      expect(mapping.noCapabilityReason.length, toolName).toBeGreaterThan(0);
      continue;
    }
    const toolFields = new Set(Object.keys(tool?.inputSchema.properties ?? {}));
    for (const id of mapping) {
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
