import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import type { TemplateWarning } from "@/api/lib/docx/template-warnings";
import type { DescribeTemplateResult } from "@/api/lib/templates/template-fill-service";
import type { TemplateConditionDecisionOutput } from "@/api/mcp/template-condition-decisions";
import type { DescribedTemplateField } from "@/api/mcp/template-field-input";
import {
  PERSON_FIELD_SOURCE,
  toTemplateFieldWireInput,
} from "@/api/mcp/template-field-input";
import { defineTextFieldSpec } from "@/api/mcp/text-field-spec";
import type { McpTextFieldSpec } from "@/api/mcp/tool-types";

// --- Text-field specs (plan 049, Option B) --------------------------------
//
// Both anonymize-mode branches of list_templates are org-scoped: templates
// have no owning workspace, so `organizationId` is the anonymization scope
// for every field below. `organizationId` is not part of either served
// payload, so (unlike a per-item workspace id already sitting in the
// payload) it must be threaded in as a builder argument rather than read off
// an item. `TEMPLATE_TOOL_DEFINITIONS` below calls these same builders with a
// placeholder id purely to derive the documented `textFields` path list:
// `deriveTextFieldPaths` only reads each spec's static `path`, never `scope`,
// so the placeholder never affects the declaration.

type TemplateListItem = {
  name: string;
  tags: string[] | null;
  whenNotToUse: string | null;
  whenToUse: string | null;
};

type TemplateListPayload = { templates: readonly TemplateListItem[] };

/** Every tag on every listed template, paired with its own index into the
 * owning `tags` array so `apply` writes back through that same array
 * reference rather than a detached copy. */
const templateTagItems = (
  payload: TemplateListPayload,
): readonly { index: number; tags: string[] }[] =>
  payload.templates.flatMap((template) => {
    const tags = template.tags;
    return tags ? tags.map((_tag, index) => ({ index, tags })) : [];
  });

export const buildTemplateListTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<TemplateListPayload>[] => [
  defineTextFieldSpec({
    path: "templates[].name",
    items: (payload: TemplateListPayload) => payload.templates,
    scope: () => organizationId,
    read: (template: TemplateListItem) => template.name,
    apply: (template: TemplateListItem, value) => {
      template.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "templates[].whenToUse",
    items: (payload: TemplateListPayload) => payload.templates,
    scope: () => organizationId,
    read: (template: TemplateListItem) => template.whenToUse,
    apply: (template: TemplateListItem, value) => {
      template.whenToUse = value;
    },
  }),
  defineTextFieldSpec({
    path: "templates[].whenNotToUse",
    items: (payload: TemplateListPayload) => payload.templates,
    scope: () => organizationId,
    read: (template: TemplateListItem) => template.whenNotToUse,
    apply: (template: TemplateListItem, value) => {
      template.whenNotToUse = value;
    },
  }),
  defineTextFieldSpec({
    path: "templates[].tags[]",
    items: templateTagItems,
    scope: () => organizationId,
    read: (item: { index: number; tags: string[] }) => item.tags[item.index],
    apply: (item: { index: number; tags: string[] }, value) => {
      item.tags[item.index] = value;
    },
  }),
];

// Detail-mode payload: the success variant of `describeStoredTemplate`'s
// result (the error variant is handled and returned before a spec ever runs).
type TemplateDetailSuccess = Extract<
  DescribeTemplateResult,
  { fields: unknown[] }
>;

/**
 * The `configure_template_fields` call to make next, spelled out: one entry
 * per configurable path, carrying the source the template already has (a
 * freshly created template has `person` everywhere) and nothing else the
 * caller has not decided. Copying and editing this beats inferring the path
 * vocabulary, and sending it back unchanged is a no-op.
 *
 * Loop item paths are included even though the manifest folds them into their
 * array root, because they are configurable and an agent has no other way to
 * learn how they are spelled.
 */
const configureSkeleton = (
  templateId: SafeId<"template">,
  payload: {
    fields: readonly DescribedTemplateField[];
    arrays: TemplateDetailSuccess["arrays"];
  },
) => {
  const configured = new Set(payload.fields.map((field) => field.path));
  return {
    template_id: templateId,
    fields: [
      ...payload.fields.map((field) => ({
        path: field.path,
        // The default carries no decision, so it stays out of the skeleton.
        ...(field.input_type === undefined || field.input_type === "text"
          ? {}
          : { input_type: field.input_type }),
        // The SAME object the field above carries, never a copy: the
        // anonymized surface rewrites an AI prompt and a lookup format
        // template in place through `fields[].source`, and a copy here would
        // hand back the original text the redaction just removed. The label
        // is deliberately absent for that reason — it is a string, so it
        // cannot be shared, and it is already in `fields[]` to read.
        source: field.source,
      })),
      ...payload.arrays.flatMap((group) =>
        group.itemFieldPaths
          .map((itemPath) => `${group.path}.${itemPath}`)
          .filter((path) => !configured.has(path))
          .map((path) => ({ path, source: PERSON_FIELD_SOURCE })),
      ),
    ],
  };
};

export const toTemplateDetailPayload = (
  templateId: SafeId<"template">,
  payload: TemplateDetailSuccess,
) => {
  const fields = payload.fields.map((field) => ({
    ...toTemplateFieldWireInput(field),
    input_type: field.inputType,
    required: field.required,
    visibleWhen: field.visibleWhen,
  }));
  return {
    ...payload,
    fields,
    configure: configureSkeleton(templateId, {
      arrays: payload.arrays,
      fields,
    }),
  };
};

export type TemplateDetailPayload = ReturnType<typeof toTemplateDetailPayload>;
type TemplateDetailField = TemplateDetailPayload["fields"][number];
type TemplateDetailCondition = TemplateDetailPayload["conditions"][number];

const templateFieldOptionItems = (
  payload: TemplateDetailPayload,
): readonly { index: number; options: string[] }[] =>
  payload.fields.flatMap((field) => {
    const options = field.options;
    return options ? options.map((_option, index) => ({ index, options })) : [];
  });

const templateFieldFormatItems = (
  payload: TemplateDetailPayload,
): readonly { key: string; template: string }[] =>
  payload.fields.flatMap((field) =>
    field.source.type === "lookup" ? arrayOrEmpty(field.source.formats) : [],
  );

export const buildTemplateDetailTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<TemplateDetailPayload>[] => [
  defineTextFieldSpec({
    path: "name",
    items: (payload: TemplateDetailPayload) => [payload],
    scope: () => organizationId,
    read: (payload: TemplateDetailPayload) => payload.name,
    apply: (payload: TemplateDetailPayload, value) => {
      payload.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "fields[].label",
    items: (payload: TemplateDetailPayload) => payload.fields,
    scope: () => organizationId,
    read: (field: TemplateDetailField) => field.label,
    apply: (field: TemplateDetailField, value) => {
      field.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "fields[].hint",
    items: (payload: TemplateDetailPayload) => payload.fields,
    scope: () => organizationId,
    read: (field: TemplateDetailField) => field.hint,
    apply: (field: TemplateDetailField, value) => {
      field.hint = value;
    },
  }),
  defineTextFieldSpec({
    path: "fields[].source.prompt",
    items: (payload: TemplateDetailPayload) => payload.fields,
    scope: () => organizationId,
    read: (field: TemplateDetailField) =>
      field.source.type === "ai" ? field.source.prompt : undefined,
    apply: (field: TemplateDetailField, value) => {
      if (field.source.type === "ai") {
        field.source.prompt = value;
      }
    },
  }),
  defineTextFieldSpec({
    path: "fields[].options[]",
    items: templateFieldOptionItems,
    scope: () => organizationId,
    read: (item: { index: number; options: string[] }) =>
      item.options[item.index],
    apply: (item: { index: number; options: string[] }, value) => {
      item.options[item.index] = value;
    },
  }),
  defineTextFieldSpec({
    path: "fields[].source.formats[].template",
    items: templateFieldFormatItems,
    scope: () => organizationId,
    read: (format: { key: string; template: string }) => format.template,
    apply: (format: { key: string; template: string }, value) => {
      format.template = value;
    },
  }),
  defineTextFieldSpec({
    path: "conditions[].prompt",
    items: (payload: TemplateDetailPayload) => payload.conditions,
    scope: () => organizationId,
    read: (condition: TemplateDetailCondition) =>
      condition.kind === "ai" ? condition.prompt : undefined,
    apply: (condition: TemplateDetailCondition, value) => {
      if (condition.kind === "ai") {
        condition.prompt = value;
      }
    },
  }),
  defineTextFieldSpec({
    path: "warnings[].path",
    items: (payload: TemplateDetailPayload) => arrayOrEmpty(payload.warnings),
    scope: () => organizationId,
    read: (warning: TemplateWarning) => warning.path,
    apply: (warning: TemplateWarning, value) => {
      warning.path = value;
    },
  }),
  defineTextFieldSpec({
    path: "warnings[].message",
    items: (payload: TemplateDetailPayload) => arrayOrEmpty(payload.warnings),
    scope: () => organizationId,
    read: (warning: TemplateWarning) => warning.message,
    apply: (warning: TemplateWarning, value) => {
      warning.message = value;
    },
  }),
  defineTextFieldSpec({
    path: "warnings[].hint",
    items: (payload: TemplateDetailPayload) => arrayOrEmpty(payload.warnings),
    scope: () => organizationId,
    read: (warning: TemplateWarning) => warning.hint,
    apply: (warning: TemplateWarning, value) => {
      warning.hint = value;
    },
  }),
];

/**
 * The one tenant-authored string a condition preview carries: each condition's
 * label, which is the field's label as the template's author wrote it. Paths,
 * booleans and probabilities are structural.
 */
type PreviewConditionsPayload = {
  conditions: readonly TemplateConditionDecisionOutput[];
};

export const buildPreviewConditionsTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<PreviewConditionsPayload>[] => [
  defineTextFieldSpec({
    path: "conditions[].label",
    items: (payload: PreviewConditionsPayload) => payload.conditions,
    scope: () => organizationId,
    read: (condition: TemplateConditionDecisionOutput) => condition.label,
    apply: (condition: TemplateConditionDecisionOutput, value) => {
      condition.label = value;
    },
  }),
];
