import { panic, Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import { entities, templates } from "@/api/db/schema";
import type { TemplatePersistenceResult } from "@/api/db/schema";
import { configureTemplateFields } from "@/api/handlers/templates/configure-template-fields-service";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { assertUsageAvailableForHandler } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  AssertNoExtraFields,
  CONFIGURE_TEMPLATE_FIELDS_PROJECTION,
  CREATE_TEMPLATE_PROJECTION,
  LIST_TEMPLATES_LIST_PROJECTION,
  LIST_TEMPLATES_PROJECTION,
  TEMPLATE_DESCRIBE_PROJECTION,
} from "@/api/lib/chat/projections";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import { extractTextForPreview } from "@/api/lib/docx/extract-text";
import type { AiFieldError } from "@/api/lib/docx/resolve-ai-fields";
import { readManifest, writeManifest } from "@/api/lib/docx/template-manifest";
import { inlineBytesIgnoredWarning } from "@/api/lib/docx/template-warnings";
import type { TemplateWarning } from "@/api/lib/docx/template-warnings";
import type { FieldMeta } from "@/api/lib/docx/types";
import { validateDocxBuffer } from "@/api/lib/entity-versions/validate-docx-buffer";
import type { DocxValidationFailure } from "@/api/lib/entity-versions/validate-docx-buffer";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import {
  brandPersistedEntityId,
  brandPersistedTemplateId,
} from "@/api/lib/safe-id-boundaries";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";
import { createStoredTemplate } from "@/api/lib/templates/create-template";
import type { FieldOverlayIssue } from "@/api/lib/templates/field-overlay";
import {
  conditionReferencesOnlySelf,
  resolveTemplateFieldOverlay,
} from "@/api/lib/templates/field-overlay";
import {
  recordTemplateFill,
  recordTemplateUse,
} from "@/api/lib/templates/record-use";
import { renameStoredTemplate } from "@/api/lib/templates/rename-template";
import { containsNull } from "@/api/lib/templates/template-data";
import type { TemplateFillCompletionMode } from "@/api/lib/templates/template-fill-completion";
import {
  decideTemplateFillCompletion,
  DEFAULT_TEMPLATE_FILL_COMPLETION_MODE,
  TEMPLATE_FILL_COMPLETION_MODES,
  templateFillCompletionModeSchema,
} from "@/api/lib/templates/template-fill-completion";
import type {
  DescribeTemplateResult,
  MissingRequiredField,
} from "@/api/lib/templates/template-fill-service";
import {
  describeStoredTemplate,
  fillStoredTemplateDocx,
  fillStoredTemplateWithText,
  fillStoredTemplateWithTextStrict,
} from "@/api/lib/templates/template-fill-service";
import { writeStoredTemplate } from "@/api/lib/templates/write-template";
import { withTimeout } from "@/api/lib/with-timeout";
import { MCP_MAX_REQUEST_BODY_BYTES } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { OPENAI_FILE_REFERENCE_SCHEMA } from "@/api/mcp/document-file-upload";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import {
  MAX_DOCX_MEGABYTES,
  MAX_INLINE_DOCX_BASE64_LENGTH,
  MAX_INLINE_DOCX_BYTES,
} from "@/api/mcp/template-docx-limits";
import type { DescribedTemplateField } from "@/api/mcp/template-field-input";
import {
  PERSON_FIELD_SOURCE,
  templateFieldInputSchema,
  toFieldMetaToolInput,
  toTemplateFieldWireInput,
} from "@/api/mcp/template-field-input";
import { TEMPLATE_FIELD_REFERENCE_URI } from "@/api/mcp/template-field-reference";
import { TEMPLATE_MARKER_REFERENCE_URI } from "@/api/mcp/template-marker-reference";
import {
  claimTemplatePersistenceRequest,
  fingerprintTemplatePersistenceRequest,
  persistFilledTemplateDocument,
  persistFilledTemplateVersion,
  recordTemplatePersistenceReceipt,
  releaseTemplatePersistenceClaim,
} from "@/api/mcp/template-persistence";
import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
  runTextFieldSpecs,
} from "@/api/mcp/text-field-spec";
import type {
  InternalToolErrorResult,
  McpTextFieldSpec,
  McpToolDefinition,
  McpToolHandler,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  bindWorkspaceRecorder,
  ensureActiveWorkspace,
  ensureWorkspaceAccess,
  enumProp,
  errorResult,
  internalFailureResult,
  isToolErrorResult,
  notFoundResult,
  nullAsAbsent,
  parseOptionalCursor,
  stringProp,
  structuredErrorResult,
  toolDataResult,
  uuidInputSchema,
  uuidProp,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import { defineValibotMcpTool } from "@/api/mcp/valibot-tool-definition";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

type TemplateToolName =
  | "list_templates"
  | "fill_template"
  | "save_filled_template"
  | "create_template"
  | "configure_template_fields";

/** Max assembled-text length returned inline; full bytes ride along as base64. */
const TEMPLATE_FILL_TEXT_MAX_CHARS = 16_000;
const SAVE_FILLED_TEMPLATE_RENDER_TIMEOUT_MS = 300_000;

/**
 * What `fill_template` sends back. `text` is the rendered preview a caller
 * reads; `docx` adds the base64 archive, which for a short document runs to
 * ~100k characters and is worth spending only when the caller keeps the bytes.
 */
const TEMPLATE_FILL_OUTPUT_MODES = ["text", "docx"] as const;
const DEFAULT_TEMPLATE_FILL_OUTPUT_MODE =
  "text" satisfies (typeof TEMPLATE_FILL_OUTPUT_MODES)[number];

/**
 * One advertised `completion_mode` property for both fill tools. The
 * persisting tool writes into a matter, so it cannot be the laxer of the two:
 * both reject unmatched placeholders unless the caller opts into a partial
 * document.
 */
const TEMPLATE_FILL_COMPLETION_MODE_PROP = {
  ...enumProp(
    "Require every placeholder by default; use allow_partial only for an intentionally incomplete document.",
    TEMPLATE_FILL_COMPLETION_MODES,
  ),
  default: DEFAULT_TEMPLATE_FILL_COMPLETION_MODE,
} as const;

/**
 * `create_template`: a document, and either a name for a new template or the
 * id of one to publish over. Creation never carries a field overlay;
 * `configure_template_fields` owns that half, so neither tool advertises
 * properties the other ignores.
 *
 * `template_id` makes the call an upsert, which is what a retrying agent
 * needs: resending the same document under the same id publishes one more
 * version instead of accumulating near-duplicate templates. A template is
 * never matched by name, because two templates may share one.
 *
 * A call carrying BOTH document sources is accepted, not refused: the host's
 * `file` is stored and the inline bytes are ignored, with a warning saying
 * so. A host fills `file` from its own transport while `docx_base64` is typed
 * by the caller, so the transported bytes are the trustworthy ones; and
 * refusing taught nothing, because two models sent both on every attempt of
 * every task and never dropped one on retry.
 */
export const createTemplateArgsSchema = nullAsAbsent(
  v.pipe(
    v.strictObject({
      template_id: v.optional(
        uuidInputSchema(
          "Omit to create a new template. Set it ONLY to a template id a previous call returned, to publish a new version over that template or rename it",
        ),
      ),
      name: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(256),
          v.description(
            "Display name; required when creating, optional when it renames an existing template",
          ),
        ),
      ),
      docx_base64: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(MAX_INLINE_DOCX_BASE64_LENGTH),
          v.description(
            "Original .docx bytes, base64-encoded verbatim; for a host that " +
              "cannot supply 'file'. Sent beside 'file', it is ignored in " +
              "favour of the attached file. Never strip parts out of the " +
              "file to shrink it.",
          ),
        ),
      ),
      file: v.optional(OPENAI_FILE_REFERENCE_SCHEMA),
    }),
    v.forward(
      v.partialCheck(
        [["template_id"], ["docx_base64"], ["file"]],
        ({ template_id, docx_base64, file }) =>
          template_id !== undefined ||
          docx_base64 !== undefined ||
          file !== undefined,
        "Provide a document source: file, or docx_base64",
      ),
      ["docx_base64"],
    ),
    v.forward(
      v.partialCheck(
        [["template_id"], ["name"]],
        ({ template_id, name }) =>
          template_id !== undefined || name !== undefined,
        "name is required to create a template",
      ),
      ["name"],
    ),
    v.forward(
      v.partialCheck(
        [["template_id"], ["name"], ["docx_base64"], ["file"]],
        ({ template_id, name, docx_base64, file }) =>
          template_id === undefined ||
          name !== undefined ||
          docx_base64 !== undefined ||
          file !== undefined,
        "With template_id, pass a document to publish a new version, a name to rename it, or both",
      ),
      ["template_id"],
    ),
  ),
);

/**
 * `configure_template_fields`: the template plus the field entries to apply.
 * Exported so `template-field-input.test.ts` exercises the entries through the
 * schema the tool actually parses rather than a second assembly of it.
 */
export const configureTemplateFieldsArgsSchema = nullAsAbsent(
  v.strictObject({
    template_id: uuidInputSchema(
      "Template to configure, as returned by create_template or list_templates",
    ),
    fields: v.pipe(
      v.array(templateFieldInputSchema),
      v.description(
        `Field configuration entries; see ${TEMPLATE_FIELD_REFERENCE_URI}`,
      ),
    ),
  }),
);

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

const buildTemplateListTextFieldSpecs = (
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

const toTemplateDetailPayload = (
  templateId: SafeId<"template">,
  payload: TemplateDetailSuccess,
) => {
  const fields = payload.fields.map((field) => ({
    ...toTemplateFieldWireInput(field),
    input_type: field.inputType,
    required: field.required,
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

type TemplateDetailPayload = ReturnType<typeof toTemplateDetailPayload>;
type TemplateDetailField = TemplateDetailPayload["fields"][number];

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

const buildTemplateDetailTextFieldSpecs = (
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

export const CREATE_TEMPLATE_TOOL_DEFINITION = defineValibotMcpTool({
  _meta: {
    "openai/fileParams": ["file"],
  },
  description:
    "Create a template from a DOCX, or publish a new version of one. To " +
    "create, pass a name and the document. To publish over an existing " +
    "template, pass its template_id with the document; template_id with only " +
    "a name renames it. Same-name templates are never merged: only " +
    "template_id matches an existing one. For the document, pass " +
    "file (preferred, " +
    `up to ${MAX_DOCX_MEGABYTES} MB) or the original bytes as docx_base64 ` +
    `(max ${MAX_INLINE_DOCX_BYTES} bytes decoded within the ` +
    `${MCP_MAX_REQUEST_BODY_BYTES}-byte MCP request frame); never retype the ` +
    `file or strip parts out to fit. Read ${TEMPLATE_MARKER_REFERENCE_URI} ` +
    "before authoring: markers are the docxtpl dialect of Jinja, and a value " +
    "marker's filters configure the field. Returns the template id, its " +
    "fields, arrays, conditions, computed values and warnings; " +
    "configure_template_fields sets what the filters did not.",
  inputSchema: createTemplateArgsSchema,
  jsonSchemaProjectionWaiver: {
    ignoreActions: ["partial_check"],
    reason: "The one-document-source check remains runtime-only.",
  },
  annotations: {
    title: "Create template",
    idempotentHint: false,
    openWorldHint: false,
  },
  access: "write",
  anonymized: { exposure: "excluded", reason: "write" },
  name: "create_template",
  scope: "stella:templates",
});

export const CONFIGURE_TEMPLATE_FIELDS_TOOL_DEFINITION = defineValibotMcpTool({
  description:
    "Configure an existing template's fields: who fills each one, its input " +
    "control, options and validation, for a template whose markers you are " +
    "not rewriting. The document is untouched, and a filter written on a " +
    "marker says the same thing. Pass template_id and one entry per field " +
    "path; every path " +
    `must already exist as a marker. Read ${TEMPLATE_FIELD_REFERENCE_URI} ` +
    "first. Returns the template's full field configuration afterwards.",
  inputSchema: configureTemplateFieldsArgsSchema,
  jsonSchemaProjectionWaiver: {
    ignoreActions: ["check", "finite"],
    reason:
      "Field compatibility checks remain runtime-only; JSON numbers are finite on the wire.",
  },
  annotations: {
    title: "Configure template fields",
    idempotentHint: true,
    openWorldHint: false,
  },
  access: "write",
  anonymized: { exposure: "excluded", reason: "write" },
  name: "configure_template_fields",
  scope: "stella:templates",
});

export const TEMPLATE_TOOL_DEFINITIONS = [
  {
    annotations: {
      title: "List templates",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "List the document templates in this organization (NDAs, powers of " +
      "attorney, leases), or describe one template's fillable fields. Omit " +
      "template_id to list templates: each template's id, name, field count, " +
      "tags, and usage guidance (whenToUse / whenNotToUse); prefer a template " +
      "whose whenToUse matches the request and skip any whose whenNotToUse " +
      "applies. Pass template_id to return that template's full field " +
      "configuration, in the shape the field reference documents " +
      `(see ${TEMPLATE_FIELD_REFERENCE_URI}), its named conditions and ` +
      "formula fields, and the configure_template_fields call to make next. " +
      "`arrays` marks {% for %} fields as arrays of objects, not dotted keys.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: uuidProp(
          "Template id to describe its fields in detail; omit to list templates",
        ),
        cursor: stringProp(
          "Opaque cursor from a previous list_templates call to fetch the next page",
          { maxLength: 512 },
        ),
      },
      additionalProperties: false,
    },
    access: "read",
    anonymized: {
      exposure: "anonymize",
      // Placeholder org id: derivation only ever reads `.path`, see the
      // builders' doc comment above.
      textFields: [
        ...deriveTextFieldPaths(buildTemplateListTextFieldSpecs("")),
        ...deriveTextFieldPaths(buildTemplateDetailTextFieldSpecs("")),
      ],
    },
    name: "list_templates",
    scope: "stella:templates",
  },
  {
    description:
      "Fill a template and return the rendered text; pass output_mode='docx' " +
      "for base64 bytes. Call list_templates first, then pass its field paths " +
      "in values. Registry, composite, formula, and AI fields resolve " +
      "automatically. Unknown keys fail unless allow_unused_values is true. " +
      "Missing required values always fail. Unfilled placeholders or failed AI " +
      "drafts fail unless completion_mode is allow_partial. Errors name exact " +
      "paths; never guess required values. Output includes completionStatus.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: uuidProp("Template id, as returned by list_templates"),
        values: {
          type: "object",
          description: "Map of field path to value.",
          additionalProperties: true,
        },
        allow_unused_values: {
          type: "boolean",
          description:
            "Allow value keys that do not match template fields. Defaults to false so misspelled field paths fail loudly.",
        },
        completion_mode: TEMPLATE_FILL_COMPLETION_MODE_PROP,
        output_mode: {
          ...enumProp(
            "text returns the rendered paragraphs and cells; docx adds the base64 archive, which is large.",
            TEMPLATE_FILL_OUTPUT_MODES,
          ),
          default: DEFAULT_TEMPLATE_FILL_OUTPUT_MODE,
        },
      },
      required: ["template_id", "values"],
      additionalProperties: false,
    },
    // openWorldHint: true because a manifest with a registry-lookup field
    // (see lookup-fields.ts) sends the fill through the shared business-
    // registry dispatch (ARES, KRS, ORSR, ...) before rendering, the same
    // external interaction matter-tools.ts's company lookup declares open-
    // world for; the hint is static per tool, so it must cover that case even
    // though most fills touch no lookup field.
    annotations: {
      title: "Fill template",
      idempotentHint: false,
      openWorldHint: true,
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "fill_template",
    scope: "stella:templates",
  },
  {
    description:
      "Fill a registered template and persist its DOCX in a matter. Use " +
      "create_document (optionally with parent_id) or create_version with " +
      "entity_id. Call list_templates for field paths; never guess required " +
      "values. Missing required values always fail. Unfilled placeholders or " +
      "failed AI drafts stop writes unless completion_mode is allow_partial. " +
      "Returns document/version ids and fill diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        action: enumProp("Persistence destination", [
          "create_document",
          "create_version",
        ]),
        template_id: uuidProp("Template id, as returned by list_templates"),
        matter_id: uuidProp("Matter receiving the filled DOCX."),
        entity_id: uuidProp(
          "Existing document entity id; required only for create_version",
        ),
        parent_id: uuidProp(
          "Folder entity id for a new document; valid only for create_document",
        ),
        name: stringProp(
          "Optional DOCX file name; defaults to the template file name",
          { maxLength: 255 },
        ),
        idempotency_key: stringProp(
          "Unique retry key for this save operation; reuse it only to recover the same timed-out request",
          { maxLength: 128 },
        ),
        values: {
          type: "object",
          description: "Map of template field path to value",
          additionalProperties: true,
        },
        completion_mode: TEMPLATE_FILL_COMPLETION_MODE_PROP,
      },
      required: [
        "action",
        "template_id",
        "matter_id",
        "idempotency_key",
        "values",
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Save filled template",
      idempotentHint: false,
      openWorldHint: true,
    },
    access: "write",
    additionalScopes: ["stella:templates"],
    anonymized: { exposure: "excluded", reason: "write" },
    name: "save_filled_template",
    scope: "stella:documents_write",
  },
  CREATE_TEMPLATE_TOOL_DEFINITION,
  CONFIGURE_TEMPLATE_FIELDS_TOOL_DEFINITION,
] as const satisfies readonly McpToolDefinition[];

/** The whole advertised list_templates surface, so the branch dispatch below
 * reads arguments a strict client's nulls have already been dropped from
 * rather than the raw ones. */
const listTemplatesArgsSchema = nullAsAbsent(
  v.strictObject({
    template_id: v.optional(
      uuidInputSchema(
        "Template id to describe its fields in detail; omit to list templates",
      ),
    ),
    cursor: v.optional(v.pipe(v.string(), v.maxLength(512))),
  }),
);

// The list_templates cursor is the boundary template id alone; the query
// resolves its (createdAt, id) in-DB.
const decodeTemplatePageCursor = (cursor: string): string | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 1) {
    return null;
  }
  const [rawId] = parts;
  return isUuidPaginationCursorPart(rawId) ? rawId : null;
};

const handleListTemplatesTool: TypedMcpToolHandler<
  v.InferInput<typeof LIST_TEMPLATES_PROJECTION>
> = async ({ args, context }) => {
  const hasPermission = hasEffectiveAuthority(context, {
    workspace: ["read"],
  });
  if (!hasPermission) {
    return errorResult("Forbidden");
  }

  const routed = v.safeParse(listTemplatesArgsSchema, args);
  if (!routed.success) {
    return validationErrorResult(routed.issues);
  }
  const { cursor: requestedCursor, template_id: templateId } = routed.output;

  // Detail mode: template_id returns one template's field configuration. The
  // list-only cursor does not apply, so reject the mixed request up front.
  if (templateId !== undefined) {
    if (requestedCursor !== undefined) {
      return structuredErrorResult({
        code: "validation_error",
        message:
          "cursor applies when listing templates; omit template_id to list",
        issues: [
          {
            path: "cursor",
            message:
              "cursor applies when listing templates; omit template_id to list",
          },
        ],
        hint: "Omit 'template_id' to list templates with 'cursor', or omit 'cursor' when requesting a single template_id.",
      });
    }
    return await describeTemplateDetail({
      args: { template_id: templateId },
      context,
    });
  }

  const cursor = parseOptionalCursor({ args, key: "cursor" });
  if (isToolErrorResult(cursor)) {
    return cursor;
  }
  let boundaryId: string | undefined;
  if (cursor !== undefined) {
    const decoded = decodeTemplatePageCursor(cursor);
    if (decoded === null) {
      return structuredErrorResult({
        code: "validation_error",
        message: "Invalid cursor",
        issues: [{ path: "cursor", message: "Invalid cursor" }],
        hint: "Pass the 'cursor' verbatim as returned by a previous call, or omit it for the first page.",
      });
    }
    boundaryId = decoded;
  }

  const limit = LIMITS.templatesCount;
  const rows = await context.scopedDb((tx) =>
    tx
      .select({
        id: templates.id,
        name: templates.name,
        fieldCount: templates.fieldCount,
        tags: templates.tags,
        whenToUse: templates.whenToUse,
        whenNotToUse: templates.whenNotToUse,
      })
      .from(templates)
      .where(
        and(
          eq(templates.organizationId, context.organizationId),
          // Resolve the full-precision (createdAt, id) boundary in-DB by id
          // so the cursor never round-trips createdAt through a millisecond
          // JS Date. The boundary lookup is org-scoped (defense in depth
          // beyond RLS) so a cursor carrying a foreign template id cannot
          // shift this org's page boundary.
          boundaryId === undefined
            ? undefined
            : sql`(${templates.createdAt}, ${templates.id}) < (select b.created_at, b.id from templates b where b.id = ${boundaryId} and b.organization_id = ${context.organizationId})`,
        ),
      )
      .orderBy(desc(templates.createdAt), desc(templates.id))
      .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.id]),
  });

  // Templates are organization-scoped, so the org id is the anonymization
  // scope. Only the org-authored free text (name, usage guidance, tags) is
  // redacted; ids and field counts pass through.
  const payload = {
    templates: page.items,
    nextCursor: page.nextCursor,
  } satisfies v.InferInput<typeof LIST_TEMPLATES_LIST_PROJECTION>;
  const textFields = runTextFieldSpecs(
    buildTemplateListTextFieldSpecs(context.organizationId),
    payload,
  );

  return { egress: "structured", payload, textFields };
};

/**
 * Exported, with the two validators below, only so `uuid-id-inputs.test.ts` can
 * bind it to the hand-written `inputSchema` these three tools still advertise:
 * a one-sided edit to either representation fails there instead of shipping a
 * `tools/list` contract the handler does not enforce. The binding retires with
 * the schema, once the tool moves to `defineValibotMcpTool` and its advertised
 * schema is projected from this one.
 */
export const describeTemplateArgsSchema = nullAsAbsent(
  v.strictObject({
    template_id: v.pipe(v.string(), v.uuid()),
  }),
);

// Detail branch of list_templates: one template's field configuration. Reused
// verbatim from the former describe_template tool, which list_templates
// absorbed. The caller (list_templates) already checked the read permission.
const describeTemplateDetail: TypedMcpToolHandler<
  v.InferInput<typeof LIST_TEMPLATES_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(describeTemplateArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }

  const payload = await describeTemplateForAgent({
    context,
    templateId: brandPersistedTemplateId(parsed.output.template_id),
  });
  if (isToolErrorResult(payload)) {
    return payload;
  }

  // Redact the org-authored template name and each field's label/hint/aiPrompt;
  // field paths, input types, options, and condition/formula expressions are
  // structural and pass through. Template = org scope.
  const textFields = runTextFieldSpecs(
    buildTemplateDetailTextFieldSpecs(context.organizationId),
    payload,
  );

  return { egress: "structured", payload, textFields };
};

/** One line describing a missing required field for the issues list: its
 *  label (falling back to the path) plus enough shape (input type, options)
 *  for an agent to ask the user the right question without another
 *  describe_template round trip. */
const describeMissingRequiredField = (field: MissingRequiredField): string => {
  const name = field.label ?? field.path;
  const options =
    field.options && field.options.length > 0
      ? ` (options: ${field.options.join(", ")})`
      : "";
  return `${name} [${field.inputType}]${options} is required and was not provided.`;
};

/** Shared structured-rejection envelope for a fill blocked on missing
 *  required fields: `fillTemplateDocxWithPolicy` returns this before any
 *  clause/AI/lookup work runs, so this is the only place either tool renders
 *  it. */
const requiredFieldsRejectionResult = (
  missingFields: MissingRequiredField[],
): ReturnType<typeof structuredErrorResult> => {
  // The preview keeps the summary `message` short; `issues` (below) still
  // carries every missing field in full — an agent must be able to supply
  // all of them in one retry, not just the first ten.
  const preview = missingFields.slice(0, 10);
  const omitted = missingFields.length - preview.length;
  const suffix = omitted > 0 ? ` (${omitted} more omitted)` : "";
  return structuredErrorResult({
    code: "validation_error",
    message: `Missing required template values: ${preview
      .map((field) => field.label ?? field.path)
      .join(", ")}${suffix}`,
    issues: missingFields.map((field) => ({
      path: `values.${field.path}`,
      message: describeMissingRequiredField(field),
    })),
    hint: "Ask the user for these values (they are required and not AI-fillable), then retry with them added to 'values'.",
  });
};

type TemplateFillCompletionGate =
  | { type: "allowed"; completionStatus: "complete" | "partial" }
  | { type: "rejected"; result: ReturnType<typeof structuredErrorResult> };

/**
 * The completion gate both fill tools run over renderer diagnostics. Owning it
 * here is what keeps the transient tool and the persisting one on one policy:
 * a live `{{ placeholder }}` is an error under the default mode whether the
 * document is handed back or written into a matter.
 */
const gateTemplateFillCompletion = ({
  mode,
  unmatchedPlaceholders,
  aiFieldErrors,
}: {
  mode: TemplateFillCompletionMode;
  unmatchedPlaceholders: readonly string[];
  aiFieldErrors: readonly AiFieldError[];
}): TemplateFillCompletionGate => {
  const completion = decideTemplateFillCompletion({
    mode,
    unmatchedPlaceholders,
    aiFieldErrors,
  });
  if (completion.type !== "rejected_partial") {
    return {
      type: "allowed",
      completionStatus: completion.type === "complete" ? "complete" : "partial",
    };
  }

  return {
    type: "rejected",
    result: structuredErrorResult({
      code: "validation_error",
      message: `Template fill incomplete; ${describeFillShortfall(completion)}`,
      issues: [
        ...completion.unmatchedPlaceholders.map((placeholder) => ({
          path: `values.${placeholder}`,
          message: "Template placeholder was not filled",
        })),
        ...completion.aiFieldErrors.map((error) => ({
          path: `values.${error.valuePath}`,
          message: error.message,
        })),
      ],
      hint: "Call list_templates with template_id (CLI: template list --template-id ID) and provide the missing values yourself, or set completion_mode to allow_partial when an incomplete document is intentional.",
    }),
  };
};
/** Summary line for a fill that is not complete. Both shortfalls are named
 *  when both are present: an agent retrying needs to know a placeholder was
 *  never filled AND that a drafted field came back unusable. */
const describeFillShortfall = ({
  unmatchedPlaceholders,
  aiFieldErrors,
}: {
  unmatchedPlaceholders: readonly string[];
  aiFieldErrors: readonly AiFieldError[];
}): string => {
  const parts: string[] = [];
  if (unmatchedPlaceholders.length > 0) {
    parts.push(`unmatched placeholders: ${previewList(unmatchedPlaceholders)}`);
  }
  if (aiFieldErrors.length > 0) {
    parts.push(
      `AI-drafted fields that failed: ${previewList(aiFieldErrors.map(({ valuePath }) => valuePath))}`,
    );
  }
  return parts.join("; ");
};

/** The summary `message` stays short; the full set always travels in `issues`
 *  so one retry can address every item. */
const previewList = (items: readonly string[]): string => {
  const preview = items.slice(0, 10);
  const omitted = items.length - preview.length;
  return `${preview.join(", ")}${omitted > 0 ? ` (${omitted} more omitted)` : ""}`;
};

/**
 * Read the org AI config at most once, and only when the fill service actually
 * asks for a usage preflight or AI collaborators. A deterministic template
 * declares no AI field, so it must not pay for that read.
 */
const deferOrgAIConfig = (context: McpRequestContext) => {
  let pending: Promise<OrgAIConfig | null> | undefined;
  return async (): Promise<OrgAIConfig | null> => {
    pending ??= (context.testDependencies?.loadOrgAIConfig ?? loadOrgAIConfig)(
      context.organizationId,
    );
    return await pending;
  };
};

/**
 * Usage preflight for a template fill, invoked by the fill service only once
 * the manifest is known to declare an AI field, before any model call, so a
 * deterministic fill never spends quota. Skips only when no provider could run
 * a model at all: with an instance provider but no org BYOK the fill still
 * calls the fast model (the metering layer prices it at the non-BYOK rate), so
 * the quota check must still apply.
 */
const assertTemplateFillUsage = async ({
  context,
  readOrgAIConfig,
  workspaceId,
}: {
  context: McpRequestContext;
  readOrgAIConfig: () => Promise<OrgAIConfig | null>;
  workspaceId: SafeId<"workspace"> | null;
}) => {
  const orgAIConfig = await readOrgAIConfig();
  if (!orgAIConfig && !hasTanStackInstanceProvider()) {
    return null;
  }
  return await assertUsageAvailableForHandler({
    metering: { actionType: "chat", modelRole: "fast" },
    organizationId: context.organizationId,
    orgAIConfig,
    workspaceId,
    userId: context.userId,
    safeDb: context.safeDb,
  });
};

export const fillTemplateArgsSchema = nullAsAbsent(
  v.strictObject({
    template_id: v.pipe(v.string(), v.uuid()),
    values: v.record(v.string(), v.unknown()),
    allow_unused_values: v.optional(v.boolean()),
    completion_mode: templateFillCompletionModeSchema,
    output_mode: v.optional(
      v.picklist(TEMPLATE_FILL_OUTPUT_MODES),
      DEFAULT_TEMPLATE_FILL_OUTPUT_MODE,
    ),
  }),
);

const handleFillTemplateTool: McpToolHandler = async ({ args, context }) => {
  const hasPermission = hasEffectiveAuthority(context, {
    template: ["use"],
  });
  if (!hasPermission) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(fillTemplateArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }

  // The org's AI config makes AI-fillable / aiAdapt fields behave exactly as
  // they do in the chat tools and web fill routes; a missing config simply
  // leaves those fields unfilled rather than erroring. Read lazily: the fill
  // service asks for it only when the manifest declares an AI field.
  const readOrgAIConfig = deferOrgAIConfig(context);
  // Built only when the manifest declares an AI field, so a deterministic fill
  // opens no metered trace. fill_template is org-scoped (no matter binding),
  // so there is no workspace id to redact tenant ids against.
  const aiCollaborators = async () => {
    const orgAIConfig = await readOrgAIConfig();
    const shared = {
      orgAIConfig,
      organizationId: context.organizationId,
      aiAnalytics: createTanStackAIAnalyticsCallbacks({
        usageMetering: {
          actionType: "chat",
          organizationId: context.organizationId,
          safeDb: context.safeDb,
          serviceTier: "standard",
          userId: context.userId,
          workspaceId: null,
        },
        feature: "templates.fill",
        modelRole: "fast",
        orgAIConfig,
        properties: { organization_id: context.organizationId },
        traceId: Bun.randomUUIDv7(),
      }),
      tenantWorkspaceIds: [],
    };
    return {
      generateAiValue: buildAiFieldGenerator(shared),
      decideAiCondition: buildAiConditionDecider(shared),
      adaptAiValue: buildAiOccurrenceAdapter(shared),
    };
  };

  const assertUsageAvailable = async () =>
    await assertTemplateFillUsage({
      context,
      readOrgAIConfig,
      workspaceId: null,
    });

  const fillStoredTemplate =
    parsed.output.allow_unused_values === true
      ? (context.testDependencies?.fillStoredTemplateWithText ??
        fillStoredTemplateWithText)
      : (context.testDependencies?.fillStoredTemplateWithTextStrict ??
        fillStoredTemplateWithTextStrict);
  const filled = await fillStoredTemplate({
    templateId: brandPersistedTemplateId(parsed.output.template_id),
    values: parsed.output.values,
    scopedDb: context.scopedDb,
    organizationId: context.organizationId,
    requiredFields: "enforce",
    assertUsageAvailable,
    aiCollaborators,
  });
  if ("usageRejection" in filled) {
    return errorResult(filled.usageRejection.message);
  }
  if ("error" in filled) {
    return errorResult(filled.error);
  }
  if ("requiredFieldsRejection" in filled) {
    return requiredFieldsRejectionResult(filled.requiredFieldsRejection);
  }
  if ("inputRejection" in filled) {
    const preview = filled.inputRejection.keys.slice(0, 10);
    const omitted = filled.inputRejection.keys.length - preview.length;
    const suffix = omitted > 0 ? ` (${omitted} more omitted)` : "";
    return structuredErrorResult({
      code: "validation_error",
      message: `Unused template value keys: ${preview.join(", ")}${suffix}`,
      issues: filled.inputRejection.keys.map((key) => ({
        path: `values.${key}`,
        message: "Value key does not match a template field",
      })),
      hint: "Call list_templates with template_id (CLI: template list --template-id ID) and correct the value keys, or set allow_unused_values to true when the extra keys are intentional.",
    });
  }

  // Record the execution (fill row + EXECUTE audit) like the REST fill routes,
  // so agent-driven fills appear in the audit trail. Best-effort: a successful
  // render is not discarded if the bookkeeping write fails (it is captured).
  await context
    .scopedDb(
      async (tx) =>
        await (
          context.testDependencies?.recordTemplateFill ?? recordTemplateFill
        )({
          tx,
          templateId: brandPersistedTemplateId(parsed.output.template_id),
          organizationId: context.organizationId,
          userId: context.userId,
          format: "docx",
          unmatchedCount: filled.unmatchedPlaceholders.length,
          aiFieldErrorCount: filled.aiFieldErrors.length,
          unusedCount: filled.unusedValues.length,
          structureErrors: filled.structureErrors,
          recordAuditEvent: context.recordAuditEvent,
        }),
    )
    .catch(captureError);

  const completion = gateTemplateFillCompletion({
    mode: parsed.output.completion_mode,
    unmatchedPlaceholders: filled.unmatchedPlaceholders,
    aiFieldErrors: filled.aiFieldErrors,
  });
  if (completion.type === "rejected") {
    return completion.result;
  }

  if (parsed.output.output_mode === "docx") {
    const truncated = filled.text.length > TEMPLATE_FILL_TEXT_MAX_CHARS;
    return toolDataResult({
      completionStatus: completion.completionStatus,
      templateName: filled.templateName,
      fileName: filled.fileName,
      text: truncated
        ? filled.text.slice(0, TEMPLATE_FILL_TEXT_MAX_CHARS)
        : filled.text,
      truncated,
      docxBase64: filled.buffer.toString("base64"),
      unmatchedPlaceholders: filled.unmatchedPlaceholders,
      unusedValues: filled.unusedValues,
      structureErrors: filled.structureErrors,
      aiFieldErrors: filled.aiFieldErrors.map((error) => ({
        field: error.valuePath,
        reason: error.reason,
        message: error.message,
      })),
    });
  }

  // The shared preview reader the template preview routes use: it flattens
  // table cells into their own entries, so an agent reading the result sees
  // the same text a human reviewing the preview does.
  const { paragraphs, charCount } = await extractTextForPreview(filled.buffer);
  const rendered: string[] = [];
  let renderedChars = 0;
  let truncated = false;
  for (const paragraph of paragraphs) {
    const remaining = TEMPLATE_FILL_TEXT_MAX_CHARS - renderedChars;
    if (paragraph.text.length > remaining) {
      // Spend the remaining budget on this paragraph's prefix rather than
      // dropping it whole: one oversized paragraph (or a document that is a
      // single long one) must not render the preview empty.
      if (remaining > 0) {
        rendered.push(paragraph.text.slice(0, remaining));
      }
      truncated = true;
      break;
    }
    rendered.push(paragraph.text);
    renderedChars += paragraph.text.length;
  }

  return toolDataResult({
    completionStatus: completion.completionStatus,
    templateName: filled.templateName,
    fileName: filled.fileName,
    paragraphs: rendered,
    charCount,
    truncated,
    unmatchedPlaceholders: filled.unmatchedPlaceholders,
    unusedValues: filled.unusedValues,
    structureErrors: filled.structureErrors,
    // Fields whose AI draft failed: they are unfilled in the document above,
    // so an agent must supply them itself rather than treat the fill as done.
    aiFieldErrors: filled.aiFieldErrors.map((error) => ({
      field: error.valuePath,
      reason: error.reason,
      message: error.message,
    })),
  });
};

export const saveFilledTemplateArgsSchema = nullAsAbsent(
  v.strictObject({
    action: v.picklist(["create_document", "create_version"]),
    template_id: v.pipe(v.string(), v.uuid()),
    matter_id: v.pipe(v.string(), v.uuid()),
    entity_id: v.optional(v.pipe(v.string(), v.uuid())),
    parent_id: v.optional(v.pipe(v.string(), v.uuid())),
    name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(255))),
    idempotency_key: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    values: v.record(v.string(), v.unknown()),
    completion_mode: templateFillCompletionModeSchema,
  }),
);

const resolveFilledDocxName = ({
  requested,
  fallback,
}: {
  requested: string | undefined;
  fallback: string;
}): string => {
  const sanitized = sanitizeFilename((requested ?? fallback).trim());
  return DOCX_EXT_RE.test(sanitized) ? sanitized : `${sanitized}.docx`;
};

const validateFilledTemplateDestination = async ({
  action,
  context,
  entityId,
  parentId,
  workspaceId,
}: {
  action: "create_document" | "create_version";
  context: McpRequestContext;
  entityId?: string | undefined;
  parentId?: string | undefined;
  workspaceId: McpRequestContext["accessibleWorkspaceIds"][number];
}): Promise<string | null> => {
  if (action === "create_document") {
    const destinationResult = await context.safeDb(async (tx) => {
      // Non-authoritative fast-fail: avoid template rendering, AI metering and
      // use-count writes when the workspace is already full. The shared buffer
      // writer retains the authoritative locked check against concurrent creates.
      const entityCount = await tx.$count(
        entities,
        eq(entities.workspaceId, workspaceId),
      );
      if (entityCount >= LIMITS.entitiesCount) {
        return "Entities limit reached";
      }
      if (parentId === undefined) {
        return null;
      }

      const parent = await tx.query.entities.findFirst({
        where: {
          id: { eq: brandPersistedEntityId(parentId) },
          workspaceId: { eq: workspaceId },
        },
        columns: { kind: true },
      });
      if (!parent) {
        return "Parent entity not found in this matter";
      }
      return parent.kind === "folder" ? null : "Parent entity must be a folder";
    });
    if (Result.isError(destinationResult)) {
      throw destinationResult.error;
    }
    return destinationResult.value;
  }

  const entityResult = await context.safeDb((tx) =>
    tx.query.entities.findFirst({
      where: {
        id: {
          eq: brandPersistedEntityId(
            entityId ?? panic("create_version preflight requires entity_id"),
          ),
        },
        workspaceId: { eq: workspaceId },
      },
      columns: { currentVersionId: true, readOnly: true },
      with: {
        currentVersion: {
          columns: {},
          with: {
            fields: { columns: { content: true } },
          },
        },
      },
    }),
  );
  if (Result.isError(entityResult)) {
    throw entityResult.error;
  }
  const entity = entityResult.value;
  if (!entity?.currentVersionId || !entity.currentVersion) {
    return "Entity not found";
  }
  if (entity.readOnly) {
    return "Entity is read-only";
  }
  if (
    !entity.currentVersion.fields.some((field) => field.content.type === "file")
  ) {
    return "Entity has no file field";
  }
  return null;
};

const handleSaveFilledTemplateTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const parsed = v.safeParse(saveFilledTemplateArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;

  if (
    (input.action === "create_version" && input.entity_id === undefined) ||
    (input.action === "create_document" && input.entity_id !== undefined) ||
    (input.action === "create_version" && input.parent_id !== undefined)
  ) {
    let invalidPath = "entity_id";
    if (input.action === "create_version" && input.entity_id !== undefined) {
      invalidPath = "parent_id";
    }
    return structuredErrorResult({
      code: "validation_error",
      message:
        input.action === "create_version"
          ? "create_version requires entity_id and does not accept parent_id"
          : "create_document does not accept entity_id",
      issues: [
        {
          path: invalidPath,
          message: "Field is not valid for the selected action",
        },
      ],
    });
  }
  if (Object.values(input.values).some(containsNull)) {
    return structuredErrorResult({
      code: "validation_error",
      message: "values must not contain null values",
      issues: [{ path: "values", message: "Null values are not allowed" }],
    });
  }

  const templatePermission = hasEffectiveAuthority(context, {
    template: ["use"],
  });
  const entityPermission = hasEffectiveAuthority(context, {
    entity: [input.action === "create_document" ? "create" : "update"],
  });
  if (!templatePermission || !entityPermission) {
    return errorResult("Forbidden");
  }

  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: input.matter_id,
  });
  if (workspaceId === null) {
    return notFoundResult("Matter not found or not accessible");
  }
  const recordAuditEvent = bindWorkspaceRecorder(context, workspaceId);
  const templateId = brandPersistedTemplateId(input.template_id);

  // Everything the caller sent except the key itself identifies the request,
  // so a rest spread keeps the fingerprint total: a future argument joins it
  // without anyone remembering to, and a key replayed under different
  // arguments (a different completion_mode included) reports a conflict
  // instead of replaying a receipt that answered a different question.
  const { idempotency_key: _idempotencyKey, ...fingerprintedInput } = input;
  const requestFingerprint = (
    context.testDependencies?.fingerprintTemplatePersistenceRequest ??
    fingerprintTemplatePersistenceRequest
  )({
    ...fingerprintedInput,
    workspaceId,
  });
  const claim = await (
    context.testDependencies?.claimTemplatePersistenceRequest ??
    claimTemplatePersistenceRequest
  )({
    safeDb: context.safeDb,
    organizationId: context.organizationId,
    workspaceId,
    userId: context.userId,
    idempotencyKey: input.idempotency_key,
    requestFingerprint,
  });
  if (Result.isError(claim)) {
    return internalFailureResult(claim.error);
  }
  const claimToken = (() => {
    switch (claim.value.status) {
      case "claimed":
        return claim.value.claimToken;
      case "completed":
        return toolDataResult(claim.value.result);
      case "conflict":
        return structuredErrorResult({
          code: "validation_error",
          message: "idempotency_key was already used for different input",
          issues: [
            {
              path: "idempotency_key",
              message: "Reuse a key only for the same save operation",
            },
          ],
        });
      case "pending":
        return errorResult(
          "A save with this idempotency_key is still in progress; retry shortly",
        );
      default: {
        claim.value satisfies never;
        return panic(`Unhandled value: ${String(claim.value)}`);
      }
    }
  })();
  if (typeof claimToken !== "string") {
    return claimToken;
  }
  const releaseClaim = async (): Promise<void> => {
    const released = await (
      context.testDependencies?.releaseTemplatePersistenceClaim ??
      releaseTemplatePersistenceClaim
    )({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      userId: context.userId,
      idempotencyKey: input.idempotency_key,
      claimToken,
    });
    if (Result.isError(released)) {
      captureError(released.error);
    }
  };

  const activeWorkspaceId = ensureActiveWorkspace({
    context,
    workspaceId: input.matter_id,
  });
  if (typeof activeWorkspaceId !== "string") {
    await releaseClaim();
    return activeWorkspaceId;
  }

  const destinationError = await validateFilledTemplateDestination({
    action: input.action,
    context,
    entityId: input.entity_id,
    parentId: input.parent_id,
    workspaceId,
  });
  if (destinationError !== null) {
    await releaseClaim();
    return errorResult(destinationError);
  }

  const readOrgAIConfig = deferOrgAIConfig(context);
  const assertUsageAvailable = async () =>
    await assertTemplateFillUsage({ context, readOrgAIConfig, workspaceId });

  const renderDeadline = AbortSignal.timeout(
    SAVE_FILLED_TEMPLATE_RENDER_TIMEOUT_MS,
  );
  const operationSignal =
    context.request === undefined
      ? renderDeadline
      : AbortSignal.any([context.request.signal, renderDeadline]);
  // Built only when the manifest declares an AI field: the fill service defers
  // this, so a deterministic fill opens no metered trace.
  const aiCollaborators = async () => {
    const orgAIConfig = await readOrgAIConfig();
    const shared = {
      orgAIConfig,
      organizationId: context.organizationId,
      skillContext: {
        organizationId: context.organizationId,
        safeDb: context.safeDb,
        userId: context.userId,
      },
      aiAnalytics: createTanStackAIAnalyticsCallbacks({
        usageMetering: {
          actionType: "chat",
          organizationId: context.organizationId,
          safeDb: context.safeDb,
          serviceTier: "standard",
          userId: context.userId,
          workspaceId,
        },
        feature: "templates.fill",
        modelRole: "fast",
        orgAIConfig,
        properties: { organization_id: context.organizationId },
        traceId: Bun.randomUUIDv7(),
      }),
      operationSignal,
      tenantWorkspaceIds: [workspaceId],
    };
    return {
      generateAiValue: buildAiFieldGenerator(shared),
      decideAiCondition: buildAiConditionDecider(shared),
      adaptAiValue: buildAiOccurrenceAdapter(shared),
    };
  };
  const filledResult = await Result.tryPromise(
    async () =>
      await withTimeout(
        async () =>
          await (
            context.testDependencies?.fillStoredTemplateDocx ??
            fillStoredTemplateDocx
          )({
            templateId,
            values: input.values,
            scopedDb: context.scopedDb,
            organizationId: context.organizationId,
            workspaceId,
            requiredFields: "enforce",
            useRecording: "caller",
            assertUsageAvailable,
            aiCollaborators,
          }),
        {
          label: "save filled template render",
          timeoutMs: SAVE_FILLED_TEMPLATE_RENDER_TIMEOUT_MS,
        },
      ),
  );
  if (Result.isError(filledResult)) {
    await releaseClaim();
    return internalFailureResult(filledResult.error);
  }
  const filled = filledResult.value;
  if ("usageRejection" in filled) {
    await releaseClaim();
    return errorResult(filled.usageRejection.message);
  }
  if ("error" in filled) {
    await releaseClaim();
    return errorResult(filled.error);
  }
  if ("requiredFieldsRejection" in filled) {
    await releaseClaim();
    return requiredFieldsRejectionResult(filled.requiredFieldsRejection);
  }
  // A live `{{ placeholder }}` is rejected before the document reaches the
  // matter, not reported afterwards: this tool persists, so it cannot be
  // laxer than the transient fill_template.
  const completion = gateTemplateFillCompletion({
    mode: input.completion_mode,
    unmatchedPlaceholders: filled.unmatchedPlaceholders,
    aiFieldErrors: filled.aiFieldErrors,
  });
  if (completion.type === "rejected") {
    await releaseClaim();
    return completion.result;
  }
  // Never cross the non-idempotent persistence boundary after either the
  // caller disconnects or the server-owned render deadline expires, even if
  // the abandoned fill operation settles later.
  if (operationSignal.aborted) {
    await releaseClaim();
    return errorResult("Request cancelled before document persistence");
  }

  const aiFieldErrors = filled.aiFieldErrors.map((error) => ({
    field: error.valuePath,
    reason: error.reason,
    message: error.message,
  }));
  const fileName = resolveFilledDocxName({
    requested: input.name,
    fallback: filled.fileName,
  });
  const recordPersistedFill = async (
    tx: Transaction,
    result: TemplatePersistenceResult,
  ): Promise<void> => {
    await (context.testDependencies?.recordTemplateUse ?? recordTemplateUse)({
      tx,
      templateId,
    });
    await (context.testDependencies?.recordTemplateFill ?? recordTemplateFill)({
      tx,
      templateId,
      organizationId: context.organizationId,
      userId: context.userId,
      format: "docx",
      unmatchedCount: filled.unmatchedPlaceholders.length,
      aiFieldErrorCount: filled.aiFieldErrors.length,
      unusedCount: filled.unusedValues.length,
      structureErrors: filled.structureErrors,
      workspaceId,
      entityId: result.entityId,
      entityVersionId: result.entityVersionId,
      recordAuditEvent,
    });
    await (
      context.testDependencies?.recordTemplatePersistenceReceipt ??
      recordTemplatePersistenceReceipt
    )({
      tx,
      organizationId: context.organizationId,
      workspaceId,
      userId: context.userId,
      idempotencyKey: input.idempotency_key,
      requestFingerprint,
      claimToken,
      result,
    });
  };
  const persistence = await Result.tryPromise({
    try: async (): Promise<
      | { status: "ok"; value: TemplatePersistenceResult }
      | { status: "error"; message: string }
    > => {
      if (input.action === "create_document") {
        let result: TemplatePersistenceResult | undefined;
        const created = await (
          context.testDependencies?.persistFilledTemplateDocument ??
          persistFilledTemplateDocument
        )({
          scopedDb: context.scopedDb,
          organizationId: context.organizationId,
          workspaceId,
          userId: context.userId,
          recordAuditEvent,
          buffer: filled.buffer,
          fileName,
          mimeType: DOCX_MIME_TYPE,
          parentId:
            input.parent_id === undefined
              ? undefined
              : brandPersistedEntityId(input.parent_id),
          afterCreate: async (tx, persisted) => {
            result = {
              action: "create_document",
              entityId: persisted.entityId,
              entityVersionId: persisted.entityVersionId,
              fileName: persisted.fileName,
              unmatchedPlaceholders: filled.unmatchedPlaceholders,
              unusedValues: filled.unusedValues,
              ...(aiFieldErrors.length === 0 ? {} : { aiFieldErrors }),
            };
            await recordPersistedFill(tx, result);
          },
        });
        return Result.isError(created)
          ? { status: "error", message: created.error.message }
          : {
              status: "ok",
              value:
                result ??
                panic("Document persisted without an idempotency receipt"),
            };
      }
      const entityId = brandPersistedEntityId(
        input.entity_id ?? panic("create_version reached without an entity_id"),
      );
      let result: TemplatePersistenceResult | undefined;
      const created = await (
        context.testDependencies?.persistFilledTemplateVersion ??
        persistFilledTemplateVersion
      )({
        safeDb: context.safeDb,
        organizationId: context.organizationId,
        workspaceId,
        entityId,
        userId: context.userId,
        recordAuditEvent,
        buffer: filled.buffer,
        fileName,
        mimeType: DOCX_MIME_TYPE,
        source: null,
        writePolicy: { type: "replace-current-file" },
        afterWrite: async (tx, persisted) => {
          result = {
            action: "create_version",
            entityId,
            entityVersionId: persisted.entityVersionId,
            fileName,
            unmatchedPlaceholders: filled.unmatchedPlaceholders,
            unusedValues: filled.unusedValues,
            ...(aiFieldErrors.length === 0 ? {} : { aiFieldErrors }),
            versionNumber: persisted.versionNumber,
          };
          await recordPersistedFill(tx, result);
        },
      });
      return Result.isError(created)
        ? { status: "error", message: created.error.message }
        : {
            status: "ok",
            value:
              result ??
              panic("Version persisted without an idempotency receipt"),
          };
    },
    catch: (cause) => cause,
  });
  if (Result.isError(persistence)) {
    await releaseClaim();
    return internalFailureResult(persistence.error);
  }
  if (persistence.value.status === "error") {
    await releaseClaim();
    return errorResult(persistence.value.message);
  }
  return toolDataResult(persistence.value.value);
};

/**
 * What to tell the caller for each structural DOCX failure on the base64 path.
 *
 * `unreadable-archive` is the failure a model-driven client actually hits on
 * this path: a client whose host cannot supply a file reference emits the whole
 * archive as base64 token by token, and a payload that drifted by one character
 * decodes to bytes that are no longer a readable ZIP. The generic "make sure it
 * is a valid .docx" advice invites the agent to shrink the file until it fits,
 * which destroys the document, so name the real cause instead.
 *
 * Total over the failure union: a new structural check has to decide what the
 * caller should do about it.
 */
const DOCX_BASE64_FAILURE_HINT = {
  "unreadable-archive":
    "The base64 does not decode to the original archive. Do not retype or " +
    "truncate the file, and do not strip parts out of it (styles.xml, " +
    "numbering.xml, theme1.xml, settings.xml, rsids) to make it smaller: " +
    "that destroys the document's formatting and still leaves an unreadable " +
    "archive. Re-encode the original .docx bytes verbatim, or have the file " +
    "attached through the host's file transport instead of inlining it.",
  "archive-limit-exceeded":
    "The archive opened, but it is outside the bounds stella will unpack " +
    "(entry count or decompressed size). Re-sending the same bytes will not " +
    "change that. Ask the user for a smaller .docx rather than repackaging " +
    "this one.",
  "missing-document-xml":
    "The archive decoded but has no 'word/document.xml'. Send the original " +
    ".docx unmodified; do not rebuild or repackage it.",
  "malformed-document-xml":
    "The archive decoded but 'word/document.xml' is not well-formed XML. " +
    "Send the original .docx unmodified; do not edit its XML by hand.",
} as const satisfies Record<DocxValidationFailure, string>;

/**
 * What to tell the caller for each structural DOCX failure on the host-file
 * path. The bytes were never retyped here, so the archive is broken at the
 * source: point at the attachment, not at the encoding.
 */
const DOCX_FILE_FAILURE_HINT = {
  "unreadable-archive":
    "The attached file is not a readable .docx archive. Attach the original " +
    "document rather than a renamed or re-exported copy.",
  "archive-limit-exceeded":
    "The attached archive exceeds the entry-count or decompressed-size limit. " +
    "Ask the user for a smaller .docx; reattaching the same file will not help.",
  "missing-document-xml":
    "The attached archive has no 'word/document.xml'. Attach the original " +
    ".docx unmodified; do not rebuild or repackage it.",
  "malformed-document-xml":
    "The attached archive's 'word/document.xml' is not well-formed XML. " +
    "Attach the original .docx unmodified.",
} as const satisfies Record<DocxValidationFailure, string>;

/** How the caller supplied the DOCX bytes for the create branch. */
type TemplateDocxSource =
  | { type: "base64"; docxBase64: string }
  | { type: "file"; file: v.InferOutput<typeof OPENAI_FILE_REFERENCE_SCHEMA> };

/** The input field each source's validation issues point back at. */
const DOCX_SOURCE_ISSUE_PATH = {
  base64: "docx_base64",
  file: "file",
} as const satisfies Record<TemplateDocxSource["type"], string>;

const DOCX_SOURCE_FAILURE_HINT = {
  base64: DOCX_BASE64_FAILURE_HINT,
  file: DOCX_FILE_FAILURE_HINT,
} as const satisfies Record<
  TemplateDocxSource["type"],
  Record<DocxValidationFailure, string>
>;

const HOST_FILE_DOWNLOAD_TIMEOUT_MS = 60_000;

type ResolvedTemplateDocx =
  | { status: "ok"; buffer: Buffer }
  | { status: "error"; result: InternalToolErrorResult };

const decodeBase64Docx = (docxBase64: string): ResolvedTemplateDocx => {
  const buffer = Buffer.from(docxBase64, "base64");
  // base64 silently drops invalid characters; an empty decode means the input
  // was not valid base64 at all.
  if (buffer.byteLength === 0) {
    return {
      status: "error",
      result: structuredErrorResult({
        code: "validation_error",
        message: "Invalid input: docx_base64 is not valid base64",
        issues: [
          { path: "docx_base64", message: "docx_base64 is not valid base64" },
        ],
        hint: "Base64-encode the raw DOCX bytes and pass the result as 'docx_base64'.",
      }),
    };
  }
  return { status: "ok", buffer };
};

/**
 * Pull the bytes behind a host file reference. The same SSRF-vetted outbound
 * fetch and byte ceiling `upload_document_version` uses: the reference is
 * caller-supplied, so the URL is resolved and pinned before any connection and
 * the body is cut off at the document size limit.
 */
const downloadHostFileDocx = async ({
  context,
  file,
}: {
  context: McpRequestContext;
  file: v.InferOutput<typeof OPENAI_FILE_REFERENCE_SCHEMA>;
}): Promise<ResolvedTemplateDocx> => {
  const downloaded = await (
    context.testDependencies?.safeOutboundFetchBytes ?? safeOutboundFetchBytes
  )({
    maxBytes: FILE_SIZE_LIMIT_BYTES.document,
    timeoutMs: HOST_FILE_DOWNLOAD_TIMEOUT_MS,
    url: file.download_url,
  });
  if (Result.isError(downloaded) || !downloaded.value.ok) {
    return {
      status: "error",
      result: structuredErrorResult({
        code: "validation_error",
        message: "The attached file could not be downloaded",
        issues: [
          {
            path: "file",
            message: "The attached file could not be downloaded",
          },
        ],
        hint:
          `Attach a .docx no larger than ${MAX_DOCX_MEGABYTES} MB and retry ` +
          "before its temporary download URL expires.",
      }),
    };
  }
  if (downloaded.value.body.byteLength === 0) {
    return {
      status: "error",
      result: structuredErrorResult({
        code: "validation_error",
        message: "The attached file is empty",
        issues: [{ path: "file", message: "The attached file is empty" }],
      }),
    };
  }
  return { status: "ok", buffer: Buffer.from(downloaded.value.body) };
};

const resolveTemplateDocx = async ({
  context,
  source,
}: {
  context: McpRequestContext;
  source: TemplateDocxSource;
}): Promise<ResolvedTemplateDocx> => {
  switch (source.type) {
    case "base64":
      return decodeBase64Docx(source.docxBase64);
    case "file":
      return await downloadHostFileDocx({ context, file: source.file });
    default: {
      source satisfies never;
      return panic(`Unhandled template DOCX source: ${String(source)}`);
    }
  }
};

/** The validated DOCX bytes a create or upsert call carries, or the failure
 *  that stopped them from being read. */
type CreateTemplateDocx =
  | { status: "ok"; buffer: Buffer }
  | { status: "error"; result: InternalToolErrorResult };

const readCreateTemplateDocx = async ({
  context,
  source,
}: {
  context: McpRequestContext;
  source: TemplateDocxSource;
}): Promise<CreateTemplateDocx> => {
  const resolved = await resolveTemplateDocx({ context, source });
  if (resolved.status === "error") {
    return resolved;
  }
  const { buffer } = resolved;
  const issuePath = DOCX_SOURCE_ISSUE_PATH[source.type];

  if (buffer.byteLength > FILE_SIZE_LIMIT_BYTES.document) {
    return {
      status: "error",
      result: structuredErrorResult({
        code: "validation_error",
        message: "DOCX exceeds the maximum allowed size",
        issues: [
          { path: issuePath, message: "DOCX exceeds the maximum allowed size" },
        ],
        hint: `Upload a DOCX no larger than ${FILE_SIZE_LIMIT_BYTES.document} bytes.`,
      }),
    };
  }

  const validation = await validateDocxBuffer(new Uint8Array(buffer).buffer);
  if (!validation.valid) {
    return {
      status: "error",
      result: structuredErrorResult({
        code: "validation_error",
        message: `Invalid DOCX file: ${validation.error}`,
        issues: [{ path: issuePath, message: validation.error }],
        hint: DOCX_SOURCE_FAILURE_HINT[source.type][validation.reason],
      }),
    };
  }
  return { status: "ok", buffer };
};

/**
 * How the caller supplied the DOCX, or that they supplied none (which is only
 * legal for a rename). A host reference wins over inline bytes when both are
 * present: the host transported the file, while the base64 was typed by the
 * caller. The inline bytes are then never decoded.
 */
const createTemplateDocxSource = (input: {
  docx_base64?: string | undefined;
  file?: v.InferOutput<typeof OPENAI_FILE_REFERENCE_SCHEMA> | undefined;
}): TemplateDocxSource | null => {
  if (input.file !== undefined) {
    return { type: "file", file: input.file };
  }
  if (input.docx_base64 !== undefined) {
    return { type: "base64", docxBase64: input.docx_base64 };
  }
  return null;
};

/**
 * `create_template` with a `template_id`: publish the document as the
 * template's next version, rename it, or both. The bytes go to S3 through
 * `writeStoredTemplate`, which owns that write and keeps it outside the
 * transaction.
 */
const upsertStoredTemplate = async ({
  buffer,
  context,
  name,
  templateId,
}: {
  buffer: Buffer | null;
  context: McpRequestContext;
  name: string | undefined;
  templateId: SafeId<"template">;
}): Promise<InternalToolErrorResult | { fieldCount: number }> => {
  if (buffer === null) {
    const renamed = await Result.gen(() =>
      (context.testDependencies?.renameStoredTemplate ?? renameStoredTemplate)({
        safeDb: context.safeDb,
        organizationId: context.organizationId,
        templateId,
        name: name ?? panic("rename branch reached without a name"),
        recordAuditEvent: context.recordAuditEvent,
      }),
    );
    return Result.isError(renamed)
      ? internalFailureResult(renamed.error)
      : { fieldCount: renamed.value.fieldCount };
  }

  const [discovered, embeddedManifest] = await Promise.all([
    discoverTemplate(buffer),
    readManifest(buffer),
  ]);
  const written = await Result.gen(() =>
    (context.testDependencies?.writeStoredTemplate ?? writeStoredTemplate)({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      templateId,
      mode: { type: "new-version", userId: context.userId },
      ...(name === undefined ? {} : { metadata: { name } }),
      recordAuditEvent: context.recordAuditEvent,
      async prepare({ manifest: currentManifest }) {
        // The new document decides which paths exist; the configuration that
        // survives is the one whose path the new bytes still carry.
        const manifest = resolveTemplateFieldOverlay({
          discovered,
          manifest: embeddedManifest ?? currentManifest,
          overlay: undefined,
        });
        const updatedDocx = await writeManifest(buffer, manifest);
        return Result.ok({ manifest, bytes: new Uint8Array(updatedDocx) });
      },
    }),
  );
  return Result.isError(written)
    ? internalFailureResult(written.error)
    : { fieldCount: written.value.row.fieldCount };
};

/**
 * `create_template`: a new template from an uploaded DOCX, a new version of an
 * existing one, or a rename. The response is the describe payload the template
 * now serves, so the agent reads the discovered fields, arrays and warnings
 * from the same producer `list_templates` uses.
 */
const handleCreateTemplateTool: TypedMcpToolHandler<
  v.InferInput<typeof CREATE_TEMPLATE_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(
    CREATE_TEMPLATE_TOOL_DEFINITION.inputSchemaSource,
    args,
  );
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;
  // Creating a template and publishing over one the organization already has
  // are different permissions, and the tool checks the one the call needs.
  const hasPermission = hasEffectiveAuthority(context, {
    template: [input.template_id === undefined ? "create" : "update"],
  });
  if (!hasPermission) {
    return errorResult("Forbidden");
  }

  const source = createTemplateDocxSource(input);
  let buffer: Buffer | null = null;
  if (source !== null) {
    const read = await readCreateTemplateDocx({ context, source });
    if (read.status === "error") {
      return read.result;
    }
    buffer = read.buffer;
  }
  // Reported with the template rather than refused, so a caller that sent
  // both learns which document was stored without losing the call.
  const sourceWarnings =
    source?.type === "file" && input.docx_base64 !== undefined
      ? [inlineBytesIgnoredWarning()]
      : [];

  if (input.template_id !== undefined) {
    const templateId = brandPersistedTemplateId(input.template_id);
    const upserted = await upsertStoredTemplate({
      buffer,
      context,
      name: input.name,
      templateId,
    });
    if (isToolErrorResult(upserted)) {
      return upserted;
    }
    const described = await describeTemplateForAgent({ context, templateId });
    if (isToolErrorResult(described)) {
      return described;
    }
    return toolDataResult({
      templateId,
      fieldCount: upserted.fieldCount,
      ...described,
      warnings: [...sourceWarnings, ...described.warnings],
    });
  }

  // The schema guarantees both on this branch: a create carries a name and a
  // document, and only an upsert may omit either.
  const name = input.name ?? panic("create branch reached without a name");
  const created = await Result.gen(() =>
    (context.testDependencies?.createStoredTemplate ?? createStoredTemplate)({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      userId: context.userId,
      buffer: buffer ?? panic("create branch reached without a DOCX"),
      name,
      fileName: `${name}.docx`,
      recordAuditEvent: context.recordAuditEvent,
    }),
  );
  if (Result.isError(created)) {
    return internalFailureResult(created.error);
  }

  const described = await describeTemplateForAgent({
    context,
    templateId: created.value.id,
  });
  if (isToolErrorResult(described)) {
    // The template exists: only reading it back failed. Returning the create
    // error bare would leave the caller with no id, and a retry would create a
    // second template, so the id and the way to reach it travel with the
    // failure.
    return structuredErrorResult({
      code: "internal_error",
      message: `Template ${created.value.id} was created, but reading its fields back failed`,
      hint: `Do not create it again. Read it with list_templates and template_id '${created.value.id}', then configure its fields.`,
      retryable: true,
    });
  }

  return toolDataResult({
    templateId: created.value.id,
    fieldCount: created.value.fieldCount,
    ...described,
    warnings: [...sourceWarnings, ...described.warnings],
  });
};

/** The describe payload both `create_template` and `configure_template_fields`
 *  hand back, read through the same producer `list_templates` detail mode
 *  uses so the three surfaces cannot drift. */
const describeTemplateForAgent = async ({
  context,
  templateId,
}: {
  context: McpRequestContext;
  templateId: SafeId<"template">;
}): Promise<InternalToolErrorResult | TemplateDetailPayload> => {
  const described = await (
    context.testDependencies?.describeStoredTemplate ?? describeStoredTemplate
  )({
    templateId,
    organizationId: context.organizationId,
    scopedDb: context.scopedDb,
  });
  if ("error" in described) {
    return errorResult(described.error);
  }
  const payload = toTemplateDetailPayload(templateId, described);
  type DescribedTemplatePayload = AssertNoExtraFields<
    typeof payload,
    v.InferInput<typeof TEMPLATE_DESCRIBE_PROJECTION>
  >;
  return payload satisfies DescribedTemplatePayload;
};

/** `configure_template_fields`: overlay field configuration onto an existing
 *  template. The stored document bytes keep their markers; only the
 *  manifest changes. */
/**
 * The position of the `fields` entry a validation issue belongs to, or null
 * when the issue is about the request rather than one entry. `fields.2.path`
 * belongs to entry 2; `template_id` and a `fields` that is not an array
 * belong to the request.
 */
const entryIndexOfIssue = (issue: v.BaseIssue<unknown>): number | null => {
  const path = issue.path;
  // An issue with no path at all is about the request, not about one entry.
  if (path === undefined) {
    return null;
  }
  const [root, position] = path;
  if (root.key !== "fields" || position === undefined) {
    return null;
  }
  return typeof position.key === "number" ? position.key : null;
};

type TemplateFieldProperty = keyof v.InferInput<
  typeof templateFieldInputSchema
>;

/**
 * The properties that decide WHO fills a field. Dropping one would silently
 * turn a derived field into a question for the person filling, so an entry
 * that gets one wrong is reported whole and applied not at all. Typed against
 * the entry's own keys, so renaming one is a compile error here.
 */
const DECISION_PROPERTIES = [
  "source",
] as const satisfies readonly TemplateFieldProperty[];

/** Every property the entry schema declares, so an undeclared key is reported
 *  as one rather than as a value the schema rejected. */
const DECLARED_ENTRY_PROPERTIES: ReadonlySet<string> = new Set(
  Object.keys(templateFieldInputSchema.entries),
);

/** What to do with an entry the schema refused: drop the one property the
 *  issue is about — named by its key path from the entry down — and keep the
 *  rest, or reject the entry whole. */
type EntryRepair =
  | { type: "drop-property"; path: readonly string[]; message: string }
  | { type: "reject-entry" };

const ENTRY_REJECTED: EntryRepair = { type: "reject-entry" };

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

const isEntryRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The keys, from the entry down, of the smallest value an issue can cost.
 * The walk follows the issue's own path as far as the entry can be rebuilt
 * without it: through plain objects, while each key is a string the value
 * carries. It stops at the nearest object property when the path turns into
 * an array element or into something that is not an object, because removing
 * one item out of a list the caller sent would silently renumber the rest.
 */
const droppablePath = (
  issue: v.BaseIssue<unknown>,
  entry: unknown,
): string[] => {
  const keys: string[] = [];
  let value = entry;
  for (const segment of arrayOrEmpty(issue.path).slice(2)) {
    if (
      typeof segment.key !== "string" ||
      !isEntryRecord(value) ||
      !Object.hasOwn(value, segment.key)
    ) {
      break;
    }
    keys.push(segment.key);
    value = value[segment.key];
  }
  return keys;
};

/**
 * How one issue is answered. A property costs itself: a strict-schema client
 * fills every property it can see, so a key this surface retired, a caller
 * misspelled, or a constraint it wrote as a placeholder must cost that key
 * and not the field it configures — and not its siblings either, so a refused
 * `validation.max_items` leaves the `validation.pattern` beside it standing.
 * The issue names the key it cost, so a misspelled `lable` does not vanish
 * silently.
 *
 * The entry as a whole goes only when it cannot be read: an unusable `path`,
 * a shape that is not an entry, or a property that decides WHO fills the
 * field — dropping that would silently turn a derived field into a question
 * for the person filling.
 */
const repairForIssue = (
  issue: v.BaseIssue<unknown>,
  entry: unknown,
): EntryRepair => {
  const path = droppablePath(issue, entry);
  const property = path.at(0);
  if (property === undefined || property === "path") {
    return ENTRY_REJECTED;
  }
  if (!DECLARED_ENTRY_PROPERTIES.has(property)) {
    return {
      type: "drop-property",
      path: [property],
      message: `\`${property}\` is not a property of a field entry.`,
    };
  }
  return DECISION_PROPERTIES.some((decision) => decision === property)
    ? ENTRY_REJECTED
    : {
        type: "drop-property",
        path,
        message: `\`${path.at(-1) ?? property}\` was dropped: ${issue.message}`,
      };
};

/** One entry with the value at `path` removed, rebuilding the objects above
 *  it. `null` when the path is not there to remove. */
const withoutPath = (
  entry: unknown,
  path: readonly string[],
): Record<string, unknown> | null => {
  const [head, ...rest] = path;
  if (
    head === undefined ||
    !isEntryRecord(entry) ||
    !Object.hasOwn(entry, head)
  ) {
    return null;
  }
  if (rest.length === 0) {
    const { [head]: _dropped, ...remaining } = entry;
    return remaining;
  }
  const inner = withoutPath(entry[head], rest);
  return inner === null ? null : { ...entry, [head]: inner };
};

/**
 * The one `source` shape that is read before the entry is parsed at all: a
 * condition on the field's own value.
 *
 * `{ "type": "condition", "expression": "expenses_reimbursed" }` on
 * `expenses_reimbursed` says "ask this when the answer is yes", which no one
 * can ever answer. The entry means the plain question, so the condition is
 * dropped and the rest of the entry applies — a decision property normally
 * costs the whole entry, and this one is not a decision, it is a shape with
 * no meaning. `null` when the entry is not that shape.
 */
const withoutCircularCondition = (
  entry: unknown,
): Record<string, unknown> | null => {
  if (!isEntryRecord(entry)) {
    return null;
  }
  const { path, source } = entry;
  if (
    typeof path !== "string" ||
    !isEntryRecord(source) ||
    source["type"] !== "condition"
  ) {
    return null;
  }
  const expression = source["expression"];
  return typeof expression === "string" &&
    conditionReferencesOnlySelf(path, expression)
    ? withoutPath(entry, ["source"])
    : null;
};

export type ConfigureEntries =
  | { type: "rejected"; result: InternalToolErrorResult }
  | {
      type: "parsed";
      templateId: string;
      fields: FieldMeta[];
      /** Where each applied entry sat in the `fields` array the caller sent,
       *  in the order the entries were applied. The service that validates
       *  them against the document counts positions in THIS list, so its
       *  issues are translated back through it. */
      applied: number[];
      /** Indices, into the `fields` array the caller sent, of the entries the
       *  schema refused, with what to do about each. */
      issues: FieldOverlayIssue[];
    };

/**
 * Read the request one property at a time. The schema is the tool's own,
 * applied to a `fields` array that is repaired between attempts: a value it
 * refuses — an invalid constraint, or a key the entry does not declare — is
 * dropped from its entry at the exact key the issue names, and reported on
 * its own; only an entry whose `path` (or whose shape as a whole) is
 * unreadable drops out. A caller that got one property wrong still configures
 * everything else it sent, including the rest of that entry and the siblings
 * of the key that went. Anything the schema objects to outside `fields` is
 * about the request, and fails it.
 *
 * The loop terminates: every pass either removes one key from an entry or
 * drops an entry, and an entry carries finitely many keys.
 */
export const parseConfigureEntries = (
  args: Record<string, unknown>,
): ConfigureEntries => {
  const schema = CONFIGURE_TEMPLATE_FIELDS_TOOL_DEFINITION.inputSchemaSource;
  const sentFields: unknown = args["fields"];
  const sent: unknown[] | null = isUnknownArray(sentFields)
    ? [...sentFields]
    : null;
  const issues: FieldOverlayIssue[] = [];
  for (const [position, entry] of sent?.entries() ?? []) {
    const dropped = withoutCircularCondition(entry);
    if (dropped === null || sent === null) {
      continue;
    }
    sent[position] = dropped;
    issues.push({
      path: `fields.${String(position)}.source`,
      index: position,
      message:
        "`source` was dropped: a condition that reads only the field's own " +
        "value cannot decide whether to ask for it.",
      hint: `The rest of the entry was applied and the field stays a question the person answers. A condition names the OTHER field it depends on; see ${TEMPLATE_FIELD_REFERENCE_URI}.`,
    });
  }
  let positions = sent === null ? [] : sent.map((_entry, index) => index);
  for (;;) {
    const candidate =
      sent === null
        ? args
        : { ...args, fields: positions.map((position) => sent[position]) };
    const parsed = v.safeParse(schema, candidate);
    if (parsed.success) {
      return {
        type: "parsed",
        templateId: parsed.output.template_id,
        fields: parsed.output.fields.map(toFieldMetaToolInput),
        applied: positions,
        issues,
      };
    }
    const rejected = new Set<number>();
    const repaired = new Set<number>();
    for (const issue of parsed.issues) {
      const local = entryIndexOfIssue(issue);
      if (local === null || sent === null) {
        return {
          type: "rejected",
          result: validationErrorResult(parsed.issues),
        };
      }
      const position =
        positions[local] ??
        panic(`entry issue names position ${String(local)}`);
      if (rejected.has(position) || repaired.has(position)) {
        continue;
      }
      const repair = repairForIssue(issue, sent[position]);
      const without =
        repair.type === "reject-entry"
          ? null
          : withoutPath(sent[position], repair.path);
      if (repair.type === "drop-property" && without !== null) {
        repaired.add(position);
        sent[position] = without;
        issues.push({
          path: [`fields.${String(position)}`, ...repair.path].join("."),
          index: position,
          message: repair.message,
          hint: `The rest of the entry was applied. Check that property against ${TEMPLATE_FIELD_REFERENCE_URI} and send it again if the field needs it.`,
        });
        continue;
      }
      rejected.add(position);
      issues.push({
        path: `fields.${String(position)}`,
        index: position,
        message: issue.message,
        hint: `Fix this entry against ${TEMPLATE_FIELD_REFERENCE_URI} and send it again; the other entries were applied.`,
      });
    }
    positions = positions.filter((position) => !rejected.has(position));
  }
};

const handleConfigureTemplateFieldsTool: TypedMcpToolHandler<
  v.InferInput<typeof CONFIGURE_TEMPLATE_FIELDS_PROJECTION>
> = async ({ args, context }) => {
  const hasPermission = hasEffectiveAuthority(context, {
    template: ["update"],
  });
  if (!hasPermission) {
    return errorResult("Forbidden");
  }

  const parsed = parseConfigureEntries(args);
  if (parsed.type === "rejected") {
    return parsed.result;
  }
  const templateId = brandPersistedTemplateId(parsed.templateId);

  const configured = await Result.gen(() =>
    (
      context.testDependencies?.configureTemplateFields ??
      configureTemplateFields
    )({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      templateId,
      fields: parsed.fields,
      recordAuditEvent: context.recordAuditEvent,
    }),
  );
  if (Result.isError(configured)) {
    return internalFailureResult(configured.error);
  }
  // The service only saw the entries the schema accepted, so it counts
  // positions in THAT list. The caller counts positions in the list it sent,
  // and repairs the entry an issue names, so the service's positions are
  // translated back before the two lists are merged.
  const serviceIssues = configured.value.issues.map((issue) => {
    const index =
      parsed.applied.at(issue.index) ??
      panic(`configure issue names applied entry ${String(issue.index)}`);
    return {
      path: `fields.${index}`,
      index,
      message: issue.message,
      hint: issue.hint,
    };
  });

  // Echo the field list in the same shape list_templates' detail mode returns,
  // so the agent sees exactly what is now configured, beside every entry that
  // was not applied and why.
  const described = await describeTemplateForAgent({ context, templateId });
  if (isToolErrorResult(described)) {
    return described;
  }
  return toolDataResult({
    ...described,
    issues: [...parsed.issues, ...serviceIssues].toSorted(
      (left, right) => left.index - right.index,
    ),
  });
};

export const TEMPLATE_TOOL_HANDLERS = {
  configure_template_fields: handleConfigureTemplateFieldsTool,
  create_template: handleCreateTemplateTool,
  fill_template: handleFillTemplateTool,
  list_templates: handleListTemplatesTool,
  save_filled_template: handleSaveFilledTemplateTool,
} satisfies Record<TemplateToolName, McpToolHandler>;

export const TEMPLATE_TOOL_SET = defineMcpToolSet(
  TEMPLATE_TOOL_DEFINITIONS,
  TEMPLATE_TOOL_HANDLERS,
);
