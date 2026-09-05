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
import type { SafeId } from "@/api/lib/branded-types";
import type {
  AssertNoExtraFields,
  LIST_TEMPLATES_LIST_PROJECTION,
  LIST_TEMPLATES_PROJECTION,
  SAVE_TEMPLATE_CREATE_PROJECTION,
  SAVE_TEMPLATE_PROJECTION,
  TEMPLATE_DESCRIBE_PROJECTION,
} from "@/api/lib/chat/projections";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import type { FieldMeta, FieldPart } from "@/api/lib/docx/types";
import { validateDocxBuffer } from "@/api/lib/entity-versions/validate-docx-buffer";
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
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";
import { createStoredTemplate } from "@/api/lib/templates/create-template";
import {
  recordTemplateFill,
  recordTemplateUse,
} from "@/api/lib/templates/record-use";
import { containsNull } from "@/api/lib/templates/template-data";
import {
  decideTemplateFillCompletion,
  DEFAULT_TEMPLATE_FILL_COMPLETION_MODE,
  TEMPLATE_FILL_COMPLETION_MODES,
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
import { withTimeout } from "@/api/lib/with-timeout";
import type { McpRequestContext } from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import {
  templateFieldInputSchema,
  toFieldMetaToolInput,
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
  InternalToolResult,
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
  parseOptionalCursor,
  stringProp,
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import { defineValibotMcpTool } from "@/api/mcp/valibot-tool-definition";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

type TemplateToolName =
  | "list_templates"
  | "fill_template"
  | "save_filled_template"
  | "save_template";

/** Max assembled-text length returned inline; full bytes ride along as base64. */
const TEMPLATE_FILL_TEXT_MAX_CHARS = 16_000;
const SAVE_FILLED_TEMPLATE_RENDER_TIMEOUT_MS = 300_000;

// Base64 encodes 3 bytes per 4 chars, so bound the encoded length to the doc
// size limit and reject an oversized upload at parse time, before it is decoded
// into a Buffer.
const MAX_DOCX_BASE64_LENGTH =
  Math.ceil(FILE_SIZE_LIMIT_BYTES.document / 3) * 4;

const saveTemplateArgsSchema = v.pipe(
  v.strictObject({
    template_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("Template to configure; omit when creating"),
      ),
    ),
    name: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(256),
        v.description("Display name; required when creating"),
      ),
    ),
    docx_base64: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(MAX_DOCX_BASE64_LENGTH),
        v.description("Base64 DOCX bytes; required when creating"),
      ),
    ),
    fields: v.optional(
      v.pipe(
        v.array(templateFieldInputSchema),
        v.description(
          `Field configuration overlay; see ${TEMPLATE_FIELD_REFERENCE_URI}`,
        ),
      ),
    ),
  }),
  v.partialCheck(
    [["template_id"], ["docx_base64"]],
    ({ template_id, docx_base64 }) =>
      (template_id === undefined) !== (docx_base64 === undefined),
    "Provide docx_base64 to create a template, or template_id to configure an existing template's fields",
  ),
  v.forward(
    v.partialCheck(
      [["docx_base64"], ["name"]],
      ({ docx_base64, name }) =>
        docx_base64 === undefined || name !== undefined,
      "name is required to create a template",
    ),
    ["name"],
  ),
  v.forward(
    v.partialCheck(
      [["template_id"], ["name"]],
      ({ template_id, name }) =>
        template_id === undefined || name === undefined,
      "name applies only when creating a template; omit it when configuring",
    ),
    ["name"],
  ),
  v.forward(
    v.partialCheck(
      [["template_id"], ["fields"]],
      ({ template_id, fields }) =>
        template_id === undefined || fields !== undefined,
      "fields is required to configure a template",
    ),
    ["fields"],
  ),
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
type TemplateDetailField = TemplateDetailSuccess["fields"][number];

const templateFieldOptionItems = (
  payload: TemplateDetailSuccess,
): readonly { index: number; options: string[] }[] =>
  payload.fields.flatMap((field) => {
    const options = field.options;
    return options ? options.map((_option, index) => ({ index, options })) : [];
  });

const templateFieldPartItems = (
  payload: TemplateDetailSuccess,
): readonly FieldPart[] =>
  payload.fields.flatMap((field) => compact(field.parts));

const templateFieldPartOptionItems = (
  payload: TemplateDetailSuccess,
): readonly { index: number; options: string[] }[] =>
  templateFieldPartItems(payload).flatMap((part) => {
    const options = part.options;
    return options ? options.map((_option, index) => ({ index, options })) : [];
  });

const templateFieldFormatItems = (
  payload: TemplateDetailSuccess,
): readonly { key: string; template: string }[] =>
  payload.fields.flatMap((field) => compact(field.formats));

const compact = <T>(
  items: readonly (T | null)[] | null | undefined,
): readonly T[] => {
  if (items === undefined || items === null) {
    return [];
  }
  return items.filter((item) => item !== null);
};

const buildTemplateDetailTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<TemplateDetailSuccess>[] => [
  defineTextFieldSpec({
    path: "name",
    items: (payload: TemplateDetailSuccess) => [payload],
    scope: () => organizationId,
    read: (payload: TemplateDetailSuccess) => payload.name,
    apply: (payload: TemplateDetailSuccess, value) => {
      payload.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "fields[].label",
    items: (payload: TemplateDetailSuccess) => payload.fields,
    scope: () => organizationId,
    read: (field: TemplateDetailField) => field.label,
    apply: (field: TemplateDetailField, value) => {
      field.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "fields[].hint",
    items: (payload: TemplateDetailSuccess) => payload.fields,
    scope: () => organizationId,
    read: (field: TemplateDetailField) => field.hint,
    apply: (field: TemplateDetailField, value) => {
      field.hint = value;
    },
  }),
  defineTextFieldSpec({
    path: "fields[].aiPrompt",
    items: (payload: TemplateDetailSuccess) => payload.fields,
    scope: () => organizationId,
    read: (field: TemplateDetailField) => field.aiPrompt,
    apply: (field: TemplateDetailField, value) => {
      field.aiPrompt = value;
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
    path: "fields[].parts[].label",
    items: templateFieldPartItems,
    scope: () => organizationId,
    read: (part: FieldPart) => part.label,
    apply: (part: FieldPart, value) => {
      part.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "fields[].parts[].options[]",
    items: templateFieldPartOptionItems,
    scope: () => organizationId,
    read: (item: { index: number; options: string[] }) =>
      item.options[item.index],
    apply: (item: { index: number; options: string[] }, value) => {
      item.options[item.index] = value;
    },
  }),
  defineTextFieldSpec({
    path: "fields[].formats[].template",
    items: templateFieldFormatItems,
    scope: () => organizationId,
    read: (format: { key: string; template: string }) => format.template,
    apply: (format: { key: string; template: string }, value) => {
      format.template = value;
    },
  }),
];

const SAVE_TEMPLATE_TOOL_DEFINITION = defineValibotMcpTool({
  description:
    "Create a document template from a DOCX, or configure an existing " +
    "template's fields. To create, pass docx_base64 (base64-encoded .docx / " +
    "Office Open XML bytes, max ~10 MB decoded) and a name; the {{field}} " +
    "markers in the file become the template's fillable fields, and fields " +
    "can configure them in the same call. To configure an existing template, " +
    "pass template_id with fields and no docx_base64; only the manifest " +
    "changes, the document's {{markers}} stay untouched. Read " +
    `${TEMPLATE_MARKER_REFERENCE_URI} before authoring a DOCX and ` +
    `${TEMPLATE_FIELD_REFERENCE_URI} before configuring fields. Returns the ` +
    "template id and field count when creating, or the updated field list " +
    "when configuring.",
  inputSchema: saveTemplateArgsSchema,
  jsonSchemaProjectionWaiver: {
    ignoreActions: ["check", "finite", "partial_check"],
    reason:
      "Field compatibility checks remain runtime-only; JSON numbers are finite on the wire.",
  },
  annotations: {
    title: "Save template",
    idempotentHint: false,
    openWorldHint: false,
  },
  access: "write",
  anonymized: { exposure: "excluded", reason: "write" },
  name: "save_template",
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
      `(see ${TEMPLATE_FIELD_REFERENCE_URI}), plus its named conditions and ` +
      "formula fields. Omitted optional scalar placeholders render blank. " +
      "A required, non-AI-fillable field omitted or empty fails " +
      "fill_template; `arrays` marks {{#each}} fields as arrays of objects, " +
      "not dotted keys.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: stringProp(
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
      "Fill a template and return text plus the DOCX as base64. First call " +
      "list_templates with template_id for field paths, then pass values as a " +
      'path-to-value map (for example, {"tenant.name":"ACME"}). Registry, ' +
      "composite, formula, and AI fields resolve automatically. Unknown keys " +
      "fail unless allow_unused_values is true; unfilled placeholders fail " +
      "unless completion_mode is allow_partial. A required field that is not " +
      "AI-fillable must be provided: an omitted or empty one fails with the " +
      "exact list of missing fields instead of a guessed value or a raw " +
      "placeholder in the output — ask the user for those values and retry. " +
      "Successful output includes completionStatus.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: stringProp("Template id, as returned by list_templates"),
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
        completion_mode: {
          ...enumProp(
            "Require every placeholder by default; use allow_partial only for an intentionally incomplete document.",
            TEMPLATE_FILL_COMPLETION_MODES,
          ),
          default: DEFAULT_TEMPLATE_FILL_COMPLETION_MODE,
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
      "Fill a registered template and persist the generated DOCX directly in " +
      "a matter, without requiring the client to upload bytes. Use " +
      "action='create_document' to create a new document (optionally inside " +
      "parent_id), or action='create_version' with entity_id to append a " +
      "version to an existing document. Call list_templates first to learn " +
      "the field paths and which are required. A required field that is not " +
      "AI-fillable must be provided, or the fill fails with the exact list of " +
      "missing fields; ask the user for those values instead of guessing. " +
      "Returns the entity and version identifiers plus any unmatched " +
      "placeholders or unused values.",
    inputSchema: {
      type: "object",
      properties: {
        action: enumProp("Persistence destination", [
          "create_document",
          "create_version",
        ]),
        template_id: stringProp("Template id, as returned by list_templates"),
        matter_id: stringProp("Matter receiving the filled DOCX."),
        entity_id: stringProp(
          "Existing document entity id; required only for create_version",
        ),
        parent_id: stringProp(
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
  SAVE_TEMPLATE_TOOL_DEFINITION,
] as const satisfies readonly McpToolDefinition[];

const listTemplatesArgsSchema = v.strictObject({
  cursor: v.optional(v.pipe(v.string(), v.maxLength(512))),
});

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

  // Detail mode: template_id returns one template's field configuration. The
  // list-only cursor does not apply, so reject the mixed request up front.
  if (args["template_id"] !== undefined) {
    if (args["cursor"] !== undefined) {
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
    return await describeTemplateDetail({ args, context });
  }

  const parsed = v.safeParse(listTemplatesArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
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

const describeTemplateArgsSchema = v.strictObject({
  template_id: v.pipe(v.string(), v.minLength(1)),
});

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

  const result = await (
    context.testDependencies?.describeStoredTemplate ?? describeStoredTemplate
  )({
    templateId: brandPersistedTemplateId(parsed.output.template_id),
    organizationId: context.organizationId,
    scopedDb: context.scopedDb,
  });
  if ("error" in result) {
    return errorResult(result.error);
  }

  // Redact the org-authored template name and each field's label/hint/aiPrompt;
  // field paths, input types, options, and condition/formula expressions are
  // structural and pass through. Template = org scope.
  const textFields = runTextFieldSpecs(
    buildTemplateDetailTextFieldSpecs(context.organizationId),
    result,
  );

  // `describeStoredTemplate` builds the describe payload, so there is no
  // literal for excess-property checking to guard; tie its return type instead.
  type TemplateDescribePayload = AssertNoExtraFields<
    typeof result,
    v.InferInput<typeof TEMPLATE_DESCRIBE_PROJECTION>
  >;
  return {
    egress: "structured",
    payload: result satisfies TemplateDescribePayload,
    textFields,
  };
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

const fillTemplateArgsSchema = v.strictObject({
  template_id: v.pipe(v.string(), v.minLength(1)),
  values: v.record(v.string(), v.unknown()),
  allow_unused_values: v.optional(v.boolean()),
  completion_mode: v.optional(
    v.picklist(TEMPLATE_FILL_COMPLETION_MODES),
    DEFAULT_TEMPLATE_FILL_COMPLETION_MODE,
  ),
});

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
          unusedCount: filled.unusedValues.length,
          structureErrors: filled.structureErrors,
          recordAuditEvent: context.recordAuditEvent,
        }),
    )
    .catch(captureError);

  const completion = decideTemplateFillCompletion({
    mode: parsed.output.completion_mode,
    unmatchedPlaceholders: filled.unmatchedPlaceholders,
  });
  if (completion.type === "rejected_partial") {
    const preview = completion.unmatchedPlaceholders.slice(0, 10);
    const omitted = completion.unmatchedPlaceholders.length - preview.length;
    const suffix = omitted > 0 ? ` (${omitted} more omitted)` : "";
    return structuredErrorResult({
      code: "validation_error",
      message: `Template fill incomplete; unmatched placeholders: ${preview.join(", ")}${suffix}`,
      issues: completion.unmatchedPlaceholders.map((placeholder) => ({
        path: `values.${placeholder}`,
        message: "Template placeholder was not filled",
      })),
      hint: "Call list_templates with template_id (CLI: template list --template-id ID) and provide the missing values, or set completion_mode to allow_partial when an incomplete document is intentional.",
    });
  }

  const completionStatus =
    completion.type === "complete" ? "complete" : "partial";

  const truncated = filled.text.length > TEMPLATE_FILL_TEXT_MAX_CHARS;

  return toolDataResult({
    completionStatus,
    templateName: filled.templateName,
    fileName: filled.fileName,
    text: truncated
      ? filled.text.slice(0, TEMPLATE_FILL_TEXT_MAX_CHARS)
      : filled.text,
    truncated,
    docxBase64: filled.buffer.toString("base64"),
    unmatchedPlaceholders: filled.unmatchedPlaceholders,
    unusedValues: filled.unusedValues,
  });
};

const saveFilledTemplateArgsSchema = v.strictObject({
  action: v.picklist(["create_document", "create_version"]),
  template_id: v.pipe(v.string(), v.uuid()),
  matter_id: v.pipe(v.string(), v.minLength(1)),
  entity_id: v.optional(v.pipe(v.string(), v.uuid())),
  parent_id: v.optional(v.pipe(v.string(), v.uuid())),
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(255))),
  idempotency_key: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  values: v.record(v.string(), v.unknown()),
});

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

  const requestFingerprint = (
    context.testDependencies?.fingerprintTemplatePersistenceRequest ??
    fingerprintTemplatePersistenceRequest
  )({
    action: input.action,
    templateId: input.template_id,
    workspaceId,
    entityId: input.entity_id,
    parentId: input.parent_id,
    name: input.name,
    values: input.values,
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
  // Never cross the non-idempotent persistence boundary after either the
  // caller disconnects or the server-owned render deadline expires, even if
  // the abandoned fill operation settles later.
  if (operationSignal.aborted) {
    await releaseClaim();
    return errorResult("Request cancelled before document persistence");
  }

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

// Create branch of save_template: a new template from an uploaded DOCX, with an
// optional field-configuration overlay. Reused from the former create_template
// tool.
const createTemplateFromDocx = async ({
  context,
  docxBase64,
  fields,
  name,
}: {
  context: McpRequestContext;
  docxBase64: string;
  fields: FieldMeta[] | undefined;
  name: string;
}): Promise<
  InternalToolResult<v.InferInput<typeof SAVE_TEMPLATE_PROJECTION>>
> => {
  const hasPermission = hasEffectiveAuthority(context, {
    template: ["create"],
  });
  if (!hasPermission) {
    return errorResult("Forbidden");
  }

  let clientManifest: { fields: FieldMeta[] } | null = null;
  if (fields !== undefined) {
    clientManifest = { fields };
  }

  const buffer = Buffer.from(docxBase64, "base64");
  // base64 silently drops invalid characters; an empty decode means the input
  // was not valid base64 at all.
  if (buffer.byteLength === 0) {
    return structuredErrorResult({
      code: "validation_error",
      message: "Invalid input: docx_base64 is not valid base64",
      issues: [
        { path: "docx_base64", message: "docx_base64 is not valid base64" },
      ],
      hint: "Base64-encode the raw DOCX bytes and pass the result as 'docx_base64'.",
    });
  }
  if (buffer.byteLength > FILE_SIZE_LIMIT_BYTES.document) {
    return structuredErrorResult({
      code: "validation_error",
      message: "DOCX exceeds the maximum allowed size",
      issues: [
        {
          path: "docx_base64",
          message: "DOCX exceeds the maximum allowed size",
        },
      ],
      hint: `Upload a DOCX no larger than ${FILE_SIZE_LIMIT_BYTES.document} bytes.`,
    });
  }

  const validation = await validateDocxBuffer(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
  if (!validation.valid) {
    return structuredErrorResult({
      code: "validation_error",
      message: `Invalid DOCX file: ${validation.error}`,
      issues: [{ path: "docx_base64", message: validation.error }],
      hint: "Ensure 'docx_base64' decodes to a valid, uncorrupted .docx file.",
    });
  }

  const created = await Result.gen(() =>
    (context.testDependencies?.createStoredTemplate ?? createStoredTemplate)({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      userId: context.userId,
      buffer,
      name,
      fileName: `${name}.docx`,
      clientManifest,
      recordAuditEvent: context.recordAuditEvent,
    }),
  );
  if (Result.isError(created)) {
    return errorResult(created.error.message);
  }

  return toolDataResult({
    templateId: created.value.id,
    name: created.value.name,
    fieldCount: created.value.fieldCount,
  } satisfies v.InferInput<typeof SAVE_TEMPLATE_CREATE_PROJECTION>);
};

// Configure branch of save_template: overlay field configuration onto an
// existing template. Reused from the former configure_template_fields tool.
const configureExistingTemplate = async ({
  context,
  fields,
  templateId: rawTemplateId,
}: {
  context: McpRequestContext;
  fields: FieldMeta[];
  templateId: string;
}): Promise<
  InternalToolResult<v.InferInput<typeof SAVE_TEMPLATE_PROJECTION>>
> => {
  const hasPermission = hasEffectiveAuthority(context, {
    template: ["update"],
  });
  if (!hasPermission) {
    return errorResult("Forbidden");
  }

  const templateId = brandPersistedTemplateId(rawTemplateId);

  const configured = await Result.gen(() =>
    (
      context.testDependencies?.configureTemplateFields ??
      configureTemplateFields
    )({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      templateId,
      fields,
      recordAuditEvent: context.recordAuditEvent,
    }),
  );
  if (Result.isError(configured)) {
    return errorResult(configured.error.message);
  }

  // Echo the updated field list in the same shape the list_templates detail
  // mode returns, so the agent sees exactly what is now configured (a complete
  // round-trip).
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

  type ConfiguredTemplatePayload = AssertNoExtraFields<
    typeof described,
    v.InferInput<typeof TEMPLATE_DESCRIBE_PROJECTION>
  >;
  return toolDataResult(described satisfies ConfiguredTemplatePayload);
};

const handleSaveTemplateTool: TypedMcpToolHandler<
  v.InferInput<typeof SAVE_TEMPLATE_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(
    SAVE_TEMPLATE_TOOL_DEFINITION.inputSchemaSource,
    args,
  );
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;
  const fields = input.fields?.map(toFieldMetaToolInput);

  // Configure branch: template_id (no docx_base64) overlays field config onto an
  // existing template. The schema guarantees fields is present here.
  if (input.template_id !== undefined) {
    return await configureExistingTemplate({
      context,
      fields:
        fields ??
        panic(
          "save_template configure branch reached without a fields overlay",
        ),
      templateId: input.template_id,
    });
  }

  // Create branch: docx_base64 and name are guaranteed present by the schema.
  return await createTemplateFromDocx({
    context,
    docxBase64:
      input.docx_base64 ??
      panic("save_template create branch reached without docx_base64"),
    fields,
    name:
      input.name ?? panic("save_template create branch reached without name"),
  });
};

export const TEMPLATE_TOOL_HANDLERS = {
  fill_template: handleFillTemplateTool,
  list_templates: handleListTemplatesTool,
  save_filled_template: handleSaveFilledTemplateTool,
  save_template: handleSaveTemplateTool,
} satisfies Record<TemplateToolName, McpToolHandler>;

export const TEMPLATE_TOOL_SET = defineMcpToolSet(
  TEMPLATE_TOOL_DEFINITIONS,
  TEMPLATE_TOOL_HANDLERS,
);
