import { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { roles } from "@stll/permissions";

import { templates } from "@/api/db/schema";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/handlers/docx/ai-field-generator";
import type { FieldMeta } from "@/api/handlers/docx/types";
import { INPUT_TYPES, isFieldMeta } from "@/api/handlers/docx/types";
import { validateDocxBuffer } from "@/api/handlers/entities/validate-docx-buffer";
import { configureTemplateFields } from "@/api/handlers/templates/configure-template-fields-service";
import { createStoredTemplate } from "@/api/handlers/templates/create-template-service";
import { recordTemplateFill } from "@/api/handlers/templates/record-use";
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
import { buildMarkerReference } from "@/api/mcp/template-marker-reference";
import type {
  McpStructuredTextField,
  McpToolDefinition,
  McpToolHandler,
} from "@/api/mcp/tool-types";
import {
  enumProp,
  errorResult,
  isToolErrorResult,
  parseOptionalCursor,
  stringProp,
  textResult,
} from "@/api/mcp/tool-utils";

type TemplateToolName =
  | "list_templates"
  | "describe_template"
  | "fill_template"
  | "create_template"
  | "configure_template_fields"
  | "template_marker_reference";

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

export const TEMPLATE_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "List the document templates in this organization (NDAs, powers of " +
      "attorney, leases, and so on). Returns each template's id, name, number " +
      "of fillable fields, tags, and usage guidance (whenToUse / whenNotToUse). " +
      "Call this first to learn which templates exist and their ids before " +
      "describing or filling one. Prefer a template whose whenToUse matches the " +
      "request and skip any whose whenNotToUse applies.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: stringProp(
          "Opaque cursor from a previous list_templates call to fetch the next page",
          { maxLength: 512 },
        ),
      },
    },
    anonymized: {
      exposure: "anonymize",
      textFields: [
        "templates[].name",
        "templates[].whenToUse",
        "templates[].whenNotToUse",
      ],
    },
    name: "list_templates",
    scope: "stella:templates",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Describe a template's fillable fields so you know what to provide before " +
      "filling it. Returns each field's full configuration: path, label, " +
      "inputType, required, hint, select options, optionsFrom (dependent " +
      "select), aiPrompt / aiAdapt (who-fills), date format, composite parts + " +
      "format, and (for registry-lookup fields) the named output formats. Also " +
      "returns named conditions and computed (formula) fields. The result is a " +
      "complete round-trip: feed the same shape to configure_template_fields. " +
      "Pass the template id from list_templates.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: stringProp("Template id, as returned by list_templates"),
      },
      required: ["template_id"],
    },
    anonymized: {
      exposure: "anonymize",
      textFields: [
        "name",
        "fields[].label",
        "fields[].hint",
        "fields[].aiPrompt",
      ],
    },
    name: "describe_template",
    scope: "stella:templates",
  },
  {
    description:
      "Fill a template with values and return the assembled document text plus " +
      "the filled DOCX as base64. Call describe_template first to learn the " +
      "field paths. 'values' maps each field path to its value, e.g. " +
      '{"tenant.name": "ACME Sp. z o.o.", "signing_date": "2026-06-08"}. ' +
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
    anonymized: { exposure: "excluded", reason: "write" },
    name: "fill_template",
    scope: "stella:templates",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Return stella's `{{...}}` template marker grammar: how to write " +
      "fillable values, conditional and repeating blocks, clause slots, and " +
      "numbering inside a DOCX. Takes no arguments. Call this before " +
      "create_template whenever you are unsure of the marker syntax.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    anonymized: { exposure: "passthrough" },
    name: "template_marker_reference",
    scope: "stella:templates",
  },
  {
    description:
      "Create a document template from a DOCX file containing {{markers}}. " +
      "'docx_base64' is the base64-encoded bytes of a .docx (Office Open XML) " +
      "file; the {{field}} markers in it become the template's fillable fields. " +
      "If you are unsure how to write the markers, call " +
      "template_marker_reference first. Optionally pass 'fields' to configure " +
      "the discovered fields in the same call: input type, select options, who " +
      "fills each field (a person, AI via aiPrompt, Person+AI via aiAdapt, a " +
      "formula, or a company-register lookup), date format, composite parts, " +
      "dependent options, hint, and required. You can also configure fields " +
      "later with configure_template_fields. " +
      "Max ~10 MB decoded. Returns the new template id and the number of " +
      "discovered fields. Use describe_template afterwards to inspect the fields.",
    inputSchema: {
      type: "object",
      properties: {
        name: stringProp("Template display name", { maxLength: 256 }),
        docx_base64: stringProp(
          "Base64-encoded DOCX file bytes (Office Open XML, max ~10 MB decoded)",
        ),
        fields: fieldsOverlayProp,
      },
      required: ["name", "docx_base64"],
    },
    anonymized: { exposure: "excluded", reason: "write" },
    name: "create_template",
    scope: "stella:templates",
  },
  {
    description:
      "Configure the fields of an EXISTING template: set input type, select " +
      "options, who fills each field (a person, AI via aiPrompt, Person+AI via " +
      "aiAdapt, a formula, or a company-register lookup with registry + named " +
      "output formats), date format, composite parts, dependent options, hint, " +
      "and required. Only the manifest is updated; the document's {{markers}} " +
      "are left untouched. Each 'fields' entry's 'path' must be a field that " +
      "exists in the template (call describe_template to list them). Returns the " +
      "updated field list (same shape as describe_template).",
    inputSchema: {
      type: "object",
      properties: {
        template_id: stringProp("Template id, as returned by list_templates"),
        fields: fieldsOverlayProp,
      },
      required: ["template_id", "fields"],
    },
    anonymized: { exposure: "excluded", reason: "write" },
    name: "configure_template_fields",
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

  const parsed = v.safeParse(listTemplatesArgsSchema, args);
  if (!parsed.success) {
    return errorResult("Invalid input: list_templates accepts only a cursor");
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

  const templateList = page.items;

  // Templates are organization-scoped, so the org id is the anonymization
  // scope. Only the org-authored free text (name, usage guidance) is redacted;
  // ids, field counts, and tags pass through.
  const workspaceId = context.organizationId;
  const textFields: McpStructuredTextField[] = [];
  for (const template of templateList) {
    pushTemplateTextField({
      apply: (value) => {
        template.name = value;
      },
      fields: textFields,
      value: template.name,
      workspaceId,
    });
    pushTemplateTextField({
      apply: (value) => {
        template.whenToUse = value;
      },
      fields: textFields,
      value: template.whenToUse,
      workspaceId,
    });
    pushTemplateTextField({
      apply: (value) => {
        template.whenNotToUse = value;
      },
      fields: textFields,
      value: template.whenNotToUse,
      workspaceId,
    });
    const tags = template.tags ?? [];
    for (const [index, tag] of tags.entries()) {
      pushTemplateTextField({
        apply: (value) => {
          tags[index] = value;
        },
        fields: textFields,
        value: tag,
        workspaceId,
      });
    }
  }

  return {
    egress: "structured",
    payload: { templates: templateList, nextCursor: page.nextCursor },
    textFields,
  };
};

/**
 * Queue one anonymizable template text field, skipping null/empty values.
 * Templates carry org-authored free text (name, usage guidance, field labels
 * and prompts); everything else on the surface is structural.
 */
const pushTemplateTextField = ({
  apply,
  fields,
  value,
  workspaceId,
}: {
  apply: (value: string) => void;
  fields: McpStructuredTextField[];
  value: string | null | undefined;
  workspaceId: string;
}): void => {
  if (typeof value === "string" && value.length > 0) {
    fields.push({ apply, value, workspaceId });
  }
};

type TemplateAnonymizableField = {
  formats?: { template: string }[] | null | undefined;
  lookup?: { formats: { template: string }[] } | null | undefined;
  options?: string[] | null | undefined;
  parts?:
    | {
        label?: string | null | undefined;
        options?: string[] | null | undefined;
      }[]
    | null
    | undefined;
};

const pushTemplateFieldNestedTextFields = ({
  field,
  fields,
  workspaceId,
}: {
  field: TemplateAnonymizableField;
  fields: McpStructuredTextField[];
  workspaceId: string;
}): void => {
  if (field.options) {
    for (const [index, option] of field.options.entries()) {
      pushTemplateTextField({
        apply: (value) => {
          field.options?.splice(index, 1, value);
        },
        fields,
        value: option,
        workspaceId,
      });
    }
  }

  if (field.parts) {
    for (const part of field.parts) {
      pushTemplateTextField({
        apply: (value) => {
          part.label = value;
        },
        fields,
        value: part.label,
        workspaceId,
      });
      if (part.options) {
        for (const [index, option] of part.options.entries()) {
          pushTemplateTextField({
            apply: (value) => {
              part.options?.splice(index, 1, value);
            },
            fields,
            value: option,
            workspaceId,
          });
        }
      }
    }
  }

  const formats = field.formats ?? field.lookup?.formats;
  if (formats) {
    for (const format of formats) {
      pushTemplateTextField({
        apply: (value) => {
          format.template = value;
        },
        fields,
        value: format.template,
        workspaceId,
      });
    }
  }
};

const markerReferenceArgsSchema = v.strictObject({});

// eslint-disable-next-line require-await -- McpToolHandler is async; this handler has no I/O to await
const handleMarkerReferenceTool: McpToolHandler = async ({ args }) => {
  const parsed = v.safeParse(markerReferenceArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: template_marker_reference takes no parameters",
    );
  }

  return textResult({ reference: buildMarkerReference() });
};

const describeTemplateArgsSchema = v.strictObject({
  template_id: v.pipe(v.string(), v.minLength(1)),
});

const handleDescribeTemplateTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const hasPermission = roles[context.memberRole].authorize({
    workspace: ["read"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

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
  const workspaceId = context.organizationId;
  const textFields: McpStructuredTextField[] = [];
  pushTemplateTextField({
    apply: (value) => {
      result.name = value;
    },
    fields: textFields,
    value: result.name,
    workspaceId,
  });
  for (const field of result.fields) {
    pushTemplateTextField({
      apply: (value) => {
        field.label = value;
      },
      fields: textFields,
      value: field.label,
      workspaceId,
    });
    pushTemplateTextField({
      apply: (value) => {
        field.hint = value;
      },
      fields: textFields,
      value: field.hint,
      workspaceId,
    });
    pushTemplateTextField({
      apply: (value) => {
        field.aiPrompt = value;
      },
      fields: textFields,
      value: field.aiPrompt,
      workspaceId,
    });
    pushTemplateFieldNestedTextFields({
      field,
      fields: textFields,
      workspaceId,
    });
  }

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

const createTemplateArgsSchema = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  docx_base64: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_DOCX_BASE64_LENGTH),
  ),
  // Validated structurally below with isFieldMeta — the same validator the REST
  // manifest overlay uses — so the JSON-schema-level shape stays loose here.
  fields: v.optional(v.array(v.unknown())),
});

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

const handleCreateTemplateTool: McpToolHandler = async ({ args, context }) => {
  const hasPermission = roles[context.memberRole].authorize({
    template: ["create"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(createTemplateArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: expected { name: string, docx_base64: string, fields?: array }",
    );
  }

  let clientManifest: { fields: FieldMeta[] } | null = null;
  if (parsed.output.fields !== undefined) {
    const overlay = validateFieldsOverlay(parsed.output.fields);
    if (!overlay.ok) {
      return errorResult(
        `Invalid field config at fields[${overlay.index}]: not a valid ` +
          "field configuration (check input type, lookup, and that formula is " +
          "not combined with aiPrompt/aiAdapt/lookup/parts).",
      );
    }
    clientManifest = { fields: overlay.fields };
  }

  const buffer = Buffer.from(parsed.output.docx_base64, "base64");
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
      name: parsed.output.name,
      fileName: `${parsed.output.name}.docx`,
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

const configureTemplateFieldsArgsSchema = v.strictObject({
  template_id: v.pipe(v.string(), v.minLength(1)),
  fields: v.array(v.unknown()),
});

const handleConfigureTemplateFieldsTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const hasPermission = roles[context.memberRole].authorize({
    template: ["update"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(configureTemplateFieldsArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: expected { template_id: string, fields: array }",
    );
  }

  const overlay = validateFieldsOverlay(parsed.output.fields);
  if (!overlay.ok) {
    return errorResult(
      `Invalid field config at fields[${overlay.index}]: not a valid field ` +
        "configuration (check input type, lookup, and that formula is not " +
        "combined with aiPrompt/aiAdapt/lookup/parts).",
    );
  }

  const templateId = brandPersistedTemplateId(parsed.output.template_id);

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

  // Echo the updated field list in the same shape describe_template returns, so
  // the agent sees exactly what is now configured (a complete round-trip).
  const described = await describeStoredTemplate({
    templateId,
    scopedDb: context.scopedDb,
  });
  if ("error" in described) {
    return errorResult(described.error);
  }

  return textResult(described);
};

export const TEMPLATE_TOOL_HANDLERS = {
  configure_template_fields: handleConfigureTemplateFieldsTool,
  create_template: handleCreateTemplateTool,
  describe_template: handleDescribeTemplateTool,
  fill_template: handleFillTemplateTool,
  list_templates: handleListTemplatesTool,
  template_marker_reference: handleMarkerReferenceTool,
} satisfies Record<TemplateToolName, McpToolHandler>;
