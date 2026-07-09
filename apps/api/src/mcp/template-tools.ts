import { panic, Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { roles } from "@stll/permissions";

import { templates } from "@/api/db/schema";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/handlers/docx/ai-field-generator";
import type { FieldMeta, FieldPart } from "@/api/handlers/docx/types";
import { INPUT_TYPES, isFieldMeta } from "@/api/handlers/docx/types";
import { validateDocxBuffer } from "@/api/handlers/entities/validate-docx-buffer";
import { configureTemplateFields } from "@/api/handlers/templates/configure-template-fields-service";
import { createStoredTemplate } from "@/api/handlers/templates/create-template-service";
import { recordTemplateFill } from "@/api/handlers/templates/record-use";
import type { DescribeTemplateResult } from "@/api/handlers/templates/template-fill-service";
import {
  describeStoredTemplate,
  fillStoredTemplateWithText,
} from "@/api/handlers/templates/template-fill-service";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { assertUsageAvailableForHandler } from "@/api/lib/api-handlers";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedTemplateId } from "@/api/lib/safe-id-boundaries";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
  runTextFieldSpecs,
} from "@/api/mcp/text-field-spec";
import type {
  McpTextFieldSpec,
  McpToolDefinition,
  McpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  enumProp,
  errorResult,
  isToolErrorResult,
  parseOptionalCursor,
  stringProp,
  textResult,
} from "@/api/mcp/tool-utils";

type TemplateToolName = "list_templates" | "fill_template" | "save_template";

/** Max assembled-text length returned inline; full bytes ride along as base64. */
const TEMPLATE_FILL_TEXT_MAX_CHARS = 16_000;

/**
 * One field-configuration overlay entry. Each object configures the field at
 * `path` (a marker discovered in the DOCX); every property except `path` is
 * optional and merged onto the discovered/stored field. Shape mirrors
 * `FieldMeta`, validated with the same `isFieldMeta` the REST manifest overlay
 * uses. JSON Schema is kept loose (`additionalProperties`) so callers can pass
 * the full shape; the handler validates each entry strictly.
 */
const fieldConfigItemSchema = {
  type: "object",
  properties: {
    path: stringProp("Field path — must match a {{marker}} in the template"),
    label: stringProp("Human-readable field label"),
    hint: stringProp(
      "Short fill guidance shown to the person filling the field",
    ),
    inputType: enumProp("Input control type", INPUT_TYPES),
    required: { type: "boolean", description: "Whether a value is required" },
    options: {
      type: "array",
      items: { type: "string" },
      description: "Allowed values when inputType is 'select'",
    },
    optionsFrom: stringProp(
      "Dependent select: path of another field whose value(s) supply the options",
    ),
    aiPrompt: stringProp(
      "Who-fills = AI: instruction the model uses to draft the value at fill time",
    ),
    aiAdapt: {
      type: "boolean",
      description:
        "Who-fills = Person+AI: the entered value is a stub AI rewrites per occurrence",
    },
    formula: stringProp(
      "Who-fills = formula: arithmetic expression over other fields, derived at fill time",
    ),
    condition: stringProp(
      "Boolean field derived by rule: a condition expression (e.g. " +
        'client_type == "company"), evaluated at fill time. A {{#if field_path}} ' +
        "marker references it by path. Mutually exclusive with " +
        "formula/aiPrompt/aiAdapt/lookup/parts.",
    ),
    parts: {
      type: "array",
      description: "Composite field parts (joined by 'format')",
      items: { type: "object", additionalProperties: true },
    },
    format: stringProp(
      "Join template over composite part keys, e.g. '{{title}} {{name}}'",
    ),
    dateFormat: {
      type: "object",
      description: "Locale-aware date rendering for a date field",
      properties: {
        locale: stringProp("BCP-47 language tag, e.g. 'cs', 'de', 'pl'"),
        style: enumProp("Date style", ["long", "medium", "short", "iso"]),
      },
      required: ["locale", "style"],
    },
    lookup: {
      type: "object",
      description: "Who-fills = company-register lookup",
      properties: {
        registry: stringProp("Registry slug, e.g. 'krs'"),
        formats: {
          type: "array",
          description:
            "Named output renderings; the first is the default for the bare {{marker}}",
          items: {
            type: "object",
            properties: {
              key: stringProp("Marker segment after the path: {{path.key}}"),
              template: stringProp(
                "[token]-substituted rendering of the registry hit",
              ),
            },
            required: ["key", "template"],
          },
        },
      },
      required: ["registry", "formats"],
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const fieldsOverlayProp = {
  type: "array",
  description:
    "Field configuration overlay, one entry per field to configure. Each " +
    "entry's 'path' must match a {{marker}} in the template. Configurable: " +
    "label, hint, inputType, required, options, optionsFrom (dependent select), " +
    "date format, composite parts + format, and who-fills the field — a person " +
    "(default), AI (aiPrompt), Person+AI (aiAdapt), a formula, or a " +
    "company-register lookup (registry + named output formats). formula is " +
    "mutually exclusive with aiPrompt/aiAdapt/lookup/parts.",
  items: fieldConfigItemSchema,
} as const;

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
): readonly FieldPart[] => payload.fields.flatMap((field) => field.parts ?? []);

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
  payload.fields.flatMap((field) => field.formats ?? []);

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

export const TEMPLATE_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "List the document templates in this organization (NDAs, powers of " +
      "attorney, leases), or describe one template's fillable fields. Omit " +
      "template_id to list templates: each template's id, name, field count, " +
      "tags, and usage guidance (whenToUse / whenNotToUse); prefer a template " +
      "whose whenToUse matches the request and skip any whose whenNotToUse " +
      "applies. Pass template_id to return that template's full field " +
      "configuration (path, label, inputType, required, hint, options, " +
      "optionsFrom, aiPrompt / aiAdapt, date format, composite parts, " +
      "registry-lookup formats) plus its named conditions and formula fields; " +
      "feed the same shape to save_template to update it.",
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
      "Fill a template with values and return the assembled document text plus " +
      "the filled DOCX as base64. Call list_templates with a template_id first " +
      "to learn the field paths. 'values' maps each field path to its value, " +
      'e.g. {"tenant.name": "ACME Sp. z o.o.", "signing_date": "2026-06-08"}. ' +
      "Registry lookups, composite fields, formula fields, and AI-fillable " +
      "fields are resolved automatically; AI-fillable fields are drafted when " +
      "you omit them. Returns the rendered text and any placeholders left " +
      "unfilled.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: stringProp("Template id, as returned by list_templates"),
        values: {
          type: "object",
          description: "Map of field path to value.",
          additionalProperties: true,
        },
      },
      required: ["template_id", "values"],
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "fill_template",
    scope: "stella:templates",
  },
  {
    description:
      "Create a document template from a DOCX, or configure an existing " +
      "template's fields. To create, pass docx_base64 (base64-encoded .docx / " +
      "Office Open XML bytes, max ~10 MB decoded) and a name; the {{field}} " +
      "markers in the file become the template's fillable fields, and you can " +
      "pass fields to configure them in the same call. To configure an existing " +
      "template, pass template_id with fields and no docx_base64; only the " +
      "manifest changes, the document's {{markers}} stay untouched. Each fields " +
      "entry's path must match a {{marker}} in the template. Read the marker " +
      "grammar from the template-markers reference resource when unsure. " +
      "Returns the template id and field count when creating, or the updated " +
      "field list when configuring.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: stringProp(
          "Existing template id to configure its fields; omit (with docx_base64) to create a new template",
        ),
        name: stringProp("Template display name; required when creating", {
          maxLength: 256,
        }),
        docx_base64: stringProp(
          "Base64-encoded DOCX file bytes (Office Open XML, max ~10 MB decoded); required when creating, omit when configuring",
        ),
        fields: fieldsOverlayProp,
      },
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "save_template",
    scope: "stella:templates",
  },
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

const handleListTemplatesTool: McpToolHandler = async ({ args, context }) => {
  const hasPermission = roles[context.memberRole].authorize({
    workspace: ["read"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  // Detail mode: template_id returns one template's field configuration. The
  // list-only cursor does not apply, so reject the mixed request up front.
  if (args["template_id"] !== undefined) {
    if (args["cursor"] !== undefined) {
      return errorResult(
        "cursor applies when listing templates; omit template_id to list",
      );
    }
    return await describeTemplateDetail({ args, context });
  }

  const parsed = v.safeParse(listTemplatesArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: list_templates accepts template_id or cursor",
    );
  }

  const cursor = parseOptionalCursor({ args, key: "cursor" });
  if (isToolErrorResult(cursor)) {
    return cursor;
  }
  let boundaryId: string | undefined;
  if (cursor !== undefined) {
    const decoded = decodeTemplatePageCursor(cursor);
    if (decoded === null) {
      return errorResult("Invalid cursor");
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
  const payload = { templates: page.items, nextCursor: page.nextCursor };
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
const describeTemplateDetail: McpToolHandler = async ({ args, context }) => {
  const parsed = v.safeParse(describeTemplateArgsSchema, args);
  if (!parsed.success) {
    return errorResult("Invalid input: expected { template_id: string }");
  }

  const result = await describeStoredTemplate({
    templateId: brandPersistedTemplateId(parsed.output.template_id),
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

  return { egress: "structured", payload: result, textFields };
};

const fillTemplateArgsSchema = v.strictObject({
  template_id: v.pipe(v.string(), v.minLength(1)),
  values: v.record(v.string(), v.unknown()),
});

const handleFillTemplateTool: McpToolHandler = async ({ args, context }) => {
  const hasPermission = roles[context.memberRole].authorize({
    template: ["use"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(fillTemplateArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: expected { template_id: string, values: object }",
    );
  }

  // Load the org's AI config so AI-fillable / aiAdapt fields behave exactly as
  // they do in the chat tools and web fill routes; a missing config simply
  // leaves those fields unfilled rather than erroring.
  const orgAIConfig = await loadOrgAIConfig(context.organizationId);
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
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
  });
  const generateAiValue = buildAiFieldGenerator({
    orgAIConfig,
    organizationId: context.organizationId,
    aiAnalytics,
  });
  const decideAiCondition = buildAiConditionDecider({
    orgAIConfig,
    organizationId: context.organizationId,
    aiAnalytics,
  });
  const adaptAiValue = buildAiOccurrenceAdapter({
    orgAIConfig,
    organizationId: context.organizationId,
    aiAnalytics,
  });

  // Gate AI quota the same way the web/chat fill paths do: the service runs
  // this only when the manifest declares AI fields, before any model call, so a
  // deterministic fill never spends quota. Gated on a usable provider — org
  // BYOK or the deployment's instance provider — since the generators run the
  // fast model in either case; a null org config flows through to the metering
  // layer (instance-provider rate).
  const assertUsageAvailable =
    orgAIConfig || hasTanStackInstanceProvider()
      ? async () =>
          await assertUsageAvailableForHandler({
            metering: { actionType: "chat", modelRole: "fast" },
            organizationId: context.organizationId,
            orgAIConfig,
            workspaceId: null,
            userId: context.userId,
            safeDb: context.safeDb,
          })
      : undefined;

  const filled = await fillStoredTemplateWithText({
    templateId: brandPersistedTemplateId(parsed.output.template_id),
    values: parsed.output.values,
    scopedDb: context.scopedDb,
    organizationId: context.organizationId,
    assertUsageAvailable,
    generateAiValue,
    decideAiCondition,
    adaptAiValue,
  });
  if ("usageRejection" in filled) {
    return errorResult(filled.usageRejection.message);
  }
  if ("error" in filled) {
    return errorResult(filled.error);
  }

  // Record the execution (fill row + EXECUTE audit) like the REST fill routes,
  // so agent-driven fills appear in the audit trail. Best-effort: a successful
  // render is not discarded if the bookkeeping write fails (it is captured).
  await context
    .scopedDb(
      async (tx) =>
        await recordTemplateFill({
          tx,
          templateId: brandPersistedTemplateId(parsed.output.template_id),
          organizationId: context.organizationId,
          userId: context.userId,
          format: "docx",
          unmatchedCount: filled.unmatchedPlaceholders.length,
          unusedCount: filled.unusedValues.length,
          recordAuditEvent: context.recordAuditEvent,
        }),
    )
    .catch(captureError);

  const truncated = filled.text.length > TEMPLATE_FILL_TEXT_MAX_CHARS;

  return textResult({
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

// base64 encodes 3 bytes per 4 chars, so bound the encoded length to the doc
// size limit and reject an oversized upload at parse time, before it is decoded
// into a Buffer.
const MAX_DOCX_BASE64_LENGTH =
  Math.ceil(FILE_SIZE_LIMIT_BYTES.document / 3) * 4;

/**
 * Prefer a cross-field (`partial_check`) validation message when present,
 * falling back to the hand-written shape hint for structural failures.
 */
const crossFieldOrGeneric = (
  issues: readonly v.BaseIssue<unknown>[],
  genericMessage: string,
): string =>
  issues.find((issue) => issue.type === "partial_check")?.message ??
  genericMessage;

const saveTemplateArgsSchema = v.pipe(
  v.strictObject({
    template_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
    docx_base64: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_DOCX_BASE64_LENGTH)),
    ),
    // Validated structurally below with isFieldMeta — the same validator the
    // REST manifest overlay uses — so the JSON-schema-level shape stays loose.
    fields: v.optional(v.array(v.unknown())),
  }),
  // Exactly one mode: create (docx_base64, no template_id) or configure
  // (template_id, no docx_base64). Both absent or both present is rejected.
  v.partialCheck(
    [["template_id"], ["docx_base64"]],
    ({ template_id, docx_base64 }) =>
      (template_id === undefined) !== (docx_base64 === undefined),
    "Provide docx_base64 to create a template, or template_id to configure an existing template's fields",
  ),
  // Creating (docx_base64) requires a name.
  v.forward(
    v.partialCheck(
      [["docx_base64"], ["name"]],
      ({ docx_base64, name }) =>
        docx_base64 === undefined || name !== undefined,
      "name is required to create a template",
    ),
    ["name"],
  ),
  // name applies only to creation; a configure call must not send it.
  v.forward(
    v.partialCheck(
      [["template_id"], ["name"]],
      ({ template_id, name }) =>
        template_id === undefined || name === undefined,
      "name applies only when creating a template; omit it when configuring",
    ),
    ["name"],
  ),
  // Configuring (template_id) requires a fields overlay to apply.
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

/**
 * Validate a raw `fields` overlay with the SAME `isFieldMeta` validator the
 * REST manifest path uses. Returns the typed fields, or the offending entry's
 * index so the caller can name it. `isFieldMeta` also enforces the
 * mutual-exclusivity rules (formula vs aiPrompt/aiAdapt/lookup/parts; parts iff
 * format).
 */
type FieldsOverlayResult =
  | { ok: true; fields: FieldMeta[] }
  | { ok: false; index: number };

const validateFieldsOverlay = (
  fields: readonly unknown[],
): FieldsOverlayResult => {
  const validated: FieldMeta[] = [];
  for (const [index, field] of fields.entries()) {
    if (!isFieldMeta(field)) {
      return { ok: false, index };
    }
    validated.push(field);
  }
  return { ok: true, fields: validated };
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
  fields: readonly unknown[] | undefined;
  name: string;
}): Promise<ReturnType<typeof textResult>> => {
  const hasPermission = roles[context.memberRole].authorize({
    template: ["create"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  let clientManifest: { fields: FieldMeta[] } | null = null;
  if (fields !== undefined) {
    const overlay = validateFieldsOverlay(fields);
    if (!overlay.ok) {
      return errorResult(
        `Invalid field config at fields[${overlay.index}]: not a valid ` +
          "field configuration (check input type, lookup, and that formula is " +
          "not combined with aiPrompt/aiAdapt/lookup/parts).",
      );
    }
    clientManifest = { fields: overlay.fields };
  }

  const buffer = Buffer.from(docxBase64, "base64");
  // base64 silently drops invalid characters; an empty decode means the input
  // was not valid base64 at all.
  if (buffer.byteLength === 0) {
    return errorResult("Invalid input: docx_base64 is not valid base64");
  }
  if (buffer.byteLength > FILE_SIZE_LIMIT_BYTES.document) {
    return errorResult("DOCX exceeds the maximum allowed size");
  }

  const validation = await validateDocxBuffer(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
  if (!validation.valid) {
    return errorResult(`Invalid DOCX file: ${validation.error}`);
  }

  const created = await Result.gen(() =>
    createStoredTemplate({
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

  return textResult({
    templateId: created.value.id,
    name: created.value.name,
    fieldCount: created.value.fieldCount,
  });
};

// Configure branch of save_template: overlay field configuration onto an
// existing template. Reused from the former configure_template_fields tool.
const configureExistingTemplate = async ({
  context,
  fields,
  templateId: rawTemplateId,
}: {
  context: McpRequestContext;
  fields: readonly unknown[];
  templateId: string;
}): Promise<ReturnType<typeof textResult>> => {
  const hasPermission = roles[context.memberRole].authorize({
    template: ["update"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const overlay = validateFieldsOverlay(fields);
  if (!overlay.ok) {
    return errorResult(
      `Invalid field config at fields[${overlay.index}]: not a valid field ` +
        "configuration (check input type, lookup, and that formula is not " +
        "combined with aiPrompt/aiAdapt/lookup/parts).",
    );
  }

  const templateId = brandPersistedTemplateId(rawTemplateId);

  const configured = await Result.gen(() =>
    configureTemplateFields({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      templateId,
      fields: overlay.fields,
      recordAuditEvent: context.recordAuditEvent,
    }),
  );
  if (Result.isError(configured)) {
    return errorResult(configured.error.message);
  }

  // Echo the updated field list in the same shape the list_templates detail
  // mode returns, so the agent sees exactly what is now configured (a complete
  // round-trip).
  const described = await describeStoredTemplate({
    templateId,
    scopedDb: context.scopedDb,
  });
  if ("error" in described) {
    return errorResult(described.error);
  }

  return textResult(described);
};

const handleSaveTemplateTool: McpToolHandler = async ({ args, context }) => {
  const parsed = v.safeParse(saveTemplateArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { docx_base64: string, name: string, fields?: array } to create, or { template_id: string, fields: array } to configure",
      ),
    );
  }
  const input = parsed.output;

  // Configure branch: template_id (no docx_base64) overlays field config onto an
  // existing template. The schema guarantees fields is present here.
  if (input.template_id !== undefined) {
    return await configureExistingTemplate({
      context,
      fields:
        input.fields ??
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
    fields: input.fields,
    name:
      input.name ?? panic("save_template create branch reached without name"),
  });
};

export const TEMPLATE_TOOL_HANDLERS = {
  fill_template: handleFillTemplateTool,
  list_templates: handleListTemplatesTool,
  save_template: handleSaveTemplateTool,
} satisfies Record<TemplateToolName, McpToolHandler>;

export const TEMPLATE_TOOL_SET = defineMcpToolSet(
  TEMPLATE_TOOL_DEFINITIONS,
  TEMPLATE_TOOL_HANDLERS,
);
